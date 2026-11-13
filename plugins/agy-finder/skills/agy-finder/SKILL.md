---
name: agy-finder
description: 在右侧辅助栏打开项目目录树面板，或生成点击直达目录树定位的链接。当用户想浏览项目目录结构或在目录树中定位某个文件时触发。
---

# AGY Finder 项目目录树

用于在 Antigravity 右侧辅助栏（Aux Pane）中打开项目目录树，或直接定位展开到指定文件/目录。

## 使用方式

1. **打开目录树面板**：当用户需要浏览项目结构时，在回复中提供链接：
   `[项目目录树](sidecar://agy-finder/tree/)`
2. **定位指定文件或目录**：对目标路径（相对路径或绝对路径均可）做 `encodeURIComponent` 后附加到 `path` 参数中：
   `[📂 定位 <文件名>](sidecar://agy-finder/tree/?path=<encoded-path>)`
3. 面板支持直接单击文件高亮路径、双击或点 `↗` 调用原生预览器打开、点 `📋` 复制路径，以及点 `🖥` 在系统文件管理器中定位。
4. **快捷键开关侧边栏 / 独立抽屉**：
   - macOS 在 Antigravity 内按 `⌘⇧E`（可在面板顶部 `⌨` 设置为 `⌘⌥E` / `⌃⇧E` / `⌘⇧Y` / `关闭`）秒开/收回右侧独立目录树抽屉；
   - Antigravity 原生右侧辅助栏开关：`⌘⇧B`（macOS）/ `Ctrl+Shift+B`（Windows/Linux）；
   - Windows / Linux 可通过 CLI `agy-finder toggle` 绑定到系统快捷键（PowerToys / AutoHotkey / GNOME / KDE）。
