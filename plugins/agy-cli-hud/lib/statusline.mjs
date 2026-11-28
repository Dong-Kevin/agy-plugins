/**
 * Ultra-fast multi-line layered statusLine renderer & Solo-compatible installer for agy-cli-hud.
 * Hot path avoids importing heavy modules (http/crypto/colab/incremental).
 * Uses restrained Catppuccin/Nord/Dracula semantic themes inspired by stormzhang/token-tracker.
 */

import { existsSync, readFileSync } from 'node:fs';
import { formatLocalDateKey, resolveHudPaths, writeJsonAtomic } from './paths.mjs';
import {
  attachWeeklyDailyToPools,
  extractTodayWeeklyUsageMap,
  formatResetCountdown,
  normalizeAgyQuotaMap,
  updateWeeklyQuotaLedger
} from './quota.mjs';
import { detectColorDepth, resolveStatuslineColors, resolveThemeName } from './themes.mjs';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function measureDisplayWidth(str) {
  if (!str) return 0;
  const plain = String(str).replace(ANSI_RE, '');
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    if (
      (cp >= 0x0300 && cp <= 0x036f) ||
      (cp >= 0xfe00 && cp <= 0xfe0f) ||
      cp === 0x200d
    ) {
      continue;
    }
    const isWide =
      cp === 0x2744 ||
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1fbff) ||
      (cp >= 0x20000 && cp <= 0x2fffd);
    w += isWide ? 2 : 1;
  }
  return w;
}

function pickFittingLine(candidates, maxWidth) {
  let last = '';
  for (const fn of candidates) {
    const line = typeof fn === 'function' ? fn() : fn;
    if (!line) continue;
    last = line;
    if (measureDisplayWidth(line) <= maxWidth) return line;
  }
  return last;
}

function paint(text, ansiFg, { dim = false } = {}) {
  if (!text) return '';
  if (!ansiFg) return text;
  return `${dim ? DIM : ''}${ansiFg}${text}${RESET}`;
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

function usageBarColor(pct, C) {
  if (pct >= 80) return C.barDanger;
  if (pct >= 50) return C.barWarn;
  return C.barOk;
}

function remainingColor(pct, C) {
  if (pct == null) return C.muted;
  if (pct <= 15) return C.barDanger;
  if (pct <= 40) return C.barWarn;
  return C.barOk;
}

/**
 * Single-hue semantic progress bar (matching token-tracker):
 * - Filled █ and empty ░ share the same threshold color (░ glyph naturally reads dimmer)
 * - When pct === 0, empty ░ stays muted neutral
 */
function buildBar(percent, width, C) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = clamped > 0 ? Math.max(1, Math.min(width, Math.round((clamped / 100) * width))) : 0;
  const empty = Math.max(0, width - filled);
  const raw = '█'.repeat(filled) + '░'.repeat(empty);
  if (!C.barOk) return raw;
  if (clamped <= 0) return paint(raw, C.muted);
  return paint(raw, usageBarColor(clamped, C));
}

function lookupSummarySession(summary, convId, hasPayload) {
  if (!summary || typeof summary !== 'object') return null;
  if (!hasPayload) {
    return summary.session_id ? summary : null;
  }
  if (!convId) {
    // Official agy CLI contract: blank conversation_id/session_id means a brand-new
    // uninitialized session before the first turn; never inherit prior session metrics.
    return null;
  }
  if (summary.sessions && typeof summary.sessions === 'object' && summary.sessions[convId]) {
    return summary.sessions[convId];
  }
  if (summary.session_id && summary.session_id === convId) {
    return summary;
  }
  return null;
}

function seedLedgerFromSummary(summary, todayKey, nowMs) {
  if (!summary || summary.quota_day !== todayKey || !Array.isArray(summary.pools)) return null;
  const pools = {};
  for (const p of summary.pools) {
    if (!p || !p.id || p.weekly_remaining_percent == null || p.weekly_used_today_percent == null) continue;
    const rem = Math.max(0, Math.min(100, Number(p.weekly_remaining_percent)));
    const used = Math.max(0, Number(p.weekly_used_today_percent) || 0);
    const preReset = Math.max(0, Number(p.weekly_pre_reset_used_percent) || 0);
    const resetCount = Math.max(0, Math.floor(Number(p.weekly_reset_count_today) || 0));
    const postUsed = Math.max(0, used - preReset);
    const cycleStart = resetCount > 0 ? 100 : Math.min(100, Number((rem + postUsed).toFixed(1)));
    pools[p.id] = {
      day_key: todayKey,
      used_today_percent: Number(used.toFixed(1)),
      pre_reset_used_percent: Number(preReset.toFixed(1)),
      reset_count_today: resetCount,
      cycle_start_remaining_percent: cycleStart,
      cycle_min_remaining_percent: rem,
      last_remaining_percent: rem,
      last_resets_at: p.weekly_resets_at ?? null,
      first_observed_at_ms: Number.isFinite(Number(p.weekly_first_observed_at_ms)) ? Number(p.weekly_first_observed_at_ms) : (nowMs - 1),
      last_observed_at_ms: nowMs - 1,
      baseline_complete: p.weekly_baseline_complete !== false,
      unobserved_gap_percent: Math.max(0, Number(p.weekly_unobserved_gap_percent) || 0)
    };
  }
  return Object.keys(pools).length ? { version: 1, updated_at_ms: nowMs - 1, pools } : null;
}

