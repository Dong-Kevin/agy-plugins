#!/usr/bin/env bash
# One-click Installer / Updater / Uninstaller for Antigravity Context & Token Viewer
# Compatible with both Antigravity Desktop App (agy App / IDE) and agy CLI on macOS & Linux.
#
# Local install:
#   ./install.sh
# Remote one-liner:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/plugins/agy-context-viewer/install.sh)"
# Uninstall:
#   ./install.sh --uninstall

set -euo pipefail

PLUGIN_DIR_NAME="context-viewer"
ORIG_PLUGINS_DIR="${ANTIGRAVITY_PLUGINS_DIR:-${AGY_PLUGINS_DIR:-}}"
PLUGINS_ROOT="${ORIG_PLUGINS_DIR:-${HOME}/.gemini/config/plugins}"
TARGET_DIR="${PLUGINS_ROOT}/${PLUGIN_DIR_NAME}"
ORIG_BIN_DIR="${ANTIGRAVITY_BIN_DIR:-${AGY_BIN_DIR:-}}"
BIN_DIR="${ORIG_BIN_DIR:-${HOME}/.local/bin}"
CLI_WRAPPER="${BIN_DIR}/agy-context"
REPO_SLUG="${REPO:-Dong-Kevin/agy-plugins}"
GIT_REF="${REF:-main}"

SCRIPT_SOURCE_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  CANDIDATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -f "${CANDIDATE_DIR}/plugin.json" && -d "${CANDIDATE_DIR}/sidecars/dashboard" ]]; then
    SCRIPT_SOURCE_DIR="${CANDIDATE_DIR}"
  fi
fi

info()  { printf "\033[1;36m[context-viewer]\033[0m %s\n" "$*"; }
ok()    { printf "\033[1;32m[context-viewer]\033[0m %s\n" "$*"; }
warn()  { printf "\033[1;33m[context-viewer]\033[0m %s\n" "$*"; }
err()   { printf "\033[1;31m[context-viewer]\033[0m %s\n" "$*" >&2; exit 1; }

if [[ "${1:-}" == "--uninstall" || "${1:-}" == "uninstall" ]]; then
  if [[ -z "${ORIG_PLUGINS_DIR}" ]] && command -v node >/dev/null 2>&1; then
    if [[ -n "${SCRIPT_SOURCE_DIR}" && -f "${SCRIPT_SOURCE_DIR}/sidecars/dashboard/cli.mjs" ]]; then
      node "${SCRIPT_SOURCE_DIR}/sidecars/dashboard/cli.mjs" float quit >/dev/null || true
    elif [[ -f "${TARGET_DIR}/sidecars/dashboard/cli.mjs" ]]; then
      node -e '
        const fs = require("node:fs");
        const path = require("node:path");
        const os = require("node:os");
        const { execFileSync } = require("node:child_process");
        const cliPath = process.argv[1];
        const agDir = process.env.AG_DIR || path.join(os.homedir(), ".gemini", "antigravity");
        const stateDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || path.join(agDir, "sidecar_data", "context-viewer", "dashboard", "data");
        const statePath = path.join(stateDir, "float_window_state.json");
        if (!fs.existsSync(statePath)) process.exit(0);
        let obj = null;
        try { obj = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch {}
        const pid = Number(obj && obj.pid);
        if (!Number.isInteger(pid) || pid <= 1) {
          try { fs.rmSync(statePath, { force: true }); } catch {}
          process.exit(0);
        }
        const alive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e && e.code === "EPERM"; } };
        try { process.kill(pid, 0); } catch (e) {
          try { fs.rmSync(statePath, { force: true }); } catch {}
          process.exit(0);
        }
        if (process.env.AGY_TEST_PID_IDENTITY_MODE === "unknown") {
          console.error(`[WARN] [context-viewer] 无法核实后台进程身份（PID ${pid}），已跳过发送退出信号；请手动确认进程状态。`);
          process.exit(0);
        }
        let cmdLine = "";
        if (process.platform === "linux") {
          try { cmdLine = fs.readFileSync(`/proc/${pid}/cmdline`).toString("utf8").replace(/\0+/g, " ").trim(); } catch {}
        }
        if (!cmdLine) {
          try {
            cmdLine = execFileSync("ps", ["-ww", "-p", String(pid), "-o", "args="], {
              env: { ...process.env, LC_ALL: "C" },
              encoding: "utf8",
              timeout: 1500,
              stdio: ["ignore", "pipe", "ignore"]
            }).trim();
          } catch {}
        }
        if (!cmdLine) {
          if (!alive(pid)) {
            try { fs.rmSync(statePath, { force: true }); } catch {}
          } else {
            console.error(`[WARN] [context-viewer] 无法核实后台进程身份（PID ${pid}），已跳过发送退出信号；请手动确认进程状态。`);
          }
          process.exit(0);
        }
        const norm = cmdLine.replace(/\\/g, "/");
        const isDaemon = norm.includes("sidecars/dashboard/float_window.mjs") && /(?:^|\s)--daemon(?:\s|$)/.test(norm) && !/(?:^|\s)(?:-e|--eval|--print|-p)(?:=|\s|$)/.test(norm);
        if (!isDaemon) {
          try { fs.rmSync(statePath, { force: true }); } catch {}
          process.exit(0);
        }
        try { execFileSync(process.execPath, [cliPath, "float", "quit"], { stdio: ["ignore", "ignore", "inherit"] }); } catch {}
      ' "${TARGET_DIR}/sidecars/dashboard/cli.mjs" || true
    fi
  fi
  if [[ -n "${ORIG_BIN_DIR}" || -z "${ORIG_PLUGINS_DIR}" ]] && [[ -L "${CLI_WRAPPER}" || -f "${CLI_WRAPPER}" ]]; then
    SHOULD_REMOVE_WRAPPER=false
    if [[ -L "${CLI_WRAPPER}" ]]; then
      LINK_TARGET="$(readlink "${CLI_WRAPPER}" || true)"
      [[ "${LINK_TARGET}" == "${TARGET_DIR}"* ]] && SHOULD_REMOVE_WRAPPER=true
    elif grep -Fq "${TARGET_DIR}/sidecars/dashboard/cli.mjs" "${CLI_WRAPPER}" 2>/dev/null; then
      SHOULD_REMOVE_WRAPPER=true
    fi
    if [[ "${SHOULD_REMOVE_WRAPPER}" == true ]]; then
      rm -f "${CLI_WRAPPER}"
      ok "已移除命令行入口：${CLI_WRAPPER}"
    fi
  fi
  if [[ -d "${TARGET_DIR}" ]]; then
    rm -rf "${TARGET_DIR}"
    ok "已移除插件目录：${TARGET_DIR}"
  else
    info "未检测到已安装目录：${TARGET_DIR}"
  fi
  info "用户本地会话归档与统计偏好设置已安全保留，未做删除。"
  exit 0
