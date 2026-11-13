# agy-plugins ROADMAP

更新时间：2026-11-13 22:17（Asia/Shanghai）。

## 本次交付目标

1. 已完成开源插件合集仓库 `Dong-Kevin/agy-plugins` 初始化、双插件迁移与交接。
2. 文档与截图升级：将总仓标题统一为 `# AGY Plugins`，补齐双插件桌面快捷键 / 对话入口 / CLI 快捷命令速查，将「让 Antigravity Agent 协助安装」设为快速安装首选，并新增 3 张零隐私泄露的 `agy-finder` 截图及刷新定制抽屉截图。
3. 双快捷键与 AGY 右侧辅助栏稳定性修复（`context-viewer v1.7.1` / `agy-finder v0.2.1`）：
   - 解决 `Overview` 态（右侧栏折叠）、跨会话 `Pin Tab` 及跨插件切换时无法自动开栏/切回的问题：将 `isAuxIframeVisible()` 改为跨同源/跨源顶层视口 `IntersectionObserver({ root: null })` 实测几何交集，彻底消除 Blink `display: none` 预热 iframe 假阳性抢占；将唤醒退避迁至本地 Node 端 `holdMs` 参数规避隐藏 iframe `DOMTimer` 节流；兼容跨会话 `Pin Tab` 标签并支持前端静态资源热重载重启。

## 当前阶段与状态

- **已完成**：
  - 仓库初始化与本地安全隔离：完成 `git init -b main`、绑定远端 `origin`、锁定仓库级 `Dong-Kevin` 与 GitHub `noreply` 提交身份，配置 `.gitignore`、`LICENSE` 及仓库管理的 `scripts/pre-push` -> `.git/hooks/pre-push` 门禁。
  - 双插件双快捷键与 Aux Pane 直达修复升级：
    - `plugins/agy-context-viewer/`（`context-viewer v1.7.1`）：`app.js` 改用 `IntersectionObserver`（`intersectionRect > 40px` + `agy_aux_ever_visible` 优先权）判定真实可见性，取消 `window.innerWidth > 40` 在 `display: none` 预热槽中的误判，并打通 `Pin Tab` 跨会话在屏切换与 Node 端 `holdMs` 无节流唤醒；`main.mjs` 新增 `/api/aux-pane-trigger` `holdMs` 支持及 `app.js` / `styles.css` / `index.html` 热重载监听；`collector.mjs` 维持 `viewBatchMs`/`viewWinnerId` 消歧与后台 `mtimeMs` 防劫持；`float_window.mjs` 调整 `720ms + 750ms` 复检与 HUD 提示；`scripts/verify.mjs` 补充 `IntersectionObserver` / `holdMs` 防回归断言。
    - `plugins/agy-finder/`（`agy-finder v0.2.1`）：`app.js` 与 `main.mjs` 同步 `IntersectionObserver` 真可见性判定、`holdMs` 无节流唤醒、`Pin Tab` 跨会话支持及静态资源热重载监听，并完整保留 `revealPath` 定位链路；`drawer.mjs` 维持 `isSubagentTranscriptHead` / `viewBatchMs` 消歧与 `720ms + 750ms` 复检 HUD；`scripts/verify.mjs` 新增 `holdMs=20` 环回 HTTP 检查与前端防回归断言。
    - 文档与打包验证：全仓重新打包生成 `agy-finder-v0.2.1.zip` 与 `context-viewer-v1.7.1.zip`。
    - 本地安装升级与实机验收：已运行 `./install.sh` 将本机插件热升级至 `context-viewer v1.7.1`（保留用户自定义侧栏键 `⌃K` / `Ctrl+K`）与 `agy-finder v0.2.1`（`⇧⌘E` / `⌥⌘E` 就绪），守护进程与宿主 Sidecar 均已自动重启加载新版；Antigravity 桌面端前台实机验证通过（含 `Overview` 折叠态自动开栏、自定义 `⌃K` / `⌥⌘E`、跨插件与跨会话 `Pin Tab` 切换）。
- **跨平台待测项**：
  - `agy-finder` 与 `agy-context-viewer` 的 Windows PowerShell 5.1 / 7 + `cmd.exe`、Linux 桌面端及 `Node.js 18` 最低版本尚未在对应宿主机实机运行。

## 关键入口

- 仓库总览：[README.md](./README.md) / [README_EN.md](./README_EN.md)
- 开发与发布约束：[AGENTS.md](./AGENTS.md)
- 统一安装脚本：[install.sh](./install.sh) / [install.ps1](./install.ps1)
- 全仓校验与打包：[scripts/verify.mjs](./scripts/verify.mjs) / [scripts/package-all.mjs](./scripts/package-all.mjs)
- 已迁移插件：[plugins/agy-finder](./plugins/agy-finder) 、[plugins/agy-context-viewer](./plugins/agy-context-viewer)

## 最近验证

- `node scripts/verify.mjs --strict-git-identity`：通过（含仓库结构与语法、官方 Schema 与唯一性、全仓隐私/PNG/noreply 门禁、`agy-context-viewer` v1.7.1 6/6 阶段、`agy-finder` v0.2.1 8/8 项含 `holdMs` 与 `IntersectionObserver` 防回归、统一 `install.sh` 隔离安装/卸载），时间：`2026-11-13 22:17`（Asia/Shanghai）。
- `RELEASE_REF=v2026.11.13 node scripts/package-all.mjs && (cd dist && shasum -a 256 -c *.sha256)`：通过，构建 `dist/agy-finder-v0.2.1.zip` 与 `dist/context-viewer-v1.7.1.zip` 及 `.sha256` 校验通过（`OK`），时间：`2026-11-13 22:17`（Asia/Shanghai）。
- `./install.sh` + 实机守护与宿主 Sidecar 检查：通过，本机已热升级为 `context-viewer v1.7.1`（`daemonVersion: 7`，`daemonBuildId: 938e533c504cd7ad`，`⌥⌘K` / 已保留 `⌃K` 就绪）与 `agy-finder v0.2.1`（`daemonVersion: 2`，`daemonBuildId: be0fcd3f8b842d72`，`⇧⌘E` / `⌥⌘E` 就绪），用户已在 macOS Antigravity 桌面端确认可用，时间：`2026-11-13 20:47`（Asia/Shanghai）。
