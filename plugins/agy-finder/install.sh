#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  CANDIDATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -f "${CANDIDATE_DIR}/plugin.json" && -d "${CANDIDATE_DIR}/sidecars/tree" ]]; then
    SCRIPT_DIR="${CANDIDATE_DIR}"
  fi
fi

ORIG_PLUGINS_DIR="${AGY_PLUGINS_DIR:-${ANTIGRAVITY_PLUGINS_DIR:-}}"
PLUGINS_DIR="${ORIG_PLUGINS_DIR:-$HOME/.gemini/config/plugins}"
TARGET_DIR="$PLUGINS_DIR/agy-finder"
BIN_DIR="${AGY_BIN_DIR:-${ANTIGRAVITY_BIN_DIR:-$HOME/.local/bin}}"
REPO_SLUG="${REPO:-Dong-Kevin/agy-plugins}"
GIT_REF="${REF:-main}"

if [[ "${1:-}" == "--uninstall" || "${1:-}" == "uninstall" ]]; then
  if [[ -z "$ORIG_PLUGINS_DIR" ]] && [[ -f "$TARGET_DIR/sidecars/tree/cli.mjs" ]] && command -v node >/dev/null 2>&1; then
    node "$TARGET_DIR/sidecars/tree/cli.mjs" quit >/dev/null 2>&1 || true
  fi
  if [[ -L "$BIN_DIR/agy-finder" ]] && ([[ -n "${AGY_BIN_DIR:-}${ANTIGRAVITY_BIN_DIR:-}" ]] || [[ -z "$ORIG_PLUGINS_DIR" ]]); then
    LINK_TARGET="$(readlink "$BIN_DIR/agy-finder" || true)"
    if [[ "$LINK_TARGET" == "$TARGET_DIR"* ]]; then
      rm -f "$BIN_DIR/agy-finder"
    fi
  fi
  if [[ -d "$TARGET_DIR" ]]; then
    rm -rf "$TARGET_DIR"
    echo "[agy-finder] 已卸载：$TARGET_DIR"
  else
    echo "[agy-finder] 未找到安装目录：$TARGET_DIR"
  fi
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[agy-finder] 未检测到 Node.js，请先安装 Node.js >= 18。" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [[ "${NODE_MAJOR}" -lt 18 ]]; then
  echo "[agy-finder] 当前 Node.js 主版本为 ${NODE_MAJOR}，需要 Node.js >= 18。" >&2
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
  command -v curl >/dev/null 2>&1 || { echo "[agy-finder] 远程下载需要 curl。" >&2; exit 1; }
  command -v tar >/dev/null 2>&1 || { echo "[agy-finder] 解压归档需要 tar。" >&2; exit 1; }
  TMP_WORK_DIR="$(mktemp -d)"
  TARBALL_URL="https://codeload.github.com/${REPO_SLUG}/tar.gz/${GIT_REF}"
  echo "[agy-finder] 正在从 GitHub 下载 ${REPO_SLUG} (${GIT_REF})..."
  curl -fsSL "${TARBALL_URL}" | tar -xz -C "${TMP_WORK_DIR}"
  FOUND_MANIFEST="$(find "${TMP_WORK_DIR}" -path "*/plugins/agy-finder/plugin.json" -print -quit)"
  if [[ -z "${FOUND_MANIFEST}" ]]; then
    FOUND_MANIFEST="$(find "${TMP_WORK_DIR}" -path "*/agy-finder/plugin.json" -print -quit)"
  fi
  if [[ -z "${FOUND_MANIFEST}" ]]; then
    FOUND_MANIFEST="$(find "${TMP_WORK_DIR}" -mindepth 1 -maxdepth 2 -name "plugin.json" -print -quit)"
  fi
  if [[ -z "${FOUND_MANIFEST}" ]]; then
    echo "[agy-finder] 下载包中未找到 plugins/agy-finder/plugin.json，请检查 REPO 与 REF。" >&2
    exit 1
  fi
  SCRIPT_DIR="$(dirname "${FOUND_MANIFEST}")"
