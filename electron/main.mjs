import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, shell, Tray } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import {
  readSettings,
  writeSettings,
  ensureDirs,
  isValidPort,
  normalizeProxy,
  parseDshArgs,
  resolveLanguage,
  NPM_REGISTRIES,
  OPEN_TARGETS,
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
import { start, stop, currentState, sleepInhibitor, onAccessUrl } from './server.mjs'
import { findExternalDsh, killExternalDsh, waitPortFree } from './external.mjs'
import { buildUpgradePlan, applyUpgradePlan, removeProfileConfig, uninstallProfilePlugins } from './plugins.mjs'
import { ensureShellEnv } from './shellenv.mjs'
import { compareVersions, parseVersion } from './semver.mjs'
import { mainT } from './i18n.mjs'
import { reportLaunch, checkUpdate, updateCheckDue, canOpenExternally, SITE_URL, GITHUB_URL, DEVELOPER } from './telemetry.mjs'
import { downloadInstaller } from './download.mjs'
import { permissionsSupported, readPermissions, openPermissionSettings } from './permissions.mjs'
import { openAppWindow, syncAppWindow, closeAppWindow } from './appwindow.mjs'

const THEMES = ['light', 'dark']
const LANGS = ['zh', 'en']
/** A failed automatic check retries after this long; a successful one is gated at 24h. */
const UPDATE_RETRY_MS = 60 * 60 * 1000

/** Language: the shared rule (paths.resolveLanguage), fed with Electron's own locale. */
function resolveLang() {
  return resolveLanguage(app.getLocale())
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
let tray = null
let appMenuKey = ''
let registry = null
let latestCache = { value: null, at: 0 }
let task = null
let external = null
let quitting = false
let readyToQuit = false
let shuttingDown = false
let quitConfirmed = false
// The installer download for the version found by the automatic check; the tray keeps it
// after the completion dialog was dismissed.
let pendingUpdate = null
let updateDownloadController = null
let updateDownloadRunning = false
let lastUpdateProgressAt = 0
let nextUpdateAttemptAt = 0
let updateCheckRunning = false

function broadcast(event) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dsh:event', event)
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  // With the Dock icon hidden the app has no regular activation path, so ask macOS
  // to bring us forward explicitly; otherwise the window can open behind other apps.
  // Skip it when the app is already active: the extra activation is what made a tray
  // click look like it stuttered before the launcher even appeared.
  if (app.dock && !app.dock.isVisible() && !app.isActive()) app.focus({ steal: true })
}

/**
 * "Open DSH" hands the screen to the DSH window, so the launcher steps aside instead of
 * sitting behind it. Hiding is not closing: the launcher keeps running, and the tray or
 * Dock icon (at least one always stays available) brings it back.
 */
function hideMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return
  mainWindow.hide()
}

/** macOS only: the Dock icon is a setting, everything else has no concept of it. */
function dockSupported() {
  return process.platform === 'darwin' && Boolean(app.dock)
}

/** macOS only: keeping the machine awake needs `caffeinate`, which only macOS ships. */
function preventSleepSupported() {
  return Boolean(sleepInhibitor())
}

let dockTimer = null

/**
 * Apply the persisted Dock-icon preference. `dock.hide()` is a documented no-op when it
 * runs within a second of a previous call, so re-check once after that window instead of
 * trusting the first attempt (rapid switch toggling otherwise leaves the Dock out of sync).
 */
function applyDockIcon() {
  if (!dockSupported()) return
  const want = Boolean(readSettings().showDock)
  const attempt = () => {
    if (!app.dock || app.dock.isVisible() === want) return
    if (want) void app.dock.show().catch(() => null)
    else app.dock.hide()
  }
  attempt()
  clearTimeout(dockTimer)
  dockTimer = setTimeout(attempt, 1100)
  dockTimer.unref?.()
}

/**
 * A settings file from an older build (or a hand edit) can ask for no tray and no Dock at
 * once, which would leave a running app with no icon anywhere. Repair it on start.
 */
