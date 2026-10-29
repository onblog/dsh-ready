/**
 * DSH Ready website front end: language switch + release info + chunked download + release manifest.
 *
 * Zero dependencies, zero third-party requests: no CDN, no analytics script, no font service.
 * Only two endpoints of our own: /api/release (release manifest) and /api/download (direct R2 transfer).
 * Usage stats only accept anonymous launch signals reported by the desktop app; the page itself reports nothing.
 *
 * Download logic and page logic deliberately live in the same file: split into two files they would be cached
 * separately, and a single release could pair a new app.js with an old download.js, breaking the page outright.
 */

const LANG_KEY = 'dsh-ready-lang';

/* ------------------------------------------------------------------ i18n */

const messages = {
  zh: {
    'meta.title': 'DSH 就位 · 一键装好 DeepSeek Harness 的桌面启动器',
    brand: 'DSH 就位',
    'nav.features': '功能',
    'nav.shots': '截图',
    'nav.stats': '数据',

    'hero.kicker': '开源 · 个人免费 · 不采集隐私',
    'hero.tagline': '零基础小白，也能一键跑起 DeepSeek Harness',
    'hero.desc':
      '下载、双击、点一下：装好、启动、升级全自动完成。不用装 Node，不用记命令，不用管端口，第一次用也能直接跑起来。',
    'hero.cta': '选择你的系统',
    'hero.source': '查看源码',
    'hero.chip.free': 'AGPL-3.0 开源',
    'hero.float.running': '运行中',
    'hero.float.installed': '已装好',
    'hero.float.oneclick': '一次点击',
    'hero.float.plugins': '插件兼容检查',
    'hero.float.before': '升级前自动核对',

    'download.title': '下载 DSH 就位',
    'download.sub': '选一个平台，下载完直接打开就能用。',
    'download.latest': '最新版本',
    'download.recommended': '推荐',
    'download.macArmHint': 'M1 / M2 / M3 / M4 芯片',
    'download.macArm': '下载 Apple Silicon 版',
    'download.macIntelHint': 'Intel 芯片的 Mac',
    'download.macIntel': '下载 Intel 版',
    'download.winHint': 'Windows 10 / 11',
    'download.win': '下载 Windows 版',
    'download.macHint': '首次打开若被系统拦截：系统设置 → 隐私与安全性 →「仍要打开」；macOS 14 及更早可右键图标选「打开」。',
    'download.winOpenHint': '安装包未签名，SmartScreen 提示时点「更多信息」→「仍要运行」。',
    'download.cancel': '取消',
    'download.retry': '重试',
    'download.direct': '改用直链下载',
    'download.starting': '正在建立连接…',
    'download.progress': '正在下载',
    'download.done': '下载完成，已存入「下载」文件夹',
    'download.failed': '下载失败，可以重试或改用直链',
    'download.unavailable': '这个平台的安装包还在上传，稍后再来',
    'download.loadFailed': '没能读到版本信息，请刷新页面重试',
    'download.size': '大小',
    'download.network': '网络中断，已重试 3 次',

    'gk.title': '首次打开需要允许一次',
    'gk.intro':
      '安装包已下载完成。它不是从 App Store 安装的，macOS 第一次会拦下它——这是正常现象，放行一次即可。',
    'gk.step1': '双击打开 App，看到「未打开 “DSH 就位.app”」的提示时，点「完成」。',
    'gk.step2':
      '打开「系统设置 → 隐私与安全性」，在「安全性」区域找到被阻止的 App，点「仍要打开」。',
    'gk.step3': '输入 Mac 密码或使用触控 ID，之后就能正常双击打开。',
    'gk.note': '如果系统提示「已损坏」，在「终端」里执行一次下面的命令：',
    'gk.copy': '复制',
    'gk.copied': '已复制',
    'gk.ok': '我知道了',

    'features.title': '只做七件事，件件做到底',
    'features.sub': '安装、启动、停止、状态、日志、升级、卸载。',
    'features.install.title': '一次点击装好',
    'features.install.desc':
      '没有 Node 也能装：自动用 nvm 装到 ~/.nvm 并写入 shell 配置，再用 npm 默认全局前缀安装 DSH，不需要 sudo。',
    'features.env.title': '和你终端里一模一样',
    'features.env.desc':
      '启动前读取登录 shell 环境，API Key、代理、PATH 都会带进去，不会出现「终端能跑、双击打不开」。',
    'features.external.title': '不和你抢端口',
    'features.external.desc': '检测同一端口上的外部实例，可以一键接管重启；其它端口的 DSH 不会被碰。',
    'features.upgrade.title': '升级前先核对插件',
    'features.upgrade.desc':
      '逐个检查第三方插件声明的 DSH 兼容范围，有阻塞项只提示、不动现有环境；通过后才列出命令并执行。',
    'features.log.title': '日志看得懂',
    'features.log.desc':
      '启动、就绪、崩溃、升级结果都写进日志面板并落盘，失败时能自己看出卡在哪一步。',
    'features.uninstall.title': '卸载不误伤数据',
    'features.uninstall.desc':
      '停实例 → 卸插件 → 清配置 → 卸本体，但保留 ~/.dsh 里的会话与凭据，重装后还能接上。',

    'shots.title': '真的长这样',
    'shots.sub': '界面截图来自沙箱里真实运行的 DSH 就位，没有后期拼贴。',
    'shots.light': '浅色主题 · 运行中',
    'shots.dark': '深色主题 · 已停止',

    'steps.title': '三步就能用',
    'steps.one.title': '下载并打开',
    'steps.one.desc': '选对应平台的安装包，拖进「应用程序」后打开。',
    'steps.two.title': '点「安装 DSH」',
    'steps.two.desc': '默认装最新版，也可以在版本下拉里挑一个。',
    'steps.three.title': '点「启动」',
    'steps.three.desc': '就绪后自动用浏览器打开，之后升级、停止都在这个窗口里。',

    'statsStrip.title': '有多少人在一起用',
    'statsStrip.sub': '只统计桌面应用上报的匿名启动信号，不含 IP、不含设备指纹；数据看板是公开的。',
    'statsStrip.total': '总用户量',
    'statsStrip.today': '今日活跃',
    'statsStrip.week': '近 7 日活跃',
    'statsStrip.more': '打开完整数据看板 →',

    'faq.title': '常见问题',
    'faq.free.q': '要钱吗？',
    'faq.free.a':
      'DSH 就位本身免费开源（AGPL-3.0-only）。个人使用、学习、二次开发都不要钱；如果你要在闭源商业产品里使用，需要一份商业授权。',
    'faq.official.q': '它是 DeepSeek 官方项目吗？',
    'faq.official.a':
      '不是。它是社区做的第三方桌面启动器，只负责安装、启动、升级官方 DSH，不修改 DSH 本体，也不替代它的 Web 界面。',
    'faq.privacy.q': '会收集我的数据吗？',
    'faq.privacy.a':
      '官网只记录匿名设备数与下载次数，用来告诉你「有多少人在用」。不写 IP、不写设备指纹、不设 Cookie，也没有任何第三方统计脚本。桌面应用本身不上报任何数据。',
    'faq.unsigned.q': '为什么打开时被系统拦住了？',
    'faq.unsigned.a':
      'macOS 安装包带 ad-hoc 签名，但没有苹果公证。首次打开若被系统拦截，到「系统设置 → 隐私与安全性」点「仍要打开」（macOS 14 及更早可右键图标选「打开」）；Windows 上点「更多信息 → 仍要运行」。',
    'faq.existing.q': '我已经在终端里装过 DSH 了，还用吗？',
    'faq.existing.a':
      '可以直接用：DSH 就位会优先复用系统里已装的 DSH，只负责帮你启停、看日志、升级，不会重复安装。',

    'footer.tagline': '一个蓝色的小窗口，管住 DeepSeek Harness 的七件事。',
    'footer.docs': '文档',
    'footer.stats': '使用数据',
    'footer.issues': '反馈',
    'footer.legal':
      '第三方项目，与 DeepSeek 官方无关。代码以 AGPL-3.0-only 授权，商业用途需另行授权。',
  },

  en: {
    'meta.title': 'DSH Ready — one-click desktop launcher for DeepSeek Harness',
    brand: 'DSH Ready',
    'nav.features': 'Features',
    'nav.shots': 'Screenshots',
    'nav.stats': 'Usage',

    'hero.kicker': 'Open source · free for personal use · privacy first',
    'hero.tagline': 'Zero experience needed — DeepSeek Harness in one click',
    'hero.desc':
      'Download, open, click once. Installation, startup and upgrades happen automatically — no Node, no commands, no ports to manage, even on a first try.',
    'hero.cta': 'Choose your platform',
    'hero.source': 'View source',
    'hero.chip.free': 'AGPL-3.0 licensed',
    'hero.float.running': 'Running',
    'hero.float.installed': 'Installed',
    'hero.float.oneclick': 'in one click',
    'hero.float.plugins': 'Plugin check',
    'hero.float.before': 'before every upgrade',

    'download.title': 'Download DSH Ready',
    'download.sub': 'Pick a platform and it is ready to open.',
    'download.latest': 'Latest',
    'download.recommended': 'Recommended',
    'download.macArmHint': 'M1 / M2 / M3 / M4',
    'download.macArm': 'Download for Apple Silicon',
    'download.macIntelHint': 'Intel-based Mac',
    'download.macIntel': 'Download for Intel',
    'download.winHint': 'Windows 10 / 11',
    'download.win': 'Download for Windows',
    'download.macHint':
      'If macOS blocks the first launch: System Settings → Privacy & Security → Open Anyway. On macOS 14 and older, right-click the app and choose Open.',
    'download.winOpenHint':
      'The installer is unsigned. If SmartScreen appears, choose More info → Run anyway.',
    'download.cancel': 'Cancel',
    'download.retry': 'Retry',
    'download.direct': 'Use the direct link instead',
    'download.starting': 'Connecting…',
    'download.progress': 'Downloading',
    'download.done': 'Download complete — saved to your Downloads folder',
    'download.failed': 'Download failed. Retry, or use the direct link.',
    'download.unavailable': 'This platform is still uploading, please check back soon',
    'download.loadFailed': 'Could not read the release info, please refresh',
    'download.size': 'Size',
    'download.network': 'Network interrupted; retried 3 times',

    'gk.title': 'Allow it once on first launch',
    'gk.intro':
      'The download finished. The app is not distributed through the App Store, so macOS blocks it once — that is expected. Allow it and it will open normally from then on.',
    'gk.step1': 'Double-click the app. When macOS says it cannot verify “DSH 就位.app”, choose “Done”.',
    'gk.step2':
      'Open System Settings → Privacy & Security. In the Security section, find the blocked app and choose “Open Anyway”.',
    'gk.step3': 'Enter your Mac password or use Touch ID. The app will open normally afterwards.',
    'gk.note': 'If macOS reports the app is damaged, run this once in Terminal:',
    'gk.copy': 'Copy',
    'gk.copied': 'Copied',
    'gk.ok': 'Got it',

    'features.title': 'Seven things, done properly',
    'features.sub': 'Install, start, stop, status, logs, upgrade, uninstall.',
    'features.install.title': 'Installed in one click',
    'features.install.desc':
      'No Node needed. It installs Node 22 through nvm into ~/.nvm, wires it into your shell profile, and installs DSH into npm\'s default global prefix — no sudo.',
    'features.env.title': 'Same environment as your terminal',
    'features.env.desc':
      'It reads your login shell environment before starting, so API keys, proxies and PATH come along. No more “works in the terminal, broken on double-click”.',
    'features.external.title': 'Never fights over a port',
    'features.external.desc':
      'It detects an instance already listening on the target port and can take it over. DSH on other ports is left alone.',
    'features.upgrade.title': 'Plugins checked before upgrading',
    'features.upgrade.desc':
      'Every third-party plugin is checked against the target version first. Blockers are reported, nothing is touched; only then are the commands shown and run.',
    'features.log.title': 'Logs you can read',
    'features.log.desc':
      'Startup, ready, crash and upgrade results all land in the log panel and on disk, so you can see which step failed.',
    'features.uninstall.title': 'Uninstall without losing data',
    'features.uninstall.desc':
      'Stop instance → remove plugins → clear profile → remove DSH, while keeping ~/.dsh sessions and credentials.',

    'shots.title': 'This is what it looks like',
    'shots.sub': 'Screenshots captured from the real app running inside a sandbox.',
    'shots.light': 'Light theme · running',
    'shots.dark': 'Dark theme · stopped',

    'steps.title': 'Running in three steps',
    'steps.one.title': 'Download and open',
    'steps.one.desc': 'Pick your platform, move the app to Applications, open it.',
    'steps.two.title': 'Click “Install DSH”',
    'steps.two.desc': 'The latest version is selected by default; the dropdown offers others.',
    'steps.three.title': 'Click “Start”',
    'steps.three.desc':
      'It opens DSH in your browser when ready. Upgrades and stops happen in the same window.',

    'statsStrip.title': 'Who is using it',
    'statsStrip.sub':
      'Anonymous launch signals sent by the desktop app only — no IPs, no fingerprints. The dashboard is public.',
    'statsStrip.total': 'Total users',
    'statsStrip.today': 'Active today',
    'statsStrip.week': 'Active in 7 days',
    'statsStrip.more': 'Open the full dashboard →',

    'faq.title': 'FAQ',
    'faq.free.q': 'Does it cost anything?',
    'faq.free.a':
      'DSH Ready is free and open source under AGPL-3.0-only. Personal use, learning and forking are free. If you bundle it into a closed-source commercial product, you need a commercial licence.',
    'faq.official.q': 'Is this an official DeepSeek project?',
    'faq.official.a':
      'No. It is a community-made desktop shell that installs, starts and upgrades the official DSH. It does not modify DSH and does not replace its web UI.',
    'faq.privacy.q': 'Does it collect my data?',
    'faq.privacy.a':
      'The site counts anonymous devices and downloads only, so the “who is using it” numbers are honest. No IP, no fingerprint, no cookies, no third-party scripts. The desktop app reports nothing at all.',
    'faq.unsigned.q': 'Why does the system block the app?',
    'faq.unsigned.a':
      'The macOS build is ad-hoc signed but not notarized. If the first launch is blocked, open System Settings → Privacy & Security and choose Open Anyway (on macOS 14 and older, right-click the app and choose Open). On Windows, choose More info → Run anyway.',
    'faq.existing.q': 'I already installed DSH in my terminal — should I still use this?',
    'faq.existing.a':
      'Yes. DSH Ready reuses the DSH already installed on your system and only helps with starting, stopping, logs and upgrades. It will not install a second copy.',

    'footer.tagline': 'One small blue window for the seven things DSH needs.',
    'footer.docs': 'Docs',
    'footer.stats': 'Usage data',
    'footer.issues': 'Issues',
    'footer.legal':
      'A third-party project, not affiliated with DeepSeek. Licensed AGPL-3.0-only; commercial use requires a separate licence.',
  },
};

