import { Eta } from 'eta'
import { createMiddleware } from 'hono/factory'
import type { CurrentUser, Renderer } from '../app-types'
import { env } from '../utils/env'
import { paths } from '../utils/paths'

// Exported so out-of-request code (the chat runner's message-final events)
// renders the same templates with the same configuration.
export const eta = new Eta({
  views: paths.views,
  cache: env.NODE_ENV === 'production',
})

export const renderMiddleware = createMiddleware<{
  Variables: {
    render: Renderer
    user: CurrentUser
  }
}>(async (c, next) => {
  c.set('render', async (template, data = {}) => {
    const html = await eta.renderAsync(template, {
      ...data,
      user: c.var.user ?? null,
      assetVersion: env.ASSET_VERSION,
      registrationOpen: env.REGISTRATION === 'open',
      currentPath: c.req.path,
    })

    return c.html(html)
  })

  await next()
})
