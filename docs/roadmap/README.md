# Roadmap

Future features and post-v1 polish. Security/correctness hardening lives in
`docs/issues/`; finished plans in `docs/completed/`.

## Scoped features

- **[Browser push notifications](push-notifications.md)** — notify on run
  stopping points (approval parks, errors, unwatched completions) via Web
  Push; includes the iOS install-to-home-screen dance.
- **[Scheduled prompts (routines)](scheduled-prompts.md)** — saved prompt +
  provider/tools + cron schedule; each firing is a normal durable run.
  Bun.cron tick, DB as truth; pg-boss deferred until a second background
  workload exists.

## Polish backlog (from v1 final integration, 2026-07-06)

None block daily use.

- **Edit-user "Save (keep responses)"** (llama-ui spec C.1(b)): saving an
  edit always regenerates; a second submit button hitting a no-run route
  would add save-without-regenerate.
- **Manual assistant edit** (spec C.2): regenerate-as-sibling shipped;
  hand-editing assistant content with a branch toggle did not.
- **Sibling switcher is SSR-only**: after a live finalize-swap the ‹ i/n ›
  switcher appears on next page load, not instantly (siblingNav is computed
  in the route, not the runner's partial render).
- **Fork edge cases**: forking mid-stream copies the streaming leaf as-is
  (no run drives it in the fork); fork doesn't copy attachments.
- **Runner stream resume**: "resume if provider supports it" is the
  finalize-as-interrupted fallback only.

## Codex provider polish (post-M8 gaps)

- Usage-window surfacing (`/wham/usage`) is not built; 429s surface as run
  errors with the upstream message.
- No device-code fallback — sign-in needs the browser on the server's
  machine (or an SSH tunnel of :1455).
- `OpenAI-Beta` header deliberately not sent (HTTP-path value unverified).

## Manual QA still wanted

- Branching UX feel (edit/regenerate/switch/delete/fork) vs. llama-ui.
- MCP approval park/resume feel on a real tool-using conversation.
- A real llama-ui history import, eyeballing branched conversations.
