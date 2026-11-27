/**
 * Dual-pool quota normalization & daily weekly-quota consumption tracker for agy CLI
 * (Gemini + Non-Gemini / 3P) and fallback caches.
 * Always normalizes percentages to REMAINING percent (0..100) to avoid used-vs-remaining ambiguity.
 */

import { formatLocalDateKey } from './paths.mjs';

const WEEKLY_WINDOW_SEC = 7 * 86_400;
const RESET_SHIFT_THRESHOLD_SEC = 3600;
const MIDNIGHT_BRIDGE_MS = 30 * 60_000;
const HEARTBEAT_REFRESH_MS = 8 * 60_000;
const LEDGER_VERSION = 1;

function toEpochSeconds(rawReset, resetInSeconds = null, nowMs = Date.now()) {
  if (typeof rawReset === 'number' && Number.isFinite(rawReset) && rawReset > 1_000_000_000) {
    return rawReset > 1e12 ? Math.round(rawReset / 1000) : Math.round(rawReset);
  }
  if (typeof rawReset === 'string' && rawReset.trim()) {
    const ms = Date.parse(rawReset.trim());
    if (Number.isFinite(ms) && ms > 0) return Math.round(ms / 1000);
  }
  if (typeof resetInSeconds === 'number' && Number.isFinite(resetInSeconds) && resetInSeconds > 0) {
    return Math.round(nowMs / 1000 + resetInSeconds);
  }
  return null;
}

function clampPercent(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Number(Math.max(0, Math.min(100, v)).toFixed(1));
}

function normalizeEntry(entry, nowMs = Date.now()) {
  if (!entry || typeof entry !== 'object') return null;
  let remainingPct = null;
  if (typeof entry.remaining_fraction === 'number' && Number.isFinite(entry.remaining_fraction)) {
    remainingPct = clampPercent(entry.remaining_fraction * 100);
  } else if (typeof entry.remainingFraction === 'number' && Number.isFinite(entry.remainingFraction)) {
    remainingPct = clampPercent(entry.remainingFraction * 100);
  } else if (typeof entry.remaining_percent === 'number' && Number.isFinite(entry.remaining_percent)) {
    remainingPct = clampPercent(entry.remaining_percent);
  } else if (typeof entry.used_percent === 'number' && Number.isFinite(entry.used_percent)) {
    remainingPct = clampPercent(100 - entry.used_percent);
  }
  if (remainingPct === null) return null;
  const resetsAt = toEpochSeconds(
    entry.resets_at ?? entry.reset_time ?? entry.resetTime,
    entry.reset_in_seconds ?? entry.resetInSeconds,
    nowMs
  );
  return { remaining_percent: remainingPct, resets_at: resetsAt };
}

function classifyBucketKey(rawKey) {
  const k = String(rawKey || '').trim().toLowerCase();
  if (!k) return null;

  const isFiveHour = /(?:^|[-_])(5h|five[-_]?hour|short|rolling)(?:$|[-_])/.test(k);
  const isWeekly = /(?:^|[-_])(week|weekly|7d|seven[-_]?day)(?:$|[-_])/.test(k);
  const windowKind = isFiveHour ? '5h' : (isWeekly ? 'weekly' : null);
  if (!windowKind) return null;

  const isNonGemini =
    /^(?:3p|third[-_]?party|non[-_]?gemini|partner|claude|anthropic|gpt|openai)/.test(k) ||
    /(?:^|[-_])(3p|claude|gpt|non[-_]?gemini|third[-_]?party)(?:$|[-_])/.test(k);
  const isGemini = !isNonGemini && /(?:^|[-_])(gemini|1p|google)(?:$|[-_])/.test(k);

  if (isGemini) return { pool: 'gemini', window: windowKind };
  if (isNonGemini) return { pool: 'non_gemini', window: windowKind };
  return null;
}

/**
 * Parses official agy CLI `statusLine` `quota` map:
 *   { "gemini-5h": {...}, "gemini-weekly": {...}, "3p-5h": {...}, "3p-weekly": {...} }
 */
