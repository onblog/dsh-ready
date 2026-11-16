import { app, BrowserWindow, screen, shell } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { USER_DATA, readSettings, resolveLanguage } from './paths.mjs'
import { mainT } from './i18n.mjs'
import { push } from './logger.mjs'

/**
 * The DSH app window: one BrowserWindow that loads the token URL DSH prints at startup.
 *
 * It is deliberately independent from the launcher window and from the DSH process:
 * closing it only closes the view, stopping DSH leaves it in place (with a "· 已停止"
 * title), and starting DSH again reloads the new token URL when it differs.
 */

const STATE_FILE = join(USER_DATA, 'app-window.json')
const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 860
const MIN_WIDTH = 900
const MIN_HEIGHT = 600
const HIDDEN_TITLEBAR = process.platform === 'darwin'

/**
 * macOS draws the traffic lights over the web content when the title bar is hidden.
 * DSH's sidebar has its brand row exactly there, so shift the wordmark clear of the
 * controls, hide the whale mark they replace, and turn the web header into a drag area.
 * The class suffixes survive the CSS-module hashing; if DSH renames them the rules simply
 * stop applying instead of breaking the page.
 */
const MAC_TITLEBAR_CSS = `
  [class*="logoRow"] { -webkit-app-region: drag; }
  [class*="logoRow"] button { -webkit-app-region: no-drag; }
  button[class*="brand"] { -webkit-app-region: no-drag; }
  body.dsh-titlebar-inset button[class*="brand"] {
    width: 158px;
    margin-left: 62px;
  }
  body.dsh-titlebar-inset [class*="brandMark"] { display: none !important; }
  body.dsh-titlebar-inset [class*="brandIdentity"] { width: auto; }

  header { -webkit-app-region: drag; }
  header a, header button, header input, header textarea, header select,
  header [role="button"], header [tabindex]:not([tabindex="-1"]),
  header [aria-haspopup], header [contenteditable="true"] { -webkit-app-region: no-drag; }
`

let appWindow = null
let baseTitle = 'DSH'
let stopped = false
let lastLoadedUrl = null
let boundsTimer = null
let downloadsWired = false

function readWindowState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    return raw && typeof raw === 'object' ? raw : null
  } catch {
    return null
  }
}

/** Bounds are a convenience: never let an I/O error break the window itself. */
function writeWindowState(win) {
  if (!win || win.isDestroyed()) return
  try {
    const normal = typeof win.getNormalBounds === 'function' ? win.getNormalBounds() : win.getBounds()
    writeFileSync(
      STATE_FILE,
      `${JSON.stringify(
        {
          x: normal.x,
          y: normal.y,
          width: normal.width,
          height: normal.height,
          maximized: win.isMaximized(),
        },
        null,
        2,
      )}\n`,
    )
  } catch {
    // Keep going: the next launch just gets the default geometry.
  }
}

/**
 * Restore the last geometry, clamped to the display it belongs to. Without the clamp a
 * window saved on a monitor that is now gone would open off-screen.
 */
function resolveBounds() {
  const saved = readWindowState()
  const width = Number(saved?.width)
  const height = Number(saved?.height)
  const x = Number(saved?.x)
  const y = Number(saved?.y)
  const target = {
    width: Number.isFinite(width) && width > 0 ? width : DEFAULT_WIDTH,
    height: Number.isFinite(height) && height > 0 ? height : DEFAULT_HEIGHT,
    x: Number.isFinite(x) ? x : null,
    y: Number.isFinite(y) ? y : null,
  }
  const display = screen.getDisplayMatching({
    x: target.x ?? 0,
    y: target.y ?? 0,
    width: target.width,
    height: target.height,
  })
  const area = display.workArea
  const nextWidth = Math.round(Math.min(Math.max(target.width, MIN_WIDTH), Math.max(MIN_WIDTH, area.width - 24)))
  const nextHeight = Math.round(Math.min(Math.max(target.height, MIN_HEIGHT), Math.max(MIN_HEIGHT, area.height - 24)))
  let nextX = target.x ?? area.x + Math.round((area.width - nextWidth) / 2)
  let nextY = target.y ?? area.y + Math.round((area.height - nextHeight) / 2)
  // Keep a usable strip of the window on that display.
  nextX = Math.min(Math.max(nextX, area.x - nextWidth + 160), area.x + area.width - 160)
  nextY = Math.min(Math.max(nextY, area.y), area.y + area.height - 120)
  return { x: nextX, y: nextY, width: nextWidth, height: nextHeight, maximized: Boolean(saved?.maximized) }
}

function applyTitle() {
  if (!appWindow || appWindow.isDestroyed()) return
  const suffix = stopped ? ` · ${mainT(resolveLanguage(app.getLocale()), 'window.stopped')}` : ''
  appWindow.setTitle(`${baseTitle || 'DSH'}${suffix}`)
}

function bringToFront(win) {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  // With the Dock icon hidden macOS has no regular activation path; ask explicitly.
  if (process.platform === 'darwin' && app.dock && !app.dock.isVisible()) app.focus({ steal: true })
}

function isSameOrigin(url) {
  try {
    const target = new URL(String(url))
    const base = new URL(lastLoadedUrl || 'http://127.0.0.1')
    return target.protocol === 'http:' && target.host === base.host
  } catch {
    return false
  }
}

function openExternally(url) {
  const value = String(url)
  if (/^(https?|mailto):/i.test(value)) void shell.openExternal(value).catch(() => null)
}

