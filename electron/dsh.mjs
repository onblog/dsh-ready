import https from 'node:https'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { ensureRuntime, resolveRuntime, npmLauncher, runtimeEnv, spawnAsync, searchPaths } from './runtime.mjs'
import { run } from './exec.mjs'
import { push } from './logger.mjs'
import { ensureShellEnv } from './shellenv.mjs'
import { readSettings } from './paths.mjs'

export const PACKAGE = '@deepseek-ai/dsh'

export const REGISTRIES = [
  { key: 'official', name: 'npm 官方源', base: 'https://registry.npmjs.org' },
  { key: 'mirror', name: '国内镜像', base: 'https://registry.npmmirror.com' },
]

function requestHead(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'HEAD', timeout }, (res) => {
      res.resume()
      if (res.statusCode && res.statusCode < 400) resolve()
      else reject(new Error(`HTTP ${res.statusCode}`))
    })
    req.on('timeout', () => req.destroy(new Error('连接超时')))
    req.on('error', reject)
    req.end()
  })
}

function requestJson(url, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          reject(error)
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('连接超时')))
    req.on('error', reject)
  })
}

/** Benchmark and pick an npm registry; fall back to the official one if both fail. */
let registryPromise = null

/**
 * The registry choice is global: the first screen's state:get and versions:list fire concurrently,
 * so both reuse the same in-flight Promise to avoid duplicate speed tests and duplicate log output.
 */
export function resetRegistryCache() {
  registryPromise = null
}

export function pickRegistry() {
  // A pinned registry skips the speed test entirely: the choice belongs to the user.
  const pinned = REGISTRIES.find((item) => item.key === readSettings().npmRegistry)
  if (pinned) return Promise.resolve(pinned.base)
  if (!registryPromise) {
    registryPromise = pickRegistryOnce().catch((error) => {
      registryPromise = null
      throw error
    })
  }
  return registryPromise
}

async function pickRegistryOnce() {
  const results = await Promise.allSettled(
    REGISTRIES.map(async (item) => {
      const started = Date.now()
      await requestHead(`${item.base}/-/ping`)
      return { ...item, elapsed: Date.now() - started }
    }),
  )
  const ok = results.filter((item) => item.status === 'fulfilled').map((item) => item.value)
  if (!ok.length) {
    push('npm 源测速失败，使用默认官方源')
    return REGISTRIES[0].base
  }
  ok.sort((a, b) => a.elapsed - b.elapsed)
  push(`npm 源测速：${ok.map((item) => `${item.name} ${item.elapsed}ms`).join('，')} → 选用 ${ok[0].name}`)
  return ok[0].base
}

let globalPrefixCache = null
let systemCache = null

export function clearSystemDshCache() {
  systemCache = null
}

/** npm's global prefix (npm's own default, no --prefix). */
async function globalPrefix(runtime) {
  if (globalPrefixCache) return globalPrefixCache
  const result = await run(runtime.npmPath, ['prefix', '-g'], {
    env: runtimeEnv(runtime),
    timeout: 20000,
  })
  const prefix = result.stdout.trim()
  if (result.code === 0 && prefix) globalPrefixCache = prefix
  return globalPrefixCache
}

function globalBinDirs() {
  const dirs = []
  if (globalPrefixCache) dirs.push(join(globalPrefixCache, 'bin'), globalPrefixCache)
  return dirs
}

const BINARY_NAME = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'

