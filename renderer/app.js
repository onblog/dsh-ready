const $ = (id) => document.getElementById(id)
const t = (key, params) => window.i18n.t(key, params)

const els = {
  boot: $('boot'),
  petBox: $('petBox'),
  petImg: $('petImg'),
  petA: $('petA'),
  petB: $('petB'),
  dot: $('dot'),
  statusText: $('statusText'),
  versionTag: $('versionTag'),
  hint: $('hint'),
  addr: $('addr'),
  portValue: $('portValue'),
  actions: document.querySelector('.actions'),
  flow: $('flow'),
  flowTitle: $('flowTitle'),
  flowBack: $('flowBack'),
  flowSummary: $('flowSummary'),
  flowNote: $('flowNote'),
  flowReport: $('flowReport'),
  flowPrimary: $('flowPrimary'),
  targetLabel: $('targetLabel'),
  versionPicker: $('versionPicker'),
  versionValue: $('versionValue'),
  latestTag: $('latestTag'),
  versionList: $('versionList'),
  combo: document.querySelector('.combo'),
  primary: $('primary'),
  stopBtn: $('stopBtn'),
  upgradeBtn: $('upgradeBtn'),
  uninstallBtn: $('uninstallBtn'),
  secondary: document.querySelector('.secondary'),
  log: $('log'),
  clearBtn: $('clearBtn'),
  themeBtn: $('themeBtn'),
  langBtn: $('langBtn'),
  quitBtn: $('quitBtn'),
  modal: $('modal'),
  modalTitle: $('modalTitle'),
  modalBody: $('modalBody'),
  modalConfirm: $('modalConfirm'),
  modalCancel: $('modalCancel'),
  nodeInfo: $('nodeInfo'),
  runtimeInfo: $('runtimeInfo'),
  settings: $('settings'),
  settingsBtn: $('settingsBtn'),
  settingsClose: $('settingsClose'),
  settingsVersion: $('settingsVersion'),
  devName: $('devName'),
  devEmail: $('devEmail'),
  devGithub: $('devGithub'),
  devSite: $('devSite'),
  autoLaunch: $('autoLaunch'),
  autoLaunchNote: $('autoLaunchNote'),
  portField: $('portField'),
  portNote: $('portNote'),
  openInBrowser: $('openInBrowser'),
  themeSeg: $('themeSeg'),
  langSeg: $('langSeg'),
  registrySeg: $('registrySeg'),
  proxyField: $('proxyField'),
  proxyNote: $('proxyNote'),
  argsField: $('argsField'),
  argsNote: $('argsNote'),
  telemetry: $('telemetry'),
  autoUpdateCheck: $('autoUpdateCheck'),
  updateBtn: $('updateBtn'),
  updateNote: $('updateNote'),
  sponsorBtn: $('sponsorBtn'),
}

const BUSY_STATUS = new Set(['starting', 'stopping', 'installing', 'upgrading', 'uninstalling', 'takingover'])
const THEMES = ['light', 'dark']
const LANGS = ['zh', 'en']

/* ---------- Text ---------- */

function applyStaticTexts() {
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n)
  for (const node of document.querySelectorAll('[data-i18n-aria]')) {
    node.setAttribute('aria-label', t(node.dataset.i18nAria))
  }
  for (const node of document.querySelectorAll('[data-i18n-title]')) node.title = t(node.dataset.i18nTitle)
  document.title = t('app.title')
}

function statusText(status) {
  return t(`status.${status}`)
}

/**
 * Icon buttons carry no text: the label lives in the tooltip / aria-label so the
 * header stays a single row of icons at 468px.
 */
function syncHeaderButtons(theme, lang) {
  const nextTheme = theme === 'light' ? 'dark' : 'light'
  const themeTitle = `${t('theme.aria')} · ${t(nextTheme === 'dark' ? 'theme.dark' : 'theme.light')}`
  els.themeBtn.title = themeTitle
  els.themeBtn.setAttribute('aria-label', themeTitle)

  const nextLang = lang === 'en' ? 'zh' : 'en'
  const langTitle = `${t('lang.aria')} · ${nextLang === 'en' ? 'English' : '中文'}`
  els.langBtn.title = langTitle
  els.langBtn.setAttribute('aria-label', langTitle)
}

let state = null
let versions = []
let versionTags = {}
let selectedVersion = null
let dropdownOpen = false
let noticeTimer = null
let noticeText = ''
let noticeIsError = false
let flowMode = null
let flowPlan = null
let planSeq = 0

/* ---------- Pet animation ---------- */

const PET_CLIPS = {
  idle: 'assets/pet/idle.webm',
  sleepy: 'assets/pet/sleepy.webm',
  busy: 'assets/pet/busy.webm',
  running: 'assets/pet/running.webm',
  look: 'assets/pet/look.webm',
  sad: 'assets/pet/sad.webm',
  happy: 'assets/pet/happy.webm',
  celebrate: 'assets/pet/celebrate.webm',
}

const STATUS_PET = {
  'not-installed': 'idle',
  stopped: 'sleepy',
  starting: 'busy',
  running: 'running',
  stopping: 'busy',
  installing: 'busy',
  upgrading: 'busy',
  uninstalling: 'busy',
  external: 'look',
  takingover: 'busy',
}

const pet = { videos: [], active: -1, name: null, override: null, timer: null }

function petEnabled() {
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches && Boolean(els.petA && els.petB)
}