function resolveLiveView(stdinPayload, summary, { nowMs = Date.now(), quotaLedger = null } = {}) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const payload = stdinPayload && typeof stdinPayload === 'object' ? stdinPayload : null;
  const hasPayload = Boolean(payload);
  const cw = payload?.context_window && typeof payload.context_window === 'object' ? payload.context_window : null;
  const cu = cw?.current_usage && typeof cw.current_usage === 'object' ? cw.current_usage : null;

  const curIn = Math.max(0, Number(cu?.input_tokens || 0) || 0);
  const curCache = Math.max(0, Number(cu?.cache_read_input_tokens ?? cu?.cache_read_tokens ?? 0) || 0);
  const curCacheW = Math.max(0, Number(cu?.cache_creation_input_tokens ?? cu?.cache_write_tokens ?? 0) || 0);
  const curPrompt = curIn + curCache + curCacheW;

  const convId = String(payload?.conversation_id || payload?.session_id || '').trim() || null;
  const matched = lookupSummarySession(s, convId, hasPayload);

  const windowSize = Number(cw?.context_window_size) > 0
    ? Number(cw.context_window_size)
    : (!hasPayload && Number(s.ctx_size) > 0 ? Number(s.ctx_size) : 1_000_000);

  let usedPct = typeof cw?.used_percentage === 'number' && Number.isFinite(cw.used_percentage)
    ? Math.max(0, Math.min(100, cw.used_percentage))
    : null;
  if (usedPct === null && curPrompt > 0 && windowSize > 0) {
    usedPct = Math.min(100, (curPrompt / windowSize) * 100);
  }
  if (usedPct === null && !hasPayload && typeof s.ctx_pct === 'number' && Number.isFinite(s.ctx_pct)) {
    usedPct = Math.max(0, Math.min(100, s.ctx_pct));
  }
  const usedTokens = curPrompt > 0
    ? curPrompt
    : (usedPct !== null
        ? Math.round((usedPct / 100) * windowSize)
        : (!hasPayload && Number(s.ctx_used) > 0 ? Number(s.ctx_used) : 0));

  const liveLastCache = curPrompt > 0 ? Number(((curCache / curPrompt) * 100).toFixed(1)) : null;
  const lastCache = liveLastCache ?? (matched && matched.last_cache != null ? matched.last_cache : null);
  const avgCache = (matched && matched.avg_cache != null) ? matched.avg_cache : liveLastCache;
  const coldStart = Boolean(
    (curPrompt >= 8000 && liveLastCache !== null && liveLastCache < 25) ||
    (matched && matched.cold_start)
  );

  const rawLiveCost = payload?.cost?.total_cost_usd ?? payload?.cost?.total_usd;
  const liveCost = typeof rawLiveCost === 'number' && Number.isFinite(rawLiveCost)
    ? rawLiveCost
    : null;
  const sessCost = (matched && matched.sess_cost > 0) ? matched.sess_cost : (liveCost ?? 0);
  const sessSaved = matched ? (matched.sess_saved || 0) : 0;
  const tps = matched ? (matched.tps ?? null) : null;

  const todayKey = formatLocalDateKey(nowMs);
  const livePools = payload?.quota && typeof payload.quota === 'object'
    ? normalizeAgyQuotaMap(payload.quota, { nowMs }).pools
    : [];
  let pools;
  if (livePools.length) {
    const baseLedger = quotaLedger || seedLedgerFromSummary(s, todayKey, nowMs);
    const projected = updateWeeklyQuotaLedger(baseLedger, livePools, { nowMs });
    pools = attachWeeklyDailyToPools(livePools, projected.byPool);
  } else {
    const rawSummaryPools = Array.isArray(s.pools) ? s.pools : [];
    const ledgerByPool = extractTodayWeeklyUsageMap(quotaLedger, todayKey);
    if (Object.keys(ledgerByPool).length > 0) {
      pools = attachWeeklyDailyToPools(rawSummaryPools, ledgerByPool);
    } else if (s.quota_day && s.quota_day !== todayKey) {
      pools = rawSummaryPools.map((p) => ({
        ...p,
        weekly_used_today_percent: null,
        weekly_reset_count_today: 0,
        weekly_pre_reset_used_percent: 0,
        weekly_post_reset_used_percent: null,
        weekly_baseline_complete: null,
        weekly_first_observed_at_ms: null,
        weekly_unobserved_gap_percent: 0
      }));
    } else {
      pools = rawSummaryPools;
    }
  }

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

