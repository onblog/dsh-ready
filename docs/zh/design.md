# DSH 就位（DSH Ready）设计

## 背景

DSH（DeepSeek Harness）目前只能通过命令行 `dsh web` 启动，非开发者需要装终端、装 Node、记命令，还要处理端口与进程残留。本应用把「安装、启动、停止、状态、日志、升级、卸载」七件事收进一个极简 Electron 桌面应用，双击即用。

明确的减法边界：不做插件管理、不做 MCP/技能、不做多实例、不做整合包、不自建 DSH 界面，只启动官方 Web 页面并用系统浏览器打开。同一时刻只管理一个 DSH 实例。

## 整体流程

1. 应用启动 → 首屏先显示轻量遮罩与转圈动画，读到本地状态（运行时、dsh 安装情况、进程状态）后再淡出；registry 最新版本后台拉取，不阻塞首屏。窗口关闭按钮只隐藏窗口，应用与 DSH 继续运行，点 Dock 图标恢复窗口。
2. 环境变量 → 读取登录 shell 环境（`$SHELL -ilc 'env -0'`）并合并进进程环境：从 Dock 或 Finder 启动的图形应用只有 launchd 的精简环境，`~/.zshrc` 里的 API Key、代理、PATH 都不会自动带进来。`HOME`、`USER`、`SHELL`、`TMPDIR`、`PATH`、`DSH_HOME` 以应用自身为准；终端/会话类变量（`TERM*`、`ITERM_*`、`DSH_SESSION_ID`、`DSH_WEB_URL` 等）不回灌；`PATH` 取 shell 与应用的并集。dsh、npm、pnpm 都继承这份环境。
3. 识别 DSH → 使用用户环境里已安装的 dsh（npm 全局、Homebrew、nvm 等）。
4. 端口 → 默认 3080，界面上的端口可点击修改并持久化；启动固定使用该端口。
5. 检测外部实例 → 每 4 秒扫描系统里的 `dsh web` 进程，只认监听「目标端口」的实例；命中时状态显示「已运行（外部）」，可停止或一键接管重启，其它端口的 dsh 不接管。
6. 运行时 → 读取登录 shell 的 Node/npm 并打印版本；缺 Node、版本低于 22.18 或缺 npm 时，先测速官方源与国内镜像，再用 nvm 安装 Node 22 到 `~/.nvm`，并把 nvm 初始化写入 shell 配置。
7. 安装 → `npm install -g @deepseek-ai/dsh@<版本>` 装到 npm 的默认全局前缀（nvm/Homebrew 的用户级 Node 都可写），不加 `--prefix`、不需要 sudo。
8. 启动 → `dsh web --no-open --port <目标端口>`，端口被占用时直接报错并提示改端口；从日志解析带 token 的地址，就绪后用系统浏览器打开。
9. 运行中 → stdout/stderr 实时流入日志面板并落盘；状态由进程存活 + HTTP 探测共同判定。
10. 停止 → 先 SIGTERM 进程组，超时 SIGKILL；应用退出时自动停止。
11. 升级 → 版本下拉只在「安装流程」和「升级流程」里出现。升级分两步：先出升级计划，再执行。
    - 升级计划：停实例前完成检查。逐个核对已安装第三方插件的 DSH 兼容声明：`peerDependencies` 里 `@deepseek-ai/dsh`、`@deepseek-ai/dsh-*` 的范围，以及 `engines.dsh`（这些内部包与 dsh 主包同版本列车发版）。插件标了 `optional` 的 peer 视为建议范围，只有建议范围不匹配时保持现状并标注；必需范围不匹配才升级。当前版本已适配就保持不动；不适配就到 registry 找适配目标版本的最高版本；找不到、或插件是 git/本地路径安装、或缺少 pnpm，都算阻塞项，只提示不执行。
    - 展示命令：检查通过后列出带版本号的 dsh 升级命令和第三方插件升级命令。
    - 执行：先停止实例（控制台启动的或检测到的外部实例），再 `npm install -g @deepseek-ai/dsh@<目标版本>` 装到 npm 默认全局前缀（就地升级），最后 `dsh plugin --profile web add <包名>@<版本> ...` 升级插件；任一步失败都写明确日志。

## 接口文档

主进程与渲染层通过 Electron IPC 通信，事件走 `dsh:event` 单向推送。

### `state:get`

无请求参数。

