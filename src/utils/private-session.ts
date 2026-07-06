import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { env } from './env'

export type PrivateSession = {
  user: {
    id: string
    name: string
    email: string
    created_at: string
  }
  issuedAt: string
  expiresAt: string
}

const algorithm = 'aes-256-gcm'

export const sessionCookieName =
  env.NODE_ENV === 'production' ? '__Host-session' : 'session'

function encryptionKey() {
  return createHash('sha256').update(env.SESSION_SECRET).digest()
}

export function sessionExpirationDate() {
  const date = new Date()
  date.setDate(date.getDate() + 30)
  return date
}

export function encryptSession(session: PrivateSession) {
  const iv = randomBytes(12)
  const cipher = createCipheriv(algorithm, encryptionKey(), iv)
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(session), 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()

  return Buffer.concat([iv, tag, encrypted]).toString('base64url')
}

export function decryptSession(value: string): PrivateSession | null {
  try {
    const input = Buffer.from(value, 'base64url')
    const iv = input.subarray(0, 12)
    const tag = input.subarray(12, 28)
    const encrypted = input.subarray(28)
    const decipher = createDecipheriv(algorithm, encryptionKey(), iv)
    decipher.setAuthTag(tag)

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString('utf8')
    const session = JSON.parse(decrypted) as PrivateSession
    const issuedAt = new Date(session.issuedAt)
    const expiresAt = new Date(session.expiresAt)

    if (Number.isNaN(issuedAt.getTime())) return null
    if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) return null
    if (!session.user?.id || !session.user.email || !session.user.name) return null

    return session
  } catch {
    return null
  }
}
