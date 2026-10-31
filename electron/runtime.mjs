import { spawn } from 'node:child_process'
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import https from 'node:https'
import { isNodeVersionOk } from './exec.mjs'
import { push } from './logger.mjs'
import { resetShellEnv } from './shellenv.mjs'
import { proxyEnv } from './paths.mjs'

/**
 * Node / npm from the user environment.
 *
 * Design constraints (real user machines, not sandboxes):
 * - Use only the user's own Node and npm: anything from the login shell PATH, Homebrew or the
 *   nvm/fnm/volta version managers is acceptable.
 * - When Node is missing, install it with nvm into ~/.nvm (the user-level default location) and write nvm init into
 *   the user's shell config; never ship a private Node copy inside the app data directory.
 * - When npm is missing, treat that Node as incomplete and just install a new Node.
 * - No install passes --prefix; each lands in its tool's default location.
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

/** Version managers such as nvm / fnm / nodenv hide node inside version directories; expand candidates per directory. */
function versionManagerDirs() {
  const patterns = IS_WIN
    ? [
        join(process.env.APPDATA ?? join(homedir(), 'AppData/Roaming'), 'nvm'),
        join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs'),
      ]
    : [
        join(homedir(), '.nvm/versions/node'),
        join(homedir(), 'Library/Application Support/fnm/node-versions'),
        join(homedir(), '.nodenv/versions'),
      ]
  const dirs = []
  for (const root of patterns) {
    try {
      for (const entry of readdirSync(root)) {
        // nvm-windows keeps node.exe directly in the version directory, with no bin subdirectory.
        dirs.push(join(root, entry))
        dirs.push(join(root, entry, 'bin'))
        dirs.push(join(root, entry, 'installation/bin'))
      }
    } catch {
      // That version manager is not installed.
    }
  }
  return dirs
}

function candidateDirs() {
  const fromPath = String(process.env.PATH || '').split(IS_WIN ? ';' : ':').filter(Boolean)
  return [...new Set([...fromPath, ...EXTRA_BIN_DIRS, ...versionManagerDirs()])]
}

/** For reuse by other modules: append the common Node install directories to PATH. */
export function searchPaths() {
  return candidateDirs()
}

export function nodeBinaryName() {
  return IS_WIN ? 'node.exe' : 'node'
}

function npmBinaryIn(dir) {
  return join(dir, IS_WIN ? 'npm.cmd' : 'npm')
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

async function probeNpm(npmPath) {
  const { code, stdout } = await run(npmPath, ['--version'], { timeout: 15000 })
  const version = stdout.trim().split('\n').pop()?.trim() ?? ''
  if (code !== 0 || !/^\d+\.\d+\.\d+/.test(version)) return null
  return version
}

/** Find a usable node + npm in the candidate directories; null means the user environment has none. */
export async function findUserNode() {
  for (const dir of candidateDirs()) {
    const nodePath = join(dir, nodeBinaryName())
    if (!existsSync(nodePath)) continue
    const version = await probeNode(nodePath)
    if (!version) continue
    const npmPath = npmBinaryIn(dir)
    const npmVersion = existsSync(npmPath) ? await probeNpm(npmPath) : null
    return {
      source: 'system',
      nodePath,
      version,
      npmPath: existsSync(npmPath) ? npmPath : null,
      npmVersion,
    }
  }
  return null
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

/** Print the toolchain status once at startup, stating clearly whatever is missing. */
export async function logToolchain() {
  const found = await resolveRuntime()
  const nodeText = found ? `node ${found.version}` : 'node 未检测到'
  const npmText = found?.npmVersion ? `npm ${found.npmVersion}` : 'npm 未检测到'
  push(`用户环境：${nodeText}，${npmText}`)
  if (!found) {
    push('缺少 Node：安装或启动 DSH 时会用 nvm 把 Node 22 装到 ~/.nvm，并写入 shell 配置')
    return
  }
  if (!found.npmVersion) push('缺少 npm：该 Node 不完整，安装或启动 DSH 时会在 ~/.nvm 下装新的 Node 22')
}

/* ---------------------------------------------------------------- nvm */

/**
 * Where nvm downloads Node from. Only benchmarked when Node actually has to be
 * installed; a machine that already has a usable Node never pays this cost.
 */
const NODE_SOURCES = [
  { name: '官方源', base: 'https://nodejs.org/dist', mirror: null },
  { name: '国内镜像', base: 'https://npmmirror.com/mirrors/node', mirror: 'https://npmmirror.com/mirrors/node' },
]

function headLatency(url, { timeout = 6000, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const request = (currentUrl, left) => {
      const req = https.request(currentUrl, { method: 'HEAD', timeout }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && left > 0) {
          res.resume()
          request(new URL(res.headers.location, currentUrl).toString(), left - 1)
          return
        }
        res.resume()
        if (res.statusCode && res.statusCode < 400) resolve(Date.now() - started)
        else reject(new Error(`HTTP ${res.statusCode}`))
      })
      req.on('timeout', () => req.destroy(new Error('连接超时')))
      req.on('error', reject)
      req.end()
    }
    request(url, redirects)
  })
}

