#!/usr/bin/env node
/**
 * Cross-platform Terminal Dashboard & CLI Helper for Antigravity Context Viewer.
 *
 * Works seamlessly for both Antigravity Desktop (`agy` App) and `agy` CLI users:
 *   node cli.mjs                  # Pretty ANSI terminal dashboard summary
 *   node cli.mjs status [convId]  # Pretty summary for latest or specified session
 *   node cli.mjs turns [convId]   # Per-turn context delta, prompts, heavy items, or compactions
 *   node cli.mjs tree [convId]    # Swarm / Subagent multi-agent tree & cost rollup
 *   node cli.mjs compact [convId] # Session compaction history & summary drawer (--full)
 *   node cli.mjs events           # Cross-session diagnostics, routing & Top 10 projects
 *   node cli.mjs json [convId]    # Compact JSON summary (add --full for raw payload)
 *   node cli.mjs float [close]    # Open / toggle / close right-side pinned floating window (Option B)
 *   node cli.mjs sidebar [on|off] # Enable / disable / toggle left-sidebar persistent tab (Option A)
 *   node cli.mjs web [--port N]   # Launch standalone Web UI in default browser
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync, watch } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectTokenHistory,
  findAppDataDir,
  findCliDataDir,
  getAuxShortcutConfig,
  getCliStatusLineConfig,
  getMenubarMode,
  getShortcutConfig,
  getSidebarEntryStatus,
  isCliRuntimeEnv,
  MENUBAR_MODES,
  scanConversation,
  setCliStatusLineConfig,
  setSidebarEntrypoint,
  syncSidebarManifestFromSettings
} from './collector.mjs';
import { controlFloatWindow, getFloatWindowStatus } from './float_window.mjs';
import { formatModelDisplayName } from './pricing.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..', '..');
const PLUGIN_DIR_ID = basename(PLUGIN_ROOT);
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, 'plugin.json'), 'utf-8')).version || '1.8.0';
  } catch {
    return '1.8.0';
  }
})();

const useColor = Boolean((process.stdout.isTTY || process.env.FORCE_COLOR) && !process.env.NO_COLOR);
const c = {
  reset: useColor ? '\x1b[0m' : '',
  bold: useColor ? '\x1b[1m' : '',
  dim: useColor ? '\x1b[2m' : '',
  cyan: useColor ? '\x1b[36m' : '',
  magenta: useColor ? '\x1b[35m' : '',
  green: useColor ? '\x1b[32m' : '',
  yellow: useColor ? '\x1b[33m' : '',
  red: useColor ? '\x1b[31m' : ''
};

/**
 * Deterministic CJK + Latin/Digit spacing & dash normalizer (preserves ANSI escape codes).
 */
