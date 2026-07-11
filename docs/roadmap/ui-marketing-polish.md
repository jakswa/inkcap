# Product UI and marketing polish

Status: complete (2026-07-10).

This pass should make inkcap feel designed for LLM tinkerers rather than expose
its database model as an administration interface. Preserve the warm
Gruvbox/fungal identity, SSR-first architecture, plain HTML forms, and no-JS
fallbacks. Change hierarchy, language, composition, and interaction safety;
do not turn the app into a generic dashboard.

The product story is:

> Connect your models. Give them tools. Turn good prompts into loops.

Durable server-owned runs, replayable SSE, and database truth are important
proof, but should support that story instead of leading every public page.

## Baseline first

Before implementation, preserve screenshots of the current UI. They are both a
design reference and evidence for the final before/after review.

Current captures use the demo account at a 1440x1000 CSS-pixel viewport and a
device scale factor of 1:

- `docs/assets/ui-polish/providers-before-light.png`
- `docs/assets/ui-polish/providers-before-dark.png`
- `docs/assets/ui-polish/loops-before-light.png`
- `docs/assets/ui-polish/loops-before-dark.png`
- `docs/assets/ui-polish/loop-new-before-light.png`

The capture fixture is `src/tasks/seed-demo.ts`. It now creates two realistic
providers, two MCP servers, and three loops: scheduled web research, scheduled
database inspection with approval, and a disabled manual release-note draft.
Future agents should extend this fixture rather than hand-editing screenshot
data in PostgreSQL.

The baseline establishes several specific problems:

- Provider cards have weak separation between identity, health, capabilities,
  routine actions, lifecycle actions, and deletion.
- Provider cards change action placement depending on available horizontal
  space, making the list harder to scan.
- Loop cards present five equally weighted database facts and four equally
  weighted actions. The automation's purpose and current state are secondary.
- Raw cron and machine statuses leak into user-facing UI.
- The loop form is a long stack of boxes rather than a guided configuration.
- An unselected MCP server can visibly have `Approve unattended` checked. This
  is ambiguous and unsafe-looking even if submission parsing later ignores it.
- Full-page screenshots become illegible when reduced to landing-page width.

## Execution contract

Treat this document as an implementation contract, not permission for a broad
redesign. Make the smallest changes that satisfy each workstream and preserve
unrelated work already present in the worktree.

Before editing:

- Read `AGENTS.md`, `docs/STATUS.md`, this document, and every primary file for
  the active workstream.
- Inspect `git status --short` and the relevant diffs. Never revert or overwrite
  changes outside this pass.
- Record the baseline PNG checksums. Files matching
  `docs/assets/ui-polish/*-before-*.png` are immutable evidence and must not be
  regenerated, optimized, renamed, or deleted.
- Run the narrow existing tests for the area before changing behavior. If they
  already fail, report that fact rather than weakening assertions.

Development commands have distinct purposes:

- `bun run dev` is the intended live-reload command: `src/dev.ts` starts both
  `css:watch` and `bun --watch`. In an environment without `watchman`, the CSS
  watcher exits and `src/dev.ts` stops both children. Do not claim live reload
  works unless this command remains running after startup.
- `bun run start` performs a one-time minified CSS build and starts the server.
  It does not watch CSS or reload server code. Restart it after server/template
  changes and rebuild CSS after Tailwind source/template changes.
- Deterministic screenshot automation must not depend on either watch mode or
  a separately running developer server. It owns its lifecycle as specified in
  Workstream 1.

After each workstream, stop and verify its acceptance criteria before touching
the next one. Do not compensate for a failed test or awkward UI by deleting
functionality, hiding information, adding JavaScript-only behavior, or changing
the fixture to avoid the state.

### Visual-review boundary

A delegated implementation agent may be unable to view or interpret PNG/WebP
output. Such an agent must not claim that a screenshot looks correct, that a
before/after comparison improved the design, that text is visually legible, or
that responsive composition passed merely because image files were created.

