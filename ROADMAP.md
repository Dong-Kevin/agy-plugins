# agy-plugins ROADMAP

更新时间：2026-11-14 13:39（Asia/Shanghai）。

## 本次交付目标

1. 发布 `v2026.11.14.3` 升级兼容性与恢复门禁加固版（`agy-finder v0.2.5` / `context-viewer v1.7.5`）：
   - 明确双插件共存时的跨插件锁协议升级前提：须将 `agy-finder`（`>= 0.2.4`）与 `context-viewer`（`>= 1.7.4`）同步升级并确保旧版后台守护进程及宿主 Sidecar 实例均已退出或重载，方可消除旧版绕过 `.lock.d` Bakery 协议并发回收 `.lock` 的风险；仅安装单插件的用户不受影响。
   - 在单插件安装时增加只读低版本对端 `[WARN]` 提示、`agy-finder` 升级前退出旧抽屉守护进程，并在全仓校验套件补齐 6 阶段 `SIGKILL` 崩溃恢复与安装告警回归测试。

## 当前阶段与状态

- **已完成（`v2026.11.14.3` 发布就绪）**：
  - **文档与版本矩阵（`agy-finder v0.2.5` / `context-viewer v1.7.5`）**：
    - 在根目录 [README.md](./README.md)、[README_EN.md](./README_EN.md) 及两插件各自的中英文 README 补充双插件共存升级说明；同步更新版本至 `0.2.5` / `1.7.5`（保持已发布 `v2026.11.14.2` 包与校验和不可变，对端兼容检查下限仍为 `0.2.4` / `1.7.4`）。
  - **安装器升级衔接与只读对端校验**：
    - [install.sh](./install.sh) 与 [install.ps1](./install.ps1) 在非卸载批次中透传 `AGY_INSTALL_BATCH`，避免全仓批量升级按目录序先装 `context-viewer` 时对尚未更新的 `agy-finder` 误报陈旧告警。
    - [plugins/agy-finder/install.sh](./plugins/agy-finder/install.sh) 与 [plugins/agy-finder/install.ps1](./plugins/agy-finder/install.ps1) 在非隔离模式下覆盖文件前先执行 `cli.mjs quit` 退出旧抽屉守护进程（隔离 `AGY_PLUGINS_DIR` 测试不触碰宿主守护进程）。
    - [plugins/agy-finder/install.sh](./plugins/agy-finder/install.sh)、[plugins/agy-finder/install.ps1](./plugins/agy-finder/install.ps1)、[plugins/agy-context-viewer/install.sh](./plugins/agy-context-viewer/install.sh) 与 [plugins/agy-context-viewer/install.ps1](./plugins/agy-context-viewer/install.ps1) 安装后只读核对同级已装对端 `plugin.json`，若单插件安装或对端未在同一批次内且版本低于 `0.2.4` / `1.7.4`，输出 `[WARN]` 提示同步升级与重载旧进程（绝不自动改动对端插件）。
  - **锁协议不变量注释与正式回归测试**：
    - `plugins/agy-finder/sidecars/tree/drawer.mjs` 与 `plugins/agy-context-viewer/sidecars/dashboard/collector.mjs` 在 `withAuxTriggerLock()` 补充 3 条协议不变量注释（`>= 0.2.4` / `>= 1.7.4` 对端前提、`ticketPath` 建立后单次 `pendingEntering` 快照完备性、不可变 `(pid, nonce)` 文件名与 `finally` 先删 `.lock` 再删 `ticketPath` 顺序）。
    - [scripts/verify.mjs](./scripts/verify.mjs) 新增两部分正式测试：（1）`verifyRootInstaller` 预置 `1.7.3` / `0.2.3` 对端验证单插件 `[WARN]` 与只读不改写、全量批次无误报及已升级无误报；（2）`verifyCrossPluginAuxTriggerLock` 补全 `['entering', 'ticket', 'critical']` × 双向 `finder <-> context` 共 6 组 `SIGKILL` 阶段中断崩溃恢复测试（活进程期间 `lockBusy: true, claimed: false`，`SIGKILL` 后继承者正常认领并清空 `.lock` 与 `.lock.d`）。
  - **本机已安装环境热升级实测**：执行 `./install.sh` 将 `~/.gemini/config/plugins/` 热升级至 `agy-finder 0.2.5` 与 `context-viewer 1.7.5`（全程无 `[WARN]`，两插件旧后台守护进程均已平滑退出并重启新实例，保留已有快捷键与菜单栏“速度与耗时”模式配置）。
- **历史基线**：
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

- `./install.sh` + 本机已安装实测：通过，热升级 `~/.gemini/config/plugins/` 至 `agy-finder 0.2.5` 与 `context-viewer 1.7.5`（无 `[WARN]`，保留已有快捷键与菜单栏速度模式），`~/.local/bin/agy-finder status --json`（`daemonRunning: true`）与 `~/.local/bin/agy-context`（`v1.7.5`）及 `menubar status` / `aux-shortcut status` 全部正常，时间：`2026-11-14 13:39`（Asia/Shanghai）。
- `node scripts/verify.mjs --strict-git-identity`：通过（含 `v0.2.5` / `v1.7.5` 双插件自检、`U1` 隔离单插件 `[WARN]` 与只读对端保护测试、`U1` 6 阶段 `SIGKILL` 崩溃恢复测试、8 进程竞争与双向旧锁并发回收交错测试、隐私扫描与 Git noreply 身份门禁及 Swift `-typecheck`），时间：`2026-11-14 12:16`（Asia/Shanghai）。
- `RELEASE_REF=v2026.11.14.3 LC_ALL=C node scripts/package-all.mjs && (cd dist && ls -lh agy-finder-v0.2.5.zip context-viewer-v1.7.5.zip && unzip -t agy-finder-v0.2.5.zip && unzip -t context-viewer-v1.7.5.zip && LC_ALL=C shasum -a 256 -c agy-finder-v0.2.5.zip.sha256 context-viewer-v1.7.5.zip.sha256)`：通过，生成 `dist/agy-finder-v0.2.5.zip`（86.5 KB，20 个文件）与 `dist/context-viewer-v1.7.5.zip`（170.2 KB，20 个文件），ZIP 完整性与 SHA-256 校验均 `OK`，时间：`2026-11-14 12:16`（Asia/Shanghai）。
