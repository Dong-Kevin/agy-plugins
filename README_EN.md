# AGY Plugins

[![Plugins](https://img.shields.io/badge/plugins-2-38bdf8)](#plugin-catalog)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-818cf8)](#quick-install)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D%2018-22c55e)](#quick-install)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-a855f7)](#privacy--security)
[![License: MIT](https://img.shields.io/badge/License-MIT-f59e0b.svg)](./LICENSE)

**[简体中文](./README.md)** | **English** · [Plugin Catalog](#plugin-catalog) · [Shortcuts & Commands](#shortcuts--quick-commands) · [Highlights & Previews](#highlights--previews) · [Quick Install](#quick-install) · [Structure & Adding Plugins](#repository-structure--adding-plugins) · [Verification](#local-verification--packaging) · [Acknowledgements](#acknowledgements)

An open-source plugin collection for **Google Antigravity Desktop (`agy` App / IDE)** and the **`agy` CLI**.

Every plugin is built strictly on Antigravity's official `plugin.json` and `sidecar_sdk` specifications — **zero `app.asar` patching, zero CDP injection, zero external `npm` runtime dependencies, and 100% local read-only telemetry**, keeping client signatures and updates intact with a cross-platform standard-library design (**macOS** verified end-to-end on hardware; **Windows / Linux** supported via embedded Aux Pane, CLI, and browser `--app` fallbacks).

---

## Plugin Catalog

| Directory | Plugin `name` | Version | Default Shortcuts & Quick Commands | Purpose | Docs |
| :--- | :--- | :--- | :--- | :--- | :--- |
| [`plugins/agy-finder`](./plugins/agy-finder) | `agy-finder` | `v0.2.7` | `⌘⇧E` (drawer) · `⌥⌘E` (Aux Pane) · `/agy-finder` · `[📂]` · `agy-finder aux` | Right-side Project File Tree & Instant Path Reveal | [README](./plugins/agy-finder/README_EN.md) |
| [`plugins/agy-context-viewer`](./plugins/agy-context-viewer) | `context-viewer` | `v1.7.8` | `⌥⌘K` (window) · `⌃⌥K` (Aux Pane) · `/context-viewer` · `agy-context aux` | Context Window, Speed, `5h + Weekly` Quotas & Token Analytics | [README](./plugins/agy-context-viewer/README_EN.md) |

---

## Shortcuts & Quick Commands

| Trigger | `AGY Finder` (`agy-finder`) | `Context & Token Viewer` (`context-viewer`) |
| :--- | :--- | :--- |
| **Floating Window / Drawer** | **`⌘⇧E`** toggles the right-side file tree drawer (Host-frontmost by default, supports click-to-record custom chords, `⌘⌥E` / `⌃⇧E` / `⌘⇧Y` presets, or global scope; zero Accessibility prompt) | **`⌥⌘K`** toggles the right-side pinned floating window (Host-frontmost by default, supports click-to-record custom chords or global scope); **`⌘⇧P`** toggles pin, **`⌘W`** closes |
| **AGY Right Aux Pane & Menu Bar** | **`⌥⌘E`** (Win / Linux: `Ctrl+Alt+E`) opens or switches Antigravity's Right Aux Pane straight to **File Tree** (wakes from `Overview` or cross-plugin states; right-click tab → `Pin Tab` to stay pinned across threads; customizable); **`⌘⇧B`** / **`Ctrl+Shift+B`** toggles the host Aux Pane | **`⌃⌥K`** (Win / Linux: `Ctrl+Alt+Shift+K`) opens or switches Antigravity's Right Aux Pane straight to **Context Dashboard** (wakes from `Overview` or cross-plugin states; right-click tab → `Pin Tab` to stay pinned across threads; customizable); macOS Menu Bar **left-click (`<5ms`) toggles window, right-click cycles 3 metrics** |
| **In-Chat Slash & Deep Links** | Type **`/agy-finder`**; click `[📂]` next to any file reference or [`sidecar://agy-finder/tree/`](sidecar://agy-finder/tree/) | Type **`/context-viewer`**; or open [`sidecar://context-viewer/dashboard/`](sidecar://context-viewer/dashboard/) |
| **Terminal CLI Commands** | `agy-finder` (toggles drawer) · `agy-finder aux [path]` (toggles AGY Aux Pane File Tree)<br/>`agy-finder open [path]` · `close` · `shortcut [<combo>\|off\|reset]` · `aux-shortcut [<combo>\|off\|reset]` · `hotkey <preset>` · `status [--json]` · `quit` | `agy-context` (rich ANSI terminal summary) · `agy-context aux` (toggles AGY Aux Pane Dashboard)<br/>`agy-context float [close\|quit]` · `menubar [context\|speed\|quota\|on\|off]` · `shortcut [status\|<combo>\|reset\|off\|--global]` · `aux-shortcut [status\|<combo>\|reset\|off]` · `turns` · `json [--full]` · `web` |
| **In-Panel Actions** | `↑` / `↓` move · `←` / `→` collapse/expand · `Enter` preview/toggle · `/` or `⌘/Ctrl+F` search · `⌘/Ctrl+.` dotfiles · `?` shortcuts · `Esc` dismiss | Palette drawer records dual custom shortcuts & 5 heatmap themes · Ceiling switcher (`Auto / 200K / 256K / 1M`) · Top capsules jump to views |

---

## Highlights & Previews

### 1. `AGY Finder` — Workspace File Tree & Instant Reveal

- **Dual-Safety Reveal**: Bundled `rules/AGENTS.md` pairs `[file](file:///...)` preview links with compact `[📂](sidecar://agy-finder/tree/?path=...)` deep links, while byte-offset incremental `transcript_full.jsonl` parsing surfaces clickable **Mention** chips even on older threads (`0%` CPU when hidden).
- **Dual Conflict-Free Shortcuts & Actions**: Native macOS **`⌘⇧E`** toggles the standalone right-side drawer and **`⌥⌘E`** jumps straight into Antigravity's Right Aux Pane File Tree (both click-to-record customizable with zero Accessibility prompts); Windows / Linux users can bind `agy-finder toggle` / `agy-finder aux`; includes fuzzy search, clipboard jump, inline preview modal, and OS file manager reveal.

<table>
  <tr>
    <td width="50%" align="center" valign="top">
      <img src="plugins/agy-finder/docs/images/finder-tree-reveal.png" width="320" alt="AGY Finder Chat Mentions and Tree Highlight Reveal" />
      <br/>
      <b>Mention Chips + Path Bar & Highlighted Tree Reveal</b><br/>
      <sub>Aggregates mentioned workspace files at the top; one click expands folders, selects the target, and offers preview / copy / OS reveal</sub>
    </td>
    <td width="50%" align="center" valign="top">
      <img src="plugins/agy-finder/docs/images/finder-shortcuts.png" width="320" alt="AGY Finder Dual Customizable Shortcuts and Keyboard Navigation" />
      <br/>
      <b>Dual Customizable Shortcuts (<code>⌘⇧E</code> Drawer / <code>⌥⌘E</code> Aux Pane)</b><br/>
      <sub>Record custom chords for both the floating drawer and AGY's Right Aux Pane, toggle Host-only vs. global scope, and navigate via keyboard</sub>
    </td>
  </tr>
</table>

### 2. `Context & Token Viewer` — Context, Speed, Quotas & Cost Dashboard

<table>
  <tr>
    <td width="50%" align="center" valign="top">
      <img src="plugins/agy-context-viewer/docs/images/pinned-float-window.png" width="320" alt="Right-Side Pinned Floating Window" />
      <br/>
      <b>Right-Side Pinned Floating Window (<code>📌</code> + <code>⌥⌘K</code>)</b><br/>
      <sub>Stays pinned beside your editor, Artifacts, and terminal; pairs with a 3-mode macOS Menu Bar indicator</sub>
    </td>
    <td width="50%" align="center" valign="top">
      <img src="plugins/agy-context-viewer/docs/images/customizer-drawer.png" width="320" alt="Dual Shortcut Recorders, Quick Entry Modes & Appearance Customizer" />
      <br/>
      <b>Dual Shortcut Recorders (<code>⌥⌘K</code> Window / <code>⌃⌥K</code> Aux Pane) & Themes</b><br/>
      <sub>Record custom hotkeys for both the floating window and AGY's Right Aux Pane, pick host-only/global scope, and customize 5 heatmap palettes</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center" valign="top">
      <img src="plugins/agy-context-viewer/docs/images/usage-trends.png" width="320" alt="53-Week Token Usage Heatmap" />
      <br/>
      <b>Usage Trends · Desktop + CLI 53-Week Heatmap</b><br/>
      <sub>Unified Desktop & <code>agy</code> CLI telemetry across Daily, Weekly, Monthly, Yearly, and Cumulative charts</sub>
    </td>
    <td width="50%" align="center" valign="top">
      <img src="plugins/agy-context-viewer/docs/images/cost-and-quotas.png" width="320" alt="Subscription & Dual 5h + Weekly Quota Pools" />
      <br/>
      <b>Cost & Quotas · Ultra / Family Sharing & Dual Pools</b><br/>
      <sub>Detects <code>Google AI Pro / Ultra</code>, supports Family Group / split-billing, and tracks <code>5h + Weekly</code> pools</sub>
    </td>
  </tr>
</table>

---

## Quick Install

> **Prerequisites & Validation Scope**: `Node.js >= 18`. End-to-end hardware validation currently covers **macOS** (including Swift native Menu Bar, floating window, and drawer; requires Xcode Command Line Tools via `xcode-select --install`). **Windows / Linux** are supported via cross-platform standard-library implementations for the embedded Aux Pane Sidecar, terminal CLIs, and browser `--app` window fallbacks (PowerShell installers, Linux desktop environments, and minimum `Node.js 18` have not yet been hardware-tested on dedicated hosts; feedback is welcome).

### Option 1: Ask Your Antigravity Agent to Install (Recommended)

Copy either prompt below directly into **Antigravity** and let the agent install, verify, and configure the CLI commands for your OS:

- **Install All Plugins (`agy-finder` + `agy-context-viewer`)**:

```text
Please install all plugins from https://github.com/Dong-Kevin/agy-plugins (on macOS/Linux run `bash -c "$(curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.sh)"`, on Windows PowerShell run `irm https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.ps1 | iex`), verify the installation status, and summarize the shortcuts and quick commands for both plugins.
```

- **Install a Single Plugin (swap `agy-finder` or `agy-context-viewer` as needed)**:

```text
Please install only the agy-finder plugin from https://github.com/Dong-Kevin/agy-plugins (on macOS/Linux run `curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.sh | bash -s -- agy-finder`, on Windows PowerShell run `$env:AGY_PLUGIN="agy-finder"; irm https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.ps1 | iex`), verify it is active, and list its shortcuts and CLI commands.
```

> **Coexisting-Plugin Upgrade Note**: When both `agy-finder` and `context-viewer` are installed on the same machine, they share the `~/.gemini/antigravity/agy_aux_pane_trigger.json` lock protocol. Please upgrade both together (via the full install command) to `agy-finder >= 0.2.4` and `context-viewer >= 1.7.4`, and ensure any previously running background daemons (`agy-finder quit` / `agy-context float quit`) and host-loaded Sidecar instances have exited or reloaded so older builds cannot bypass the new Bakery lock; single-plugin installations are unaffected.

### Option 2: macOS / Linux One-Liner (All or Single Plugin)

```bash
# Install all plugins
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.sh)"

# Install a single plugin (by folder name or manifest name)
curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.sh | bash -s -- agy-finder
curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.sh | bash -s -- agy-context-viewer

# Uninstall all (or pass plugin names)
curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.sh | bash -s -- --uninstall
```

### Option 3: Windows PowerShell One-Liner

```powershell
# Install all plugins
irm https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.ps1 | iex

# Install specific plugin(s)
$env:AGY_PLUGIN="agy-finder"; irm https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.ps1 | iex
```

### Option 4: Git Clone or Official `agy` CLI

```bash
git clone https://github.com/Dong-Kevin/agy-plugins.git
cd agy-plugins

./install.sh --list
./install.sh                        # Install all plugins (or pass plugin names)

# Windows PowerShell:
# .\install.ps1 -List
# .\install.ps1 -Plugin agy-finder, agy-context-viewer

# Or install individual plugin folders via official agy CLI:
agy plugin install ./plugins/agy-finder
agy plugin install ./plugins/agy-context-viewer
```

### Option 5: Register via `plugins.json` or Offline Releases

Add the `plugins/` directory to `~/.gemini/config/plugins.json` or `.agents/plugins.json`:

```json
{
  "entries": [
    { "path": "/path/to/agy-plugins/plugins" }
  ]
}
```

Offline ZIP packages and `.sha256` checksums are also published under [Releases](https://github.com/Dong-Kevin/agy-plugins/releases).

---

## Repository Structure & Adding Plugins

```text
agy-plugins/
├── README.md                          # Chinese repository overview
├── README_EN.md                       # English repository overview
├── AGENTS.md                          # Monorepo engineering & release guardrails
├── ROADMAP.md                         # Repository milestones & verification log
├── LICENSE                            # MIT License
├── install.sh                         # Unified installer / lister / uninstaller (macOS / Linux)
├── install.ps1                        # Unified installer / lister / uninstaller (Windows PowerShell)
├── plugins/
│   ├── agy-finder/                    # Project file tree plugin (v0.2.7)
│   └── agy-context-viewer/            # Context & token analytics plugin (context-viewer v1.7.8)
└── scripts/
    ├── verify.mjs                     # Repo-wide schema, privacy, PNG metadata, plugin & installer suite
    ├── package-all.mjs                # Zero-dependency Release ZIP + SHA-256 packager
    └── pre-push                       # Repository-managed Git pre-push privacy gate
```

### Adding a New Plugin

1. Create `plugins/<plugin-dir>/` following the official layout (`plugin.json` with `"repository": "https://github.com/Dong-Kevin/agy-plugins"`, `"homepage"` pointing to `.../tree/main/plugins/<plugin-dir>`, `assets/logo.svg`, `README.md`, `install.sh`, `install.ps1`).
2. Keep `plugin.json` `name` and bundled `skills/<name>/` names globally unique across `plugins/*`.
3. Namespace all custom CSS variables in sidecar UIs (e.g., `--af-*`, `--cv-*`) and never load external `http(s)://` assets in HTML/CSS.
4. Include `plugins/<plugin-dir>/scripts/verify.mjs` and register the plugin in `scripts/package-all.mjs`.
5. Run the repository verification and packaging suites before committing.

---

## Local Verification & Packaging

```bash
# Run repo-wide structure, schema, privacy, PNG metadata, Git identity & all plugin tests
node scripts/verify.mjs --strict-git-identity

# Build standalone Release ZIPs + SHA-256 files into dist/
node scripts/package-all.mjs
```

---

## Privacy & Security

- **Zero External Runtime Dependencies**: Built strictly with `Node.js >= 18` standard library and OS-native components.
- **100% Local Read-Only**: Conversation archives and status endpoints are processed strictly locally; zero prompts, paths, or credentials leave the machine.
- **Non-Intrusive Host Boundary**: Never modifies `Antigravity.app` binaries or `~/.gemini/config/config.json`.
- **Automated Gate**: `scripts/verify.mjs` enforces path/credential/PNG-chunk/Git-noreply checks across the entire repository.

---

## Acknowledgements

- `plugins/agy-context-viewer` was originally inspired by **[elviscjn-cjn/antigravity-context-viewer](https://github.com/elviscjn-cjn/antigravity-context-viewer)** — sincere thanks to the original author for pioneering Antigravity context and quota visualization!

---

## License

Licensed under the [MIT License](./LICENSE).
