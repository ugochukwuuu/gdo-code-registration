import { readFileSync } from 'node:fs'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import vm from 'node:vm'
import { parentPort, workerData } from 'node:worker_threads'

const backend = readFileSync(new URL('../backend/Code.gs', import.meta.url), 'utf8')
const codeHeaders = ['Code', 'Status', 'CreatedAt', 'RedeemedAt', 'RegistrationID']
const registrationHeaders = ['RegistrationID', 'FullName', 'Phone', 'Email', 'RegistrationCode', 'TicketNumber', 'RegisteredAt', 'ParentAddress', 'ParentName', 'ParentPhone', 'ParentEmail']
const sheetNames = { 0: 'RegistrationCodes', 1: 'Registrations' }
const password = 'local-test-password'
const digest = value => createHash('sha256').update(value).digest()

export function setup() {
  const shared = new SharedArrayBuffer(256 * 1024)
  emulator(shared).save({ RegistrationCodes: [codeHeaders], Registrations: [registrationHeaders], cache: {} })
  return shared
}

export function emulator(shared, { delay = 0 } = {}) {
  const control = new Int32Array(shared, 0, 4)
  const data = new Uint8Array(shared, 16)
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let fail = ''
  const state = () => JSON.parse(decoder.decode(data.subarray(0, Atomics.load(control, 1))))
  const save = next => {
    const encoded = encoder.encode(JSON.stringify(next))
    data.set(encoded)
    Atomics.store(control, 1, encoded.length)
  }
  const cache = {
    get: key => state().cache[key] || null,
    put(key, value) {
      const next = state()
      next.cache[key] = value
      save(next)
    },
    remove(key) {
      const next = state()
      delete next.cache[key]
      save(next)
    },
  }
  const Sheets = {
    Spreadsheets: {
      Values: {
        batchGet(_id, { ranges }) {
          const next = state()
          return { valueRanges: ranges.map(range => ({ values: next[range.split('!')[0]] })) }
        },
      },
      get: () => ({
        sheets: Object.entries(sheetNames).map(([sheetId, title]) => ({ properties: { sheetId: Number(sheetId), title } })),
      }),
      batchUpdate({ requests }) {
        if (Atomics.load(control, 0) !== 1) throw new Error('Write without the script lock')
        if (delay) Atomics.wait(control, 0, 1, delay)
        const next = state()
        for (const request of requests) {
          const operation = request.appendCells || request.updateCells
          const rows = operation.rows.map(row => row.values.map(cell => {
            if (typeof cell.userEnteredValue.stringValue !== 'string') throw new Error('Expected literal cell values')
            return cell.userEnteredValue.stringValue
          }))
          if (request.appendCells) next[sheetNames[operation.sheetId]].push(...rows)
          else {
            const { sheetId, rowIndex, columnIndex } = operation.start
            next[sheetNames[sheetId]][rowIndex].splice(columnIndex, rows[0].length, ...rows[0])
          }
        }
        if (fail === 'before') {
          fail = ''
          throw new Error('Atomic batch failed before applying any changes')
        }
        save(next)
        if (fail === 'after') {
          fail = ''
          throw new Error('Write committed but the acknowledgement was lost')
        }
      },
    },
  }
  const context = vm.createContext({
    Sheets,
    CacheService: { getScriptCache: () => cache },
    LockService: {
      getScriptLock: () => ({
        tryLock(timeout) {
          const deadline = Date.now() + timeout
          while (Atomics.compareExchange(control, 0, 0, 1) !== 0) {
            Atomics.add(control, 3, 1)
            if (Atomics.wait(control, 0, 1, Math.max(0, deadline - Date.now())) === 'timed-out') return false
          }
          return true
        },
        releaseLock() {
          Atomics.store(control, 0, 0)
          Atomics.notify(control, 0)
        },
      }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperties: () => ({
          SPREADSHEET_ID: 'local-sheet',
          ADMIN_PASSWORD_SHA256: digest(password).toString('hex'),
          APP_SECRET: 'a'.repeat(64),
        }),
      }),
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      computeDigest: (_algorithm, value) => Array.from(digest(value)),
      computeHmacSha256Signature: (value, secret) => Array.from(createHmac('sha256', secret).update(value).digest()),
      getUuid: randomUUID,
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: value => ({ setMimeType: () => value }),
    },
    console: { error() {} },
  })
  vm.runInContext(backend, context)
  const call = (action, fields) => JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ action, ...fields }) } }))
  return {
    call, save, state,
    login: () => call('adminLogin', { password }).data.token,
    failNextWrite(mode) { fail = mode },
    contention: () => Atomics.load(control, 3),
  }
}

if (parentPort) {
  const { shared, details } = workerData
  const api = emulator(shared, { delay: 250 })
  const control = new Int32Array(shared, 0, 4)
  const arrivals = Atomics.add(control, 2, 1)
  if (arrivals === 0) Atomics.wait(control, 2, 1, 5000)
  else Atomics.notify(control, 2)
  parentPort.postMessage(api.call('redeem', details))
}
