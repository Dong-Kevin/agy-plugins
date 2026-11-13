# agy-plugins 仓库开发与发布约定

本文件补充全局 `~/.agents/AGENTS.md`，仅记录本开源插件合集仓库稳定且关键的架构与校验约束。

## 仓库定位与目录边界

- 本仓库（`https://github.com/Dong-Kevin/agy-plugins`）为各开源 Antigravity 插件的统一源码与发布入口；各插件独立存放在 `plugins/<plugin-dir>/` 下，互不耦合。
- **插件目录**：
  - [plugins/agy-finder](./plugins/agy-finder)：目录树定位插件（`name: "agy-finder"`），安装目标目录为 `~/.gemini/config/plugins/agy-finder`。
  - [plugins/agy-context-viewer](./plugins/agy-context-viewer)：上下文与 Token 看板插件（`name: "context-viewer"`），安装目标目录保持 `~/.gemini/config/plugins/context-viewer` 以兼容既有用户偏好设置与本地归档路径。
- **统一入口**：根目录 [install.sh](./install.sh)、[install.ps1](./install.ps1)、[scripts/verify.mjs](./scripts/verify.mjs)、[scripts/package-all.mjs](./scripts/package-all.mjs) 与 [scripts/pre-push](./scripts/pre-push)。

## 不可破坏的技术约束

1. **官方插件清单规范**：每个 `plugins/<dir>/plugin.json` 必须符合 `https://antigravity.google/schemas/v1/plugin.json`，顶层仅使用官方支持字段；`repository` 必须为字符串 `"https://github.com/Dong-Kevin/agy-plugins"`（不可使用对象格式），`name` 与 `skills/<skill>/` 名称全仓全局唯一。
2. **宿主合规边界**：严禁在脚本或运行时代码中直接修改 `~/.gemini/config/config.json` 或 `Antigravity.app` 的 `app.asar`；不注入 CDP；`rules/AGENTS.md` 必须保持纯 Markdown（禁止 YAML frontmatter）。
3. **样式隔离与零外链**：每个 Sidecar 的 CSS 自定义属性必须使用独立前缀（`agy-finder` 为 `--af-*`，`context-viewer` 为 `--cv-*`，新插件须使用各自唯一前缀），避免与宿主注入的 `--muted`、`--accent`、`--border` 等变量冲突；前端 HTML / CSS 禁止引用外部 `http(s)://` 静态资源。
4. **零外部运行时依赖**：所有插件、安装器、校验与打包脚本仅使用 `Node.js >= 18` 标准库及系统原生能力，不引入 `node_modules`。
5. **安全安装与热更新**：安装脚本必须在系统临时目录完成文件暂存，并最后原子移动替换 `sidecar.json`，避免宿主 `SidecarManager` 扫描到半成品目录；隔离环境变量测试（`AGY_PLUGINS_DIR` / `ANTIGRAVITY_PLUGINS_DIR`）时不得触碰本机正在运行的宿主守护进程。
6. **开源隐私与 Git 身份门禁**：仓库局部 Git 身份必须锁定为 `Dong-Kevin` 与 GitHub `noreply` 邮箱；严禁提交个人主目录路径、未脱敏邮箱、凭据、真实会话 UUID 或未剥离元数据块的 PNG 截图，且不将内部审查草稿合入公开仓库。

## 改动与发布前必跑检查

```bash
node scripts/verify.mjs --strict-git-identity
node scripts/package-all.mjs
```
