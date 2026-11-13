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
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
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

export const DAEMON_VERSION = 1;

export const HOTKEY_PRESETS = [
  { id: 'cmd+shift+e', macLabel: '⌘⇧E', winLabel: 'Ctrl+Shift+E', desc: '默认快捷键' },
  { id: 'cmd+alt+e', macLabel: '⌘⌥E', winLabel: 'Ctrl+Alt+E', desc: '备选快捷键' },
  { id: 'ctrl+shift+e', macLabel: '⌃⇧E', winLabel: 'Ctrl+Shift+E', desc: 'Control 组合' },
  { id: 'cmd+shift+y', macLabel: '⌘⇧Y', winLabel: 'Ctrl+Shift+Y', desc: '右手顺手键' },
  { id: 'off', macLabel: '关闭', winLabel: '关闭', desc: '仅手动点击打开' }
];

const VALID_PRESETS = new Set(HOTKEY_PRESETS.map((p) => p.id));

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

export function getShortcutSettings() {
  const raw = readJsonSafe(getSettingsPath());
  const rawPreset = String(raw?.hotkeyPreset || 'cmd+shift+e').toLowerCase();
  const hotkeyPreset = VALID_PRESETS.has(rawPreset) ? rawPreset : 'cmd+shift+e';
  const drawerPinned = raw?.drawerPinned !== undefined ? Boolean(raw.drawerPinned) : true;
  return { hotkeyPreset, drawerPinned };
}

export function saveShortcutSettings(patch = {}) {
  const current = getShortcutSettings();
  let nextPreset = current.hotkeyPreset;
  if (typeof patch.hotkeyPreset === 'string') {
    const candidate = patch.hotkeyPreset.trim().toLowerCase();
    if (!VALID_PRESETS.has(candidate)) {
      const err = new Error(`不支持的快捷键预设：${patch.hotkeyPreset}`);
      err.status = 400;
      throw err;
    }
    nextPreset = candidate;
  }
  const nextPinned = typeof patch.drawerPinned === 'boolean' ? patch.drawerPinned : current.drawerPinned;
  const next = { hotkeyPreset: nextPreset, drawerPinned: nextPinned };
  writeJsonFileAtomic(getSettingsPath(), next);
  return next;
}

export function readActiveContextHint() {
  return readJsonSafe(getActiveContextPath()) || {};
}

