#!/usr/bin/env node
/**
 * Render the SEO files for the static site: /sitemap.xml, /robots.txt, and the
 * `__SITE_URL__` placeholder inside the listed HTML files.
 *
 * The production domain is NEVER committed. It comes from the `SITE_URL`
 * environment variable, which is set when the site is deployed (locally or by
 * Cloudflare Workers Builds). A fork can point SITE_URL at its own domain and
 * every canonical link, Open Graph URL, the sitemap and robots.txt follow.
 *
 * Usage: SITE_URL=https://example.com node scripts/render-seo.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CONFIG_PATH = join(ROOT, 'seo.config.json');

const siteUrl = (process.env.SITE_URL ?? '').trim().replace(/\/+$/, '');
if (!siteUrl) {
  console.error(
    'render-seo: SITE_URL is required.\n' +
      '  Set it in the deploy environment or in a local, git-ignored .env file.\n' +
      '  Example: SITE_URL=https://example.com node scripts/render-seo.mjs',
  );
  process.exit(1);
}

if (!/^https?:\/\//.test(siteUrl)) {
  console.error(`render-seo: SITE_URL must start with http:// or https:// (got "${siteUrl}")`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const outDir = join(ROOT, config.outDir ?? 'public');
const pages = Array.isArray(config.pages) && config.pages.length ? config.pages : ['/'];
const htmlFiles = Array.isArray(config.html) ? config.html : [];
const PLACEHOLDER = '__SITE_URL__';

if (config.sitemap !== false) {
  const urls = pages
    .map((path) => `  <url>\n    <loc>${siteUrl}${path}</loc>\n  </url>`)
    .join('\n');
  writeFileSync(
    join(outDir, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
  );
}

writeFileSync(
  join(outDir, 'robots.txt'),
  `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`,
);

let replaced = 0;
for (const file of htmlFiles) {
  const path = join(ROOT, file);
  if (!existsSync(path)) {
    console.warn(`render-seo: html file not found, skipped: ${file}`);
    continue;
  }
  const before = readFileSync(path, 'utf8');
  if (!before.includes(PLACEHOLDER)) continue;
  writeFileSync(path, before.split(PLACEHOLDER).join(siteUrl));
  replaced += 1;
}

console.log(
  `render-seo: ${siteUrl} -> sitemap.xml (${pages.length} urls), robots.txt, ${replaced} html file(s)`,
);