/** Two video layers alternate and cross-fade on state changes, so the frame never flashes black. */
function playPetClip(name) {
  if (!petEnabled() || !PET_CLIPS[name] || pet.name === name) return
  if (!pet.videos.length) pet.videos = [els.petA, els.petB]
  const nextIndex = pet.active === 1 ? 0 : 1
  const next = pet.videos[nextIndex]
  const prev = pet.active >= 0 ? pet.videos[pet.active] : null
  pet.name = name

  const activate = () => {
    if (pet.name !== name) return
    next.play().catch(() => {})
    next.classList.add('is-active')
    if (prev) {
      prev.pause()
      prev.classList.remove('is-active')
    }
    els.petImg.classList.add('is-hidden')
    pet.active = nextIndex
  }

  next.loop = true
  next.addEventListener('canplay', activate, { once: true })
  if (next.dataset.clip === name && next.readyState >= 2) {
    activate()
    return
  }
  // Swapping the source must wait for canplay before playing, otherwise load() interrupts play() and leaves it paused.
  next.dataset.clip = name
  next.src = PET_CLIPS[name]
  next.load()
}

function syncPet() {
  if (pet.override) return
  playPetClip(STATUS_PET[state?.status] ?? 'idle')
}

/** One-shot reactions: click response, upgrade celebration, failure sigh. */
function reactPet(name, duration = 2400) {
  if (!petEnabled()) return
  pet.override = name
  playPetClip(name)
  clearTimeout(pet.timer)
  pet.timer = setTimeout(() => {
    pet.override = null
    playPetClip(STATUS_PET[state?.status] ?? 'idle')
  }, duration)
}

els.petBox.addEventListener('click', () => reactPet('happy', 2000))

/* ---------- Log ---------- */

const MAX_LOG_NODES = 600
let logLines = []
const ERROR_PATTERN = /error|failed|failure|失败|错误|超时|异常|denied|not found/i
const OK_PATTERN = /完成|已就绪|已停止|校验通过/

function decorate(text) {
  const line = document.createElement('div')
  line.className = 'line'
  if (ERROR_PATTERN.test(text)) line.classList.add('err')
  else if (OK_PATTERN.test(text)) line.classList.add('ok')
  line.textContent = text
  return line
}

function followLog() {
  const nearBottom = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 32
  if (nearBottom) els.log.scrollTop = els.log.scrollHeight
}

function appendLine(text) {
  logLines.push(text)
  if (logLines.length > MAX_LOG_NODES) logLines.splice(0, logLines.length - MAX_LOG_NODES)
  els.log.querySelector('.placeholder')?.remove()
  els.log.append(decorate(text))
  while (els.log.childElementCount > MAX_LOG_NODES) els.log.firstElementChild.remove()
  followLog()
}

function renderLogs(lines) {
  logLines = lines.slice(-MAX_LOG_NODES)
  els.log.textContent = ''
  if (!lines.length) {
    const empty = document.createElement('div')
    empty.className = 'line placeholder'
    empty.textContent = t('console.empty')
    els.log.append(empty)
    return
  }
  const fragment = document.createDocumentFragment()
  for (const text of lines.slice(-MAX_LOG_NODES)) fragment.append(decorate(text))
  els.log.append(fragment)
  els.log.scrollTop = els.log.scrollHeight
}

/* ---------- Hints ---------- */

function defaultHint(current) {
  if (!current) return t('hint.loading')
  const fromSystem = current.dshSource === 'system'
  switch (current.status) {
    case 'not-installed':
      return t('hint.notInstalled')
    case 'stopped':
      return fromSystem ? t('hint.stoppedSystem') : t('hint.stoppedApp')
    case 'external':
      return t('hint.external')
    case 'starting':
      return t('hint.starting')
    case 'running':
      return t('hint.running')
    case 'stopping':
      return t('hint.stopping')
    case 'installing':
      return t('hint.installing')
    case 'upgrading':
      return t('hint.upgrading')
    case 'uninstalling':
      return t('hint.uninstalling')
    case 'takingover':
      return t('hint.takingover')
    default:
      return ''
  }
}

function showHint() {
  if (noticeText) {
    els.hint.textContent = noticeText
    els.hint.classList.toggle('err', noticeIsError)
    return
  }
  els.hint.textContent = defaultHint(state)
  els.hint.classList.remove('err')
}

function notice(text, isError = false) {
  noticeText = text
  noticeIsError = isError
  clearTimeout(noticeTimer)
  showHint()
  noticeTimer = setTimeout(() => {
    noticeText = ''
    showHint()
  }, 4500)
}

/* ---------- Version picker ---------- */

function renderVersionValue() {
  els.versionValue.textContent = selectedVersion ?? t('flow.loading')
}

function renderVersionOptions() {
  els.versionList.textContent = ''
  if (!versions.length) {
    const empty = document.createElement('li')
    empty.className = 'empty'
    empty.textContent = t('flow.loadingVersions')
    els.versionList.append(empty)
    return
  }
  const fragment = document.createDocumentFragment()
  for (const version of versions) {
    const item = document.createElement('li')
    item.setAttribute('role', 'option')
    item.dataset.version = version
    item.textContent = version
    if (version === selectedVersion) item.classList.add('active')
    const tag = Object.entries(versionTags).find(([, value]) => value === version)?.[0]
    if (tag) {
      const badge = document.createElement('span')
      badge.className = 'tag'
      badge.textContent = tag
      item.append(badge)
    }
    item.addEventListener('click', () => {
      selectedVersion = version
      renderVersionValue()
      renderVersionOptions()
      closeDropdown()
      if (flowMode === 'upgrade') buildPlan()
    })
    fragment.append(item)
  }
  els.versionList.append(fragment)
}

