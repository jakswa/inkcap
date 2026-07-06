# Bun Hono SSR Starter

A small Bun SSR starter for AI-assisted apps: Hono routes, Eta templates, HTML forms, PostgreSQL, raw SQL migrations, encrypted cookie sessions, and generated Tailwind CSS.

## Shape

- Run from source in development and bundle to `build/` for production.
- Use Hono middleware/routes and Eta SSR templates.
- Use plain HTML forms for UI actions.
- Use `Bun.SQL` with named bun-sqlgen queries in `src/db/queries/*.ts`.
- Use raw SQL migrations in `src/db/migrations/*.sql`.
- Use encrypted private-cookie sessions. There is no session table or per-request session lookup, so sessions are stateless and non-revocable by default.
- Use `Bun.password` for password hashing.
- Put templates in `src/views`, Tailwind source and generated CSS in `src/static`, and images in `src/static`.

## Quick Start

Create a local copy from the starter template, then configure and run:

```sh
bun create gh:jakswa/bun-hono-ssr my-app
cd my-app
cp .env.example .env.local   # then edit DATABASE_URL and SESSION_SECRET
bun install
bun run db:migrate
bun run dev
```

Open `http://localhost:3000`.

## Env

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/honossr"
SESSION_SECRET="change-me-in-production"
ASSET_VERSION="dev"
PORT=3000
NODE_ENV=development
```

Create the local database named in `DATABASE_URL` before running migrations.
For Docker builds, pass `ASSET_VERSION` as a build arg so asset URLs roll back with the image.

## Scripts

```sh
bun run dev         # Watch Tailwind CSS and run src/index.ts
bun run css:build   # Generate src/static/app.css from Tailwind
bun run css:watch   # Watch and regenerate src/static/app.css
bun run start       # Build CSS, then run src/index.ts
bun run start:prod  # Run build/index.js
bun run db:migrate  # Apply unapplied SQL migrations
bun run db:types    # Generate bun-sqlgen query result types
bun run typecheck   # TypeScript verification
bun test            # Concurrent test suite using .env.test
bun run app:build   # Build CSS, then bundle src/index.ts and src/tasks/*.ts into build/
bun run build       # Verification plus app:build
```

Every `src/tasks/*.ts` file becomes a production-runnable `build/tasks/*.js` entrypoint. Task files accept normal CLI args through `Bun.argv`.

## Structure

All code lives under `src/`. Runtime files (templates, assets, migrations) stay as
files and are copied verbatim into `build/`; the rest is bundled.

- **`src/views/`** — `.eta` templates. Read at runtime by Eta (`paths.views`). Copied to `build/views/`.
- **`src/static/`** — Tailwind input, generated `.css`, and `.svg` assets. Read at runtime by `serve-assets.ts` (`paths.appAssets`). Copied to `build/static/`.
- **`src/db/migrations/`** — raw SQL migrations. Read at runtime by `migrate.ts` (`paths.dbMigrations`). Copied to `build/db/migrations/`.
- Everything else under `src/` is TypeScript bundled by `bun run app:build` into `build/index.js` and `build/tasks/*.js`. Only the bundled output ships to prod.
- **`src/build.ts`** — build-time tooling. Runs on the dev/CI machine only; never bundled or shipped.

`runtimeRoot` in `src/utils/paths.ts` flips between `src` (dev) and `build` (prod) so
the same code resolves runtime files in both. `build/` is gitignored and won't exist
until you run `bun run app:build`.

```txt
src/
├── index.ts                # server entrypoint (dev + prod)
├── app.ts                  # Hono app, middleware, routes
├── app-types.ts            # Hono app/variables typings
├── build.ts                # build tooling, never shipped
├── views/                  # .eta templates, copied to build/views/
│   ├── layouts/main.eta
│   ├── partials/header.eta, footer.eta
│   ├── home.eta, home-content.eta
│   ├── dashboard.eta, dashboard-content.eta
│   ├── error.eta, error-content.eta
│   └── auth/login.eta, login-content.eta, register.eta, register-content.eta
├── static/                 # app.tailwind.css source, generated app.css, svg assets
├── assets/serve-assets.ts  # versioned, cached asset serving
├── db/
│   ├── client.ts           # Bun.SQL client
│   ├── typed-sql.ts        # bun-sqlgen sql-tagged template helper
│   ├── migrate.ts          # migration runner
│   ├── migrations/001_init.sql  # raw SQL, copied to build/db/migrations/
│   └── queries/            # named queries (users.ts) + queries.gen.d.ts
├── middleware/             # render.ts, current-user.ts
├── routes/                 # home.ts, dashboard.ts, auth.ts
├── tasks/                  # migrate.ts (each file → build/tasks/*.js)
└── utils/                  # env, password, validation, private-session, paths
```

## Development Rules

- Add pages in `src/routes` and render templates with `c.var.render('template-name', data)`.
- Keep templates simple: display data, avoid business logic, and do not raw-print user input.
- Keep Eta escaping enabled.
- Prefer Tailwind utilities in `src/views/**/*.eta`; keep `src/static/app.tailwind.css` limited to imports, sources, theme tokens, font faces, and rare base/global rules.
- Do not concatenate SQL strings or use `sql.unsafe` with user input.
- After DB changes, run `bun run db:types`, `bun run typecheck`, and `bun test`.

## Database

- Add schema changes as numbered SQL files in `src/db/migrations`.
- Put app queries in `src/db/queries/*.ts` using `sql.QueryName\`...\``.
- `bun run db:types` validates queries against migrations and refreshes `queries.gen.d.ts`.
- `bun test` resets and migrates the `.env.test` database before running tests concurrently.
- Test `DATABASE_URL` must end with `test`; the setup refuses to reset any other database name.
- Tests should create unique data and avoid global row-count assertions.
- Runtime registration/login need a real `DATABASE_URL` and `bun run db:migrate`.
- The migration runner applies pending files inside one transaction, so PostgreSQL commands that cannot run in a transaction block (for example `CREATE INDEX CONCURRENTLY`) need a custom migration path.

## Auth

- Registration stores a user with `Bun.password.hash()`.
- Login verifies with `Bun.password.verify()`.
- The session payload is encrypted into an HTTP-only cookie using `SESSION_SECRET` and includes an `issuedAt` timestamp for future invalidation checks.
- Protected routes check `c.var.user`; logout clears only the current browser cookie.
- Stateless sessions are not globally revocable by default and can carry stale user identity until expiry. Re-fetch users on sensitive routes, and compare `issuedAt` against a per-user or global invalidation watermark if you add password changes, account deletion, or "log out everywhere".

## Assets

- `/assets/:version/app.css` maps to generated `src/static/app.css`.
- Other files map to `src/static/*`. Do not hand-edit or track generated `src/static/app.css`; edit `src/static/app.tailwind.css` and templates instead.
- Production responses use long-lived immutable caching.
- Development responses use `no-store`.

## Production Build

- `bun run app:build` generates CSS, then `src/build.ts` bundles `src/index.ts` and every `src/tasks/*.ts` file.
- It copies runtime files (`src/views`, `src/static`, `src/db/migrations`) into `build/`.
- Docker copies only `build/`; it does not need `src/` or `node_modules/` at runtime.

## Docker

```sh
docker build --build-arg ASSET_VERSION=$(git rev-parse --short=7 HEAD) -t my-app .
docker run -p 3000:3000 --env-file .env.production my-app
```

Set `DATABASE_URL` and `SESSION_SECRET` in the runtime environment. Do not override the image's `NODE_ENV=production` unless you mean to disable production caching.
