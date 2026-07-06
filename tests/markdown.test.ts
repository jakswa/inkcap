import { describe, expect, test } from 'bun:test'
import { renderInline, renderMarkdown } from '../src/utils/markdown'

describe('renderMarkdown — GFM', () => {
  test('renders tables', () => {
    const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |\n')
    expect(html).toContain('<table>')
    expect(html).toContain('<th>a</th>')
    expect(html).toContain('<td>1</td>')
  })

  test('renders strikethrough', () => {
    const html = renderMarkdown('~~gone~~')
    expect(html).toContain('<del>gone</del>')
  })

  test('renders task lists with disabled checkboxes', () => {
    const html = renderMarkdown('- [ ] todo\n- [x] done\n')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('disabled')
    expect(html).toContain('checked')
    // Unchecked box must not carry a stray checked attribute.
    const [uncheckedLi] = html.split('</li>')
    expect(uncheckedLi).not.toContain('checked')
  })

  test('autolinks bare URLs', () => {
    const html = renderMarkdown('See https://example.com for more.')
    expect(html).toContain('<a href="https://example.com"')
  })

  test('renders blockquotes', () => {
    const html = renderMarkdown('> quoted wisdom')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('quoted wisdom')
  })

  test('renders nested lists', () => {
    const html = renderMarkdown('- top\n  - nested\n    - deeper\n- second top\n')
    expect(html.match(/<ul>/g)?.length).toBe(3)
    expect(html).toContain('nested')
    expect(html).toContain('deeper')
  })

  test('inline code renders without highlighting', () => {
    const html = renderMarkdown('Run `bun test` now.')
    expect(html).toContain('<code>bun test</code>')
  })
})

describe('renderMarkdown — fenced code + highlighting', () => {
  test('highlights a known language and keeps a language class', () => {
    const html = renderMarkdown('```js\nconst x = 1\n```\n')
    expect(html).toContain('language-js')
    expect(html).toContain('hljs')
    expect(html).toContain('hljs-keyword')
  })

  test('highlights python', () => {
    const html = renderMarkdown('```python\ndef f(x):\n    return x + 1\n```\n')
    expect(html).toContain('language-python')
    expect(html).toContain('hljs-keyword')
  })

  test('highlights bash', () => {
    const html = renderMarkdown('```bash\necho "hi" && ls -la\n```\n')
    expect(html).toContain('language-bash')
    expect(html).toContain('<pre><code')
  })

  test('unknown language falls back to escaped plain text, no hljs spans', () => {
    const html = renderMarkdown('```not-a-real-lang\nsome <text>\n```\n')
    expect(html).toContain('language-not-a-real-lang')
    expect(html).not.toContain('hljs-')
    expect(html).toContain('&lt;text&gt;')
  })

  test('fence with no language hint has no language class', () => {
    const html = renderMarkdown('```\nplain fenced text\n```\n')
    expect(html).not.toContain('language-')
    expect(html).toContain('plain fenced text')
  })

  test('HTML-looking content inside a code fence stays escaped, never parsed', () => {
    const html = renderMarkdown('```\n<img src=x onerror="alert(1)">\n```\n')
    // The whole line must survive only as escaped text inside <code> — no
    // real <img> tag, and the escaped onerror="..." text is inert.
    expect(html).toContain('<pre><code>&lt;img src=x onerror="alert(1)"&gt;</code></pre>')
    expect(html).not.toMatch(/<img[\s>]/)
  })
})