function resolveLang() {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved === 'zh' || saved === 'en') return saved;
  return (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

let lang = resolveLang();

function t(key) {
  return messages[lang]?.[key] ?? messages.zh[key] ?? key;
}

function applyLanguage(next) {
  lang = next;
  localStorage.setItem(LANG_KEY, lang);
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';

  document.title = t('meta.title');
  const title = document.querySelector('title');
  if (title) title.textContent = t('meta.title');

  for (const node of document.querySelectorAll('[data-i18n]')) {
    const key = node.dataset.i18n;
    if (!(key in messages.zh)) continue;
    node.textContent = t(key);
  }

  for (const node of document.querySelectorAll('[data-i18n-html]')) {
    const key = node.dataset.i18nHtml;
    if (!(key in messages.zh)) continue;
    node.innerHTML = t(key);
  }

  const label = document.getElementById('lang-label');
  if (label) label.textContent = lang === 'zh' ? 'EN' : '中文';
  const toggle = document.getElementById('lang-toggle');
  if (toggle) toggle.setAttribute('aria-label', lang === 'zh' ? 'Switch to English' : '切换到中文');

  // Screenshots are captured in both languages; show the matching set.
  for (const img of document.querySelectorAll('img[data-src-zh]')) {
    const src = lang === 'zh' ? img.dataset.srcZh : img.dataset.srcEn;
    if (src && img.getAttribute('src') !== src) img.setAttribute('src', src);
  }

  document.dispatchEvent(new CustomEvent('langchange', { detail: lang }));
}

/* ------------------------------------------------------------------ util */

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* --------------------------------------------------------------- download */

const CHUNK_COUNT_LARGE = 8;
const CHUNK_COUNT_SMALL = 4;
const LARGE_FILE = 50 * 1024 * 1024;

/**
 * Split one installer into ranged requests and report progress as they land.
 * The win is link utilisation, not exceeding the bandwidth cap: when one
 * connection is throttled, parallel chunks add up. Requires the Worker to
 * answer with 206 + Content-Range, which /api/download does.
 */
async function downloadInParallel(url, size, onProgress, signal) {
  const chunkCount = size >= LARGE_FILE ? CHUNK_COUNT_LARGE : CHUNK_COUNT_SMALL;
  const chunkSize = Math.ceil(size / chunkCount);
  const parts = new Array(chunkCount).fill(null);
  let loaded = 0;

  const fetchChunk = async (index) => {
    const start = index * chunkSize;
    const end = Math.min(start + chunkSize - 1, size - 1);
    if (start > end) return;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: { Range: `bytes=${start}-${end}` },
          signal,
        });
        if (response.status !== 206) throw new Error(`unexpected status ${response.status}`);

        const reader = response.body.getReader();
        const buffers = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffers.push(value);
          loaded += value.length;
          onProgress?.(loaded, size);
        }
        parts[index] = new Blob(buffers);
        return;
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        if (attempt === 2) throw error;
        await delay(400 * (attempt + 1));
      }
    }
  };

  await Promise.all(Array.from({ length: chunkCount }, (_, index) => fetchChunk(index)));
  return new Blob(parts, { type: 'application/octet-stream' });
}

