import { execFile } from 'node:child_process'

const DEFAULT_WEB_PORT = 3080
const IS_WIN = process.platform === 'win32'

function runCommand(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (error, stdout) => {
      resolve(error ? '' : String(stdout))
    })
  })
}

/** Whether a process command line is the dsh web service main process. */
export function isDshWebCommand(command) {
  if (!command || command.includes('--help')) return false
  const text = String(command).replace(/\\/g, '/')
  const hasDsh = /(?:^|[\s/])dsh(?:[\s./]|$)/.test(text)
  const hasWeb = /(?:^|\s)web(?:\s|$)/.test(text) || text.includes('--profile web')
  return hasDsh && hasWeb
}

/** On Windows, find the PID listening on a given port via netstat. */
async function listeningPidOnPort(port) {
  const output = await runCommand('netstat', ['-ano'])
  for (const line of output.split('\n')) {
    if (!line.includes('LISTENING')) continue
    const parts = line.trim().split(/\s+/)
    const local = parts[1] ?? ''
    const pid = Number(parts[parts.length - 1])
    if (!local.endsWith(`:${port}`)) continue
    if (Number.isInteger(pid) && pid > 0) return pid
  }
  return null
}

/** On Windows, read a process command line to confirm the process on the target port is dsh web. */
async function commandLineOf(pid) {
  const output = await runCommand('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
  ])
  return output.trim()
}

async function portListening(port) {
  if (IS_WIN) return (await listeningPidOnPort(port)) !== null
  const output = await runCommand('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'])
  return Boolean(output.trim())
}

async function listeningPorts(pid) {
  const output = await runCommand('lsof', [
    '-p', String(pid), '-a', '-iTCP', '-sTCP:LISTEN', '-P', '-n', '-Fn',
  ])
  const ports = []
  for (const line of output.split('\n')) {
    if (!line.startsWith('n')) continue
    const match = /:(\d+)$/.exec(line.trim())
    if (match) ports.push(Number(match[1]))
  }
  return ports
}

/**
 * Find dsh web processes listening on the given port that this console does not own.
 * Only one instance is reported; dsh on a different port is not managed by this console and is left alone.
 */
export async function findExternalDsh(targetPort) {
  const wanted = Number(targetPort) || DEFAULT_WEB_PORT

  if (IS_WIN) {
    const pid = await listeningPidOnPort(wanted)
    if (!pid) return null
    const command = await commandLineOf(pid)
    if (!isDshWebCommand(command)) return null
    return { pid, port: wanted, url: `http://127.0.0.1:${wanted}` }
  }

  const psOutput = await runCommand('ps', ['-axo', 'pid=,command='])
  if (!psOutput) return null

  const candidates = []
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const command = match[2]
    if (!isDshWebCommand(command)) continue
    // Skip parent-process wrappers around node (e.g. npm exec); take only the process that really runs dsh.
    if (command.includes('dsh/bin.js') && !command.includes('dsh web')) continue
    candidates.push(pid)
  }

  for (const pid of candidates) {
    const ports = await listeningPorts(pid)
    if (ports.includes(wanted)) return { pid, port: wanted, url: `http://127.0.0.1:${wanted}` }
  }
  return null
}

/** Stop an external dsh process: SIGTERM first, SIGKILL after the timeout. */
export async function killExternalDsh(pid, timeoutMs = 6000) {
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  if (!alive()) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive()) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already exited.
  }
}

/** Wait for the port to be released from the listening state. */
export async function waitPortFree(port, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await portListening(port))) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}
