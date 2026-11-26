# AGY CLI HUD (`agy-cli-hud`)

Zero-dependency, low-latency CLI HUD & compliant Google Colab telemetry plugin built for **`agy` CLI** and **Solo**.

- **Clear product split**: `agy-context-viewer` remains dedicated to Antigravity Desktop App / IDE; `agy-cli-hud` targets terminal CLI and Solo native drawer with zero WebView, zero floating windows, and zero CDP injection.
- **Layered status bar below the prompt**: Uses `agy` CLI's official `statusLine` contract with default **2-line** (optional 3-line or 1-line) width-adaptive layout, bounded stdin timeout, single-instance background sync locking, and default non-blocking Solo async bypass (opt-in `--solo-sync`) to prevent `signal: killed` timeouts.
- **Restrained multi-theme palette**: Inspired by `token-tracker`, ships with **6 curated themes** (`mocha` default, `latte`, `frappe`, `macchiato`, `nord`, `dracula`) featuring calm semantic row grouping, single-hue threshold bars, and automatic 256-color fallback.
- **Incremental JSONL rollup**: Byte-offset cursor with `step_index` deduplication computes session average cache hit rate, today/month token usage, and API retail reference cost / subscription leverage in milliseconds.
- **Native dual-pool quotas**: Reads `gemini-5h`, `gemini-weekly`, `3p-5h`, and `3p-weekly` directly from `agy` callbacks, normalized to remaining percentage.
- **Solo native drawer snapshot**: Atomically writes `~/.gemini/antigravity-cli/cache/agy-cli-hud/usage-hud.v1.json` for Solo's native right-side **Usage (`⌘U`)** drawer.
- **Compliant Google Colab monitoring**: Official OAuth 2.0 (PKCE) + `colaboratory.googleapis.com/v1beta` REST API for tier, CU balance, CU/h rate, GPU RAM/VRAM/utilization/idle countdown, keep-alive, release, and low-frequency queue polling.

## Quick Install

```bash
./install.sh agy-cli-hud
```

## Usage

```bash
agy-hud install-statusline --lines 2
agy-hud status
agy-hud theme list
agy-hud theme set nord
agy-hud config set lines 3
agy-hud watch
agy-hud colab import-secret ./client_secret.json
agy-hud colab login
```
