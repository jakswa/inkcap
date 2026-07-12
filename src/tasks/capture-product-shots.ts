// Deterministic product screenshot capture. One command owns the whole
// lifecycle: build CSS, provision a disposable screenshot database (never the
// developer's normal DB), migrate + seed it with a frozen fixture clock,
// start the app on a dedicated configurable port, wait for HTTP readiness,
// drive a configurable system Chromium through Playwright to capture the
// required matrix, stop only the child it started, and report objective
// capture facts. It does not assess visual quality.
//
//   bun src/tasks/capture-product-shots.ts
//   bun src/tasks/capture-product-shots.ts --stability-check
//   bun src/tasks/capture-product-shots.ts --publish  # after visual approval
//
// Config (env, all optional with sensible defaults):
//   SHOTS_PORT            dedicated port (default 4343). Must be free.
//   SHOTS_DATABASE_URL    disposable DB URL (default: <dev DB>_shots on same host).
//   SHOTS_BROWSER         system Chromium executable path (default: auto-detect).
//   INKCAP_FIXED_NOW      ISO-8601 instant frozen across seed + render + browser.
//   SHOTS_OUT_DIR         candidate output directory (default docs/assets/ui-polish/candidates).
//   SHOTS_EMAIL / SHOTS_PASSWORD  demo login (default demo@inkcap.dev / inkcap-demo).
//
// This task is a dev-only tool. src/build.ts excludes it from the production
// bundle because Playwright is a devDependency and must not ship to prod.

import { spawn } from 'node:child_process'
import { access, mkdir, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { SQL } from 'bun'
import { migrate } from '../db/migrate'

interface CaptureTarget {
  name: string
  route: string
  viewport: { width: number; height: number }
  colorScheme: 'light' | 'dark'
  fullPage: boolean
  focusSelector?: string
}

interface CaptureInfo {
  path: string
  bytes: number
  width: number
  height: number
  httpStatus: number
}

interface CaptureResult {
  target: CaptureTarget
  info: CaptureInfo
}

interface CaptureAllResult {
  browserVersion: string
  results: CaptureResult[]
}

const FIXED_NOW_DEFAULT = '2026-07-10T12:00:00Z'

function readArg(flag: string): string | null {
  const index = Bun.argv.indexOf(flag)
  return index >= 0 ? (Bun.argv[index + 1] ?? null) : null
}
function readEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback
}

const root = resolve(import.meta.dir, '../..')
const outDir = readEnv('SHOTS_OUT_DIR', join(root, 'docs/assets/ui-polish/candidates'))
const fixedNow = readArg('--fixed-now') ?? readEnv('INKCAP_FIXED_NOW', FIXED_NOW_DEFAULT)
const fixedNowMs = Date.parse(fixedNow)
if (!Number.isFinite(fixedNowMs)) {
  fail(`INKCAP_FIXED_NOW is not a parseable ISO-8601 instant: ${fixedNow}`)
}
const port = Number(readArg('--port') ?? readEnv('SHOTS_PORT', '4343'))
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  fail(`SHOTS_PORT is not a valid port: ${port}`)
}
const shotsEmail = readEnv('SHOTS_EMAIL', 'demo@inkcap.dev')
const shotsPassword = readEnv('SHOTS_PASSWORD', 'inkcap-demo')
const stabilityCheck = Bun.argv.includes('--stability-check')
const publishShots = Bun.argv.includes('--publish')

const devDbUrl = process.env['DATABASE_URL']
if (!devDbUrl) {
  fail(
    'DATABASE_URL is unset. Bun loads .env.development automatically; set DATABASE_URL (or a .env file) so the disposable shots DB can be derived from its host/credentials.',
  )
}
const shotsDbUrl = readArg('--database-url') ?? readEnv('SHOTS_DATABASE_URL', deriveShotsDbUrl(devDbUrl))
const shotsDbName = new URL(shotsDbUrl).pathname.slice(1)
if (!shotsDbName.includes('shots')) {
  fail(
    `Refusing to use a screenshot database whose name does not contain "shots": ${shotsDbUrl}. Set SHOTS_DATABASE_URL to a dedicated disposable database.`,
  )
}
if (shotsDbName === new URL(devDbUrl).pathname.slice(1)) {
  fail(`The shots database must differ from the developer database (${shotsDbName}).`)
}

const browserPath = readArg('--browser') ?? readEnv('SHOTS_BROWSER', '')

