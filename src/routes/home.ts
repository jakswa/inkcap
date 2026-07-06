import { Hono } from 'hono'

export const homeRoutes = new Hono()

homeRoutes.get('/', async (c) => {
  c.header('Cache-Control', 'private, no-cache')
  return c.var.render('home', {
    title: 'Bun Hono SSR Starter',
  })
})