describe('renderMarkdown — XSS neutralization', () => {
  test('strips script tags and their contents entirely', () => {
    const html = renderMarkdown('before\n\n<script>alert(1)</script>\n\nafter')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
    expect(html).toContain('before')
    expect(html).toContain('after')
  })

  test('strips inline event-handler attributes', () => {
    const html = renderMarkdown('<img src="x.png" onerror="alert(1)">')
    expect(html).not.toContain('onerror')
  })

  test('strips javascript: hrefs on links', () => {
    const html = renderMarkdown('[click me](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
  })

  test('strips javascript: hrefs on raw HTML anchors', () => {
    const html = renderMarkdown('<a href="javascript:alert(1)">bad</a>')
    expect(html).not.toContain('javascript:')
  })

  test('drops iframe tags outright, including data: src attempts', () => {
    const html = renderMarkdown('<iframe src="data:text/html,<script>alert(1)</script>"></iframe>')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('data:text/html')
  })

  test('strips data: URLs from image src', () => {
    const html = renderMarkdown('![x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)')
    expect(html).not.toContain('data:text/html')
  })

  test('external links get target=_blank and rel=noopener', () => {
    const html = renderMarkdown('[ext](https://example.com/page)')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  test('relative and same-page links are left alone (no target=_blank)', () => {
    const html = renderMarkdown('[rel](/local/path) and [anchor](#section)')
    expect(html).not.toContain('target="_blank"')
  })

  test('mailto links are not treated as external', () => {
    const html = renderMarkdown('[email me](mailto:a@example.com)')
    expect(html).toContain('href="mailto:a@example.com"')
    expect(html).not.toContain('target="_blank"')
  })
})

describe('renderMarkdown — passthrough content', () => {
  test('dollar signs and math-like text pass through untouched', () => {
    const html = renderMarkdown('The total is $5 and $10, or $x + y$ in math notation.')
    expect(html).toContain('$5')
    expect(html).toContain('$10')
    expect(html).toContain('$x + y$')
  })
})

describe('renderMarkdown — large input', () => {
  // These sizes reflect the realistic "huge" shapes a chat message actually
  // takes (one big pasted file, one big wall of prose, a long-but-plausible
  // multi-paragraph message) — not an adversarial worst case. marked's block
  // lexer is quadratic in the *number of separate blank-line-separated
  // blocks* (not raw byte size): thousands of tiny paragraphs measurably
  // degrades well past what's tested here. See notes for why that's treated
  // as an app-layer (message length limit) concern rather than something
  // this pure util guards against.

  test(
    'a large (~1.2MB) fenced code block renders without hanging',
    () => {
      const big = ('const value = '.padEnd(60, 'a') + ';\n').repeat(20000)
      const html = renderMarkdown('```js\n' + big + '\n```\n')
      expect(html).toContain('<pre><code')
      expect(html.length).toBeGreaterThan(big.length)
    },
    5_000,
  )

  test(
    'a large (~1MB) single paragraph of prose renders without hanging',
    () => {
      const big = Array.from({ length: 100_000 }, (_, i) => `word${i}`).join(' ')
      const html = renderMarkdown(big)
      expect(html).toContain('word0')
      expect(html).toContain('word99999')
    },
    5_000,
  )

  test(
    'a long multi-paragraph message (600 paragraphs) renders without hanging',
    () => {
      const big = Array.from(
        { length: 600 },
        (_, i) => `Paragraph number ${i} of text.`,
      ).join('\n\n')
      const html = renderMarkdown(big)
      expect(html).toContain('Paragraph number 0 of text.')
      expect(html).toContain('Paragraph number 599 of text.')
    },
    5_000,
  )
})

describe('renderInline', () => {
  test('renders inline formatting', () => {
    const html = renderInline('**bold** and `code` and _em_')
    expect(html).toBe('<strong>bold</strong> and <code>code</code> and <em>em</em>')
  })

  test('strips block elements like paragraphs, lists, and headings', () => {
    const html = renderInline('# Heading\n\n- list item\n\n> quote\n')
    expect(html).not.toContain('<h1>')
    expect(html).not.toContain('<li>')
    expect(html).not.toContain('<blockquote>')
    expect(html).not.toContain('<p>')
  })

  test('strips fenced code blocks (no highlighting spans)', () => {
    const html = renderInline('```js\nconst x = 1\n```')
    expect(html).not.toContain('<pre>')
    expect(html).not.toContain('hljs')
  })

  test('neutralizes scripts and javascript: hrefs same as block mode', () => {
    const html = renderInline('<script>alert(1)</script>[x](javascript:alert(1))')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('javascript:')
  })

  test('external links still get target=_blank', () => {
    const html = renderInline('[ext](https://example.com)')
    expect(html).toContain('target="_blank"')
  })
})
