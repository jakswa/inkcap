import { Hono } from 'hono'
import { getArtifactForUser } from '../db/queries/artifacts'
import { renderMarkdown } from '../utils/markdown'

export const artifactRoutes = new Hono()

artifactRoutes.get('/artifacts/:id', async (c) => {
  const user = c.var.user
  if (!user) return c.redirect('/login')

  const artifact = await getArtifactForUser({ id: c.req.param('id'), userId: user.id })
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
