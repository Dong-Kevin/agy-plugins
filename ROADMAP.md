# agy-plugins ROADMAP

更新时间：2026-11-13 14:55（Asia/Shanghai）。

## 本次交付目标

1. 已完成开源插件合集仓库 `Dong-Kevin/agy-plugins` 初始化、双插件迁移与交接。
2. 文档与截图升级：将总仓标题统一为 `# AGY Plugins`，补齐双插件桌面快捷键 / 对话入口 / CLI 快捷命令速查，将「让 Antigravity Agent 协助安装」设为快速安装首选，并新增 3 张零隐私泄露的 `agy-finder` 截图及刷新含 `⌥⌘K` 快捷键录制的 `context-viewer` 定制抽屉截图。

## 当前阶段与状态

- **已完成**：
  - 仓库初始化与本地安全隔离：完成 `git init -b main`、绑定远端 `origin`、锁定仓库级 `Dong-Kevin` 与 GitHub `noreply` 提交身份，配置 `.gitignore`、`LICENSE` 及仓库管理的 `scripts/pre-push` -> `.git/hooks/pre-push` 门禁。
  - 插件迁移与官方规范对齐：
    - `plugins/agy-finder/`（`v0.1.0`）：补全 `$schema`、`homepage` 与字符串 `repository` 字段；升级 `install.sh` 与 `install.ps1`；新增 `docs/images/{finder-tree-reveal.png,finder-shortcuts.png,finder-quick-preview.png}`（2x 视网膜画质并已剥离 PNG 元数据块）。
    - `plugins/agy-context-viewer/`（`context-viewer` `v1.6.3`，基线 `2b1ba84`）：保留全套组件与 8 张脱敏截图，并刷新 `docs/images/customizer-drawer.png` 以展示 `侧栏看板快捷键（⌥⌘K 点击修改）` 与生效范围控件。
  - 文档与打包升级：
    - 更新根目录及两个子插件的中英文 `README.md` / `README_EN.md`（H1 精简为 `# AGY Plugins`、突出快捷键与 CLI 速查表、首选 Agent 协助安装提示词、内嵌 `agy-finder` 预览图）。
    - 更新 `scripts/package-all.mjs` 为 `agy-finder` 发布包内的 README 自动重写在线 `docs/images/` 链接。
  - 开源提交与推送：已完成 `main` 分支首次开源提交（`e06cedc`）及本轮文档、快捷命令与脱敏截图升级提交（推送至 `origin/main`）。
- **待授权外部操作**：
  - 后续如需打 `git tag`、发布 GitHub Release 或归档旧独立仓库，待明确授权后执行。
- **跨平台 / 交互待测项（继承自原项目）**：
  - `agy-finder` 与 `agy-context-viewer` 的 Windows PowerShell 5.1 / 7 + `cmd.exe`、Linux 桌面端及 `Node.js 18` 最低版本尚未在对应宿主机实机运行。
  - `agy-finder` 在 Antigravity 桌面端按 `⌘⇧E` 及点击对话 `[📂]` 链接的前端交互体验仍待用户实机确认。

## 关键入口

- 仓库总览：[README.md](./README.md) / [README_EN.md](./README_EN.md)
- 开发与发布约束：[AGENTS.md](./AGENTS.md)
- 统一安装脚本：[install.sh](./install.sh) / [install.ps1](./install.ps1)
- 全仓校验与打包：[scripts/verify.mjs](./scripts/verify.mjs) / [scripts/package-all.mjs](./scripts/package-all.mjs)
- 已迁移插件：[plugins/agy-finder](./plugins/agy-finder) 、[plugins/agy-context-viewer](./plugins/agy-context-viewer)

## 最近验证

- `node scripts/verify.mjs --strict-git-identity`：通过（含仓库结构与语法、插件官方 Schema 与唯一性、全仓隐私/PNG/noreply 门禁、`agy-context-viewer` 6/6 阶段、`agy-finder` 8/8 项及根目录 `install.sh` 隔离安装/卸载冒烟测试），时间：`2026-11-13 14:45`（Asia/Shanghai）。
- `node scripts/package-all.mjs` + `shasum -a 256 -c`：通过，生成 `dist/agy-finder-v0.1.0.zip`（与 `dist/context-viewer-v1.6.3.zip` 并完成在线截图链接重写与 SHA-256 校验），时间：`2026-11-13 14:45`（Asia/Shanghai）。
- 原仓库交接复核：`../agy-context-viewer` 运行 `node scripts/verify.mjs --strict-git-identity`（6/6 阶段通过），`../agy-finder` 在隔离宿主会话环境变量后运行 `node scripts/verify.mjs`（8/8 项通过），时间：`2026-11-13 14:15`（Asia/Shanghai）。
