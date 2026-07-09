# Codex device-code auth

Status: implemented as the default ChatGPT sign-in path; needs real-account QA.
Keep the `localhost:1455` loopback flow as an advanced fallback until then.

## Why

Loopback OAuth assumes the browser and inkcap server are the same machine. That
breaks remote/self-hosted use: callbacks land on the user's localhost, tunnels
are confusing, and port conflicts are common.

Device-code auth is simpler:

1. inkcap requests a device code.
2. inkcap shows the OpenAI verification URL and one-time code.
3. The user signs in with any browser and enters the code.
4. inkcap polls and stores the returned token bundle like the old flow.

## UX notes

Say this plainly:

- experimental personal-use bridge, not the official OpenAI API;
- OpenAI handles the password;
- inkcap stores refreshable ChatGPT tokens server-side;
- never share the device code; enter it only at the official OpenAI URL;
- usage counts against ChatGPT limits;
- some accounts/workspaces require enabling device-code login.

## Current code

- Auth helpers: `src/services/codex-auth.ts`
- Provider translation: `src/services/codex-client.ts`
- Provider routes/templates start device login, render code/URL/expiry, poll,
  then create or re-auth the provider.

## Keep before removing fallback

- Test with real individual and workspace accounts.
- Confirm disabled-device-code error messages are understandable.
- Confirm endpoint/parameter drift against current Codex CLI behavior.
