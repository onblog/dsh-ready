# Deployment and releases

## Prerequisites

- Node 20+ (this project is developed on Node 25) with npm.
- A Cloudflare login: `cd site && npx wrangler login`, with write access to Workers
  Scripts, D1, R2, KV and Workers Routes.
- Access to the GitHub repository `onblog/dsh-ready`.

## Resource layout

The site uses these Cloudflare resources (`common` already exists in this account):

| Resource | Name / id |
| --- | --- |
| Worker | `dsh-ready` |
| D1 | `common` (`ba170df9-05e6-427e-a081-099306e7fc77`), tables prefixed `ready_` |
| R2 | `common` bucket, key prefix `dsh-ready/` |
| KV | `a81355effe1948efba1e9cf97ae3d04a`, keys prefixed `ready:` |

`d1_migrations` records migrations by **file name**, so files must be named
`NNNN_ready_*.sql` to avoid colliding with an already-applied migration.

## First deployment

```sh
cd site
npm install
npx wrangler d1 migrations apply common --remote
SITE_URL=https://dsh.wordtk.com npm run deploy
```

`npm run deploy` runs `scripts/render-seo.mjs` first (replacing the `__SITE_URL__`
placeholder with the real origin and generating `sitemap.xml` / `robots.txt`), then
`wrangler deploy`.

The custom domain is **not** declared in `wrangler.jsonc`: the live origin must not be
hardcoded in the repository. Bind it once in Cloudflare Dashboard → Workers & Pages →
`dsh-ready` → Settings → Domains & Routes; `wrangler deploy` leaves that binding as it is.
`workers_dev` and `preview_urls` are both false, so the site is only reachable on its domain.

## Release process (desktop + site)

Before packaging the desktop app, put a `.env` in the repo root (already git-ignored) with
these two variables. `electron-builder`'s `beforeBuild` runs
`scripts/write-site-config.cjs`, which writes `electron/site.generated.json` into the bundle:

```sh
SITE_URL=https://YOUR_DOMAIN
CONTACT_EMAIL=YOUR_EMAIL
```

Building without them still works: launch reporting and the update check stay off, and the
contact entry in the About sheet is hidden.

```sh
# 1. bump version in package.json
npm install
npm run dist:mac:arm64
npm run dist:mac:x64
npm run dist:win

# 2. upload all three to R2 and rewrite latest.json (old files are pruned)
cd site
npm run release

# 3. recapture screenshots when the UI changed (optional)
cd ..
npm run shots

# 4. redeploy the site when static files changed
cd site
SITE_URL=https://dsh.wordtk.com npm run deploy
```

`publish-release.mjs` keeps only the live version: upload the three installers, upload
`latest.json`, then delete every object the previous manifest referenced. R2 must not
accumulate installers nobody can download.

## Workers Builds (deploy on git push)

1. Cloudflare Dashboard → Workers & Pages → `dsh-ready` → Settings → Build.
2. Connect the GitHub repository `onblog/dsh-ready`, production branch `main`.
3. Root directory `site`, build command empty (static assets + a single Worker script,
   nothing to compile), deploy command `npx wrangler deploy`.
4. Add the environment variable `SITE_URL=https://dsh.wordtk.com` (needed by the SEO
   renderer).
5. From then on a push to `main` deploys automatically in about 30 seconds. Do **not**
   add a GitHub Actions workflow.

## Verification

```sh
cd site && npm run dev            # local worker + assets
curl -s localhost:8787/api/release
curl -s localhost:8787/api/stats
```

Against production:

```sh
curl -sI https://dsh.wordtk.com/
curl -s https://dsh.wordtk.com/api/stats
curl -s -H "Range: bytes=0-1023" -o /dev/null -w "%{http_code}\n" \
  "https://dsh.wordtk.com/api/download?arch=arm64"   # 206
```

## Observability

`wrangler.jsonc` sets `observability.enabled` and `observability.traces`; logs and
traces are visible in Dashboard → Workers → dsh-ready → Observability. The worker
logs structured `console.error('[api]', error)` entries so fields can be filtered.

## Rollback

Worker: Dashboard → Workers → dsh-ready → Deployments → pick the previous version and
roll back. Installers: point `site/latest.json` back at the previous version, re-upload
those files and run `npm run release`; the script prunes whatever the new manifest does
not reference.
