const endpoint = import.meta.env.VITE_APPS_SCRIPT_URL?.trim()

export const configured = /^https:\/\/script\.google\.com\/macros\/s\/(?!REPLACE_WITH_)[\w-]+\/exec$/.test(endpoint || '')

export class ApiError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export async function request(action, fields = {}) {
  if (!configured) {
    throw new ApiError('NOT_CONFIGURED', 'Online registration is awaiting setup. Please contact the organiser.')
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 25000)
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ action, ...fields }),
      credentials: 'omit',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error('Unexpected HTTP status')
    const result = await response.json()
    if (result.ok === true) return result.data
    if (result.ok === false && result.error?.code && result.error?.message) {
      throw new ApiError(result.error.code, result.error.message)
    }
    throw new Error('Invalid response')
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError('NETWORK', 'We could not confirm the response. Check your connection and try again.')
  } finally {
    clearTimeout(timeout)
  }
}

export function requestKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
}
