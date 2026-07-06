import { sql } from '../client'
import { randomUUIDv7 } from 'bun'

// A tool_approvals row is one tool call awaiting (or having received) a human
// decision. Rows are created when a run parks in waiting_approval and resolved
// when the user approves/denies from the conversation page.

export async function createToolApproval(input: {
  runId: string
  messageId: string
  toolCallId: string
  toolName: string
  arguments: string
}) {
  const [approval] = await sql.CreateToolApproval`
    INSERT INTO tool_approvals (id, run_id, message_id, tool_call_id, tool_name, arguments)
    VALUES (
      ${randomUUIDv7()},
      ${input.runId},
      ${input.messageId},
      ${input.toolCallId},
      ${input.toolName},
      ${input.arguments}
    )
    RETURNING id, run_id, message_id, tool_call_id, tool_name, arguments,
              decision, created_at, decided_at
  `

  return approval
}

// Pending calls for a run, oldest first (issue order). Drives the approval UI.
export async function listPendingApprovalsForRun(runId: string) {
  return sql.ListPendingApprovalsForRun`
    SELECT id, run_id, message_id, tool_call_id, tool_name, arguments,
           decision, created_at, decided_at
    FROM tool_approvals
    WHERE run_id = ${runId} AND decision = 'pending'
    ORDER BY created_at ASC
  `
}

// Every approval row for a run, oldest first — used by the resume path to
// execute in issue order regardless of decision.
export async function listApprovalsForRun(runId: string) {
  return sql.ListApprovalsForRun`
    SELECT id, run_id, message_id, tool_call_id, tool_name, arguments,
           decision, created_at, decided_at
    FROM tool_approvals
    WHERE run_id = ${runId}
    ORDER BY created_at ASC
  `
}

// Resolve every still-pending call for a run in one shot (batch approve/deny).
export async function decideRunApprovals(input: {
  runId: string
  decision: 'approved' | 'denied'
}) {
  return sql.DecideRunApprovals`
    UPDATE tool_approvals
    SET decision = ${input.decision}, decided_at = now()
    WHERE run_id = ${input.runId} AND decision = 'pending'
    RETURNING id, run_id, message_id, tool_call_id, tool_name, arguments,
              decision, created_at, decided_at
  `
}
