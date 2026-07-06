import type { Context } from 'hono'
import { join, resolve, sep } from 'node:path'
import { env } from '../utils/env'
import { paths } from '../utils/paths'

const contentTypes: Record<string, string> = {
  css: 'text/css; charset=utf-8',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript; charset=utf-8',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
}

type CompressedEncoding = 'br' | 'gzip'

let cachedCss: string | undefined

function assetCacheHeader() {
  return env.NODE_ENV === 'production'
    ? 'public, max-age=31536000, immutable'
    : 'no-store'
}

function safeAssetPath(path: string) {
  const cleaned = path.replace(/^\/+/, '')

  if (!cleaned || cleaned.includes('\\')) {
    return null
  }

  const root = resolve(paths.appAssets)
  const resolved = resolve(root, cleaned)
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) return null

  return { relative: cleaned, absolute: resolved }
}

function contentTypeFor(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return contentTypes[ext] ?? 'application/octet-stream'
}

function acceptsEncoding(header: string | undefined, encoding: CompressedEncoding) {
  if (!header) return false

  let wildcardQ: number | null = null
  for (const rawPart of header.toLowerCase().split(',')) {
    const [rawToken, ...params] = rawPart.trim().split(';')
    const token = rawToken?.trim()
    if (!token) continue

    const qParam = params.find((param) => param.trim().startsWith('q='))
    const q = qParam ? Number(qParam.trim().slice(2)) : 1
    const acceptable = Number.isFinite(q) && q > 0

    if (token === encoding) return acceptable
    if (token === '*') wildcardQ = q
  }

  return wildcardQ !== null && Number.isFinite(wildcardQ) && wildcardQ > 0
}

async function compressedVariantFor(
  path: { relative: string; absolute: string },
  acceptEncoding: string | undefined,
) {
  if (acceptsEncoding(acceptEncoding, 'br')) {
    const file = Bun.file(`${path.absolute}.br`)
    if (await file.exists()) return { encoding: 'br' as const, file }
  }

  if (acceptsEncoding(acceptEncoding, 'gzip')) {
    const file = Bun.file(`${path.absolute}.gz`)
    if (await file.exists()) return { encoding: 'gzip' as const, file }
  }

  return null
}

async function readAppCss() {
  if (env.NODE_ENV === 'production' && cachedCss) return cachedCss

  const css = await Bun.file(join(paths.appAssets, 'app.css')).text()

  if (env.NODE_ENV === 'production') {
    cachedCss = css
  }

  return css
}

export async function serveAssets(c: Context) {
  const version = c.req.param('version')
  if (env.NODE_ENV === 'production' && version !== env.ASSET_VERSION) {
    return c.notFound()
  }

  const rawPath = c.req.path.replace(/^\/assets\/[^/]+\//, '')
  const path = safeAssetPath(rawPath)

  if (!path) return c.notFound()

  c.header('Cache-Control', assetCacheHeader())

  c.header('Vary', 'Accept-Encoding')

  const compressed = await compressedVariantFor(
    path,
    c.req.header('Accept-Encoding'),
  )
  if (compressed) {
    c.header('Content-Encoding', compressed.encoding)
    c.header('Content-Type', contentTypeFor(path.relative))
    return c.body(compressed.file.stream())
  }

  if (path.relative === 'app.css') {
    c.header('Content-Type', 'text/css; charset=utf-8')
    return c.body(await readAppCss())
  }

  const file = Bun.file(path.absolute)

  if (!(await file.exists())) {
    return c.notFound()
  }

  c.header('Content-Type', contentTypeFor(path.relative))
  return c.body(file.stream())
}