async function loadVersions() {
  try {
    const result = await window.api.listVersions()
    versions = Array.isArray(result?.versions) ? result.versions : []
    versionTags = result?.tags ?? {}
    if (!selectedVersion) {
      selectedVersion = result?.latest ?? versions[0] ?? null
      renderVersionValue()
      if (flowMode === 'upgrade' && !flowPlan) buildPlan()
    }
    if (result?.latest) els.latestTag.textContent = t('flow.latest', { version: result.latest })
    renderVersionOptions()
  } catch {
    versions = []
    renderVersionOptions()
  }
}

function openDropdown() {
  if (dropdownOpen) return
  dropdownOpen = true
  els.versionList.hidden = false
  els.combo.classList.add('open')
  els.versionPicker.setAttribute('aria-expanded', 'true')
  renderVersionOptions()
}

function closeDropdown() {
  dropdownOpen = false
  els.versionList.hidden = true
  els.combo.classList.remove('open')
  els.versionPicker.setAttribute('aria-expanded', 'false')
}

/* ---------- Flow panel ---------- */

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function openFlow(mode) {
  flowMode = mode
  flowPlan = null
  els.flow.hidden = false
  els.actions.hidden = true
  els.flowReport.textContent = ''
  els.flowSummary.classList.remove('err')
  els.flowTitle.textContent = t(mode === 'install' ? 'flow.installTitle' : 'flow.upgradeTitle')
  els.targetLabel.textContent = t(mode === 'install' ? 'flow.installVersion' : 'flow.targetVersion')
  els.flowPrimary.textContent = t(mode === 'install' ? 'flow.startInstall' : 'flow.startUpgrade')
  els.flowPrimary.disabled = mode === 'upgrade'
  els.flowNote.hidden = true
  if (mode === 'install') {
    els.flowSummary.textContent = t('flow.installSummary')
  } else {
    buildPlan()
  }
  if (!versions.length) loadVersions()
}

function closeFlow() {
  flowMode = null
  flowPlan = null
  planSeq += 1
  els.flow.hidden = true
  els.actions.hidden = false
  els.flowReport.textContent = ''
  closeDropdown()
}

async function buildPlan() {
  if (flowMode !== 'upgrade') return
  const seq = ++planSeq
  flowPlan = null
  els.flowReport.textContent = ''
  els.flowSummary.classList.remove('err')
  els.flowSummary.textContent = t('flow.checking', { version: selectedVersion ?? '' })
  els.flowPrimary.disabled = true

  let result
  try {
    result = await window.api.planUpgrade(selectedVersion)
  } catch (error) {
    if (seq !== planSeq) return
    els.flowSummary.textContent = error.message || t('flow.checkFailedUnknown')
    els.flowSummary.classList.add('err')
    return
  }
  if (seq !== planSeq || flowMode !== 'upgrade') return
  if (!result?.ok) {
    els.flowSummary.textContent = result?.message || t('flow.checkFailedUnknown')
    els.flowSummary.classList.add('err')
    return
  }
  flowPlan = result.plan
  renderPlan(result.plan)
}

function peerLabel(peer) {
  return peer ? `${peer.name} ${peer.range}` : ''
}

/** Builds a localized notice from the structured detail; falls back to the main-process copy when fields are missing. */
function pluginReason(item) {
  const detail = item.detail
  if (!detail) return item.reason ?? item.note ?? null
  if (detail.kind === 'pnpmMissing') return t('reason.pnpmMissing')
  if (detail.kind === 'unverified') return t('reason.unverified')
  if (detail.kind === 'optionalOnly') return t('reason.optionalOnly')
  if (detail.kind === 'localSource') {
    return t('reason.localSource', {
      name: item.name,
      version: item.current,
      peer: peerLabel(detail.peer),
      target: detail.target,
    })
  }
  if (detail.kind === 'queryFailed') {
    return t('reason.queryFailed', {
      name: item.name,
      version: item.current,
      peer: peerLabel(detail.peer),
      target: detail.target,
      error: detail.error,
    })
  }
  if (detail.kind === 'noCompatible') {
    return t('reason.noCompatible', {
      name: item.name,
      version: item.current,
      peer: peerLabel(detail.peer),
      target: detail.target,
      latest: detail.latest?.version ?? '—',
      latestPeer: peerLabel(detail.latest?.peer) || '—',
    })
  }
  if (detail.kind === 'noNewer') {
    return t('reason.noNewer', {
      name: item.name,
      version: item.current,
      peer: peerLabel(detail.peer),
      target: detail.target,
      picked: detail.picked,
    })
  }
  return item.reason ?? item.note ?? null
}

