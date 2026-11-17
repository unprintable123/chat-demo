import { spawn } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const children = new Set()
let stopping = false

const start = (command, args, env = {}) => {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  })
  children.add(child)
  child.once('exit', (code, signal) => {
    children.delete(child)
    if (!stopping) {
      console.error(`[chat] process exited (${signal || code})`)
      stop(typeof code === 'number' ? code : 1)
    }
  })
  return child
}

const stop = (code) => {
  if (stopping) {
    return
  }
  stopping = true
  for (const child of children) {
    child.kill()
  }
  setTimeout(() => process.exit(code), 500).unref()
}

start(process.execPath, ['server/index.mjs', '--api-only'], { PORT: '8091' })

if (process.platform === 'win32') {
  start(
    process.env.ComSpec || 'cmd.exe',
    ['/d', '/s', '/c', 'pnpm exec rspack serve -c rspack.config.ts'],
    { NODE_ENV: 'development' }
  )
} else {
  start('pnpm', ['exec', 'rspack', 'serve', '-c', 'rspack.config.ts'], {
    NODE_ENV: 'development',
  })
}

process.once('SIGINT', () => stop(0))
process.once('SIGTERM', () => stop(0))
