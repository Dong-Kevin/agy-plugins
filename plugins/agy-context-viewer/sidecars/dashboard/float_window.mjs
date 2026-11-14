#!/usr/bin/env node
/**
 * Persistent Menu Bar (`NSStatusItem`) & Right-Side Floating Window Controller (`float_window.mjs`).
 *
 * - macOS: Compiles & caches `native_float_macos.swift` once into sidecar state dir,
 *   hosting:
 *     1) Top-right macOS Menu Bar live context indicator (`◈ 42%`), 1-click to pop/hide
 *        the right-side dashboard window (`<5ms` zero cold-start), switchable ON/OFF anytime;
 *     2) Native Cocoa + WKWebView right-docked Always-on-Top (`📌`) floating window
 *        communicating strictly over zero-port stdin/stdout JSON lines.
 * - Windows / Linux (or macOS without swiftc): Cleanly falls back to a frameless
 *   Chromium `--app` mini-window backed by a local loopback server.
 */

import { createHash } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  ackAuxPaneTrigger,
  collectTokenHistory,
  createLoopbackSessionToken,
  getAuxShortcutConfig,
  getMenubarMode,
  getMenubarPreference,
  getPluginStateDir,
  getSettings,
  getShortcutConfig,
  getSidebarEntryStatus,
  guardLoopbackRequest,
  injectCsrfMeta,
  launchCliTerminal,
  LOOPBACK_SECURITY_HEADERS,
  markAuxPaneOpening,
  markAuxPaneSwitched,
  MENUBAR_MODES,
  readAuxPaneTrigger,
  readLoopbackJsonBody,
  recordAuxActiveConversation,
  saveSettings,
  scanConversation,
  setAuxShortcutConfig,
  setMenubarMode,
  setMenubarPreference,
  setShortcutConfig,
  setSidebarEntrypoint,
  updateActiveSessionHint,
  waitForAuxPaneTrigger,
  writeAuxPaneTrigger
} from './collector.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DAEMON_VERSION = 7;
const DAEMON_RUNTIME_FILES = [
  'pricing.mjs',
  'collector.mjs',
  'float_window.mjs',
  'native_float_macos.swift',
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

function isDaemonStateCurrent(st) {
  return Boolean(
    st &&
    st.daemonVersion === DAEMON_VERSION &&
    st.daemonBuildId === DAEMON_BUILD_ID
  );
}

const MENUBAR_MODE_LABELS = {
  context: '当前上下文使用占比',
  speed: '最新生成速度与耗时（均值 / 峰值）',
  quota: '5 小时 / Week 额度余量'
};

function getStateFilePath() {
  return join(getPluginStateDir(), 'float_window_state.json');
}

function getCmdFilePath() {
  return join(getPluginStateDir(), 'float_cmd.json');
}

function getSpawnLockPath() {
  return join(getPluginStateDir(), 'float_spawn.lock');
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 1) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

const EXPECTED_DAEMON_ENTRY_REL = 'sidecars/dashboard/float_window.mjs';

function isRegularFileSafe(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

function isDaemonRuntimeExecutable(execToken) {
  const raw = String(execToken || '').trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/');
  if (!raw) return false;
  const base = raw.split('/').pop() || '';
  return /^(?:node(?:\d+(?:\.\d+)*)?|electron|antigravity|Antigravity(?:\s+Helper(?:\s+\([^)]+\))?)?)(?:\.exe)?$/i.test(base);
}

function isExactDaemonEntryPath(candidatePath, expectedRel = EXPECTED_DAEMON_ENTRY_REL) {
  const norm = String(candidatePath || '').trim().replace(/\\/g, '/');
  if (!norm || norm.startsWith('-')) return false;
  return norm === expectedRel || norm.endsWith('/' + expectedRel);
}

export function tokenizeWindowsCommandLine(cmdLine) {
  const s = String(cmdLine || '').trim();
  if (!s) return [];
  const args = [];
  let cur = '';
  let inQuotes = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      let bs = 0;
      while (i < s.length && s[i] === '\\') { bs++; i++; }
      if (i < s.length && s[i] === '"') {
        cur += '\\'.repeat(Math.floor(bs / 2));
        if (bs % 2 === 0) inQuotes = !inQuotes;
        else cur += '"';
        i++;
      } else {
        cur += '\\'.repeat(bs);
      }
      continue;
    }
    if (ch === '"') {
      if (inQuotes && i + 1 < s.length && s[i + 1] === '"') {
        cur += '"';
        i += 2;
      } else {
        inQuotes = !inQuotes;
        i++;
      }
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      args.push(cur);
      cur = '';
      while (i < s.length && /\s/.test(s[i])) i++;
      continue;
    }
    cur += ch;
    i++;
  }
  args.push(cur);
  return args;
}

export function evaluateStructuredDaemonArgv(argv, expectedRel = EXPECTED_DAEMON_ENTRY_REL) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return { status: 'unknown', reason: 'empty-argv' };
  }
  if (!isDaemonRuntimeExecutable(argv[0])) {
    return { status: 'mismatch', reason: 'exec-mismatch' };
  }
  if (argv.length < 3) {
    return { status: 'mismatch', reason: 'argv-too-short' };
  }
  if (!isExactDaemonEntryPath(argv[1], expectedRel)) {
    return { status: 'mismatch', reason: 'entry-mismatch' };
  }
  if (argv[2] !== '--daemon') {
    return { status: 'mismatch', reason: 'daemon-flag-not-argv2' };
  }
  return { status: 'verified' };
}

export function evaluatePsDaemonCommand(commRaw, argsRaw, expectedRel = EXPECTED_DAEMON_ENTRY_REL, isFileFn = isRegularFileSafe) {
  const comm = String(commRaw || '').replace(/[\r\n]+$/, '').trim();
  const args = String(argsRaw || '').replace(/[\r\n]+$/, '').trim();
  if (!args) return { status: 'unknown', reason: 'ps-empty-args' };

  let execToken = '';
  let rest = '';
  if (comm && args === comm) {
    if (!isDaemonRuntimeExecutable(comm)) return { status: 'mismatch', reason: 'exec-mismatch' };
    return { status: 'mismatch', reason: 'no-entry-args' };
  }
  if (comm && args.startsWith(comm + ' ')) {
    execToken = comm;
    rest = args.slice(comm.length + 1).trimStart();
  } else {
    const m = args.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    if (!m) return { status: 'unknown', reason: 'ps-unparseable' };
    const firstTok = m[1];
    if (comm) {
      const commBase = comm.replace(/\\/g, '/').split('/').pop() || '';
      const firstBase = firstTok.replace(/\\/g, '/').split('/').pop() || '';
      if (commBase && firstBase && !firstBase.startsWith(commBase) && !commBase.startsWith(firstBase)) {
        if (!isDaemonRuntimeExecutable(comm) && !isDaemonRuntimeExecutable(firstTok)) {
          return { status: 'mismatch', reason: 'exec-mismatch' };
        }
        return { status: 'unknown', reason: 'ps-comm-args-diverged' };
      }
    }
    execToken = comm && isDaemonRuntimeExecutable(comm) ? comm : firstTok;
    rest = String(m[2] || '').trimStart();
  }

  if (!isDaemonRuntimeExecutable(execToken)) {
    return { status: 'mismatch', reason: 'exec-mismatch' };
  }
  if (!rest || rest.startsWith('-')) {
    return { status: 'mismatch', reason: 'missing-or-flag-argv1' };
  }

  const normRest = rest.replace(/\\/g, '/');
  const escapedRel = expectedRel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entryMatch = new RegExp(`^([\\s\\S]*?${escapedRel})\\s+--daemon(?:\\s|$)`).exec(normRest);
  if (!entryMatch) {
    return { status: 'mismatch', reason: 'entry-or-daemon-mismatch' };
  }

  const rawCandidate = rest.slice(0, entryMatch[1].length);
  if (!isExactDaemonEntryPath(rawCandidate, expectedRel)) {
    return { status: 'mismatch', reason: 'entry-boundary-mismatch' };
  }

  // Zero internal whitespace => guaranteed single argv[1] token followed immediately by argv[2] === '--daemon'
  if (!/\s/.test(rawCandidate)) {
    return { status: 'verified' };
  }

  // Contains whitespace: distinguish genuine spaced directory path from `helper [args...] <entry>`
  const candidateExists = isFileFn(rawCandidate);
  const wsRe = /\s+/g;
  let ws;
  while ((ws = wsRe.exec(rawCandidate)) !== null) {
    const prefix = rawCandidate.slice(0, ws.index);
    const after = rawCandidate.slice(ws.index + ws[0].length);
    if (!candidateExists) {
      if (
        after.startsWith('-') ||
        /^(?:\.{0,2}\/|~\/|[A-Za-z]:[\\/])/.test(after) ||
        /\.(?:m?js|cjs|ts|py|sh|pl|rb)$/i.test(prefix) ||
        isFileFn(prefix)
      ) {
        return { status: 'mismatch', reason: 'multi-arg-before-entry' };
      }
    } else if (isFileFn(prefix)) {
      return { status: 'unknown', reason: 'ambiguous-spaced-file-prefix' };
    }
  }

  if (candidateExists) {
    return { status: 'verified' };
  }
  return { status: 'unknown', reason: 'unverified-spaced-entry' };
}

function queryProcessIdentity(pid) {
  const n = Number(pid);
  if (process.platform === 'win32') {
    try {
      const psCmd = `$ErrorActionPreference='Stop'; $p = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + ${n}); if ($null -eq $p) { [Console]::Out.Write('{"dead":true}') } else { [Console]::Out.Write((@{ dead = $false; name = [string]$p.Name; cmd = [string]$p.CommandLine } | ConvertTo-Json -Compress)) }`;
      const raw = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psCmd],
        { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      if (!raw) {
        return isPidAlive(n) ? { status: 'unknown', reason: 'win32-empty-output' } : { status: 'dead' };
      }
      const parsed = JSON.parse(raw);
      if (parsed.dead || !isPidAlive(n)) return { status: 'dead' };
      const procName = String(parsed.name || '').trim();
      if (procName && !isDaemonRuntimeExecutable(procName)) {
        return { status: 'mismatch', reason: 'win32-name-mismatch', cmdLine: String(parsed.cmd || '') };
      }
      const cmdLine = String(parsed.cmd || '').trim();
      if (!cmdLine) return { status: 'unknown', reason: 'win32-empty-cmdline' };
      return { status: 'structured', argv: tokenizeWindowsCommandLine(cmdLine), cmdLine };
    } catch {
      return isPidAlive(n) ? { status: 'unknown', reason: 'win32-probe-failed' } : { status: 'dead' };
    }
  }

  if (process.platform === 'linux') {
    try {
      const raw = readFileSync(`/proc/${n}/cmdline`, 'utf8');
      const trimmed = raw.replace(/\0+$/, '');
      if (trimmed) {
        const argv = trimmed.split('\0');
        return { status: 'structured', argv, cmdLine: argv.join(' ') };
      }
    } catch {}
  }

  let lastPsError = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!isPidAlive(n)) return { status: 'dead' };
    lastPsError = false;
    let comm = '';
    let args = '';
    try {
      comm = execFileSync(
        'ps',
        ['-ww', '-p', String(n), '-o', 'comm='],
        { env: { ...process.env, LC_ALL: 'C' }, encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).replace(/[\r\n]+$/, '');
      // -ww prevents macOS `ps` from truncating long paths at 80 columns
      args = execFileSync(
        'ps',
        ['-ww', '-p', String(n), '-o', 'args='],
        { env: { ...process.env, LC_ALL: 'C' }, encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).replace(/[\r\n]+$/, '');
    } catch {
      lastPsError = true;
    }
    if (!lastPsError && args.trim()) {
      return { status: 'ps', comm, args, cmdLine: args };
    }
    if (!isPidAlive(n)) return { status: 'dead' };
    if (attempt < 2) {
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } catch {}
    }
  }
  return isPidAlive(n)
    ? { status: 'unknown', reason: lastPsError ? 'ps-unavailable' : 'ps-empty-output' }
    : { status: 'dead' };
}

