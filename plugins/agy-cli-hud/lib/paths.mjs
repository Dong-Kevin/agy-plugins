/**
 * Centralized path resolution and atomic file utilities for agy-cli-hud.
 * Zero external dependencies. Supports full env isolation for tests.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export function resolveHomeDir() {
  return resolve(process.env.AGY_HUD_HOME || process.env.HOME || process.env.USERPROFILE || homedir());
}

export function resolveAgyCliHome() {
  if (process.env.AGY_CLI_HOME) return resolve(process.env.AGY_CLI_HOME);
  if (process.env.CLI_AGENTS_AGY_HOME) return resolve(process.env.CLI_AGENTS_AGY_HOME);
  return join(resolveHomeDir(), '.gemini', 'antigravity-cli');
}

export function resolveAgyDesktopHome() {
  if (process.env.AGY_DESKTOP_HOME) return resolve(process.env.AGY_DESKTOP_HOME);
  return join(resolveHomeDir(), '.gemini', 'antigravity');
}

export function resolveHudDataDir() {
  if (process.env.AGY_HUD_DATA_DIR) return resolve(process.env.AGY_HUD_DATA_DIR);
  return join(resolveAgyCliHome(), 'cache', 'agy-cli-hud');
}

export function resolveHudPaths() {
  const dataDir = resolveHudDataDir();
  const colabDir = join(dataDir, 'colab');
  const cliHome = resolveAgyCliHome();
  const desktopHome = resolveAgyDesktopHome();
  return {
    cliHome,
    cliBrainDir: join(cliHome, 'brain'),
    cliConversationsDir: join(cliHome, 'conversations'),
    cliSettingsPath: join(cliHome, 'settings.json'),
    desktopBrainDir: join(desktopHome, 'brain'),
    desktopConversationsDir: join(desktopHome, 'conversations'),
    desktopSettingsPath: join(desktopHome, 'sidecar_data', 'context-viewer', 'dashboard', 'data', 'settings_v1.json'),
    desktopHostCachePath: join(desktopHome, 'sidecar_data', 'context-viewer', 'dashboard', 'data', 'host_status_cache_v1.json'),
    legacyColabDataDir: join(desktopHome, 'plugin_data', 'agy-colab-panel'),
    dataDir,
    configPath: join(dataDir, 'config.v1.json'),
    cursorStatePath: join(dataDir, 'incremental_state.v1.json'),
    snapshotPath: join(dataDir, 'usage-hud.v1.json'),
    summaryPath: join(dataDir, 'statusline_summary.v1.json'),
    liveSessionPath: join(dataDir, 'live_statusline.v1.json'),
    syncStampPath: join(dataDir, 'last_sync.stamp'),
    soloSyncStampPath: join(dataDir, 'sync.stamp'),
    syncLockPath: join(dataDir, 'sync.lock'),
    colabDir,
    colabConfigPath: join(colabDir, 'config.json'),
    colabTokenPath: join(colabDir, 'token.json'),
    colabCachePath: join(colabDir, 'colab_cache.v1.json'),
    colabSniperPath: join(colabDir, 'sniper_state.v1.json')
  };
}

export function ensurePrivateDir(dirPath) {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try { chmodSync(dirPath, 0o700); } catch {}
  }
}

export function readJsonSafe(filePath, fallback = null) {
  try {
    if (!existsSync(filePath)) return fallback;
    const raw = readFileSync(filePath, 'utf8');
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(filePath, value, { mode = 0o600, pretty = false } = {}) {
  const dir = dirname(filePath);
  ensurePrivateDir(dir);
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`;
  const body = pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value);
  try {
    writeFileSync(tmpPath, body, { encoding: 'utf8', mode });
    if (process.platform !== 'win32') {
      try { chmodSync(tmpPath, mode); } catch {}
    }
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

export function formatLocalDateKey(inputDate = new Date()) {
  const d = inputDate instanceof Date ? inputDate : new Date(inputDate);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function formatLocalMonthKey(inputDate = new Date()) {
  const dayKey = formatLocalDateKey(inputDate);
  return dayKey ? dayKey.slice(0, 7) : null;
}
