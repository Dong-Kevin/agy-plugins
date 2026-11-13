<img src="assets/logo.svg" width="84" align="right" alt="AGY Finder Logo" />

# AGY Finder 项目目录树 (`agy-finder`)

[![Version](https://img.shields.io/badge/version-v0.1.0-38bdf8)](https://github.com/Dong-Kevin/agy-plugins/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-818cf8)](#安装与启用)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D%2018-22c55e)](#安装与启用)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-a855f7)](#核心特性)
[![License: MIT](https://img.shields.io/badge/License-MIT-f59e0b.svg)](./LICENSE)

**简体中文** | **[English](./README_EN.md)** · [核心特性](#核心特性) · [安装与启用](#安装与启用) · [快捷键与 CLI](#快捷键与-cli) · [本地开发与校验](#本地开发与校验)

轻量、零外部依赖、跨平台（macOS / Windows / Linux）的 **Google Antigravity** 右侧辅助栏（Aux Pane）与独立抽屉项目目录树插件，现统一维护于 **[Dong-Kevin/agy-plugins](https://github.com/Dong-Kevin/agy-plugins)**。

针对 Antigravity 桌面端右侧缺乏完整项目目录树、点击对话路径无法展开定位目录位置的问题，提供 **「对话内直点深链接 + 日志增量提取双保险」** 方案。

---

## 核心特性

- **零依赖、零侵入、跨平台**：纯 `Node.js >= 18` 标准库 + 原生 HTML / CSS / JS + 官方 `sidecar_sdk` 构建，无需 `npm install`，不修改客户端 `app.asar`、不注入 CDP、不修改用户外部 `~/.agents/AGENTS.md` 或 `~/.gemini/config/config.json`。
- **双保险路径定位（支持相对路径、绝对路径、`file://` 与 `:行号`）**：
  1. **聊天直点定位（插件内置 `rules/AGENTS.md`）**：保留 `[文件名](file:///...)` 原生预览链接的同时附带 `[📂](sidecar://agy-finder/tree/?path=...)`，点击即刻在右侧展开目录树并脉冲高亮目标文件。
  2. **100% 确定性兜底（增量字节偏移读取 `transcript_full.jsonl`）**：仅在目录树面板可见时按需轮询（面板收起时 `0%` CPU），通过 `stat` 缓存 + 字节偏移增量解析提取当前会话出现过的真实存在路径，在面板顶部展示 **「对话提及」** 快捷芯片，一键定位目录树（对旧对话或模型漏写链接同样有效）。
  3. **搜索与路径直跳**：搜索框支持实时模糊筛选文件名，也支持粘贴任意相对 / 绝对路径按 `Enter`（或点 `🎯` 读取剪贴板）直接展开树定位；工作区外路径自动挂载所属项目根并展开。
- **高频轻交互**：
  - 单击文件高亮选中并显示路径栏；双击或点 `↗` 调用宿主原生 `fileView` 预览（独立抽屉模式下提供轻量文本预览弹窗）。
  - 行内按钮支持一键复制相对 / 绝对路径（`Shift + 点击` 复制绝对路径）及在系统文件管理器（Finder / Explorer / xdg-open）中定位。

---

## 安装与启用

### 方式 1：macOS / Linux 一键安装

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/plugins/agy-finder/install.sh)"
```

卸载：

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/plugins/agy-finder/install.sh)" -- --uninstall
```

### 方式 2：Windows PowerShell 一键安装

```powershell
irm https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/plugins/agy-finder/install.ps1 | iex
```

卸载：

```powershell
.\plugins\agy-finder\install.ps1 -Uninstall
```

### 方式 3：通过总仓克隆安装

```bash
git clone https://github.com/Dong-Kevin/agy-plugins.git
cd agy-plugins
./install.sh agy-finder        # Windows PowerShell 执行：.\install.ps1 -Plugin agy-finder
```

### 方式 4：通过官方 `agy` CLI 安装本地目录

```bash
agy plugin install ./plugins/agy-finder
```

安装完成后，Antigravity 会自动加载并启用 **AGY Finder 项目目录树**（可在左侧 **Customizations → Installed** 中随时开关管理），点击对话中的 `[AGY Finder 目录树](sidecar://agy-finder/tree/)` 或右侧辅助栏入口即可打开。

---

## 快捷键与 CLI

- **独立右侧抽屉快捷键（macOS 原生，默认 `⌘⇧E`）**：通过 Carbon `RegisterEventHotKey` 仅当 `Antigravity` 为前台应用时激活，切换到其他应用自动注销、**零冲突且无需辅助功能权限**；可在面板右上角 `⌨` 中切换预设（`⌘⇧E`、`⌘⌥E`、`⌃⇧E`、`⌘⇧Y` 或 `关闭`）。
- **宿主右侧辅助栏原生开关**：Antigravity 原生支持 `⌘⇧B`（macOS）/ `Ctrl+Shift+B`（Windows / Linux）显隐右侧栏，右键插件标签可 `Pin Tab` 固定。
- **跨平台 CLI 快捷触发（Windows / Linux / macOS）**：

```bash
agy-finder toggle              # 打开或关闭右侧独立目录树抽屉（可在系统快捷键工具中绑定 Ctrl+Shift+E）
agy-finder open [path]         # 打开抽屉并可选定位到指定路径
agy-finder close               # 关闭抽屉
agy-finder status [--json]     # 查看抽屉与快捷键状态
agy-finder hotkey <preset>     # 设置快捷键预设：cmd+shift+e | cmd+alt+e | ctrl+shift+e | cmd+shift+y | off
agy-finder quit                # 退出后台抽屉守护进程
```

- **面板内完整键盘导航**：`↑` / `↓` 移动、`←` / `→` 折叠 / 展开、`Enter` 预览 / 展开、`/` 或 `⌘/Ctrl+F` 搜索、`⌘/Ctrl+.` 显隐 dotfiles、`?` 开关快捷键面板、`Esc` 逐层关闭弹窗 / 收起抽屉。

---

## 本地开发与校验

```bash
# 运行完整自检（清单规范、语法、CSS 隔离、路径解析、增量日志解析、HTTP 环回与安装测试）
node scripts/verify.mjs

# 独立 Web 预览模式（仅监听 127.0.0.1）
node sidecars/tree/main.mjs --standalone --port 18980
```

## License

MIT License
