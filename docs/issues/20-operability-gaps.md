# 20 — Operability gaps: no health endpoint, no HEALTHCHECK, silent run errors

**Severity:** Medium (an operator can't tell a degraded instance from a healthy one)
**Found:** ops-readiness audit, 2026-07-07

A cluster of small holes that together make the single stateful process hard
to operate. None is a security issue; all are "you won't know it's broken."

## 20a — No health/readiness endpoint

No `/health`, `/healthz`, or `/up` route exists (route list in
`src/app.ts`). `GET /` (`src/routes/home.ts`) renders without touching the DB
— `currentUser` only decrypts a cookie — so an uptime monitor pointed at `/`
returns 200 even during a full database outage.

**Fix:** add an unauthenticated `GET /healthz` that runs `SELECT 1` and is
excluded from request logging.

## 20b — No Docker HEALTHCHECK

`Dockerfile` has no `HEALTHCHECK` instruction, so an orchestrator has no
container-level signal of liveness/readiness.

**Fix:** `HEALTHCHECK CMD` curling `/healthz` (depends on 20a).

## 20c — No migrate-on-boot path

Migration is a manual `bun build/tasks/migrate.js` (README). Nothing stops
new code from booting against an old schema.

**Fix:** an entrypoint that runs `migrate` then `exec bun build/index.js`, or
a documented compose init pattern.

## 20d — Run errors never logged

`finishRun(handle, 'error', message)` (`src/services/runner.ts`) persists the
error to the DB/UI but never logs it. The runner's only `console.error`s are
listener failure and finalize failure. A provider outage that errors every
run produces **zero** server-side log lines. There is also no request/access
logging (`hono/logger` is not wired into `src/app.ts`).

**Fix:** log run errors with run/conversation ids at the `finishRun('error')`
call site; add a minimal request logger.

## Related

- Graceful shutdown ([19](19-graceful-shutdown-drain.md)).
- `run_events` unbounded growth / boot-only cleanup ([17a](17-low-priority-hardening.md)).
