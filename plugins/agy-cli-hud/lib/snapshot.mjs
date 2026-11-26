/**
 * Shared snapshot contract (usage-hud.v1.json) and ultra-compact statusline summary (<4KB).
 * Never stores conversation text, credentials, or raw email addresses.
 */

import { existsSync } from 'node:fs';
import { readJsonSafe, resolveHudPaths, writeJsonAtomic } from './paths.mjs';
import { extractEffortFromModel, formatModelDisplay, normalizeModelId, resolvePlanMonthlyUsd } from './pricing.mjs';
import { normalizeAgyQuotaMap, normalizeHostCacheQuotas } from './quota.mjs';

export const DEFAULT_CONFIG = {
  lines: 2, // 1 | 2 | 3
  scope: 'cli_only', // cli_only | all
  color: true,
  plan_tier: 'auto', // auto | free | plus | pro | ultra
  monthly_paid_usd: null,
  sync_interval_ms: 2000,
  colab_poll_interval_ms: 45000,
  colab_keep_alive: true
};

export function loadHudConfig(paths = resolveHudPaths()) {
  const saved = readJsonSafe(paths.configPath, {});
  const cfg = { ...DEFAULT_CONFIG, ...(saved && typeof saved === 'object' ? saved : {}) };
  if (![1, 2, 3].includes(Number(cfg.lines))) cfg.lines = 2;
  else cfg.lines = Number(cfg.lines);
  if (!['cli_only', 'all'].includes(cfg.scope)) cfg.scope = 'cli_only';
  return cfg;
}

export function saveHudConfig(partial, paths = resolveHudPaths()) {
  const current = loadHudConfig(paths);
  const next = { ...current, ...(partial && typeof partial === 'object' ? partial : {}) };
  if (![1, 2, 3].includes(Number(next.lines))) next.lines = 2;
  else next.lines = Number(next.lines);
  if (!['cli_only', 'all'].includes(next.scope)) next.scope = 'cli_only';
  writeJsonAtomic(paths.configPath, next, { mode: 0o600, pretty: true });
  return next;
}

function resolveDesktopSubscriptionCost(paths) {
  const desktopSettings = readJsonSafe(paths.desktopSettingsPath, null);
  const custom = desktopSettings?.customPlan;
  if (!custom || typeof custom !== 'object') return null;
  if (custom.zeroExtra) return 0;
  const rawPaid = Number(custom.actualPricePaid);
  if (Number.isFinite(rawPaid) && rawPaid >= 0) {
    const cur = String(custom.currency || 'USD').toUpperCase();
    if (cur === 'USD') return rawPaid;
    if (cur === 'CNY') return Number((rawPaid / 6.72).toFixed(2));
  }
  return null;
}