| 字段 | 含义 | 取值范围 |
| --- | --- | --- |
| status | 当前状态 | not-installed / stopped / external / starting / running / stopping / installing / upgrading / uninstalling / takingover |
| external | 目标端口上由其它方式启动的实例 | `{ pid, port, url }` 或 null |
| targetPort | 目标端口（可修改，默认 3080） | 1–65535 |
| dshVersion | 当前生效版本 | 语义化版本或 null |
| dshSource | 当前版本来源 | app / system / null |
| systemDshVersion | 系统已安装的版本 | 语义化版本或 null |
| latestVersion | registry 最新版本 | 语义化版本或 null |
| port | 本次监听端口 | 1–65535，未启动为 null |
| url | 访问地址 | http URL 或 null |
| pid | dsh 进程号 | 正整数或 null |
| runtime | 运行时来源 | system / missing |
| nodeVersion | Node 版本 | 如 v22.20.0 或 null |
| theme | 主题（不跟随系统，默认 dark） | dark / light |
| lang | 界面语言（已解析） | zh / en |
| busy | 是否在执行安装类操作 | true / false |

### `versions:list`

拉取可安装版本，供版本下拉使用。

| 字段 | 含义 | 取值范围 |
| --- | --- | --- |
| latest | 最新版本 | 语义化版本或 null |
| tags | dist-tags 映射 | 如 `{ latest: "0.2.1-rc.2", next: "..." }` |
| versions | 可选版本列表（最新在前，最多 40 条） | 版本号字符串数组 |

### `dsh:install`

| 字段 | 含义 | 取值范围 |
| --- | --- | --- |
| version | 目标版本 | 版本号或 dist-tag，默认取 `latest` |

响应：`{ ok, message }`。过程日志通过 `dsh:event` 推送。

### `upgrade:plan`

生成升级计划：先核对已安装第三方插件与目标版本的兼容性，全部通过才给出要执行的命令。

| 字段 | 含义 | 取值范围 |
| --- | --- | --- |
| version | 目标版本 | 语义化版本或 dist-tag；缺省取 registry 最新版 |

| 响应字段 | 含义 | 取值范围 |
| --- | --- | --- |
| ok | 请求是否处理成功 | true / false |
| message | 失败原因 | 字符串，成功时缺省 |
| plan.ok | 检查是否通过 | true / false |
| plan.currentDsh | 当前生效版本 | 语义化版本 |
| plan.targetDsh | 目标版本 | 语义化版本，需高于当前版本 |
| plan.dshSource | 当前版本来源 | app / system |
| plan.profile | 插件所在 profile | 固定 web |
| plan.plugins | 逐个插件的检查结果 | 数组，见下表 |
| plan.blockers | 阻塞项 | 数组 `{ name, reason }`，可为空 |
| plan.commands | 将要执行的命令 | 字符串数组，dsh 命令在前 |
| plan.dshArgs | dsh 升级命令参数 | 字符串数组 |
| plan.pluginArgs | 插件升级命令参数，无需升级时为 null | 字符串数组或 null |

`plan.plugins` 数组元素：

| 字段 | 含义 | 取值范围 |
| --- | --- | --- |
| name | 插件包名 | 字符串 |
| current | 已安装版本 | 语义化版本 |
| next | 目标版本 | 语义化版本，阻塞时为 null |
| action | 处理方式 | upgrade / keep / blocked |
| verified | 是否有必需的 DSH 兼容声明（只有可选声明或未声明的按「未校验」放行） | true / false |
| note | 补充说明 | 字符串或 null |
| reason | 阻塞原因 | 字符串，非阻塞时为 null |

### `upgrade:apply`

| 字段 | 含义 | 取值范围 |
| --- | --- | --- |
| plan | `upgrade:plan` 返回的计划 | 对象，需包含 targetDsh 与 dshArgs |

响应 `{ ok, message }`。执行顺序：停止实例 → 升级 dsh → 升级插件。

### `dsh:uninstall`

无请求参数。先弹确认框说明四步动作与保留项，确认后执行「停止实例 → 卸载插件 → 清理 profile 配置 → 卸载程序本体」，用户数据 `~/.dsh` 不动。

| 响应字段 | 含义 | 取值范围 |
| --- | --- | --- |
| ok | 是否执行完成 | true / false |
| cancelled | 用户点了取消 | true，取消时返回 |
| message | 结果说明 | 字符串，如「DSH 已卸载（用户数据、Node 与 npm 保留）」 |

