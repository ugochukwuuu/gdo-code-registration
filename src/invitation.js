export function normaliseCode(value) {
  return value.trim().toUpperCase().replace(/[\s-]/g, '')
}

export function compactCode(code) {
  const bytes = normaliseCode(code).match(/.{2}/g).map(pair => String.fromCharCode(parseInt(pair, 16)))
  return btoa(bytes.join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function expandCode(fragment) {
  // Ten bytes encode to 14 unpadded characters. The last character has only two data bits.
  if (!/^[A-Za-z0-9_-]{13}[AQgw]$/.test(fragment)) return null
  const bytes = atob(fragment.replace(/-/g, '+').replace(/_/g, '/'))
  return Array.from(bytes, byte => byte.charCodeAt(0).toString(16).padStart(2, '0')).join('').toUpperCase()
}
