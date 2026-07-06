// Bootstrap a user (plus their personal account) from the command line, for
// deployments running with REGISTRATION=closed. The password may come from
// --password or, preferably, the CREATE_USER_PASSWORD env var so it stays out
// of shell history.
//
//   CREATE_USER_PASSWORD=... bun build/tasks/create-user.js --name "Jake" --email jake@example.com

import { sql } from '../db/client'
import { createUser, getUserByEmailNormalized } from '../db/queries/users'
import { hashPassword } from '../utils/password'
import { normalizeEmail } from '../utils/validation'

function readArg(flag: string): string | null {
  const index = Bun.argv.indexOf(flag)
  const value = index >= 0 ? Bun.argv[index + 1] : undefined
  return value ?? null
}

try {
  const name = readArg('--name')?.trim() ?? ''
  const email = readArg('--email')?.trim() ?? ''
  const password = readArg('--password') ?? process.env['CREATE_USER_PASSWORD'] ?? ''
  const emailNormalized = normalizeEmail(email)

  if (!name || !emailNormalized || !password) {
    throw new Error(
      'Usage: create-user --name <name> --email <email> [--password <password>] (or set CREATE_USER_PASSWORD)',
    )
  }
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters')
  }

  const existing = await getUserByEmailNormalized(emailNormalized)
  if (existing) {
    throw new Error(`Email is already registered: ${email}`)
  }

  const passwordHash = await hashPassword(password)
  const user = await createUser({ name, email, emailNormalized, passwordHash })
  console.log(`Created user ${user.email} (${user.id})`)
} finally {
  await sql.close()
}