fi

# 1. Verify Node.js >= 18
if ! command -v node >/dev/null 2>&1; then
  err "未检测到 Node.js，请先安装 Node.js 18 或更高版本。"
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [[ "${NODE_MAJOR}" -lt 18 ]]; then
  err "当前 Node.js 主版本为 ${NODE_MAJOR}，需要 Node.js >= 18。"
fi

# 2. Resolve source directory (local checkout / extracted zip OR remote GitHub tarball)
TMP_WORK_DIR=""
STAGE_DIR=""
cleanup() {
  if [[ -n "${STAGE_DIR}" && -d "${STAGE_DIR}" ]]; then
    rm -rf "${STAGE_DIR}"
  fi
  if [[ -n "${TMP_WORK_DIR}" && -d "${TMP_WORK_DIR}" ]]; then
    rm -rf "${TMP_WORK_DIR}"
  fi
}
trap cleanup EXIT

if [[ -z "${SCRIPT_SOURCE_DIR}" ]]; then
  if [[ -z "${REPO_SLUG}" ]]; then
    err "远程一键安装请通过环境变量指定仓库，例如：REPO=\"Dong-Kevin/agy-plugins\" curl -fsSL .../plugins/agy-context-viewer/install.sh | bash"
  fi
  command -v curl >/dev/null 2>&1 || err "远程下载需要 curl。"
  command -v tar  >/dev/null 2>&1 || err "解压归档需要 tar。"

  TMP_WORK_DIR="$(mktemp -d)"
  TARBALL_URL="https://codeload.github.com/${REPO_SLUG}/tar.gz/${GIT_REF}"
  info "正在从 GitHub 下载 ${REPO_SLUG} (${GIT_REF})..."
  curl -fsSL "${TARBALL_URL}" | tar -xz -C "${TMP_WORK_DIR}"
  EXTRACTED_ROOT="$(find "${TMP_WORK_DIR}" -maxdepth 4 -path "*/plugins/agy-context-viewer/plugin.json" -print -quit)"
  if [[ -z "${EXTRACTED_ROOT}" ]]; then
    EXTRACTED_ROOT="$(find "${TMP_WORK_DIR}" -maxdepth 3 -path "*/context-viewer/plugin.json" -print -quit)"
  fi
  if [[ -z "${EXTRACTED_ROOT}" ]]; then
    EXTRACTED_ROOT="$(find "${TMP_WORK_DIR}" -mindepth 1 -maxdepth 2 -name "plugin.json" -print -quit)"
  fi
  [[ -n "${EXTRACTED_ROOT}" ]] || err "下载包中未找到 plugins/agy-context-viewer/plugin.json，请检查 REPO 与分支名。"
  SCRIPT_SOURCE_DIR="$(dirname "${EXTRACTED_ROOT}")"
