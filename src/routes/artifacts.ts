import { Hono } from 'hono'
import { getArtifactForUser } from '../db/queries/artifacts'
import { renderMarkdown } from '../utils/markdown'

export const artifactRoutes = new Hono()

function downloadName(title: string) {
  const safe = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return `${safe || 'artifact'}.md`
}

artifactRoutes.get('/artifacts/:id.md', async (c) => {
  const user = c.var.user
  if (!user) return c.redirect('/login')

  const artifact = await getArtifactForUser({ id: c.req.param('id') ?? '', userId: user.id })
  if (!artifact) return c.notFound()

  c.header('Content-Type', 'text/markdown; charset=utf-8')
  c.header('Content-Disposition', `attachment; filename="${downloadName(artifact.title)}"`)
  c.header('Cache-Control', 'private, no-store')
  return c.body(artifact.body_markdown)
})

artifactRoutes.get('/artifacts/:id', async (c) => {
  const user = c.var.user
  if (!user) return c.redirect('/login')

  const artifact = await getArtifactForUser({ id: c.req.param('id') ?? '', userId: user.id })
  if (!artifact) return c.notFound()

  c.header('Cache-Control', 'private, no-store')
  return c.var.render('artifacts/show', {
    title: artifact.title,
    artifact: {
      ...artifact,
      bodyHtml: renderMarkdown(artifact.body_markdown),
    },
  })
})
