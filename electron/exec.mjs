import { spawn } from 'node:child_process'

export const MIN_NODE_MAJOR = 22
export const MIN_NODE_MINOR = 18

/** Parse a version string such as `v22.18.0`; returns null on failure. */
export function parseNodeVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? '').trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

export function isNodeVersionOk(version) {
  const parsed = parseNodeVersion(version)
  if (!parsed) return false
  if (parsed.major !== MIN_NODE_MAJOR) return parsed.major > MIN_NODE_MAJOR
  return parsed.minor >= MIN_NODE_MINOR
}

/** Run a command and collect its output; used for short commands such as version probes. */
export function run(cmd, args, { cwd, env, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(cmd, args, { cwd, env: env ?? process.env })
    } catch (error) {
      resolve({ code: -1, stdout, stderr: String(error?.message || error) })
      return
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: String(error?.message || error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}
