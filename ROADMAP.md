# agy-plugins ROADMAP

更新时间：2026-11-15 12:27（Asia/Shanghai）。

## 本次交付目标

1. 为 `agy-finder` 新增 HTML（`.html` / `.htm` / `.xhtml`）识别与系统默认浏览器打开能力（方案 A：聊天 `[🌐]` 胶囊 + `[📂]` 定位胶囊，面板／抽屉／提及内默认调用系统 `https` 默认浏览器打开且支持 `Alt`/`Option` 查看源码），升级至 `v0.2.8`，完成全仓校验、打包与本机 `./install.sh` 热升级。
2. 为 `context-viewer` 消除闲置期与跨进程对 `language_server` 的重复本地 RPC 轮询（解决每小时约 480 次无效 RPC 触发 Clearcut 遥测上传的问题），升级至 `v1.7.10`，完成全仓校验、打包与本机 `./install.sh context-viewer` 热升级。
3. 同步升级双插件右侧辅助栏（Aux Pane）唤醒桥接：依据 Antigravity 宿主真实消息合约（隐藏态或未加载 `Cyc` 桥接组件时仅根 `epc()` 响应 `toggle-conversation`，可见态挂载的 `Cyc` 才响应 `toggle-aux-pane`），隐藏态统一经 `window.sidecar.ui.toggleConversation(targetConvId)` 先展开折叠面板并挂载标签页，再由可见对端插件经 `toggleAuxPane({ tabType: 'sidecarView', uri })` 切换目标标签，修复冷挂载误关竞态、`revealPath` 跨插件衔接与宽限窗口，并完成 `v0.2.8` / `v1.7.10` 双插件热升级与全仓门禁验收。

## 当前阶段与状态