fi

# 3. Stage in system temp (NEVER inside PLUGINS_ROOT, which SidecarManager scans live)
#    and sync in-place into TARGET_DIR so active sidecar working directory stays valid.
info "正在安装插件到 ${TARGET_DIR} ..."
mkdir -p "${PLUGINS_ROOT}"
rm -rf "${PLUGINS_ROOT}"/.context-viewer-stage.* 2>/dev/null || true

STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ag-context-viewer-stage.XXXXXX")"

cp "${SCRIPT_SOURCE_DIR}/plugin.json" "${STAGE_DIR}/plugin.json"
[[ -f "${SCRIPT_SOURCE_DIR}/README.md" ]] && cp "${SCRIPT_SOURCE_DIR}/README.md" "${STAGE_DIR}/README.md"
[[ -f "${SCRIPT_SOURCE_DIR}/LICENSE" ]]   && cp "${SCRIPT_SOURCE_DIR}/LICENSE" "${STAGE_DIR}/LICENSE"
cp -R "${SCRIPT_SOURCE_DIR}/assets" "${STAGE_DIR}/assets"
cp -R "${SCRIPT_SOURCE_DIR}/skills" "${STAGE_DIR}/skills"
mkdir -p "${STAGE_DIR}/sidecars/dashboard"
for f in sidecar.json package.json main.mjs collector.mjs pricing.mjs float_window.mjs native_float_macos.swift cli.mjs index.html styles.css app.js; do
  cp "${SCRIPT_SOURCE_DIR}/sidecars/dashboard/${f}" "${STAGE_DIR}/sidecars/dashboard/${f}"
done
chmod +x "${STAGE_DIR}/sidecars/dashboard/cli.mjs" "${STAGE_DIR}/sidecars/dashboard/float_window.mjs" "${STAGE_DIR}/skills/context-viewer/scripts/status.mjs"

if [[ -z "${ORIG_PLUGINS_DIR}" && -d "${TARGET_DIR}" ]]; then
  node "${STAGE_DIR}/sidecars/dashboard/cli.mjs" float quit >/dev/null || true
fi

mkdir -p "${TARGET_DIR}/assets" "${TARGET_DIR}/skills" "${TARGET_DIR}/sidecars/dashboard"
chmod 755 "${TARGET_DIR}" "${TARGET_DIR}/sidecars" "${TARGET_DIR}/sidecars/dashboard"

cp -f "${STAGE_DIR}/plugin.json" "${TARGET_DIR}/plugin.json"
[[ -f "${STAGE_DIR}/README.md" ]] && cp -f "${STAGE_DIR}/README.md" "${TARGET_DIR}/README.md"
[[ -f "${STAGE_DIR}/LICENSE" ]]   && cp -f "${STAGE_DIR}/LICENSE" "${TARGET_DIR}/LICENSE"
rm -rf "${TARGET_DIR}/assets" && cp -R "${STAGE_DIR}/assets" "${TARGET_DIR}/assets"
rm -rf "${TARGET_DIR}/skills" && cp -R "${STAGE_DIR}/skills" "${TARGET_DIR}/skills"

# Copy runtime scripts first, then atomically replace sidecar.json last so SidecarManager reloads cleanly
for f in package.json pricing.mjs collector.mjs float_window.mjs native_float_macos.swift cli.mjs index.html styles.css app.js main.mjs; do
  cp -f "${STAGE_DIR}/sidecars/dashboard/${f}" "${TARGET_DIR}/sidecars/dashboard/${f}"
done
chmod +x "${TARGET_DIR}/sidecars/dashboard/cli.mjs" "${TARGET_DIR}/sidecars/dashboard/float_window.mjs" "${TARGET_DIR}/skills/context-viewer/scripts/status.mjs"
cp -f "${STAGE_DIR}/sidecars/dashboard/sidecar.json" "${TARGET_DIR}/sidecars/dashboard/.sidecar.json.tmp"
mv -f "${TARGET_DIR}/sidecars/dashboard/.sidecar.json.tmp" "${TARGET_DIR}/sidecars/dashboard/sidecar.json"

# Sync user's saved manifest & launch persistent macOS Menu Bar indicator if enabled
if [[ -z "${ORIG_PLUGINS_DIR}" ]]; then
  node "${TARGET_DIR}/sidecars/dashboard/cli.mjs" --sync-manifest >/dev/null 2>&1 || true
  if [[ "$(uname -s)" == "Darwin" ]]; then
    if /usr/bin/swiftc -version >/dev/null 2>&1; then
      node "${TARGET_DIR}/sidecars/dashboard/cli.mjs" --ensure-menubar >/dev/null 2>&1 || true
    else
      warn "未检测到可用的 Swift 编译器（Xcode Command Line Tools），macOS 原生菜单栏与置顶小窗暂未启用；可运行 xcode-select --install 后执行 agy-context menubar on 开启（宿主侧边栏与终端看板不受影响）。"
    fi
  fi
