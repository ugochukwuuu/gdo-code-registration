export function readSession(key) {
  try {
    return JSON.parse(sessionStorage.getItem('gdo:' + key))
  } catch {
    return null
  }
}

export function writeSession(key, value) {
  try {
    if (value == null) sessionStorage.removeItem('gdo:' + key)
    else sessionStorage.setItem('gdo:' + key, JSON.stringify(value))
  } catch {
    // Keep the current operation usable if the browser disables storage.
  }
}
