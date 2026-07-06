import { cp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const buildDir = join(root, 'build')
const taskGlob = new Bun.Glob('src/tasks/*.ts')

const taskEntrypoints = Array.from(taskGlob.scanSync({ cwd: root }), (file) =>
  join(root, file),
)

await rm(buildDir, { recursive: true, force: true })
await mkdir(buildDir, { recursive: true })

const result = await Bun.build({
  entrypoints: [join(root, 'src/index.ts'), ...taskEntrypoints],
  outdir: buildDir,
  target: 'bun',
})

if (!result.success) {
  for (const log of result.logs) {
    console.error(log)
  }

  process.exit(1)
}

await cp(join(root, 'src/views'), join(buildDir, 'views'), { recursive: true })
await cp(join(root, 'src/static'), join(buildDir, 'static'), { recursive: true })
await cp(join(root, 'src/db/migrations'), join(buildDir, 'db/migrations'), {
  recursive: true,
})

console.log('Built app into build/')