fi

STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agy-finder-stage.XXXXXX")"
mkdir -p "$STAGE_DIR/assets" "$STAGE_DIR/rules" "$STAGE_DIR/skills/agy-finder" "$STAGE_DIR/sidecars/tree"

cp "$SCRIPT_DIR/plugin.json" "$STAGE_DIR/plugin.json"
[[ -f "$SCRIPT_DIR/README.md" ]] && cp "$SCRIPT_DIR/README.md" "$STAGE_DIR/README.md"
[[ -f "$SCRIPT_DIR/LICENSE" ]] && cp "$SCRIPT_DIR/LICENSE" "$STAGE_DIR/LICENSE"
cp "$SCRIPT_DIR/assets/logo.svg" "$STAGE_DIR/assets/logo.svg"
cp "$SCRIPT_DIR/rules/AGENTS.md" "$STAGE_DIR/rules/AGENTS.md"
cp "$SCRIPT_DIR/skills/agy-finder/SKILL.md" "$STAGE_DIR/skills/agy-finder/SKILL.md"

for f in package.json main.mjs path_utils.mjs mentions.mjs drawer.mjs cli.mjs native_drawer_macos.swift index.html styles.css app.js; do
  cp "$SCRIPT_DIR/sidecars/tree/$f" "$STAGE_DIR/sidecars/tree/$f"
done

mkdir -p "$TARGET_DIR/assets" "$TARGET_DIR/rules" "$TARGET_DIR/skills/agy-finder" "$TARGET_DIR/sidecars/tree"

cp -f "$STAGE_DIR/plugin.json" "$TARGET_DIR/plugin.json"
[[ -f "$STAGE_DIR/README.md" ]] && cp -f "$STAGE_DIR/README.md" "$TARGET_DIR/README.md"
[[ -f "$STAGE_DIR/LICENSE" ]] && cp -f "$STAGE_DIR/LICENSE" "$TARGET_DIR/LICENSE"
cp -f "$STAGE_DIR/assets/logo.svg" "$TARGET_DIR/assets/logo.svg"
cp -f "$STAGE_DIR/rules/AGENTS.md" "$TARGET_DIR/rules/AGENTS.md"
cp -f "$STAGE_DIR/skills/agy-finder/SKILL.md" "$TARGET_DIR/skills/agy-finder/SKILL.md"

for f in package.json main.mjs path_utils.mjs mentions.mjs drawer.mjs cli.mjs native_drawer_macos.swift index.html styles.css app.js; do
  cp -f "$STAGE_DIR/sidecars/tree/$f" "$TARGET_DIR/sidecars/tree/$f"
done
chmod +x "$TARGET_DIR/sidecars/tree/cli.mjs"

if [[ -n "${AGY_BIN_DIR:-}${ANTIGRAVITY_BIN_DIR:-}" ]] || [[ -z "$ORIG_PLUGINS_DIR" ]]; then
  mkdir -p "$BIN_DIR"
  ln -sf "$TARGET_DIR/sidecars/tree/cli.mjs" "$BIN_DIR/agy-finder"
  echo "[agy-finder] CLI 已链接：$BIN_DIR/agy-finder"
fi

# Write sidecar.json last via atomic mv so Antigravity reloads cleanly on upgrade
TMP_SIDECAR="$TARGET_DIR/sidecars/tree/.sidecar.json.tmp.$$"
cp "$SCRIPT_DIR/sidecars/tree/sidecar.json" "$TMP_SIDECAR"
mv -f "$TMP_SIDECAR" "$TARGET_DIR/sidecars/tree/sidecar.json"

if [[ -z "$ORIG_PLUGINS_DIR" ]] && command -v agy >/dev/null 2>&1; then
  agy plugin enable agy-finder >/dev/null 2>&1 || true
fi

echo "[agy-finder] 安装完成：$TARGET_DIR"
echo "插件已自动加载并启用，可在 Antigravity 的 Customizations -> Installed 中管理状态"
