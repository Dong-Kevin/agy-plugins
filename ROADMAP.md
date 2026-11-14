# agy-plugins ROADMAP

更新时间：2026-11-15 01:09（Asia/Shanghai）。

## 本次交付目标

1. 修复第九轮代码审查确认的 Context Viewer P2 问题 `Y1`（后台回溯尚有待写模型映射时，强制刷新先清空缓存导致未落盘数据丢失），完成 `H4` 回归测试、全仓校验打包、本机 `./install.sh` 热升级与本地增量提交；远端 `git push` 与 GitHub Release（`v2026.11.15`）待授权确认。

## 当前阶段与状态

- **已完成 `Y1（P2）` 本地修复、验证、本机热升级与增量提交准备（`context-viewer v1.7.9`）**：
  - **后台回溯待写模型批次自持与先落盘再取消（Y1）**：在 [collector.mjs](./plugins/agy-context-viewer/sidecars/dashboard/collector.mjs) 中提取 `mergePersistedConvsInto()`，为回溯批次 `wave` 绑定独立 `pendingConvs`、`persistPath` 与 `agDir`，新增 `stopGenBackfillWave()` 在强制刷新或切换数据目录清空共享缓存前先原子落盘待写步骤模型并收拢旧队列，同时保留已有并发上限与响应预算且避免跨目录污染。
  - **补齐 `H4` 三场景冷进程回归测试**：在 [verify.mjs](./plugins/agy-context-viewer/scripts/verify.mjs) 新增 `H4`（预算内部分成功／430 ms 后台未满 6 条处于待写态时强刷且宿主转 503，全新冷子进程离线读取保留模型；以及回溯期间切换数据目录持久化隔离）。
  - **本机热升级（含 `Y1` 修复）**：已重新执行 `./install.sh`，`~/.gemini/config/plugins/context-viewer` 已更新至最新 `1.7.9`（已核对含 `stopGenBackfillWave`），`agy-finder` 保持 `0.2.7`；`~/.local/bin/agy-context --help` 与 `agy-context json` 验证正常，随本次增量提交至本地 `main`。
- **待确认后置操作（对外写入）**：
  - 尚未执行 `git push`、打 tag 或公开发布 GitHub Release（拟用 Tag `v2026.11.15`，待 `boss` 明确授权后以 `RELEASE_REF=v2026.11.15` 打包并发布）。
- **已合入本地提交基线（`55ca7c4`，含 X1／X2 修复）**：
  - **步骤模型缓存自愈与合并保护（X1）**：[collector.mjs](./plugins/agy-context-viewer/sidecars/dashboard/collector.mjs) 禁止写入或长期命中空映射，按缺失步骤完整性与文件签名联合校验；新结果与磁盘已有 `steps` 增量合并且不覆写已知模型，`force: true` 显式清理内存／miss 状态以重新拉取补齐。
  - **本地优先历史聚合、有界并发回溯与前端轮询解耦（X2）**：`collectTokenHistory()` 改为先解析本地 `transcript.jsonl`、跳过内联模型已完成或 `cli` 会话，仅对桌面缺模型步骤并发回溯（`6` 并发、单次 `900ms` 超时、单轮 `350ms` 同步预算、连续失败熔断并后台落盘更新 ETag）；[app.js](./plugins/agy-context-viewer/sidecars/dashboard/app.js) 中 `boot()` 不再阻塞 `1500ms` 上下文轮询启动。
  - **回归测试基线**：[verify.mjs](./plugins/agy-context-viewer/scripts/verify.mjs) 含 `H2`/`H3` 及前端慢 `/api/history` 轮询不阻塞用例。