function renderPlan(plan) {
  const upgrades = plan.plugins.filter((item) => item.action === 'upgrade')
  els.flowSummary.classList.toggle('err', !plan.ok)
  if (plan.ok) {
    const pluginNote = upgrades.length
      ? t('flow.checkPassedPlugins', { count: upgrades.length })
      : t('flow.checkPassedNoPlugins')
    els.flowSummary.textContent = t('flow.checkPassed', {
      current: plan.currentDsh,
      target: plan.targetDsh,
      pluginNote,
    })
  } else {
    const names = plan.blockers.map((item) => item.name).join(', ')
    els.flowSummary.textContent = t('flow.checkFailed', { names })
  }

  const running = state?.status === 'running' || state?.status === 'external'
  els.flowNote.hidden = !plan.ok || !running
  els.flowNote.textContent = t('flow.stopNote')

  els.flowReport.textContent = ''
  if (plan.plugins.length) {
    const list = el('div', 'plugin-list')
    for (const plugin of plan.plugins) {
      const row = el('div', `plugin-row ${plugin.action}`)
      row.append(el('span', 'plugin-name mono', plugin.name))
      const versions = plugin.action === 'upgrade' ? `${plugin.current} → ${plugin.next}` : plugin.current
      row.append(el('span', 'plugin-ver mono', versions || '—'))
      const label =
        plugin.action === 'upgrade'
          ? t('badge.upgrade')
          : plugin.action === 'blocked'
            ? t('badge.blocked')
            : plugin.verified
              ? t('badge.keep')
              : t('badge.unverified')
      row.append(el('span', `badge ${plugin.action}`, label))
      const tip = pluginReason(plugin)
      if (tip) row.title = tip
      list.append(row)
    }
    els.flowReport.append(list)
  } else {
    els.flowReport.append(el('p', 'flow-empty', t('flow.noPlugins')))
  }

  if (plan.blockers.length) {
    const box = el('div', 'blocker-box')
    for (const blocker of plan.blockers) {
      const reason = pluginReason(blocker) ?? ''
      box.append(el('p', 'blocker-item', reason ? `${blocker.name}: ${reason}` : blocker.name))
    }
    box.append(el('p', 'blocker-tip', t('flow.blockerTip')))
    els.flowReport.append(box)
  }

  if (plan.ok && plan.commands.length) {
    els.flowReport.append(el('p', 'cmd-label', t('flow.commandsLabel')))
    for (const command of plan.commands) els.flowReport.append(el('code', 'cmd mono', command))
  }

  els.flowPrimary.disabled = !plan.ok
}

/* ---------- Status rendering ---------- */

function render(next) {
  state = next
  const status = next.status
  const busy = next.busy || BUSY_STATUS.has(status)
  const installed = Boolean(next.dshVersion)
  const outside = next.external ?? null
  const outsideRunning = status === 'external' && outside

  document.body.dataset.status = status
  els.statusText.textContent = statusText(status)
  els.dot.className = 'dot'
  if (busy) els.dot.classList.add('busy')
  else if (status === 'running' || status === 'external') els.dot.classList.add('on')

  if (next.dshVersion) {
    const suffix = outsideRunning
      ? t('version.external')
      : next.dshSource === 'system'
        ? t('version.system')
        : ''
    els.versionTag.textContent = `v${next.dshVersion}${suffix}`
  } else {
    els.versionTag.textContent = 'v—'
  }

  // Host is always 127.0.0.1 and is shown even when stopped; the port gets its own column.
  els.addr.textContent = '127.0.0.1'
  els.portValue.textContent = String(next.targetPort ?? 3080)
  els.portValue.title = t('sheet.portHint')
  if (next.latestVersion) {
    els.latestTag.textContent = t('flow.latest', { version: next.latestVersion })
    if (!selectedVersion) {
      selectedVersion = next.latestVersion
      renderVersionValue()
    }
  }

  els.secondary.hidden = !installed && !outsideRunning
  els.upgradeBtn.disabled = busy
  els.uninstallBtn.disabled = busy
  els.stopBtn.disabled = busy
  els.versionPicker.disabled = busy

  const canStop = status === 'running' || status === 'external'
  const managed = status === 'stopped' || status === 'running'
  els.stopBtn.hidden = !canStop
  els.upgradeBtn.hidden = !managed
  els.uninstallBtn.hidden = !managed

  if (status === 'running') {
    els.primary.textContent = t('action.open')
    els.primary.dataset.action = 'open'
    els.primary.disabled = false
  } else if (status === 'stopped') {
    els.primary.textContent = t('action.start')
    els.primary.dataset.action = 'start'
    els.primary.disabled = false
  } else if (status === 'not-installed') {
    els.primary.textContent = t('action.install')
    els.primary.dataset.action = 'install'
    els.primary.disabled = busy
  } else if (status === 'external') {
    els.primary.textContent = t('action.takeover')
    els.primary.dataset.action = 'takeover'
    els.primary.disabled = false
  } else {
    els.primary.textContent = t('action.working')
    els.primary.dataset.action = ''
    els.primary.disabled = true
  }

  syncPet()

  els.stopBtn.textContent = t('action.stop')
  els.upgradeBtn.textContent = t('action.upgrade')
  els.uninstallBtn.textContent = t('action.uninstall')

  els.nodeInfo.textContent = next.nodeVersion
    ? `Node ${next.nodeVersion}${next.npmVersion ? ` · npm ${next.npmVersion}` : ''}`
    : t('node.none')
  els.runtimeInfo.textContent = t(`runtime.${next.runtime === 'system' ? 'system' : 'missing'}`)

  const theme = THEMES.includes(next.theme) ? next.theme : 'dark'
  document.documentElement.dataset.theme = theme
  syncHeaderButtons(theme, next.lang)
  syncSettingsControls(theme, next.lang)
  renderSettingsSheet()
  showHint()
}

/* ---------- Custom confirm dialog ---------- */

let modalResolve = null

function closeModal(result) {
  if (els.modal.hidden) return
  els.modal.hidden = true
  document.removeEventListener('keydown', onModalKeydown, true)
  const resolve = modalResolve
  modalResolve = null
  if (resolve) resolve(result)
}

function onModalKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeModal(false)
  } else if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    closeModal(true)
  }
}