/** Save through a plain anchor: a file picker before the transfer is friction. */
function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/* ------------------------------------------------------------ page wiring */

let manifest = { version: null, released_at: null, files: {} };
let activeDownload = null;

function cardFor(arch) {
  return document.querySelector(`.dl-card[data-arch="${arch}"]`);
}

function setStatus(text, isError = false) {
  const status = document.getElementById('download-status');
  if (!status) return;
  status.textContent = text || '';
  status.style.color = isError ? 'var(--pink)' : '';
}

function setButtonState(card, state) {
  const button = card?.querySelector('.dl-btn');
  if (!button) return;
  const arch = card.dataset.arch;
  const key =
    state === 'done'
      ? 'download.done'
      : state === 'retry'
        ? 'download.retry'
        : arch === 'arm64'
          ? 'download.macArm'
          : arch === 'x64'
            ? 'download.macIntel'
            : 'download.win';
  const label = button.querySelector('.dl-btn__label');
  if (label) label.textContent = t(key);
  button.disabled = state === 'busy';
}

function updateRecommendation() {
  const ua = navigator.userAgent;
  const isMac = /Mac OS X|Macintosh/i.test(ua);
  const isWindows = /Windows NT/i.test(ua);
  let arch = null;

  if (isMac) {
    // Safari/Chrome do not expose the CPU model, but WebGL usually names it.
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl');
      const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
      arch = /Apple\s*M\d/i.test(renderer) ? 'arm64' : /Intel|AMD|Radeon/i.test(renderer) ? 'x64' : null;
    } catch {
      arch = null;
    }
    if (!arch) arch = 'arm64'; // every Mac sold since 2020 is Apple Silicon
  } else if (isWindows) {
    arch = 'win-x64';
  }

  for (const badge of document.querySelectorAll('[data-recommend-for]')) {
    const target = badge.dataset.recommendFor;
    const match =
      (target === 'mac-arm64' && arch === 'arm64') ||
      (target === 'mac-x64' && arch === 'x64') ||
      (target === 'win' && arch === 'win-x64');
    badge.hidden = !match;
  }
}

