import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { push } from './logger.mjs'

/**
 * Read user environment variables from the login shell.
 * An app launched from the GUI only gets launchd's minimal environment, so whatever `~/.zshrc` declares
 * (API keys, proxies, PATH, ...) is missing; dsh spawned by this console needs that environment.
 */

/** The UI/app environment wins; it is never overridden from the shell. */
const KEEP_APP = new Set(['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'PATH', 'DSH_HOME'])

/** Terminal, session and process-identity variables are not applied back, keeping another session's state out of new processes. */
const IGNORED = new Set([
  'PWD',
  'OLDPWD',
  'SHLVL',
  '_',
  'TERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TERM_SESSION_ID',
  'TERM_FEATURES',
  'TERMINFO_DIRS',
  'ITERM_SESSION_ID',
  'ITERM_PROFILE',
  'COLORFGBG',
  'COLORTERM',
  'LS_COLORS',
  'LSCOLORS',
  'PAGER',
  'LESS',
  'GIT_PAGER',
  'NO_COLOR',
  'XPC_FLAGS',
  'XPC_SERVICE_NAME',
  'SECURITYSESSIONID',
  'OSLogRateLimit',
  '__CFBundleIdentifier',
  '__CF_USER_TEXT_ENCODING',
  'DSH_SESSION_ID',
  'DSH_WEB_URL',
  'DSH_SHELL',
])

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']

let loadPromise = null
let applied = false

/** After installing nvm / editing shell config, drop the cache so the next ensureShellEnv reads it again. */
export function resetShellEnv() {
  loadPromise = null
  applied = false
}

function parseEnv(text) {
  const env = {}
  for (const chunk of String(text ?? '').split('\0')) {
    // An interactive shell may print banners to stdout; validate each chunk as name=value to filter them out.
    const line = chunk.replace(/^[\r\n]+/, '')
    const index = line.indexOf('=')
    if (index <= 0) continue
    const key = line.slice(0, index)
    if (!ENV_NAME.test(key)) continue
    env[key] = line.slice(index + 1)
  }
  return env
}

function runShell(shell, timeout) {
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', 'env -0'],
      { timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => resolve({ error, stdout }),
    )
  })
}

/** Read and parse the login shell environment; the result is cached and read only once. */
export function loadShellEnv() {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    if (process.env.DSH_READY_SKIP_SHELL_ENV === '1') {
      return { env: null, elapsed: 0, error: null, skipped: true }
    }
    if (process.platform === 'win32') {
      return { env: null, elapsed: 0, error: 'Windows 不读取 shell 环境', skipped: true }
    }
    const shell = process.env.SHELL || '/bin/zsh'
    if (!existsSync(shell)) {
      return { env: null, elapsed: 0, error: `未找到 shell：${shell}`, skipped: false }
    }

    const started = Date.now()
    const { error, stdout } = await runShell(shell, 8000)
    const env = parseEnv(stdout)
    const count = Object.keys(env).length
    if (count < 5) {
      return { env: null, elapsed: Date.now() - started, error: error?.message ?? 'shell 未返回环境变量', skipped: false }
    }
    return { env, elapsed: Date.now() - started, error: null, skipped: false }
  })()
  return loadPromise
}

/** Merge the shell environment into process.env so child processes (dsh / npm / pnpm) inherit it. */
export async function ensureShellEnv() {
  const result = await loadShellEnv()
  if (applied) return result
  applied = true

  if (!result.env) {
    if (!result.skipped) push(`未读取到登录 shell 环境（${result.error}），沿用应用自身环境`)
    return result
  }

  let count = 0
  for (const [key, value] of Object.entries(result.env)) {
    if (IGNORED.has(key) || KEEP_APP.has(key)) continue
    if (process.env[key] === value) continue
    process.env[key] = value
    count += 1
  }

  const separator = process.platform === 'win32' ? ';' : ':'
  const dirs = [...new Set([...(result.env.PATH ?? '').split(separator), ...(process.env.PATH ?? '').split(separator)])]
  process.env.PATH = dirs.filter(Boolean).join(separator)

  const proxies = PROXY_KEYS.filter((key) => process.env[key])
  push(
    `已加载登录 shell 环境：${count} 个变量（${result.elapsed}ms）${proxies.length ? `，含代理 ${proxies.join('、')}` : ''}`,
  )
  return result
}
