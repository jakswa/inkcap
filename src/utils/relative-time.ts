// Compact human-relative timestamp ("just now", "5m ago", "3d ago", or an
// absolute date past a week) for conversation lists. Kept out of templates so
// the .eta files stay display-only.
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

export function relativeTime(value: Date | string | number, now: Date = new Date()): string {
  const then = value instanceof Date ? value : new Date(value)
  const diff = now.getTime() - then.getTime()

  if (!Number.isFinite(diff)) return ''
  if (diff < 0) return 'just now'
  if (diff < MINUTE) return 'just now'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`
  if (diff < WEEK) return `${Math.floor(diff / DAY)}d ago`

  return then.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}