function formatZh(input) {
  if (input === null || input === undefined) return '';
  const ansiMasks = [];
  let s = String(input).replace(/\x1b\[[0-9;]*m/g, (m) => {
    ansiMasks.push(m);
    return `\u0000A${ansiMasks.length - 1}\u0000`;
  });
  s = s.replace(/——/g, ' -- ');
  s = s.replace(/([\u4e00-\u9fff])([A-Za-z0-9$¥€£@#%/+-])/g, '$1 $2');
  s = s.replace(/([A-Za-z0-9%$¥€£])([\u4e00-\u9fff])/g, '$1 $2');
  return s.replace(/\u0000A(\d+)\u0000/g, (_, idx) => ansiMasks[Number(idx)] || '');
}

function fmtTok(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '--';
  const num = Number(n);
  if (Math.abs(num) >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (Math.abs(num) >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return String(Math.round(num));
}

function fmtUsd(n, digits = 2) {
  const num = Number(n || 0);
  return `$${num.toFixed(digits)}`;
}

function renderBar(pct, width = 20, invertWarn = false) {
  if (pct === null || pct === undefined || Number.isNaN(Number(pct))) {
    return `${c.dim}[${'░'.repeat(width)}]${c.reset}`;
  }
  const clamped = Math.max(0, Math.min(100, Number(pct)));
  const filled = Math.round((clamped / 100) * width);
  const barStr = `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
  let col = c.green;
  if (invertWarn) {
    col = clamped <= 15 ? c.red : clamped <= 40 ? c.yellow : c.green;
  } else {
    col = clamped >= 90 ? c.red : clamped >= 75 ? c.yellow : c.green;
  }
  return `${col}[${barStr}]${c.reset}`;
}

function cleanOneLine(str) {
  return String(str || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function charDisplayWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

function stringDisplayWidth(str) {
  let w = 0;
  for (const ch of String(str || '')) w += charDisplayWidth(ch);
  return w;
}

function truncateByWidth(str, maxWidth) {
  const s = cleanOneLine(str);
  if (maxWidth <= 0) return '';
  if (stringDisplayWidth(s) <= maxWidth) return s;
  if (maxWidth === 1) return '…';
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = charDisplayWidth(ch);
    if (w + cw > maxWidth - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

function padEndByWidth(str, targetWidth) {
  const s = String(str || '');
  const w = stringDisplayWidth(s);
  if (w >= targetWidth) return s;
  return `${s}${' '.repeat(targetWidth - w)}`;
}

function formatShortTime(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return truncateByWidth(String(ts), 16);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

function formatCostAdaptive(usd) {
  const n = Number(usd || 0);
  if (n > 0 && n < 0.01) return fmtUsd(n, 4);
  return fmtUsd(n, 2);
}

function formatBranchBadge(branchInfo) {
  return branchInfo?.isBranch ? ` ${c.yellow}[/btw 分支]${c.reset}` : '';
}

function formatAgentState(state, { padWidth = 0 } = {}) {
  const s = String(state || '').toLowerCase();
  let label = state ? String(state) : '--';
  let color = c.dim;
  if (s === 'working' || s === 'running' || s === 'active') {
    label = '运行中';
    color = c.green;
  } else if (s === 'waiting' || s === 'idle') {
    label = '待命';
    color = c.cyan;
  } else if (s === 'done' || s === 'completed') {
    label = '已完成';
    color = c.dim;
  } else if (s === 'stopped') {
    label = '已停止';
    color = c.dim;
  } else if (s === 'killed') {
    label = '已终止';
    color = c.red;
  } else if (s === 'error' || s === 'failed') {
    label = '异常';
    color = c.red;
  }
  const padded = padWidth > 0 ? padEndByWidth(truncateByWidth(label, padWidth), padWidth) : label;
  return `${color}${padded}${c.reset}`;
}

function formatEventKind(kind) {
  const k = String(kind || '').toLowerCase();
  if (k === 'quota_429' || k === '429') return `${c.yellow}[429 限流]${c.reset}`;
  if (k === 'safety_filter' || k === 'safety') return `${c.red}[安全过滤]${c.reset}`;
  if (k === 'upstream_retry' || k === 'retry') return `${c.yellow}[上游重试]${c.reset}`;
  if (k === 'context_overflow' || k === 'overflow') return `${c.red}[上下文溢出]${c.reset}`;
  return `${c.dim}[${kind || '异常'}]${c.reset}`;
}

function getRepoLabel(repoInfo) {
  if (!repoInfo || typeof repoInfo !== 'object') return '';
  if (repoInfo.label) return String(repoInfo.label);
  if (repoInfo.name) {
    return repoInfo.branch ? `${repoInfo.name}@${repoInfo.branch}` : String(repoInfo.name);
  }
  return '';
}

function formatStartupBadge(startup, { compact = false } = {}) {
  const state = typeof startup === 'string' ? startup : startup?.state;
  if (state === 'hot') return `${c.green}${compact ? '热' : '热启动'}${c.reset}`;
  if (state === 'warm') return `${c.yellow}${compact ? '部分' : '部分缓存'}${c.reset}`;
  if (state === 'cold') return `${c.red}${compact ? '冷' : '冷启动'}${c.reset}`;
  return '';
}

function formatHeavyKind(kind) {
  const k = String(kind || '').toLowerCase();
  const map = {
    tool: '工具',
    tool_output: '工具输出',
    tool_result: '工具结果',
    file: '文件',
    read_file: '读文件',
    command: '命令',
    terminal: '终端',
    prompt: '用户输入',
    user: '用户输入',
    assistant: '模型回复',
    thinking: '思考',
    thought: '思考',
    attachment: '附件',
    image: '图片',
    diff: '差异',
    search: '搜索'
  };
  return map[k] || (kind ? String(kind) : '其他');
}

function normalizeMenubarModeArg(raw) {
  const s = String(raw || '').toLowerCase();
  if (['context', 'ctx', 'percent', 'pct'].includes(s)) return 'context';
  if (['speed', 'spd', 'tps', 'latency'].includes(s)) return 'speed';
  if (['quota', '5h', 'week', 'limit'].includes(s)) return 'quota';
  return null;
}

function printHelp() {
  const lines = [
    `${c.bold}Antigravity Context & Token Viewer CLI (v${PLUGIN_VERSION})${c.reset}`,
    '',
    '用法：',
    '  agy-context [status] [conversationId]           终端可视化汇总（自动识别桌面端与 agy CLI 最新活跃会话）',
    '  agy-context statusline install [--replace]      为 agy CLI 开启底部实时状态栏（写入 settings.json，默认与内置状态栏叠加）',
    '  agy-context statusline [status|off|uninstall]   查看、暂停或移除 agy CLI 底部实时状态栏配置',
    '  agy-context watch [conversationId] [--once]     终端实时盯盘面板（适配 tmux 分屏，自动跟随最新会话变化）',
    '  agy-context menubar [context|speed|quota]       定制 macOS 顶部菜单栏显示：上下文占比 / 速度与耗时 / 5h或Week额度',
    '  agy-context menubar [on|off|toggle|status]      开启、关闭或查看顶部菜单栏常驻图标（切换会话时自动跟随）',
    '  agy-context float [toggle|close|quit]           切换屏幕右侧独立置顶小窗（不受右侧栏切换影响，随时可取消置顶或收回）',
    '  agy-context aux [toggle|open]                   一键打开或切换 Antigravity 右侧辅助栏「上下文看板」',
    '  agy-context shortcut [combo|reset|off|--global] 查看或自定义独立悬浮窗快捷键（macOS 默认 ⌥⌘K，零辅助功能权限）',
    '  agy-context aux-shortcut [combo|reset|off]      查看或自定义 AGY 右侧辅助栏看板快捷键（macOS 默认 ⌃⌥K）',
    '  agy-context turns [convId] [--prompts|--heavy|--compact] 查看逐轮上下文变化、Prompt 冷热启动、重度消耗或压缩记录',
    '  agy-context heavy [conversationId]              查看当前会话上下文重度消耗 Top 10 排行',
    '  agy-context tree [conversationId]               查看 Swarm / Subagent 多代理整树聚合与费用统计',
    '  agy-context compact [conversationId] [--full]   查看当前会话上下文压缩历史与摘要原文',
    '  agy-context events|diag|projects                查看跨会话异常事件、灰度路由取证及项目消耗 Top 10',
    '  agy-context json [conversationId]               输出结构化 JSON 摘要（加 --full 输出完整原始快照）',
    '  agy-context web [--port 18970]                  启动独立本地 Web 看板并自动在浏览器打开（适合纯 CLI 用户）',
    '  agy-context --help                              查看帮助说明'
  ];
  console.log(lines.map(formatZh).join('\n'));
}

async function runMenubarCommand(rawArgs) {
  const sub = (rawArgs.filter((a) => !a.startsWith('-'))[1] || 'toggle').toLowerCase();
  if (rawArgs.includes('--status') || sub === 'status') {
    const st = getFloatWindowStatus();
    if (rawArgs.includes('--json')) {
      console.log(JSON.stringify(st, null, 2));
      return;
    }
    const modeLabelMap = {
      context: '上下文占比',
      speed: '速度与耗时',
      quota: '5h/Week 额度'
    };
    const mLbl = modeLabelMap[st.menubarMode || getMenubarMode()] || st.menubarMode;
    const convInfo = st.activeConvTitle ? ` · 跟随会话：${st.activeConvTitle}` : '';
    console.log(
      formatZh(
        st.menubarActive
          ? `${c.green}●${c.reset} 顶部菜单栏常驻运行中 (PID ${st.pid} · 模式：${mLbl} · 显示：${st.statusTitle || '◈ --%'}${convInfo})`
          : st.menubarEnabled
            ? `${c.yellow}◐${c.reset} 顶部菜单栏偏好已开启（模式：${mLbl}，执行 agy-context menubar on 可立即唤起）`
            : `${c.dim}○${c.reset} 顶部菜单栏常驻图标当前状态：已关闭`
      )
    );
    return;
  }

  const pickedMode = normalizeMenubarModeArg(sub);
  if (pickedMode && MENUBAR_MODES.includes(pickedMode)) {
    const res = await controlFloatWindow({ action: 'set-menubar-mode', menubarMode: pickedMode });
    if (rawArgs.includes('--json')) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    if (!res.ok) {
      console.error(formatZh(`${c.red}✗${c.reset} ${res.error || '切换失败'}`));
      process.exitCode = 1;
      return;
    }
    console.log(formatZh(`${c.green}✓${c.reset} ${res.message}`));
    return;
  }

  let menubarEnabled;
  if (['on', 'enable', 'true', '1'].includes(sub) || rawArgs.includes('--on')) {
    menubarEnabled = true;
  } else if (['off', 'disable', 'false', '0', 'close'].includes(sub) || rawArgs.includes('--off')) {
    menubarEnabled = false;
  }
  const res = await controlFloatWindow({ action: 'set-menubar', menubarEnabled });
  if (rawArgs.includes('--json')) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  if (!res.ok) {
    console.error(formatZh(`${c.red}✗${c.reset} ${res.error || '切换失败'}`));
    process.exitCode = 1;
    return;
  }
  console.log(formatZh(`${c.green}✓${c.reset} ${res.message}`));
}

function runSidebarCommand(rawArgs) {
  const sub = (rawArgs.filter((a) => !a.startsWith('-'))[1] || 'toggle').toLowerCase();
  if (rawArgs.includes('--status') || sub === 'status') {
    const st = getSidebarEntryStatus();
    if (rawArgs.includes('--json')) {
      console.log(JSON.stringify(st, null, 2));
      return;
    }
    console.log(
      formatZh(
        st.sidebarEnabled
          ? `${c.green}●${c.reset} 方案 A（左侧栏 Plugins 常驻页签）当前状态：已开启`
          : `${c.dim}○${c.reset} 方案 A（左侧栏 Plugins 常驻页签）当前状态：已关闭`
      )
    );
    return;
  }

  const cur = getSidebarEntryStatus();
  let wantEnabled = !cur.sidebarEnabled;
  if (['on', 'enable', 'true', '1'].includes(sub) || rawArgs.includes('--on')) {
    wantEnabled = true;
  } else if (['off', 'disable', 'false', '0', 'close'].includes(sub) || rawArgs.includes('--off')) {
    wantEnabled = false;
  }
  const res = setSidebarEntrypoint(wantEnabled);
  if (rawArgs.includes('--json')) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  if (!res.ok) {
    console.error(formatZh(`${c.red}✗${c.reset} ${res.error || '切换失败'}`));
    process.exitCode = 1;
    return;
  }
  console.log(formatZh(`${c.green}✓${c.reset} ${res.message}`));
}

async function runFloatCommand(rawArgs) {
  const sub = (rawArgs.filter((a) => !a.startsWith('-'))[1] || '').toLowerCase();
  let action = 'open';
  if (rawArgs.includes('--quit') || ['quit', 'kill', 'exit'].includes(sub)) {
    action = 'quit';
  } else if (rawArgs.includes('--close') || ['close', 'off', 'stop', 'hide', 'unpin-close'].includes(sub)) {
    action = 'close';
  } else if (rawArgs.includes('--toggle') || sub === 'toggle') {
    action = 'toggle';
  } else if (rawArgs.includes('--status') || sub === 'status') {
    action = 'status';
  }
  const pinned = !rawArgs.includes('--unpinned');
  const res = await controlFloatWindow({ action, pinned });
  if (rawArgs.includes('--json')) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  if (!res.ok) {
    console.error(formatZh(`${c.red}✗${c.reset} ${res.error || '操作失败'}`));
    process.exitCode = 1;
    return;
  }
  if (res.warning) {
    console.error(formatZh(`${c.yellow}${res.warning}${c.reset}`));
    return;
  }
  if (action === 'status') {
    console.log(
      formatZh(
        res.running
          ? `${c.green}●${c.reset} 右侧独立看板显示中 (PID ${res.pid} · ${res.pinned ? '已置顶' : '普通窗口'}${res.menubarActive ? ` · 菜单栏 ${res.statusTitle || '已开启'}` : ''})`
          : res.menubarActive
            ? `${c.cyan}◈${c.reset} 右侧小窗已收回（顶部菜单栏常驻就绪：${res.statusTitle || '◈ --%'}，单击可秒开）`
            : `${c.dim}○${c.reset} 右侧独立看板当前未打开`
      )
    );
    return;
  }
  console.log(formatZh(`${c.green}✓${c.reset} ${res.message || (res.running ? '已打开独立看板' : '已收回独立看板')}`));
}

async function runAuxCommand(rawArgs) {
  const positionals = rawArgs.filter((a) => !a.startsWith('-'));
  const sub = (positionals[1] || 'toggle').toLowerCase();
  const action = sub === 'open' ? 'open-aux' : 'toggle-aux';
  const convId = process.env.ANTIGRAVITY_CONVERSATION_ID || '';
  const res = await controlFloatWindow({ action, convId });
  if (rawArgs.includes('--json')) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  if (!res.ok) {
    console.error(formatZh(`${c.red}✗${c.reset} ${res.error || '切换 AGY 侧栏看板失败'}`));
    process.exitCode = 1;
    return;
  }
  console.log(formatZh(`${res.acked ? c.green + '✓' : c.cyan + '◈'}${c.reset} ${res.message}`));
}

async function runShortcutCommand(rawArgs, { isAux = false } = {}) {
  const positionals = rawArgs.filter((a) => !a.startsWith('-'));
  const rawSub = positionals[1] || '';
  const sub = rawSub.toLowerCase();
  const hasGlobalFlag = rawArgs.includes('--global');
  const hasAppFlag = rawArgs.includes('--app');
  const hasResetFlag = rawArgs.includes('--reset') || ['reset', 'default'].includes(sub);
  const hasOffFlag = rawArgs.includes('--off') || ['off', 'disable', 'disabled', 'false', '0'].includes(sub);
  const hasOnFlag = rawArgs.includes('--on') || ['on', 'enable', 'enabled', 'true', '1'].includes(sub);

  const label = isAux ? 'AGY 侧栏看板快捷键' : '独立悬浮窗快捷键';
  const isPureStatus =
    rawArgs.includes('--status') ||
    sub === 'status' ||
    (!rawSub && !hasGlobalFlag && !hasAppFlag && !hasResetFlag && !hasOffFlag && !hasOnFlag);

  if (isPureStatus) {
    const fw = getFloatWindowStatus();
    const sc = isAux ? (fw.auxShortcut || getAuxShortcutConfig()) : (fw.shortcut || getShortcutConfig());
    const active = isAux ? fw.auxShortcutActive : fw.shortcutActive;
    if (rawArgs.includes('--json')) {
      const payload = isAux
        ? { ok: true, auxShortcut: sc, floatWindow: fw }
        : { ok: true, shortcut: sc, floatWindow: fw };
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    const scopeLbl = sc.scope === 'global' ? '全局生效' : '仅宿主前台生效';
    console.log(
      formatZh(
        !sc.enabled
          ? `${c.dim}○${c.reset} ${label}当前状态：已停用（已保存键位：${sc.display}，默认：${sc.defaultDisplay}）`
          : active
            ? `${c.green}●${c.reset} ${label}运行中：${c.bold}${sc.display}${c.reset}（${scopeLbl} · PID ${fw.pid}）`
            : `${c.cyan}◈${c.reset} ${label}已配置：${c.bold}${sc.display}${c.reset}（${scopeLbl}${sc.isDefault ? ' · 默认' : ''}）`
      )
    );
    return;
  }

  const patch = { action: isAux ? 'set-aux-shortcut' : 'set-shortcut' };
  if (hasResetFlag) {
    patch.reset = true;
  } else {
    if (hasOffFlag) {
      patch.enabled = false;
    } else if (hasOnFlag) {
      patch.enabled = true;
    } else if (rawSub) {
      patch.accelerator = rawSub;
      patch.enabled = true;
    }
    if (hasGlobalFlag) patch.scope = 'global';
    else if (hasAppFlag) patch.scope = 'app';
  }

  const res = await controlFloatWindow(patch);
  if (rawArgs.includes('--json')) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  if (!res.ok) {
    console.error(formatZh(`${c.red}✗${c.reset} ${res.error || '设置快捷键失败'}`));
    process.exitCode = 1;
    return;
  }
  console.log(formatZh(`${c.green}✓${c.reset} ${res.message}`));
}

async function runWebServer(rawArgs) {
  const portIdx = rawArgs.indexOf('--port');
  const port = portIdx >= 0 && rawArgs[portIdx + 1] ? rawArgs[portIdx + 1] : '18970';
  const noOpen = rawArgs.includes('--no-open');
  const childArgs = [join(__dirname, 'main.mjs'), '--standalone', '--port', String(port)];
  if (!noOpen) childArgs.push('--open');

  const child = spawn(process.execPath, childArgs, { stdio: 'inherit' });
  await new Promise((resolvePromise) => {
    child.on('exit', (code) => {
      process.exitCode = code ?? 0;
      resolvePromise();
    });
  });
}

function buildCompactSummary(ctx = {}, hist = {}) {
  const safeCtx = ctx && typeof ctx === 'object' ? ctx : {};
  const safeHist = hist && typeof hist === 'object' ? hist : {};
  const cx = safeCtx.context || {};
  const sp = safeCtx.speed || {};
  const st = cx.sessionTotals || {};
  const turns = Array.isArray(safeCtx.turns) ? safeCtx.turns : [];
  const promptTurns = Array.isArray(safeCtx.promptTurns) ? safeCtx.promptTurns : [];
  const heavyItems = Array.isArray(safeCtx.heavyItems) ? safeCtx.heavyItems : [];
  const compactionsRaw = Array.isArray(safeCtx.compactions) ? safeCtx.compactions : [];
  const rawAgentTree = safeCtx.agentTree && typeof safeCtx.agentTree === 'object' ? safeCtx.agentTree : null;
  const rawProjects = Array.isArray(safeHist.analyticsBySource?.all?.byProject)
    ? safeHist.analyticsBySource.all.byProject
    : [];
  const rawDiag = safeHist.diagnostics && typeof safeHist.diagnostics === 'object' ? safeHist.diagnostics : null;
  const sumAll = safeHist.analyticsBySource?.all?.summary || {};
  const sumDesktop = safeHist.analyticsBySource?.desktop?.summary || {};
  const sumCli = safeHist.analyticsBySource?.cli?.summary || {};
  const costPeriod = safeHist.analyticsBySource?.all?.costs?.period?.hybrid || {};
  const costAll = safeHist.analyticsBySource?.all?.costs?.allTime?.hybrid || {};
  const plan = safeHist.planStatus || {};
  const activeConvMeta = (safeCtx.recentConversations || []).find((item) => item.id === safeCtx.conversationId);
  const runtimeEnv = isCliRuntimeEnv() ? 'cli' : 'desktop';
  const convSource = activeConvMeta?.source || safeCtx.conversationSource || runtimeEnv;

  const compactAgentTree = rawAgentTree
    ? {
        isSwarm: Boolean(rawAgentTree.isSwarm),
        swarmTitle: rawAgentTree.swarmTitle || null,
        childrenCount: Number(rawAgentTree.childrenCount || 0),
        activeChildrenCount: Number(rawAgentTree.activeChildrenCount || 0),
        treeTotals: rawAgentTree.treeTotals
          ? {
              turnsCount: Number(rawAgentTree.treeTotals.turnsCount || 0),
              totalTokens: Number(rawAgentTree.treeTotals.totalTokens || 0),
              inputTokens: Number(rawAgentTree.treeTotals.inputTokens || 0),
              cacheTokens: Number(rawAgentTree.treeTotals.cacheTokens || 0),
              outputTokens: Number(rawAgentTree.treeTotals.outputTokens || 0),
              costUSD: Number(Number(rawAgentTree.treeTotals.costUSD || 0).toFixed(4)),
              cacheSavingsUSD: Number(Number(rawAgentTree.treeTotals.cacheSavingsUSD || 0).toFixed(4))
            }
          : null,
        children: (Array.isArray(rawAgentTree.children) ? rawAgentTree.children : []).slice(0, 10).map((ch) => ({
          id: ch?.id || null,
          name: ch?.name || '',
          role: ch?.role || '',
          model: ch?.model || '',
          state: ch?.state || '',
          turnsCount: Number(ch?.turnsCount || 0),
          totalTokens: Number(ch?.totalTokens || 0),
          costUSD: Number(Number(ch?.costUSD || 0).toFixed(4)),
          cacheSavingsUSD: Number(Number(ch?.cacheSavingsUSD || 0).toFixed(4))
        }))
      }
    : null;

  return {
    pluginDirId: PLUGIN_DIR_ID,
    runtimeEnv,
    entrypoints: {
      sidecarAuxPane: `sidecar://${PLUGIN_DIR_ID}/dashboard/`,
      sidebarFullPane: `sidecar://${PLUGIN_DIR_ID}/dashboard/sidebar`,
      sidebarTabEnabled: getSidebarEntryStatus().sidebarEnabled,
      customizationSettings: `customization://${PLUGIN_DIR_ID}`
    },
    floatWindow: getFloatWindowStatus(),
    conversation: {
      id: safeCtx.conversationId || null,
      source: convSource,
      title: safeCtx.conversationTitle || '未命名会话',
      repoInfo: safeCtx.repoInfo || null,
      branchInfo: safeCtx.branchInfo || null,
      compactionsCount: compactionsRaw.length,
      model: cx.model || '未识别模型',
      usedTokens: cx.used ?? null,
      promptUsed: cx.promptUsed ?? null,
      projectedNextMin: cx.projectedNextMin ?? null,
      projectedNextPercent: cx.projectedNextPercent ?? null,
      budgetTokens: cx.budget ?? null,
      budgetSource: cx.budgetSource || (cx.budget ? 'server' : 'unknown'),
      pendingTokens: cx.pendingTokens ?? 0,
      usagePercent: cx.percent ?? null,
      usedFormatted: `${fmtTok(cx.used)} / ${cx.budget ? fmtTok(cx.budget) : '未知'} (${cx.percent != null ? `${cx.percent}%` : '容量未知'})`,
      cacheHitPercent: cx.cacheHitPercent ?? null,
      latestPromptStartup: cx.latestPromptStartup || null,
      speed: {
        latestTps: sp.tps ?? null,
        streamingTps: sp.streamingTps ?? null,
        avgTps: sp.avgTps ?? null,
        peakTps: sp.peakTps ?? null,
        ttftSec: sp.ttft ?? null,
        durationSec: sp.duration ?? null
      },
      sessionTotals: {
        cacheReadTokens: st.cacheTokens ?? 0,
        freshInputTokens: st.inputTokens ?? 0,
        outputTokens: st.outputTokens ?? 0,
        thinkingTokens: st.thinkingTokens ?? 0,
        grossTokens: st.totalTokens ?? 0,
        cacheHitPercent: st.cacheHitPercent ?? null,
        turnsCount: activeConvMeta?.turnsCount || turns.length || 0
      },
      roundApiCostUSD: Number((cx.roundCostUSD || 0).toFixed(4)),
      sessionApiCostUSD: Number((cx.sessionCostUSD || 0).toFixed(4)),
      sessionCacheSavingsUSD: Number((cx.sessionCacheSavingsUSD || 0).toFixed(4)),
      status: cx.error?.title || '正常'
    },
    agentTree: compactAgentTree,
    compactions: compactionsRaw.slice(0, 5).map((item, idx) => ({
      index: item?.index ?? (idx + 1),
      stepIndex: item?.stepIndex ?? null,
      createdAt: item?.createdAt ?? null,
      beforeTokens: item?.beforeTokens ?? null,
      afterTokens: item?.afterTokens ?? null,
      savedTokens: item?.savedTokens ?? null,
      savedPercent: item?.savedPercent ?? null,
      summaryPreview: item?.summaryPreview || ''
    })),
    topProjects: rawProjects.slice(0, 5).map((p) => ({
      name: p?.name || '未归类工作区',
      conversations: Number(p?.conversations || 0),
      requests: Number(p?.requests || 0),
      tokens: Number(p?.tokens || 0),
      inputTokens: Number(p?.inputTokens || 0),
      cacheTokens: Number(p?.cacheTokens || 0),
      outputTokens: Number(p?.outputTokens || 0),
      costUSD: Number(Number(p?.costUSD || 0).toFixed(4)),
      cacheSavingsUSD: Number(Number(p?.cacheSavingsUSD || 0).toFixed(4))
    })),
    diagnostics: rawDiag
      ? {
          sqliteEnabled: Boolean(rawDiag.sqliteEnabled),
          eventsSummary: rawDiag.eventsSummary || null,
          routingSummary: rawDiag.routingSummary || null
        }
      : null,
    recentTurns: turns.slice(0, 8).map((t) => ({
      turn: t.turnIndex,
      contextTokens: t.totalTokens,
      deltaTokens: t.deltaTokens,
      outputTokens: t.outputTokens,
      tps: t.tps,
      costUSD: t.costUSD,
      tools: t.tools || []
    })),
    promptTurns: promptTurns.slice(0, 8).map((p) => ({
      promptIndex: p.promptIndex ?? null,
      createdAt: p.createdAt ?? null,
      promptPreview: p.promptPreview || '',
      startupState: p.startupState ?? null,
      startupCacheHitPercent: p.startupCacheHitPercent ?? null,
      callsCount: p.callsCount ?? 0,
      startTokens: p.startTokens ?? null,
      endTokens: p.endTokens ?? null,
      deltaTokens: p.deltaTokens ?? 0,
      outputTokens: p.outputTokens ?? 0,
      costUSD: p.costUSD != null ? Number(Number(p.costUSD).toFixed(4)) : 0,
      ttft: p.ttft ?? null,
      avgTps: p.avgTps ?? null,
      tools: Array.isArray(p.tools) ? p.tools : []
    })),
    heavyItems: heavyItems.slice(0, 5).map((h, idx) => ({
      rank: h.rank ?? (idx + 1),
      kind: h.kind || 'unknown',
      label: h.label || '',
      preview: h.preview || '',
      estTokens: h.estTokens ?? 0,
      sharePercent: h.sharePercent ?? null
    })),
    globalHistory: {
      totalTokens: fmtTok(sumAll.grandTotalTokens),
      desktopTokens: fmtTok(sumDesktop.grandTotalTokens),
      cliTokens: fmtTok(sumCli.grandTotalTokens),
      todayTokens: fmtTok(sumAll.todayTokens),
      monthTokens: fmtTok(sumAll.monthTokens),
      yearTokens: fmtTok(sumAll.yearTokens),
      conversations: safeHist.sources?.all?.conversationsCount || 0,
      desktopConversations: safeHist.sources?.desktop?.conversationsCount || 0,
      cliConversations: safeHist.sources?.cli?.conversationsCount || 0,
      activeDays: sumAll.activeDaysCount || 0,
      monthHybridCostUSD: Number((costPeriod.totalCostUSD || 0).toFixed(2)),
      allTimeHybridCostUSD: Number((costAll.totalCostUSD || 0).toFixed(2)),
      periodCacheSavingsUSD: Number((costPeriod.cacheSavingsUSD || 0).toFixed(2)),
      allTimeCacheSavingsUSD: Number((costAll.cacheSavingsUSD || 0).toFixed(2)),
      plan: `${plan.tierName || '未连接宿主'} (${plan.symbol || '$'}${plan.effectivePrice ?? '--'}/${plan.billingCycle || '月'})`
    },
    historyStatus: safeHist.historyStatus || { state: 'ok', restrictedSources: [], reason: '' },
    quotaStatus: safeHist.quotaStatus || safeCtx.quotaStatus || null,
    quotas: (safeHist.modelQuotas || []).map((q) => {
      const p5 = typeof q.fiveHour?.remainingPercent === 'number' ? q.fiveHour.remainingPercent : null;
      const pBase = p5 === null
        ? (typeof q.baseRemainingPercent === 'number'
            ? q.baseRemainingPercent
            : (typeof q.remainingPercent === 'number' ? q.remainingPercent : null))
        : null;
      const pW = typeof q.weekly?.remainingPercent === 'number' ? q.weekly.remainingPercent : null;
      const eff5 = p5 ?? pBase;
      return {
        label: q.displayTitle || q.title || q.groupLabel || q.label || '模型配额池',
        remainingPercent: eff5 !== null && pW !== null ? Math.min(eff5, pW) : (eff5 ?? pW ?? null),
        fiveHourPercent: p5,
        basePercent: pBase,
        weeklyPercent: pW,
        resetText: q.fiveHour?.resetTimeZh || q.weekly?.resetTimeZh || q.baseResetTimeZh || q.resetTimeZh || q.resetCountdown || ''
      };
    })
  };
}

function printPrettyStatus(ctx, hist) {
  const s = buildCompactSummary(ctx, hist);
  const cv = s.conversation;
  const gh = s.globalHistory;
  const srcBadge = cv.source === 'cli' ? '[CLI]' : '[Desktop]';

  const out = [];
  out.push(`${c.bold}${c.magenta}◈ 上下文与 Token 看板${c.reset} ${c.dim}(v${PLUGIN_VERSION} · Desktop + agy CLI)${c.reset}`);
  out.push(`${c.dim}${'─'.repeat(64)}${c.reset}`);

  if (!cv.id) {
    out.push('当前尚未检测到本地会话归档记录。');
  } else {
    const repoLabel = getRepoLabel(cv.repoInfo);
    const repoTag = repoLabel ? ` ${c.cyan}[${repoLabel}]${c.reset}` : '';
    const branchTag = formatBranchBadge(cv.branchInfo);
    out.push(`${c.bold}当前会话${c.reset}  ${c.cyan}${srcBadge}${c.reset} ${cv.title}${repoTag}${branchTag} ${c.dim}(${cv.id.slice(0, 8)})${c.reset}`);
    out.push(`活跃模型  ${c.bold}${cv.model}${c.reset}  ·  状态：${cv.status}`);
    const budgetText = cv.budgetTokens ? fmtTok(cv.budgetTokens) : '未知上限';
    const pctText = cv.usagePercent != null ? `${cv.usagePercent}%` : (cv.usedTokens != null ? '容量未知' : '--%');
    const lsBlockedNote = !cv.budgetTokens && (s.quotaStatus?.errorCode === 'EPERM' || s.quotaStatus?.errorCode === 'EACCES')
      ? ' · 沙箱限制暂不可查询语言服务'
      : '';
    out.push(`窗口水位  ${renderBar(cv.usagePercent)} ${c.bold}${pctText}${c.reset}  (${fmtTok(cv.usedTokens)} / ${budgetText}${cv.pendingTokens > 0 ? `，含待发送 +${fmtTok(cv.pendingTokens)}` : ''}${lsBlockedNote})`);
    const startupBadge = formatStartupBadge(cv.latestPromptStartup);
    const startupPct = cv.latestPromptStartup?.cacheHitPercent != null
      ? ` ${Math.round(Number(cv.latestPromptStartup.cacheHitPercent))}%`
      : '';
    const startupPart = startupBadge ? ` · 本 Prompt 首跳${startupBadge}${startupPct}` : '';
    out.push(`缓存速度  单轮缓存命中 ${c.bold}${cv.cacheHitPercent != null ? `${cv.cacheHitPercent}%` : '--'}${c.reset}${startupPart}  ·  最新 ${c.cyan}${cv.speed.latestTps ? `${cv.speed.latestTps} tok/s` : '--'}${c.reset} (均值 ${cv.speed.avgTps ?? '--'} / 峰值 ${cv.speed.peakTps ?? '--'} tok/s, TTFT ${cv.speed.ttftSec ?? '--'}s)`);
    out.push(`会话吞吐  共 ${cv.sessionTotals.turnsCount} 轮  ·  累计总吞吐 ${c.bold}${fmtTok(cv.sessionTotals.grossTokens)}${c.reset} (缓存 ${fmtTok(cv.sessionTotals.cacheReadTokens)} · 新增输入 ${fmtTok(cv.sessionTotals.freshInputTokens)} · 输出 ${fmtTok(cv.sessionTotals.outputTokens)})`);
    const sessionSavingsStr = cv.sessionCacheSavingsUSD > 0
      ? (cv.sessionCacheSavingsUSD < 0.01 ? fmtUsd(cv.sessionCacheSavingsUSD, 4) : fmtUsd(cv.sessionCacheSavingsUSD, 2))
      : '';
    const sessionSavingsPart = sessionSavingsStr ? `  ·  ${c.green}缓存省 ${sessionSavingsStr}${c.reset}` : '';
    out.push(`参考折算  本轮 ${c.bold}${fmtUsd(cv.roundApiCostUSD, 4)}${c.reset}  ·  全会话累计 ${c.bold}${fmtUsd(cv.sessionApiCostUSD, 4)}${c.reset}${sessionSavingsPart}`);
    if (ctx?.agentTree?.childrenCount > 0) {
      const tt = ctx.agentTree.treeTotals || {};
      const treeSaveNum = Number(tt.cacheSavingsUSD || 0);
      const treeSavePart = treeSaveNum > 0
        ? ` (${c.green}缓存省 ${fmtUsd(treeSaveNum, 2)}${c.reset})`
        : ` ${c.dim}(缓存省 $0.00)${c.reset}`;
      out.push(`多代理树  含 ${c.bold}${ctx.agentTree.childrenCount}${c.reset} 个子代理 · 整树吞吐 ${c.bold}${fmtTok(tt.totalTokens ?? 0)}${c.reset} · 整树折算 ${c.bold}${fmtUsd(tt.costUSD ?? 0, 2)}${c.reset}${treeSavePart}`);
    }
    if (Array.isArray(ctx?.compactions) && ctx.compactions.length > 0) {
      const totalSaved = ctx.compactions.reduce((acc, item) => acc + Math.max(0, Number(item?.savedTokens || 0)), 0);
      const savedPart = totalSaved > 0 ? ` · 累计释放 ${c.green}${fmtTok(totalSaved)} Token${c.reset}` : '';
      out.push(`压缩记录  共 ${c.bold}${ctx.compactions.length}${c.reset} 次${savedPart}（运行 ${c.cyan}agy-context compact${c.reset} 查看摘要）`);
    }
    const heavyTop = (Array.isArray(ctx?.heavyItems) ? ctx.heavyItems : [])
      .filter((item) => Number(item?.estTokens || 0) >= 2000)
      .slice(0, 3);
    if (heavyTop.length > 0) {
      const heavySummary = heavyTop
        .map((item) => `${truncateByWidth(item.label || formatHeavyKind(item.kind), 24)} (~${fmtTok(item.estTokens)})`)
        .join(' · ');
      out.push(`重度消耗  Top 3：${c.yellow}${heavySummary}${c.reset}`);
    }
  }

  if (s.recentTurns.length > 0) {
    out.push('');
    out.push(`${c.bold}最近 5 轮上下文变化（倒序）${c.reset}`);
    for (const t of s.recentTurns.slice(0, 5)) {
      const d = Number(t.deltaTokens || 0);
      const dStr = d > 0 ? `${c.yellow}+${fmtTok(d)}${c.reset}` : d < 0 ? `${c.green}${fmtTok(d)}${c.reset}` : `${c.dim}0${c.reset}`;
      const toolStr = t.tools.length ? `  [${t.tools.slice(0, 3).join(', ')}]` : '';
      out.push(`  #${String(t.turn).padEnd(3)} 水位 ${fmtTok(t.contextTokens).padStart(7)} (${dStr})  ·  输出 ${fmtTok(t.outputTokens).padStart(6)}  ·  ${t.tps ? `${t.tps} tok/s` : '--'}${c.dim}${toolStr}${c.reset}`);
    }
  }

  out.push('');
  if (s.historyStatus?.state === 'restricted') {
    out.push(`${c.bold}本机多源历史汇总${c.reset} ${c.yellow}(受沙箱限制仅统计当前可读会话：共 ${gh.conversations} 个 · 请在外部终端运行 agy-context 查看完整汇总)${c.reset}`);
  } else {
    out.push(`${c.bold}本机多源历史汇总${c.reset} ${c.dim}(共 ${gh.conversations} 个会话：桌面端 ${gh.desktopConversations} / CLI ${gh.cliConversations} · 活跃 ${gh.activeDays} 天)${c.reset}`);
  }
  out.push(`  累计总计 ${c.bold}${gh.totalTokens}${c.reset} (桌面 ${gh.desktopTokens} / CLI ${gh.cliTokens})  ·  今日 ${c.bold}${gh.todayTokens}${c.reset}  ·  本月 ${c.bold}${gh.monthTokens}${c.reset}  ·  本年 ${gh.yearTokens}`);
  const periodSavingsPart = gh.periodCacheSavingsUSD > 0
    ? `  ·  ${c.green}本月缓存省 ${fmtUsd(gh.periodCacheSavingsUSD, 2)}${c.reset}`
    : '';
  out.push(`  费用参考 本月 ${c.bold}${fmtUsd(gh.monthHybridCostUSD)}${c.reset}  ·  历史累计 ${c.bold}${fmtUsd(gh.allTimeHybridCostUSD)}${c.reset}${periodSavingsPart}  ·  订阅 ${gh.plan}`);
  const diag = hist?.diagnostics;
  const evSum = diag?.eventsSummary || {};
  const rtSum = diag?.routingSummary || {};
  const hasDiagEvents = Number(evSum.total || 0) > 0 ||
    Number(evSum.quota429 || 0) > 0 ||
    Number(evSum.safetyFilter || 0) > 0 ||
    Number(evSum.upstreamRetry || 0) > 0 ||
    Number(evSum.contextOverflow || 0) > 0;
  const hasDiagRouting = Number(rtSum.total || 0) > 0;
  if (diag && (hasDiagEvents || hasDiagRouting)) {
    const diagParts = [];
    if (Number(evSum.quota429 || 0) > 0) diagParts.push(`${c.yellow}429 ×${evSum.quota429}${c.reset}`);
    if (Number(evSum.safetyFilter || 0) > 0) {
      const wasted = Number(evSum.safetyWastedUSD || 0);
      const wastedStr = wasted > 0 ? ` (浪费 ${fmtUsd(wasted, 2)})` : '';
      diagParts.push(`${c.red}安全过滤 ×${evSum.safetyFilter}${wastedStr}${c.reset}`);
    }
    if (Number(evSum.upstreamRetry || 0) > 0) diagParts.push(`${c.yellow}重试 ×${evSum.upstreamRetry}${c.reset}`);
    if (Number(evSum.contextOverflow || 0) > 0) diagParts.push(`${c.red}溢出 ×${evSum.contextOverflow}${c.reset}`);
    if (Number(rtSum.total || 0) > 0) diagParts.push(`${c.cyan}灰度路由 ×${rtSum.total}${c.reset}`);
    if (diagParts.length === 0 && Number(evSum.total || 0) > 0) {
      diagParts.push(`${c.yellow}异常 ×${evSum.total}${c.reset}`);
    }
    out.push(`  取证诊断 ${diagParts.join(' · ')}`);
  }

  if (s.quotas.length > 0) {
    out.push('');
    const syncNote = s.quotaStatus?.stale
      ? ` ${c.yellow}(缓存快照 · 上次同步 ${s.quotaStatus.lastSuccessAt || '--'})${c.reset}`
      : (s.quotaStatus?.summaryStale ? ` ${c.yellow}(多窗口摘要降级)${c.reset}` : '');
    out.push(`${c.bold}实时配额池余量${c.reset}${syncNote}`);
    for (const q of s.quotas.slice(0, 4)) {
      let pctCol = '余量未知';
      if (q.fiveHourPercent !== null && q.weeklyPercent !== null) {
        pctCol = `5h ${q.fiveHourPercent}% · 周 ${q.weeklyPercent}%`;
      } else if (q.basePercent !== null && q.weeklyPercent !== null) {
        pctCol = `基础 ${q.basePercent}% · 周 ${q.weeklyPercent}%`;
      } else if (q.fiveHourPercent !== null) {
        pctCol = `${String(q.fiveHourPercent).padStart(5)}%`;
      } else if (q.basePercent !== null) {
        pctCol = `基础 ${q.basePercent}%`;
      } else if (q.weeklyPercent !== null) {
        pctCol = `周 ${q.weeklyPercent}%`;
      }
      out.push(`  ${renderBar(q.remainingPercent, 12, true)} ${pctCol}  ${q.label}${q.resetText ? ` ${c.dim}(重置：${q.resetText})${c.reset}` : ''}`);
    }
  } else if (s.quotaStatus?.state === 'error') {
    out.push('');
    out.push(`${c.bold}实时配额池余量${c.reset} ${c.yellow}(${s.quotaStatus.reason || '宿主语言服务请求失败，暂未获取到配额池'})${c.reset}`);
  }

  out.push(`${c.dim}${'─'.repeat(64)}${c.reset}`);
  if (s.runtimeEnv === 'cli' || cv.source === 'cli') {
    out.push(`${c.dim}提示：可在外部终端运行 agy-context web 打开完整面板、agy-context float 打开右侧置顶小窗（agy-context shortcut --global 开启终端前台热键）、agy-context menubar on 开启菜单栏常驻。${c.reset}`);
  } else {
    out.push(`${c.dim}提示：agy-context menubar [context|speed|quota] 切换顶部菜单栏显示内容；agy-context float 弹出右侧置顶小窗。${c.reset}`);
  }

  console.log(out.map(formatZh).join('\n'));
}

function printTurnsTable(ctx) {
  const turns = ctx.turns || [];
  const out = [];
  out.push(`${c.bold}会话逐轮上下文与工具调用明细${c.reset} ${c.dim}(${ctx.conversationTitle || ctx.conversationId || '无会话'})${c.reset}`);
  out.push(`${c.dim}${'─'.repeat(76)}${c.reset}`);
  if (!turns.length) {
    out.push('暂无轮次记录。');
  } else {
    for (const t of turns.slice(0, 20)) {
      const d = Number(t.deltaTokens || 0);
      const dStr = d > 0 ? `+${fmtTok(d)}` : fmtTok(d);
      const tools = (t.tools || []).length ? ` | 工具：${t.tools.join(', ')}` : '';
      out.push(
        `#${String(t.turnIndex).padEnd(3)} | 上下文 ${fmtTok(t.totalTokens).padStart(7)} (${dStr.padStart(7)}) | 输出 ${fmtTok(t.outputTokens).padStart(6)} | ${fmtUsd(t.costUSD, 4)} | ${t.tps ? `${t.tps} tok/s` : '--'}${tools}`
      );
    }
  }
  console.log(out.map(formatZh).join('\n'));
}

function printPromptTurnsTable(ctx) {
  const promptTurns = Array.isArray(ctx?.promptTurns) ? ctx.promptTurns : [];
  const repoLabel = getRepoLabel(ctx?.repoInfo);
  const repoTag = repoLabel ? ` ${c.cyan}[${repoLabel}]${c.reset}` : '';
  const out = [];
  out.push(`${c.bold}Prompt 轮次冷热启动分析（倒序）${c.reset} ${c.dim}(${ctx?.conversationTitle || ctx?.conversationId || '无会话'})${c.reset}${repoTag}`);
  out.push(`${c.dim}${'─'.repeat(88)}${c.reset}`);
  if (!promptTurns.length) {
    out.push('暂无 Prompt 轮次记录。');
  } else {
    for (const p of promptTurns.slice(0, 20)) {
      const idxLabel = `#P${p.promptIndex ?? '?'}`.padEnd(4);
      const stateBadge = formatStartupBadge(p.startupState, { compact: true }) || `${c.dim}--${c.reset}`;
      const hitStr = p.startupCacheHitPercent != null ? `${Math.round(Number(p.startupCacheHitPercent))}%` : '--';
      const callsStr = `${p.callsCount ?? 0}次`;
      const d = Number(p.deltaTokens || 0);
      const dRaw = d > 0 ? `+${fmtTok(d)}` : fmtTok(d);
      const dStr = d > 0 ? `${c.yellow}${dRaw}${c.reset}` : d < 0 ? `${c.green}${dRaw}${c.reset}` : `${c.dim}0${c.reset}`;
      const ttftStr = p.ttft != null ? `${Number(p.ttft).toFixed(1)}s` : '--';
      const tpsStr = p.avgTps != null ? `${Math.round(Number(p.avgTps))}t/s` : '--';
      const preview = truncateByWidth(p.promptPreview || '', 30);
      const previewPart = preview ? ` | ${c.dim}${preview}${c.reset}` : '';
      out.push(
        `${idxLabel} | ${stateBadge} ${hitStr.padStart(4)} | ${callsStr.padStart(4)} | 窗口 ${fmtTok(p.endTokens).padStart(7)} (${dStr}) | TTFT ${ttftStr}/${tpsStr}${previewPart}`
      );
    }
  }
  console.log(out.map(formatZh).join('\n'));
}

function printHeavyItemsTable(ctx) {
  const heavyItems = Array.isArray(ctx?.heavyItems) ? ctx.heavyItems : [];
  const repoLabel = getRepoLabel(ctx?.repoInfo);
  const repoTag = repoLabel ? ` ${c.cyan}[${repoLabel}]${c.reset}` : '';
  const out = [];
  out.push(`${c.bold}上下文重度消耗 Top 10 排行${c.reset} ${c.dim}(${ctx?.conversationTitle || ctx?.conversationId || '无会话'})${c.reset}${repoTag}`);
  out.push(`${c.dim}${'─'.repeat(88)}${c.reset}`);
  if (!heavyItems.length) {
    out.push('暂无上下文重度消耗记录。');
  } else {
    for (const [idx, item] of heavyItems.slice(0, 10).entries()) {
      const rankStr = `#${String(item.rank ?? (idx + 1)).padEnd(2)}`;
      const kindStr = `[${formatHeavyKind(item.kind)}]`;
      const labelStr = truncateByWidth(item.label || '--', 28);
      const tokStr = `~${fmtTok(item.estTokens)}`;
      const shareStr = item.sharePercent != null ? `${Number(item.sharePercent).toFixed(1)}%` : '--';
      const preview = truncateByWidth(item.preview || '', 34);
      const previewPart = preview ? ` | ${c.dim}${preview}${c.reset}` : '';
      out.push(
        `${rankStr} | ${c.cyan}${kindStr}${c.reset} ${c.bold}${labelStr}${c.reset} | ${c.yellow}${tokStr.padStart(8)}${c.reset} (${shareStr.padStart(5)})${previewPart}`
      );
    }
  }
  console.log(out.map(formatZh).join('\n'));
}

function printAgentTreeTable(ctx, width) {
  const cols = Math.max(40, Math.min(96, Number(width || process.stdout.columns || 88)));
  const repoLabel = getRepoLabel(ctx?.repoInfo);
  const repoTag = repoLabel ? ` ${c.cyan}[${repoLabel}]${c.reset}` : '';
  const branchTag = formatBranchBadge(ctx?.branchInfo);
  const convLabel = truncateByWidth(ctx?.conversationTitle || ctx?.conversationId || '无会话', Math.max(14, cols - 32));
  const div = `${c.dim}${'─'.repeat(Math.min(cols, 88))}${c.reset}`;
  const out = [];
  out.push(`${c.bold}Swarm / Subagent 整树聚合${c.reset} ${c.dim}(${convLabel})${c.reset}${repoTag}${branchTag}`);
  out.push(div);

  const tree = ctx?.agentTree;
  if (!tree || !(Number(tree.childrenCount || 0) > 0)) {
    out.push('当前会话暂无 Swarm 或 Subagent 子代理记录。');
    if (ctx?.conversationId) {
      const st = ctx?.context?.sessionTotals || {};
      out.push(`${c.dim}单会话累计：吞吐 ${fmtTok(st.totalTokens)} · 参考折算 ${fmtUsd(ctx?.context?.sessionCostUSD || 0, 4)}${c.reset}`);
    }
    console.log(out.map(formatZh).join('\n'));
    return;
  }

  const modeBadge = tree.isSwarm ? `${c.magenta}[Swarm]${c.reset}` : `${c.cyan}[Subagent]${c.reset}`;
  const titleMax = Math.max(12, cols - 34);
  const treeTitle = truncateByWidth(tree.swarmTitle || ctx?.conversationTitle || '多代理协同任务', titleMax);
  const activeN = Number(tree.activeChildrenCount || 0);
  const totalN = Number(tree.childrenCount || 0);
  out.push(`${modeBadge} ${c.bold}${treeTitle}${c.reset}  ${c.dim}活跃 ${activeN} / 共 ${totalN} 个子代理${c.reset}`);

  const children = Array.isArray(tree.children) ? tree.children : [];
  if (children.length === 0) {
    out.push(`${c.dim}  暂无子代理明细项。${c.reset}`);
  } else {
    out.push('');
    const narrow = cols < 74;
    for (const [idx, ch] of children.entries()) {
      const idxStr = `#${String(idx + 1).padEnd(2)}`;
      const rawName = ch?.name || (ch?.id ? String(ch.id).slice(0, 8) : '未命名');
      const nameW = narrow ? Math.max(10, Math.min(18, cols - 26)) : 16;
      const nameStr = padEndByWidth(truncateByWidth(rawName, nameW), nameW);
      const roleText = ch?.role ? truncateByWidth(String(ch.role), narrow ? 10 : 12) : '--';
      const roleStr = `[${roleText}]`;
      const stateStr = formatAgentState(ch?.state, { padWidth: narrow ? 0 : 6 });
      const modelRaw = formatShortModel(ch?.model) || ch?.model || '--';
      const modelStr = truncateByWidth(modelRaw, narrow ? Math.max(10, cols - 34) : 14);
      const turnsStr = `${Number(ch?.turnsCount || 0)} 轮`;
      const tokStr = fmtTok(ch?.totalTokens ?? 0);
      const costStr = formatCostAdaptive(ch?.costUSD || 0);

      if (narrow) {
        out.push(`${c.dim}${idxStr}${c.reset} ${c.bold}${truncateByWidth(rawName, nameW)}${c.reset} ${c.cyan}${roleStr}${c.reset} · ${stateStr}`);
        out.push(`    ${c.dim}${modelStr}${c.reset} · ${turnsStr} · ${tokStr} · ${c.yellow}${costStr}${c.reset}`);
      } else {
        out.push(
          `${c.dim}${idxStr}${c.reset} ${c.bold}${nameStr}${c.reset} ${c.cyan}${padEndByWidth(roleStr, 14)}${c.reset} ${stateStr} | ${padEndByWidth(modelStr, 14)} | ${turnsStr.padStart(5)} | ${tokStr.padStart(7)} | ${c.yellow}${costStr.padStart(7)}${c.reset}`
        );
      }
    }
  }

  const tt = tree.treeTotals || {};
  out.push(div);
  const totalBody = truncateByWidth(
    formatZh(`共 ${Number(tt.turnsCount || 0)} 轮 · 吞吐 ${fmtTok(tt.totalTokens ?? 0)} (缓存 ${fmtTok(tt.cacheTokens ?? 0)} / 新增 ${fmtTok(tt.inputTokens ?? 0)} / 输出 ${fmtTok(tt.outputTokens ?? 0)})`),
    Math.max(20, cols - 10)
  );
  out.push(`整树合计  ${c.bold}${totalBody}${c.reset}`);
  const saveNum = Number(tt.cacheSavingsUSD || 0);
  const savePart = saveNum > 0 ? `  ·  ${c.green}缓存省 ${fmtUsd(saveNum, 2)}${c.reset}` : '';
  out.push(`费用合计  参考折算 ${c.bold}${fmtUsd(tt.costUSD ?? 0, 2)}${c.reset}${savePart}`);
  console.log(out.map(formatZh).join('\n'));
}

function printCompactionsTable(ctx, { full = false, width } = {}) {
  const cols = Math.max(40, Math.min(96, Number(width || process.stdout.columns || 88)));
  const repoLabel = getRepoLabel(ctx?.repoInfo);
  const repoTag = repoLabel ? ` ${c.cyan}[${repoLabel}]${c.reset}` : '';
  const branchTag = formatBranchBadge(ctx?.branchInfo);
  const convLabel = truncateByWidth(ctx?.conversationTitle || ctx?.conversationId || '无会话', Math.max(14, cols - 28));
  const compactions = Array.isArray(ctx?.compactions) ? ctx.compactions : [];
  const div = `${c.dim}${'─'.repeat(Math.min(cols, 88))}${c.reset}`;
  const out = [];
  out.push(`${c.bold}会话上下文压缩历史与摘要${c.reset} ${c.dim}(${convLabel})${c.reset}${repoTag}${branchTag}`);
  out.push(div);

  if (!compactions.length) {
    out.push('当前会话暂无上下文压缩记录。');
    console.log(out.map(formatZh).join('\n'));
    return;
  }

  const totalSaved = compactions.reduce((acc, item) => acc + Math.max(0, Number(item?.savedTokens || 0)), 0);
  const savedSummary = totalSaved > 0 ? ` · 累计释放 ${c.green}${fmtTok(totalSaved)} Token${c.reset}` : '';
  out.push(`共 ${c.bold}${compactions.length}${c.reset} 次压缩${savedSummary}`);
  out.push('');

  let hasFullText = false;
  for (const [idx, item] of compactions.entries()) {
    const cIdx = item?.index ?? (idx + 1);
    const timeStr = formatShortTime(item?.createdAt);
    const beforeStr = fmtTok(item?.beforeTokens);
    const afterStr = fmtTok(item?.afterTokens);
    const savedNum = item?.savedTokens != null ? Number(item.savedTokens) : null;
    const savedStr = savedNum != null ? `-${fmtTok(Math.abs(savedNum))}` : '--';
    const pctStr = item?.savedPercent != null ? ` (-${Number(item.savedPercent).toFixed(1)}%)` : '';
    const stepPart = item?.stepIndex != null && cols >= 64 ? ` ${c.dim}Step ${item.stepIndex}${c.reset}` : '';
    out.push(
      `${c.bold}${c.cyan}#C${cIdx}${c.reset}${stepPart} | ${c.dim}${timeStr}${c.reset} | ${beforeStr} → ${afterStr} | ${c.green}省 ${savedStr}${pctStr}${c.reset}`
    );

    if (item?.summaryFull) hasFullText = true;
    if (full) {
      const fullText = String(item?.summaryFull || item?.summaryPreview || '').trim();
      if (fullText) {
        for (const rawLine of fullText.split(/\r?\n/)) {
          out.push(`    ${rawLine}`);
        }
      } else {
        out.push(`    ${c.dim}（无压缩摘要原文）${c.reset}`);
      }
    } else {
      const previewMax = Math.max(16, cols - 10);
      const preview = truncateByWidth(item?.summaryPreview || '', previewMax);
      out.push(`    ${c.dim}摘要：${preview || '（无摘要预览）'}${c.reset}`);
    }
  }

  if (!full && hasFullText) {
    out.push('');
    out.push(`${c.dim}提示：追加 --full 可打印完整压缩摘要原文（agy-context compact --full）。${c.reset}`);
  }
  console.log(out.map(formatZh).join('\n'));
}

function printDiagnosticsReport(hist, width) {
  const cols = Math.max(40, Math.min(96, Number(width || process.stdout.columns || 88)));
  const diag = hist?.diagnostics || null;
  const evSum = diag?.eventsSummary || {};
  const rtSum = diag?.routingSummary || {};
  const recentEvents = Array.isArray(diag?.recentEvents) ? diag.recentEvents : [];
  const recentRouting = Array.isArray(diag?.recentRouting) ? diag.recentRouting : [];
  const byProject = Array.isArray(hist?.analyticsBySource?.all?.byProject) ? hist.analyticsBySource.all.byProject : [];
  const sourceMode = diag?.sqliteEnabled ? 'SQLite + Transcript' : 'Transcript（未启用 SQLite）';
  const div = `${c.dim}${'─'.repeat(Math.min(cols, 88))}${c.reset}`;
  const narrow = cols < 74;

  const out = [];
  out.push(`${c.bold}${c.magenta}◈ 跨会话取证诊断与项目消耗报告${c.reset} ${c.dim}(${sourceMode})${c.reset}`);
  out.push(div);

  // 1. 异常事件汇总与最近 10 条事件明细
  out.push(`${c.bold}1. 异常事件汇总${c.reset} ${c.dim}(数据源：${sourceMode})${c.reset}`);
  const evTotal = Number(evSum.total || 0);
  const ev429 = Number(evSum.quota429 || 0);
  const evSafety = Number(evSum.safetyFilter || 0);
  const evWasted = Number(evSum.safetyWastedUSD || 0);
  const evRetry = Number(evSum.upstreamRetry || 0);
  const evOverflow = Number(evSum.contextOverflow || 0);
  const evSummaryLine = `总计 ${evTotal} 次 · 429 限流 ${ev429} · 安全过滤 ${evSafety} (浪费 ${fmtUsd(evWasted, 2)}) · 上游重试 ${evRetry} · 上下文溢出 ${evOverflow}`;
  out.push(`  ${truncateByWidth(formatZh(evSummaryLine), Math.max(20, cols - 2))}`);

  if (recentEvents.length === 0) {
    out.push(`  ${c.dim}暂无异常事件记录。${c.reset}`);
  } else {
    out.push(`${c.dim}  最近 ${Math.min(10, recentEvents.length)} 条异常事件明细：${c.reset}`);
    for (const ev of recentEvents.slice(0, 10)) {
      const kindTag = formatEventKind(ev?.kind);
      const timeStr = ev?.createdAt ? formatShortTime(ev.createdAt) : (ev?.date || '--');
      const convName = truncateByWidth(ev?.convTitle || (ev?.convId ? String(ev.convId).slice(0, 8) : '--'), narrow ? 16 : 18);
      const wastedPart = Number(ev?.wastedUSD || 0) > 0 ? ` ${c.red}浪费 ${formatCostAdaptive(ev.wastedUSD)}${c.reset}` : '';
      const detailRaw = cleanOneLine(ev?.detail || '');
      if (narrow) {
        out.push(`  ${kindTag} ${c.dim}${timeStr}${c.reset} ${convName}${wastedPart}`);
        if (detailRaw) {
          out.push(`    ${c.dim}${truncateByWidth(detailRaw, Math.max(16, cols - 4))}${c.reset}`);
        }
      } else {
        const detailMax = Math.max(14, cols - 48);
        const detailPart = detailRaw ? ` | ${c.dim}${truncateByWidth(detailRaw, detailMax)}${c.reset}` : '';
        out.push(`  ${kindTag} ${c.dim}${timeStr}${c.reset} | ${convName}${wastedPart}${detailPart}`);
      }
    }
  }

  // 2. 服务端灰度路由汇总与最近 8 条切模记录
  out.push('');
  out.push(`${c.bold}2. 服务端灰度路由汇总${c.reset}`);
  const rtTotal = Number(rtSum.total || 0);
  const rtModels = Number(rtSum.uniqueModels || 0);
  out.push(`  累计切模 ${c.bold}${rtTotal}${c.reset} 次 · 涉及模型 ${c.bold}${rtModels}${c.reset} 个`);
  if (recentRouting.length === 0) {
    out.push(`  ${c.dim}暂无服务端灰度路由或切模记录。${c.reset}`);
  } else {
    out.push(`${c.dim}  最近 ${Math.min(8, recentRouting.length)} 条切模记录：${c.reset}`);
    for (const r of recentRouting.slice(0, 8)) {
      const timeStr = r?.createdAt ? formatShortTime(r.createdAt) : (r?.date || '--');
      const modelW = narrow ? Math.max(10, Math.floor((cols - 16) / 2)) : (cols >= 84 ? 24 : 20);
      const reqM = truncateByWidth(r?.requestedModel || '--', modelW);
      const resM = truncateByWidth(r?.respondedModel || '--', modelW);
      const convName = truncateByWidth(r?.convTitle || (r?.convId ? String(r.convId).slice(0, 8) : ''), 16);
      const reasonStr = r?.reason ? ` (${truncateByWidth(r.reason, 18)})` : '';
      if (narrow) {
        out.push(`  ${c.dim}${timeStr}${c.reset} ${c.cyan}${reqM}${c.reset} → ${c.yellow}${resM}${c.reset}`);
        if (convName || reasonStr) {
          out.push(`    ${c.dim}${truncateByWidth(`${convName}${reasonStr}`, Math.max(16, cols - 4))}${c.reset}`);
        }
      } else {
        const usedCols = 2 + stringDisplayWidth(timeStr) + 3 + stringDisplayWidth(reqM) + 3 + stringDisplayWidth(resM) + 3;
        const extraMax = Math.max(10, cols - usedCols);
        const extra = (convName || reasonStr) && extraMax >= 10
          ? ` | ${c.dim}${truncateByWidth(`${convName}${reasonStr}`, extraMax)}${c.reset}`
          : '';
        out.push(`  ${c.dim}${timeStr}${c.reset} | ${c.cyan}${reqM}${c.reset} → ${c.yellow}${resM}${c.reset}${extra}`);
      }
    }
  }

  // 3. 按项目 / 工作区消耗排行 Top 10
  out.push('');
  out.push(`${c.bold}3. 按项目 / 工作区消耗排行 Top 10${c.reset}`);
  if (byProject.length === 0) {
    out.push(`  ${c.dim}暂无项目 / 工作区维度消耗统计。${c.reset}`);
  } else {
    const nameW = narrow ? Math.max(10, Math.min(20, cols - 20)) : Math.max(14, Math.min(24, cols - 56));
    for (const [idx, proj] of byProject.slice(0, 10).entries()) {
      const rankStr = `#${String(idx + 1).padEnd(2)}`;
      const pName = truncateByWidth(proj?.name || '未归类工作区', nameW);
      const convsStr = `${Number(proj?.conversations || 0)} 会话`;
      const tokStr = fmtTok(proj?.tokens ?? 0);
      const saveStr = fmtUsd(proj?.cacheSavingsUSD || 0, 2);
      const costStr = fmtUsd(proj?.costUSD || 0, 2);
      if (narrow) {
        out.push(`  ${c.dim}${rankStr}${c.reset} ${c.bold}${pName}${c.reset} ${c.dim}(${convsStr})${c.reset}`);
        out.push(`    ${tokStr} · ${c.green}省 ${saveStr}${c.reset} · ${c.yellow}折算 ${costStr}${c.reset}`);
      } else {
        out.push(
          `  ${c.dim}${rankStr}${c.reset} ${c.bold}${padEndByWidth(pName, nameW)}${c.reset} | ${convsStr.padStart(6)} | ${tokStr.padStart(7)} | ${c.green}缓存省 ${saveStr.padStart(7)}${c.reset} | ${c.yellow}折算 ${costStr.padStart(7)}${c.reset}`
        );
      }
    }
  }

  out.push(div);
  console.log(out.map(formatZh).join('\n'));
}

async function readStdinBounded(timeoutMs = 150) {
  if (process.stdin.isTTY) return '';
  return new Promise((resolvePromise) => {
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onErr);
      try { process.stdin.pause(); } catch {}
      resolvePromise(Buffer.concat(chunks).toString('utf8'));
    };
    const onData = (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const onEnd = () => finish();
    const onErr = () => finish();
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onErr);
    process.stdin.resume();
  });
}

function getFlagValue(rawArgs, flagName) {
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === flagName && rawArgs[i + 1] && !rawArgs[i + 1].startsWith('-')) {
      return rawArgs[i + 1];
    }
    if (a.startsWith(`${flagName}=`)) {
      return a.slice(flagName.length + 1);
    }
  }
  return '';
}

