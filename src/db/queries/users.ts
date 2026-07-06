import { sql } from '../client'
import { randomUUIDv7 } from 'bun'

export async function getUserById(id: string) {
  const [user] = await sql.GetUserById`
    SELECT id, name, email, created_at
    FROM users
    WHERE id = ${id}
  `

  return user
}

export async function getUserByEmailNormalized(emailNormalized: string) {
  const [user] = await sql.GetUserByEmailNormalized`
    SELECT id, name, email, email_normalized, password_hash, created_at
    FROM users
    WHERE email_normalized = ${emailNormalized}
  `

  return user
}

// Creating a user also creates their personal account and owner membership in
// one atomic statement. The personal account id equals the user id (invariant
// from migration 012); resource reads still go through account_memberships so
// shared accounts can be added later without touching the scoped queries.
export async function createUser(input: {
  name: string
  email: string
  emailNormalized: string
  passwordHash: string
}) {
  const userId = randomUUIDv7()
  const [user] = await sql.CreateUser`
    WITH new_account AS (
      INSERT INTO accounts (id, name) VALUES (${userId}, ${input.name})
    ), new_membership AS (
      INSERT INTO account_memberships (account_id, user_id, role)
      VALUES (${userId}, ${userId}, 'owner')
    )
    INSERT INTO users (id, name, email, email_normalized, password_hash)
    VALUES (${userId}, ${input.name}, ${input.email}, ${input.emailNormalized}, ${input.passwordHash})
    RETURNING id, name, email, created_at
  `

  return user
}
