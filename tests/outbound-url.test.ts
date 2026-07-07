import { describe, expect, test } from 'bun:test'
import { $ } from 'bun'

describe('outbound URL guard', () => {
  test('blocks private HTTP origins in production unless explicitly trusted', async () => {
    const script = String.raw`
      process.env.NODE_ENV = 'production'
      process.env.SESSION_SECRET = 'test-session-secret-that-is-long-enough-for-production'
      process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/unused_test'
      process.env.ASSET_VERSION = 'test'
      const { assertSafeOutboundUrl } = await import('./src/utils/outbound-url.ts')
      let blocked = false
      try {
        await assertSafeOutboundUrl('http://192.168.1.169:8001/v1/models')
      } catch (error) {
        blocked = error instanceof Error && error.message.includes('Outbound URLs must use https in production')
      }
      if (!blocked) throw new Error('expected untrusted private HTTP URL to be blocked')
      process.env.OUTBOUND_TRUSTED_HOSTS = '192.168.1.169'
      await assertSafeOutboundUrl('http://192.168.1.169:8001/v1/models')
    `

    const result = await $`bun -e ${script}`.quiet().nothrow()
    expect(result.exitCode).toBe(0)
    expect(result.stderr.toString()).toBe('')
  })
})
