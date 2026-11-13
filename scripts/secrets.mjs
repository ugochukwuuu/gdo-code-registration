import { createHash, randomBytes } from 'node:crypto'

const password = randomBytes(24).toString('base64url')
console.log(`Admin password (save privately): ${password}`)
console.log(`ADMIN_PASSWORD_SHA256=${createHash('sha256').update(password).digest('hex')}`)
console.log(`APP_SECRET=${randomBytes(32).toString('hex')}`)
