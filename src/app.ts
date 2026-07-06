import { Hono } from 'hono'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { csrf } from 'hono/csrf'
import { secureHeaders } from 'hono/secure-headers'
import { serveAssets } from './assets/serve-assets'
import { currentUser } from './middleware/current-user'
import { renderMiddleware } from './middleware/render'
import { authRoutes } from './routes/auth'
import { dashboardRoutes } from './routes/dashboard'
import { homeRoutes } from './routes/home'

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
    maxSize: 50 * 1024 * 1024,
    onError: (c) => c.text('Request body too large', 413),
  }),
)

app.get('/assets/:version/*', serveAssets)

app.use(csrf())
app.use(currentUser)
app.use(renderMiddleware)

app.route('/', homeRoutes)
app.route('/', authRoutes)
app.route('/', dashboardRoutes)

app.notFound((c) =>
  renderError(c, 404, 'Page not found', 'The page you requested does not exist.'),
)

app.onError((error, c) => {
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
