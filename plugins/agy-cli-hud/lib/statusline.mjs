/**
 * Ultra-fast multi-line layered statusLine renderer & Solo-compatible installer for agy-cli-hud.
 * Hot path avoids importing heavy modules (http/crypto/colab/incremental).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHudPaths, writeJsonAtomic } from './paths.mjs';
import { formatResetCountdown, normalizeAgyQuotaMap } from './quota.mjs';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

// Antigravity Prism Rainbow Palette: [r, g, b, ansi256]
const PALETTE = {
  coral:    [255, 107, 122, 210],
  crimson:  [255,  83, 112, 203],
  orange:   [255, 158, 100, 215],
  amber:    [255, 198,  92, 221],
  gold:     [255, 217, 102, 221],
  lime:     [163, 230,  92, 150],
  mint:     [ 77, 232, 176,  79],
  cyan:     [ 77, 217, 255,  81],
  sky:      [115, 188, 255, 111],
  blue:     [122, 162, 247, 111],
  indigo:   [157, 140, 248, 141],
  violet:   [192, 132, 252, 177],
  pink:     [244, 114, 182, 212],
  rose:     [255, 138, 178, 211],
  peach:    [253, 186, 116, 216],
  aquaSoft: [125, 211, 252, 117],
  lavSoft:  [165, 180, 252, 147],
  slate:    [134, 143, 170, 103],
  muted:    [ 92,  99, 122, 242]
};

const BAR_PRISM_FILLED = [
  PALETTE.coral,
  PALETTE.orange,
  PALETTE.gold,
  [136, 232, 122, 114],
  PALETTE.mint,
  PALETTE.cyan,
  PALETTE.blue,
  PALETTE.violet,
  PALETTE.pink
];

const BAR_PRISM_TRACK = [
  [116,  64,  74,  95],
  [118,  84,  62,  95],
  [116, 102,  62, 101],
  [ 68, 108,  72,  65],
  [ 58, 106,  90,  66],
  [ 56,  98, 116,  67],
  [ 68,  82, 118,  61],
  [ 92,  70, 118,  97],
  [114,  66,  94,  96]
];

const BAR_WARN_STOPS = [PALETTE.gold, PALETTE.amber, PALETTE.orange, PALETTE.coral];
const BAR_CRIT_STOPS = [PALETTE.orange, PALETTE.coral, PALETTE.crimson];

const CTX_GRADIENT = [PALETTE.coral, PALETTE.orange, PALETTE.gold];
const GEMINI_GRADIENT = [PALETTE.cyan, PALETTE.blue, PALETTE.indigo, PALETTE.violet, PALETTE.pink];
const NON_GEMINI_GRADIENT = [PALETTE.coral, PALETTE.orange, PALETTE.gold, PALETTE.rose];
const COLAB_GRADIENT = [PALETTE.gold, PALETTE.orange, PALETTE.coral, PALETTE.pink, PALETTE.violet];

function detectColorDepth(useColor, explicitDepth) {
  if (!useColor) return 'none';
  if (explicitDepth === 'truecolor' || explicitDepth === '256' || explicitDepth === 'none') {
    return explicitDepth;
  }
  const termProgram = String(process.env.TERM_PROGRAM || '');
  if (termProgram === 'Apple_Terminal') return '256';
  const colorTerm = String(process.env.COLORTERM || '');
  if (
    /(truecolor|24bit)/i.test(colorTerm) ||
    /(ghostty|iterm|wezterm|kitty|alacritty|warp|vscode|hyper|rio|tabby)/i.test(termProgram) ||
    Boolean(process.env.WT_SESSION) ||
    Boolean(process.env.CLI_AGENTS_SURFACE_ID)
  ) {
    return 'truecolor';
  }
  return '256';
}

function fgCode(rgb, depth, bold = false) {
  if (depth === 'none' || !rgb) return '';
  const prefix = bold ? BOLD : '';
  if (depth === 'truecolor') {
    return `${prefix}\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
  }
  return `${prefix}\x1b[38;5;${rgb[3]}m`;
}

function paintRgb(text, rgb, depth, { bold = false } = {}) {
  if (!text) return '';
  if (depth === 'none' || !rgb) return text;
  return `${fgCode(rgb, depth, bold)}${text}${RESET}`;
}

function sampleStops(stops, t) {
  if (stops.length === 1) return stops[0];
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (stops.length - 1);
  const idx = Math.min(stops.length - 2, Math.floor(scaled));
  const frac = scaled - idx;
  const a = stops[idx];
  const b = stops[idx + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * frac),
    Math.round(a[1] + (b[1] - a[1]) * frac),
    Math.round(a[2] + (b[2] - a[2]) * frac),
    frac < 0.5 ? a[3] : b[3]
  ];
}

function paintGradient(text, stops, depth, { bold = false } = {}) {
  if (!text) return '';
  if (depth === 'none') return text;
  const chars = Array.from(text);
  if (chars.length <= 1) return paintRgb(text, stops[0], depth, { bold });
  let out = '';
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (ch === ' ') {
      out += ch;
      continue;
    }
    const rgb = sampleStops(stops, i / (chars.length - 1));
    out += `${fgCode(rgb, depth, bold)}${ch}`;
  }
  return `${out}${RESET}`;
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

function buildBar(percent, width, depth, { invertSeverity = false } = {}) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = clamped > 0 ? Math.max(1, Math.min(width, Math.round((clamped / 100) * width))) : 0;
  const empty = Math.max(0, width - filled);
  if (depth === 'none') return '█'.repeat(filled) + '░'.repeat(empty);

  const filledStops = invertSeverity
    ? (clamped <= 15 ? BAR_CRIT_STOPS : clamped <= 40 ? BAR_WARN_STOPS : BAR_PRISM_FILLED)
    : (clamped >= 90 ? BAR_CRIT_STOPS : clamped >= 75 ? BAR_WARN_STOPS : BAR_PRISM_FILLED);

  let out = '';
  const denom = Math.max(1, width - 1);
  for (let i = 0; i < width; i += 1) {
    const t = i / denom;
    if (i < filled) {
      out += `${fgCode(sampleStops(filledStops, t), depth)}█`;
    } else {
      out += `${fgCode(sampleStops(BAR_PRISM_TRACK, t), depth)}░`;
    }
  }
  return `${out}${RESET}`;
}

function remainingRgb(pct) {
  if (pct == null) return PALETTE.slate;
  if (pct <= 15) return PALETTE.crimson;
  if (pct <= 40) return PALETTE.amber;
  if (pct <= 70) return PALETTE.lime;
  if (pct <= 89) return PALETTE.mint;
  return PALETTE.cyan;
}

function contextRgb(pct) {
  if (pct == null) return PALETTE.slate;
  if (pct >= 90) return PALETTE.crimson;
  if (pct >= 75) return PALETTE.amber;
  return PALETTE.orange;
}

function cacheRgb(pct) {
  if (pct == null) return PALETTE.slate;
  if (pct >= 70) return PALETTE.mint;
  if (pct >= 40) return PALETTE.amber;
  return PALETTE.coral;
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

function resolveLiveView(stdinPayload, summary) {
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

function formatPoolSegment(pool, { compact = false, depth = 'truecolor', nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (!pool) return '';
  const isGemini = pool.id === 'gemini';
  const tagText = isGemini
    ? (compact ? 'G' : 'Gemini')
    : (compact ? '非G' : '非Gemini');
  const f5 = pool.five_hour_remaining_percent;
  const fw = pool.weekly_remaining_percent;
  if (f5 == null && fw == null) return '';

  const tagStyled = compact
    ? paintRgb(tagText, isGemini ? PALETTE.sky : PALETTE.orange, depth, { bold: true })
    : paintGradient(tagText, isGemini ? GEMINI_GRADIENT : NON_GEMINI_GRADIENT, depth, { bold: true });

  if (compact) {
    const p5 = f5 != null ? paintRgb(`${Math.round(f5)}%`, remainingRgb(f5), depth, { bold: true }) : paintRgb('--', PALETTE.slate, depth);
    const pw = fw != null ? paintRgb(`${Math.round(fw)}%`, remainingRgb(fw), depth, { bold: true }) : paintRgb('--', PALETTE.slate, depth);
    const slash = paintRgb('/', PALETTE.muted, depth);
    return `${tagStyled} ${p5}${slash}${pw}`;
  }

  const label5h = paintRgb('5h', isGemini ? PALETTE.aquaSoft : PALETTE.peach, depth);
  const labelW = paintRgb('周', isGemini ? PALETTE.lavSoft : PALETTE.rose, depth);
  const dot = paintRgb(' · ', PALETTE.muted, depth);

  const parts = [];
  if (f5 != null) {
    const cd = formatResetCountdown(pool.five_hour_resets_at, nowSec);
    const cdStr = cd ? paintRgb(` (${cd})`, PALETTE.slate, depth) : '';
    parts.push(`${label5h} ${paintRgb(`余${Math.round(f5)}%`, remainingRgb(f5), depth, { bold: true })}${cdStr}`);
  }
  if (fw != null) {
    parts.push(`${labelW} ${paintRgb(`余${Math.round(fw)}%`, remainingRgb(fw), depth, { bold: true })}`);
  }
  return `${tagStyled} ${parts.join(dot)}`;
}

function formatColabCompact(colab, { tierMode = 'wide', depth = 'truecolor' } = {}) {
  if (!colab) return '';
  const cu = colab.cu != null ? `${Number(colab.cu).toFixed(1)}` : null;
  const gpu = colab.rt?.gpu && colab.rt.gpu !== 'NONE' ? colab.rt.gpu : null;
  if (cu === null && !gpu) return '';

  if (tierMode === 'narrow') {
    return cu !== null ? paintRgb(`CU ${cu}`, PALETTE.gold, depth, { bold: true }) : '';
  }
  if (tierMode === 'mid') {
    if (cu !== null && gpu) {
      return `${paintRgb(`CU ${cu}`, PALETTE.gold, depth, { bold: true })} ${paintRgb(`(${gpu})`, PALETTE.violet, depth)}`;
    }
    if (cu !== null) return paintRgb(`CU ${cu}`, PALETTE.gold, depth, { bold: true });
    return `${paintGradient('Colab', COLAB_GRADIENT, depth, { bold: true })} ${paintRgb(gpu, PALETTE.violet, depth, { bold: true })}`;
  }
  const bits = [];
  if (gpu) bits.push(paintRgb(gpu, PALETTE.violet, depth, { bold: true }));
  if (cu !== null) bits.push(paintRgb(`${cu} CU`, PALETTE.gold, depth, { bold: true }));
  const dot = paintRgb(' · ', PALETTE.muted, depth);
  return `${paintGradient('Colab', COLAB_GRADIENT, depth, { bold: true })} ${bits.join(dot)}`;
}

function formatColabDetailLine(colab, depth) {
  if (!colab) return '';
  const parts = [];
  const tier = colab.tier ? `[${colab.tier}]` : '';
  const cuPart = colab.cu != null ? paintRgb(`${Number(colab.cu).toFixed(1)} CU`, PALETTE.gold, depth, { bold: true }) : '';
  const ratePart = colab.rate != null && colab.rate > 0
    ? paintRgb(`(-${Number(colab.rate).toFixed(1)}/h${colab.hrs != null ? ` ≈${Number(colab.hrs).toFixed(1)}h` : ''})`, PALETTE.slate, depth)
    : '';
  const head = [
    paintGradient('Colab', COLAB_GRADIENT, depth, { bold: true }),
    tier ? paintRgb(tier, PALETTE.cyan, depth, { bold: true }) : '',
    cuPart,
    ratePart
  ]
    .filter(Boolean)
    .join(' ');
  if (head) parts.push(head);

  if (colab.rt) {
    if (colab.rt.gpu) parts.push(paintRgb(colab.rt.gpu, PALETTE.violet, depth, { bold: true }));
    if (colab.rt.ram_u != null && colab.rt.ram_t != null) {
      parts.push(`${paintRgb('RAM', PALETTE.sky, depth)} ${paintRgb(`${Math.round(colab.rt.ram_u)}/${Math.round(colab.rt.ram_t)}G`, PALETTE.aquaSoft, depth)}`);
    }
    if (colab.rt.vram_u != null && colab.rt.vram_t != null) {
      parts.push(`${paintRgb('VRAM', PALETTE.mint, depth)} ${paintRgb(`${Math.round(colab.rt.vram_u)}/${Math.round(colab.rt.vram_t)}G`, PALETTE.lime, depth)}`);
    }
    if (colab.rt.idle_m != null) {
      const idleRgb = colab.rt.idle_m <= 15 ? PALETTE.crimson : colab.rt.idle_m <= 30 ? PALETTE.amber : PALETTE.slate;
      parts.push(paintRgb(`闲置 ${Math.round(colab.rt.idle_m)}m`, idleRgb, depth, { bold: colab.rt.idle_m <= 30 }));
    }
  }
  return parts.join(paintRgb(' · ', PALETTE.muted, depth));
}

function formatTodaySeg(tokens, cost, depth, { showCost = true } = {}) {
  const lbl = paintRgb('今日', PALETTE.indigo, depth);
  const tok = paintRgb(formatTokensCompact(tokens), PALETTE.violet, depth, { bold: true });
  if (!showCost) return `${lbl} ${tok}`;
  const usd = `${paintRgb('(', PALETTE.slate, depth)}${paintRgb(formatUsdCompact(cost), PALETTE.pink, depth, { bold: true })}${paintRgb(')', PALETTE.slate, depth)}`;
  return `${lbl} ${tok} ${usd}`;
}

function formatMonthSeg(tokens, cost, depth) {
  const lbl = paintRgb('本月', PALETTE.pink, depth);
  const tok = paintRgb(formatTokensCompact(tokens), PALETTE.rose, depth, { bold: true });
  const usd = `${paintRgb('(', PALETTE.slate, depth)}${paintRgb(formatUsdCompact(cost), PALETTE.peach, depth, { bold: true })}${paintRgb(')', PALETTE.slate, depth)}`;
  return `${lbl} ${tok} ${usd}`;
}

function formatSessionCostSeg(sessCost, depth, { labeled = true, saved = 0 } = {}) {
  const head = labeled
    ? `${paintRgb('本会话', PALETTE.sky, depth)} ${paintRgb(formatUsdCompact(sessCost), PALETTE.blue, depth, { bold: true })}`
    : paintRgb(formatUsdCompact(sessCost), PALETTE.blue, depth, { bold: true });
  if (saved > 0.01) {
    return `${head} ${paintRgb('(', PALETTE.slate, depth)}${paintRgb(`省 ${formatUsdCompact(saved)}`, PALETTE.mint, depth)}${paintRgb(')', PALETTE.slate, depth)}`;
  }
  return head;
}

function formatCacheSeg(avgCache, lastCache, coldStart, depth, { compact = false } = {}) {
  const lbl = paintRgb(compact ? 'C̄' : '缓存均值', PALETTE.gold, depth);
  const avgStr = paintRgb(`${Math.round(avgCache)}%`, cacheRgb(avgCache), depth, { bold: true });
  const turnTail = !compact && lastCache != null
    ? ` ${paintRgb('(本轮 ', PALETTE.slate, depth)}${paintRgb(`${Math.round(lastCache)}%`, cacheRgb(lastCache), depth)}${paintRgb(')', PALETTE.slate, depth)}`
    : '';
  const coldTag = coldStart ? paintRgb(' ❄', PALETTE.cyan, depth, { bold: true }) : '';
  return `${lbl} ${avgStr}${turnTail}${coldTag}`;
}

function formatTpsSeg(tps, depth) {
  return `${paintRgb(String(tps), PALETTE.cyan, depth, { bold: true })} ${paintRgb('t/s', PALETTE.aquaSoft, depth)}`;
}

export function renderStatusLine(stdinPayload, summary, options = {}) {
  const view = resolveLiveView(stdinPayload, summary);
  const linesMode = [1, 2, 3].includes(Number(options.lines))
    ? Number(options.lines)
    : ([1, 2, 3].includes(Number(summary?.lines)) ? Number(summary.lines) : 2);
  const useColor = options.color !== undefined
    ? Boolean(options.color)
    : (summary?.color !== undefined ? Boolean(summary.color) : true);
  const depth = detectColorDepth(useColor, options.colorDepth);
  const nowSec = options.nowSec || Math.floor(Date.now() / 1000);

  const sep = paintRgb(' · ', PALETTE.muted, depth);
  const pipe = paintRgb(' │ ', PALETTE.muted, depth);
  const tierMode = view.width >= 105 ? 'wide' : (view.width >= 75 ? 'mid' : 'narrow');

  const gPool = view.pools.find((p) => p.id === 'gemini');
  const ngPool = view.pools.find((p) => p.id === 'non_gemini');

  const ctxLabel = paintGradient('Ctx', CTX_GRADIENT, depth, { bold: true });
  const pctStr = view.usedPct != null
    ? paintRgb(`${Math.round(view.usedPct)}%`, contextRgb(view.usedPct), depth, { bold: true })
    : paintRgb('--', PALETTE.slate, depth);
  const tokPair = view.usedTokens > 0
    ? paintRgb(`(${formatTokensCompact(view.usedTokens)}/${formatTokensCompact(view.windowSize)})`, PALETTE.slate, depth)
    : '';

  // 1-line compact mode
  if (linesMode === 1) {
    const segs = [];
    if (tierMode === 'wide') {
      segs.push(`${ctxLabel} ${buildBar(view.usedPct ?? 0, 8, depth)} ${pctStr}${tokPair ? ` ${tokPair}` : ''}`);
      if (view.avgCache != null) segs.push(formatCacheSeg(view.avgCache, null, view.coldStart, depth, { compact: false }));
      if (view.todayTokens > 0 || view.todayCost > 0) segs.push(formatTodaySeg(view.todayTokens, view.todayCost, depth));
      const gp = formatPoolSegment(gPool, { compact: true, depth, nowSec });
      const ngp = formatPoolSegment(ngPool, { compact: true, depth, nowSec });
      if (gp) segs.push(gp);
      if (ngp) segs.push(ngp);
      const cb = formatColabCompact(view.colab, { tierMode: 'narrow', depth });
      if (cb) segs.push(cb);
    } else {
      segs.push(`${ctxLabel} ${pctStr}`);
      if (view.avgCache != null) segs.push(formatCacheSeg(view.avgCache, null, view.coldStart, depth, { compact: true }));
      if (view.todayTokens > 0) segs.push(formatTodaySeg(view.todayTokens, view.todayCost, depth, { showCost: false }));
      const gp = formatPoolSegment(gPool, { compact: true, depth, nowSec });
      if (gp) segs.push(gp);
    }
    return segs.join(sep);
  }

  // 3-line layered mode
  if (linesMode === 3) {
    const l1 = [];
    const barW = tierMode === 'wide' ? 10 : (tierMode === 'mid' ? 6 : 0);
    l1.push(barW > 0
      ? `${ctxLabel} ${buildBar(view.usedPct ?? 0, barW, depth)} ${pctStr}${tokPair ? ` ${tokPair}` : ''}`
      : `${ctxLabel} ${pctStr}`
    );
    if (view.avgCache != null) {
      l1.push(formatCacheSeg(view.avgCache, tierMode === 'wide' ? view.lastCache : null, view.coldStart, depth, { compact: tierMode !== 'wide' }));
    }
    if (tierMode !== 'narrow' && view.tps) l1.push(formatTpsSeg(view.tps, depth));
    if (view.sessCost > 0) {
      l1.push(formatSessionCostSeg(view.sessCost, depth, {
        labeled: tierMode === 'wide',
        saved: tierMode === 'wide' ? view.sessSaved : 0
      }));
    }

    const l2Blocks = [];
    const usageBits = [];
    if (view.todayTokens > 0 || view.todayCost > 0) {
      usageBits.push(formatTodaySeg(view.todayTokens, view.todayCost, depth));
    }
    if (tierMode === 'wide' && (view.monthTokens > 0 || view.monthCost > 0)) {
      usageBits.push(formatMonthSeg(view.monthTokens, view.monthCost, depth));
    }
    if (usageBits.length) l2Blocks.push(usageBits.join(sep));
    const gp = formatPoolSegment(gPool, { compact: tierMode !== 'wide', depth, nowSec });
    const ngp = formatPoolSegment(ngPool, { compact: tierMode !== 'wide', depth, nowSec });
    if (gp) l2Blocks.push(gp);
    if (ngp) l2Blocks.push(ngp);

    const out = [l1.join(sep)];
    if (l2Blocks.length) out.push(l2Blocks.join(pipe));
    if (view.colab) {
      const l3 = formatColabDetailLine(view.colab, depth);
      if (l3) out.push(l3);
    }
    return out.join('\n');
  }

  // Default 2-line layered mode
  const l1 = [];
  if (tierMode === 'wide') {
    l1.push(`${ctxLabel} ${buildBar(view.usedPct ?? 0, 8, depth)} ${pctStr}${tokPair ? ` ${tokPair}` : ''}`);
    if (view.avgCache != null) {
      l1.push(formatCacheSeg(view.avgCache, view.lastCache, view.coldStart, depth, { compact: false }));
    }
    if (view.tps) l1.push(formatTpsSeg(view.tps, depth));
    if (view.sessCost > 0) l1.push(formatSessionCostSeg(view.sessCost, depth, { labeled: true }));
    if (view.todayTokens > 0 || view.todayCost > 0) {
      l1.push(formatTodaySeg(view.todayTokens, view.todayCost, depth));
    }
  } else if (tierMode === 'mid') {
    l1.push(`${ctxLabel} ${buildBar(view.usedPct ?? 0, 6, depth)} ${pctStr}${tokPair ? ` ${tokPair}` : ''}`);
    if (view.avgCache != null) l1.push(formatCacheSeg(view.avgCache, null, view.coldStart, depth, { compact: true }));
    if (view.sessCost > 0) l1.push(formatSessionCostSeg(view.sessCost, depth, { labeled: false }));
    if (view.todayTokens > 0) l1.push(formatTodaySeg(view.todayTokens, view.todayCost, depth, { showCost: false }));
  } else {
    l1.push(`${ctxLabel} ${pctStr}`);
    if (view.avgCache != null) l1.push(formatCacheSeg(view.avgCache, null, view.coldStart, depth, { compact: true }));
    if (view.todayTokens > 0) l1.push(formatTodaySeg(view.todayTokens, view.todayCost, depth, { showCost: false }));
  }

  const l2Blocks = [];
  const gp = formatPoolSegment(gPool, { compact: tierMode !== 'wide', depth, nowSec });
  const ngp = formatPoolSegment(ngPool, { compact: tierMode !== 'wide', depth, nowSec });
  if (gp) l2Blocks.push(gp);
  if (ngp) l2Blocks.push(ngp);
  const cb = formatColabCompact(view.colab, { tierMode, depth });
  if (cb) l2Blocks.push(cb);

  if (l2Blocks.length === 0) return l1.join(sep);
  return `${l1.join(sep)}\n${l2Blocks.join(pipe)}`;
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

function isSoloBridgeCommand(cmd) {
  return typeof cmd === 'string' && cmd.includes('agent hook agy-statusline');
}

function isSoloShellWrapper(cmd) {
  if (!isSoloBridgeCommand(cmd)) return false;
  const trimmed = cmd.trim();
  return (
    trimmed.includes('$CLI_AGENTS_SURFACE_ID') ||
    trimmed.includes('$CLI_AGENTS_HOOK_CLI') ||
    /^if\s+\[/.test(trimmed) ||
    /^payload=\$\(cat\)/.test(trimmed)
  );
}

function stripDirectForwardCommand(cmd) {
  const idx = cmd.indexOf(' --forward-command ');
  return idx >= 0 ? cmd.slice(0, idx).trim() : cmd.trim();
}

/**
 * Installs or removes agy-cli-hud statusLine cleanly without clobbering Solo's agy-statusline bridge.
 * Preserves Solo's canonical `if [ -n "$CLI_AGENTS_SURFACE_ID" ] ...; else /bin/sh -c ...; fi`
 * wrapper (and self-heals truncated wrappers), while also supporting legacy direct-binary bridges.
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
        currentSl.command = isSoloShellWrapper(existingCmd)
          ? buildSoloSurfaceHookCommand(null)
          : stripDirectForwardCommand(existingCmd);
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
    nextCmd = buildSoloSurfaceHookCommand(hudCommand);
    mode = 'solo_chained';
  } else if (isSoloBridgeCommand(existingCmd)) {
    const baseBridge = stripDirectForwardCommand(existingCmd);
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
