import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import { join } from 'node:path'
import {
  readSettings,
  writeSettings,
  ensureDirs,
  isValidPort,
  normalizeProxy,
  parseDshArgs,
  NPM_REGISTRIES,
} from './paths.mjs'
import { push, getLines, clearLines, onLine } from './logger.mjs'
import {

  installDsh,
  uninstallDsh,
  latestVersion,
  listVersions,
  pickRegistry,
  resetRegistryCache,
  findSystemDsh,
  resolveDsh,
  primeGlobalPrefix,
} from './dsh.mjs'
import { resolveRuntime, runtimeState, clearRuntimeCache, logToolchain } from './runtime.mjs'
import { start, stop, currentState } from './server.mjs'
import { findExternalDsh, killExternalDsh, waitPortFree } from './external.mjs'
import { buildUpgradePlan, applyUpgradePlan, removeProfileConfig, uninstallProfilePlugins } from './plugins.mjs'
import { ensureShellEnv } from './shellenv.mjs'
import { compareVersions, parseVersion } from './semver.mjs'
import { mainT } from './i18n.mjs'
import { reportLaunch, checkUpdate, canOpenExternally, SITE_URL, GITHUB_URL, DEVELOPER } from './telemetry.mjs'

const THEMES = ['light', 'dark']
const LANGS = ['zh', 'en']

/** Language: an explicit user choice wins, otherwise infer from the system locale (zh always means Simplified). */
function resolveLang() {
  const stored = readSettings().lang
  if (LANGS.includes(stored)) return stored
  return String(app.getLocale()).toLowerCase().startsWith('zh') ? 'zh' : 'en'
}
/**
 * Launch at login is delegated to the OS login item. It only makes sense for the
 * packaged app: in development the login item would point at the Electron binary.
 * Linux has no Electron-native equivalent here, so the switch stays disabled.
 */
function autoLaunchSupported() {
  return app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32')
}

function readAutoLaunch() {
  if (!autoLaunchSupported()) return { supported: false, enabled: false }
  try {
    return { supported: true, enabled: Boolean(app.getLoginItemSettings().openAtLogin) }
  } catch {
    return { supported: true, enabled: false }
  }
}

let mainWindow = null
let registry = null
let latestCache = { value: null, at: 0 }
let task = null
let external = null
let quitting = false
let readyToQuit = false
let shuttingDown = false
let quitConfirmed = false

function broadcast(event) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:event', event)
}

/** Refresh the "DSH started another way" detection result; returns whether it changed. */
async function refreshExternal() {
  if (currentState().running) {
    const changed = external !== null
    external = null
    return changed
  }
  const found = await findExternalDsh(readSettings().port)
  const next = found ? { pid: found.pid, port: found.port, url: found.url } : null
  const changed = JSON.stringify(next) !== JSON.stringify(external)
  external = next
  return changed
}

async function buildState() {
  await resolveRuntime()
  const runtime = runtimeState()
  const system = findSystemDsh()
  const resolved = resolveDsh()
  const version = resolved?.version ?? null
  const live = currentState()
  let status = 'not-installed'
  if (task) status = task
  else if (live.running) status = 'running'
  else if (external) status = 'external'
  else if (version) status = 'stopped'
  return {
    status,
    external,
    targetPort: readSettings().port,
    dshVersion: version,
    dshSource: resolved?.source ?? null,
    systemDshVersion: system?.version ?? null,
    latestVersion: latestCache.value,
    port: live.port,
    url: live.url,
    pid: live.pid,
    runtime: runtime.runtime,
    nodeVersion: runtime.nodeVersion,
    npmVersion: runtime.npmVersion,
    theme: THEMES.includes(readSettings().theme) ? readSettings().theme : 'dark',
    lang: resolveLang(),
    busy: task !== null,
  }
}

async function emitState() {
  const state = await buildState()
  broadcast({ type: 'state', state })
  return state
}

async function withTask(name, fn) {
  if (task) throw new Error(mainT(resolveLang(), 'msg.busy'))
  task = name
  await emitState()
  try {
    return await fn()
  } finally {
    task = null
    clearRuntimeCache()
    await emitState()
  }
}

async function refreshLatest(force = false) {
  const fresh = force || Date.now() - latestCache.at > 10 * 60 * 1000
  if (!fresh) return latestCache.value
  registry = registry ?? (await pickRegistry())
  const value = await latestVersion(registry)
  if (value) latestCache = { value, at: Date.now() }
  return latestCache.value
}

