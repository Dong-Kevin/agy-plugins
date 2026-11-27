#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  CANDIDATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -f "${CANDIDATE_DIR}/plugin.json" && -f "${CANDIDATE_DIR}/bin/agy-hud.mjs" ]]; then
    SCRIPT_DIR="${CANDIDATE_DIR}"
  fi
fi

ORIG_PLUGINS_DIR="${AGY_PLUGINS_DIR:-${ANTIGRAVITY_PLUGINS_DIR:-}}"
PLUGINS_DIR="${ORIG_PLUGINS_DIR:-$HOME/.gemini/config/plugins}"
TARGET_DIR="$PLUGINS_DIR/agy-cli-hud"
BIN_DIR="${AGY_BIN_DIR:-${ANTIGRAVITY_BIN_DIR:-$HOME/.local/bin}}"
REPO_SLUG="${REPO:-Dong-Kevin/agy-plugins}"
GIT_REF="${REF:-main}"

if [[ "${1:-}" == "--uninstall" || "${1:-}" == "uninstall" ]]; then
  if [[ -z "$ORIG_PLUGINS_DIR" ]] && command -v node >/dev/null 2>&1; then
    if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/bin/agy-hud.mjs" ]]; then
      node "${SCRIPT_DIR}/bin/agy-hud.mjs" colab snipe --stop >/dev/null 2>&1 || true
    elif [[ -f "$TARGET_DIR/bin/agy-hud.mjs" ]]; then
      node "$TARGET_DIR/bin/agy-hud.mjs" colab snipe --stop >/dev/null 2>&1 || true
    fi
  fi
  if [[ -L "$BIN_DIR/agy-hud" ]] && ([[ -n "${AGY_BIN_DIR:-}${ANTIGRAVITY_BIN_DIR:-}" ]] || [[ -z "$ORIG_PLUGINS_DIR" ]]); then
    LINK_TARGET="$(readlink "$BIN_DIR/agy-hud" || true)"
    if [[ "$LINK_TARGET" == "$TARGET_DIR"* ]]; then
      rm -f "$BIN_DIR/agy-hud"
    fi
  fi
  if [[ -d "$TARGET_DIR" ]]; then
    rm -rf "$TARGET_DIR"
    echo "[agy-cli-hud] 已卸载：$TARGET_DIR"
  else
    echo "[agy-cli-hud] 未找到安装目录：$TARGET_DIR"
  fi
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[agy-cli-hud] 未检测到 Node.js，请先安装 Node.js >= 18。" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [[ "${NODE_MAJOR}" -lt 18 ]]; then
  echo "[agy-cli-hud] 当前 Node.js 主版本为 ${NODE_MAJOR}，需要 Node.js >= 18。" >&2
  exit 1
fi

TMP_WORK_DIR=""
STAGE_DIR=""
cleanup() {
  if [[ -n "${TMP_WORK_DIR}" && -d "${TMP_WORK_DIR}" ]]; then
    rm -rf "${TMP_WORK_DIR}"
  fi
  if [[ -n "${STAGE_DIR}" && -d "${STAGE_DIR}" ]]; then
    rm -rf "${STAGE_DIR}"
  fi
}
trap cleanup EXIT

if [[ -z "${SCRIPT_DIR}" ]]; then
  command -v curl >/dev/null 2>&1 || { echo "[agy-cli-hud] 远程下载需要 curl。" >&2; exit 1; }
  command -v tar >/dev/null 2>&1 || { echo "[agy-cli-hud] 解压归档需要 tar。" >&2; exit 1; }
  TMP_WORK_DIR="$(mktemp -d)"
  TARBALL_URL="https://codeload.github.com/${REPO_SLUG}/tar.gz/${GIT_REF}"
  echo "[agy-cli-hud] 正在从 GitHub 下载 ${REPO_SLUG} (${GIT_REF})..."
  curl -fsSL "${TARBALL_URL}" | tar -xz -C "${TMP_WORK_DIR}"
  FOUND_MANIFEST="$(find "${TMP_WORK_DIR}" -path "*/plugins/agy-cli-hud/plugin.json" -print -quit)"
  if [[ -z "${FOUND_MANIFEST}" ]]; then
    FOUND_MANIFEST="$(find "${TMP_WORK_DIR}" -path "*/agy-cli-hud/plugin.json" -print -quit)"
  fi
  if [[ -z "${FOUND_MANIFEST}" ]]; then
    echo "[agy-cli-hud] 下载包中未找到 plugins/agy-cli-hud/plugin.json，请检查 REPO 与 REF。" >&2
    exit 1
  fi
  SCRIPT_DIR="$(dirname "${FOUND_MANIFEST}")"