fi

# 4. Install `agy-context` CLI wrapper into ~/.local/bin (skip when isolated plugins dir is used without explicit BIN_DIR)
if [[ -n "${ORIG_BIN_DIR}" || -z "${ORIG_PLUGINS_DIR}" ]]; then
  mkdir -p "${BIN_DIR}"
  cat > "${CLI_WRAPPER}" <<EOF
#!/usr/bin/env bash
exec node "${TARGET_DIR}/sidecars/dashboard/cli.mjs" "\$@"
EOF
  chmod +x "${CLI_WRAPPER}"
fi

# 5. If `agy` CLI is installed, enable plugin via official CLI (never hand-edit config.json)
if [[ -z "${ORIG_PLUGINS_DIR}" ]] && command -v agy >/dev/null 2>&1; then
  agy plugin enable "${PLUGIN_DIR_NAME}" >/dev/null 2>&1 || true
fi

echo ""
ok "安装完成！版本：$(node -p 'require(process.argv[1]).version' "${TARGET_DIR}/plugin.json")"
echo ""
printf "  • \033[1mAntigravity 桌面端 / IDE\033[0m：\n"
printf "    1) 顶部菜单栏秒开（macOS 默认开启，切换会话自动跟随）：单击右上角图标秒开或收回看板，右键或用 \033[36magy-context menubar [context|speed|quota|off]\033[0m 定制显示内容；\n"
printf "    2) 双快捷键（零辅助功能权限，支持面板录制/CLI自定义）：宿主前台按 \033[36m⌥⌘K\033[0m 开关独立置顶小窗（\033[36magy-context float\033[0m / \033[36mshortcut\033[0m）；按 \033[36m⌃⌥K\033[0m 直达 AGY 右侧辅助栏看板（\033[36magy-context aux\033[0m / \033[36maux-shortcut\033[0m）；\n"
printf "    3) 内嵌侧边栏：在 Customizations → Plugins 开启「上下文与 Token 看板」，点击右侧栏图标或 \033[36msidecar://%s/dashboard/\033[0m 即可打开。\n\n" "${PLUGIN_DIR_NAME}"
printf "  • \033[1magy CLI / 终端用户\033[0m：\n"
printf "    1) 在 agy 对话中直接输入 \033[36m/context-viewer\033[0m 查看当前会话水位与费用；\n"
printf "    2) 在终端运行 \033[36magy-context\033[0m 查看彩色进度条看板，或运行 \033[36magy-context web\033[0m 在浏览器打开完整热力图面板。\n"
if [[ ":${PATH}:" != *":${BIN_DIR}:"* ]]; then
  warn "提示：${BIN_DIR} 当前不在 PATH 中，也可直接运行：node ${TARGET_DIR}/sidecars/dashboard/cli.mjs"
fi

OUTDATED_PEER_VER="$(node -e '
  const fs = require("node:fs");
  const [manifestPath, minVer, batchRaw, ...batchMatches] = process.argv.slice(1);
  const batch = new Set(String(batchRaw || "").split(",").map((s) => s.trim()).filter(Boolean));
  if (batchMatches.some((k) => batch.has(k)) || !fs.existsSync(manifestPath)) process.exit(0);
  try {
    const ver = String(JSON.parse(fs.readFileSync(manifestPath, "utf8")).version || "").trim();
    const parse = (v) => {
      const m = v.replace(/^v/i, "").split("+")[0].split("-")[0].split(".");
      if (m.length < 3) return null;
      const nums = m.slice(0, 3).map((x) => Number(x));
      return nums.every((n) => Number.isInteger(n) && n >= 0) ? nums : null;
    };
    const a = parse(ver), b = parse(minVer);
    if (!a || !b) process.exit(0);
    const lt = a[0] !== b[0] ? a[0] < b[0] : (a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2]);
    if (lt) process.stdout.write(ver.replace(/^v/i, ""));
  } catch {}
' "${PLUGINS_ROOT}/agy-finder/plugin.json" "0.2.4" "${AGY_INSTALL_BATCH:-}" "agy-finder")" || true
if [[ -n "${OUTDATED_PEER_VER}" ]]; then
  warn "[WARN] 检测到同机已安装的 agy-finder 版本为 v${OUTDATED_PEER_VER}（低于共享触发锁协议所需的 v0.2.4）。请同步升级 agy-finder（例如在总仓运行 ./install.sh）并重载宿主或重启旧后台实例，以避免旧版锁回收竞争。"
fi