function fail(message: string): never {
  console.error(`capture: ${message}`)
  process.exit(1)
}

function deriveShotsDbUrl(devUrl: string): string {
  const url = new URL(devUrl)
  const original = url.pathname.slice(1) || 'inkcap'
  url.pathname = `/${original}_shots`
  return url.toString()
}

async function resolveBrowserPath(candidate: string): Promise<string> {
  const candidates = candidate
    ? [candidate]
    : ['/usr/bin/chromium', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome']
  for (const path of candidates) {
    if (!path) continue
    try {
      const s = await stat(path)
      if (s.isFile() || s.isCharacterDevice() || s.isBlockDevice()) {
        if (await pathIsExecutable(path)) return path
      }
    } catch {
      // not present; try next
    }
  }
  fail(
    'No usable system Chromium found. Set SHOTS_BROWSER to a Chromium/Chrome executable path, or install one (e.g. `bunx playwright install chromium` and set SHOTS_BROWSER to the resulting binary).',
  )
}

async function pathIsExecutable(path: string): Promise<boolean> {
  try {
    await access(path, 1) // X_OK
    return true
  } catch {
    return false
  }
}

async function assertBrowserExecutable(path: string): Promise<void> {
  let exists = false
  try {
    const s = await stat(path)
    exists = s.isFile() || s.isCharacterDevice() || s.isBlockDevice()
  } catch {
    exists = false
  }
  if (!exists) {
    fail(
      `SHOTS_BROWSER does not exist or is not a file: ${path}. Set SHOTS_BROWSER to a Chromium/Chrome executable, or run \`bunx playwright install chromium\`.`,
    )
  }
  if (!(await pathIsExecutable(path))) {
    fail(`SHOTS_BROWSER is not executable: ${path}.`)
  }
}

async function portIsFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const tester = createServer()
    tester.unref()
    tester.once('error', () => res(false))
    tester.listen(port, '127.0.0.1', () => {
      tester.close(() => res(true))
    })
  })
}

function spawnChild(cmd: string[], env: NodeJS.ProcessEnv): ReturnType<typeof spawn> {
  const child = spawn(cmd[0]!, cmd.slice(1), {
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
    cwd: root,
  })
  return child
}

function runCmd(cmd: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnChild(cmd, env)
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd.join(' ')} exited with ${code}`))
    })
  })
}

async function dropCreateMigrate(): Promise<void> {
  const url = new URL(shotsDbUrl)
  const dbName = url.pathname.slice(1)
  const maintenanceUrl = new URL(shotsDbUrl)
  maintenanceUrl.pathname = '/postgres'
  const sql = new SQL(maintenanceUrl.toString())
  try {
    await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${dbName} AND pid <> pg_backend_pid()`
    await sql`DROP DATABASE IF EXISTS ${sql(dbName)}`
    await sql`CREATE DATABASE ${sql(dbName)}`
    await sql.close()
  } catch (error) {
    try {
      await sql.close()
    } catch {
      // ignore
    }
    throw new Error(
      `Could not provision disposable screenshot database ${dbName}. Check that the credentials in DATABASE_URL can CREATE DATABASE.\n${String(error)}`,
    )
  }
  await migrate(shotsDbUrl, { quiet: true })
  console.log(`Provisioned and migrated ${dbName}`)
}

interface ConversationIds {
  heroId: string
  approvalId: string
}

async function queryConversationIds(): Promise<ConversationIds> {
  const sql = new SQL(shotsDbUrl)
  try {
    const [hero] = await sql`SELECT id FROM conversations WHERE title = 'Flaky Playwright checkout spec' LIMIT 1`
    const [approval] = await sql`SELECT id FROM conversations WHERE title = 'Index bloat on analytics DB' LIMIT 1`
    if (!hero || !approval) {
      fail('Seed did not produce the expected demo conversations (hero/approval).')
    }
    return { heroId: hero.id, approvalId: approval.id }
  } finally {
    await sql.close()
  }
}

