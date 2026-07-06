import { Hono } from 'hono'

export const settingsRoutes = new Hono()

settingsRoutes.get('/settings', async (c) => {
  if (!c.var.user) {
    return c.redirect('/login')
  }

  c.header('Cache-Control', 'private, no-store')
  return c.var.render('settings', {
    title: 'Settings',
  })
})
