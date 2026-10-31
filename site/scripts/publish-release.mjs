#!/usr/bin/env node
/**
 * Publish the packaged installers to R2 and point the site at the new version.
 *
 *   1. upload release/dsh-ready-<version>-<arch>.{dmg,exe} -> R2 common/dsh-ready/releases/
 *   2. rewrite site/latest.json (the manifest the Worker serves)
 *   3. upload the manifest -> R2 common/dsh-ready/releases/latest.json
 *   4. delete the installers the previous manifest pointed at
 *
 * Run `npm run dist` in the repo root first, then `npm run release` from site/.
 *
 * Object keys carry the `dsh-ready/` prefix (must match KEY_PREFIX in
 * src/index.js). Only the live version stays in the bucket — installers nobody
 * can download must not pile up.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const siteDir = path.resolve(import.meta.dirname, '..');
const repoDir = path.resolve(siteDir, '..');
const releaseDir = path.join(repoDir, 'release');
const wranglerBin = path.join(siteDir, 'node_modules', '.bin', 'wrangler');
const BUCKET = 'common';
const KEY_PREFIX = 'dsh-ready/';
/** `common` KV namespace, used by the worker for the manifest cache. */
const KV_NAMESPACE = 'a81355effe1948efba1e9cf97ae3d04a';

/** arch key in the manifest -> file produced by electron-builder. */
const TARGETS = {
  arm64: (version) => `dsh-ready-${version}-arm64.dmg`,
  x64: (version) => `dsh-ready-${version}-x64.dmg`,
  'win-x64': (version) => `dsh-ready-${version}-x64.exe`,
};

const { version } = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8'));

/**
 * wrangler 4.144 on Node 25 finishes the work and then never exits (an open
 * handle keeps the process alive), so waiting for exitCode would hang. Wait for
 * the success line, then stop the process ourselves.
 */
function runWrangler(args, successPattern, { failPattern, timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(wranglerBin, args, {
      cwd: siteDir,
      env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      error ? reject(error) : resolve(output);
    };

    const timer = setTimeout(
      () => finish(new Error(`wrangler timed out after ${timeoutMs}ms:\n${output}`)),
      timeoutMs,
    );

    const onData = (chunk) => {
      output += chunk.toString();
      if (successPattern.test(output)) return finish(null);
      if (failPattern?.test(output)) {
        const line = output.split('\n').find((l) => l.trim() && !l.includes('⛅')) || output;
        return finish(new Error(line.trim()));
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', finish);
    child.on('exit', (code) => {
      if (successPattern.test(output)) return finish(null);
      // The exit code is authoritative. Newer wrangler builds print their progress
      // differently (a successful `kv key delete` prints nothing at all), so matching
      // on output alone reported success as failure.
      if (code === 0) return finish(null);
      finish(new Error(`wrangler exited with code ${code}:\n${output}`));
    });
  });
}

const UPLOAD_ATTEMPTS = 3;

async function upload(localFile, key) {
  const args = ['r2', 'object', 'put', `${BUCKET}/${key}`, `--file=${localFile}`, '--remote'];
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      return await runWrangler(args, /Upload complete/i);
    } catch (error) {
      if (attempt === UPLOAD_ATTEMPTS) throw error;
      const first = String(error.message).split('\n').find((line) => line.trim()) || 'unknown error';
      console.log(`  attempt ${attempt}/${UPLOAD_ATTEMPTS} failed: ${first.trim()}`);
      await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
    }
  }
}

async function deleteObject(key) {
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      await runWrangler(['r2', 'object', 'delete', `${BUCKET}/${key}`, '--remote'], /Delete complete/i, {
        failPattern: /does not exist|not found|✘/i,
        timeoutMs: 120000,
      });
      return 'deleted';
    } catch (error) {
      const message = String(error.message);
      if (/does not exist|not found/i.test(message)) return 'missing';
      if (attempt === UPLOAD_ATTEMPTS) throw error;
      console.log(`  delete attempt ${attempt}/${UPLOAD_ATTEMPTS} failed: ${message.split('\n')[0]}`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

function readPreviousKeys(manifestPath) {
  try {
    const previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return Object.values(previous.files || {})
      .map((file) => file.key)
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function main() {
  if (!fs.existsSync(wranglerBin)) {
    throw new Error(`wrangler not installed; run npm install in ${siteDir}`);
  }

  const manifestPath = path.join(siteDir, 'latest.json');
  const previousKeys = readPreviousKeys(manifestPath);

  const files = {};
  for (const [arch, nameOf] of Object.entries(TARGETS)) {
    const name = nameOf(version);
    const file = path.join(releaseDir, name);
    if (!fs.existsSync(file)) throw new Error(`missing ${file}; build installers first`);
    files[arch] = { key: `${KEY_PREFIX}releases/${name}`, name, size: fs.statSync(file).size };
  }

  for (const [arch, file] of Object.entries(files)) {
    console.log(`uploading ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
    await upload(path.join(releaseDir, file.name), file.key);
    void arch;
  }

  const manifest = {
    version,
    released_at: new Date().toISOString().slice(0, 10),
    files,
  };

  const inline = (file) =>
    `{ ${Object.entries(file)
      .map(([k, v]) => `"${k}": ${JSON.stringify(v)}`)
      .join(', ')} }`;
  const body = [
    '{',
    `  "version": "${manifest.version}",`,
    `  "released_at": "${manifest.released_at}",`,
    '  "files": {',
    `    "arm64":  ${inline(files.arm64)},`,
    `    "x64":    ${inline(files.x64)},`,
    `    "win-x64": ${inline(files['win-x64'])}`,
    '  }',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(manifestPath, body);
  console.log(`wrote ${path.relative(process.cwd(), manifestPath)}`);

  await upload(manifestPath, `${KEY_PREFIX}releases/latest.json`);

  // The worker keeps the manifest in KV for a few hours; drop the cached copy so
  // the new version is visible immediately instead of after the TTL.
  try {
    await runWrangler(
      ['kv', 'key', 'delete', 'ready:manifest', '--namespace-id', KV_NAMESPACE, '--remote'],
      /Deleted|success|not found/i,
      { failPattern: /✘/i, timeoutMs: 120000 },
    );
    console.log('cleared the cached release manifest in KV');
  } catch (error) {
    console.log(`kv invalidate skipped: ${String(error.message).split('\n')[0]}`);
  }

  const keep = new Set(Object.values(files).map((file) => file.key));
  const stale = previousKeys.filter((key) => !keep.has(key));
  if (stale.length) {
    console.log('removing older installers');
    for (const key of stale) {
      const result = await deleteObject(key);
      console.log(`  ${result === 'deleted' ? 'deleted' : 'already gone'}: ${key}`);
    }
  }

  console.log(`published ${version}: ${Object.keys(files).join(', ')}`);
}

main().catch((error) => {
  console.error(`release failed: ${error.message}`);
  process.exit(1);
});
