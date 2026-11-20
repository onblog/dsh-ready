/**
 * Entry gate for scanner and vulnerability-probe traffic.
 *
 * Background (2026-11-18 traffic): 418 of the 495 requests to this host were
 * 404s, almost all of them probes for `wp-admin`, `.env`, `*.php` and other
 * paths this site never serves. The asset layer lets unmatched requests fall
 * through to this script (`env.ASSETS.fetch` at the end of the fetch handler),
 * so those probes burned a Worker invocation each before coming back 404.
 *
 * So reject them before that fallthrough: a path signature answers 404, and the
 * two non-browser UAs that only ever produced 504 answer 403. Addresses that keep
 * probing get 429 after `BLOCK_LIMIT_PER_WINDOW` blocked requests in a minute
 * (2026-11-19: three addresses sent 3.4k probes in one hour, one of them alone
 * 3.1k). Constants only -- no env access, no D1, no R2, no logging.
 */

/** Known-bad client signatures (all of 2026-11-18 they got 504, never a 200). */
const BLOCKED_USER_AGENTS = new Set(['nginx-ssl early hints', 'fl2 early hints']);

/** Per-address ceiling for *blocked* traffic only: legitimate pages never count. */
const BLOCK_WINDOW_MS = 60_000;
const BLOCK_LIMIT_PER_WINDOW = 20;
/** Isolate-local sliding window: address -> { count, since }. Only blocked hits are recorded. */
const blockedHits = new Map();

/**
 * Scan signatures:
 *   1. WordPress probes (`/wp-admin/`, `/wp-login.php`, `/wp-content/...`);
 *   2. any segment ending in `.php` (this site serves no PHP, so it is a probe);
 *   3. dotfiles (`.env`, `.git/config`, `.aws/...`);
 *   4. common back-office and middleware fingerprints;
 *   5. backup and config suffixes (`.sql`, `.bak`, `.old`, `.swp`, `*.tfvars`).
 */
const SCAN_PATTERNS = [
  /\/wp-[a-z]/i,
  /\.php(?=$|[/?#])/i,
  /\/\.(?:env|git|svn|hg|docker|aws|ssh|npmrc|boto|ds_store|dockercfg|idea|vscode|cursor)(?=$|[/?#.])/i,
  /\/(?:phpinfo|phpmyadmin|pma|adminer|xmlrpc|wlwmanifest|cgi-bin|actuator|nacos|solr|jenkins|telescope|_profiler|server-status|docker-compose|dockerfile)(?=$|[/?#])/i,
  /\.(?:sql|bak|old|swp|swo|orig|save|tfvars)(?=$|[/?#])/i,
];

/** Whether `pathname` (already parsed, no query) matches a scan signature. */
export function isScannerPath(pathname) {
  return SCAN_PATTERNS.some((pattern) => pattern.test(pathname));
}

/** Whether the UA is a known-bad client. An empty UA is allowed: health checks may omit it. */
export function isScannerUserAgent(userAgent) {
  if (!userAgent) return false;
  return BLOCKED_USER_AGENTS.has(userAgent.trim().toLowerCase());
}

/**
 * Whether this address is over the blocked-traffic ceiling.
 *
 * Called only after a request already matched a scan signature, so a false
 * positive here means "someone asked for wp-admin 21 times in a minute" -- it
 * can never hit a normal page view.
 */
export function isFlooding(ip, now = Date.now()) {
  if (!ip) return false;
  const entry = blockedHits.get(ip);
  if (!entry || now - entry.since >= BLOCK_WINDOW_MS) {
    blockedHits.set(ip, { count: 1, since: now });
    if (blockedHits.size > 1000) {
      for (const [key, value] of blockedHits) {
        if (now - value.since >= BLOCK_WINDOW_MS) blockedHits.delete(key);
      }
    }
    return false;
  }
  entry.count += 1;
  return entry.count > BLOCK_LIMIT_PER_WINDOW;
}

/** The 4xx answer for blocked traffic: plain text, not cached, not indexed. */
function blockedResponse(status) {
  const body = status === 403 ? 'Forbidden' : status === 429 ? 'Too Many Requests' : 'Not Found';
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
  };
  if (status === 429) headers['Retry-After'] = String(Math.ceil(BLOCK_WINDOW_MS / 1000));
  return new Response(body, { status, headers });
}

/**
 * Returns the 4xx response when the request matches a scan signature, otherwise
 * `null` so the caller keeps routing.
 *
 * The UA is checked first: those clients should not be served any path at all,
 * so 403 is clearer than 404.
 */
export function scannerResponseFor(request, pathname) {
  const blockedByUa = isScannerUserAgent(request.headers.get('User-Agent'));
  if (!blockedByUa && !isScannerPath(pathname)) return null;
  if (isFlooding(request.headers.get('CF-Connecting-IP'))) return blockedResponse(429);
  return blockedResponse(blockedByUa ? 403 : 404);
}
