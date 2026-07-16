// Seed a demo account with realistic-looking history: providers, MCP servers,
// and a handful of conversations (markdown replies, reasoning accordions,
// timings chips, a completed MCP tool loop, a run parked in waiting_approval,
// and a regenerated sibling branch). Used for product screenshots and for
// kicking the tires on a fresh install without wiring up a real provider.
//
//   bun src/tasks/seed-demo.ts [--email demo@inkcap.dev] [--password inkcap-demo]
//
// Idempotent-ish: re-running wipes and re-creates the demo user's
// conversations; the user, providers, and MCP servers are reused by name.
// Nothing here talks to a real provider — the seeded providers point at
// localhost/LAN addresses, so "send" on a demo conversation will just error.

import { sql } from '../db/client'
import {
  createConversation,
  deleteConversation,
  listConversationsForUser,
  setConversationCurrNode,
  setConversationSeedState,
} from '../db/queries/conversations'
import { createImportedMessage, setMessageParentId } from '../db/queries/messages'
import { createMcpServer, listMcpServersForUser, setConversationMcpOverride } from '../db/queries/mcp-servers'
import { createLoop, replaceLoopMcpServers } from '../db/queries/loops'
import {
  createProvider,
  getProviderByNameForAccount,
  type ProviderModelMetadata,
} from '../db/queries/providers'
import { createRun } from '../db/queries/runs'
import { createToolApproval } from '../db/queries/tool-approvals'
import { createUser, getUserByEmailNormalized, patchUserSettings } from '../db/queries/users'
import { hashPassword } from '../utils/password'
import { normalizeEmail } from '../utils/validation'
import { randomUUIDv7 } from 'bun'

function readArg(flag: string): string | null {
  const index = Bun.argv.indexOf(flag)
  const value = index >= 0 ? Bun.argv[index + 1] : undefined
  return value ?? null
}

const minutes = (n: number) => n * 60_000

// Deterministic capture passes INKCAP_FIXED_NOW (ISO-8601) so seeded instants
// are reproducible instead of wall-clock-relative. Unset → real now, the
// historical behavior.
const fixedNowMs = (() => {
  const raw = process.env['INKCAP_FIXED_NOW']
  if (!raw) return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : null
})()
function nowMs(): number {
  return fixedNowMs ?? Date.now()
}

interface SeedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  reasoning?: string
  model?: string
  toolCalls?: unknown
  toolCallId?: string
  timings?: { prompt_n: number; prompt_ms: number; predicted_n: number; predicted_ms: number }
  // When set, this message is inserted as an *extra sibling* of the previous
  // chain message (a regenerate branch) and does NOT advance the chain.
  siblingOfPrevious?: boolean
}

interface SeedConversation {
  title: string
  model: string
  pinned?: boolean
  reasoningEffort?: string
  updatedMinutesAgo: number
  mcp?: boolean
  messages: SeedMessage[]
  // Park the conversation in waiting_approval on this tool call (must match
  // the leaf assistant message's tool call).
  pendingApproval?: { toolCallId: string; toolName: string; arguments: string }
}

