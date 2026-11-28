---
name: context-viewer
description: 查看当前会话上下文窗口占用、缓存命中率、模型生成速度（TTFT / tok/s）、每轮消耗涨跌时间线、桌面端与 agy CLI 历史 Token 用量及 API 订阅折算对比，或在桌面端一键打开侧边栏可视化看板。当用户询问上下文占用、Token 消耗、配额池余量或费用估算时触发。
---

# 上下文与 Token 看板 (`context-viewer`)

本技能同时兼容 **Antigravity 桌面端 (`agy` App / IDE)** 与 **终端 `agy` CLI**，全程基于本地会话归档与官方只读接口运行，不修改客户端安装包或全局 `config.json`。

## 1. 获取精确实时统计数据（App 与 CLI 通用）

先根据当前技能文件 `SKILL.md` 所在的目录 `<skill-dir>`，运行内置跨平台脚本（自动兼容 macOS / Linux / Windows 及任意插件安装目录名）：

```bash
node "<skill-dir>/scripts/status.mjs" --json
```

如需指定会话 ID，可追加会话 ID 参数：

```bash
node "<skill-dir>/scripts/status.mjs" --json "<conversation-id>"
```

脚本返回的 JSON 中已包含：
- `entrypoints.sidecarAuxPane`：当前插件实际目录对应的 `sidecar://<dir>/dashboard/` 链接
- `entrypoints.customizationSettings`：当前插件对应的 `customization://<dir>` 设置页链接
- `conversation`：当前会话窗口水位、`repoInfo`、`branchInfo`（`/btw` 分支）、`latestPromptStartup`、待发送预估 Token、缓存命中率、生成速度、四维累计吞吐、会话 API 等值金额与 `sessionCacheSavingsUSD`
- `recentTurns`、`promptTurns` 与 `heavyItems`：最近轮次水位 `±Delta`、按用户 Prompt 的冷/热启动诊断与上下文重度消耗 Top 排行
- `agentTree` 与 `compactions`：Swarm / Subagent 多代理整树聚合统计与压缩历史摘要
- `globalHistory`、`topProjects`、`diagnostics` 与 `quotas`：桌面端 / IDE + `agy` CLI 多源累计 Token、按项目消耗排行、异常与灰度路由取证汇总及实时模型配额池余量

## 2. 按宿主环境呈现结果

### 在 Antigravity 桌面端 / IDE 中
1. 用简洁要点或表格汇报用户关心的指标（窗口水位、缓存命中率、速度、累计吞吐或费用）。
2. 若用户希望快捷打开右侧栏看板，直接输出脚本返回的 `entrypoints.sidecarAuxPane` 单行胶囊链接，例如：
   `[上下文看板](sidecar://context-viewer/dashboard/)`
   *(注意：务必使用脚本返回的实际 `<dir>` 目录名，切勿硬编码。若插件或 Sidecar 尚未开启，则引导点击 `[上下文与 Token 看板](customization://<dir>)` 启用。)*