- **已完成本地实现、回归验证、打包与本机热升级（`agy-finder v0.2.8` 与 `context-viewer v1.7.10`，已提交推送 `main`，待确认打 tag／发布 GitHub Release）**：
  - **双插件 Aux Pane 折叠态唤醒修复与桥接优化（`agy-finder v0.2.8` & `context-viewer v1.7.10`）**：
    - 宿主消息边界核查（只读排查宿主前端主包与 `sidecar_sdk/preload.js`）：`Dyc` 仅在 `visible === true` 时挂载 `Cyc`（注册 `toggle-aux-pane` 监听），隐藏态下直接调用 `toggleAuxPane` 会被宿主静默丢弃；唯有无条件挂载在根组件 `P6c` 的 `epc()` 会接收 `toggle-conversation` 并展开已折叠的 Aux Pane。若会话停留在 `Overview` 且从未打开／固定任一 Sidecar 标签，展开后会保持 `Overview` 并弹出一次“请点开一次并右键 Pin Tab”提示引导。
    - `context-viewer`（[app.js](./plugins/agy-context-viewer/sidecars/dashboard/app.js) / [float_window.mjs](./plugins/agy-context-viewer/sidecars/dashboard/float_window.mjs)）：保留 `isHostSidebarContext()` 作为 `/sidebar` 最终兜底（`holdMs=390`，不上报 `hello` 也不误发关闭键）与冷挂载 `visibleSince` / `alreadyOpeningOrSwitched` / `coordinatorBootAt` 防误关保护；在 `!isVisibleNow` 分支恢复仅调用 `window.sidecar.ui.toggleConversation(targetConvId)`（不再在隐藏态调用被宿主丢弃的 `toggleAuxPane` 或预置 `switched`），并保留隐藏窗口首屏延迟与可见对端 `toggleAuxPane({ tabType: 'sidecarView', uri })` 切换；CLI 二次轮询与守护进程 HUD 宽限窗口调整为 `450ms` / `750ms`。
    - `agy-finder`（[app.js](./plugins/agy-finder/sidecars/tree/app.js) / [drawer.mjs](./plugins/agy-finder/sidecars/tree/drawer.mjs)）：同步移除 `!isVisibleNow` 中的 `toggleAuxPane` 与预置 `switched`，统一经 `toggleConversation(targetConvId)` 唤醒折叠面板；保留冷挂载防误关保护、`ackSeq >= seq` 早退前幂等 `triggerRevealOnce(trig.seq, trig.revealPath)` 与 `drawer.mjs` `450ms` / `750ms` 宽限窗口。
    - 回归与行为校验（双侧 `scripts/verify.mjs`）：更新 `verifyContextAuxBridgeBehavior` 与 `verifyFinderAuxBridgeBehavior` 沙箱测试，强制按 `currentIoVisible === true` 门禁模拟宿主 `toggleAuxPane` 受理条件（隐藏态误发记为失败），完整验证隐藏态 `toggleConversation` 唤醒 -> 可见对端 `toggleAuxPane` 切换、冷挂载防误关、`WasAlreadyVisible` 折叠、`/sidebar` 兜底及跨插件 `revealPath` 保留。
  - **消除闲置与跨进程重复 LS RPC（`context-viewer v1.7.10`）**：
    - [collector.mjs](./plugins/agy-context-viewer/sidecars/dashboard/collector.mjs)：移除 `scanSnapCache` 中 `15s` 时间分桶、`Math.floor(Date.now() / 15000)` 导致的不变强制重扫，提前解析本地 `transcript.jsonl` 收集 `requiredModelSteps` 与错误步骤；仅在覆盖不全或未过退避窗口（`4s -> 8s -> 18s -> 60s`，文件静默超过 `3` 分钟自动收敛）时查询 `GetCascadeTrajectoryGeneratorMetadata`；新增 `host_status_cache_v1.json`（上限 4 项、按 `lsKeyHash` 隔离且不落盘凭据或未脱敏邮箱）与 `active_conv_gen_cache_v1.json`（上限 6 会话、剥离非末轮 `tokenBreakdown` 并经 `sanitizeDiagnosticText` 脱敏错误诊断）跨进程复用，`getHostUserStatus()` 增加并发合流、`hasCrossedQuotaResetBoundary()` 重置窗口精确唤醒与按活跃度／前后台／菜单栏模式分级退避（隐藏闲置 `>= 10` 分钟退避至 `30` 分钟），`getSettings()` / `saveSettings()` 默认走 `{ background: true }`，`collectTokenHistory()` 空闲 `60s` 复用。
    - [float_window.mjs](./plugins/agy-context-viewer/sidecars/dashboard/float_window.mjs) 与 [app.js](./plugins/agy-context-viewer/sidecars/dashboard/app.js)：可见未固定窗口复用 Web 轮询跳过重复扫描，隐藏态 ETag 无变化超 `90s` 将 `barTimer` 降频至 `5s` 并透传 `{ background, menubarMode }`；浮窗 `--hidden-window` 启动在 `__cvOnHostVisibility(true)` 前不请求 `/api/context` 与 `/api/history`，侧边栏由隐藏恢复可见时同步补齐 `loadHistory(false)`。
    - [verify.mjs](./plugins/agy-context-viewer/scripts/verify.mjs)：新增 `I1` 回归套件（闲置 `15s/30s/5m/25m` 零额外 RPC、跨 `resetTime` 单次唤醒、`4.5s` 延迟 commit 重试收敛、冷子进程零 RPC 跨进程命中与敏感字段剥离/`force: true` 穿透）与前端 VM 隐藏浮窗启动延迟加载测试。
  - **受白名单保护的跨平台默认浏览器打开（`agy-finder v0.2.8`）**：[path_utils.mjs](./plugins/agy-finder/sidecars/tree/path_utils.mjs) 新增 `BROWSER_HTML_EXTS`、`isBrowserHtmlPath()` 与 `openInDefaultBrowser()`（仅放行本地 `.html` / `.htm` / `.xhtml` 普通文件；macOS 优先按 `https` LaunchServices handler、Safari、`/usr/bin/open` 顺序回退；Windows 读 `https` UserChoice 并经 `rundll32.exe` 回退；Linux 读 `xdg-settings` 并经 `xdg-open` 回退），并在 `resolveTargetPath` / `listDirectoryEntries` / `searchWorkspaceFiles` / [mentions.mjs](./plugins/agy-finder/sidecars/tree/mentions.mjs) 附加 `isHtmlFile` 标记。
  - **三端接口、CLI 与前端方案 A 交互**：[main.mjs](./plugins/agy-finder/sidecars/tree/main.mjs) 与 [drawer.mjs](./plugins/agy-finder/sidecars/tree/drawer.mjs) 接入 `POST /api/open-browser`，[cli.mjs](./plugins/agy-finder/sidecars/tree/cli.mjs) 新增 `agy-finder browser <path>`；[app.js](./plugins/agy-finder/sidecars/tree/app.js) 与 [index.html](./plugins/agy-finder/sidecars/tree/index.html) 支持 `open=browser` 深链并自动 `history.replaceState` 清理单次参数，树行／双击／`Enter`／顶部栏／提及芯片均默认调浏览器打开 HTML 并保留 `Alt`/`Option` 查看源码；同步更新 [rules/AGENTS.md](./plugins/agy-finder/rules/AGENTS.md)、[SKILL.md](./plugins/agy-finder/skills/agy-finder/SKILL.md) 与全仓中英文文档。
  - **待确认后置操作（对外写入）**：已完成 `main` 分支提交与推送；尚未打 tag 或创建 GitHub Release，待确认后执行。
