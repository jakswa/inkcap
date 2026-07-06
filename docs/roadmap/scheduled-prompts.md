# Scheduled prompts (routines)

**Status:** scoped, not started (2026-07-06)

## The idea

A **routine** is a saved prompt with a provider/model/tool configuration and a
schedule. When it fires (cron or a manual "Run now" button), the server starts
a normal run — same runner, same durability, same approval flow — in a fresh
conversation tagged with the routine. Enable/disable turns the schedule off
without deleting the setup.

spail is unusually well-positioned for this: most chat apps bolt scheduling
onto a client-owned loop, but our runner already executes unattended — a
routine is just a run nobody clicked "send" for. Prior art worth stealing
from: Anthropic's Claude Code routines / scheduled agents (pick model + tools,
write a prompt, cron schedule, manual trigger), ChatGPT Tasks (scheduled
prompts + notification on completion), and the older automation lineage —
cron itself, Huginn agents, Home Assistant automations — for the
enable/disable + last-result-visible UX conventions.

Example routines that motivate the shape: "every morning at 7, summarize
overnight HN/lobste.rs via the fetch MCP server", "Mondays: review my
calendar MCP and draft a week plan", "hourly: check the build dashboard and
only say something if it's red".

## UX (boring CRUD, per house rules)

`/routines` — SSR list (name, schedule, enabled, last fired, link to last
conversation) + new/edit forms. Fields:

- name, **prompt** (the user message), optional system prompt
- provider + model (same picker as new-conversation)
- MCP server selection (reuse the per-conversation override semantics)
- **schedule**: cron expression + a few named presets (daily/hourly/weekly)
  rendered as `<select>` → cron string; store the string. Timezone stored
  per routine (default: server TZ).
- enabled checkbox; **Run now** button (plain form POST, works with JS off,
  also the manual-only mode: leave schedule empty)

Each firing creates a conversation titled `"<name> — <date>"` with
`routine_id` set, so the conversation list can group/filter them and the
routine page links its history. Runs park on `waiting_approval` exactly like
interactive ones — which is where [push-notifications](push-notifications.md) earns its keep.

## Schema

```
routines       id, account_id, name, prompt, system_prompt,
               provider_id, model, mcp_config jsonb,
               schedule (cron string, NULL = manual only), timezone,
               enabled, last_fired_at, next_fire_at, timestamps
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
Postgres we already run — it's the right *standard* if spail grows real
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
2. The tick: Bun.cron + croner + claim query + misfire policy + boot pass.
3. Conversation-list grouping for routine output; auto-disable on repeated
   failure.
4. (later) push notification on fire/park/completion — see
   [push-notifications](push-notifications.md).

## Open questions

- New conversation per fire (current lean) vs. append to one rolling
  conversation per routine? Rolling reads nicely for digests but grows an
  unbounded tree and fights the one-active-run invariant if a fire overlaps
  a parked approval. Start with per-fire + grouping; revisit.
- Retention: hourly routines make conversations fast. Auto-prune routine
  conversations older than N days (opt-in per routine)?
- Should a routine be able to pre-approve specific MCP tools? Convenient for
  true automation, but it widens the prompt-injection surface tracked in
  issue 04 — if we do it, scope it per-tool per-routine, never global.
