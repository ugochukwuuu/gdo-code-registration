import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { emulator, setup } from './emulator.mjs'

const key = () => randomBytes(32).toString('hex')

function fixture(count = 1) {
  const shared = setup()
  const api = emulator(shared)
  const token = api.login()
  const requestKey = key()
  const result = api.call('adminGenerate', { token, count, requestKey })
  assert.equal(result.ok, true)
  return { shared, api, token, requestKey, codes: result.data.codes }
}

function attendee(code, fields) {
  return { code, requestKey: key(), fullName: 'Ada Okafor', phone: '0803 123 4567', email: '', parentAddress: '10 Example Road, Asaba', ...fields }
}

function concurrentRedeem(shared, details) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./emulator.mjs', import.meta.url), { workerData: { shared, details } })
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', code => {
      if (code !== 0) reject(new Error('Worker exited with code ' + code))
    })
  })
}

test('admin operations require a session, generation retries reuse the batch, and logout revokes access', () => {
  const { api, codes, token, requestKey } = fixture(3)
  assert.equal(new Set(codes).size, 3)
  assert.ok(codes.every(code => /^(?:[0-9A-F]{4}-){4}[0-9A-F]{4}$/.test(code)))
  assert.equal(api.call('adminGenerate', { count: 1, requestKey: key() }).error.code, 'UNAUTHENTICATED')
  assert.equal(api.call('adminLogin', { password: 'incorrect' }).error.code, 'INVALID_PASSWORD')
  assert.deepEqual(api.call('adminGenerate', { token, count: 3, requestKey }).data.codes, codes)
  assert.deepEqual(api.call('adminList', { token }).data.totals, { generated: 3, redeemed: 0, remaining: 3 })
  api.call('adminLogout', { token })
  assert.equal(api.call('adminList', { token }).error.code, 'UNAUTHENTICATED')
})

test('redemption writes both sheets, uses unique ticket numbers, and keeps values as literal strings', () => {
  const { api, codes, token } = fixture(2)
  const [first, second] = codes
  assert.equal(api.call('verify', { code: first.toLowerCase().replaceAll('-', '') }).data.code, first)
  assert.equal(api.call('verify', { code: first }).data.code, first)
  assert.equal(api.state().RegistrationCodes[1][1], 'Unused')
  assert.equal(api.call('redeem', attendee(first, { phone: 'bad' })).error.code, 'INVALID_PHONE')
  assert.equal(api.call('redeem', attendee(first, { email: 'no-at' })).error.code, 'INVALID_EMAIL')
  assert.equal(api.call('redeem', attendee(first, { fullName: '' })).error.code, 'INVALID_NAME')
  assert.equal(api.call('redeemWithAddress', attendee(first, { parentAddress: '  ' })).error.code, 'INVALID_ADDRESS')
  const submitted = attendee(first, { fullName: '=Ada Okafor', email: 'ada@example.test' })
  const accepted = api.call('redeemWithAddress', submitted)
  assert.deepEqual(accepted.data, { fullName: '=Ada Okafor', ticketNumber: 'GDO-000001' })
  assert.equal(api.call('verify', { code: first }).error.code, 'CODE_USED')
  assert.equal(api.call('redeem', attendee(second)).data.ticketNumber, 'GDO-000002')
  const { RegistrationCodes, Registrations } = api.state()
  assert.equal(RegistrationCodes[1][1], 'Used')
  assert.equal(RegistrationCodes[1][4], Registrations[1][0])
  assert.deepEqual(Registrations[1].slice(1, 6), ['=Ada Okafor', '08031234567', 'ada@example.test', first, 'GDO-000001'])
  assert.equal(Registrations[1][7], submitted.parentAddress)
  assert.equal(api.call('adminList', { token, tab: 'attendees' }).data.items[0].parentAddress, submitted.parentAddress)
  assert.equal(api.call('adminList', { token, status: 'Unused' }).data.items.length, 0)
  assert.equal(api.call('adminList', { token, tab: 'attendees' }).data.items.length, 2)
})

