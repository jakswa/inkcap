const nodeEnv = process.env['NODE_ENV'] ?? 'development'

export const env = {
  DATABASE_URL: mustGet('DATABASE_URL'),
  SESSION_SECRET: mustGet('SESSION_SECRET'),
  PORT: readPort(),
  NODE_ENV: nodeEnv,
  ASSET_VERSION:
    nodeEnv === 'production' ? mustGet('ASSET_VERSION') : String(Date.now()),
}

function mustGet(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function readPort() {
  const raw = process.env['PORT'] ?? '3000'
  const port = Number(raw)

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: ${raw}`)
  }

  return port
}