- **已完成（独立开源致谢章节恢复）**：
  - **独立开源致谢章节恢复**：在根目录 [README.md](./README.md)、[README_EN.md](./README_EN.md) 与 [context-viewer README.md](./plugins/agy-context-viewer/README.md) / [README_EN.md](./plugins/agy-context-viewer/README_EN.md) 中恢复独立的 `## 致谢` / `## Acknowledgements` 章节（完整保留对 **[elviscjn-cjn/antigravity-context-viewer](https://github.com/elviscjn-cjn/antigravity-context-viewer)** 的致谢与架构独立说明），并将插件目录内 README 许可证链接修正为 `./LICENSE`。
- **已完成基线**：
  - **全仓 README 精简与高清截图更新（`0d21d38`）**：精简 6 份中英文 README（`README.md` / `README_EN.md` / 两款插件 README）突出核心介绍、Agent 一句话安装、快捷键与 UI/CLI 自定义位置，并更新 7 张 `@2x` 脱敏高清截图。
- **已发布基线**：
  - `v2026.11.14.6`：`agy-finder v0.2.7` / `context-viewer v1.7.8`（配额池语义化合并 `Gemini 模型` / `非 Gemini 模型`、历史步骤模型并发回溯与离线缓存、清理静态 `Prompt / Flow Credits`、`Q1`/`H1` 回归测试与本机热升级验收）。
- **历史基线**：
  - `v2026.11.14.5`（`8ac2d50`）：`agy-finder v0.2.7` / `context-viewer v1.7.7`（守护进程精确 `argv[1]` 入口边界核验、`isDirectDaemonEntry` 自启动防护、`install.ps1` `$VerifyJs` 同构校验及 README 平台验证范围客观校准）。
  - `v2026.11.14.4`（`71ec790`）：`agy-finder v0.2.6` / `context-viewer v1.7.6`（实现守护进程跨平台 PID 身份核验、修复安装升级 `$STAGE_DIR` 预退出调用边界与 `float_window.mjs` `quit` 状态清理顺序并完成本机热升级发布；注：身份核验在该版本基于命令行子串匹配，已于 `v0.2.7` / `v1.7.7` 收紧至精确 `argv[1]` 入口边界）。
  - `v2026.11.14.3`（`c5d1c80`）：`agy-finder v0.2.5` / `context-viewer v1.7.5`（补充双插件共存升级说明、单插件低版本对端只读 `[WARN]`、`AGY_INSTALL_BATCH` 批次透传与 6 阶段 `SIGKILL` 崩溃恢复校验）。
  - `v2026.11.14.2`（`a365456`）：`agy-finder v0.2.4` / `context-viewer v1.7.4`（修复同代 Bakery 协议下并发回收旧锁的 TOCTOU 竞态及 `agy-finder` 切换工作区旧搜索结果残留）。
  - `v2026.11.14.1`（`b6e5b81`）：`agy-finder v0.2.3` / `context-viewer v1.7.3`；`v2026.11.14`（`f74753e`）：`0.2.2` / `1.7.2`；`v2026.11.13`：`0.2.1` / `1.7.1`。
- **跨平台与未实测项**：
  - Windows PowerShell 5.1 / 7（本机无 `pwsh`，`.ps1` 改动通过 JS 语法扫描但未在 Windows 实机验收）、Linux 桌面端、`Node.js 18` 最低版本。

## 关键入口

- 仓库总览：[README.md](./README.md) / [README_EN.md](./README_EN.md)
- 开发与发布约束：[AGENTS.md](./AGENTS.md)
- 统一安装脚本：[install.sh](./install.sh) / [install.ps1](./install.ps1)
- 全仓校验与打包：[scripts/verify.mjs](./scripts/verify.mjs) / [scripts/package-all.mjs](./scripts/package-all.mjs)
- 已迁移插件：[plugins/agy-finder](./plugins/agy-finder) 、[plugins/agy-context-viewer](./plugins/agy-context-viewer)

## 最近验证

- `./install.sh` 本机热升级验收（含 `Y1` 修复）：通过（`~/.gemini/config/plugins/context-viewer` 为 `1.7.9` 且已核对 `stopGenBackfillWave` 存在，`agy-finder` 保持 `0.2.7`；`~/.local/bin/agy-context --help` 输出 `v1.7.9`，`agy-context json` 返回正常）。时间：`2026-11-15 01:09`（Asia/Shanghai）。
- `Y1` 修复后全仓验收：`node scripts/verify.mjs --strict-git-identity && node scripts/package-all.mjs` 通过（含 `context-viewer v1.7.9` 6/6 自检及 `H2`/`H3`/`H4`/前端慢历史用例、`agy-finder v0.2.7` 全套自检、全仓隐私扫描与 Git noreply 身份门禁；生成 `agy-finder-v0.2.7.zip` 90.4 KB、`context-viewer-v1.7.9.zip` 171.2 KB，SHA-256 `807b03c8e40f98f8d2ad4a5aff77726cfb6322a12a6cc845c5cd0df2152785e2`）。时间：`2026-11-15 01:01`（Asia/Shanghai）。
- 第九轮复查：`node scripts/verify.mjs --strict-git-identity` 通过；HEAD 临时副本打包及两份 ZIP 完整性／校验和通过。独立探针确认 X1／X2 原始场景恢复（18 个内联模型会话 0 次 metadata RPC、5 ms 返回；18 个缺模型会话 355 ms 返回后后台补齐并更新 ETag），另复现上述 Y1。时间：`2026-11-15 00:47`（Asia/Shanghai）。
- `./install.sh` 本机热升级验收：通过（`~/.gemini/config/plugins/context-viewer` 升级至 `1.7.9`，`agy-finder` 保持 `0.2.7`，`~/.local/bin/agy-context --help` 输出 `v1.7.9`，`agy-context json` 返回正常）。时间：`2026-11-15 00:38`（Asia/Shanghai）。
- `node scripts/verify.mjs --strict-git-identity && node scripts/package-all.mjs`：通过（含全仓隐私扫描、PNG 元数据块 audit、`context-viewer v1.7.9` 6/6 自检与 `H2`/`H3`/前端慢历史用例、`agy-finder v0.2.7` 全套自检、跨插件锁校验与双插件发布包 `agy-finder-v0.2.7.zip` 90.4 KB / `context-viewer-v1.7.9.zip` 170.6 KB）。时间：`2026-11-15 00:30`（Asia/Shanghai）。
- `node scripts/verify.mjs --strict-git-identity`：通过；发布标签提交与 HEAD 分别在临时副本执行 `node scripts/package-all.mjs`，两组 ZIP 完整性与校验和通过，标签重建摘要与发布资产一致。独立模拟探针复现上述两项 P2；18 个会话的 metadata 超时令历史采集等待约 13.5 秒。时间：`2026-11-14 23:33`（Asia/Shanghai）。
- `node scripts/verify.mjs --strict-git-identity && node scripts/package-all.mjs`：通过（含全仓隐私扫描、PNG 元数据块 audit、`context-viewer v1.7.8` 6/6 自检、`agy-finder v0.2.7` 全套自检、跨插件锁校验与双插件 ZIP 发布包生成 `agy-finder-v0.2.7.zip` 90.4 KB / `context-viewer-v1.7.8.zip` 167.3 KB），时间：`2026-11-14 22:51`（Asia/Shanghai）。
- `RELEASE_REF=v2026.11.14.6` 实机发布验收（`./install.sh` 热升级、双池与 5,505 次请求实机数据）：见历史提交 `v2026.11.14.6`，时间：`2026-11-14 20:49`（Asia/Shanghai）。
