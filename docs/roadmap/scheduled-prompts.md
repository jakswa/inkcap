# Scheduled prompts / routines

Status: scoped, not started.

A routine is a saved prompt with provider/model/tool config and a schedule. A
fire creates a normal headless conversation/run, so durability, MCP approvals,
branching, and recovery stay in the existing runner.

## UX

`/routines` should be boring SSR CRUD:

- name, user prompt, optional system prompt
- provider/model
- MCP/tool config plus ahead-of-time approvals for headless execution
- cron schedule with simple presets; empty schedule means manual-only
- enabled checkbox and **Run now** button
- last/next fire and links to produced conversations

Each fire should create a fresh conversation tagged with `routine_id`. Start
with per-fire conversations, not one ever-growing thread.

## Schema sketch

```txt
routines(id, account_id, name, prompt, system_prompt,
         provider_id, model, mcp_config,
         schedule, timezone, enabled,
         last_fired_at, next_fire_at, timestamps)
routine_tool_permissions(id, routine_id, mcp_server_id, tool_name,
                         permission, created_at)
conversations + routine_id
```

Materialize `next_fire_at` so the scheduler and UI do not parse cron in hot
paths.

## Scheduler choice

Use one in-process `Bun.cron("* * * * *", tick)` and keep the DB as truth.
The tick claims due rows with an optimistic `UPDATE ... WHERE next_fire_at =
<seen> RETURNING *`, recomputes `next_fire_at`, then starts runs.

Use a small cron parser (for example `croner`) only for next-occurrence math.
Skip large stale backlogs on boot; a sleeping laptop should not replay every
missed hourly run.

Do not add pg-boss for routines alone. Reconsider it when there is a second
real background workload such as push retries, bulk imports, scheduled exports,
or multi-process workers.

## Build order

1. Migration + CRUD + manual **Run now**.
2. Artifact submission path for previewable routine outputs.
3. Cron tick, claim query, misfire policy, boot pass.
4. Push notifications for completion/approval/error.
5. Conversation-list grouping and repeated-failure auto-disable.
