# agy-plugins ROADMAP

更新时间：2026-11-14 19:25（Asia/Shanghai）。

## 本次交付目标

1. 发布 `v2026.11.14.5` 守护进程入口边界精确核验与文档校准版（`agy-finder v0.2.7` / `context-viewer v1.7.7`）：
   - 修复原 `includes('sidecars/...')` 子串匹配缺陷：要求同时核验运行时可执行文件名（`node` / `electron` / `antigravity`）、实际入口 `argv[1]` 精确结尾及紧随其后的 `argv[2] === '--daemon'` 参数边界，防止普通程序将守护脚本路径作为 `--input` 或位置数据参数传递时被误判终止。
   - 收紧两插件守护进程模块底部自启动守卫（校验 `argv[1]` 为当前脚本且 `argv[2] === '--daemon'`），统一独立 `--uninstall` / `-Uninstall` 卸载门禁，并客观校准中英文 README 的平台验证范围说明。

## 当前阶段与状态

- **已完成（`v2026.11.14.5` 发布就绪）**：
  - **版本矩阵（`agy-finder v0.2.7` / `context-viewer v1.7.7`）**：
    - 同步更新两插件 `plugin.json`、[plugins/agy-context-viewer/sidecars/dashboard/index.html](./plugins/agy-context-viewer/sidecars/dashboard/index.html) 静态资源版本参数、[plugins/agy-context-viewer/sidecars/dashboard/cli.mjs](./plugins/agy-context-viewer/sidecars/dashboard/cli.mjs) 兜底版本号，以及根目录与两插件各自中英文 README（保持 `>= 0.2.4` / `>= 1.7.4` 对端锁协议下限）。
    - 在根目录 [README.md](./README.md)、[README_EN.md](./README_EN.md) 与两插件中英文 README 客观校准平台验证范围：明确 `macOS` 已完成实机全量验证，Windows / Linux 基于跨平台标准库提供内嵌辅助栏、终端 CLI 与浏览器 `--app` 小窗回退（Windows PowerShell、Linux 桌面端与 `Node.js 18` 最低版本尚未在对应宿主机实机验收）。
  - **守护进程实际入口与参数边界核验**：
    - [plugins/agy-finder/sidecars/tree/drawer.mjs](./plugins/agy-finder/sidecars/tree/drawer.mjs) 与 [plugins/agy-context-viewer/sidecars/dashboard/float_window.mjs](./plugins/agy-context-viewer/sidecars/dashboard/float_window.mjs) 新增并导出 `tokenizeWindowsCommandLine()`、`evaluateStructuredDaemonArgv()` 与 `evaluatePsDaemonCommand()`：
      - Linux 直接按 `\0` 读取 `/proc/<pid>/cmdline` 还原结构化 `argv[]`；Windows 解析 `Win32_Process` `Name` + 带引号 `CommandLine`；macOS / POSIX 联用 `ps -ww -o comm=` 与 `ps -ww -o args=` 核对可执行文件名、精确入口结尾（兼容含空格路径）与紧邻 `--daemon` 参数（含 `4000ms` 超时与 3 次重试容错，避免并发重载或退出瞬间误报 `[WARN]`），无法消歧含空格路径时保守返回 `unknown`（严禁发信号）。
      - 收紧两模块底部 `isDirectDaemonEntry` 自启动守卫，避免外部脚本携带 `--daemon` 动态导入模块时误触发守护循环。
  - **独立卸载门禁统一**：
    - [plugins/agy-finder/install.sh](./plugins/agy-finder/install.sh) 与 [plugins/agy-context-viewer/install.sh](./plugins/agy-context-viewer/install.sh) 的独立 `--uninstall` 分支同步改用结构化 `argv` / `ps comm+args`（含重试与 `4000ms` 超时）入口核验。
    - [plugins/agy-finder/install.ps1](./plugins/agy-finder/install.ps1) 与 [plugins/agy-context-viewer/install.ps1](./plugins/agy-context-viewer/install.ps1) 的独立 `-Uninstall` 分支统一使用 `$VerifyJs`（`Win32_Process` + `tokenizeWindowsCommandLine` + `evaluateStructuredDaemonArgv`），与运行时守护核验保持同构，并在全仓检验中通过 `vm.Script` JS 语法解析。
  - **正式回归测试**：
    - [scripts/verify.mjs](./scripts/verify.mjs) 在 `verifyDaemonQuitAndUpgradePidSafety()` 扩展 `W1-1` ~ `W1-4` 跨双插件用例：覆盖 `--input <daemon> --daemon` 数据参数防误杀（含 `quit`、升级、管道 `--uninstall`）、位置参数混淆、`.mjs.bak` 后缀混淆、非 Node `/bin/sh` 进程、含空格路径合法守护进程正常退出、`import` 自启动防护及 Win32 / Linux / POSIX 解析纯函数单测。
  - **本机已安装环境热升级实测**：执行 `./install.sh` 将 `~/.gemini/config/plugins/` 热升级至 `agy-finder` `0.2.7` 与 `context-viewer` `1.7.7`（全程无 `[WARN]`，两插件旧版守护进程经精确入口核验平滑退出并拉起新实例，保留自定义侧栏快捷键与菜单栏“速度与耗时”模式配置）。
