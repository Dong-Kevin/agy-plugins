# agy-plugins ROADMAP

更新时间：2026-11-27 14:27（Asia/Shanghai）。

## 本次交付目标

1. 交付并打磨 `agy` CLI 与 Solo 专用零依赖轻量插件 `plugins/agy-cli-hud`（`v0.1.0`，命令 `agy-hud`）：6 套克制主题与输入栏下方 1/2/3 行宽屏自适应状态栏、非阻塞 Solo 异步旁路与 `agy-hud render` 防截胡入口、SQLite 精确速度计时、增量 JSONL 游标统计、双池 5h/周额度与每池今日周耗（含日内重置 `↻`、桌面端基线回填与 `+` 透明标注）及合规版 Google Colab 算力监控（零 CDP），保持 `agy-context-viewer` 专用于 Desktop App。
2. 保持三插件全仓严格校验（`node scripts/verify.mjs --strict-git-identity`）与独立发布打包（`node scripts/package-all.mjs`）全部通过并同步推送 `main`。

## 后置与挂起事项

- **待 boss 确认**：
  - 是否同步给 `agy-finder` 也加上同款更新检测与一键自动更新按钮；
  - 是否升版推送并发布新版 GitHub Release（含 `agy-cli-hud v0.1.0`）。
- **挂起：`agy-fork` / `agy-session`（`agy` CLI 无损会话分叉插件）**：调研确认底层依赖宿主 `ForkConversation` / `UpdateConversationAnnotations` RPC（需处理 `invoke_subagent` 前轮回退），但经 boss 确认当前非刚需且预计官方原生推出，暂挂起不立项。
- **跨平台与未实测项**：Windows PowerShell 5.1 / 7（本机无 `pwsh`，`.ps1` 改动通过 JS 语法扫描但未在 Windows 实机验收）、Linux 桌面端、`Node.js 18` 最低版本。

## 近期里程碑（滚动 5 条）

- **2026-11-27 · `agy-cli-hud` 主题、防强杀、精确计时与今日周耗升级**：重构 6 套克制主题与 `theme` 命令；默认启用 Solo 异步旁路 + `agy-hud render` 免疫旧版快渲染截胡并压缩 `>24h` 增量缓存；引入 `sqlite_timing.mjs` 修复 `t/s` 虚高；上线每池今日周耗账本（日内重置 `↻`、8 分钟心跳保活零点桥接、联动桌面端 `host_status_cache_v1.json` 同日早锚回填与 `+` 透明缺口标注）及 1/2/3 行 CJK 防折行矩阵。详录见 [2026-11-p4.md](./docs/log/2026-11-p4.md#2026-11-27-agy-cli-hud-体验与周耗升级)。
- **2026-11-26 · 新增 `agy-cli-hud v0.1.0` 轻量 CLI 与 Solo 遥测插件（已提交 `dd636ce`）**：新建零依赖 [plugins/agy-cli-hud](./plugins/agy-cli-hud)（`agy-hud`），实现增量 JSONL 字节游标今日/本月/7 日与会话平均缓存滚存、API 零售分段折算与订阅杠杆、Gemini/非 Gemini 双池 5h/周剩余额度、合规 OAuth 2.0 PKCE + 官方 Colab REST 算力监控（零 CDP）、原子共享快照 `usage-hud.v1.json` / `<4 KB` 摘要与 Solo 零冲突共存分层底栏，并接入总仓 `verify.mjs` / `package-all.mjs` / 统一安装器。详录见 [2026-11-p4.md](./docs/log/2026-11-p4.md#2026-11-26-新增-agy-cli-hud)。
- **2026-11-25 · `agy-context-viewer` 热力图右侧今日色块裁切修复（已提交 `4f48b29`）**：根因系悬停展开 `#day-inspector` 触发 8px 纵向滚动条挤压 `#chart-stage` 且右内边距被溢出忽略；以 `scrollbar-gutter: stable`、子元素承接左右留白及 `ResizeObserver` 贴右保活根治，补齐 R2 回归并完成本机热同步。详录见 [2026-11-p4.md](./docs/log/2026-11-p4.md#2026-11-25-热力图裁切修复)。
- **2026-11-25 · `agy-context-viewer` 版本更新提示与一键自动更新（已提交 `4f48b29`）**：新建零依赖 [updater.mjs](./plugins/agy-context-viewer/sidecars/dashboard/updater.mjs)（HTTPS 白名单含重定向、SHA-256、CRC-32/Zip-Slip 防护、临时目录原子替换与 `.git` 源码保护），打通三端热重载、顶栏/抽屉/零 CLS 浮层与 `verifyAutoUpdater` 回归并完成本机热同步。详录见 [2026-11-p4.md](./docs/log/2026-11-p4.md#2026-11-25-一键自动更新)。
- **2026-11-25 · `agy-context-viewer` 项目排行前 5/10、AI 订阅卡片优化与热力图放大（已推送 `9f2cda2`）**：项目排行默认前 5 并支持切前 10，重构订阅卡窄屏防断行与圆角分组层，统一趋势切入自动定位当前周期并将热力图放大至 `13×13px`，经真实 Headless Chrome `375×860` 窄侧栏实测零溢出。详录见 [2026-11-p4.md](./docs/log/2026-11-p4.md#2026-11-25-排行订阅与热力图)。
- **已发布与归档基线**：最新 GitHub Release 为 `v2026.11.21`（`context-viewer v1.9.0` & `agy-finder v0.2.9`）；更早全仓动效升级、`v1.8.0`、`v2026.11.15.1`、`v2026.11.15` 及全部历史迭代与 14 轮复查详录见 [docs/log/INDEX.md](./docs/log/INDEX.md)。

## 最新验证基线

- **全仓门禁（2026-11-27 14:27）**：`node scripts/verify.mjs --strict-git-identity` -- 全仓结构/语法、开源隐私与 Git 身份门禁、三插件测试（`agy-cli-hud` 11/11、`agy-context-viewer` 9/9 与 `agy-finder` 12/12）、根安装器及跨插件 8 进程锁与 V1 守护边界全部通过（`exit 0`）。
- **三插件打包（2026-11-27 14:13）**：`node scripts/package-all.mjs` -- 构建并校验通过（`agy-cli-hud-v0.1.0.zip` `67.5 KB`、`context-viewer-v1.9.0.zip` `341.9 KB`、`agy-finder-v0.2.9.zip` `109.5 KB`）。

## 关键入口

- 仓库总览：[README.md](./README.md) / [README_EN.md](./README_EN.md)
- 开发与发布约束：[AGENTS.md](./AGENTS.md)
- 历史迭代日志索引：[docs/log/INDEX.md](./docs/log/INDEX.md)（分片：[2026-11-p4.md](./docs/log/2026-11-p4.md) ~ [2026-11-p1.md](./docs/log/2026-11-p1.md)）
- 统一安装脚本：[install.sh](./install.sh) / [install.ps1](./install.ps1)
- 全仓校验与打包：[scripts/verify.mjs](./scripts/verify.mjs) / [scripts/package-all.mjs](./scripts/package-all.mjs)
- 已维护插件：[plugins/agy-finder](./plugins/agy-finder)、[plugins/agy-context-viewer](./plugins/agy-context-viewer)、[plugins/agy-cli-hud](./plugins/agy-cli-hud)
