import { Cron } from 'croner'
import { timeZoneLabel, zonedLocalDateTime } from '../utils/timezone'

export function normalizeSchedule(value: string | null | undefined) {
  const schedule = (value ?? '').trim()
  return schedule.length > 0 ? schedule : null
}

// JavaScript Date always represents an instant, so keep PostgreSQL's timezone-
// free scheduler cursor as a sortable local datetime string instead.
export function wallClockTime(instant: Date, timezone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(instant).map((part) => [part.type, part.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`
}

export function wallTimeToInstant(wallTime: string, timezone: string) {
  return zonedLocalDateTime(wallTime.slice(0, 16), timezone)
}

export function nextLoopFireAt(
  schedule: string | null,
  timezone: string,
  from: Date = new Date(),
) {
  if (!schedule) return null
  if (schedule.startsWith('once:')) {
    const instant = zonedLocalDateTime(schedule.slice(5), timezone)
    return instant && instant > from ? instant : null
  }
  const job = new Cron(schedule, { paused: true, timezone, mode: '5-part' })
  const next = job.nextRun(from)
  return next ? new Date(next) : null
}

export function nextLoopWallTime(
  schedule: string | null,
  timezone: string,
  from: Date = new Date(),
) {
  const instant = nextLoopFireAt(schedule, timezone, from)
  return instant ? wallClockTime(instant, timezone) : null
}

export function scheduleFormParts(schedule: string | null | undefined) {
  if (!schedule) return { mode: 'manual', minute: '0', time: '09:00', weekday: '1', once: '', custom: '' }
  if (schedule.startsWith('once:')) return { mode: 'once', minute: '0', time: '09:00', weekday: '1', once: schedule.slice(5), custom: '' }
  let match = /^(\d{1,2}) \* \* \* \*$/.exec(schedule)
  if (match) return { mode: 'hourly', minute: match[1]!, time: '09:00', weekday: '1', once: '', custom: '' }
  match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/.exec(schedule)
  if (match) {
    const mode = match[3] === '*' ? 'daily' : match[3] === '1-5' ? 'weekdays' : 'weekly'
    return { mode, minute: '0', time: `${match[2]!.padStart(2, '0')}:${match[1]!.padStart(2, '0')}`, weekday: match[3] === '*' || match[3] === '1-5' ? '1' : match[3]!, once: '', custom: '' }
  }
  return { mode: 'custom', minute: '0', time: '09:00', weekday: '1', once: '', custom: schedule }
}

export function humanizeLoopSchedule(schedule: string | null, timezone: string) {
  if (!schedule) return 'Manual only'
  const parts = scheduleFormParts(schedule)
  let next: Date | null
  try {
    next = nextLoopFireAt(schedule, timezone)
  } catch {
    return `Invalid schedule (${schedule}) in ${timezone}`
  }
  const zone = timeZoneLabel(timezone, next ?? new Date())
  if (parts.mode === 'once') {
    const instant = zonedLocalDateTime(parts.once, timezone)
    return instant ? `Once on ${new Intl.DateTimeFormat('en-US', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(instant)} ${zone}` : `Once in ${timezone}`
  }
  if (parts.mode === 'hourly') return `Hourly at :${parts.minute.padStart(2, '0')} ${zone}`
  const [hour, minute] = parts.time.split(':').map(Number)
  const sample = new Date(Date.UTC(2024, 0, 1, hour, minute))
  const clock = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(sample)
  if (parts.mode === 'daily') return `Daily at ${clock} ${zone}`
  if (parts.mode === 'weekdays') return `Weekdays at ${clock} ${zone}`
  if (parts.mode === 'weekly') {
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
    return `Every ${days[Number(parts.weekday)]} at ${clock} ${zone}`
  }
  return `Custom schedule (${schedule}) in ${timezone}`
}

export function validateLoopSchedule(schedule: string | null, timezone: string) {
  if (!schedule) return null
  try {
    return nextLoopWallTime(schedule, timezone)
  } catch (error) {
    throw new Error(
      `Schedule is not a valid 5-field cron expression: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