/** Pick the faster Node source. Only called from installNodeWithNvm(). */
async function pickNodeSource() {
  const results = await Promise.allSettled(
    NODE_SOURCES.map(async (source) => ({ ...source, elapsed: await headLatency(`${source.base}/index.json`) })),
  )
  const ok = results.filter((item) => item.status === 'fulfilled').map((item) => item.value)
  if (!ok.length) {
    push('Node 下载源测速失败，使用官方源')
    return { preferred: NODE_SOURCES[0], order: NODE_SOURCES }
  }
  ok.sort((a, b) => a.elapsed - b.elapsed)
  push(`Node 源测速：${ok.map((item) => `${item.name} ${item.elapsed}ms`).join('，')} → 选用 ${ok[0].name}`)
  const preferred = ok[0]
  return { preferred, order: [preferred, ...NODE_SOURCES.filter((source) => source.base !== preferred.base)] }
}

const NVM_DIR = join(homedir(), '.nvm')
const NVM_VERSION = 'v0.40.3'
const NVM_URLS = [
  `https://codeload.github.com/nvm-sh/nvm/tar.gz/refs/tags/${NVM_VERSION}`,
  `https://ghproxy.net/https://github.com/nvm-sh/nvm/archive/refs/tags/${NVM_VERSION}.tar.gz`,
]

function nvmInstalled() {
  return existsSync(join(NVM_DIR, 'nvm.sh'))
}

function rcFileForShell() {
  const shell = basename(process.env.SHELL || '/bin/zsh')
  if (shell === 'zsh') return join(homedir(), '.zshrc')
  if (shell === 'bash') return join(homedir(), process.platform === 'darwin' ? '.bash_profile' : '.bashrc')
  return join(homedir(), '.profile')
}

/** Write the nvm init block into the user's shell config (marked and idempotent). */
function writeShellInit() {
  const rc = rcFileForShell()
  const marker = '# >>> dsh-ready nvm >>>'
  try {
    const current = existsSync(rc) ? readFileSync(rc, 'utf8') : ''
    if (current.includes(marker)) return rc
    const block = [
      '',
      marker,
      'export NVM_DIR="$HOME/.nvm"',
      '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
      '[ -s "$NVM_DIR/bash_completion" ] && . "$NVM_DIR/bash_completion"',
      '# <<< dsh-ready nvm <<<',
      '',
    ].join('\n')
    appendFileSync(rc, block)
    push(`已把 nvm 初始化写入 ${rc}（新开的终端会自动带上 node/npm）`)
  } catch (error) {
    push(`写入 ${rc} 失败：${error.message}；本应用仍会直接使用 ~/.nvm 里的 node`)
  }
  return rc
}

function downloadToFile(url, target, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const request = (currentUrl) => {
      const req = https.get(currentUrl, { timeout }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          request(new URL(res.headers.location, currentUrl).toString())
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }
        const out = createWriteStream(target)
        res.pipe(out)
        out.on('finish', () => resolve(target))
        out.on('error', reject)
      })
      req.on('timeout', () => req.destroy(new Error('连接超时')))
      req.on('error', reject)
    }
    request(url)
  })
}

/** Install nvm into ~/.nvm (no git, no Homebrew dependency). */
export async function ensureNvm() {
  if (nvmInstalled()) return NVM_DIR

  push(`未检测到 nvm，正在安装到 ${NVM_DIR}`)
  const tmp = join(homedir(), '.dsh-ready-nvm-download.tar.gz')
  let lastError = null
  for (const url of NVM_URLS) {
    try {
      await downloadToFile(url, tmp)
      lastError = null
      break
    } catch (error) {
      lastError = error
    }
  }
  if (lastError) throw new Error(`nvm 下载失败：${lastError.message}`)

  const extractDir = join(homedir(), '.dsh-ready-nvm-extract')
  rmSync(extractDir, { recursive: true, force: true })
  mkdirSync(extractDir, { recursive: true })
  const tar = await run('tar', ['-xzf', tmp, '-C', extractDir], { timeout: 120000 })
  rmSync(tmp, { force: true })
  if (tar.code !== 0) throw new Error(`nvm 解压失败：${String(tar.stderr).trim() || tar.code}`)

  const unpacked = readdirSync(extractDir).find((name) => name.startsWith('nvm-'))
  if (!unpacked) throw new Error('nvm 解压后未找到目录')
  rmSync(NVM_DIR, { recursive: true, force: true })
  renameSync(join(extractDir, unpacked), NVM_DIR)
  rmSync(extractDir, { recursive: true, force: true })

  writeShellInit()
  push('nvm 安装完成')
  return NVM_DIR
}