export function recordActiveContextHint(partial = {}) {
  try {
    const cur = readActiveContextHint();
    const next = { ...cur };
    if (typeof partial.conversationId === 'string' && CONV_ID_RE.test(partial.conversationId.trim())) {
      next.conversationId = partial.conversationId.trim();
    }
    if (Array.isArray(partial.roots) && partial.roots.length > 0) {
      next.roots = partial.roots.filter((r) => typeof r === 'string' && existsSync(r));
    }
    if (typeof partial.primaryRoot === 'string' && existsSync(partial.primaryRoot)) {
      next.primaryRoot = partial.primaryRoot;
    }
    if (typeof partial.lastRevealPath === 'string' && partial.lastRevealPath.trim()) {
      next.lastRevealPath = partial.lastRevealPath.trim();
      next.lastRevealAt = Date.now();
    }
    if (typeof partial.agentApiExe === 'string' && partial.agentApiExe.trim()) {
      next.agentApiExe = partial.agentApiExe.trim();
    }
    next.updatedAt = Date.now();
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
  const settings = getShortcutSettings();
  const st = readDrawerState();
  const nativeHotkeySupported = platform === 'darwin';
  if (!st) {
    return {
      ok: true,
      daemonRunning: false,
      running: false,
      windowVisible: false,
      pinned: settings.drawerPinned,
      hotkeyPreset: settings.hotkeyPreset,
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
    hotkeyPreset: VALID_PRESETS.has(st.hotkeyPreset) ? st.hotkeyPreset : settings.hotkeyPreset,
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

async function spawnDaemon({ pinned = true, hiddenWindow = false, hotkeyPreset = 'cmd+shift+e', revealPath = '' } = {}) {
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
    const daemonArgs = [fileURLToPath(import.meta.url), '--daemon', '--preset', hotkeyPreset];
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

  if (action === 'set-hotkey') {
    const next = saveShortcutSettings({ hotkeyPreset: String(options.hotkeyPreset || '') });
    if (disableDrawer) {
      return {
        ...getDrawerStatus(platform),
        hotkeyPreset: next.hotkeyPreset,
        message: next.hotkeyPreset === 'off' ? '已关闭独立抽屉快捷键' : `已更新抽屉快捷键为 ${next.hotkeyPreset}`
      };
    }
    const current = readDrawerState();
    if (current) {
      const st = await sendDaemonCommand(current, { cmd: 'setHotkey', hotkeyPreset: next.hotkeyPreset });
      return {
        ...st,
        hotkeyPreset: next.hotkeyPreset,
        message: next.hotkeyPreset === 'off'
          ? '已关闭全局应用内快捷键（仍可从右侧抽屉按钮打开）'
          : `已生效：在 Antigravity 内按快捷键即可秒开/收回目录树`
      };
    }
    if (platform === 'darwin' && next.hotkeyPreset !== 'off') {
      const spawned = await spawnDaemon({
        pinned: next.drawerPinned,
        hiddenWindow: true,
        hotkeyPreset: next.hotkeyPreset
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
      message: `已保存快捷键预设：${next.hotkeyPreset}`
    };
  }

  if (action === 'set-pinned') {
    const nextPinned = typeof options.pinned === 'boolean' ? options.pinned : !getShortcutSettings().drawerPinned;
    saveShortcutSettings({ drawerPinned: nextPinned });
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
    const settings = getShortcutSettings();
    if (platform !== 'darwin' || settings.hotkeyPreset === 'off') {
      return getDrawerStatus(platform);
    }
    if (current) {
      if (current.hotkeyPreset !== settings.hotkeyPreset) {
        return sendDaemonCommand(current, { cmd: 'setHotkey', hotkeyPreset: settings.hotkeyPreset });
      }
      return getDrawerStatus(platform);
    }
    const st = await spawnDaemon({
      pinned: settings.drawerPinned,
      hiddenWindow: true,
      hotkeyPreset: settings.hotkeyPreset
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
    const settings = getShortcutSettings();
    if (current.mode === 'native-macos' && settings.hotkeyPreset !== 'off') {
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
  const settings = getShortcutSettings();
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
  return process.env.ANTIGRAVITY_APPDATA_DIR || join(homedir(), '.gemini', 'antigravity');
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

function buildBundledDrawerHtml({ initialPinned, initialHotkeyPreset }) {
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

  const bridgeScript = `
<script>
(() => {
  window.__AF_DRAWER_MODE__ = true;
  window.__AF_DRAWER_PINNED__ = ${initialPinned ? 'true' : 'false'};
  window.__AF_HOTKEY_PRESET__ = ${JSON.stringify(initialHotkeyPreset || 'cmd+shift+e')};
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
      drawer: {
        ok: true,
        daemonRunning: true,
        running: Boolean(stateObj.windowVisible),
        windowVisible: Boolean(stateObj.windowVisible),
        pinned: Boolean(stateObj.pinned),
        hotkeyPreset: stateObj.hotkeyPreset || settings.hotkeyPreset,
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
      hooks.onSetHotkey?.(next.hotkeyPreset);
      writeDrawerState(stateObj);
      return { ok: true, settings: next, hotkeyPreset: next.hotkeyPreset };
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

async function startMacNativeDaemon({ initialPinned, initialVisible, initialPreset, initialRevealPath }) {
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
    mode: 'native-macos',
    cmdSeq: 0,
    startedAt: new Date().toISOString()
  };

  const args = ['--preset', initialPreset];
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
      const html = buildBundledDrawerHtml({
        initialPinned: stateObj.pinned,
        initialHotkeyPreset: stateObj.hotkeyPreset
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
    } else if (cmdObj.cmd === 'setPinned' && typeof cmdObj.pinned === 'boolean') {
      stateObj.pinned = cmdObj.pinned;
      sendToChild({ type: 'setPinned', pinned: stateObj.pinned });
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
    startMacNativeDaemon({ initialPinned, initialVisible, initialPreset, initialRevealPath });
  } else {
    startFallbackAppWindowDaemon({ initialPinned, initialPreset, initialRevealPath });
  }
}
