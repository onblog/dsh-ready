# DSH Ready — design

## Background

DeepSeek Harness (`dsh`) is only reachable through the CLI (`dsh web`). Anyone who
does not live in a terminal has to install Node, remember commands, pick a port and
clean up leftover processes. DSH Ready puts seven operations into one small Electron
window: **install, start, stop, status, logs, upgrade, uninstall**.

Deliberate non-goals: no plugin management, no MCP/skills UI, no multiple instances,
no custom DSH UI. It starts the official web UI and hands it to the system browser.
Exactly one DSH instance is managed at a time.

## Flow

1. App start → a light boot overlay with a spinner until local state (runtime, DSH
   install, process status) is read, then fades out. The registry's latest version is
   fetched in the background and never blocks the first paint. Closing the window
   only hides it; the app and DSH keep running, and the menu-bar icon (or reopening the app)
   restores the window.
2. Environment → the login shell environment (`$SHELL -ilc 'env -0'`) is merged into
   the process environment. An app launched from Finder only inherits launchd's
   minimal environment, so API keys, proxies and `PATH` from `~/.zshrc` would
   otherwise be missing. `HOME`, `USER`, `SHELL`, `TMPDIR`, `PATH`, `DSH_HOME` always
   come from the app; terminal/session variables (`TERM*`, `ITERM_*`,
   `DSH_SESSION_ID`, `DSH_WEB_URL`, …) are never copied back; `PATH` is the union of
   shell and app values. dsh, npm and pnpm inherit this environment.
   Set `DSH_READY_SKIP_SHELL_ENV=1` to skip it.
3. Detect DSH → use the `dsh` already installed in the user environment (npm global,
   Homebrew, nvm, …). There is no app-private copy.
4. Port → default 3080, editable in the UI and persisted; starting always uses it.
5. External instance → scan the system for `dsh web` processes every 4 seconds, but
   only accept one listening on the **target port**. When found, the status becomes
   "running (external)" and the user can stop it or take it over. DSH on other ports
   is never touched.
6. Runtime → read Node/npm from the login shell and log both versions. When Node is
   missing, older than 22.18 or ships without npm, never modify the user's environment;
   direct the user to the English Node.js download page for manual installation.
7. Install → `npm install -g @deepseek-ai/dsh@<version>` into npm's default global
   prefix (writable for nvm/Homebrew user-level Node). No `--prefix`, no sudo.
8. Start → `dsh web --no-open --port <port>`; a busy port is reported as an error
   instead of being silently shifted. Parse the tokenized URL from the logs and open
   the browser once ready.
9. Running → stdout/stderr stream into the log panel and to disk; status combines
   process liveness with an HTTP probe.
10. Stop → SIGTERM the process group, SIGKILL after a timeout; the app stops DSH on
    quit as well.
11. Upgrade → versions only appear in the install/upgrade flows. An upgrade is a plan
    followed by execution:
    - **Plan**: check every installed third-party plugin's DSH compatibility before
      touching anything: `peerDependencies` on `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`
      and `engines.dsh` (internal packages release in lockstep with the main package).
      Optional peers are advisory — a mismatch keeps the plugin as is and marks it;
      only a required mismatch triggers an upgrade. If the current version already
      fits, keep it; otherwise find the highest version of the plugin that fits the
      target. Missing versions, git/local-path installs, or a missing pnpm are
      blockers: report them, change nothing.
    - **Show commands**: on success, list the DSH upgrade command and every plugin
      upgrade command with versions.
    - **Execute**: stop the instance (app-started or external), run
      `npm install -g @deepseek-ai/dsh@<target>` into npm's default global prefix,
      then `dsh plugin --profile web add <pkg>@<ver> …`.
      Every failure is logged explicitly.

## IPC API

The main process and the renderer talk over Electron IPC; events flow one way via
`dsh:event`.

### `state:get`

No request payload. Response fields:

| Field | Meaning | Values |
| --- | --- | --- |
| status | current state | not-installed / stopped / external / starting / running / stopping / restarting / installing / upgrading / uninstalling / takingover |
| external | instance on the target port started elsewhere | `{ pid, port, url }` or null |
| targetPort | target port (editable, default 3080) | 1–65535 |
| dshVersion | active version | semver or null |
| dshSource | where it comes from | app / system / null |
| systemDshVersion | system-installed version | semver or null |
| latestVersion | registry latest | semver or null |
| port | listening port for this run | 1–65535, null when stopped |
| url | access URL | http URL or null |
| pid | DSH process id | positive integer or null |
| runtime | runtime source | system / missing |
| nodeVersion | Node version | e.g. v22.20.0 or null |
| theme | theme mode (never follows the OS) | dark / light |
| lang | resolved UI language | zh / en |
| busy | install-class operation in progress | true / false |

