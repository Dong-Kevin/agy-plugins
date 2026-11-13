<img src="assets/logo.svg" width="84" align="right" alt="AGY Finder Logo" />

# AGY Finder (`agy-finder`)

[![Version](https://img.shields.io/badge/version-v0.1.0-38bdf8)](https://github.com/Dong-Kevin/agy-plugins/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-818cf8)](#installation)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D%2018-22c55e)](#installation)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-a855f7)](#key-features)
[![License: MIT](https://img.shields.io/badge/License-MIT-f59e0b.svg)](./LICENSE)

**[简体中文](./README.md)** | **English** · [Key Features](#key-features) · [Installation](#installation) · [Shortcuts & CLI](#shortcuts--cli) · [Local Development](#local-development--verification)

A lightweight, zero-dependency, cross-platform (macOS / Windows / Linux) **Google Antigravity** Auxiliary Pane & floating drawer file-tree plugin, maintained in **[Dong-Kevin/agy-plugins](https://github.com/Dong-Kevin/agy-plugins)**.

Designed to give Antigravity Desktop a persistent workspace explorer and instant jump-to-file reveal from agent replies using a **dual-safety approach: inline deep links + incremental `transcript_full.jsonl` mention extraction**.

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

### Option 1: macOS / Linux One-Liner

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/plugins/agy-finder/install.sh)"
```

Uninstall:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/plugins/agy-finder/install.sh)" -- --uninstall
```

### Option 2: Windows PowerShell One-Liner

```powershell
irm https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/plugins/agy-finder/install.ps1 | iex
```

Uninstall:

```powershell
.\plugins\agy-finder\install.ps1 -Uninstall
```

### Option 3: Install from Unified Repository Clone

```bash
git clone https://github.com/Dong-Kevin/agy-plugins.git
cd agy-plugins
./install.sh agy-finder        # Windows PowerShell: .\install.ps1 -Plugin agy-finder
```

### Option 4: Install Local Folder via Official `agy` CLI

```bash
agy plugin install ./plugins/agy-finder
```

---

## Shortcuts & CLI

- **macOS Native Drawer Hotkey (`⌘⇧E` by default)**: Uses Carbon `RegisterEventHotKey` active **only when `Antigravity` is frontmost** — zero VS Code conflicts and **zero Accessibility permission prompts**. Switch presets (`⌘⇧E`, `⌘⌥E`, `⌃⇧E`, `⌘⇧Y`, or `off`) via the `⌨` button.
- **Host Aux Pane Toggle**: `⌘⇧B` (macOS) / `Ctrl+Shift+B` (Windows / Linux); right-click the tab to `Pin Tab`.
- **Cross-Platform CLI**:

```bash
agy-finder toggle              # Toggle the right-side file tree drawer (bind Ctrl+Shift+E on Windows/Linux)
agy-finder open [path]         # Open the drawer and optionally reveal a path
agy-finder close               # Hide the drawer
agy-finder status [--json]     # Inspect drawer & hotkey state
agy-finder hotkey <preset>     # Set hotkey preset: cmd+shift+e | cmd+alt+e | ctrl+shift+e | cmd+shift+y | off
agy-finder quit                # Stop the background drawer daemon
```

- **Full In-Panel Keyboard Navigation**: `↑` / `↓` move, `←` / `→` collapse/expand, `Enter` preview/toggle, `/` or `⌘/Ctrl+F` search, `⌘/Ctrl+.` toggle dotfiles, `?` shortcut help, `Esc` dismiss modal/drawer.

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