export function formatWeeklyUsedPercent(v) {
  const num = Number(v);
  if (!Number.isFinite(num) || num < 0) return null;
  if (num === 0) return '0%';
  if (num < 10) {
    const rounded = Number(num.toFixed(1));
    return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
  }
  return `${Math.round(num)}%`;
}

function weeklyUsedColor(pct, C) {
  if (pct >= 35) return C.barDanger;
  if (pct >= 20) return C.barWarn;
  return C.quota;
}

function formatWeeklyUsedTag(pool, C, { style = 'full' } = {}) {
  const raw = pool?.weekly_used_today_percent;
  if (raw == null || !Number.isFinite(Number(raw))) return '';
  const val = Math.max(0, Number(raw));
  const pctStr = formatWeeklyUsedPercent(val);
  if (!pctStr) return '';
  const partialMark = pool?.weekly_baseline_complete === false ? '+' : '';
  const resetMark = Number(pool?.weekly_reset_count_today) > 0 ? '↻' : '';
  const text = style === 'narrow'
    ? `今${pctStr}${partialMark}${resetMark}`
    : `(今用${pctStr}${partialMark}${resetMark})`;
  return paint(text, weeklyUsedColor(val, C), { dim: val === 0 });
}

function formatPoolSegment(pool, { compact = false, mode = null, C, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (!pool) return '';
  const resolvedMode = mode || (compact ? 'compact' : 'full');
  const isGemini = pool.id === 'gemini';
  const tagText = isGemini
    ? (resolvedMode === 'full' ? 'Gemini' : 'G')
    : (resolvedMode === 'full' ? '非Gemini' : '非G');
  const f5 = pool.five_hour_remaining_percent;
  const fw = pool.weekly_remaining_percent;
  if (f5 == null && fw == null) return '';

  const tagStyled = paint(tagText, C.quota);
  if (resolvedMode === 'compact' || resolvedMode === 'narrow') {
    const p5 = f5 != null ? paint(`${Math.round(f5)}%`, remainingColor(f5, C)) : paint('--', C.muted);
    const pw = fw != null ? paint(`${Math.round(fw)}%`, remainingColor(fw, C)) : paint('--', C.muted);
    const slash = paint('/', C.muted);
    const usedTag = fw != null ? formatWeeklyUsedTag(pool, C, { style: resolvedMode }) : '';
    return `${tagStyled} ${p5}${slash}${pw}${usedTag ? ` ${usedTag}` : ''}`;
  }

  const dot = paint(' · ', C.muted);
  const parts = [];
  if (f5 != null) {
    const cd = resolvedMode === 'full' ? formatResetCountdown(pool.five_hour_resets_at, nowSec) : '';
    const cdStr = cd ? ` ${paint(`(${cd})`, C.quota, { dim: true })}` : '';
    parts.push(`${paint('5h', C.quota)} ${paint(`余${Math.round(f5)}%`, remainingColor(f5, C))}${cdStr}`);
  }
  if (fw != null) {
    const usedTag = formatWeeklyUsedTag(pool, C, { style: resolvedMode });
    parts.push(`${paint('周', C.quota)} ${paint(`余${Math.round(fw)}%`, remainingColor(fw, C))}${usedTag ? ` ${usedTag}` : ''}`);
  }
  return `${tagStyled} ${parts.join(dot)}`;
}

function formatColabCompact(colab, { tierMode = 'wide', C } = {}) {
  if (!colab) return '';
  const cu = colab.cu != null ? `${Number(colab.cu).toFixed(1)}` : null;
  const gpu = colab.rt?.gpu && colab.rt.gpu !== 'NONE' ? colab.rt.gpu : null;
  if (cu === null && !gpu) return '';

  if (tierMode === 'narrow') {
    if (cu !== null) return paint(`${cu} CU`, C.colab);
    return gpu ? paint(gpu, C.colab) : '';
  }
  if (tierMode === 'mid') {
    if (cu !== null && gpu) {
      return `${paint(`${cu} CU`, C.colab)} ${paint(`(${gpu})`, C.colab, { dim: true })}`;
    }
    if (cu !== null) return paint(`${cu} CU`, C.colab);
    return paint(`Colab ${gpu}`, C.colab);
  }
  const bits = [];
  if (gpu) bits.push(paint(gpu, C.colab));
  if (cu !== null) bits.push(paint(`${cu} CU`, C.colab));
  return `${paint('Colab', C.colab)} ${bits.join(paint(' · ', C.muted))}`;
}

function formatColabDetailLine(colab, C, { narrow = false, mode = null } = {}) {
  if (!colab) return '';
  const resolvedMode = mode || (narrow ? 'narrow' : 'full');
  const parts = [];
  const tier = colab.tier ? `[${colab.tier}]` : '';
  const cuPart = colab.cu != null ? `${Number(colab.cu).toFixed(1)} CU` : '';
  const headText = ['Colab', tier, cuPart].filter(Boolean).join(' ');
  const ratePart = resolvedMode === 'full' && colab.rate != null && colab.rate > 0
    ? ` ${paint(`(-${Number(colab.rate).toFixed(1)}/h${colab.hrs != null ? ` ≈${Number(colab.hrs).toFixed(1)}h` : ''})`, C.colab, { dim: true })}`
    : '';
  if (headText) parts.push(`${paint(headText, C.colab)}${ratePart}`);

  if (colab.rt) {
    if (colab.rt.gpu) parts.push(paint(colab.rt.gpu, C.colab));
    if (resolvedMode !== 'narrow' && colab.rt.ram_u != null && colab.rt.ram_t != null) {
      parts.push(paint(`RAM ${Math.round(colab.rt.ram_u)}/${Math.round(colab.rt.ram_t)}G`, C.total));
    }
    if (resolvedMode !== 'narrow' && colab.rt.vram_u != null && colab.rt.vram_t != null) {
      parts.push(paint(`VRAM ${Math.round(colab.rt.vram_u)}/${Math.round(colab.rt.vram_t)}G`, C.total));
    }
    if (colab.rt.idle_m != null) {
      const m = Math.round(colab.rt.idle_m);
      const idleColor = m <= 15 ? C.barDanger : (m <= 30 ? C.barWarn : C.total);
      parts.push(paint(`闲置 ${m}m`, idleColor, { dim: m > 30 }));
    }
  }
  return parts.join(paint(' · ', C.muted));
}

function formatTodaySeg(tokens, cost, C, { showCost = true } = {}) {
  const text = showCost
    ? `今日 ${formatTokensCompact(tokens)} (${formatUsdCompact(cost)})`
    : `今日 ${formatTokensCompact(tokens)}`;
  return paint(text, C.total);
}

function formatMonthSeg(tokens, cost, C) {
  return paint(`本月 ${formatTokensCompact(tokens)} (${formatUsdCompact(cost)})`, C.total);
}

function formatSessionCostSeg(sessCost, C, { labeled = true, saved = 0 } = {}) {
  const head = paint(labeled ? `本会话 ${formatUsdCompact(sessCost)}` : formatUsdCompact(sessCost), C.tokens);
  if (saved > 0.01) {
    return `${head} ${paint(`(省 ${formatUsdCompact(saved)})`, C.tokens, { dim: true })}`;
  }
  return head;
}

function formatCacheSeg(avgCache, lastCache, coldStart, C, { compact = false } = {}) {
  const lbl = compact ? 'C̄' : '缓存均值';
  const rounded = Math.round(avgCache);
  const head = rounded < 40
    ? `${paint(lbl, C.tokens)} ${paint(`${rounded}%`, C.barDanger)}`
    : paint(`${lbl} ${rounded}%`, C.tokens);
  const turnTail = !compact && lastCache != null
    ? ` ${paint(`(本轮 ${Math.round(lastCache)}%)`, C.tokens, { dim: true })}`
    : '';
  const coldTag = coldStart ? paint(' ❄', C.barDanger) : '';
  return `${head}${turnTail}${coldTag}`;
}

function formatTpsSeg(tps, C) {
  return paint(`${tps} t/s`, C.tokens);
}

export function renderStatusLine(stdinPayload, summary, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs))
    ? Number(options.nowMs)
    : (Number.isFinite(Number(options.nowSec)) ? Number(options.nowSec) * 1000 : Date.now());
  const nowSec = Number.isFinite(Number(options.nowSec))
    ? Number(options.nowSec)
    : Math.floor(nowMs / 1000);
  const view = resolveLiveView(stdinPayload, summary, {
    nowMs,
    quotaLedger: options.quotaLedger || null
  });
  const linesMode = [1, 2, 3].includes(Number(options.lines))
    ? Number(options.lines)
    : ([1, 2, 3].includes(Number(summary?.lines)) ? Number(summary.lines) : 2);
  const useColor = options.color !== undefined
    ? Boolean(options.color)
    : (summary?.color !== undefined ? Boolean(summary.color) : true);
  const depth = detectColorDepth(useColor, options.colorDepth);
  const themeName = resolveThemeName({
    explicitTheme: options.theme,
    summaryTheme: summary?.theme
  });
  const C = resolveStatuslineColors(themeName, depth);

  const sep = paint(' · ', C.muted);
  const pipe = paint(' │ ', C.muted);
  const tierMode = view.width >= 105 ? 'wide' : (view.width >= 75 ? 'mid' : 'narrow');

  const gPool = view.pools.find((p) => p.id === 'gemini');
  const ngPool = view.pools.find((p) => p.id === 'non_gemini');

  const ctxLabel = paint('Ctx', C.label);
  const pctStr = view.usedPct != null
    ? paint(`${Math.round(view.usedPct)}%`, view.usedPct >= 80 ? C.barDanger : C.label)
    : paint('--', C.muted);
  const tokPair = view.usedTokens > 0
    ? paint(`(${formatTokensCompact(view.usedTokens)}/${formatTokensCompact(view.windowSize)})`, C.label, { dim: true })
    : '';

  const maxW = Math.max(40, Number(view.width) || 120);
  const hasTps = view.tps != null && Number.isFinite(Number(view.tps)) && Number(view.tps) > 0;
  const hasToday = view.todayTokens > 0 || view.todayCost > 0;
  const hasMonth = view.monthTokens > 0 || view.monthCost > 0;

  const buildCtxPart = (barW, includeTok) => (
    barW > 0
      ? `${ctxLabel} ${buildBar(view.usedPct ?? 0, barW, C)} ${pctStr}${includeTok && tokPair ? ` ${tokPair}` : ''}`
      : `${ctxLabel} ${pctStr}`
  );

  const buildQuotaLine = (modes, colabMode = null) => {
    const candidates = modes.map((qMode) => () => {
      const blocks = [];
      const gp = formatPoolSegment(gPool, { mode: qMode, C, nowSec });
      const ngp = formatPoolSegment(ngPool, { mode: qMode, C, nowSec });
      if (gp) blocks.push(gp);
      if (ngp) blocks.push(ngp);
      if (colabMode) {
        const cb = formatColabCompact(view.colab, { tierMode: colabMode, C });
        if (cb) blocks.push(cb);
      }
      return blocks.join(pipe);
    });
    return pickFittingLine(candidates, maxW);
  };

  // 1-line compact mode
  if (linesMode === 1) {
    const buildOneLine = ({ barW, includeTok, compactCache, showTodayCost, includeNg, includeColab }) => {
      const segs = [buildCtxPart(barW, includeTok)];
      if (view.avgCache != null) segs.push(formatCacheSeg(view.avgCache, null, view.coldStart, C, { compact: compactCache }));
      if (hasToday && (showTodayCost || view.todayTokens > 0)) {
        segs.push(formatTodaySeg(view.todayTokens, view.todayCost, C, { showCost: showTodayCost }));
      }
      const gp = formatPoolSegment(gPool, { mode: 'narrow', C, nowSec });
      const ngp = includeNg ? formatPoolSegment(ngPool, { mode: 'narrow', C, nowSec }) : '';
      if (gp) segs.push(gp);
      if (ngp) segs.push(ngp);
      if (includeColab) {
        const cb = formatColabCompact(view.colab, { tierMode: 'narrow', C });
        if (cb) segs.push(cb);
      }
      return segs.join(sep);
    };
    const candidates = tierMode === 'wide'
      ? [
          () => buildOneLine({ barW: 8, includeTok: true, compactCache: false, showTodayCost: true, includeNg: true, includeColab: true }),
          () => buildOneLine({ barW: 6, includeTok: false, compactCache: true, showTodayCost: true, includeNg: true, includeColab: true }),
          () => buildOneLine({ barW: 0, includeTok: false, compactCache: true, showTodayCost: false, includeNg: true, includeColab: true }),
          () => buildOneLine({ barW: 0, includeTok: false, compactCache: true, showTodayCost: false, includeNg: true, includeColab: false }),
          () => buildOneLine({ barW: 0, includeTok: false, compactCache: true, showTodayCost: false, includeNg: false, includeColab: false })
        ]
      : [
          () => buildOneLine({ barW: 0, includeTok: false, compactCache: true, showTodayCost: false, includeNg: false, includeColab: false })
        ];
    return pickFittingLine(candidates, maxW);
  }

  // 3-line layered mode: dedicated quota row (with daily weekly-quota consumption) so every row breathes cleanly
  if (linesMode === 3) {
    const hasColab = Boolean(view.colab);
    const buildL1Three = ({ barW, includeTok, compactCache, includeLastCache, includeTps, includeCost, labelCost, includeSaved, includeToday, showTodayCost }) => {
      const l1 = [buildCtxPart(barW, includeTok)];
      if (view.avgCache != null) {
        l1.push(formatCacheSeg(view.avgCache, includeLastCache ? view.lastCache : null, view.coldStart, C, { compact: compactCache }));
      }
      if (includeTps && hasTps) {
        l1.push(formatTpsSeg(view.tps, C));
      }
      if (includeCost && view.sessCost > 0) {
        l1.push(formatSessionCostSeg(view.sessCost, C, {
          labeled: labelCost,
          saved: includeSaved ? view.sessSaved : 0
        }));
      }
      if (includeToday && hasToday) {
        l1.push(formatTodaySeg(view.todayTokens, view.todayCost, C, { showCost: showTodayCost }));
      }
      return l1.join(sep);
    };

    const l1Candidates = tierMode === 'wide'
      ? [
          () => buildL1Three({ barW: 10, includeTok: true, compactCache: false, includeLastCache: true, includeTps: true, includeCost: true, labelCost: true, includeSaved: !hasColab, includeToday: hasColab, showTodayCost: true }),
          () => buildL1Three({ barW: 8, includeTok: true, compactCache: false, includeLastCache: false, includeTps: true, includeCost: true, labelCost: true, includeSaved: !hasColab, includeToday: hasColab, showTodayCost: true }),
          () => buildL1Three({ barW: 6, includeTok: false, compactCache: true, includeLastCache: false, includeTps: true, includeCost: true, labelCost: false, includeSaved: false, includeToday: hasColab, showTodayCost: true }),
          () => buildL1Three({ barW: 6, includeTok: false, compactCache: true, includeLastCache: false, includeTps: true, includeCost: true, labelCost: false, includeSaved: false, includeToday: hasColab, showTodayCost: false })
        ]
      : (tierMode === 'mid'
          ? [
              () => buildL1Three({ barW: 6, includeTok: true, compactCache: true, includeLastCache: false, includeTps: true, includeCost: true, labelCost: false, includeSaved: false, includeToday: hasColab, showTodayCost: false }),
              () => buildL1Three({ barW: 6, includeTok: false, compactCache: true, includeLastCache: false, includeTps: true, includeCost: true, labelCost: false, includeSaved: false, includeToday: hasColab, showTodayCost: false }),
              () => buildL1Three({ barW: 0, includeTok: false, compactCache: true, includeLastCache: false, includeTps: false, includeCost: true, labelCost: false, includeSaved: false, includeToday: hasColab, showTodayCost: false })
            ]
          : [
              () => buildL1Three({ barW: 0, includeTok: false, compactCache: true, includeLastCache: false, includeTps: false, includeCost: !hasColab, labelCost: false, includeSaved: false, includeToday: hasColab, showTodayCost: false }),
              () => buildL1Three({ barW: 0, includeTok: false, compactCache: true, includeLastCache: false, includeTps: false, includeCost: false, labelCost: false, includeSaved: false, includeToday: hasColab, showTodayCost: false })
            ]);

    const quotaModes3 = tierMode === 'wide'
      ? ['full', 'mid', 'compact', 'narrow']
      : (tierMode === 'mid' ? ['mid', 'compact', 'narrow'] : ['narrow']);
    const quotaRow = buildQuotaLine(quotaModes3);

    const out = [pickFittingLine(l1Candidates, maxW)];
    if (hasColab) {
      if (quotaRow) out.push(quotaRow);
      const l3 = tierMode === 'narrow'
        ? formatColabDetailLine(view.colab, C, { mode: 'narrow' })
        : pickFittingLine([
            () => formatColabDetailLine(view.colab, C, { mode: 'full' }),
            () => formatColabDetailLine(view.colab, C, { mode: 'mid' }),
            () => formatColabDetailLine(view.colab, C, { mode: 'narrow' })
          ], maxW);
      if (l3) out.push(l3);
    } else {
      const usageRow = tierMode === 'narrow'
        ? (hasToday
            ? pickFittingLine([
                () => formatTodaySeg(view.todayTokens, view.todayCost, C, { showCost: true }),
                () => formatTodaySeg(view.todayTokens, view.todayCost, C, { showCost: false })
              ], maxW)
            : '')
        : pickFittingLine([
            () => {
              const bits = [];
              if (hasToday) bits.push(formatTodaySeg(view.todayTokens, view.todayCost, C));
              if (hasMonth) bits.push(formatMonthSeg(view.monthTokens, view.monthCost, C));
              return bits.join(sep);
            },
            () => (hasToday ? formatTodaySeg(view.todayTokens, view.todayCost, C) : '')
          ], maxW);
      if (usageRow) out.push(usageRow);
      if (quotaRow) out.push(quotaRow);
    }
    return out.join('\n');
  }

  // Default 2-line layered mode
  const buildL1Two = ({ barW, includeTok, compactCache, includeLastCache, includeTps, includeCost, labelCost, showTodayCost }) => {
    const l1 = [buildCtxPart(barW, includeTok)];
    if (view.avgCache != null) {
      l1.push(formatCacheSeg(view.avgCache, includeLastCache ? view.lastCache : null, view.coldStart, C, { compact: compactCache }));
    }
    if (includeTps && hasTps) l1.push(formatTpsSeg(view.tps, C));
    if (includeCost && view.sessCost > 0) l1.push(formatSessionCostSeg(view.sessCost, C, { labeled: labelCost }));
    if (hasToday && (showTodayCost || view.todayTokens > 0)) {
      l1.push(formatTodaySeg(view.todayTokens, view.todayCost, C, { showCost: showTodayCost }));
    }
    return l1.join(sep);
  };

  const l1Line = pickFittingLine(
    tierMode === 'wide'
      ? [
          () => buildL1Two({ barW: 8, includeTok: true, compactCache: false, includeLastCache: true, includeTps: true, includeCost: true, labelCost: true, showTodayCost: true }),
          () => buildL1Two({ barW: 8, includeTok: true, compactCache: false, includeLastCache: false, includeTps: true, includeCost: true, labelCost: true, showTodayCost: true }),
          () => buildL1Two({ barW: 6, includeTok: false, compactCache: true, includeLastCache: false, includeTps: true, includeCost: true, labelCost: false, showTodayCost: true })
        ]
      : (tierMode === 'mid'
          ? [
              () => buildL1Two({ barW: 6, includeTok: true, compactCache: true, includeLastCache: false, includeTps: false, includeCost: true, labelCost: false, showTodayCost: false }),
              () => buildL1Two({ barW: 6, includeTok: false, compactCache: true, includeLastCache: false, includeTps: false, includeCost: true, labelCost: false, showTodayCost: false })
            ]
          : [
              () => buildL1Two({ barW: 0, includeTok: false, compactCache: true, includeLastCache: false, includeTps: false, includeCost: false, labelCost: false, showTodayCost: false })
            ]),
    maxW
  );

  const buildL2Pair = (qMode, cMode) => {
    const blocks = [];
    const gp = formatPoolSegment(gPool, { mode: qMode, C, nowSec });
    const ngp = formatPoolSegment(ngPool, { mode: qMode, C, nowSec });
    if (gp) blocks.push(gp);
    if (ngp) blocks.push(ngp);
    if (cMode) {
      const cb = formatColabCompact(view.colab, { tierMode: cMode, C });
      if (cb) blocks.push(cb);
    }
    return blocks.join(pipe);
  };

  const l2Candidates = tierMode === 'wide'
    ? [
        () => buildL2Pair('full', 'wide'),
        () => buildL2Pair('full', 'mid'),
        () => buildL2Pair('full', 'narrow'),
        () => buildL2Pair('mid', 'narrow'),
        () => buildL2Pair('compact', 'narrow')
      ]
    : (tierMode === 'mid'
        ? [
            () => buildL2Pair('compact', 'mid'),
            () => buildL2Pair('compact', 'narrow'),
            () => buildL2Pair('narrow', 'narrow')
          ]
        : [
            () => buildL2Pair('narrow', 'narrow'),
            () => buildL2Pair('narrow', null)
          ]);

  const l2Line = pickFittingLine(l2Candidates, maxW);
  if (!l2Line) return l1Line;
  return `${l1Line}\n${l2Line}`;
}