function stripFormatTags(str) {
  return String(str || '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/#\[[^\]]*\]/g, '');
}

function formatShortModel(modelName) {
  const s = String(modelName || '').trim();
  if (!s || s === '未记录模型' || s === '未识别模型') return '';
  return s
    .replace(/\s*\((?:high|medium|low|xhigh|max|minimal)\)\s*$/i, '')
    .replace(/^Gemini\s+\d+(?:\.\d+)?\s+/i, '')
    .replace(/^Claude\s+/i, '')
    .trim();
}

function formatUsdCompact(usd) {
  const n = Number(usd || 0);
  if (!(n > 0)) return '';
  if (n >= 10) return `$${n.toFixed(1)}`;
  if (n >= 0.1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

function pickQuotaPool(ctx, modelDisplay) {
  if (ctx?.context?.quota) return ctx.context.quota;
  const quotas = Array.isArray(ctx?.quotas) ? ctx.quotas : [];
  if (!quotas.length) return null;
  const lower = String(modelDisplay || '').toLowerCase();
  const isThirdParty = /\b(?:claude|anthropic|opus|sonnet|haiku|gpt|openai)\b/.test(lower);
  if (isThirdParty) {
    return quotas.find((q) => /非\s*gemini|claude|gpt/i.test(String(q.displayTitle || q.title || q.label || ''))) || quotas[0];
  }
  return quotas.find((q) => /gemini/i.test(String(q.displayTitle || q.title || q.label || '')) && !/非\s*gemini/i.test(String(q.displayTitle || q.title || q.label || ''))) || quotas[0];
}

function paintTag(text, colorKey, format) {
  if (!text) return '';
  if (format === 'plain') return text;
  if (format === 'tmux') {
    const tmuxMap = {
      cyan: '#[fg=cyan]',
      green: '#[fg=green]',
      yellow: '#[fg=yellow]',
      red: '#[fg=red]',
      magenta: '#[fg=magenta]',
      dim: '#[fg=colour244]',
      bold: '#[bold]'
    };
    const prefix = tmuxMap[colorKey] || '';
    return prefix ? `${prefix}${text}#[default]` : text;
  }
  const ansiMap = {
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    magenta: '\x1b[35m',
    dim: '\x1b[2m',
    bold: '\x1b[1m'
  };
  const prefix = ansiMap[colorKey] || '';
  return prefix ? `${prefix}${text}\x1b[0m` : text;
}

function buildStatuslineText(ctx, stdinPayload = {}, { format = 'ansi', terminalWidth = 80 } = {}) {
  const cx = ctx?.context || {};
  const sp = ctx?.speed || {};
  const stdinCw = stdinPayload?.context_window || {};
  const stdinCur = stdinCw?.current_usage || {};
  const rawStdinModel = stdinPayload?.model?.display_name || stdinPayload?.model?.id || '';
  const modelDisplay = (cx.model && cx.model !== '未记录模型')
    ? cx.model
    : (rawStdinModel ? formatModelDisplayName(rawStdinModel) : '');
  const shortModel = formatShortModel(modelDisplay);

  const curInput = Number(stdinCur.input_tokens || 0);
  const curCacheRead = Number(stdinCur.cache_read_input_tokens || 0);
  const curCacheCreate = Number(stdinCur.cache_creation_input_tokens || 0);
  const curOutput = Number(stdinCur.output_tokens || 0);
  const stdinCurTotal = curInput + curCacheRead + curCacheCreate + curOutput;

  let usedTokens = cx.used ?? null;
  if (usedTokens === null && stdinCurTotal > 0) {
    usedTokens = stdinCurTotal;
  } else if (stdinCurTotal > 0 && cx.actual != null && stdinCurTotal > cx.actual && !(cx.pendingTokens > 0)) {
    usedTokens = stdinCurTotal;
  }

  const stdinBudget = Number(stdinCw.context_window_size || 0) > 0 ? Number(stdinCw.context_window_size) : null;
  const budgetTokens = cx.budget || stdinBudget || null;
  const usedPercent = (usedTokens !== null && budgetTokens > 0)
    ? Number(((usedTokens / budgetTokens) * 100).toFixed(1))
    : null;

  const stdinPromptSum = curInput + curCacheCreate + curCacheRead;
  const cacheHitPercent = cx.cacheHitPercent != null
    ? cx.cacheHitPercent
    : (stdinPromptSum > 0 ? Number(((curCacheRead / stdinPromptSum) * 100).toFixed(1)) : null);

  const latestTps = sp.streamingTps ?? sp.tps ?? null;
  const sessionCost = cx.sessionCostUSD > 0 ? cx.sessionCostUSD : null;
  const quotaPool = pickQuotaPool(ctx, modelDisplay);

  const pctColor = usedPercent == null
    ? 'cyan'
    : (usedPercent >= 90 ? 'red' : usedPercent >= 75 ? 'yellow' : 'green');

  const compactMode = terminalWidth < 68;
  const segments = [];

  if (shortModel && !compactMode) {
    segments.push({ prio: 2, text: paintTag(`◈ ${shortModel}`, 'magenta', format) });
  }

  if (usedTokens !== null && usedTokens > 0) {
    const usedPart = budgetTokens > 0
      ? (compactMode ? `${usedPercent}%` : `${fmtTok(usedTokens)}/${fmtTok(budgetTokens)} (${usedPercent}%)`)
      : fmtTok(usedTokens);
    const prefix = (shortModel && !compactMode) ? '' : '◈ ';
    segments.push({ prio: 1, text: paintTag(`${prefix}${usedPart}`, pctColor, format) });
  } else {
    const prefix = (shortModel && !compactMode) ? '' : '◈ ';
    segments.push({ prio: 1, text: paintTag(`${prefix}就绪`, 'dim', format) });
  }

  if (cacheHitPercent !== null && cacheHitPercent >= 0) {
    const turnsCount = Number(ctx?.turns?.length || 0);
    const isColdFirstHop = cx.latestPromptStartup?.state === 'cold' && Number(cx.latestPromptStartup?.callsCount || 0) <= 1;
    const isColdRestart = turnsCount > 1 && (cacheHitPercent < 25 || isColdFirstHop);
    if (isColdRestart) {
      const coldColor = cacheHitPercent < 10 ? 'red' : 'yellow';
      segments.push({ prio: 3, text: paintTag(`❄C ${Math.round(cacheHitPercent)}%`, coldColor, format) });
    } else {
      segments.push({ prio: 3, text: paintTag(`C ${Math.round(cacheHitPercent)}%`, cacheHitPercent > 0 ? 'dim' : 'yellow', format) });
    }
  }

  if (latestTps !== null && latestTps > 0) {
    segments.push({ prio: 3, text: paintTag(`⚡ ${Math.round(latestTps)}t/s`, 'cyan', format) });
  }

  const costStr = formatUsdCompact(sessionCost);
  if (costStr) {
    segments.push({ prio: 4, text: paintTag(costStr, 'yellow', format) });
  }

  if (quotaPool) {
    const p5 = typeof quotaPool.fiveHour?.remainingPercent === 'number'
      ? Math.round(quotaPool.fiveHour.remainingPercent)
      : (typeof quotaPool.baseRemainingPercent === 'number' ? Math.round(quotaPool.baseRemainingPercent) : null);
    const pW = typeof quotaPool.weekly?.remainingPercent === 'number' ? Math.round(quotaPool.weekly.remainingPercent) : null;
    if (p5 !== null || pW !== null) {
      const qColor = Math.min(p5 ?? 100, pW ?? 100) <= 15 ? 'red' : Math.min(p5 ?? 100, pW ?? 100) <= 40 ? 'yellow' : 'green';
      const qLabel = (p5 !== null && pW !== null && !compactMode)
        ? `⏳ 5h ${p5}%·W ${pW}%`
        : (p5 !== null ? `⏳ 5h ${p5}%` : `⏳ W ${pW}%`);
      segments.push({ prio: 2, text: paintTag(qLabel, qColor, format) });
    }
  }

  const sep = format === 'plain' ? ' | ' : paintTag(' · ', 'dim', format);
  const maxWidth = Math.max(24, Number(terminalWidth || 80) - 4);
  const kept = [...segments];
  const renderList = (list) => list.map((s) => s.text).join(sep);

  while (kept.length > 1 && stripFormatTags(renderList(kept)).length > maxWidth) {
    let dropIdx = -1;
    let maxPrio = -1;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (kept[i].prio > maxPrio) {
        maxPrio = kept[i].prio;
        dropIdx = i;
      }
    }
    if (dropIdx >= 0 && maxPrio > 1) {
      kept.splice(dropIdx, 1);
    } else {
      break;
    }
  }

  return renderList(kept);
}

async function runStatuslineCommand(rawArgs) {
  const positionals = rawArgs.filter((a) => !a.startsWith('-'));
  const sub = (positionals[1] || '').toLowerCase();
  const wantJson = rawArgs.includes('--json');

  if (['install', 'enable', 'on', 'off', 'disable', 'uninstall', 'remove', 'delete', 'status'].includes(sub)) {
    const cliEntryPath = resolve(__dirname, 'cli.mjs');
    const res = sub === 'status'
      ? getCliStatusLineConfig()
      : setCliStatusLineConfig({
          action: sub,
          stackWithDefault: !rawArgs.includes('--replace'),
          cliEntryPath
        });
    if (wantJson) {
      console.log(JSON.stringify(res, null, 2));
      if (!res.ok) process.exitCode = 1;
      return;
    }
    if (!res.ok) {
      console.error(formatZh(`${c.red}✗${c.reset} ${res.error || '操作失败'}`));
      process.exitCode = 1;
      return;
    }
    if (sub === 'status') {
      const stateIcon = res.enabled ? `${c.green}●${c.reset}` : `${c.dim}○${c.reset}`;
      const stateText = res.enabled
        ? `已开启（${res.stackWithDefault ? '与内置状态栏叠加' : '替换内置状态栏'}）`
        : (res.configured ? '已配置但当前暂停' : '未配置');
      console.log(formatZh(`${stateIcon} agy CLI 底部状态栏：${stateText}`));
      if (res.command) console.log(formatZh(`  命令：${res.command}`));
      console.log(formatZh(`  配置：${res.settingsPath}`));
      return;
    }
    console.log(formatZh(`${c.green}✓${c.reset} ${res.message}`));
    return;
  }

  const stdinRaw = await readStdinBounded(150);
  let stdinPayload = {};
  let hasStdinJson = false;
  if (stdinRaw && stdinRaw.trim()) {
    try {
      const parsed = JSON.parse(stdinRaw);
      if (parsed && typeof parsed === 'object') {
        stdinPayload = parsed;
        hasStdinJson = true;
      }
    } catch {}
  }

  const stdinConvId = String(stdinPayload.conversation_id || stdinPayload.session_id || '').trim();
  const convArg = (
    stdinConvId ||
    (sub && sub !== 'render' ? positionals[1] : '') ||
    (hasStdinJson ? '' : (process.env.ANTIGRAVITY_CONVERSATION_ID || ''))
  ).trim();

  const fmtFlag = getFlagValue(rawArgs, '--format').toLowerCase();
  const format = (rawArgs.includes('--plain') || rawArgs.includes('--no-color') || fmtFlag === 'plain')
    ? 'plain'
    : ((rawArgs.includes('--tmux') || fmtFlag === 'tmux') ? 'tmux' : 'ansi');
  const terminalWidth = Number(stdinPayload.terminal_width || getFlagValue(rawArgs, '--width') || process.stdout.columns || 104);

  const ctx = await scanConversation(convArg, {
    force: false,
    allowDiskCacheWithoutLs: true,
    skipRecentList: Boolean(convArg),
    noFallbackToRecent: hasStdinJson && !stdinConvId,
    skipWorkspaceLookup: true
  });

  const line = buildStatuslineText(ctx, stdinPayload, { format, terminalWidth });
  process.stdout.write(`${line}\n`);
}

function renderWatchPanel(ctx, width = 60, intervalMs = 1500) {
  const cols = Math.max(36, Math.min(92, Number(width || 60)));
  const barW = Math.max(10, Math.min(24, cols - 30));
  const cx = ctx?.context || {};
  const sp = ctx?.speed || {};
  const st = cx.sessionTotals || {};
  const turns = ctx?.turns || [];
  const quotas = ctx?.quotas || [];
  const srcBadge = ctx?.conversationSource === 'cli' ? '[CLI]' : '[Desktop]';
  const nowStr = new Date().toLocaleTimeString('zh-CN', { hour12: false });

  const lines = [];
  lines.push(`${c.bold}${c.magenta}◈ 上下文实时监控${c.reset} ${c.dim}${nowStr}${c.reset}`);
  lines.push(`${c.dim}${'─'.repeat(Math.min(cols, 72))}${c.reset}`);

  if (!ctx?.conversationId) {
    lines.push('暂无本地活跃会话归档。');
  } else {
    const rawTitle = String(ctx.conversationTitle || '未命名会话');
    const repoLabel = getRepoLabel(ctx.repoInfo);
    const idSuffixWidth = 11; // " (12345678)"
    const availWidth = Math.max(10, cols - srcBadge.length - 1 - idSuffixWidth - 2);
    let shortTitle = '';
    let repoPart = '';
    if (repoLabel && availWidth >= 20) {
      const maxRepoW = Math.min(26, Math.floor(availWidth * 0.45));
      const shortRepo = truncateByWidth(repoLabel, Math.max(6, maxRepoW - 3));
      const repoBoxW = stringDisplayWidth(shortRepo) + 3;
      const titleW = Math.max(8, availWidth - repoBoxW);
      shortTitle = truncateByWidth(rawTitle, titleW);
      repoPart = ` ${c.cyan}[${shortRepo}]${c.reset}`;
    } else {
      shortTitle = truncateByWidth(rawTitle, availWidth);
    }
    lines.push(`${c.cyan}${srcBadge}${c.reset} ${c.bold}${shortTitle}${c.reset}${repoPart} ${c.dim}(${ctx.conversationId.slice(0, 8)})${c.reset}`);
    lines.push(`模型  ${c.bold}${cx.model || '未识别模型'}${c.reset}`);
    const pctText = cx.percent != null ? `${cx.percent}%` : '容量未知';
    const budgetText = cx.budget ? fmtTok(cx.budget) : '未知上限';
    lines.push(`水位  ${renderBar(cx.percent, barW)} ${c.bold}${pctText}${c.reset} (${fmtTok(cx.used)}/${budgetText})`);
    const startupState = cx.latestPromptStartup?.state;
    const startupPart = startupState === 'hot'
      ? ` · ${c.green}首跳热${c.reset}`
      : startupState === 'warm'
        ? ` · ${c.yellow}首跳温${c.reset}`
        : startupState === 'cold'
          ? ` · ${c.red}首跳冷${c.reset}`
          : '';
    lines.push(`缓存  ${c.bold}${cx.cacheHitPercent != null ? `${cx.cacheHitPercent}%` : '--'}${c.reset}${startupPart} · 速度 ${c.cyan}${sp.streamingTps ?? sp.tps ?? '--'} t/s${c.reset} · 费用 ${c.yellow}${fmtUsd(cx.sessionCostUSD || 0, 3)}${c.reset}`);
    lines.push(`吞吐  ${turns.length} 轮 · 累计 ${fmtTok(st.totalTokens)} (缓存 ${fmtTok(st.cacheTokens)} / 输出 ${fmtTok(st.outputTokens)})`);
    if (ctx?.agentTree?.childrenCount > 0) {
      const tt = ctx.agentTree.treeTotals || {};
      const treeBody = truncateByWidth(
        formatZh(`含 ${ctx.agentTree.childrenCount} 子代理 · ${fmtTok(tt.totalTokens ?? 0)} · ${fmtUsd(tt.costUSD ?? 0, 2)}`),
        Math.max(12, cols - 6)
      );
      lines.push(`整树  ${c.cyan}${treeBody}${c.reset}`);
    }

    if (turns.length > 0) {
      lines.push('');
      lines.push(`${c.bold}最近轮次（倒序）${c.reset}`);
      for (const t of turns.slice(0, 6)) {
        const d = Number(t.deltaTokens || 0);
        const dStr = d > 0 ? `${c.yellow}+${fmtTok(d)}${c.reset}` : d < 0 ? `${c.green}${fmtTok(d)}${c.reset}` : `${c.dim}0${c.reset}`;
        const tools = (t.tools || []).slice(0, 2).join(', ');
        const toolText = tools ? ` ${c.dim}[${tools}]${c.reset}` : '';
        lines.push(`  #${String(t.turnIndex).padEnd(2)} ${fmtTok(t.totalTokens).padStart(6)} (${dStr}) · ${t.tps ? `${t.tps}t/s` : '--'}${toolText}`);
      }
    }
  }

  if (quotas.length > 0) {
    lines.push('');
    lines.push(`${c.bold}配额池余量${c.reset}${ctx.quotaStatus?.stale ? ` ${c.yellow}(缓存)${c.reset}` : ''}`);
    for (const q of quotas.slice(0, 3)) {
      const p5 = typeof q.fiveHour?.remainingPercent === 'number' ? q.fiveHour.remainingPercent : q.baseRemainingPercent;
      const pW = typeof q.weekly?.remainingPercent === 'number' ? q.weekly.remainingPercent : null;
      const eff = p5 !== null && pW !== null ? Math.min(p5, pW) : (p5 ?? pW ?? q.remainingPercent ?? null);
      const pctStr = (p5 !== null && pW !== null) ? `5h ${p5}% · 周 ${pW}%` : (p5 !== null ? `5h ${p5}%` : (pW !== null ? `周 ${pW}%` : '--'));
      const qTitle = q.displayTitle || q.title || q.label || '模型池';
      lines.push(`  ${renderBar(eff, Math.min(12, barW), true)} ${pctStr} ${c.dim}${qTitle}${c.reset}`);
    }
  }

  lines.push(`${c.dim}${'─'.repeat(Math.min(cols, 72))}${c.reset}`);
  lines.push(`${c.dim}Ctrl+C 退出 · 每 ${(intervalMs / 1000).toFixed(1)}s 自动刷新${c.reset}`);
  return lines.map(formatZh);
}

async function runWatchCommand(rawArgs) {
  const positionals = rawArgs.filter((a) => !a.startsWith('-'));
  const convArg = (positionals[1] || process.env.ANTIGRAVITY_CONVERSATION_ID || '').trim();
  const once = rawArgs.includes('--once');
  const intervalRaw = Number(getFlagValue(rawArgs, '--interval') || 1500);
  const intervalMs = Math.max(500, Math.min(30_000, Number.isFinite(intervalRaw) ? intervalRaw : 1500));

  const fetchAndRender = async () => {
    const ctx = await scanConversation(convArg, {
      force: true,
      allowDiskCacheWithoutLs: true,
      skipWorkspaceLookup: true
    });
    const cols = process.stdout.columns || Number(getFlagValue(rawArgs, '--width') || 64);
    return { ctx, lines: renderWatchPanel(ctx, cols, intervalMs) };
  };

  if (once) {
    const { lines } = await fetchAndRender();
    console.log(lines.join('\n'));
    return;
  }

  let running = true;
  let rendering = false;
  let firstPaint = true;
  const watchers = [];
  let timer = null;
  let debounceTimer = null;

  const paint = async () => {
    if (!running || rendering) return;
    rendering = true;
    try {
      const { lines } = await fetchAndRender();
      const prefix = firstPaint ? '\x1b[2J\x1b[H' : '\x1b[H';
      firstPaint = false;
      const body = lines.map((l) => `${l}\x1b[K`).join('\n');
      process.stdout.write(`${prefix}${body}\x1b[J\n`);
    } catch {} finally {
      rendering = false;
    }
  };

  const cleanup = () => {
    if (!running) return;
    running = false;
    if (timer) clearInterval(timer);
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const w of watchers) {
      try { w.close(); } catch {}
    }
    if (process.stdout.isTTY) process.stdout.write('\x1b[?25h');
  };

  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  if (process.stdout.isTTY) process.stdout.write('\x1b[?25l');

  for (const base of [findCliDataDir(), findAppDataDir()]) {
    const brainDir = join(base, 'brain');
    if (!existsSync(brainDir)) continue;
    try {
      const w = watch(brainDir, { recursive: false }, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => { void paint(); }, 200);
      });
      w.on('error', () => {});
      watchers.push(w);
    } catch {}
  }

  await paint();
  timer = setInterval(() => { void paint(); }, intervalMs);
  await new Promise(() => {});
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes('--sync-manifest')) {
    syncSidebarManifestFromSettings();
    return;
  }
  if (rawArgs.includes('--ensure-menubar')) {
    await controlFloatWindow({ action: 'ensure-menubar' });
    return;
  }
  if (rawArgs.includes('-h') || rawArgs.includes('--help') || rawArgs[0] === 'help') {
    printHelp();
    return;
  }

  const firstPositional = rawArgs.find((a) => !a.startsWith('-')) || 'status';
  const knownCmds = new Set(['status', 'statusline', 'watch', 'turns', 'heavy', 'tree', 'compact', 'events', 'diag', 'projects', 'json', 'web', 'serve', 'open', 'float', 'pin', 'aux', 'menubar', 'sidebar', 'shortcut', 'hotkey', 'aux-shortcut', 'aux-hotkey']);
  const cmd = knownCmds.has(firstPositional.toLowerCase()) ? firstPositional.toLowerCase() : 'status';

  if (cmd === 'statusline') {
    await runStatuslineCommand(rawArgs);
    return;
  }

  if (cmd === 'watch') {
    await runWatchCommand(rawArgs);
    return;
  }

  if (cmd === 'aux') {
    await runAuxCommand(rawArgs);
    return;
  }

  if (cmd === 'aux-shortcut' || cmd === 'aux-hotkey') {
    await runShortcutCommand(rawArgs, { isAux: true });
    return;
  }

  if (cmd === 'shortcut' || cmd === 'hotkey') {
    await runShortcutCommand(rawArgs, { isAux: false });
    return;
  }

  if (cmd === 'menubar') {
    await runMenubarCommand(rawArgs);
    return;
  }

  if (cmd === 'sidebar') {
    runSidebarCommand(rawArgs);
    return;
  }

  if (cmd === 'float' || cmd === 'pin') {
    await runFloatCommand(rawArgs);
    return;
  }

  if (cmd === 'web' || cmd === 'serve' || cmd === 'open') {
    await runWebServer(rawArgs);
    return;
  }

  const positionalRest = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === '--width' && rawArgs[i + 1] && !rawArgs[i + 1].startsWith('-')) {
      i++;
      continue;
    }
    if (!a.startsWith('-')) positionalRest.push(a);
  }
  const convArg = knownCmds.has((positionalRest[0] || '').toLowerCase())
    ? (positionalRest[1] || process.env.ANTIGRAVITY_CONVERSATION_ID || '')
    : (positionalRest[0] || process.env.ANTIGRAVITY_CONVERSATION_ID || '');

  const wantJson = cmd === 'json' || rawArgs.includes('--json');
  const wantFull = rawArgs.includes('--full');
  const widthFlag = Number(getFlagValue(rawArgs, '--width') || 0) || undefined;

  const isEventsCmd = cmd === 'events' || cmd === 'diag' || cmd === 'projects';
  const needContext = wantJson || !isEventsCmd;
  const needHistory = wantJson || isEventsCmd || (cmd !== 'turns' && cmd !== 'heavy' && cmd !== 'tree' && cmd !== 'compact');
  const [ctx, hist] = await Promise.all([
    needContext ? scanConversation(convArg, { force: true, allowDiskCacheWithoutLs: true }) : Promise.resolve({}),
    needHistory ? collectTokenHistory({ force: true, convId: convArg, allowDiskCacheWithoutLs: true }) : Promise.resolve({})
  ]);

  if (wantJson) {
    const payload = wantFull ? { context: ctx, history: hist } : buildCompactSummary(ctx, hist);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (cmd === 'heavy') {
    printHeavyItemsTable(ctx);
    return;
  }

  if (cmd === 'tree') {
    printAgentTreeTable(ctx, widthFlag);
    return;
  }

  if (cmd === 'compact') {
    printCompactionsTable(ctx, { full: wantFull, width: widthFlag });
    return;
  }

  if (isEventsCmd) {
    printDiagnosticsReport(hist, widthFlag);
    return;
  }

  if (cmd === 'turns') {
    const wantPrompts = rawArgs.includes('--prompts');
    const wantHeavy = rawArgs.includes('--heavy');
    const wantCompact = rawArgs.includes('--compact');
    if (wantPrompts || wantHeavy || wantCompact) {
      let printed = false;
      if (wantPrompts) {
        printPromptTurnsTable(ctx);
        printed = true;
      }
      if (wantHeavy) {
        if (printed) console.log('');
        printHeavyItemsTable(ctx);
        printed = true;
      }
      if (wantCompact) {
        if (printed) console.log('');
        printCompactionsTable(ctx, { full: wantFull, width: widthFlag });
      }
    } else {
      printTurnsTable(ctx);
    }
    return;
  }

  printPrettyStatus(ctx, hist);
}

export {
  buildCompactSummary,
  formatZh,
  printAgentTreeTable,
  printCompactionsTable,
  printDiagnosticsReport,
  printPrettyStatus,
  renderWatchPanel
};

const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  const entryCandidates = [
    fileURLToPath(import.meta.url),
    join(PLUGIN_ROOT, 'skills', 'context-viewer', 'scripts', 'status.mjs')
  ];
  const rawArgv = resolve(process.argv[1]);
  let realArgv = rawArgv;
  try { realArgv = realpathSync(rawArgv); } catch {}
  return entryCandidates.some((cand) => {
    const rawCand = resolve(cand);
    let realCand = rawCand;
    try { realCand = realpathSync(rawCand); } catch {}
    return realArgv === realCand || rawArgv === rawCand;
  });
})();

if (isDirectRun) {
  main().catch((err) => {
    console.error(formatZh(`执行失败：${err.message}`));
    process.exitCode = 1;
  });
}