function nvmShell(script, { mirror = null, timeout = 1200000 } = {}) {
  const command = [
    'export NVM_DIR="$HOME/.nvm"',
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
    script,
  ].join('; ')
  return run('bash', ['-lc', command], {
    env: { ...process.env, NVM_DIR, ...(mirror ? { NVM_NODEJS_ORG_MIRROR: mirror } : {}) },
    timeout,
  })
}

/** Install Node 22 with nvm, make it the default version and return the node path. */
async function installNodeWithNvm() {
  await ensureNvm()
  const { order } = await pickNodeSource()
  push('正在通过 nvm 安装 Node 22（用户级，~/.nvm）；首次下载通常需要 1–3 分钟，请保持网络连接')
  const heartbeat = setInterval(() => push('nvm 安装仍在进行（首次下载较慢，请保持网络连接）…'), 30000)
  let result
  try {
    for (const source of order) {
      result = await nvmShell('nvm install 22 --default && nvm which 22', { mirror: source.mirror })
      if (result.code === 0) break
      const next = order.find((item) => item.base !== source.base)
      push(`${source.name}安装失败${next ? `，改用${next.name}重试` : ''}`)
    }
  } finally {
    clearInterval(heartbeat)
  }
  if (!result || result.code !== 0) {
    throw new Error('nvm 安装 Node 失败：官方源与国内镜像都不可用，请检查网络后重试')
  }

  const lines = result.stdout.trim().split('\n').filter(Boolean)
  const nodePath = lines.reverse().find((line) => line.includes('/node') && !line.includes('nvm'))
  if (result.code !== 0 || !nodePath) {
    throw new Error(
      `nvm 安装 Node 失败：${(result.stderr || result.stdout || '').trim().split('\n').pop() || result.code}`,
    )
  }
  if (!existsSync(nodePath)) throw new Error(`nvm 报告了 node 路径但文件不存在：${nodePath}`)

  // Take effect in this process immediately: put nvm's bin first on PATH and reload the login shell environment.
  const binDir = join(nodePath, '..')
  process.env.PATH = `${binDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`
  process.env.NVM_DIR = NVM_DIR
  resetShellEnv()
  clearRuntimeCache()
  push(`Node 22 已安装到 ${nodePath}`)
  return nodePath
}

/** Make sure a usable node + npm exist in the user environment; install whatever is missing. */
export async function ensureRuntime() {
  const found = await resolveRuntime()
  if (found && isNodeVersionOk(found.version) && found.npmVersion) {
    push(`使用用户环境 Node ${found.version}（npm ${found.npmVersion}）`)
    return found
  }

  if (process.platform === 'win32') {
    if (found) {
      throw new Error('检测到 node，但版本低于 22.18 或缺少 npm；请先用官方安装包升级 Node LTS 后重试')
    }
    throw new Error('未检测到 Node。Windows 请先安装 Node.js LTS（用户级安装即可），再回到本应用重试')
  }

  push(
    found
      ? '用户环境 Node 不满足要求（需 22.18+ 且带 npm），准备用 nvm 安装'
      : '未检测到 Node，准备用 nvm 安装到 ~/.nvm',
  )
  await installNodeWithNvm()

  const after = await findUserNode()
  if (!after) throw new Error('nvm 安装完成，但仍未找到 node，请查看上方日志')
  if (!isNodeVersionOk(after.version)) throw new Error(`安装后的 node 版本仍不满足要求：${after.version}`)
  if (!after.npmVersion) throw new Error('安装后的 Node 缺少 npm，请重新安装 Node')
  cached = after
  return after
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
    return { cmd: runtime.npmPath, prefix: [] }
  }
  throw new Error('用户环境缺少 npm，请先安装 Node（自带 npm）后重试')
}

export function spawnAsync(cmd, args, { cwd, env, timeout = 600000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: env ?? process.env, shell: process.platform === 'win32' })
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