const SOLO_SURFACE_HOOK_PREFIX =
  'if [ -n "$CLI_AGENTS_SURFACE_ID" ] && [ -x "$CLI_AGENTS_HOOK_CLI" ]; then "$CLI_AGENTS_HOOK_CLI" agent hook agy-statusline';

function shellQuote(arg) {
  const s = String(arg);
  if (!s) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\"'\"'")}'`;
}

function buildSoloSurfaceHookCommand(forward = null) {
  if (forward) {
    const quoted = shellQuote(forward);
    return `${SOLO_SURFACE_HOOK_PREFIX} --forward-command ${quoted}; else /bin/sh -c ${quoted}; fi`;
  }
  return `${SOLO_SURFACE_HOOK_PREFIX}; fi`;
}

/**
 * Non-blocking Solo async bypass wrapper (matches Solo hook_configuration.py `bg_match` verbatim):
 * feeds stdin to Solo's `agy-statusline` observer in a background subshell with redirected stdio
 * while executing the ultra-fast `agy-hud statusline` (~40ms) directly in the foreground so slow
 * Python cold-starts never trip agy CLI's statusLine SIGKILL timeout.
 */
function buildSoloAsyncBypassCommand(hudCommand) {
  return `payload=$(cat); if [ -n "$CLI_AGENTS_SURFACE_ID" ] && [ -x "$CLI_AGENTS_HOOK_CLI" ]; then (printf "%s" "$payload" | "$CLI_AGENTS_HOOK_CLI" agent hook agy-statusline >/dev/null 2>&1 &); fi; printf "%s" "$payload" | ${hudCommand}`;
}