export function normalizeAgyQuotaMap(quotaMap, { source = 'agy_statusline', stale = false, nowMs = Date.now() } = {}) {
  if (!quotaMap || typeof quotaMap !== 'object') {
    return { source, stale, pools: [] };
  }

  const acc = {
    gemini: { id: 'gemini', label: 'Gemini', five_hour_remaining_percent: null, five_hour_resets_at: null, weekly_remaining_percent: null, weekly_resets_at: null },
    non_gemini: { id: 'non_gemini', label: '非 Gemini（Claude · GPT）', five_hour_remaining_percent: null, five_hour_resets_at: null, weekly_remaining_percent: null, weekly_resets_at: null }
  };

  for (const [key, value] of Object.entries(quotaMap)) {
    const cls = classifyBucketKey(key);
    if (!cls) continue;
    const norm = normalizeEntry(value, nowMs);
    if (!norm) continue;
    const target = acc[cls.pool];
    if (cls.window === '5h') {
      if (target.five_hour_remaining_percent === null || norm.remaining_percent < target.five_hour_remaining_percent) {
        target.five_hour_remaining_percent = norm.remaining_percent;
        target.five_hour_resets_at = norm.resets_at;
      }
    } else if (cls.window === 'weekly') {
      if (target.weekly_remaining_percent === null || norm.remaining_percent < target.weekly_remaining_percent) {
        target.weekly_remaining_percent = norm.remaining_percent;
        target.weekly_resets_at = norm.resets_at;
      }
    }
  }

  const pools = [];
  for (const p of [acc.gemini, acc.non_gemini]) {
    if (p.five_hour_remaining_percent !== null || p.weekly_remaining_percent !== null) {
      pools.push(p);
    }
  }
  return { source, stale, pools };
}

function normalizeHostCacheEntryBuckets(entry, nowMs = Date.now()) {
  if (!entry || typeof entry !== 'object') return [];
  const bucketMap = {};

  const groups = entry.quotaSummaryGroups || entry.modelQuotaGroups;
  if (Array.isArray(groups) && groups.length > 0) {
    for (const g of groups) {
      const name = String(g?.displayName || g?.groupId || g?.id || '').toLowerCase();
      const isNonG = /(?:claude|gpt|3p|third|partner|non[-_\s]?gemini)/.test(name);
      const isG = !isNonG && /gemini/.test(name);
      const prefix = isG ? 'gemini' : (isNonG ? '3p' : '');
      if (!prefix) continue;
      const buckets = Array.isArray(g?.buckets) ? g.buckets : [];
      for (const b of buckets) {
        const bid = String(b?.bucketId || b?.label || b?.window || '').toLowerCase();
        if (/5h|five|short/.test(bid)) {
          bucketMap[`${prefix}-5h`] = b;
        } else if (/week|7d/.test(bid)) {
          bucketMap[`${prefix}-weekly`] = b;
        }
      }
    }
  }

  if (Object.keys(bucketMap).length === 0 && Array.isArray(entry.quotas) && entry.quotas.length > 0) {
    for (const q of entry.quotas) {
      const name = String(q?.id || q?.shortLabel || q?.displayTitle || q?.title || '').toLowerCase();
      const isNonG = /(?:claude|gpt|3p|third|partner|non[-_\s]?gemini|非\s*gemini)/.test(name);
      const isG = !isNonG && /gemini/.test(name);
      const prefix = isG ? 'gemini' : (isNonG ? '3p' : '');
      if (!prefix) continue;
      if (q?.fiveHour && typeof q.fiveHour === 'object') {
        bucketMap[`${prefix}-5h`] = q.fiveHour;
      }
      if (q?.weekly && typeof q.weekly === 'object') {
        bucketMap[`${prefix}-weekly`] = q.weekly;
      }
    }
  }

  return normalizeAgyQuotaMap(bucketMap, { source: 'desktop_cache', stale: true, nowMs }).pools;
}

function resolveHostCacheEntryTimestampMs(entry, fallbackMs = Date.now()) {
  if (!entry || typeof entry !== 'object') return fallbackMs;
  if (typeof entry.at === 'number' && Number.isFinite(entry.at) && entry.at > 1_000_000_000_000) {
    return Math.round(entry.at);
  }
  for (const raw of [entry.summaryFetchedAt, entry.fetchedAt, entry.quotaStatus?.summaryLastSuccessAt, entry.quotaStatus?.lastSuccessAt]) {
    if (typeof raw === 'string' && raw.trim()) {
      const ms = Date.parse(raw.trim());
      if (Number.isFinite(ms) && ms > 0) return Math.round(ms);
    }
  }
  return fallbackMs;
}

/**
 * Extracts chronological timestamped quota observations from Desktop agy-context-viewer
 * host_status_cache_v1.json (supports both multi-instance `entries` map and legacy flat shape).
 */
