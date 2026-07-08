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
import { startRun } from './runner'

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
  const job = new Cron(schedule, { paused: true, timezone, mode: '5-part' })
  const next = job.nextRun(from)
  return next ? new Date(next) : null
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
