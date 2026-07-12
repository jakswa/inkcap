# Artifacts

Status: completed 2026-07-10. This is the original implementation plan; see the
current code in `src/routes/artifacts.ts` and `src/services/runner.ts`.

An artifact is a saved, user-openable result produced by a run. Chat remains the
provenance and follow-up surface; the artifact is the nicer thing to open when a
headless routine finishes.

## Initial shape

- A run may create multiple artifacts.
- Artifacts have server-rendered URLs and link back to their source chat.
- In chat, decorate the tool-result message that created the artifact.
- The model never emits HTML, CSS, notification fields, or arbitrary URLs.

Model-facing tool should stay tiny, e.g.:

```json
{
  "kind": "briefing",
  "title": "Morning Edition",
  "summary": "Rain after 5 PM. Three major tech stories.",
  "body": "## Front Page\n\n..."
}
```

## Storage sketch

```txt
artifacts(id, account_id, conversation_id, run_id, message_id,
          kind, title, summary, body_markdown,
          share_description, public_shared_at, public_share_expires_at,
          created_at)
```

Render markdown through the existing sanitizer. Add dedicated templates only
after the generic path proves useful.

## Build order

1. Migration + queries.
2. Internal `submit_artifact` tool in runner sessions.
3. Generic artifact route/page with ownership checks.
4. Conversation UI surface for produced artifacts.
5. Later: notification targeting and specialized briefing/newspaper template.

## Do not

- Let the model generate raw web pages.
- Let the model send notifications or choose notification URLs.
- Build a document platform before the briefing use case works.
