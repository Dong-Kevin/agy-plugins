/**
 * Cross-platform Quick-Toggle Right-Side Drawer & Hotkey Controller (`drawer.mjs`).
 *
 * - macOS: Compiles & caches `native_drawer_macos.swift` once into sidecar data dir,
 *   providing zero-port WKWebView right-side drawer + app-scoped Carbon hotkey
 *   (active ONLY when Antigravity or the drawer itself is frontmost — zero TCC
 *   Accessibility prompts and zero VS Code shortcut conflict).
 * - Windows / Linux: Manages a frameless Chromium/Edge `--app` drawer daemon over
 *   a 127.0.0.1 loopback server so OS hotkey tools (PowerToys / AHK / GNOME / KDE)
 *   can bind `Ctrl+Shift+E` -> `agy-finder toggle`.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
  writeSync
} from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { CONV_ID_RE, getConversationMentions } from './mentions.mjs';
import {
  listDirectoryEntries,
  readTextPreview,
  resolveTargetPath,
  revealInOsFileManager,
  searchWorkspaceFiles,
  toFileUri,
  toLocalPath
} from './path_utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..', '..');

export const DAEMON_VERSION = 2;

export const HOTKEY_PRESETS = [
  { id: 'cmd+shift+e', macLabel: '⌘⇧E', winLabel: 'Ctrl+Shift+E', desc: '默认快捷键' },
  { id: 'cmd+alt+e', macLabel: '⌘⌥E', winLabel: 'Ctrl+Alt+E', desc: '备选快捷键' },
  { id: 'ctrl+shift+e', macLabel: '⌃⇧E', winLabel: 'Ctrl+Shift+E', desc: 'Control 组合' },
  { id: 'cmd+shift+y', macLabel: '⌘⇧Y', winLabel: 'Ctrl+Shift+Y', desc: '右手顺手键' },
  { id: 'off', macLabel: '关闭', winLabel: '关闭', desc: '仅手动点击打开' }
];

const VALID_PRESETS = new Set(HOTKEY_PRESETS.map((p) => p.id));

export const DEFAULT_DRAWER_SHORTCUT_MAC = 'Shift+Meta+E';
export const DEFAULT_DRAWER_SHORTCUT_OTHER = 'Ctrl+Shift+E';
export const DEFAULT_AUX_SHORTCUT_MAC = 'Alt+Meta+E';
export const DEFAULT_AUX_SHORTCUT_OTHER = 'Ctrl+Alt+E';
export const SHORTCUT_SCOPES = ['app', 'global'];

const PRESET_TO_ACCELERATOR = Object.freeze({
  'cmd+shift+e': 'Shift+Meta+E',
  'cmd+alt+e': 'Alt+Meta+E',
  'ctrl+shift+e': 'Ctrl+Shift+E',
  'cmd+shift+y': 'Shift+Meta+Y'
});

const ACCELERATOR_TO_PRESET = Object.freeze({
  'Shift+Meta+E': 'cmd+shift+e',
  'Alt+Meta+E': 'cmd+alt+e',
  'Ctrl+Shift+E': 'ctrl+shift+e',
  'Shift+Meta+Y': 'cmd+shift+y'
});

const MAC_CARBON_KEYCODES = Object.freeze({
  A: 0, B: 11, C: 8, D: 2, E: 14, F: 3, G: 5, H: 4, I: 34, J: 38,
  K: 40, L: 37, M: 46, N: 45, O: 31, P: 35, Q: 12, R: 15, S: 1, T: 17,
  U: 32, V: 9, W: 13, X: 7, Y: 16, Z: 6,
  '0': 29, '1': 18, '2': 19, '3': 20, '4': 21,
  '5': 23, '6': 22, '7': 26, '8': 28, '9': 25,
  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97,
  F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
  Space: 49,
  Backquote: 50,
  Minus: 27,
  Equal: 24,
  BracketLeft: 33,
  BracketRight: 30,
  Backslash: 42,
  Semicolon: 41,
  Quote: 39,
  Comma: 43,
  Period: 47,
  Slash: 44
});

const MAC_CARBON_MODS = Object.freeze({
  Meta: 256,
  Shift: 512,
  Alt: 2048,
  Ctrl: 4096
});

const SHORTCUT_KEY_DISPLAY = Object.freeze({
  Space: 'Space',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/'
});

const SHORTCUT_KEY_ALIASES = Object.freeze({
  space: 'Space',
  spacebar: 'Space',
  '`': 'Backquote',
  '~': 'Backquote',
  backquote: 'Backquote',
  grave: 'Backquote',
  tilde: 'Backquote',
  '-': 'Minus',
  '_': 'Minus',
  minus: 'Minus',
  '=': 'Equal',
  equal: 'Equal',
  plus: 'Equal',
  '[': 'BracketLeft',
  '{': 'BracketLeft',
  bracketleft: 'BracketLeft',
  ']': 'BracketRight',
  '}': 'BracketRight',
  bracketright: 'BracketRight',
  '\\': 'Backslash',
  '|': 'Backslash',
  backslash: 'Backslash',
  ';': 'Semicolon',
  ':': 'Semicolon',
  semicolon: 'Semicolon',
  "'": 'Quote',
  '"': 'Quote',
  quote: 'Quote',
  ',': 'Comma',
  '<': 'Comma',
  comma: 'Comma',
  '.': 'Period',
  '>': 'Period',
  period: 'Period',
  dot: 'Period',
  '/': 'Slash',
  '?': 'Slash',
  slash: 'Slash'
});

const RESERVED_MAC_META_ONLY_KEYS = new Set([
  'A', 'C', 'F', 'H', 'M', 'N', 'Q', 'R', 'S', 'T', 'V', 'W', 'X', 'Z', 'Space'
]);
const RESERVED_OTHER_CTRL_ONLY_KEYS = new Set(['A', 'C', 'V', 'W', 'X', 'Z']);

export function getDefaultDrawerShortcut(platform = process.platform) {
  return platform === 'darwin' ? DEFAULT_DRAWER_SHORTCUT_MAC : DEFAULT_DRAWER_SHORTCUT_OTHER;
}

export function getDefaultAuxShortcut(platform = process.platform, drawerAccelerator = '') {
  const primary = platform === 'darwin' ? DEFAULT_AUX_SHORTCUT_MAC : DEFAULT_AUX_SHORTCUT_OTHER;
  const alt = platform === 'darwin' ? 'Ctrl+Alt+E' : 'Ctrl+Alt+Shift+E';
  if (drawerAccelerator && drawerAccelerator === primary) {
    return alt;
  }
  return primary;
}

function canonicalizeKeyToken(rawToken) {
  const trimmed = String(rawToken || '').trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (SHORTCUT_KEY_ALIASES[lower]) return SHORTCUT_KEY_ALIASES[lower];
  if (/^key([a-z])$/i.test(trimmed)) return trimmed.slice(3).toUpperCase();
  if (/^[a-z]$/i.test(trimmed)) return trimmed.toUpperCase();
  if (/^digit([0-9])$/i.test(trimmed)) return trimmed.slice(5);
  if (/^[0-9]$/.test(trimmed)) return trimmed;
  if (/^f([1-9]|1[0-2])$/i.test(trimmed)) return trimmed.toUpperCase();
  return null;
}

export function formatShortcutDisplay(spec, platform = process.platform) {
  const raw = String(spec || '').trim();
  if (!raw || /^(off|none|disabled?)$/i.test(raw)) return '已关闭';
  const parts = raw.split('+').filter(Boolean);
  if (!parts.length) return '已关闭';
  const keyPart = parts[parts.length - 1];
  const modSet = new Set(parts.slice(0, -1));
  const keyLabel = SHORTCUT_KEY_DISPLAY[keyPart] || keyPart;
  if (platform === 'darwin') {
    let out = '';
    if (modSet.has('Ctrl')) out += '⌃';
    if (modSet.has('Alt')) out += '⌥';
    if (modSet.has('Shift')) out += '⇧';
    if (modSet.has('Meta')) out += '⌘';
    return `${out}${keyLabel}`;
  }
  const mods = [];
  if (modSet.has('Ctrl')) mods.push('Ctrl');
  if (modSet.has('Alt')) mods.push('Alt');
  if (modSet.has('Shift')) mods.push('Shift');
  if (modSet.has('Meta')) mods.push(platform === 'win32' ? 'Win' : 'Super');
  return [...mods, keyLabel].join('+');
}

export function shortcutToMacCarbon(spec) {
  const raw = String(spec || '').trim();
  if (!raw) return null;
  const parts = raw.split('+').filter(Boolean);
  if (!parts.length) return null;
  const keyPart = parts[parts.length - 1];
  const keyCode = MAC_CARBON_KEYCODES[keyPart];
  if (typeof keyCode !== 'number') return null;
  let modifiers = 0;
  for (const mod of parts.slice(0, -1)) {
    if (MAC_CARBON_MODS[mod]) {
      modifiers |= MAC_CARBON_MODS[mod];
    }
  }
  return { keyCode, modifiers };
}

export function normalizeShortcutSpec(raw, platform = process.platform) {
  const str = String(raw ?? '').trim();
  if (!str) {
    return { ok: false, error: '快捷键不能为空' };
  }
  if (/^(off|none|disable|disabled)$/i.test(str)) {
    return {
      ok: true,
      disabled: true,
      accelerator: '',
      display: '已关闭',
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      key: '',
      macCarbon: null
    };
  }

  const expanded = str
    .replace(/⌃/g, 'Ctrl+')
    .replace(/⌥/g, 'Alt+')
    .replace(/⇧/g, 'Shift+')
    .replace(/⌘/g, 'Meta+')
    .replace(/\+\s*\+$/g, '+Equal');

  const rawTokens = expanded.split('+').map((t) => t.trim()).filter(Boolean);
  const mods = { ctrl: false, alt: false, shift: false, meta: false };
  const keys = [];

  for (const tok of rawTokens) {
    const low = tok.toLowerCase();
    if (['ctrl', 'control', 'ctl'].includes(low)) {
      mods.ctrl = true;
    } else if (['alt', 'opt', 'option'].includes(low)) {
      mods.alt = true;
    } else if (['shift', 'shft'].includes(low)) {
      mods.shift = true;
    } else if (['meta', 'cmd', 'command', 'super', 'win'].includes(low)) {
      mods.meta = true;
    } else {
      const canonKey = canonicalizeKeyToken(tok);
      if (!canonKey) {
        return {
          ok: false,
          error: `不支持的按键「${tok}」，请使用字母 A-Z、数字 0-9、F1-F12 或常用符号键`
        };
      }
      keys.push(canonKey);
    }
  }

  if (keys.length === 0) {
    return {
      ok: false,
      error: '请按下包含修饰键（如 ⌘ / ⌥ / ⌃）与单个主键的组合键'
    };
  }
  if (keys.length > 1) {
    return {
      ok: false,
      error: '快捷键只能包含一个主键，请使用「修饰键 + 单个按键」组合'
    };
  }

  const key = keys[0];
  const isFunctionKey = /^F([1-9]|1[0-2])$/.test(key);
  const hasPrimaryMod = mods.ctrl || mods.alt || mods.meta;
  if (!hasPrimaryMod && !isFunctionKey) {
    return {
      ok: false,
      error: '快捷键需至少包含 ⌘ / ⌥ / ⌃ 修饰键之一（或使用 F1-F12），避免干扰正常文字输入'
    };
  }

  if (platform === 'darwin') {
    const onlyMeta = mods.meta && !mods.alt && !mods.ctrl && !mods.shift;
    const onlyMetaShift = mods.meta && mods.shift && !mods.alt && !mods.ctrl;
    if ((onlyMeta && RESERVED_MAC_META_ONLY_KEYS.has(key)) || (onlyMetaShift && key === 'Z')) {
      return {
        ok: false,
        error: '该组合键为系统保留或基础编辑快捷键（如复制/粘贴/退出），请换用带 ⌥ 或 ⌃ 的组合（如 ⌥⌘E）'
      };
    }
  } else {
    const onlyCtrl = mods.ctrl && !mods.alt && !mods.meta && !mods.shift;
    if (onlyCtrl && RESERVED_OTHER_CTRL_ONLY_KEYS.has(key)) {
      return {
        ok: false,
        error: '该组合键为基础编辑快捷键（如复制/粘贴/撤销），请换用 Ctrl+Alt 组合（如 Ctrl+Alt+E）'
      };
    }
  }

  const orderedParts = [];
  if (mods.ctrl) orderedParts.push('Ctrl');
  if (mods.alt) orderedParts.push('Alt');
  if (mods.shift) orderedParts.push('Shift');
  if (mods.meta) orderedParts.push('Meta');
  orderedParts.push(key);
  const accelerator = orderedParts.join('+');

  return {
    ok: true,
    disabled: false,
    accelerator,
    display: formatShortcutDisplay(accelerator, platform),
    modifiers: mods,
    key,
    macCarbon: shortcutToMacCarbon(accelerator)
  };
}

const DAEMON_RUNTIME_FILES = [
  'drawer.mjs',
  'native_drawer_macos.swift',
  'path_utils.mjs',
  'mentions.mjs',
  'index.html',
  'styles.css',
  'app.js'
];

function computeDaemonBuildId() {
  const h = createHash('sha256');
  h.update(`v${DAEMON_VERSION}\n`);
  for (const name of DAEMON_RUNTIME_FILES) {
    const p = join(__dirname, name);
    h.update(`${name}:`);
    if (existsSync(p)) {
      h.update(readFileSync(p));
    }
    h.update('\n');
  }
  return h.digest('hex').slice(0, 16);
}

export const DAEMON_BUILD_ID = computeDaemonBuildId();

export function getSidecarStateDir() {
  if (process.env.AGY_FINDER_DATA_DIR) {
    return resolve(process.env.AGY_FINDER_DATA_DIR);
  }
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    return resolve(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR);
  }
  return join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'agy-finder', 'tree', 'data');
}

function getSettingsPath() {
  return join(getSidecarStateDir(), 'settings.json');
}

function getActiveContextPath() {
  return join(getSidecarStateDir(), 'active_context.json');
}

function getStateFilePath() {
  return join(getSidecarStateDir(), 'drawer_state.json');
}

function getCmdFilePath() {
  return join(getSidecarStateDir(), 'drawer_cmd.json');
}

function getSpawnLockPath() {
  return join(getSidecarStateDir(), 'drawer_spawn.lock');
}

function writeJsonFileAtomic(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, filePath);
}

function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 1) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

export function getDrawerShortcutConfig(platform = process.platform) {
  const raw = readJsonSafe(getSettingsPath()) || {};
  const defaultAccelerator = getDefaultDrawerShortcut(platform);
  const defaultDisplay = formatShortcutDisplay(defaultAccelerator, platform);
  const scope = SHORTCUT_SCOPES.includes(raw.shortcutScope) ? raw.shortcutScope : 'app';

  let enabled;
  if (typeof raw.drawerShortcutEnabled === 'boolean') {
    enabled = raw.drawerShortcutEnabled;
  } else if (typeof raw.hotkeyPreset === 'string') {
    enabled = raw.hotkeyPreset.trim().toLowerCase() !== 'off';
  } else {
    enabled = true;
  }

  let accelerator = defaultAccelerator;
  if (typeof raw.drawerShortcutAccelerator === 'string' && raw.drawerShortcutAccelerator.trim()) {
    const parsed = normalizeShortcutSpec(raw.drawerShortcutAccelerator, platform);
    if (parsed.ok && !parsed.disabled) {
      accelerator = parsed.accelerator;
    }
  } else if (typeof raw.hotkeyPreset === 'string') {
    const presetAcc = PRESET_TO_ACCELERATOR[raw.hotkeyPreset.trim().toLowerCase()];
    if (presetAcc) accelerator = presetAcc;
  }

  const display = formatShortcutDisplay(accelerator, platform);
  const presetId = !enabled ? 'off' : (ACCELERATOR_TO_PRESET[accelerator] || 'custom');
  return {
    enabled,
    accelerator,
    display,
    defaultAccelerator,
    defaultDisplay,
    isDefault: enabled === true && accelerator === defaultAccelerator && scope === 'app',
    scope,
    presetId,
    nativeGlobalSupported: platform === 'darwin',
    macCarbon: shortcutToMacCarbon(accelerator)
  };
}

export function getAuxShortcutConfig(platform = process.platform) {
  const raw = readJsonSafe(getSettingsPath()) || {};
  const drawer = getDrawerShortcutConfig(platform);
  const defaultAccelerator = getDefaultAuxShortcut(platform, drawer.accelerator);
  const defaultDisplay = formatShortcutDisplay(defaultAccelerator, platform);
  const enabled = typeof raw.auxShortcutEnabled === 'boolean' ? raw.auxShortcutEnabled : true;
  const scope = SHORTCUT_SCOPES.includes(raw.shortcutScope) ? raw.shortcutScope : 'app';

  let accelerator = defaultAccelerator;
  if (typeof raw.auxShortcutAccelerator === 'string' && raw.auxShortcutAccelerator.trim()) {
    const parsed = normalizeShortcutSpec(raw.auxShortcutAccelerator, platform);
    if (parsed.ok && !parsed.disabled) {
      accelerator = parsed.accelerator;
    }
  }
  const display = formatShortcutDisplay(accelerator, platform);

  return {
    enabled,
    accelerator,
    display,
    defaultAccelerator,
    defaultDisplay,
    isDefault: enabled === true && accelerator === defaultAccelerator && scope === 'app',
    scope,
    nativeGlobalSupported: platform === 'darwin',
    macCarbon: shortcutToMacCarbon(accelerator)
  };
}

export function setDrawerShortcutConfig(patch = {}, platform = process.platform) {
  const raw = readJsonSafe(getSettingsPath()) || {};
  const cur = getDrawerShortcutConfig(platform);
  let nextEnabled = cur.enabled;
  let nextAccelerator = cur.accelerator;
  let nextScope = cur.scope;

  if (patch.reset === true || patch.drawerShortcutReset === true) {
    nextEnabled = true;
    nextAccelerator = getDefaultDrawerShortcut(platform);
  } else {
    const rawAcc = patch.accelerator ?? patch.drawerAccelerator ?? patch.drawerShortcutAccelerator;
    if (rawAcc !== undefined) {
      const parsed = normalizeShortcutSpec(rawAcc, platform);
      if (!parsed.ok) {
        return { ok: false, error: parsed.error, shortcut: cur, drawerShortcut: cur };
      }
      if (parsed.disabled) {
        nextEnabled = false;
      } else {
        nextAccelerator = parsed.accelerator;
        if (typeof patch.enabled !== 'boolean' && typeof patch.drawerShortcutEnabled !== 'boolean') {
          nextEnabled = true;
        }
      }
    }

    const rawEnabled = typeof patch.enabled === 'boolean'
      ? patch.enabled
      : (typeof patch.drawerShortcutEnabled === 'boolean' ? patch.drawerShortcutEnabled : undefined);
    if (typeof rawEnabled === 'boolean') {
      nextEnabled = rawEnabled;
    }

    const rawScope = patch.scope ?? patch.shortcutScope;
    if (rawScope !== undefined) {
      const normScope = String(rawScope).trim().toLowerCase();
      if (!SHORTCUT_SCOPES.includes(normScope)) {
        return { ok: false, error: '无效的快捷键生效范围（仅支持 app 或 global）', shortcut: cur, drawerShortcut: cur };
      }
      nextScope = normScope;
    }
  }

  const auxCur = getAuxShortcutConfig(platform);
  if (nextEnabled && auxCur.enabled && nextAccelerator === auxCur.accelerator) {
    return {
      ok: false,
      error: `快捷键 ${formatShortcutDisplay(nextAccelerator, platform)} 已被「AGY 侧栏目录树」占用，请先更换另一个组合键`,
      shortcut: cur,
      drawerShortcut: cur
    };
  }

  const nextPreset = !nextEnabled ? 'off' : (ACCELERATOR_TO_PRESET[nextAccelerator] || 'cmd+shift+e');
  const nextRaw = {
    ...raw,
    hotkeyPreset: nextPreset,
    drawerPinned: typeof raw.drawerPinned === 'boolean' ? raw.drawerPinned : true,
    drawerShortcutEnabled: nextEnabled,
    drawerShortcutAccelerator: nextAccelerator,
    shortcutScope: nextScope,
    updatedAt: new Date().toISOString()
  };
  writeJsonFileAtomic(getSettingsPath(), nextRaw);
  const nextShortcut = getDrawerShortcutConfig(platform);
  return {
    ok: true,
    shortcut: nextShortcut,
    drawerShortcut: nextShortcut,
    auxShortcut: getAuxShortcutConfig(platform),
    hotkeyPreset: nextShortcut.presetId
  };
}

export function setAuxShortcutConfig(patch = {}, platform = process.platform) {
  const raw = readJsonSafe(getSettingsPath()) || {};
  const cur = getAuxShortcutConfig(platform);
  const drawerCur = getDrawerShortcutConfig(platform);

  let nextEnabled = cur.enabled;
  let nextAccelerator = cur.accelerator;
  let nextScope = cur.scope;

  if (patch.reset === true || patch.auxShortcutReset === true) {
    nextEnabled = true;
    nextAccelerator = getDefaultAuxShortcut(platform, drawerCur.enabled ? drawerCur.accelerator : '');
  } else {
    const rawAcc = patch.accelerator ?? patch.auxAccelerator ?? patch.auxShortcutAccelerator;
    if (rawAcc !== undefined) {
      const parsed = normalizeShortcutSpec(rawAcc, platform);
      if (!parsed.ok) {
        return { ok: false, error: parsed.error, auxShortcut: cur };
      }
      if (parsed.disabled) {
        nextEnabled = false;
      } else {
        nextAccelerator = parsed.accelerator;
        if (typeof patch.enabled !== 'boolean' && typeof patch.auxShortcutEnabled !== 'boolean') {
          nextEnabled = true;
        }
      }
    }

    const rawEnabled = typeof patch.enabled === 'boolean'
      ? patch.enabled
      : (typeof patch.auxShortcutEnabled === 'boolean' ? patch.auxShortcutEnabled : undefined);
    if (typeof rawEnabled === 'boolean') {
      nextEnabled = rawEnabled;
    }

    const rawScope = patch.scope ?? patch.shortcutScope;
    if (rawScope !== undefined) {
      const normScope = String(rawScope).trim().toLowerCase();
      if (!SHORTCUT_SCOPES.includes(normScope)) {
        return { ok: false, error: '无效的快捷键生效范围（仅支持 app 或 global）', auxShortcut: cur };
      }
      nextScope = normScope;
    }
  }

  if (nextEnabled && drawerCur.enabled && nextAccelerator === drawerCur.accelerator) {
    return {
      ok: false,
      error: `快捷键 ${formatShortcutDisplay(nextAccelerator, platform)} 已被「独立目录树抽屉」占用，请先更换另一个组合键`,
      auxShortcut: cur
    };
  }

  const nextRaw = {
    ...raw,
    drawerPinned: typeof raw.drawerPinned === 'boolean' ? raw.drawerPinned : true,
    auxShortcutEnabled: nextEnabled,
    auxShortcutAccelerator: nextAccelerator,
    shortcutScope: nextScope,
    updatedAt: new Date().toISOString()
  };
  writeJsonFileAtomic(getSettingsPath(), nextRaw);
  return {
    ok: true,
    auxShortcut: getAuxShortcutConfig(platform),
    drawerShortcut: getDrawerShortcutConfig(platform)
  };
}

export function getShortcutSettings(platform = process.platform) {
  const raw = readJsonSafe(getSettingsPath()) || {};
  const drawerShortcut = getDrawerShortcutConfig(platform);
  const auxShortcut = getAuxShortcutConfig(platform);
  const rawPreset = String(raw.hotkeyPreset || '').toLowerCase();
  const hotkeyPreset = !drawerShortcut.enabled
    ? 'off'
    : (ACCELERATOR_TO_PRESET[drawerShortcut.accelerator] || (VALID_PRESETS.has(rawPreset) ? rawPreset : 'custom'));
  const drawerPinned = raw.drawerPinned !== undefined ? Boolean(raw.drawerPinned) : true;
  return {
    hotkeyPreset,
    drawerPinned,
    shortcut: drawerShortcut,
    drawerShortcut,
    auxShortcut
  };
}

export function saveShortcutSettings(patch = {}, platform = process.platform) {
  const raw = readJsonSafe(getSettingsPath()) || {};
  const current = getShortcutSettings(platform);
  let nextPreset = current.hotkeyPreset;
  let nextDrawerEnabled = current.drawerShortcut.enabled;
  let nextDrawerAcc = current.drawerShortcut.accelerator;

  if (typeof patch.hotkeyPreset === 'string') {
    const candidate = patch.hotkeyPreset.trim().toLowerCase();
    if (!VALID_PRESETS.has(candidate)) {
      const err = new Error(`不支持的快捷键预设：${patch.hotkeyPreset}`);
      err.status = 400;
      throw err;
    }
    nextPreset = candidate;
    if (candidate === 'off') {
      nextDrawerEnabled = false;
    } else {
      nextDrawerEnabled = true;
      nextDrawerAcc = PRESET_TO_ACCELERATOR[candidate] || getDefaultDrawerShortcut(platform);
      const auxExplicit = typeof raw.auxShortcutAccelerator === 'string' && raw.auxShortcutAccelerator.trim();
      const auxCur = getAuxShortcutConfig(platform);
      if (auxCur.enabled && auxCur.accelerator === nextDrawerAcc && auxExplicit) {
        const err = new Error(`快捷键 ${formatShortcutDisplay(nextDrawerAcc, platform)} 已被「AGY 侧栏目录树」占用`);
        err.status = 400;
        throw err;
      }
    }
  }

  const nextPinned = typeof patch.drawerPinned === 'boolean' ? patch.drawerPinned : current.drawerPinned;
  const next = {
    ...raw,
    hotkeyPreset: nextPreset,
    drawerPinned: nextPinned,
    drawerShortcutEnabled: nextDrawerEnabled,
    drawerShortcutAccelerator: nextDrawerAcc,
    updatedAt: new Date().toISOString()
  };
  writeJsonFileAtomic(getSettingsPath(), next);
  return getShortcutSettings(platform);
}

export function getSharedAuxTriggerPath() {
  const override = String(process.env.AGY_AUX_TRIGGER_PATH || '').trim();
  if (override) return resolve(override);

  const dirs = [
    process.env.AGY_FINDER_DATA_DIR,
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR
  ].filter((v) => typeof v === 'string' && v.trim());

  for (const rawDir of dirs) {
    for (let d = resolve(rawDir); d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        return join(d, 'agy_aux_pane_trigger.json');
      }
    }
    return join(resolve(rawDir), 'agy_aux_pane_trigger.json');
  }
  return join(getAppDataDir(), 'sidecar_data', 'agy_aux_pane_trigger.json');
}

export function readAuxPaneTrigger() {
  const raw = readJsonSafe(getSharedAuxTriggerPath());
  return {
    seq: Number(raw?.seq || 0),
    targetPlugin: typeof raw?.targetPlugin === 'string' ? raw.targetPlugin : '',
    uri: typeof raw?.uri === 'string' ? raw.uri : '',
    action: typeof raw?.action === 'string' ? raw.action : 'toggle',
    convId: typeof raw?.convId === 'string' ? raw.convId : '',
    revealPath: typeof raw?.revealPath === 'string' ? raw.revealPath : '',
    at: Number(raw?.at || 0),
    openingSeq: Number(raw?.openingSeq || 0),
    ackSeq: Number(raw?.ackSeq || 0),
    ackAt: Number(raw?.ackAt || 0),
    ackPlugin: typeof raw?.ackPlugin === 'string' ? raw.ackPlugin : '',
    switchedSeq: Number(raw?.switchedSeq || 0),
    activeConvId: typeof raw?.activeConvId === 'string' ? raw.activeConvId : '',
    activeConvUpdatedAt: Number(raw?.activeConvUpdatedAt || 0),
    viewBatchMs: Number(raw?.viewBatchMs || 0),
    viewWinnerId: typeof raw?.viewWinnerId === 'string' ? raw.viewWinnerId : ''
  };
}

function isSubagentTranscriptHead(logPath) {
  let fd = null;
  try {
    fd = openSync(logPath, 'r');
    const buf = Buffer.alloc(4096);
    const bytesRead = readSync(fd, buf, 0, buf.length, 0);
    if (bytesRead <= 0) return false;
    const raw = buf.subarray(0, bytesRead).toString('utf8');
    const lines = raw.split('\n');
    let firstType = '';
    let hasUserInput = false;
    for (let i = 0; i < Math.min(lines.length, 8); i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let stepType = '';
      try {
        const obj = JSON.parse(line);
        stepType = String(obj?.type || '');
      } catch {
        const mType = line.match(/"type"\s*:\s*"([^"]+)"/);
        if (mType) stepType = mType[1];
      }
      if (!stepType) continue;
      if (!firstType) firstType = stepType;
      if (stepType === 'USER_INPUT') {
        hasUserInput = true;
        break;
      }
    }
    return !hasUserInput && firstType === 'SYSTEM_MESSAGE';
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
  }
}

function findLatestDesktopConversationCandidate({ prevResolvedId = '', knownBatchMs = 0 } = {}) {
  const appDataDir = getAppDataDir();
  const brainDir = join(appDataDir, 'brain');
  const annDir = join(appDataDir, 'annotations');
  if (!existsSync(brainDir)) return null;

  const entries = [];
  try {
    for (const entry of readdirSync(brainDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !CONV_ID_RE.test(entry.name)) continue;
      const id = entry.name;
      const logFull = join(brainDir, id, '.system_generated', 'logs', 'transcript_full.jsonl');
      const logMini = join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl');
      const target = existsSync(logFull) ? logFull : (existsSync(logMini) ? logMini : '');
      if (!target) continue;
      let mtimeMs = 0;
      try { mtimeMs = statSync(target).mtimeMs; } catch {}
      let viewTimeMs = 0;
      const annPath = join(annDir, `${id}.pbtxt`);
      if (existsSync(annPath)) {
        try {
          const raw = readFileSync(annPath, 'utf-8');
          const mView = raw.match(/last_user_view_time:\s*\{\s*seconds:\s*(\d+)(?:\s+nanos:\s*(\d+))?\s*\}/);
          if (mView) {
            viewTimeMs = Number(mView[1]) * 1000 + Math.round(Number(mView[2] || 0) / 1e6);
          }
        } catch {}
      }
      if (viewTimeMs === 0 && isSubagentTranscriptHead(target)) {
        continue;
      }
      if (mtimeMs > 0 || viewTimeMs > 0) {
        entries.push({ id, mtimeMs, viewTimeMs });
      }
    }
  } catch {}
  if (!entries.length) return null;

  let maxViewMs = 0;
  for (const e of entries) {
    if (e.viewTimeMs > maxViewMs) maxViewMs = e.viewTimeMs;
  }
  const candidates = [];
  let viewWinnerId = '';
  if (maxViewMs > 0) {
    const tied = entries.filter((e) => Math.abs(e.viewTimeMs - maxViewMs) <= 80);
    const winner = (tied.length > 1 && prevResolvedId)
      ? (maxViewMs > knownBatchMs
          ? (tied.find((e) => e.id !== prevResolvedId) || tied[0])
          : (tied.find((e) => e.id === prevResolvedId) || tied[0]))
      : tied[0];
    if (winner) {
      viewWinnerId = winner.id;
      candidates.push({ id: winner.id, ts: maxViewMs });
    }
  }
  const newestTurn = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (
    newestTurn &&
    newestTurn.mtimeMs > 0 &&
    (maxViewMs === 0 || (newestTurn.viewTimeMs === 0 && newestTurn.mtimeMs > maxViewMs))
  ) {
    candidates.push({ id: newestTurn.id, ts: newestTurn.mtimeMs });
  }
  candidates.sort((a, b) => b.ts - a.ts);
  if (!candidates[0]) return null;
  return {
    id: candidates[0].id,
    ts: candidates[0].ts,
    maxViewMs,
    viewWinnerId
  };
}

const AUX_TRIGGER_WAIT_ARR = new Int32Array(new SharedArrayBuffer(4));

function isAuxLockPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function withAuxTriggerLock(fn) {
  const filePath = getSharedAuxTriggerPath();
  const lockPath = `${filePath}.lock`;
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {}

  const token = `${process.pid}:${Date.now()}:${randomBytes(6).toString('hex')}`;
  const deadline = Date.now() + 4000;
  let acquired = false;
  let attempt = 0;

  while (!acquired && Date.now() < deadline) {
    let fd = null;
    try {
      fd = openSync(lockPath, 'wx', 0o600);
      writeSync(fd, token);
      acquired = true;
    } catch (err) {
      if (err?.code === 'ENOENT') {
        try { mkdirSync(dirname(lockPath), { recursive: true }); } catch {}
        continue;
      }
      if (err?.code !== 'EEXIST') break;

      try {
        const st = statSync(lockPath);
        const ageMs = Date.now() - Number(st.mtimeMs || 0);
        if (ageMs >= 5000) {
          let raw = '';
          try { raw = readFileSync(lockPath, 'utf8'); } catch {}
          const ownerPid = Number(String(raw || '').split(':')[0]);
          if (!isAuxLockPidAlive(ownerPid) || ageMs >= 15000) {
            const stalePath = `${lockPath}.stale.${process.pid}.${Date.now()}`;
            try {
              renameSync(lockPath, stalePath);
              try { unlinkSync(stalePath); } catch {}
              continue;
            } catch {}
          }
        }
      } catch (statErr) {
        if (statErr?.code === 'ENOENT') continue;
      }

      const waitMs = Math.min(16, 2 + attempt * 2);
      attempt += 1;
      try {
        Atomics.wait(AUX_TRIGGER_WAIT_ARR, 0, 0, waitMs);
      } catch {}
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch {}
      }
    }
  }

  try {
    return fn(filePath);
  } finally {
    if (acquired) {
      try {
        if (readFileSync(lockPath, 'utf8') === token) {
          unlinkSync(lockPath);
        }
      } catch {}
    }
  }
}

export function writeAuxPaneTrigger({ targetPlugin = 'agy-finder', uri = '', action = 'toggle', convId = '', revealPath = '' } = {}) {
  return withAuxTriggerLock((filePath) => {
    const cur = readAuxPaneTrigger();
    const hint = readActiveContextHint();
    const explicitConvId = (typeof convId === 'string' && CONV_ID_RE.test(convId.trim())) ? convId.trim() : '';

    let resolvedActive = explicitConvId;
    let nextViewBatchMs = Number(cur.viewBatchMs || 0);
    let nextViewWinnerId = cur.viewWinnerId || '';
    if (!resolvedActive) {
      const candidates = [];
      const latestDesktop = findLatestDesktopConversationCandidate({
        prevResolvedId: cur.viewWinnerId || hint.conversationId || cur.activeConvId || '',
        knownBatchMs: nextViewBatchMs
      });
      if (latestDesktop?.id && latestDesktop.ts > 0) {
        candidates.push(latestDesktop);
        if (latestDesktop.maxViewMs > 0) nextViewBatchMs = latestDesktop.maxViewMs;
        if (latestDesktop.viewWinnerId) nextViewWinnerId = latestDesktop.viewWinnerId;
      }
      if (CONV_ID_RE.test(String(hint.conversationId || '')) && Number(hint.updatedAt || 0) > 0) {
        candidates.push({ id: hint.conversationId, ts: Number(hint.updatedAt) });
      }
      if (CONV_ID_RE.test(String(cur.activeConvId || '')) && Number(cur.activeConvUpdatedAt || 0) > 0) {
        candidates.push({ id: cur.activeConvId, ts: Number(cur.activeConvUpdatedAt) });
      }
      candidates.sort((a, b) => b.ts - a.ts);
      resolvedActive = (
        candidates[0]?.id ||
        (CONV_ID_RE.test(String(hint.conversationId || '')) ? hint.conversationId : '') ||
        (CONV_ID_RE.test(String(cur.activeConvId || '')) ? cur.activeConvId : '') ||
        ''
      );
    } else {
      nextViewWinnerId = explicitConvId;
    }

    const next = {
      seq: Math.max(0, Number(cur.seq || 0)) + 1,
      targetPlugin: String(targetPlugin || 'agy-finder'),
      uri: String(uri || ''),
      action: String(action || 'toggle'),
      convId: (typeof convId === 'string' && convId.trim()) ? convId.trim() : resolvedActive,
      revealPath: typeof revealPath === 'string' ? revealPath : '',
      at: Date.now(),
      openingSeq: 0,
      ackSeq: cur.ackSeq,
      ackAt: cur.ackAt,
      ackPlugin: cur.ackPlugin,
      switchedSeq: 0,
      activeConvId: resolvedActive,
      activeConvUpdatedAt: explicitConvId ? Date.now() : Number(cur.activeConvUpdatedAt || 0),
      viewBatchMs: nextViewBatchMs,
      viewWinnerId: nextViewWinnerId
    };
    writeJsonFileAtomic(filePath, next);
    return next;
  });
}

export function markAuxPaneOpening({ seq } = {}) {
  const targetSeq = Number(seq || 0);
  if (!targetSeq) {
    return { ok: true, claimed: false, trigger: readAuxPaneTrigger() };
  }
  return withAuxTriggerLock((filePath) => {
    const cur = readAuxPaneTrigger();
    if (targetSeq <= cur.openingSeq) {
      return { ok: true, claimed: false, trigger: cur };
    }
    const next = {
      ...cur,
      openingSeq: targetSeq
    };
    writeJsonFileAtomic(filePath, next);
    return { ok: true, claimed: true, trigger: next };
  });
}

export function ackAuxPaneTrigger({ seq, plugin = 'agy-finder' } = {}) {
  const targetSeq = Number(seq || 0);
  if (!targetSeq) {
    return { ok: true, claimed: false, trigger: readAuxPaneTrigger() };
  }
  return withAuxTriggerLock((filePath) => {
    const cur = readAuxPaneTrigger();
    if (targetSeq < cur.seq || cur.ackSeq >= targetSeq) {
      return { ok: true, claimed: false, trigger: cur };
    }
    const next = {
      ...cur,
      ackSeq: targetSeq,
      ackAt: Date.now(),
      ackPlugin: String(plugin || 'agy-finder')
    };
    writeJsonFileAtomic(filePath, next);
    return { ok: true, claimed: true, trigger: next };
  });
}

export function markAuxPaneSwitched({ seq } = {}) {
  const targetSeq = Number(seq || 0);
  if (!targetSeq) {
    return { ok: true, claimed: false, trigger: readAuxPaneTrigger() };
  }
  return withAuxTriggerLock((filePath) => {
    const cur = readAuxPaneTrigger();
    if (targetSeq <= cur.switchedSeq) {
      return { ok: true, claimed: false, trigger: cur };
    }
    const next = {
      ...cur,
      switchedSeq: targetSeq
    };
    writeJsonFileAtomic(filePath, next);
    return { ok: true, claimed: true, trigger: next };
  });
}

export function recordAuxActiveConversation({ convId = '' } = {}) {
  const cleanId = String(convId || '').trim();
  if (!CONV_ID_RE.test(cleanId)) {
    return { ok: false, activeConvId: '' };
  }
  return withAuxTriggerLock((filePath) => {
    const raw = readJsonSafe(filePath);
    const cur = readAuxPaneTrigger();
    const now = Date.now();
    if (raw && cur.activeConvId === cleanId && now - Number(cur.activeConvUpdatedAt || 0) < 1000) {
      return { ok: true, activeConvId: cleanId };
    }
    writeJsonFileAtomic(filePath, {
      ...cur,
      activeConvId: cleanId,
      activeConvUpdatedAt: now
    });
    return { ok: true, activeConvId: cleanId };
  });
}

export function waitForAuxPaneTrigger({ since = 0, timeoutMs = 8000 } = {}) {
  const sinceSeq = Math.max(0, Number(since || 0));
  const clampedMs = Math.max(0, Math.min(9500, Number(timeoutMs ?? 8000) || 0));
  const initial = readAuxPaneTrigger();
  if (initial.seq > sinceSeq || clampedMs === 0) {
    return Promise.resolve({ ok: true, changed: initial.seq > sinceSeq, trigger: initial });
  }

  const filePath = getSharedAuxTriggerPath();
  const dir = dirname(filePath);
  const name = basename(filePath);
  try { mkdirSync(dir, { recursive: true }); } catch {}

  return new Promise((resolvePromise) => {
    let settled = false;
    let watcher = null;
    let pollTimer = null;
    let timeoutTimer = null;

    const finish = (trigger) => {
      if (settled) return;
      settled = true;
      try { watcher?.close(); } catch {}
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolvePromise({ ok: true, changed: trigger.seq > sinceSeq, trigger });
    };

    const checkNow = () => {
      const cur = readAuxPaneTrigger();
      if (cur.seq > sinceSeq) finish(cur);
    };

    try {
      watcher = watch(dir, (_ev, filename) => {
        if (!filename || String(filename) === name) {
          checkNow();
        }
      });
      watcher.on('error', () => {});
    } catch {}

    pollTimer = setInterval(checkNow, 90);
    pollTimer.unref?.();
    timeoutTimer = setTimeout(() => {
      finish(readAuxPaneTrigger());
    }, clampedMs);
    timeoutTimer.unref?.();
  });
}

export function readActiveContextHint() {
  return readJsonSafe(getActiveContextPath()) || {};
}

export function recordActiveContextHint(partial = {}) {
  try {
    const cur = readActiveContextHint();
    const next = { ...cur };
    const allowContextOverwrite = partial.visible !== false;
    if (allowContextOverwrite) {
      if (typeof partial.conversationId === 'string' && CONV_ID_RE.test(partial.conversationId.trim())) {
        next.conversationId = partial.conversationId.trim();
      }
      if (Array.isArray(partial.roots) && partial.roots.length > 0) {
        next.roots = partial.roots.filter((r) => typeof r === 'string' && existsSync(r));
      }
      if (typeof partial.primaryRoot === 'string' && existsSync(partial.primaryRoot)) {
        next.primaryRoot = partial.primaryRoot;
      }
      next.updatedAt = Date.now();
    }
    if (typeof partial.lastRevealPath === 'string' && partial.lastRevealPath.trim()) {
      next.lastRevealPath = partial.lastRevealPath.trim();
      next.lastRevealAt = Date.now();
    }
    if (typeof partial.agentApiExe === 'string' && partial.agentApiExe.trim()) {
      next.agentApiExe = partial.agentApiExe.trim();
    }
    writeJsonFileAtomic(getActiveContextPath(), next);
    return next;
  } catch {
    return {};
  }
}

function isDaemonStateCurrent(st) {
  return Boolean(st && st.daemonVersion === DAEMON_VERSION && st.daemonBuildId === DAEMON_BUILD_ID);
}

function readDrawerState() {
  const p = getStateFilePath();
  const obj = readJsonSafe(p);
  if (obj?.pid && isPidAlive(obj.pid)) return obj;
  try { rmSync(p, { force: true }); } catch {}
  return null;
}

function writeDrawerState(data) {
  writeJsonFileAtomic(getStateFilePath(), data);
}

function clearDrawerStateIfOwned() {
  const p = getStateFilePath();
  const obj = readJsonSafe(p);
  if (!obj?.pid || obj.pid === process.pid) {
    try { rmSync(p, { force: true }); } catch {}
  }
}

async function terminateProcessAndWait(pid, timeoutMs = 900) {
  if (!pid || !isPidAlive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch {}
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isPidAlive(pid)) {
    await new Promise((r) => setTimeout(r, 35));
  }
  if (isPidAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  try { rmSync(getStateFilePath(), { force: true }); } catch {}
}

export function getDrawerStatus(platform = process.platform) {
  const settings = getShortcutSettings(platform);
  const st = readDrawerState();
  const nativeHotkeySupported = platform === 'darwin';
  const drawerShortcut = settings.drawerShortcut;
  const auxShortcut = settings.auxShortcut;
  if (!st) {
    return {
      ok: true,
      daemonRunning: false,
      running: false,
      windowVisible: false,
      pinned: settings.drawerPinned,
      hotkeyPreset: settings.hotkeyPreset,
      shortcut: drawerShortcut,
      drawerShortcut,
      auxShortcut,
      nativeHotkeySupported,
      mode: null
    };
  }
  const windowVisible = st.windowVisible !== undefined ? Boolean(st.windowVisible) : Boolean(st.running);
  return {
    ok: true,
    daemonRunning: true,
    daemonVersion: st.daemonVersion ?? null,
    daemonBuildId: st.daemonBuildId ?? null,
    running: windowVisible,
    windowVisible,
    pid: st.pid,
    pinned: st.pinned !== undefined ? Boolean(st.pinned) : settings.drawerPinned,
    hotkeyPreset: (VALID_PRESETS.has(st.hotkeyPreset) || st.hotkeyPreset === 'custom') ? st.hotkeyPreset : settings.hotkeyPreset,
    shortcut: drawerShortcut,
    drawerShortcut,
    auxShortcut,
    nativeHotkeySupported,
    mode: st.mode || (nativeHotkeySupported ? 'native-macos' : 'app-window'),
    cmdSeq: Number(st.cmdSeq || 0),
    startedAt: st.startedAt || null
  };
}

async function sendDaemonCommand(current, cmdObj) {
  if (current.controlPort && current.controlToken) {
    try {
      const res = await fetch(`http://127.0.0.1:${current.controlPort}/internal/cmd`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AF-Control-Token': current.controlToken
        },
        body: JSON.stringify(cmdObj)
      });
      if (res.ok) {
        return getDrawerStatus();
      }
    } catch {}
  }

  const seq = Math.max(Number(current.cmdSeq || 0) + 1, Date.now());
  writeJsonFileAtomic(getCmdFilePath(), { seq, ...cmdObj });
  if (process.platform !== 'win32') {
    try {
      process.kill(current.pid, 'SIGUSR1');
    } catch {
      return getDrawerStatus();
    }
  }

  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    const st = readDrawerState();
    if (!st || Number(st.cmdSeq || 0) >= seq) {
      return getDrawerStatus();
    }
  }
  return getDrawerStatus();
}

function resolveStandaloneNodeBinary() {
  if (process.execPath && !/Antigravity|Electron|Helper/i.test(process.execPath) && existsSync(process.execPath)) {
    return { bin: process.execPath, extraEnv: {} };
  }
  for (const c of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
    if (existsSync(c)) return { bin: c, extraEnv: {} };
  }
  if (process.platform !== 'win32') {
    try {
      const found = execFileSync('/usr/bin/which', ['node'], { encoding: 'utf8', timeout: 1000 }).trim();
      if (found && existsSync(found)) return { bin: found, extraEnv: {} };
    } catch {}
  }
  return { bin: process.execPath, extraEnv: { ELECTRON_RUN_AS_NODE: '1' } };
}

function diagnoseMacCompileFailure() {
  const errPath = join(getSidecarStateDir(), 'last_swiftc_error.txt');
  if (existsSync(errPath)) {
    try {
      const detail = readFileSync(errPath, 'utf8').trim();
      if (detail) {
        return `macOS 原生抽屉编译未成功（请确认已安装 Xcode Command Line Tools）：${detail}`;
      }
    } catch {}
  }
  return '未能启动 macOS 原生抽屉守护进程，请确认已安装 Xcode Command Line Tools（xcode-select --install）后重试。';
}

function buildShortcutCliArgs(drawerShortcut, auxShortcut) {
  const args = [];
  if (drawerShortcut?.enabled && drawerShortcut?.macCarbon) {
    args.push(
      '--drawer-keycode', String(drawerShortcut.macCarbon.keyCode),
      '--drawer-mods', String(drawerShortcut.macCarbon.modifiers),
      '--drawer-label', String(drawerShortcut.display || ''),
      '--drawer-acc', String(drawerShortcut.accelerator || '')
    );
  } else {
    args.push('--no-drawer-shortcut');
  }
  if (auxShortcut?.enabled && auxShortcut?.macCarbon) {
    args.push(
      '--aux-keycode', String(auxShortcut.macCarbon.keyCode),
      '--aux-mods', String(auxShortcut.macCarbon.modifiers),
      '--aux-label', String(auxShortcut.display || ''),
      '--aux-acc', String(auxShortcut.accelerator || '')
    );
  } else {
    args.push('--no-aux-shortcut');
  }
  args.push('--scope', String(drawerShortcut?.scope || auxShortcut?.scope || 'app'));
  return args;
}

function buildShortcutDaemonPayload(cfg) {
  return {
    enabled: Boolean(cfg?.enabled && cfg?.macCarbon),
    keyCode: cfg?.macCarbon?.keyCode ?? 0,
    carbonModifiers: cfg?.macCarbon?.modifiers ?? 0,
    accelerator: String(cfg?.accelerator || ''),
    displayLabel: String(cfg?.display || ''),
    scope: String(cfg?.scope || 'app')
  };
}

async function spawnDaemon({
  pinned = true,
  hiddenWindow = false,
  hotkeyPreset = 'cmd+shift+e',
  revealPath = '',
  drawerShortcut = null,
  auxShortcut = null
} = {}) {
  const settings = getShortcutSettings();
  const effDrawer = drawerShortcut || settings.drawerShortcut;
  const effAux = auxShortcut || settings.auxShortcut;
  const lockPath = getSpawnLockPath();
  if (existsSync(lockPath)) {
    try {
      const lockAge = Date.now() - statSync(lockPath).mtimeMs;
      const lockObj = readJsonSafe(lockPath);
      if (lockAge < 15000 && lockObj?.pid && isPidAlive(lockObj.pid)) {
        const waitDeadline = Date.now() + 15000;
        while (Date.now() < waitDeadline) {
          await new Promise((r) => setTimeout(r, 80));
          const existing = readDrawerState();
          if (isDaemonStateCurrent(existing)) {
            return getDrawerStatus();
          }
          if (!existsSync(lockPath)) break;
        }
      }
    } catch {}
  }

  try {
    writeJsonFileAtomic(lockPath, { pid: process.pid, at: Date.now() });
  } catch {}

  try {
    const daemonArgs = [
      fileURLToPath(import.meta.url),
      '--daemon',
      '--preset',
      hotkeyPreset || effDrawer.presetId || 'cmd+shift+e',
      ...buildShortcutCliArgs(effDrawer, effAux)
    ];
    if (pinned === false) daemonArgs.push('--unpinned');
    if (hiddenWindow) daemonArgs.push('--hidden-window');
    if (revealPath) daemonArgs.push('--reveal', revealPath);

    const { bin: nodeBin, extraEnv } = resolveStandaloneNodeBinary();
    let childExited = false;
    const child = spawn(nodeBin, daemonArgs, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...extraEnv }
    });
    child.on('exit', () => { childExited = true; });
    child.on('error', () => { childExited = true; });
    child.unref();

    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 65));
      const st = readDrawerState();
      if (st?.pid && isDaemonStateCurrent(st)) {
        return getDrawerStatus();
      }
      if (childExited) break;
    }
  } finally {
    try { rmSync(lockPath, { force: true }); } catch {}
  }
  return null;
}

export async function controlDrawer(options = {}, deps = {}) {
  const platform = deps.platform || process.platform;
  const action = String(options.action || 'toggle').toLowerCase();
  const disableDrawer = process.env.AGY_FINDER_DISABLE_DRAWER === '1';

  if (action === 'status') {
    return getDrawerStatus(platform);
  }

  if (options.revealPath) {
    recordActiveContextHint({ lastRevealPath: String(options.revealPath) });
  }

  if (action === 'aux' || action === 'open-aux' || action === 'toggle-aux') {
    const trigger = writeAuxPaneTrigger({
      targetPlugin: 'agy-finder',
      uri: 'sidecar://agy-finder/tree/',
      action: action === 'open-aux' ? 'open' : 'toggle',
      convId: String(options.convId || ''),
      revealPath: String(options.revealPath || '')
    });
    const deadline = Date.now() + 650;
    let latest = readAuxPaneTrigger();
    while (Date.now() < deadline && Number(latest.ackSeq || 0) < Number(trigger.seq || 1)) {
      await new Promise((r) => setTimeout(r, 45));
      latest = readAuxPaneTrigger();
    }
    const acked = Number(latest.ackSeq || 0) >= Number(trigger.seq || 1);
    const opened = Number(latest.openingSeq || 0) >= Number(trigger.seq || 1);
    const settings = getShortcutSettings(platform);
    let message = `已切换 AGY 右侧辅助栏「目录树」（快捷键 ${settings.auxShortcut.display}）`;
    if (!acked) {
      message = opened
        ? '侧栏已展开：因目录树标签曾被 × 关闭，请在右侧 Extensions 点开一次「AGY Finder」（右键标签选 Pin Tab 可永久固定）'
        : '首次启动请先在右侧 Overview → Extensions 点开一次「AGY Finder」（右键标签选 Pin Tab 后即可跨会话随时呼出）';
    }
    return {
      ...getDrawerStatus(platform),
      acked,
      trigger: latest,
      message
    };
  }

  if (action === 'set-drawer-shortcut' || action === 'set-aux-shortcut') {
    const isAux = action === 'set-aux-shortcut';
    const res = isAux ? setAuxShortcutConfig(options, platform) : setDrawerShortcutConfig(options, platform);
    if (!res.ok) {
      return {
        ...getDrawerStatus(platform),
        ok: false,
        error: res.error,
        shortcut: res.shortcut,
        drawerShortcut: res.drawerShortcut,
        auxShortcut: res.auxShortcut
      };
    }
    const nextDrawer = res.drawerShortcut;
    const nextAux = res.auxShortcut;
    const shouldStayResident = nextDrawer.enabled || nextAux.enabled;
    const label = isAux ? nextAux.display : nextDrawer.display;
    const enabled = isAux ? nextAux.enabled : nextDrawer.enabled;
    const targetDesc = isAux ? 'AGY 右侧辅助栏目录树' : '独立目录树抽屉';

    if (disableDrawer) {
      return {
        ...getDrawerStatus(platform),
        hotkeyPreset: nextDrawer.presetId,
        shortcut: nextDrawer,
        drawerShortcut: nextDrawer,
        auxShortcut: nextAux,
        message: enabled ? `已更新${targetDesc}快捷键为 ${label}` : `已关闭${targetDesc}快捷键`
      };
    }

    let current = readDrawerState();
    if (current && !isDaemonStateCurrent(current)) {
      await terminateProcessAndWait(current.pid);
      current = null;
    }

    if (current) {
      if (!shouldStayResident && !current.windowVisible) {
        await terminateProcessAndWait(current.pid);
      } else {
        await sendDaemonCommand(current, {
          cmd: isAux ? 'setAuxShortcut' : 'setDrawerShortcut',
          shortcut: isAux ? buildShortcutDaemonPayload(nextAux) : buildShortcutDaemonPayload(nextDrawer),
          hotkeyPreset: nextDrawer.presetId
        });
      }
    } else if (platform === 'darwin' && shouldStayResident) {
      await spawnDaemon({
        pinned: getShortcutSettings(platform).drawerPinned,
        hiddenWindow: true,
        hotkeyPreset: nextDrawer.presetId,
        drawerShortcut: nextDrawer,
        auxShortcut: nextAux
      });
    }

    const ctrlHint = (platform === 'darwin' && isAux && enabled && /^Ctrl\+[A-Z]$/.test(nextAux.accelerator || ''))
      ? '（若与宿主编辑器快捷键冲突，可改用 ⌃⌥ 或 ⌥⌘ 组合）'
      : '';
    return {
      ...getDrawerStatus(platform),
      hotkeyPreset: nextDrawer.presetId,
      shortcut: nextDrawer,
      drawerShortcut: nextDrawer,
      auxShortcut: nextAux,
      message: enabled
        ? `已生效：按 ${label} 即可切换${targetDesc}${ctrlHint}`
        : `已关闭${targetDesc}快捷键`
    };
  }

  if (action === 'set-recording') {
    if (!disableDrawer && platform === 'darwin') {
      const current = readDrawerState();
      if (current) {
        await sendDaemonCommand(current, {
          cmd: 'setShortcutRecording',
          recording: Boolean(options.recording)
        }).catch(() => {});
      }
    }
    return {
      ...getDrawerStatus(platform),
      ok: true
    };
  }

  if (action === 'set-hotkey') {
    const next = saveShortcutSettings({ hotkeyPreset: String(options.hotkeyPreset || '') }, platform);
    const shouldStayResident = next.drawerShortcut.enabled || next.auxShortcut.enabled;
    if (disableDrawer) {
      return {
        ...getDrawerStatus(platform),
        hotkeyPreset: next.hotkeyPreset,
        shortcut: next.drawerShortcut,
        drawerShortcut: next.drawerShortcut,
        auxShortcut: next.auxShortcut,
        message: next.hotkeyPreset === 'off' ? '已关闭独立抽屉快捷键' : `已更新抽屉快捷键为 ${next.drawerShortcut.display}`
      };
    }
    const current = readDrawerState();
    if (current) {
      if (!shouldStayResident && !current.windowVisible) {
        await terminateProcessAndWait(current.pid);
        return {
          ...getDrawerStatus(platform),
          hotkeyPreset: next.hotkeyPreset,
          message: '已关闭所有快捷键'
        };
      }
      const st = await sendDaemonCommand(current, {
        cmd: 'setDrawerShortcut',
        shortcut: buildShortcutDaemonPayload(next.drawerShortcut),
        hotkeyPreset: next.hotkeyPreset
      });
      return {
        ...st,
        hotkeyPreset: next.hotkeyPreset,
        message: next.hotkeyPreset === 'off'
          ? '已关闭独立抽屉快捷键（仍可从右侧抽屉按钮打开）'
          : `已生效：在 Antigravity 内按 ${next.drawerShortcut.display} 即可秒开/收回目录树`
      };
    }
    if (platform === 'darwin' && shouldStayResident) {
      const spawned = await spawnDaemon({
        pinned: next.drawerPinned,
        hiddenWindow: true,
        hotkeyPreset: next.hotkeyPreset,
        drawerShortcut: next.drawerShortcut,
        auxShortcut: next.auxShortcut
      });
      if (spawned) {
        return {
          ...spawned,
          message: '已启动后台快捷键监听，在 Antigravity 内随时一键唤起目录树'
        };
      }
    }
    return {
      ...getDrawerStatus(platform),
      hotkeyPreset: next.hotkeyPreset,
      message: `已保存快捷键预设：${next.drawerShortcut.display}`
    };
  }

  if (action === 'set-pinned') {
    const nextPinned = typeof options.pinned === 'boolean' ? options.pinned : !getShortcutSettings(platform).drawerPinned;
    saveShortcutSettings({ drawerPinned: nextPinned }, platform);
    const current = readDrawerState();
    if (current && !disableDrawer) {
      return sendDaemonCommand(current, { cmd: 'setPinned', pinned: nextPinned });
    }
    return { ...getDrawerStatus(platform), pinned: nextPinned };
  }

  if (disableDrawer) {
    return getDrawerStatus(platform);
  }

  let current = readDrawerState();
  if (current && action !== 'quit' && !isDaemonStateCurrent(current)) {
    await terminateProcessAndWait(current.pid);
    current = null;
  }

  if (action === 'quit') {
    if (current?.pid) {
      await terminateProcessAndWait(current.pid);
    }
    return {
      ...getDrawerStatus(platform),
      closed: true,
      message: '已退出目录树抽屉助手'
    };
  }

  if (action === 'ensure-hotkey') {
    const settings = getShortcutSettings(platform);
    const shouldStayResident = settings.drawerShortcut.enabled || settings.auxShortcut.enabled;
    if (platform !== 'darwin' || !shouldStayResident) {
      return getDrawerStatus(platform);
    }
    if (current) {
      await sendDaemonCommand(current, {
        cmd: 'syncShortcuts',
        hotkeyPreset: settings.hotkeyPreset,
        drawerShortcut: buildShortcutDaemonPayload(settings.drawerShortcut),
        auxShortcut: buildShortcutDaemonPayload(settings.auxShortcut)
      });
      return getDrawerStatus(platform);
    }
    const st = await spawnDaemon({
      pinned: settings.drawerPinned,
      hiddenWindow: true,
      hotkeyPreset: settings.hotkeyPreset,
      drawerShortcut: settings.drawerShortcut,
      auxShortcut: settings.auxShortcut
    });
    return st || getDrawerStatus(platform);
  }

  const curVisible = Boolean(current?.windowVisible ?? current?.running);
  const shouldClose = action === 'close' || (action === 'toggle' && curVisible);

  if (shouldClose) {
    if (!current) {
      return {
        ...getDrawerStatus(platform),
        closed: true,
        message: '独立目录树抽屉当前已处于关闭状态'
      };
    }
    const settings = getShortcutSettings(platform);
    const shouldStayResident = settings.drawerShortcut.enabled || settings.auxShortcut.enabled;
    if (current.mode === 'native-macos' && shouldStayResident) {
      const st = await sendDaemonCommand(current, { cmd: 'hideWindow' });
      return {
        ...st,
        closed: true,
        message: '已收回目录树抽屉（按快捷键可随时秒开）'
      };
    }
    if (current.controlPort && current.controlToken) {
      await sendDaemonCommand(current, { cmd: 'close' });
    }
    await terminateProcessAndWait(current.pid);
    return {
      ...getDrawerStatus(platform),
      closed: true,
      message: '已关闭目录树抽屉窗口'
    };
  }

  // Open or reveal in drawer
  const settings = getShortcutSettings(platform);
  const revealPath = String(options.revealPath || '');
  if (current) {
    const st = await sendDaemonCommand(current, { cmd: 'showWindow', revealPath });
    return {
      ...st,
      alreadyRunning: curVisible,
      message: '已在屏幕右侧打开目录树抽屉'
    };
  }

  const st = await spawnDaemon({
    pinned: typeof options.pinned === 'boolean' ? options.pinned : settings.drawerPinned,
    hiddenWindow: false,
    hotkeyPreset: settings.hotkeyPreset,
    drawerShortcut: settings.drawerShortcut,
    auxShortcut: settings.auxShortcut,
    revealPath
  });

  if (st) {
    return {
      ...st,
      message: '已在屏幕右侧打开独立目录树抽屉'
    };
  }

  return {
    ok: false,
    running: false,
    error: platform === 'darwin' ? diagnoseMacCompileFailure() : '未能打开独立目录树窗口（未检测到可用 Chromium/Edge 浏览器，请使用宿主右侧 Aux Pane + Ctrl+Shift+B）'
  };
}

// ---------------------------------------------------------------------------
// Shared Daemon Tree / Workspace / RPC Helpers
// ---------------------------------------------------------------------------

function getAppDataDir() {
  return process.env.ANTIGRAVITY_APPDATA_DIR || process.env.AG_DIR || join(homedir(), '.gemini', 'antigravity');
}

let cachedRecentConv = { at: 0, convId: '' };
function findLatestBrainConversationId() {
  if (Date.now() - cachedRecentConv.at < 2500 && cachedRecentConv.convId) {
    return cachedRecentConv.convId;
  }
  const brainDir = join(getAppDataDir(), 'brain');
  if (!existsSync(brainDir)) return '';
  let bestId = '';
  let bestMtime = 0;
  try {
    for (const entry of readdirSync(brainDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !CONV_ID_RE.test(entry.name)) continue;
      const logFull = join(brainDir, entry.name, '.system_generated', 'logs', 'transcript_full.jsonl');
      const logMini = join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
      const target = existsSync(logFull) ? logFull : (existsSync(logMini) ? logMini : '');
      if (!target) continue;
      try {
        const m = statSync(target).mtimeMs;
        if (m > bestMtime) {
          bestMtime = m;
          bestId = entry.name;
        }
      } catch {}
    }
  } catch {}
  cachedRecentConv = { at: Date.now(), convId: bestId };
  return bestId;
}

function resolveDaemonRoots(data = {}, hint = {}) {
  const roots = [];
  const seen = new Set();
  const addRoot = (raw) => {
    const local = toLocalPath(raw);
    if (!local) return;
    const abs = resolve(local);
    if (!seen.has(abs) && existsSync(abs)) {
      seen.add(abs);
      roots.push(abs);
    }
  };

  if (typeof data.workspaceUri === 'string' && data.workspaceUri.trim()) {
    for (const part of data.workspaceUri.split(',')) addRoot(part);
  }
  if (typeof data.root === 'string' && data.root.trim()) {
    for (const part of data.root.split(',')) addRoot(part);
  }

  const convId = String(data.conversationId || hint.conversationId || findLatestBrainConversationId() || '').trim();
  const exe = hint.agentApiExe || process.env.ANTIGRAVITY_AGENTAPI_EXE || '';
  if (convId && CONV_ID_RE.test(convId) && exe && existsSync(exe)) {
    try {
      const out = execFileSync(exe, ['agentapi', 'get-conversation-metadata', convId], {
        encoding: 'utf8',
        timeout: 1200
      });
      const parsed = JSON.parse(out);
      const uris = parsed?.response?.conversationMetadata?.metadata?.workspaceUris || [];
      for (const u of uris) addRoot(u);
    } catch {}
  }

  if (Array.isArray(hint.roots)) {
    for (const r of hint.roots) addRoot(r);
  }
  addRoot(hint.primaryRoot);
  addRoot(process.env.ANTIGRAVITY_WORKSPACE_ROOT);
  addRoot(process.env.WORKSPACE_ROOT);
  if (roots.length === 0) addRoot(process.cwd());
  return { roots, convId };
}

function buildBundledDrawerHtml({
  initialPinned,
  initialHotkeyPreset,
  initialDrawerShortcut = null,
  initialAuxShortcut = null
}) {
  let html = readFileSync(join(__dirname, 'index.html'), 'utf8');
  const css = readFileSync(join(__dirname, 'styles.css'), 'utf8').replace(/<\/style/gi, '<\\/style');
  const js = readFileSync(join(__dirname, 'app.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
  const logoSvgPath = join(PLUGIN_ROOT, 'assets', 'logo.svg');
  const logoDataUri = existsSync(logoSvgPath)
    ? `data:image/svg+xml;base64,${readFileSync(logoSvgPath).toString('base64')}`
    : '';

  html = html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>\s*/i, '');
  html = html.replace(/<script\s+src="\/preload\.js"><\/script>\s*/i, '');
  if (logoDataUri) {
    html = html.replaceAll('/assets/logo.svg', logoDataUri);
  }
  html = html.replace(
    /<link\s+rel="stylesheet"\s+href="\/styles\.css[^"]*"\s*\/?>/i,
    () => `<style id="af-inline-styles">\n${css}\n</style>`
  );

  const settingsFallback = (!initialDrawerShortcut || !initialAuxShortcut) ? getShortcutSettings() : null;
  const effDrawer = initialDrawerShortcut || settingsFallback.drawerShortcut;
  const effAux = initialAuxShortcut || settingsFallback.auxShortcut;

  const bridgeScript = `
<script>
(() => {
  window.__AF_DRAWER_MODE__ = true;
  window.__AF_DRAWER_PINNED__ = ${initialPinned ? 'true' : 'false'};
  window.__AF_HOTKEY_PRESET__ = ${JSON.stringify(initialHotkeyPreset || 'cmd+shift+e')};
  window.__AF_DRAWER_SHORTCUT__ = ${JSON.stringify(effDrawer)};
  window.__AF_AUX_SHORTCUT__ = ${JSON.stringify(effAux)};
  let seq = 1;
  const pending = new Map();

  window.__afResolveRpc = (id, status, payload) => {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id);
    item.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload)
    });
  };

  window.sidecar = {
    conversationId: "",
    isDrawerWindow: true,
    getWorkspaceUris: async () => [],
    onWorkspaceChange: () => () => {},
    setPinned: (pinned) => {
      window.__AF_DRAWER_PINNED__ = Boolean(pinned);
      window.webkit?.messageHandlers?.afBridge?.postMessage(
        JSON.stringify({ kind: "togglePin", pinned: Boolean(pinned) })
      );
    },
    closeDrawerWindow: () => {
      window.webkit?.messageHandlers?.afBridge?.postMessage(
        JSON.stringify({ kind: "closeWindow" })
      );
    },
    setShortcutRecording: (recording) => {
      window.webkit?.messageHandlers?.afBridge?.postMessage(
        JSON.stringify({ kind: "setRecording", recording: Boolean(recording) })
      );
    },
    fetch: (path, opts = {}) => new Promise((resolvePromise, rejectPromise) => {
      const id = seq++;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          rejectPromise(new Error("IPC request timeout"));
        }
      }, 15000);
      pending.set(id, {
        resolve: (res) => { clearTimeout(timer); resolvePromise(res); },
        reject: (err) => { clearTimeout(timer); rejectPromise(err); }
      });
      window.webkit.messageHandlers.afBridge.postMessage(JSON.stringify({
        kind: "rpc",
        id,
        path: String(path || ""),
        method: String(opts.method || "GET").toUpperCase(),
        body: opts.body || null
      }));
    })
  };
})();
</script>`;

  html = html.replace(
    /<script\s+src="\/app\.js[^"]*"><\/script>/i,
    () => `${bridgeScript}\n<script>\n${js}\n</script>`
  );
  return html;
}