export function verifyDaemonProcessIdentity(stateObj) {
  const n = Number(stateObj?.pid);
  if (!Number.isInteger(n) || n <= 1) return { status: 'dead' };
  try {
    process.kill(n, 0);
  } catch (err) {
    if (err?.code === 'EPERM') return { status: 'mismatch', reason: 'eperm' };
    return { status: 'dead' };
  }
  if (process.env.AGY_TEST_PID_IDENTITY_MODE === 'unknown') {
    return { status: 'unknown', reason: 'test-forced-unknown' };
  }
  if (n === process.pid) {
    return evaluateStructuredDaemonArgv(process.argv, EXPECTED_DAEMON_ENTRY_REL);
  }

  const probe = queryProcessIdentity(n);
  if (probe.status === 'structured') {
    return { ...evaluateStructuredDaemonArgv(probe.argv, EXPECTED_DAEMON_ENTRY_REL), cmdLine: probe.cmdLine };
  }
  if (probe.status === 'ps') {
    return { ...evaluatePsDaemonCommand(probe.comm, probe.args, EXPECTED_DAEMON_ENTRY_REL), cmdLine: probe.cmdLine };
  }
  return probe;
}

function writeJsonFileAtomic(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmp, filePath);
}

function clearStateIfPidMatches(pid) {
  const p = getStateFilePath();
  if (!existsSync(p)) return;
  try {
    const obj = JSON.parse(readFileSync(p, 'utf-8'));
    if (!obj?.pid || Number(obj.pid) === Number(pid)) {
      rmSync(p, { force: true });
    }
  } catch {
    try { rmSync(p, { force: true }); } catch {}
  }
}

function inspectFloatState() {
  const p = getStateFilePath();
  if (!existsSync(p)) {
    return { state: null, rawState: null, identity: { status: 'dead' } };
  }
  let obj = null;
  try {
    obj = JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    try { rmSync(p, { force: true }); } catch {}
    return { state: null, rawState: null, identity: { status: 'dead' } };
  }
  if (!obj?.pid) {
    try { rmSync(p, { force: true }); } catch {}
    return { state: null, rawState: null, identity: { status: 'dead' } };
  }
  const identity = verifyDaemonProcessIdentity(obj);
  if (identity.status === 'verified') {
    return { state: obj, rawState: obj, identity };
  }
  if (identity.status === 'dead' || identity.status === 'mismatch') {
    try { rmSync(p, { force: true }); } catch {}
  }
  return { state: null, rawState: obj, identity };
}

function readFloatState() {
  return inspectFloatState().state;
}

function writeFloatState(data) {
  writeJsonFileAtomic(getStateFilePath(), data);
}

function clearFloatStateIfOwned() {
  clearStateIfPidMatches(process.pid);
}

async function terminateProcessAndWait(pid, optionsOrTimeout = 900) {
  const opts = typeof optionsOrTimeout === 'number'
    ? { timeoutMs: optionsOrTimeout }
    : (optionsOrTimeout || {});
  const timeoutMs = Number(opts.timeoutMs ?? 900);
  const targetState = opts.stateObj || { pid };

  const initial = verifyDaemonProcessIdentity(targetState);
  if (initial.status === 'dead' || initial.status === 'mismatch') {
    clearStateIfPidMatches(pid);
    return { terminated: false, skippedSignal: initial.status === 'mismatch', status: initial.status };
  }
  if (initial.status === 'unknown') {
    return { terminated: false, skippedSignal: true, status: 'unknown' };
  }

  try { process.kill(Number(pid), 'SIGTERM'); } catch {}
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isPidAlive(pid)) {
    await new Promise((r) => setTimeout(r, 35));
  }
  if (isPidAlive(pid)) {
    const beforeKill = verifyDaemonProcessIdentity(targetState);
    if (beforeKill.status === 'verified') {
      try { process.kill(Number(pid), 'SIGKILL'); } catch {}
      const killDeadline = Date.now() + 200;
      while (Date.now() < killDeadline && isPidAlive(pid)) {
        await new Promise((r) => setTimeout(r, 15));
      }
    } else if (beforeKill.status === 'unknown') {
      return { terminated: false, skippedSignal: true, status: 'unknown' };
    }
  }
  clearStateIfPidMatches(pid);
  return { terminated: true, skippedSignal: false, status: 'verified' };
}

export function getFloatWindowStatus(platform = process.platform) {
  const st = readFloatState();
  const menubarSupported = platform === 'darwin';
  const prefMenubar = menubarSupported ? getMenubarPreference() : false;
  const prefMode = getMenubarMode();
  const shortcut = getShortcutConfig(platform);
  const auxShortcut = getAuxShortcutConfig(platform);
  if (!st) {
    return {
      ok: true,
      daemonRunning: false,
      running: false,
      windowVisible: false,
      pinned: false,
      menubarEnabled: prefMenubar,
      menubarMode: prefMode,
      menubarActive: false,
      menubarSupported,
      shortcutEnabled: shortcut.enabled,
      shortcutActive: false,
      shortcut,
      auxShortcutEnabled: auxShortcut.enabled,
      auxShortcutActive: false,
      auxShortcut,
      statusTitle: null,
      activeConvId: null,
      activeConvTitle: null,
      mode: null
    };
  }
  const windowVisible = st.windowVisible !== undefined ? Boolean(st.windowVisible) : Boolean(st.running);
  const shortcutEnabled = st.shortcutEnabled !== undefined ? Boolean(st.shortcutEnabled) : shortcut.enabled;
  const auxShortcutEnabled = st.auxShortcutEnabled !== undefined ? Boolean(st.auxShortcutEnabled) : auxShortcut.enabled;
  return {
    ok: true,
    daemonRunning: true,
    daemonVersion: st.daemonVersion ?? null,
    daemonBuildId: st.daemonBuildId ?? null,
    running: windowVisible,
    windowVisible,
    pid: st.pid,
    pinned: Boolean(st.pinned),
    menubarEnabled: menubarSupported ? Boolean(st.menubarEnabled ?? prefMenubar) : false,
    menubarMode: MENUBAR_MODES.includes(st.menubarMode) ? st.menubarMode : prefMode,
    menubarActive: Boolean(st.menubarEnabled),
    menubarSupported,
    shortcutEnabled,
    shortcutActive: menubarSupported && shortcutEnabled && (st.mode || 'native-macos') === 'native-macos',
    shortcut,
    auxShortcutEnabled,
    auxShortcutActive: menubarSupported && auxShortcutEnabled && (st.mode || 'native-macos') === 'native-macos',
    auxShortcut,
    statusTitle: st.statusTitle || null,
    activeConvId: st.activeConvId || null,
    activeConvTitle: st.activeConvTitle || null,
    hasLsBridge: Boolean(st.hasLsBridge),
    mode: st.mode || 'native-macos',
    cmdSeq: Number(st.cmdSeq || 0),
    startedAt: st.startedAt || null
  };
}

async function sendDaemonCommand(current, cmdObj) {
  if (verifyDaemonProcessIdentity(current).status !== 'verified') {
    return getFloatWindowStatus();
  }
  const seq = Math.max(Number(current.cmdSeq || 0) + 1, Date.now());
  writeJsonFileAtomic(getCmdFilePath(), { seq, ...cmdObj });
  try {
    process.kill(current.pid, 'SIGUSR1');
  } catch {
    return getFloatWindowStatus();
  }

  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    const st = readFloatState();
    if (!st || Number(st.cmdSeq || 0) >= seq) {
      return getFloatWindowStatus();
    }
  }
  return getFloatWindowStatus();
}

function resolveStandaloneNodeBinary() {
  if (process.execPath && !/Antigravity|Electron|Helper/i.test(process.execPath) && existsSync(process.execPath)) {
    return { bin: process.execPath, extraEnv: {} };
  }
  const candidates = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node'
  ];
  for (const c of candidates) {
    if (existsSync(c)) return { bin: c, extraEnv: {} };
  }
  if (process.platform !== 'win32') {
    try {
      const found = execFileSync('/usr/bin/which', ['node'], { encoding: 'utf-8', timeout: 1000 }).trim();
      if (found && existsSync(found)) return { bin: found, extraEnv: {} };
    } catch {}
  }
  return { bin: process.execPath, extraEnv: { ELECTRON_RUN_AS_NODE: '1' } };
}

function diagnoseMacMenubarFailure() {
  if (process.platform !== 'darwin') {
    return '顶部系统菜单栏常驻图标仅支持 macOS 系统';
  }
  const errPath = join(getPluginStateDir(), 'last_swiftc_error.txt');
  if (existsSync(errPath)) {
    try {
      const detail = readFileSync(errPath, 'utf-8').trim();
      if (detail) {
        return `macOS 原生菜单栏编译未成功（请确认已安装 Xcode Command Line Tools：xcode-select --install）：${detail}`;
      }
    } catch {}
  }
  return '未能启动 macOS 原生菜单栏守护进程，请确认已安装 Xcode Command Line Tools（运行 xcode-select --install）后重试。';
}

