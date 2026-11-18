#!/usr/bin/env node
/**
 * Cross-platform Terminal Dashboard & CLI Helper for Antigravity Context Viewer.
 *
 * Works seamlessly for both Antigravity Desktop (`agy` App) and `agy` CLI users:
 *   node cli.mjs                  # Pretty ANSI terminal dashboard summary
 *   node cli.mjs status [convId]  # Pretty summary for latest or specified session
 *   node cli.mjs turns [convId]   # Per-turn context delta & tool call timeline
 *   node cli.mjs json [convId]    # Compact JSON summary (add --full for raw payload)
 *   node cli.mjs float [close]    # Open / toggle / close right-side pinned floating window (Option B)
 *   node cli.mjs sidebar [on|off] # Enable / disable / toggle left-sidebar persistent tab (Option A)
 *   node cli.mjs web [--port N]   # Launch standalone Web UI in default browser
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, watch } from 'node:fs';
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..', '..');
const PLUGIN_DIR_ID = basename(PLUGIN_ROOT);
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, 'plugin.json'), 'utf-8')).version || '1.7.11';
  } catch {
    return '1.7.11';
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
    '  agy-context turns [conversationId]              查看最近 20 轮每轮上下文涨跌 (±Delta) 与工具调用明细',
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

function buildCompactSummary(ctx, hist) {
  const cx = ctx.context || {};
  const sp = ctx.speed || {};
  const st = cx.sessionTotals || {};
  const turns = ctx.turns || [];
  const sumAll = hist.analyticsBySource?.all?.summary || {};
  const sumDesktop = hist.analyticsBySource?.desktop?.summary || {};
  const sumCli = hist.analyticsBySource?.cli?.summary || {};
  const costPeriod = hist.analyticsBySource?.all?.costs?.period?.hybrid || {};
  const costAll = hist.analyticsBySource?.all?.costs?.allTime?.hybrid || {};
  const plan = hist.planStatus || {};
  const activeConvMeta = (ctx.recentConversations || []).find((item) => item.id === ctx.conversationId);
  const runtimeEnv = isCliRuntimeEnv() ? 'cli' : 'desktop';
  const convSource = activeConvMeta?.source || ctx.conversationSource || runtimeEnv;

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
      id: ctx.conversationId || null,
      source: convSource,
      title: ctx.conversationTitle || '未命名会话',
      model: cx.model || '未识别模型',
      usedTokens: cx.used ?? null,
      budgetTokens: cx.budget ?? null,
      budgetSource: cx.budgetSource || (cx.budget ? 'server' : 'unknown'),
      pendingTokens: cx.pendingTokens ?? 0,
      usagePercent: cx.percent ?? null,
      usedFormatted: `${fmtTok(cx.used)} / ${cx.budget ? fmtTok(cx.budget) : '未知'} (${cx.percent != null ? `${cx.percent}%` : '容量未知'})`,
      cacheHitPercent: cx.cacheHitPercent ?? null,
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
      status: cx.error?.title || '正常'
    },
    recentTurns: turns.slice(0, 8).map((t) => ({
      turn: t.turnIndex,
      contextTokens: t.totalTokens,
      deltaTokens: t.deltaTokens,
      outputTokens: t.outputTokens,
      tps: t.tps,
      costUSD: t.costUSD,
      tools: t.tools || []
    })),
    globalHistory: {
      totalTokens: fmtTok(sumAll.grandTotalTokens),
      desktopTokens: fmtTok(sumDesktop.grandTotalTokens),
      cliTokens: fmtTok(sumCli.grandTotalTokens),
      todayTokens: fmtTok(sumAll.todayTokens),
      monthTokens: fmtTok(sumAll.monthTokens),
      yearTokens: fmtTok(sumAll.yearTokens),
      conversations: hist.sources?.all?.conversationsCount || 0,
      desktopConversations: hist.sources?.desktop?.conversationsCount || 0,
      cliConversations: hist.sources?.cli?.conversationsCount || 0,
      activeDays: sumAll.activeDaysCount || 0,
      monthHybridCostUSD: Number((costPeriod.totalCostUSD || 0).toFixed(2)),
      allTimeHybridCostUSD: Number((costAll.totalCostUSD || 0).toFixed(2)),
      plan: `${plan.tierName || '未连接宿主'} (${plan.symbol || '$'}${plan.effectivePrice ?? '--'}/${plan.billingCycle || '月'})`
    },
    historyStatus: hist.historyStatus || { state: 'ok', restrictedSources: [], reason: '' },
    quotaStatus: hist.quotaStatus || ctx.quotaStatus || null,
    quotas: (hist.modelQuotas || []).map((q) => {
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
    out.push(`${c.bold}当前会话${c.reset}  ${c.cyan}${srcBadge}${c.reset} ${cv.title} ${c.dim}(${cv.id.slice(0, 8)})${c.reset}`);
    out.push(`活跃模型  ${c.bold}${cv.model}${c.reset}  ·  状态：${cv.status}`);
    const budgetText = cv.budgetTokens ? fmtTok(cv.budgetTokens) : '未知上限';
    const pctText = cv.usagePercent != null ? `${cv.usagePercent}%` : (cv.usedTokens != null ? '容量未知' : '--%');
    const lsBlockedNote = !cv.budgetTokens && (s.quotaStatus?.errorCode === 'EPERM' || s.quotaStatus?.errorCode === 'EACCES')
      ? ' · 沙箱限制暂不可查询语言服务'
      : '';
    out.push(`窗口水位  ${renderBar(cv.usagePercent)} ${c.bold}${pctText}${c.reset}  (${fmtTok(cv.usedTokens)} / ${budgetText}${cv.pendingTokens > 0 ? `，含待发送 +${fmtTok(cv.pendingTokens)}` : ''}${lsBlockedNote})`);
    out.push(`缓存速度  单轮缓存命中 ${c.bold}${cv.cacheHitPercent != null ? `${cv.cacheHitPercent}%` : '--'}${c.reset}  ·  最新 ${c.cyan}${cv.speed.latestTps ? `${cv.speed.latestTps} tok/s` : '--'}${c.reset} (均值 ${cv.speed.avgTps ?? '--'} / 峰值 ${cv.speed.peakTps ?? '--'} tok/s, TTFT ${cv.speed.ttftSec ?? '--'}s)`);
    out.push(`会话吞吐  共 ${cv.sessionTotals.turnsCount} 轮  ·  累计总吞吐 ${c.bold}${fmtTok(cv.sessionTotals.grossTokens)}${c.reset} (缓存 ${fmtTok(cv.sessionTotals.cacheReadTokens)} · 新增输入 ${fmtTok(cv.sessionTotals.freshInputTokens)} · 输出 ${fmtTok(cv.sessionTotals.outputTokens)})`);
    out.push(`参考折算  本轮 ${c.bold}${fmtUsd(cv.roundApiCostUSD, 4)}${c.reset}  ·  全会话累计 ${c.bold}${fmtUsd(cv.sessionApiCostUSD, 4)}${c.reset}`);
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
  out.push(`  费用参考 本月 ${c.bold}${fmtUsd(gh.monthHybridCostUSD)}${c.reset}  ·  历史累计 ${c.bold}${fmtUsd(gh.allTimeHybridCostUSD)}${c.reset}  ·  订阅 ${gh.plan}`);

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
  const modelDisplay = (cx.model && cx.model !== '未记录模型')
    ? cx.model
    : (stdinPayload?.model?.display_name || stdinPayload?.model?.id || '');
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
    segments.push({ prio: 3, text: paintTag(`C ${Math.round(cacheHitPercent)}%`, cacheHitPercent > 0 ? 'dim' : 'yellow', format) });
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
    const maxTitleLen = Math.max(12, cols - 18);
    const rawTitle = String(ctx.conversationTitle || '未命名会话');
    const shortTitle = rawTitle.length > maxTitleLen ? `${rawTitle.slice(0, maxTitleLen - 1)}…` : rawTitle;
    lines.push(`${c.cyan}${srcBadge}${c.reset} ${c.bold}${shortTitle}${c.reset} ${c.dim}(${ctx.conversationId.slice(0, 8)})${c.reset}`);
    lines.push(`模型  ${c.bold}${cx.model || '未识别模型'}${c.reset}`);
    const pctText = cx.percent != null ? `${cx.percent}%` : '容量未知';
    const budgetText = cx.budget ? fmtTok(cx.budget) : '未知上限';
    lines.push(`水位  ${renderBar(cx.percent, barW)} ${c.bold}${pctText}${c.reset} (${fmtTok(cx.used)}/${budgetText})`);
    lines.push(`缓存  ${c.bold}${cx.cacheHitPercent != null ? `${cx.cacheHitPercent}%` : '--'}${c.reset} · 速度 ${c.cyan}${sp.streamingTps ?? sp.tps ?? '--'} t/s${c.reset} · 费用 ${c.yellow}${fmtUsd(cx.sessionCostUSD || 0, 3)}${c.reset}`);
    lines.push(`吞吐  ${turns.length} 轮 · 累计 ${fmtTok(st.totalTokens)} (缓存 ${fmtTok(st.cacheTokens)} / 输出 ${fmtTok(st.outputTokens)})`);

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
  const knownCmds = new Set(['status', 'statusline', 'watch', 'turns', 'json', 'web', 'serve', 'open', 'float', 'pin', 'aux', 'menubar', 'sidebar', 'shortcut', 'hotkey', 'aux-shortcut', 'aux-hotkey']);
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

  const positionalRest = rawArgs.filter((a) => !a.startsWith('-'));
  const convArg = knownCmds.has((positionalRest[0] || '').toLowerCase())
    ? (positionalRest[1] || process.env.ANTIGRAVITY_CONVERSATION_ID || '')
    : (positionalRest[0] || process.env.ANTIGRAVITY_CONVERSATION_ID || '');

  const wantJson = cmd === 'json' || rawArgs.includes('--json');
  const wantFull = rawArgs.includes('--full');

  const [ctx, hist] = await Promise.all([
    scanConversation(convArg, { force: true, allowDiskCacheWithoutLs: true }),
    collectTokenHistory({ force: true, convId: convArg, allowDiskCacheWithoutLs: true })
  ]);

  if (wantJson) {
    const payload = wantFull ? { context: ctx, history: hist } : buildCompactSummary(ctx, hist);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (cmd === 'turns') {
    printTurnsTable(ctx);
    return;
  }

  printPrettyStatus(ctx, hist);
}

main().catch((err) => {
  console.error(formatZh(`执行失败：${err.message}`));
  process.exitCode = 1;
});
