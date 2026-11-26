/**
 * Lightweight official API retail pricing & model normalization for agy-cli-hud.
 * Aligned with agy-context-viewer pricing.mjs without importing heavy collector logic.
 */

export const PRICING_VERIFIED_DATE = '2026-11-19';

export const MODEL_PRICING_TABLE = {
  'gemini-4-carbon': [
    { effectiveTo: '2026-11-30', inputPerMillion: 2.00, outputPerMillion: 10.00, cacheReadPerMillion: 0.10 },
    { effectiveFrom: '2026-12-01', inputPerMillion: 4.00, outputPerMillion: 20.00, cacheReadPerMillion: 0.20 }
  ],
  'gemini-4-argon': [
    { effectiveTo: '2026-11-30', inputPerMillion: 2.00, outputPerMillion: 10.00, cacheReadPerMillion: 0.10 },
    { effectiveFrom: '2026-12-01', inputPerMillion: 4.00, outputPerMillion: 20.00, cacheReadPerMillion: 0.20 }
  ],
  'gemini-4-neon': [
    { inputPerMillion: 3.00, outputPerMillion: 15.00, cacheReadPerMillion: 0.15 }
  ],
  'gemini-4-hydrogen': [
    { inputPerMillion: 1.50, outputPerMillion: 7.50, cacheReadPerMillion: 0.075 }
  ],
  'gemini-3.8-flash': [
    { effectiveTo: '2026-12-31', inputPerMillion: 0.75, outputPerMillion: 3.75, cacheReadPerMillion: 0.075 },
    { effectiveFrom: '2027-01-01', inputPerMillion: 1.50, outputPerMillion: 7.50, cacheReadPerMillion: 0.15 }
  ],
  'claude-opus-5-5': [
    { inputPerMillion: 4.00, outputPerMillion: 20.00, cacheReadPerMillion: 0.20, cacheWritePerMillion: 5.00 }
  ],
  'claude-sonnet-5-5': [
    { inputPerMillion: 2.00, outputPerMillion: 10.00, cacheReadPerMillion: 0.10, cacheWritePerMillion: 2.50 }
  ],
  'gemini-3.1-pro-preview': [
    { maxPromptTokens: 200000, inputPerMillion: 2.00, outputPerMillion: 12.00, cacheReadPerMillion: 0.20 },
    { minPromptTokens: 200001, inputPerMillion: 4.00, outputPerMillion: 18.00, cacheReadPerMillion: 0.40 }
  ],
  'gemini-3.5-flash-lite': [
    { inputPerMillion: 0.30, outputPerMillion: 2.50, cacheReadPerMillion: 0.03 }
  ],
  'gemini-2.5-pro': [
    { maxPromptTokens: 200000, inputPerMillion: 1.25, outputPerMillion: 10.00, cacheReadPerMillion: 0.125 },
    { minPromptTokens: 200001, inputPerMillion: 2.50, outputPerMillion: 15.00, cacheReadPerMillion: 0.25 }
  ]
};

export const MODEL_DISPLAY_NAMES = {
  'gemini-4-carbon': 'Gemini 4 Carbon',
  'gemini-4-argon': 'Gemini 4 Argon',
  'gemini-4-neon': 'Gemini 4 Neon',
  'gemini-4-hydrogen': 'Gemini 4 Hydrogen',
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'gpt-oss-120b': 'GPT-OSS 120B',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro Preview',
  'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite',
  'gemini-2.5-pro': 'Gemini 2.5 Pro'
};

export const MODEL_CONTEXT_WINDOWS = {
  'gemini-4-carbon': 1_000_000,
  'gemini-4-argon': 1_000_000,
  'gemini-4-neon': 1_000_000,
  'gemini-4-hydrogen': 1_000_000,
  'gemini-3.8-flash': 1_000_000,
  'gemini-3.5-flash-lite': 1_000_000,
  'gemini-3.1-pro-preview': 1_000_000,
  'gemini-2.5-pro': 1_000_000,
  'claude-opus-5-5': 200_000,
  'claude-sonnet-5-5': 200_000,
  'gpt-oss-120b': 128_000
};

