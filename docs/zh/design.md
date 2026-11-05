# DSH 就位（DSH Ready）设计

## 背景

DSH（DeepSeek Harness）目前只能通过命令行 `dsh web` 启动，非开发者需要装终端、装 Node、记命令，还要处理端口与进程残留。本应用把「安装、启动、停止、状态、日志、升级、卸载」七件事收进一个极简 Electron 桌面应用，双击即用。

明确的减法边界：不做插件管理、不做 MCP/技能、不做多实例、不做整合包、不自建 DSH 界面，只启动官方 Web 页面并用系统浏览器打开。同一时刻只管理一个 DSH 实例。

## 整体流程

1. 应用启动 → 首屏先显示轻量遮罩与转圈动画，读到本地状态（运行时、dsh 安装情况、进程状态）后再淡出；registry 最新版本后台拉取，不阻塞首屏。窗口关闭按钮只隐藏窗口，应用与 DSH 继续运行，点菜单栏图标（或重新打开应用）恢复窗口。
2. 环境变量 → 读取登录 shell 环境（`$SHELL -ilc 'env -0'`）并合并进进程环境：从 Dock 或 Finder 启动的图形应用只有 launchd 的精简环境，`~/.zshrc` 里的 API Key、代理、PATH 都不会自动带进来。`HOME`、`USER`、`SHELL`、`TMPDIR`、`PATH`、`DSH_HOME` 以应用自身为准；终端/会话类变量（`TERM*`、`ITERM_*`、`DSH_SESSION_ID`、`DSH_WEB_URL` 等）不回灌；`PATH` 取 shell 与应用的并集。dsh、npm、pnpm 都继承这份环境。
3. 识别 DSH → 使用用户环境里已安装的 dsh（npm 全局、Homebrew、nvm 等）。
4. 端口 → 默认 3080，界面上的端口可点击修改并持久化；启动固定使用该端口。
5. 检测外部实例 → 每 4 秒扫描系统里的 `dsh web` 进程，只认监听「目标端口」的实例；命中时状态显示「已运行（外部）」，可停止或一键接管重启，其它端口的 dsh 不接管。
6. 运行时 → 读取登录 shell 的 Node/npm 并打印版本；缺 Node、版本低于 22.18 或缺 npm 时，不自动修改用户环境，提示用户前往 Node.js 中文官网下载页手动安装。
7. 安装 → `npm install -g @deepseek-ai/dsh@<版本>` 装到 npm 的默认全局前缀（nvm/Homebrew 的用户级 Node 都可写），不加 `--prefix`、不需要 sudo。
8. 启动 → `dsh web --no-open --port <目标端口>`，端口被占用时直接报错并提示改端口；从日志解析带 token 的地址，就绪后用系统浏览器打开。macOS 上开启「阻止空闲休眠」时，整条命令外面再套一层 `caffeinate -i`（caffeinate 把工具换成自己的 pid 执行，另 fork 一个断言持有进程），DSH 退出时断言随之释放。
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
| status | 当前状态 | not-installed / stopped / external / starting / running / stopping / restarting / installing / upgrading / uninstalling / takingover |
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

### `dsh:restart`

无请求参数，响应 `{ ok, url }`。先停止当前实例（控制台启动的，或已接管的外部实例），再用当前设置重新启动，用于让「启动时生效」的设置（阻止空闲休眠、代理、附加参数）立刻落地。状态会短暂进入 `restarting`。

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

`app:info` 无参数，返回 `{ version, site, github, developer, autoLaunch, dock, preventSleep }`；
`autoLaunch` 为 `{ supported, enabled }`，`supported` 只在安装版 macOS / Windows 上为 true；
`dock.supported` 与 `preventSleep.supported` 只在 macOS 上为 true（后者还要求系统存在 `/usr/bin/caffeinate`）。

`app:auto-launch` 请求 `{ enabled }`，调用 `app.setLoginItemSettings({ openAtLogin })` 并回读真实状态。

| 响应字段 | 含义 | 取值范围 |
| --- | --- | --- |
| ok | 是否写入成功 | true / false |
| supported | 平台是否支持开机自启动 | true / false（Linux 与开发模式为 false） |
| enabled | 回读到的真实状态 | true / false |

平台不支持时返回 `ok:false` 并附说明文案，主进程日志同步记录一次结果。

### `settings:get` / `settings:set`

`settings:get` 无参数，返回 `{ port, openInBrowser, showTray, showDock, preventSleep, telemetry, autoUpdateCheck, npmRegistry, proxy, dshArgs }`。

