export async function hashPassword(password: string) {
  return Bun.password.hash(password)
}

export async function verifyPassword(password: string, hash: string) {
  return Bun.password.verify(password, hash)
}
