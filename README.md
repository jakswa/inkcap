# inkcap

A server-driven LLM chat app: the **server owns the conversation**. A chat "run"
is a durable server-side job — close the laptop mid-generation, open your phone
later, and the chat reached a sensible stopping point without you. Rewrite of
llama.cpp's web UI (the fork at `~/sandbox/llama-ui` is the living spec), built
on the bun-hono-ssr starter: Hono routes, Eta SSR templates, HTML forms,
PostgreSQL, raw SQL migrations, encrypted cookie sessions, Tailwind.

Docs: `docs/STATUS.md` (current state), `docs/roadmap/` (future features +
polish backlog), `docs/issues/` (hardening work; resolved ones in
`resolved/`), `docs/specs/` (harvested provider/export/MCP specs),
`docs/completed/` (finished plans — THE_PLAN.md is the design record).

## Shape

- **Boring CRUD is boring.** Conversation list, providers, MCP servers, auth:
  SSR templates and plain HTML forms, no client JS.
- **JS is a budget, spent on the chat view only.** One hand-rolled island
  (`src/static/chat.js`): SSE subscribe, token append, composer submit. Every
  action still works as a plain form with JS off.
- **The server is the agent runtime.** `src/services/runner.ts` streams from
  the provider, persists deltas on a debounce (300ms/24 deltas), runs the MCP
  tool loop, parks on `waiting_approval`, recovers interrupted runs on boot.
  Browsers are spectators: SSE fan-out with `Last-Event-ID` replay; zero
  subscribers changes nothing; page reload always shows DB truth.
- **Provider and MCP keys never reach the browser.** Server-side rows; the
  server makes all upstream calls (`src/utils/outbound-url.ts` guards targets).
- **Messages are a tree.** `messages.parent_id` + `conversations.curr_node`
  pick the active path; edit/regenerate create siblings; branching is schema,
  the UI is just forms.
- Markdown renders **server-side** (`marked` + `highlight.js` + `sanitize-html`
  in `src/utils/markdown.ts`); streams show plain text, then finalize-swap to
  rendered HTML.

## Quick Start

Needs local PostgreSQL with `inkcap` and `inkcap_test` databases.

```sh
bun install
cp .env.example .env.local         # DATABASE_URL, SESSION_SECRET
bun run db:migrate
bun run dev                        # http://localhost:3000 — register first
bun src/tasks/seed-provider.ts --user you@example.com
                                   # llama-server provider from DEV_LLAMA_SERVER /
                                   # DEV_LLAMA_KEY, owned by that user's account
```

Import llama-ui history (idempotent; JSONL or zip, attachments, branch trees):

```sh
bun src/tasks/import-llama-ui.ts <export.jsonl-or-.zip> --user you@example.com
```

Chat on your own ChatGPT subscription (Codex): Providers → Add provider →
"Sign in with ChatGPT". The server runs the Codex CLI's OAuth flow with a
loopback callback on `localhost:1455` — browse from the machine running inkcap
(or tunnel that port) during sign-in. Tokens stay server-side and
auto-refresh; protocol details and caveats: `docs/specs/openai-codex.md`.

## Env

`DATABASE_URL`, `SESSION_SECRET`, `ASSET_VERSION`, `PORT`, `NODE_ENV`,
`REGISTRATION` (see `.env.example`); `DEV_LLAMA_SERVER` / `DEV_LLAMA_KEY` feed
the provider seed task. In production, `SESSION_SECRET` must be ≥32 bytes and
not a placeholder, and `ASSET_VERSION` must be set (pass as a Docker build arg
so asset URLs roll back with the image). `REGISTRATION` defaults to `closed`
in production (`open` elsewhere); bootstrap a closed deployment with
`bun build/tasks/create-user.js --name ... --email ...` (password via the
`CREATE_USER_PASSWORD` env var).

## Scripts

```sh
bun run dev         # css:watch + bun --watch src/index.ts
bun run db:migrate  # Apply unapplied SQL migrations
bun run db:types    # Generate bun-sqlgen query result types
bun run typecheck   # TypeScript verification
bun test            # Concurrent test suite using .env.test
bun run app:build   # Build CSS, bundle src/index.ts + src/tasks/*.ts into build/
bun run build       # db:types + typecheck + test + app:build
```