export function extractHostCacheObservations(hostCache, nowMs = Date.now(), { includeStale = false } = {}) {
  if (!hostCache || typeof hostCache !== 'object') return [];
  const rawEntries = [];
  if (hostCache.entries && typeof hostCache.entries === 'object' && !Array.isArray(hostCache.entries)) {
    for (const val of Object.values(hostCache.entries)) {
      if (val && typeof val === 'object') rawEntries.push(val);
    }
  } else {
    rawEntries.push(hostCache);
  }

  const out = [];
  for (const ent of rawEntries) {
    const isStale = Boolean(ent?.quotaStatus?.stale || ent?.quotaStatus?.summaryStale);
    if (!includeStale && isStale) continue;
    const obsMs = resolveHostCacheEntryTimestampMs(ent, nowMs);
    const pools = normalizeHostCacheEntryBuckets(ent, obsMs);
    if (!pools.length) continue;
    out.push({ observed_at_ms: obsMs, stale: isStale, pools });
  }
  out.sort((a, b) => a.observed_at_ms - b.observed_at_ms);
  return out;
}

/**
 * Fallback normalization from Desktop agy-context-viewer host_status_cache_v1.json
 * when CLI hasn't emitted a live quota callback yet.
 */
export function normalizeHostCacheQuotas(hostCache, nowMs = Date.now()) {
  const obs = extractHostCacheObservations(hostCache, nowMs, { includeStale: true });
  if (!obs.length) {
    return { source: 'desktop_cache', stale: true, pools: [] };
  }
  const newest = obs[obs.length - 1];
  return { source: 'desktop_cache', stale: true, pools: newest.pools };
}

export function formatResetCountdown(resetsAtEpochSec, nowSec = Math.floor(Date.now() / 1000)) {
  if (!resetsAtEpochSec || !Number.isFinite(resetsAtEpochSec)) return '';
  const diff = Math.max(0, Math.round(resetsAtEpochSec - nowSec));
  if (diff <= 0) return '';
  const totalMin = Math.ceil(diff / 60);
  if (totalMin >= 1440) {
    const days = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  }
  if (totalMin >= 60) {
    const hours = Math.floor(totalMin / 60);
    const mins = totalMin % 60;
    return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
  }
  return `${totalMin}m`;
}

function round1(v) {
  const num = Number(v);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Number(num.toFixed(1));
}