/** In-app confirm dialog: returns true when the user clicks confirm. */
function showModal({ title, lines = [], confirmText, cancelText, danger = false }) {
  closeModal(false)
  els.modalTitle.textContent = title
  els.modalBody.textContent = ''
  for (const line of lines) {
    if (!line) continue
    els.modalBody.append(el('p', null, line))
  }
  els.modalConfirm.textContent = confirmText || t('action.working')
  els.modalCancel.textContent = cancelText || t('dialog.cancel')
  els.modalConfirm.classList.toggle('danger', danger)
  els.modal.hidden = false
  document.addEventListener('keydown', onModalKeydown, true)
  els.modalConfirm.focus()
  return new Promise((resolve) => {
    modalResolve = resolve
  })
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !els.settings.hidden) {
    event.preventDefault()
    closeSettings()
  }
})

els.modalConfirm.addEventListener('click', () => closeModal(true))
els.modalCancel.addEventListener('click', () => closeModal(false))
els.modal.addEventListener('click', (event) => {
  if (event.target === els.modal) closeModal(false)
})

/* ---------- Actions ---------- */

async function runAction(fn, pendingText, doneText = '') {
  notice(pendingText, false)
  let result
  try {
    result = await fn()
  } catch (error) {
    reactPet('sad', 2200)
    notice(error.message || t('notice.actionFailed'), true)
    return
  }
  if (result && result.ok === false) {
    reactPet('sad', 2200)
    if (!result.cancelled) notice(result.message || t('notice.actionFailed'), true)
    else notice(t('notice.takeoverCancelled'))
    return
  }
  reactPet('celebrate', 2200)
  if (result?.url) notice(t('notice.startedUrl', { url: result.url }))
  else if (result?.message) notice(result.message)
  else notice(doneText || t('notice.actionFailed'))
  try {
    render(await window.api.getState())
  } catch {
    // Completed by the status event.
  }
}

els.primary.addEventListener('click', () => {
  const action = els.primary.dataset.action
  if (action === 'install') openFlow('install')
  else if (action === 'start') runAction(() => window.api.start(), t('notice.starting'), t('notice.started'))
  else if (action === 'open') runAction(() => window.api.open(), t('notice.opening'), t('notice.opened'))
  else if (action === 'takeover') confirmTakeover()
})

els.stopBtn.addEventListener('click', () => {
  runAction(() => window.api.stop(), t('notice.stopping'), t('notice.stopped'))
})

els.upgradeBtn.addEventListener('click', () => openFlow('upgrade'))

els.uninstallBtn.addEventListener('click', () => confirmUninstall())

async function confirmUninstall() {
  const running = state?.status === 'running' || state?.status === 'external'
  const localManaged = Boolean(state?.dshVersion)
  const lines = [t('uninstall.step1'), t('uninstall.keep')]
  if (running) lines.push(t('uninstall.running'))
  if (!localManaged) lines.push(t('uninstall.system'))
  const confirmed = await showModal({
    title: t('uninstall.title'),
    lines,
    confirmText: t('uninstall.confirm'),
    cancelText: t('dialog.cancel'),
    danger: true,
  })
  if (!confirmed) return
  runAction(() => window.api.uninstall(), t('notice.uninstalling'), t('notice.uninstalled'))
}

async function confirmTakeover() {
  const outside = state?.external
  const lines = outside ? [t('takeover.detail', { pid: outside.pid, port: outside.port })] : []
  const confirmed = await showModal({
    title: t('takeover.title'),
    lines,
    confirmText: t('takeover.confirm'),
    cancelText: t('dialog.cancel'),
  })
  if (!confirmed) return
  runAction(() => window.api.takeover(), t('notice.takingover'))
}

els.flowBack.addEventListener('click', closeFlow)

els.flowPrimary.addEventListener('click', () => {
  if (flowMode === 'install') {
    const version = selectedVersion
    closeFlow()
    runAction(() => window.api.install(version), t('notice.installing'), t('notice.installed'))
  } else if (flowMode === 'upgrade') {
    if (!flowPlan?.ok) return
    const plan = flowPlan
    closeFlow()
    runAction(() => window.api.applyUpgrade(plan), t('notice.upgrading'), t('notice.upgraded'))
  }
})

els.versionPicker.addEventListener('click', () => {
  if (dropdownOpen) closeDropdown()
  else openDropdown()
  if (!versions.length) loadVersions()
})

document.addEventListener('mousedown', (event) => {
  if (dropdownOpen && !els.combo.contains(event.target)) closeDropdown()
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (dropdownOpen) closeDropdown()
    else if (flowMode) closeFlow()
  }
})

async function applyTheme(theme) {
  const next = THEMES.includes(theme) ? theme : 'dark'
  document.documentElement.dataset.theme = next
  syncHeaderButtons(next, state?.lang)
  syncSettingsControls(next, state?.lang)
  await window.api.setTheme(next)
}

async function switchLanguage(lang) {
  const next = LANGS.includes(lang) ? lang : 'zh'
  state = { ...(state ?? {}), lang: next }
  await applyLanguage(next)
  window.api.setLang(next)
}

els.themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
  void applyTheme(next)
})

els.langBtn.addEventListener('click', () => {
  void switchLanguage(state?.lang === 'en' ? 'zh' : 'en')
})

els.quitBtn.addEventListener('click', () => requestQuit())

els.clearBtn.addEventListener('click', async () => {
  await window.api.clearLogs()
  els.log.textContent = ''
  const empty = document.createElement('div')
  empty.className = 'line placeholder'
  empty.textContent = t('console.cleared')
  els.log.append(empty)
})

/* ---------- Settings sheet ---------- */

let appInfo = null
let settings = null
let updateNoteTimer = null
let updateNoteState = { kind: 'idle', version: '' }

