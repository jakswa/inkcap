export {}

const commands = [
  ['bun', 'run', 'css:watch'],
  ['bun', '--watch', 'src/index.ts'],
]

const processes = commands.map((command) =>
  Bun.spawn(command, { stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' }),
)

let stopping = false

function stopAll() {
  if (stopping) return
  stopping = true
  for (const child of processes) child.kill()
}

process.on('SIGINT', () => {
  stopAll()
  process.exit(130)
})

process.on('SIGTERM', () => {
  stopAll()
  process.exit(143)
})

const exitCode = await Promise.race(processes.map((child) => child.exited))
stopAll()
process.exit(exitCode)