test('failed atomic update leaves the code usable and a lost response can be retried safely', () => {
  const { api, codes: [code] } = fixture()
  const payload = attendee(code)
  api.failNextWrite('before')
  assert.equal(api.call('redeem', payload).error.code, 'TEMPORARY_ERROR')
  assert.equal(api.state().RegistrationCodes[1][1], 'Unused')
  assert.equal(api.state().Registrations.length, 1)
  api.failNextWrite('after')
  assert.equal(api.call('redeem', payload).error.code, 'TEMPORARY_ERROR')
  assert.deepEqual(api.call('redeem', payload).data, { fullName: payload.fullName, ticketNumber: 'GDO-000001' })
  assert.equal(api.call('redeem', { ...payload, fullName: 'Different Name' }).error.code, 'CODE_USED')
  assert.equal(api.call('redeem', attendee(code)).error.code, 'CODE_USED')
  assert.equal(api.state().Registrations.length, 2)

  // An attendee who registered before the new column can still recover their ticket.
  const legacy = api.state()
  legacy.Registrations[1].length = 7
  api.save(legacy)
  assert.deepEqual(api.call('redeem', { ...payload, parentAddress: undefined }).data,
    { fullName: payload.fullName, ticketNumber: 'GDO-000001' })
})

test('simultaneous distinct submissions for the same code produce one winner', async () => {
  const { shared, api, codes: [code] } = fixture()
  const results = await Promise.all([
    concurrentRedeem(shared, attendee(code)),
    concurrentRedeem(shared, attendee(code, { fullName: 'Chioma Obi' })),
  ])
  assert.ok(api.contention() > 0)
  assert.equal(results.filter(result => result.ok).length, 1)
  assert.equal(results.find(result => !result.ok).error.code, 'CODE_USED')
  assert.equal(api.state().Registrations.length, 2)
})

test('simultaneous repeats of the same submission return one ticket and create one record', async () => {
  const { shared, api, codes: [code] } = fixture()
  const details = attendee(code)
  const [first, second] = await Promise.all([concurrentRedeem(shared, details), concurrentRedeem(shared, details)])
  assert.ok(api.contention() > 0)
  assert.deepEqual(first, second)
  assert.equal(first.data.ticketNumber, 'GDO-000001')
  assert.equal(api.state().Registrations.length, 2)
})

test('registration stores the child’s ticket name separately from the required parent details', () => {
  const { api, token, codes: [code] } = fixture()
  const details = { code, requestKey: key(), fullName: 'Ada Okafor', childAge: '0', parentName: 'Ife Okafor',
    parentPhone: '0803 123 4567', parentEmail: 'parent@example.test' }
  for (const childAge of [undefined, '-1', '10.5', '121']) {
    assert.equal(api.call('redeemWithParent', { ...details, childAge }).error.code, 'INVALID_CHILD_AGE')
  }
  assert.equal(api.call('redeemWithParent', { ...details, parentName: '' }).error.code, 'INVALID_PARENT_NAME')
  assert.equal(api.call('redeemWithParent', { ...details, parentPhone: '' }).error.code, 'INVALID_PHONE')
  assert.equal(api.call('redeemWithParent', { ...details, parentEmail: '' }).error.code, 'INVALID_EMAIL')
  assert.equal(api.state().RegistrationCodes[1][1], 'Unused')
  api.failNextWrite('after')
  assert.equal(api.call('redeemWithParent', details).error.code, 'TEMPORARY_ERROR')
  assert.deepEqual(api.call('redeemWithParent', details).data, { fullName: 'Ada Okafor', ticketNumber: 'GDO-000001' })
  assert.equal(api.call('redeemWithParent', { ...details, childAge: '1' }).error.code, 'CODE_USED')
  const [, row] = api.state().Registrations
  assert.deepEqual(row.slice(7), ['', 'Ife Okafor', '08031234567', 'parent@example.test', '0'])
  const [item] = api.call('adminList', { token, tab: 'attendees' }).data.items
  assert.equal(item.parentName, details.parentName)
  assert.equal(item.parentPhone, '08031234567')
  assert.equal(item.parentEmail, details.parentEmail)
  assert.equal(item.childAge, '0')

  const legacy = api.state()
  legacy.Registrations[1].pop()
  legacy.Registrations[1][10] = 'legacy@example.test'
  api.save(legacy)
  assert.deepEqual(api.call('redeemWithParent', { ...details, childAge: undefined, parentEmail: 'legacy@example.test' }).data,
    { fullName: details.fullName, ticketNumber: 'GDO-000001' })
})
