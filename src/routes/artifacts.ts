import { Hono } from 'hono'
import type { Context } from 'hono'
import { getArtifactForUser } from '../db/queries/artifacts'
import { renderMarkdown } from '../utils/markdown'

export const artifactRoutes = new Hono()

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function downloadName(title: string) {
  const safe = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return `${safe || 'artifact'}.md`
}

function artifactIdFromParam(value: string | undefined) {
  const id = value ?? ''
  return uuidPattern.test(id) ? id : null
}

async function artifactForRequest(c: Context) {
  const user = c.var.user
  if (!user) return { redirect: c.redirect('/login') }

  const id = artifactIdFromParam(c.req.param('id'))
  if (!id) return { notFound: true }

  const artifact = await getArtifactForUser({ id, userId: user.id })
  if (!artifact) return { notFound: true }
  return { artifact }
}

function contentDispositionAttachment(filename: string) {
  return `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

async function renderMarkdownDownload(c: Context) {
  const result = await artifactForRequest(c)
  if ('redirect' in result) return result.redirect
  if ('notFound' in result) return c.notFound()

  const filename = downloadName(result.artifact.title)
  return new Response(result.artifact.body_markdown, {
    headers: {
      // application/octet-stream + attachment makes this a real download in
      // browsers that like to inline text/markdown or text/plain navigations.
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': contentDispositionAttachment(filename),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

artifactRoutes.get('/artifacts/:id/download', renderMarkdownDownload)

artifactRoutes.get('/artifacts/:id', async (c) => {
  const result = await artifactForRequest(c)
  if ('redirect' in result) return result.redirect
  if ('notFound' in result) return c.notFound()

  const artifact = result.artifact
  c.header('Cache-Control', 'private, no-store')
  return c.var.render('artifacts/show', {
    title: artifact.title,
    artifact: {
      ...artifact,
      downloadFilename: downloadName(artifact.title),
      bodyHtml: renderMarkdown(artifact.body_markdown),
    },
  })
})
