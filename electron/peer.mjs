import { compareVersions, parseVersion, satisfies } from './semver.mjs'

const DSH_PACKAGE = '@deepseek-ai/dsh'
const DSH_SUB_PREFIX = `${DSH_PACKAGE}-`

/**
 * A plugin declares its DSH compatibility in peerDependencies, pointing at @deepseek-ai/dsh
 * or the internal @deepseek-ai/dsh-* packages; those ship on the same version train as the main dsh package,
 * so these ranges can be validated directly against the target dsh version.
 */
export function dshPeers(manifest) {
  const peers = manifest?.peerDependencies ?? {}
  const meta = manifest?.peerDependenciesMeta ?? {}
  const entries = []
  for (const [name, range] of Object.entries(peers)) {
    if (name !== DSH_PACKAGE && !name.startsWith(DSH_SUB_PREFIX)) continue
    entries.push({ name, range: String(range), optional: meta?.[name]?.optional === true })
  }
  const engineRange = manifest?.engines?.dsh
  if (engineRange) entries.push({ name: 'engines.dsh', range: String(engineRange), optional: false })
  return entries
}

/**
 * Check whether the DSH compatibility range declared by a package version covers the target dsh version.
 * required covers mandatory declarations (plain peers and engines.dsh); optional covers advisory ranges a plugin marked optional:
 * when either does not match it means "version must change"; when only optional does not match it is advisory.
 */
export function checkDshPeers(manifest, targetVersion) {
  const peers = dshPeers(manifest)
  const requiredMismatch = peers.find((peer) => !peer.optional && !satisfies(targetVersion, peer.range)) ?? null
  const optionalMismatch = peers.find((peer) => peer.optional && !satisfies(targetVersion, peer.range)) ?? null
  return {
    peers,
    requiredMismatch,
    optionalMismatch,
    mismatched: requiredMismatch ?? optionalMismatch,
    required: peers.filter((peer) => !peer.optional),
    ok: !requiredMismatch && !optionalMismatch,
  }
}

function shortRange(range) {
  const text = String(range)
  return text.length > 44 ? `${text.slice(0, 44)}…` : text
}

export function peerText(peer) {
  return `${peer.name} ${shortRange(peer.range)}`
}

function noteOf(peers) {
  if (!peers.length) return '未声明 DSH 兼容范围'
  const head = `要求 ${peerText(peers[0])}`
  return peers.length > 1 ? `${head} 等 ${peers.length} 项` : head
}

/**
 * Pick the highest version from the npm packument that fits the target dsh version.
 * Returns { version, manifest } or null.
 */
export function pickCompatibleVersion(packument, targetVersion) {
  const versions = Object.entries(packument?.versions ?? {})
  const candidates = []
  for (const [version, manifest] of versions) {
    if (!parseVersion(version)) continue
    if (!checkDshPeers(manifest, targetVersion).ok) continue
    candidates.push({ version, manifest })
  }
  if (!candidates.length) return null
  candidates.sort((a, b) => compareVersions(b.version, a.version))

  const latest = packument?.['dist-tags']?.latest
  const tagged = candidates.find((item) => item.version === latest)
  return tagged ?? candidates[0]
}

/** How the latest published version compares to the target dsh, for the "no compatible version" notice. */
export function describeMismatch(packument, targetVersion) {
  const latest = packument?.['dist-tags']?.latest
  const manifest = latest ? packument?.versions?.[latest] : null
  if (!manifest) return 'registry 上没有可用的发布版本'
  const { mismatched } = checkDshPeers(manifest, targetVersion)
  const head = `npm 上最新版 ${latest}`
  if (!mismatched) return `${head} 适配 ${targetVersion}，但没有高于当前安装版本的可选版本`
  return `${head} 要求 ${peerText(mismatched)}，与目标 ${targetVersion} 不匹配`
}

export { noteOf }
