/**
 * DSH Ready — official site worker.
 *
 * Only /api/* reaches this script (see `run_worker_first` in wrangler.jsonc);
 * every other request is answered straight from the static asset layer, so a
 * page view costs no Worker request and the site stays on the free plan.
 *
 * Privacy: the only thing this worker stores is an anonymous launch signal sent
 * by the desktop app — a random device id, the UTC date, the app version, and
 * Cloudflare's coarse geo (country / region / city). No IP address, no cookies,
 * no user agent, no third-party calls. Nothing about website visitors is kept,
 * and the KV namespace is used only to keep the release manifest warm.
 *
 * Object keys carry the `dsh-ready/` prefix and tables carry the `ready_`
 * prefix, because the bucket and database are the account-wide `common` ones.
 */

const KEY_PREFIX = 'dsh-ready/';
const MANIFEST_KEY = `${KEY_PREFIX}releases/latest.json`;
const MANIFEST_TTL_MS = 60_000;
const MANIFEST_KV_KEY = 'ready:manifest';

/** Download architectures the site can offer. Keys must match the manifest. */
const ARCHES = ['arm64', 'x64', 'win-x64'];
const ARCH_SET = new Set(ARCHES);

let manifestCache = { value: null, at: 0 };

function json(status, payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function fail(status, code, message) {
  return json(status, { ok: false, error: { code, message } });
}

/**
 * Read the release manifest: 60s in-memory cache, then KV as a cheap second
 * layer, then R2 (the source of truth). This keeps a busy download page from
 * hammering R2 and still lets a new release appear within a minute.
 */
async function readManifest(env, { fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && manifestCache.value && now - manifestCache.at < MANIFEST_TTL_MS) {
    return manifestCache.value;
  }

  // `fresh` 跳过两层缓存直接读 R2：下载前的版本核对、以及发版瞬间，都不能被
  // 几分钟前的旧清单糊弄，否则页面会拿着旧 size 去切新安装包。
  if (!fresh) {
    try {
      const warm = await env.KV.get(MANIFEST_KV_KEY, 'json');
      if (warm) {
        manifestCache = { value: warm, at: now };
        return warm;
      }
    } catch (error) {
      console.error('[manifest] kv read failed', error);
    }
  }

  const object = await env.R2_RELEASES.get(MANIFEST_KEY);
  if (!object) return null;

  let parsed;
  try {
    parsed = await object.json();
  } catch {
    return null;
  }

  manifestCache = { value: parsed, at: now };
  try {
    await env.KV.put(MANIFEST_KV_KEY, JSON.stringify(parsed), { expirationTtl: 60 * 60 * 6 });
  } catch (error) {
    console.error('[manifest] kv write failed', error);
  }
  return parsed;
}

/** Public shape: the internal R2 key never leaves the worker. */
function publicManifest(manifest) {
  const files = {};
  for (const arch of ARCHES) {
    const file = manifest?.files?.[arch];
    if (!file) continue;
    files[arch] = {
      name: file.name,
      size: file.size ?? null,
      // 前端拿它做最后一道校验：长度对、内容错（错位拼接）也能挡住。
      sha256: file.sha256 ?? null,
      // 版本号进 URL：发版后旧链接指向的字节不会被拼到新安装包里。
      url: `/api/download?arch=${arch}&v=${encodeURIComponent(manifest.version)}`,
    };
  }
  return {
    version: manifest.version,
    released_at: manifest.released_at ?? null,
    files,
  };
}

function safeFilename(name) {
  const base = String(name || 'dsh-ready-installer').split('/').pop();
  return base.replace(/[^\w.\-]+/g, '-');
}

async function handleRelease(env, url) {
  const manifest = await readManifest(env, { fresh: url?.searchParams.get('fresh') === '1' });
  if (!manifest) {
    return fail(503, 'release_unavailable', '安装包还在上传，请稍后再来 / Installers are not published yet.');
  }
  // 版本号是强一致信息：缓存 60 秒会让页面拿着旧 size 去切新安装包。
  return json(200, { ok: true, data: publicManifest(manifest) });
}

async function handleDownload(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return fail(405, 'method_not_allowed', '只支持 GET / GET only');
  }

  const arch = url.searchParams.get('arch');
  if (!ARCH_SET.has(arch)) {
    return fail(400, 'bad_request', `未知的架构 / unknown arch: ${arch ?? ''} (${ARCHES.join(', ')})`);
  }

  let manifest = await readManifest(env);

  // 客户端带着版本号来下载时，必须和这一版的对象严格对应。否则会拿旧 size
  // 去切新文件——拼出来的安装包少一截，用户只看到「文件已损坏」。
  const wantedVersion = url.searchParams.get('v');
  if (wantedVersion && manifest?.version !== wantedVersion) {
    manifest = await readManifest(env, { fresh: true });
    if (manifest?.version !== wantedVersion) {
      return fail(
        409,
        'conflict',
        `安装包已更新到 ${manifest?.version ?? '新版本'}，请刷新页面后重新下载 / Reload the page and try again`,
      );
    }
  }

  const file = manifest?.files?.[arch];
  if (!manifest || !file?.key) {
    return fail(404, 'not_found', '当前版本没有这个平台的安装包 / no installer for this platform');
  }

  // Only forward Range when the client asked for it, otherwise R2 may answer a
  // plain GET with a ranged object.
  const rangeHeader = request.headers.get('range');
  const ifRange = request.headers.get('if-range');
  let useRange = Boolean(rangeHeader);

  // If-Range：浏览器续传时会带上它。对象已经换成新版本时必须回整包，让客户端
  // 从头下，而不是把新版本的尾巴接到旧版本的前半截上。
  if (useRange && ifRange) {
    const head = await env.R2_RELEASES.head(file.key);
    if (!head?.httpEtag || ifRange.trim() !== head.httpEtag) useRange = false;
  }

  const object = await env.R2_RELEASES.get(
    file.key,
    useRange ? { range: request.headers } : undefined,
  );
  if (!object) {
    return fail(404, 'not_found', '安装包文件不存在 / installer object is missing');
  }

  const headers = new Headers();
  headers.set('Content-Type', 'application/octet-stream');
  headers.set('Content-Disposition', `attachment; filename="${safeFilename(file.name)}"`);
  // 安装包一律不进中间缓存：缓存跨版本是「下载到旧版 / 拼出坏包」的另一条来路。
  headers.set('Cache-Control', 'no-store');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('X-Version', manifest.version ?? '');
  if (object.httpEtag) headers.set('ETag', object.httpEtag);

  let status = 200;
  let body = object.body;

  if (body === null) {
    status = 304;
  } else if (useRange && object.range) {
    // R2 reports a range even for plain GETs; gate 206 on the request header.
    status = 206;
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? object.size;
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set('Content-Length', String(length));
  } else {
    headers.set('Content-Length', String(object.size));
  }

  return new Response(body, { status, headers });
}