/** Header icons and the settings controls always mirror the live state, wherever it was changed. */
function syncSettingsControls(theme, lang) {
  const currentTheme = THEMES.includes(theme) ? theme : 'dark'
  for (const item of els.themeSeg.querySelectorAll('.seg-item')) {
    item.setAttribute('aria-checked', item.dataset.value === currentTheme ? 'true' : 'false')
  }
  const currentLang = lang === 'en' ? 'en' : 'zh'
  for (const item of els.langSeg.querySelectorAll('.seg-item')) {
    item.setAttribute('aria-checked', item.dataset.value === currentLang ? 'true' : 'false')
  }
}

/** The switch is a real button, so the checked state lives in aria-checked + data-on. */
function renderAutoLaunch(info) {
  const supported = Boolean(info?.supported) && Boolean(appInfo)
  const enabled = Boolean(info?.enabled)
  els.autoLaunch.disabled = !supported
  els.autoLaunch.dataset.on = enabled ? 'true' : 'false'
  els.autoLaunch.setAttribute('aria-checked', enabled ? 'true' : 'false')
  els.autoLaunchNote.hidden = false
  if (!appInfo) els.autoLaunchNote.textContent = '—'
  else if (!supported) els.autoLaunchNote.textContent = t('sheet.autoLaunchUnsupported')
  else els.autoLaunchNote.textContent = t(enabled ? 'sheet.autoLaunchOn' : 'sheet.autoLaunchOff')
}

/** Switches are plain buttons: the state lives in aria-checked (and data-on for the CSS knob). */
function setSwitch(button, on) {
  button.dataset.on = on ? 'true' : 'false'
  button.setAttribute('aria-checked', on ? 'true' : 'false')
}

/** Paint every control from the settings snapshot; called on open, after every write and on language change. */
function renderSettingsSheet() {
  if (!settings) return
  setSwitch(els.openInBrowser, Boolean(settings.openInBrowser))
  setSwitch(els.telemetry, settings.telemetry !== false)
  setSwitch(els.autoUpdateCheck, settings.autoUpdateCheck !== false)

  for (const item of els.registrySeg.querySelectorAll('.seg-item')) {
    item.setAttribute('aria-checked', item.dataset.value === settings.npmRegistry ? 'true' : 'false')
  }

  if (document.activeElement !== els.proxyField) els.proxyField.value = settings.proxy ?? ''
  if (document.activeElement !== els.argsField) els.argsField.value = settings.dshArgs ?? ''
  if (document.activeElement !== els.portField) els.portField.value = String(settings.port ?? 3080)

  const locked = state?.status === 'running' || state?.status === 'external'
  els.portField.disabled = locked
  els.portNote.textContent = locked ? t('sheet.portLocked') : t('sheet.portHint')

  els.proxyNote.textContent = t('sheet.proxyHint')
  els.proxyNote.classList.remove('is-error')
  const droppedNow = parseArgsPreview(settings.dshArgs ?? '')
  els.argsNote.textContent = droppedNow.length
    ? t('sheet.argsDropped', { args: droppedNow.join(' ') })
    : t('sheet.argsHint')
  els.argsNote.classList.toggle('is-error', droppedNow.length > 0)
}

/**
 * Client-side mirror of the main-process whitelist, only to show the user what will be
 * ignored. The main process stays authoritative.
 */
