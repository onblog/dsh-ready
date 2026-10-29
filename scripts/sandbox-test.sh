#!/usr/bin/env bash
# Isolated test environment: its own DSH_HOME + its own app data directory, leaving the user's ~/.dsh, settings and logs untouched.
# Usage:
#   scripts/sandbox-test.sh            create the sandbox and launch the app (close the window manually when done)
#   scripts/sandbox-test.sh --destroy  destroy the sandbox
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SANDBOX="${DSH_SANDBOX_DIR:-/tmp/dsh-ready-sandbox}"
DSH_BIN="${DSH_BIN:-$(command -v dsh || true)}"
ELECTRON="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

if [[ "${1:-}" == "--destroy" ]]; then
  rm -rf "$SANDBOX"
  echo "沙箱已销毁：$SANDBOX"
  exit 0
fi

if [[ -z "$DSH_BIN" ]]; then
  echo "未找到 dsh 命令" >&2
  exit 1
fi

if [[ ! -x "$ELECTRON" ]]; then
  echo "未找到 Electron，请先 npm install" >&2
  exit 1
fi

if [[ ! -f "$SANDBOX/profiles/web/package.json" ]]; then
  rm -rf "$SANDBOX"
  mkdir -p "$SANDBOX"
  DSH_HOME="$SANDBOX" "$DSH_BIN" web --help >/dev/null
  echo "沙箱 profile 已生成：$SANDBOX/profiles/web"
fi

mkdir -p "$SANDBOX/appdata"
echo "沙箱 DSH_HOME：$SANDBOX"
echo "沙箱应用数据：$SANDBOX/appdata"
echo "用户数据不会被读写。"
exec env DSH_HOME="$SANDBOX" "$ELECTRON" --user-data-dir="$SANDBOX/appdata" "$ROOT" "$@"
