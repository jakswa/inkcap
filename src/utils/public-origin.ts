// The canonical origin users reach the app at, for deployments where it
// differs from what the server sees (TLS-terminating proxy, LAN IP access).
// Read lazily so tests can vary it per-case.
export function publicOrigin(): string | null {
  const raw = process.env['PUBLIC_ORIGIN']?.trim().replace(/\/+$/, '')
  return raw || null
}
