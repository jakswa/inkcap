# Roadmap

Future features and post-v1 polish. Security/correctness hardening lives in
`docs/issues/`; finished plans in `docs/completed/`.

## Scoped features

- **[Scheduled prompts (routines)](scheduled-prompts.md)** — saved prompt +
  provider/tools + cron schedule; each firing is a normal durable headless run.
  Bun.cron tick, DB as truth; pg-boss deferred until a second background
  workload exists.
- **[Artifacts](artifacts.md)** — lightweight AI-created deliverables attached
  to runs. The model calls a tiny `submit_artifact` tool; the server owns
  storage, rendering, links, and notification targeting.
- **[Browser push notifications](push-notifications.md)** — focused first on
  headless routine outcomes: result ready, approval needed, or failure. Web Push
  delivery; includes the iOS install-to-home-screen dance.

## Feature gaps surfaced by the 2026-07-07 audit

Capabilities the specs/schema anticipate but no route implements yet. None is
a regression — they're unbuilt.

- **Conversation export (out of inkcap).** `docs/specs/export-format.md` and
  the importer (`src/utils/llama-ui-import.ts`, `src/tasks/import-llama-ui.ts`)
  cover import *in*; there is no route or task that serializes an inkcap
  conversation back to the JSONL/zip wire format. Round-tripping (import →
  edit → export) and "download my data" both need it. The branch-tree walk
  already exists on the read side; this is mostly the inverse serializer.
- **Attachments over HTTP.** The `attachments` table (bytea) is populated
  *only* by the CLI importer — there is no upload route (no `type=file` in any
  composer view, no multipart handler) and no download/serve route, so
  imported attachments can't even be viewed. Building this needs a serving
  route with a locked-down `Content-Type` + `Content-Disposition: attachment`
  and an ownership check (imported SVG/HTML served inline would be stored XSS
  — design it out from the start), plus a per-attachment body-limit carve-out
  above the global 1 MiB form cap.
- **Prompts & defaults (system prompt, model knobs).** The settings page
  already renders a "Coming soon" card for system-prompt presets, naming
  behaviour, and sampling knobs (`src/views/settings-content.eta`); nothing
  behind it exists — runs send no system prompt and no temperature/sampling
  controls. This is the llama-ui parity gap most visible to a daily user.

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
- No device-code fallback — remote sign-in works, but via the manual
  paste-the-callback-URL form rather than a polished device-code flow.
- `OpenAI-Beta` header deliberately not sent (HTTP-path value unverified).

## Manual QA still wanted

- Branching UX feel (edit/regenerate/switch/delete/fork) vs. llama-ui.
- MCP approval park/resume feel on a real tool-using conversation.
- A real llama-ui history import, eyeballing branched conversations.