async function waitForReadiness(): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`)
      if (res.ok) {
        console.log(`Server ready on port ${port}`)
        return
      }
    } catch {
      // not up yet
    }
    await Bun.sleep(250)
  }
  fail(`Server did not become ready on port ${port} within 30s.`)
}

const CAPTURE_MATRIX: CaptureTarget[] = [
  { name: 'home-moss-light', route: '/?grove=moss', viewport: { width: 1440, height: 900 }, colorScheme: 'light', fullPage: true },
  { name: 'home-moon-light', route: '/?grove=moon', viewport: { width: 1440, height: 900 }, colorScheme: 'light', fullPage: true },
  { name: 'home-lichen-light', route: '/?grove=lichen', viewport: { width: 1440, height: 900 }, colorScheme: 'light', fullPage: true },
  { name: 'chat-hero-light', route: '__HERO__', viewport: { width: 1440, height: 900 }, colorScheme: 'light', fullPage: false },
  { name: 'chat-hero-dark', route: '__HERO__', viewport: { width: 1440, height: 900 }, colorScheme: 'dark', fullPage: false },
  { name: 'providers-light', route: '/providers', viewport: { width: 1440, height: 1000 }, colorScheme: 'light', fullPage: false },
  { name: 'providers-dark', route: '/providers', viewport: { width: 1440, height: 1000 }, colorScheme: 'dark', fullPage: false },
  { name: 'loops-light', route: '/loops', viewport: { width: 1440, height: 1000 }, colorScheme: 'light', fullPage: false },
  { name: 'loops-dark', route: '/loops', viewport: { width: 1440, height: 1000 }, colorScheme: 'dark', fullPage: false },
  { name: 'loop-config-light', route: '/loops/new', viewport: { width: 1440, height: 1000 }, colorScheme: 'light', fullPage: false, focusSelector: 'h2:text-is("When")' },
  { name: 'mcp-approval-dark', route: '__APPROVAL__', viewport: { width: 1440, height: 900 }, colorScheme: 'dark', fullPage: false },
  { name: 'chat-mobile-light', route: '__HERO__', viewport: { width: 390, height: 844 }, colorScheme: 'light', fullPage: false },
]

function resolveRoute(route: string, ids: ConversationIds): string {
  if (route === '__HERO__') return `/conversations/${ids.heroId}`
  if (route === '__APPROVAL__') return `/conversations/${ids.approvalId}`
  return route
}

async function login(page: import('playwright').Page, origin: string): Promise<void> {
  await page.goto(`${origin}/login`, { waitUntil: 'load' })
  await page.fill('input[name="email"]', shotsEmail)
  await page.fill('input[name="password"]', shotsPassword)
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 10_000 }),
    page.click('button[type="submit"]'),
  ])
  if (new URL(page.url()).pathname !== '/conversations') {
    throw new Error(`Login redirected to an unexpected page: ${page.url()}`)
  }
  // Confirm the session cookie landed; if not, the screenshot would be the
  // anonymous redirect view.
  const res = await page.request.get(`${origin}/providers`)
  if (res.status() !== 200) {
    throw new Error(`Login did not establish a session (GET /providers -> ${res.status()}).`)
  }
}

async function captureTarget(
  browser: import('playwright').Browser,
  origin: string,
  target: CaptureTarget,
  ids: ConversationIds,
  dir: string,
  storageState: Awaited<ReturnType<import('playwright').BrowserContext['storageState']>>,
): Promise<CaptureInfo> {
  const context = await browser.newContext({
    storageState,
    viewport: target.viewport,
    colorScheme: target.colorScheme,
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  })
  const page = await context.newPage()
  // Keep references to chat EventSources so each isolated capture can close
  // its replay stream after the parked/current state has rendered.
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource
    const sources: EventSource[] = []
    class TrackedEventSource extends NativeEventSource {
      constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
        super(url, eventSourceInitDict)
        sources.push(this)
      }
    }
    Object.defineProperty(window, 'EventSource', { value: TrackedEventSource })
    Object.defineProperty(window, '__inkcapCaptureEventSources', { value: sources })
  })
  // Freeze the page clock to the capture instant before any navigation so
  // client-side Date usage is deterministic.
  await page.clock.install({ time: fixedNowMs })
  await page.clock.setFixedTime(fixedNowMs)
  try {
    const route = resolveRoute(target.route, ids)
    const res = await page.goto(`${origin}${route}`, { waitUntil: 'load' })
    const httpStatus = res?.status() ?? 0
    if (httpStatus !== 200) {
      throw new Error(`GET ${route} returned ${httpStatus}`)
    }
    await page.evaluate(async () => {
      if ((document as Document).fonts && 'ready' in document.fonts) {
        await document.fonts.ready
      }
    })
    // Detail captures may deliberately frame a lower section rather than
    // wasting the viewport on the generic top of a long form.
    if (target.focusSelector) {
      await page.locator(target.focusSelector).evaluate((element) => {
        const top = element.getBoundingClientRect().top + window.scrollY
        window.scrollTo(0, Math.max(0, top - 120))
      })
    }
    // Deterministic settle: animations are reduced; let layout/fonts stabilize
    // without depending on networkidle (SSE would hang it for active runs).
    await page.waitForTimeout(800)
    await page.evaluate(() => {
      const sources = (window as typeof window & { __inkcapCaptureEventSources?: EventSource[] }).__inkcapCaptureEventSources ?? []
      for (const source of sources) source.close()
    })
    const outPath = join(dir, `${target.name}.png`)
    await page.screenshot({ path: outPath, fullPage: target.fullPage, animations: 'disabled', caret: 'hide' })
    const s = await stat(outPath)
    const png = await Bun.file(outPath).arrayBuffer()
    const view = new DataView(png)
    // PNG width/height are big-endian uint32 at byte offsets 16/20.
    const width = view.getUint32(16)
    const height = view.getUint32(20)
    return { path: outPath, bytes: s.size, width, height, httpStatus }
  } finally {
    await context.close()
  }
}

async function captureAll(dir: string, resolvedBrowser: string, targets: CaptureTarget[] = CAPTURE_MATRIX): Promise<CaptureAllResult> {
  await mkdir(dir, { recursive: true })
  await assertBrowserExecutable(resolvedBrowser)
  const browser = await chromium.launch({ executablePath: resolvedBrowser, headless: true })
  const browserVersion = browser.version()
  try {
    const ids = await queryConversationIds()
    const origin = `http://127.0.0.1:${port}`
    // Authenticate once per matrix. Besides being faster, this avoids making
    // screenshot count accidentally depend on the application's login rate
    // limit while each capture still gets an isolated browser context.
    const authContext = await browser.newContext()
    const authPage = await authContext.newPage()
    await login(authPage, origin)
    const storageState = await authContext.storageState()
    await authContext.close()
    const results: CaptureResult[] = []
    for (const target of targets) {
      const info = await captureTarget(browser, origin, target, ids, dir, storageState)
      results.push({ target, info })
      console.log(
        `captured ${target.name}: ${info.width}x${info.height} ${info.bytes}B (HTTP ${info.httpStatus}) -> ${info.path}`,
      )
    }
    return { browserVersion, results }
  } finally {
    await browser.close()
  }
}

