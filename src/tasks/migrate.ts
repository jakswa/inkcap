import { migrate } from '../db/migrate'
import { env } from '../utils/env'

await migrate(env.DATABASE_URL)
console.log('Migrations complete')
