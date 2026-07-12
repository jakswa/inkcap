# Roadmap

Future product work only. Security/correctness hardening is in `docs/issues/`;
completed plans and design history are in `docs/completed/`.

## Bigger slices

- **Draft a loop from chat** (`chat-to-loop-draft.md`): turn the active branch
  into reviewable, prefilled loop form data. Never auto-save or infer unattended
  permission.
- **Browser-footprint budget** (`browser-footprint-budget.md`): reproduce and
  enforce the small browser-asset claim instead of relying on stale marketing
  numbers.
- **Operational footprint** (`operational-footprint.md`): provide a supported
  one-command Compose path and evaluate, without promising, an embedded personal
  mode.
- **Codex auth cleanup** (`codex-device-auth.md`): device-code auth is the
  default; keep loopback fallback until real-account QA says otherwise.

## Known feature gaps

- **Export out of inkcap**: the importer exists, but no route or task serializes
  an inkcap conversation to the JSONL/zip format in
  `docs/specs/export-format.md`.
- **Attachments over HTTP**: the importer stores attachments, but there is no
  upload or download route. Serving must enforce ownership and safe headers.
- **Prompts/defaults**: no system-prompt presets or sampling/model knobs yet.

## Polish backlog

- Edit a user message without regenerating.
- Manual assistant-message edit.
- Live sibling-switcher update after finalize-swap.
- Fork edge cases: mid-stream leaves and attachments.
- Provider stream resume beyond finalize-as-interrupted fallback.
- Codex usage-window surfacing; 429s currently show as run errors.

## Manual QA wanted

- Branching UX against llama-ui expectations.
- MCP approval park/resume on a real tool conversation.
- Real llama-ui import with branched conversations and attachments.
- Device-code Codex login with a real account.
- Push setup and loop notifications on desktop and installed iOS.
