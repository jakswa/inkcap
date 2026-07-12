import { Hono } from 'hono'
import { newChatData } from './conversations'

export const homeRoutes = new Hono()

const groves = ['moss', 'moon', 'lichen'] as const

function randomGrove() {
  return groves[Math.floor(Math.random() * groves.length)]
}

homeRoutes.get('/', async (c) => {
  const user = c.var.user
  c.header('Cache-Control', user ? 'private, no-store' : 'private, no-cache')

  if (!user) {
    return c.var.render('home', { title: 'inkcap' })
  }

  const requestedGrove = c.req.query('grove') || ''
  const grove = groves.includes(requestedGrove as (typeof groves)[number])
    ? requestedGrove
    : randomGrove()
  return c.var.render('home', {
    title: 'New chat · inkcap',
    fullBleed: true,
    grove,
    ...(await newChatData(user.id, { includeSidebar: false })),
  })
})
