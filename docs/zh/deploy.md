# 部署与发布

## 前置条件

- Node 20+（本项目在 Node 25 上开发）与 npm。
- 已登录 Cloudflare：`cd site && npx wrangler login`，账号需有 Workers Scripts、D1、
  R2、KV、Workers Routes 的写权限。
- 能访问 GitHub 仓库 `onblog/dsh-ready`。

## 资源约定

官网使用的 Cloudflare 资源如下（`common` 是本账号已有的通用资源，本仓库不新建库）：

| 资源 | 名称 / ID |
| --- | --- |
| Worker | `dsh-ready` |
| D1 | `common`（`ba170df9-05e6-427e-a081-099306e7fc77`），表前缀 `ready_` |
| R2 | `common` 桶，key 前缀 `dsh-ready/` |
| KV | `a81355effe1948efba1e9cf97ae3d04a`，key 前缀 `ready:` |

D1 的 `d1_migrations` 表按**文件名**记账，所以迁移文件必须叫
`NNNN_ready_*.sql`，避免与同名迁移冲突。

## 首次部署

```sh
cd site
npm install
npx wrangler d1 migrations apply common --remote
SITE_URL=https://dsh.wordtk.com npm run deploy
```

`npm run deploy` 会先执行 `scripts/render-seo.mjs`（把 `__SITE_URL__` 占位符替换成
真实域名，并生成 `sitemap.xml` / `robots.txt`），再 `wrangler deploy`。

域名绑定写在 `wrangler.jsonc` 的 `routes`（`custom_domain: true`），`wrangler deploy`
会一并维护 DNS 记录与证书；`workers_dev` 与 `preview_urls` 均为 false。

## 发版流程（桌面端 + 官网）

```sh
# 1. 改 package.json 的 version
npm install
npm run dist:mac:arm64
npm run dist:mac:x64
npm run dist:win

# 2. 三端安装包上传 R2，并重写 latest.json（旧版本会被自动删除）
cd site
npm run release

# 3. 截图（可选，界面有改动时）
cd ..
npm run shots

# 4. 官网重新部署（静态资源有变化时）
cd site
SITE_URL=https://dsh.wordtk.com npm run deploy
```

`publish-release.mjs` 只保留当前版本：上传新的三个安装包 → 上传 `latest.json` →
删除上一份清单里指向的旧对象。R2 里不应堆积下载不到的安装包。

## Workers Builds（git push 自动部署）

1. Cloudflare Dashboard → Workers & Pages → `dsh-ready` → Settings → Build。
2. 连接 GitHub 仓库 `onblog/dsh-ready`，生产分支 `main`。
3. Root directory 填 `site`，构建命令留空（纯静态 + 单文件 Worker，无需构建），
   部署命令 `npx wrangler deploy`。
4. 环境变量加 `SITE_URL=https://dsh.wordtk.com`（SEO 渲染需要）。
5. 之后推送到 `main` 即自动部署，约 30 秒后生效；**不要**再加 GitHub Actions
   workflow。

## 本地验证

```sh
cd site
npm run dev                    # 本地 Worker + 静态资源
curl -s localhost:8787/api/release
curl -s localhost:8787/api/stats
```

线上验证：

```sh
curl -sI https://dsh.wordtk.com/                    # 200 + text/html
curl -s https://dsh.wordtk.com/api/stats            # ok: true
curl -sI "https://dsh.wordtk.com/api/download?arch=arm64" | head -5
curl -s -H "Range: bytes=0-1023" -o /dev/null -w "%{http_code}\n" \
  "https://dsh.wordtk.com/api/download?arch=arm64"   # 206
```

## 观测

`wrangler.jsonc` 已开启 `observability.enabled` 与 `observability.traces`：日志与链路
在 Dashboard → Workers → dsh-ready → Observability 查看，代码里用结构化
`console.error('[api]', error)` 输出，便于按字段筛选。

## 回滚

Worker 版本回滚：Dashboard → Workers → dsh-ready → Deployments → 选上一个版本
Rollback。安装包回滚：把 `site/latest.json` 改回旧版本并重新上传对应文件，然后
`npm run release`（脚本会按清单删除当前版本不再引用的对象）。