function ensureAccessIcon() {
  if (!dockSupported()) return
  const settings = readSettings()
  if (settings.showTray || settings.showDock) return
  writeSettings({ showTray: true })
  push('托盘图标与 Dock 图标不能同时关闭，已恢复系统托盘图标')
}

/** Menu-bar Quit: straight to before-quit, which stops a managed DSH and exits. */
function requestQuitFromTray() {
  quitConfirmed = true
  app.quit()
}

/**
 * The menu bar wants a monochrome template image at 18pt (with a @2x companion that
 * nativeImage picks up from the same path); the colour app icon shrunk to 16px is unreadable,
 * so it stays as the fallback only. Windows keeps the colour icon, downscaled as before.
 */
function trayIcon() {
  const assets = join(import.meta.dirname, '..', 'renderer', 'assets')
  if (process.platform === 'darwin') {
    // No resize(): it would drop the @2x representation and leave a 1x bitmap to be upscaled.
    const template = nativeImage.createFromPath(join(assets, 'trayTemplate.png'))
    if (!template.isEmpty()) {
      template.setTemplateImage(true)
      return template
    }
  }
  return nativeImage
    .createFromPath(join(assets, 'app-icon.png'))
    .resize({ width: 16, height: 16 })
}

/**
 * The token URL is printed a moment after DSH is ready. Give it a short grace period so
 * "Open DSH" does not normally open the bare localhost URL, but still fall back to it.
 */
async function accessUrl() {
  const deadline = Date.now() + 2500
  while (Date.now() < deadline) {
    const live = currentState()
    if (live.openUrl) return live.openUrl
    if (!live.running) return null
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  const live = currentState()
  return live.openUrl || live.url
}

/**
 * Open the running DSH using the persisted "打开方式". The button and the tray menu both
 * land here, so the setting cannot drift between two entry points.
 *
 * Either target takes over the screen, so the launcher hides itself once the hand-off
 * succeeds instead of lingering behind the DSH window or the browser.
 */
async function openDsh() {
  const target = await accessUrl()
  if (!target) return { ok: false, message: mainT(resolveLang(), 'msg.notRunning') }

  if (readSettings().openTarget === 'browser') {
    push('正在用浏览器打开 DSH')
    try {
      await shell.openExternal(target)
      hideMainWindow()
      return { ok: true, target: 'browser' }
    } catch (error) {
      return { ok: false, message: error.message }
    }
  }

  push('正在打开 DSH 窗口')
  try {
    if (!openAppWindow(target)) return { ok: false, message: mainT(resolveLang(), 'msg.notRunning') }
    hideMainWindow()
    return { ok: true, target: 'app' }
  } catch (error) {
    return { ok: false, message: error.message }
  }
}

/**
 * The "app as the primary surface" rule shared by the tray, Dock and a second launch:
 * while DSH runs with the app-window target, go straight to that window and leave the
 * launcher alone. Browser mode, a stopped service or a missing token fall back to the
 * launcher; the tray menu's "Show main window" is always the explicit escape hatch.
 */
function openPreferredSurface() {
  const live = currentState()
  const target = live.openUrl || live.url
  if (!live.running || readSettings().openTarget !== 'app' || !target) return false
  try {
    openAppWindow(target)
    return true
  } catch (error) {
    push(`打开 DSH 窗口失败：${error.message}`)
    return false
  }
}

function trayClick() {
  if (!openPreferredSurface()) showMainWindow()
}

/** The tray menu, rebuilt on every sync so its labels and enabled state stay current. */
function trayMenu() {
  const live = currentState()
  const running = Boolean(live.openUrl || live.url)
  const lang = resolveLang()
  const template = [
    { label: mainT(lang, 'tray.openDsh'), enabled: running, click: () => { void openDsh() } },
    { label: mainT(lang, 'tray.showMain'), click: showMainWindow },
    { type: 'separator' },
  ]
  // The menu is the one permanent place a background app can keep an update after the
  // completion dialog was dismissed; clicking it starts the download or reopens the dialog.
  if (pendingUpdate) {
    const update = pendingUpdate
    const ready = update.status === 'ready' && Boolean(update.path) && existsSync(update.path)
    template.push({
      label: mainT(lang, ready ? 'tray.installUpdate' : 'tray.updateAvailable', { version: update.latest }),
      click: () => {
        showMainWindow()
        if (pendingUpdate?.status === 'ready' && pendingUpdate.path && existsSync(pendingUpdate.path)) {
          broadcastUpdateReady()
        } else {
          void startUpdateDownload()
          // Reopen the progress panel even after "background"/cancel; the renderer had
          // dismissed it, and this click is an explicit request to see it again.
          broadcast({ type: 'update-progress-show', latest: update.latest })
        }
      },
    })
    template.push({ type: 'separator' })
  }
  template.push({ label: mainT(lang, 'tray.quit'), click: requestQuitFromTray })
  return Menu.buildFromTemplate(template)
}

/** Rebuild the attached menu on Windows/Linux; macOS builds it fresh on right-click. */
function syncTrayMenu() {
  if (!tray || process.platform === 'darwin') return
  tray.setContextMenu(trayMenu())
}

/** Keep one native notification-area/menu-bar icon in sync with the persisted setting. */
function syncTray() {
  if (!readSettings().showTray) {
    tray?.destroy()
    tray = null
    return
  }
  if (!tray) {
    tray = new Tray(trayIcon())
    // One click on the whale always brings the window back — no double-click handler.
    tray.on('click', trayClick)
    // macOS pops an attached menu on *any* click, which would swallow that first click,
    // so there the menu is bound to the right button only and pushed manually.
    if (process.platform === 'darwin') tray.on('right-click', () => tray.popUpContextMenu(trayMenu()))
  }
  tray.setToolTip(resolveLang() === 'zh' ? 'DSH 就位' : 'DSH Ready')
  if (process.platform !== 'darwin') syncTrayMenu()
}

/** The startup check can finish while the launcher page is still loading. */
function broadcastWhenReady(event) {
  const send = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    broadcast(event)
  }
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.isLoadingMainFrame()) {
    mainWindow.webContents.once('did-finish-load', send)
  } else {
    send()
  }
}

