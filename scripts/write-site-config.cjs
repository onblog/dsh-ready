'use strict';

/**
 * Bake the website origin and the contact address into the package.
 *
 * Why: the repository must stay free of a live domain and a real mailbox, and a
 * packaged app cannot read `.env` at runtime (a double-clicked .app inherits no
 * shell environment). So the two values are resolved here — environment first,
 * then a local `.env` next to this script — and written to a generated file that
 * electron-builder ships inside the app bundle.
 *
 * The generated file is git-ignored. Building without these variables still
 * succeeds: telemetry and the update check stay disabled, and the contact entry
 * is hidden from the About sheet.
 *
 *   SITE_URL=https://example.com CONTACT_EMAIL=you@example.com npm run dist
 *   node scripts/write-site-config.cjs --require   # fail when SITE_URL is missing
 */
const fs = require('node:fs');
const path = require('node:path');

const repoDir = path.resolve(__dirname, '..');
const target = path.join(repoDir, 'electron', 'site.generated.json');
const requireUrl = process.argv.includes('--require');

/** Minimal `.env` reader: `KEY=value`, optional quotes, no interpolation. */
function fromDotEnv(key) {
  const file = path.join(repoDir, '.env');
  if (!fs.existsSync(file)) return '';
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`);
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(pattern);
    if (match) return match[1].replace(/^['"]|['"]$/g, '').trim();
  }
  return '';
}

const read = (key) => (process.env[key] || fromDotEnv(key)).trim();
const siteUrl = read('SITE_URL').replace(/\/+$/, '');
const contactEmail = read('CONTACT_EMAIL');

if (!siteUrl) {
  if (requireUrl) {
    console.error('error: SITE_URL is required for a release build (env or .env)');
    process.exit(1);
  }
  fs.rmSync(target, { force: true });
  console.warn(
    'warn: SITE_URL not set — launch reporting, the update check and the site link stay disabled in this build',
  );
  process.exit(0);
}

if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(siteUrl)) {
  console.error(`error: SITE_URL must be an absolute http(s) origin, got "${siteUrl}"`);
  process.exit(1);
}

if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
  console.error(`error: CONTACT_EMAIL is not an email address, got "${contactEmail}"`);
  process.exit(1);
}

fs.writeFileSync(target, `${JSON.stringify({ siteUrl, contactEmail }, null, 2)}\n`);
console.log(`site config written for ${siteUrl}${contactEmail ? ` (contact: ${contactEmail})` : ''}`);
