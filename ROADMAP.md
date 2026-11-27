# agy-plugins ROADMAP

更新时间：2026-11-27 14:56（Asia/Shanghai）。

## 本次交付目标

1. 完成三插件全系安全自动更新接入（`agy-finder v0.3.0` 顶栏/设置面板/零 CLS 浮层 + 三端热重载 + `agy-finder update`，`agy-cli-hud v0.1.0` 按需 `agy-hud update`，`context-viewer v1.10.0` 保持既有全链路自动更新），统一升级中英 README 并正式发布 **`v2026.11.27`** GitHub Release。
2. 保持三插件全仓严格校验（`node scripts/verify.mjs --strict-git-identity`）与独立发布打包（`node scripts/package-all.mjs`）全部通过并同步推送 `main` 与 Release 标签。

## 后置与挂起事项

- **挂起：`agy-fork` / `agy-session`（`agy` CLI 无损会话分叉插件）**：调研确认底层依赖宿主 `ForkConversation` / `UpdateConversationAnnotations` RPC（需处理 `invoke_subagent` 前轮回退），但经 boss 确认当前非刚需且预计官方原生推出，暂挂起不立项。
- **跨平台与未实测项**：Windows PowerShell 5.1 / 7（本机无 `pwsh`，`.ps1` 改动通过 JS 语法扫描但未在 Windows 实机验收）、Linux 桌面端、`Node.js 18` 最低版本。

## 近期里程碑（滚动 5 条）

- **2026-11-27 · `v2026.11.27` 发版、全系安全自动更新接入与中英 README 同步**：为 `agy-finder` 升级至 `v0.3.0` 并补齐零依赖 `updater.mjs`（HTTPS 白名单/SHA-256/CRC-32/Zip-Slip/临时目录原子替换）、Sidecar/Standalone/macOS 抽屉热重载、顶栏/设置面板/零 CLS 浮层与 `agy-finder update`；为 `agy-cli-hud v0.1.0` 补齐按需动态加载的 `agy-hud update`；将 `context-viewer` 升级至 `v1.10.0`；全面同步根仓库与三插件共 8 份中英 README 并发布 `v2026.11.27` GitHub Release。详录见 [2026-11-p4.md](./docs/log/2026-11-p4.md#2026-11-27-全系自动更新与发版)。
- **2026-11-27 · `agy-cli-hud` 主题、防强杀、精确计时与今日周耗升级（已推送 `a425638`）**：重构 6 套克制主题与 `theme` 命令；默认启用 Solo 异步旁路 + `agy-hud render` 免疫旧版快渲染截胡并压缩 `>24h` 增量缓存；引入 `sqlite_timing.mjs` 修复 `t/s` 虚高；上线每池今日周耗账本（日内重置 `↻`、8 分钟心跳保活零点桥接、联动桌面端 `host_status_cache_v1.json` 同日早锚回填与 `+` 透明缺口标注）及 1/2/3 行 CJK 防折行矩阵。详录见 [2026-11-p4.md](./docs/log/2026-11-p4.md#2026-11-27-agy-cli-hud-体验与周耗升级)。
- **2026-11-26 · 新增 `agy-cli-hud v0.1.0` 轻量 CLI 与 Solo 遥测插件（已推送 `dd636ce`）**：新建零依赖 [plugins/agy-cli-hud](./plugins/agy-cli-hud)（`agy-hud`），实现增量 JSONL 字节游标今日/本月/7 日与会话平均缓存滚存、API 零售分段折算与订阅杠杆、Gemini/非 Gemini 双池 5h/周剩余额度、合规 OAuth 2.0 PKCE + 官方 Colab REST 算力监控（零 CDP）、原子共享快照 `usage-hud.v1.json` / `<4 KB` 摘要与 Solo 零冲突共存分层底栏，并接入总仓 `verify.mjs` / `package-all.mjs` / 统一安装器。详录见 [2026-11-p4.md](./docs/log/2026-11-p4.md#2026-11-26-新增-agy-cli-hud)。
- **2026-11-25 · `agy-context-viewer` 热力图右侧今日色块裁切修复（已推送 `4f48b29`）**：根因系悬停展开 `#day-inspector` 触发 8px 纵向滚动条挤压 `#chart-stage` 且右内边距被溢出忽略；以 `scrollbar-gutter: stable`、子元素承接左右留白及 `ResizeObserver` 贴右保活根治，补齐 R2 回归并完成本机热同步。详录见 [2026-11-p4.md](./docs/log/2026-11-p4.md#2026-11-25-热力图裁切修复)。
- **2026-11-25 · `agy-context-viewer` 版本更新提示与一键自动更新（已推送 `4f48b29`）**：新建零依赖 [updater.mjs](./plugins/agy-context-viewer/sidecars/dashboard/updater.mjs)（HTTPS 白名单含重定向、SHA-256、CRC-32/Zip-Slip 防护、临时目录原子替换与 `.git` 源码保护），打通三端热重载、顶栏/抽屉/零 CLS 浮层与 `verifyAutoUpdater` 回归并完成本机热同步。详录见 [2026-11-p4.md](./docs/log/2026-11-p4.md#2026-11-25-一键自动更新)。
- **已发布与归档基线**：最新 GitHub Release 为 `v2026.11.27`（`context-viewer v1.10.0`、`agy-finder v0.3.0`、`agy-cli-hud v0.1.0`）；更早 `v2026.11.21`、`v1.8.0`、`v2026.11.15.1`、`v2026.11.15` 及全部历史迭代与 14 轮复查详录见 [docs/log/INDEX.md](./docs/log/INDEX.md)。

## 最新验证基线

- **全仓门禁（2026-11-27 14:55）**：`node scripts/verify.mjs --strict-git-identity` -- 全仓结构/语法、开源隐私与 Git 身份门禁、三插件测试（`agy-cli-hud` 12/12、`agy-context-viewer v1.10.0` 9/9 与 `agy-finder v0.3.0` 13/13）、根安装器及跨插件 8 进程锁与 V1 守护边界全部通过（`exit 0`）。
- **三插件打包（2026-11-27 14:51）**：`node scripts/package-all.mjs` -- 构建并校验通过（`agy-finder-v0.3.0.zip` `123.6 KB`、`context-viewer-v1.10.0.zip` `342.6 KB`、`agy-cli-hud-v0.1.0.zip` `77.7 KB`）。

## 关键入口

- 仓库总览：[README.md](./README.md) / [README_EN.md](./README_EN.md)
- 开发与发布约束：[AGENTS.md](./AGENTS.md)
- 历史迭代日志索引：[docs/log/INDEX.md](./docs/log/INDEX.md)（分片：[2026-11-p4.md](./docs/log/2026-11-p4.md) ~ [2026-11-p1.md](./docs/log/2026-11-p1.md)）
- 统一安装脚本：[install.sh](./install.sh) / [install.ps1](./install.ps1)
- 全仓校验与打包：[scripts/verify.mjs](./scripts/verify.mjs) / [scripts/package-all.mjs](./scripts/package-all.mjs)
- 已维护插件：[plugins/agy-finder](./plugins/agy-finder)、[plugins/agy-context-viewer](./plugins/agy-context-viewer)、[plugins/agy-cli-hud](./plugins/agy-cli-hud)