The implementation agent is responsible for objective evidence:

- Generate the requested files and report exact paths, pixel dimensions, byte
  sizes, routes, viewport, theme, browser version, and capture command.
- Check HTTP responses, browser console/page errors, overflow measurements,
  element visibility, focus order, accessible names, and decoded-pixel
  stability where automation can establish them.
- Provide DOM snapshots or concise extracted text for each captured state when
  useful, but do not treat them as a substitute for visual inspection.
- Mark visual composition, hierarchy, cropping, contrast appearance, and image
  legibility as `awaiting visual review` rather than `passed`.

The orchestrating agent is the primary visual reviewer. It must open the images,
approve composition, and own the result rather than forwarding the delegated
agent's self-report. Work pauses at two gates: after provider/loop application
screenshots are generated and before landing/marketing composition is
finalized; and after the final capture matrix is generated but before public
WebPs are replaced.

At each gate, the orchestrator must either approve the candidate or resume the
same delegated agent with a concrete correction list tied to files, routes, and
observed defects. Repeat capture, visual review, and correction until the gate
passes. Reuse the same agent session where possible so it retains implementation
context. Escalate to the user only for a product-direction pivot, a meaningful
tradeoff not settled by this plan, or a blocker the orchestrator cannot resolve.
If no capable visual reviewer is available, retain existing public images and
report the work as incomplete.

## Design direction

Keep:

- Warm paper/soil surfaces, inkcap purple, olive status color, mushroom mark.
- Strong display headings and restrained shadows.
- Server-rendered pages, semantic HTML, and ordinary links/forms.
- Dense technical information when it helps a tinkerer make a decision.
- Light and dark modes driven by the existing token system.

Improve:

- Give every page one obvious next action.
- Lead cards with purpose and current state, then configuration metadata.
- Use progressive disclosure for secondary and destructive actions.
- Prefer human labels such as `Waiting for approval` over
  `waiting_approval`, and describe cron schedules in ordinary language while
  retaining the expression as secondary text.
- Use small, deliberate visual motifs rather than a generic icon library.
  Status dots, connecting lines, and mono labels can suggest a living system.
- Keep controls large enough for touch and preserve visible focus states.
- Use focused product crops in public storytelling; reserve full-page captures
  for detailed galleries or documentation.

Do not:

- Add a client framework or general-purpose component library.
- hide essential configuration behind JavaScript-only behavior.
- add gradients, glass panels, excessive pills, or interchangeable SaaS cards.
- invent compatibility layers for old markup without a concrete consumer.
- hand-edit generated `src/static/app.css`.

## Workstream 1: capture workflow

This workstream comes before UI edits so no baseline is lost. The initial
captures above are complete, but the ad hoc capture command should become a
small reproducible project task before final screenshots are made.

Scope:

- Add a browser automation development dependency only if the repository will
  retain the workflow. Prefer Playwright using the system Chromium executable
  when available; document browser installation otherwise.
- Add a task such as `src/tasks/capture-product-shots.ts` or a focused script
  under `scripts/`. It must seed data, log in, select color scheme and viewport,
  wait for fonts/layout, and write deterministic files.
- The command must run `bun run css:build`, start `bun src/index.ts` itself on a
  dedicated configurable port, wait for an HTTP readiness check, capture, and
  stop only the child process it started in success and failure paths. It must
  not invoke `bun run dev`, require `watchman`, kill processes by name, or
  assume port 3000 is free.
- If the capture command finds its configured port occupied, fail with a clear
  message instead of capturing from an unknown server.
- Use `.env.test` or an explicit disposable screenshot database. Never delete
  or reseed a developer's normal database as a side effect of image capture.
- Make time-dependent fixture output stable. Pass a fixed capture clock into
  fixture creation or otherwise seed fixed instants and freeze browser time.
  Do not rely on `Date.now()` while claiming pixel-stable output. Prevent the
  scheduler from firing seeded loops during capture.
