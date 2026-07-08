import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { renderMarkdown } from '../utils/markdown'
import { paths } from '../utils/paths'

function assertFile(path: string) {
  if (!existsSync(path)) throw new Error(`Runtime smoke test could not find ${path}`)
}

const html = renderMarkdown('**runtime smoke**')

if (!html.includes('<strong>runtime smoke</strong>')) {
  throw new Error(`Markdown smoke test rendered unexpected HTML: ${html}`)
}

// Prove copied runtime files are present for the current entrypoint.
assertFile(join(paths.views, 'error.eta'))

// In the final image we also support running the bundled server with
// NODE_ENV=development. For build/index.js that expects /app/{views,static,db},
// so Dockerfile creates compatibility symlinks and this verifies them.
if (process.cwd() === '/app') {
  assertFile('/app/views/error.eta')
  assertFile('/app/static/app.css')
  assertFile('/app/db/migrations/001_init.sql')
}

console.log('Runtime smoke test passed')
