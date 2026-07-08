import { Hono } from 'hono'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { csrf } from 'hono/csrf'
import { HTTPException } from 'hono/http-exception'
import { secureHeaders } from 'hono/secure-headers'
import { serveAssets } from './assets/serve-assets'
import { env } from './utils/env'
import { currentUser } from './middleware/current-user'
import { renderMiddleware } from './middleware/render'
import { trustedOrigins } from './utils/public-origin'
import { authRoutes } from './routes/auth'
import { conversationRoutes } from './routes/conversations'
import { dashboardRoutes } from './routes/dashboard'
import { homeRoutes } from './routes/home'
import { mcpServerRoutes } from './routes/mcp-servers'
import { providerRoutes } from './routes/providers'
import { settingsRoutes } from './routes/settings'
import { loopRoutes } from './routes/loops'
import { artifactRoutes } from './routes/artifacts'
import { pushRoutes } from './routes/push'

export const app = new Hono()

app.use(
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
    },
  }),
)
app.use(
  bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) => c.text('Request body too large', 413),
  }),
)

app.get('/assets/:version/*', serveAssets)
app.get('/manifest.webmanifest', (c) =>
  c.json({
    name: 'inkcap',
    short_name: 'inkcap',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f7f3ea',
    theme_color: '#7c3aed',
    icons: [
      {
        src: `/assets/${env.ASSET_VERSION}/logo.svg`,
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any maskable',
      },
    ],
  }),
)
app.get('/sw.js', (c) => {
  c.header('Content-Type', 'text/javascript; charset=utf-8')
  c.header('Service-Worker-Allowed', '/')
  c.header('Cache-Control', 'no-store')
  return c.body(`self.addEventListener('push', (event) => {\n  let data = {};\n  try { data = event.data ? event.data.json() : {}; } catch (_) {}\n  const title = data.title || 'inkcap';\n  const options = {\n    body: data.body || '',\n    icon: '/assets/${env.ASSET_VERSION}/logo.svg',\n    badge: '/assets/${env.ASSET_VERSION}/logo.svg',\n    data: { url: data.url || '/' }\n  };\n  event.waitUntil(self.registration.showNotification(title, options));\n});\n\nself.addEventListener('notificationclick', (event) => {\n  event.notification.close();\n  const url = new URL(event.notification.data && event.notification.data.url || '/', self.location.origin).href;\n  event.waitUntil((async () => {\n    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });\n    for (const client of windows) {\n      if ('focus' in client && client.url === url) return client.focus();\n    }\n    return clients.openWindow(url);\n  })());\n});\n`)
})

// Hono's default same-origin check, plus operator-declared extra origins for
// split-origin deployments: PUBLIC_ORIGIN (a TLS-terminating proxy makes the
// browser's https origin differ from the http URL the server sees) and
// CSRF_TRUSTED_ORIGINS (e.g. a LAN IP used to dodge hairpin NAT).
app.use(
  csrf({
    origin: (origin, c) => {
      if (origin === new URL(c.req.url).origin) return true
      return trustedOrigins().includes(origin)
    },
  }),
)
app.use(currentUser)
app.use(renderMiddleware)

app.route('/', homeRoutes)
app.route('/', authRoutes)
app.route('/', dashboardRoutes)
app.route('/', providerRoutes)
app.route('/', mcpServerRoutes)
app.route('/', settingsRoutes)
app.route('/', loopRoutes)
app.route('/', artifactRoutes)
app.route('/', pushRoutes)
app.route('/', conversationRoutes)

app.notFound((c) =>
  renderError(c, 404, 'Page not found', 'The page you requested does not exist.'),
)

app.onError((error, c) => {
  // Deliberate rejections (CSRF's 403, most visibly) keep their status and
  // response instead of masquerading as a server error. Logged at warn so a
  // misconfigured trusted origin is diagnosable from the server side.
  if (error instanceof HTTPException) {
    console.warn(
      `HTTP ${error.status} on ${c.req.method} ${new URL(c.req.url).pathname}${error.message ? `: ${error.message}` : ''}`,
    )
    return error.getResponse()
  }

  console.error(error)
  return renderError(
    c,
    500,
    'Something went wrong',
    'An unexpected error occurred. Please try again.',
  )
})

function renderError(
  c: Context,
  status: 404 | 500,
  title: string,
  message: string,
) {
  c.status(status)

  if (c.var.render) {
    return c.var.render('error', { title, status, message })
  }

  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${message}</p></body></html>`,
    status,
  )
}
