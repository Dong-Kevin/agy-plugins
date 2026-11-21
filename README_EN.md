# AGY Plugins

An open-source plugin suite for **Google Antigravity** (Desktop & `agy` CLI) -- **zero runtime dependencies**, **zero client binary patching**, and **atomic hot upgrades** for instant file navigation and live context/quota telemetry.

[简体中文](README.md) | **English**

| Plugin | What It Does | Version | Docs |
| :--- | :--- | :---: | :--- |
| **`agy-finder`** | Right-side file tree, chat `[📂]` reveal & HTML `[🌐]` browser launch, conversation mentions, native preview & `⌘⇧E` drawer | `v0.2.9` | [EN](plugins/agy-finder/README_EN.md) · [中文](plugins/agy-finder/README.md) |
| **`context-viewer`** | Context gauge, 10-category spectrum, session & per-model cache rates, Swarm tree, custom date trends, dual quota pools, Menu Bar & pinned float | `v1.9.0` | [EN](plugins/agy-context-viewer/README_EN.md) · [中文](plugins/agy-context-viewer/README.md) |

---

## One-Sentence Agent Install

Paste either prompt directly into Antigravity to install, verify availability, and summarize shortcuts automatically:

> **Install all plugins:**
> ```text
> Please install all plugins from https://github.com/Dong-Kevin/agy-plugins (on macOS/Linux run `bash -c "$(curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.sh)"`, on Windows PowerShell run `irm https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.ps1 | iex`), verify the installation status, and summarize the shortcuts for both plugins.
> ```
> **Install a single plugin** (replace `agy-finder` with `context-viewer` if needed):
> ```text
> Please install only agy-finder from https://github.com/Dong-Kevin/agy-plugins (on macOS/Linux run `curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.sh | bash -s -- agy-finder`, on Windows PowerShell run `$env:AGY_PLUGIN="agy-finder"; irm https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.ps1 | iex`), verify it is active, and list its shortcuts.
> ```

<details>
<summary>Manual CLI Install / Single-Plugin / Uninstall (macOS · Linux · Windows)</summary>

```bash
# macOS / Linux -- install or hot-upgrade all plugins
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.sh)"

# Install a single plugin (agy-finder or context-viewer)
curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.sh | bash -s -- agy-finder
curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.sh | bash -s -- context-viewer

# Uninstall all (append plugin name to uninstall one)
curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.sh | bash -s -- --uninstall
```

```powershell
# Windows PowerShell -- install all
irm https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.ps1 | iex

# Install a single plugin (agy-finder or context-viewer)
$env:AGY_PLUGIN="agy-finder"; irm https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.ps1 | iex
```

</details>

---

## Shortcuts & Where to Customize

> [!TIP]
> **Stay pinned across threads:** After opening either plugin in Antigravity's Right Aux Pane, **right-click its tab and select `Pin Tab`** so new conversations won't close it.

| Action | `agy-finder` (File Tree) | `context-viewer` (Context Dashboard) | Where to Customize |
| :--- | :--- | :--- | :--- |
| **AGY Aux Pane Jump** | **`⌥⌘E`** | **`⌃⌥K`** | **In-UI Recorder + CLI**<br/>Finder: click **`⌨`** (or `?`) top-right -> **`⌥⌘E` record button**<br/>Context: click **palette icon** next to `📌` -> **`⌃⌥K` record button** |
| **Floating Drawer / Window** | **`⌘⇧E`** (macOS slide drawer) | **`⌥⌘K`** (macOS pinned float window) | **In-UI Recorder + CLI**<br/>Finder: **`⌨`** -> **`⇧⌘E` record button** / preset / **`AGY Only`**<br/>Context: **palette icon** -> **`⌥⌘K` record button** / **`Host Focus Only`** |
| **macOS Menu Bar Badge** | -- | Live **◈ / ⚡ / ⏳** indicator<br/>Left-click `<5ms` toggle · Right-click cycle modes | **Palette icon** -> toggle Menu Bar & 3 display modes<br/>CLI: `agy-context menubar [context\|speed\|quota\|off]` |
| **Host Panel / Chat** | **`⌘⇧B`** / **`/agy-finder`** · **`[📂]`** | **`⌘⇧B`** / **`/context-viewer`**<br/>`⌘⇧P` pin · `⌘W` close float window | Toggle host Aux Pane visibility via native `⌘⇧B` (`Ctrl+Shift+B` on Win/Linux) |
| **Terminal CLI** | `agy-finder` · `agy-finder aux [path]` | `agy-context` · `aux` · `float` · `web` | CLI keybinding updates:<br/>`agy-finder shortcut\|aux-shortcut <combo\|reset>`<br/>`agy-context shortcut\|aux-shortcut <combo\|reset>` |
| **Themes & Split-Billing** | Moon button **`🌙`** toggles light/dark | **5 heatmap palettes** in palette drawer<br/>Custom family/shared plan split-billing | Context: **palette icon** (theme & 5-stop colors)<br/>`Cost & Quota` tab top-right **`Customize Plan ✎`** |

