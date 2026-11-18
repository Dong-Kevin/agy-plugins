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
3. **默认浏览器打开本地 HTML 文件**：针对 `.html` / `.htm` / `.xhtml` 文件，使用 `&open=browser` 胶囊直接调用系统默认浏览器渲染页面并同步定位：
   `[🌐](sidecar://agy-finder/tree/?path=<encoded-path>&open=browser) [📂](sidecar://agy-finder/tree/?path=<encoded-path>)`
4. 面板与独立抽屉支持单击高亮路径；对 `.html` / `.htm` / `.xhtml` 双击、按 `Enter` 或点 `🌐` 默认调用系统默认浏览器打开（按住 `Alt`/`Option` 点击或 `Alt+Enter` 可查看源码），普通文件双击或点 `↗` 调用原生预览器打开；点 `📋` 复制路径，点 `🖥` 在系统文件管理器中定位；也可在终端运行 `agy-finder browser <path>` 直接用默认浏览器打开本地 HTML。
5. **快捷键开关独立抽屉 / 直达 AGY 右侧辅助栏**：
   - macOS 默认在 Antigravity 内按 `⌘⇧E` 秒开/收回独立右侧目录树抽屉，按 `⌥⌘E` 直接拉起或切到 Antigravity 原生右侧辅助栏并显示目录树；
   - 在面板右上角 `⌨` 可分别点击录制**独立抽屉**与 **AGY 侧栏**快捷键，并切换「仅 AGY 前台 / 全局生效」或内置预设；
   - Windows / Linux 可将 `agy-finder toggle`（独立抽屉）或 `agy-finder aux`（AGY 侧栏）绑定到系统快捷键（PowerToys / AutoHotkey / GNOME / KDE）。

## 终端 `agy` CLI 用法

- `agy` CLI 不加载桌面端 Sidecar 面板，也不支持点击 `sidecar://` 协议链接；在 CLI 会话中仅输出标准 `[文件名](file:///绝对路径)` 链接。
- 如需在终端外使用独立目录树抽屉或直接用浏览器打开本地 HTML，可在终端标签页运行：
  - `agy-finder` / `agy-finder open <path>`：开关右侧独立目录树抽屉并高亮目标路径（macOS 如需在终端前台按 `⌘⇧E` 呼出，可执行 `agy-finder shortcut --global`）
  - `agy-finder browser <path>`：用系统默认浏览器打开本地 HTML 文件
