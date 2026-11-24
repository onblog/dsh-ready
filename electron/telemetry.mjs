/**
 * Website communication: anonymous launch reporting + a daily update check.
 *
 * - Requests go only to this project's own site; no third party is ever called.
 * - The launch report contains only "a locally generated random device ID + the version number"; the server adds Cloudflare's
 *   coarse region (country / province / city). No IP address, no device fingerprint and no usage behaviour are ever sent.
 * - The update check runs at most once a day and only drives the "new version available" notice and the website link.
 * - Setting the environment variable DSH_READY_NO_TELEMETRY=1 disables both kinds of request entirely.
 *
 * The live origin and the contact address are **not** in this file: a public
 * repository must not hardcode them. `scripts/write-site-config.cjs` writes
 * `site.generated.json` next to this file at packaging time (from `SITE_URL` /
 * `CONTACT_EMAIL`, env or `.env`). When that file is absent — a plain `npm start`
 * or a fork built without the variables — both strings stay empty and every
 * network feature below degrades to a no-op instead of failing.
 */
import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { setDefaultResultOrder } from 'node:dns'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSettings, writeSettings } from './paths.mjs'
import { compareVersions } from './semver.mjs'

/** Build-time deployment values; an empty object when the build supplied none. */
function generatedConfig() {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    return JSON.parse(readFileSync(join(here, 'site.generated.json'), 'utf8'))
  } catch {
    return {}
  }
}

const GENERATED = generatedConfig()
const origin = (value) => String(value || '').trim().replace(/\/+$/, '')

export const SITE_URL = origin(process.env.SITE_URL) || origin(GENERATED.siteUrl)
export const CONTACT_EMAIL = String(process.env.CONTACT_EMAIL || GENERATED.contactEmail || '').trim()
export const GITHUB_URL = 'https://github.com/onblog/dsh-ready'
export const DEVELOPER = { name: 'Martin', email: CONTACT_EMAIL, github: 'https://github.com/onblog' }

const RELEASE_URL = SITE_URL ? `${SITE_URL}/api/release` : ''
const PING_URL = SITE_URL ? `${SITE_URL}/api/ping` : ''
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Own requests are the app's only outbound traffic, and they used to be brittle on slow home
 * networks: an 8s hard timeout with no retry, and Node's resolver could pick a blackholed IPv6
 * address and burn the whole budget (a browser works there because Chromium does Happy Eyeballs).
 * Prefer IPv4 like curl/Chromium, allow more time, and retry once before calling it offline.
 */
const REQUEST_TIMEOUT_MS = 15_000
const REQUEST_ATTEMPTS = 2
const RETRY_DELAY_MS = 1200
try {
  setDefaultResultOrder('ipv4first')
} catch {
  // Older runtimes keep their default order; the longer timeout still covers it.
}

/** The error code worth showing a human: Node hides it inside `cause`. */
function networkCode(error) {
  return String(error?.cause?.code || error?.code || error?.name || 'network')
}

/** fetch() with the shared timeout and one retry; the caller decides what a failure means. */
async function requestWithRetry(url, init = {}) {
  let lastError
  for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt += 1) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch (error) {
      lastError = error
      if (attempt < REQUEST_ATTEMPTS) await new Promise((done) => setTimeout(done, RETRY_DELAY_MS))
    }
  }
  throw lastError
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** The environment variable is the hard kill switch; the settings switch only covers launch reporting. */
function envTelemetryDisabled() {
  return process.env.DSH_READY_NO_TELEMETRY === '1'
}

function launchReportDisabled() {
  return envTelemetryDisabled() || readSettings().telemetry === false
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
  if (!PING_URL || launchReportDisabled()) return
  try {
    await requestWithRetry(PING_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: deviceId(), version: app.getVersion() }),
    })
  } catch {
    // A failed report must not affect any local feature.
  }
}

/**
 * Whether an automatic check is due: the switch is on and a day has passed since the last
 * successful check. The background scheduler and `checkUpdate` share this one rule, so a
 * long-running app keeps checking instead of only checking once at launch.
 */
export function updateCheckDue(now = Date.now()) {
  if (readSettings().autoUpdateCheck === false) return false
  const last = Number(readSettings().lastUpdateCheck) || 0
  return now - last >= DAY_MS
}

/**
 * Check the version published on the website.
 * Without force it is limited to once a day; force backs the manual check in the "About" panel.
 */
export async function checkUpdate({ force = false } = {}) {
  // A manual check is always allowed (unless the env kill switch is set); the daily
  // automatic one follows the "check automatically" switch.
  // Two different reasons hid behind the same "disabled" flag: no baked origin, or the
  // environment kill switch. The sheet now says which one it is.
  if (!RELEASE_URL) return { ok: false, disabled: true, reason: 'unconfigured' }
  if (envTelemetryDisabled()) return { ok: false, disabled: true, reason: 'disabled' }
  if (!force && readSettings().autoUpdateCheck === false) return { ok: false, disabled: true }

  // The same due rule the scheduler reads, so "once a day" has exactly one definition.
  if (!force && !updateCheckDue()) return { ok: false, skipped: true }

  let response
  try {
    response = await requestWithRetry(RELEASE_URL, { headers: { Accept: 'application/json' } })
  } catch (error) {
    return { ok: false, offline: true, reason: 'offline', detail: networkCode(error) }
  }

  let payload
  try {
    payload = await response.json()
  } catch {
    return { ok: false, reason: 'server', status: response.status }
  }
  if (!response.ok || !payload?.ok) return { ok: false, reason: 'server', status: response.status }

  // Only a finished check spends the day's quota. Stamping before the request meant one
  // offline launch silenced the next automatic check for 24 hours.
  writeSettings({ lastUpdateCheck: Date.now() })

  const current = app.getVersion()
  const latest = String(payload.data.version || '')
  const hasUpdate = Boolean(latest) && compareVersions(latest, current) > 0
  return { ok: true, current, latest, hasUpdate, file: hasUpdate ? releaseFileFor(payload.data.files, latest) : null }
}

/**
 * The installer for this machine, from the manifest's `files` map. Windows is published as
 * x64 only, so even Windows on ARM takes that build (it runs under emulation); Linux has no
 * published installer and gets `null`.
 */
function releaseFileFor(files, version) {
  let arch = null
  if (process.platform === 'darwin') arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  else if (process.platform === 'win32') arch = 'win-x64'
  const entry = arch ? files?.[arch] : null
  const size = Number(entry?.size) || 0
  const sha256 = String(entry?.sha256 || '').toLowerCase()
  if (!entry?.name || size <= 0 || !sha256) return null
  try {
    const fallback = `/api/download?arch=${encodeURIComponent(arch)}&v=${encodeURIComponent(version)}`
    const url = new URL(entry.url || fallback, SITE_URL).toString()
    return { arch, name: String(entry.name), size, sha256, url }
  } catch {
    return null
  }
}

/** External link allowlist: project links plus the two localized official Node.js download pages. */
export function canOpenExternally(url) {
  try {
    const target = new URL(String(url))
    if (target.protocol === 'mailto:') return Boolean(DEVELOPER.email) && target.pathname === DEVELOPER.email
    if (target.protocol !== 'https:') return false
    if (target.host === 'nodejs.org') {
      return target.pathname === '/zh-cn/download' || target.pathname === '/en/download'
    }
    const allowed = new Set([new URL(GITHUB_URL).host])
    if (SITE_URL) allowed.add(new URL(SITE_URL).host)
    return allowed.has(target.host)
  } catch {
    return false
  }
}
