import https from 'node:https'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { dshHomeDir } from './paths.mjs'
import { PACKAGE, resolveDsh } from './dsh.mjs'
import { compareVersions } from './semver.mjs'
import { checkDshPeers, describeMismatch, peerText, pickCompatibleVersion } from './peer.mjs'
import { ensureRuntime, findExecutable, npmLauncher, runtimeEnv, searchPaths, spawnAsync } from './runtime.mjs'
import { push } from './logger.mjs'
import { ensureShellEnv } from './shellenv.mjs'

const OFFICIAL_PREFIX = '@deepseek-ai/'
const CONCURRENCY = 4
const TIMEOUT = 20000

/** Version specs that can be written as-is on the registry (dist-tags included); anything else counts as a git / local path install. */
const REGISTRY_SPEC = /^(?:[\^~]|>=|<=|>|<|=)?\s*v?\d/
const TAG_SPEC = /^(?:latest|next|alpha|beta|rc|stable)$/i

function encodePackage(name) {
  return name.replace('/', '%2f')
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { timeout: TIMEOUT, headers: { accept: 'application/vnd.npm.install-v1+json' } },
      (res) => {
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
      },
    )
    req.on('timeout', () => req.destroy(new Error('连接超时')))
    req.on('error', reject)
  })
}

export function profileDir(profile = 'web') {
  return join(dshHomeDir(), 'profiles', profile)
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function isRegistrySpec(spec) {
  if (spec === undefined || spec === null || spec === '') return true
  const text = String(spec).trim()
  return REGISTRY_SPEC.test(text) || TAG_SPEC.test(text)
}

/**
 * Installed third-party plugins: the profile's dependencies plus non-official packages in bundles.
 * Also carries the DSH compatibility range declared by the local package and the install source (registry / git / local path).
 */
export function readInstalledPlugins(profile = 'web') {
  const dir = profileDir(profile)
  const manifest = readJson(join(dir, 'package.json'))
  if (!manifest) return []

  const names = new Set(Object.keys(manifest.dependencies ?? {}))
  for (const bundle of manifest.dsh?.profile?.bundles ?? []) {
    if (!bundle.startsWith(OFFICIAL_PREFIX)) names.add(bundle)
  }

  const plugins = []
  for (const name of names) {
    if (name === PACKAGE || name.startsWith(OFFICIAL_PREFIX)) continue
    const pkg = readJson(join(dir, 'node_modules', name, 'package.json'))
    const declared = manifest.dependencies?.[name]
    const fallback = isRegistrySpec(declared) ? String(declared ?? '').replace(/^[^\d]*/, '') : ''
    const version = pkg?.version ?? (fallback || null)
    if (!version) continue
    plugins.push({
      name,
      version,
      source: isRegistrySpec(declared) ? 'registry' : 'local',
      manifest: pkg ?? {},
    })
  }
  return plugins.sort((a, b) => a.name.localeCompare(b.name))
}

async function runPool(items, worker) {
  const results = []
  let cursor = 0
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index])
    }
  })
  await Promise.all(runners)
  return results
}

export function findPnpm() {
  return findExecutable('pnpm', searchPaths())
}

/**
 * Check one plugin: keep the current version when it already fits; otherwise look for the highest version that fits the target.
 * When only the optional dependency range mismatches it is advisory: if nothing fits, keep the status quo and flag it.
 */