function getLocalDayStartMs(nowMs) {
  const d = new Date(nowMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}

/**
 * Checks whether a 7-day weekly quota window started earlier on the same local calendar day.
 * When true, all consumption in the current window (100 - remaining_percent) occurred today.
 */
export function isWeeklyWindowStartedToday(resetsAtSec, todayKey, nowMs = Date.now()) {
  if (typeof resetsAtSec !== 'number' || !Number.isFinite(resetsAtSec) || !todayKey) return false;
  const nowSec = Math.floor(nowMs / 1000);
  const remainingSec = resetsAtSec - nowSec;
  if (remainingSec < 6 * 86_400 - 600 || remainingSec > WEEKLY_WINDOW_SEC + 600) {
    return false;
  }
  const approxStartMs = (resetsAtSec - WEEKLY_WINDOW_SEC) * 1000;
  return formatLocalDateKey(approxStartMs) === todayKey;
}

function buildPoolDailySummary(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const used = round1(entry.used_today_percent);
  const preReset = round1(entry.pre_reset_used_percent);
  const resetCount = Math.max(0, Math.floor(Number(entry.reset_count_today) || 0));
  const postReset = resetCount > 0 ? round1(Math.max(0, used - preReset)) : null;
  const baselineComplete = typeof entry.baseline_complete === 'boolean'
    ? entry.baseline_complete
    : (resetCount > 0 || Number(entry.cycle_start_remaining_percent) >= 99.9);
  const firstObsMs = typeof entry.first_observed_at_ms === 'number' && Number.isFinite(entry.first_observed_at_ms)
    ? Math.round(entry.first_observed_at_ms)
    : null;
  const unobservedGap = round1(entry.unobserved_gap_percent);
  return {
    used_today_percent: used,
    pre_reset_used_percent: preReset,
    post_reset_used_percent: postReset,
    reset_count_today: resetCount,
    baseline_complete: baselineComplete,
    first_observed_at_ms: firstObsMs,
    unobserved_gap_percent: unobservedGap > 0 ? unobservedGap : 0
  };
}

function normalizePrevPoolEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.day_key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.day_key)) return null;
  const lastRem = clampPercent(raw.last_remaining_percent);
  if (lastRem === null) return null;
  const startRem = clampPercent(raw.cycle_start_remaining_percent) ?? lastRem;
  const minRem = clampPercent(raw.cycle_min_remaining_percent) ?? lastRem;
  const usedToday = round1(raw.used_today_percent);
  const resetCount = Math.max(0, Math.floor(Number(raw.reset_count_today) || 0));
  const resetsAt = typeof raw.last_resets_at === 'number' && Number.isFinite(raw.last_resets_at) && raw.last_resets_at > 1_000_000_000
    ? Math.round(raw.last_resets_at)
    : null;
  const obsMs = typeof raw.last_observed_at_ms === 'number' && Number.isFinite(raw.last_observed_at_ms)
    ? Math.round(raw.last_observed_at_ms)
    : null;
  const baselineComplete = typeof raw.baseline_complete === 'boolean'
    ? raw.baseline_complete
    : (resetCount > 0 || startRem >= 99.9);
  let firstObsMs = typeof raw.first_observed_at_ms === 'number' && Number.isFinite(raw.first_observed_at_ms)
    ? Math.round(raw.first_observed_at_ms)
    : (usedToday === 0 ? obsMs : null);
  // A partial-baseline entry starts at 0% on its first observation, so first === last with used > 0
  // indicates a legacy-migrated entry whose true first observation timestamp is unknown.
  if (!baselineComplete && resetCount === 0 && usedToday > 0 && firstObsMs != null && obsMs != null && firstObsMs === obsMs) {
    firstObsMs = null;
  }
  return {
    day_key: raw.day_key,
    used_today_percent: usedToday,
    pre_reset_used_percent: round1(raw.pre_reset_used_percent),
    reset_count_today: resetCount,
    cycle_start_remaining_percent: startRem,
    cycle_min_remaining_percent: minRem,
    last_remaining_percent: lastRem,
    last_resets_at: resetsAt,
    first_observed_at_ms: firstObsMs,
    last_observed_at_ms: obsMs,
    baseline_complete: baselineComplete,
    unobserved_gap_percent: round1(raw.unobserved_gap_percent)
  };
}

/**
 * Pure state transition for one pool's daily weekly-quota consumption.
 * Accurately accumulates pre-reset + post-reset usage when a weekly reset happens mid-day,
 * guards against rounding oscillation and stale multi-tab observations, refreshes heartbeat
 * timestamps so midnight bridging stays live, supports earlier-same-day anchor backfill
 * from Desktop caches, and tracks baseline completeness transparently.
 */
