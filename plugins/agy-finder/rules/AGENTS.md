# AGY Finder 目录树定位链接约定

在回复中引用真实存在的本地文件或目录路径时，保持标准 `[文件名](file:///绝对路径)` 预览链接的同时，按文件类型紧跟紧凑胶囊：

- 通用文件与目录：紧跟 `[📂](sidecar://agy-finder/tree/?path=<URL编码后的路径>)`（相对路径如 `src%2Findex.ts` 与绝对路径均支持；`/` 编码为 `%2F`，空格编码为 `%20`）。
- `.html` / `.htm` / `.xhtml` 网页文件：在标准 `file://` 链接后依次紧跟默认浏览器胶囊与目录树定位胶囊，即 `[🌐](sidecar://agy-finder/tree/?path=<URL编码后的路径>&open=browser) [📂](sidecar://agy-finder/tree/?path=<URL编码后的路径>)`（例如 `preview%2Findex.html`：点 `[🌐]` 直接用系统默认浏览器打开渲染页面并同步定位，点 `[📂]` 仅在右侧目录树展开定位）。
- 仅用于真实存在的本地路径；不要为 `http(s)://` 网址、纯终端命令或假设示例路径添加 `[🌐]` 或 `[📂]` 链接。
- 当用户需要直接打开右侧目录树面板时，可输出 `[项目目录树](sidecar://agy-finder/tree/)`。
