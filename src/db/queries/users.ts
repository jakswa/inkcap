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

export async function createUser(input: {
  name: string
  email: string
  emailNormalized: string
  passwordHash: string
}) {
  const [user] = await sql.CreateUser`
    INSERT INTO users (id, name, email, email_normalized, password_hash)
    VALUES (${randomUUIDv7()}, ${input.name}, ${input.email}, ${input.emailNormalized}, ${input.passwordHash})
    RETURNING id, name, email, created_at
  `

  return user
}