try {
  const email = readArg('--email') ?? 'demo@inkcap.dev'
  const password = readArg('--password') ?? 'inkcap-demo'
  const emailNormalized = normalizeEmail(email)
  if (!emailNormalized) throw new Error(`Not a usable email: ${email}`)

  const existingUser = await getUserByEmailNormalized(emailNormalized)
  let userId: string
  if (existingUser) {
    userId = existingUser.id
    console.log(`Reusing existing user ${email}`)
  } else {
    const created = await createUser({
      name: 'Ada',
      email,
      emailNormalized,
      passwordHash: await hashPassword(password),
    })
    userId = created.id
    console.log(`Created demo user ${email} (password: ${password})`)
  }
  const accountId = userId // personal account id === user id (migration 012)
  await patchUserSettings({ userId, patch: { timeZone: 'America/New_York' } })

  // Fresh slate for conversations only; providers/MCP servers are reused.
  for (const row of await listConversationsForUser(userId)) {
    await deleteConversation({ id: row.id, userId })
  }

  const existingLlama = await getProviderByNameForAccount({ name: 'workstation llama-server', accountId })
  let llamaId: string
  if (existingLlama) {
    llamaId = existingLlama.id
  } else {
    const modelMetadata: ProviderModelMetadata = {
      'qwen3-32b': { capabilities: ['completion', 'tools'], reasoning: true, contextSize: 32768, source: 'seed' },
      'gemma-3-27b-it': { capabilities: ['completion'], reasoning: false, contextSize: 131072, source: 'seed' },
      'llama-3.3-70b-instruct': { capabilities: ['completion', 'tools'], reasoning: false, contextSize: 131072, source: 'seed' },
    }
    const created = await createProvider({
      accountId,
      name: 'workstation llama-server',
      kind: 'llama-server',
      baseUrl: 'http://192.168.1.42:8080',
      defaultModel: 'qwen3-32b',
      models: ['qwen3-32b', 'gemma-3-27b-it', 'llama-3.3-70b-instruct'],
      modelMetadata,
    })
    llamaId = created.id
  }

  if (!(await getProviderByNameForAccount({ name: 'OpenRouter', accountId }))) {
    await createProvider({
      accountId,
      name: 'OpenRouter',
      kind: 'openai-compat',
      baseUrl: 'https://openrouter.ai/api',
      apiKey: 'sk-or-demo-not-a-real-key',
      defaultModel: 'anthropic/claude-sonnet-4.5',
      models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5-mini'],
    })
  }

  const existingMcp = await listMcpServersForUser(userId)
  const mcpIds: string[] = []
  for (const server of [
    { name: 'postgres (analytics)', url: 'http://127.0.0.1:8931/mcp', autoApprove: false },
    { name: 'web-search', url: 'http://127.0.0.1:8932/mcp', autoApprove: true },
  ]) {
    const found = existingMcp.find((row) => row.name === server.name)
    if (found) {
      mcpIds.push(found.id)
    } else {
      const created = await createMcpServer({ accountId, ...server })
      mcpIds.push(created.id)
    }
  }

  // Keep the automation screens useful for product screenshots too. Loops are
  // safe to replace because this task owns the entire demo account fixture.
  await sql`DELETE FROM loops WHERE account_id = ${accountId}`
  const seededLoops = [
    {
      name: 'Morning model watch',
      prompt: 'Review the latest local-model and inference-server releases. Summarize only changes that could improve our current setup, then submit a short briefing artifact.',
      model: 'qwen3-32b',
      schedule: '0 8 * * 1-5',
      enabled: true,
      nextFireAt: new Date(nowMs() + minutes(11 * 60)),
      tools: [{ mcpServerId: mcpIds[1]!, autoApprove: true }],
    },
    {
      name: 'Analytics index check',
      prompt: 'Inspect analytics database index health. Explain meaningful regressions and prepare SQL recommendations, but require approval before making any changes.',
      model: 'llama-3.3-70b-instruct',
      schedule: '30 6 * * 1',
      enabled: true,
      nextFireAt: new Date(nowMs() + minutes(2 * 24 * 60)),
      tools: [{ mcpServerId: mcpIds[0]!, autoApprove: false }],
    },
    {
      name: 'Release notes draft',
      prompt: 'Turn the merged changes since the last tag into concise release notes for technical users. Group fixes, features, and operational changes.',
      model: 'qwen3-32b',
      schedule: null,
      enabled: false,
      nextFireAt: null,
      tools: [],
    },
  ]
  for (const seed of seededLoops) {
    const loop = await createLoop({
      accountId,
      userId,
      name: seed.name,
      prompt: seed.prompt,
      providerId: llamaId,
      model: seed.model,
      reasoningEffort: 'medium',
      schedule: seed.schedule,
      enabled: seed.enabled,
      nextFireAt: seed.nextFireAt,
    })
    await replaceLoopMcpServers({ loopId: loop.id, servers: seed.tools })
  }

  const conversations: SeedConversation[] = [
    {
      title: 'Flaky Playwright checkout spec',
      model: 'qwen3-32b',
      pinned: true,
      reasoningEffort: 'medium',
      updatedMinutesAgo: 24,
      mcp: true,
      messages: [
        {
          role: 'user',
          content:
            'Our checkout spec fails about 1 in 10 CI runs with `TimeoutError: locator.click: Timeout 30000ms exceeded` on the **Pay now** button. It never fails locally. Where do I even start?',
        },
        {
          role: 'assistant',
          model: 'qwen3-32b',
          reasoning:
            'Intermittent CI-only click timeouts are almost never the click itself — the locator resolves but the element is detached, disabled, or covered when the click fires. CI differs from local in speed and in profile state (cold cache, no cookies), so I should point at actionability logs first rather than guessing.',
          timings: { prompt_n: 486, prompt_ms: 2140, predicted_n: 274, predicted_ms: 8730 },
          content: `1-in-10 and CI-only almost always means a race, not a broken selector. Three things to check, in order:

1. **Read the actionability log, not just the error.** The timeout message includes what the click was waiting for — look for \`element is not enabled\` or \`subtree intercepts pointer events\` in the CI trace.
2. **Record a trace on retry** so you can scrub through the failure:

   \`\`\`ts
   // playwright.config.ts
   export default defineConfig({
     retries: process.env.CI ? 2 : 0,
     use: { trace: 'on-first-retry' },
   })
   \`\`\`

3. **Assert the button is actually ready before clicking.** If the pay button is disabled until a payment intent request settles, make that explicit:

   \`\`\`ts
   const pay = page.getByRole('button', { name: 'Pay now' })
   await expect(pay).toBeEnabled()
   await pay.click()
   \`\`\`

If the trace shows the click landing somewhere else — an overlay, a toast, a consent banner — that's your culprit, and it'll be something that only renders on a fresh CI profile.`,
        },
        {
          role: 'user',
          content:
            "Traced it. A cookie-consent banner renders only on fresh profiles (CI is always fresh) and it covers the button for a second while it animates in.",
        },
        {
          role: 'assistant',
          model: 'qwen3-32b',
          timings: { prompt_n: 812, prompt_ms: 3320, predicted_n: 158, predicted_ms: 5140 },
          siblingOfPrevious: false,
          content: `Classic. Don't dismiss it in each test — kill it at the source with pre-seeded storage state:

\`\`\`ts
// global.setup.ts — runs once, before the whole suite
await context.addCookies([
  { name: 'consent', value: 'dismissed', domain: 'shop.local', path: '/' },
])
await context.storageState({ path: 'e2e/.auth/state.json' })
\`\`\`

Point \`use.storageState\` at that file and the banner never mounts, in any spec. Keep **one** dedicated test that runs without the seeded state and exercises the banner itself, so the dismiss flow stays covered.`,
        },
        {
          role: 'assistant',
          model: 'qwen3-32b',
          timings: { prompt_n: 812, prompt_ms: 3290, predicted_n: 121, predicted_ms: 4030 },
          siblingOfPrevious: true,
          content: `That explains the animation-length flake window. Two fixes, pick by taste:

- **Suppress it for tests**: seed a \`consent\` cookie in your setup project so the banner never renders.
- **Make the click banner-proof**: \`await page.getByTestId('consent-accept').click()\` first, guarded by \`.or()\` so it no-ops when absent.

The cookie is less code and faster suites; the explicit dismiss keeps the banner path tested.`,
        },
      ],
    },
    {
      title: 'Index bloat on analytics DB',
      model: 'llama-3.3-70b-instruct',
      updatedMinutesAgo: 190,
      mcp: true,
      messages: [
        {
          role: 'user',
          content:
            'Which indexes on the analytics database are bloated? Use the postgres tool — read-only for now.',
        },
        {
          role: 'assistant',
          model: 'llama-3.3-70b-instruct',
          content: "I'll check estimated bloat from `pg_stat_user_indexes` joined against page-level estimates.",
          toolCalls: [
            {
              id: 'call_pg_01',
              type: 'function',
              function: {
                name: 'query',
                arguments:
                  '{"sql":"SELECT indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) AS size, round(100 * (1 - avg_leaf_density / 90), 1) AS est_bloat_pct FROM pgstatindex_all() ORDER BY est_bloat_pct DESC LIMIT 5"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          toolCallId: 'call_pg_01',
          content: `indexrelname              | size    | est_bloat_pct
--------------------------+---------+---------------
idx_events_user_id        | 4213 MB | 61.4
idx_events_created_at     | 2887 MB | 44.2
idx_sessions_token        | 912 MB  | 38.9
idx_pageviews_url_hash    | 1544 MB | 12.1
idx_users_email_lower     | 88 MB   | 4.3`,
        },
        {
          role: 'assistant',
          model: 'llama-3.3-70b-instruct',
          timings: { prompt_n: 1093, prompt_ms: 4470, predicted_n: 202, predicted_ms: 6810 },
          content: `Two indexes are worth acting on:

| index | size | est. bloat |
| --- | --- | --- |
| \`idx_events_user_id\` | 4.2 GB | **61%** |
| \`idx_events_created_at\` | 2.9 GB | **44%** |

Everything else is under 40% and fine to leave. The \`events\` table's churn (deletes from the retention job) is the likely cause — the fix is \`REINDEX INDEX CONCURRENTLY\`, which rebuilds without blocking writes. Reclaiming \`idx_events_user_id\` alone should free roughly 2.5 GB.`,
        },
        {
          role: 'user',
          content: 'Go ahead and reindex `idx_events_user_id` now, concurrently.',
        },
        {
          role: 'assistant',
          model: 'llama-3.3-70b-instruct',
          content: '',
          toolCalls: [
            {
              id: 'call_pg_02',
              type: 'function',
              function: {
                name: 'execute',
                arguments: '{"sql":"REINDEX INDEX CONCURRENTLY idx_events_user_id;"}',
              },
            },
          ],
        },
      ],
      pendingApproval: {
        toolCallId: 'call_pg_02',
        toolName: 'execute',
        arguments: '{"sql":"REINDEX INDEX CONCURRENTLY idx_events_user_id;"}',
      },
    },
    {
      title: 'Kyoto in late October',
      model: 'gemma-3-27b-it',
      updatedMinutesAgo: 60 * 26,
      messages: [
        {
          role: 'user',
          content:
            'Four days in Kyoto in late October, first visit. We like temples but burn out fast — one big sight a day, then food and walking.',
        },
        {
          role: 'assistant',
          model: 'gemma-3-27b-it',
          timings: { prompt_n: 388, prompt_ms: 1620, predicted_n: 341, predicted_ms: 11260 },
          content: `Late October is a sweet spot — momiji season is starting in the hills but the peak crowds haven't landed. One anchor a day:

**Day 1 — east side.** Kiyomizu-dera right at 6am opening (seriously — you'll have the veranda nearly alone), then drift downhill through Sannenzaka to Ishibei-koji lane. Afternoon: nothing. Nishiki Market for dinner supplies.

**Day 2 — Arashiyama.** Skip the bamboo-grove crush and book the first Hozugawa river boat instead; do the grove at dusk on the way out. Okonomiyaki at a counter spot rather than a kaiseki splurge tonight.

**Day 3 — north hills.** Kinkaku-ji early, then bus to Kōtō-in in the Daitoku-ji complex — the maple courtyard there is the underrated one. Kamo river walk in the evening.

**Day 4 — no temple.** Fushimi Inari *at night* (open 24h, lantern-lit, mostly empty above the second gate cluster), after a lazy day around Demachiyanagi and a coffee crawl.

Want restaurant picks pinned to those neighborhoods?`,
        },
      ],
    },
    {
      title: 'Sourdough hydration math',
      model: 'qwen3-32b',
      updatedMinutesAgo: 60 * 49,
      messages: [
        {
          role: 'user',
          content:
            'My starter is 100% hydration. Recipe: 500g flour, 325g water, 100g starter, 10g salt. What hydration is that really, and how do I hit 78%?',
        },
        {
          role: 'assistant',
          model: 'qwen3-32b',
          timings: { prompt_n: 291, prompt_ms: 1180, predicted_n: 187, predicted_ms: 6240 },
          content: `Count the starter's halves in the totals:

| | flour | water |
| --- | --- | --- |
| recipe | 500 g | 325 g |
| starter (100% hydr.) | 50 g | 50 g |
| **total** | **550 g** | **375 g** |

375 / 550 = **68.2%** — a fair bit stiffer than you probably thought.

For 78% you need 0.78 × 550 = 429 g total water, so add **54 g** to the mix water (325 → 379 g). Go in two steps: hold back ~25 g, then work it in during the second set of stretch-and-folds once the gluten can take it.`,
        },
      ],
    },
    {
      title: 'Regex for semver ranges',
      model: 'anthropic/claude-sonnet-4.5',
      updatedMinutesAgo: 60 * 74,
      messages: [
        {
          role: 'user',
          content: 'One regex to validate `^1.2.3`, `~1.2.3`, `1.2.x`, and plain `1.2.3` — no prerelease tags needed.',
        },
        {
          role: 'assistant',
          model: 'anthropic/claude-sonnet-4.5',
          timings: { prompt_n: 214, prompt_ms: 890, predicted_n: 142, predicted_ms: 3980 },
          content: `\`\`\`js
const range = /^[\\^~]?(?:0|[1-9]\\d*)\\.(?:(?:0|[1-9]\\d*)|x)\\.(?:(?:0|[1-9]\\d*)|x)$/
\`\`\`

Reading it left to right: optional \`^\` or \`~\` prefix, then three dot-separated parts where major must be a real number and minor/patch may each be a literal \`x\`. It rejects leading zeros (\`01.2.3\`) on purpose, per the semver spec.

Caveat: this accepts \`1.x.3\`, which npm's range grammar technically doesn't. If that matters, force patch to \`x\` whenever minor is:

\`\`\`js
const strict = /^[\\^~]?(?:0|[1-9]\\d*)\\.(?:x\\.x|(?:0|[1-9]\\d*)\\.(?:x|0|[1-9]\\d*))$/
\`\`\``,
        },
      ],
    },
    {
      title: 'Docker healthcheck for a Bun server',
      model: 'llama-3.3-70b-instruct',
      updatedMinutesAgo: 60 * 96,
      messages: [
        {
          role: 'user',
          content: 'Smallest sane HEALTHCHECK for a Bun HTTP server image with no curl or wget installed?',
        },
        {
          role: 'assistant',
          model: 'llama-3.3-70b-instruct',
          timings: { prompt_n: 176, prompt_ms: 740, predicted_n: 98, predicted_ms: 3210 },
          content: `Use the runtime you already ship:

\`\`\`dockerfile
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \\
  CMD bun -e "await fetch('http://127.0.0.1:3000/healthz').then(r => { if (!r.ok) throw 1 })"
\`\`\`

No extra binaries, and \`bun -e\` exits non-zero on a thrown value, which is all Docker looks at. Keep \`/healthz\` dependency-free (no DB round-trip) so a slow query can't flap the container.`,
        },
      ],
    },
  ]

  const now = nowMs()
  for (const seed of conversations) {
    const conversation = await createConversation({
      userId,
      title: seed.title,
      providerId: llamaId,
      model: seed.model,
      reasoningEffort: seed.reasoningEffort ?? null,
    })

    const updatedAt = new Date(now - minutes(seed.updatedMinutesAgo))
    // Space messages a couple of minutes apart, ending at updatedAt.
    const startAt = updatedAt.getTime() - minutes(3 * seed.messages.length)

    let prevChainId: string | null = null // parent of the *next* chain message
    let lastChainId: string | null = null // current chain leaf
    let index = 0
    for (const message of seed.messages) {
      const row = await createImportedMessage({
        id: randomUUIDv7(),
        conversationId: conversation.id,
        role: message.role,
        content: message.content,
        reasoningContent: message.reasoning ?? null,
        model: message.model ?? null,
        toolCalls: message.toolCalls ?? null,
        toolCallId: message.toolCallId ?? null,
        timings: message.timings ?? null,
        createdAt: new Date(startAt + minutes(3 * index)),
      })
      index += 1

      if (message.siblingOfPrevious) {
        // Regenerate branch: same parent as the current leaf; becomes the
        // active leaf (newest sibling wins, like a real regenerate).
        if (prevChainId) await setMessageParentId({ id: row.id, parentId: prevChainId })
        lastChainId = row.id
      } else {
        if (lastChainId) await setMessageParentId({ id: row.id, parentId: lastChainId })
        prevChainId = lastChainId
        lastChainId = row.id
      }
    }

    if (lastChainId) {
      await setConversationCurrNode({ id: conversation.id, currNode: lastChainId })
    }

    if (seed.mcp) {
      for (const mcpServerId of mcpIds) {
        await setConversationMcpOverride({
          conversationId: conversation.id,
          mcpServerId,
          enabled: true,
        })
      }
    }

    if (seed.pendingApproval && lastChainId) {
      const run = await createRun({
        conversationId: conversation.id,
        status: 'waiting_approval',
        leafMessageId: lastChainId,
        turnCount: 2,
      })
      await createToolApproval({
        runId: run.id,
        messageId: lastChainId,
        toolCallId: seed.pendingApproval.toolCallId,
        toolName: seed.pendingApproval.toolName,
        arguments: seed.pendingApproval.arguments,
      })
    }

    await setConversationSeedState({
      id: conversation.id,
      createdAt: new Date(startAt),
      updatedAt,
      pinned: seed.pinned ?? false,
    })
    console.log(`Seeded "${seed.title}" (${conversation.id})`)
  }

  console.log(`\nDone. Log in as ${email} / ${password}`)
} finally {
  await sql.close()
}
