import type { Context } from 'hono'
import { join } from 'node:path'
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

  if (!cleaned || cleaned.includes('..') || cleaned.includes('\\')) {
    return null
  }

  return cleaned
}

function contentTypeFor(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return contentTypes[ext] ?? 'application/octet-stream'
}

function acceptsEncoding(header: string | undefined, encoding: CompressedEncoding) {
  if (!header) return false

  return header
    .toLowerCase()
    .split(',')
    .some((part) => part.trim().split(';')[0] === encoding)
}

async function compressedVariantFor(
  path: string,
  acceptEncoding: string | undefined,
) {
  if (acceptsEncoding(acceptEncoding, 'br')) {
    const file = Bun.file(join(paths.appAssets, `${path}.br`))
    if (await file.exists()) return { encoding: 'br' as const, file }
  }

  if (acceptsEncoding(acceptEncoding, 'gzip')) {
    const file = Bun.file(join(paths.appAssets, `${path}.gz`))
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
    c.header('Content-Type', contentTypeFor(path))
    return c.body(compressed.file.stream())
  }

  if (path === 'app.css') {
    c.header('Content-Type', 'text/css; charset=utf-8')
    return c.body(await readAppCss())
  }

  const file = Bun.file(join(paths.appAssets, path))

  if (!(await file.exists())) {
    return c.notFound()
  }

  c.header('Content-Type', contentTypeFor(path))
  return c.body(file.stream())
}
