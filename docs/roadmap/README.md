# Roadmap

Future product work only. Security/correctness hardening is in `docs/issues/`;
completed design history is in `docs/completed/`.

## Bigger slices

- **Product UI and marketing polish** (`ui-marketing-polish.md`): provider and
  loop UX, shared interaction patterns, reproducible screenshots, and a
  tinkerer-first app/marketing story.
- **Routines / scheduled prompts** (`scheduled-prompts.md`): saved prompt +
  provider/model/tools + cron/manual trigger. Each fire creates a normal
  durable run.
- **Artifacts** (`artifacts.md`): server-owned deliverables produced by runs,
  useful for headless routine outputs such as daily briefings.
- **Browser push** (`push-notifications.md`): notify when a routine completes,
  needs approval, or fails.
- **Codex auth cleanup** (`codex-device-auth.md`): device-code auth is the
  default; keep loopback fallback until real-account QA says otherwise.
- **Draft a loop from chat** (`chat-to-loop-draft.md`): an explicit inference
  turns the active conversation branch into reviewable, prefilled loop form
  data; it must never auto-save or infer unattended permission.
- **Browser-footprint budget** (`browser-footprint-budget.md`): reproduce and
  enforce the small browser-asset claim instead of relying on stale marketing
  numbers.
- **Operational footprint** (`operational-footprint.md`): provide a supported
  one-command Compose path and evaluate, without promising, an embedded personal
  mode.

## Known feature gaps

- **Export out of inkcap**: importer exists; no route/task serializes an inkcap
  conversation back to the JSONL/zip format in `docs/specs/export-format.md`.
- **Attachments over HTTP**: importer stores attachments, but there is no upload
  or download route. Serving must enforce ownership and safe content headers.
- **Prompts/defaults**: no system prompt presets or sampling/model knobs yet.
- **AI decoration toggles**: optional side jobs for titles/share copy/etc. are
  not built.

## Polish backlog

- Edit user message without regenerating.
- Manual assistant-message edit.
- Live sibling switcher update after finalize-swap.
- Fork edge cases: mid-stream leaves and attachments.
- Provider stream resume beyond finalize-as-interrupted fallback.
- Codex usage-window surfacing; 429s currently show as run errors.

## Manual QA wanted

- Branching UX against llama-ui expectations.
- MCP approval park/resume on a real tool conversation.
- Real llama-ui import with branched conversations and attachments.
