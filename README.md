# inkcap

Server-driven LLM chat. The server owns the conversation: a run is a durable
job that keeps moving even if every browser disconnects. Browsers render state,
subscribe to SSE, and submit forms; the database is truth.

This file doubles as `AGENTS.md` / `CLAUDE.md`, so keep it useful and short.

## Docs

- Current state: `docs/STATUS.md`
- Future work: `docs/roadmap/`
- Security/correctness backlog: `docs/issues/`
- Provider/export/MCP notes: `docs/specs/`
- Design history: `docs/completed/THE_PLAN.md`

## Architecture rules

- CRUD pages are SSR (`src/routes`, `src/views`) with plain HTML forms.
- Client JS is only for chat (`src/static/chat.js`): SSE, token append,
  composer submit. Everything must still work after reload and mostly with JS
  off.
- The runner (`src/services/runner.ts`) streams provider output, persists
  deltas, handles MCP tool loops/approval parking, emits replayable SSE events,
  and recovers interrupted runs on boot.
- Provider/MCP credentials stay server-side. Guard outbound targets with
  `src/utils/outbound-url.ts`.
- Timestamps are UTC throughout PostgreSQL and the application unless a domain
  explicitly needs local wall-clock context (`loops.next_fire_at`).
- Messages are a tree: `messages.parent_id` plus `conversations.curr_node`.
  Edit/regenerate/fork create or select branches; do not flatten this model.
- Markdown is rendered server-side via `src/utils/markdown.ts`. Stream plain
  text, then swap in sanitized rendered HTML when final.

## Setup

Requires Bun and PostgreSQL. Create `inkcap`; create `inkcap_test` if running
tests.

```sh
bun install
cp .env.example .env.local   # fill DATABASE_URL and SESSION_SECRET
bun run db:migrate
bun run dev                  # http://localhost:3000
```

Seed helpers:

```sh
bun src/tasks/seed-provider.ts --user you@example.com
bun src/tasks/seed-demo.ts
bun src/tasks/import-llama-ui.ts <export.jsonl-or.zip> --user you@example.com
```

ChatGPT/Codex provider support is experimental and personal-use only. It uses a
server-side device-code login and stores refreshable tokens in the DB; prefer
API providers for shared/production use. Details: `docs/specs/openai-codex.md`.

## Scripts

```sh
bun run dev         # CSS watch + app watch
bun run db:migrate  # apply SQL migrations
bun run db:types    # regenerate typed query declarations
bun run typecheck   # tsc --noEmit
bun test            # reset/migrate .env.test DB, run tests
bun run app:build   # CSS + production bundle in build/
bun run build       # db:types + typecheck + test + app:build
```

Every `src/tasks/*.ts` is bundled as `build/tasks/*.js` and reads CLI args from
`Bun.argv`.

## Repo map

```txt
src/
├── app.ts, index.ts       Hono app + entrypoint
├── routes/                SSR routes and form handlers
├── views/                 Eta templates
├── static/                Tailwind source, generated CSS, chat island
├── services/              runner, provider clients, MCP, branching
├── db/migrations/         numbered raw SQL migrations
├── db/queries/            bun-sqlgen tagged queries
├── middleware/            render/current-user/session plumbing
├── tasks/                 migrate, seed, import, create-user, mock-provider
└── utils/                 env, markdown, message view, paths, outbound guard
```

Runtime files (`views`, `static`, `db/migrations`) are copied into `build/`;
other server code is bundled. `src/utils/paths.ts` switches between dev/prod
roots.

## Development guardrails

- Add pages in `src/routes`; render with `c.var.render(name, data)`.
- Templates display data only. Keep Eta escaping on. Never raw-print user input.
- Prefer Tailwind utilities. Do not hand-edit generated `src/static/app.css`.
- Do not concatenate SQL or use `sql.unsafe` with user input.
- After DB changes: `bun run db:types && bun run typecheck && bun test`.
- Account scoping matters: providers/MCP servers belong to accounts and must be
  fetched through membership checks so foreign IDs 404.
- Production defaults: registration closed, strong `SESSION_SECRET`, explicit
  `ASSET_VERSION`, migrations before app start.

## Deploy

Published image: `ghcr.io/jakswa/inkcap:latest`.

```sh
docker run -p 3000:3000 --env-file .env.production ghcr.io/jakswa/inkcap:latest \
  sh -lc 'bun build/tasks/migrate.js && exec bun build/index.js'
```

Self-build:

```sh
docker build --build-arg ASSET_VERSION=$(git rev-parse --short=7 HEAD) -t inkcap .
```
