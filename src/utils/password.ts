export async function hashPassword(password: string) {
  if (process.env['NODE_ENV'] === 'test') {
    // Production uses Bun's default password hasher/cost. Tests still exercise
    // real hash+verify, but at a deliberately low cost so auth integration
    // tests are not dominated by CPU-bound password work.
    return Bun.password.hash(password, { algorithm: 'bcrypt', cost: 4 })
  }
  return Bun.password.hash(password)
}

export async function verifyPassword(password: string, hash: string) {
  return Bun.password.verify(password, hash)
}
