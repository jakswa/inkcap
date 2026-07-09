# Realtime chat UI reset

Status: checkpointed after the fresh-pass cleanup. Keep this note as the
contract for future realtime UI work; if the contract slips again, prefer a
server-rendered refresh fallback over adding browser-side transcript heuristics.

## What went wrong

The transcript became split-brain. The server owns durable messages, but the
browser also started interpreting transcript semantics: removing tool-call
chips, inspecting DOM nodes for content/reasoning, and hiding assistant turns
after tool results arrived. Selector changes then caused visible failures:
reasoning disappeared, empty assistant bubbles appeared, and tool/result
ownership became unclear.

The worst coupling was between assistant tool-call rows and later tool-result
rows. A tool result must not cause client-side code to decide whether the
previous assistant message is meaningful. The server already knows the message
state; the browser should not guess from the DOM.

## Contract

After the user presses Enter, the transcript should clearly and stably show the
server-side run until it stops:

- Reasoning streams into a reasoning block.
- Assistant text streams into a content block.
- Tool results appear as their own rows and own tool name/arguments/result.
- The global status strip shows waiting, prompt-processing, and generation
  progress.
- Reloads and reconnects show database truth without losing or duplicating text.

## Current path

- Server-render visibility. Assistant messages show reasoning if present,
  content only if present, and never render empty content bubbles.
- Tool rows own resolved tool metadata. Assistant-side tool-call inspectors are
  not durable UI.
- Client JS is a dumb realtime tail: insert server HTML, append text by offset,
  replace a message on final, update run progress/status, refresh on terminal
  status. It must not hide transcript nodes based on DOM heuristics.
- Prompt/generation progress is run-level, transient SSE (`run-progress`), not
  persisted message-delta metadata.
- Generation progress only starts after actual output begins in that provider
  turn; prompt-processing timing payloads must not flip the status to
  `Generating…`.
- Final metadata and action icons share one compact wrapping footer for skinny
  screens.

## Fallback if this regresses

Gut live transcript mutation: use SSE/polling only to refresh server-rendered
snapshots, then reintroduce token streaming one narrow piece at a time.
