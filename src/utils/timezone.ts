export function validTimeZone(value: string | null | undefined): string | null {
  const zone = (value ?? '').trim()
  if (!zone || zone.length > 100) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format()
    return zone
  } catch {
    return null
  }
}

export function timeZoneLabel(timeZone: string, at = new Date()): string {
  const part = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'short',
  }).formatToParts(at).find((item) => item.type === 'timeZoneName')?.value
  return part || timeZone
}

// Convert an HTML datetime-local value to an instant in an IANA zone. The
// round-trip rejects impossible wall times during the spring DST jump.
export function zonedLocalDateTime(value: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  const wanted = match.slice(1).map(Number)
  let timestamp = Date.UTC(wanted[0]!, wanted[1]! - 1, wanted[2]!, wanted[3]!, wanted[4]!)
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]))
    const seenAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute))
    const wantedAsUtc = Date.UTC(wanted[0]!, wanted[1]! - 1, wanted[2]!, wanted[3]!, wanted[4]!)
    timestamp += wantedAsUtc - seenAsUtc
  }
  const result = new Date(timestamp)
  const parts = Object.fromEntries(formatter.formatToParts(result).map((part) => [part.type, part.value]))
  const actual = [parts.year, parts.month, parts.day, parts.hour, parts.minute].join('-')
  const expected = [match[1], match[2], match[3], match[4], match[5]].join('-')
  return actual === expected ? result : null
}
