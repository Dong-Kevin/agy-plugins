# agy-plugins ROADMAP

更新时间：2026-11-14 15:21（Asia/Shanghai）。

## 本次交付目标

1. 发布 `v2026.11.14.4` 守护进程 PID 复用防护与升级边界加固版（`agy-finder v0.2.6` / `context-viewer v1.7.6`）：
   - 修复状态文件（`drawer_state.json` / `float_window_state.json`）中的 PID 在守护进程异常退出后被系统复用于无关进程时，`quit`、热升级与 `--uninstall` 误发 `SIGUSR1`、`SIGTERM` 或 `SIGKILL` 的风险。
   - 修复 `install.sh` / `install.ps1` 升级旧版本时调用 `$TARGET_DIR` 旧版 `cli.mjs` 导致新版进程身份校验被绕过的升级边界问题；同步加固独立 `--uninstall` / `-Uninstall` 的进程身份门禁。

## 当前阶段与状态

- **已完成（`v2026.11.14.4` 发布就绪）**：
  - **版本矩阵（`agy-finder v0.2.6` / `context-viewer v1.7.6`）**：
    - 同步更新两插件 `plugin.json`、[plugins/agy-context-viewer/sidecars/dashboard/index.html](./plugins/agy-context-viewer/sidecars/dashboard/index.html) 静态资源版本参数、[plugins/agy-context-viewer/sidecars/dashboard/cli.mjs](./plugins/agy-context-viewer/sidecars/dashboard/cli.mjs) 兜底版本号，以及根目录与两插件各自中英文 README（保持 `v2026.11.14.2` 对端锁协议兼容下限 `>= 0.2.4` / `>= 1.7.4`）。
  - **双插件守护进程 PID 身份核验（向后兼容 `<= 0.2.5` / `<= 1.7.5` 旧守护进程）**：
    - [plugins/agy-finder/sidecars/tree/drawer.mjs](./plugins/agy-finder/sidecars/tree/drawer.mjs) 与 [plugins/agy-context-viewer/sidecars/dashboard/float_window.mjs](./plugins/agy-context-viewer/sidecars/dashboard/float_window.mjs) 新增跨平台命令行身份校验（macOS / POSIX `LC_ALL=C ps -ww -p <pid> -o args=`、Linux `/proc/<pid>/cmdline` 兜底、Windows `Win32_Process` `CommandLine`）及 `verifyDaemonProcessIdentity()`、`inspectDrawerState()` / `inspectFloatState()`、`clearStateIfPidMatches()`；仅核验 `sidecars/tree/drawer.mjs --daemon` 或 `sidecars/dashboard/float_window.mjs --daemon` 并排除 `-e` / `--eval` / `--print` / `-p`（不依赖 `daemonBuildId`，确保真实旧版守护进程可被平滑退出）。
    - 将 `action === 'quit'` 前置于 `readDrawerState()` / `readFloatState()` 清理之前，并在发送 `SIGUSR1`、`SIGTERM` 与 `SIGKILL` 前二次核验 PID 身份：`dead` / `mismatch` 自动清理陈旧状态文件且严禁发信号；`unknown`（无法读取命令行）跳过信号、保留状态文件并由 [plugins/agy-finder/sidecars/tree/cli.mjs](./plugins/agy-finder/sidecars/tree/cli.mjs) 与 [plugins/agy-context-viewer/sidecars/dashboard/cli.mjs](./plugins/agy-context-viewer/sidecars/dashboard/cli.mjs) 向 `stderr` 输出 `[WARN]`。
  - **安装器预退出边界与独立卸载门禁**：
    - [plugins/agy-finder/install.sh](./plugins/agy-finder/install.sh)、[plugins/agy-context-viewer/install.sh](./plugins/agy-context-viewer/install.sh)、[plugins/agy-finder/install.ps1](./plugins/agy-finder/install.ps1) 与 [plugins/agy-context-viewer/install.ps1](./plugins/agy-context-viewer/install.ps1) 在非隔离升级覆盖目标目录前改为调用暂存/源码目录中的新版 `cli.mjs` 退出旧守护进程，杜绝执行已装目录内旧版 `<= 0.2.5` / `<= 1.7.5` 的无校验退出逻辑。
    - 独立 `--uninstall` / `-Uninstall`（无本地源码目录，如 `curl ... | bash`）在调用已装 `cli.mjs` 前先核验状态文件中的 PID 身份，匹配才执行旧 `cli.mjs` 退出，不匹配仅清理陈旧状态文件，未知时跳过信号并输出 `[WARN]`。
  - **正式回归测试**：
    - [scripts/verify.mjs](./scripts/verify.mjs) 新增 `verifyDaemonQuitAndUpgradePidSafety()` 跨双插件回归套件，覆盖缺失与死 PID 状态、复用 PID 无误杀、`install.sh` 升级走 `$STAGE_DIR`（在目标目录植入模拟旧版盲杀脚本验证不被调用）、独立 `bash -s -- --uninstall` 拦截、真实路径旧版 `--daemon` 正常退出及 `AGY_TEST_PID_IDENTITY_MODE=unknown` `[WARN]` 保活。
    - [plugins/agy-context-viewer/scripts/verify.mjs](./plugins/agy-context-viewer/scripts/verify.mjs) 更新 `6c` / `6d` 模拟守护进程脚本路径为 `sidecars/dashboard/float_window.mjs --daemon` 以匹配新身份核验。
  - **本机已安装环境热升级实测**：执行 `./install.sh` 将 `~/.gemini/config/plugins/` 热升级至 `agy-finder 0.2.6` 与 `context-viewer 1.7.6`（全程无 `[WARN]`，两插件旧版后台守护进程均经新版暂存 CLI 身份核验平滑退出并拉起新实例，保留已有快捷键与菜单栏“速度与耗时”模式配置）。