### `dsh:start`

无请求参数（端口由系统分配），响应 `{ ok, url }`。

### `dsh:stop`

无请求参数，响应 `{ ok }`。控制台自己启动的实例直接停止；检测到的外部实例按 PID 结束进程并等待端口释放。

### `dsh:takeover`

无请求参数，响应 `{ ok, url }` 或 `{ ok: false, cancelled }`。

先弹确认框说明将停止的 PID 与端口，确认后停止外部进程、等待端口释放，再由 DSH 就位重新启动，实现接管。

### `dsh:open`

用系统浏览器打开当前地址（带 token），无请求参数，响应 `{ ok }`。

### `log:get` / `log:clear`

`log:get` 返回 `{ lines: string[] }`，保留最近 2000 行；`log:clear` 返回 `{ ok }`。

### `port:set`

| 字段 | 含义 | 取值范围 |
| --- | --- | --- |
| port | 目标端口 | 1–65535 |

运行中拒绝修改。修改后立即重新检测外部实例并持久化到 `settings.json`。

### `app:quit`

无请求参数，弹确认框，确认后结束应用；由控制台启动的 DSH 会先停止。

| 响应字段 | 含义 | 取值范围 |
| --- | --- | --- |
| ok | 是否发起退出 | true / false |
| cancelled | 用户点了取消 | true，取消时返回 |

### `lang:set`

| 字段 | 含义 | 取值范围 |
| --- | --- | --- |
| lang | 界面语言 | zh / en；其它值按 system 存 |

响应 `{ ok, lang }`，`lang` 为解析后的实际语言（zh / en）。首屏语言来自 `state:get` 的 `lang` 字段。

### `theme:set`

| 字段 | 含义 | 取值范围 |
| --- | --- | --- |
| theme | 主题模式 | dark / light（默认 dark） |

响应 `{ ok, theme }`，同时持久化到应用数据目录 `settings.json`。仅接受 `light` / `dark`，其它值（含历史遗留的 `system`）一律按 `dark` 处理。

### `app:info` / `app:auto-launch`

`app:info` 无参数，返回 `{ version, site, github, developer, autoLaunch }`；
`autoLaunch` 为 `{ supported, enabled }`，`supported` 只在安装版 macOS / Windows 上为 true。

`app:auto-launch` 请求 `{ enabled }`，调用 `app.setLoginItemSettings({ openAtLogin })` 并回读真实状态。

| 响应字段 | 含义 | 取值范围 |
| --- | --- | --- |
| ok | 是否写入成功 | true / false |
| supported | 平台是否支持开机自启动 | true / false（Linux 与开发模式为 false） |
| enabled | 回读到的真实状态 | true / false |

平台不支持时返回 `ok:false` 并附说明文案，主进程日志同步记录一次结果。

### `settings:get` / `settings:set`

`settings:get` 无参数，返回 `{ port, openInBrowser, telemetry, autoUpdateCheck, npmRegistry, proxy, dshArgs }`。

`settings:set` 接受上述字段的子集，返回 `{ ok, settings, dropped }`：

| 字段 | 含义 | 取值范围 |
| --- | --- | --- |
| ok | 是否写入成功 | true / false |
| settings | 回读后的完整设置 | 同 settings:get |
| dropped | 被白名单丢弃的启动参数 | 字符串数组，可为空 |

写盘前统一做归一化：`proxy` 走 `normalizeProxy`（非法则存空串），`dshArgs` 走 `parseDshArgs`
（丢弃 `--port` 等非法 token），布尔字段只接受 `true` / `false`。`npmRegistry` 变化时清空源缓存并
重新拉取最新版本。端口与主题、语言仍走各自的 `port:set` / `theme:set` / `lang:set`。

### 事件 `dsh:event`

| 字段 | 含义 | 取值范围 |
| --- | --- | --- |
| type | 事件类型 | log / state |
| line | 日志行 | 字符串 |
| state | 全量状态快照 | 同 `state:get` 响应 |

## 界面语言

支持简体中文与英文，默认跟随系统区域（`zh` 一律按简体处理）。

