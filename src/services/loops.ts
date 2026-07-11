import { Cron } from 'croner'
import { createConversation, setConversationCurrNode } from '../db/queries/conversations'
import { createMessage } from '../db/queries/messages'
import { setConversationMcpOverride } from '../db/queries/mcp-servers'
import {
  claimDueLoop,
  listDueLoops,
  listLoopMcpServers,
  noteLoopFired,
} from '../db/queries/loops'
import { notifyLoopStartFailure } from './push'
import { startRun } from './runner'
import { timeZoneLabel, zonedLocalDateTime } from '../utils/timezone'

export type LoopRow = NonNullable<Awaited<ReturnType<typeof claimDueLoop>>>

export function normalizeSchedule(value: string | null | undefined) {
  const schedule = (value ?? '').trim()
  return schedule.length > 0 ? schedule : null
}

export function defaultLoopTimezone() {
  return process.env['TZ'] || 'UTC'
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

export function humanizeRunStatus(status: string | null | undefined) {
  const labels: Record<string, string> = {
    queued: 'Queued', running: 'Running', streaming: 'Running',
    done: 'Completed', completed: 'Completed', waiting_approval: 'Waiting for approval',
    error: 'Failed', failed: 'Failed', cancelled: 'Cancelled',
  }
  return status ? (labels[status] ?? 'In progress') : 'Never run'
}

export function validateLoopSchedule(schedule: string | null, timezone: string) {
  if (!schedule) return null
  try {
    return nextLoopFireAt(schedule, timezone)
  } catch (error) {
    throw new Error(
      `Schedule is not a valid 5-field cron expression: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export async function fireLoop(loop: {
  id: string
  user_id: string
  name: string
  prompt: string
  system_prompt: string | null
  provider_id: string | null
  model: string | null
  reasoning_effort: string | null
}) {
  if (!loop.provider_id) throw new Error('Loop has no provider configured.')

  const title = `${loop.name} — ${new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date())}`

  const conversation = await createConversation({
    userId: loop.user_id,
    title,
    providerId: loop.provider_id,
    model: loop.model,
    reasoningEffort: loop.reasoning_effort,
    routineId: loop.id,
  })

  const selectedServers = await listLoopMcpServers(loop.id)
  await Promise.all(
    selectedServers.map((server) =>
      setConversationMcpOverride({
        conversationId: conversation.id,
        mcpServerId: server.mcp_server_id,
        enabled: true,
      }),
    ),
  )

  let parentId: string | null = null
  if ((loop.system_prompt ?? '').trim().length > 0) {
    const systemMessage = await createMessage({
      conversationId: conversation.id,
      role: 'system',
      content: loop.system_prompt ?? '',
    })
    parentId = systemMessage.id
    await setConversationCurrNode({ id: conversation.id, currNode: systemMessage.id })
  }

  const userMessage = await createMessage({
    conversationId: conversation.id,
    parentId,
    role: 'user',
    content: loop.prompt,
  })
  await setConversationCurrNode({ id: conversation.id, currNode: userMessage.id })
  await noteLoopFired({ id: loop.id, conversationId: conversation.id })
  await startRun(conversation.id)
  return conversation
}

let schedulerStarted = false
let schedulerBusy = false
let interval: ReturnType<typeof setInterval> | null = null

export async function tickLoops() {
  if (schedulerBusy) return
  schedulerBusy = true
  try {
    const now = new Date()
    const due = await listDueLoops(now)
    for (const seen of due) {
      if (!seen.next_fire_at || !seen.schedule) continue
      let nextFireAt: Date | null = null
      try {
        nextFireAt = nextLoopFireAt(seen.schedule, seen.timezone ?? defaultLoopTimezone(), now)
      } catch (error) {
        console.warn(`invalid loop schedule for ${seen.id}:`, error)
      }
      const claimed = await claimDueLoop({
        id: seen.id,
        seenNextFireAt: seen.next_fire_at,
        nextFireAt,
      })
      if (!claimed) continue
      try {
        await fireLoop(claimed)
      } catch (error) {
        console.error(`loop ${claimed.id} failed to start`, error)
        await notifyLoopStartFailure({
          userId: claimed.user_id,
          loopId: claimed.id,
          loopName: claimed.name,
          error,
        })
      }
    }
  } finally {
    schedulerBusy = false
  }
}

export function startLoopScheduler() {
  if (schedulerStarted) return
  schedulerStarted = true

  const bunCron = (Bun as unknown as { cron?: (expr: string, fn: () => void | Promise<void>) => unknown }).cron
  if (bunCron) {
    bunCron('* * * * *', () => void tickLoops())
  } else {
    interval = setInterval(() => void tickLoops(), 60_000)
    interval.unref?.()
  }
  void tickLoops()
}

export function stopLoopSchedulerForTests() {
  if (interval) clearInterval(interval)
  interval = null
  schedulerStarted = false
}