function packageVersionAt(binaryPath) {
  let current
  try {
    current = dirname(realpathSync(binaryPath))
  } catch {
    return null
  }
  for (let depth = 0; depth < 5; depth += 1) {
    const manifest = join(current, 'package.json')
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
        if (pkg.name === PACKAGE && pkg.version) return pkg.version
      } catch {
        // Keep walking up.
      }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

/** Warm the npm global prefix at startup so global bins outside PATH can still be found. */
export async function primeGlobalPrefix() {
  const runtime = await resolveRuntime()
  if (!runtime?.npmPath) return null
  await globalPrefix(runtime)
  if (globalPrefixCache) push(`npm 全局前缀：${globalPrefixCache}`)
  clearSystemDshCache()
  return globalPrefixCache
}

/** A dsh already installed in the user environment (npm global / Homebrew / nvm, etc.); null when absent. */
export function findSystemDsh() {
  if (systemCache !== null) return systemCache
  for (const dir of [...globalBinDirs(), ...searchPaths()]) {
    const candidate = join(dir, BINARY_NAME)
    if (!existsSync(candidate)) continue
    const version = packageVersionAt(candidate)
    if (version) {
      systemCache = { path: candidate, version }
      return systemCache
    }
  }
  systemCache = undefined
  return null
}

/** The dsh in effect right now: user environment only, no private app-bundled copy any more. */
export function resolveDsh() {
  const found = findSystemDsh()
  if (found) return { path: found.path, version: found.version, source: 'system' }
  return null
}

/** The dsh version currently in effect in the user environment. */
export function installedVersion() {
  return findSystemDsh()?.version ?? null
}

export async function latestVersion(registry) {
  try {
    const meta = await requestJson(`${registry}/${PACKAGE.replace('/', '%2f')}/latest`)
    return meta.version ?? null
  } catch {
    return null
  }
}

function compareVersions(a, b) {
  const parse = (value) => String(value).replace(/^v/, '').split(/[.+-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part))
  const left = parse(a)
  const right = parse(b)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = left[index]
    const r = right[index]
    if (l === r) continue
    if (typeof l === 'number' && typeof r === 'number') return r - l
    if (typeof l === 'number') return -1
    if (typeof r === 'number') return 1
    return String(r).localeCompare(String(l))
  }
  return 0
}

/** Fetch the available versions and dist-tags, used for the version dropdown during install. */
export async function listVersions(registry) {
  const meta = await requestJson(`${registry}/${PACKAGE.replace('/', '%2f')}`, 20000)
  const tags = meta['dist-tags'] ?? {}
  const versions = Object.keys(meta.versions ?? {}).sort(compareVersions)
  const tagVersions = [...new Set(Object.values(tags))]
  const merged = [...new Set([...tagVersions, ...versions])]
  return {
    latest: tags.latest ?? null,
    tags,
    versions: merged.slice(0, 40),
  }
}

async function npmRun(runtime, args) {
  await ensureShellEnv()
  const launcher = npmLauncher(runtime)
  push(`执行 npm ${args.join(' ')}`)
  const result = await spawnAsync(launcher.cmd, [...launcher.prefix, ...args], {
    cwd: homedir(),
    env: { ...runtimeEnv(runtime), npm_config_update_notifier: 'false' },
  })
  if (result.code !== 0) {
    throw new Error(
      `npm 执行失败（退出码 ${result.code}）。如果提示 EACCES，说明当前 npm 的全局目录不可写，请改用 nvm 或 Homebrew 安装的用户级 Node。`,
    )
  }
  return result
}

export async function installDsh(version = 'latest') {
  const runtime = await ensureRuntime()
  const registry = await pickRegistry()
  const target = String(version || 'latest').trim()
  push(`开始安装 DSH@${target}，首次安装需要下载依赖，请耐心等待`)
  await npmRun(runtime, [
    'install',
    '-g',
    `${PACKAGE}@${target}`,
    '--registry',
    registry,
    '--no-fund',
    '--no-audit',
  ])

  // Installs land in npm's default global prefix; remember it so this process finds dsh without a restart.
  globalPrefixCache = null
  const prefix = await globalPrefix(runtime)
  clearSystemDshCache()
  const installed = findSystemDsh()?.version ?? null
  if (!installed) {
    throw new Error(
      `安装完成但未在 PATH${prefix ? `（npm prefix -g: ${prefix}）` : ''} 里找到 dsh，请查看日志后重试`,
    )
  }
  push(`DSH ${installed} 安装完成（npm 全局前缀：${prefix ?? '未知'}）`)
  return installed
}

export async function uninstallDsh() {
  const runtime = await ensureRuntime()
  const registry = await pickRegistry()
  push('卸载 DSH 程序本体（Node 与 npm 不删除）')
  await npmRun(runtime, ['uninstall', '-g', PACKAGE, '--registry', registry])
  globalPrefixCache = null
  clearSystemDshCache()
  push('DSH 程序本体已卸载')
}