- 主进程按优先级解析：`settings.json` 里显式选择的 `lang` → `app.getLocale()` 的区域判断；结果放进 `state.lang`，渲染层据此加载文案。
- 渲染层文案集中在 `renderer/i18n.js`（`t(key, params)`），主进程返回的状态消息集中在 `electron/i18n.mjs`（`mainT`），两边 key 命名保持一致。
- 确认框、提示框全部由渲染层自绘（`showModal`），不再使用 Electron 原生 `dialog`；Cmd+Q 与菜单退出也走同一个确认框。
- 语言按钮固定在最左侧，显示当前语言（`中文` / `EN`），点击即切换并持久化到 `settings.json`。
- 插件升级检查的结构化结果（`plan.plugins[].detail`）由渲染层按当前语言拼文案，主进程不再返回写死的中文原因。
- 日志与命令保持原文（dsh / npm / pnpm 的原始输出），不参与翻译。

## 鲸鱼娘动画

状态与动画的对应关系（本地素材，随应用一起分发）：

| 动画 | 文件 | 触发状态 |
| --- | --- | --- |
| 待机呼吸 | `idle` | not-installed |
| 小憩沉眠 | `sleepy` | stopped |
| 忙碌点按 | `busy` | starting / stopping / installing / upgrading / uninstalling / takingover |
| 漂浮踏步 | `running` | running |
| 东张西望 | `look` | external |
| 元气挥手 | `happy` | 点击鲸鱼娘（2 秒后回到当前状态） |
| 雀跃庆祝 | `celebrate` | 操作成功（2.2 秒） |
| 垂头叹气 | `sad` | 操作失败（2.2 秒） |

- 两层 `video` 交替播放实现交叉淡入，切状态不闪黑；首帧未就绪时继续显示静态头像。
- `prefers-reduced-motion: reduce` 下只显示静态头像，不加载视频。
- 视频为 VP9 + alpha 透明通道（640×360），`object-fit: cover` 填进 86×86 的头像区。

## 设置与更新

- 头部只有四个图标按钮，顺序固定：语言 → 主题 → 设置 → 退出。图标按钮不写文字，
  语义放在 `title` 与 `aria-label`（例如「切换主题 · 浅色」），所以 468px 宽度下也只有一个图标行；
  主题图标显示的是「将要切换到的主题」，深色态显示太阳；语言图标固定用「文A」字形，
  不使用 `EN` / `中文` 文字，也不用地球图标。
- 语言与主题图标点击即切换，和设置页共用同一份状态；设置页里是分段控件，能直接指到目标值。
- 「设置」是应用内自绘面板，由原「关于」弹窗改造而来：应用图标 + 名称 + 版本；
  开发者信息严格一行（👤 Martin · ✉ 邮箱 · GitHub · 官网，10.5px 可点击），不换行、超出裁切；
  下面是三组设置，底部是「请我喝杯咖啡」。不再展示开源协议与商业授权信息。
- 设置项（三组，顺序固定）：
  - **常规**：开机自启动、DSH 端口、启动后自动打开浏览器、主题、语言。
  - **网络**：npm 源（自动 / 官方 / 镜像）、HTTP(S) 代理、DSH 附加启动参数。
  - **隐私与更新**：匿名启动上报、自动检查更新、检查更新。
- 端口只有一个入口：设置页的「DSH 端口」。主界面端口改为只读展示（`span`，不再是可点击按钮），
  DSH 正在运行或检测到外部实例时输入框锁定并提示「运行中不可修改」。
- 开机自启动：`role="switch"` 自绘开关，主进程调 `app.setLoginItemSettings`；
  仅安装版 macOS / Windows 可用，Linux 与开发模式禁用并在开关下方给出说明。
- 启动后自动打开浏览器：默认关闭。关闭时启动命令追加 `--no-open`，开启则由 DSH 自己拉起浏览器。
- npm 源：`auto` 保留原有的双源测速；`official` / `mirror` 直接锁定，跳过测速。
  切换后清空源缓存并重新拉取最新版本。