async function checkPlugin(plugin, targetDsh, registry) {
  const local = checkDshPeers(plugin.manifest, targetDsh)
  const verified = local.required.length > 0

  if (local.ok) {
    return {
      name: plugin.name,
      current: plugin.version,
      next: plugin.version,
      action: 'keep',
      verified,
      note: verified ? null : local.peers.length ? '只声明了可选依赖范围，按未校验处理' : '该插件未声明 DSH 兼容范围，无法校验',
      detail: verified ? null : { kind: local.peers.length ? 'optionalOnly' : 'unverified' },
      reason: null,
    }
  }

  const soft = local.requiredMismatch === null
  const localNote = `${plugin.name} ${plugin.version} 要求 ${peerText(local.mismatched)}，与目标 ${targetDsh} 不匹配`

  const keepAsIs = (note) => ({
    name: plugin.name,
    current: plugin.version,
    next: plugin.version,
    action: 'keep',
    verified: false,
    note,
    detail: { kind: local.peers.length ? 'optionalOnly' : 'unverified' },
    reason: null,
  })

  if (plugin.source !== 'registry') {
    const note = `${localNote}；该插件以 git 或本地路径安装，保持当前版本`
    const detail = { kind: 'localSource', peer: local.mismatched, target: targetDsh }
    return soft
      ? keepAsIs(note)
      : { ...keepAsIs(note), action: 'blocked', next: null, detail, reason: `${note}，需要手动确认版本` }
  }

  let packument
  try {
    packument = await fetchJson(`${registry}/${encodePackage(plugin.name)}`)
  } catch (error) {
    const note = `${localNote}；查询 npm 版本失败：${error.message}`
    const detail = { kind: 'queryFailed', peer: local.mismatched, target: targetDsh, error: error.message }
    return soft ? keepAsIs(note) : { ...keepAsIs(note), action: 'blocked', next: null, detail, reason: note }
  }

  const picked = pickCompatibleVersion(packument, targetDsh)
  if (!picked) {
    const note = `${localNote}；${describeMismatch(packument, targetDsh)}`
    const latest = packument?.['dist-tags']?.latest
    const latestManifest = latest ? packument?.versions?.[latest] : null
    const detail = {
      kind: 'noCompatible',
      peer: local.mismatched,
      target: targetDsh,
      latest: latest ? { version: latest, peer: checkDshPeers(latestManifest, targetDsh).mismatched } : null,
    }
    return soft ? keepAsIs(note) : { ...keepAsIs(note), action: 'blocked', next: null, detail, reason: note }
  }
  if (compareVersions(picked.version, plugin.version) <= 0) {
    const note = `${localNote}；适配目标版本的最高版本是 ${picked.version}，不高于当前安装版本`
    const detail = { kind: 'noNewer', peer: local.mismatched, target: targetDsh, picked: picked.version }
    return soft ? keepAsIs(note) : { ...keepAsIs(note), action: 'blocked', next: null, detail, reason: note }
  }

  const pickedVerified = checkDshPeers(picked.manifest, targetDsh).required.length > 0
  return {
    name: plugin.name,
    current: plugin.version,
    next: picked.version,
    action: 'upgrade',
    verified: pickedVerified,
    note: pickedVerified ? null : '目标版本只声明了可选依赖范围，按兼容处理',
    detail: pickedVerified ? null : { kind: 'optionalOnly' },
    reason: null,
  }
}

function buildCommands({ targetDsh, dshSource, profile, upgrades, registry }) {
  // Always install into npm's default global prefix, never with --prefix.
  const dshArgs = ['install', '-g', `${PACKAGE}@${targetDsh}`, '--registry', registry, '--no-fund', '--no-audit']

  const pluginArgs = upgrades.length
    ? [
        'plugin',
        '--profile',
        profile,
        'add',
        ...upgrades.map((item) => `${item.name}@${item.next}`),
        '--registry',
        registry,
      ]
    : null

  return {
    dshArgs,
    pluginArgs,
    commands: [`npm ${dshArgs.join(' ')}`, pluginArgs ? `dsh ${pluginArgs.join(' ')}` : null].filter(Boolean),
  }
}

/**
 * Uninstall the third-party plugins of the profile.
 * Prefer dsh plugin remove (it keeps the bundles layer list in sync as well); when pnpm/dsh is missing, hand off to
 * the profile config cleanup below as a fallback, so no half-finished state is left behind.
 */
export async function uninstallProfilePlugins(profile = 'web') {
  const plugins = readInstalledPlugins(profile)
  if (!plugins.length) {
    push('profile 里没有第三方插件，跳过插件卸载')
    return []
  }

  const names = plugins.map((item) => item.name)
  const target = resolveDsh()
  if (!target || !findPnpm()) {
    push(`未找到可用的 dsh 或 pnpm，插件交给配置清理一并移除：${names.join('、')}`)
    return names
  }

  push(`卸载第三方插件：${names.join('、')}`)
  const runtime = await ensureRuntime()
  const result = await spawnAsync(
    target.path,
    ['plugin', '--profile', profile, 'remove', ...names],
    { cwd: profileDir(profile), env: runtimeEnv(runtime), timeout: 600000 },
  )
  if (result.code !== 0) {
    push(`插件卸载命令退出码 ${result.code}，继续清理 profile 配置`)
    return names
  }
  push(`已卸载插件：${names.join('、')}`)
  return names
}

