import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { env } from './env'

const blockedHostnames = new Set(['localhost', 'localhost.localdomain'])

export async function assertSafeOutboundUrl(raw: string) {
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Outbound URL must use http or https')
  }

  if (env.NODE_ENV !== 'production') return

  if (url.protocol !== 'https:') {
    throw new Error('Outbound URLs must use https in production')
  }

  if (blockedHostnames.has(url.hostname.toLowerCase())) {
    throw new Error('Outbound URL host is not allowed')
  }

  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true, verbatim: true })

  if (addresses.some(({ address }) => isBlockedAddress(address))) {
    throw new Error('Outbound URL resolves to a private or reserved address')
  }
}

function isBlockedAddress(address: string) {
  if (address === '::1' || address === '::') return true
  if (address.toLowerCase().startsWith('fe80:')) return true
  if (address.toLowerCase().startsWith('fc') || address.toLowerCase().startsWith('fd')) {
    return true
  }

  const parts = address.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false
  const [a, b] = parts

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}
