# AGY Finder（`agy-finder`）

专为 **Google Antigravity** 打造的轻量项目目录树插件 -- 点击聊天回复中的 **`[📂]`** 链接或在右侧栏按快捷键，即可秒级展开并高亮定位目标文件；识别 `.html` / `.htm` / `.xhtml` 并支持通过 **`[🌐]`** 胶囊或面板内直接调用系统默认浏览器打开渲染页面；支持会话提及文件提取、增量 DOM 零抖动滚动、快速筛选、原地文本预览、macOS 独立右侧滑出抽屉以及**一键安全自动更新**。

**简体中文** | [English](README_EN.md) | [合集主页](../../README.md)

---

## Agent 一句话安装

复制下面这段话直接发给 Antigravity，即可自动完成安装与状态检查：

```text
请帮我安装 AGY Finder 插件（来自 https://github.com/Dong-Kevin/agy-plugins ：macOS / Linux 运行 `bash -c "$(curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/plugins/agy-finder/install.sh)"`，Windows PowerShell 运行 `irm https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/plugins/agy-finder/install.ps1 | iex`），安装后验证 `agy-finder status` 并列出快捷键说明。
```

<details>
<summary>手动命令行安装 / 热更新 / 卸载（macOS · Linux · Windows）</summary>

```bash
# macOS / Linux -- 安装或原地热更新
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/plugins/agy-finder/install.sh)"

# 卸载
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/plugins/agy-finder/install.sh)" -- --uninstall
```

```powershell
# Windows PowerShell -- 安装或热更新（卸载运行 .\plugins\agy-finder\install.ps1 -Uninstall）
irm https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/plugins/agy-finder/install.ps1 | iex
```

- 也可从 [Releases](https://github.com/Dong-Kevin/agy-plugins/releases) 下载 `agy-finder-v0.3.0.zip` 解压后执行 `./install.sh`，或运行 `agy plugin install ./plugins/agy-finder`。

</details>

---

## 快捷键与自定义位置

| 触发方式 | 默认按键 / 操作 | 说明 | 自定义位置 |
| :--- | :--- | :--- | :--- |
| **macOS 独立右侧抽屉** | **`⌘⇧E`** | 贴右边缘滑出独立目录树抽屉，失焦自动收起，零辅助功能权限 | **顶部工具栏 `⌨`（或按 `?`）** → **`⇧⌘E 点击修改`** / 预设下拉 / **`仅 AGY 内 / 全局`**<br/>CLI：`agy-finder shortcut [combo\|reset\|off]` · `agy-finder hotkey <preset>` |
| **AGY 右侧栏直达** | **`⌥⌘E`**（Win/Linux 可绑 CLI） | 无论在 `Overview`、收起态或其它插件页，直达目录树面板 | **顶部工具栏 `⌨`** → **`⌥⌘E 点击修改`**；标签页 **右键 → `Pin Tab`** 跨对话常驻<br/>CLI：`agy-finder aux-shortcut [combo\|reset\|off]` |
| **宿主与对话入口** | **`⌘⇧B`**（Win/Linux `Ctrl+Shift+B`）<br/>**`/agy-finder`** · **`[🌐]`** · **`[📂]`** | 切宿主右侧辅助栏显隐；点 `[📂]` 展开并高亮文件；点 HTML 旁的 `[🌐]` 用默认浏览器打开页面 | 自动写入用户级 `rules/AGENTS.md` 约定（纯本地规则，不改客户端文件） |
| **树内键盘导航** | **`↑/↓`** · **`←/→`** · **`Enter`** · **`/`** · **`⌘.`** | 上下移动、展开折叠、HTML 默认浏览器打开（`⌥`/`Alt`+点击看源码）、模糊搜索、显隐点文件 | 顶部工具栏切换 **自动 / 浅 / 深色** 主题，**`⌨` 左侧独立抽屉按钮** 弹出抽屉 |
| **一键安全自动更新** | **顶栏下载图标** / **`⌨` 面板** / `agy-finder update` | 自动检测官方 GitHub Release，经 HTTPS 白名单、`.sha256` 与 CRC-32 校验后原子热更新并重载 | 有新版本时顶栏亮起圆点并弹出底部零 CLS 提示条，可一键升级或暂不提示当前版本 |

<details>
<summary>常用 <code>agy-finder</code> 终端命令速查</summary>

```bash
agy-finder                      # 显示 / 隐藏右侧独立滑出抽屉
agy-finder open [path]          # 打开抽屉并直接定位高亮指定路径
agy-finder browser <path>       # 在系统默认浏览器中打开本地 HTML 文件
agy-finder aux [path]           # 唤醒 Antigravity 原生右侧辅助栏直达目录树（Win/Linux 可绑 Ctrl+Alt+E）
agy-finder status [--json]      # 查看抽屉、Aux Pane 与双快捷键当前配置
agy-finder update [--check]     # 检查或自动更新至最新 GitHub Release（含 SHA-256 校验）
agy-finder shortcut <combo>     # 命令行修改独立抽屉快捷键（支持 reset / off / --global）
agy-finder aux-shortcut <combo> # 命令行修改 AGY 右侧栏直达快捷键
agy-finder quit                 # 停止后台抽屉守护进程
```

</details>

---

## 界面预览

<table>
  <tr>
    <td align="center" width="33%">
      <strong>对话提及与路径定位</strong><br/>
      <img src="docs/images/finder-tree-reveal.png" width="265" alt="AGY Finder 对话提及与路径高亮定位" />
    </td>
    <td align="center" width="33%">
      <strong>快捷键面板（点击 <code>⌨</code>）</strong><br/>
      <img src="docs/images/finder-shortcuts.png" width="265" alt="AGY Finder 双快捷键录制面板" />
    </td>
    <td align="center" width="33%">
      <strong>弹窗预览与系统定位</strong><br/>
      <img src="docs/images/finder-quick-preview.png" width="265" alt="AGY Finder 原生弹窗文本预览" />
    </td>
  </tr>
</table>

---

## 兼容与说明

- **插件协同**：与 `context-viewer` 同机安装时共用 `~/.gemini/antigravity/agy_aux_pane_trigger.json` 互斥锁，建议同步升级 `context-viewer >= v1.7.4` 并重启已有后台进程。
- **验证与协议**：依赖 `Node.js >= 18`；macOS 抽屉与真实宿主交互已实测，Windows / Linux 支持 AGY 原生 Sidecar 与 `agy-finder` CLI。本地校验：`node plugins/agy-finder/scripts/verify.mjs`（[MIT License](./LICENSE)）。