/** Delete the profile directory (plugin dependencies, cordis config and lock live here); the rest of ~/.dsh is user data and is kept. */
export function removeProfileConfig(profile = 'web') {
  const dir = profileDir(profile)
  if (!existsSync(dir)) {
    push('profile 配置目录不存在，跳过')
    return false
  }
  rmSync(dir, { recursive: true, force: true })
  push(`已清理 profile 配置：${dir}`)
  return true
}

/**
 * Build an upgrade plan: first check whether every installed third-party plugin fits the target dsh version;
 * only when all pass does it return the commands to execute; when something blocks, report it without executing.
 */
export async function buildUpgradePlan({ registry, targetDsh, currentDsh, dshSource, profile = 'web' }) {
  const plugins = readInstalledPlugins(profile)
  push(`升级检查：目标 DSH ${targetDsh}，已安装第三方插件 ${plugins.length} 个`)

  const results = await runPool(plugins, (plugin) => checkPlugin(plugin, targetDsh, registry))
  const blockers = results.filter((item) => item.action === 'blocked')
  const upgrades = results.filter((item) => item.action === 'upgrade')

  const { dshArgs, pluginArgs, commands } = buildCommands({
    targetDsh,
    dshSource,
    profile,
    upgrades,
    registry,
  })

  if (upgrades.length && !findPnpm()) {
    blockers.push({
      name: 'pnpm',
      current: null,
      next: null,
      action: 'blocked',
      detail: { kind: 'pnpmMissing' },
      reason: '未检测到 pnpm，第三方插件需要 pnpm 才能升级，请先安装 pnpm',
    })
  }

  const ok = blockers.length === 0
  push(
    ok
      ? `升级检查通过：${upgrades.length ? `${upgrades.length} 个插件需要同步升级` : '插件无需变更'}`
      : `升级检查未通过：${blockers.map((item) => item.name).join('、')}`,
  )

  return {
    ok,
    currentDsh,
    targetDsh,
    dshSource,
    profile,
    plugins: results,
    blockers,
    commands,
    dshArgs,
    pluginArgs,
  }
}

/** Execute the plan: once the instance is stopped, upgrade dsh first, then the plugins. */
export async function applyUpgradePlan(plan) {
  await ensureShellEnv()
  const { ensureRuntime } = await import('./runtime.mjs')
  const { resolveDsh, clearSystemDshCache } = await import('./dsh.mjs')

  const upgrades = plan.plugins.filter((item) => item.action === 'upgrade')
  if (upgrades.length && !findPnpm()) {
    throw new Error('未检测到 pnpm，第三方插件无法升级，请先安装 pnpm 后重试')
  }

  const runtime = await ensureRuntime()
  const launcher = npmLauncher(runtime)
  const env = { ...runtimeEnv(runtime), npm_config_update_notifier: 'false' }

  push(`执行：npm ${plan.dshArgs.join(' ')}`)
  const dshResult = await spawnAsync(launcher.cmd, [...launcher.prefix, ...(plan.dshArgs ?? [])], {
    cwd: homedir(),
    env,
    timeout: 900000,
  })
  if (dshResult.code !== 0) throw new Error(`升级 DSH 失败（退出码 ${dshResult.code}），请查看日志`)
  clearSystemDshCache()
  push(`DSH 已升级到 ${plan.targetDsh}`)

  if (!plan.pluginArgs) return { upgradedPlugins: [] }

  const target = resolveDsh()
  if (!target) throw new Error('升级后未找到 dsh 可执行文件，请查看日志')
  push(`执行：dsh ${plan.pluginArgs.join(' ')}`)
  const pluginResult = await spawnAsync(target.path, plan.pluginArgs, {
    cwd: profileDir(plan.profile),
    env,
    timeout: 900000,
  })
  if (pluginResult.code !== 0) {
    throw new Error(`升级第三方插件失败（退出码 ${pluginResult.code}），DSH 已升级完成，请查看日志后重试插件升级`)
  }
  push(`已升级插件：${upgrades.map((item) => item.name).join('、')}`)
  return { upgradedPlugins: upgrades.map((item) => item.name) }
}
