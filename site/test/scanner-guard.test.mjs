/**
 * 入口闸门：扫描器/漏洞探测必须在进路由之前被挡掉。
 *
 * 判据来自 2026-11-18 的线上统计（当天 495 次请求里 418 次是 404，多数是
 * `wp-admin`、`.env`、`*.php` 这类探测）。闸门跑在资源层兜底之前，误伤真实路径
 * 的代价远大于多接几个探测请求，所以两侧都钉住。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';
import { isScannerPath, isScannerUserAgent } from '../src/scanner-guard.js';

/** 2026-11-18 真实出现过的探测路径。 */
const SCAN_PATHS = [
  '/wp-admin/',
  '/wp-login.php',
  '/wp-content/plugins/about.php',
  '/index.php',
  '/db.php',
  '/.env',
  '/config/.env',
  '/.env.example',
  '/.git/config',
  '/.docker/config.json',
  '/.aws/credentials',
  '/phpmyadmin/',
  '/cgi-bin/php',
  '/xmlrpc.php',
  '/actuator/env',
  '/telescope/requests',
  '/_profiler/phpinfo',
  '/database.sql',
  '/backup.old',
  '/config.swp',
  '/*.auto.tfvars',
  '/Dockerfile',
];

/** 真实路由：首页、接口、下载页与静态资源。 */
const ALLOWED_PATHS = [
  '/',
  '/download',
  '/docs/getting-started',
  '/api/release/latest',
  '/api/ping',
  '/assets/app.js',
  '/latest.json',
  '/sitemap.xml',
  '/robots.txt',
  '/.well-known/security.txt',
];

test('scan paths are rejected', () => {
  for (const pathname of SCAN_PATHS) assert.equal(isScannerPath(pathname), true, pathname);
});

test('real paths pass through', () => {
  for (const pathname of ALLOWED_PATHS) assert.equal(isScannerPath(pathname), false, pathname);
});

test('bad UA signatures match case-insensitively, empty UA is allowed', () => {
  assert.equal(isScannerUserAgent('nginx-ssl early hints'), true);
  assert.equal(isScannerUserAgent('FL2 Early Hints'), true);
  assert.equal(isScannerUserAgent(null), false);
  assert.equal(isScannerUserAgent(''), false);
  assert.equal(isScannerUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), false);
});

test('a probe is answered 404 before the asset layer runs', async () => {
  // 空 env 即可：命中闸门时不会读取任何绑定。
  const response = await worker.fetch(new Request('https://dsh.wordtk.com/wp-login.php'), {});
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'Not Found');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('a broken UA is answered 403 even on a real path', async () => {
  const request = new Request('https://dsh.wordtk.com/', { headers: { 'User-Agent': 'fl2 early hints' } });
  const response = await worker.fetch(request, {});
  assert.equal(response.status, 403);
});

test('a normal request still falls through to the asset layer', async () => {
  // 用假 ASSETS 证明放行：闸门返回 null 后，非 /api 路径会调用 env.ASSETS.fetch。
  let asked = null;
  const env = {
    ASSETS: {
      fetch: async (request) => {
        asked = new URL(request.url).pathname;
        return new Response('asset', { status: 200 });
      },
    },
  };
  const response = await worker.fetch(new Request('https://dsh.wordtk.com/download'), env);
  assert.equal(response.status, 200);
  assert.equal(asked, '/download');
});
