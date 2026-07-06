import { app } from './app'
import { env } from './utils/env'
import {
  cleanupExpiredRunEvents,
  recoverInterruptedRuns,
} from './services/runner'

// Boot recovery before serving: park any runs a previous process left
// `running` (finalizing their streaming messages as interrupted, keeping every
// persisted token), and drop replay events for long-terminal runs.
const recovered = await recoverInterruptedRuns()
if (recovered > 0) console.log(`recovered ${recovered} interrupted run(s)`)
await cleanupExpiredRunEvents()

export default {
  port: env.PORT,
  // SSE subscribers idle between tokens; never time the connection out.
  idleTimeout: 0,
  fetch: app.fetch,
}