interface ServerHandle {
  child: ReturnType<typeof spawn>
  kill: () => Promise<void>
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}

function startServer(env: NodeJS.ProcessEnv): ServerHandle {
  const child = spawnChild(['bun', 'src/index.ts'], env)
  let stopping = false
  const kill = async () => {
    if (stopping) return
    stopping = true
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    if (!(await waitForExit(child, 2000))) {
      child.kill('SIGKILL')
      if (!(await waitForExit(child, 2000))) {
        throw new Error(`Capture server pid ${child.pid ?? 'unknown'} did not exit after SIGKILL.`)
      }
    }
  }
  child.on('exit', (code) => {
    if (!stopping && code !== 0 && code !== null) {
      console.error(`capture: server exited unexpectedly with ${code}`)
    }
  })
  return { child, kill }
}

function buildEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  // Start from the parent process env so Bun's auto-loaded .env values (and
  // PATH) carry over, then override with capture-specific knobs.
  return {
    ...process.env,
    ...extra,
  }
}

async function main(): Promise<void> {
  const resolvedBrowser = await resolveBrowserPath(browserPath)
  if (!(await portIsFree(port))) {
    fail(
      `Port ${port} is already in use. Capture refuses to screenshot an unknown server. Set SHOTS_PORT to a free dedicated port.`,
    )
  }
  await runCmd(['bun', 'run', 'css:build'], buildEnv({}))
  console.log(`CSS built`)
  await dropCreateMigrate()

  const seedEnv = buildEnv({
    DATABASE_URL: shotsDbUrl,
    SESSION_SECRET: 'capture-session-secret-fixed-non-production-only',
    INKCAP_FIXED_NOW: fixedNow,
    NODE_ENV: 'development',
  })
  await runCmd(['bun', 'src/tasks/seed-demo.ts'], seedEnv)
  console.log(`Demo seed complete (frozen clock ${fixedNow})`)

  const serverEnv = buildEnv({
    DATABASE_URL: shotsDbUrl,
    SESSION_SECRET: 'capture-session-secret-fixed-non-production-only',
    PORT: String(port),
    NODE_ENV: 'development',
    REGISTRATION: 'open',
    INKCAP_FIXED_NOW: fixedNow,
    INKCAP_DISABLE_SCHEDULER: '1',
  })
  const server = startServer(serverEnv)
  try {
    await waitForReadiness()
    const { browserVersion, results } = await captureAll(outDir, resolvedBrowser)
    console.log(`\nBrowser: ${browserVersion} (${resolvedBrowser})`)
    console.log(`Viewport/dsf: CSS px viewport, deviceScaleFactor 1`)
    console.log(`Output dir: ${outDir}`)
    console.log(`Captures: ${results.length}`)
    const overflowChecks = await checkOverflow(results, browserVersion)
    console.log(overflowChecks)
    await writeReport(resolvedBrowser, browserVersion, results)
  } finally {
    await server.kill()
  }
  if (stabilityCheck) {
    await runStabilityCheck(resolvedBrowser)
  }
  if (publishShots) {
    await encodePublicShots()
  }
  console.log('Server stopped; no child process remains.')
}