function renderManifest() {
  const versionLine = document.getElementById('version-line');
  const versionValue = document.getElementById('version-value');
  const releasedValue = document.getElementById('released-value');
  if (versionLine && versionValue && manifest.version) {
    versionValue.textContent = `v${manifest.version}`;
    if (releasedValue) releasedValue.textContent = manifest.released_at || '';
    versionLine.hidden = false;
  }

  for (const [arch, file] of Object.entries(manifest.files || {})) {
    const sizeEl = document.querySelector(`[data-size-for="${arch}"]`);
    if (sizeEl) sizeEl.textContent = file.size ? `${t('download.size')} ${formatBytes(file.size)}` : '';
    const card = cardFor(arch);
    if (card) card.dataset.ready = '1';
  }

  // A platform without a published file keeps its button, but reports clearly.
  for (const card of document.querySelectorAll('.dl-card')) {
    const arch = card.dataset.arch;
    const button = card.querySelector('.dl-btn');
    if (button && !manifest.files?.[arch]) {
      button.disabled = false;
    }
  }
}

async function loadRelease() {
  try {
    const response = await fetch('/api/release');
    const payload = await response.json();
    if (!payload.ok) {
      setStatus(t('download.unavailable'), true);
      return;
    }
    manifest = payload.data;
    renderManifest();
  } catch {
    setStatus(t('download.loadFailed'), true);
  }
}

