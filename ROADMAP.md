# agy-plugins ROADMAP

更新时间：2026-11-13 17:21（Asia/Shanghai）。

## 本次交付目标

1. 已完成开源插件合集仓库 `Dong-Kevin/agy-plugins` 初始化、双插件迁移与交接。
2. 文档与截图升级：将总仓标题统一为 `# AGY Plugins`，补齐双插件桌面快捷键 / 对话入口 / CLI 快捷命令速查，将「让 Antigravity Agent 协助安装」设为快速安装首选，并新增 3 张零隐私泄露的 `agy-finder` 截图及刷新定制抽屉截图。
3. 双快捷键自定义升级（独立窗口 + AGY 右侧辅助栏直达）：保留独立浮窗/抽屉快捷键（`context-viewer` `⌥⌘K` / `agy-finder` `⌘⇧E`），新增可自定义快捷键一键唤醒并切换 Antigravity 原生右侧辅助栏直达 **上下文看板**（`⌃⌥K` / `agy-context aux`）或 **项目目录树**（`⌥⌘E` / `agy-finder aux`），均支持面板点击录制、作用域切换与碰撞拦截。

## 当前阶段与状态

- **已完成**：
  - 仓库初始化与本地安全隔离：完成 `git init -b main`、绑定远端 `origin`、锁定仓库级 `Dong-Kevin` 与 GitHub `noreply` 提交身份，配置 `.gitignore`、`LICENSE` 及仓库管理的 `scripts/pre-push` -> `.git/hooks/pre-push` 门禁。
  - 双插件双快捷键与 Aux Pane 直达升级：
    - `plugins/agy-context-viewer/`（`context-viewer` `v1.6.3` -> `v1.7.0`）：扩展双 Carbon 原生热键（独立悬浮窗 `⌥⌘K` + AGY 侧栏看板 `⌃⌥K`）、面板双点击录制开关与作用域切换、共享触发总线与 `startAuxPaneBridgeCoordinator()`、CLI `aux` / `aux-shortcut` 命令、修复 `syncFloatButtonUi()` 未定义变量并刷新 `@2x` 无元数据 `docs/images/customizer-drawer.png`。
    - `plugins/agy-finder/`（`agy-finder` `v0.1.0` -> `v0.2.0`）：升级 `native_drawer_macos.swift` 与 `drawer.mjs` 支持双 Carbon 原生热键（独立抽屉 `⌘⇧E` + AGY 侧栏目录树 `⌥⌘E`）、点击录制自定义快捷键与碰撞校验、`startAuxPaneBridgeCoordinator()`、`agy-finder aux` / `shortcut` / `aux-shortcut` CLI 命令、`install.sh` 安装热升级守护支持，并刷新 `@2x` 无元数据 `docs/images/finder-shortcuts.png`。
    - 文档与安装器同步：更新中英文 `README.md` / `README_EN.md`、双 `SKILL.md` 及安装提示，补齐验证隔离守卫（`AGY_CONTEXT_VIEWER_DISABLE_DAEMON`）并清理 `package-all.mjs` 旧版打包残留。
    - 本地安装升级与提交推送：已运行 `./install.sh` 将本机插件目录升级至 `agy-finder v0.2.0`（守护已上线，双热键 `⇧⌘E` / `⌥⌘E` 就绪）与 `context-viewer v1.7.0`（守护已上线，双热键 `⌥⌘K` / `⌃⌥K` 就绪），并提交推送至 `origin/main`。
- **待授权外部操作**：
  - 后续如需打 `git tag` 或发布 GitHub Release，待明确授权后执行。
- **跨平台 / 交互待测项**：
  - `agy-finder` 与 `agy-context-viewer` 的 Windows PowerShell 5.1 / 7 + `cmd.exe`、Linux 桌面端及 `Node.js 18` 最低版本尚未在对应宿主机实机运行。
  - 更新后双插件在 Antigravity 桌面端按 `⌃⌥K` / `⌥⌘E` 实际唤醒宿主右侧辅助栏的端到端桌面交互待用户实机体验确认。

## 关键入口

- 仓库总览：[README.md](./README.md) / [README_EN.md](./README_EN.md)
- 开发与发布约束：[AGENTS.md](./AGENTS.md)
- 统一安装脚本：[install.sh](./install.sh) / [install.ps1](./install.ps1)
- 全仓校验与打包：[scripts/verify.mjs](./scripts/verify.mjs) / [scripts/package-all.mjs](./scripts/package-all.mjs)
- 已迁移插件：[plugins/agy-finder](./plugins/agy-finder) 、[plugins/agy-context-viewer](./plugins/agy-context-viewer)

## 最近验证

- `node scripts/verify.mjs --strict-git-identity`：通过（含仓库结构与语法、官方 Schema 与唯一性、全仓隐私/PNG/noreply 门禁、`agy-context-viewer` v1.7.0 6/6 阶段、`agy-finder` v0.2.0 8/8 项及根目录 `install.sh` 隔离安装/卸载冒烟测试），时间：`2026-11-13 17:20`（Asia/Shanghai）。
- `node scripts/package-all.mjs` + `(cd dist && shasum -a 256 -c *.sha256)`：通过，生成 `dist/agy-finder-v0.2.0.zip`（`75.7 KB`）与 `dist/context-viewer-v1.7.0.zip`（`161.7 KB`）及各自 `.sha256` 校验通过（`OK`），时间：`2026-11-13 17:21`（Asia/Shanghai）。
- `./install.sh` + 实机安装核对：通过，本机已加载 `agy-finder v0.2.0`（`daemonVersion: 2`，`⇧⌘E` / `⌥⌘E` 就绪）与 `context-viewer v1.7.0`（`daemonVersion: 7`，`⌥⌘K` / `⌃⌥K` 就绪），时间：`2026-11-13 17:21`（Asia/Shanghai）。
