# Browser push notifications

**Status:** scoped, not started (2026-07-07)

## Why this exists

Notifications are primarily for **headless routine runs**: work the server did
while the user was away. The motivating use case is a daily briefing that
finishes in the morning and opens as an [artifact](artifacts.md), not raw chat.

Keep the first notification product narrow:

- routine **completed** → open the conversation, where produced artifacts are
  visible.
- routine **parks on `waiting_approval`** → open the conversation approval UI.
- routine **errors** → open the errored conversation.

Opening a specific artifact directly is desirable, especially for daily
briefings, but the targeting rule is intentionally not designed yet.

General chat notifications can exist later, but they are not the reason to ship
Web Push. The personal value is: "my scheduled/headless result is ready" or
"my scheduled/headless run needs me."

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

1. Open inkcap in Safari → Share → **Add to Home Screen** (no install prompt
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
2. Routine-run notification hooks: completed, `waiting_approval`, error.
   Completed routine runs open the conversation URL first; artifact-specific
   notification links wait for an explicit targeting design.
3. Manifest + root-scope `sw.js` + iOS install hint → iPhone works.
4. (later) General chat notifications, Declarative Web Push variant, badge
   counts, per-event-type preferences.

## Open questions

- Notification preferences granularity: probably one global toggle first,
  because only routine outcomes notify initially.
- Does `web-push` run clean under Bun 1.3? (10-minute spike before committing
  to hand-rolling.)
- Icon set: we have SVGs only; need 192/512 PNGs for the manifest.
- Should routine completion without an artifact notify, or should only
  artifact-producing routines produce "ready" pushes? Lean: notify, but link to
  chat as fallback.
- How does a run choose an artifact-specific notification target when multiple
  artifacts exist? Not designed yet; do not add a hidden `primary` rule until
  this is settled.
