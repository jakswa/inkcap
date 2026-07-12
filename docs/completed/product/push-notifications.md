# Browser push notifications

Status: completed 2026-07-10. This is the original implementation plan; see
`src/routes/push.ts` and `src/services/push.ts` for current behavior.

First use case: headless routine outcomes. Notify when a routine completes,
parks for approval, or fails. General chat notifications can wait.

## Mechanics

- Store one row per device subscription:

```txt
push_subscriptions(id, user_id, endpoint unique, p256dh, auth,
                   user_agent, created_at, last_used_at)
```

- Use Web Push + VAPID. Try the `web-push` package under Bun before deciding to
  hand-roll the RFC bits.
- Payloads should be tiny: title, body, conversation URL.
- Delete subscriptions on `404`/`410` from the push service.
- Sending is fire-and-forget from runner finalize/park paths; push failure must
  never fail a run.

## Client surface

Add a settings-page enable/disable flow and a root-scope `sw.js`. The service
worker should be push-only: no fetch handler, no offline cache.

For iOS, support the Home Screen web-app path: manifest at root, install hint,
then request permission from a user gesture inside the installed app. Safari tab
push is not enough.

## Build order

1. VAPID keys, migration, settings subscribe/unsubscribe.
2. Routine hooks: completed, `waiting_approval`, error. Link to conversation
   first; artifact-specific links wait for an explicit targeting rule.
3. Root `sw.js`, manifest, icons, iOS install hint.
4. Later: preferences, general chat notifications, badges, Declarative Web
   Push.

## Open decisions

- Notification preference granularity.
- Icon generation.
- Whether routine completion without artifacts should notify.
- How a run chooses one artifact target when multiple artifacts exist.