- **已发布基线**：
  - `v2026.11.15`（`77e6750`）：`agy-finder v0.2.7` / `context-viewer v1.7.9`（包含 `55ca7c4` + `77e6750`：历史步骤模型缓存自愈与合并保护 `X1`、本地优先历史聚合 + 有界并发回溯 + 首屏轮询解耦 `X2`、后台回溯批次自持待写与强刷／切目录先落盘保护 `Y1`、`H2`/`H3`/`H4` 回归测试、双插件全仓校验、本机 `./install.sh` 热升级及绑定 `RELEASE_REF=v2026.11.15` 发布包与 SHA-256 资产校验）。
- **已归档基线（`v2026.11.15`）**：
  - **步骤模型缓存自愈与合并保护（X1）**：[collector.mjs](./plugins/agy-context-viewer/sidecars/dashboard/collector.mjs) 禁止写入或长期命中空映射，按缺失步骤完整性与文件签名联合校验；新结果与磁盘已有 `steps` 增量合并且不覆写已知模型，`force: true` 显式清理内存／miss 状态以重新拉取补齐。
  - **本地优先历史聚合、有界并发回溯与前端轮询解耦（X2）**：`collectTokenHistory()` 改为先解析本地 `transcript.jsonl`、跳过内联模型已完成或 `cli` 会话，仅对桌面缺模型步骤并发回溯（`6` 并发、单次 `900ms` 超时、单轮 `350ms` 同步预算、连续失败熔断并后台落盘更新 ETag）；[app.js](./plugins/agy-context-viewer/sidecars/dashboard/app.js) 中 `boot()` 不再阻塞 `1500ms` 上下文轮询启动。
  - **后台回溯待写模型批次自持与先落盘再取消（Y1）**：[collector.mjs](./plugins/agy-context-viewer/sidecars/dashboard/collector.mjs) 提取 `mergePersistedConvsInto()`，为回溯波次 `wave` 绑定独立 `pendingConvs`、`persistPath` 与 `agDir`，新增 `stopGenBackfillWave()` 在强制刷新或切换数据目录清空共享缓存前先原子落盘待写步骤模型并收拢旧队列。
  - **回归测试、本机热升级与远端发布**：[verify.mjs](./plugins/agy-context-viewer/scripts/verify.mjs) 补齐 `H2`/`H3`/`H4` 及前端慢历史用例；本机已通过 `./install.sh` 升级至 `context-viewer 1.7.9` / `agy-finder 0.2.7`；`origin/main` 已推送至 `77e6750` 并已发布 GitHub Release `v2026.11.15`（本地 `ROADMAP.md` 同步本次发布交接记录，未另做冗余空提交）。
- **历史基线**：
  - `v2026.11.14.6`（`2e61759`）：`agy-finder v0.2.7` / `context-viewer v1.7.8`（配额池语义化合并 `Gemini 模型` / `非 Gemini 模型`、历史步骤模型并发回溯与离线缓存、清理静态 `Prompt / Flow Credits`、`Q1`/`H1` 回归测试与本机热升级验收；后续于 `0d21d38`、`76cf215` 精简 README、更新高清截图并恢复独立开源致谢章节）。
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