/** Ask the renderer to show the completion dialog (also used by the tray after "later"). */
function broadcastUpdateReady() {
  const update = pendingUpdate
  if (!update || update.status !== 'ready' || !update.path) return
  broadcastWhenReady({
    type: 'update-downloaded',
    latest: update.latest,
    name: update.file?.name ?? '',
    size: update.size || update.file?.size || 0,
  })
}

function cancelUpdateDownload() {
  if (updateDownloadController) {
    updateDownloadController.abort()
    updateDownloadController = null
  }
  if (pendingUpdate?.status === 'downloading') pendingUpdate.status = 'idle'
}

/**
 * Fetch the installer in parallel ranges into the Downloads folder. The launcher is often
 * hidden while DSH runs: progress is broadcast for the window, the download keeps going in
 * the background, and the completion dialog is what brings the window forward.
 */
async function startUpdateDownload() {
  const update = pendingUpdate
  if (!update?.file || quitting || shuttingDown) return
  if (updateDownloadRunning) return
  if (update.status === 'downloading') return
  if (update.status === 'ready') {
    if (update.path && existsSync(update.path)) return
    // The file was removed after "later": download it again instead of offering a dead path.
    update.status = 'idle'
    update.path = null
    syncTrayMenu()
  }
  updateDownloadRunning = true
  update.status = 'downloading'
  update.received = 0
  update.error = ''
  lastUpdateProgressAt = 0
  syncTrayMenu()
  broadcast({ type: 'update-progress', latest: update.latest, received: 0, total: update.file.size, percent: 0 })
  const controller = new AbortController()
  updateDownloadController = controller
  const onProgress = (received, total) => {
    update.received = received
    const now = Date.now()
    if (now - lastUpdateProgressAt < 200 && received < total) return
    lastUpdateProgressAt = now
    broadcast({
      type: 'update-progress',
      latest: update.latest,
      received,
      total,
      percent: total ? Math.min(99, Math.floor((received / total) * 100)) : 0,
    })
  }
  try {
    const result = await downloadInstaller({
      ...update.file,
      signal: controller.signal,
      onProgress,
    })
    if (pendingUpdate !== update) return
    update.path = result.path
    update.size = result.bytes
    update.status = 'ready'
    syncTrayMenu()
    broadcastUpdateReady()
    showMainWindow()
  } catch (error) {
    if (pendingUpdate !== update) return
    if (controller.signal.aborted) {
      update.status = 'idle'
      return
    }
    update.status = 'failed'
    update.error = error.message
    push(`更新下载失败：${error.message}`)
    broadcast({ type: 'update-download-failed', latest: update.latest, message: error.message })
    syncTrayMenu()
  } finally {
    if (updateDownloadController === controller) updateDownloadController = null
    updateDownloadRunning = false
  }
}

