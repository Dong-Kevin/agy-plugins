# AGY Plugins (`Dong-Kevin/agy-plugins`)

[![Plugins](https://img.shields.io/badge/plugins-2-38bdf8)](#plugin-catalog)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-818cf8)](#quick-install)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D%2018-22c55e)](#quick-install)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-a855f7)](#privacy--security)
[![License: MIT](https://img.shields.io/badge/License-MIT-f59e0b.svg)](./LICENSE)

**[简体中文](./README.md)** | **English** · [Plugin Catalog](#plugin-catalog) · [Highlights & Previews](#highlights--previews) · [Quick Install](#quick-install) · [Structure & Adding Plugins](#repository-structure--adding-plugins) · [Verification](#local-verification--packaging) · [Acknowledgements](#acknowledgements)

An open-source plugin collection for **Google Antigravity Desktop (`agy` App / IDE)** and the **`agy` CLI**.

Every plugin is built strictly on Antigravity's official `plugin.json` and `sidecar_sdk` specifications — **zero `app.asar` patching, zero CDP injection, zero external `npm` runtime dependencies, and 100% local read-only telemetry**, keeping client signatures and updates intact across **macOS, Linux, and Windows**.

---

## Plugin Catalog

| Directory | Plugin `name` | Version | Purpose | Key Highlights | Docs |
| :--- | :--- | :--- | :--- | :--- | :--- |
| [`plugins/agy-finder`](./plugins/agy-finder) | `agy-finder` | `v0.1.0` | Right-side Project File Tree & Path Reveal | Inline `[📂]` deep links + incremental `transcript_full.jsonl` fallback, conflict-free `⌘⇧E` native macOS drawer & preview | [README](./plugins/agy-finder/README_EN.md) |
| [`plugins/agy-context-viewer`](./plugins/agy-context-viewer) | `context-viewer` | `v1.6.3` | Context Window, Speed, Quotas & Token Analytics | 3-mode macOS Menu Bar badge (auto-follows active chat), `⌥⌘K` pinned floating window, `5h + Weekly` quota pools & 53-week heatmap | [README](./plugins/agy-context-viewer/README_EN.md) |

---

## Highlights & Previews

### 1. `AGY Finder` — Workspace File Tree & Instant Reveal

- **Dual-Safety Reveal**: Bundled `rules/AGENTS.md` appends compact `[📂](sidecar://agy-finder/tree/?path=...)` deep links to agent file references, while byte-offset incremental `transcript_full.jsonl` parsing surfaces quick **Mention** chips even on older threads (`0%` CPU when hidden).
- **Conflict-Free Shortcuts & Actions**: Native macOS `⌘⇧E` via Carbon `RegisterEventHotKey` (active only when `Antigravity` is frontmost, zero Accessibility permission prompts), plus `agy-finder toggle` CLI for Windows/Linux global hotkeys, fuzzy search, clipboard jump, and OS file manager reveal.

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
      <img src="plugins/agy-context-viewer/docs/images/context-overview.png" width="320" alt="Context Window Breakdown & Cache Hit Rate" />
      <br/>
      <b>Current Session · Context & Cache Breakdown</b><br/>
      <sub>Budget ring gauge, unsent input estimate, 3-part prompt breakdown, and 4D throughput</sub>
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

> **Prerequisites**: `Node.js >= 18`. On macOS, native Menu Bar / floating window / drawer compilation requires Xcode Command Line Tools (`xcode-select --install`). On Windows / Linux, the embedded Aux Pane Sidecar and terminal CLIs work out of the box.

### Option 1: macOS / Linux One-Liner (All or Single Plugin)

```bash
# Install all plugins
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.sh)"

# Install a single plugin (by folder name or manifest name)
curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.sh | bash -s -- agy-finder
curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.sh | bash -s -- agy-context-viewer

# Uninstall all (or pass plugin names)
curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.sh | bash -s -- --uninstall
```

### Option 2: Windows PowerShell One-Liner

```powershell
# Install all plugins
irm https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.ps1 | iex

# Install specific plugin(s)
$env:AGY_PLUGIN="agy-finder"; irm https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.ps1 | iex
```

### Option 3: Git Clone or Official `agy` CLI

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

### Option 4: Register via `plugins.json`

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
│   ├── agy-finder/                    # Project file tree plugin (v0.1.0)
│   └── agy-context-viewer/            # Context & token analytics plugin (context-viewer v1.6.3)
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
