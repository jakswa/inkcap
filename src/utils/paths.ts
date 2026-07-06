import { basename, join, resolve } from 'node:path'

// In dev, runtime files live under src/. In prod, the build copies them under build/.
const runtimeRoot =
  process.env['NODE_ENV'] === 'production'
    ? productionRoot()
    : resolve(import.meta.dir, '..')

export const paths = {
  appAssets: join(runtimeRoot, 'static'),
  dbMigrations: join(runtimeRoot, 'db/migrations'),
  views: join(runtimeRoot, 'views'),
}

function productionRoot() {
  // Bundled task entrypoints run from build/tasks/*.js; the server runs from build/index.js.
  return basename(import.meta.dir) === 'tasks'
    ? resolve(import.meta.dir, '..')
    : import.meta.dir
}
