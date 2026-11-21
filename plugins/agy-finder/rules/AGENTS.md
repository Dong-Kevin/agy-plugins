# AGY Finder 目录树定位链接约定

## 1. 先判定宿主环境（硬门禁）

在输出任何 `sidecar://` 链接之前，**必须先检查** `<user_information>` 中的 `App Data Directory` / `Artifact Directory Path`（以及可见的 `transcriptPath` 或 `ANTIGRAVITY_APP_DATA_DIR` / `ANTIGRAVITY_LS_VERSION`）：

- **终端 `agy` CLI 会话**（上述任一路径包含 `antigravity-cli`，或 `ANTIGRAVITY_LS_VERSION` 以 `cli-` 开头，或会话已提示处于 `agy` CLI）：
  - **严禁**输出任何 `sidecar://` 协议链接、**严禁**输出 `[📂]` / `[🌐]` 胶囊或 `[项目目录树](sidecar://agy-finder/tree/)`（终端 Markdown 渲染器会将其展开为 `📂 sidecar://agy-finder/tree/?path=...` 不可点击的长 URL，严重破坏排版）。
  - 引用本地文件时，**仅保留标准 `[文件名](file:///绝对路径)` 链接**。
  - 仅在用户明确询问如何在终端外定位目录树或用浏览器打开 HTML 时，再提示运行 `agy-finder open <path>` 或 `agy-finder browser <path>`。
- **Antigravity 桌面端 / IDE 会话**（确认 `App Data Directory` 为 `antigravity` 或 `antigravity-ide`，且**不含** `antigravity-cli`）：启用下方第 2 节紧凑胶囊约定。

## 2. 桌面端 / IDE 紧凑胶囊约定（仅非 CLI 宿主生效）

在回复中引用真实存在的本地文件或目录路径时，保持标准 `[文件名](file:///绝对路径)` 预览链接的同时，按文件类型紧跟紧凑胶囊：

- 通用文件与目录：紧跟 `[📂](sidecar://agy-finder/tree/?path=<URL编码后的路径>)`（相对路径如 `src%2Findex.ts` 与绝对路径均支持；`/` 编码为 `%2F`，空格编码为 `%20`）。
- `.html` / `.htm` / `.xhtml` 网页文件：在标准 `file://` 链接后依次紧跟默认浏览器胶囊与目录树定位胶囊，即 `[🌐](sidecar://agy-finder/tree/?path=<URL编码后的路径>&open=browser) [📂](sidecar://agy-finder/tree/?path=<URL编码后的路径>)`（例如 `preview%2Findex.html`：点 `[🌐]` 直接用系统默认浏览器打开渲染页面并同步定位，点 `[📂]` 仅在右侧目录树展开定位）。
- 仅用于真实存在的本地路径；不要为 `http(s)://` 网址、纯终端命令或假设示例路径添加 `[🌐]` 或 `[📂]` 链接。
- 当用户需要直接打开右侧目录树面板时，可输出 `[项目目录树](sidecar://agy-finder/tree/)`。