async function encodePublicShots(): Promise<void> {
  const script = `
from pathlib import Path
from PIL import Image
import sys
src = Path(sys.argv[1])
marketing = Path('marketing-site/shots')
app = Path('src/static/shots')
mapping = {
  'chat-hero-light.png': 'chat-desktop-light.webp',
  'chat-hero-dark.png': 'chat-desktop-dark.webp',
  'mcp-approval-dark.png': 'approval-desktop-dark.webp',
  'chat-mobile-light.png': 'chat-mobile-light.webp',
  'providers-light.png': 'providers-light.webp',
  'providers-dark.png': 'providers-dark.webp',
  'loops-light.png': 'loops-light.webp',
  'loops-dark.png': 'loops-dark.webp',
  'loop-config-light.png': 'loop-config-light.webp',
}
for source, name in mapping.items():
    image = Image.open(src / source).convert('RGB')
    image.save(marketing / name, 'WEBP', quality=88, method=6)
    if name.startswith('chat-desktop'):
        image.save(app / name, 'WEBP', quality=88, method=6)
`
  await runCmd(['python3', '-c', script, outDir], buildEnv({}))
  console.log('Published optimized WebPs to marketing-site/shots and src/static/shots.')
}

async function checkOverflow(results: CaptureResult[], _browserVersion: string): Promise<string> {
  const lines: string[] = ['Objective checks:']
  let all200 = true
  for (const r of results) {
    if (r.info.httpStatus !== 200) all200 = false
  }
  lines.push(`  HTTP 200 for all ${results.length} captures: ${all200 ? 'passed' : 'failed'}`)
  let dimsOk = true
  for (const r of results) {
    if (r.info.width !== r.target.viewport.width || r.info.height !== r.target.viewport.height) {
      dimsOk = false
      lines.push(`  dimension mismatch: ${r.target.name} is ${r.info.width}x${r.info.height} (expected ${r.target.viewport.width}x${r.target.viewport.height})`)
    }
  }
  lines.push(`  All captures match declared viewport dimensions: ${dimsOk ? 'passed' : 'failed'}`)
  return lines.join('\n')
}

async function writeReport(
  resolvedBrowser: string,
  browserVersion: string,
  results: CaptureResult[],
): Promise<void> {
  const reportPath = join(outDir, 'capture-report.json')
  const report = {
    generatedAt: fixedNow,
    command: 'bun src/tasks/capture-product-shots.ts',
    browser: { package: 'playwright@1.61.1', executable: resolvedBrowser, version: browserVersion },
    port,
    shotsDatabase: shotsDbName,
    fixedNow,
    deviceScaleFactor: 1,
    login: shotsEmail,
    captures: results.map((r) => ({
      name: r.target.name,
      route: r.target.route,
      viewport: r.target.viewport,
      colorScheme: r.target.colorScheme,
      path: r.info.path,
      bytes: r.info.bytes,
      width: r.info.width,
      height: r.info.height,
      httpStatus: r.info.httpStatus,
    })),
    status: publishShots ? 'approved for publication' : 'awaiting visual review',
  }
  await Bun.write(reportPath, JSON.stringify(report, null, 2))
  console.log(`Report: ${reportPath}`)
}

