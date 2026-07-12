# Screenshot iteration loop

Use screenshots as part of UI implementation, not only as final documentation. A
small decoration can look coherent in isolation and awkward once the header,
composer controls, page geometry, and theme are visible together.

## Reproducible capture (preferred)

The repository already has a capture task that owns the complete fixture:

```sh
bun run shots:capture
```

It:

1. creates and migrates a disposable database whose name contains `shots`;
2. seeds the demo account with a frozen clock;
3. builds CSS;
4. starts a dedicated app process on port 4343;
5. logs in through Playwright;
6. captures the matrix in `docs/assets/ui-polish/candidates/`; and
7. shuts down only the process it started.

The default fixture login is `demo@inkcap.dev` / `inkcap-demo`. Override it with
`SHOTS_EMAIL` and `SHOTS_PASSWORD`; do not put personal credentials in capture
scripts. The task accepts `SHOTS_DATABASE_URL`, `SHOTS_PORT`, `SHOTS_OUT_DIR`,
and `SHOTS_BROWSER` when the defaults do not fit the machine.

If Chromium is unavailable, install it and point the task at the executable:

```sh
bunx playwright install chromium
SHOTS_BROWSER=/path/to/chrome bun run shots:capture
```

The landing scenes have stable routes and corresponding capture targets:

```txt
/?grove=moss    → home-moss-light.png
/?grove=moon    → home-moon-light.png
/?grove=lichen  → home-lichen-light.png
```

An unqualified `/` intentionally randomizes the scene and should not be used for
visual regression work.

## Fast loop against an existing dev server

For a quick exploratory pass:

1. Run `bun run dev`.
2. Seed a known login if needed:
   `bun src/tasks/seed-demo.ts --email demo@inkcap.dev --password inkcap-demo`.
3. Use Playwright at a fixed viewport (desktop baseline: 1440×900).
4. Log in through `/login`, navigate to a pinned route, and save a screenshot in
   `/tmp` rather than the repository.
5. Open the screenshot with the image-reading tool and inspect the whole frame.

Prefer the disposable capture task before shipping: `seed-demo` reuses an
existing demo user and does not reset that user's password, while the capture
task starts from a fresh database every time.

## Edit → see → adjust

1. **Pin the state.** Fix route, viewport, color scheme, account fixture, and
   focus state. Random pages are impossible to compare reliably.
2. **Make one visual hypothesis.** Examples: remove a heading, enlarge a fungal
   silhouette, or move growth behind the composer border. Avoid changing color,
   geometry, copy, and spacing simultaneously.
3. **Build before capture.** Run `bun run css:build` unless the CSS watcher is
   definitely active.
4. **Capture the complete page once, then crop the iteration area.** A fixed
   center clip (for example, 800×470 inside a 1440×900 viewport) removes visual
   noise and makes repeated comparisons cheaper. Return to a full-page capture
   before approval because crops hide collisions with navigation, footer, and
   ambient backgrounds.
5. **Inspect at actual size.** Check that decorative shapes share a believable
   baseline, do not float, preserve control contrast, and still read at the
   normal viewport—not only when zoomed into a crop.
6. **Compare every variant.** A shared CSS adjustment can improve one scene and
   break another. Capture pinned variants in one browser session.
7. **Check at least one dark and one narrow rendering** before locking a visual
   treatment, even when the main comparison matrix is desktop/light.
8. **Back out failed experiments cleanly.** Keep reference screenshots outside
   Git unless they are intentional documentation assets.
9. Run `bun run typecheck`, `bun run css:build`, relevant tests, and
   `git diff --check` after the visual direction settles.

## Publishing product screenshots

Candidate captures are review artifacts. They do not replace tracked product
shots until explicitly approved:

```sh
bun run shots:check      # repeat capture and compare stability
bun run shots:publish    # publish approved mapped assets
```

Do not publish merely because the capture command succeeded; it verifies a
repeatable render, not aesthetic quality.