function parseArgsPreview(text) {
  const tokens = String(text ?? '').trim().split(/\s+/).filter(Boolean)
  const longFlag = /^--[A-Za-z0-9][A-Za-z0-9._-]*(=[A-Za-z0-9._:@/%,+~=-]+)?$/
  const shortFlag = /^-[A-Za-z]$/
  const value = /^[A-Za-z0-9][A-Za-z0-9._:@,+~=-]*$/
  const portFlag = /^(--port|--listen|-p)(=|$)/
  const dropped = []
  let expectValue = false
  let dropValue = false
  for (const token of tokens) {
    if (token.startsWith('-')) {
      if (portFlag.test(token)) {
        dropped.push(token)
        dropValue = !token.includes('=')
        expectValue = false
        continue
      }
      if (!longFlag.test(token) && !shortFlag.test(token)) {
        dropped.push(token)
        dropValue = false
        expectValue = false
        continue
      }
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
    if (expectValue && value.test(token)) {
      expectValue = false
      continue
    }
    dropped.push(token)
    expectValue = false
  }
  return dropped
}

/** Persist one patch and repaint; returns the main-process answer so callers can flag errors. */
async function patchSettings(patch) {
  const result = await window.api.setSettings(patch).catch(() => null)
  if (result?.ok) {
    settings = { ...(settings ?? {}), ...result.settings }
    renderSettingsSheet()
  }
  return result
}

const UPDATE_NOTE_KEYS = {
  idle: 'sheet.updateCurrent',
  checking: 'sheet.updateChecking',
  found: 'sheet.updateFound',
  latest: 'sheet.updateLatest',
  failed: 'sheet.updateFailed',
}

/** One state object drives the note, so switching language re-renders the current message instead of a stale one. */
function renderUpdateNote(kind = updateNoteState.kind, version = updateNoteState.version) {
  updateNoteState = { kind, version }
  const key = UPDATE_NOTE_KEYS[kind] || UPDATE_NOTE_KEYS.idle
  els.updateNote.textContent = t(key, { version: version || appInfo?.version || '—' })
}

async function openSettings() {
  closeModal(false)
  try {
    appInfo = await window.api.getAppInfo()
  } catch {
    appInfo = null
  }
  try {
    settings = await window.api.getSettings()
  } catch {
    settings = null
  }
  els.settingsVersion.textContent = `v${appInfo?.version ?? '—'}`
  clearTimeout(updateNoteTimer)
  els.updateBtn.textContent = t('update.check')
  els.updateBtn.disabled = false
  renderUpdateNote('idle', appInfo?.version)
  renderAutoLaunch(appInfo?.autoLaunch)
  syncSettingsControls(document.documentElement.dataset.theme, state?.lang)
  renderSettingsSheet()
  els.settings.hidden = false
  document.body.classList.add('sheet-open')
  // Focus the card, not the close button: a focused X draws a focus ring on open.
  document.querySelector('.sheet-card').focus({ preventScroll: true })
}

function closeSettings() {
  els.settings.hidden = true
  document.body.classList.remove('sheet-open')
}

async function openExternal(url) {
  if (!url) return
  await window.api.openExternal(url).catch(() => null)
}

/** Update checks report through the button label plus one line of status text. */
async function checkUpdates() {
  clearTimeout(updateNoteTimer)
  els.updateBtn.textContent = t('update.checking')
  els.updateBtn.disabled = true
  renderUpdateNote('checking')
  try {
    const result = await window.api.checkUpdate()
    if (!result?.ok) {
      els.updateBtn.textContent = t('update.failed')
      renderUpdateNote('failed')
      return
    }
    if (result.hasUpdate) {
      els.updateBtn.textContent = t('update.found')
      renderUpdateNote('found', result.latest)
      promptUpdate(result)
    } else {
      els.updateBtn.textContent = t('update.latest')
      renderUpdateNote('latest', result.latest || appInfo?.version)
    }
  } finally {
    els.updateBtn.disabled = false
    updateNoteTimer = setTimeout(() => {
      els.updateBtn.textContent = t('update.check')
      renderUpdateNote('idle', appInfo?.version)
    }, 4000)
  }
}

async function promptUpdate(info) {
  closeSettings()
  const confirmed = await showModal({
    title: t('update.title'),
    lines: [
      t('update.detail', { current: info.current ?? appInfo?.version ?? '—', latest: info.latest }),
    ],
    confirmText: t('update.go'),
    cancelText: t('update.later'),
  })
  if (confirmed) await openExternal(info.url || appInfo?.site)
}

els.settingsBtn.addEventListener('click', openSettings)
els.settingsClose.addEventListener('click', closeSettings)
els.settings.addEventListener('click', (event) => {
  if (event.target === els.settings) closeSettings()
})
els.devEmail.addEventListener('click', () => openExternal(`mailto:${appInfo?.developer?.email || ''}`))
els.devName.addEventListener('click', () => openExternal(appInfo?.developer?.github))
els.devGithub.addEventListener('click', () => openExternal(appInfo?.github))
els.devSite.addEventListener('click', () => openExternal(appInfo?.site))
els.sponsorBtn.addEventListener('click', () => openExternal(appInfo?.developer?.github))
els.updateBtn.addEventListener('click', () => checkUpdates())

els.themeSeg.addEventListener('click', (event) => {
  const item = event.target.closest('.seg-item')
  if (item) void applyTheme(item.dataset.value)
})

els.langSeg.addEventListener('click', (event) => {
  const item = event.target.closest('.seg-item')
  if (item) void switchLanguage(item.dataset.value)
})

/** Boolean settings: the switch flips optimistically, and reverts if the main process refuses. */
function bindSwitch(button, key) {
  button.addEventListener('click', async () => {
    const next = button.dataset.on !== 'true'
    setSwitch(button, next)
    const result = await window.api.setSettings({ [key]: next }).catch(() => null)
    if (result?.ok) {
      settings = { ...(settings ?? {}), ...result.settings }
      renderSettingsSheet()
    } else {
      setSwitch(button, !next)
    }
  })
}

bindSwitch(els.openInBrowser, 'openInBrowser')
bindSwitch(els.telemetry, 'telemetry')
bindSwitch(els.autoUpdateCheck, 'autoUpdateCheck')

els.registrySeg.addEventListener('click', (event) => {
  const item = event.target.closest('.seg-item')
  if (item) void patchSettings({ npmRegistry: item.dataset.value })
})

/** Proxy: saved on Enter or on blur; an unparsable value is rejected and the field reverts. */
async function commitProxy() {
  if (!settings) return
  const raw = els.proxyField.value
  const result = await patchSettings({ proxy: raw })
  if (!result) return
  const stored = result.settings?.proxy ?? ''
  const invalid = Boolean(String(raw).trim()) && !stored
  els.proxyField.value = stored
  els.proxyField.classList.toggle('is-invalid', invalid)
  els.proxyNote.textContent = invalid ? t('sheet.proxyInvalid') : t('sheet.proxyHint')
  els.proxyNote.classList.toggle('is-error', invalid)
}

/** Extra DSH arguments: the main process reports which tokens it refused. */
async function commitArgs() {
  if (!settings) return
  const result = await patchSettings({ dshArgs: els.argsField.value })
  if (!result) return
  const dropped = result.dropped ?? []
  els.argsNote.textContent = dropped.length
    ? t('sheet.argsDropped', { args: [...new Set(dropped)].join(' ') })
    : t('sheet.argsHint')
  els.argsNote.classList.toggle('is-error', dropped.length > 0)
}

/** Port: only editable while DSH is stopped, and it takes effect on the next start. */
async function commitPort() {
  if (!settings || els.portField.disabled) return
  const port = Number(String(els.portField.value).trim())
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    els.portField.classList.add('is-invalid')
    els.portNote.classList.add('is-error')
    els.portNote.textContent = t('sheet.portInvalid')
    els.portField.value = String(settings.port ?? 3080)
    return
  }
  if (port === settings.port) {
    els.portField.classList.remove('is-invalid')
    return
  }
  const result = await window.api.setPort(port).catch(() => null)
  if (!result?.ok) {
    els.portField.classList.add('is-invalid')
    els.portNote.classList.add('is-error')
    els.portNote.textContent = result?.message || t('sheet.saveFailed')
    els.portField.value = String(settings.port ?? 3080)
    return
  }
  settings = { ...settings, port: result.port ?? port }
  els.portField.value = String(settings.port)
  els.portField.classList.remove('is-invalid')
  els.portNote.classList.remove('is-error')
  els.portNote.textContent = t('sheet.portSaved', { port: settings.port })
  try {
    render(await window.api.getState())
  } catch {
    // Completed by the status event.
  }
}

