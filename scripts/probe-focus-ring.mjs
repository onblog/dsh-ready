#!/usr/bin/env node
/**
 * Focus-ring regression probe: a hidden window coming back must not paint the header
 * icon's :focus-visible ring, while real keyboard focus must survive.
 *
 * Launches the app in a throwaway sandbox over CDP, then:
 *   1. focuses #langBtn, dispatches the window focus event (what mainWindow.show() causes)
 *   2. expects document.activeElement to fall back to <body>
 *   3. dispatches a keydown first, repeats, and expects the button to keep focus
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitForTarget(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error('devtools target never appeared');
}

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  const ready = new Promise((done, fail) => {
    ws.addEventListener('open', () => done());
    ws.addEventListener('error', () => fail(new Error('cdp socket error')));
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    msg.error ? slot.reject(new Error(msg.error.message)) : slot.resolve(msg.result);
  });
  const send = (method, params = {}) =>
    new Promise((done, fail) => {
      const next = ++id;
      pending.set(next, { resolve: done, reject: fail });
      ws.send(JSON.stringify({ id: next, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed');
    return result.result?.value;
  };
  return { ready, send, evaluate, close: () => ws.close() };
}

async function main() {
  const electronPath = require('electron');
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-ready-focus-'));
  const appData = join(sandbox, 'appdata');
  const dshHome = join(sandbox, 'dsh-home');
  await mkdir(appData, { recursive: true });
  await mkdir(dshHome, { recursive: true });
  const port = 9600 + Math.floor(Math.random() * 200);

  const child = spawn(electronPath, [`--user-data-dir=${appData}`, `--remote-debugging-port=${port}`, ROOT], {
    env: { ...process.env, DSH_HOME: dshHome, DSH_READY_SKIP_SHELL_ENV: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});

  let cdp;
  try {
    cdp = connect((await waitForTarget(port)).webSocketDebuggerUrl);
    await cdp.ready;
    await sleep(1200);

    const pointerCase = await cdp.evaluate(`(() => {
      keyboardNav = false;
      const button = document.getElementById('langBtn');
      button.focus();
      window.dispatchEvent(new Event('focus'));
      return { active: document.activeElement.id || document.activeElement.tagName, ring: button.matches(':focus-visible') };
    })()`);

    const keyboardCase = await cdp.evaluate(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      const button = document.getElementById('langBtn');
      button.focus();
      window.dispatchEvent(new Event('focus'));
      return { active: document.activeElement.id || document.activeElement.tagName, ring: button.matches(':focus-visible') };
    })()`);

    console.log('pointer refocus ->', JSON.stringify(pointerCase));
    console.log('keyboard refocus ->', JSON.stringify(keyboardCase));
    const pass = pointerCase.active !== 'langBtn' && keyboardCase.active === 'langBtn';
    console.log(pass ? 'PASS: tray-style refocus drops the header ring, keyboard focus is kept' : 'FAIL');
    process.exitCode = pass ? 0 : 1;
  } finally {
    cdp?.close();
    child.kill('SIGKILL');
    await rm(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`probe failed: ${error.message}`);
  process.exit(1);
});