const PLACEHOLDER_MODEL_MAP = {
  model_placeholder_m427: 'gemini-4-carbon',
  model_placeholder_m437: 'gemini-4-carbon',
  model_placeholder_m438: 'gemini-4-carbon',
  model_placeholder_m667: 'gemini-4-carbon',
  model_placeholder_m417: 'gemini-4-argon',
  model_placeholder_m418: 'gemini-4-argon',
  model_placeholder_m419: 'gemini-4-argon',
  model_placeholder_m681: 'gemini-4-argon',
  model_placeholder_m532: 'gemini-4-neon',
  model_placeholder_m533: 'gemini-4-neon',
  model_placeholder_m534: 'gemini-4-neon',
  model_placeholder_m535: 'gemini-4-neon',
  model_placeholder_m537: 'gemini-4-neon',
  model_placeholder_m525: 'gemini-4-hydrogen',
  model_placeholder_m526: 'gemini-4-hydrogen',
  model_placeholder_m527: 'gemini-4-hydrogen',
  model_placeholder_m528: 'gemini-4-hydrogen',
  model_placeholder_m318: 'gemini-3.8-flash',
  model_placeholder_m319: 'gemini-3.8-flash',
  model_placeholder_m320: 'gemini-3.8-flash',
  model_placeholder_m322: 'gemini-3.8-flash',
  model_placeholder_m400: 'claude-opus-5-5',
  model_placeholder_m401: 'claude-opus-5-5',
  model_placeholder_m402: 'claude-opus-5-5',
  model_placeholder_m403: 'claude-sonnet-5-5',
  model_placeholder_m404: 'claude-sonnet-5-5',
  model_placeholder_m405: 'claude-sonnet-5-5',
  model_openai_gpt_oss_120b_medium: 'gpt-oss-120b'
};

export const PLAN_MONTHLY_DEFAULTS_USD = {
  free: 0,
  plus: 4.99,
  pro: 19.99,
  ultra: 249.99
};

export function normalizeModelId(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (!s || s === 'none') return null;
  if (PLACEHOLDER_MODEL_MAP[s]) return PLACEHOLDER_MODEL_MAP[s];
  if (Object.prototype.hasOwnProperty.call(MODEL_DISPLAY_NAMES, s)) return s;
  if (/(?:^|[\s/_-])(?:gemini[-_\s]*)?4[-_\s]*carbon(?:$|[^a-z0-9])/.test(s)) return 'gemini-4-carbon';
  if (/(?:^|[\s/_-])(?:gemini[-_\s]*)?4[-_\s]*argon(?:$|[^a-z0-9])/.test(s)) return 'gemini-4-argon';
  if (/(?:^|[\s/_-])(?:gemini[-_\s]*)?4[-_\s]*neon(?:$|[^a-z0-9])/.test(s)) return 'gemini-4-neon';
  if (/(?:^|[\s/_-])(?:gemini[-_\s]*)?4[-_\s]*hydrogen(?:$|[^a-z0-9])/.test(s)) return 'gemini-4-hydrogen';
  if (/(?:^|[\s/_-])(?:gemini[-_\s]*)?3[._-]5[-_\s]*flash[-_\s]*lite(?:$|[^a-z0-9])/.test(s)) return 'gemini-3.5-flash-lite';
  if (/(?:^|[\s/_-])(?:gemini[-_\s]*)?3[._-]8[-_\s]*flash(?:$|[^a-z0-9])/.test(s) && !/flash[-_\s]*lite/.test(s)) return 'gemini-3.8-flash';
  if (/\bclaude\b/.test(s) && /(?:opus[-_\s]*5[._-]5|5[._-]5[-_\s]*opus)(?:$|[^0-9])/.test(s)) return 'claude-opus-5-5';
  if (/\bclaude\b/.test(s) && /(?:sonnet[-_\s]*5[._-]5|5[._-]5[-_\s]*sonnet)(?:$|[^0-9])/.test(s)) return 'claude-sonnet-5-5';
  if (/(?:^|[\s/_-])gpt[-_\s]*oss[-_\s]*120b(?:$|[^a-z0-9])/.test(s)) return 'gpt-oss-120b';
  if (/(?:^|[\s/_-])(?:gemini[-_\s]*3[._-]1|3\.1)[-_\s]*pro(?:$|[^a-z0-9])/.test(s)) return 'gemini-3.1-pro-preview';
  if (/(?:^|[\s/_-])(?:gemini[-_\s]*2[._-]5|2\.5)[-_\s]*pro(?:$|[^a-z0-9])/.test(s)) return 'gemini-2.5-pro';
  return null;
}

