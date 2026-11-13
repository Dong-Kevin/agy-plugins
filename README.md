# AGY Plugins (`Dong-Kevin/agy-plugins`)

[![Plugins](https://img.shields.io/badge/plugins-2-38bdf8)](#插件矩阵)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-818cf8)](#快速安装)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D%2018-22c55e)](#快速安装)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-a855f7)](#隐私与安全原则)
[![License: MIT](https://img.shields.io/badge/License-MIT-f59e0b.svg)](./LICENSE)

**简体中文** | **[English](./README_EN.md)** · [插件矩阵](#插件矩阵) · [亮点与预览](#亮点与预览) · [快速安装](#快速安装) · [目录结构与新增插件](#目录结构与新增插件) · [校验与打包](#本地校验与打包) · [致谢](#致谢)

面向 **Google Antigravity 桌面端（`agy` App / IDE）** 与 **终端 `agy` CLI** 的开源插件合集仓库。

所有插件均严格遵循 Antigravity 官方 `plugin.json` 与 `sidecar_sdk` 规范构建 -- **不解包修改 `app.asar`、不注入 CDP 渲染进程、不引入第三方 `npm` 运行时依赖、100% 本地只读运行**，既保障客户端签名与自动升级完整无损，也可在 macOS / Linux / Windows 跨平台开箱即用。

---

## 插件矩阵

| 插件目录 | 插件标识 (`name`) | 版本 | 功能定位 | 核心亮点 | 详细文档 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| [`plugins/agy-finder`](./plugins/agy-finder) | `agy-finder` | `v0.1.0` | 右侧项目目录树与路径直达定位 | 对话 `[📂]` 深链接 + `transcript_full.jsonl` 增量兜底，macOS `⌘⇧E` 前台零冲突抽屉与预览 | [查看 README](./plugins/agy-finder/README.md) |
| [`plugins/agy-context-viewer`](./plugins/agy-context-viewer) | `context-viewer` | `v1.6.3` | 上下文窗口、速度、双配额池与 Token 看板 | macOS 顶部菜单栏 3 档徽章（切换对话自动跟随）、`⌥⌘K` 右侧独立置顶小窗、`5h + Week` 配额池与 53 周热力图 | [查看 README](./plugins/agy-context-viewer/README.md) |

---

## 亮点与预览

### 1. `AGY Finder` -- 右侧项目目录树与对话路径直达

- **双保险路径定位**：内置 `rules/AGENTS.md` 让回答中的文件附带 `[📂](sidecar://agy-finder/tree/?path=...)` 快捷入口；同时仅在面板可见时按字节偏移增量读取 `transcript_full.jsonl`，提取对话提及路径芯片，对历史对话同样有效。
- **零冲突快捷键与轻交互**：macOS 下默认 `⌘⇧E`（基于 Carbon `RegisterEventHotKey`，仅在 `Antigravity` 前台生效、无需辅助功能权限），Windows / Linux 可通过 `agy-finder toggle` 绑定全局热键；支持模糊检索、剪贴板路径直跳、原生文件预览与系统文件管理器定位。

### 2. `Context & Token Viewer` -- 上下文、速度、配额与费用看板

<table>
  <tr>
    <td width="50%" align="center" valign="top">
      <img src="plugins/agy-context-viewer/docs/images/pinned-float-window.png" width="320" alt="右侧独立置顶小窗" />
      <br/>
      <b>右侧独立置顶小窗（<code>📌</code> + <code>⌥⌘K</code>）</b><br/>
      <sub>与代码、Artifacts、终端同屏常驻；支持 macOS 菜单栏 3 档徽章与切换会话自动跟随</sub>
    </td>
    <td width="50%" align="center" valign="top">
      <img src="plugins/agy-context-viewer/docs/images/context-overview.png" width="320" alt="当前会话上下文与缓存率" />
      <br/>
      <b>当前会话 · 上下文构成与缓存命中率</b><br/>
      <sub>预算水位圆环、待发送估算、三段上下文拆解与四维累计吞吐</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center" valign="top">
      <img src="plugins/agy-context-viewer/docs/images/usage-trends.png" width="320" alt="53 周 Token 用量趋势热力图" />
      <br/>
      <b>用量趋势 · 桌面端 + CLI 53 周日历热力图</b><br/>
      <sub>打通桌面端与 <code>agy</code> CLI 日志，支持日 / 周 / 月 / 年 / 累计多维穿透</sub>
    </td>
    <td width="50%" align="center" valign="top">
      <img src="plugins/agy-context-viewer/docs/images/cost-and-quotas.png" width="320" alt="订阅识别与 5h+Week 双配额池" />
      <br/>
      <b>费用与订阅 · Ultra / 家庭组与 <code>5h + Week</code> 配额池</b><br/>
      <sub>精准识别 <code>Google AI Pro / Ultra</code>，支持家庭组共享 / AA 拼车折算</sub>
    </td>
  </tr>
</table>

---

## 快速安装

> **环境要求**：本机需安装 `Node.js >= 18`。macOS 原生菜单栏、置顶小窗与独立抽屉首次编译需具备 Swift 工具链（未安装时运行 `xcode-select --install`）；Windows / Linux 下宿主内嵌 Aux Pane 与终端 CLI 完整可用。

### 方式 1：macOS / Linux 一键安装（支持全部或单插件）

```bash
# 安装仓库内全部插件
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.sh)"

# 仅安装指定插件（支持目录名或 plugin.json 的 name）
curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.sh | bash -s -- agy-finder
curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.sh | bash -s -- agy-context-viewer

# 卸载全部（或追加插件名卸载指定插件）
curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.sh | bash -s -- --uninstall
```

### 方式 2：Windows PowerShell 一键安装

```powershell
# 安装全部插件
irm https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.ps1 | iex

# 仅安装指定插件（如 agy-finder 或 agy-context-viewer）
$env:AGY_PLUGIN="agy-finder"; irm https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.ps1 | iex
```

### 方式 3：克隆仓库后本地安装或通过 `agy` CLI 安装

```bash
git clone https://github.com/Dong-Kevin/agy-plugins.git
cd agy-plugins

# 查看可用插件列表
./install.sh --list

# 安装全部或指定插件
./install.sh
./install.sh agy-finder

# Windows PowerShell：
# .\install.ps1 -List
# .\install.ps1 -Plugin agy-finder, agy-context-viewer

# 或使用官方 agy CLI 安装单个插件子目录：
agy plugin install ./plugins/agy-finder
agy plugin install ./plugins/agy-context-viewer
```

### 方式 4：通过 `plugins.json` 直接挂载（开发 / 团队共享）

可将本仓库 `plugins/` 目录直接注册到全局 `~/.gemini/config/plugins.json` 或工作区 `.agents/plugins.json`（参考 [官方 JSON 配置文档](https://antigravity.google/docs/plugins)）：

```json
{
  "entries": [
    { "path": "/path/to/agy-plugins/plugins" }
  ]
}
```

也可以前往 [Releases](https://github.com/Dong-Kevin/agy-plugins/releases) 下载对应插件的离线压缩包与 `.sha256` 校验文件后解压安装。

---

## 目录结构与新增插件

```text
agy-plugins/
├── README.md                          # 仓库中文总览
├── README_EN.md                       # 仓库英文总览
├── AGENTS.md                          # 仓库开发、安全与发布约束
├── ROADMAP.md                         # 仓库里程碑与验证记录
├── LICENSE                            # MIT License
├── install.sh                         # 统一安装 / 列表 / 卸载脚本（macOS / Linux）
├── install.ps1                        # 统一安装 / 列表 / 卸载脚本（Windows PowerShell）
├── plugins/
│   ├── agy-finder/                    # 项目目录树插件（v0.1.0）
│   └── agy-context-viewer/            # 上下文与 Token 看板插件（context-viewer v1.6.3）
└── scripts/
    ├── verify.mjs                     # 全仓规范、隐私、PNG 元数据、子插件与安装器门禁
    ├── package-all.mjs                # 零依赖构建各插件独立 Release ZIP 与 SHA-256
    └── pre-push                       # 仓库管理的 Git pre-push 门禁脚本
```

### 新增插件清单（Contributor Checklist）

1. 在 `plugins/<plugin-dir>/` 下按官方结构创建 `plugin.json`（`repository` 统一填写 `"https://github.com/Dong-Kevin/agy-plugins"`，`homepage` 指向 `.../tree/main/plugins/<plugin-dir>`）、`assets/logo.svg`、`README.md` 与跨平台 `install.sh` / `install.ps1`。
2. 确保 `plugin.json` 的 `name` 与内部 `skills/<skill>/` 名称在全仓内全局唯一。
3. Sidecar 前端自定义 CSS 变量使用独立命名空间前缀，避免与宿主注入的 `--muted`、`--accent`、`--border` 等变量冲突，且不得引入外部 `http(s)://` 静态资源。
4. 为新插件补充 `plugins/<plugin-dir>/scripts/verify.mjs`，并同步更新 `scripts/package-all.mjs`。
5. 运行下方全仓校验与打包命令，确认全部检查通过后再提交。

---

## 本地校验与打包

```bash
# 运行全仓结构、官方 Schema、隐私脱敏、PNG 元数据、Git 身份及所有子插件自检
node scripts/verify.mjs --strict-git-identity

# 构建全部插件的独立发行包至 dist/ 目录并校验 SHA-256
node scripts/package-all.mjs
```

> 启用仓库管理的推送前隐私门禁：`ln -sf ../../scripts/pre-push .git/hooks/pre-push`（本仓库已默认链接）。

---

## 隐私与安全原则

- **零外部运行时依赖**：仅使用 `Node.js >= 18` 标准库与操作系统原生能力。
- **100% 本地只读**：所有会话日志与状态采集仅在本地完成，不上传对话内容、文件路径、凭据或任何遥测数据。
- **零侵入宿主**：不修改 `Antigravity.app` 安装包或全局 `~/.gemini/config/config.json`。
- **严格隐私门禁**：所有源码、文档与截图均通过 `scripts/verify.mjs` 的本地路径、凭据模式、PNG 元数据块与 Git `noreply` 提交身份校验。

---

## 致谢

- `plugins/agy-context-viewer` 在构思之初深受开源项目 **[elviscjn-cjn/antigravity-context-viewer](https://github.com/elviscjn-cjn/antigravity-context-viewer)** 的启发，谨向原作者致以诚挚感谢！

---

## License

基于 [MIT License](./LICENSE) 开源。