### `versions:list`

| Field | Meaning |
| --- | --- |
| latest | latest version |
| tags | dist-tags, e.g. `{ latest, next }` |
| versions | installable versions, newest first, at most 40 |

### `dsh:install`

`{ version }` — a version or dist-tag, defaults to `latest`. Response `{ ok, message }`;
progress streams through `dsh:event`.

### `upgrade:plan` / `upgrade:apply`

`upgrade:plan` takes `{ version }` (defaults to registry latest) and returns
`{ ok, message, plan }`, where `plan` carries `ok`, `currentDsh`, `targetDsh`,
`dshSource`, `profile` (always `web`), `plugins[]` (`name`, `current`, `next`,
`action` = upgrade/keep/blocked, `verified`, `note`, `reason`), `blockers[]`,
`commands[]`, `dshArgs[]` and `pluginArgs[]`.

`upgrade:apply` takes the plan object and executes stop → DSH upgrade → plugin
upgrade in that order.

### `dsh:uninstall`, `dsh:start`, `dsh:stop`, `dsh:takeover`, `dsh:open`

- `dsh:uninstall` confirms four steps in the in-app dialog, then runs stop →
  remove plugins → clean profile → remove DSH. User data in `~/.dsh` is kept.
- `dsh:start` → `{ ok, url }`.
- `dsh:stop` → `{ ok }`; stops the app-started instance or the accepted external one.
- `dsh:takeover` → `{ ok, url }` or `{ ok: false, cancelled }`; confirms the PID and
  port, stops the external process, waits for the port, then restarts from the app.
- `dsh:open` opens the current URL (with token) in the system browser.

### `dsh:restart`

No request payload; response `{ ok, url }`. Stops the current instance (app-started or the
accepted external one) and starts it again with the current settings, so launch-time settings
(prevent idle sleep, proxy, extra arguments) take effect right away. The status shows
`restarting` meanwhile.

### `log:get`, `log:clear`, `port:set`, `app:quit`, `lang:set`, `theme:set`

`log:get` → `{ lines }` (last 2000 lines); `log:clear` → `{ ok }`.
`port:set` takes `{ port }` and is refused while running; the new port is persisted to
`settings.json`. `app:quit` confirms, stops a managed DSH and quits.
`lang:set` takes `{ lang }` and returns the resolved language; `theme:set` takes
`{ theme }` and persists it. Only `light` / `dark` are accepted; any other value
(including a legacy `system`) falls back to `dark`.

### `app:info`, `app:auto-launch`

`app:info` → `{ version, site, github, developer, autoLaunch, dock, preventSleep }`, where
`autoLaunch` is `{ supported, enabled }` and `supported` is true only in the installed macOS /
Windows build; `dock.supported` and `preventSleep.supported` are true on macOS only (the
latter also needs `/usr/bin/caffeinate`).
`app:auto-launch` takes `{ enabled }`, calls `app.setLoginItemSettings({ openAtLogin })` and
reads the real state back → `{ ok, supported, enabled }`. Unsupported platforms return
`ok: false` with a message, and the result is written to the app log.

### `settings:get`, `settings:set`

`settings:get` → `{ port, openInBrowser, showTray, showDock, preventSleep, telemetry,
autoUpdateCheck, npmRegistry, proxy, dshArgs }`.
`settings:set` takes any subset of those fields → `{ ok, settings, dropped, restartRequired }`,
where `dropped` lists the launch-argument tokens the whitelist refused and `restartRequired`
reports that a running app-managed DSH must be restarted before the new `preventSleep` value
applies. Values are normalised before writing: `proxy` via `normalizeProxy` (illegal input
becomes empty), `dshArgs` via `parseDshArgs` (drops `--port` and other non-whitelisted tokens),
booleans only accept `true` / `false`; `preventSleep` is written on macOS only. A changed
`npmRegistry` clears the registry cache and re-reads the latest version. Port, theme and
language keep their own `port:set` / `theme:set` / `lang:set` channels.

### Event `dsh:event`

`{ type: 'log' | 'state', line?, state? }` — a log line or a full state snapshot.

