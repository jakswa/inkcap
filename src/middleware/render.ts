import { Eta } from 'eta'
import { createMiddleware } from 'hono/factory'
import type { CurrentUser, Renderer } from '../app-types'
import { env } from '../utils/env'
import { paths } from '../utils/paths'

const eta = new Eta({
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
    })

    return c.html(html)
  })

  await next()
})
