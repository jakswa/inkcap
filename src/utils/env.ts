const nodeEnv = process.env['NODE_ENV'] ?? 'development'

// Declared before `env`: its initializer calls readSessionSecret(), which
// reads this set in production — a later `const` would still be in its
// temporal dead zone and crash the boot.
const placeholderSessionSecrets = new Set([
  'change-me-in-production',
  'changeme',
  'secret',
  'password',
])

export const env = {
  DATABASE_URL: mustGet('DATABASE_URL'),
  SESSION_SECRET: readSessionSecret(),
  PORT: readPort(),
  NODE_ENV: nodeEnv,
  ASSET_VERSION: readAssetVersion(),
  REGISTRATION: readRegistration(),
}

// Comma-separated list env var. Read lazily (not snapshotted into `env`):
// the split-origin knobs are optional and tests vary them at runtime.
export function readEnvList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
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

// Self-serve registration: "open" or "closed". Defaults to closed in
// production — a public deployment should not accept strangers. Bootstrap a
// closed deployment with `bun build/tasks/create-user.js` (or set
// REGISTRATION=open for the first boot, register, and flip it back).
function readRegistration(): 'open' | 'closed' {
  const raw = process.env['REGISTRATION'] ?? (nodeEnv === 'production' ? 'closed' : 'open')
  if (raw !== 'open' && raw !== 'closed') {
    throw new Error(`Invalid REGISTRATION value: ${raw} (use "open" or "closed")`)
  }
  return raw
}

function readAssetVersion() {
  if (nodeEnv !== 'production') return String(Date.now())

  const value = mustGet('ASSET_VERSION')
  if (value === 'dev') {
    throw new Error('ASSET_VERSION must not be "dev" in production')
  }
  return value
}