- Pin the browser package/version used by the task. A system Chromium path may
  be configurable, but the command must validate it and explain how to supply
  one rather than silently selecting a different browser.
- Separate archival baseline output under `docs/assets/ui-polish/` from public
  optimized WebP output under `marketing-site/shots/` and `src/static/shots/`.
- Capture at stable CSS dimensions, then encode WebP without changing the
  declared intrinsic aspect ratio.
- Never include real credentials, tokens, hostnames, account email, or current
  personal data.

Required final capture matrix:

| Subject | Theme | Viewport | Use |
| --- | --- | --- | --- |
| Focused chat hero | light + dark | 1440x900 | app and marketing hero |
| Provider registry | light + dark | 1440x1000 | gallery/marketing |
| Loops dashboard | light + dark | 1440x1000 | gallery/marketing |
| Loop configuration | light | 1440x1000 | marketing detail |
| MCP approval | dark | 1440x900 | marketing detail |
| Chat | light | 390x844 | mobile proof |

Acceptance criteria:

- One documented command regenerates all final screenshots from a seeded DB.
- Captures are stable across two consecutive runs except for encoded metadata.
- The two-run stability check compares decoded pixels or normalized image
  output, not file timestamps alone.
- A failed capture leaves no child server running and does not modify the
  baseline PNGs or the normal development database.
- Public images have useful alt text and no text smaller than is legible at the
  rendered width.
- Baseline PNGs remain unchanged through the implementation pass.

## Workstream 2: shared application patterns

Primary files:

- `src/static/app.tailwind.css`
- `src/views/partials/header.eta`
- affected route templates under `src/views/`

Create a small vocabulary from existing utilities rather than a large
component abstraction:

- Page intro: eyebrow, bounded title, useful sentence, one primary action.
- Resource card: identity/state header, purpose/content body, compact facts,
  primary action, secondary action menu/disclosure.
- Status treatment: healthy, paused, running, waiting, failed, and neutral.
- Definition row: human label plus value, with technical source as secondary.
- Empty state: explain what the object unlocks and provide one starter action.
- Danger zone: visually separated and confirmed, never adjacent to routine
  actions.

Keep these as CSS classes and template composition unless actual reuse makes a
partial clearer. Do not introduce helpers solely to rename one Tailwind string.

Global acceptance criteria:

- Pages work at 390px and 1440px without horizontal overflow.
- Keyboard focus is obvious; headings and form labels remain correctly nested.
- Forms remain usable with JavaScript disabled.
- Light and dark contrast remains clear for text, borders, statuses, and focus.
- Destructive POSTs require an explicit confirmation step or dedicated screen.

## Workstream 3: providers

Primary files:

- `src/views/providers/index-content.eta`
- `src/views/providers/new-content.eta`
- `src/views/providers/edit-content.eta`
- `src/views/providers/codex-device-content.eta`
- `src/routes/providers.ts`
- `tests/integration/providers.test.ts`
- `tests/integration/codex.test.ts`

Registry composition:

- Lead with provider name and a plain-language connection state.
- Show provider kind, endpoint host, default model, authentication state, and
  discovered model count in a compact facts area.
- Keep model capabilities available, but prevent long model lists from
  dominating the card. Show a representative subset and disclose the rest.
- Make `Test connection` the context-sensitive primary action when health is
  unknown or failed; otherwise prefer `Edit` as the routine action.
- Move enable/disable and delete into a clearly secondary management area.
- Render successful tests as a concise health result with inference model,
  latency if available, model count, and meaningful capabilities. Keep detailed
  discovery output available without flooding the card.

Creation/edit composition:

- Explain provider choices in user language: local llama-server,
  OpenAI-compatible API, or ChatGPT/Codex sign-in.