## UI language

Simplified Chinese and English, defaulting to the system locale (anything `zh` counts
as simplified).

- Resolution order: `settings.json` language → `app.getLocale()`; the result is
  exposed as `state.lang` and drives `renderer/i18n.js` (`t(key, params)`).
- Main-process messages live in `electron/i18n.mjs` (`mainT`) with the same `msg.*`
  keys as the renderer, so both sides stay in sync.
- Every confirmation and prompt is drawn in-app (`showModal`); no native `dialog`.
- The language button is the leftmost header action and shows `中文` / `EN`.
- Structured upgrade results (`plan.plugins[].detail`) are formatted by the renderer
  in the current language; the main process returns no baked-in Chinese reasons.
- Console output and commands stay verbatim (dsh / npm / pnpm output is not translated).

## Whale-girl animation

State → animation mapping (bundled assets):

| Animation | File | Trigger |
| --- | --- | --- |
| idle breathing | `idle` | not-installed |
| sleeping | `sleepy` | stopped |
| busy | `busy` | starting / stopping / restarting / installing / upgrading / uninstalling / takingover |
| floating steps | `running` | running |
| looking around | `look` | external |
| wave | `happy` | clicking the whale girl (2s, then back) |
| celebrate | `celebrate` | successful action (2.2s) |
| sigh | `sad` | failed action (2.2s) |

Two `<video>` layers cross-fade so state changes never flash black; the static image
stays visible until the first frame is decoded. Under
`prefers-reduced-motion: reduce` only the static image is shown and no video is
loaded. Videos are VP9 with alpha (640×360) cropped into an 86×86 area.

## Settings sheet and updates

- The header holds four icon-only buttons, always in this order: language, theme, settings,
  quit. No text labels, so the bar stays one row at 468px; the meaning lives in `title` and
  `aria-label` (e.g. "Switch theme · Light"). The theme icon shows the theme it switches to, and
  the language icon is always the "文A" glyph pair — never `EN` / `中文` text, never a globe.
- Language and theme icons toggle on click and share one state with the settings sheet, where
  segmented controls target a value directly.
- "Settings" is an in-app panel reworked from the old About dialog: app icon, name, version,
  then a single developer line (👤 Martin · ✉ email · GitHub · website, 10.5px, clickable,
  never wrapped), three groups of settings, and a "Buy me a coffee" button at the bottom.
  Licence and commercial-licensing copy are no longer shown.
- Settings groups (fixed order):
  - **General**: launch at login, DSH port, open the browser after start, system tray icon, Dock icon, prevent idle sleep, theme, language.
  - **Network**: npm registry (auto / official / mirror), HTTP(S) proxy, extra DSH arguments.
  - **Privacy & updates**: anonymous launch report, daily update check, manual check button.
- The port has exactly one entry point: the "DSH port" row in the sheet. The main window shows it
  read-only (a `span`, no longer a button); the field is locked with a note while DSH is running or
  an external instance is detected.
- Launch at login: a custom `role="switch"` button backed by `app.setLoginItemSettings`.
  Installed macOS / Windows builds only; Linux and development mode disable it with a note.
- Open the browser after start: off by default. When off, `--no-open` is appended to the launch
  command; when on, DSH opens the browser itself.
- System tray / menu-bar icon: on by default, switchable off from the sheet (switching off destroys
  the icon instead of leaving a gap). The menu holds "Show main window" and "Quit" only; quitting
  still goes through the in-app confirmation sheet, and the tooltip plus menu labels follow the
  language switch.
  - **macOS uses a monochrome template image** — `renderer/assets/trayTemplate.png` at 18pt plus the
    matching `@2x` at 36pt, both rasterised from one drawing, with `setTemplateImage(true)` so the
    system tints it for a light or dark menu bar. The artwork is DSH's own whale mark (`FISH_LOGO_PATH`
    from `@deepseek-ai/dsh-client-ui-primitives`, viewBox 23.16×17.04) — not a hand-drawn glyph, and
    never the colour app icon `.resize()`d: an illustration at 16–18px turns into a smear, and
    `resize()` also drops the `@2x` representation and leaves a 1x bitmap to be upscaled on Retina.
    `nativeImage.createFromPath()` picks up the `@2x` sibling automatically, so no scaling happens here.
  - **Windows / Linux keep the colour icon** (`app-icon.png` downscaled to 16px).
  - **One click returns to the main window** on every platform, and `double-click` is deliberately not
    bound. On macOS an attached `setContextMenu` menu pops on *any* click and swallows that first
    click, so the menu is pushed with `popUpContextMenu` on the right button only and the left click
    stays with `click` -> restore the window.
