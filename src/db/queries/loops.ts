import { sql } from '../client'
import { randomUUIDv7 } from 'bun'

export interface LoopFormInput {
  accountId: string
  userId: string
  name: string
  prompt: string
  systemPrompt?: string | null
  providerId: string
  model?: string | null
  reasoningEffort?: string | null
  schedule?: string | null
  timezone: string
  enabled: boolean
  nextFireAt?: Date | null
}

export async function createLoop(input: LoopFormInput) {
  const [loop] = await sql.CreateLoop`
    INSERT INTO loops (
      id, account_id, user_id, name, prompt, system_prompt, provider_id, model,
      reasoning_effort, schedule, timezone, enabled, next_fire_at
    )
    VALUES (
      ${randomUUIDv7()}, ${input.accountId}, ${input.userId}, ${input.name},
      ${input.prompt}, ${input.systemPrompt ?? null}, ${input.providerId},
      ${input.model ?? null}, ${input.reasoningEffort ?? null},
      ${input.schedule ?? null}, ${input.timezone}, ${input.enabled},
      ${input.nextFireAt ?? null}
    )
    RETURNING id, account_id, user_id, name, prompt, system_prompt, provider_id,
              model, reasoning_effort, schedule, timezone, enabled,
              last_fired_at, next_fire_at, last_conversation_id,
              created_at, updated_at
  `
  return loop
}

export async function updateLoop(input: LoopFormInput & { id: string }) {
  const [loop] = await sql.UpdateLoop`
    UPDATE loops
    SET name = ${input.name},
        prompt = ${input.prompt},
        system_prompt = ${input.systemPrompt ?? null},
        provider_id = ${input.providerId},
        model = ${input.model ?? null},
        reasoning_effort = ${input.reasoningEffort ?? null},
        schedule = ${input.schedule ?? null},
        timezone = ${input.timezone},
        enabled = ${input.enabled},
        next_fire_at = ${input.nextFireAt ?? null},
        updated_at = now()
    WHERE id = ${input.id} AND user_id = ${input.userId}
    RETURNING id, account_id, user_id, name, prompt, system_prompt, provider_id,
              model, reasoning_effort, schedule, timezone, enabled,
              last_fired_at, next_fire_at, last_conversation_id,
              created_at, updated_at
  `
  return loop
}

export async function getLoopForUser(input: { id: string; userId: string }) {
  const [loop] = await sql.GetLoopForUser`
    SELECT l.id, l.account_id, l.user_id, l.name, l.prompt, l.system_prompt,
           l.provider_id, l.model, l.reasoning_effort, l.schedule, l.timezone,
           l.enabled, l.last_fired_at, l.next_fire_at, l.last_conversation_id,
           l.created_at, l.updated_at,
           p.name AS provider_name,
           c.title AS last_conversation_title
    FROM loops l
    JOIN account_memberships m ON m.account_id = l.account_id AND m.user_id = ${input.userId}
    LEFT JOIN providers p ON p.id = l.provider_id
    LEFT JOIN conversations c ON c.id = l.last_conversation_id
    WHERE l.id = ${input.id}
  `
  return loop
}

export async function listLoopsForUser(userId: string) {
  return sql.ListLoopsForUser`
    SELECT l.id, l.account_id, l.user_id, l.name, l.prompt, l.system_prompt,
           l.provider_id, l.model, l.reasoning_effort, l.schedule, l.timezone,
           l.enabled, l.last_fired_at, l.next_fire_at, l.last_conversation_id,
           l.created_at, l.updated_at,
           p.name AS provider_name,
           c.title AS last_conversation_title
    FROM loops l
    JOIN account_memberships m ON m.account_id = l.account_id AND m.user_id = ${userId}
    LEFT JOIN providers p ON p.id = l.provider_id
    LEFT JOIN conversations c ON c.id = l.last_conversation_id
    ORDER BY l.created_at DESC
  `
}

