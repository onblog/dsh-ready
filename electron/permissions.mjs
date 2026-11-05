/**
 * macOS system-permission probes for the settings sheet.
 *
 * One question per row — "did the user grant this?" — and **no probe may pop a system
 * dialog**: the sheet re-runs the checks every time it opens and whenever the window comes
 * back from System Settings, so a prompting probe would greet the user with the same alert
 * over and over. That constraint decides the technique for each row:
 *
 *   - Accessibility and Screen Recording have real preflight APIs (silent when the prompt
 *     flag is off), so they are exact.
 *   - Full Disk Access has no preflight at all; the proof is reading a file that TCC protects
 *     on every macOS version and checking for its real first bytes (a denied read can hand
 *     back an empty buffer instead of throwing, so "did not throw" is not enough).
 *
 * System Settings → App Management is deliberately absent. It has no preflight either, and
 * every operation that would prove it (`chmod`, writing inside another `.app`) raises the TCC
 * prompt — so the only remaining source is the TCC database, and macOS 26 keeps no readable
 * record of that service at all (not one row, not even for apps the user switched on). A row
 * that can only ever say "cannot tell" is noise in a health indicator, and the launcher does
 * not modify other app bundles; when a feature needs it, the system will ask at that moment and
 * the request can come back with a real trigger.
 */
import { app, desktopCapturer, shell, systemPreferences } from 'electron'
import { closeSync, openSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Report order; the renderer keeps its rows in the same order. */
const PERMISSION_IDS = ['accessibility', 'screenRecording', 'fullDiskAccess']

/**
 * System Settings deep links. The `?Privacy_*` anchor is what selects the row inside the
 * Privacy & Security pane; a wrong anchor still opens the pane but lands on the wrong tab.
 */
const PANES = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  fullDiskAccess: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
}

/**
 * Files that are TCC-protected on every macOS version this app supports. Either one being
 * readable proves Full Disk Access: files that merely *used to* be protected — the legacy
 * `~/Library/Safari` bookmarks — can be left readable after a migration, which reports a grant
 * that does not exist.
 */
const FDA_SENTINELS = [
  '/Library/Application Support/com.apple.TCC/TCC.db',
  join(homedir(), 'Library/Messages', 'chat.db'),
]

/** Every TCC.db / chat.db is a SQLite database, so byte 0 is always this header. */
const SQLITE_HEADER = Buffer.from('SQLite format 3\u0000', 'latin1')
const SQLITE_HEADER_LENGTH = 16

/** macOS only: Windows and Linux have no TCC, and the settings row is hidden there. */
export function permissionsSupported() {
  return process.platform === 'darwin'
}

/**
 * Read the current state of every permission.
 *
 * `state` is `granted` | `missing`; the renderer owns the copy, so ids travel without labels.
 * The probe is cheap (two API reads plus up to two file reads) and silent.
 */
export async function readPermissions() {
  if (!permissionsSupported()) return { supported: false, items: [], grantedCount: 0, total: 0 }

  const states = {
    accessibility: trustedAccessibility(),
    screenRecording: systemPreferences.getMediaAccessStatus('screen') === 'granted',
    fullDiskAccess: fullDiskAccessGranted(),
  }
  const items = PERMISSION_IDS.map((id) => ({ id, state: states[id] ? 'granted' : 'missing' }))
  return {
    supported: true,
    items,
    grantedCount: items.filter((item) => item.state === 'granted').length,
    total: items.length,
    // Which app the user is being asked to toggle. macOS keys every grant on the bundle's code
    // identity, so "granted but still missing" is almost always a different copy (dmg, an old
    // build, or a translocated path) — showing the target makes that visible.
    owner: {
      path: app.getPath('exe'),
      version: app.getVersion(),
      packaged: app.isPackaged,
      transient: isTransientLocation(app.getPath('exe')),
    },
  }
}

/**
 * True when the running bundle cannot keep a TCC grant anyway: App Translocation re-mounts a
 * quarantined app from a randomized read-only path, and a copy launched straight out of the dmg
 * lives on /Volumes. Grants are keyed on the code identity at that path, so they evaporate.
 */
function isTransientLocation(execPath) {
  return /\/Volumes\//.test(execPath) || /AppTranslocation/.test(execPath)
}

/**
 * Open the Privacy & Security pane that owns `id`, first making sure this app is *listed* in
 * it. macOS only offers rows for apps that have asked, and a silent check never asks — so
 * without this the pane opens with no row to toggle, the user switches on something else, and
 * reports that the grant did not work. `registered` tells the sheet to say so.
 */
export async function openPermissionSettings(id) {
  const url = PANES[id]
  if (!url) return { ok: false, registered: false }
  const registered = registerForPane(id)
  try {
    await shell.openExternal(url)
    return { ok: true, registered }
  } catch {
    return { ok: false, registered }
  }
}

/** Ask macOS to register this app in the list behind `id`, raising its one-time prompt. */
function registerForPane(id) {
  if (id === 'accessibility' && !trustedAccessibility()) {
    // The prompting variant is the only way an app joins the Accessibility list; it returns
    // immediately and shows the system alert.
    try {
      systemPreferences.isTrustedAccessibilityClient(true)
      return true
    } catch {
      return false
    }
  }
  if (id === 'screenRecording' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    // One real capture request is what registers the app for Screen Recording. Deliberately not
    // awaited: the first call can stay pending until the user answers, and the pane must still
    // open right away.
    void desktopCapturer
      .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      .catch(() => null)
    return true
  }
  return false
}

/**
 * Accessibility is the one permission with a synchronous preflight. `false` keeps it silent —
 * the prompting variant (`true`) is the only way macOS registers the app in the list, and it
 * raises an alert, which is exactly what a re-runnable check must not do.
 */
function trustedAccessibility() {
  try {
    return systemPreferences.isTrustedAccessibilityClient(false)
  } catch {
    return false
  }
}

/** Full Disk Access by reading a protected sentinel: readable + real SQLite header. */
function fullDiskAccessGranted() {
  // No existence pre-check: a denied stat() on a protected path reports "missing", so the
  // read itself has to decide. Either sentinel readable is enough — both are FDA-only.
  return FDA_SENTINELS.some(readableSqlite)
}

function readableSqlite(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const head = Buffer.alloc(SQLITE_HEADER_LENGTH)
    const read = readSync(fd, head, 0, SQLITE_HEADER_LENGTH, 0)
    // A blocked read can succeed with EOF instead of throwing (macOS 15.x), hence the byte check.
    return read === SQLITE_HEADER_LENGTH && head.equals(SQLITE_HEADER)
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* nothing left to do with a descriptor that will not close */
      }
    }
  }
}