function createWindow() {
  const savedTheme = readSettings().theme
  const theme = THEMES.includes(savedTheme) ? savedTheme : 'dark'
  nativeTheme.themeSource = theme
  mainWindow = new BrowserWindow({
    width: 468,
    height: 520,
    minWidth: 440,
    minHeight: 520,
    maximizable: false,
    fullscreenable: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 19 },
    title: 'DSH 就位',
    backgroundColor: theme === 'dark' ? '#121211' : '#f7f6f3',
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  mainWindow.loadFile(join(import.meta.dirname, '..', 'renderer', 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    mainWindow.hide()
    push('窗口已隐藏，DSH 继续运行；点 Dock 图标可重新打开，点界面「退出」结束程序')
  })
  mainWindow.on('closed', () => { mainWindow = null })
}

onLine((line) => broadcast({ type: 'log', line }))

ipcMain.handle('state:get', async () => {
  // Return local state for the first screen first; the registry latest version is fetched in the background and pushed later.
  const before = latestCache.value
  void refreshLatest()
    .then((value) => (value && value !== before ? emitState() : null))
    .catch(() => null)
  return buildState()
})

ipcMain.handle('versions:list', async () => {
  try {
    registry = registry ?? (await pickRegistry())
    return await listVersions(registry)
  } catch (error) {
    return { latest: latestCache.value, versions: [], error: error.message }
  }
})

ipcMain.handle('dsh:install', async (_event, version) => {
  try {
    await withTask('installing', async () => {
      await installDsh(version)
      latestCache = { value: null, at: 0 }
      await refreshLatest(true).catch(() => null)
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error.message }
  }
})

ipcMain.handle('upgrade:plan', async (_event, version) => {
  try {
    const resolved = resolveDsh()
    if (!resolved) return { ok: false, message: mainT(resolveLang(), 'msg.notInstalled') }
    registry = registry ?? (await pickRegistry())

    const wanted = String(version ?? '').trim()
    let target = parseVersion(wanted) ? wanted : null
    if (!target) {
      const list = await listVersions(registry).catch(() => null)
      target = list?.latest ?? latestCache.value ?? null
      if (target) latestCache = { value: target, at: Date.now() }
    }
    if (!target) return { ok: false, message: mainT(resolveLang(), 'msg.noTarget') }
    if (compareVersions(target, resolved.version) <= 0) {
      return { ok: false, message: mainT(resolveLang(), 'msg.targetTooLow', { current: resolved.version }) }
    }

    const plan = await buildUpgradePlan({
      registry,
      targetDsh: target,
      currentDsh: resolved.version,
      dshSource: resolved.source,
    })
    return { ok: true, plan }
  } catch (error) {
    return { ok: false, message: error.message }
  }
})

ipcMain.handle('upgrade:apply', async (_event, plan) => {
  if (!plan?.targetDsh || !Array.isArray(plan.dshArgs) || !plan.dshArgs.length) {
    return { ok: false, message: mainT(resolveLang(), 'msg.noPlan') }
  }
  try {
    await withTask('upgrading', async () => {
      if (currentState().running) await stop()
      if (external) {
        push('先停止其它方式启动的 DSH')
        await killExternalDsh(external.pid)
        await waitPortFree(external.port)
        external = null
      }
      await applyUpgradePlan(plan)
      latestCache = { value: null, at: 0 }
      await refreshLatest(true).catch(() => null)
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error.message }
  }
})

ipcMain.handle('dsh:uninstall', async () => {
  const localManaged = Boolean(findSystemDsh())
  const running = currentState().running
  const outside = external

  try {
    await withTask('uninstalling', async () => {
      if (running) {
        push('卸载第 1 步：停止 DSH 实例')
        await stop()
      } else if (outside) {
        push('卸载第 1 步：停止其它方式启动的 DSH')
        await killExternalDsh(outside.pid)
        await waitPortFree(outside.port)
        external = null
      }

      push('卸载第 2 步：卸载第三方插件')
      await uninstallProfilePlugins()

      push('卸载第 3 步：清理 profile 配置')
      removeProfileConfig()

      push('用户数据 ~/.dsh（会话、聊天记录、凭据）保留，不参与卸载')

      if (localManaged) {
        push('卸载第 4 步：卸载 DSH 程序本体（npm 默认全局前缀）')
        await uninstallDsh()
      } else {
        push('卸载第 4 步：未检测到全局安装的 DSH，跳过程序卸载')
      }
      push('卸载完成：用户环境里的 Node 与 npm 保持原样，用户数据 ~/.dsh 保留')
    })
    return {
      ok: true,
      message: localManaged ? mainT(resolveLang(), 'msg.uninstalled') : mainT(resolveLang(), 'msg.systemUninstall'),
    }
  } catch (error) {
    return { ok: false, message: error.message }
  }
})

ipcMain.handle('dsh:start', async () => {
  try {
    task = 'starting'
    await emitState()
    const target = await start(readSettings().port)
    return { ok: true, url: target }
  } catch (error) {
    return { ok: false, message: error.message }
  } finally {
    task = null
    await emitState()
  }
})

ipcMain.handle('dsh:stop', async () => {
  try {
    task = 'stopping'
    await emitState()
    if (currentState().running) {
      await stop()
    } else if (external) {
      const target = external
      push(`正在停止其它方式启动的 DSH（PID ${target.pid}，端口 ${target.port}）`)
      await killExternalDsh(target.pid)
      await waitPortFree(target.port)
      push('外部启动的 DSH 已停止')
      external = null
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error.message }
  } finally {
    task = null
    await emitState()
  }
})

ipcMain.handle('dsh:takeover', async () => {
  if (!external) return { ok: false, message: mainT(resolveLang(), 'msg.takeoverNone') }
  const target = external

  try {
    task = 'takingover'
    await emitState()
    push(`接管 DSH：先停止外部进程 PID ${target.pid}`)
    await killExternalDsh(target.pid)
    const freed = await waitPortFree(target.port)
    if (!freed) throw new Error(`端口 ${target.port} 仍被占用，请稍后重试`)
    external = null
    const url = await start(readSettings().port)
    return { ok: true, url }
  } catch (error) {
    return { ok: false, message: error.message }
  } finally {
    task = null
    await emitState()
  }
})

ipcMain.handle('dsh:open', async () => {
  const live = currentState()
  const target = live.openUrl || live.url
  if (!target) return { ok: false, message: mainT(resolveLang(), 'msg.notRunning') }
  push('正在用浏览器打开 DSH')
  await shell.openExternal(target)
  return { ok: true }
})

/** The settings snapshot the settings sheet renders; app:info covers version and auto launch. */
function publicSettings() {
  const settings = readSettings()
  return {
    port: settings.port,
    openInBrowser: settings.openInBrowser,
    telemetry: settings.telemetry,
    autoUpdateCheck: settings.autoUpdateCheck,
    npmRegistry: settings.npmRegistry,
    proxy: settings.proxy,
    dshArgs: settings.dshArgs,
  }
}

ipcMain.handle('settings:get', () => publicSettings())

ipcMain.handle('settings:set', async (_event, patch) => {
  const next = {}
  const dropped = []
  if (patch && typeof patch === 'object') {
    if (typeof patch.openInBrowser === 'boolean') next.openInBrowser = patch.openInBrowser
    if (typeof patch.telemetry === 'boolean') next.telemetry = patch.telemetry
    if (typeof patch.autoUpdateCheck === 'boolean') next.autoUpdateCheck = patch.autoUpdateCheck
    if (NPM_REGISTRIES.includes(patch.npmRegistry)) next.npmRegistry = patch.npmRegistry
    if (typeof patch.proxy === 'string') {
      const raw = patch.proxy.trim()
      if (!raw) {
        next.proxy = '' // An empty field is an explicit "no proxy".
      } else {
        const normalized = normalizeProxy(raw)
        // Invalid input never overwrites a working proxy: report it and keep the old value.
        if (!normalized) return { ok: false, invalid: 'proxy', settings: publicSettings() }
        next.proxy = normalized
      }
    }
    if (typeof patch.dshArgs === 'string') {
      next.dshArgs = patch.dshArgs.trim()
      dropped.push(...parseDshArgs(patch.dshArgs).dropped)
    }
  }

  const before = readSettings()
  writeSettings(next)
  const after = readSettings()

  if (after.npmRegistry !== before.npmRegistry) {
    // The registry is cached process-wide: drop it and re-read the latest version.
    resetRegistryCache()
    latestCache = { value: null, at: 0 }
    push(`npm 源：${after.npmRegistry === 'auto' ? '自动测速' : after.npmRegistry === 'official' ? '官方源' : '国内镜像'}`)
    void refreshLatest(true)
      .then((value) => (value ? emitState() : null))
      .catch(() => null)
  }
  if (after.proxy !== before.proxy) {
    push(after.proxy ? `代理已设置：${after.proxy}（仅 npm 与 DSH 子进程）` : '代理已清除')
  }
  if (after.dshArgs !== before.dshArgs) {
    push(after.dshArgs ? `DSH 附加参数：${after.dshArgs}` : 'DSH 附加参数已清空')
  }
  if (dropped.length) push(`已忽略不可用的参数：${[...new Set(dropped)].join(' ')}`)

  await emitState()
  return { ok: true, settings: publicSettings(), dropped: [...new Set(dropped)] }
})

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  site: SITE_URL,
  github: GITHUB_URL,
  developer: DEVELOPER,
  autoLaunch: readAutoLaunch(),
}))

