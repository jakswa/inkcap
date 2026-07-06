import { SQL } from 'bun'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { paths } from '../utils/paths'

export async function migrate(databaseUrl: string, options: { quiet?: boolean } = {}) {
  const sql = new SQL(databaseUrl)

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `

    const files = (await readdir(paths.dbMigrations))
      .filter((file) => file.endsWith('.sql'))
      .sort()

    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(92384756)`

      for (const file of files) {
        const [alreadyApplied] = await tx`
          SELECT 1 FROM schema_migrations WHERE filename = ${file}
        `

        if (alreadyApplied) continue

        if (!options.quiet) console.log(`Applying migration: ${file}`)
        await tx.file(join(paths.dbMigrations, file))
        await tx`INSERT INTO schema_migrations (filename) VALUES (${file})`
      }
    })
  } finally {
    await sql.close()
  }
}