/* ------------------------------------------------------------------ stats */

const DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** UTC date as YYYY-MM-DD, so a launch always lands on exactly one day. */
function utcDate(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Record one app launch.
 *
 * Only the desktop app calls this; the website never reports page views. A
 * launch stores a random device id (created locally by the app), the UTC date,
 * the app version and the coarse geo Cloudflare derived from the request.
 */
async function handlePing(request, env) {
  if (request.method !== 'POST') return fail(405, 'method_not_allowed', '只支持 POST / POST only');

  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'bad_request', '请求体不是合法 JSON / body is not JSON');
  }

  const device = String(body?.device || '');
  if (!DEVICE_ID_RE.test(device)) {
    return fail(400, 'bad_request', 'device 必须是 UUID / device must be a UUID');
  }

  const version = String(body?.version || '').slice(0, 32) || null;
  const cf = request.cf || {};

  try {
    await env.DB.prepare(
      `INSERT INTO ready_launches (device_id, date, version, country, region, city, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        device,
        utcDate(),
        version,
        cf.country || null,
        cf.region || null,
        cf.city || null,
        Date.now(),
      )
      .run();
  } catch (error) {
    console.error('[ping] insert failed', error);
    return fail(500, 'internal_error', '记录失败 / could not record the launch');
  }

  return json(200, { ok: true });
}

/** Aggregates only — device ids never leave the database. */
async function handleStats(env) {
  const today = utcDate();
  const weekAgo = utcDate(-6);

  const [total, todayRow, weekRow, cities, countries, daily] = await Promise.all([
    env.DB.prepare('SELECT COUNT(DISTINCT device_id) AS n FROM ready_launches').first(),
    env.DB.prepare('SELECT COUNT(DISTINCT device_id) AS n FROM ready_launches WHERE date = ?')
      .bind(today)
      .first(),
    env.DB.prepare('SELECT COUNT(DISTINCT device_id) AS n FROM ready_launches WHERE date >= ?')
      .bind(weekAgo)
      .first(),
    env.DB.prepare(
      `SELECT city, country, COUNT(DISTINCT device_id) AS devices
       FROM ready_launches
       WHERE city IS NOT NULL AND city != ''
       GROUP BY city, country
       ORDER BY devices DESC, city ASC
       LIMIT 40`,
    ).all(),
    env.DB.prepare(
      `SELECT country, COUNT(DISTINCT device_id) AS devices
       FROM ready_launches
       WHERE country IS NOT NULL AND country != ''
       GROUP BY country
       ORDER BY devices DESC`,
    ).all(),
    env.DB.prepare(
      `SELECT date, COUNT(DISTINCT device_id) AS uv
       FROM ready_launches
       GROUP BY date
       ORDER BY date DESC
       LIMIT 30`,
    ).all(),
  ]);

  return json(
    200,
    {
      ok: true,
      data: {
        totalDevices: total?.n ?? 0,
        todayDevices: todayRow?.n ?? 0,
        weekDevices: weekRow?.n ?? 0,
        cities: (cities?.results || []).map((row) => ({
          city: row.city,
          country: row.country,
          devices: row.devices,
        })),
        countries: (countries?.results || []).map((row) => ({
          code: row.country,
          devices: row.devices,
        })),
        daily: (daily?.results || []).map((row) => ({ date: row.date, uv: row.uv })),
      },
    },
    { 'Cache-Control': 'public, max-age=120' },
  );
}

async function handleApi(request, env, url) {
  if (url.pathname === '/api/release') return handleRelease(env, url);
  if (url.pathname === '/api/download') return handleDownload(request, env, url);
  if (url.pathname === '/api/ping') return handlePing(request, env);
  if (url.pathname === '/api/stats') return handleStats(env);
  return fail(404, 'not_found', '没有这个接口 / no such endpoint');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (error) {
        console.error('[api]', error);
        return fail(500, 'internal_error', '服务器开小差了，稍后再试 / internal error');
      }
    }

    // Reached only if asset routing ever lets a non-API path through.
    return env.ASSETS.fetch(request);
  },
};