ipcMain.handle('app:auto-launch', async (_event, enabled) => {
  if (!autoLaunchSupported()) {
    return { ok: false, supported: false, enabled: false, message: mainT(resolveLang(), 'msg.autoLaunchUnsupported') }
  }
  const next = Boolean(enabled)
  try {
    app.setLoginItemSettings({ openAtLogin: next, openAsHidden: false })
  } catch {
    return { ok: false, supported: true, enabled: readAutoLaunch().enabled, message: mainT(resolveLang(), 'msg.autoLaunchFailed') }
  }
  const state = readAutoLaunch()
  push(mainT(resolveLang(), state.enabled ? 'msg.autoLaunchOn' : 'msg.autoLaunchOff'))
  return { ok: true, ...state }
})

ipcMain.handle('app:check-update', async () => checkUpdate({ force: true }))

ipcMain.handle('app:open-external', async (_event, url) => {
  if (!canOpenExternally(url)) return { ok: false }
  await shell.openExternal(String(url))
  return { ok: true }
})

ipcMain.handle('app:quit', async () => {
  quitConfirmed = true
  app.quit()
  return { ok: true }
})

ipcMain.handle('log:get', () => ({ lines: getLines() }))

ipcMain.handle('log:clear', () => {
  clearLines()
  return { ok: true }
})