async function dispatchDrawerRpc(rawPath, method, rawBody, stateObj, hooks = {}) {
  const u = new URL(rawPath, 'http://127.0.0.1');
  const data = Object.fromEntries(u.searchParams.entries());
  if (rawBody && method === 'POST') {
    try {
      Object.assign(data, typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody);
    } catch {}
  }

  const hint = readActiveContextHint();
  const { roots, convId } = resolveDaemonRoots(data, hint);

  if (u.pathname === '/api/workspace' && method === 'GET') {
    return {
      ok: true,
      platform: process.platform,
      conversationId: convId,
      primaryRoot: roots[0] || '',
      lastRevealPath: hint.lastRevealPath || '',
      lastRevealAt: hint.lastRevealAt || 0,
      roots: roots.map((r) => ({ path: r, name: basename(r) || r, fileUri: toFileUri(r) }))
    };
  }
  if (u.pathname === '/api/tree' && method === 'GET') {
    const root = data.root ? resolve(toLocalPath(data.root)) : roots[0];
    const showHidden = data.showHidden === '1' || data.showHidden === 'true' || data.showHidden === true;
    return listDirectoryEntries(root, String(data.dir || ''), { showHidden });
  }
  if (u.pathname === '/api/resolve' && method === 'GET') {
    return resolveTargetPath(String(data.path || ''), roots);
  }
  if (u.pathname === '/api/mentions' && method === 'GET') {
    return getConversationMentions({
      conversationId: convId,
      roots,
      clientEtag: String(data.etag || '')
    });
  }
  if (u.pathname === '/api/search' && method === 'GET') {
    const root = data.root ? resolve(toLocalPath(data.root)) : roots[0];
    const showHidden = data.showHidden === '1' || data.showHidden === 'true' || data.showHidden === true;
    return searchWorkspaceFiles(root, String(data.q || ''), { showHidden });
  }
  if (u.pathname === '/api/preview' && method === 'GET') {
    return readTextPreview(String(data.path || ''), roots);
  }
  if (u.pathname === '/api/reveal-os' && method === 'POST') {
    return revealInOsFileManager(String(data.path || ''), roots);
  }
  if (u.pathname === '/api/shortcut' && method === 'GET') {
    const settings = getShortcutSettings();
    return {
      ok: true,
      platform: process.platform,
      settings,
      presets: HOTKEY_PRESETS,
      shortcut: settings.drawerShortcut,
      drawerShortcut: settings.drawerShortcut,
      auxShortcut: settings.auxShortcut,
      drawer: {
        ok: true,
        daemonRunning: true,
        running: Boolean(stateObj.windowVisible),
        windowVisible: Boolean(stateObj.windowVisible),
        pinned: Boolean(stateObj.pinned),
        hotkeyPreset: stateObj.hotkeyPreset || settings.hotkeyPreset,
        shortcut: settings.drawerShortcut,
        drawerShortcut: settings.drawerShortcut,
        auxShortcut: settings.auxShortcut,
        nativeHotkeySupported: process.platform === 'darwin',
        mode: stateObj.mode
      },
      hostShortcuts: {
        toggleSidePanel: process.platform === 'darwin' ? '⌘⇧B' : 'Ctrl+Shift+B',
        closeTab: process.platform === 'darwin' ? '⌘W' : 'Ctrl+W',
        reopenTab: process.platform === 'darwin' ? '⌘⇧T' : 'Ctrl+Shift+T'
      }
    };
  }
  if (u.pathname === '/api/shortcut' && method === 'POST') {
    const act = String(data.action || '').toLowerCase();
    if (act === 'set-hotkey') {
      const next = saveShortcutSettings({ hotkeyPreset: String(data.hotkeyPreset || '') });
      stateObj.hotkeyPreset = next.hotkeyPreset;
      hooks.onSetDrawerShortcut?.(next.drawerShortcut);
      writeDrawerState(stateObj);
      return {
        ok: true,
        settings: next,
        hotkeyPreset: next.hotkeyPreset,
        shortcut: next.drawerShortcut,
        drawerShortcut: next.drawerShortcut,
        auxShortcut: next.auxShortcut
      };
    }
    if (act === 'set-drawer-shortcut') {
      const res = setDrawerShortcutConfig(data);
      if (!res.ok) {
        return {
          ok: false,
          error: res.error,
          shortcut: res.drawerShortcut,
          drawerShortcut: res.drawerShortcut
        };
      }
      stateObj.hotkeyPreset = res.hotkeyPreset;
      hooks.onSetDrawerShortcut?.(res.drawerShortcut);
      hooks.onSetAuxShortcut?.(res.auxShortcut);
      writeDrawerState(stateObj);
      return {
        ok: true,
        hotkeyPreset: res.hotkeyPreset,
        shortcut: res.drawerShortcut,
        drawerShortcut: res.drawerShortcut,
        auxShortcut: res.auxShortcut,
        message: res.drawerShortcut.enabled
          ? `独立目录树抽屉快捷键已设为 ${res.drawerShortcut.display}`
          : '已关闭独立目录树抽屉快捷键'
      };
    }
    if (act === 'set-recording') {
      hooks.onSetRecording?.(Boolean(data.recording));
      return { ok: true };
    }
    if (act === 'set-aux-shortcut') {
      const res = setAuxShortcutConfig(data);
      if (!res.ok) {
        return {
          ok: false,
          error: res.error,
          auxShortcut: res.auxShortcut
        };
      }
      hooks.onSetDrawerShortcut?.(res.drawerShortcut);
      hooks.onSetAuxShortcut?.(res.auxShortcut);
      writeDrawerState(stateObj);
      const ctrlHint = (process.platform === 'darwin' && res.auxShortcut.enabled && /^Ctrl\+[A-Z]$/.test(res.auxShortcut.accelerator || ''))
        ? '（若与宿主编辑器快捷键冲突，可改用 ⌃⌥ 或 ⌥⌘ 组合）'
        : '';
      return {
        ok: true,
        shortcut: res.drawerShortcut,
        drawerShortcut: res.drawerShortcut,
        auxShortcut: res.auxShortcut,
        message: res.auxShortcut.enabled
          ? `AGY 侧栏目录树快捷键已设为 ${res.auxShortcut.display}${ctrlHint}`
          : '已关闭 AGY 侧栏目录树快捷键'
      };
    }
    if (act === 'trigger-aux' || act === 'aux' || act === 'toggle-aux') {
      const trigger = writeAuxPaneTrigger({
        targetPlugin: 'agy-finder',
        uri: 'sidecar://agy-finder/tree/',
        action: String(data.auxAction || 'toggle'),
        convId: String(data.convId || ''),
        revealPath: String(data.revealPath || '')
      });
      return { ok: true, trigger };
    }
    if (act === 'set-pinned') {
      const nextPinned = typeof data.pinned === 'boolean' ? data.pinned : !stateObj.pinned;
      saveShortcutSettings({ drawerPinned: nextPinned });
      stateObj.pinned = nextPinned;
      hooks.onSetPinned?.(nextPinned);
      writeDrawerState(stateObj);
      return { ok: true, pinned: nextPinned };
    }
    if (act === 'close') {
      hooks.onHide?.();
      return { ok: true, closed: true };
    }
    if (act === 'open') {
      hooks.onShow?.(String(data.revealPath || ''));
      return { ok: true, windowVisible: true };
    }
    if (act === 'toggle') {
      hooks.onToggle?.();
      return { ok: true, windowVisible: Boolean(stateObj.windowVisible) };
    }
  }
  if (u.pathname === '/api/aux-pane-trigger') {
    if (method === 'GET') {
      const since = Number(data.since || 0);
      const timeoutMs = Number(data.waitMs ?? data.timeoutMs ?? 8000);
      return waitForAuxPaneTrigger({ since, timeoutMs });
    }
    if (method === 'POST') {
      const act = String(data.action || 'trigger').toLowerCase();
      if (act === 'opening') {
        return markAuxPaneOpening({ seq: Number(data.seq || 0) });
      }
      if (act === 'ack') {
        return ackAuxPaneTrigger({
          seq: Number(data.seq || 0),
          plugin: String(data.plugin || 'agy-finder')
        });
      }
      if (act === 'switched') {
        return markAuxPaneSwitched({ seq: Number(data.seq || 0) });
      }
      if (act === 'hello') {
        return recordAuxActiveConversation({ convId: String(data.convId || '') });
      }
      const trigger = writeAuxPaneTrigger({
        targetPlugin: String(data.targetPlugin || 'agy-finder'),
        uri: String(data.uri || 'sidecar://agy-finder/tree/'),
        action: String(data.auxAction || act || 'toggle'),
        convId: String(data.convId || ''),
        revealPath: String(data.revealPath || '')
      });
      return { ok: true, trigger };
    }
  }

  const err = new Error(`Unknown route: ${method} ${u.pathname}`);
  err.status = 404;
  throw err;
}