function wireNavigation(win) {
  const { webContents } = win
  // Anything DSH wants to open in a new window belongs to the user's real browser, not to a
  // second, unmanaged Electron window we would have to parent and close.
  webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url)
    return { action: 'deny' }
  })
  webContents.on('will-navigate', (event, url) => {
    if (isSameOrigin(url)) return
    event.preventDefault()
    openExternally(url)
  })
  // A server-side redirect must not be able to walk the window off the local origin either.
  webContents.on('will-redirect', (event, url) => {
    if (isSameOrigin(url)) return
    event.preventDefault()
    openExternally(url)
  })
  webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    // -3 is ERR_ABORTED: the normal result of a superseded navigation, not a failure.
    if (!isMainFrame || code === -3) return
    push(`DSH 窗口加载失败：${description}（${code}）`)
    if (!win.isVisible()) bringToFront(win)
  })
}

/**
 * Downloads go to the OS Downloads folder without a native save dialog (this app draws its
 * own UI and never uses native pickers). A numeric suffix keeps repeated names apart.
 */
function wireDownloads(session) {
  if (downloadsWired) return
  downloadsWired = true
  session.on('will-download', (_event, item) => {
    try {
      const dir = app.getPath('downloads')
      const name = basename(item.getFilename() || 'download')
      const dot = name.lastIndexOf('.')
      const stem = dot > 0 ? name.slice(0, dot) : name
      const ext = dot > 0 ? name.slice(dot) : ''
      let target = join(dir, name)
      for (let index = 1; existsSync(target); index += 1) target = join(dir, `${stem}-${index}${ext}`)
      item.setSavePath(target)
      item.once('done', (_doneEvent, status) => {
        push(status === 'completed' ? `文件已保存：${target}` : `下载未完成：${name}（${status}）`)
      })
    } catch (error) {
      push(`下载失败：${error.message}`)
    }
  })
}

/** Re-apply the title-bar CSS after every document load (a DSH restart replaces it). */
function wireTitleBar(win) {
  if (!HIDDEN_TITLEBAR) return
  const inject = () => {
    if (win.isDestroyed()) return
    void win.webContents.insertCSS(MAC_TITLEBAR_CSS).catch(() => null)
  }
  // The traffic lights disappear in fullscreen; drop the reserved inset so the wordmark
  // returns to its normal place, and put it back when the window leaves fullscreen.
  const applyInset = (inset = !win.isFullScreen()) => {
    if (win.isDestroyed()) return
    void win.webContents
      .executeJavaScript(`document.body.classList.toggle('dsh-titlebar-inset', ${inset})`)
      .catch(() => null)
  }
  win.webContents.on('dom-ready', () => {
    inject()
    applyInset()
  })
  win.webContents.on('did-finish-load', inject)
  win.on('enter-full-screen', () => applyInset(false))
  win.on('leave-full-screen', () => applyInset(true))
}

/** Open the app window, or focus the one that is already open. */
export function openAppWindow(url) {
  if (!url) return false
  if (appWindow && !appWindow.isDestroyed()) {
    if (url !== lastLoadedUrl) {
      lastLoadedUrl = url
      void appWindow.loadURL(url).catch((error) => push(`DSH 窗口加载失败：${error.message}`))
    }
    if (stopped) {
      stopped = false
      applyTitle()
    }
    bringToFront(appWindow)
    return true
  }

  const bounds = resolveBounds()
  const theme = readSettings().theme === 'light' ? 'light' : 'dark'
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    title: 'DSH',
    backgroundColor: theme === 'dark' ? '#121211' : '#f7f6f3',
    autoHideMenuBar: process.platform !== 'darwin',
    ...(HIDDEN_TITLEBAR
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 19 } }
      : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  appWindow = win
  baseTitle = 'DSH'
  stopped = false
  lastLoadedUrl = url
  applyTitle()
  wireDownloads(win.webContents.session)
  wireNavigation(win)
  wireTitleBar(win)

  win.on('page-title-updated', (event, title) => {
    event.preventDefault()
    baseTitle = String(title ?? '').trim() || 'DSH'
    applyTitle()
  })

  const save = () => writeWindowState(win)
  win.on('resize', () => {
    clearTimeout(boundsTimer)
    boundsTimer = setTimeout(save, 250)
  })
  win.on('move', () => {
    clearTimeout(boundsTimer)
    boundsTimer = setTimeout(save, 250)
  })
  win.on('close', save)
  win.on('closed', () => {
    clearTimeout(boundsTimer)
    if (appWindow === win) appWindow = null
    lastLoadedUrl = null
    baseTitle = 'DSH'
    stopped = false
  })
  win.once('ready-to-show', () => {
    if (bounds.maximized) win.maximize()
    bringToFront(win)
  })

  void win.loadURL(url).catch((error) => push(`DSH 窗口加载失败：${error.message}`))
  return true
}

/** Focus an existing app window; returns false when there is nothing to focus. */
export function focusAppWindow() {
  if (!appWindow || appWindow.isDestroyed()) return false
  bringToFront(appWindow)
  return true
}

export function hasAppWindow() {
  return Boolean(appWindow && !appWindow.isDestroyed())
}

export function closeAppWindow() {
  if (!appWindow || appWindow.isDestroyed()) return
  const win = appWindow
  appWindow = null
  win.close()
}

/**
 * Keep the window in step with the service: a stopped instance only changes the title,
 * while a restarted one gets reloaded because DSH prints a fresh token URL every start.
 */
export function syncAppWindow({ running, openUrl } = {}) {
  if (!appWindow || appWindow.isDestroyed()) return
  stopped = !running
  // Always repaint: the language may have changed even when the stopped/running state did not.
  applyTitle()
  if (running && openUrl && openUrl !== lastLoadedUrl) {
    lastLoadedUrl = openUrl
    void appWindow.loadURL(openUrl).catch((error) => push(`DSH 窗口加载失败：${error.message}`))
  }
}