/**
 * Surface the result of an update check. A new version is downloaded immediately; the tray
 * carries it while the download runs, and the completion dialog appears once the verified
 * installer sits in Downloads. A platform without a published installer gets an in-app
 * notice — nothing opens a browser.
 */
function publishUpdate(result) {
  if (!result?.ok) return
  if (!result.hasUpdate) {
    cancelUpdateDownload()
    if (pendingUpdate) {
      pendingUpdate = null
      syncTrayMenu()
    }
    return
  }
  if (quitting || shuttingDown) return
  if (!result.file) {
    push(`新版本 v${result.latest}：当前平台没有可直接下载的安装包`)
    broadcastWhenReady({ type: 'update-unsupported', latest: result.latest })
    return
  }

  if (pendingUpdate?.latest !== result.latest) {
    cancelUpdateDownload()
    pendingUpdate = {
      latest: result.latest,
      current: result.current,
      file: result.file,
      status: 'idle',
      path: null,
      size: result.file.size,
      received: 0,
      error: '',
    }
    syncTrayMenu()
    push(`发现新版本：${result.latest}（当前 ${result.current}）`)
    broadcastWhenReady({
      type: 'update-available',
      latest: result.latest,
      current: result.current,
      size: result.file.size,
    })
  } else if (pendingUpdate.status !== 'ready') {
    // A republished manifest can update the size/digest; a finished file stays as is.
    pendingUpdate.file = result.file
  }
  void startUpdateDownload()
}

/**
 * The automatic check. Called from the 4s poll as well as at startup, so an app that never
 * quits still notices a release: the 24h gate lives in telemetry (`updateCheckDue`), and a
 * failed attempt retries an hour later instead of burning the day or hammering the site.
 */
async function autoUpdateCheck() {
  if (task || updateCheckRunning || quitting || shuttingDown) return
  const now = Date.now()
  if (now < nextUpdateAttemptAt) return
  if (!updateCheckDue(now)) return
  updateCheckRunning = true
  try {
    const result = await checkUpdate()
    if (!result?.ok) nextUpdateAttemptAt = Date.now() + UPDATE_RETRY_MS
    publishUpdate(result)
  } catch {
    nextUpdateAttemptAt = Date.now() + UPDATE_RETRY_MS
  } finally {
    updateCheckRunning = false
  }
}

/**
 * The application menu follows the app's own language setting, not the OS locale, so the
 * menu bar speaks the same language as the window. "Open DSH" is disabled until a token URL
 * exists; "Open main window" is always available as the escape hatch.
 */