async function runStabilityCheck(resolvedBrowser: string): Promise<void> {
  console.log('\nStability check: two consecutive captures compared by decoded pixels.')
  const secondDir = join(outDir, '.stability-second')
  await rm(secondDir, { recursive: true, force: true })

  // Run the second matrix in a fresh process. This reproduces the documented
  // command's full lifecycle and prevents Chromium/SSE resources retained by
  // the first browser process from influencing the comparison.
  await runCmd(
    ['bun', 'src/tasks/capture-product-shots.ts'],
    buildEnv({
      SHOTS_OUT_DIR: secondDir,
      SHOTS_PORT: String(port),
      SHOTS_DATABASE_URL: shotsDbUrl,
      SHOTS_BROWSER: resolvedBrowser,
      INKCAP_FIXED_NOW: fixedNow,
      SHOTS_EMAIL: shotsEmail,
      SHOTS_PASSWORD: shotsPassword,
    }),
  )

  let mismatches = 0
  for (const target of CAPTURE_MATRIX) {
    const firstPath = join(outDir, `${target.name}.png`)
    const secondPath = join(secondDir, `${target.name}.png`)
    const cmp = await comparePngPixels(firstPath, secondPath)
    const firstBytes = (await stat(firstPath)).size
    const secondBytes = (await stat(secondPath)).size
    const status = cmp.identical ? 'identical' : 'differ'
    if (!cmp.identical) mismatches++
    console.log(
      `  ${target.name}: ${status} (maxAbsDiff=${cmp.maxAbsDiff}, meanAbsDiff=${cmp.meanAbsDiff.toFixed(4)}, bytesA=${firstBytes}, bytesB=${secondBytes})`,
    )
  }
  const verdict = mismatches === 0 ? 'passed' : 'failed'
  console.log(`Stability verdict: ${verdict} (${mismatches}/${CAPTURE_MATRIX.length} captures differed)`)
  await rm(secondDir, { recursive: true, force: true })
  if (mismatches > 0) {
    fail(`Two consecutive captures were not pixel-identical (${mismatches} differed).`)
  }
}

interface PixelCmp {
  identical: boolean
  maxAbsDiff: number
  meanAbsDiff: number
}

async function comparePngPixels(a: string, b: string): Promise<PixelCmp> {
  // Decode and compare normalized pixel output using Python+PIL. The stability
  // command fails if the decoder is unavailable: encoded-byte equality is not
  // an acceptable substitute for the plan's decoded-pixel requirement.
  const script = [
    'import sys',
    'try:',
    '    from PIL import Image',
    'except Exception as e:',
    '    print("NO_PIL:" + str(e)); sys.exit(2)',
    'a = Image.open(sys.argv[1]).convert("RGB")',
    'b = Image.open(sys.argv[2]).convert("RGB")',
    'if a.size != b.size:',
    '    print("SIZE_DIFF"); sys.exit(1)',
    'pa = list(a.getdata()); pb = list(b.getdata())',
    'mx = 0; s = 0; n = len(pa)',
    'for i in range(n):',
    '    dr = abs(pa[i][0]-pb[i][0]); dg = abs(pa[i][1]-pb[i][1]); db = abs(pa[i][2]-pb[i][2])',
    '    d = max(dr, dg, db); s += (dr+dg+db)/3',
    '    if d > mx: mx = d',
    'print("MAX:" + str(mx)); print("MEAN:" + str(s/n)); sys.exit(0 if mx == 0 else 1)',
  ].join('\n')
  return new Promise((resolve) => {
    const child = spawn('python3', ['-c', script, a, b], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.on('exit', (code) => {
      if (out.startsWith('NO_PIL:')) {
        console.error(`capture: decoded-pixel comparison requires Python Pillow (${out.trim()})`)
        resolve({ identical: false, maxAbsDiff: -1, meanAbsDiff: -1 })
        return
      }
      const max = /MAX:(\d+)/.exec(out)?.[1] ? Number(/MAX:(\d+)/.exec(out)![1]) : -1
      const mean = /MEAN:([\d.]+)/.exec(out)?.[1] ? Number(/MEAN:([\d.]+)/.exec(out)![1]) : -1
      resolve({ identical: code === 0 && max === 0, maxAbsDiff: max, meanAbsDiff: mean })
    })
    child.on('error', () => resolve({ identical: false, maxAbsDiff: -1, meanAbsDiff: -1 }))
  })
}

await main()