export function extractLiveStatuslineFacts(stdinPayload) {
  if (!stdinPayload || typeof stdinPayload !== 'object') return null;
  const convId = String(stdinPayload.conversation_id || stdinPayload.session_id || '').trim() || null;
  const modelObj = stdinPayload.model && typeof stdinPayload.model === 'object' ? stdinPayload.model : {};
  const rawModelId = String(modelObj.id || modelObj.display_name || '').trim();
  const displayName = String(modelObj.display_name || '').trim() || formatModelDisplay(rawModelId) || null;
  const effort = String(modelObj.effort || '').trim() || extractEffortFromModel(rawModelId) || null;

  const cw = stdinPayload.context_window && typeof stdinPayload.context_window === 'object'
    ? stdinPayload.context_window
    : {};
  const cu = cw.current_usage && typeof cw.current_usage === 'object' ? cw.current_usage : {};

  const curInput = Math.max(0, Number(cu.input_tokens || 0) || 0);
  const curCacheRead = Math.max(0, Number(cu.cache_read_input_tokens ?? cu.cache_read_tokens ?? 0) || 0);
  const curCacheWrite = Math.max(0, Number(cu.cache_creation_input_tokens ?? cu.cache_write_tokens ?? 0) || 0);
  const curOutput = Math.max(0, Number(cu.output_tokens || 0) || 0);
  const curPrompt = curInput + curCacheRead + curCacheWrite;

  const windowSize = Number(cw.context_window_size) > 0 ? Number(cw.context_window_size) : null;
  const usedPct = typeof cw.used_percentage === 'number' && Number.isFinite(cw.used_percentage)
    ? Number(Math.max(0, Math.min(100, cw.used_percentage)).toFixed(1))
    : (windowSize && curPrompt > 0 ? Number(Math.min(100, (curPrompt / windowSize) * 100).toFixed(1)) : null);

  const contextUsedTokens = curPrompt > 0
    ? curPrompt
    : (usedPct === 0 ? 0 : (windowSize && usedPct !== null ? Math.round((usedPct / 100) * windowSize) : null));

  const costObj = stdinPayload.cost && typeof stdinPayload.cost === 'object' ? stdinPayload.cost : {};
  const rawTotalCost = costObj.total_cost_usd ?? costObj.total_usd;
  const totalCostUsd = typeof rawTotalCost === 'number' && Number.isFinite(rawTotalCost)
    ? Number(rawTotalCost.toFixed(4))
    : null;

  const quotaNormalized = stdinPayload.quota && typeof stdinPayload.quota === 'object'
    ? normalizeAgyQuotaMap(stdinPayload.quota, { source: 'agy_statusline', stale: false })
    : null;

  return {
    observed_at: Math.floor(Date.now() / 1000),
    has_stdin_payload: true,
    conversation_id: convId,
    agent_state: typeof stdinPayload.agent_state === 'string' ? stdinPayload.agent_state : null,
    plan_tier: typeof stdinPayload.plan_tier === 'string' ? stdinPayload.plan_tier : null,
    model_id: normalizeModelId(rawModelId) || rawModelId || null,
    model_display: displayName,
    effort,
    context_used_tokens: contextUsedTokens,
    context_window_size: windowSize,
    context_used_percent: usedPct,
    total_input_tokens: cw.total_input_tokens != null && Number.isFinite(Number(cw.total_input_tokens)) ? Number(cw.total_input_tokens) : null,
    total_output_tokens: cw.total_output_tokens != null && Number.isFinite(Number(cw.total_output_tokens)) ? Number(cw.total_output_tokens) : null,
    last_turn_cache_hit_percent: curPrompt > 0 ? Number(((curCacheRead / curPrompt) * 100).toFixed(1)) : null,
    cold_start_alert: Boolean(curPrompt >= 8000 && (curCacheRead / curPrompt) * 100 < 25),
    session_cost_usd: totalCostUsd,
    quotas: quotaNormalized
  };
}