export function extractEffortFromModel(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const m = raw.match(/(?:[-_\s(])(xhigh|high|medium|low|minimal|thinking|fast)\)?$/i);
  return m ? m[1].toLowerCase() : '';
}

export function formatModelDisplay(rawModel) {
  const norm = normalizeModelId(rawModel);
  if (norm && MODEL_DISPLAY_NAMES[norm]) return MODEL_DISPLAY_NAMES[norm];
  if (!rawModel || typeof rawModel !== 'string') return '';
  return rawModel.trim();
}

export function inferContextWindowSize(rawModel) {
  const norm = normalizeModelId(rawModel);
  if (norm && MODEL_CONTEXT_WINDOWS[norm]) return MODEL_CONTEXT_WINDOWS[norm];
  return 1_000_000;
}

export function matchPricingRule(modelKey, dateStr = PRICING_VERIFIED_DATE, promptTokens = 0) {
  const tiers = MODEL_PRICING_TABLE[modelKey];
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  const isoDay = typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateStr)
    ? dateStr.slice(0, 10)
    : PRICING_VERIFIED_DATE;

  for (const tier of tiers) {
    if (tier.effectiveFrom && isoDay < tier.effectiveFrom) continue;
    if (tier.effectiveTo && isoDay > tier.effectiveTo) continue;
    if (tier.maxPromptTokens != null && promptTokens > tier.maxPromptTokens) continue;
    if (tier.minPromptTokens != null && promptTokens < tier.minPromptTokens) continue;
    return tier;
  }
  return tiers[tiers.length - 1];
}

export function calculateTurnCost({
  model,
  inputTokens = 0,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
  outputTokens = 0,
  dateStr = PRICING_VERIFIED_DATE
}) {
  const normKey = normalizeModelId(model);
  if (!normKey) {
    return { priced: false, costUsd: 0, cacheSavedUsd: 0, modelKey: null };
  }
  const input = Math.max(0, Number(inputTokens) || 0);
  const cacheRead = Math.max(0, Number(cacheReadTokens) || 0);
  const cacheWrite = Math.max(0, Number(cacheWriteTokens) || 0);
  const output = Math.max(0, Number(outputTokens) || 0);
  const promptTotal = input + cacheRead + cacheWrite;
  const tier = matchPricingRule(normKey, dateStr, promptTotal);
  if (!tier) {
    return { priced: false, costUsd: 0, cacheSavedUsd: 0, modelKey: normKey };
  }

  const writeRate = tier.cacheWritePerMillion !== undefined
    ? Number(tier.cacheWritePerMillion)
    : (normKey.startsWith('claude-') ? tier.inputPerMillion * 1.25 : tier.inputPerMillion);

  const costUsd =
    (input * tier.inputPerMillion +
      cacheRead * tier.cacheReadPerMillion +
      cacheWrite * writeRate +
      output * tier.outputPerMillion) / 1_000_000;

  const grossSavings = (cacheRead * Math.max(0, tier.inputPerMillion - tier.cacheReadPerMillion)) / 1_000_000;
  const writeSurcharge = (cacheWrite * Math.max(0, writeRate - tier.inputPerMillion)) / 1_000_000;
  const cacheSavedUsd = Math.max(0, grossSavings - writeSurcharge);

  return {
    priced: true,
    modelKey: normKey,
    costUsd,
    cacheSavedUsd
  };
}

export function resolvePlanMonthlyUsd(planTier, customMonthlyUsd = null) {
  if (customMonthlyUsd !== null && customMonthlyUsd !== undefined && customMonthlyUsd !== '') {
    const num = Number(customMonthlyUsd);
    if (Number.isFinite(num) && num >= 0) return num;
  }
  const key = String(planTier || '').trim().toLowerCase();
  if (key.includes('ultra')) return PLAN_MONTHLY_DEFAULTS_USD.ultra;
  if (key.includes('pro')) return PLAN_MONTHLY_DEFAULTS_USD.pro;
  if (key.includes('plus')) return PLAN_MONTHLY_DEFAULTS_USD.plus;
  if (key.includes('free')) return PLAN_MONTHLY_DEFAULTS_USD.free;
  return null;
}