Every `src/tasks/*.ts` file becomes a production-runnable `build/tasks/*.js`
entrypoint taking CLI args via `Bun.argv`.

## Structure

Runtime files (`src/views`, `src/static`, `src/db/migrations`) stay as files
and are copied verbatim into `build/`; everything else is bundled. `runtimeRoot`
in `src/utils/paths.ts` flips between `src` (dev) and `build` (prod). `build/`
is gitignored.

```txt
src/
├── index.ts, app.ts        # entrypoint; Hono app, middleware, routes
├── routes/                 # auth, conversations (chat + SSE + branching), providers, mcp-servers, ...
├── services/               # runner.ts (the agent runtime), provider-client, codex-auth/-client, mcp-client, branching
├── views/                  # .eta templates (conversations/, providers/, mcp-servers/, auth/, partials/)
├── static/                 # app.tailwind.css → generated app.css, chat.js island, svgs
├── db/
│   ├── migrations/         # 001_init ... 012_accounts (raw SQL)
│   └── queries/            # named bun-sqlgen queries per table + queries.gen.d.ts
├── middleware/             # render.ts, current-user.ts
├── tasks/                  # migrate, seed-provider, create-user, import-llama-ui, mock-provider
├── utils/                  # env, markdown, message-view, outbound-url, private-session, ...
└── build.ts                # build-time tooling, never shipped
```

## Development Rules

- Add pages in `src/routes`, render with `c.var.render('template-name', data)`.
- Templates display data; no business logic; never raw-print user input; keep
  Eta escaping enabled. Assistant markdown goes through `renderMarkdown()` only.
- Prefer Tailwind utilities in templates; keep `app.tailwind.css` to imports,
  theme tokens, and rare global rules. Never hand-edit generated `app.css`.
- Do not concatenate SQL strings or use `sql.unsafe` with user input.
- Commit only at milestones (working end-to-end slices).
- After DB changes: `bun run db:types && bun run typecheck && bun test`.

## Database

- Schema changes are numbered SQL files in `src/db/migrations`; the runner
  applies pending files in one transaction (so no `CREATE INDEX CONCURRENTLY`
  without a custom path).
- App queries live in `src/db/queries/*.ts` as `sql.QueryName\`...\``;
  `bun run db:types` validates them against migrations.
- `bun test` resets and migrates the `.env.test` database (name must end with
  `test`) and runs concurrently — tests create unique data, no global
  row-count assertions.
- Core tables: `users`, `accounts` + `account_memberships` (ownership scope;
  a user's personal account id equals their user id), `providers`,
  `conversations`, `messages` (tree), `runs` (+ partial unique index: one
  active run per conversation), `run_events` (SSE replay log), `attachments`
  (bytea), `mcp_servers`.

## Auth

- `Bun.password` hash/verify; session payload encrypted into an HTTP-only
  cookie via `SESSION_SECRET` with an `issuedAt` timestamp.
- Registering creates the user plus a personal account and owner membership in
  one statement. Providers and MCP servers belong to accounts; every route
  fetches them through an `account_memberships` join, so a foreign id 404s.
  Sharing later = adding membership rows, not re-scoping queries.
- Stateless sessions are non-revocable by default (`docs/issues/09`): re-fetch
  users on sensitive routes; add an invalidation watermark before shipping
  password changes or "log out everywhere".

## Assets

- `/assets/:version/app.css` serves generated `src/static/app.css`; other
  files map to `src/static/*`. Production: immutable caching; dev: `no-store`.

## Production

- `bun run app:build` → `build/`; Docker copies only `build/` (no `src/`,
  no `node_modules/`). Migrate inside the image: `bun build/tasks/migrate.js`.
- The app is a single stateful process (web server + runner) by design;
  restart is always safe — boot recovery finalizes interrupted runs.

```sh
docker build --build-arg ASSET_VERSION=$(git rev-parse --short=7 HEAD) -t inkcap .
docker run -p 3000:3000 --env-file .env.production inkcap
```