function buildAppMenu(lang, running) {
  const t = (key) => mainT(lang, key)
  const isMac = process.platform === 'darwin'
  const openMain = { id: 'open-main', label: t('menu.openMain'), click: showMainWindow }
  const openDshItem = {
    id: 'open-dsh',
    label: t('menu.openDsh'),
    enabled: running,
    click: () => { void openDsh() },
  }

  const first = isMac
    ? {
        label: t('menu.appName'),
        submenu: [
          { role: 'about', label: t('menu.about') },
          { type: 'separator' },
          openMain,
          openDshItem,
          { type: 'separator' },
          { role: 'services', label: t('menu.services'), submenu: [] },
          { type: 'separator' },
          { role: 'hide', label: t('menu.hide') },
          { role: 'hideOthers', label: t('menu.hideOthers') },
          { role: 'unhide', label: t('menu.showAll') },
          { type: 'separator' },
          { role: 'quit', label: t('menu.quit') },
        ],
      }
    : {
        label: t('menu.file'),
        submenu: [
          openMain,
          openDshItem,
          { type: 'separator' },
          { role: 'close', label: t('menu.closeWindow') },
          { type: 'separator' },
          { role: 'quit', label: t('menu.quit') },
        ],
      }

  const file = isMac
    ? { label: t('menu.file'), submenu: [{ role: 'close', label: t('menu.closeWindow') }] }
    : null

  const edit = {
    label: t('menu.edit'),
    submenu: [
      { role: 'undo', label: t('menu.undo') },
      { role: 'redo', label: t('menu.redo') },
      { type: 'separator' },
      { role: 'cut', label: t('menu.cut') },
      { role: 'copy', label: t('menu.copy') },
      { role: 'paste', label: t('menu.paste') },
      { role: 'selectAll', label: t('menu.selectAll') },
    ],
  }

  const view = {
    label: t('menu.view'),
    submenu: [
      { role: 'reload', label: t('menu.reload') },
      { role: 'forceReload', label: t('menu.forceReload') },
      { role: 'toggleDevTools', label: t('menu.devTools') },
      { type: 'separator' },
      { role: 'resetZoom', label: t('menu.resetZoom') },
      { role: 'zoomIn', label: t('menu.zoomIn') },
      { role: 'zoomOut', label: t('menu.zoomOut') },
      { type: 'separator' },
      { role: 'togglefullscreen', label: t('menu.fullscreen') },
    ],
  }

  const windowMenu = {
    label: t('menu.window'),
    submenu: [
      { role: 'minimize', label: t('menu.minimize') },
      ...(isMac
        ? [
            { role: 'zoom', label: t('menu.zoom') },
            { type: 'separator' },
            { role: 'front', label: t('menu.front') },
          ]
        : []),
    ],
  }

  const help = isMac
    ? null
    : { label: t('menu.help'), submenu: [{ role: 'about', label: t('menu.about') }] }

  return Menu.buildFromTemplate([
    first,
    ...(file ? [file] : []),
    edit,
    view,
    windowMenu,
    ...(help ? [help] : []),
  ])
}

function syncAppMenu() {
  const lang = resolveLang()
  const live = currentState()
  const running = Boolean(live.openUrl || live.url)
  const key = `${lang}:${running ? 1 : 0}`
  if (key === appMenuKey) return
  appMenuKey = key
  Menu.setApplicationMenu(buildAppMenu(lang, running))
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
  // The app window is a view, not part of the service state machine: keep its title and
  // token URL in step here, and never close it because DSH stopped.
  const live = currentState()
  syncAppWindow({ running: Boolean(live.running), openUrl: live.openUrl })
  syncTrayMenu()
  syncAppMenu()
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
    width: 520,
    height: 600,
    minWidth: 480,
    minHeight: 560,
    maximizable: false,
    fullscreenable: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 19 },
    title: 'DSH 就位',
    backgroundColor: theme === 'dark' ? '#121211' : '#f7f6f3',
    show: false,
    acceptFirstMouse: true,
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

// The token URL is printed a moment after the process starts and disappears when it exits.
// React immediately: the app window must reload the new token without waiting for a state tick.
onAccessUrl(() => {
  const live = currentState()
  syncAppWindow({ running: Boolean(live.running), openUrl: live.openUrl })
  syncTrayMenu()
  syncAppMenu()
  void emitState()
})

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

async function runUpgrade(plan) {
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
}

