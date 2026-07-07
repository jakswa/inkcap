# Scheduled prompts (routines)

**Status:** scoped, not started (2026-07-07)

## The idea

A **routine** is a saved prompt with a provider/model/tool configuration and a
schedule. When it fires (cron or a manual "Run now" button), the server starts
a normal headless run — same runner, same durability, same approval flow — in a
fresh conversation tagged with the routine. Enable/disable turns the schedule
off without deleting the setup.

The intended polished result is often an [artifact](artifacts.md): a saved,
server-rendered deliverable such as a daily briefing/newspaper page. The
conversation remains the provenance and follow-up surface; notifications can
start by opening the conversation and later open a specific artifact once that
targeting rule is designed.

inkcap is unusually well-positioned for this: most chat apps bolt scheduling
onto a client-owned loop, but our runner already executes unattended — a
routine is just a run nobody clicked "send" for. Prior art worth stealing
from: Anthropic's Claude Code routines / scheduled agents (pick model + tools,
write a prompt, cron schedule, manual trigger), ChatGPT Tasks (scheduled
prompts + notification on completion), and the older automation lineage —
cron itself, Huginn agents, Home Assistant automations — for the
enable/disable + last-result-visible UX conventions.

Example routines that motivate the shape: "every morning at 7, produce a
newspaper-style briefing from news/weather/calendar tools", "Mondays: review my
calendar MCP and draft a week plan", "hourly: check the build dashboard and
only say something if it's red".

## UX (boring CRUD, per house rules)

`/routines` — SSR list (name, schedule, enabled, last fired, link to last
conversation) + new/edit forms. Fields:

- name, **prompt** (the user message), optional system prompt
- provider + model (same picker as new-conversation)
- MCP server/tool configuration for this routine, including any ahead-of-time
  approvals needed for headless execution
- **schedule**: cron expression + a few named presets (daily/hourly/weekly)
  rendered as `<select>` → cron string; store the string. Timezone stored
  per routine (default: server TZ).
- enabled checkbox; **Run now** button (plain form POST, works with JS off,
  also the manual-only mode: leave schedule empty)

Each firing creates a conversation titled `"<name> — <date>"` with
`routine_id` set, so the conversation list can group/filter them and the
routine page links its history. The routine prompt can instruct the model to
call the internal `submit_artifact` tool when it has the finished user-facing
result. Runs park on `waiting_approval` exactly like interactive ones — which is
where [push-notifications](push-notifications.md) earns its keep.

## Schema

```
routines       id, account_id, name, prompt, system_prompt,
               provider_id, model, mcp_config jsonb,
               schedule (cron string, NULL = manual only), timezone,
               enabled, last_fired_at, next_fire_at, timestamps
routine_tool_permissions
               id, routine_id, mcp_server_id, tool_name,
               permission jsonb, created_at
conversations  + routine_id (nullable FK)
```

`next_fire_at` is materialized so the scheduler is a plain indexed query and
the UI can show "next run in 3h" without parsing cron in templates.

## Scheduler: Bun.cron tick + DB as truth

Bun 1.3 ships `Bun.cron(expr, fn)` — in-process, validated 5-field
expressions, overlap-skip, hot-reload-safe. But routines are *dynamic DB
rows*, so we don't register one Bun.cron job per routine (create/edit/delete
would mean juggling job handles). Instead:

- **One `Bun.cron("* * * * *", tick)`** — the only Bun.cron registration.
- `tick`: claim due rows optimistically —
  `UPDATE routines SET next_fire_at = <recomputed> WHERE enabled AND
  next_fire_at <= now() AND next_fire_at = <seen> RETURNING *` — then fire
  each claim (create conversation + message, `startRun`). Single process
  today, but the claim pattern costs nothing and survives a future second
  process.
- **Next-occurrence math**: Bun.cron schedules but doesn't expose "next fire
  after T". Use `croner` (small, zero-dep, tz-aware) purely as a calculator
  for `next_fire_at` — on create/edit, after each fire, and re-validated at
  form submit so a bad expression 422s instead of landing in the table.
- **Misfire policy**: on boot (and in tick), a routine whose `next_fire_at`
  is in the past fires **once** if it's less than one interval / a grace
  window stale, else skips forward with a log line — a laptop asleep all
  weekend should not replay 60 hourly digests. Mirrors the boot-recovery
  philosophy: never silently lose, never duplicate.

Failure isolation: a routine whose run errors just has an errored
conversation to inspect — the schedule keeps ticking. Consider auto-disable
after N consecutive failures (with a notice on the routine page) so a dead
provider doesn't generate an error conversation every hour forever.

## pg-boss: not yet, and here's the line

pg-boss would give us queues, retries, cron, and `SKIP LOCKED` workers on the
Postgres we already run — it's the right *standard* if inkcap grows real
background variety. But routines alone don't clear the bar:

- The **runner is already the durable executor**; routines only need a
  trigger, and the trigger is one `Bun.cron` line + one claiming UPDATE.
- pg-boss brings its own schema, job serialization, and a worker lifecycle to
  supervise — more moving parts than the ~80 lines it would replace, in an
  app whose design is "one stateful process, restart always safe".

**Adopt pg-boss when a second real background workload shows up** (push-retry
queues, bulk re-imports, scheduled exports/summarization, or a second
process). The migration is cheap precisely because the design above keeps DB
rows as the source of truth: swap the tick for a pg-boss cron job, keep
everything else.

## Build order

1. Migration + `/routines` CRUD + **Run now** (no scheduler yet — already
   useful as "saved prompts").
2. Add the lightweight `submit_artifact` path so a manual routine preview can
   produce a user-openable result.
3. The tick: Bun.cron + croner + claim query + misfire policy + boot pass.
4. Push notification on routine completion/approval/error — completed runs open
   the conversation first; artifact-specific links wait for a targeting design.
   See [push-notifications](push-notifications.md).
5. Conversation-list grouping for routine output; auto-disable on repeated
   failure.

## Open questions

- New conversation per fire (current lean) vs. append to one rolling
  conversation per routine? Rolling reads nicely for digests but grows an
  unbounded tree and fights the one-active-run invariant if a fire overlaps
  a parked approval. Start with per-fire + grouping; revisit.
- Retention: hourly routines make conversations/artifacts fast. Auto-prune old
  routine outputs (opt-in per routine)?
- Exact shape of routine tool permissions. Table stakes: routines need their
  own MCP/tool config and ahead-of-time approvals so headless runs can actually
  complete. Safety boundary: approvals are scoped per routine + server + tool +
  capability/argument shape, never global. This overlaps with issue 04's
  approval-bypass risk.
- How rich should briefing artifacts get? Start with markdown under a server
  template; add a dedicated newspaper/front-page template only after the basic
  artifact path is useful.