- 双插件 Aux Pane 折叠态唤醒修复与本机统一热升级：`bash ./install.sh` 成功热升级 `~/.gemini/config/plugins/{context-viewer,agy-finder}`（`agy-context --help` 输出 `v1.7.10`、`agy-finder status` 返回就绪、`diff -q` 确认双侧已安装 `app.js` 与仓库源码一致，双侧守护进程与 `main.mjs` 已平滑重启接入）；macOS 实机 `⌃K` / `⌃E` 折叠态唤醒验证通过；`node scripts/verify.mjs --strict-git-identity && node scripts/package-all.mjs` 通过（含 `currentIoVisible === true` 门禁下双插件 Aux Pane VM 行为回归、跨插件锁测试、全仓隐私扫描与 `dist/agy-finder-v0.2.8.zip` / `dist/context-viewer-v1.7.10.zip` 重新打包）。时间：`2026-11-15 12:27`（Asia/Shanghai）。
- `context-viewer v1.7.10` 本机热升级与实机验证：`./install.sh context-viewer` 成功热升级 `~/.gemini/config/plugins/context-viewer` 至 `1.7.10`（`~/.local/bin/agy-context --help` 输出 `v1.7.10`、`agy-context json` 返回 `hasConv: true, quotaState: 'live'`），`float_window.mjs --daemon` 与 `cv-float-macos-*` 守护进程已切换为新副本并生成共享缓存 `host_status_cache_v1.json` 与 `active_conv_gen_cache_v1.json`。时间：`2026-11-15 10:20`（Asia/Shanghai）。
- `context-viewer v1.7.10` 全仓门禁与打包：`node scripts/verify.mjs --strict-git-identity && node scripts/package-all.mjs` 通过（注：前一次全仓测试中 `verifyCrossPluginAuxTriggerLock` 偶发一次锁竞争 `28 !== 40` 后重跑通过；覆盖全仓隐私扫描、PNG 元数据块 audit、`agy-context-viewer v1.7.10` 6/6 自检含 `I1` 闲置零 RPC/`resetTime` 边界/延迟收敛/冷启动共享缓存脱敏及隐藏浮窗 VM 延迟加载、`agy-finder v0.2.8` 全套校验、跨插件锁校验与生成 `agy-finder-v0.2.8.zip` 94.2 KB / `context-viewer-v1.7.10.zip` 176.2 KB / SHA-256 `5cf05131d5c84c4cc50677275849160fadbddf7598aa117311b79b795a1195c9`）。时间：`2026-11-15 10:19`（Asia/Shanghai）。
- `agy-finder v0.2.8` 本机热升级与 CLI Dry-Run 验证：`./install.sh` 成功热升级 `~/.gemini/config/plugins/agy-finder` 至 `0.2.8`（`context-viewer` 当时为 `1.7.9`），已核对 `rules/AGENTS.md` 含 `[🌐]` + `open=browser` 规则、`~/.local/bin/agy-finder status` 正常，且 `AGY_FINDER_DRY_RUN_BROWSER=1 ~/.local/bin/agy-finder browser .../plugins/agy-finder/sidecars/tree/index.html --json` 命中 `com.google.chrome` 首候选返回 `ok: true`。时间：`2026-11-15 10:12`（Asia/Shanghai）。
- `agy-finder v0.2.8` 全仓门禁与打包：`node scripts/verify.mjs --strict-git-identity && node scripts/package-all.mjs` 通过（含全仓隐私扫描、PNG 元数据块 audit、`agy-context-viewer v1.7.9` 6/6 自检、`agy-finder v0.2.8` 10/10 专项校验含 `openInDefaultBrowser` 注入回退、`POST /api/open-browser` CSRF/白名单、`open=browser` VM 深链与 `Alt` 源码预览回归、跨插件锁校验与生成 `agy-finder-v0.2.8.zip` 94.2 KB / SHA-256 `c5d9ad5275a8eb390b497c85e3f18f1e90d05aae68825ba51bee8a151b50c3f2`）。时间：`2026-11-15 10:11`（Asia/Shanghai）。
- 第十轮复查：`node scripts/verify.mjs --strict-git-identity`、独立 Y1 对照探针均通过；标签提交临时副本运行 `RELEASE_REF=v2026.11.15 LC_ALL=C node scripts/package-all.mjs` 通过，两份 ZIP 完整性及 4 个资产摘要与 GitHub API 一致。Windows／Linux 桌面和 Node.js 18 仍未实机验收。时间：`2026-11-15 01:54`（Asia/Shanghai）。
- `v2026.11.15` 远端推送与 Release 发布验收：`git push origin main`（含 `pre-push` 全仓校验与严格 Git 身份门禁）通过，`origin/main` 同步至 `77e6750`；以 `RELEASE_REF=v2026.11.15 LC_ALL=C node scripts/package-all.mjs` 生成绑定 Tag 的 4 个发布资产并校验 ZIP（20 条目、`testzip() is None`）与 `.sha256` 一致；已创建 GitHub Release `v2026.11.15` 并核验线上资产摘要完全一致（`agy-finder-v0.2.7.zip` SHA-256 `f52a64e1327b9f8fdadcbb2529a8ccfd265fb91c1e9a4558bebf5cc45ecbe2b6`；`context-viewer-v1.7.9.zip` SHA-256 `614d454bfb818a855e3ebd34eedcbb7882f2caefdf4322024d9d3cd34cb109d2`）。时间：`2026-11-15 01:21`（Asia/Shanghai）。
- `./install.sh` 本机热升级验收（含 `Y1` 修复）：通过（`~/.gemini/config/plugins/context-viewer` 为 `1.7.9` 且已核对 `stopGenBackfillWave` 存在，`agy-finder` 保持 `0.2.7`；`~/.local/bin/agy-context --help` 输出 `v1.7.9`，`agy-context json` 返回正常）。时间：`2026-11-15 01:09`（Asia/Shanghai）。
- `Y1` 修复后全仓验收：`node scripts/verify.mjs --strict-git-identity && node scripts/package-all.mjs` 通过（含 `context-viewer v1.7.9` 6/6 自检及 `H2`/`H3`/`H4`/前端慢历史用例、`agy-finder v0.2.7` 全套自检、全仓隐私扫描与 Git noreply 身份门禁；生成 `agy-finder-v0.2.7.zip` 90.4 KB、`context-viewer-v1.7.9.zip` 171.2 KB，SHA-256 `807b03c8e40f98f8d2ad4a5aff77726cfb6322a12a6cc845c5cd0df2152785e2`）。时间：`2026-11-15 01:01`（Asia/Shanghai）。
- 第九轮复查：`node scripts/verify.mjs --strict-git-identity` 通过；HEAD 临时副本打包及两份 ZIP 完整性／校验和通过。独立探针确认 X1／X2 原始场景恢复（18 个内联模型会话 0 次 metadata RPC、5 ms 返回；18 个缺模型会话 355 ms 返回后后台补齐并更新 ETag），另复现上述 Y1。时间：`2026-11-15 00:47`（Asia/Shanghai）。
- `./install.sh` 本机热升级验收：通过（`~/.gemini/config/plugins/context-viewer` 升级至 `1.7.9`，`agy-finder` 保持 `0.2.7`，`~/.local/bin/agy-context --help` 输出 `v1.7.9`，`agy-context json` 返回正常）。时间：`2026-11-15 00:38`（Asia/Shanghai）。
- `node scripts/verify.mjs --strict-git-identity && node scripts/package-all.mjs`：通过（含全仓隐私扫描、PNG 元数据块 audit、`context-viewer v1.7.9` 6/6 自检与 `H2`/`H3`/前端慢历史用例、`agy-finder v0.2.7` 全套自检、跨插件锁校验与双插件发布包 `agy-finder-v0.2.7.zip` 90.4 KB / `context-viewer-v1.7.9.zip` 170.6 KB）。时间：`2026-11-15 00:30`（Asia/Shanghai）。
- `node scripts/verify.mjs --strict-git-identity`：通过；发布标签提交与 HEAD 分别在临时副本执行 `node scripts/package-all.mjs`，两组 ZIP 完整性与校验和通过，标签重建摘要与发布资产一致。独立模拟探针复现上述两项 P2；18 个会话的 metadata 超时令历史采集等待约 13.5 秒。时间：`2026-11-14 23:33`（Asia/Shanghai）。
- `node scripts/verify.mjs --strict-git-identity && node scripts/package-all.mjs`：通过（含全仓隐私扫描、PNG 元数据块 audit、`context-viewer v1.7.8` 6/6 自检、`agy-finder v0.2.7` 全套自检、跨插件锁校验与双插件 ZIP 发布包生成 `agy-finder-v0.2.7.zip` 90.4 KB / `context-viewer-v1.7.8.zip` 167.3 KB），时间：`2026-11-14 22:51`（Asia/Shanghai）。
- `RELEASE_REF=v2026.11.14.6` 实机发布验收（`./install.sh` 热升级、双池与 5,505 次请求实机数据）：见历史提交 `v2026.11.14.6`，时间：`2026-11-14 20:49`（Asia/Shanghai）。