- Dock icon (macOS only): **off by default** — the launcher lives in the menu bar and keeps the Dock
  free; on Windows / Linux the row is not rendered at all (`row[hidden]`, out of the tab order). The switch calls
  `app.dock.hide()` / `show()`, compares against `isVisible()` first and re-checks 1.1s later, because
  Electron documents `dock.hide()` as a no-op when another call happened within a second (otherwise a
  quick double-toggle leaves the Dock out of sync with the setting). With the Dock hidden macOS treats
  the process as an accessory app (`lsappinfo` reports `type="UIElement"`), so restoring the window
  from the menu bar also calls `app.focus({ steal: true })`; with both the tray and the Dock off, the
  app is still reachable by reopening it from Finder — the second instance brings the window back.
- npm registry: `auto` keeps the original two-registry speed test; `official` / `mirror` pin one and
  skip the test. Switching clears the registry cache and re-reads the latest version.
- HTTP(S) proxy: written only into the npm / DSH child environment (`HTTP_PROXY`, `HTTPS_PROXY`,
  `ALL_PROXY`, `NO_PROXY`); the app's own version and update requests stay direct (stated in the UI).
- Proxy normalisation: `host:port` and `http(s)://host:port` are accepted; any other scheme (socks)
  is refused; a single-label host (`http`, `proxy` — usually a half-typed value) must carry an
  explicit port, while IPv4 / dotted names / localhost / IPv6 may omit it; the port must be 1–65535.
- Prevent idle sleep (macOS only): **on by default** — the launch is wrapped in `caffeinate -i`,
  so idle sleep (short of closing the lid) no longer interrupts a running session. On Windows /
  Linux the row is not rendered at all: a switch that can never be flipped is noise.
  The value is read when DSH is spawned, so a toggle is written immediately and, when an
  app-managed DSH is running, the main process answers `restartRequired: true`; the sheet then
  raises the in-app confirm dialog — "Restart now" runs `dsh:restart` (stop → start, status
  `restarting`), while cancelling keeps nothing: `preventSleep` is rolled back and focus returns
  to the switch. With DSH stopped the value is saved silently and applies on the next start.
- An invalid proxy never overwrites a working one: `settings:set` answers
  `ok:false, invalid:'proxy'`, the field is highlighted and the typed text is kept, instead of the
  earlier behaviour that normalised it to an empty string and silently cleared the stored proxy.
- The proxy does not hot-apply to a running DSH (it is injected when the child is spawned), so the
  row says "restart DSH to apply" after saving.
- Extra DSH arguments: split on whitespace, every token checked against a flag/value whitelist and
  never passed to a shell; `--port` / `-p` are dropped because the port setting owns that, and the
  dropped tokens are shown inline.
- Launch reporting and the daily update check have separate switches: the first covers `/api/ping`,
  the second the once-a-day `/api/release`; the manual check always works. The
  `DSH_READY_NO_TELEMETRY=1` environment variable remains the hard kill switch.
- Every control is custom-drawn (button + `aria-checked`, styled text fields); native `select`,
  `checkbox` and browser dialogs are never used.
- Focus rings only appear for keyboard input: after a tray click brings the window back, Chromium
  restores focus to the header icon that was clicked last and paints its `:focus-visible` ring, which
  reads as the language button lighting up on its own. The renderer tracks the input modality —
  `keydown` marks keyboard, `pointerdown` marks pointer — and on a window `focus` in pointer modality
  it blurs whatever holds focus inside `.bar`; fields elsewhere keep their focus, and keyboard
  navigation still shows rings. `scripts/probe-focus-ring.mjs` pins this behaviour over CDP
  (pointer refocus -> focus returns to `body`, keyboard refocus -> the button keeps focus).
- All external links go through the main process (`app:open-external`) with an allowlist of the
  site, the repository, the developer profile, the developer email, and the two exact Node.js
  download paths (`/zh-cn/download`, `/en/download`).
- A newer version opens an in-app confirm dialog, then the system browser on the download page.
- The sheet is 400px wide with `max-height: calc(100vh - 44px)` and scrolls internally, so the
  window keeps its size.

## Platforms and builds

macOS Apple Silicon (arm64), macOS Intel (x64) and Windows (x64).