<details>
<summary>Platform Support Notes (macOS · Windows · Linux)</summary>

- **macOS**: Both `agy-finder` drawer/hotkeys and `context-viewer` Menu Bar/pinned float use compiled native Swift binaries scoped to Antigravity focus by default (**zero Accessibility permissions required**, optional global scope toggle in UI).
- **Windows / Linux**: Native Antigravity Right Aux Pane Sidecar and `agy-finder` / `agy-context` CLI commands work out of the box; bind OS shortcuts to `agy-finder aux` / `agy-context aux` (e.g., `Ctrl+Shift+E` / `Ctrl+Alt+K`) if desired.

</details>

---

## Visual Preview

<table>
  <tr>
    <td align="center" width="33%">
      <strong>Tree Reveal &amp; Mentions (Finder)</strong><br/>
      <img src="plugins/agy-finder/docs/images/finder-tree-reveal.png" width="265" alt="AGY Finder Tree Reveal" />
    </td>
    <td align="center" width="33%">
      <strong>Shortcut Recorder (`⌨` Panel)</strong><br/>
      <img src="plugins/agy-finder/docs/images/finder-shortcuts.png" width="265" alt="AGY Finder Shortcuts Panel" />
    </td>
    <td align="center" width="33%">
      <strong>Context &amp; Speed (Context)</strong><br/>
      <img src="plugins/agy-context-viewer/docs/images/context-overview.png" width="245" alt="Context Viewer Context Overview" />
    </td>
  </tr>
  <tr>
    <td align="center">
      <strong>Dual Pools &amp; Costs (Context)</strong><br/>
      <img src="plugins/agy-context-viewer/docs/images/cost-and-quotas.png" width="245" alt="Context Viewer Dual Quota Pools" />
    </td>
    <td align="center">
      <strong>53-Week Heatmap (Context)</strong><br/>
      <img src="plugins/agy-context-viewer/docs/images/usage-trends.png" width="245" alt="Context Viewer 53-Week Trends" />
    </td>
    <td align="center">
      <strong>Shortcuts &amp; Palette Drawer</strong><br/>
      <img src="plugins/agy-context-viewer/docs/images/customizer-drawer.png" width="250" alt="Context Viewer Customizer Drawer" />
    </td>
  </tr>
</table>

---

## Acknowledgements

- `plugins/agy-context-viewer` was originally inspired by **[elviscjn-cjn/antigravity-context-viewer](https://github.com/elviscjn-cjn/antigravity-context-viewer)** -- the pioneering open-source project that first explored context breakdown, token activity heatmaps, and model quota visualization for Google Antigravity. Sincere thanks and respect to the original author!

---

## Local Verification & License

```bash
node scripts/verify.mjs --strict-git-identity   # Schema, privacy & PNG metadata checks
node scripts/package-all.mjs                    # Build per-plugin ZIP bundles & SHA-256
```

- See each plugin's README for full CLI options and platform notes. Released under the [MIT License](LICENSE).