export async function setLoopEnabled(input: {
  id: string
  userId: string
  enabled: boolean
  nextFireAt?: Date | null
}) {
  const [loop] = await sql.SetLoopEnabled`
    UPDATE loops
    SET enabled = ${input.enabled},
        next_fire_at = ${input.nextFireAt ?? null},
        updated_at = now()
    WHERE id = ${input.id} AND user_id = ${input.userId}
    RETURNING id, account_id, user_id, name, prompt, system_prompt, provider_id,
              model, reasoning_effort, schedule, timezone, enabled,
              last_fired_at, next_fire_at, last_conversation_id,
              created_at, updated_at
  `
  return loop
}

export async function deleteLoop(input: { id: string; userId: string }) {
  const [loop] = await sql.DeleteLoop`
    DELETE FROM loops
    WHERE id = ${input.id} AND user_id = ${input.userId}
    RETURNING id
  `
  return loop
}

export async function listDueLoops(now: Date) {
  return sql.ListDueLoops`
    SELECT id, account_id, user_id, name, prompt, system_prompt, provider_id,
           model, reasoning_effort, schedule, timezone, enabled,
           last_fired_at, next_fire_at, last_conversation_id,
           created_at, updated_at
    FROM loops
    WHERE enabled = true AND next_fire_at IS NOT NULL AND next_fire_at <= ${now}
    ORDER BY next_fire_at ASC
    LIMIT 25
  `
}

export async function claimDueLoop(input: {
  id: string
  seenNextFireAt: Date
  nextFireAt: Date | null
}) {
  const [loop] = await sql.ClaimDueLoop`
    UPDATE loops
    SET last_fired_at = now(),
        next_fire_at = ${input.nextFireAt},
        updated_at = now()
    WHERE id = ${input.id}
      AND enabled = true
      AND next_fire_at = ${input.seenNextFireAt}
    RETURNING id, account_id, user_id, name, prompt, system_prompt, provider_id,
              model, reasoning_effort, schedule, timezone, enabled,
              last_fired_at, next_fire_at, last_conversation_id,
              created_at, updated_at
  `
  return loop
}

export async function noteLoopFired(input: { id: string; conversationId: string }) {
  const [loop] = await sql.NoteLoopFired`
    UPDATE loops
    SET last_conversation_id = ${input.conversationId}, updated_at = now()
    WHERE id = ${input.id}
    RETURNING id, last_conversation_id
  `
  return loop
}

export async function listLoopMcpServers(loopId: string) {
  return sql.ListLoopMcpServers`
    SELECT mcp_server_id, auto_approve
    FROM loop_mcp_servers
    WHERE loop_id = ${loopId}
    ORDER BY created_at ASC
  `
}

export async function replaceLoopMcpServers(input: {
  loopId: string
  servers: { mcpServerId: string; autoApprove: boolean }[]
}) {
  await sql.DeleteLoopMcpServers`
    DELETE FROM loop_mcp_servers WHERE loop_id = ${input.loopId}
  `
  for (const server of input.servers) {
    await sql.InsertLoopMcpServer`
      INSERT INTO loop_mcp_servers (loop_id, mcp_server_id, auto_approve)
      VALUES (${input.loopId}, ${server.mcpServerId}, ${server.autoApprove})
    `
  }
}

export async function listMcpServersWithLoopSelection(input: {
  loopId: string
  userId: string
}) {
  return sql.ListMcpServersWithLoopSelection`
    SELECT s.id, s.name, s.url, s.enabled, s.auto_approve,
           s.request_timeout_ms, s.created_at, s.updated_at,
           lms.mcp_server_id IS NOT NULL AS loop_enabled,
           lms.auto_approve AS loop_auto_approve
    FROM mcp_servers s
    JOIN account_memberships m ON m.account_id = s.account_id AND m.user_id = ${input.userId}
    LEFT JOIN loop_mcp_servers lms
      ON lms.mcp_server_id = s.id AND lms.loop_id = ${input.loopId}
    ORDER BY s.created_at ASC
  `
}