/** Enter saves, Escape restores the stored value, blur saves too — one shared behaviour. */
function bindField(input, commit) {
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void commit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      renderSettingsSheet()
      input.blur()
    }
  })
  input.addEventListener('blur', () => {
    void commit()
  })
}

bindField(els.portField, commitPort)
bindField(els.proxyField, commitProxy)
bindField(els.argsField, commitArgs)

/** Turning the switch: the main process owns the OS login item, the button only reflects the result. */
els.autoLaunch.addEventListener('click', async () => {
  if (els.autoLaunch.disabled) return
  const next = els.autoLaunch.dataset.on !== 'true'
  els.autoLaunch.disabled = true
  try {
    const result = await window.api.setAutoLaunch(next)
    if (result?.ok) {
      appInfo = { ...(appInfo ?? {}), autoLaunch: { supported: result.supported, enabled: result.enabled } }
      renderAutoLaunch(appInfo.autoLaunch)
    } else {
      els.autoLaunchNote.textContent = t('sheet.autoLaunchFailed')
    }
  } catch {
    els.autoLaunchNote.textContent = t('sheet.autoLaunchFailed')
  } finally {
    const supported = Boolean(appInfo?.autoLaunch?.supported)
    els.autoLaunch.disabled = !supported
  }
})

window.api.onEvent((payload) => {
  if (payload.type === 'log') appendLine(payload.line)
  else if (payload.type === 'state') render(payload.state)
  else if (payload.type === 'quit-request') requestQuit()
  else if (payload.type === 'update-available') promptUpdate(payload)
})

/** Quit confirmation: the UI button, Cmd+Q and the menu all share the same custom dialog. */
async function requestQuit() {
  if (!els.modal.hidden) return
  const running = state?.status === 'running' || state?.status === 'external'
  const confirmed = await showModal({
    title: t('quit.title'),
    lines: [t(running ? 'quit.detailRunning' : 'quit.detailIdle')],
    confirmText: t('quit.confirm'),
    cancelText: t('dialog.cancel'),
    danger: true,
  })
  if (confirmed) await window.api.quit()
}

/* ---------- Boot overlay ---------- */

const BOOT_MIN_MS = 360
let bootHidden = false
const bootStartedAt = Date.now()

/** Remove the overlay once the first state is ready; always remove it, success or failure, so the spinner never gets stuck. */
function finishBoot() {
  if (bootHidden) return
  bootHidden = true
  const wait = Math.max(0, BOOT_MIN_MS - (Date.now() - bootStartedAt))
  setTimeout(() => {
    els.boot.classList.add('is-hidden')
    setTimeout(() => {
      els.boot.hidden = true
    }, 260)
  }, wait)
}

/** Language switch: swap the dictionary, re-render static and dynamic copy, then re-render from the current state. */
async function applyLanguage(lang) {
  closeModal(false)
  window.i18n.lang = LANGS.includes(lang) ? lang : 'zh'
  document.documentElement.lang = window.i18n.lang === 'en' ? 'en' : 'zh-CN'
  applyStaticTexts()
  if (state) render(state)
  syncHeaderButtons(document.documentElement.dataset.theme, window.i18n.lang)
  syncSettingsControls(document.documentElement.dataset.theme, window.i18n.lang)
  renderSettingsSheet()
  renderUpdateNote()
  renderVersionValue()
  renderVersionOptions()
  if (flowMode) {
    els.flowTitle.textContent = t(flowMode === 'install' ? 'flow.installTitle' : 'flow.upgradeTitle')
    els.targetLabel.textContent = t(flowMode === 'install' ? 'flow.installVersion' : 'flow.targetVersion')
    els.flowPrimary.textContent = t(flowMode === 'install' ? 'flow.startInstall' : 'flow.startUpgrade')
    if (flowPlan) renderPlan(flowPlan)
  }
  renderLogs(logLines)
}

async function boot() {
  // Fallback: never keep spinning even if the main process misbehaves.
  const guard = setTimeout(() => {
    if (bootHidden) return
    finishBoot()
    notice(t('notice.readStateTimeout'), true)
  }, 8000)

  try {
    const [logs, current] = await Promise.all([
      window.api.getLogs().catch(() => ({ lines: [] })),
      window.api.getState(),
    ])
    await applyLanguage(current.lang)
    renderLogs(logs?.lines ?? [])
    renderVersionValue()
    render(current)
  } catch (error) {
    notice(error.message || t('notice.readStateFailed'), true)
  } finally {
    clearTimeout(guard)
    finishBoot()
    loadVersions()
  }
}

boot()
