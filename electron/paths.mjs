import { app } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

export const USER_DATA = app.getPath('userData')
let dshHome = null

/** DSH_HOME is resolved lazily: read it after the login shell environment loads, so it never points to a different directory than the child processes. */
export function dshHomeDir() {
  if (!dshHome) dshHome = process.env.DSH_HOME || join(app.getPath('home'), '.dsh')
  return dshHome
}
export const LOG_DIR = join(USER_DATA, 'logs')
export const LOG_FILE = join(LOG_DIR, 'dsh.log')
export const SETTINGS_FILE = join(USER_DATA, 'settings.json')

const DEFAULT_SETTINGS = {
  theme: 'dark',
  lang: 'system',
  port: 3080,
  // Open the browser once DSH is up. Off by default: launching must never hijack the screen.
  openInBrowser: false,
  // Anonymous launch reporting. The daily update check has its own switch.
  telemetry: true,
  autoUpdateCheck: true,
  // 'auto' benchmarks both registries, 'official' / 'mirror' pin one.
  npmRegistry: 'auto',
  // Proxy for the npm / DSH child processes only (the app's own requests stay direct).
  proxy: '',
  // Extra `dsh web` arguments. Parsed into an argv array, never through a shell.
  dshArgs: '',
}

export const NPM_REGISTRIES = ['auto', 'official', 'mirror']

export function isValidPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

/**
 * Accept `host:port` or `http(s)://host:port`; anything else (including a socks:// URL,
 * which npm cannot use) is treated as "no proxy".
 */
export function normalizeProxy(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)
  if (hasScheme && !/^https?:\/\//i.test(raw)) return ''
  try {
    const parsed = new URL(hasScheme ? raw : `http://${raw}`)
    if (!parsed.hostname) return ''
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return ''
  }
}

/** Child-process proxy variables; empty object when no proxy is configured. */
export function proxyEnv() {
  const url = readSettings().proxy
  if (!url) return {}
  return { HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url, NO_PROXY: 'localhost,127.0.0.1,::1' }
}

// Long flags (`--host`, `--theme=dark`) and single-letter short flags (`-p`) only: a
// combined blob like `-rf` never reaches dsh. Values must start with a letter or digit,
// so a stray `/` or a shell fragment can never ride along.
const LONG_FLAG_RE = /^--[A-Za-z0-9][A-Za-z0-9._-]*(=[A-Za-z0-9._:@/%,+~=-]+)?$/
const SHORT_FLAG_RE = /^-[A-Za-z]$/
const VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._:@,+~=-]*$/
const PORT_FLAG_RE = /^(--port|--listen|-p)(=|$)/

/**
 * Parse the "extra DSH arguments" field into an argv array.
 * Nothing is passed to a shell: every token must match a flag/value whitelist. The port
 * flags and their values are dropped because the port setting owns them, and a dropped
 * flag also drops the value that follows it.
 */
export function parseDshArgs(text) {
  const tokens = String(text ?? '').trim().split(/\s+/).filter(Boolean)
  const args = []
  const dropped = []
  let expectValue = false
  let dropValue = false
  for (const token of tokens) {
    if (token.startsWith('-')) {
      if (PORT_FLAG_RE.test(token)) {
        dropped.push(token)
        dropValue = !token.includes('=')
        expectValue = false
        continue
      }
      if (!LONG_FLAG_RE.test(token) && !SHORT_FLAG_RE.test(token)) {
        dropped.push(token)
        dropValue = false
        expectValue = false
        continue
      }
      args.push(token)
      dropValue = false
      expectValue = !token.includes('=')
      continue
    }
    if (dropValue) {
      dropped.push(token)
      dropValue = false
      expectValue = false
      continue
    }
    if (expectValue && VALUE_RE.test(token)) {
      args.push(token)
      expectValue = false
      continue
    }
    dropped.push(token)
    expectValue = false
  }
  return { args, dropped }
}

export function readSettings() {
  let stored = {}
  try {
    stored = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
  } catch {
    stored = {}
  }
  const port = Number(stored.port)
  // Themes are an explicit binary choice: any legacy "system" value or unknown input falls back to dark.
  const theme = stored.theme === 'light' || stored.theme === 'dark' ? stored.theme : DEFAULT_SETTINGS.theme
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    theme,
    port: isValidPort(port) ? port : DEFAULT_SETTINGS.port,
    lang: stored.lang === 'zh' || stored.lang === 'en' || stored.lang === 'system' ? stored.lang : DEFAULT_SETTINGS.lang,
    openInBrowser: bool(stored.openInBrowser, DEFAULT_SETTINGS.openInBrowser),
    telemetry: bool(stored.telemetry, DEFAULT_SETTINGS.telemetry),
    autoUpdateCheck: bool(stored.autoUpdateCheck, DEFAULT_SETTINGS.autoUpdateCheck),
    npmRegistry: NPM_REGISTRIES.includes(stored.npmRegistry) ? stored.npmRegistry : DEFAULT_SETTINGS.npmRegistry,
    proxy: normalizeProxy(stored.proxy),
    dshArgs: typeof stored.dshArgs === 'string' ? stored.dshArgs.trim() : DEFAULT_SETTINGS.dshArgs,
  }
}

export function writeSettings(patch) {
  const next = { ...readSettings(), ...patch }
  try {
    mkdirSync(USER_DATA, { recursive: true })
    writeFileSync(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`)
  } catch {
    // An unwritable settings file must not break the main flow.
  }
  return next
}

export function ensureDirs() {
  for (const dir of [USER_DATA, LOG_DIR]) mkdirSync(dir, { recursive: true })
}
