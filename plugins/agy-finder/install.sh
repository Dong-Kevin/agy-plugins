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
  if [[ -z "$ORIG_PLUGINS_DIR" ]] && command -v node >/dev/null 2>&1; then
    if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/sidecars/tree/cli.mjs" ]]; then
      node "${SCRIPT_DIR}/sidecars/tree/cli.mjs" quit >/dev/null || true
    elif [[ -f "$TARGET_DIR/sidecars/tree/cli.mjs" ]]; then
      node -e '
        const fs = require("node:fs");
        const path = require("node:path");
        const os = require("node:os");
        const { execFileSync } = require("node:child_process");
        const cliPath = process.argv[1];
        const dataDir = process.env.AGY_FINDER_DATA_DIR || process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || path.join(os.homedir(), ".gemini", "antigravity", "sidecar_data", "agy-finder", "tree", "data");
        const statePath = path.join(dataDir, "drawer_state.json");
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
          console.error(`[WARN] [agy-finder] 无法核实后台进程身份（PID ${pid}），已跳过发送退出信号；请手动确认进程状态。`);
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
            console.error(`[WARN] [agy-finder] 无法核实后台进程身份（PID ${pid}），已跳过发送退出信号；请手动确认进程状态。`);
          }
          process.exit(0);
        }
        const norm = cmdLine.replace(/\\/g, "/");
        const isDaemon = norm.includes("sidecars/tree/drawer.mjs") && /(?:^|\s)--daemon(?:\s|$)/.test(norm) && !/(?:^|\s)(?:-e|--eval|--print|-p)(?:=|\s|$)/.test(norm);
        if (!isDaemon) {
          try { fs.rmSync(statePath, { force: true }); } catch {}
          process.exit(0);
        }
        try { execFileSync(process.execPath, [cliPath, "quit"], { stdio: ["ignore", "ignore", "inherit"] }); } catch {}
      ' "$TARGET_DIR/sidecars/tree/cli.mjs" || true
    fi
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

if [[ -z "$ORIG_PLUGINS_DIR" ]] && [[ -d "$TARGET_DIR" ]]; then
  chmod +x "$STAGE_DIR/sidecars/tree/cli.mjs"
  node "$STAGE_DIR/sidecars/tree/cli.mjs" quit >/dev/null || true
fi

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

if [[ -z "$ORIG_PLUGINS_DIR" ]] && [[ "$(uname -s)" == "Darwin" ]] && /usr/bin/swiftc -version >/dev/null 2>&1; then
  node "$TARGET_DIR/sidecars/tree/cli.mjs" --ensure-hotkey >/dev/null 2>&1 || true
fi

if [[ -z "$ORIG_PLUGINS_DIR" ]] && command -v agy >/dev/null 2>&1; then
  agy plugin enable agy-finder >/dev/null 2>&1 || true
fi

echo "[agy-finder] 安装完成：$TARGET_DIR"
echo "插件已自动加载并启用（可在 Customizations -> Installed 管理）：按 ⌘⇧E 开关独立抽屉，按 ⌥⌘E 直达 AGY 右侧辅助栏目录树，或运行 agy-finder aux / agy-finder --help。"

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
' "$PLUGINS_DIR/context-viewer/plugin.json" "1.7.4" "${AGY_INSTALL_BATCH:-}" "agy-context-viewer" "context-viewer")" || true
if [[ -n "$OUTDATED_PEER_VER" ]]; then
  echo "[WARN] [agy-finder] 检测到同机已安装的 context-viewer 版本为 v${OUTDATED_PEER_VER}（低于共享触发锁协议所需的 v1.7.4）。请同步升级 context-viewer（例如在总仓运行 ./install.sh）并重载宿主或重启旧后台实例，以避免旧版锁回收竞争。"
fi