function ensureCompiledMacBinary() {
  const errPath = join(getSidecarStateDir(), 'last_swiftc_error.txt');
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/swiftc')) {
    return null;
  }
  const swiftSrc = join(__dirname, 'native_drawer_macos.swift');
  if (!existsSync(swiftSrc)) return null;

  const srcHash = createHash('sha256').update(readFileSync(swiftSrc)).digest('hex').slice(0, 10);
  const binDir = join(getSidecarStateDir(), 'bin');
  mkdirSync(binDir, { recursive: true });
  const binPath = join(binDir, `af-drawer-macos-${srcHash}`);

  if (existsSync(binPath)) {
    try { rmSync(errPath, { force: true }); } catch {}
    return binPath;
  }

  try {
    execFileSync('/usr/bin/swiftc', [swiftSrc, '-o', binPath], {
      stdio: 'pipe',
      timeout: 60000
    });
    try { rmSync(errPath, { force: true }); } catch {}
    return binPath;
  } catch (err) {
    try {
      const detail = err?.stderr?.length ? String(err.stderr) : (err?.message || err?.code || '');
      const stderrText = String(detail).split('\n').filter(Boolean).slice(0, 3).join(' ').slice(0, 320);
      writeFileSync(errPath, stderrText || 'swiftc compilation failed', 'utf8');
    } catch {}
    return null;
  }
}