export function composeSnapshot({
  incrementalResult,
  buildSessionFn,
  liveFacts = null,
  colabSummary = null,
  config = null,
  paths = resolveHudPaths(),
  sessionId = null
}) {
  const cfg = config || loadHudConfig(paths);
  const live = liveFacts || readJsonSafe(paths.liveSessionPath, null);
  const nowSec = Math.floor(Date.now() / 1000);
  const liveAgeSec = live?.observed_at ? Math.max(0, nowSec - Number(live.observed_at)) : Infinity;
  const isFreshUninitializedLive = Boolean(
    !sessionId &&
    live &&
    live.has_stdin_payload &&
    !live.conversation_id &&
    liveAgeSec <= 300
  );

  const explicitSessionId = sessionId || live?.conversation_id || null;
  const targetSessionId = explicitSessionId
    ? explicitSessionId
    : (isFreshUninitializedLive ? null : (incrementalResult?.latestSessionState?.sessionId || null));

  // Never fall back to another session's latestSessionState when an explicit sessionId
  // is requested (e.g. a brand-new conversation without transcript yet) or when the live
  // CLI prompt is an active uninitialized session.
  const incFile = targetSessionId
    ? (incrementalResult?.sessionsById?.get(targetSessionId) || null)
    : null;
  const incSession = incFile && buildSessionFn ? buildSessionFn(incFile) : null;

  const sameLiveSession = Boolean(
    live && (
      (targetSessionId && live.conversation_id === targetSessionId) ||
      isFreshUninitializedLive
    )
  );
  const resolvedModelId = (sameLiveSession && live.model_id) || incSession?.model_id || null;
  const resolvedModelDisplay = (sameLiveSession && live.model_display) || incSession?.model_display || null;
  const resolvedAgentState = (sameLiveSession && live.agent_state) || 'idle';
  const resolvedDeltaTokens = incSession?.last_turn_delta_tokens ?? 0;
  const resolvedTotalTokens = incSession?.session_total_tokens ?? (
    sameLiveSession && live.total_input_tokens != null && live.total_output_tokens != null
      ? live.total_input_tokens + live.total_output_tokens
      : 0
  );
  const resolvedAvgCache = incSession?.session_avg_cache_hit_percent ?? (sameLiveSession ? live.last_turn_cache_hit_percent : null);
  const resolvedColdStart = Boolean(
    (sameLiveSession && live.cold_start_alert) || incSession?.cold_start_alert
  );
  const resolvedSessionCost = incSession?.session_cost_usd > 0
    ? incSession.session_cost_usd
    : ((sameLiveSession && live.session_cost_usd != null) ? live.session_cost_usd : 0);

  const activeSession = {
    conversation_id: targetSessionId,
    agent: 'agy',
    model_id: resolvedModelId,
    model_display: resolvedModelDisplay,
    model: resolvedModelDisplay || resolvedModelId,
    effort: (sameLiveSession && live.effort) || incSession?.effort || null,
    agent_state: resolvedAgentState,
    status: resolvedAgentState,
    context_used_tokens: (sameLiveSession && live.context_used_tokens != null)
      ? live.context_used_tokens
      : (incSession?.context_used_tokens ?? 0),
    context_window_size: (sameLiveSession && live.context_window_size != null)
      ? live.context_window_size
      : (incSession?.context_window_size ?? 1_000_000),
    context_used_percent: (sameLiveSession && live.context_used_percent != null)
      ? live.context_used_percent
      : (incSession?.context_used_percent ?? 0),
    last_turn_delta_tokens: resolvedDeltaTokens,
    context_delta_tokens: resolvedDeltaTokens,
    session_total_tokens: resolvedTotalTokens,
    total_tokens: resolvedTotalTokens,
    session_avg_cache_hit_percent: resolvedAvgCache,
    avg_cache_hit_percent: resolvedAvgCache,
    last_turn_cache_hit_percent: (sameLiveSession && live.last_turn_cache_hit_percent != null)
      ? live.last_turn_cache_hit_percent
      : (incSession?.last_turn_cache_hit_percent ?? null),
    cold_start_alert: resolvedColdStart,
    cache_cold_alert: resolvedColdStart,
    output_tps: incSession?.output_tps ?? null,
    ttft_ms: incSession?.ttft_ms ?? null,
    session_cost_usd: resolvedSessionCost,
    session_api_cost_usd: resolvedSessionCost,
    session_cache_saved_usd: incSession?.session_cache_saved_usd ?? 0
  };

  // Quotas: prefer live statusLine callback -> previous snapshot -> desktop host cache
  let quotas = { source: 'none', stale: true, pools: [] };
  if (live?.quotas?.pools?.length) {
    const ageSec = Math.floor(Date.now() / 1000) - (live.observed_at || 0);
    quotas = {
      source: live.quotas.source || 'agy_statusline',
      stale: ageSec > 300,
      pools: live.quotas.pools
    };
  } else {
    const prevSnap = readJsonSafe(paths.snapshotPath, null);
    if (prevSnap?.quotas?.pools?.length) {
      quotas = { ...prevSnap.quotas, stale: true };
    } else if (existsSync(paths.desktopHostCachePath)) {
      const hostCache = readJsonSafe(paths.desktopHostCachePath, null);
      const fromDesktop = normalizeHostCacheQuotas(hostCache);
      if (fromDesktop.pools.length) quotas = fromDesktop;
    }
  }

  const gPool = (quotas.pools || []).find((p) => p.id === 'gemini') || null;
  const ngPool = (quotas.pools || []).find((p) => p.id === 'non_gemini') || null;
  quotas = {
    ...quotas,
    gemini: {
      five_hour: {
        remaining_percent: gPool?.five_hour_remaining_percent ?? null,
        resets_at: gPool?.five_hour_resets_at ?? null
      },
      weekly: {
        remaining_percent: gPool?.weekly_remaining_percent ?? null,
        resets_at: gPool?.weekly_resets_at ?? null
      }
    },
    non_gemini: {
      five_hour: {
        remaining_percent: ngPool?.five_hour_remaining_percent ?? null,
        resets_at: ngPool?.five_hour_resets_at ?? null
      },
      weekly: {
        remaining_percent: ngPool?.weekly_remaining_percent ?? null,
        resets_at: ngPool?.weekly_resets_at ?? null
      }
    }
  };

  const planTier = cfg.plan_tier && cfg.plan_tier !== 'auto'
    ? cfg.plan_tier
    : (live?.plan_tier || 'pro');
  const desktopPaid = cfg.monthly_paid_usd == null ? resolveDesktopSubscriptionCost(paths) : null;
  const monthlyPaidUsd = resolvePlanMonthlyUsd(planTier, cfg.monthly_paid_usd ?? desktopPaid);
  const monthCostUsd = incrementalResult?.rollups?.month?.api_cost_usd || 0;
  const leverageX = monthlyPaidUsd && monthlyPaidUsd > 0 && monthCostUsd > 0
    ? Number((monthCostUsd / monthlyPaidUsd).toFixed(1))
    : null;

  const rawColab = colabSummary || readJsonSafe(paths.colabCachePath, null) || {
    connected: false,
    configured: false,
    tier: null,
    cu_balance: null,
    cu_rate_hourly: null,
    estimated_hours_left: null,
    runtimes: [],
    sniper: { active: false, target_accelerator: null, interval_sec: 30, attempts: 0 }
  };
  const colab = {
    ...rawColab,
    balance_cu: rawColab.cu_balance ?? rawColab.balance_cu ?? null,
    burn_rate_cu_per_hour: rawColab.cu_rate_hourly ?? rawColab.burn_rate_cu_per_hour ?? null,
    eta_hours: rawColab.estimated_hours_left ?? rawColab.eta_hours ?? null,
    fetched_at: rawColab.fetched_at ?? rawColab.updated_at ?? null,
    error: rawColab.error ?? null
  };

  const todayRollup = incrementalResult?.rollups?.today || {
    tokens: 0, sessions: 0, turns: 0, cache_hit_percent: null, api_cost_usd: 0, cache_saved_usd: 0
  };
  const monthRollup = incrementalResult?.rollups?.month || {
    tokens: 0, sessions: 0, turns: 0, active_days: 0, cache_hit_percent: null, api_cost_usd: 0, cache_saved_usd: 0, last_7d_tokens: [0, 0, 0, 0, 0, 0, 0]
  };

  const snapshot = {
    schema_version: 1,
    updated_at: nowSec,
    generated_at: nowSec,
    active_session: activeSession,
    rollups: {
      scope: incrementalResult?.rollups?.scope || cfg.scope,
      today: todayRollup,
      month: monthRollup,
      subscription: {
        plan_tier: planTier,
        monthly_paid_usd: monthlyPaidUsd,
        leverage_x: leverageX
      }
    },
    usage: {
      today: {
        total_tokens: todayRollup.tokens,
        api_cost_usd: todayRollup.api_cost_usd,
        cache_saved_usd: todayRollup.cache_saved_usd,
        sessions: todayRollup.sessions,
        avg_cache_hit_percent: todayRollup.cache_hit_percent
      },
      month: {
        total_tokens: monthRollup.tokens,
        api_cost_usd: monthRollup.api_cost_usd,
        cache_saved_usd: monthRollup.cache_saved_usd,
        active_days: monthRollup.active_days,
        daily_tokens_7d: monthRollup.last_7d_tokens
      },
      plan: {
        tier: planTier,
        monthly_paid_usd: monthlyPaidUsd,
        leverage_ratio: leverageX
      }
    },
    quotas,
    colab
  };

  const topRuntime = Array.isArray(colab.runtimes) && colab.runtimes.length ? colab.runtimes[0] : null;
  const summary = {
    v: 1,
    updated_at: snapshot.updated_at,
    lines: cfg.lines,
    color: cfg.color,
    session_id: activeSession.conversation_id,
    ctx_pct: activeSession.context_used_percent,
    ctx_used: activeSession.context_used_tokens,
    ctx_size: activeSession.context_window_size,
    avg_cache: activeSession.session_avg_cache_hit_percent,
    avg_cache_pct: activeSession.session_avg_cache_hit_percent,
    last_cache: activeSession.last_turn_cache_hit_percent,
    last_cache_pct: activeSession.last_turn_cache_hit_percent,
    cold_start: activeSession.cold_start_alert,
    tps: activeSession.output_tps,
    sess_cost: activeSession.session_cost_usd,
    session_usd: activeSession.session_cost_usd,
    sess_saved: activeSession.session_cache_saved_usd,
    today_tokens: snapshot.rollups.today.tokens,
    today_cost: snapshot.rollups.today.api_cost_usd,
    today_usd: snapshot.rollups.today.api_cost_usd,
    month_tokens: snapshot.rollups.month.tokens,
    month_cost: snapshot.rollups.month.api_cost_usd,
    g5h: gPool?.five_hour_remaining_percent ?? null,
    g5h_reset: gPool?.five_hour_resets_at ?? null,
    gw: gPool?.weekly_remaining_percent ?? null,
    ng5h: ngPool?.five_hour_remaining_percent ?? null,
    ngw: ngPool?.weekly_remaining_percent ?? null,
    pools: quotas.pools,
    colab_connected: Boolean(colab.connected),
    colab_tier: colab.connected ? (colab.tier ?? null) : null,
    colab_cu: colab.connected ? (colab.cu_balance ?? null) : null,
    colab_burn: colab.connected ? (colab.cu_rate_hourly ?? null) : null,
    colab_gpu: colab.connected ? (topRuntime?.accelerator ?? null) : null,
    colab_ram_used: colab.connected ? (topRuntime?.ram_used_gb ?? null) : null,
    colab_ram_total: colab.connected ? (topRuntime?.ram_total_gb ?? null) : null,
    colab_vram_used: colab.connected ? (topRuntime?.vram_used_gb ?? null) : null,
    colab_vram_total: colab.connected ? (topRuntime?.vram_total_gb ?? null) : null,
    colab_idle_min: colab.connected ? (topRuntime?.idle_remaining_minutes ?? null) : null,
    colab: colab.connected
      ? {
          tier: colab.tier,
          cu: colab.cu_balance,
          rate: colab.cu_rate_hourly,
          hrs: colab.estimated_hours_left,
          rt: topRuntime
            ? {
                gpu: topRuntime.accelerator,
                ram_u: topRuntime.ram_used_gb,
                ram_t: topRuntime.ram_total_gb,
                vram_u: topRuntime.vram_used_gb,
                vram_t: topRuntime.vram_total_gb,
                idle_m: topRuntime.idle_remaining_minutes
              }
            : null
        }
      : null
  };

  // Keep a compact bounded lookup of recent active sessions (< 3.8KB total summary)
  // so concurrent agy CLI tabs resolve their own metrics without cross-session bleed.
  if (buildSessionFn && incrementalResult?.sessionsById && incrementalResult.sessionsById.size > 0) {
    const recentFiles = Array.from(incrementalResult.sessionsById.values())
      .filter((f) => f && f.sessionId && f.session && f.session.turns > 0)
      .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))
      .slice(0, 6);
    const sessionsMap = {};
    for (const f of recentFiles) {
      const m = buildSessionFn(f);
      if (!m) continue;
      const entry = {
        avg_cache: m.session_avg_cache_hit_percent,
        last_cache: m.last_turn_cache_hit_percent,
        cold_start: m.cold_start_alert,
        tps: m.output_tps,
        sess_cost: m.session_cost_usd,
        sess_saved: m.session_cache_saved_usd
      };
      sessionsMap[f.sessionId] = entry;
      summary.sessions = sessionsMap;
      if (Buffer.byteLength(JSON.stringify(summary), 'utf8') > 3800) {
        delete sessionsMap[f.sessionId];
        break;
      }
    }
    if (Object.keys(sessionsMap).length > 0) {
      summary.sessions = sessionsMap;
    } else {
      delete summary.sessions;
    }
  }

  writeJsonAtomic(paths.snapshotPath, snapshot, { mode: 0o600, pretty: false });
  writeJsonAtomic(paths.summaryPath, summary, { mode: 0o600, pretty: false });
  return { snapshot, summary };
}
