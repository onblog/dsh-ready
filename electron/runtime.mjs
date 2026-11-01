import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isNodeVersionOk, MIN_NODE_TEXT } from './exec.mjs'
import { push } from './logger.mjs'
import { proxyEnv, resolveLanguage } from './paths.mjs'

/**
 * Node / npm from the user environment.
 *
 * Design constraints (real user machines, not sandboxes):
 * - Use only the user's own Node and npm: anything from the login shell PATH, Homebrew or the
 *   nvm/fnm/volta version managers is acceptable.
 * - Never install or modify Node/npm. When the runtime is missing or incomplete, send the user
 *   to the localized official Node.js download page for manual installation.
 */

const IS_WIN = process.platform === 'win32'

const EXTRA_BIN_DIRS = IS_WIN
  ? [
      join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs'),
      join(process.env.APPDATA ?? join(homedir(), 'AppData/Roaming'), 'npm'),
      join(homedir(), 'scoop', 'shims'),
      'C:\\ProgramData\\chocolatey\\bin',
    ]
  : [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      join(homedir(), '.volta/bin'),
      join(homedir(), '.local/bin'),
      join(homedir(), '.asdf/shims'),
    ]

function pathDirs() {
  const separator = IS_WIN ? ';' : ':'
  return String(process.env.PATH || '')
    .split(separator)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
}

function candidateDirs() {
  return [...new Set([...pathDirs(), ...EXTRA_BIN_DIRS])]
}

/** For reuse by other modules: append the common Node install directories to PATH. */
export function searchPaths() {
  return candidateDirs()
}