- **历史基线**：
  - `v2026.11.14.4`（`71ec790`）：`agy-finder v0.2.6` / `context-viewer v1.7.6`（实现守护进程跨平台 PID 身份核验、修复安装升级 `$STAGE_DIR` 预退出调用边界与 `float_window.mjs` `quit` 状态清理顺序并完成本机热升级发布；注：身份核验在该版本基于命令行子串匹配，已于 `v0.2.7` / `v1.7.7` 收紧至精确 `argv[1]` 入口边界）。
  - `v2026.11.14.3`（`c5d1c80`）：`agy-finder v0.2.5` / `context-viewer v1.7.5`（补充双插件共存升级说明、单插件低版本对端只读 `[WARN]`、`AGY_INSTALL_BATCH` 批次透传与 6 阶段 `SIGKILL` 崩溃恢复校验）。
  - `v2026.11.14.2`（`a365456`）：`agy-finder v0.2.4` / `context-viewer v1.7.4`（修复同代 Bakery 协议下并发回收旧锁的 TOCTOU 竞态及 `agy-finder` 切换工作区旧搜索结果残留）。
  - `v2026.11.14.1`（`b6e5b81`）：`agy-finder v0.2.3` / `context-viewer v1.7.3`；`v2026.11.14`（`f74753e`）：`0.2.2` / `1.7.2`；`v2026.11.13`：`0.2.1` / `1.7.1`。
- **跨平台与未实测项**：
  - Windows PowerShell 5.1 / 7（本机无 `pwsh`，本次 `.ps1` 改动通过 JS 语法扫描但未在 Windows 实机验收）、Linux 桌面端、`Node.js 18` 最低版本、真实桌面端宿主复用/侧栏交互。

## 关键入口

- 仓库总览：[README.md](./README.md) / [README_EN.md](./README_EN.md)
- 开发与发布约束：[AGENTS.md](./AGENTS.md)
- 统一安装脚本：[install.sh](./install.sh) / [install.ps1](./install.ps1)
- 全仓校验与打包：[scripts/verify.mjs](./scripts/verify.mjs) / [scripts/package-all.mjs](./scripts/package-all.mjs)
- 已迁移插件：[plugins/agy-finder](./plugins/agy-finder) 、[plugins/agy-context-viewer](./plugins/agy-context-viewer)

## 最近验证

- `./install.sh && ~/.local/bin/agy-finder status --json && ~/.local/bin/agy-context float status --json`：通过，本机热升级至 `agy-finder` `0.2.7` / `context-viewer` `1.7.7` 退出码 `0` 且全程无 `[WARN]`，两插件均切至新守护进程实例（`daemonRunning: true`）并保留自定义侧栏快捷键与菜单栏 `speed` 模式配置，时间：`2026-11-14 19:25`（Asia/Shanghai）。
- `node scripts/verify.mjs --strict-git-identity`：通过（含 `v0.2.7` / `v1.7.7` 双插件自检、`install.ps1` 内嵌 JS 语法扫描、`V1` / `W1` 守护进程入口边界精确核验与 PID 复用防误杀、6 阶段 `SIGKILL` 崩溃恢复、隐私扫描与 Git noreply 身份门禁及 Swift `-typecheck`），时间：`2026-11-14 19:25`（Asia/Shanghai）。
- `RELEASE_REF=v2026.11.14.5 LC_ALL=C node scripts/package-all.mjs && (cd dist && ls -lh agy-finder-v0.2.7.zip context-viewer-v1.7.7.zip && unzip -t agy-finder-v0.2.7.zip && unzip -t context-viewer-v1.7.7.zip && LC_ALL=C shasum -a 256 -c agy-finder-v0.2.7.zip.sha256 context-viewer-v1.7.7.zip.sha256)`：通过，生成 `dist/agy-finder-v0.2.7.zip`（94.0 KB，20 个文件）与 `dist/context-viewer-v1.7.7.zip`（177.5 KB，20 个文件），ZIP 完整性与 SHA-256 校验均 `OK`，时间：`2026-11-14 19:25`（Asia/Shanghai）。
