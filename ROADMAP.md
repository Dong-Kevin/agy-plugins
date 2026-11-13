# agy-plugins ROADMAP

更新时间：2026-11-14 00:34（Asia/Shanghai）。

## 本次交付目标

1. 发布 `v2026.11.14` 稳定性与首屏体验升级（`context-viewer v1.7.2` / `agy-finder v0.2.2`）：
   - 加固跨插件并发锁、路径与符号链接解析、定位缓存刷新、切会话竞态防覆盖与隔离安装边界：包括跨插件共享 `agy_aux_pane_trigger.json` 原子文件锁与死锁自动回收、相对点文件（`.env`）与父目录（`../`）解析修复、定位已展开缓存目录强制刷新、会话快速切换乱序防覆盖与按会话隔离 `ETag`、工作区搜索符号链接环路/重复别名物理目录去重、隔离 `AGY_PLUGINS_DIR` 安装/卸载保护已有 `$HOME/.local/bin` CLI 入口及归属校验。
   - 落地体验与测试升级：`agy-finder` 可见展开目录自动增量同步与搜索加载/截断/错误提示横幅、`context-viewer` 首屏 Hero 卡片提升模型配额条并默认折叠累计四维吞吐区块，补齐 8 进程并发锁、`node:vm` 真实前端交互、点文件/符号链接搜索及隔离 `HOME/.local/bin` 回归测试。

## 当前阶段与状态

- **已完成**：
  - 仓库初始化与过往发布基线：完成 `git init -b main`、绑定远端 `origin`、锁定 `Dong-Kevin` 与 GitHub `noreply` 身份、`scripts/pre-push` 门禁及 `v2026.11.13`（`agy-finder v0.2.1`、`context-viewer v1.7.1`）发布。
  - `v2026.11.14` 发布就绪（`agy-finder v0.2.2` / `context-viewer v1.7.2`）：
    - `plugins/agy-finder/`（`v0.2.2`）：`drawer.mjs` 新增 `withAuxTriggerLock`（`wx` 原子锁 + `Atomics.wait` + PID/mtime 死锁回收）保护 5 个触发器变更函数；`path_utils.mjs` 修复 `.env` / `../` 相对路径裁剪并增加 `realpathSync` 环路与根挂载防护；`app.js` / `styles.css` 修复 `revealPathInTree` 强制刷新（`fetchDir(..., true)`）、新增 `syncVisibleExpandedDirs()`（3.5s 可见期轮询）及搜索态/截断/错误提示横幅；`install.ps1` 增加隔离安装/卸载 CLI 保护与归属校验；`scripts/verify.mjs` 补充相对点文件/符号链接搜索与 `node:vm` 定位刷新及搜索前端行为测试。
    - `plugins/agy-context-viewer/`（`context-viewer v1.7.2`）：`collector.mjs` 同步落盘 `withAuxTriggerLock` 保护共享 Aux 触发器；`app.js` 新增 `contextReqSeq` / `contextEtagConv` / `contextInFlight` 与 `historyReqSeq` 乱序防覆盖护栏；`index.html` / `styles.css` 将 `#ctx-quota-box` 提升至 Hero 卡片首屏并把累计吞吐与折算金额改为默认折叠（带实时摘要胶囊 `#cum-summary-chip`）；`install.sh` 与 `install.ps1` 补全隔离安装 `BIN_DIR` 保护与卸载归属检查；`scripts/verify.mjs` 新增 Hero DOM 与 `node:vm` 乱序竞态测试。
    - 全仓校验、打包与本地热升级：根 `scripts/verify.mjs` 新增 8 进程跨插件并发锁竞争/陈旧锁恢复测试与隔离 `HOME/.local/bin` 哨兵保护测试；生成 `RELEASE_REF=v2026.11.14` 发布包 `dist/agy-finder-v0.2.2.zip` 与 `dist/context-viewer-v1.7.2.zip`；执行 `./install.sh` 完成本机热升级并确认 `Ctrl+K` 自定义快捷键完整保留。
- **跨平台待测项**：
  - `agy-finder` 与 `agy-context-viewer` 的 Windows PowerShell 5.1 / 7 + `cmd.exe`、Linux 桌面端及 `Node.js 18` 最低版本尚未在对应宿主机实机运行。

## 关键入口

- 仓库总览：[README.md](./README.md) / [README_EN.md](./README_EN.md)
- 开发与发布约束：[AGENTS.md](./AGENTS.md)
- 统一安装脚本：[install.sh](./install.sh) / [install.ps1](./install.ps1)
- 全仓校验与打包：[scripts/verify.mjs](./scripts/verify.mjs) / [scripts/package-all.mjs](./scripts/package-all.mjs)
- 已迁移插件：[plugins/agy-finder](./plugins/agy-finder) 、[plugins/agy-context-viewer](./plugins/agy-context-viewer)

## 最近验证

- `node scripts/verify.mjs --strict-git-identity`：通过（含两插件语法/Swift `-typecheck`/隐私门禁/`node:vm` 前端行为测试、点文件与符号链接搜索、8 进程跨插件并发锁与陈旧锁回收、隔离 `HOME/.local/bin` 哨兵保护），时间：`2026-11-14 00:06`（Asia/Shanghai，随 `push` 门禁复跑）。
- `RELEASE_REF=v2026.11.14 LC_ALL=C node scripts/package-all.mjs && (cd dist && LC_ALL=C shasum -a 256 -c *.sha256)`：通过，生成 `dist/agy-finder-v0.2.2.zip`（81.9 KB）与 `dist/context-viewer-v1.7.2.zip`（166.6 KB），SHA-256 校验 `OK`，时间：`2026-11-14 00:34`（Asia/Shanghai）。
- `./install.sh` + 本机守护与配置检查：通过，本机已热升级至 `agy-finder 0.2.2`（`⇧⌘E` / `⌥⌘E`）与 `context-viewer 1.7.2`（`⌥⌘K` / 保留自定义 `Ctrl+K`，菜单栏常驻就绪），时间：`2026-11-14 00:06`（Asia/Shanghai）。
