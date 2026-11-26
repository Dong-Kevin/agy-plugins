/**
 * Ultra-fast multi-line layered statusLine renderer & Solo-compatible installer for agy-cli-hud.
 * Hot path avoids importing heavy modules (http/crypto/colab/incremental).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHudPaths, writeJsonAtomic } from './paths.mjs';
import { formatResetCountdown, normalizeAgyQuotaMap } from './quota.mjs';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';

function paint(text, code, useColor) {
  if (!useColor || !code) return text;
  return `${code}${text}${RESET}`;
}

export function formatTokensCompact(n) {
  const num = Number(n || 0);
  if (!Number.isFinite(num) || num <= 0) return '0';
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(num >= 10_000_000 ? 1 : 2)}M`;
  if (num >= 10_000) return `${Math.round(num / 1000)}K`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return String(Math.round(num));
}

export function formatUsdCompact(usd) {
  const num = Number(usd || 0);
  if (!Number.isFinite(num) || num <= 0) return '$0.00';
  if (num >= 100) return `$${Math.round(num)}`;
  if (num >= 10) return `$${num.toFixed(1)}`;
  return `$${num.toFixed(2)}`;
}

function buildBar(percent, width, useColor, { invertSeverity = false } = {}) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((clamped / 100) * width);
  const empty = Math.max(0, width - filled);
  const raw = '█'.repeat(filled) + '░'.repeat(empty);
  if (!useColor) return raw;
  let color = GREEN;
  if (invertSeverity) {
    color = clamped <= 15 ? RED : clamped <= 40 ? YELLOW : GREEN;
  } else {
    color = clamped >= 90 ? RED : clamped >= 75 ? YELLOW : GREEN;
  }
  return `${color}${'█'.repeat(filled)}${DIM}${'░'.repeat(empty)}${RESET}`;
}

function remainingColor(pct) {
  if (pct == null) return DIM;
  if (pct <= 15) return RED;
  if (pct <= 40) return YELLOW;
  return GREEN;
}

function contextColor(pct) {
  if (pct == null) return DIM;
  if (pct >= 90) return RED;
  if (pct >= 75) return YELLOW;
  return GREEN;
}

function cacheColor(pct) {
  if (pct == null) return DIM;
  if (pct >= 70) return CYAN;
  if (pct >= 40) return YELLOW;
  return DIM;
}

function resolveLiveView(stdinPayload, summary) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const payload = stdinPayload && typeof stdinPayload === 'object' ? stdinPayload : null;
  const cw = payload?.context_window && typeof payload.context_window === 'object' ? payload.context_window : null;
  const cu = cw?.current_usage && typeof cw.current_usage === 'object' ? cw.current_usage : null;

  const curIn = Math.max(0, Number(cu?.input_tokens || 0) || 0);
  const curCache = Math.max(0, Number(cu?.cache_read_input_tokens || 0) || 0);
  const curCacheW = Math.max(0, Number(cu?.cache_creation_input_tokens || 0) || 0);
  const curPrompt = curIn + curCache + curCacheW;

  const windowSize = Number(cw?.context_window_size) > 0 ? Number(cw.context_window_size) : 1_000_000;
  let usedPct = typeof cw?.used_percentage === 'number' && Number.isFinite(cw.used_percentage)
    ? Math.max(0, Math.min(100, cw.used_percentage))
    : null;
  if (usedPct === null && curPrompt > 0 && windowSize > 0) {
    usedPct = Math.min(100, (curPrompt / windowSize) * 100);
  }
  const usedTokens = curPrompt > 0
    ? curPrompt
    : (usedPct !== null ? Math.round((usedPct / 100) * windowSize) : 0);

  const convId = String(payload?.conversation_id || payload?.session_id || '').trim() || null;
  const sameSession = !convId || !s.session_id || convId === s.session_id;

  const liveLastCache = curPrompt > 0 ? Number(((curCache / curPrompt) * 100).toFixed(1)) : null;
  const lastCache = liveLastCache ?? (sameSession ? s.last_cache : null);
  const avgCache = (sameSession && s.avg_cache != null) ? s.avg_cache : liveLastCache;
  const coldStart = Boolean(
    (curPrompt >= 8000 && liveLastCache !== null && liveLastCache < 25) ||
    (sameSession && s.cold_start)
  );

  const liveCost = typeof payload?.cost?.total_usd === 'number' && Number.isFinite(payload.cost.total_usd)
    ? payload.cost.total_usd
    : null;
  const sessCost = (sameSession && s.sess_cost > 0) ? s.sess_cost : (liveCost ?? 0);
  const sessSaved = sameSession ? (s.sess_saved || 0) : 0;
  const tps = sameSession ? s.tps : null;

  const livePools = payload?.quota && typeof payload.quota === 'object'
    ? normalizeAgyQuotaMap(payload.quota).pools
    : [];
  const pools = livePools.length ? livePools : (Array.isArray(s.pools) ? s.pools : []);

  const width = Number(payload?.terminal_width) > 0
    ? Number(payload.terminal_width)
    : (Number(process.env.COLUMNS) > 0 ? Number(process.env.COLUMNS) : 120);

  return {
    width,
    usedPct,
    usedTokens,
    windowSize,
    avgCache,
    lastCache,
    coldStart,
    tps,
    sessCost,
    sessSaved,
    todayTokens: s.today_tokens || 0,
    todayCost: s.today_cost || 0,
    monthTokens: s.month_tokens || 0,
    monthCost: s.month_cost || 0,
    pools,
    colab: s.colab || null
  };
}

function formatPoolSegment(pool, { compact = false, useColor = true, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (!pool) return '';
  const tag = pool.id === 'gemini'
    ? (compact ? 'G' : 'Gemini')
    : (compact ? '非G' : '非Gemini');
  const f5 = pool.five_hour_remaining_percent;
  const fw = pool.weekly_remaining_percent;
  if (f5 == null && fw == null) return '';

  if (compact) {
    const p5 = f5 != null ? paint(`${Math.round(f5)}%`, remainingColor(f5), useColor) : '--';
    const pw = fw != null ? paint(`${Math.round(fw)}%`, remainingColor(fw), useColor) : '--';
    return `${paint(tag, DIM, useColor)} ${p5}/${pw}`;
  }

  const parts = [];
  if (f5 != null) {
    const cd = formatResetCountdown(pool.five_hour_resets_at, nowSec);
    const cdStr = cd ? paint(` (${cd})`, DIM, useColor) : '';
    parts.push(`5h ${paint(`余${Math.round(f5)}%`, remainingColor(f5), useColor)}${cdStr}`);
  }
  if (fw != null) {
    parts.push(`周 ${paint(`余${Math.round(fw)}%`, remainingColor(fw), useColor)}`);
  }
  return `${paint(tag, BOLD, useColor)} ${parts.join(' · ')}`;
}

function formatColabCompact(colab, { tierMode = 'wide', useColor = true } = {}) {
  if (!colab) return '';
  const cu = colab.cu != null ? `${Number(colab.cu).toFixed(1)}` : null;
  const gpu = colab.rt?.gpu && colab.rt.gpu !== 'NONE' ? colab.rt.gpu : null;
  if (cu === null && !gpu) return '';

  if (tierMode === 'narrow') {
    return cu !== null ? paint(`CU ${cu}`, MAGENTA, useColor) : '';
  }
  if (tierMode === 'mid') {
    if (cu !== null && gpu) return paint(`CU ${cu} (${gpu})`, MAGENTA, useColor);
    if (cu !== null) return paint(`CU ${cu}`, MAGENTA, useColor);
    return paint(`Colab ${gpu}`, MAGENTA, useColor);
  }
  const bits = [];
  if (gpu) bits.push(gpu);
  if (cu !== null) bits.push(`${cu} CU`);
  return `${paint('Colab', MAGENTA, useColor)} ${bits.join(' · ')}`;
}

function formatColabDetailLine(colab, useColor) {
  if (!colab) return '';
  const parts = [];
  const tier = colab.tier ? `[${colab.tier}]` : '';
  const cuPart = colab.cu != null ? `${Number(colab.cu).toFixed(1)} CU` : '';
  const ratePart = colab.rate != null && colab.rate > 0
    ? `(-${Number(colab.rate).toFixed(1)}/h${colab.hrs != null ? ` ≈${Number(colab.hrs).toFixed(1)}h` : ''})`
    : '';
  const head = [paint('Colab', MAGENTA, useColor), tier ? paint(tier, CYAN, useColor) : '', cuPart, ratePart ? paint(ratePart, DIM, useColor) : '']
    .filter(Boolean)
    .join(' ');
  if (head) parts.push(head);

  if (colab.rt) {
    if (colab.rt.gpu) parts.push(paint(colab.rt.gpu, BOLD, useColor));
    if (colab.rt.ram_u != null && colab.rt.ram_t != null) {
      parts.push(`RAM ${Math.round(colab.rt.ram_u)}/${Math.round(colab.rt.ram_t)}G`);
    }
    if (colab.rt.vram_u != null && colab.rt.vram_t != null) {
      parts.push(`VRAM ${Math.round(colab.rt.vram_u)}/${Math.round(colab.rt.vram_t)}G`);
    }
    if (colab.rt.idle_m != null) {
      const idleColor = colab.rt.idle_m <= 15 ? RED : colab.rt.idle_m <= 30 ? YELLOW : DIM;
      parts.push(paint(`闲置 ${Math.round(colab.rt.idle_m)}m`, idleColor, useColor));
    }
  }
  return parts.join(paint(' · ', DIM, useColor));
}

export function renderStatusLine(stdinPayload, summary, options = {}) {
  const view = resolveLiveView(stdinPayload, summary);
  const linesMode = [1, 2, 3].includes(Number(options.lines))
    ? Number(options.lines)
    : ([1, 2, 3].includes(Number(summary?.lines)) ? Number(summary.lines) : 2);
  const useColor = options.color !== undefined
    ? Boolean(options.color)
    : (summary?.color !== undefined ? Boolean(summary.color) : true);
  const nowSec = options.nowSec || Math.floor(Date.now() / 1000);

  const sep = paint(' · ', DIM, useColor);
  const pipe = paint(' │ ', DIM, useColor);
  const tierMode = view.width >= 105 ? 'wide' : (view.width >= 75 ? 'mid' : 'narrow');

  const gPool = view.pools.find((p) => p.id === 'gemini');
  const ngPool = view.pools.find((p) => p.id === 'non_gemini');

  const pctStr = view.usedPct != null ? paint(`${Math.round(view.usedPct)}%`, contextColor(view.usedPct), useColor) : paint('--', DIM, useColor);
  const tokPair = view.usedTokens > 0
    ? paint(`(${formatTokensCompact(view.usedTokens)}/${formatTokensCompact(view.windowSize)})`, DIM, useColor)
    : '';
  const coldTag = view.coldStart ? paint(' ❄', CYAN, useColor) : '';

  // 1-line compact mode
  if (linesMode === 1) {
    const segs = [];
    if (tierMode === 'wide') {
      segs.push(`Ctx ${buildBar(view.usedPct ?? 0, 8, useColor)} ${pctStr}${tokPair ? ` ${tokPair}` : ''}`);
      if (view.avgCache != null) segs.push(`缓存均值 ${paint(`${Math.round(view.avgCache)}%`, cacheColor(view.avgCache), useColor)}${coldTag}`);
      if (view.todayTokens > 0) segs.push(`今日 ${formatTokensCompact(view.todayTokens)} (${formatUsdCompact(view.todayCost)})`);
      const gp = formatPoolSegment(gPool, { compact: true, useColor, nowSec });
      const ngp = formatPoolSegment(ngPool, { compact: true, useColor, nowSec });
      if (gp) segs.push(gp);
      if (ngp) segs.push(ngp);
      const cb = formatColabCompact(view.colab, { tierMode: 'narrow', useColor });
      if (cb) segs.push(cb);
    } else {
      segs.push(`Ctx ${pctStr}`);
      if (view.avgCache != null) segs.push(`C̄ ${paint(`${Math.round(view.avgCache)}%`, cacheColor(view.avgCache), useColor)}${coldTag}`);
      if (view.todayTokens > 0) segs.push(`今日 ${formatTokensCompact(view.todayTokens)}`);
      const gp = formatPoolSegment(gPool, { compact: true, useColor, nowSec });
      if (gp) segs.push(gp);
    }
    return segs.join(sep);
  }

  // 3-line layered mode
  if (linesMode === 3) {
    const l1 = [];
    const barW = tierMode === 'wide' ? 10 : (tierMode === 'mid' ? 6 : 0);
    l1.push(barW > 0
      ? `Ctx ${buildBar(view.usedPct ?? 0, barW, useColor)} ${pctStr}${tokPair ? ` ${tokPair}` : ''}`
      : `Ctx ${pctStr}`
    );
    if (view.avgCache != null) {
      const turnTail = tierMode === 'wide' && view.lastCache != null ? paint(` (本轮 ${Math.round(view.lastCache)}%)`, DIM, useColor) : '';
      l1.push(`${tierMode === 'wide' ? '缓存均值' : 'C̄'} ${paint(`${Math.round(view.avgCache)}%`, cacheColor(view.avgCache), useColor)}${turnTail}${coldTag}`);
    }
    if (tierMode !== 'narrow' && view.tps) l1.push(`${view.tps} t/s`);
    if (view.sessCost > 0) {
      const savedTail = tierMode === 'wide' && view.sessSaved > 0.01 ? paint(` (省 ${formatUsdCompact(view.sessSaved)})`, GREEN, useColor) : '';
      l1.push(`${tierMode === 'wide' ? '本会话 ' : ''}${formatUsdCompact(view.sessCost)}${savedTail}`);
    }

    const l2Blocks = [];
    const usageBits = [];
    if (view.todayTokens > 0 || view.todayCost > 0) {
      usageBits.push(`今日 ${formatTokensCompact(view.todayTokens)} (${formatUsdCompact(view.todayCost)})`);
    }
    if (tierMode === 'wide' && (view.monthTokens > 0 || view.monthCost > 0)) {
      usageBits.push(`本月 ${formatTokensCompact(view.monthTokens)} (${formatUsdCompact(view.monthCost)})`);
    }
    if (usageBits.length) l2Blocks.push(usageBits.join(sep));
    const gp = formatPoolSegment(gPool, { compact: tierMode !== 'wide', useColor, nowSec });
    const ngp = formatPoolSegment(ngPool, { compact: tierMode !== 'wide', useColor, nowSec });
    if (gp) l2Blocks.push(gp);
    if (ngp) l2Blocks.push(ngp);

    const out = [l1.join(sep)];
    if (l2Blocks.length) out.push(l2Blocks.join(pipe));
    if (view.colab) {
      const l3 = formatColabDetailLine(view.colab, useColor);
      if (l3) out.push(l3);
    }
    return out.join('\n');
  }

  // Default 2-line layered mode
  const l1 = [];
  if (tierMode === 'wide') {
    l1.push(`Ctx ${buildBar(view.usedPct ?? 0, 8, useColor)} ${pctStr}${tokPair ? ` ${tokPair}` : ''}`);
    if (view.avgCache != null) {
      const turnTail = view.lastCache != null ? paint(` (本轮 ${Math.round(view.lastCache)}%)`, DIM, useColor) : '';
      l1.push(`缓存均值 ${paint(`${Math.round(view.avgCache)}%`, cacheColor(view.avgCache), useColor)}${turnTail}${coldTag}`);
    }
    if (view.tps) l1.push(`${view.tps} t/s`);
    if (view.sessCost > 0) l1.push(`本会话 ${formatUsdCompact(view.sessCost)}`);
    if (view.todayTokens > 0 || view.todayCost > 0) {
      l1.push(`今日 ${formatTokensCompact(view.todayTokens)} (${formatUsdCompact(view.todayCost)})`);
    }
  } else if (tierMode === 'mid') {
    l1.push(`Ctx ${buildBar(view.usedPct ?? 0, 6, useColor)} ${pctStr}${tokPair ? ` ${tokPair}` : ''}`);
    if (view.avgCache != null) l1.push(`C̄ ${paint(`${Math.round(view.avgCache)}%`, cacheColor(view.avgCache), useColor)}${coldTag}`);
    if (view.sessCost > 0) l1.push(formatUsdCompact(view.sessCost));
    if (view.todayTokens > 0) l1.push(`今日 ${formatTokensCompact(view.todayTokens)}`);
  } else {
    l1.push(`Ctx ${pctStr}`);
    if (view.avgCache != null) l1.push(`C̄ ${paint(`${Math.round(view.avgCache)}%`, cacheColor(view.avgCache), useColor)}${coldTag}`);
    if (view.todayTokens > 0) l1.push(`今日 ${formatTokensCompact(view.todayTokens)}`);
  }

  const l2Blocks = [];
  const gp = formatPoolSegment(gPool, { compact: tierMode !== 'wide', useColor, nowSec });
  const ngp = formatPoolSegment(ngPool, { compact: tierMode !== 'wide', useColor, nowSec });
  if (gp) l2Blocks.push(gp);
  if (ngp) l2Blocks.push(ngp);
  const cb = formatColabCompact(view.colab, { tierMode, useColor });
  if (cb) l2Blocks.push(cb);

  if (l2Blocks.length === 0) return l1.join(sep);
  return `${l1.join(sep)}\n${l2Blocks.join(pipe)}`;
}

function shellQuote(arg) {
  const s = String(arg);
  if (/^[A-Za-z0-9_./:-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function isSoloBridgeCommand(cmd) {
  return typeof cmd === 'string' && cmd.includes('agent hook agy-statusline');
}

function stripForwardCommand(cmd) {
  const idx = cmd.indexOf(' --forward-command ');
  return idx >= 0 ? cmd.slice(0, idx).trim() : cmd.trim();
}

/**
 * Installs or removes agy-cli-hud statusLine cleanly without clobbering Solo's agy-statusline bridge.
 */