`settings:set` 接受上述字段的子集，返回 `{ ok, settings, dropped, restartRequired }`：

| 字段 | 含义 | 取值范围 |
| --- | --- | --- |
| ok | 是否写入成功 | true / false |
| settings | 回读后的完整设置 | 同 settings:get |
| dropped | 被白名单丢弃的启动参数 | 字符串数组，可为空 |
| restartRequired | `preventSleep` 变化且当前有就位启动的实例在跑 | true / false |

写盘前统一做归一化：`proxy` 走 `normalizeProxy`（非法则存空串），`dshArgs` 走 `parseDshArgs`
（丢弃 `--port` 等非法 token），布尔字段只接受 `true` / `false`。`npmRegistry` 变化时清空源缓存并
重新拉取最新版本。`preventSleep` 只在 macOS 上写入（其它平台忽略该字段）。端口与主题、语言仍走各自的
`port:set` / `theme:set` / `lang:set`。

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
- 提示框全部由渲染层自绘（`showModal`），不使用 Electron 原生 `dialog`；**退出不再有确认框**：顶栏退出按钮、Cmd+Q 与菜单栏「退出」一律直接退出，退出前会把受管的 DSH 停掉，没有别的代价需要在弹窗里确认。
- 语言按钮固定在最左侧，显示当前语言（`中文` / `EN`），点击即切换并持久化到 `settings.json`。
- 插件升级检查的结构化结果（`plan.plugins[].detail`）由渲染层按当前语言拼文案，主进程不再返回写死的中文原因。
- 日志与命令保持原文（dsh / npm / pnpm 的原始输出），不参与翻译。

## 鲸鱼娘动画

状态与动画的对应关系（本地素材，随应用一起分发）：

| 动画 | 文件 | 触发状态 |
| --- | --- | --- |
| 待机呼吸 | `idle` | not-installed |
| 小憩沉眠 | `sleepy` | stopped |
| 忙碌点按 | `busy` | starting / stopping / restarting / installing / upgrading / uninstalling / takingover |
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
  - **常规**：开机自启动、DSH 端口、启动后自动打开浏览器、系统托盘图标、显示 Dock 图标、阻止空闲休眠、主题、语言。
  - **网络**：npm 源（自动 / 官方 / 镜像）、HTTP(S) 代理、DSH 附加启动参数。
  - **隐私与更新**：匿名启动上报、自动检查更新、检查更新、系统权限（仅 macOS）。
- 端口只有一个入口：设置页的「DSH 端口」。主界面端口改为只读展示（`span`，不再是可点击按钮），
  DSH 正在运行或检测到外部实例时输入框锁定并提示「运行中不可修改」。
- 开机自启动：`role="switch"` 自绘开关，主进程调 `app.setLoginItemSettings`；
  仅安装版 macOS / Windows 可用，Linux 与开发模式禁用并在开关下方给出说明。
- 启动后自动打开浏览器：默认关闭。关闭时启动命令追加 `--no-open`，开启则由 DSH 自己拉起浏览器。
- 系统托盘 / 菜单栏图标：默认开启，可在设置里关掉（关掉即销毁图标，不留空位）。菜单只有
  「显示主窗口」与「退出」两项，退出即退、不再弹确认框；tooltip 与菜单文案跟随语言切换。
  - **macOS 用单色模板图**（`renderer/assets/trayTemplate.png` 18pt + 同名 `@2x` 36pt，由同一份
    矢量栅格化，`setTemplateImage(true)` 让系统按菜单栏明暗自动着色）。图案就是 DSH 官方鲸鱼 mark
    （`@deepseek-ai/dsh-client-ui-primitives` 的 `FISH_LOGO_PATH`，viewBox 23.16×17.04），不自己另画、
    也不拿彩色应用图标去 `.resize()`：立绘缩到 16–18px 是一团糊块，而且 `resize()` 会丢掉 `@2x` 表示、
    在 Retina 上被二次放大。`nativeImage.createFromPath()` 会自动带上同目录的 `@2x` 变体，所以这里不做缩放。
  - **Windows / Linux 保留彩色图标**（`app-icon.png` 缩到 16px）。
  - **单击即回到主窗口**（三平台一致，故意不绑 `double-click`）：macOS 若用 `setContextMenu` 会在
    任意点击时弹菜单、把这一次单击吃掉，所以那里只在**右键**用 `popUpContextMenu` 推菜单，
    左键留给 `click` → 唤起窗口。
