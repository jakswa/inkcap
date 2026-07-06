// Server-side markdown pipeline for chat bubbles (M4 groundwork, THE_PLAN D3).
//
// Library choices (D3 resolved):
// - `marked` over `markdown-it`: GFM (tables, strikethrough, task-list
//   checkboxes, bare-URL autolinks) all ship in marked's default `gfm: true`
//   ruleset with zero plugins, where markdown-it needs a plugin per feature.
//   Fewer deps, smaller surface.
// - `highlight.js` over `shiki`: synchronous API that fits a plain function
//   signature (`renderMarkdown(md): string`); shiki's grammars are async/WASM
//   and meant for build-time or async render paths. highlight.js starts fast
//   and cheap per-call on Bun, which matters since this runs per message.
// - `sanitize-html` over server-side DOMPurify: purpose-built for exactly
//   this (allowlist tags/attributes/classes, transform tags, restrict URL
//   schemes) without needing a DOM (jsdom) dependency to host DOMPurify.
//
// Pipeline: marked (parse + our code-block renderer runs highlight.js
// synchronously, escaping non-highlighted code itself) -> sanitize-html
// (runs last, strips anything dangerous, keeps highlight.js's class-based
// spans via an allowlist, adds target=_blank+rel=noopener to external links).

import hljs from 'highlight.js'
import { Marked } from 'marked'
import sanitizeHtml from 'sanitize-html'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Fenced code renderer: highlight with highlight.js when the language hint is
// one it recognizes; otherwise render plain escaped text. Deliberately never
// falls back to `highlightAuto` (language-guessing walks every registered
// grammar and is a needless slow path for large/unknown blocks).
function renderCodeBlock(code: string, infoString?: string): string {
  const language = (infoString ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  const classes: string[] = []
  if (language) classes.push(`language-${language}`)

  if (language && hljs.getLanguage(language)) {
    classes.push('hljs')
    const { value } = hljs.highlight(code, { language, ignoreIllegals: true })
    return `<pre><code class="${classes.join(' ')}">${value}</code></pre>\n`
  }

  const classAttr = classes.length > 0 ? ` class="${classes.join(' ')}"` : ''
  return `<pre><code${classAttr}>${escapeHtml(code)}</code></pre>\n`
}

const markdown = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      return renderCodeBlock(text, lang)
    },
  },
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
    input: [{ name: 'type', values: ['checkbox'] }, 'disabled', 'checked'],
  },
  allowedClasses: {
    code: ['hljs', 'language-*'],
    span: ['hljs-*'],
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

/**
 * Render chat-message markdown (GFM: tables, strikethrough, task lists,
 * autolinks; fenced code with language classes + highlight.js highlighting;
 * inline code; blockquotes) to sanitized HTML fragments suitable for direct
 * insertion into a chat bubble. No `<html>`/`<body>` wrapper. Raw HTML in the
 * input is neutralized; `javascript:`/`data:` URLs are stripped; external
 * links get `target="_blank" rel="noopener noreferrer"`.
 */
export function renderMarkdown(md: string): string {
  const html = markdown.parse(md, { async: false }) as string
  return sanitizeHtml(html, blockSanitizeOptions)
}

/**
 * Render markdown for one-line contexts (conversation titles, previews).
 * Strips block-level elements (paragraphs, lists, tables, blockquotes, code
 * fences) — only inline formatting survives.
 */
export function renderInline(md: string): string {
  const html = markdown.parseInline(md, { async: false }) as string
  return sanitizeHtml(html, inlineSanitizeOptions)
}