- HTTP(S) 代理：只写进 npm 与 DSH 子进程的 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`，
  应用自身的版本查询与更新检查仍然直连（设置项下方明写这句）；格式非法时拒绝保存并高亮。
- DSH 附加启动参数：空格分词后逐 token 过白名单（`--flag` / `--flag=value` / flag 后的值 token），
  绝不过 shell；`--port` / `-p` 一律丢弃（端口由设置项统一管理），被丢弃的 token 会显示在行内提示里。
- 匿名启动上报与自动检查更新各有一个开关：上报开关只管 `/api/ping`；自动更新开关只管每天一次的
  `/api/release`；手动「检查更新」始终可用。环境变量 `DSH_READY_NO_TELEMETRY=1` 仍是硬关闭。
- 所有切换控件均为自绘：分段控件与开关都是 `button` + `aria-checked`，文本输入框也是自绘样式，
  不使用系统 `select` / `checkbox` / 原生确认框。
- 外链统一走主进程 `app:open-external`，只允许官网、仓库、开发者主页与开发者邮箱，
  避免任意 URL 被利用。
- 发现新版本时弹应用内确认框，确认后用系统浏览器打开官网下载页。
- 面板宽 400px、`max-height: calc(100vh - 44px)`，内容超出时卡片内部滚动，窗口尺寸不变。
- 启动上报（`/api/ping`）只含随机会话级设备 ID 与版本号。

## 平台与构建

支持 macOS Apple Silicon（arm64）、macOS Intel（x64）、Windows（x64）。

| 产物 | 命令 | 说明 |
| --- | --- | --- |
| dsh-ready-1.0.9-arm64.dmg | `npm run dist:mac:arm64` | Apple Silicon 机器 |
| dsh-ready-1.0.9-x64.dmg | `npm run dist:mac:x64` | Intel 机器；可在 Apple Silicon 上交叉构建 |
| dsh-ready-1.0.9-x64.exe | `npm run dist:win` | Windows 安装包；在 macOS 上构建不需要 Wine |

- 交叉构建：Apple Silicon 上打 Intel 包时，electron-builder 自动下载 x64 版 Electron，产物是可运行的 x86_64 应用。
- Node 由 nvm 按当前机器架构安装到 `~/.nvm`（官方源优先，失败时自动切 npmmirror 镜像），不打进安装包；Windows 暂不自动安装，会提示先装 Node LTS。
- macOS 构建在 `afterPack` 钩子里用 `codesign --deep --force --sign -` 做 ad-hoc 签名
  （electron-builder 的 `identity` 留空）：Apple Silicon 直接可运行；未公证，带隔离属性
  的副本首次打开仍会被 Gatekeeper 拦一次，到「系统设置 → 隐私与安全性」点「仍要打开」。
  若提示「已损坏」，执行 `xattr -cr`。
- 三平台共享同一份 `electron/` 与 `renderer/` 代码，平台差异集中在这几处：

| 能力 | macOS | Windows |
| --- | --- | --- |
| 检测其它方式启动的实例 | `ps` + `lsof` | `netstat -ano` 取端口 PID，`powershell Get-CimInstance` 取命令行 |
| 停止实例 | 进程组 SIGTERM，超时 SIGKILL | `taskkill /PID <pid> /T /F` 结束进程树 |
| 插件升级依赖 | pnpm | pnpm.cmd |

## 日志与监控

- dsh 输出按行写入 `<userData>/logs/dsh.log`，单文件超过 5MB 轮转为 `dsh.log.1`。
- 内存环形缓冲保留最近 2000 行，界面最多渲染 600 行。
- 安装、升级、卸载、Node 安装复用同一日志通道。
- 升级检查输出参与检查的插件数量与结论；升级执行输出每条实际命令、命令退出码与插件升级结果。
- 启动、就绪、停止、崩溃、启动超时都写显式日志，便于非开发者自助判断。
- 外部实例检测每 4 秒轮询一次，状态变化才推送界面；检测失败保留上一次结果。
- 窗口关闭时写一条「窗口已隐藏」日志，告诉用户从哪里恢复窗口、从哪里真正退出。
- 启动时写一条登录 shell 环境加载结果（变量个数、耗时、是否含代理），并打印 node / npm 版本（缺失也打印），不打印变量值。

## 待确认事项

- Windows 安装包本期一并出：已完成打包与产物校验（PE x86-64、asar 内容、安装包生成），未在 Windows 真机跑过一遍启动/停止/升级。
- Windows 不读取登录 shell 环境，环境变量按系统环境继承。
- 读取 shell 环境依赖 `$SHELL -ilc`，本机 zsh 约 100–400ms；如需跳过可设 `DSH_READY_SKIP_SHELL_ENV=1`。
- 界面「鲸鱼娘」头像来自用户提供的外部插画，正式分发前需替换为自有或已授权素材。
- 端口冲突只提示不自动顺延，避免用户找不到实际地址。