export function applyWeeklyPoolObservation(
  prevRaw,
  observation,
  { nowMs = Date.now(), onlyIfNewer = false, allowEarlierSameDayAnchor = false } = {}
) {
  const prev = normalizePrevPoolEntry(prevRaw);
  const rem = clampPercent(observation?.weekly_remaining_percent ?? observation?.remaining_percent);
  if (rem === null) {
    return { entry: prev, changed: false };
  }
  const rawResetsAt = observation?.weekly_resets_at ?? observation?.resets_at;
  const resetsAt = typeof rawResetsAt === 'number' && Number.isFinite(rawResetsAt) && rawResetsAt > 1_000_000_000
    ? Math.round(rawResetsAt)
    : null;

  const tsMs = Number.isFinite(nowMs) ? Math.round(nowMs) : Date.now();
  const nowSec = Math.floor(tsMs / 1000);
  const todayKey = formatLocalDateKey(tsMs);
  if (!todayKey) {
    return { entry: prev, changed: false };
  }

  if (prev && todayKey < prev.day_key) {
    return { entry: prev, changed: false };
  }

  // Same local calendar day: optional earlier-anchor backfill (e.g., morning Desktop snapshot
  // discovered during background sync after CLI initialized later the same day).
  const anchorCeilingMs = prev?.first_observed_at_ms ?? prev?.last_observed_at_ms ?? null;
  if (
    allowEarlierSameDayAnchor &&
    prev &&
    todayKey === prev.day_key &&
    prev.reset_count_today === 0 &&
    anchorCeilingMs != null &&
    tsMs < anchorCeilingMs
  ) {
    const sameCycle =
      prev.last_resets_at == null ||
      resetsAt == null ||
      Math.abs(resetsAt - prev.last_resets_at) < RESET_SHIFT_THRESHOLD_SEC;
    if (sameCycle && rem > prev.cycle_start_remaining_percent) {
      const gained = rem - prev.cycle_start_remaining_percent;
      const nextStart = rem;
      const nextUsed = round1(prev.pre_reset_used_percent + Math.max(0, nextStart - prev.cycle_min_remaining_percent));
      const nextGap = prev.unobserved_gap_percent > 0
        ? round1(Math.max(0, prev.unobserved_gap_percent - gained))
        : 0;
      const nextComplete = Boolean(
        prev.baseline_complete ||
        nextStart >= 99.9 ||
        (prev.unobserved_gap_percent > 0 && nextGap <= 0.1)
      );
      return {
        entry: {
          ...prev,
          used_today_percent: nextUsed,
          cycle_start_remaining_percent: nextStart,
          last_resets_at: prev.last_resets_at ?? resetsAt,
          first_observed_at_ms: tsMs,
          baseline_complete: nextComplete,
          unobserved_gap_percent: nextComplete ? 0 : nextGap
        },
        changed: true
      };
    }
    if (onlyIfNewer) {
      return { entry: prev, changed: false };
    }
  }

  if (onlyIfNewer && prev && prev.last_observed_at_ms != null && tsMs <= prev.last_observed_at_ms) {
    return { entry: prev, changed: false };
  }

  // First observation ever or new local calendar day rollover
  if (!prev || todayKey > prev.day_key) {
    const prevResetFellToday = Boolean(
      prev &&
      prev.last_resets_at != null &&
      resetsAt != null &&
      (resetsAt - prev.last_resets_at) >= RESET_SHIFT_THRESHOLD_SEC &&
      formatLocalDateKey(prev.last_resets_at * 1000) === todayKey
    );
    const prevResetExpiredToday = Boolean(
      prev &&
      prev.last_resets_at != null &&
      resetsAt == null &&
      nowSec >= prev.last_resets_at - 60 &&
      rem > prev.last_remaining_percent + 1.0 &&
      formatLocalDateKey(prev.last_resets_at * 1000) === todayKey
    );
    const startedToday = prevResetFellToday || prevResetExpiredToday || isWeeklyWindowStartedToday(resetsAt, todayKey, tsMs);

    if (startedToday) {
      return {
        entry: {
          day_key: todayKey,
          used_today_percent: round1(Math.max(0, 100 - rem)),
          pre_reset_used_percent: 0,
          reset_count_today: 1,
          cycle_start_remaining_percent: 100,
          cycle_min_remaining_percent: rem,
          last_remaining_percent: rem,
          last_resets_at: resetsAt,
          first_observed_at_ms: tsMs,
          last_observed_at_ms: tsMs,
          baseline_complete: true,
          unobserved_gap_percent: 0
        },
        changed: true
      };
    }

    // Bridge turns that started shortly before local midnight (within 30m) in the same weekly cycle
    const sameCycleAcrossMidnight = Boolean(
      prev && (
        prev.last_resets_at != null && resetsAt != null
          ? Math.abs(resetsAt - prev.last_resets_at) < RESET_SHIFT_THRESHOLD_SEC
          : rem <= prev.last_remaining_percent + 0.5
      )
    );
    const todayStartMs = getLocalDayStartMs(tsMs);
    const yesterdayKey = formatLocalDateKey(todayStartMs - 43_200_000);
    const isPrevYesterday = Boolean(prev && yesterdayKey && prev.day_key === yesterdayKey);
    const bridgedMidnight = Boolean(
      prev &&
      sameCycleAcrossMidnight &&
      prev.last_observed_at_ms != null &&
      prev.last_observed_at_ms < todayStartMs &&
      (todayStartMs - prev.last_observed_at_ms) <= MIDNIGHT_BRIDGE_MS &&
      rem <= prev.last_remaining_percent
    );
    if (bridgedMidnight) {
      const startRem = prev.last_remaining_percent;
      return {
        entry: {
          day_key: todayKey,
          used_today_percent: round1(Math.max(0, startRem - rem)),
          pre_reset_used_percent: 0,
          reset_count_today: 0,
          cycle_start_remaining_percent: startRem,
          cycle_min_remaining_percent: rem,
          last_remaining_percent: rem,
          last_resets_at: resetsAt ?? prev.last_resets_at,
          first_observed_at_ms: tsMs,
          last_observed_at_ms: tsMs,
          baseline_complete: true,
          unobserved_gap_percent: 0
        },
        changed: true
      };
    }

    // Clean overnight rollover: zero consumption occurred between yesterday's last observation and today's first
    const unchangedOvernight = Boolean(
      isPrevYesterday &&
      sameCycleAcrossMidnight &&
      Math.abs(rem - prev.last_remaining_percent) <= 0.1
    );
    const untouched = rem >= 99.9;
    const baselineComplete = untouched || unchangedOvernight;
    const unobservedGap = (!baselineComplete && prev && sameCycleAcrossMidnight && rem < prev.last_remaining_percent - 0.1)
      ? round1(prev.last_remaining_percent - rem)
      : 0;

    return {
      entry: {
        day_key: todayKey,
        used_today_percent: 0,
        pre_reset_used_percent: 0,
        reset_count_today: 0,
        cycle_start_remaining_percent: rem,
        cycle_min_remaining_percent: rem,
        last_remaining_percent: rem,
        last_resets_at: resetsAt,
        first_observed_at_ms: tsMs,
        last_observed_at_ms: tsMs,
        baseline_complete: baselineComplete,
        unobserved_gap_percent: unobservedGap
      },
      changed: true
    };
  }

  // Same local calendar day: ignore stale observations from an earlier weekly cycle
  if (prev.last_resets_at != null && resetsAt != null && resetsAt < prev.last_resets_at - RESET_SHIFT_THRESHOLD_SEC) {
    return { entry: prev, changed: false };
  }

  let didReset = false;
  if (prev.last_resets_at != null && resetsAt != null) {
    didReset = (resetsAt - prev.last_resets_at) >= RESET_SHIFT_THRESHOLD_SEC;
  } else if (prev.last_resets_at != null && resetsAt == null) {
    didReset = nowSec >= prev.last_resets_at - 60 && rem > prev.last_remaining_percent + 1.0;
  } else if (prev.last_resets_at == null && resetsAt != null) {
    didReset = (isWeeklyWindowStartedToday(resetsAt, todayKey, tsMs) && rem > prev.last_remaining_percent + 1.0) ||
      (rem - prev.last_remaining_percent >= 10.0);
  } else {
    didReset = (rem - prev.last_remaining_percent >= 10.0);
  }

  if (didReset) {
    const preReset = round1(prev.used_today_percent);
    const postReset = round1(Math.max(0, 100 - rem));
    const nextObsMs = prev.last_observed_at_ms != null ? Math.max(prev.last_observed_at_ms, tsMs) : tsMs;
    return {
      entry: {
        day_key: todayKey,
        used_today_percent: round1(preReset + postReset),
        pre_reset_used_percent: preReset,
        reset_count_today: prev.reset_count_today + 1,
        cycle_start_remaining_percent: 100,
        cycle_min_remaining_percent: rem,
        last_remaining_percent: rem,
        last_resets_at: resetsAt,
        first_observed_at_ms: prev.first_observed_at_ms,
        last_observed_at_ms: nextObsMs,
        baseline_complete: prev.baseline_complete,
        unobserved_gap_percent: prev.unobserved_gap_percent
      },
      changed: true
    };
  }

  // Same cycle today: monotonic floor prevents oscillation drift & stale multi-tab double-counting.
  // Also refresh last_observed_at_ms on throttled heartbeats for current (non-stale) observations
  // so late-night activity before midnight keeps MIDNIGHT_BRIDGE_MS accurate.
  const nextMin = Math.min(prev.cycle_min_remaining_percent, rem);
  const nextUsed = round1(prev.pre_reset_used_percent + Math.max(0, prev.cycle_start_remaining_percent - nextMin));
  const nextResetsAt = resetsAt ?? prev.last_resets_at;
  const isFreshHeartbeat = Boolean(
    rem <= prev.cycle_min_remaining_percent + 0.5 &&
    (prev.last_observed_at_ms == null || (tsMs > prev.last_observed_at_ms && (tsMs - prev.last_observed_at_ms) >= HEARTBEAT_REFRESH_MS))
  );
  const meaningfulChange =
    nextMin !== prev.cycle_min_remaining_percent ||
    nextUsed !== prev.used_today_percent ||
    (prev.last_resets_at == null && nextResetsAt != null) ||
    isFreshHeartbeat;

  if (!meaningfulChange) {
    return { entry: prev, changed: false };
  }

  const nextObsMs = prev.last_observed_at_ms != null ? Math.max(prev.last_observed_at_ms, tsMs) : tsMs;
  return {
    entry: {
      day_key: todayKey,
      used_today_percent: nextUsed,
      pre_reset_used_percent: prev.pre_reset_used_percent,
      reset_count_today: prev.reset_count_today,
      cycle_start_remaining_percent: prev.cycle_start_remaining_percent,
      cycle_min_remaining_percent: nextMin,
      last_remaining_percent: nextMin,
      last_resets_at: nextResetsAt,
      first_observed_at_ms: prev.first_observed_at_ms,
      last_observed_at_ms: nextObsMs,
      baseline_complete: prev.baseline_complete,
      unobserved_gap_percent: prev.unobserved_gap_percent
    },
    changed: true
  };
}

