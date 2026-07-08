// Server-side markdown pipeline for chat bubbles (M4 groundwork, THE_PLAN D3).
//
// Library choices:
// - `md4w` for markdown parsing/rendering: a md4c-backed WebAssembly renderer.
//   It is dramatically faster on LLM-shaped markdown than marked in Bun, while
//   keeping the call site synchronous after one startup-time WASM init.
// - `highlight.js` for fenced-code highlighting via md4w's highlighter hook.
//   We never use language auto-detection; unknown languages are escaped plain
//   text to avoid slow grammar scans.
// - `sanitize-html` runs last. md4w is a renderer, not a trust boundary: raw
//   HTML and unsafe URLs must still be allowlisted/stripped after rendering.

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import hljs from 'highlight.js'
import { init, mdToHtml, setCodeHighlighter } from 'md4w'
import type { Options } from 'md4w'
import sanitizeHtml from 'sanitize-html'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function md4wWasmPath() {
  // Source/dev/test run from src/utils. Production runs from build/index.js and
  // src/build.ts copies the wasm next to the bundle. Passing bytes to md4w
  // avoids relying on package-relative paths after bundling without node_modules.
  return process.env['NODE_ENV'] === 'production'
    ? resolve(import.meta.dir, 'md4w-small.wasm')
    : resolve(import.meta.dir, '../../node_modules/md4w/js/md4w-small.wasm')
}

await init(await readFile(md4wWasmPath()))

// Disable md4c's raw HTML *block* handling so a malicious/accidental block
// like `<script>...</script>` does not swallow following markdown as literal
// HTML. We intentionally leave inline raw HTML parsing enabled: sanitize-html
// is the trust boundary and strips disallowed inline tags/attrs while keeping
// harmless text around them. Using NO_HTML_SPANS would escape script contents
// as visible text instead of letting the sanitizer drop them entirely.
const markdownOptions: Options = { parseFlags: ['DEFAULT', 'NO_HTML_BLOCKS'] }

setCodeHighlighter((infoString, code) => {
  const codeText = code.replace(/\n+$/, '')
  const language = infoString.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  const classes: string[] = []
  if (language) classes.push(`language-${language}`)

  if (language && hljs.getLanguage(language)) {
    classes.push('hljs')
    const { value } = hljs.highlight(codeText, { language, ignoreIllegals: true })
    return `<pre><code class="${classes.join(' ')}">${value}</code></pre>\n`
  }

  const classAttr = classes.length > 0 ? ` class="${classes.join(' ')}"` : ''
  return `<pre><code${classAttr}>${escapeHtml(codeText)}</code></pre>\n`
})

// Shared sanitizer config for the block pipeline. Runs after highlighting so
// it must keep highlight.js's `hljs`/`language-*`/`hljs-*` class-based spans.
const blockSanitizeOptions: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'br',
    'hr',
    'strong',
    'em',
    'del',
    'blockquote',
    'pre',
    'code',
    'span',
    'ul',
    'ol',
    'li',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'a',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'img',
    'input',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title'],
    th: ['align'],
    td: ['align'],
    code: ['class'],
    span: ['class'],
    input: [
      { name: 'type', values: ['checkbox'] },
      { name: 'class', values: ['task-list-item-checkbox'] },
      'disabled',
      'checked',
    ],
    li: ['class'],
  },
  allowedClasses: {
    code: ['hljs', 'language-*'],
    span: ['hljs-*'],
    li: ['task-list-item'],
    input: ['task-list-item-checkbox'],
  },
  // Defaults to http/https/ftp/mailto/tel — notably excludes `javascript:`
  // and `data:`, which is exactly what we want stripped from hrefs/srcs.
  allowProtocolRelative: true,
  transformTags: {
    a: (tagName, attribs) => {
      const href = attribs['href'] ?? ''
      const isExternal = /^([a-z][a-z0-9+.-]*:)?\/\//i.test(href) && !/^mailto:/i.test(href)
      if (!isExternal) return { tagName, attribs }
      return {
        tagName,
        attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' },
      }
    },
  },
}

// Stricter allowlist for one-line contexts (conversation titles, previews):
// inline formatting only, no block elements, no images/tables.
const inlineSanitizeOptions: sanitizeHtml.IOptions = {
  allowedTags: ['strong', 'em', 'del', 'code', 'a', 'span', 'br'],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    code: ['class'],
    span: ['class'],
  },
  allowedClasses: {
    code: ['hljs', 'language-*'],
    span: ['hljs-*'],
  },
  allowProtocolRelative: true,
  transformTags: blockSanitizeOptions.transformTags,
}

function normalizeMd4wCodeFenceNewline(html: string): string {
  // md4w preserves the final newline inside fenced code blocks; marked did not.
  // Trim only the newline immediately before </code></pre> to keep snapshots and
  // code-fence rendering stable without touching ordinary markdown text.
  return html.replace(/\n<\/code><\/pre>/g, '</code></pre>')
}

function removeMd4wHeadingAnchors(html: string): string {
  // md4w appends empty self-link anchors to headings. We do not style or use
  // them, so remove only empty anchors that sit directly before a heading close.
  return html.replace(/\s*<a\b[^>]*href="#[^"]*"[^>]*><\/a>(?=<\/h[1-6]>)/g, '')
}

function removeBlockCodeForInline(html: string): string {
  // md4w has no parseInline API. For one-line contexts, render normally and
  // then remove complete fenced-code blocks before the inline sanitizer unwraps
  // the remaining block tags.
  return html.replace(/<pre\b[\s\S]*?<\/pre>\s*/gi, '')
}

function renderMd4w(md: string): string {
  // md4w 0.2.7 throws on empty input. Empty markdown should render empty.
  if (md.length === 0) return ''
  return removeMd4wHeadingAnchors(
    normalizeMd4wCodeFenceNewline(mdToHtml(md, markdownOptions)),
  )
}

/**
 * Render chat-message markdown (GFM-ish: tables, strikethrough, task lists,
 * autolinks; fenced code with language classes + highlight.js highlighting;
 * inline code; blockquotes) to sanitized HTML fragments suitable for direct
 * insertion into a chat bubble. No `<html>`/`<body>` wrapper. Raw HTML in the
 * input is sanitized; `javascript:`/`data:` URLs are stripped; external links
 * get `target="_blank" rel="noopener noreferrer"`.
 */
export function renderMarkdown(md: string): string {
  return sanitizeHtml(renderMd4w(md), blockSanitizeOptions)
}

/**
 * Render markdown for one-line contexts (conversation titles, previews).
 * Strips block-level elements (paragraphs, lists, tables, blockquotes, code
 * fences) — only inline formatting survives.
 */
export function renderInline(md: string): string {
  // md4w has no parseInline API. Render block markdown, drop fenced-code blocks
  // entirely, then sanitize with an inline-only allowlist that unwraps ordinary
  // block tags.
  return sanitizeHtml(
    removeBlockCodeForInline(renderMd4w(md)),
    inlineSanitizeOptions,
  ).trim()
}
