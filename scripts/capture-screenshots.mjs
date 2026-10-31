#!/usr/bin/env node
/**
 * Really launches DSH Ready inside a sandbox, captures UI screenshots, and cleans up afterwards.
 *
 * Why not "open the app and take screenshots by hand":
 *   - A real launch means user data gets read and written; this script points DSH_HOME and --user-data-dir
 *     at a temporary directory that is deleted on exit, never touching ~/.dsh, ~/Library/Application Support
 *     or a running DSH (it opens its own debug port, so it does not clash with 3080).
 *   - Screenshots go through Page.captureScreenshot of the Chrome DevTools Protocol, so the window
 *     never has to appear on screen and no accessibility permission is needed.
 *
 * Usage:
 *   npm run shots                    # generate 4 shots (light/dark x zh/en)
 *   npm run shots -- --keep          # keep the sandbox for debugging
 *   npm run shots -- --smoke-only    # only verify it launches, no images
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = resolve(import.meta.dirname, '..');
const OUT_DIR = join(ROOT, 'site', 'public', 'assets');

const args = process.argv.slice(2);
const keepSandbox = args.includes('--keep');
const smokeOnly = args.includes('--smoke-only');

/** Fake state the renderer accepts; no real DSH process is involved. */
const STATES = {
  light_zh: {
    theme: 'light',
    lang: 'zh',
    state: {
      status: 'running',
      busy: false,
      dshVersion: '1.2.3',
      dshSource: 'system',
      external: null,
      targetPort: 3080,
      latestVersion: '1.2.3',
      nodeVersion: '22.18.0',
      npmVersion: '10.9.2',
      runtime: 'system',
      theme: 'light',
      lang: 'zh',
    },
  },
  dark_zh: {
    theme: 'dark',
    lang: 'zh',
    state: {
      status: 'stopped',
      busy: false,
      dshVersion: '1.2.3',
      dshSource: 'app',
      external: null,
      targetPort: 3080,
      latestVersion: '1.2.4',
      nodeVersion: '22.18.0',
      npmVersion: '10.9.2',
      runtime: 'system',
      theme: 'dark',
      lang: 'zh',
    },
  },
  light_en: {
    theme: 'light',
    lang: 'en',
    state: {
      status: 'running',
      busy: false,
      dshVersion: '1.2.3',
      dshSource: 'app',
      external: null,
      targetPort: 3080,
      latestVersion: '1.2.3',
      nodeVersion: '22.18.0',
      npmVersion: '10.9.2',
      runtime: 'system',
      theme: 'light',
      lang: 'en',
    },
  },
  dark_en: {
    theme: 'dark',
    lang: 'en',
    state: {
      status: 'stopped',
      busy: false,
      dshVersion: '1.2.3',
      dshSource: 'system',
      external: null,
      targetPort: 3080,
      latestVersion: '1.2.4',
      nodeVersion: '22.18.0',
      npmVersion: '10.9.2',
      runtime: 'system',
      theme: 'dark',
      lang: 'en',
    },
  },
};

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForJsonList(port, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await response.json();
      const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* not listening yet */
    }
    await sleep(250);
  }
  throw new Error('DevTools target did not appear — the app probably failed to start');
}

/** Minimal CDP client over the built-in WebSocket (Node 22+). */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        message.error ? reject(new Error(message.error.message)) : resolve(message.result);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolvePromise, reject) => {
      ws.addEventListener('open', resolvePromise, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'evaluate failed');
    }
    return result.result?.value;
  }
}

async function capture(cdp, file) {
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    fromSurface: true,
  });
  const path = join(OUT_DIR, file);
  await writeFile(path, Buffer.from(shot.data, 'base64'));
  return path;
}

async function main() {
  const electronPath = require('electron');
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-ready-shot-'));
  const appData = join(sandbox, 'appdata');
  const dshHome = join(sandbox, 'dsh-home');
  await mkdir(appData, { recursive: true });
  await mkdir(dshHome, { recursive: true });

  const port = 9400 + Math.floor(Math.random() * 200);
  console.log(`sandbox: ${sandbox}`);

  const child = spawn(
    electronPath,
    [`--user-data-dir=${appData}`, `--remote-debugging-port=${port}`, ROOT],
    {
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        DSH_READY_SKIP_SHELL_ENV: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));

  let cdp;
  try {
    const page = await waitForJsonList(port);
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // Device metrics: 2x so the PNG stays sharp when the site shows it at 468px.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 468,
      height: 520,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await sleep(5000); // let boot, the first state push and one external scan settle

    const title = await cdp.evaluate('document.title');
    console.log(`startup ok — window title: ${title}`);

    if (smokeOnly) return;

    await mkdir(OUT_DIR, { recursive: true });

    for (const [name, spec] of Object.entries(STATES)) {
      const expression = `
        (async () => {
          finishBoot();
          applyLanguage(${JSON.stringify(spec.lang)});
          render(${JSON.stringify(spec.state)});
          logLines.length = 0;
          renderLogs([]);
          document.body.dataset.shot = '1';
          return document.querySelector('#statusText')?.textContent ?? '';
        })()
      `;
      const want = spec.state.status === 'running'
        ? (spec.lang === 'zh' ? '运行中' : 'Running')
        : (spec.lang === 'zh' ? '已停止' : 'Stopped');
      const file = `app-${name.replace('_', '-')}.png`;
      let shown = '';
      // Real IPC state can land between the injected render and the capture
      // (external instance polling runs every 4s), so retry until the pixels
      // actually match the requested status and theme.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        shown = await cdp.evaluate(expression);
        // Button colors animate for ~120ms after the theme flips; let them settle,
        // then re-assert the injected state right before the capture.
        await sleep(280);
        shown = await cdp.evaluate(expression);
        await capture(cdp, file);
        const check = await cdp.evaluate(
          `JSON.stringify({ text: document.querySelector('#statusText')?.textContent ?? '', theme: document.documentElement.dataset.theme })`,
        );
        const { text, theme } = JSON.parse(check);
        if (process.env.SHOT_DEBUG === '1') {
          const extra = await cdp.evaluate(
            `JSON.stringify({ disabled: els.primary.disabled, bg: getComputedStyle(els.primary).backgroundColor, color: getComputedStyle(els.primary).color })`,
          );
          console.log('    debug', attempt, JSON.parse(extra));
        }
        if (text === want && theme === spec.theme) break;
        await sleep(250);
      }
      console.log(`  ${file} (${shown})`);
    }

    // The settings sheet is part of the product now; capture it as evidence.
    await cdp.evaluate('openSettings()');
    await sleep(700);
    await capture(cdp, 'app-settings.png');
    console.log('  app-settings.png (settings sheet)');
  } finally {
    cdp?.ws.close();
    child.kill('SIGTERM');
    await new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolvePromise();
      }, 3000);
      child.on('exit', () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });

    if (keepSandbox) {
      console.log(`kept sandbox: ${sandbox}`);
    } else {
      await rm(sandbox, { recursive: true, force: true });
      console.log('sandbox removed');
    }
  }
}

main().catch((error) => {
  console.error(`capture failed: ${error.message}`);
  process.exit(1);
});
