/**
 * Release/download contract for the site worker.
 *
 * The desktop launcher is distributed as three installers behind one endpoint,
 * and users hold the dmgs for months. These pin the two silent failure modes
 * that produced a "damaged" installer: a chunked download mixing bytes from two
 * versions, and an installer served from a cache that outlived the release.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';

const VERSION = '1.0.18';
const ETAG = '"current-etag"';
const SIZES = { arm64: 1000, x64: 2000, 'win-x64': 3000 };

const MANIFEST = {
  version: VERSION,
  released_at: '2026-11-02',
  files: Object.fromEntries(
    Object.entries(SIZES).map(([arch, size]) => [
      arch,
      {
        key: `dsh-ready/releases/${arch}.bin`,
        name: `dsh-ready-${VERSION}-${arch}.bin`,
        size,
        sha256: arch.padEnd(64, '0'),
      },
    ]),
  ),
};

const bytes = (size, seed) => new Uint8Array(size).map((_, index) => (index * 7 + seed) % 251);
const OBJECTS = Object.fromEntries(
  Object.entries(SIZES).map(([arch, size], index) => [
    `dsh-ready/releases/${arch}.bin`,
    bytes(size, index + 1),
  ]),
);

/** Only what the handlers touch: json(), ranged get(), head(), plus the KV layer. */
const R2 = {
  async get(key, options) {
    if (key.endsWith('latest.json')) return { json: async () => MANIFEST, body: null, size: 0 };

    const data = OBJECTS[key];
    if (!data) return null;

    // The worker forwards either a Headers object (real R2 accepts it) or a
    // parsed { offset, length }; the fake has to understand both.
    const range = options?.range;
    let offset = 0;
    let length = data.length;
    if (range && typeof range.get === 'function') {
      const match = /bytes=(\d+)-(\d*)/.exec(range.get('range') ?? '');
      if (match) {
        offset = Number(match[1]);
        length = (match[2] ? Number(match[2]) : data.length - 1) - offset + 1;
      }
    } else if (range) {
      offset = range.offset ?? 0;
      length = range.length ?? data.length;
    }
    return {
      body: new Blob([data.slice(offset, offset + length)]).stream(),
      size: data.length,
      range: { offset, length },
      httpEtag: ETAG,
    };
  },
  async head(key) {
    const data = OBJECTS[key];
    return data ? { size: data.length, httpEtag: ETAG } : null;
  },
};

const KV = { async get() { return null; }, async put() {} };
const env = { R2_RELEASES: R2, KV, ASSETS: { fetch: async () => new Response('asset') } };
const get = (path, headers = {}) =>
  worker.fetch(new Request(`https://dsh.example.com${path}`, { headers }), env);

test('manifest lists all three targets with sha256 and a versioned url', async () => {
  const response = await get('/api/release?fresh=1');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const body = await response.json();
  assert.equal(body.data.version, VERSION);
  assert.deepEqual(Object.keys(body.data.files).sort(), ['arm64', 'win-x64', 'x64']);
  assert.equal(body.data.files['win-x64'].sha256, MANIFEST.files['win-x64'].sha256);
  assert.equal(body.data.files.arm64.url, `/api/download?arch=arm64&v=${VERSION}`);
});

test('download without a version keeps working for older pages', async () => {
  const response = await get('/api/download?arch=arm64');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(SIZES.arm64));
  // A stable URL must not be cached: that is how an old installer kept being
  // served after a release.
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('a stale version is refused instead of serving mismatched bytes', async () => {
  const response = await get('/api/download?arch=arm64&v=1.0.17');
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error.code, 'conflict');
});

test('a ranged request returns exactly that slice', async () => {
  const response = await get(`/api/download?arch=win-x64&v=${VERSION}`, { Range: 'bytes=100-199' });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 100-199/${SIZES['win-x64']}`);
  assert.equal(response.headers.get('content-length'), '100');
});

test('a stale If-Range gets the whole file so a resume cannot splice versions', async () => {
  const response = await get(`/api/download?arch=arm64&v=${VERSION}`, {
    Range: 'bytes=500-',
    'If-Range': '"some-old-etag"',
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(SIZES.arm64));
  assert.equal(response.headers.get('content-range'), null);
});

test('a matching If-Range still gets a partial response', async () => {
  const response = await get(`/api/download?arch=arm64&v=${VERSION}`, {
    Range: 'bytes=500-',
    'If-Range': ETAG,
  });
  assert.equal(response.status, 206);
  assert.equal(
    response.headers.get('content-range'),
    `bytes 500-${SIZES.arm64 - 1}/${SIZES.arm64}`,
  );
});