function run(cmd, args, { cwd, env, timeout = 15000 } = {}) {
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

async function probeNode(nodePath) {
  const { code, stdout } = await run(nodePath, ['-v'], { timeout: 8000 })
  const version = stdout.trim()
  if (code !== 0 || !isNodeVersionOk(version)) return null
  return version
}

async function probeNpm(nodePath, npmPath, npmCliPath) {
  // npm.cmd cannot be spawned directly on Windows. Execute its JS entry point
  // with the matching node.exe instead, avoiding cmd.exe quoting and EINVAL.
  const { code, stdout } = npmCliPath
    ? await run(nodePath, [npmCliPath, '--version'], { timeout: 15000 })
    : await run(npmPath, ['--version'], { timeout: 15000 })
  const version = stdout.trim().split('\n').pop()?.trim() ?? ''
  if (code !== 0 || !/^\d+\.\d+\.\d+/.test(version)) return null
  return version
}

function firstOnPath(files) {
  for (const dir of pathDirs()) {
    for (const file of files) {
      const candidate = join(dir, file)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** Resolve and execute the node/npm commands currently exposed by PATH. */
export async function findUserNode() {
  const nodePath = firstOnPath(IS_WIN ? ['node.exe'] : ['node'])
  if (!nodePath) return null
  const version = await probeNode(nodePath)
  if (!version) return null

  const npmPath = firstOnPath(IS_WIN ? ['npm.cmd', 'npm.exe', 'npm.bat'] : ['npm'])
  const npmCliCandidate = IS_WIN && npmPath
    ? join(dirname(npmPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : null
  const npmCliPath = npmCliCandidate && existsSync(npmCliCandidate) ? npmCliCandidate : null
  const hasNpm = Boolean(npmPath) && (!IS_WIN || Boolean(npmCliPath))
  const npmVersion = hasNpm ? await probeNpm(nodePath, npmPath, npmCliPath) : null
  return {
    source: 'system',
    nodePath,
    version,
    npmPath: hasNpm ? npmPath : null,
    npmCliPath,
    npmVersion,
  }
}

let cached = null

/** Resolve the user environment runtime; never installs and never downloads. */
export async function resolveRuntime() {
  if (cached) return cached
  cached = await findUserNode()
  return cached
}

export function clearRuntimeCache() {
  cached = null
}

export function runtimeState() {
  if (cached) {
    return { runtime: 'system', nodeVersion: cached.version, npmVersion: cached.npmVersion ?? null }
  }
  return { runtime: 'missing', nodeVersion: null, npmVersion: null }
}

const NODE_DOWNLOAD_URL = {
  zh: 'https://nodejs.org/zh-cn/download',
  en: 'https://nodejs.org/en/download',
}

function runtimeLang() {
  return resolveLanguage(Intl.DateTimeFormat().resolvedOptions().locale)
}

function missingRuntimeMessage(found) {
  const lang = runtimeLang()
  const link = lang === 'zh'
    ? `[安装链接](${NODE_DOWNLOAD_URL.zh})`
    : `[Installation link](${NODE_DOWNLOAD_URL.en})`
  if (lang === 'zh') {
    return found
      ? `Node 版本低于 ${MIN_NODE_TEXT} 或缺少 npm，请手动安装最新版 Node.js LTS：${link}`
      : `未检测到 Node 和 npm，请手动安装 Node.js LTS：${link}`
  }
  return found
    ? `Node must be version ${MIN_NODE_TEXT} or newer and include npm. Install the latest Node.js LTS manually: ${link}`
    : `Node and npm were not found. Install Node.js LTS manually: ${link}`
}

/** Print the toolchain status once at startup, stating clearly whatever is missing. */
export async function logToolchain() {
  const found = await resolveRuntime()
  const nodeText = found ? `node ${found.version}` : 'node 未检测到'
  const npmText = found?.npmVersion ? `npm ${found.npmVersion}` : 'npm 未检测到'
  push(`用户环境：${nodeText}，${npmText}`)
  if (!found || !found.npmVersion) push(missingRuntimeMessage(found))
}

/** Return a usable user-installed Node/npm runtime, or direct the user to install it manually. */
export async function ensureRuntime() {
  const found = await resolveRuntime()
  if (found && isNodeVersionOk(found.version) && found.npmVersion) {
    push(`使用用户环境 Node ${found.version}（npm ${found.npmVersion}）`)
    return found
  }
  const message = missingRuntimeMessage(found)
  push(message)
  throw new Error(message)
}

/* ------------------------------------------------------- process helpers */

/** Find an executable in the candidate directories, null when absent; on Windows try .cmd/.exe/.bat in turn. */
export function findExecutable(name, extraDirs = []) {
  const files = IS_WIN ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`] : [name]
  for (const dir of [...extraDirs, ...candidateDirs()]) {
    for (const file of files) {
      const candidate = join(dir, file)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** Build the child process environment: add node's bin directory and the common install directories to PATH. */
export function runtimeEnv(runtime) {
  const sep = process.platform === 'win32' ? ';' : ':'
  const nodeDir = runtime?.nodePath ? runtime.nodePath.replace(/[\\/]node(\.exe)?$/, '') : null
  const dirs = [nodeDir, ...candidateDirs()].filter(Boolean)
  const current = String(process.env.PATH ?? '')
  const merged = [...new Set([...dirs, ...current.split(sep).filter(Boolean)])]
  // Proxy variables reach npm and DSH; the app's own requests never go through them.
  return { ...process.env, PATH: merged.join(sep), ...proxyEnv() }
}

/** npm invocation arguments: use the npm from the user environment and specify no prefix. */
export function npmLauncher(runtime) {
  if (runtime?.npmPath && existsSync(runtime.npmPath)) {
    if (IS_WIN && runtime.npmCliPath && existsSync(runtime.npmCliPath)) {
      return { cmd: runtime.nodePath, prefix: [runtime.npmCliPath] }
    }
    return { cmd: runtime.npmPath, prefix: [] }
  }
  throw new Error('用户环境缺少 npm，请先安装 Node（自带 npm）后重试')
}

export function spawnAsync(cmd, args, { cwd, env, timeout = 600000 } = {}) {
  return new Promise((resolve) => {
    const shell = IS_WIN && /\.(?:cmd|bat)$/i.test(cmd)
    const child = spawn(cmd, args, { cwd, env: env ?? process.env, shell })
    let buffer = ''
    const flush = (chunk) => {
      buffer += chunk
      const parts = buffer.split('\n')
      buffer = parts.pop() ?? ''
      for (const line of parts) if (line.trim()) push(line.trimEnd())
    }
    child.stdout?.on('data', (chunk) => flush(String(chunk)))
    child.stderr?.on('data', (chunk) => flush(String(chunk)))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, error })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (buffer.trim()) push(buffer.trimEnd())
      resolve({ code: code ?? -1 })
    })
  })
}
