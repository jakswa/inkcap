# Enforceable browser-footprint claim

Status: proposed, not started.

## Why

inkcap's strongest current differentiator is factual: it renders ordinary HTML,
ships no client framework or webfonts, and reserves a small vanilla-JavaScript
island for realtime chat. Marketing should be able to state that precisely
without relying on a hand-measured number that silently grows stale.

This is initially an absolute inkcap claim, not a comparative competitor claim.
Any future comparison must pin competitor versions and publish a reproducible,
like-for-like method.

## Baseline snapshot

Measured 2026-07-12 from the current worktree. CSS was generated to a temporary
file with Tailwind's production `--minify` option; Brotli used quality 11, which
matches the Docker image's precompression path.

| Asset | Raw | Brotli |
| --- | ---: | ---: |
| Generated application CSS | 62,181 B | 9,736 B |
| `chat.js` | 24,368 B | 5,893 B |
| Chat CSS + JavaScript | 86,549 B | 15,629 B |
| `notifications.js` | 3,857 B | 1,063 B |
| `timezone.js` | 248 B | 152 B |

These are static asset transfer sizes, not total page weight, memory use, CPU
cost, HTML size, or provider traffic. Most CRUD pages currently reference no
JavaScript; chat remains usable without JavaScript through SSR forms and the
refresh fallback, although realtime streaming is progressively enhanced.

## Build-time budget

Add a retained command such as `bun run footprint` that:

1. Generates minified CSS without modifying checked-in output unexpectedly.
2. Records raw, gzip, and Brotli sizes for every browser asset.
3. Fails CI when agreed budgets regress. Initial ceilings can be:
   - chat JavaScript: 6.5 KiB Brotli;
   - shared CSS: 10 KiB Brotli;
   - settings-only JavaScript: 1.5 KiB Brotli;
   - registration-only JavaScript: 0.5 KiB Brotli.
4. Scans rendered/template route entry points and reports which scripts each
   page loads, so a zero-JavaScript page cannot quietly acquire a global bundle.
5. Writes a machine-readable report and a concise Markdown summary suitable for
   documentation and release review.

Budgets should allow deliberate exceptions through an explicit reviewed update,
not encourage size tricks or removal of accessible behavior.

## Browser-level measurement

Add an optional Playwright measurement against deterministic seeded data:

- use a cold profile and disabled cache;
- record encoded transfer bytes by document/CSS/JS/font/image;
- count browser scripts and third-party origins;
- measure an empty chat and a representative settled conversation;
- record JS heap, DOM nodes, script duration, and task duration as diagnostic
  trends rather than prematurely marketed guarantees;
- run each scenario repeatedly and report the median;
- separately verify core navigation/forms with JavaScript disabled.

Exclude model-provider traffic from application-shell totals and show HTML
separately because transcript size is content-dependent.

## Comparative claims

Do not publish “lighter than Open WebUI,” “100× smaller,” or similar language
from public demos or unmatched screenshots. A defensible comparison requires:

- locally hosted, pinned image/commit versions;
- the same authenticated blank-chat state and browser;
- cold and warm-cache results;
- a documented inclusion/exclusion policy;
- multiple runs and a dated report.

The durable marketing claim should remain the direct measurement, for example:
“Chat uses 5.9 KB of Brotli-compressed JavaScript” with an explanation of what
is excluded.

## Acceptance criteria

- One command reproduces the checked-in asset report.
- CI catches accidental budget regressions.
- The report distinguishes raw, gzip, and Brotli bytes.
- Route-level script loading and no-JS fallback are tested.
- Any public number links to or clearly summarizes its measurement method.