export function extractTodayWeeklyUsageMap(ledger, todayKey = formatLocalDateKey(Date.now())) {
  const out = {};
  const pools = ledger?.pools && typeof ledger.pools === 'object' ? ledger.pools : null;
  if (!pools || !todayKey) return out;
  for (const [poolId, raw] of Object.entries(pools)) {
    const norm = normalizePrevPoolEntry(raw);
    if (!norm || norm.day_key !== todayKey) continue;
    out[poolId] = buildPoolDailySummary(norm);
  }
  return out;
}

export function updateWeeklyQuotaLedger(
  prevLedger,
  pools,
  { nowMs = Date.now(), onlyIfNewer = false, allowEarlierSameDayAnchor = false } = {}
) {
  const tsMs = Number.isFinite(nowMs) ? Math.round(nowMs) : Date.now();
  const todayKey = formatLocalDateKey(tsMs);
  const prevPools = prevLedger?.pools && typeof prevLedger.pools === 'object' ? prevLedger.pools : {};
  const nextPools = {};
  for (const [poolId, raw] of Object.entries(prevPools)) {
    const norm = normalizePrevPoolEntry(raw);
    if (norm) nextPools[poolId] = norm;
  }

  let changed = false;
  if (Array.isArray(pools)) {
    for (const pool of pools) {
      if (!pool || !pool.id || pool.weekly_remaining_percent == null) continue;
      const res = applyWeeklyPoolObservation(nextPools[pool.id], pool, {
        nowMs: tsMs,
        onlyIfNewer,
        allowEarlierSameDayAnchor
      });
      if (res.entry) nextPools[pool.id] = res.entry;
      if (res.changed) changed = true;
    }
  }

  const ledger = {
    version: LEDGER_VERSION,
    updated_at_ms: changed ? tsMs : (Number(prevLedger?.updated_at_ms) || tsMs),
    pools: nextPools
  };
  return {
    ledger,
    changed,
    todayKey,
    byPool: extractTodayWeeklyUsageMap(ledger, todayKey)
  };
}