- 显示 Dock 图标（仅 macOS）：**默认关闭** —— 启动器常驻菜单栏，不占用 Dock 位；Windows / Linux
  上整行不渲染（`row[hidden]`，连 tab 焦点一起消失）。开关走 `app.dock.hide()` / `show()`，先用 `isVisible()` 比对期望值，
  再在 1.1 秒后复核一次：Electron 文档明确 `dock.hide()` 对 1 秒内的连续调用是 no-op，快速连点时
  否则会留下 Dock 与设置不一致。Dock 隐藏后 macOS 把进程当作配件（`lsappinfo` 里 `type="UIElement"`），
  所以菜单栏唤起窗口时额外调 `app.focus({ steal: true })`，避免窗口开在别的应用后面；
  托盘与 Dock 都关掉时仍可从访达再点一次应用，第二个实例会唤出已有主窗口。
- 阻止空闲休眠（仅 macOS）：**默认开启** —— 启动 DSH 时用 `caffeinate -i` 包住 `dsh web`，
  合盖之外的空闲睡眠不会再打断跑着的会话；Windows / Linux 上整行不渲染 —— 做不到的开关不放出来，
  既不占位也不假装开着。这个设置只在启动时读取，
  切换后立即写盘；若此刻有就位启动的 DSH 在跑，主进程返回 `restartRequired: true`，界面弹应用内
  确认框：「立即重启」走 `dsh:restart`（停 → 起，状态显示 `restarting`），「取消」不保留改动，
  `preventSleep` 回滚到原值并把焦点还给开关；DSH 没在跑时直接保存，下次启动生效，不弹任何框。
- npm 源：`auto` 保留原有的双源测速；`official` / `mirror` 直接锁定，跳过测速。
  切换后清空源缓存并重新拉取最新版本。
- HTTP(S) 代理：只写进 npm 与 DSH 子进程的 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`，
  应用自身的版本查询与更新检查仍然直连（设置项下方明写这句）。
- 代理地址归一化规则：接受 `host:port` 与 `http(s)://host:port`；非 http(s) 协议（如 socks）一律拒绝；
  单标签主机名（`http`、`proxy` 这类多半是输入到一半的值）必须显式带端口才算合法，IPv4 / 含点域名 /
  localhost / IPv6 允许省略端口；端口需在 1–65535。
- 非法代理**绝不覆盖已有设置**：`settings:set` 返回 `ok:false, invalid:'proxy'`，界面高亮并保留用户输入，
  不会像早期实现那样归一化成空串把已配代理悄悄清掉。
- 代理对运行中的 DSH 不会热生效（只在启动子进程时注入），保存后行内提示「重启 DSH 后生效」。
- DSH 附加启动参数：空格分词后逐 token 过白名单（`--flag` / `--flag=value` / flag 后的值 token），
  绝不过 shell；`--port` / `-p` 一律丢弃（端口由设置项统一管理），被丢弃的 token 会显示在行内提示里。
- 匿名启动上报与自动检查更新各有一个开关：上报开关只管 `/api/ping`；自动更新开关只管每天一次的
  `/api/release`；手动「检查更新」始终可用。环境变量 `DSH_READY_NO_TELEMETRY=1` 仍是硬关闭。
- 系统权限检查（**仅 macOS**，Windows / Linux 整行不渲染）：行样式照抄「检查更新」——标签下是一行
  「已开通 3/4 项」，右侧是「检测权限」按钮。按钮在设置页之上再叠一层自绘清单：左侧权限名 + 用途，
  中间一枚状态徽标，右侧「打开设置」。徽标是画出来的字形（圆底 + 对勾 / 三角感叹号），不是 emoji：
  ✅ 已开通走 `--ok`，⚠️ 未开通 / 无法检测走 `--warn`，顶部四段进度条一段一项。
  「打开设置」用 `x-apple.systempreferences:` 深链直达对应面板
  （`Privacy_Accessibility` / `Privacy_ScreenCapture` / `Privacy_AppBundles` / `Privacy_AllFiles`）。
  四项检测**一律不弹系统框**（否则每次打开设置都糊一遍同样的授权弹窗）：辅助功能走
  `systemPreferences.isTrustedAccessibilityClient(false)`，屏幕录制走 `getMediaAccessStatus('screen')`，
  磁盘完全访问靠读一个 TCC 保护文件并校验真实 SQLite 头（macOS 15 上被拒的读取会返回 EOF 而不是抛错，
  「没抛错」不算拿到权限）。App 管理没有 preflight API，而所有能证明它的操作（改权限、写别的 `.app`）
  都会触发 TCC 弹窗，所以它的结论从 TCC 数据库读——而 TCC 数据库本身就在磁盘完全访问后面：没开那一项时
  这一行如实显示第三种状态「需先开通磁盘完全访问」，不猜。
