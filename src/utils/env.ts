const nodeEnv = process.env['NODE_ENV'] ?? 'development'

export const env = {
  DATABASE_URL: mustGet('DATABASE_URL'),
  SESSION_SECRET: readSessionSecret(),
  PORT: readPort(),
  NODE_ENV: nodeEnv,
  ASSET_VERSION: readAssetVersion(),
}

const placeholderSessionSecrets = new Set([
  'change-me-in-production',
  'changeme',
  'secret',
  'password',
])

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

function readSessionSecret() {
  const value = mustGet('SESSION_SECRET')

  if (nodeEnv === 'production') {
    if (placeholderSessionSecrets.has(value.toLowerCase())) {
      throw new Error('SESSION_SECRET must not use a placeholder value in production')
    }
    if (new TextEncoder().encode(value).byteLength < 32) {
      throw new Error('SESSION_SECRET must be at least 32 bytes in production')
    }
  }

  return value
}

function readAssetVersion() {
  if (nodeEnv !== 'production') return String(Date.now())

  const value = mustGet('ASSET_VERSION')
  if (value === 'dev') {
    throw new Error('ASSET_VERSION must not be "dev" in production')
  }
  return value
}