- Keep Codex experimental/personal-use messaging honest but not alarming.
- Group identity, connection, authentication, and model defaults.
- Preserve credential masking and all account-scoping behavior.
- A failed test must retain entered non-secret fields and give a useful next
  action. Never reflect raw secrets.

Codex device flow:

- Make the one-time code and verification destination the visual focus.
- Clearly show pending, expired, failed, and connected states.
- Automatic polling is optional; if added, retain the manual POST fallback.

Provider acceptance criteria:

- A user can distinguish local, hosted API, and Codex providers at a glance.
- Enabled state and connection health are not conflated.
- Delete cannot happen from an unconfirmed adjacent button click.
- Long URLs and model names wrap or truncate without displacing actions.
- Existing ownership, masking, CRUD, and discovery tests continue to pass.

## Workstream 4: loops

Primary files:

- `src/views/loops/index-content.eta`
- `src/views/loops/form-content.eta`
- `src/views/loops/show-content.eta`
- `src/routes/loops.ts`
- `src/services/loops.ts`
- `src/db/queries/loops.ts`
- new `tests/integration/loops.test.ts`

Language:

- Keep `Loops` as the product noun. Use `automation` in explanatory copy for
  people who do not yet know the noun.
- Replace `Scheduled prompt/tool loops` with a benefit-led heading.
- Explain that every run becomes an inspectable chat, but do not repeat the
  implementation model on every card.

Dashboard composition:

- Lead with loop name, enabled/paused state, and next meaningful event.
- Show a human schedule such as `Weekdays at 8:00 AM ET`; retain
  `0 8 * * 1-5` as quiet technical detail or in the details screen.
- Give the latest run a visible state: never run, running, completed, waiting
  for approval, or failed. Humanize all status labels.
- Make `Run now` the clear primary action. Details should be available through
  the card/title. Move enable/disable and edit into secondary controls.
- Emphasize approval-required and failed loops without making healthy loops
  visually noisy.
- Surface artifacts only when they exist or when artifact production is part of
  the loop's recipe.

Form composition:

- Organize the page as `Task`, `Model`, `When`, and `Tools & permission`.
- Start with a manual-only/scheduled choice. Offer useful schedule presets and
  an advanced cron field rather than presenting raw cron as the default mental
  model.
- Show a human preview of the next occurrence and timezone before submission.
  Server-side validation remains authoritative.
- Populate models from the selected provider where possible. Any enhancement
  must preserve a plain input/select fallback.
- Show reasoning effort only when meaningful for the selected provider/model,
  or explain that unsupported providers ignore it.
- Treat each MCP selection and its unattended permission as one nested choice.
  An unselected server must not submit, display, or imply auto-approval.
- Explain the consequence beside unattended approval: calls from that server
  may run without a later click. Do not rely on color alone.
- Save as paused by default unless the user explicitly enables a schedule.

Details composition:

- Present the recipe and run history as the core of the page.
- Each run shows time, human status, duration if known, artifact link if any,
  and chat link. Errors should be readable without exposing stack traces.
- Keep delete in a separated danger area with confirmation.

Loops acceptance criteria:

- No machine status identifiers appear in rendered user-facing text.
- Schedule meaning is understandable without knowing cron.
- An unselected MCP server cannot be auto-approved in UI or submitted state.
- Manual-only, scheduled-paused, and scheduled-enabled states are distinct.
- Run-now, enable/disable, create/edit, validation, deletion, ownership, and MCP
  permission behavior have integration coverage.
- The dashboard remains useful with zero runs and with long prompt text.

## Workstream 5: app landing page

Primary files:

- `src/views/home-content.eta`
- `src/routes/home.ts`
- `src/static/app.tailwind.css`
- `src/static/shots/`

The app landing page is both a public welcome and an authenticated launchpad.
Keep its CTAs conditional, but use the same product story as marketing.

Composition:

- Hero: mushroom mark, `inkcap`, concise tinkerer promise, and current auth CTA.
- Product proof: do not shrink an entire 1440px application into `max-w-4xl`.
  Use a focused chat crop or an overlapping two-frame composition where the
  main text and controls remain legible.
- Three-step story: connect a provider, have a durable tool-using conversation,
  turn a useful prompt into a loop.
- Keep implementation details in a quiet proof strip rather than the main
  feature cards.
- Avoid duplicating all marketing copy; the app page should stay shorter.

Acceptance criteria:

- The primary screenshot is legible at common laptop and phone widths.
- Logged-out, registration-open, registration-closed, and authenticated CTA
  states remain correct.
- Page weight remains modest and no landing-page JavaScript is added.

## Workstream 6: marketing site

Primary files:

- `marketing-site/index.html`
- `marketing-site/style.css`
- `marketing-site/getting-started.html`
- `marketing-site/shots/`

Audience:

- Primary: LLM tinkerers who connect local or hosted models, try tools, compare
  models, and reuse successful workflows.
- Secondary: less-technical self-hosters willing to follow a clear Docker
  setup.
- Proof audience: technical readers who care about durability, credentials,
  SSR, branching, and the small JavaScript surface.

Suggested page sequence:

1. Hero: `Connect your models. Give them tools. Keep the good ideas running.`
2. Focused product composition with direct `Get started` and `View GitHub`
   actions.
3. Three-step narrative: providers, conversations/tools, loops.
4. Durable-run proof using the approval and phone moments.
5. Focused providers and loops gallery, not more full-page miniatures.
6. Quiet technical proof: server-owned runs, PostgreSQL truth, branching,
   credentials server-side, minimal JS.
7. A readable quick start that links to the detailed setup page rather than
   making one very long Docker command the visual centerpiece.

Copy principles:

- Lead with what a tinkerer can do, then explain why inkcap is dependable.
- Use `self-hosted` and supported provider names early enough to qualify users.
- Avoid claims of enterprise security, universal provider compatibility, or
  hands-off autonomy.
- Explain ChatGPT/Codex support as experimental and personal-use only where it
  is presented.
- Keep the existing understated humor and mushroom personality.

Visual composition:

- Preserve static HTML/CSS and automatic light/dark color schemes.
- Make the mushroom hero more editorial, not larger for its own sake.
- Use asymmetric screenshot crops and short annotations to point at the exact
  capability being discussed.
- Keep body measure readable and vary section rhythm; avoid six identical
  feature cards as the dominant page structure.
- Update metadata, Open Graph image/description if introduced, captions, and
  alt text with the final narrative.

Marketing acceptance criteria:

- A new visitor can identify self-hosting, provider choice, tools, and loops
  without reading architecture copy.
- A technical visitor can still find durable-run and security-model details.
- The landing and getting-started pages work at 390px and 1440px in both color
  schemes.
- Navigation, setup links, GitHub links, Docker command, and Pages deployment
  remain valid.

The root `README.md` should remain technical. Do not add a screenshot gallery
there unless a later documentation goal requires it.

## Delegation order

Agents should work in this order. Each agent must read this document,
`AGENTS.md`, and the files named in its workstream before editing.

1. **Capture/fixture agent**: finalize deterministic fixture and checked-in
   screenshot command. Must not alter baseline captures.
2. **Pattern/provider agent**: shared CSS vocabulary and provider screens,
   including tests and responsive QA.
3. **Loops agent**: dashboard, form, details, interaction safety, and dedicated
   integration tests. Rebase mentally on shared patterns rather than creating a
   parallel design language.
4. **Interim capture and visual gate**: rerun the capture command for provider
   and loop states. The orchestrator must inspect the images and either approve
   the application direction or resume the implementation agent with specific
   corrections before landing/marketing composition proceeds.
5. **Landing/marketing agent**: app landing and static marketing narrative.
   Use temporary crops until final application screens are stable.
