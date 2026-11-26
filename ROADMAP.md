# agy-plugins ROADMAP

更新时间：2026-11-25 23:27（Asia/Shanghai）。

## 本次交付目标

1. 修复 `agy-context-viewer` 用量趋势热力图在鼠标移到右侧有数据格时，今日色块被裁切半格、移到下方后重新露出的问题（代码、回归断言与本机 `./install.sh context-viewer` 热同步已完成，尚未 Git 提交）。
2. 完成 `agy-context-viewer` 版本更新提示与一键自动更新全链路（安全自更新模块、三端热重载、前端零 CLS 浮层与 `verifyAutoUpdater` 回归，尚未 Git 提交）。
3. 保持全仓严格校验（`node scripts/verify.mjs --strict-git-identity`）与双插件发布打包（`node scripts/package-all.mjs`）全部通过。

## 后置与挂起事项

- **待 boss 确认**：
  - 是否同步给 `agy-finder` 也加上同款更新检测与一键自动更新按钮；
  - 是否升版提交推送并发布新版 GitHub Release。
- **挂起：`agy-fork` / `agy-session`（`agy` CLI 无损会话分叉插件）**：调研确认底层依赖宿主 `ForkConversation` / `UpdateConversationAnnotations` RPC（需处理 `invoke_subagent` 前轮回退），但经 boss 确认当前非刚需且预计官方原生推出，暂挂起不立项。
- **跨平台与未实测项**：Windows PowerShell 5.1 / 7（本机无 `pwsh`，`.ps1` 改动通过 JS 语法扫描但未在 Windows 实机验收）、Linux 桌面端、`Node.js 18` 最低版本。

## 近期里程碑（滚动 5 条）

- **2026-11-25 · `agy-context-viewer` 热力图右侧今日色块裁切修复（未提交）**：根因系悬停展开 `#day-inspector` 触发 8px 纵向滚动条挤压 `#chart-stage` 且右内边距被溢出忽略；以 `scrollbar-gutter: stable`、子元素承接左右留白及 `ResizeObserver` 贴右保活根治，补齐 R2 回归并完成本机热同步。详录见 [2026-11-p4.md](./docs/log/2026-11-p4.md#2026-11-25-热力图裁切修复)。
- **2026-11-25 · `agy-context-viewer` 版本更新提示与一键自动更新（未提交）**：新建零依赖 [updater.mjs](./plugins/agy-context-viewer/sidecars/dashboard/updater.mjs)（HTTPS 白名单含重定向、SHA-256、CRC-32/Zip-Slip 防护、临时目录原子替换与 `.git` 源码保护），打通三端热重载、顶栏/抽屉/零 CLS 浮层与 `verifyAutoUpdater` 回归并完成本机热同步。详录见 [2026-11-p4.md](./docs/log/2026-11-p4.md#2026-11-25-一键自动更新)。
- **2026-11-25 · `agy-context-viewer` 项目排行前 5/10、AI 订阅卡片优化与热力图放大（已推送 `9f2cda2`）**：项目排行默认前 5 并支持切前 10，重构订阅卡窄屏防断行与圆角分组层，统一趋势切入自动定位当前周期并将热力图放大至 `13×13px`，经真实 Headless Chrome `375×860` 窄侧栏实测零溢出。详录见 [2026-11-p4.md](./docs/log/2026-11-p4.md#2026-11-25-排行订阅与热力图)。
- **2026-11-25 · 全仓 Apple 级统一动效体系与交互升级（已推送 `9f2cda2`）**：`agy-context-viewer`、`agy-finder` 前端及 macOS Swift 原生层落地统一物理曲线/时长、零 CLS 覆盖层、增量 DOM 行复用与三端减弱动效；Headless Chrome 量化实测双插件 CLS 均为 `0.0`、滚动稳在 `60.0 FPS`。详录见 [2026-11-p4.md](./docs/log/2026-11-p4.md#2026-11-25-全仓动效升级)。
- **2026-11-24 · `context-viewer` pulse 启发 P0–P2 + 毛玻璃质感优化（已推送 `0b4d37a`）**：补齐 `cacheWriteTokens` 精算、自动压缩与缓存断流消歧、配额池 EMA 估算、Markdown/CSV/JSON 导出、OLED/增强毛玻璃（去除 `.top-bar` 脏绘）与 200 键中英双语切换。详录见 [2026-11-p4.md](./docs/log/2026-11-p4.md#2026-11-24-缓存精算与毛玻璃)。
- **已发布与归档基线**：最新 GitHub Release 为 `v2026.11.21`（`context-viewer v1.9.0` & `agy-finder v0.2.9`）；更早 `v1.8.0`、`v2026.11.15.1`、`v2026.11.15` 及全部历史迭代与 14 轮复查详录见 [docs/log/INDEX.md](./docs/log/INDEX.md)。

## 最新验证基线

- **全仓门禁（2026-11-25 23:27）**：`node scripts/verify.mjs --strict-git-identity` -- 全仓结构/语法、开源隐私与 Git 身份门禁、双插件测试（`agy-context-viewer` 9/9 共 32 个源码文件与 `agy-finder` 12/12）、根安装器及跨插件 8 进程锁与 V1 守护边界全部通过（`exit 0`）。
- **双插件打包（2026-11-25 19:01）**：`node scripts/package-all.mjs` -- 构建并校验通过（`context-viewer-v1.9.0.zip` `341.9 KB`、`agy-finder-v0.2.9.zip` `109.5 KB`）。

## 关键入口

- 仓库总览：[README.md](./README.md) / [README_EN.md](./README_EN.md)
- 开发与发布约束：[AGENTS.md](./AGENTS.md)
- 历史迭代日志索引：[docs/log/INDEX.md](./docs/log/INDEX.md)（分片：[2026-11-p4.md](./docs/log/2026-11-p4.md) ~ [2026-11-p1.md](./docs/log/2026-11-p1.md)）
- 统一安装脚本：[install.sh](./install.sh) / [install.ps1](./install.ps1)
- 全仓校验与打包：[scripts/verify.mjs](./scripts/verify.mjs) / [scripts/package-all.mjs](./scripts/package-all.mjs)
- 已迁移插件：[plugins/agy-finder](./plugins/agy-finder)、[plugins/agy-context-viewer](./plugins/agy-context-viewer)
