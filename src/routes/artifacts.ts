import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  disableArtifactPublicShare,
  getArtifactForUser,
  getPublicArtifactById,
  setArtifactPublicShare,
} from '../db/queries/artifacts'
import { renderMarkdown } from '../utils/markdown'
import { publicOrigin } from '../utils/public-origin'

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

function contentDispositionAttachment(filename: string) {
  return `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

function shareUrl(c: Context, id: string) {
  const origin = publicOrigin() ?? new URL(c.req.url).origin
  return `${origin}/artifacts/${id}`
}

function shareExpiresAt(choice: string) {
  if (choice === 'forever') return null
  const now = Date.now()
  const hours: Record<string, number> = {
    '1h': 1,
    '24h': 24,
    '7d': 24 * 7,
    '30d': 24 * 30,
  }
  const selected = hours[choice]
  if (!selected) return null
  return new Date(now + selected * 60 * 60 * 1000)
}

function publicShareActive(artifact: {
  public_shared_at?: Date | null
  public_share_expires_at?: Date | null
}) {
  return Boolean(
    artifact.public_shared_at &&
      (!artifact.public_share_expires_at || artifact.public_share_expires_at > new Date()),
  )
}

function artifactKindLabel(kind: string | null | undefined) {
  const label = (kind || 'artifact').trim().toLowerCase()
  return label || 'artifact'
}

function shareTitle(artifact: { title: string; kind?: string | null }) {
  return `inkcap ${artifactKindLabel(artifact.kind)}: ${artifact.title}`.slice(0, 160)
}

function shareDescription(artifact: {
  share_description?: string | null
  kind?: string | null
}) {
  const decorated = artifact.share_description?.trim()
  if (decorated) return decorated.slice(0, 300)
  const kind = artifactKindLabel(artifact.kind)
  return `A ${kind} artifact shared from inkcap.`
}

async function artifactForRequest(c: Context) {
  const id = artifactIdFromParam(c.req.param('id'))
  if (!id) return { notFound: true as const }

  const user = c.var.user
  if (user) {
    const owned = await getArtifactForUser({ id, userId: user.id })
    if (owned) return { artifact: owned, owner: true as const, id }
  }

  const shared = await getPublicArtifactById(id)
  if (shared) return { artifact: shared, owner: false as const, id }

  if (!user) return { redirect: c.redirect('/login') }
  return { notFound: true as const }
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

artifactRoutes.post('/artifacts/:id/share', async (c) => {
  const user = c.var.user
  if (!user) return c.redirect('/login')

  const id = artifactIdFromParam(c.req.param('id'))
  if (!id) return c.notFound()

  const form = await c.req.formData()
  const expires = shareExpiresAt(String(form.get('expires') ?? 'forever'))
  const artifact = await setArtifactPublicShare({ id, userId: user.id, expiresAt: expires })
  if (!artifact) return c.notFound()

  return c.redirect(`/artifacts/${id}?shared=1`)
})

artifactRoutes.post('/artifacts/:id/unshare', async (c) => {
  const user = c.var.user
  if (!user) return c.redirect('/login')

  const id = artifactIdFromParam(c.req.param('id'))
  if (!id) return c.notFound()

  await disableArtifactPublicShare({ id, userId: user.id })
  return c.redirect(`/artifacts/${id}?unshared=1`)
})

artifactRoutes.get('/artifacts/:id', async (c) => {
  const result = await artifactForRequest(c)
  if ('redirect' in result) return result.redirect
  if ('notFound' in result) return c.notFound()

  const artifact = result.artifact
  c.header('Cache-Control', 'private, no-store')
  const canonicalUrl = shareUrl(c, artifact.id)
  const description = shareDescription(artifact)
  return c.var.render('artifacts/show', {
    title: artifact.title,
    metaDescription: description,
    ogTitle: shareTitle(artifact),
    ogDescription: description,
    ogUrl: canonicalUrl,
    ogType: 'article',
    twitterCard: 'summary',
    owner: result.owner,
    shareUrl: canonicalUrl,
    sharedNotice: c.req.query('shared') === '1',
    unsharedNotice: c.req.query('unshared') === '1',
    artifact: {
      ...artifact,
      publicShareActive: publicShareActive(artifact),
      downloadFilename: downloadName(artifact.title),
      bodyHtml: renderMarkdown(artifact.body_markdown),
    },
  })
})
