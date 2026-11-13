import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { loadEnvFile } from 'node:process'

try {
  loadEnvFile('.env.local')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

const endpoint = process.env.VITE_APPS_SCRIPT_URL
const origin = process.env.GDO_FRONTEND_ORIGIN
const shouldWrite = process.env.GDO_SMOKE_WRITE === '1'
const password = process.env.GDO_SMOKE_ADMIN_PASSWORD
const key = () => randomBytes(32).toString('hex')

function verifyCors(response, requestOrigin, stage) {
  const allowed = response.headers.get('access-control-allow-origin')
  assert.ok(allowed === '*' || allowed === requestOrigin, stage + ' lacks a matching Access-Control-Allow-Origin header')
}

async function call(action, fields = {}) {
  const headers = { 'Content-Type': 'text/plain;charset=UTF-8' }
  if (origin) headers.Origin = origin
  const first = await fetch(endpoint, {
    method: 'POST', headers, body: JSON.stringify({ action, ...fields }),
    redirect: 'manual', signal: AbortSignal.timeout(25000),
  })
  assert.ok([302, 303].includes(first.status), 'Expected the Apps Script Content Service redirect')
  const redirected = new URL(first.headers.get('location'))
  assert.equal(redirected.origin, 'https://script.googleusercontent.com', 'Check anonymous web-app access and the /exec URL')
  if (origin) verifyCors(first, origin, 'The initial response')
  const result = await fetch(redirected, {
    headers: origin ? { Origin: 'null' } : {},
    redirect: 'error', signal: AbortSignal.timeout(25000),
  })
  assert.ok(result.ok, 'The Apps Script response did not succeed')
  if (origin) verifyCors(result, 'null', 'The redirected response')
  return result.json()
}

function success(result, action) {
  assert.ok(result.ok, action + ' failed (' + (result.error?.code || 'unexpected response') + ')')
  return result.data
}

try {
  assert.match(endpoint || '', /^https:\/\/script\.google\.com\/macros\/s\/(?!REPLACE_WITH_)[\w-]+\/exec$/, 'Set VITE_APPS_SCRIPT_URL to the deployed /exec URL')
  if (origin) assert.equal(new URL(origin).origin, origin, 'Set GDO_FRONTEND_ORIGIN to the site origin without a trailing slash')
  if (shouldWrite) assert.ok(password, 'Set GDO_SMOKE_ADMIN_PASSWORD privately for the test deployment')
  const health = success(await call('health'), 'Health check')
  assert.equal(health.service, 'gdo-code-registration')
  assert.equal(health.version, 2, 'Deploy the version that supports ParentAddress before connecting the updated frontend')
  console.log(origin ? 'Live redirect, CORS headers and Sheets connectivity passed.' : 'Live redirect and Sheets connectivity passed.')

  if (shouldWrite) {
    const { token } = success(await call('adminLogin', { password }), 'Admin login')
    try {
      const batch = { token, count: 2, requestKey: key() }
      const { codes: [code, secondCode] } = success(await call('adminGenerate', batch), 'Code generation')
      assert.deepEqual(success(await call('adminGenerate', batch), 'Batch replay').codes, [code, secondCode])
      success(await call('verify', { code }), 'Code verification')
      const entrants = ['Deployment Test One', 'Deployment Test Two'].map(fullName => ({
        code, requestKey: key(), fullName, phone: '08000000000', email: '', parentAddress: '10 Example Road, Asaba',
      }))
      const results = await Promise.all(entrants.map(details => call('redeemWithAddress', details)))
      assert.equal(results.filter(result => result.ok).length, 1, 'Exactly one submission should succeed')
      assert.equal(results.find(result => !result.ok).error?.code, 'CODE_USED')
      const index = results.findIndex(result => result.ok)
      const ticket = results[index].data
      assert.match(ticket.ticketNumber, /^GDO-\d{6,}$/)
      assert.deepEqual(success(await call('redeemWithAddress', entrants[index]), 'Submission replay'), ticket)
      const second = success(await call('redeemWithAddress', { ...entrants[0], code: secondCode, requestKey: key() }), 'Second ticket')
      assert.notEqual(second.ticketNumber, ticket.ticketNumber)
      const dashboard = success(await call('adminList', { token, tab: 'attendees' }), 'Attendee list')
      assert.equal(dashboard.items.filter(item => item.code === code && item.ticketNumber === ticket.ticketNumber).length, 1)
      assert.equal(dashboard.items.find(item => item.code === code).parentAddress, entrants[index].parentAddress)
      console.log('Live admin generation, simultaneous redemption, safe replay and ticket uniqueness passed.')
    } finally {
      await call('adminLogout', { token })
    }
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
