---
name: agy-cli-hud
description: 专为 agy CLI 与 Solo 设计的轻量低延迟终端监控与 Colab 算力命令行（agy-hud）。当用户要在 agy CLI 输入栏下方配置 2/3 行分层实时状态栏、快速查询今日/本月 Token 与 API 等值、当前会话平均缓存、Gemini 与非 Gemini 双池 5h/周额度，或通过合规 OAuth 连接管理 Google Colab 算力实例时触发。
---

# AGY CLI HUD (`agy-hud`)

本技能用于面向 `agy` CLI 与 **Solo** 的轻量实时遥测体验：

- **输入栏下方原生状态栏**：通过 `agy` 官方 `statusLine` 接口在输入框正下方输出 2 行（默认）或 3 行分层指标，热路径零网络请求、零全盘扫盘，且自动兼容 Solo 既有的 `agy-statusline --forward-command` 桥接。
- **Solo 原生右侧抽屉联动**：输出标准化的 `usage-hud.v1.json` 只读快照供 Solo 右侧「用量」抽屉（`⌘U`）直接消费，零 WebView、零独立浮窗。
- **合规 Google Colab 监控**：纯 OAuth 2.0 (PKCE) + 官方 REST API，支持余额、CU/h、活跃 GPU 实例硬件/闲置倒计时、续期、释放与低频排队抢算力（彻底不包含 CDP DOM 注入）。

## 常用命令

```bash
# 查看当前会话、今日/本月用量、平均缓存、双池额度与 Colab 概览
agy-hud status

# 安装输入栏下方 2 行（默认）或 3 行分层状态栏（自动保留 Solo 桥接）
agy-hud install-statusline --lines 2
agy-hud install-statusline --lines 3

# 卸载 HUD 状态栏（完好保留 Solo 桥接）
agy-hud install-statusline --uninstall

# 调整配置（分层行数 1/2/3、主题、统计口径 cli_only/all、月费折算）
agy-hud config set lines 3
agy-hud config set scope cli_only
agy-hud config set monthly_paid_usd 19.99

# 查看、预览或切换配色主题（mocha/latte/frappe/macchiato/nord/dracula）
agy-hud theme list
agy-hud theme preview
agy-hud theme set nord

# 非 Solo 终端下的轻量实时看板
agy-hud watch

# 连接与管理 Google Colab（凭据以 0600 权限存于私有缓存目录）
agy-hud colab import-secret /path/to/client_secret.json
agy-hud colab login
agy-hud colab status
agy-hud colab keepalive
agy-hud colab release <runtime-id>
agy-hud colab snipe A100 --interval 30
agy-hud colab snipe --stop
```

## 安全与边界

- 绝不修改 `~/.gemini/config/config.json` 或 `Antigravity.app` 宿主包，不注入 CDP。
- 仅在用户明确要求修改 `~/.gemini/antigravity-cli/settings.json` 时运行 `agy-hud install-statusline`。
- 输出或回报中不得包含个人主目录路径、OAuth Token、Client Secret 或未脱敏邮箱。
