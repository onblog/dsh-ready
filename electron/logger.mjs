import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { LOG_DIR, LOG_FILE } from './paths.mjs'

const MAX_LINES = 2000
const MAX_BYTES = 5 * 1024 * 1024

let lines = []
const listeners = new Set()

function rotateIfNeeded() {
  try {
    if (statSync(LOG_FILE).size > MAX_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`)
  } catch {
    // The file does not exist on the first write, so no rotation is needed.
  }
}

export function onLine(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function push(line) {
  const text = String(line ?? '').replace(/\r$/, '')
  const stamped = `[${stamp()}] ${text}`
  lines.push(stamped)
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    rotateIfNeeded()
    appendFileSync(LOG_FILE, `${stamped}\n`)
  } catch {
    // A failed disk write must not break the main flow.
  }
  for (const fn of listeners) {
    try {
      fn(stamped)
    } catch {
      // One failing subscriber must not affect the others.
    }
  }
}

export function getLines() {
  return lines.slice()
}

export function clearLines() {
  lines = []
}
