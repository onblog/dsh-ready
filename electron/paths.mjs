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

const DEFAULT_SETTINGS = { theme: 'dark', lang: 'system', port: 3080 }

export function isValidPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535
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
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    theme,
    port: isValidPort(port) ? port : DEFAULT_SETTINGS.port,
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
