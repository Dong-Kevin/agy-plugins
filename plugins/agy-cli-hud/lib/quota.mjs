/**
 * Dual-pool quota normalization for agy CLI (Gemini + Non-Gemini / 3P) and fallback caches.
 * Always normalizes percentages to REMAINING percent (0..100) to avoid used-vs-remaining ambiguity.
 */

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

/**
 * Fallback normalization from Desktop agy-context-viewer host_status_cache_v1.json
 * when CLI hasn't emitted a live quota callback yet.
 */
export function normalizeHostCacheQuotas(hostCache, nowMs = Date.now()) {
  const groups = hostCache?.quotaSummaryGroups || hostCache?.modelQuotaGroups;
  if (!Array.isArray(groups) || groups.length === 0) {
    return { source: 'desktop_cache', stale: true, pools: [] };
  }
  const bucketMap = {};
  for (const g of groups) {
    const name = String(g?.displayName || g?.groupId || g?.id || '').toLowerCase();
    const isNonG = /(?:claude|gpt|3p|third|partner|non[-_\s]?gemini)/.test(name);
    const isG = !isNonG && /gemini/.test(name);
    const prefix = isG ? 'gemini' : (isNonG ? '3p' : '');
    if (!prefix) continue;
    const buckets = Array.isArray(g?.buckets) ? g.buckets : [];
    for (const b of buckets) {
      const bid = String(b?.bucketId || b?.label || '').toLowerCase();
      if (/5h|five|short/.test(bid)) {
        bucketMap[`${prefix}-5h`] = b;
      } else if (/week|7d/.test(bid)) {
        bucketMap[`${prefix}-weekly`] = b;
      }
    }
  }
  return normalizeAgyQuotaMap(bucketMap, { source: 'desktop_cache', stale: true, nowMs });
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
