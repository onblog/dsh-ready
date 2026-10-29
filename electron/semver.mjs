/**
 * Minimal semver implementation: it serves exactly one question, "does a version fall inside a peer dependency range".
 * Supports ^ ~ >= <= > < =, x/* wildcards, partial versions (1, 1.2), hyphen ranges and || combinations.
 * Matching uses pure range semantics (prereleases included): the DSH version train is itself rc/alpha prerelease,
 * so npm's default "prereleases only count within the same version tuple" rule would misjudge clearly compatible
 * declarations such as *, >=0.1.0-rc.1 <0.3.0-0 as incompatible.
 */

const FULL = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseVersion(input) {
  const match = FULL.exec(String(input ?? '').trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.') : [],
  }
}

function comparePre(a, b) {
  if (!a.length && !b.length) return 0
  if (!a.length) return 1
  if (!b.length) return -1
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumber = /^\d+$/.test(left)
    const rightNumber = /^\d+$/.test(right)
    if (leftNumber && rightNumber) {
      const diff = Number(left) - Number(right)
      if (diff !== 0) return diff > 0 ? 1 : -1
    } else if (leftNumber) {
      return -1
    } else if (rightNumber) {
      return 1
    } else if (left !== right) {
      return left > right ? 1 : -1
    }
  }
  return 0
}

export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1
  }
  return comparePre(left.pre, right.pre)
}

export function isPrerelease(version) {
  return Boolean(parseVersion(version)?.pre.length)
}

function text(major, minor, patch, pre) {
  return `${major}.${minor}.${patch}${pre ? `-${pre}` : ''}`
}

/** Parse partial versions such as `1`, `1.2`, `1.2.x`, `*`; returns null for non-numeric input. */
function parsePartial(input) {
  const numbers = []
  for (const part of String(input).split('.')) {
    if (/^[xX*]$/.test(part)) numbers.push(null)
    else if (/^\d+$/.test(part)) numbers.push(Number(part))
    else return null
  }
  if (!numbers.length || numbers.length > 3) return null
  while (numbers.length < 3) numbers.push(null)
  return numbers
}

function comparator(op, major, minor, patch, pre) {
  return { op, version: text(major, minor, patch, pre) }
}

/** The `-0` upper bound: excludes prereleases of the same version, e.g. <2.0.0-0 excludes 2.0.0-alpha. */
function upperBound(major, minor, patch) {
  return comparator('<', major, minor, patch, '0')
}

/** Expand one comparator into an equivalent [lower bound, upper bound] pair. */
function expand(token) {
  const raw = String(token).trim()
  if (!raw || raw === '*' || raw === 'x' || raw === 'X') return []

  const match = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(raw)
  if (!match) return []
  const operator = match[1] ?? '='
  const target = match[2].trim()
  if (/^[xX*]$/.test(target)) return []

  const [base, ...preParts] = target.split('-')
  const pre = preParts.length ? preParts.join('-') : null
  const numbers = parsePartial(base)
  if (!numbers) return null
  const [major, minor, patch] = numbers
  const partial = minor === null || patch === null
  // Partial versions (1, 1.2) use -0 as the lower bound so prereleases match too, consistent with npm includePrerelease.
  const low = pre ?? (partial ? '0' : null)

  if (operator === '^') {
    if (major === null) return []
    const floor = comparator('>=', major, minor ?? 0, patch ?? 0, low)
    if (major > 0) return [floor, upperBound(major + 1, 0, 0)]
    if (minor === null) return [floor, upperBound(1, 0, 0)]
    if (patch === null || minor > 0) return [floor, upperBound(0, minor + 1, 0)]
    return [floor, upperBound(0, 0, patch + 1)]
  }

  if (operator === '~') {
    if (major === null) return []
    const floor = comparator('>=', major, minor ?? 0, patch ?? 0, low)
    if (minor === null) return [floor, upperBound(major + 1, 0, 0)]
    return [floor, upperBound(major, minor + 1, 0)]
  }

  if (operator === '=') {
    if (major === null) return []
    if (minor === null) return [comparator('>=', major, 0, 0, '0'), upperBound(major + 1, 0, 0)]
    if (patch === null) return [comparator('>=', major, minor, 0, '0'), upperBound(major, minor + 1, 0)]
    return [comparator('=', major, minor, patch, pre)]
  }

  if (major === null) return []

  if (operator === '>') {
    if (pre || patch !== null) return [comparator('>', major, minor ?? 0, patch ?? 0, pre)]
    if (minor === null) return [comparator('>=', major + 1, 0, 0, '0')]
    return [comparator('>=', major, minor + 1, 0, '0')]
  }

  if (operator === '>=') return [comparator('>=', major, minor ?? 0, patch ?? 0, low)]

  if (operator === '<') return [comparator('<', major, minor ?? 0, patch ?? 0, pre)]

  // operator === '<='
  if (pre || patch !== null) return [comparator('<=', major, minor ?? 0, patch ?? 0, pre)]
  if (minor === null) return [comparator('<', major + 1, 0, 0, '0')]
  return [comparator('<', major, minor + 1, 0, '0')]
}

function hit(version, item) {
  const diff = compareVersions(version, item.version)
  if (item.op === '=') return diff === 0
  if (item.op === '>') return diff > 0
  if (item.op === '>=') return diff >= 0
  if (item.op === '<') return diff < 0
  if (item.op === '<=') return diff <= 0
  return false
}

/** Expand hyphen ranges such as `1.2 - 2.3` into lower and upper bounds. */
function expandHyphen(tokens) {
  const out = []
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === '-' && out.length && index + 1 < tokens.length) {
      const lower = out.pop()
      out.push(`>=${lower.includes('-') ? lower : `${lower}-0`}`, `<=${tokens[index + 1]}`)
      index += 1
      continue
    }
    out.push(tokens[index])
  }
  return out
}

export function satisfies(version, range) {
  const parsed = parseVersion(version)
  if (!parsed) return false
  const raw = String(range ?? '').trim()
  if (!raw) return true

  return raw.split('||').some((group) => {
    const tokens = expandHyphen(group.trim().split(/\s+/).filter(Boolean))
    if (!tokens.length) return true

    return tokens.every((token) => {
      const comparators = expand(token)
      if (comparators === null) return false
      return comparators.every((item) => hit(version, item))
    })
  })
}
