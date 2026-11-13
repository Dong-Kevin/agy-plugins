# agy-plugins ROADMAP

更新时间：2026-11-14 02:03（Asia/Shanghai）。

## 本次交付目标

1. 发布 `v2026.11.14.1` 稳定性补丁版（`agy-finder v0.2.3` / `context-viewer v1.7.3`）：
   - 补全共享触发锁 fail-closed 超时互斥、`agy-finder` 符号链接工作区相对路径一致化与 `>25` 展开目录轮转同步、`context-viewer` 自动跟随态下宿主会话 ID 实时变更感知与并发防覆盖。

## 当前阶段与状态

- **已完成（`v2026.11.14.1` 发布就绪）**：
  - `plugins/agy-finder/`（`v0.2.3`）：
    - `drawer.mjs` / `main.mjs` / `app.js`：`withAuxTriggerLock()` 改为获锁失败即中止执行（fail-closed）并通过 `onFail` 明确返回 `ok: false` / `claimed: false` / `lockBusy: true`（同步等待收敛为 1200 ms，死进程 PID 锁立即回收、活进程锁绝不抢占），前端改用严格 `sw?.claimed` / `ackRes?.claimed` 判定。
    - `path_utils.mjs` / `app.js`：抽出统一 `matchWorkspaceRoot()`，在绝对路径、相对路径与兜底分支统一执行符号链接工作区路径重映射，保持目录读取 `403` 越界校验不放宽，并在 `revealPathInTree` 暴露目录加载失败提示。
    - `app.js`：`syncVisibleExpandedDirs()` 过滤祖先未展开的子目录，并按 `root` 维护 `syncCursorByRoot` 分批轮转刷新（单轮上限 1 个根目录 + 24 个可见子目录），`btn-collapse-all` 同步重置游标。
    - `scripts/verify.mjs`：补齐符号链接工作区相对路径展开（含 `listDirectoryEntries` 校验）及 >25 展开目录轮转同步与折叠过滤 VM 回归测试。
  - `plugins/agy-context-viewer/`（`context-viewer v1.7.3`）：
    - `collector.mjs` / `main.mjs` / `float_window.mjs` / `app.js`：同步落地 fail-closed `withAuxTriggerLock()` 与全链路锁繁忙返回。
    - `app.js`：`loadContext()` 在在途合并判断前先同步实时 `window.sidecar?.conversationId`，仅同一 `contextInFlightConv` 合并跳过；响应返回后再次核对实时宿主 ID 并拒绝滞后旧响应。
    - `scripts/verify.mjs`：补齐自动跟随态宿主会话请求期切换与滞后覆盖防护 VM 回归测试。
  - 全仓校验、打包与本机热升级实测：根目录 `scripts/verify.mjs` 补齐活进程持锁超时互斥、死进程锁即时回收及释放后复领测试；构建 `RELEASE_REF=v2026.11.14.1` 发行包 `dist/agy-finder-v0.2.3.zip` 与 `dist/context-viewer-v1.7.3.zip`；执行 `./install.sh` 完成本机热升级并验证已安装实例的符号链接 `/api/resolve` + `/api/tree`、fail-closed 锁超时互斥、CLI/菜单栏常驻及 `Ctrl+K` 配置保留。
- **历史基线**：
  - `v2026.11.14`（`f74753e`）：`agy-finder v0.2.2` / `context-viewer v1.7.2`；`v2026.11.13`：`agy-finder v0.2.1` / `context-viewer v1.7.1`。
- **跨平台待测项**：
  - Windows PowerShell 5.1 / 7 + `cmd.exe`、Linux 桌面端、`Node.js 18` 最低版本及真实桌面端宿主复用/侧栏交互尚未在对应宿主机实机验收。

## 关键入口

- 仓库总览：[README.md](./README.md) / [README_EN.md](./README_EN.md)
- 开发与发布约束：[AGENTS.md](./AGENTS.md)
- 统一安装脚本：[install.sh](./install.sh) / [install.ps1](./install.ps1)
- 全仓校验与打包：[scripts/verify.mjs](./scripts/verify.mjs) / [scripts/package-all.mjs](./scripts/package-all.mjs)
- 已迁移插件：[plugins/agy-finder](./plugins/agy-finder) 、[plugins/agy-context-viewer](./plugins/agy-context-viewer)

## 最近验证

- `./install.sh` + 本机已安装实测：通过，热升级至 `agy-finder 0.2.3` / `context-viewer 1.7.3`（保留自定义 `Ctrl+K` 与 `menubarMode: speed`），`agy-finder` 符号链接工作区独立 HTTP `/api/resolve`（`200`）与 `/api/tree`（`200`）及双插件已安装模块 fail-closed 锁超时测试全部通过，时间：`2026-11-14 02:03`（Asia/Shanghai）。
- `node scripts/verify.mjs --strict-git-identity`：通过（含 S1/R1 8 进程竞争 + 死锁回收 + 活锁 fail-closed 超时互斥、S2/R2 符号链接工作区相对路径 + `403` 守卫、S3 `>25` 展开目录轮转 + 折叠祖先过滤 VM 测试、S4 自动跟随宿主会话切换 + 乱序防覆盖 VM 测试、隔离安装器与 Swift `-typecheck`），时间：`2026-11-14 02:03`（Asia/Shanghai）。
- `RELEASE_REF=v2026.11.14.1 LC_ALL=C node scripts/package-all.mjs && (cd dist && LC_ALL=C shasum -a 256 -c agy-finder-v0.2.3.zip.sha256 context-viewer-v1.7.3.zip.sha256)`：通过，生成 `dist/agy-finder-v0.2.3.zip`（83.0 KB）与 `dist/context-viewer-v1.7.3.zip`（167.2 KB），SHA-256 校验 `OK`，时间：`2026-11-14 02:03`（Asia/Shanghai）。
