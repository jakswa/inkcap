import { createConversation, setConversationCurrNode } from '../db/queries/conversations'
import { createMessage } from '../db/queries/messages'
import { setConversationMcpOverride } from '../db/queries/mcp-servers'
import {
  claimDueLoop,
  listLoopMcpServers,
  listScheduledLoops,
  noteLoopFired,
} from '../db/queries/loops'
import { getUserSettings } from '../db/queries/users'
import { notifyLoopStartFailure } from './push'
import { startRun } from './runner'
import { nextLoopWallTime, wallClockTime } from './loop-schedule'

export type LoopRow = NonNullable<Awaited<ReturnType<typeof claimDueLoop>>>

export function humanizeRunStatus(status: string | null | undefined) {
  const labels: Record<string, string> = {
    queued: 'Queued', running: 'Running', streaming: 'Running',
    done: 'Completed', completed: 'Completed', waiting_approval: 'Waiting for approval',
    error: 'Failed', failed: 'Failed', cancelled: 'Cancelled',
  }
  return status ? (labels[status] ?? 'In progress') : 'Never run'
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
    const scheduled = await listScheduledLoops()
    const settingsByUser = new Map<string, Awaited<ReturnType<typeof getUserSettings>>>()
    for (const seen of scheduled) {
      if (!seen.next_fire_at || !seen.schedule) continue
      let settings = settingsByUser.get(seen.user_id)
      if (!settings) {
        settings = await getUserSettings(seen.user_id)
        settingsByUser.set(seen.user_id, settings)
      }
      if (seen.next_fire_at > wallClockTime(now, settings.timeZone)) continue
      let nextFireAt: string | null = null
      try {
        nextFireAt = nextLoopWallTime(seen.schedule, settings.timeZone, now)
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
