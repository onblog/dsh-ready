/**
 * Website communication: anonymous launch reporting + a daily update check.
 *
 * - Requests go only to dsh.wordtk.com; no third party is ever called.
 * - The launch report contains only "a locally generated random device ID + the version number"; the server adds Cloudflare's
 *   coarse region (country / province / city). No IP address, no device fingerprint and no usage behaviour are ever sent.
 * - The update check runs at most once a day and only drives the "new version available" notice and the website link.
 * - Setting the environment variable DSH_READY_NO_TELEMETRY=1 disables both kinds of request entirely.
 */
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { readSettings, writeSettings } from './paths.mjs'
import { compareVersions } from './semver.mjs'

export const SITE_URL = 'https://dsh.wordtk.com'
export const GITHUB_URL = 'https://github.com/onblog/dsh-ready'
export const DEVELOPER = { name: 'Martin', email: 'hello@wordtk.com', github: 'https://github.com/onblog' }

const RELEASE_URL = `${SITE_URL}/api/release`
const PING_URL = `${SITE_URL}/api/ping`
const DAY_MS = 24 * 60 * 60 * 1000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function telemetryDisabled() {
  return process.env.DSH_READY_NO_TELEMETRY === '1'
}

/** One random ID per machine; it does not change with hardware, account or network. */
function deviceId() {
  const stored = String(readSettings().deviceId || '')
  if (UUID_RE.test(stored)) return stored
  const id = randomUUID()
  writeSettings({ deviceId: id })
  return id
}

/** Report once per launch (one device may produce several rows a day; UV counts distinct devices). */
export async function reportLaunch() {
  if (telemetryDisabled()) return
  try {
    await fetch(PING_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: deviceId(), version: app.getVersion() }),
      signal: AbortSignal.timeout(6000),
    })
  } catch {
    // A failed report must not affect any local feature.
  }
}

/**
 * Check the version published on the website.
 * Without force it is limited to once a day; force backs the manual check in the "About" panel.
 */
export async function checkUpdate({ force = false } = {}) {
  if (telemetryDisabled()) return { ok: false, disabled: true }

  const last = Number(readSettings().lastUpdateCheck) || 0
  if (!force && Date.now() - last < DAY_MS) return { ok: false, skipped: true }
  writeSettings({ lastUpdateCheck: Date.now() })

  try {
    const response = await fetch(RELEASE_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    const payload = await response.json()
    if (!payload?.ok) return { ok: false }

    const current = app.getVersion()
    const latest = String(payload.data.version || '')
    const hasUpdate = Boolean(latest) && compareVersions(latest, current) > 0
    return { ok: true, current, latest, hasUpdate, url: SITE_URL }
  } catch {
    return { ok: false, offline: true }
  }
}

/** External link allowlist: this project's website and repository only, so it cannot be abused with arbitrary URLs. */
export function canOpenExternally(url) {
  try {
    const target = new URL(String(url))
    if (target.protocol === 'mailto:') return target.pathname === DEVELOPER.email
    if (target.protocol !== 'https:') return false
    const allowed = new Set([new URL(SITE_URL).host, new URL(GITHUB_URL).host])
    return allowed.has(target.host)
  } catch {
    return false
  }
}