6. **Capture agent**: produce the final screenshot matrix and objective capture
   report for both themes and mobile. It must not approve visual quality.
7. **Visual reviewer/orchestrator**: open every baseline and candidate image,
   compare before and after, resume the implementation agent for corrections as
   needed, and explicitly approve the selected crops only after iteration.
8. **Publication agent**: only after recorded visual approval, replace public
   WebPs, update intrinsic dimensions/captions/alt text, and rerun final checks.

For a single agent executing the whole pass, these are still hard checkpoints,
not suggestions. At each checkpoint it must inspect the diff, run the listed
verification, and resolve regressions before proceeding. Public screenshots
must be replaced only at checkpoint 8, after provider, loop, landing, and
marketing behavior is stable and checkpoint 7 records visual approval.

Provider and loops agents can work in parallel only after the shared pattern
vocabulary is agreed or landed. Marketing HTML/CSS can proceed in parallel, but
final composition and image dimensions must wait for polished screenshots.

Every delegated agent should return:

- Files changed and user-visible behavior changed.
- Tests and manual viewport/theme checks performed.
- Any acceptance criteria intentionally deferred.
- Screenshots or exact routes/states that the visual reviewer should inspect.
- Which checks are objective passes and which remain `awaiting visual review`.

The agent must not:

- Change routes, database schema, service behavior, or client JavaScript merely
  to make a composition easier unless a workstream explicitly requires it.
- Add Playwright to production dependencies, commit browser binaries, or add a
  second screenshot framework if an existing retained tool can do the job.
- Hand-edit `src/static/app.css`, baseline PNGs, or generated query types.
- Replace all application typography, color tokens, navigation, or card markup
  outside the named surfaces as an unsolicited global redesign.
- Mark an acceptance criterion complete based only on code inspection when it
  calls for a viewport, theme, keyboard, no-JS, image, or behavioral check.
- Infer visual quality from file existence, dimensions, OCR, DOM text, image
  hashes, or a successful browser automation exit code.

## Verification

Run the verification for each checkpoint before proceeding:

```sh
# Checkpoint 1: capture/fixture
bun run typecheck
# Run the checked-in capture command twice and compare normalized output.

# Checkpoint 2: shared patterns/providers
bun run css:build
bun run typecheck
bun test tests/integration/providers.test.ts

# Checkpoint 3: loops
bun run css:build
bun run typecheck
bun test tests/integration/loops.test.ts

# Checkpoint 4: app landing/marketing
bun run css:build
bun run typecheck
bun run app:build
```

The comments describe required actions; replace the capture comment with the
actual checked-in command once its script name is chosen. Do not run a missing
future test during an earlier checkpoint and report that expected absence as a
regression.

Run before completion:

```sh
bun run db:types
bun run typecheck
bun test
bun run app:build
```

Manual review matrix:

- 390px and 1440px widths.
- Light and dark schemes.
- Empty, healthy, disabled/paused, waiting-approval, and failed states.
- JavaScript enabled and disabled for forms/navigation.
- Keyboard-only traversal and visible focus.
- Long provider names, model names, endpoints, loop names, and prompts.
- Registration open/closed and authenticated/anonymous landing states.
- Browser console has no errors, every form action reaches the expected route,
  and no server process remains after automated capture.

Verification reporting must distinguish `passed`, `failed`, and `not run`.
Missing local infrastructure is not a pass. Include the command and concise
failure reason for anything not completed.

For visual criteria, use a fourth status: `awaiting visual review`. Only the
orchestrating reviewer or user may change that status to `passed`, and the
approval should identify the reviewed file paths.

## Completion definition

This pass is complete when providers and loops are safer and easier to scan,
the public story speaks first to LLM tinkerers, focused screenshots are legible
at their rendered sizes, baseline and final captures can be regenerated, and
the entire application build passes without weakening SSR/no-JS behavior.
