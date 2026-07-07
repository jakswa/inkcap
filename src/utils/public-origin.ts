// Split-origin deployment awareness: what origin/protocol is the browser
// actually on, when that differs from what the server sees (TLS-terminating
// proxy, direct LAN IP access). Env reads are lazy so tests can vary them.
import type { Context } from 'hono'
import { readEnvList } from './env'

// Browsers send Origin headers in canonical form (lowercase, no path, no
// trailing slash); operators paste origins from address bars. Meet in the
// middle or the comparison silently never matches.
function normalizeOrigin(raw: string): string {
  try {
    return new URL(raw).origin
  } catch {
    return raw.replace(/\/+$/, '')
  }
}

// The canonical browser-facing origin (PUBLIC_ORIGIN), for OAuth return
// redirects and CSRF trust.
export function publicOrigin(): string | null {
  const raw = process.env['PUBLIC_ORIGIN']?.trim()
  return raw ? normalizeOrigin(raw) : null
}

// Origins allowed to submit forms beyond the same-origin default:
// CSRF_TRUSTED_ORIGINS plus PUBLIC_ORIGIN, all normalized.
export function trustedOrigins(): string[] {
  const origins = readEnvList('CSRF_TRUSTED_ORIGINS').map(normalizeOrigin)
  const configured = publicOrigin()
  if (configured) origins.push(configured)
  return origins
}

// Whether the browser reached us over https. The forwarded header is
// spoofable by direct clients; it only ever picks a cookie name, and callers
// combine it with insecureSessionCookieAllowed() (docs/issues/18).
export function requestIsSecure(c: Context) {
  const forwardedProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  if (forwardedProto) return forwardedProto === 'https'
  return new URL(c.req.url).protocol === 'https:'
}
