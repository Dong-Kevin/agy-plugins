# agy-plugins ROADMAP

更新时间：2026-11-14 20:49（Asia/Shanghai）。

## 本次交付目标

1. 发布 `v2026.11.14.6` 配额池语义化合并、历史步骤模型归因补全与失真 Credits 清理版（`agy-finder v0.2.7` / `context-viewer v1.7.8`）：
   - 将受同一 Gemini 共享池约束的 `Gemini 4 Hydrogen`（含 `Low` / `Medium` / `High` / `XHigh`）及后续 Gemini 型号稳定合并进单一 **`Gemini 模型`** 配额池，与 **`非 Gemini 模型（Claude / GPT）`** 并列展示（保留成员档位悬浮明细）。
   - 自动并发回溯宿主 `GetCascadeTrajectoryGeneratorMetadata` 并持久化零隐私步骤模型缓存，消除未点开历史会话产生的「未记录模型归档请求」，并合并同一未收录单价模型的推理强度后缀。
   - 移除服务端恒定不变的遗留静态占位字段 `Prompt Credits` / `Flow Credits`。

## 当前阶段与状态

- **已完成（`v2026.11.14.6` 发布就绪）**：
  - **配额池统一与模型归因优化（[pricing.mjs](./plugins/agy-context-viewer/sidecars/dashboard/pricing.mjs)）**：
    - 定义统一推理强度后缀正则 `EFFORT_SUFFIX_RE`（覆盖 `XHigh` / `Minimal` / `Low` / `Medium` / `High` / `Thinking` / `Fast`），修复 `resolveConfigSummaryGroup()`、`buildQuotaPools()` 与 `resolveModelQuota()` 中 `(XHigh)` 漏匹配导致的拆池问题。
    - 子族标签 `extractSubfamilyTags()` 仅解析配额组标识字段（`displayName` + `bucketId`），不再被说明文案 `description` 中的示例模型列表误导；扩展 `hydrogen` 识别与品牌回退逻辑，并为单品牌总池生成语义化 `displayTitle` / `shortLabel`（`Gemini 模型` / `非 Gemini 模型（Claude / GPT）`）。
    - 补齐 `MODEL_PLACEHOLDER_M322` -> `gemini-3.8-flash` 映射，并在 `summarizeApiCost()` 中剥离未收录单价模型的强度后缀（如 `Gemini 4 Hydrogen (XHigh)` / `(High)` 合并为单一 `Gemini 4 Hydrogen` 行），同时保持 `Gemini Flash` / `Orchestrator (Carbon)` / `Gemini 4 Hydrogen` 在 Hybrid 模式下按基准折算（满足 `S4` 约束）。
  - **历史会话步骤模型并发回溯与离线缓存（[collector.mjs](./plugins/agy-context-viewer/sidecars/dashboard/collector.mjs)）**：
    - `collectTokenHistory()` 在语言服务可达时按最多 6 并发增量拉取未缓存历史会话的 `GetCascadeTrajectoryGeneratorMetadata`，并将零隐私 `{ size, mtimeMs, steps }` 映射原子写入插件数据目录 `gen_step_models_v1.json`（`scanConversation()` 同步维护，`lsGenMissCache` 60s 避免未知会话重复轮询），确保在线与离线 CLI 模式均保持 `missingModel: 0`。
  - **界面清理、版本同步与回归测试**：
    - [app.js](./plugins/agy-context-viewer/sidecars/dashboard/app.js) 移除 `Prompt Credits` 与 `Flow Credits` 展示行及 `fmtCredit`，[float_window.mjs](./plugins/agy-context-viewer/sidecars/dashboard/float_window.mjs) 与 [cli.mjs](./plugins/agy-context-viewer/sidecars/dashboard/cli.mjs) 适配 `shortLabel` / `displayTitle`；同步升级 `context-viewer` 版本至 `1.7.8`（`plugin.json`、`index.html`、`cli.mjs` 及根目录与插件中英文 README，并清理 `Prompt / Flow Credits` 文档提及）。
    - [plugins/agy-context-viewer/scripts/verify.mjs](./plugins/agy-context-viewer/scripts/verify.mjs) 新增 `Q1`（`Hydrogen`/`XHigh` 并池、语义标题、Credits 移除与强度后缀合并）与 `H1`（未访问历史会话自动回溯 `GeneratorMetadata` 与离线缓存命中）回归测试。
  - **本机热升级与实机数据验收**：执行 `LC_ALL=C node scripts/package-all.mjs && ./install.sh` 完成本地打包与热升级（`context-viewer` 1.7.8 / `agy-finder` 0.2.7，零 `[WARN]`，守护进程 PID 83044 运行正常），并通过真实 `~/.local/bin/agy-context --json --full` 验证：配额池收敛为 2 池（`Gemini 模型` 15 档 / `非 Gemini 模型（Claude / GPT）` 7 档），全量 5,505 次请求 `missingModel: 0`；macOS 桌面端看板 UI 已由用户实测确认。
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

- `node scripts/verify.mjs --strict-git-identity`：通过（含 `context-viewer v1.7.8` 6/6 自检、`Q1` 配额池语义合并与 Credits 清理、`H1` 历史步骤模型回溯与离线缓存持久化、`agy-finder` 自检、隐私扫描与 Git noreply 身份门禁），时间：`2026-11-14 20:49`（Asia/Shanghai）。
- `RELEASE_REF=v2026.11.14.6 LC_ALL=C node scripts/package-all.mjs && (cd dist && ls -lh agy-finder-v0.2.7.zip context-viewer-v1.7.8.zip && unzip -t agy-finder-v0.2.7.zip >/dev/null && unzip -t context-viewer-v1.7.8.zip >/dev/null && LC_ALL=C shasum -a 256 -c agy-finder-v0.2.7.zip.sha256 context-viewer-v1.7.8.zip.sha256)`：通过，生成 `dist/agy-finder-v0.2.7.zip`（94.0 KB，20 个文件）与 `dist/context-viewer-v1.7.8.zip`（179.3 KB，20 个文件），ZIP 完整性与 SHA-256 校验均 `OK`，时间：`2026-11-14 20:49`（Asia/Shanghai）。
- `./install.sh && ~/.local/bin/agy-context float status --json && ~/.local/bin/agy-context --json --full`：通过，零 `[WARN]` 完成本机热升级（`daemonRunning: true`，PID `83044`），`quotasCount=2`（`Gemini 模型` 15 档、`非 Gemini 模型（Claude / GPT）` 7 档），`unpricedReasons={"missingModel":0,"unsupportedModel":3343,"missingUsage":0}`，时间：`2026-11-14 20:34`（Asia/Shanghai）。