async function startDownload(arch) {
  if (activeDownload) activeDownload.abort();

  const card = cardFor(arch);
  const file = manifest.files?.[arch];
  if (!card) return;

  if (!file) {
    setStatus(t('download.unavailable'), true);
    return;
  }

  const controller = new AbortController();
  activeDownload = controller;

  const progress = card.querySelector('.progress');
  const bar = card.querySelector('.progress__bar i');
  const text = card.querySelector('.progress__text');
  const cancel = card.querySelector('.progress__cancel');
  const button = card.querySelector('.dl-btn');

  card.classList.add('is-busy');
  if (progress) progress.hidden = false;
  if (button) button.disabled = true;
  setStatus(`${t('download.progress')}…`);

  if (cancel) {
    cancel.onclick = () => controller.abort();
  }

  let lastPercent = -1;
  const onProgress = (loaded, total) => {
    const percent = total ? Math.min(100, Math.floor((loaded / total) * 100)) : 0;
    if (percent === lastPercent) return;
    lastPercent = percent;
    if (bar) bar.style.width = `${percent}%`;
    if (text) text.textContent = `${percent}% · ${formatBytes(loaded)} / ${formatBytes(total)}`;
  };

  try {
    const blob = await downloadInParallel(file.url, file.size, onProgress, controller.signal);
    saveBlob(blob, file.name);
    // macOS builds are ad-hoc signed but not notarized: the first launch is
    // blocked once by Gatekeeper, so explain the exact allow steps right after
    // the download finishes instead of letting people get stuck.
    if (arch !== 'win-x64') setTimeout(showGatekeeper, 500);
    if (bar) bar.style.width = '100%';
    if (text) text.textContent = `100% · ${formatBytes(file.size)}`;
    setStatus(t('download.done'));
    setButtonState(card, 'done');
    setTimeout(() => setButtonState(card, 'idle'), 4000);
  } catch (error) {
    if (error.name === 'AbortError') {
      setStatus(lang === 'zh' ? '已取消下载' : 'Download cancelled');
      if (bar) bar.style.width = '0%';
      if (text) text.textContent = '0%';
    } else {
      setStatus(t('download.failed'), true);
      const fallback = document.getElementById('download-fallback');
      const direct = document.getElementById('download-direct');
      if (fallback && direct) {
        direct.href = file.url;
        fallback.hidden = false;
      }
      setButtonState(card, 'retry');
    }
  } finally {
    activeDownload = null;
    card.classList.remove('is-busy');
    if (button) button.disabled = false;
    if (progress) setTimeout(() => { progress.hidden = true; }, 3000);
  }
}

