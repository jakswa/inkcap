# Codex device-code auth

Status: initial implementation landed; needs real-account QA. Replaces the
default "Sign in with ChatGPT" path; keeps the current `localhost:1455`
callback as an advanced fallback until device-code auth is proven stable and
broadly enabled.

## Problem

The current Codex OAuth flow borrows the Codex CLI public client, including its
fixed redirect URI: `http://localhost:1455/auth/callback`. That works when the
browser and inkcap server are the same machine. It is hostile for remote/self-
hosted inkcap:

- the browser lands on the user's `localhost:1455`, not the server's;
- users need an SSH tunnel, URL replay, or a browser on the server;
- port conflicts and multi-login state mismatches are easy to trigger;
- explaining this makes an already-experimental auth path feel scarier.

## Proposed path

Use OpenAI/Codex device-code auth as the default, matching the RFC 8628 shape
surfaced by `codex login --device-auth`:

1. inkcap requests a device code from OpenAI.
2. inkcap shows the official verification URL and one-time code.
3. The user opens the URL in any browser, signs in, and enters the code.
4. inkcap polls until OpenAI returns the access/refresh token bundle.
5. Existing Codex token storage and refresh handling take over unchanged.

No listener, callback, tunnel, or reachable browser-to-server route is needed.

## UX copy goals

Lead with the simpler story, not OAuth internals:

> Sign-in uses a one-time device code. Open the OpenAI link in any browser and
> enter the code. No tunneling or port forwarding needed.

Keep the short safety note:

- experimental, personal-use bridge; not the official OpenAI API;
- OpenAI handles the password;
- inkcap stores refreshable ChatGPT tokens server-side;
- never share the device code; only enter it at the official OpenAI URL;
- usage counts against ChatGPT limits.

Say up front that first-time setup may require enabling **Allow device code
login** in ChatGPT security settings, or a workspace admin enabling it for
Team/Enterprise.

## Fallback policy

Keep the `localhost:1455` flow for now, but hide it behind an advanced fallback:

- device-code auth is beta and may change;
- device-code login can be disabled by account/workspace policy;
- the existing callback flow already works for local users and is useful for
  debugging against Codex CLI behavior.

Do not present both paths as equal choices. Default to device code; link the
legacy callback only from troubleshooting or a "device code unavailable" branch.

## Implementation status

- Device-code request + polling helpers live beside the loopback flow in
  `src/services/codex-auth.ts`.
- SSR routes start a device login, render URL/code/expiry, and poll/complete
  provider creation or re-auth.
- Token storage and refresh-token rotation are unchanged.
- Provider UI and README now lead with device code; localhost is an advanced
  fallback link.

## Open questions

- Exact OpenAI endpoints, request params, polling interval, and error taxonomy
  need to be confirmed from the current Codex CLI implementation.
- Should the waiting page auto-refresh with `<meta http-equiv="refresh">`, a
  plain refresh button, or a small JS poll? Prefer SSR/plain refresh unless the
  wait feels bad.
- When device-code login is disabled, can we surface a specific message that
  points to the ChatGPT setting/admin requirement?
