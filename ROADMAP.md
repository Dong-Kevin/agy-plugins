# agy-plugins ROADMAP

更新时间：2026-11-14 09:40（Asia/Shanghai）。

## 本次交付目标

1. 发布 `v2026.11.14.2` 稳定性补丁版（`agy-finder v0.2.4` / `context-viewer v1.7.4`）：
   - 修复双插件共享触发锁并发回收旧锁时的 TOCTOU 抢占竞态，以及 `agy-finder` 切换工作区根目录时保留旧搜索结果并遗漏对新根目录重新搜索的问题。

## 当前阶段与状态

- **已完成（`v2026.11.14.2` 发布就绪）**：
  - `plugins/agy-finder/`（`v0.2.4`）：
    - `drawer.mjs`：`withAuxTriggerLock()` 升级为两层协议 -- 外层采用持久化目录 `${lockPath}.d` 内的 Lamport Bakery 票据互斥（唯一不可变 `entering-*` / `ticket-*` / `cand-*` 文件名 + 死 PID 清理），内层结合 `linkSync(candPath, lockPath)`（按需回退 `'wx'`）与 `renameSync` 回收死锁，使旧锁回收与新锁获取遵守同一互斥序，避免迟到回收者误移活持有者锁；严格先释放 `.lock` 再释放票据。
    - `app.js`：抽出 `resetSearchResultsForContextChange()`，在 `handleSearchInput()` 捕获并核对 `requestRoot === state.activeRoot`；`root-select` 切换根目录与 `refreshWorkspace()` 变更根目录时立即作废旧请求并清空旧结果，若搜索框非空则立即按新根目录重查并展示加载态（同时拉取新根目录首层目录缓存，清空搜索后可直接渲染对应目录树）；`btn-toggle-hidden` 同步切为立即刷新搜索。
    - `scripts/verify.mjs`：在 `verifyFinderFrontendBehavior` 补齐“已有结果后 A → B”“搜索未完成时 A → B”“快速 A → B → A”“旧请求报错不污染新根目录”与“清空搜索回归当前目录树” VM 回归测试。
  - `plugins/agy-context-viewer/`（`context-viewer v1.7.4`）：
    - `collector.mjs`：同步将 `withAuxTriggerLock()` 升级为 `${lockPath}.d` 两层 Bakery 票据互斥 + `linkSync` 原子锁获取与死锁回收协议，更新清单、CLI 与 `index.html` 版本至 `1.7.4`。
  - 全仓校验、打包与本机热升级实测：`scripts/verify.mjs` 新增双向旧锁回收交错障碍回归测试（Case A 回收中途被阻塞与 Case B 迟到回收者尝试删除死票据不破坏活持有者锁）；生成 `dist/agy-finder-v0.2.4.zip`（84.5 KB）与 `dist/context-viewer-v1.7.4.zip`（168.4 KB）；执行 `./install.sh` 将 `~/.gemini/config/plugins/` 热升级至 `agy-finder 0.2.4` 与 `context-viewer 1.7.4`，保留原有快捷键与 `menubarMode: speed` 偏好，CLI 与隔离已安装模块 Bakery 死锁回收测试全部通过。
- **历史基线**：
  - `v2026.11.14.1`（`b6e5b81`）：`agy-finder v0.2.3` / `context-viewer v1.7.3`（闭合共享触发锁超时 fail-closed 与常驻活锁不抢占边界，并修复符号链接工作区相对路径、展开目录轮转同步与自动跟随切会话竞态；并发回收旧锁的 TOCTOU 竞态由 `v2026.11.14.2` 补齐）。
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

- `./install.sh` + 本机已安装实测：通过，热升级至 `agy-finder 0.2.4` / `context-viewer 1.7.4`（保留自定义 `Ctrl+K` 与 `menubarMode: speed`），`~/.local/bin/agy-finder status --json`（`daemonRunning: true`）与 `agy-context --version`（`v1.7.4`）及双插件已安装模块隔离 Bakery 死锁回收测试全部通过，时间：`2026-11-14 09:40`（Asia/Shanghai）。
- `node scripts/verify.mjs --strict-git-identity`：通过（含双插件自检、`v0.2.4` / `v1.7.4` 清单与隔离检查、R1/S1/T1 8 进程竞争与双向旧锁并发回收交错测试、R2/S2/S3/T2 符号链接相对路径 + 目录轮转 + 切工作区重搜 VM 测试、S4 自动跟随切会话 VM 测试、隔离安装卸载与 Swift `-typecheck`），时间：`2026-11-14 09:40`（Asia/Shanghai）。
- `RELEASE_REF=v2026.11.14.2 LC_ALL=C node scripts/package-all.mjs && (cd dist && unzip -t agy-finder-v0.2.4.zip && unzip -t context-viewer-v1.7.4.zip && LC_ALL=C shasum -a 256 -c agy-finder-v0.2.4.zip.sha256 context-viewer-v1.7.4.zip.sha256)`：通过，生成 `dist/agy-finder-v0.2.4.zip`（84.5 KB）与 `dist/context-viewer-v1.7.4.zip`（168.4 KB），ZIP 完整性与 SHA-256 校验均 `OK`，时间：`2026-11-14 09:40`（Asia/Shanghai）。