function buildDirectSoloAsyncBypassCommand(baseBridge, hudCommand) {
  return `payload=$(cat); (printf "%s" "$payload" | ${baseBridge} >/dev/null 2>&1 &); printf "%s" "$payload" | ${hudCommand}`;
}

function isSoloBridgeCommand(cmd) {
  return typeof cmd === 'string' && cmd.includes('agent hook agy-statusline');
}

function isSoloShellWrapper(cmd) {
  if (!isSoloBridgeCommand(cmd)) return false;
  const trimmed = cmd.trim();
  return (
    trimmed.includes('$CLI_AGENTS_SURFACE_ID') ||
    trimmed.includes('$CLI_AGENTS_HOOK_CLI') ||
    /^if\s+\[/.test(trimmed)
  );
}

function extractDirectSoloBridge(cmd) {
  const trimmed = String(cmd || '').trim();
  const asyncMatch = trimmed.match(
    /^payload=\$\(cat\);\s*\(printf\s+"%s"\s+"\$payload"\s+\|\s+(.+?)\s*>\/dev\/null\s+2>&1\s*&\);/
  );
  if (asyncMatch) return asyncMatch[1].trim();
  const idx = trimmed.indexOf(' --forward-command ');
  return idx >= 0 ? trimmed.slice(0, idx).trim() : trimmed;
}

/**
 * Installs or removes agy-cli-hud statusLine cleanly without clobbering Solo's agy-statusline bridge.
 * Defaults to non-blocking Solo async bypass (`soloSync: false`) to prevent agy CLI statusLine
 * SIGKILL timeouts caused by Solo's cold Python runtime, while matching Solo's `bg_match` grammar
 * and restoring Solo's canonical `if [ -n "$CLI_AGENTS_SURFACE_ID" ] ...; fi` wrapper on uninstall.
 */
export function configureAgyStatusLine({
  hudCommand = 'agy-hud render',
  uninstall = false,
  stackWithDefault = true,
  soloSync = false,
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
        currentSl.command = isSoloShellWrapper(existingCmd)
          ? buildSoloSurfaceHookCommand(null)
          : extractDirectSoloBridge(existingCmd);
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
  if (isSoloShellWrapper(existingCmd)) {
    if (soloSync) {
      nextCmd = buildSoloSurfaceHookCommand(hudCommand);
      mode = 'solo_chained';
    } else {
      nextCmd = buildSoloAsyncBypassCommand(hudCommand);
      mode = 'solo_async';
    }
  } else if (isSoloBridgeCommand(existingCmd)) {
    const baseBridge = extractDirectSoloBridge(existingCmd);
    if (soloSync) {
      nextCmd = `${baseBridge} --forward-command ${shellQuote(hudCommand)}`;
      mode = 'solo_chained';
    } else {
      nextCmd = buildDirectSoloAsyncBypassCommand(baseBridge, hudCommand);
      mode = 'solo_async';
    }
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
