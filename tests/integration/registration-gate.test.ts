// REGISTRATION=closed gate. `env` is read once at import, and the suite runs
// concurrently against one process (mutating the shared env object would race
// auth.test.ts's live registrations), so closed mode gets its own subprocess
// with its own app import.

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const projectRoot = join(import.meta.dir, '../..')

const script = `
const { app } = await import('${join(projectRoot, 'src/app.ts')}')

const getRegister = await app.request('http://localhost:3000/register')
const postRegister = await app.request('http://localhost:3000/register', {
  method: 'POST',
  headers: { Origin: 'http://localhost:3000' },
  body: new FormData(),
})
const home = await (await app.request('http://localhost:3000/')).text()
const login = await (await app.request('http://localhost:3000/login')).text()

console.log(
  JSON.stringify({
    getRegister: getRegister.status,
    postRegister: postRegister.status,
    homeLinksRegister: home.includes('/register'),
    loginLinksRegister: login.includes('/register'),
    loginStillWorks: login.includes('Log in'),
  }),
)
process.exit(0)
`

describe('registration gate', () => {
  test('REGISTRATION=closed 404s the register routes and hides the links', async () => {
    const proc = Bun.spawn(['bun', '-e', script], {
      cwd: projectRoot,
      env: {
        ...process.env,
        REGISTRATION: 'closed',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(exitCode, err).toBe(0)

    const result = JSON.parse(out.trim().split('\n').at(-1)!)
    expect(result).toEqual({
      getRegister: 404,
      postRegister: 404,
      homeLinksRegister: false,
      loginLinksRegister: false,
      loginStillWorks: true,
    })
  }, 20_000)

  test('open mode (test default) serves the register page and links to it', async () => {
    const { app } = await import('../../src/app')
    const page = await app.request('http://localhost:3000/register')
    expect(page.status).toBe(200)
    const login = await (await app.request('http://localhost:3000/login')).text()
    expect(login).toContain('/register')
  })
})