ipcMain.handle('upgrade:apply', async (_event, plan) => {
  if (!plan?.targetDsh || !Array.isArray(plan.dshArgs) || !plan.dshArgs.length) {
    return { ok: false, message: mainT(resolveLang(), 'msg.noPlan') }
  }
  try {
    await runUpgrade(plan)
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error.message }
  }
})

ipcMain.handle('upgrade:force', async (_event, plan) => {
  if (!plan?.targetDsh || !Array.isArray(plan.dshArgs) || !plan.dshArgs.length) {
    return { ok: false, message: mainT(resolveLang(), 'msg.noPlan') }
  }
  if (!plan.forceable || !Array.isArray(plan.incompatible) || !plan.incompatible.length) {
    return { ok: false, message: mainT(resolveLang(), 'msg.noForce') }
  }
  try {
    await runUpgrade({ ...plan, force: true })
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
    // DSH is gone; leaving an app window pointing at a dead service is just a zombie.
    closeAppWindow()
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

/**
 * Restart the app-managed instance in place, so a launch-time setting ("prevent idle
 * sleep", later the proxy or launch arguments) can take effect without a trip to Stop.
 */
ipcMain.handle('dsh:restart', async () => {
  if (task) return { ok: false, message: mainT(resolveLang(), 'msg.busy') }
  try {
    task = 'restarting'
    await emitState()
    if (currentState().running) {
      await stop()
    } else if (external) {
      push('重启前先停止其它方式启动的 DSH')
      await killExternalDsh(external.pid)
      await waitPortFree(external.port)
      external = null
    }
    const url = await start(readSettings().port)
    return { ok: true, url }
  } catch (error) {
    return { ok: false, message: error.message }
  } finally {
    task = null
    await emitState()
  }
})

ipcMain.handle('dsh:open', () => openDsh())

/** The settings snapshot the settings sheet renders; app:info covers version and auto launch. */
function publicSettings() {
  const settings = readSettings()
  return {
    port: settings.port,
    openTarget: settings.openTarget,
    showTray: settings.showTray,
    showDock: settings.showDock,
    preventSleep: settings.preventSleep,
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
    if (OPEN_TARGETS.includes(patch.openTarget)) next.openTarget = patch.openTarget
    if (typeof patch.showTray === 'boolean') next.showTray = patch.showTray
    if (typeof patch.showDock === 'boolean') next.showDock = patch.showDock
    // The switch only exists on macOS; other platforms refuse the write instead of storing
    // a value nothing reads.
    if (typeof patch.preventSleep === 'boolean' && preventSleepSupported()) next.preventSleep = patch.preventSleep
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
  const after = { ...before, ...next }
  // Tray and Dock are the only ways back to a hidden launcher, so the second "off" is
  // refused instead of leaving a running app with no icon anywhere.
  if (dockSupported() && !after.showTray && !after.showDock) {
    return {
      ok: false,
      blocked: 'accessIcons',
      message: mainT(resolveLang(), 'msg.keepAccessIcon'),
      settings: publicSettings(),
    }
  }
  writeSettings(next)

  if (after.showTray !== before.showTray) syncTray()
  if (after.showDock !== before.showDock) applyDockIcon()

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

  // "Prevent idle sleep" is applied when DSH is spawned, so a running instance has to be
  // restarted for the change to take effect. The renderer asks; declining reverts the write.
  const sleepChanged = after.preventSleep !== before.preventSleep
  if (sleepChanged) {
    push(after.preventSleep ? '已开启「阻止空闲休眠」（重启 DSH 后生效）' : '已关闭「阻止空闲休眠」（重启 DSH 后生效）')
  }

  await emitState()
  return {
    ok: true,
    settings: publicSettings(),
    dropped: [...new Set(dropped)],
    restartRequired: sleepChanged && currentState().running,
  }
})

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  site: SITE_URL,
  github: GITHUB_URL,
  developer: DEVELOPER,
  autoLaunch: readAutoLaunch(),
  dock: { supported: dockSupported() },
  preventSleep: { supported: preventSleepSupported() },
  permissions: { supported: permissionsSupported() },
}))