async function startMacNativeDaemon({
  initialPinned,
  initialVisible,
  initialPreset,
  initialRevealPath,
  initialDrawerShortcut = null,
  initialAuxShortcut = null
}) {
  const settings = getShortcutSettings();
  const effDrawer = initialDrawerShortcut || settings.drawerShortcut;
  const effAux = initialAuxShortcut || settings.auxShortcut;
  const binPath = ensureCompiledMacBinary();
  if (!binPath) {
    if (initialVisible) {
      return startFallbackAppWindowDaemon({ initialPinned, initialPreset, initialRevealPath });
    }
    process.exit(0);
  }

  const stateObj = {
    daemonVersion: DAEMON_VERSION,
    daemonBuildId: DAEMON_BUILD_ID,
    daemonRunning: true,
    running: initialVisible,
    windowVisible: initialVisible,
    pid: process.pid,
    pinned: initialPinned,
    hotkeyPreset: initialPreset,
    drawerShortcut: effDrawer,
    auxShortcut: effAux,
    mode: 'native-macos',
    cmdSeq: 0,
    startedAt: new Date().toISOString()
  };

  const args = ['--preset', initialPreset, ...buildShortcutCliArgs(effDrawer, effAux)];
  if (!initialPinned) args.push('--unpinned');
  if (!initialVisible) args.push('--hidden-window');

  const child = spawn(binPath, args, { stdio: ['pipe', 'pipe', 'ignore'] });

  const sendToChild = (obj) => {
    if (child.stdin && !child.stdin.destroyed) {
      child.stdin.write(`${JSON.stringify(obj)}\n`);
    }
  };

  const hooks = {
    onSetHotkey: (preset) => sendToChild({ type: 'setHotkey', hotkeyPreset: preset }),
    onSetDrawerShortcut: (cfg) => {
      stateObj.drawerShortcut = cfg;
      sendToChild({ type: 'setDrawerShortcut', ...buildShortcutDaemonPayload(cfg) });
    },
    onSetAuxShortcut: (cfg) => {
      stateObj.auxShortcut = cfg;
      sendToChild({ type: 'setAuxShortcut', ...buildShortcutDaemonPayload(cfg) });
    },
    onSetRecording: (recording) => sendToChild({ type: 'setShortcutRecording', recording: Boolean(recording) }),
    onSetPinned: (p) => sendToChild({ type: 'setPinned', pinned: p }),
    onHide: () => sendToChild({ type: 'hideWindow' }),
    onShow: (rp) => sendToChild({ type: 'showWindow', revealPath: rp || '' }),
    onToggle: () => sendToChild({ type: 'toggleWindow' })
  };

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg.type === 'ready') {
      const latest = getShortcutSettings();
      const html = buildBundledDrawerHtml({
        initialPinned: stateObj.pinned,
        initialHotkeyPreset: stateObj.hotkeyPreset,
        initialDrawerShortcut: latest.drawerShortcut,
        initialAuxShortcut: latest.auxShortcut
      });
      sendToChild({ type: 'loadHtml', html });
      if (initialVisible && initialRevealPath) {
        sendToChild({ type: 'revealPath', revealPath: initialRevealPath });
      }
      writeDrawerState(stateObj);
      return;
    }

    if (msg.type === 'visibilityChanged') {
      stateObj.windowVisible = Boolean(msg.windowVisible);
      stateObj.running = stateObj.windowVisible;
      writeDrawerState(stateObj);
      return;
    }

    if (msg.type === 'pinChanged') {
      stateObj.pinned = Boolean(msg.pinned);
      saveShortcutSettings({ drawerPinned: stateObj.pinned });
      writeDrawerState(stateObj);
      return;
    }

    if (msg.type === 'hotkeyChanged') {
      stateObj.hotkeyPreset = String(msg.hotkeyPreset || 'cmd+shift+e');
      saveShortcutSettings({ hotkeyPreset: stateObj.hotkeyPreset });
      writeDrawerState(stateObj);
      return;
    }

    if (msg.type === 'auxHotkeyTriggered') {
      const trigger = writeAuxPaneTrigger({
        targetPlugin: 'agy-finder',
        uri: 'sidecar://agy-finder/tree/',
        action: 'toggle'
      });
      const checkTimer = setTimeout(() => {
        const cur = readAuxPaneTrigger();
        if (Number(cur.ackSeq || 0) >= Number(trigger.seq || 1)) return;
        const opened = Number(cur.openingSeq || 0) >= Number(trigger.seq || 1);
        if (opened) {
          const graceTimer = setTimeout(() => {
            const afterGrace = readAuxPaneTrigger();
            if (Number(afterGrace.ackSeq || 0) >= Number(trigger.seq || 1)) return;
            sendToChild({
              type: 'showHud',
              message: '右侧栏已展开：请点开一次「AGY Finder」（右键标签 Pin Tab 固定后，按快捷键即可自动开栏直达）'
            });
          }, 750);
          graceTimer.unref?.();
          return;
        }
        sendToChild({
          type: 'showHud',
          message: '首次启动请先在右侧 Overview → Extensions 点开一次「AGY Finder」（右键 Pin Tab 后跨会话直接呼出）'
        });
      }, 720);
      checkTimer.unref?.();
      return;
    }

    if (msg.type === 'closed') {
      clearDrawerStateIfOwned();
      process.exit(0);
    }

    if (msg.type === 'rpcRequest') {
      try {
        const payload = await dispatchDrawerRpc(msg.path, msg.method, msg.body, stateObj, hooks);
        sendToChild({ type: 'rpcReply', id: msg.id, ok: true, status: 200, payload });
      } catch (err) {
        sendToChild({
          type: 'rpcReply',
          id: msg.id,
          ok: false,
          status: Number.isInteger(err?.status) ? err.status : 500,
          payload: { ok: false, error: err?.message || 'Internal error' }
        });
      }
    }
  });

  const handleSigUsr1 = () => {
    const cmdObj = readJsonSafe(getCmdFilePath());
    if (!cmdObj || Number(cmdObj.seq || 0) <= Number(stateObj.cmdSeq || 0)) return;
    stateObj.cmdSeq = Number(cmdObj.seq);
    if (cmdObj.cmd === 'showWindow') {
      sendToChild({ type: 'showWindow', revealPath: String(cmdObj.revealPath || '') });
    } else if (cmdObj.cmd === 'hideWindow') {
      sendToChild({ type: 'hideWindow' });
    } else if (cmdObj.cmd === 'toggleWindow') {
      sendToChild({ type: 'toggleWindow' });
    } else if (cmdObj.cmd === 'setHotkey' && cmdObj.hotkeyPreset) {
      stateObj.hotkeyPreset = String(cmdObj.hotkeyPreset);
      sendToChild({ type: 'setHotkey', hotkeyPreset: stateObj.hotkeyPreset });
    } else if (cmdObj.cmd === 'setDrawerShortcut' && cmdObj.shortcut) {
      if (cmdObj.hotkeyPreset) stateObj.hotkeyPreset = String(cmdObj.hotkeyPreset);
      stateObj.drawerShortcut = getShortcutSettings().drawerShortcut;
      sendToChild({ type: 'setDrawerShortcut', ...cmdObj.shortcut });
    } else if (cmdObj.cmd === 'setAuxShortcut' && cmdObj.shortcut) {
      stateObj.auxShortcut = getShortcutSettings().auxShortcut;
      sendToChild({ type: 'setAuxShortcut', ...cmdObj.shortcut });
    } else if (cmdObj.cmd === 'syncShortcuts') {
      if (cmdObj.hotkeyPreset) stateObj.hotkeyPreset = String(cmdObj.hotkeyPreset);
      const latest = getShortcutSettings();
      stateObj.drawerShortcut = latest.drawerShortcut;
      stateObj.auxShortcut = latest.auxShortcut;
      if (cmdObj.drawerShortcut) sendToChild({ type: 'setDrawerShortcut', ...cmdObj.drawerShortcut });
      if (cmdObj.auxShortcut) sendToChild({ type: 'setAuxShortcut', ...cmdObj.auxShortcut });
    } else if (cmdObj.cmd === 'setPinned' && typeof cmdObj.pinned === 'boolean') {
      stateObj.pinned = cmdObj.pinned;
      sendToChild({ type: 'setPinned', pinned: stateObj.pinned });
    } else if (cmdObj.cmd === 'setShortcutRecording') {
      sendToChild({ type: 'setShortcutRecording', recording: Boolean(cmdObj.recording) });
    }
    writeDrawerState(stateObj);
  };

  process.on('SIGUSR1', handleSigUsr1);

  const shutdown = () => {
    clearDrawerStateIfOwned();
    sendToChild({ type: 'quit' });
    setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      process.exit(0);
    }, 120);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  child.on('exit', () => {
    clearDrawerStateIfOwned();
    process.exit(0);
  });
}