| Artifact | Command | Notes |
| --- | --- | --- |
| `dsh-ready-1.0.16-arm64.dmg` | `npm run dist:mac:arm64` | Apple Silicon |
| `dsh-ready-1.0.16-x64.dmg` | `npm run dist:mac:x64` | Intel; cross-builds on Apple Silicon |
| `dsh-ready-1.0.16-x64.exe` | `npm run dist:win` | NSIS; cross-builds on Apple Silicon |

- Cross-builds download the matching Electron build; Intel/Windows packaging works on
  an Apple Silicon Mac without Wine.
- macOS builds are **ad-hoc signed in an `afterPack` hook** (`codesign --deep --force
  --sign -`, with electron-builder's `identity` left null), which Apple Silicon
  requires. They are not notarized, so a quarantined copy is still blocked once by
  Gatekeeper: allow it in System Settings → Privacy & Security, or clear it with
  `xattr -cr` when macOS claims the app is damaged.
- On Apple Silicon without Rosetta, the legacy NSIS bundle is an x86_64 `makensis` and
  cannot run, so `electron-builder.config.mjs` pins `toolsets.nsis = '1.2.1'`
  (unified bundle with a native arm64 entrypoint).
- All three platforms only detect Node/npm in the user's environment and never install
  or modify them. A missing or unsupported runtime shows the localized official Node.js download link.
- All three platforms share `electron/` and `renderer/`; platform differences are:

| Capability | macOS | Windows |
| --- | --- | --- |
| Detect external instance | `ps` + `lsof` | `netstat -ano`, `powershell Get-CimInstance` |
| Stop instance | process group SIGTERM, then SIGKILL | `taskkill /PID <pid> /T /F` |
| Plugin upgrades | pnpm | pnpm.cmd |

## Logging and monitoring

- dsh output is written line by line to `<userData>/logs/dsh.log`; the file rotates to
  `dsh.log.1` at 5 MB.
- An in-memory ring buffer keeps the last 2000 lines; the UI renders at most 600.
- Install, upgrade, uninstall and Node installation share the same log channel.
- Upgrade checks log the number of plugins inspected and the verdict; execution logs
  every command, exit code and plugin result.
- Start, ready, stop, crash and start-timeout each write an explicit line so a
  non-developer can tell where it failed.
- External detection polls every 4 seconds and only pushes real changes; a failed
  probe keeps the previous result.
- Hiding the window logs how to restore it and where the real quit button is.
- Startup logs the shell-environment result (variable count, elapsed time, proxy
  presence) plus the node and npm versions — including when either is missing —
  without printing any variable value.

## Website (dsh.wordtk.com)

- **Static first.** `site/public` holds the HTML/CSS/JS and images; the asset layer
  answers those requests without a Worker invocation. Only `/api/*` runs
  `src/index.js`.
- **One theme.** The site lives in the whale-blue palette and has no light/dark
  toggle: a second palette dilutes the "one lamp in the deep sea" look.
- **Downloads.** `/api/release` exposes the R2 manifest (version, sizes, URLs);
  `/api/download?arch=` streams the object with Range support so the browser can
  fetch 8 chunks in parallel and show real progress.
- **Anonymous counts.** `/api/visit` stores a random device id, the UTC date, the page
  path and Cloudflare's coarse geo. KV deduplicates a device per day, so reloads do
  not inflate UV and D1 writes stay cheap. `/api/stats` returns aggregates only.
- **Data model.** `ready_launches` in the `common` D1 database (device id, UTC date,
  version, country/region/city), the `dsh-ready/` key prefix in the `common` R2
  bucket, and the `common` KV namespace for the release-manifest cache.
- **App-only statistics.** The website never reports page views or downloads. The
  desktop app sends one anonymous launch signal (`/api/ping`) and the stats page is
  built from those rows only: totals, a world map with city detail, and a 14-day chart.

## Open items

- The Windows installer is packaged and inspected on macOS (PE x86-64, asar, NSIS
  output) but the start/stop/upgrade flow has not been exercised on real Windows.
- Windows does not read the login shell environment; it inherits the system
  environment.
- Reading the shell environment relies on `$SHELL -ilc` (100–400 ms on this machine);
  `DSH_READY_SKIP_SHELL_ENV=1` skips it.
- The whale-girl illustration is provided by the project author and should be
  replaced with owned or licensed artwork before redistribution beyond this project.
- A busy port is reported, never auto-shifted, so the address on screen is real.
