# AGY CLI HUD (`agy-cli-hud`)

专为 **`agy` CLI** 与 **Solo** 打造的零依赖、低延迟终端监控与 Google Colab 算力插件。

- **定位分工清晰**：`agy-context-viewer` 专注 Antigravity Desktop App / IDE 的重度 WebView 分析；本插件专注 **CLI 与 Solo 原生体验**，零 WebView、零独立浮窗、零 CDP 注入。
- **输入栏下方分层实时状态栏**：利用 `agy` CLI 官方 `statusLine` 契约，默认 **2 行分层**（可选 3 行或 1 行），按终端宽度自适应防折行，热路径零网络请求、零全盘扫描。
- **字节偏移增量引擎**：借鉴 `token-tracker` 的 `IncrementalJSONL` 游标思路，只解析新增字节，并按 `step_index` 去重防复算，毫秒级汇总 **当前会话平均缓存**、**今日使用量**、**本月使用量** 与 **API 等值参考 / 订阅回本**。
- **原生双池额度**：直读 `agy` 回调中的 `gemini-5h`、`gemini-weekly`、`3p-5h`、`3p-weekly` 四桶并统一为 **「剩余 %」** 口径。
- **Solo 原生联动**：输出原子只读快照 `~/.gemini/antigravity-cli/cache/agy-cli-hud/usage-hud.v1.json`，无缝供给 Solo 右侧原生第 4 页签 **「用量」(`⌘U`)**，并兼容 Solo 既有 `agy-statusline --forward-command` 桥接，绝不互覆配置。
- **合规 Google Colab 监控**：纯官方 Google OAuth 2.0 (PKCE) + `colaboratory.googleapis.com/v1beta` REST API，实时查看订阅等级、剩余 CU、CU/h、活跃 GPU 的 RAM/VRAM/负载/闲置倒计时，并支持续期、释放与低频排队。

## 快速安装

```bash
# 在 agy-plugins 仓库根目录安装
./install.sh agy-cli-hud

# 或在插件目录单独安装
cd plugins/agy-cli-hud && ./install.sh
```

安装完成后会自动链接 `~/.local/bin/agy-hud`。

## 快速使用

```bash
# 1. 启用输入栏下方 2 行分层状态栏（自动保留 Solo 既有桥接）
agy-hud install-statusline --lines 2

# 2. 查看全量指标概览（或 --json）
agy-hud status

# 3. 切换为 3 行分层（第 3 行展示 Colab 实时硬件与闲置倒计时）
agy-hud config set lines 3

# 4. 在非 Solo 终端下使用轻量实时看板
agy-hud watch

# 5. 连接 Google Colab（使用你自己的 Google Cloud OAuth 桌面凭据）
agy-hud colab import-secret ./client_secret.json
agy-hud colab login
agy-hud colab status
```

## 默认 2 行状态栏示例

```text
Ctx ████░░░░ 42% (420K/1.0M) · 缓存均值 86% (本轮 94%) · 58 t/s · 本会话 $1.24 · 今日 2.42M ($6.80)
Gemini 5h 余78% (2h14m) · 周 余64% │ 非Gemini 5h 余92% · 周 余88% │ Colab A100 · 84.2 CU
```

## 卸载

```bash
agy-hud install-statusline --uninstall
./install.sh --uninstall agy-cli-hud
```