ipcMain.handle('port:set', async (_event, value) => {
  if (currentState().running) return { ok: false, message: mainT(resolveLang(), 'msg.portFirst') }
  const port = Number(value)
  if (!isValidPort(port)) return { ok: false, message: mainT(resolveLang(), 'msg.portInvalid') }
  writeSettings({ port })
  push(`端口已设置为 ${port}`)
  await refreshExternal()
  await emitState()
  return { ok: true, port }
})

ipcMain.handle('lang:set', async (_event, lang) => {
  const next = LANGS.includes(lang) ? lang : 'system'
  writeSettings({ lang: next })
  await emitState()
  return { ok: true, lang: resolveLang() }
})

ipcMain.handle('theme:set', async (_event, theme) => {
  const next = THEMES.includes(theme) ? theme : 'dark'
  writeSettings({ theme: next })
  nativeTheme.themeSource = next
  return { ok: true, theme: next }
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

app.whenReady().then(async () => {
  ensureDirs()
  push('DSH 就位已启动')
  // The window need not wait for the shell environment: 2.5s at most, and loading is ensured again before starting DSH.
  await Promise.race([
    ensureShellEnv().catch(() => null),
    new Promise((resolve) => setTimeout(resolve, 2500)),
  ])
  // Print the user environment's node/npm at startup, stating clearly whatever is missing.
  await logToolchain()
  await primeGlobalPrefix().catch(() => null)
  createWindow()
  await refreshExternal()
  await emitState()
  // Launch reporting and the daily update check never block the UI: failures stay silent and do not disturb the user.
  void reportLaunch()
  void checkUpdate()
    .then((result) => {
      if (result?.ok && result.hasUpdate) broadcast({ type: 'update-available', ...result })
    })
    .catch(() => null)
  setInterval(async () => {
    if (task) return
    try {
      if (await refreshExternal()) await emitState()
    } catch {
      // Keep the previous result when detection fails.
    }
  }, 4000)
})

app.on('window-all-closed', () => {
  if (readyToQuit) app.quit()
})

app.on('before-quit', (event) => {
  if (readyToQuit) return

  // Intercept until confirmed and hand over to the in-app custom confirm dialog (Cmd+Q / menu quit also land here).
  if (!quitConfirmed) {
    event.preventDefault()
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) mainWindow.show()
      mainWindow.focus()
      mainWindow.webContents.send('dsh:event', { type: 'quit-request' })
    } else {
      quitConfirmed = true
      app.quit()
    }
    return
  }

  event.preventDefault()
  if (shuttingDown) return
  shuttingDown = true
  quitting = true
  void (async () => {
    if (currentState().running) {
      push('退出前停止 DSH')
      try {
        await stop()
      } catch {
        // Try to stop on exit; keep quitting even if that fails.
      }
    }
    readyToQuit = true
    app.quit()
  })()
})

app.on('activate', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})
