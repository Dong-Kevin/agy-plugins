<img src="assets/logo.svg" width="84" align="right" alt="AGY Finder Logo" />

# AGY Finder (`agy-finder`)

[![Version](https://img.shields.io/badge/version-v0.2.3-38bdf8)](https://github.com/Dong-Kevin/agy-plugins/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-818cf8)](#installation)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D%2018-22c55e)](#installation)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-a855f7)](#key-features)
[![License: MIT](https://img.shields.io/badge/License-MIT-f59e0b.svg)](./LICENSE)

**[简体中文](./README.md)** | **English** · [Screenshots](#screenshots) · [Shortcuts & CLI](#shortcuts--cli) · [Key Features](#key-features) · [Installation](#installation) · [Local Development](#local-development--verification)

A lightweight, zero-dependency, cross-platform (macOS / Windows / Linux) **Google Antigravity** Auxiliary Pane & floating drawer file-tree plugin, maintained in **[Dong-Kevin/agy-plugins](https://github.com/Dong-Kevin/agy-plugins)**.

Designed to give Antigravity Desktop a persistent workspace explorer and instant jump-to-file reveal from agent replies using a **dual-safety approach: inline deep links + incremental `transcript_full.jsonl` mention extraction**.

---

## Screenshots

<table>
  <tr>
    <td width="33%" align="center" valign="top">
      <img src="docs/images/finder-tree-reveal.png" width="268" alt="AGY Finder Mention Chips and Tree Highlight Reveal" />
      <br/>
      <b>Mention Chips & Highlighted Reveal</b><br/>
      <sub>Collects mentioned files into quick chips; one click expands the tree, highlights the file, and offers copy / preview actions</sub>
    </td>
    <td width="33%" align="center" valign="top">
      <img src="docs/images/finder-shortcuts.png" width="268" alt="AGY Finder Dual Custom Hotkeys and Keyboard Navigation" />
      <br/>
      <b>Dual Custom Hotkeys (<code>⌘⇧E</code> / <code>⌥⌘E</code>) & Nav</b><br/>
      <sub>Click-to-record hotkeys for Standalone Drawer & AGY Right Aux Pane, frontmost/global scope, and full keyboard nav</sub>
    </td>
    <td width="33%" align="center" valign="top">
      <img src="docs/images/finder-quick-preview.png" width="268" alt="AGY Finder Inline Code Preview Modal" />
      <br/>
      <b>Lightweight Inline File Preview</b><br/>
      <sub>Double-click or hit <code>↗</code> in drawer mode to preview text/code cleanly with one-click OS file manager reveal</sub>
    </td>
  </tr>
</table>

---

## Shortcuts & CLI

| Trigger | Default Hotkey / Command | Behavior |
| :--- | :--- | :--- |
| **Right-Side Floating Drawer (macOS)** | **`⌘⇧E`** | Uses Carbon `RegisterEventHotKey` active **only when `Antigravity` is frontmost** by default — zero conflicts and **zero Accessibility permission prompts**. Click-to-record custom chords, presets (`⌘⌥E`, `⌃⇧E`, `⌘⇧Y`), or global scope via `⌨`. |
| **AGY Right Aux Pane Direct Jump (macOS)** | **`⌥⌘E`** | Wakes Antigravity's native Right Aux Pane straight to **AGY Finder File Tree** even from `Overview`, collapsed, or cross-plugin states (right-click the tab → `Pin Tab` to keep it pinned across threads; shows a native HUD prompt on unmounted cold start; customize via `⌨` or `agy-finder aux-shortcut`, with `⌥⌘` / `⌃⌥` combos recommended) |
| **Host Auxiliary Pane Toggle** | **`⌘⇧B`** (macOS)<br/>**`Ctrl+Shift+B`** (Win / Linux) | Toggles Antigravity's native Right Aux Pane; right-click the tab to `Pin Tab`. |
| **In-Chat Slash & Deep Links** | **`/agy-finder`**<br/>Click **`[📂]`** or [`sidecar://agy-finder/tree/`](sidecar://agy-finder/tree/) | Opens the file tree panel or reveals & highlights the exact target path from chat replies. |
| **Cross-Platform Terminal CLI** | **`agy-finder`** (drawer)<br/>**`agy-finder aux`** (Aux Pane) | Toggles the floating drawer or jumps into AGY's Right Aux Pane File Tree from terminal or OS hotkey tools (e.g., bind `Ctrl+Shift+E` / `Ctrl+Alt+E` on Win / Linux). |
| **In-Panel Keyboard Navigation** | `↑` / `↓` · `←` / `→` · `Enter` · `/` · `⌘/Ctrl+.` · `?` · `Esc` | Move rows, collapse/expand, preview/toggle, search files, toggle dotfiles, show shortcuts, dismiss modal/drawer. |

```bash
agy-finder                              # Same as agy-finder toggle: show/hide right-side floating drawer
agy-finder open [path]                  # Open the floating drawer and optionally reveal a path
agy-finder aux [path]                   # Reveal/switch Antigravity Right Aux Pane to File Tree (+ optional path)
agy-finder close                        # Hide the floating drawer
agy-finder status [--json]              # Inspect drawer, Aux Pane & dual shortcut state
agy-finder shortcut [<combo>|off|reset]      # View or customize floating drawer shortcut
agy-finder aux-shortcut [<combo>|off|reset]  # View or customize AGY Aux Pane shortcut
agy-finder hotkey <preset>              # Set drawer preset: cmd+shift+e | cmd+alt+e | ctrl+shift+e | cmd+shift+y | off
agy-finder quit                         # Stop the background drawer daemon
```

---

## Key Features

- **Zero External Dependencies & Non-Intrusive**: Built purely with the `Node.js >= 18` standard library, vanilla HTML / CSS / JS, and official `sidecar_sdk`. Never patches `app.asar`, never injects CDP, and never modifies `~/.agents/AGENTS.md` or `~/.gemini/config/config.json`.
- **Dual-Safety Path Reveal (Relative, Absolute, `file://`, and `:line`)**:
  1. **In-Chat Deep Links (`rules/AGENTS.md`)**: Pairs standard `[file](file:///...)` preview links with compact `[📂](sidecar://agy-finder/tree/?path=...)` reveal links that expand and pulse-highlight the target in the right tree.
  2. **100% Deterministic Fallback (`transcript_full.jsonl`)**: Polls only while the tree pane is visible (`0%` CPU when hidden), reading byte-offset deltas with `stat` caching to surface real mentioned paths as quick **Mention** chips at the top of the panel.
  3. **Fuzzy Search & Direct Path Jump**: Filter files in real time or paste any path and press `Enter` (or click `🎯` to read from clipboard) to reveal immediately, automatically mounting external project roots when needed.
- **Fast Actions**: Click to select, double-click or click `↗` to open in the host previewer (or lightweight modal in drawer mode), copy relative/absolute paths (`Shift + Click` for absolute), and reveal in Finder / Explorer / `xdg-open`.

---

## Installation

### Option 1: Ask Your Antigravity Agent to Install (Recommended)

Paste this prompt directly into **Antigravity**:

```text
Please install the AGY Finder plugin from https://github.com/Dong-Kevin/agy-plugins (on macOS/Linux run `bash -c "$(curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/plugins/agy-finder/install.sh)"`, on Windows PowerShell run `irm https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/plugins/agy-finder/install.ps1 | iex`), verify `agy-finder status`, and summarize its keyboard shortcuts.
```

### Option 2: macOS / Linux One-Liner

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/plugins/agy-finder/install.sh)"
```

Uninstall:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/plugins/agy-finder/install.sh)" -- --uninstall
```

### Option 3: Windows PowerShell One-Liner

```powershell
irm https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/plugins/agy-finder/install.ps1 | iex
```

Uninstall:

```powershell
.\plugins\agy-finder\install.ps1 -Uninstall
```

### Option 4: Install from Unified Repository Clone

```bash
git clone https://github.com/Dong-Kevin/agy-plugins.git
cd agy-plugins
./install.sh agy-finder        # Windows PowerShell: .\install.ps1 -Plugin agy-finder
```

### Option 5: Install Local Folder via Official `agy` CLI

```bash
agy plugin install ./plugins/agy-finder
```

---

## Local Development & Verification

```bash
# Run full self-check (manifest, syntax, CSS isolation, path utils, incremental log parser, loopback HTTP & installer)
node scripts/verify.mjs

# Standalone loopback preview (127.0.0.1 only)
node sidecars/tree/main.mjs --standalone --port 18980
```

## License

MIT License