/* --------------------------------------------------------- Gatekeeper note */

function showGatekeeper() {
  const modal = document.getElementById('gk');
  if (!modal) return;
  modal.hidden = false;
  document.getElementById('gkOk')?.focus();
}

function closeGatekeeper() {
  const modal = document.getElementById('gk');
  if (modal) modal.hidden = true;
}

function initGatekeeper() {
  const modal = document.getElementById('gk');
  if (!modal) return;

  const ok = document.getElementById('gkOk');
  const close = document.getElementById('gkClose');
  const copy = document.getElementById('gkCopy');
  const cmd = document.getElementById('gkCmd');

  ok?.addEventListener('click', closeGatekeeper);
  close?.addEventListener('click', closeGatekeeper);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeGatekeeper();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.hidden) closeGatekeeper();
  });

  copy?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(cmd?.textContent ?? '');
      const label = copy.textContent;
      copy.textContent = t('gk.copied');
      setTimeout(() => {
        copy.textContent = label;
      }, 1600);
    } catch {
      /* clipboard may be unavailable on http; the text is selectable anyway */
    }
  });
}

/* -------------------------------------------------------------- stats ui */

function setText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

async function loadStatsPreview() {
  if (!document.getElementById('stat-total')) return;
  try {
    const response = await fetch('/api/stats');
    const payload = await response.json();
    if (!payload.ok) return;
    setText('stat-total', payload.data.totalDevices);
    setText('stat-today', payload.data.todayDevices);
    setText('stat-week', payload.data.weekDevices);
  } catch {
    /* numbers are decorative here */
  }
}

/* --------------------------------------------------------------- startup */

function initLanguageToggle() {
  const toggle = document.getElementById('lang-toggle');
  if (!toggle) return;
  toggle.addEventListener('click', () => {
    applyLanguage(lang === 'zh' ? 'en' : 'zh');
    // Sizes/recommendations are locale-independent, but status text is not.
    if (manifest.files && Object.keys(manifest.files).length) renderManifest();
  });
}

function initDownloads() {
  for (const button of document.querySelectorAll('.dl-btn')) {
    button.addEventListener('click', () => startDownload(button.closest('.dl-card').dataset.arch));
  }
}

function initPet() {
  const video = document.getElementById('hero-pet');
  if (!video) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduce.matches) {
    video.remove();
    return;
  }
  video.play().catch(() => {});
}

function boot() {
  initLanguageToggle();
  applyLanguage(lang);
  initDownloads();
  initGatekeeper();
  initPet();
  updateRecommendation();
  loadRelease();
  loadStatsPreview();

  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener('click', (event) => {
      const target = document.querySelector(link.getAttribute('href'));
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