fi

STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agy-cli-hud-stage.XXXXXX")"
mkdir -p "$STAGE_DIR/assets" "$STAGE_DIR/bin" "$STAGE_DIR/lib" "$STAGE_DIR/skills/agy-cli-hud"

cp "$SCRIPT_DIR/plugin.json" "$STAGE_DIR/plugin.json"
cp "$SCRIPT_DIR/package.json" "$STAGE_DIR/package.json"
[[ -f "$SCRIPT_DIR/README.md" ]] && cp "$SCRIPT_DIR/README.md" "$STAGE_DIR/README.md"
[[ -f "$SCRIPT_DIR/README_EN.md" ]] && cp "$SCRIPT_DIR/README_EN.md" "$STAGE_DIR/README_EN.md"
[[ -f "$SCRIPT_DIR/LICENSE" ]] && cp "$SCRIPT_DIR/LICENSE" "$STAGE_DIR/LICENSE"
cp "$SCRIPT_DIR/assets/logo.svg" "$STAGE_DIR/assets/logo.svg"
cp "$SCRIPT_DIR/skills/agy-cli-hud/SKILL.md" "$STAGE_DIR/skills/agy-cli-hud/SKILL.md"
cp "$SCRIPT_DIR/bin/agy-hud.mjs" "$STAGE_DIR/bin/agy-hud.mjs"
for f in paths.mjs pricing.mjs quota.mjs incremental.mjs sqlite_timing.mjs colab.mjs snapshot.mjs themes.mjs statusline.mjs; do
  cp "$SCRIPT_DIR/lib/$f" "$STAGE_DIR/lib/$f"
done

mkdir -p "$TARGET_DIR/assets" "$TARGET_DIR/bin" "$TARGET_DIR/lib" "$TARGET_DIR/skills/agy-cli-hud"
cp -f "$STAGE_DIR/package.json" "$TARGET_DIR/package.json"
[[ -f "$STAGE_DIR/README.md" ]] && cp -f "$STAGE_DIR/README.md" "$TARGET_DIR/README.md"
[[ -f "$STAGE_DIR/README_EN.md" ]] && cp -f "$STAGE_DIR/README_EN.md" "$TARGET_DIR/README_EN.md"
[[ -f "$STAGE_DIR/LICENSE" ]] && cp -f "$STAGE_DIR/LICENSE" "$TARGET_DIR/LICENSE"
cp -f "$STAGE_DIR/assets/logo.svg" "$TARGET_DIR/assets/logo.svg"
cp -f "$STAGE_DIR/skills/agy-cli-hud/SKILL.md" "$TARGET_DIR/skills/agy-cli-hud/SKILL.md"
cp -f "$STAGE_DIR/bin/agy-hud.mjs" "$TARGET_DIR/bin/agy-hud.mjs"
for f in paths.mjs pricing.mjs quota.mjs incremental.mjs sqlite_timing.mjs colab.mjs snapshot.mjs themes.mjs statusline.mjs; do
  cp -f "$STAGE_DIR/lib/$f" "$TARGET_DIR/lib/$f"
done
chmod +x "$TARGET_DIR/bin/agy-hud.mjs"

# Atomic plugin.json swap last
TMP_MANIFEST="$TARGET_DIR/.plugin.json.tmp.$$"
cp "$STAGE_DIR/plugin.json" "$TMP_MANIFEST"
mv -f "$TMP_MANIFEST" "$TARGET_DIR/plugin.json"

if [[ -n "${AGY_BIN_DIR:-}${ANTIGRAVITY_BIN_DIR:-}" ]] || [[ -z "$ORIG_PLUGINS_DIR" ]]; then
  mkdir -p "$BIN_DIR"
  ln -sf "$TARGET_DIR/bin/agy-hud.mjs" "$BIN_DIR/agy-hud"
  echo "[agy-cli-hud] CLI 已链接：$BIN_DIR/agy-hud"
fi

if [[ -z "$ORIG_PLUGINS_DIR" ]] && command -v agy >/dev/null 2>&1; then
  agy plugin enable agy-cli-hud >/dev/null 2>&1 || true
fi

echo "[agy-cli-hud] 安装完成：$TARGET_DIR"
echo "运行 agy-hud status 查看概览，或运行 agy-hud install-statusline --lines 2 启用输入栏下方分层状态栏。"
