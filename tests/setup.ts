import { SQL } from 'bun'
import { afterAll } from 'bun:test'
import { migrate } from '../src/db/migrate'

process.env.DATABASE_URL ||= 'postgresql://postgres:postgres@localhost:5432/honossr_test'
process.env.SESSION_SECRET ||= 'test-session-secret'
process.env.ASSET_VERSION ||= 'test'
process.env.NODE_ENV ||= 'test'

const databaseUrl = new URL(process.env.DATABASE_URL)
const databaseName = databaseUrl.pathname.slice(1)

if (!databaseName.endsWith('test')) {
  throw new Error(
    `Refusing to reset test database because DATABASE_URL database "${databaseName}" does not end with "test".`,
  )
}

const maintenanceUrl = new URL(databaseUrl)
maintenanceUrl.pathname = '/postgres'

try {
  const maintenanceSql = new SQL(maintenanceUrl.toString())

  await maintenanceSql`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = ${databaseName}
      AND pid <> pg_backend_pid()
  `
  await maintenanceSql`DROP DATABASE IF EXISTS ${maintenanceSql(databaseName)}`
  await maintenanceSql`CREATE DATABASE ${maintenanceSql(databaseName)}`
  await maintenanceSql.close()

  await migrate(databaseUrl.toString(), { quiet: true })
} catch (error) {
  throw new Error(
    `Postgres is required for bun test. Set DATABASE_URL to a local test database ending in "test".\n${String(error)}`,
  )
}

afterAll(async () => {
  const { sql } = await import('../src/db/client')
  await sql.close()
})
