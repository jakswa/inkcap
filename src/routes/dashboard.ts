import { Hono } from 'hono'

export const dashboardRoutes = new Hono()

dashboardRoutes.get('/dashboard', async (c) => {
  if (!c.var.user) {
    return c.redirect('/login')
  }

  c.header('Cache-Control', 'private, no-store')
  return c.var.render('dashboard', {
    title: 'Dashboard',
  })
})
