import { SQL } from 'bun'
import { env } from '../utils/env'
import type { Queries } from './queries/queries.gen'
import { withTypedQueries } from './typed-sql'
import { useUtcProcessTimezone, utcDatabaseUrl } from './utc'

useUtcProcessTimezone()

export const sql = withTypedQueries<Queries>(new SQL(utcDatabaseUrl(env.DATABASE_URL)))