export function configureAgyStatusLine({
  hudCommand = 'agy-hud statusline',
  uninstall = false,
  stackWithDefault = true,
  paths = resolveHudPaths()
} = {}) {
  const settingsPath = paths.cliSettingsPath;
  let doc = {};
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, 'utf8').trim();
    if (raw) {
      doc = JSON.parse(raw);
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        throw new Error(`无效的 settings.json 格式：${settingsPath}`);
      }
    }
  }

  const currentSl = doc.statusLine && typeof doc.statusLine === 'object' ? { ...doc.statusLine } : {};
  const existingCmd = typeof currentSl.command === 'string' ? currentSl.command.trim() : '';

  if (uninstall) {
    if (isSoloBridgeCommand(existingCmd)) {
      if (existingCmd.includes('agy-hud')) {
        currentSl.command = stripForwardCommand(existingCmd);
        doc.statusLine = currentSl;
        writeJsonAtomic(settingsPath, doc, { mode: 0o600, pretty: true });
        return { ok: true, mode: 'solo_preserved', command: currentSl.command, settingsPath };
      }
      return { ok: true, mode: 'noop_solo_preserved', command: existingCmd, settingsPath };
    }
    if (existingCmd.includes('agy-hud')) {
      delete doc.statusLine;
      writeJsonAtomic(settingsPath, doc, { mode: 0o600, pretty: true });
      return { ok: true, mode: 'removed', command: null, settingsPath };
    }
    return { ok: true, mode: 'noop', command: existingCmd || null, settingsPath };
  }

  let nextCmd = hudCommand;
  let mode = 'direct';
  if (isSoloBridgeCommand(existingCmd)) {
    const baseBridge = stripForwardCommand(existingCmd);
    nextCmd = `${baseBridge} --forward-command ${shellQuote(hudCommand)}`;
    mode = 'solo_chained';
  }

  doc.statusLine = {
    ...currentSl,
    type: 'command',
    command: nextCmd,
    enabled: true,
    stack_with_default: Boolean(stackWithDefault)
  };
  writeJsonAtomic(settingsPath, doc, { mode: 0o600, pretty: true });
  return { ok: true, mode, command: nextCmd, settingsPath };
}
