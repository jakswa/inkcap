import { Hono } from 'hono'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { csrf } from 'hono/csrf'
import { HTTPException } from 'hono/http-exception'
import { secureHeaders } from 'hono/secure-headers'
import { serveAssets } from './assets/serve-assets'
import { currentUser } from './middleware/current-user'
import { renderMiddleware } from './middleware/render'
import { publicOrigin } from './utils/public-origin'
import { authRoutes } from './routes/auth'
import { conversationRoutes } from './routes/conversations'
import { dashboardRoutes } from './routes/dashboard'
import { homeRoutes } from './routes/home'
import { mcpServerRoutes } from './routes/mcp-servers'
import { providerRoutes } from './routes/providers'
import { settingsRoutes } from './routes/settings'

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

// Hono's default same-origin check, plus operator-declared extra origins for
// split-origin deployments: PUBLIC_ORIGIN (a TLS-terminating proxy makes the
// browser's https origin differ from the http URL the server sees) and
// CSRF_TRUSTED_ORIGINS (comma-separated, e.g. a LAN IP used to dodge hairpin
// NAT). Read lazily so tests can vary them.
function csrfTrustedOrigins() {
  const origins = (process.env['CSRF_TRUSTED_ORIGINS'] ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  const configured = publicOrigin()
  if (configured) origins.push(configured)
  return origins
}

app.use(
  csrf({
    origin: (origin, c) => {
      if (origin === new URL(c.req.url).origin) return true
      return csrfTrustedOrigins().includes(origin)
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
app.route('/', conversationRoutes)

app.notFound((c) =>
  renderError(c, 404, 'Page not found', 'The page you requested does not exist.'),
)

app.onError((error, c) => {
  // Deliberate rejections (CSRF's 403, most visibly) keep their status and
  // response instead of masquerading as a server error.
  if (error instanceof HTTPException) return error.getResponse()

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
