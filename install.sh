#!/usr/bin/env bash
# Unified Installer / Updater / Uninstaller for Dong-Kevin/agy-plugins
# Usage:
#   ./install.sh                  # Install all plugins
#   ./install.sh --all            # Install all plugins
#   ./install.sh agy-finder       # Install a specific plugin (dir name or manifest name)
#   ./install.sh --list           # List available plugins
#   ./install.sh --uninstall      # Uninstall all plugins
#   ./install.sh --uninstall agy-finder
#
# Remote one-liner:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.sh)"
#   curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.sh | bash -s -- agy-finder

set -euo pipefail

REPO_SLUG="${REPO:-Dong-Kevin/agy-plugins}"
GIT_REF="${REF:-main}"

SCRIPT_ROOT=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  CANDIDATE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -d "${CANDIDATE_ROOT}/plugins" ]]; then
    SCRIPT_ROOT="${CANDIDATE_ROOT}"
  fi
fi

TMP_WORK_DIR=""
cleanup() {
  if [[ -n "${TMP_WORK_DIR}" && -d "${TMP_WORK_DIR}" ]]; then
    rm -rf "${TMP_WORK_DIR}"
  fi
}
trap cleanup EXIT

ensure_source_root() {
  if [[ -n "${SCRIPT_ROOT}" ]]; then
    return 0
  fi
  command -v curl >/dev/null 2>&1 || { echo "[agy-plugins] 远程下载需要 curl。" >&2; exit 1; }
  command -v tar >/dev/null 2>&1 || { echo "[agy-plugins] 解压归档需要 tar。" >&2; exit 1; }
  TMP_WORK_DIR="$(mktemp -d)"
  TARBALL_URL="https://codeload.github.com/${REPO_SLUG}/tar.gz/${GIT_REF}"
  echo "[agy-plugins] 正在从 GitHub 下载 ${REPO_SLUG} (${GIT_REF})..."
  curl -fsSL "${TARBALL_URL}" | tar -xz -C "${TMP_WORK_DIR}"
  FOUND_DIR="$(find "${TMP_WORK_DIR}" -mindepth 2 -maxdepth 2 -type d -name "plugins" -print -quit)"
  if [[ -z "${FOUND_DIR}" ]]; then
    echo "[agy-plugins] 下载包中未找到 plugins/ 目录，请检查 REPO 与 REF。" >&2
    exit 1
  fi
  SCRIPT_ROOT="$(dirname "${FOUND_DIR}")"
}

usage() {
  cat <<'EOF'
AGY Plugins 统一安装脚本

用法:
  ./install.sh                         安装仓库内全部插件
  ./install.sh --all                   安装仓库内全部插件
  ./install.sh <plugin...>             安装指定插件（支持目录名或 plugin.json 中的 name）
  ./install.sh --list                  列出仓库内全部插件
  ./install.sh --uninstall [plugin...] 卸载指定插件（不传插件名则卸载全部）
  ./install.sh --help                  显示帮助
EOF
}

UNINSTALL=0
LIST_ONLY=0
INSTALL_ALL=0
TARGETS=()

for arg in "$@"; do
  case "$arg" in
    -h|--help|help)
      usage
      exit 0
      ;;
    --list|list)
      LIST_ONLY=1
      ;;
    --uninstall|uninstall)
      UNINSTALL=1
      ;;
    --all|all)
      INSTALL_ALL=1
      ;;
    -*)
      echo "[agy-plugins] 未知参数：$arg" >&2
      usage >&2
      exit 1
      ;;
    *)
      TARGETS+=("$arg")
      ;;
  esac
done

ensure_source_root

if ! command -v node >/dev/null 2>&1; then
  echo "[agy-plugins] 未检测到 Node.js，请先安装 Node.js >= 18。" >&2
  exit 1
fi

discover_plugins() {
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const pluginsDir = path.join(process.argv[1], "plugins");
    for (const ent of fs.readdirSync(pluginsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!ent.isDirectory()) continue;
      const manifestPath = path.join(pluginsDir, ent.name, "plugin.json");
      const installerPath = path.join(pluginsDir, ent.name, "install.sh");
      if (!fs.existsSync(manifestPath) || !fs.existsSync(installerPath)) continue;
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      console.log([ent.name, m.name || ent.name, m.version || "0.0.0", m.displayName || m.name || ent.name].join("\t"));
    }
  ' "${SCRIPT_ROOT}"
}

PLUGIN_ROWS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && PLUGIN_ROWS+=("$line")
done < <(discover_plugins)

if [[ ${#PLUGIN_ROWS[@]} -eq 0 ]]; then
  echo "[agy-plugins] plugins/ 下未发现可安装插件。" >&2
  exit 1
fi

if [[ "$LIST_ONLY" -eq 1 ]]; then
  echo "可用插件列表："
  for row in "${PLUGIN_ROWS[@]}"; do
    IFS=$'\t' read -r dir_name pkg_name version display_name <<< "$row"
    printf "  - %-20s (name: %-16s v%-8s) %s\n" "$dir_name" "$pkg_name" "$version" "$display_name"
  done
  exit 0
fi

SELECTED_DIRS=()
if [[ ${#TARGETS[@]} -eq 0 || "$INSTALL_ALL" -eq 1 ]]; then
  for row in "${PLUGIN_ROWS[@]}"; do
    IFS=$'\t' read -r dir_name _ _ _ <<< "$row"
    SELECTED_DIRS+=("$dir_name")
  done
else
  for target in "${TARGETS[@]}"; do
    matched=""
    for row in "${PLUGIN_ROWS[@]}"; do
      IFS=$'\t' read -r dir_name pkg_name _ _ <<< "$row"
      if [[ "$target" == "$dir_name" || "$target" == "$pkg_name" ]]; then
        matched="$dir_name"
        break
      fi
    done
    if [[ -z "$matched" ]]; then
      echo "[agy-plugins] 未找到插件：$target（可运行 --list 查看可用列表）" >&2
      exit 1
    fi
    already=0
    for existing in "${SELECTED_DIRS[@]+"${SELECTED_DIRS[@]}"}"; do
      if [[ "$existing" == "$matched" ]]; then
        already=1
        break
      fi
    done
    if [[ "$already" -eq 0 ]]; then
      SELECTED_DIRS+=("$matched")
    fi
  done
fi

for dir_name in "${SELECTED_DIRS[@]}"; do
  installer="${SCRIPT_ROOT}/plugins/${dir_name}/install.sh"
  echo ""
  echo "=== [agy-plugins] 处理插件：${dir_name} ==="
  if [[ "$UNINSTALL" -eq 1 ]]; then
    bash "$installer" --uninstall
  else
    bash "$installer"
  fi
done
