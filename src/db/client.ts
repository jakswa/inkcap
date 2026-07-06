import { SQL } from 'bun'
import { env } from '../utils/env'
import type { Queries } from './queries/queries.gen'
import { withTypedQueries } from './typed-sql'

export const sql = withTypedQueries<Queries>(new SQL(env.DATABASE_URL))