/**
 * System-permission checks (macOS only, see permissions.mjs). Reads are silent and cheap, so
 * the sheet may call them on every open and every time the window regains focus.
 */
ipcMain.handle('perm:read', () => readPermissions())

/** Deep-link into the matching Privacy & Security pane; System Settings takes the foreground. */
ipcMain.handle('perm:open', async (_event, id) => {
  const result = await openPermissionSettings(String(id ?? ''))
  // The click is the only feedback this action has, so a refusal has to reach the log panel.
  if (!result.ok) push(`打开系统设置失败：${id}`)
  return result
})

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

ipcMain.handle('app:check-update', async () => {
  const result = await checkUpdate({ force: true })
  if (!result?.ok) {
    // The sheet shows a reason too, but the log keeps the evidence (error code / HTTP status).
    const detail = [result?.reason, result?.status ? `HTTP ${result.status}` : '', result?.detail || '']
      .filter(Boolean)
      .join(' ')
    push(`检查更新失败：${detail || '未知原因'}`)
    return result
  }
  if (result.hasUpdate) {
    publishUpdate(result)
    // A manual check is also the way back to the dialog after "later".
    if (pendingUpdate?.status === 'ready') {
      showMainWindow()
      broadcastUpdateReady()
    } else if (pendingUpdate?.status === 'downloading') {
      broadcast({ type: 'update-progress-show', latest: pendingUpdate.latest })
    }
  }
  return result
})

ipcMain.handle('update:cancel', () => {
  const latest = pendingUpdate?.latest ?? ''
  cancelUpdateDownload()
  broadcast({ type: 'update-cancelled', latest })
  return { ok: true }
})

/** Open the downloaded installer with the OS (dmg → mounted, exe → NSIS). */
ipcMain.handle('update:install', async () => {
  const update = pendingUpdate
  if (!update?.path || update.status !== 'ready') {
    return { ok: false, message: mainT(resolveLang(), 'msg.updateMissing') }
  }
  const error = await shell.openPath(update.path).catch((err) => err.message)
  if (error) return { ok: false, message: error }
  push(`已打开更新安装包：${update.path}`)
  return { ok: true }
})

ipcMain.handle('update:show-file', () => {
  if (!pendingUpdate?.path) return { ok: false }
  shell.showItemInFolder(pendingUpdate.path)
  return { ok: true }
})

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
  syncTray()
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
    if (!openPreferredSurface()) showMainWindow()
  })
}

app.whenReady().then(async () => {
  ensureDirs()
  ensureAccessIcon()
  applyDockIcon()
  syncAppMenu()
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
  syncTray()
  await refreshExternal()
  await emitState()
  // Launch reporting and the daily update check never block the UI: failures stay silent and do not disturb the user.
  void reportLaunch()
  void autoUpdateCheck()
  setInterval(async () => {
    // The same poll that watches for an external DSH also carries the daily update gate:
    // a long-running app must not stop hearing about new releases.
    void autoUpdateCheck()
    if (task) return
    try {
      const wasRunning = currentState().running
      const changed = await refreshExternal()
      // A crashed/exited DSH has to reach the UI too; external-instance changes alone
      // would leave the button and the app-window title saying "running".
      if (changed || currentState().running !== wasRunning) await emitState()
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

  // Quitting is not a decision to confirm: the header button, Cmd+Q and the menu-bar entry all
  // end here and exit directly. A managed DSH is stopped on the way out (see below), which is
  // the only consequence worth knowing — the sheet showed it, a dialog only blocked the exit.
  quitConfirmed = true
  event.preventDefault()
  if (shuttingDown) return
  shuttingDown = true
  quitting = true
  cancelUpdateDownload()
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
  // Dock activation follows the app-window target: a running DSH with the app target
  // opens/focuses that window; browser mode or a stopped service shows the launcher.
  if (!openPreferredSurface()) showMainWindow()
})
