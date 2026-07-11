# Close the small-self-hosting operational gap

Status: proposed, not started.

## Problem

inkcap has a small browser surface, but a first-time installation still requires
PostgreSQL plus a long `docker run` command with networking, migration, secret,
registration, and outbound-host options. That is a reasonable production
architecture, but it prevents “small self-hosted app” from being an unqualified
end-to-end claim.

Do not blur browser footprint and operational footprint in marketing. Until this
work lands, say that the browser client is small and list PostgreSQL plainly.

## Phase 1 — one-command supported deployment

Ship and test an official Compose setup:

- one documented `docker compose up -d` path;
- pinned inkcap and PostgreSQL services with health checks;
- one obvious durable data location;
- generated/fixed session secret guidance without committing secrets;
- migrations run before the app becomes ready;
- conservative registration and outbound-network defaults;
- clear local-model networking for Linux, macOS, and Windows hosts;
- documented upgrade, backup, restore, logs, and complete uninstall paths;
- a smoke test in CI or the release workflow.

The quick-start should be short because defaults and files carry the complexity,
not because required flags were omitted.

## Phase 2 — evaluate a personal embedded mode

Investigate, but do not promise, SQLite or another embedded persistence mode for
single-user/personal deployments. The evaluation must cover:

- query and migration divergence from PostgreSQL;
- atomic run claiming, active-run invariants, and scheduler concurrency;
- runner recovery and transaction behavior;
- artifact/attachment growth, backup, and corruption recovery;
- an eventual move from embedded mode to PostgreSQL;
- test-matrix and maintenance cost.

A one-container/one-volume personal mode would materially strengthen “small on
purpose,” but a leaky compatibility layer could make the codebase and correctness
worse. A polished Compose path is valuable even if embedded mode is rejected.

## Other possible deliverables

- A versioned configuration generator or first-run setup command.
- `/healthz` and Docker health integration, coordinated with
  `docs/issues/20-operability-gaps.md`.
- A release-time migration compatibility check.
- Backup metadata and a command that verifies a restore into a temporary DB.
- Resource-usage measurements for an idle personal instance.

## Acceptance criteria

- A new user can reach the registration/login page from a clean machine with one
  documented command and no hand-written connection string.
- Restarting preserves database and application state.
- Upgrading and rolling back have explicit, tested instructions.
- Backup and restore are documented and exercised.
- Local provider networking has platform-specific instructions.
- Marketing accurately distinguishes browser size, server image size, memory,
  and external service requirements.
- Embedded mode is either implemented with parity tests or rejected in a dated
  decision record with reasons.