export function attachWeeklyDailyToPools(pools, byPool) {
  if (!Array.isArray(pools)) return [];
  const map = byPool && typeof byPool === 'object' ? byPool : {};
  return pools.map((p) => {
    if (!p || typeof p !== 'object') return p;
    const daily = p.id ? map[p.id] : null;
    if (!daily) {
      return {
        ...p,
        weekly_used_today_percent: p.weekly_used_today_percent ?? null,
        weekly_reset_count_today: p.weekly_reset_count_today ?? 0,
        weekly_pre_reset_used_percent: p.weekly_pre_reset_used_percent ?? 0,
        weekly_post_reset_used_percent: p.weekly_post_reset_used_percent ?? null,
        weekly_baseline_complete: p.weekly_baseline_complete ?? null,
        weekly_first_observed_at_ms: p.weekly_first_observed_at_ms ?? null,
        weekly_unobserved_gap_percent: p.weekly_unobserved_gap_percent ?? 0
      };
    }
    return {
      ...p,
      weekly_used_today_percent: daily.used_today_percent,
      weekly_reset_count_today: daily.reset_count_today,
      weekly_pre_reset_used_percent: daily.pre_reset_used_percent,
      weekly_post_reset_used_percent: daily.post_reset_used_percent,
      weekly_baseline_complete: daily.baseline_complete,
      weekly_first_observed_at_ms: daily.first_observed_at_ms,
      weekly_unobserved_gap_percent: daily.unobserved_gap_percent
    };
  });
}