- **历史基线**：
  - `v2026.11.14.3`（`c5d1c80`）：`agy-finder v0.2.5` / `context-viewer v1.7.5`（补充双插件共存升级说明、单插件低版本对端只读 `[WARN]`、`AGY_INSTALL_BATCH` 批次透传与 6 阶段 `SIGKILL` 崩溃恢复校验）。
  - `v2026.11.14.2`（`a365456`）：`agy-finder v0.2.4` / `context-viewer v1.7.4`（修复同代 Bakery 协议下并发回收旧锁的 TOCTOU 竞态及 `agy-finder` 切换工作区旧搜索结果残留；注：双插件共存时须双端均升级至 `>= 0.2.4` / `>= 1.7.4` 且旧守护与宿主 Sidecar 实例退出/重载后方完全生效）。
  - `v2026.11.14.1`（`b6e5b81`）：`agy-finder v0.2.3` / `context-viewer v1.7.3`（闭合共享触发锁超时 fail-closed 与常驻活锁不抢占边界，并修复符号链接工作区相对路径、展开目录轮转同步与自动跟随切会话竞态）。
  - `v2026.11.14`（`f74753e`）：`agy-finder v0.2.2` / `context-viewer v1.7.2`；`v2026.11.13`：`agy-finder v0.2.1` / `context-viewer v1.7.1`。
- **跨平台与未实测项**：
  - Windows PowerShell 5.1 / 7（本机无 `pwsh`，本次 `.ps1` 改动待目标系统实机验收）、Linux 桌面端、`Node.js 18` 最低版本及真实桌面端宿主复用/侧栏交互尚未在对应宿主机实机验收。

## 关键入口

- 仓库总览：[README.md](./README.md) / [README_EN.md](./README_EN.md)
- 开发与发布约束：[AGENTS.md](./AGENTS.md)
- 统一安装脚本：[install.sh](./install.sh) / [install.ps1](./install.ps1)
- 全仓校验与打包：[scripts/verify.mjs](./scripts/verify.mjs) / [scripts/package-all.mjs](./scripts/package-all.mjs)
- 已迁移插件：[plugins/agy-finder](./plugins/agy-finder) 、[plugins/agy-context-viewer](./plugins/agy-context-viewer)

## 最近验证

- `./install.sh` + 本机已安装实测：通过，热升级 `~/.gemini/config/plugins/` 至 `agy-finder 0.2.6` 与 `context-viewer 1.7.6`（全程无 `[WARN]`，两插件旧守护平滑退出并重启为新实例，保留已有快捷键与菜单栏“速度与耗时”模式），`~/.local/bin/agy-finder status --json`（`daemonRunning: true`）与 `~/.local/bin/agy-context float status --json`（`daemonRunning: true`）均正常，时间：`2026-11-14 15:21`（Asia/Shanghai）。
- `node scripts/verify.mjs --strict-git-identity`：通过（含 `v0.2.6` / `v1.7.6` 双插件自检、`V1` 守护进程 PID 身份校验 / PID 复用不误杀 / `STAGE_DIR` 升级边界 / 独立 `--uninstall` 门禁 / `unknown` `[WARN]` 回归测试、`U1` 6 阶段 `SIGKILL` 崩溃恢复与单插件低版本 `[WARN]` 测试、隐私扫描与 Git noreply 身份门禁及 Swift `-typecheck`），时间：`2026-11-14 15:21`（Asia/Shanghai）。
- `RELEASE_REF=v2026.11.14.4 LC_ALL=C node scripts/package-all.mjs && (cd dist && ls -lh agy-finder-v0.2.6.zip context-viewer-v1.7.6.zip && unzip -t agy-finder-v0.2.6.zip && unzip -t context-viewer-v1.7.6.zip && LC_ALL=C shasum -a 256 -c agy-finder-v0.2.6.zip.sha256 context-viewer-v1.7.6.zip.sha256)`：通过，生成 `dist/agy-finder-v0.2.6.zip`（89.9 KB，20 个文件）与 `dist/context-viewer-v1.7.6.zip`（173.5 KB，20 个文件），ZIP 完整性与 SHA-256 校验均 `OK`，时间：`2026-11-14 15:21`（Asia/Shanghai）。
