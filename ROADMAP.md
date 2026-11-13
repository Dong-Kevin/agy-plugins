# agy-plugins ROADMAP

更新时间：2026-11-13 14:18（Asia/Shanghai）。

## 本次交付目标

初始化统一的开源插件合集仓库 `Dong-Kevin/agy-plugins`（绑定远端 `https://github.com/Dong-Kevin/agy-plugins.git`），完成 `agy-finder`（`v0.1.0`）与 `agy-context-viewer`（`context-viewer` `v1.6.3`）向 `plugins/` 目录的迁移、统一安装/校验/打包基础设施建设、双语文档编写，以及与原独立项目目录的文档交接。

## 当前阶段与状态

- **已完成**：
  - 仓库初始化与本地安全隔离：完成 `git init -b main`、绑定远端 `origin`、锁定仓库级 `Dong-Kevin` 与 GitHub `noreply` 提交身份，配置 `.gitignore`、`LICENSE` 及仓库管理的 `scripts/pre-push` -> `.git/hooks/pre-push` 门禁。
  - 插件迁移与官方规范对齐：
    - `plugins/agy-finder/`（`v0.1.0`）：补全 `$schema`、`homepage` 与字符串 `repository` 字段；升级 `install.sh` 与 `install.ps1` 同时支持本地克隆与 `Dong-Kevin/agy-plugins` 远程一键下载安装；补充英文 `README_EN.md`；调整 `scripts/verify.mjs` 适配单仓与合集两种根目录结构。
    - `plugins/agy-context-viewer/`（`context-viewer` `v1.6.3`，基线 `2b1ba84`）：完整保留 `sidecars/dashboard/`、`skills/` 与已脱敏的 8 张 `docs/images/*.png` 截图（不迁入内部 `docs/CODEX_REVIEW_*.md` 审查草稿）；对齐 `plugin.json`、`install.sh`、`install.ps1`、`scripts/verify.mjs`、`scripts/package-release.mjs` 与中英文 `README`。
  - 统一仓库基础设施与文档：完成根目录中英文 `README.md` / `README_EN.md`、`AGENTS.md`、`ROADMAP.md`、统一安装器 `install.sh` / `install.ps1`、全仓校验套件 `scripts/verify.mjs` 与零依赖发行包构建脚本 `scripts/package-all.mjs`。
  - 原项目文档交接：已在原 `../agy-finder` 与 `../agy-context-viewer` 目录同步更新迁移声明、清理个人路径并复核各自验证套件。
  - 首次开源提交与推送：已获用户授权执行 `main` 分支首次提交并推送至 `origin/main`（通过 `pre-push` 隐私身份门禁）。
- **跨平台 / 交互待测项（继承自原项目）**：
  - `agy-finder` 与 `agy-context-viewer` 的 Windows PowerShell 5.1 / 7 + `cmd.exe`、Linux 桌面端及 `Node.js 18` 最低版本尚未在对应宿主机实机运行。
  - `agy-finder` 在 Antigravity 桌面端按 `⌘⇧E` 及点击对话 `[📂]` 链接的前端交互体验仍待用户实机确认。
- **待授权外部操作**：
  - 后续如需打 `git tag`、发布 GitHub Release 或归档旧独立仓库，待明确授权后执行。

## 关键入口

- 仓库总览：[README.md](./README.md) / [README_EN.md](./README_EN.md)
- 开发与发布约束：[AGENTS.md](./AGENTS.md)
- 统一安装脚本：[install.sh](./install.sh) / [install.ps1](./install.ps1)
- 全仓校验与打包：[scripts/verify.mjs](./scripts/verify.mjs) / [scripts/package-all.mjs](./scripts/package-all.mjs)
- 已迁移插件：[plugins/agy-finder](./plugins/agy-finder) 、[plugins/agy-context-viewer](./plugins/agy-context-viewer)

## 最近验证

- `node scripts/verify.mjs --strict-git-identity`：通过（含仓库结构与语法、插件官方 Schema 与唯一性、全仓隐私/PNG/noreply 门禁、`agy-context-viewer` 6/6 阶段、`agy-finder` 8/8 项及根目录 `install.sh` 隔离安装/卸载冒烟测试），时间：`2026-11-13 14:15`（Asia/Shanghai）。
- `node scripts/package-all.mjs` + `shasum -a 256 -c`：通过，生成 `dist/agy-finder-v0.1.0.zip`（59.9 KB，20 个文件）与 `dist/context-viewer-v1.6.3.zip`（152.4 KB，20 个文件）且 SHA-256 校验通过，时间：`2026-11-13 14:15`（Asia/Shanghai）。
- 原仓库交接复核：`../agy-context-viewer` 运行 `node scripts/verify.mjs --strict-git-identity`（6/6 阶段通过），`../agy-finder` 在隔离宿主会话环境变量后运行 `node scripts/verify.mjs`（8/8 项通过），时间：`2026-11-13 14:15`（Asia/Shanghai）。