async function spawnDaemon({ pinned = true, menubarEnabled = true, hiddenWindow = false, menubarMode = '' } = {}) {
  if (process.env.AGY_CONTEXT_VIEWER_DISABLE_DAEMON === '1') {
    return null;
  }
  const lockPath = getSpawnLockPath();
  if (existsSync(lockPath)) {
    try {
      const lockAge = Date.now() - statSync(lockPath).mtimeMs;
      const lockObj = JSON.parse(readFileSync(lockPath, 'utf-8'));
      if (lockAge < 15000 && lockObj?.pid && isPidAlive(lockObj.pid)) {
        const waitDeadline = Date.now() + 15000;
        while (Date.now() < waitDeadline) {
          await new Promise((r) => setTimeout(r, 80));
          const existing = readFloatState();
          if (isDaemonStateCurrent(existing)) {
            return getFloatWindowStatus();
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
    const resolvedMode = MENUBAR_MODES.includes(menubarMode) ? menubarMode : getMenubarMode();
    const daemonArgs = [fileURLToPath(import.meta.url), '--daemon', '--mode', resolvedMode];
    if (pinned === false) daemonArgs.push('--unpinned');
    if (!menubarEnabled) daemonArgs.push('--no-menubar');
    if (hiddenWindow) daemonArgs.push('--hidden-window');

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

    // Covers one-time cold-cache swiftc compilation (~2s); cached binary boots in ~80ms
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 65));
      const st = readFloatState();
      if (st?.pid && isDaemonStateCurrent(st)) {
        return getFloatWindowStatus();
      }
      if (childExited) break;
    }
  } finally {
    try { rmSync(lockPath, { force: true }); } catch {}
  }

  return null;
}

export async function controlFloatWindow(options = {}, deps = {}) {
  const platform = deps.platform || process.platform;
  const spawnFn = deps.spawnDaemon || spawnDaemon;
  const terminateFn = deps.terminateProcess || terminateProcessAndWait;
  const sendCmdFn = deps.sendDaemonCommand || sendDaemonCommand;

  const action = String(options.action || 'toggle').toLowerCase();
  if (action === 'status') {
    return getFloatWindowStatus(platform);
  }

  if (action === 'toggle-aux' || action === 'open-aux') {
    const trig = writeAuxPaneTrigger({
      targetPlugin: 'context-viewer',
      uri: 'sidecar://context-viewer/dashboard/',
      action: action === 'open-aux' ? 'open' : 'toggle',
      convId: typeof options.convId === 'string' ? options.convId : ''
    });
    if (trig?.ok === false || !trig?.seq) {
      return {
        ok: false,
        acked: false,
        lockBusy: true,
        trigger: trig,
        message: '侧栏触发锁繁忙，请稍后重试'
      };
    }
    const deadline = Date.now() + 650;
    let latest = readAuxPaneTrigger();
    while (Date.now() < deadline && Number(latest.ackSeq || 0) < Number(trig.seq || 1)) {
      await new Promise((r) => setTimeout(r, 45));
      latest = readAuxPaneTrigger();
    }
    const acked = Number(latest.ackSeq || 0) >= Number(trig.seq || 1);
    const opened = Number(latest.openingSeq || 0) >= Number(trig.seq || 1);
    let message = '已切换 Antigravity 右侧辅助栏「上下文看板」';
    if (!acked) {
      message = opened
        ? '侧栏已展开：因看板标签曾被 × 关闭，请在右侧 Extensions 点开一次「上下文看板」（右键标签选 Pin Tab 可永久固定）'
        : '首次启动请先在右侧 Overview → Extensions 点开一次「上下文看板」（右键标签选 Pin Tab 后即可跨会话随时呼出）';
    }
    return {
      ok: true,
      acked,
      trigger: latest,
      message
    };
  }

  if (action === 'quit') {
    const inspected = inspectFloatState();
    if (inspected.identity.status === 'unknown') {
      const pidLabel = inspected.rawState?.pid ?? 'unknown';
      const warning = `[WARN] [context-viewer] 无法核实后台进程身份（PID ${pidLabel}），已跳过发送退出信号；请手动确认进程状态。`;
      return {
        ...getFloatWindowStatus(platform),
        ok: true,
        closed: false,
        terminated: false,
        skippedSignal: true,
        unverifiedPid: inspected.rawState?.pid ?? null,
        warning,
        message: warning
      };
    }
    if (inspected.identity.status === 'verified' && inspected.state?.pid) {
      const termRes = await terminateFn(inspected.state.pid, { stateObj: inspected.state });
      if (termRes?.skippedSignal && termRes?.status === 'unknown') {
        const warning = `[WARN] [context-viewer] 无法核实后台进程身份（PID ${inspected.state.pid}），已跳过发送退出信号；请手动确认进程状态。`;
        return {
          ...getFloatWindowStatus(platform),
          ok: true,
          closed: false,
          terminated: false,
          skippedSignal: true,
          unverifiedPid: inspected.state.pid,
          warning,
          message: warning
        };
      }
      return {
        ...getFloatWindowStatus(platform),
        closed: true,
        terminated: true,
        skippedSignal: false,
        message: '已彻底退出悬浮看板与顶部菜单栏守护进程'
      };
    }
    return {
      ...getFloatWindowStatus(platform),
      closed: true,
      terminated: false,
      skippedSignal: inspected.identity.status === 'mismatch',
      staleStateCleaned: inspected.identity.status === 'mismatch',
      message: '已彻底退出悬浮看板与顶部菜单栏守护进程'
    };
  }

  let current = readFloatState();
  const callerLsAddr = process.env.ANTIGRAVITY_LS_ADDRESS || '';
  let upgradedFrom = null;

  // Seamlessly upgrade older daemons (version or code/asset fingerprint mismatch)
  // OR refresh daemon when Antigravity restarts with a new LS port
  if (
    current &&
    (!isDaemonStateCurrent(current) || (callerLsAddr && current.lsAddress !== callerLsAddr))
  ) {
    const prevVisible = Boolean(current.windowVisible ?? current.running);
    const prevPinned = current.pinned !== false;
    const prevMenubar = Boolean(current.menubarEnabled);
    const prevShortcut = Boolean(current.shortcutEnabled ?? getShortcutConfig(platform).enabled);
    const prevAuxShortcut = Boolean(current.auxShortcutEnabled ?? getAuxShortcutConfig(platform).enabled);
    const prevMode = MENUBAR_MODES.includes(current.menubarMode) ? current.menubarMode : getMenubarMode();
    upgradedFrom = { prevVisible, prevPinned, prevMenubar, prevShortcut, prevAuxShortcut, prevMode };
    await terminateFn(current.pid, { stateObj: current });
    current = null;
    if ((action === 'ensure-menubar' || action === 'ensure-daemon') && prevVisible) {
      const restarted = await spawnFn({
        pinned: prevPinned,
        menubarEnabled: platform === 'darwin' ? getMenubarPreference() : false,
        hiddenWindow: false,
        menubarMode: prevMode
      });
      return restarted || getFloatWindowStatus(platform);
    }
    if (action === 'refresh-session' && (prevVisible || (platform === 'darwin' && (prevMenubar || prevShortcut || prevAuxShortcut)))) {
      const restarted = await spawnFn({
        pinned: prevPinned,
        menubarEnabled: platform === 'darwin' ? prevMenubar : false,
        hiddenWindow: !prevVisible,
        menubarMode: prevMode
      });
      return restarted || getFloatWindowStatus(platform);
    }
  }

  if (action === 'refresh-session') {
    if (current?.menubarEnabled) {
      return sendCmdFn(current, { cmd: 'refreshSession' });
    }
    return getFloatWindowStatus(platform);
  }

  if (action === 'ensure-menubar' || action === 'ensure-daemon') {
    if (platform !== 'darwin') {
      return getFloatWindowStatus(platform);
    }
    const wantMenubar = getMenubarPreference();
    const sc = getShortcutConfig(platform);
    const auxSc = getAuxShortcutConfig(platform);
    const wantShortcut = Boolean(sc.enabled);
    const wantAuxShortcut = Boolean(auxSc.enabled);
    if (!wantMenubar && !wantShortcut && !wantAuxShortcut) {
      return getFloatWindowStatus(platform);
    }
    if (current) {
      if (wantMenubar && !current.menubarEnabled) {
        return sendCmdFn(current, { cmd: 'setMenubar', enabled: true, mode: getMenubarMode() });
      }
      if (
        current.shortcutEnabled !== undefined &&
        (
          Boolean(current.shortcutEnabled) !== wantShortcut ||
          (wantShortcut && current.shortcutAccelerator && current.shortcutAccelerator !== sc.accelerator) ||
          (wantShortcut && current.shortcutScope && current.shortcutScope !== sc.scope)
        )
      ) {
        await sendCmdFn(current, {
          cmd: 'setShortcut',
          enabled: wantShortcut,
          accelerator: sc.accelerator,
          display: sc.display,
          scope: sc.scope,
          keyCode: sc.macCarbon?.keyCode ?? -1,
          modifiers: sc.macCarbon?.modifiers ?? 0
        });
      }
      if (
        current.auxShortcutEnabled !== undefined &&
        (
          Boolean(current.auxShortcutEnabled) !== wantAuxShortcut ||
          (wantAuxShortcut && current.auxShortcutAccelerator && current.auxShortcutAccelerator !== auxSc.accelerator)
        )
      ) {
        return sendCmdFn(current, {
          cmd: 'setAuxShortcut',
          enabled: wantAuxShortcut,
          accelerator: auxSc.accelerator,
          display: auxSc.display,
          scope: auxSc.scope,
          keyCode: auxSc.macCarbon?.keyCode ?? -1,
          modifiers: auxSc.macCarbon?.modifiers ?? 0
        });
      }
      return getFloatWindowStatus(platform);
    }
    const st = await spawnFn({
      pinned: upgradedFrom ? upgradedFrom.prevPinned : true,
      menubarEnabled: wantMenubar,
      hiddenWindow: true,
      menubarMode: upgradedFrom ? upgradedFrom.prevMode : getMenubarMode()
    });
    return st || getFloatWindowStatus(platform);
  }

  if (action === 'set-shortcut') {
    const saved = setShortcutConfig(options, platform);
    if (!saved.ok) {
      return {
        ...getFloatWindowStatus(platform),
        ok: false,
        error: saved.error,
        shortcut: saved.shortcut
      };
    }
    const sc = saved.shortcut;
    const auxSc = getAuxShortcutConfig(platform);
    let nextStatus = null;
    if (platform === 'darwin') {
      if (current) {
        nextStatus = await sendCmdFn(current, {
          cmd: 'setShortcut',
          enabled: sc.enabled,
          accelerator: sc.accelerator,
          display: sc.display,
          scope: sc.scope,
          keyCode: sc.macCarbon?.keyCode ?? -1,
          modifiers: sc.macCarbon?.modifiers ?? 0
        });
      } else if (sc.enabled || auxSc.enabled) {
        nextStatus = await spawnFn({
          pinned: upgradedFrom ? upgradedFrom.prevPinned : true,
          menubarEnabled: getMenubarPreference(),
          hiddenWindow: true,
          menubarMode: upgradedFrom ? upgradedFrom.prevMode : getMenubarMode()
        });
      }
    }
    const fresh = getFloatWindowStatus(platform);
    const scopeLabel = sc.scope === 'global' ? '全局生效' : '仅宿主前台生效';
    const message = !sc.enabled
      ? '已关闭独立悬浮窗快捷键'
      : platform === 'darwin'
        ? `已启用独立悬浮窗快捷键 ${sc.display}（${scopeLabel}），可一键打开或关闭右侧置顶小窗`
        : `已保存独立悬浮窗快捷键 ${sc.display}（焦点位于看板内时可一键关闭或切换）`;
    return {
      ...(nextStatus || fresh),
      ...fresh,
      ok: true,
      shortcut: sc,
      auxShortcut: auxSc,
      message
    };
  }

  if (action === 'set-aux-shortcut') {
    const saved = setAuxShortcutConfig(options, platform);
    if (!saved.ok) {
      return {
        ...getFloatWindowStatus(platform),
        ok: false,
        error: saved.error,
        auxShortcut: saved.auxShortcut
      };
    }
    const auxSc = saved.auxShortcut;
    const sc = getShortcutConfig(platform);
    let nextStatus = null;
    if (platform === 'darwin') {
      if (current) {
        nextStatus = await sendCmdFn(current, {
          cmd: 'setAuxShortcut',
          enabled: auxSc.enabled,
          accelerator: auxSc.accelerator,
          display: auxSc.display,
          scope: auxSc.scope,
          keyCode: auxSc.macCarbon?.keyCode ?? -1,
          modifiers: auxSc.macCarbon?.modifiers ?? 0
        });
      } else if (auxSc.enabled || sc.enabled) {
        nextStatus = await spawnFn({
          pinned: upgradedFrom ? upgradedFrom.prevPinned : true,
          menubarEnabled: getMenubarPreference(),
          hiddenWindow: true,
          menubarMode: upgradedFrom ? upgradedFrom.prevMode : getMenubarMode()
        });
      }
    }
    const fresh = getFloatWindowStatus(platform);
    const scopeLabel = auxSc.scope === 'global' ? '全局生效' : '仅宿主前台生效';
    const ctrlHint = (platform === 'darwin' && /^Ctrl\+[A-Z]$/.test(auxSc.accelerator || ''))
      ? '（若与宿主编辑器快捷键冲突，可改用 ⌃⌥ 或 ⌥⌘ 组合）'
      : '';
    const message = !auxSc.enabled
      ? '已关闭 AGY 右侧辅助栏看板快捷键'
      : platform === 'darwin'
        ? `已启用 AGY 侧栏看板快捷键 ${auxSc.display}（${scopeLabel}），可一键打开或切换右侧辅助栏「上下文看板」${ctrlHint}`
        : `已保存 AGY 侧栏看板快捷键 ${auxSc.display}（焦点位于看板内时可直接切换）`;
    return {
      ...(nextStatus || fresh),
      ...fresh,
      ok: true,
      auxShortcut: auxSc,
      shortcut: sc,
      message
    };
  }

  if (action === 'set-recording') {
    if (platform === 'darwin' && current) {
      await sendCmdFn(current, {
        cmd: 'setRecording',
        recording: Boolean(options.recording)
      }).catch(() => {});
    }
    return {
      ...getFloatWindowStatus(platform),
      ok: true
    };
  }

  if (action === 'set-menubar-mode') {
    if (platform !== 'darwin') {
      return {
        ...getFloatWindowStatus(platform),
        ok: false,
        error: '顶部系统菜单栏常驻图标仅支持 macOS 系统'
      };
    }
    const validMode = setMenubarMode(options.menubarMode);
    if (!getMenubarPreference()) {
      setMenubarPreference(true);
    }
    let nextStatus;
    if (current) {
      nextStatus = await sendCmdFn(current, {
        cmd: 'setMenubarMode',
        mode: validMode,
        enableMenubar: true
      });
    } else {
      nextStatus = await spawnFn({
        pinned: upgradedFrom ? upgradedFrom.prevPinned : true,
        menubarEnabled: true,
        hiddenWindow: true,
        menubarMode: validMode
      });
    }
    const fresh = getFloatWindowStatus(platform);
    if (!fresh.daemonRunning) {
      return {
        ...fresh,
        ok: false,
        menubarEnabled: true,
        menubarMode: validMode,
        error: diagnoseMacMenubarFailure()
      };
    }
    return {
      ...(nextStatus || fresh),
      ...fresh,
      ok: true,
      menubarEnabled: true,
      menubarMode: validMode,
      message: `顶部菜单栏已切换为「${MENUBAR_MODE_LABELS[validMode] || validMode}」${fresh.statusTitle ? `（当前显示：${fresh.statusTitle}）` : ''}`
    };
  }

  if (action === 'set-menubar') {
    if (platform !== 'darwin') {
      return {
        ...getFloatWindowStatus(platform),
        ok: false,
        error: '顶部系统菜单栏常驻图标仅支持 macOS 系统（当前平台可使用 📌 独立悬浮小窗）'
      };
    }
    const curPref = getMenubarPreference();
    const wantEnabled = typeof options.menubarEnabled === 'boolean'
      ? options.menubarEnabled
      : !curPref;
    setMenubarPreference(wantEnabled);
    const curMode = options.menubarMode ? setMenubarMode(options.menubarMode) : getMenubarMode();

    let nextStatus;
    if (current) {
      nextStatus = await sendCmdFn(current, { cmd: 'setMenubar', enabled: wantEnabled, mode: curMode });
    } else if (wantEnabled) {
      nextStatus = await spawnFn({
        pinned: upgradedFrom ? upgradedFrom.prevPinned : true,
        menubarEnabled: true,
        hiddenWindow: true,
        menubarMode: curMode
      });
    } else {
      nextStatus = getFloatWindowStatus(platform);
    }

    const fresh = getFloatWindowStatus(platform);
    if (wantEnabled && !fresh.daemonRunning) {
      return {
        ...fresh,
        ok: false,
        menubarEnabled: wantEnabled,
        menubarMode: curMode,
        error: diagnoseMacMenubarFailure()
      };
    }
    const sc = getShortcutConfig(platform);
    return {
      ...(nextStatus || fresh),
      ...fresh,
      ok: true,
      menubarEnabled: wantEnabled,
      menubarMode: curMode,
      message: wantEnabled
        ? `已开启顶部菜单栏常驻图标（${MENUBAR_MODE_LABELS[curMode]}${fresh.statusTitle ? `：${fresh.statusTitle}` : ''}），单击可秒开或收回看板`
        : sc.enabled
          ? `已关闭顶部菜单栏常驻图标（快捷键 ${sc.display} 与 📌 右侧置顶小窗仍随时可用）`
          : '已关闭顶部菜单栏常驻图标（仍可随时使用 📌 右侧置顶小窗）'
    };
  }

  const curVisible = Boolean(current?.windowVisible ?? current?.running);
  const shouldClose = action === 'close' || (action === 'toggle' && curVisible);

  if (shouldClose) {
    if (!current) {
      return {
        ...getFloatWindowStatus(platform),
        closed: true,
        message: '右侧独立看板当前已处于关闭状态'
      };
    }
    const sc = getShortcutConfig(platform);
    const auxSc = getAuxShortcutConfig(platform);
    const keepResident = Boolean(
      current.menubarEnabled ||
      (current.shortcutEnabled ?? sc.enabled) ||
      (current.auxShortcutEnabled ?? auxSc.enabled)
    );
    if (keepResident && current.mode === 'native-macos') {
      const st = await sendCmdFn(current, { cmd: 'hideWindow' });
      const reopenHint = current.menubarEnabled && sc.enabled
        ? `按 ${sc.display} 或单击菜单栏 ◈ 图标可随时秒开`
        : sc.enabled
          ? `按 ${sc.display} 可随时秒开`
          : '顶部菜单栏 ◈ 图标仍常驻，单击可随时秒开';
      return {
        ...st,
        closed: true,
        message: `已收回右侧小窗（${reopenHint}）`
      };
    }
    await terminateFn(current.pid, { stateObj: current });
    return {
      ...getFloatWindowStatus(platform),
      closed: true,
      message: '已关闭右侧独立置顶看板'
    };
  }

  // Open or focus window
  if (current) {
    const cmdPayload = { cmd: 'showWindow' };
    if (typeof options.pinned === 'boolean') {
      cmdPayload.pinned = options.pinned;
    }
    const st = await sendCmdFn(current, cmdPayload);
    return {
      ...st,
      alreadyRunning: curVisible,
      message: st.pinned
        ? '已在屏幕右侧弹出独立置顶看板（点击右上角 ◈ 菜单栏图标或 📌 可随时收回）'
        : '已在屏幕右侧打开独立看板小窗'
    };
  }

  const wantMenubar = platform === 'darwin' ? getMenubarPreference() : false;
  const st = await spawnFn({
    pinned: typeof options.pinned === 'boolean'
      ? options.pinned
      : (upgradedFrom ? upgradedFrom.prevPinned : true),
    menubarEnabled: wantMenubar,
    hiddenWindow: false,
    menubarMode: upgradedFrom ? upgradedFrom.prevMode : getMenubarMode()
  });

  if (st) {
    return {
      ...st,
      message: st.pinned
        ? '已在屏幕右侧钉住独立看板（右上角菜单栏 ◈ 实时水位同步就绪，单击可随时显隐）'
        : '已在屏幕右侧打开独立看板小窗'
    };
  }

  return {
    ok: false,
    running: false,
    error: '启动独立悬浮窗口超时，请检查系统环境或重试。'
  };
}

// ---------------------------------------------------------------------------
// Daemon Implementation (Native macOS Menu Bar + WKWebView IPC + Fallback)
// ---------------------------------------------------------------------------

function buildBundledFloatHtml({ initialPinned, initialHidden, initialMenubar, initialMode = 'context', initialShortcut = null, initialAuxShortcut = null }) {
  let html = readFileSync(join(__dirname, 'index.html'), 'utf-8');
  const css = readFileSync(join(__dirname, 'styles.css'), 'utf-8').replace(/<\/style/gi, '<\\/style');
  const js = readFileSync(join(__dirname, 'app.js'), 'utf-8').replace(/<\/script/gi, '<\\/script');

  // Remove host preload script tag so WKWebView runs 100% offline in-memory
  html = html.replace(/<script\s+src="\/preload\.js"><\/script>/i, '');
  html = html.replace(
    /<link\s+rel="stylesheet"\s+href="\/styles\.css[^"]*">/i,
    () => `<style id="cv-inline-styles">\n${css}\n</style>`
  );

  const bridgeScript = `
<script>
(() => {
  window.__CV_FLOAT_MODE__ = true;
  window.__CV_FLOAT_PINNED__ = ${initialPinned ? 'true' : 'false'};
  window.__CV_INITIAL_HIDDEN__ = ${initialHidden ? 'true' : 'false'};
  window.__CV_MENUBAR_ENABLED__ = ${initialMenubar ? 'true' : 'false'};
  window.__CV_MENUBAR_MODE__ = ${JSON.stringify(initialMode || 'context')};
  window.__CV_SHORTCUT_INIT__ = ${JSON.stringify(initialShortcut || null)};
  window.__CV_AUX_SHORTCUT_INIT__ = ${JSON.stringify(initialAuxShortcut || null)};
  let seq = 1;
  const pending = new Map();

  window.__cvResolveRpc = (id, status, payload) => {
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
    isFloatWindow: true,
    getWorkspaceUris: async () => [],
    onWorkspaceChange: () => () => {},
    setPinned: (pinned) => {
      window.__CV_FLOAT_PINNED__ = Boolean(pinned);
      window.webkit?.messageHandlers?.cvBridge?.postMessage(
        JSON.stringify({ kind: "togglePin", pinned: Boolean(pinned) })
      );
    },
    setShortcutRecording: (recording) => {
      window.webkit?.messageHandlers?.cvBridge?.postMessage(
        JSON.stringify({ kind: "setShortcutRecording", recording: Boolean(recording) })
      );
    },
    closeFloatWindow: () => {
      window.webkit?.messageHandlers?.cvBridge?.postMessage(
        JSON.stringify({ kind: "closeWindow" })
      );
    },
    fetch: (path, opts = {}) => new Promise((resolve, reject) => {
      const id = seq++;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error("IPC request timeout"));
        }
      }, 15000);
      pending.set(id, {
        resolve: (res) => { clearTimeout(timer); resolve(res); },
        reject: (err) => { clearTimeout(timer); reject(err); }
      });
      window.webkit.messageHandlers.cvBridge.postMessage(JSON.stringify({
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

function fmtCompactTok(n) {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return `${Math.round(v)}`;
}

function fmtCompactDur(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(Number(sec))) return null;
  const s = Number(sec);
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const rem = Math.round(s - m * 60);
    return rem > 0 ? `${m}m${rem}s` : `${m}m`;
  }
  if (s < 10) return `${s.toFixed(1)}s`;
  return `${Math.round(s)}s`;
}

function fmtCompactTps(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
  const n = Number(v);
  return n < 10 ? n.toFixed(1) : String(Math.round(n));
}

function fmtQuotaWindowAndCountdown(resetTime) {
  if (!resetTime) return { winTag: '额度', countdown: '' };
  const ms = new Date(resetTime).getTime() - Date.now();
  if (!Number.isFinite(ms)) return { winTag: '额度', countdown: '' };
  const winTag = ms > 24 * 3600 * 1000 ? 'Week' : '5h';
  if (ms <= 0) return { winTag, countdown: '即将重置' };
  const totalMin = Math.max(1, Math.round(ms / 60000));
  if (ms > 24 * 3600 * 1000) {
    const d = Math.floor(totalMin / 1440);
    const h = Math.floor((totalMin % 1440) / 60);
    return { winTag, countdown: h > 0 ? `${d}d${h}h` : `${d}d` };
  }
  if (totalMin >= 60) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return { winTag, countdown: `${h}h${String(m).padStart(2, '0')}m` };
  }
  return { winTag, countdown: `${totalMin}m` };
}

function truncateDisplayCols(str, maxCols = 24) {
  const s = String(str || '').trim();
  let cols = 0;
  for (const ch of s) {
    cols += (ch.codePointAt(0) || 0) > 0x2e7f ? 2 : 1;
  }
  if (cols <= maxCols) return s;
  let out = '';
  let cur = 0;
  for (const ch of s) {
    const w = (ch.codePointAt(0) || 0) > 0x2e7f ? 2 : 1;
    if (cur + w > maxCols - 1) break;
    out += ch;
    cur += w;
  }
  return `${out.trimEnd()}…`;
}

function cleanTooltipConvTitle(rawTitle, fallbackId = '') {
  const base = String(rawTitle || '').trim();
  if (!base) return fallbackId ? `会话 ${fallbackId.slice(0, 8)}` : '当前对话';
  const shortened = base
    .replace(/https?:\/\/(?:www\.)?[^/\s]+\/([^\s]+)/gi, (_, tail) => {
      const segs = tail.split('/').filter(Boolean);
      return segs.length ? segs[segs.length - 1] : '';
    })
    .replace(/https?:\/\/[^\s]+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateDisplayCols(shortened || base, 24);
}

function cleanTooltipModel(rawModel) {
  const s = String(rawModel || '').trim();
  if (!s) return '待首轮请求';
  return truncateDisplayCols(
    s.replace(/\s*\(([^()]+)\)\s*$/, ' · $1').replace(/\s+/g, ' '),
    28
  );
}

function summarizePoolShortLabel(pool) {
  if (pool?.shortLabel) {
    return truncateDisplayCols(String(pool.shortLabel), 14);
  }
  const fams = Array.isArray(pool?.families) ? pool.families.filter(Boolean) : [];
  if (fams.length === 1 && fams[0].length <= 15) {
    return fams[0];
  }
  const brands = [];
  for (const f of fams) {
    let b = String(f).trim();
    if (/^gemini\b/i.test(b)) b = 'Gemini';
    else if (/^claude\b/i.test(b)) b = 'Claude';
    else if (/^gpt\b/i.test(b)) b = 'GPT';
    else b = b.split(/[\s/-]+/)[0] || b;
    if (b && !brands.includes(b)) brands.push(b);
  }
  if (brands.length === 1) return `${brands[0]} 系列`;
  if (brands.length >= 2) return brands.slice(0, 2).join(' / ');
  const fallback = String(pool?.title || '配额池').replace(/\s*配额池$/, '').trim();
  return truncateDisplayCols(fallback || '配额池', 14);
}

export function formatStatusItemFromSnapshot(snap, rawMode = 'context') {
  const mode = MENUBAR_MODES.includes(rawMode) ? rawMode : 'context';
  const cx = snap?.context;
  const spd = snap?.speed;
  const hasConv = Boolean(snap?.ok && snap.conversationId);
  const isKnownNum = (v) => typeof v === 'number' && Number.isFinite(v);

  let title = mode === 'speed' ? '⚡ --t/s' : mode === 'quota' ? '⏳ 额度 --%' : '◈ --%';

  if (mode === 'context') {
    if (hasConv && cx) {
      if (isKnownNum(cx.percent)) {
        const pct = Math.max(0, Math.min(999, Math.round(cx.percent)));
        const prefix = pct >= 90 ? '⚠ ' : '◈ ';
        title = `${prefix}${pct}%`;
      } else if (isKnownNum(cx.used) && cx.used > 0) {
        title = `◈ ${fmtCompactTok(cx.used)}`;
      } else {
        title = '◈ 0%';
      }
    }
  } else if (mode === 'speed') {
    const latestTps = fmtCompactTps(spd?.tps ?? spd?.streamingTps ?? null);
    const durStr = fmtCompactDur(spd?.duration);
    const avgStr = fmtCompactTps(spd?.avgTps);
    const peakStr = fmtCompactTps(spd?.peakTps);
    if (hasConv && latestTps !== null) {
      const mainPart = durStr ? `${latestTps}t/s·${durStr}` : `${latestTps}t/s`;
      const subPart = (avgStr !== null && peakStr !== null) ? ` (均${avgStr}/峰${peakStr})` : '';
      title = `⚡ ${mainPart}${subPart}`;
    } else if (hasConv && durStr !== null) {
      title = `⚡ ${durStr}`;
    }
  } else if (mode === 'quota') {
    const q = cx?.quota || (Array.isArray(snap?.quotas) && snap.quotas.length ? snap.quotas[0] : null);
    const hasFiveHourObj = Boolean(q?.fiveHour);
    const p5 = isKnownNum(q?.fiveHour?.remainingPercent)
      ? q.fiveHour.remainingPercent
      : (!hasFiveHourObj && isKnownNum(q?.remainingPercent) ? q.remainingPercent : null);
    const pBase = hasFiveHourObj && p5 === null
      ? (isKnownNum(q?.baseRemainingPercent)
          ? q.baseRemainingPercent
          : (isKnownNum(q?.remainingPercent) ? q.remainingPercent : null))
      : null;
    const pW = isKnownNum(q?.weekly?.remainingPercent) ? q.weekly.remainingPercent : null;
    if (p5 !== null && pW !== null) {
      const r5 = Math.max(0, Math.min(100, Math.round(p5)));
      const rW = Math.max(0, Math.min(100, Math.round(pW)));
      const icon = Math.min(r5, rW) <= 15 ? '⚠ ' : '⏳ ';
      title = `${icon}5h ${r5}%·周${rW}%`;
    } else if (pBase !== null && pW !== null) {
      const rB = Math.max(0, Math.min(100, Math.round(pBase)));
      const rW = Math.max(0, Math.min(100, Math.round(pW)));
      const icon = Math.min(rB, rW) <= 15 ? '⚠ ' : '⏳ ';
      title = `${icon}基础 ${rB}%·周${rW}%`;
    } else if (p5 !== null) {
      const remPct = Math.max(0, Math.min(100, Math.round(p5)));
      const { winTag, countdown } = fmtQuotaWindowAndCountdown(q.fiveHour?.resetTime || q.resetTime);
      const tag = q.fiveHour ? '5h' : winTag;
      const icon = remPct <= 15 ? '⚠ ' : '⏳ ';
      title = countdown ? `${icon}${tag} ${remPct}%·${countdown}` : `${icon}${tag} ${remPct}%`;
    } else if (pBase !== null) {
      const remPct = Math.max(0, Math.min(100, Math.round(pBase)));
      const { countdown } = fmtQuotaWindowAndCountdown(q.fiveHour?.resetTime || q.baseResetTime || q.resetTime);
      const icon = remPct <= 15 ? '⚠ ' : '⏳ ';
      title = countdown ? `${icon}基础 ${remPct}%·${countdown}` : `${icon}基础 ${remPct}%`;
    } else if (pW !== null) {
      const remPct = Math.max(0, Math.min(100, Math.round(pW)));
      const { countdown } = fmtQuotaWindowAndCountdown(q.weekly?.resetTime);
      const icon = remPct <= 15 ? '⚠ ' : '⏳ ';
      title = countdown ? `${icon}Week ${remPct}%·${countdown}` : `${icon}Week ${remPct}%`;
    }
  }

  // Structured multi-block tooltip: every line stays <= 36 display cols to avoid awkward wrapping
  const sections = [];

  if (hasConv) {
    const convShort = cleanTooltipConvTitle(snap.conversationTitle, snap.conversationId);
    const modelShort = cleanTooltipModel(cx?.model);
    sections.push([`会话：${convShort}`, `模型：${modelShort}`].join('\n'));

    const metricLines = [];
    if (cx && isKnownNum(cx.percent) && Number(cx.budget) > 0) {
      const limNum = Number(cx.budget);
      const limStr = limNum >= 1_000_000 ? `${(limNum / 1_000_000).toFixed(0)}M` : `${Math.round(limNum / 1_000)}K`;
      metricLines.push(`上下文：${Math.round(cx.percent)}%（${fmtCompactTok(cx.used)} / ${limStr}）`);
    } else if (cx && isKnownNum(cx.used)) {
      metricLines.push(`上下文：已用 ${fmtCompactTok(cx.used)}（上限未知）`);
    } else {
      metricLines.push('上下文：0%（新会话待首轮请求）');
    }

    if (spd && (spd.tps != null || spd.duration != null)) {
      const dLbl = fmtCompactDur(spd.duration) || '--';
      metricLines.push(`速度：${spd.tps ?? '--'} tok/s · 耗时 ${dLbl}`);
      if (spd.avgTps != null || spd.peakTps != null) {
        metricLines.push(`统计：均值 ${spd.avgTps ?? '--'} · 峰值 ${spd.peakTps ?? '--'} tok/s`);
      }
    }
    sections.push(metricLines.join('\n'));
  } else {
    sections.push('上下文与 Token 看板');
  }

  const quotaLines = [];
  const qs = snap?.quotaStatus;
  if (qs?.stale) {
    quotaLines.push('同步：语言服务离线（展示缓存）');
  } else if (qs?.summaryStale) {
    quotaLines.push('同步：多窗口配额摘要暂不可用');
  } else if (qs?.state === 'error') {
    quotaLines.push('同步：语言服务请求失败');
  }

  const formatPoolLine = (poolName, obj) => {
    const hasFiveHourObj = Boolean(obj?.fiveHour);
    const p5 = isKnownNum(obj?.fiveHour?.remainingPercent)
      ? obj.fiveHour.remainingPercent
      : (!hasFiveHourObj && isKnownNum(obj?.remainingPercent) ? obj.remainingPercent : null);
    const pBase = hasFiveHourObj && p5 === null
      ? (isKnownNum(obj?.baseRemainingPercent)
          ? obj.baseRemainingPercent
          : (isKnownNum(obj?.remainingPercent) ? obj.remainingPercent : null))
      : null;
    const pW = isKnownNum(obj?.weekly?.remainingPercent) ? obj.weekly.remainingPercent : null;
    if (p5 !== null && pW !== null) {
      return `${poolName}：5h ${p5}% · 周 ${pW}%`;
    }
    if (pBase !== null && pW !== null) {
      return `${truncateDisplayCols(poolName, 12)}：基础 ${pBase}% · 周 ${pW}%`;
    }
    if (p5 !== null) {
      const { winTag, countdown } = fmtQuotaWindowAndCountdown(obj.fiveHour?.resetTime || obj.resetTime);
      const tag = obj.fiveHour ? '5h' : winTag;
      const rst = countdown ? ` · ${countdown} 重置` : '';
      return `${poolName} (${tag})：${p5}%${rst}`;
    }
    if (pBase !== null) {
      const { countdown } = fmtQuotaWindowAndCountdown(obj.fiveHour?.resetTime || obj.baseResetTime || obj.resetTime);
      const rst = countdown ? `·5h ${countdown}重置` : '';
      return `${truncateDisplayCols(poolName, 12)}：基础 ${pBase}%${rst}`;
    }
    if (pW !== null) {
      const { countdown } = fmtQuotaWindowAndCountdown(obj.weekly?.resetTime);
      const rst = countdown ? ` · ${countdown} 重置` : '';
      return `${poolName} (Week)：${pW}%${rst}`;
    }
    const { countdown } = fmtQuotaWindowAndCountdown(obj?.fiveHour?.resetTime || obj?.weekly?.resetTime || obj?.resetTime);
    const rst = countdown ? ` · ${countdown} 重置` : '';
    return `${poolName}：余量未知${rst}`;
  };

  const pools = Array.isArray(snap?.quotas) ? snap.quotas : [];
  if (pools.length) {
    for (const pool of pools.slice(0, 3)) {
      quotaLines.push(formatPoolLine(summarizePoolShortLabel(pool), pool));
    }
  } else if (cx?.quota) {
    const qName = truncateDisplayCols(cx.quota.label || '当前配额', 14);
    quotaLines.push(formatPoolLine(qName, cx.quota));
  }
  if (quotaLines.length) {
    sections.push(quotaLines.join('\n'));
  }

  sections.push('左键显隐看板 · 右键切换模式与置顶');
  return { title, tooltip: sections.join('\n\n') };
}

async function dispatchApiRpc(rawPath, method, rawBody, currentState, hooks = {}) {
  const u = new URL(rawPath, 'http://127.0.0.1');
  const data = Object.fromEntries(u.searchParams.entries());
  if (rawBody && method === 'POST') {
    try {
      Object.assign(data, typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody);
    } catch {}
  }

  if (u.pathname === '/api/context' && method === 'GET') {
    const convId = data.conversationId || '';
    const force = data.force === '1' || data.force === 'true' || data.force === true;
    const snap = await scanConversation(convId, { force });
    if (hooks.onActiveContextSnap && (!convId || convId === currentState.pinnedConvId)) {
      hooks.onActiveContextSnap(snap);
    }
    if (!force && data.etag && snap.etag && data.etag === snap.etag) {
      return {
        ok: true,
        unchanged: true,
        etag: snap.etag,
        conversationId: snap.conversationId,
        recentConversations: snap.recentConversations
      };
    }
    return snap;
  }

  if (u.pathname === '/api/history' && method === 'GET') {
    const force = data.force === '1' || data.force === 'true' || data.force === true;
    const hist = await collectTokenHistory({ force });
    if (!force && data.etag && hist.etag && data.etag === hist.etag) {
      return { ok: true, unchanged: true, etag: hist.etag };
    }
    return hist;
  }

  if (u.pathname === '/api/settings' && method === 'GET') {
    return getSettings();
  }
  if (u.pathname === '/api/settings' && method === 'POST') {
    return saveSettings(data);
  }
  if (u.pathname === '/api/launch-cli' && method === 'POST') {
    return launchCliTerminal(data);
  }
  if (u.pathname === '/api/aux-pane-trigger' && method === 'GET') {
    const since = Number(data.since || 0);
    const waitMs = Number(data.waitMs ?? data.timeoutMs ?? 8000);
    return waitForAuxPaneTrigger({ since, timeoutMs: waitMs });
  }
  if (u.pathname === '/api/aux-pane-trigger' && method === 'POST') {
    if (data.action === 'opening') {
      return markAuxPaneOpening({ seq: Number(data.seq || 0) });
    }
    if (data.action === 'ack') {
      return ackAuxPaneTrigger({
        seq: Number(data.seq || 0),
        plugin: String(data.plugin || 'context-viewer')
      });
    }
    if (data.action === 'switched') {
      return markAuxPaneSwitched({ seq: Number(data.seq || 0) });
    }
    if (data.action === 'hello') {
      return recordAuxActiveConversation({ convId: String(data.convId || '') });
    }
    const trigger = writeAuxPaneTrigger({
      targetPlugin: String(data.targetPlugin || 'context-viewer'),
      uri: String(data.uri || 'sidecar://context-viewer/dashboard/'),
      action: String(data.action || 'toggle'),
      convId: typeof data.convId === 'string' ? data.convId : '',
      revealPath: typeof data.revealPath === 'string' ? data.revealPath : ''
    });
    if (trigger?.ok === false || !trigger?.seq) {
      return { ok: false, lockBusy: true, error: '共享触发锁繁忙，请稍后重试', trigger };
    }
    return { ok: true, trigger };
  }
  if (u.pathname === '/api/float-window') {
    const shortcut = getShortcutConfig();
    const auxShortcut = getAuxShortcutConfig();
    return {
      ok: true,
      daemonRunning: true,
      running: Boolean(currentState.windowVisible),
      windowVisible: Boolean(currentState.windowVisible),
      pinned: Boolean(currentState.pinned),
      menubarEnabled: Boolean(currentState.menubarEnabled),
      menubarMode: currentState.menubarMode || getMenubarMode(),
      shortcutEnabled: Boolean(currentState.shortcutEnabled ?? shortcut.enabled),
      shortcut,
      auxShortcutEnabled: Boolean(currentState.auxShortcutEnabled ?? auxShortcut.enabled),
      auxShortcut,
      mode: currentState.mode
    };
  }
  if (u.pathname === '/api/entrypoints' && method === 'GET') {
    const shortcut = getShortcutConfig();
    const auxShortcut = getAuxShortcutConfig();
    return {
      ...getSidebarEntryStatus(),
      menubarEnabled: Boolean(currentState.menubarEnabled),
      menubarMode: currentState.menubarMode || getMenubarMode(),
      menubarSupported: process.platform === 'darwin',
      shortcut,
      auxShortcut,
      floatWindow: {
        ok: true,
        daemonRunning: true,
        running: Boolean(currentState.windowVisible),
        windowVisible: Boolean(currentState.windowVisible),
        pinned: Boolean(currentState.pinned),
        menubarEnabled: Boolean(currentState.menubarEnabled),
        menubarMode: currentState.menubarMode || getMenubarMode(),
        shortcutEnabled: Boolean(currentState.shortcutEnabled ?? shortcut.enabled),
        shortcut,
        auxShortcutEnabled: Boolean(currentState.auxShortcutEnabled ?? auxShortcut.enabled),
        auxShortcut,
        mode: currentState.mode
      }
    };
  }
  if (u.pathname === '/api/entrypoints' && method === 'POST') {
    if (data.target === 'shortcut-recording' || typeof data.recording === 'boolean') {
      hooks.onSetRecording?.(Boolean(data.recording));
      return {
        ...getSidebarEntryStatus(),
        ok: true
      };
    }
    const isAuxShortcutUpdate = (
      data.target === 'aux-shortcut' ||
      data.auxShortcutReset === true ||
      data.auxAccelerator !== undefined ||
      data.auxShortcutAccelerator !== undefined ||
      typeof data.auxShortcutEnabled === 'boolean'
    );
    const isShortcutUpdate = !isAuxShortcutUpdate && (
      data.target === 'shortcut' ||
      data.shortcutReset === true ||
      data.reset === true ||
      data.accelerator !== undefined ||
      data.shortcutAccelerator !== undefined ||
      typeof data.shortcutEnabled === 'boolean' ||
      data.shortcutScope !== undefined ||
      data.scope !== undefined
    );
    const hasSessionHint = typeof data.pinnedConvId === 'string' || typeof data.activeHostConvId === 'string';
    if (hasSessionHint) {
      updateActiveSessionHint({
        pinnedConvId: typeof data.pinnedConvId === 'string' ? data.pinnedConvId : undefined,
        userFocusedConvId: typeof data.activeHostConvId === 'string' ? data.activeHostConvId : undefined,
        userFocusedAt: data.activeHostConvId ? Date.now() : undefined
      });
      if (typeof data.pinnedConvId === 'string') {
        currentState.pinnedConvId = data.pinnedConvId;
      }
      hooks.onRefreshMenubar?.();
      if (
        !isShortcutUpdate &&
        !isAuxShortcutUpdate &&
        typeof data.menubarEnabled !== 'boolean' &&
        typeof data.menubarMode !== 'string' &&
        typeof data.sidebarEnabled !== 'boolean' &&
        !data.target
      ) {
        return {
          ...getSidebarEntryStatus(),
          menubarEnabled: Boolean(currentState.menubarEnabled),
          menubarMode: currentState.menubarMode || getMenubarMode(),
          menubarSupported: process.platform === 'darwin'
        };
      }
    }
    if (isAuxShortcutUpdate) {
      if (hooks.onSetAuxShortcut) {
        return hooks.onSetAuxShortcut(data);
      }
      const saved = setAuxShortcutConfig(data);
      if (!saved.ok) {
        return { ...getSidebarEntryStatus(), ok: false, error: saved.error, auxShortcut: saved.auxShortcut };
      }
      const auxSc = saved.auxShortcut;
      const scopeLabel = auxSc.scope === 'global' ? '全局生效' : '仅宿主前台生效';
      const ctrlHint = (process.platform === 'darwin' && /^Ctrl\+[A-Z]$/.test(auxSc.accelerator || ''))
        ? '（若与宿主编辑器快捷键冲突，可改用 ⌃⌥ 或 ⌥⌘ 组合）'
        : '';
      return {
        ...getSidebarEntryStatus(),
        ok: true,
        auxShortcut: auxSc,
        message: !auxSc.enabled
          ? '已关闭 AGY 右侧辅助栏看板快捷键'
          : process.platform === 'darwin'
            ? `已启用 AGY 侧栏看板快捷键 ${auxSc.display}（${scopeLabel}），可一键打开或切换右侧辅助栏「上下文看板」${ctrlHint}`
            : `已保存 AGY 侧栏看板快捷键 ${auxSc.display}（焦点位于看板内时可直接切换）`
      };
    }
    if (isShortcutUpdate) {
      if (hooks.onSetShortcut) {
        return hooks.onSetShortcut(data);
      }
      const saved = setShortcutConfig(data);
      if (!saved.ok) {
        return { ...getSidebarEntryStatus(), ok: false, error: saved.error, shortcut: saved.shortcut };
      }
      const sc = saved.shortcut;
      const scopeLabel = sc.scope === 'global' ? '全局生效' : '仅宿主前台生效';
      return {
        ...getSidebarEntryStatus(),
        ok: true,
        shortcut: sc,
        message: !sc.enabled
          ? '已关闭独立悬浮窗快捷键'
          : process.platform === 'darwin'
            ? `已启用独立悬浮窗快捷键 ${sc.display}（${scopeLabel}），可一键打开或关闭右侧置顶小窗`
            : `已保存独立悬浮窗快捷键 ${sc.display}（焦点位于看板内时可一键关闭或切换）`
      };
    }
    if (typeof data.menubarMode === 'string' && hooks.onSetMenubarMode) {
      return hooks.onSetMenubarMode(data.menubarMode);
    }
    if (typeof data.menubarEnabled === 'boolean' && hooks.onSetMenubar) {
      return hooks.onSetMenubar(Boolean(data.menubarEnabled));
    }
    if (typeof data.sidebarEnabled === 'boolean') {
      return setSidebarEntrypoint(data.sidebarEnabled);
    }
    if (hooks.onSetMenubar) {
      return hooks.onSetMenubar(!currentState.menubarEnabled);
    }
    return getSidebarEntryStatus();
  }

  const notFoundErr = new Error(`Unknown route: ${method} ${u.pathname}`);
  notFoundErr.status = 404;
  throw notFoundErr;
}

function ensureCompiledMacBinary() {
  const errPath = join(getPluginStateDir(), 'last_swiftc_error.txt');
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/swiftc')) {
    return null;
  }
  const swiftSrc = join(__dirname, 'native_float_macos.swift');
  if (!existsSync(swiftSrc)) return null;

  const srcHash = createHash('sha256').update(readFileSync(swiftSrc)).digest('hex').slice(0, 10);
  const binDir = join(getPluginStateDir(), 'bin');
  mkdirSync(binDir, { recursive: true });
  const binPath = join(binDir, `cv-float-macos-${srcHash}`);

  if (existsSync(binPath)) {
    try { rmSync(errPath, { force: true }); } catch {}
    return binPath;
  }

  try {
    execFileSync('/usr/bin/swiftc', [swiftSrc, '-o', binPath], {
      stdio: 'pipe',
      timeout: 30000
    });
    try { rmSync(errPath, { force: true }); } catch {}
    return binPath;
  } catch (err) {
    try {
      const stderrText = String(err?.stderr || err?.message || '').split('\n').filter(Boolean).slice(0, 2).join(' ').slice(0, 240);
      writeFileSync(errPath, stderrText || 'swiftc compilation failed', 'utf-8');
    } catch {}
    return null;
  }
}

async function startMacNativeDaemon({ initialPinned, initialMenubar, initialVisible, initialMode = 'context' }) {
  const binPath = ensureCompiledMacBinary();
  if (!binPath) {
    if (!initialVisible) {
      process.exit(0);
    }
    return startFallbackAppWindowDaemon();
  }

  const resolvedMode = MENUBAR_MODES.includes(initialMode) ? initialMode : getMenubarMode();
  const initialSc = getShortcutConfig('darwin');
  const initialAuxSc = getAuxShortcutConfig('darwin');
  const state = {
    daemonVersion: DAEMON_VERSION,
    daemonBuildId: DAEMON_BUILD_ID,
    daemonRunning: true,
    running: initialVisible,
    windowVisible: initialVisible,
    pid: process.pid,
    pinned: initialPinned,
    menubarEnabled: initialMenubar,
    menubarMode: resolvedMode,
    shortcutEnabled: Boolean(initialSc.enabled),
    shortcutAccelerator: initialSc.accelerator,
    shortcutDisplay: initialSc.display,
    shortcutScope: initialSc.scope,
    auxShortcutEnabled: Boolean(initialAuxSc.enabled),
    auxShortcutAccelerator: initialAuxSc.accelerator,
    auxShortcutDisplay: initialAuxSc.display,
    statusTitle: resolvedMode === 'speed' ? '⚡ --t/s' : resolvedMode === 'quota' ? '⏳ 额度 --%' : '◈ --%',
    activeConvId: null,
    activeConvTitle: null,
    hasLsBridge: Boolean(process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN),
    lsAddress: process.env.ANTIGRAVITY_LS_ADDRESS || '',
    mode: 'native-macos',
    cmdSeq: 0,
    startedAt: new Date().toISOString()
  };

  const shouldKeepResident = () => Boolean(state.menubarEnabled || state.shortcutEnabled || state.auxShortcutEnabled);

  const args = ['--mode', resolvedMode];
  if (!initialPinned) args.push('--unpinned');
  if (!initialMenubar) args.push('--no-menubar');
  if (!initialVisible) args.push('--hidden-window');
  if (!initialSc.enabled) args.push('--no-shortcut');
  if (typeof initialSc.macCarbon?.keyCode === 'number') {
    args.push('--shortcut-keycode', String(initialSc.macCarbon.keyCode));
    args.push('--shortcut-mods', String(initialSc.macCarbon.modifiers || 0));
  }
  if (initialSc.display) {
    args.push('--shortcut-label', initialSc.display);
  }
  if (!initialAuxSc.enabled) args.push('--no-aux-shortcut');
  if (typeof initialAuxSc.macCarbon?.keyCode === 'number') {
    args.push('--aux-keycode', String(initialAuxSc.macCarbon.keyCode));
    args.push('--aux-mods', String(initialAuxSc.macCarbon.modifiers || 0));
  }
  if (initialAuxSc.display) {
    args.push('--aux-label', initialAuxSc.display);
  }
  args.push('--shortcut-scope', initialSc.scope || 'app');

  const child = spawn(binPath, args, { stdio: ['pipe', 'pipe', 'ignore'] });

  const sendToChild = (obj) => {
    if (child.stdin && !child.stdin.destroyed) {
      child.stdin.write(`${JSON.stringify(obj)}\n`);
    }
  };

  let lastSentTitle = '';
  let lastSentTip = '';
  let lastSentMode = '';
  let latestSnap = null;
  let barPolling = false;

  const applySnapToMenubar = (snap) => {
    if (snap?.ok) {
      latestSnap = snap;
      state.activeConvId = snap.conversationId || null;
      state.activeConvTitle = snap.conversationTitle || null;
    }
    if (!state.menubarEnabled) return;
    const curMode = state.menubarMode || 'context';
    const { title, tooltip } = formatStatusItemFromSnapshot(snap, curMode);
    if (title !== lastSentTitle || tooltip !== lastSentTip || curMode !== lastSentMode) {
      lastSentTitle = title;
      lastSentTip = tooltip;
      lastSentMode = curMode;
      state.statusTitle = title;
      sendToChild({ type: 'updateStatusItem', mode: curMode, title, tooltip });
      writeFloatState(state);
    }
  };

  const refreshMenubarStatusItem = async (forceScan = false) => {
    if (!state.menubarEnabled) return;
    if (barPolling && !forceScan) return;
    barPolling = true;
    try {
      const snap = await scanConversation('', { force: false });
      applySnapToMenubar(snap);
    } catch {} finally {
      barPolling = false;
    }
  };

  const barTimer = setInterval(() => {
    if (state.menubarEnabled) {
      refreshMenubarStatusItem(false).catch(() => {});
    }
  }, 1500);
  barTimer.unref?.();

  const shutdown = () => {
    clearInterval(barTimer);
    clearFloatStateIfOwned();
    sendToChild({ type: 'quit' });
    setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      process.exit(0);
    }, 120);
  };

  const handleSetMenubarInDaemon = async (wantEnabled) => {
    setMenubarPreference(wantEnabled);
    state.menubarEnabled = wantEnabled;
    if (!wantEnabled) {
      lastSentTitle = '';
      lastSentTip = '';
      lastSentMode = '';
    }
    sendToChild({ type: 'setMenubar', enabled: wantEnabled, mode: state.menubarMode });
    if (wantEnabled) {
      if (latestSnap) applySnapToMenubar(latestSnap);
      await refreshMenubarStatusItem(true);
    }
    writeFloatState(state);
    if (!shouldKeepResident() && !state.windowVisible) {
      setTimeout(shutdown, 80);
    }
    return {
      ...getSidebarEntryStatus(),
      ok: true,
      menubarEnabled: wantEnabled,
      menubarMode: state.menubarMode,
      menubarSupported: true,
      floatWindow: {
        ok: true,
        daemonRunning: true,
        running: Boolean(state.windowVisible),
        windowVisible: Boolean(state.windowVisible),
        pinned: Boolean(state.pinned),
        menubarEnabled: wantEnabled,
        menubarMode: state.menubarMode,
        shortcutEnabled: Boolean(state.shortcutEnabled),
        statusTitle: state.statusTitle,
        mode: state.mode
      },
      message: wantEnabled
        ? `已开启顶部菜单栏常驻图标（当前显示：${state.statusTitle}）`
        : state.shortcutEnabled
          ? `已关闭顶部菜单栏常驻图标（快捷键 ${state.shortcutDisplay || '⌥⌘K'} 仍可一键唤起）`
          : '已关闭顶部菜单栏常驻图标'
    };
  };

  const handleSetShortcutInDaemon = async (payload) => {
    const saved = setShortcutConfig(payload, 'darwin');
    if (!saved.ok) {
      return {
        ...getSidebarEntryStatus(),
        ok: false,
        error: saved.error,
        shortcut: saved.shortcut
      };
    }
    const sc = saved.shortcut;
    const auxSc = getAuxShortcutConfig('darwin');
    state.shortcutEnabled = Boolean(sc.enabled);
    state.shortcutAccelerator = sc.accelerator;
    state.shortcutDisplay = sc.display;
    state.shortcutScope = sc.scope;
    sendToChild({
      type: 'setShortcut',
      enabled: sc.enabled,
      accelerator: sc.accelerator,
      keyCode: sc.macCarbon?.keyCode ?? -1,
      modifiers: sc.macCarbon?.modifiers ?? 0,
      label: sc.display,
      scope: sc.scope
    });
    writeFloatState(state);
    if (!shouldKeepResident() && !state.windowVisible) {
      setTimeout(shutdown, 80);
    }
    const scopeLabel = sc.scope === 'global' ? '全局生效' : '仅宿主前台生效';
    return {
      ...getSidebarEntryStatus(),
      ok: true,
      shortcut: sc,
      auxShortcut: auxSc,
      floatWindow: {
        ok: true,
        daemonRunning: true,
        running: Boolean(state.windowVisible),
        windowVisible: Boolean(state.windowVisible),
        pinned: Boolean(state.pinned),
        menubarEnabled: Boolean(state.menubarEnabled),
        menubarMode: state.menubarMode,
        shortcutEnabled: Boolean(sc.enabled),
        shortcut: sc,
        auxShortcutEnabled: Boolean(auxSc.enabled),
        auxShortcut: auxSc,
        statusTitle: state.statusTitle,
        mode: state.mode
      },
      message: sc.enabled
        ? `已启用独立悬浮窗快捷键 ${sc.display}（${scopeLabel}），可一键打开或关闭右侧置顶小窗`
        : '已关闭独立悬浮窗快捷键'
    };
  };

  const handleSetAuxShortcutInDaemon = async (payload) => {
    const saved = setAuxShortcutConfig(payload, 'darwin');
    if (!saved.ok) {
      return {
        ...getSidebarEntryStatus(),
        ok: false,
        error: saved.error,
        auxShortcut: saved.auxShortcut
      };
    }
    const auxSc = saved.auxShortcut;
    const sc = getShortcutConfig('darwin');
    state.auxShortcutEnabled = Boolean(auxSc.enabled);
    state.auxShortcutAccelerator = auxSc.accelerator;
    state.auxShortcutDisplay = auxSc.display;
    state.shortcutScope = auxSc.scope;
    sendToChild({
      type: 'setAuxShortcut',
      enabled: auxSc.enabled,
      accelerator: auxSc.accelerator,
      keyCode: auxSc.macCarbon?.keyCode ?? -1,
      modifiers: auxSc.macCarbon?.modifiers ?? 0,
      label: auxSc.display,
      scope: auxSc.scope
    });
    writeFloatState(state);
    if (!shouldKeepResident() && !state.windowVisible) {
      setTimeout(shutdown, 80);
    }
    const scopeLabel = auxSc.scope === 'global' ? '全局生效' : '仅宿主前台生效';
    return {
      ...getSidebarEntryStatus(),
      ok: true,
      auxShortcut: auxSc,
      shortcut: sc,
      floatWindow: {
        ok: true,
        daemonRunning: true,
        running: Boolean(state.windowVisible),
        windowVisible: Boolean(state.windowVisible),
        pinned: Boolean(state.pinned),
        menubarEnabled: Boolean(state.menubarEnabled),
        menubarMode: state.menubarMode,
        shortcutEnabled: Boolean(sc.enabled),
        shortcut: sc,
        auxShortcutEnabled: Boolean(auxSc.enabled),
        auxShortcut: auxSc,
        statusTitle: state.statusTitle,
        mode: state.mode
      },
      message: auxSc.enabled
        ? `已启用 AGY 侧栏看板快捷键 ${auxSc.display}（${scopeLabel}），可一键打开或切换右侧辅助栏「上下文看板」${/^Ctrl\+[A-Z]$/.test(auxSc.accelerator || '') ? '（若与宿主编辑器快捷键冲突，可改用 ⌃⌥ 或 ⌥⌘ 组合）' : ''}`
        : '已关闭 AGY 右侧辅助栏看板快捷键'
    };
  };

  const handleSetMenubarModeInDaemon = async (rawMode) => {
    const validMode = setMenubarMode(rawMode);
    state.menubarMode = validMode;
    if (!state.menubarEnabled) {
      setMenubarPreference(true);
      state.menubarEnabled = true;
      sendToChild({ type: 'setMenubar', enabled: true, mode: validMode });
    } else {
      sendToChild({ type: 'setMenubarMode', mode: validMode });
    }
    lastSentTitle = '';
    lastSentMode = '';
    if (latestSnap) applySnapToMenubar(latestSnap);
    await refreshMenubarStatusItem(true);
    writeFloatState(state);
    return {
      ...getSidebarEntryStatus(),
      ok: true,
      menubarEnabled: true,
      menubarMode: validMode,
      menubarSupported: true,
      statusTitle: state.statusTitle,
      floatWindow: {
        ok: true,
        daemonRunning: true,
        running: Boolean(state.windowVisible),
        windowVisible: Boolean(state.windowVisible),
        pinned: Boolean(state.pinned),
        menubarEnabled: true,
        menubarMode: validMode,
        shortcutEnabled: Boolean(state.shortcutEnabled),
        statusTitle: state.statusTitle,
        mode: state.mode
      },
      message: `顶部菜单栏已切换为「${MENUBAR_MODE_LABELS[validMode] || validMode}」（当前显示：${state.statusTitle}）`
    };
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('exit', clearFloatStateIfOwned);

  process.on('SIGUSR1', () => {
    (async () => {
      let cmd = { seq: Date.now(), cmd: 'showWindow' };
      const cmdPath = getCmdFilePath();
      if (existsSync(cmdPath)) {
        try {
          cmd = JSON.parse(readFileSync(cmdPath, 'utf-8'));
        } catch {}
      }

      const action = String(cmd.cmd || 'showWindow');
      if (action === 'quit') {
        shutdown();
        return;
      }
      if (action === 'showWindow' || action === 'focus') {
        if (typeof cmd.pinned === 'boolean' && cmd.pinned !== state.pinned) {
          state.pinned = cmd.pinned;
          sendToChild({ type: 'setPinned', pinned: cmd.pinned });
        }
        state.windowVisible = true;
        state.running = true;
        sendToChild({ type: 'showWindow' });
      } else if (action === 'hideWindow') {
        if (shouldKeepResident()) {
          state.windowVisible = false;
          state.running = false;
          sendToChild({ type: 'hideWindow' });
        } else {
          shutdown();
          return;
        }
      } else if (action === 'toggleWindow') {
        if (state.windowVisible) {
          if (shouldKeepResident()) {
            state.windowVisible = false;
            state.running = false;
            sendToChild({ type: 'hideWindow' });
          } else {
            shutdown();
            return;
          }
        } else {
          state.windowVisible = true;
          state.running = true;
          sendToChild({ type: 'showWindow' });
        }
      } else if (action === 'setMenubar') {
        const en = Boolean(cmd.enabled);
        if (cmd.mode && MENUBAR_MODES.includes(cmd.mode)) {
          state.menubarMode = cmd.mode;
        }
        state.menubarEnabled = en;
        if (!en) {
          lastSentTitle = '';
          lastSentTip = '';
          lastSentMode = '';
        }
        if (!shouldKeepResident() && !state.windowVisible) {
          shutdown();
          return;
        }
        sendToChild({ type: 'setMenubar', enabled: en, mode: state.menubarMode });
        if (en) {
          if (latestSnap) applySnapToMenubar(latestSnap);
          await refreshMenubarStatusItem(true);
        }
      } else if (action === 'setShortcut') {
        const sc = getShortcutConfig('darwin');
        state.shortcutEnabled = typeof cmd.enabled === 'boolean' ? cmd.enabled : Boolean(sc.enabled);
        state.shortcutAccelerator = cmd.accelerator || sc.accelerator;
        state.shortcutDisplay = cmd.display || sc.display;
        state.shortcutScope = cmd.scope || sc.scope;
        if (!shouldKeepResident() && !state.windowVisible) {
          shutdown();
          return;
        }
        sendToChild({
          type: 'setShortcut',
          enabled: state.shortcutEnabled,
          accelerator: state.shortcutAccelerator,
          keyCode: typeof cmd.keyCode === 'number' ? cmd.keyCode : (sc.macCarbon?.keyCode ?? -1),
          modifiers: typeof cmd.modifiers === 'number' ? cmd.modifiers : (sc.macCarbon?.modifiers ?? 0),
          label: state.shortcutDisplay,
          scope: state.shortcutScope
        });
      } else if (action === 'setAuxShortcut') {
        const auxSc = getAuxShortcutConfig('darwin');
        state.auxShortcutEnabled = typeof cmd.enabled === 'boolean' ? cmd.enabled : Boolean(auxSc.enabled);
        state.auxShortcutAccelerator = cmd.accelerator || auxSc.accelerator;
        state.auxShortcutDisplay = cmd.display || auxSc.display;
        if (cmd.scope) state.shortcutScope = cmd.scope;
        if (!shouldKeepResident() && !state.windowVisible) {
          shutdown();
          return;
        }
        sendToChild({
          type: 'setAuxShortcut',
          enabled: state.auxShortcutEnabled,
          accelerator: state.auxShortcutAccelerator,
          keyCode: typeof cmd.keyCode === 'number' ? cmd.keyCode : (auxSc.macCarbon?.keyCode ?? -1),
          modifiers: typeof cmd.modifiers === 'number' ? cmd.modifiers : (auxSc.macCarbon?.modifiers ?? 0),
          label: state.auxShortcutDisplay,
          scope: state.shortcutScope
        });
      } else if (action === 'setMenubarMode') {
        const validMode = setMenubarMode(cmd.mode);
        state.menubarMode = validMode;
        if (cmd.enableMenubar && !state.menubarEnabled) {
          state.menubarEnabled = true;
          sendToChild({ type: 'setMenubar', enabled: true, mode: validMode });
        } else {
          sendToChild({ type: 'setMenubarMode', mode: validMode });
        }
        lastSentTitle = '';
        lastSentMode = '';
        if (latestSnap) applySnapToMenubar(latestSnap);
        await refreshMenubarStatusItem(true);
      } else if (action === 'refreshSession') {
        await refreshMenubarStatusItem(true);
      } else if (action === 'setPinned' && typeof cmd.pinned === 'boolean') {
        state.pinned = cmd.pinned;
        sendToChild({ type: 'setPinned', pinned: cmd.pinned });
      } else if (action === 'setRecording') {
        sendToChild({ type: 'setRecording', recording: Boolean(cmd.recording) });
      }

      state.cmdSeq = Number(cmd.seq || Date.now());
      writeFloatState(state);
    })().catch(() => {});
  });

  child.on('exit', () => {
    clearInterval(barTimer);
    clearFloatStateIfOwned();
    process.exit(0);
  });

  const rl = createInterface({ input: child.stdout });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    if (msg.type === 'ready') {
      state.pinned = Boolean(msg.pinned);
      state.menubarEnabled = Boolean(msg.menubarEnabled);
      if (msg.menubarMode && MENUBAR_MODES.includes(msg.menubarMode)) {
        state.menubarMode = msg.menubarMode;
      }
      if (typeof msg.shortcutEnabled === 'boolean') {
        state.shortcutEnabled = msg.shortcutEnabled;
      }
      if (typeof msg.auxShortcutEnabled === 'boolean') {
        state.auxShortcutEnabled = msg.auxShortcutEnabled;
      }
      state.windowVisible = Boolean(msg.windowVisible);
      state.running = state.windowVisible;
      writeFloatState(state);
      sendToChild({
        type: 'loadHtml',
        html: buildBundledFloatHtml({
          initialPinned: state.pinned,
          initialHidden: !state.windowVisible,
          initialMenubar: state.menubarEnabled,
          initialMode: state.menubarMode,
          initialShortcut: getShortcutConfig('darwin'),
          initialAuxShortcut: getAuxShortcutConfig('darwin')
        })
      });
      if (state.menubarEnabled) {
        refreshMenubarStatusItem(true).catch(() => {});
      }
    } else if (msg.type === 'auxHotkeyTriggered') {
      const trig = writeAuxPaneTrigger({
        targetPlugin: 'context-viewer',
        uri: 'sidecar://context-viewer/dashboard/',
        action: 'toggle'
      });
      if (trig?.ok === false || !trig?.seq) {
        return;
      }
      setTimeout(() => {
        const latest = readAuxPaneTrigger();
        if (Number(latest.ackSeq || 0) >= Number(trig.seq || 1)) return;
        const opened = Number(latest.openingSeq || 0) >= Number(trig.seq || 1);
        if (opened) {
          setTimeout(() => {
            const afterGrace = readAuxPaneTrigger();
            if (Number(afterGrace.ackSeq || 0) >= Number(trig.seq || 1)) return;
            sendToChild({
              type: 'showHud',
              text: '右侧栏已展开：请点开一次「上下文看板」（右键标签 Pin Tab 固定后，按快捷键即可自动开栏直达）'
            });
          }, 750).unref?.();
          return;
        }
        sendToChild({
          type: 'showHud',
          text: '首次使用请先在右侧 Overview → Extensions 点开一次「上下文看板」（右键 Pin Tab 后跨会话直接呼出）'
        });
      }, 720).unref?.();
    } else if (msg.type === 'menubarModeChanged') {
      const nextMode = setMenubarMode(msg.mode);
      state.menubarMode = nextMode;
      lastSentTitle = '';
      lastSentMode = '';
      if (latestSnap) applySnapToMenubar(latestSnap);
      await refreshMenubarStatusItem(true);
      writeFloatState(state);
    } else if (msg.type === 'visibilityChanged') {
      state.windowVisible = Boolean(msg.windowVisible);
      state.running = state.windowVisible;
      writeFloatState(state);
      if (state.windowVisible && state.menubarEnabled) {
        refreshMenubarStatusItem(true).catch(() => {});
      }
    } else if (msg.type === 'pinChanged') {
      state.pinned = Boolean(msg.pinned);
      writeFloatState(state);
    } else if (msg.type === 'userDisabledMenubar') {
      setMenubarPreference(false);
      state.menubarEnabled = false;
      state.windowVisible = Boolean(msg.windowVisible);
      state.running = state.windowVisible;
      writeFloatState(state);
      if (!state.windowVisible && !shouldKeepResident()) {
        clearFloatStateIfOwned();
        process.exit(0);
      }
    } else if (msg.type === 'rpcRequest') {
      if (msg.path === '/api/reload-float-bundle') {
        sendToChild({
          type: 'loadHtml',
          html: buildBundledFloatHtml({
            initialPinned: state.pinned,
            initialHidden: !state.windowVisible,
            initialMenubar: state.menubarEnabled,
            initialMode: state.menubarMode,
            initialShortcut: getShortcutConfig('darwin'),
            initialAuxShortcut: getAuxShortcutConfig('darwin')
          })
        });
        sendToChild({ type: 'rpcReply', id: msg.id, ok: true, status: 200, payload: { ok: true } });
        return;
      }
      try {
        const payload = await dispatchApiRpc(msg.path, msg.method, msg.body, state, {
          onActiveContextSnap: applySnapToMenubar,
          onSetMenubar: handleSetMenubarInDaemon,
          onSetMenubarMode: handleSetMenubarModeInDaemon,
          onSetShortcut: handleSetShortcutInDaemon,
          onSetAuxShortcut: handleSetAuxShortcutInDaemon,
          onSetRecording: (recording) => { sendToChild({ type: 'setRecording', recording: Boolean(recording) }); },
          onRefreshMenubar: () => { refreshMenubarStatusItem(true).catch(() => {}); }
        });
        sendToChild({ type: 'rpcReply', id: msg.id, ok: true, status: 200, payload });
      } catch (err) {
        sendToChild({
          type: 'rpcReply',
          id: msg.id,
          ok: false,
          status: 500,
          payload: { ok: false, error: err.message }
        });
      }
    } else if (msg.type === 'closed') {
      clearInterval(barTimer);
      clearFloatStateIfOwned();
      process.exit(0);
    }
  });
}

function findChromiumBinary() {
  if (process.platform === 'darwin') {
    const macApps = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
    ];
    return macApps.find((p) => existsSync(p)) || null;
  }
  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    const winBins = [
      join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
      join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      join(local, 'Google\\Chrome\\Application\\chrome.exe')
    ];
    return winBins.find((p) => existsSync(p)) || null;
  }
  for (const name of ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    try {
      const out = execFileSync('which', [name], { encoding: 'utf-8', timeout: 1000 }).trim();
      if (out) return out;
    } catch {}
  }
  return null;
}

export function createFallbackHttpServer(state, { onCloseRequest } = {}) {
  const sessionToken = createLoopbackSessionToken();
  const server = createServer(async (req, res) => {
    try {
      const activePort = server.address()?.port || 0;
      const guard = guardLoopbackRequest(req, res, { port: activePort, token: sessionToken });
      if (!guard.ok) return;

      const lookupMethod = guard.method === 'HEAD' ? 'GET' : guard.method;
      if (lookupMethod === 'GET' && guard.url.pathname === '/') {
        const fallbackBridgeScript = [
          '<script>',
          'window.__CV_FLOAT_MODE__ = true;',
          'window.__CV_BROWSER_FALLBACK__ = true;',
          'window.sidecar = {',
          '  conversationId: "",',
          '  fetch: (p, o) => fetch(p, o),',
          '  getWorkspaceUris: async () => [],',
          '  onWorkspaceChange: () => () => {},',
          '  closeFloatWindow: async () => {',
          '    try {',
          '      const t = document.querySelector(\'meta[name="cv-csrf-token"]\')?.getAttribute("content") || "";',
          '      await fetch("/api/float-window", {',
          '        method: "POST",',
          '        headers: { "Content-Type": "application/json", ...(t ? { "X-CV-Token": t } : {}) },',
          '        body: JSON.stringify({ action: "close" })',
          '      });',
          '    } catch {}',
          '    try { window.close(); } catch {}',
          '  }',
          '};',
          '</script>'
        ].join('');
        const baseHtml = readFileSync(join(__dirname, 'index.html'), 'utf-8').replace(
          '<script src="/preload.js"></script>',
          () => fallbackBridgeScript
        );
        const html = injectCsrfMeta(baseHtml, sessionToken);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          ...LOOPBACK_SECURITY_HEADERS
        });
        res.end(guard.method === 'HEAD' ? undefined : html);
        return;
      }
      if (lookupMethod === 'GET' && guard.url.pathname === '/styles.css') {
        res.writeHead(200, {
          'Content-Type': 'text/css; charset=utf-8',
          'Cache-Control': 'no-store',
          ...LOOPBACK_SECURITY_HEADERS
        });
        res.end(guard.method === 'HEAD' ? undefined : readFileSync(join(__dirname, 'styles.css'), 'utf-8'));
        return;
      }
      if (lookupMethod === 'GET' && guard.url.pathname === '/app.js') {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
          ...LOOPBACK_SECURITY_HEADERS
        });
        res.end(guard.method === 'HEAD' ? undefined : readFileSync(join(__dirname, 'app.js'), 'utf-8'));
        return;
      }

      const postBody = guard.method === 'POST' ? await readLoopbackJsonBody(req) : null;
      if (guard.url.pathname === '/api/float-window' && guard.method === 'POST') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          ...LOOPBACK_SECURITY_HEADERS
        });
        res.end(JSON.stringify({ ok: true, running: false }));
        onCloseRequest?.();
        return;
      }

      const out = await dispatchApiRpc(
        `${guard.url.pathname}${guard.url.search}`,
        lookupMethod,
        postBody,
        state
      );
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...LOOPBACK_SECURITY_HEADERS
      });
      res.end(guard.method === 'HEAD' ? undefined : JSON.stringify(out));
    } catch (err) {
      const status = Number.isInteger(err?.status) ? err.status : 500;
      if (!res.headersSent) {
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          ...LOOPBACK_SECURITY_HEADERS
        });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ ok: false, error: err?.message || 'Internal server error' }));
      }
    }
  });

  return { server, sessionToken };
}

async function startFallbackAppWindowDaemon() {
  const state = {
    daemonVersion: DAEMON_VERSION,
    daemonBuildId: DAEMON_BUILD_ID,
    daemonRunning: true,
    running: true,
    windowVisible: true,
    pid: process.pid,
    pinned: false,
    menubarEnabled: false,
    mode: 'browser-app',
    cmdSeq: 0,
    startedAt: new Date().toISOString()
  };

  const { server } = createFallbackHttpServer(state, {
    onCloseRequest: () => {
      setTimeout(() => { clearFloatStateIfOwned(); process.exit(0); }, 100);
    }
  });

  process.on('SIGTERM', () => { clearFloatStateIfOwned(); process.exit(0); });
  process.on('SIGINT', () => { clearFloatStateIfOwned(); process.exit(0); });
  process.on('exit', clearFloatStateIfOwned);

  server.listen(0, '127.0.0.1', () => {
    const targetUrl = `http://127.0.0.1:${server.address().port}/`;
    state.url = targetUrl;
    writeFloatState(state);

    const browserBin = findChromiumBinary();
    if (browserBin) {
      execFile(browserBin, [`--app=${targetUrl}`, '--window-size=432,860'], () => {});
    } else if (process.platform === 'win32') {
      execFile('cmd.exe', ['/c', 'start', '', targetUrl], () => {});
    } else if (process.platform === 'darwin') {
      execFile('/usr/bin/open', [targetUrl], () => {});
    } else {
      execFile('xdg-open', [targetUrl], () => {});
    }
  });
}

const isDirectDaemonEntry = (() => {
  if (!process.argv[1] || process.argv[2] !== '--daemon') return false;
  const selfPath = fileURLToPath(import.meta.url);
  if (resolve(process.argv[1]) === selfPath) return true;
  try { return realpathSync(process.argv[1]) === realpathSync(selfPath); } catch { return false; }
})();
if (isDirectDaemonEntry) {
  const initialPinned = !process.argv.includes('--unpinned');
  const initialMenubar = !process.argv.includes('--no-menubar');
  const initialVisible = !process.argv.includes('--hidden-window');
  const mIdx = process.argv.indexOf('--mode');
  const initialMode = mIdx >= 0 && process.argv[mIdx + 1] ? process.argv[mIdx + 1] : getMenubarMode();
  if (process.platform === 'darwin') {
    startMacNativeDaemon({ initialPinned, initialMenubar, initialVisible, initialMode });
  } else {
    startFallbackAppWindowDaemon();
  }
}
