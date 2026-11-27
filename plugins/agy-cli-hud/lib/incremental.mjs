/**
 * IncrementalJSONL byte-offset scanner & daily/monthly rollup engine for agy-cli-hud.
 * Inspired by token-tracker IncrementalJSONL: only parses newly appended bytes per session.
 * Deduplicates by step_index so RUNNING -> DONE status updates never double-count tokens.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync
} from 'node:fs';
import { join } from 'node:path';
import {
  formatLocalDateKey,
  formatLocalMonthKey,
  readJsonSafe,
  resolveHudPaths,
  writeJsonAtomic
} from './paths.mjs';
import {
  calculateTurnCost,
  extractEffortFromModel,
  formatModelDisplay,
  inferContextWindowSize,
  normalizeModelId
} from './pricing.mjs';

const STATE_VERSION = 2;
const CONV_ID_RE = /^[0-9a-f-]{8,64}$/i;
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const DEFAULT_SEEN_STEPS_MAX_AGE_MS = 24 * 3_600_000;

function parseDurationSec(val) {
  if (val == null) return null;
  if (typeof val === 'number') {
    return Number.isFinite(val) && val >= 0 && val <= 86400 ? val : null;
  }
  if (typeof val === 'string') {
    const s = val.trim();
    const msMatch = s.match(/^([0-9]+(?:\.[0-9]+)?)ms$/i);
    if (msMatch) {
      const sec = Number(msMatch[1]) / 1000;
      return Number.isFinite(sec) && sec >= 0 && sec <= 86400 ? sec : null;
    }
    const secMatch = s.match(/^([0-9]+(?:\.[0-9]+)?)s$/i);
    if (secMatch) {
      const sec = Number(secMatch[1]);
      return Number.isFinite(sec) && sec >= 0 && sec <= 86400 ? sec : null;
    }
    return null;
  }
  if (typeof val === 'object') {
    const sec = Number(val.seconds ?? 0);
    const nanos = Number(val.nanos ?? 0);
    if (Number.isFinite(sec) && Number.isFinite(nanos) && sec >= 0 && sec <= 86400 && nanos >= 0 && nanos < 1e9) {
      return sec + nanos / 1e9;
    }
  }
  return null;
}

function emptyDayBucket() {
  return {
    turns: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    cacheSavedUsd: 0
  };
}

function emptySessionAcc(sessionId, source) {
  return {
    sessionId,
    source,
    model: '',
    modelDisplay: '',
    effort: '',
    turns: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    lastTurnInput: 0,
    lastTurnCacheRead: 0,
    lastTurnCacheWrite: 0,
    lastTurnOutput: 0,
    lastTurnContextTokens: 0,
    prevTurnContextTokens: 0,
    lastTurnStep: -1,
    lastTurnAt: '',
    pendingTurn: null,
    lastOutputTps: null,
    lastTurnTtftMs: null,
    costUsd: 0,
    cacheSavedUsd: 0,
    firstSeenAt: '',
    lastSeenAt: ''
  };
}

function emptyFileState(sessionId, source) {
  return {
    sessionId,
    source,
    offset: 0,
    partial: '',
    size: 0,
    mtimeMs: 0,
    seenSteps: {},
    sqliteTimingSig: null,
    sqliteTiming: null,
    session: emptySessionAcc(sessionId, source),
    byDay: {}
  };
}

function extractTurnMetrics(record) {
  if (!record || typeof record !== 'object') return null;
  const type = String(record.type || '');
  if (type === 'USER_INPUT' || type === 'CHECKPOINT' || type === 'ERROR_MESSAGE' || record.checkpoint) {
    return null;
  }

  let input = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let output = 0;
  let hasUsage = false;

  if (
    record.input_tokens != null ||
    record.output_tokens != null ||
    record.cache_read_tokens != null ||
    record.cache_write_tokens != null ||
    record.cache_creation_input_tokens != null
  ) {
    input = Math.max(0, Number(record.input_tokens || 0) || 0);
    cacheRead = Math.max(0, Number(record.cache_read_tokens || 0) || 0);
    cacheWrite = Math.max(0, Number(record.cache_write_tokens ?? record.cache_creation_input_tokens ?? 0) || 0);
    output = Math.max(0, Number(record.output_tokens || 0) || 0);
    hasUsage = input > 0 || cacheRead > 0 || cacheWrite > 0 || output > 0;
  } else {
    const u = record.chatModel?.usage || record.usage || record.usageMetadata;
    if (u && typeof u === 'object') {
      input = Math.max(0, Number(u.inputTokens ?? u.input_tokens ?? 0) || 0);
      cacheRead = Math.max(0, Number(u.cacheReadTokens ?? u.cache_read_tokens ?? 0) || 0);
      cacheWrite = Math.max(0, Number(u.cacheWriteTokens ?? u.cacheCreationInputTokens ?? u.cache_creation_input_tokens ?? u.cache_write_tokens ?? 0) || 0);
      output = Math.max(0, Number(u.outputTokens ?? u.output_tokens ?? 0) || 0);
      hasUsage = input > 0 || cacheRead > 0 || cacheWrite > 0 || output > 0;
    }
  }

  if (!hasUsage && type !== 'PLANNER_RESPONSE') return null;
  if (!hasUsage) return null;

  const rawModel = String(record.model || record.generatorModel || record.chatModel?.model || '').trim();
  const createdAt = String(record.created_at || record.timestamp || '').trim();
  const status = String(record.status || '').trim().toUpperCase();
  const stepIndex = record.step_index != null ? Number(record.step_index) : null;

  const cm = record.chatModel && typeof record.chatModel === 'object' ? record.chatModel : null;
  const ttftSec = parseDurationSec(cm?.timeToFirstToken ?? record.time_to_first_token)
    ?? (Number.isFinite(Number(record.ttft_ms)) && Number(record.ttft_ms) >= 0 ? Number(record.ttft_ms) / 1000 : null);
  const streamingSec = parseDurationSec(cm?.streamingDuration ?? record.streaming_duration)
    ?? (Number.isFinite(Number(record.streaming_ms)) && Number(record.streaming_ms) >= 0 ? Number(record.streaming_ms) / 1000 : null);
  const explicitDurSec = (ttftSec !== null && streamingSec !== null)
    ? (ttftSec + streamingSec)
    : (streamingSec ?? ttftSec ?? (
        Number.isFinite(Number(record.duration_ms)) && Number(record.duration_ms) >= 0
          ? Number(record.duration_ms) / 1000
          : null
      ));
  const explicitTps = (output > 0 && explicitDurSec !== null && explicitDurSec >= 0.05)
    ? Number((output / explicitDurSec).toFixed(1))
    : null;
  const explicitTtftMs = ttftSec !== null ? Math.round(ttftSec * 1000) : null;

  return {
    stepKey: stepIndex !== null && Number.isFinite(stepIndex) ? String(stepIndex) : null,
    stepIndex: stepIndex !== null && Number.isFinite(stepIndex) ? stepIndex : -1,
    status,
    rawModel,
    createdAt,
    input,
    cacheRead,
    cacheWrite,
    output,
    explicitTps,
    explicitTtftMs
  };
}

function applyTurnDelta(fileState, turn, fallbackMtimeMs) {
  const dayKey =
    formatLocalDateKey(turn.createdAt || fallbackMtimeMs) ||
    formatLocalDateKey(Date.now());
  const priced = calculateTurnCost({
    model: turn.rawModel || fileState.session.model,
    inputTokens: turn.input,
    cacheReadTokens: turn.cacheRead,
    cacheWriteTokens: turn.cacheWrite,
    outputTokens: turn.output,
    dateStr: dayKey
  });

  const nextEntry = {
    dayKey,
    input: turn.input,
    cacheRead: turn.cacheRead,
    cacheWrite: turn.cacheWrite,
    output: turn.output,
    costUsd: priced.costUsd,
    cacheSavedUsd: priced.cacheSavedUsd
  };

  const sess = fileState.session;
  const prev = turn.stepKey ? fileState.seenSteps[turn.stepKey] : null;
  if (prev) {
    // Undo prior counters for same step_index (e.g., RUNNING -> DONE update)
    sess.inputTokens = Math.max(0, sess.inputTokens - prev.input);
    sess.cacheReadTokens = Math.max(0, sess.cacheReadTokens - prev.cacheRead);
    sess.cacheWriteTokens = Math.max(0, sess.cacheWriteTokens - prev.cacheWrite);
    sess.outputTokens = Math.max(0, sess.outputTokens - prev.output);
    sess.costUsd = Math.max(0, sess.costUsd - prev.costUsd);
    sess.cacheSavedUsd = Math.max(0, sess.cacheSavedUsd - prev.cacheSavedUsd);

    const prevDay = fileState.byDay[prev.dayKey];
    if (prevDay) {
      prevDay.turns = Math.max(0, prevDay.turns - 1);
      prevDay.inputTokens = Math.max(0, prevDay.inputTokens - prev.input);
      prevDay.cacheReadTokens = Math.max(0, prevDay.cacheReadTokens - prev.cacheRead);
      prevDay.cacheWriteTokens = Math.max(0, prevDay.cacheWriteTokens - prev.cacheWrite);
      prevDay.outputTokens = Math.max(0, prevDay.outputTokens - prev.output);
      prevDay.costUsd = Math.max(0, prevDay.costUsd - prev.costUsd);
      prevDay.cacheSavedUsd = Math.max(0, prevDay.cacheSavedUsd - prev.cacheSavedUsd);
    }
  } else {
    sess.turns += 1;
  }

  sess.inputTokens += nextEntry.input;
  sess.cacheReadTokens += nextEntry.cacheRead;
  sess.cacheWriteTokens += nextEntry.cacheWrite;
  sess.outputTokens += nextEntry.output;
  sess.costUsd += nextEntry.costUsd;
  sess.cacheSavedUsd += nextEntry.cacheSavedUsd;

  if (!fileState.byDay[dayKey]) {
    fileState.byDay[dayKey] = emptyDayBucket();
  }
  const dayBucket = fileState.byDay[dayKey];
  dayBucket.turns += 1;
  dayBucket.inputTokens += nextEntry.input;
  dayBucket.cacheReadTokens += nextEntry.cacheRead;
  dayBucket.cacheWriteTokens += nextEntry.cacheWrite;
  dayBucket.outputTokens += nextEntry.output;
  dayBucket.costUsd += nextEntry.costUsd;
  dayBucket.cacheSavedUsd += nextEntry.cacheSavedUsd;

  if (turn.stepKey) {
    fileState.seenSteps[turn.stepKey] = nextEntry;
  }

  if (turn.rawModel) {
    sess.model = turn.rawModel;
    sess.modelDisplay = formatModelDisplay(turn.rawModel);
    const eff = extractEffortFromModel(turn.rawModel);
    if (eff) sess.effort = eff;
  }

  const contextNow = turn.input + turn.cacheRead + turn.cacheWrite;
  if (!prev && sess.lastTurnContextTokens > 0) {
    sess.prevTurnContextTokens = sess.lastTurnContextTokens;
  }

  const tsMs = turn.createdAt ? Date.parse(turn.createdAt) : NaN;
  if (turn.explicitTps !== null) {
    sess.lastOutputTps = turn.explicitTps;
    if (turn.explicitTtftMs !== null) sess.lastTurnTtftMs = turn.explicitTtftMs;
    sess.pendingTurn = null;
  } else if (turn.output > 0 && Number.isFinite(tsMs)) {
    const pt = sess.pendingTurn;
    if (pt && turn.stepKey && pt.stepKey === turn.stepKey) {
      // Same step_index update (e.g. RUNNING -> DONE): keep original startMs
      pt.output = turn.output;
      pt.status = turn.status;
      if (turn.status === 'DONE' && tsMs > pt.startMs) {
        const dtSec = (tsMs - pt.startMs) / 1000;
        if (dtSec >= 1 && dtSec <= 180 && pt.output >= 20) {
          sess.lastOutputTps = Number((pt.output / dtSec).toFixed(1));
        }
        sess.pendingTurn = null;
      }
    } else {
      sess.pendingTurn = {
        stepKey: turn.stepKey,
        startMs: tsMs,
        output: turn.output,
        status: turn.status
      };
    }
  }

  sess.lastTurnInput = turn.input;
  sess.lastTurnCacheRead = turn.cacheRead;
  sess.lastTurnCacheWrite = turn.cacheWrite;
  sess.lastTurnOutput = turn.output;
  sess.lastTurnContextTokens = contextNow;
  if (turn.stepIndex >= 0) sess.lastTurnStep = turn.stepIndex;
  if (turn.createdAt) {
    if (!sess.firstSeenAt) sess.firstSeenAt = turn.createdAt;
    sess.lastTurnAt = turn.createdAt;
    sess.lastSeenAt = turn.createdAt;
  }
}

function processTranscriptRecord(state, rec, fallbackMtimeMs) {
  if (!rec || typeof rec !== 'object') return;
  const type = String(rec.type || '');
  const ts = String(rec.created_at || rec.timestamp || '').trim();
  const tsMs = ts ? Date.parse(ts) : NaN;
  const rawStep = rec.step_index != null ? Number(rec.step_index) : null;
  const stepKey = rawStep !== null && Number.isFinite(rawStep) ? String(rawStep) : null;
  const sess = state.session;

  // In agy transcript.jsonl, `created_at` is the step START timestamp (not completion).
  // Close any open pending model turn once a DIFFERENT subsequent step begins.
  const pt = sess.pendingTurn;
  if (pt && (!stepKey || !pt.stepKey || stepKey !== pt.stepKey)) {
    if (type !== 'USER_INPUT' && Number.isFinite(tsMs) && tsMs > pt.startMs) {
      const dtSec = (tsMs - pt.startMs) / 1000;
      if (dtSec >= 1 && dtSec <= 180 && pt.output >= 20) {
        sess.lastOutputTps = Number((pt.output / dtSec).toFixed(1));
      }
    }
    // Always clear on a new step (including USER_INPUT or same-second tool dispatch)
    // so human reading pause or subsequent tool runtime never bleeds into model time.
    sess.pendingTurn = null;
  }

  const turn = extractTurnMetrics(rec);
  if (turn) {
    applyTurnDelta(state, turn, fallbackMtimeMs);
  }
}

export function scanTranscriptFileIncremental(filePath, prevState, { sessionId, source = 'cli' }) {
  let st;
  try {
    st = statSync(filePath);
  } catch {
    return { state: prevState || null, changed: false };
  }
  if (!st.isFile()) return { state: prevState || null, changed: false };

  let state = prevState;
  if (!state || typeof state !== 'object' || st.size < Number(state.offset || 0)) {
    state = emptyFileState(sessionId, source);
  }
  if (state.size === st.size && Math.abs(state.mtimeMs - st.mtimeMs) < 1 && state.offset === st.size) {
    return { state, changed: false };
  }

  const fd = openSync(filePath, 'r');
  try {
    let pos = Number(state.offset || 0);
    let carry = String(state.partial || '');
    const buf = Buffer.allocUnsafe(Math.min(Math.max(st.size - pos, 4096), MAX_CHUNK_BYTES));

    while (pos < st.size) {
      const toRead = Math.min(buf.length, st.size - pos);
      const bytesRead = readSync(fd, buf, 0, toRead, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;

      const chunk = carry + buf.subarray(0, bytesRead).toString('utf8');
      const lines = chunk.split('\n');
      carry = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line[0] !== '{') continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        processTranscriptRecord(state, rec, st.mtimeMs);
      }
    }

    // Also try parsing trailing complete JSON line without newline (common while streaming)
    const trimmedCarry = carry.trim();
    if (trimmedCarry && trimmedCarry[0] === '{' && trimmedCarry[trimmedCarry.length - 1] === '}') {
      try {
        const rec = JSON.parse(trimmedCarry);
        processTranscriptRecord(state, rec, st.mtimeMs);
        carry = '';
      } catch {
        // Keep incomplete JSON line in carry buffer
      }
    }

    // Final-turn EOF fallback (when the last record is a completed PLANNER_RESPONSE
    // with no following tool step yet, e.g. final answer waiting at prompt):
    // use transcript file flush mtimeMs - startMs without clearing pendingTurn
    // so a delayed tool step can still refine it while a later USER_INPUT clears it.
    const openTurn = state.session.pendingTurn;
    if (openTurn && openTurn.status !== 'RUNNING' && Number.isFinite(st.mtimeMs) && st.mtimeMs > openTurn.startMs) {
      const dtSec = (st.mtimeMs - openTurn.startMs) / 1000;
      if (dtSec >= 1 && dtSec <= 180 && openTurn.output >= 20) {
        state.session.lastOutputTps = Number((openTurn.output / dtSec).toFixed(1));
      }
    }

    state.offset = pos;
    state.partial = carry.length <= 65536 ? carry : '';
    state.size = st.size;
    state.mtimeMs = st.mtimeMs;
    state.source = source;
    return { state, changed: true };
  } finally {
    closeSync(fd);
  }
}

function listBrainTranscripts(brainDir, source) {
  const found = [];
  if (!brainDir || !existsSync(brainDir)) return found;
  let entries;
  try {
    entries = readdirSync(brainDir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || !CONV_ID_RE.test(ent.name)) continue;
    const txPath = join(brainDir, ent.name, '.system_generated', 'logs', 'transcript.jsonl');
    if (existsSync(txPath)) {
      found.push({ sessionId: ent.name, filePath: txPath, source });
    }
  }
  return found;
}

export function loadIncrementalState(paths = resolveHudPaths()) {
  const raw = readJsonSafe(paths.cursorStatePath, null);
  if (raw && raw.version === STATE_VERSION && raw.files && typeof raw.files === 'object') {
    return raw;
  }
  return { version: STATE_VERSION, updatedAt: 0, files: {} };
}

export function saveIncrementalState(state, paths = resolveHudPaths()) {
  state.version = STATE_VERSION;
  state.updatedAt = Date.now();
  writeJsonAtomic(paths.cursorStatePath, state, { mode: 0o600, pretty: false });
}

export function runIncrementalSync({
  scope = 'cli_only',
  paths = resolveHudPaths(),
  now = new Date(),
  seenStepsMaxAgeMs = DEFAULT_SEEN_STEPS_MAX_AGE_MS
} = {}) {
  const state = loadIncrementalState(paths);
  const targets = [...listBrainTranscripts(paths.cliBrainDir, 'cli')];
  if (scope === 'all') {
    targets.push(...listBrainTranscripts(paths.desktopBrainDir, 'desktop'));
  }

  let changedAny = false;
  const activePaths = new Set();
  for (const item of targets) {
    activePaths.add(item.filePath);
    const prev = state.files[item.filePath];
    const { state: next, changed } = scanTranscriptFileIncremental(item.filePath, prev, item);
    if (next) {
      state.files[item.filePath] = next;
      if (changed) changedAny = true;
    }
  }

  // Prune deleted files and trim seenSteps on inactive historical sessions (>24h)
  // so incremental_state.v1.json stays compact without affecting session/byDay totals.
  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  const maxStepAge = Number.isFinite(seenStepsMaxAgeMs) && seenStepsMaxAgeMs > 0
    ? seenStepsMaxAgeMs
    : DEFAULT_SEEN_STEPS_MAX_AGE_MS;
  for (const [existingPath, fState] of Object.entries(state.files)) {
    if (!activePaths.has(existingPath) && !existsSync(existingPath)) {
      delete state.files[existingPath];
      changedAny = true;
      continue;
    }
    if (
      fState &&
      fState.mtimeMs > 0 &&
      (nowMs - fState.mtimeMs) > maxStepAge &&
      fState.seenSteps &&
      typeof fState.seenSteps === 'object' &&
      Object.keys(fState.seenSteps).length > 0
    ) {
      fState.seenSteps = {};
      changedAny = true;
    }
  }

  if (changedAny || !existsSync(paths.cursorStatePath)) {
    saveIncrementalState(state, paths);
  }

  const todayKey = formatLocalDateKey(now);
  const monthKey = formatLocalMonthKey(now);

  // Build 7-day rolling window keys (oldest -> today)
  const last7Keys = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(now.getTime() - i * 86_400_000);
    last7Keys.push(formatLocalDateKey(d));
  }
  const last7Totals = Object.fromEntries(last7Keys.map((k) => [k, 0]));

  const today = {
    tokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    sessions: 0,
    turns: 0,
    apiCostUsd: 0,
    cacheSavedUsd: 0
  };
  const month = {
    tokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    activeDaysSet: new Set(),
    sessions: 0,
    turns: 0,
    apiCostUsd: 0,
    cacheSavedUsd: 0
  };

  let latestSessionState = null;
  const sessionsById = new Map();

  for (const fState of Object.values(state.files)) {
    if (!fState || !fState.session) continue;
    if (scope === 'cli_only' && fState.source !== 'cli') continue;

    sessionsById.set(fState.sessionId, fState);
    if (!latestSessionState || (fState.mtimeMs || 0) > (latestSessionState.mtimeMs || 0)) {
      latestSessionState = fState;
    }

    let touchedMonth = false;
    for (const [dKey, bucket] of Object.entries(fState.byDay || {})) {
      if (!bucket || bucket.turns <= 0) continue;
      const tot = bucket.inputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens + bucket.outputTokens;
      if (dKey === todayKey) {
        today.tokens += tot;
        today.inputTokens += bucket.inputTokens;
        today.cacheReadTokens += bucket.cacheReadTokens;
        today.cacheWriteTokens += bucket.cacheWriteTokens;
        today.outputTokens += bucket.outputTokens;
        today.turns += bucket.turns;
        today.apiCostUsd += bucket.costUsd;
        today.cacheSavedUsd += bucket.cacheSavedUsd;
        today.sessions += 1;
      }
      if (dKey.startsWith(monthKey)) {
        month.tokens += tot;
        month.inputTokens += bucket.inputTokens;
        month.cacheReadTokens += bucket.cacheReadTokens;
        month.cacheWriteTokens += bucket.cacheWriteTokens;
        month.outputTokens += bucket.outputTokens;
        month.turns += bucket.turns;
        month.apiCostUsd += bucket.costUsd;
        month.cacheSavedUsd += bucket.cacheSavedUsd;
        month.activeDaysSet.add(dKey);
        touchedMonth = true;
      }
      if (Object.prototype.hasOwnProperty.call(last7Totals, dKey)) {
        last7Totals[dKey] += tot;
      }
    }
    if (touchedMonth) month.sessions += 1;
  }

  const todayPrompt = today.inputTokens + today.cacheReadTokens + today.cacheWriteTokens;
  const monthPrompt = month.inputTokens + month.cacheReadTokens + month.cacheWriteTokens;

  return {
    changed: changedAny,
    state,
    todayKey,
    monthKey,
    sessionsById,
    latestSessionState,
    rollups: {
      scope,
      today: {
        tokens: Math.round(today.tokens),
        input_tokens: Math.round(today.inputTokens),
        cache_read_tokens: Math.round(today.cacheReadTokens),
        output_tokens: Math.round(today.outputTokens),
        sessions: today.sessions,
        turns: today.turns,
        cache_hit_percent: todayPrompt > 0 ? Number(((today.cacheReadTokens / todayPrompt) * 100).toFixed(1)) : null,
        api_cost_usd: Number(today.apiCostUsd.toFixed(4)),
        cache_saved_usd: Number(today.cacheSavedUsd.toFixed(4))
      },
      month: {
        tokens: Math.round(month.tokens),
        input_tokens: Math.round(month.inputTokens),
        cache_read_tokens: Math.round(month.cacheReadTokens),
        output_tokens: Math.round(month.outputTokens),
        sessions: month.sessions,
        turns: month.turns,
        active_days: month.activeDaysSet.size,
        cache_hit_percent: monthPrompt > 0 ? Number(((month.cacheReadTokens / monthPrompt) * 100).toFixed(1)) : null,
        api_cost_usd: Number(month.apiCostUsd.toFixed(4)),
        cache_saved_usd: Number(month.cacheSavedUsd.toFixed(4)),
        last_7d_tokens: last7Keys.map((k) => Math.round(last7Totals[k] || 0))
      }
    }
  };
}

export function buildSessionMetricsFromIncremental(fileState) {
  if (!fileState || !fileState.session) return null;
  const s = fileState.session;
  const totalPrompt = s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens;
  const lastPrompt = s.lastTurnInput + s.lastTurnCacheRead + s.lastTurnCacheWrite;
  const avgCacheHit = totalPrompt > 0 ? Number(((s.cacheReadTokens / totalPrompt) * 100).toFixed(1)) : null;
  const lastCacheHit = lastPrompt > 0 ? Number(((s.lastTurnCacheRead / lastPrompt) * 100).toFixed(1)) : null;
  const windowSize = inferContextWindowSize(s.model);
  const usedPct = windowSize > 0 && s.lastTurnContextTokens > 0
    ? Number(Math.min(100, (s.lastTurnContextTokens / windowSize) * 100).toFixed(1))
    : null;
  const deltaTokens = s.prevTurnContextTokens > 0
    ? s.lastTurnContextTokens - s.prevTurnContextTokens
    : 0;

  const sqlTiming = fileState.sqliteTiming && typeof fileState.sqliteTiming === 'object'
    ? fileState.sqliteTiming
    : null;
  const resolvedOutputTps = (sqlTiming && typeof sqlTiming.output_tps === 'number' && Number.isFinite(sqlTiming.output_tps) && sqlTiming.output_tps > 0)
    ? sqlTiming.output_tps
    : s.lastOutputTps;
  const resolvedTtftMs = (sqlTiming && typeof sqlTiming.ttft_ms === 'number' && Number.isFinite(sqlTiming.ttft_ms) && sqlTiming.ttft_ms >= 0)
    ? sqlTiming.ttft_ms
    : (s.lastTurnTtftMs ?? null);

  return {
    conversation_id: s.sessionId,
    agent: 'agy',
    model_id: normalizeModelId(s.model) || s.model || null,
    model_display: s.modelDisplay || formatModelDisplay(s.model) || null,
    effort: s.effort || null,
    turns: s.turns,
    context_used_tokens: s.lastTurnContextTokens,
    context_window_size: windowSize,
    context_used_percent: usedPct,
    last_turn_delta_tokens: deltaTokens,
    session_total_tokens: s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens + s.outputTokens,
    session_avg_cache_hit_percent: avgCacheHit,
    last_turn_cache_hit_percent: lastCacheHit,
    cold_start_alert: Boolean(lastPrompt >= 8000 && lastCacheHit !== null && lastCacheHit < 25),
    output_tps: resolvedOutputTps,
    ttft_ms: resolvedTtftMs,
    session_cost_usd: Number(s.costUsd.toFixed(4)),
    session_cache_saved_usd: Number(s.cacheSavedUsd.toFixed(4)),
    updated_at: s.lastSeenAt || null
  };
}
