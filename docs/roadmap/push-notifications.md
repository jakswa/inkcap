# Browser push notifications

**Status:** scoped, not started (2026-07-06)

## Why this is a natural fit

The whole point of spail is that runs finish while nobody is watching. Today
the only way to learn a run reached a stopping point is to come back and look.
Web Push closes that loop server-side — no polling, no open tab — and it's the
delivery channel [scheduled-prompts](scheduled-prompts.md) needs to be useful ("your morning
routine ran, 1 tool call awaiting approval").

Notify on the runner's existing stopping points, nothing new invented:

- run **parks on `waiting_approval`** — the highest-value one; a parked run is
  dead until a human acts.
- run **errors** (including boot-recovery "interrupted by restart").
- run **completes** — only when no SSE subscriber saw it land (the runner
  already knows its subscriber count; someone watching live needs no push).
- a routine fired (see [scheduled-prompts](scheduled-prompts.md)).

## Mechanics (the standard part)

Web Push is three standards working together, all server-side except a tiny
service worker:

1. **Subscription** (client): a service worker registers, then
   `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`
   yields `{ endpoint, keys: { p256dh, auth } }`, POSTed to us via plain form
   or one fetch in the settings page.
2. **VAPID auth** (RFC 8292): we hold one ES256 keypair (env or a `settings`
   row); each push request carries a short-lived JWT signed with it.
3. **Payload encryption** (RFC 8291, `aes128gcm`): payloads are encrypted to
   the subscription's keys; the push service (FCM/Mozilla/APNs) can't read them.

The npm `web-push` package does 2+3; it's plain node-crypto so it should run
under Bun, but **verify first** — if it fights, the two RFCs are ~200 lines to
hand-roll and we already lean that way. Keep payloads tiny (title, body,
conversation URL); the spec ceiling is ~4KB.

### Schema

```
push_subscriptions  id, user_id, endpoint (unique), p256dh, auth,
                    user_agent, created_at, last_used_at
```

Per-device rows (phone + laptop = two rows). Delete on `404`/`410` from the
push service — that's the standard "subscription expired" signal. Sending is
fire-and-forget from the runner's finalize/park paths; a failed push must
never fail a run.

### Service worker + manifest

This softens the "no PWA" non-goal, deliberately and narrowly: **the service
worker is push-only** — `push` → `showNotification`, `notificationclick` →
focus-or-open the conversation URL. No fetch handler, no caching, no offline.
~30 lines.

Routing wrinkle: a service worker's scope is capped at its own URL path, and
our assets serve from `/assets/:version/…`. Serve `sw.js` (and
`manifest.webmanifest`) at the root — either a small dedicated route or a
`Service-Worker-Allowed: /` header. The manifest needs `display: standalone`,
name, icons (192/512 PNG) — required for the iOS path below.

## The iOS complexity (why this doc exists)

iOS supports Web Push since 16.4, **but only for Home Screen web apps**.
Safari-tab browsing gets nothing. The user journey we have to design for:

1. Open spail in Safari → Share → **Add to Home Screen** (no install prompt
   exists; we have to show instructions, typically a one-time dismissible hint
   for iOS user agents). Manifest with `display: standalone` is mandatory —
   without it, no push even when installed.
2. The installed app has a **separate cookie jar** — the user logs in again
   there. Our encrypted-cookie sessions survive fine; it's just a second login.
3. Request notification permission **from a user gesture inside the installed
   app** (a "Enable notifications" button on settings — never on page load).
4. Delivery then rides APNs transparently; badge counts work via the Badging
   API if we ever want them.

Current-state caveats (mid-2026):

- **EU/DMA:** Apple removed Home Screen web app support in the EU (sites open
  as Safari bookmarks, no push). Personal deployment in the US — noted, not
  blocking.
- **iOS 26** defaults Add-to-Home-Screen to "open as web app", which lowers
  step 1's friction.
- **Declarative Web Push** (Safari 18.4+): JSON-described notifications that
  skip the service-worker `push` handler entirely. Worth adopting as a
  progressive enhancement later; the classic path still works and covers
  Chrome/Firefox/Android, so build classic first.

## Build order

1. VAPID keys + `push_subscriptions` migration + subscribe/unsubscribe on the
   settings page (works on desktop Chrome/Firefox immediately).
2. Runner hooks: `waiting_approval` park + error + unwatched-complete.
3. Manifest + root-scope `sw.js` + iOS install hint → iPhone works.
4. (later) Declarative Web Push variant, badge counts, per-event-type
   preferences.

## Open questions

- Notification preferences granularity: per-user event-type toggles, or ship
  all-on and see if it annoys? (Lean: all-on, one global toggle.)
- Does `web-push` run clean under Bun 1.3? (10-minute spike before committing
  to hand-rolling.)
- Icon set: we have SVGs only; need 192/512 PNGs for the manifest.
