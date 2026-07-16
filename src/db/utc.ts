// PostgreSQL `timestamp without time zone` values are UTC instants everywhere
// except the loop scheduler's explicitly local next_fire_at cursor. Keep both
// the server session and Bun's Date parser on UTC so ordinary timestamps cross
// the boundary without implicit host-local conversion.
export function useUtcProcessTimezone() {
  process.env.TZ = 'UTC'
}

export function utcDatabaseUrl(databaseUrl: string) {
  const url = new URL(databaseUrl)
  const options = url.searchParams.get('options')?.trim()
  url.searchParams.set('options', [options, '-c timezone=UTC'].filter(Boolean).join(' '))
  return url.toString()
}
