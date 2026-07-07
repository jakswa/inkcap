# Artifacts

**Status:** scoped, not started (2026-07-07)

## The idea

An **artifact** is a saved, user-openable result produced by a run. It is not an
AI-authored web page and not a replacement for chat. Chat remains the provenance
and follow-up surface; the artifact is the nicer thing a user opens when a
headless routine finishes.

Initial motivating case: a daily briefing / newspaper-style routine. The routine
runs unattended, the model gathers data through approved tools, then emits a
single lightweight artifact payload. The user notification opens the artifact
instead of dumping them into raw chat.

## Product shape

- A run may create **multiple artifacts**.
- Artifacts have their own URLs and server-rendered templates.
- The artifact page links back to the source conversation for provenance and
  follow-up.
- In the chat transcript, artifacts are surfaced by decorating the tool-result
  message that created them. Tool details remain visible; the decoration is the
  extra affordance to open the artifact.
- Notification targeting can start conservative: routine completion may link to
  the conversation until we design how a finished run chooses an artifact URL.

This gives us the finished-result feeling without making every chat output an
artifact and without letting the model control navigation or notifications.

## Model-facing contract: intentionally tiny

Expose one internal tool to the chatting model:

```json
{
  "kind": "briefing",
  "title": "Morning Edition",
  "summary": "Rain after 5 PM. Three major tech stories. One calendar conflict.",
  "body": "## Front Page\n\n..."
}
```

Keep it dumb on purpose:

- no HTML
- no CSS
- no notification fields
- no arbitrary URL
- no schema lecture unless a specific kind needs it

The model only needs to know: "call this when you have a user-facing result."
All routing, rendering, notification policy, clipping, ownership, and safety are
server responsibilities.

## Rendering policy

Server owns presentation.

Initial storage can be simple:

```
artifacts  id, account_id, conversation_id, run_id, message_id nullable,
           kind, title, summary, body_markdown,
           created_at
```

Rendering:

- generic kinds render as sanitized markdown using the existing markdown path.
- special kinds can get dedicated server templates.
- `kind = briefing` can start generic.
- later, `kind = newspaper` or `briefing/newspaper` can render as a front-page
  experience with newspaper typography and layout, still using server-owned
  structure/templates.

The model never emits raw HTML that we render.

## Notification targeting is intentionally unresolved

Multiple artifacts are allowed, and we have not yet chosen how a run marks one
as the notification/default-open target. Do not smuggle that decision into the
first schema or tool API.

Until this is designed, routine notifications can safely open the source
conversation, which can list artifacts produced by the run.

## Relationship to routines and notifications

Artifacts are most valuable when produced by headless scheduled runs:

1. routine fires
2. runner starts a normal conversation/run
3. model uses approved tools
4. model calls `submit_artifact`
5. server stores artifact(s) for the run
6. run completes
7. notification opens the conversation, where artifacts are visible, unless a
   later targeting rule chooses a specific artifact URL

If the run parks for approval or errors, notification also opens the
conversation.

## Build order

1. Migration + artifact model/query helpers.
2. Internal `submit_artifact` tool available to runner sessions.
3. Generic artifact route/page, linked back to conversation.
4. Routine completion surfaces produced artifacts from the conversation page.
5. Design artifact notification targeting if/when conversation fallback feels
   bad.
6. Dedicated briefing/newspaper template once the generic path proves useful.

## Regrets to avoid

- Do not let the model generate raw HTML pages.
- Do not let the model send notifications directly.
- Do not let the model choose arbitrary notification URLs.
- Do not build a full document/artifact platform before the briefing use case
  works.
- Do not expose complex schemas to small/local models unless a kind truly needs
  it.