- 权限清单在三个时机重测：打开设置时、点「重新检测」时、窗口重新获得焦点时。系统设置是另一个 App，
  用户切回来正是结论变化的时刻，不该再要求手点一次。
- 网络容错（慢速/双栈网络的实测教训）：App 自身的两个请求（`/api/ping`、`/api/release`）共用
  15 秒超时 + 一次重试，并在模块加载时把 DNS 解析顺序设为 `ipv4first`。原因是这类网络里 IPv6 的
  AAAA 记录常常黑洞：浏览器靠 Happy Eyeballs 会立刻回落 IPv4（同一台机器 `curl` 4 秒能拿到 200），
  而 Node 的 `fetch` 会死在 IPv6 连接上直到超时 —— 表现为「浏览器能下载、检查更新却失败」。
- 失败原因分档，不再一律「检查失败」：未写入官网地址（打包缺 `SITE_URL`）、被环境变量关闭、
  网络不可达（附错误码，如 `ETIMEDOUT`）、服务器异常（附 HTTP 状态码）；同一句话同时写进日志面板。
- 所有切换控件均为自绘：分段控件与开关都是 `button` + `aria-checked`，文本输入框也是自绘样式，
  不使用系统 `select` / `checkbox` / 原生确认框。
- 焦点环只在键盘操作时出现：窗口被托盘单击唤回后，Chromium 会把焦点还给上一个被点过的头部图标，
  并画出 `:focus-visible` 边框（看起来像「语言按钮莫名高亮」）。渲染层记录输入模态 ——
  `keydown` 置为键盘、`pointerdown` 置为指针，窗口重新 `focus` 时若处于指针模态就把 `.bar` 里的
  焦点 `blur()` 掉；输入框等其它位置不受影响，键盘导航照常保留焦点环。
  `scripts/probe-focus-ring.mjs` 用 CDP 钉住这个行为（指针重聚焦 → 焦点回 `body`，键盘重聚焦 → 保留）。
- 外链统一走主进程 `app:open-external`，只允许官网、仓库、开发者主页、开发者邮箱，
  以及 Node.js 官方下载页的两个精确路径（`/zh-cn/download`、`/en/download`），避免任意 URL 被利用。
- 发现新版本时弹应用内确认框，确认后用系统浏览器打开官网下载页。
- 面板宽 400px、`max-height: calc(100vh - 44px)`，内容超出时卡片内部滚动，窗口尺寸不变。
- 启动上报（`/api/ping`）只含随机会话级设备 ID 与版本号。

## 平台与构建

支持 macOS Apple Silicon（arm64）、macOS Intel（x64）、Windows（x64）。

| 产物 | 命令 | 说明 |
| --- | --- | --- |
| dsh-ready-1.1.0-arm64.dmg | `npm run dist:mac:arm64` | Apple Silicon 机器 |
| dsh-ready-1.1.0-x64.dmg | `npm run dist:mac:x64` | Intel 机器；可在 Apple Silicon 上交叉构建 |
| dsh-ready-1.1.0-x64.exe | `npm run dist:win` | Windows 安装包；在 macOS 上构建不需要 Wine |

- 交叉构建：Apple Silicon 上打 Intel 包时，electron-builder 自动下载 x64 版 Electron，产物是可运行的 x86_64 应用。
- 三个平台都只检测用户环境里的 Node/npm，不自动安装或修改；缺失或版本不满足要求时显示本地化的 Node.js 官网安装链接。
- macOS 构建在 `afterPack` 钩子里签名（electron-builder 的 `identity` 留空）：优先用
  **稳定的自签名身份**（`scripts/create-signing-identity.sh` 在每台构建机导入一次），
  没有该身份时退回 ad-hoc（`--sign -`）。这不是外观问题：ad-hoc 签名的设计需求只有
  `cdhash H"…"`，**每次构建都是一个全新的代码身份**，而 macOS 的 TCC 授权正是按这条需求
  记账的 —— 于是每个新版本都会以“陌生 App”出现，用户之前给的辅助功能 / 屏幕录制 /
  磁盘完全访问授权静默失效，而系统设置里那行旧条目还显示“已开”。自签名身份得到的是
  `identifier "com.onblog.dsh-ready" and certificate leaf = H"…"`，跨版本稳定。
  构建日志会打印最终的设计需求，退回 ad-hoc 一眼可见。两者都未公证，带隔离属性的副本首次
  打开仍会被 Gatekeeper 拦一次，到「系统设置 → 隐私与安全性」点「仍要打开」；
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