function findChromiumBinary() {
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
          '/Applications/Chromium.app/Contents/MacOS/Chromium'
        ]
      : ['google-chrome', 'microsoft-edge', 'chromium', 'chromium-browser', 'brave-browser'];

  for (const c of candidates) {
    if (c.includes('/') || c.includes('\\')) {
      if (existsSync(c)) return c;
    } else {
      try {
        const found = execFileSync('which', [c], { encoding: 'utf8', timeout: 800 }).trim();
        if (found) return found;
      } catch {}
    }
  }
  return '';
}

function tokensEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  return ba.length > 0 && ba.length === bb.length && timingSafeEqual(ba, bb);
}

async function startFallbackAppWindowDaemon({ initialPinned, initialPreset, initialRevealPath }) {
  const browserBin = findChromiumBinary();
  if (!browserBin) {
    process.exit(1);
  }

  const csrfToken = randomBytes(24).toString('hex');
  const controlToken = randomBytes(24).toString('hex');
  const userDataDir = join(getSidecarStateDir(), 'chromium-drawer-profile');
  mkdirSync(userDataDir, { recursive: true });

  const stateObj = {
    daemonVersion: DAEMON_VERSION,
    daemonBuildId: DAEMON_BUILD_ID,
    daemonRunning: true,
    running: true,
    windowVisible: true,
    pid: process.pid,
    pinned: initialPinned,
    hotkeyPreset: initialPreset,
    mode: 'app-window',
    cmdSeq: 0,
    controlPort: 0,
    controlToken,
    startedAt: new Date().toISOString()
  };

  let browserChild = null;
  let lastReveal = initialRevealPath || '';

  const shutdown = () => {
    clearDrawerStateIfOwned();
    try { browserChild?.kill('SIGTERM'); } catch {}
    try { server.close(); } catch {}
    process.exit(0);
  };

  const server = createServer(async (req, res) => {
    const port = server.address()?.port || 0;
    const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    const reqHost = String(req.headers.host || '').trim().toLowerCase();
    if (!allowed.has(reqHost)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Forbidden host' }));
      return;
    }

    const u = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (u.pathname === '/internal/cmd' && req.method === 'POST') {
      if (!tokensEqual(req.headers['x-af-control-token'], controlToken)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Forbidden control token' }));
        return;
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let cmdObj = {};
      try { cmdObj = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
      if (cmdObj.cmd === 'close' || cmdObj.cmd === 'hideWindow') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        setTimeout(shutdown, 40);
        return;
      }
      if (cmdObj.revealPath) lastReveal = String(cmdObj.revealPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'GET' && u.pathname === '/') {
      let html = readFileSync(join(__dirname, 'index.html'), 'utf8');
      html = html.replace(
        '</head>',
        `  <meta name="af-csrf-token" content="${csrfToken}">\n</head>`
      );
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && u.pathname === '/preload.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end('window.sidecar = window.sidecar || { isDrawerWindow: true, conversationId: "", getWorkspaceUris: async () => [], onWorkspaceChange: () => () => {} };');
      return;
    }
    if (req.method === 'GET' && u.pathname === '/styles.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      res.end(readFileSync(join(__dirname, 'styles.css'), 'utf8'));
      return;
    }
    if (req.method === 'GET' && u.pathname === '/app.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(readFileSync(join(__dirname, 'app.js'), 'utf8'));
      return;
    }
    if (req.method === 'GET' && u.pathname === '/assets/logo.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(readFileSync(join(PLUGIN_ROOT, 'assets', 'logo.svg'), 'utf8'));
      return;
    }

    if (req.method === 'POST' && !tokensEqual(req.headers['x-af-token'], csrfToken)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Forbidden CSRF token' }));
      return;
    }

    let rawBody = '';
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      rawBody = Buffer.concat(chunks).toString('utf8');
    }

    try {
      const payload = await dispatchDrawerRpc(u.pathname + u.search, req.method, rawBody, stateObj, {
        onHide: () => setTimeout(shutdown, 40)
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(Number.isInteger(err?.status) ? err.status : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err?.message || 'Internal error' }));
    }
  });

  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    stateObj.controlPort = port;
    writeDrawerState(stateObj);

    const qs = new URLSearchParams({ mode: 'drawer' });
    if (lastReveal) qs.set('path', lastReveal);
    const targetUrl = `http://127.0.0.1:${port}/?${qs.toString()}`;

    browserChild = spawn(
      browserBin,
      [
        `--app=${targetUrl}`,
        `--user-data-dir=${userDataDir}`,
        '--window-size=360,820',
        '--no-first-run',
        '--no-default-browser-check'
      ],
      { stdio: 'ignore' }
    );
    browserChild.on('exit', shutdown);
    browserChild.on('error', shutdown);
  });

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv.includes('--daemon')) {
  const settings = getShortcutSettings();
  const initialPinned = !process.argv.includes('--unpinned') && settings.drawerPinned;
  const initialVisible = !process.argv.includes('--hidden-window');
  const pIdx = process.argv.indexOf('--preset');
  const initialPreset = pIdx >= 0 && process.argv[pIdx + 1] ? process.argv[pIdx + 1] : settings.hotkeyPreset;
  const rIdx = process.argv.indexOf('--reveal');
  const initialRevealPath = rIdx >= 0 && process.argv[rIdx + 1] ? process.argv[rIdx + 1] : '';

  if (process.platform === 'darwin') {
    startMacNativeDaemon({
      initialPinned,
      initialVisible,
      initialPreset,
      initialRevealPath,
      initialDrawerShortcut: settings.drawerShortcut,
      initialAuxShortcut: settings.auxShortcut
    });
  } else {
    startFallbackAppWindowDaemon({ initialPinned, initialPreset, initialRevealPath });
  }
}
