# Draft a loop from a successful chat

Status: proposed, not started.

## Product opportunity

A useful conversation and a loop are currently separate workflows. A person who
has finally arrived at a good prompt must manually recreate the task, model,
tools, and other context in the loop form.

Add a chat action such as **Draft loop**. One click should run a small,
intentional inference round over the active conversation path and ask the model
to produce a structured loop draft. The user then lands on the ordinary new-loop
form with editable values filled in. Nothing is saved, scheduled, enabled, or
granted unattended permission until the user reviews and submits that form.

This is a product hypothesis, not a researched claim that competitors cannot do
it. Validate the workflow on its own merits before positioning it as a market
differentiator.

## Desired flow

1. The user reaches a useful result in chat and chooses **Draft loop**.
2. inkcap starts an explicit, billable inference using the current conversation
   branch and its provider/model context; the user does not have to restate the
   conversation.
3. The inference receives an internal structured-output tool such as
   `draft_loop`, with fields matching the reviewable parts of the loop form:
   name, task prompt, optional system prompt, suggested schedule mode/time,
   model, reasoning setting, and requested MCP servers/tools.
4. The server validates the tool payload and stores a short-lived account-scoped
   draft. Do not put a large prompt or sensitive context in a query string.
5. The browser is redirected to `/loops/new?draft=<opaque id>` and the existing
   SSR form is prefilled.
6. The user edits the recipe, chooses timing and permissions, and saves it using
   the normal loop creation path.

## Safety and correctness constraints

- Treat model output only as draft form data; all existing server-side parsing,
  ownership checks, and validation remain authoritative.
- Never infer or pre-check unattended MCP approval. A model may suggest a tool,
  but a person must explicitly grant unattended permission in the form.
- Never copy credentials, tool outputs, or hidden provider auth into the draft.
- Make the extra inference and its model/cost visible before or while it runs.
- Use the selected conversation branch, not flattened sibling history.
- Handle missing/disabled providers, interrupted draft runs, malformed tool
  output, and expired drafts without losing the original conversation.
- Keep manual loop creation fully usable without JavaScript.

## Design questions

- Whether the draft inference should use the conversation's model by default or
  an account-level utility model.
- Whether the drafting turn should appear in the transcript or remain a clearly
  linked side job.
- Whether to include prior assistant output in the task prompt or ask the model
  to synthesize a clean standalone prompt.
- Draft lifetime and whether drafts deserve a DB table or signed/session-backed
  temporary storage.
- Whether later iterations can apply improvements from a loop run back to the
  loop recipe.

## Acceptance criteria

- A chat action produces a useful prefilled loop form from the active branch.
- The destination is a review screen, never an auto-created or auto-enabled
  loop.
- Suggested MCP use cannot silently become unattended approval.
- The final save goes through the same validation and account scoping as manual
  creation.
- Failure leaves the conversation intact and provides a retry or manual-create
  path.
- Integration tests cover ownership, branch selection, malformed output,
  permission handling, expiry, and successful prefill/save.