3. **自由切换「顶部菜单栏常驻图标（3 种定制内容 + 切换会话自动跟随）」与「屏幕右侧独立置顶小窗（`📌`）」**：
   - **顶部系统菜单栏常驻图标（macOS 默认开启，切换不同或静止会话时自动跟随更新；左键秒开 / 收回右侧看板，右键快捷切换显示内容）**：
     ```bash
     node "<skill-dir>/scripts/status.mjs" menubar context   # 切换显示：当前上下文使用占比（如 ◈ 43%）
     node "<skill-dir>/scripts/status.mjs" menubar speed     # 切换显示：最新生成速度与耗时（如 ⚡ 35t/s·49s (均38/峰132)）
     node "<skill-dir>/scripts/status.mjs" menubar quota     # 切换显示：5 小时 / Week 额度余量（如 ⏳ 5h 95%·1h08m）
     node "<skill-dir>/scripts/status.mjs" menubar on        # 开启顶部菜单栏常驻图标
     node "<skill-dir>/scripts/status.mjs" menubar off       # 关闭顶部菜单栏常驻图标
     ```
     也可直接**右键点击 macOS 顶部菜单栏图标**勾选切换，或在看板右上角调色盘设置抽屉的「菜单栏显示内容」分段按钮中一键切换。
   - **独立置顶小窗 & 直达 AGY 右侧辅助栏（双可自定义快捷键，默认 `⌥⌘K` / `⌃⌥K`）**：
     ```bash
     node "<skill-dir>/scripts/status.mjs" float                     # 弹出并钉住右侧独立置顶小窗
     node "<skill-dir>/scripts/status.mjs" float close               # 收回独立小窗
     node "<skill-dir>/scripts/status.mjs" aux                       # 唤醒并切换 AGY 右侧辅助栏到上下文看板
     node "<skill-dir>/scripts/status.mjs" shortcut                  # 查看独立小窗快捷键与生效范围
     node "<skill-dir>/scripts/status.mjs" shortcut opt+cmd+l        # 自定义独立小窗快捷键（reset / off / --global）
     node "<skill-dir>/scripts/status.mjs" aux-shortcut              # 查看 AGY 侧栏看板快捷键
     node "<skill-dir>/scripts/status.mjs" aux-shortcut ctrl+opt+l   # 自定义 AGY 侧栏看板快捷键（reset / off / --global）
     ```
     也可点击看板右上角的 `📌` 按钮切换置顶，或在看板右上角调色盘设置抽屉中分别点击录制「独立悬浮窗快捷键」与「AGY 侧栏看板键」。

### 在终端 `agy` CLI 中
1. 直接汇报终端统计摘要（注意：`agy` CLI 不加载桌面端 Sidecar，**不要**输出 `sidecar://` 或 `customization://` 链接；也可以运行不带 `--json` 的 `node "<skill-dir>/scripts/status.mjs"` 查看彩色终端进度条看板，或传 `turns` 查看逐轮消耗表）。
2. 若返回 `historyStatus.state === "restricted"` 或 `quotaStatus.errorCode === "EPERM"`（常见于 `agy` CLI 沙箱环境），先如实汇报当前会话的已用 Token、缓存命中率、生成速度、最近轮次增量与参考费用，再提示用户在**外部终端标签页**运行以下命令查看完整跨会话热力图、实时配额与图形界面：
   ```bash
   agy-context                   # 外部终端查看桌面端 + IDE + CLI 全量汇总与实时状态
   agy-context statusline install # 为 agy CLI 开启底部原生实时状态栏（实时显示模型、水位%、冷启动预警、速率、费用与 5h/Week 配额）
   agy-context watch             # 终端实时盯盘面板（适配 tmux 分屏，随会话归档变化自动刷新）
   agy-context turns --prompts   # 按用户输入分组诊断冷/热启动缓存命中与增量（含思考占比与整请求有效吞吐）
   agy-context heavy             # 查看当前会话上下文重度消耗 Top 10（含独立 Skills 分组占比）
   agy-context tree              # 查看 Swarm / Subagent 多代理整树吞吐与折算费用
   agy-context compact           # 查看上下文压缩历史与摘要（追加 --full 看原文）
   agy-context events            # 查看跨会话 429 / 安全过滤浪费 / 重试次数与 requestId / 灰度路由取证及按项目排行
   agy-context pricing [--sync|--reset] # 离线查看内置/已同步模型费率与分段调价预告（--sync 手动同步官方定价）
   agy-context quota-rpc [on|off|status] # 开关「零额度 RPC 模式」（off = 纯本地统计，禁发 GetUserStatus/Quota RPC）
   agy-context menubar on        # (macOS) 开启顶部菜单栏常驻图标，切换会话自动跟随
   agy-context float             # 弹出屏幕右侧独立置顶小窗（可配 agy-context shortcut --global 在终端前台用 ⌥⌘K 呼出）
   agy-context web               # 在 127.0.0.1:18970 启动完整 Web 热力图与双池配额看板并打开浏览器
   ```
