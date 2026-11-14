# agy-plugins ROADMAP

更新时间：2026-11-14 22:59（Asia/Shanghai）。

## 本次交付目标

1. 在全仓精简版 README 中保留并还原独立的开源致谢章节（`## 致谢` / `## Acknowledgements`），并修正插件内 `./LICENSE` 相对链接。

## 当前阶段与状态

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

- `node scripts/verify.mjs --strict-git-identity && node scripts/package-all.mjs`：通过（含全仓隐私扫描、PNG 元数据块 audit、`context-viewer v1.7.8` 6/6 自检、`agy-finder v0.2.7` 全套自检、跨插件锁校验与双插件 ZIP 发布包生成 `agy-finder-v0.2.7.zip` 90.4 KB / `context-viewer-v1.7.8.zip` 167.3 KB），时间：`2026-11-14 22:51`（Asia/Shanghai）。
- `RELEASE_REF=v2026.11.14.6` 实机发布验收（`./install.sh` 热升级、双池与 5,505 次请求实机数据）：见历史提交 `v2026.11.14.6`，时间：`2026-11-14 20:49`（Asia/Shanghai）。
