/**
 * Optional read-only SQLite timing reader for agy-cli-hud.
 *
 * Reads exact server-reported TTFT (timeToFirstToken) and streaming duration
 * (streamingDuration) plus output token usage from `<appDataDir>/conversations/<convId>.db`
 * (`gen_metadata` table) to compute accurate comprehensive throughput:
 *   output_tps = outputTokens / (ttft + streamingSec)
 *
 * Guarantees:
 * - Zero external dependencies; Node.js >= 18 compatible via dynamic `import('node:sqlite')`.
 * - Strictly read-only (`{ readOnly: true, timeout }`), always closed in `finally`.
 * - OOM-safe SQL slicing (`substr(data, 1, 8192)` + `substr(data, -4096)` / `-65536`).
 * - Never imported on the `agy-hud statusline` hot path (only used by background `sync`).
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CONV_ID_RE = /^[0-9a-f-]{8,64}$/i;
const MAX_STAT_VALUE = 100_000_000;

let sqliteLoadPromise = null;
let cachedDatabaseSync = null;
let sqliteProbed = false;

export async function isSqliteAvailable() {
  if (sqliteProbed) return Boolean(cachedDatabaseSync);
  if (!sqliteLoadPromise) {
    sqliteLoadPromise = (async () => {
      const origEmitWarning = process.emitWarning;
      process.emitWarning = function filteredSqliteWarning(warning, ...rest) {
        const msg = typeof warning === 'string' ? warning : String(warning?.message || '');
        const type = typeof rest[0] === 'string' ? rest[0] : String(rest[0]?.type || warning?.name || '');
        if (type === 'ExperimentalWarning' && /sqlite/i.test(msg)) return;
        return origEmitWarning.call(process, warning, ...rest);
      };
      try {
        const mod = await import('node:sqlite');
        if (typeof mod?.DatabaseSync === 'function') {
          cachedDatabaseSync = mod.DatabaseSync;
        }
      } catch {
        cachedDatabaseSync = null;
      } finally {
        process.emitWarning = origEmitWarning;
        sqliteProbed = true;
      }
      return Boolean(cachedDatabaseSync);
    })();
  }
  return sqliteLoadPromise;
}

export function getSqliteFileSig(dbPath) {
  if (!dbPath || typeof dbPath !== 'string') return null;
  try {
    const st = statSync(dbPath);
    if (!st.isFile()) return null;
    let sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
    const walPath = `${dbPath}-wal`;
    try {
      if (existsSync(walPath)) {
        const wst = statSync(walPath);
        sig += `|${wst.ino}:${wst.size}:${wst.mtimeMs}`;
      }
    } catch {}
    return sig;
  } catch {
    return null;
  }
}

export function resolveConversationDbPath(sessionId, source, paths) {
  if (!sessionId || !CONV_ID_RE.test(String(sessionId)) || !paths) return null;
  const dirs = source === 'desktop'
    ? [paths.desktopConversationsDir, paths.cliConversationsDir]
    : [paths.cliConversationsDir, paths.desktopConversationsDir];
  const seen = new Set();
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const candidate = join(dir, `${sessionId}.db`);
    try {
      if (existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// Minimal bounds-safe Protobuf wire decoder (zero dependencies)
// ---------------------------------------------------------------------------

function toBuffer(val) {
  if (!val) return null;
  if (Buffer.isBuffer(val)) return val;
  if (val instanceof Uint8Array) return Buffer.from(val.buffer, val.byteOffset, val.byteLength);
  if (typeof val === 'string') return Buffer.from(val, 'utf8');
  return null;
}

function readVarint(buf, offset, end = buf.length) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < end && shift < 70n) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      const value = result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : Number.MAX_SAFE_INTEGER;
      return { value, big: result, next: pos };
    }
    shift += 7n;
  }
  return null;
}

function parseProtobufFields(buf, start = 0, end = buf.length, maxFields = 512) {
  const fields = [];
  let pos = start;
  let count = 0;
  let truncated = false;
  while (pos < end && count < maxFields) {
    const tag = readVarint(buf, pos, end);
    if (!tag || tag.big <= 0n) {
      truncated = true;
      break;
    }
    const fn = Number(tag.big >> 3n);
    const wt = Number(tag.big & 7n);
    if (!Number.isFinite(fn) || fn <= 0 || fn > 536870911) {
      truncated = true;
      break;
    }
    pos = tag.next;
    if (wt === 0) {
      const v = readVarint(buf, pos, end);
      if (!v) { truncated = true; break; }
      fields.push({ fn, wt, val: v.value, big: v.big });
      pos = v.next;
    } else if (wt === 1) {
      if (pos + 8 > end) { truncated = true; break; }
      fields.push({ fn, wt, buf: buf.subarray(pos, pos + 8) });
      pos += 8;
    } else if (wt === 2) {
      const len = readVarint(buf, pos, end);
      if (!len || len.value < 0) { truncated = true; break; }
      const bodyStart = len.next;
      const bodyEnd = bodyStart + len.value;
      if (bodyEnd > end) {
        fields.push({ fn, wt, truncated: true, buf: buf.subarray(bodyStart, end) });
        truncated = true;
        break;
      }
      fields.push({ fn, wt, buf: buf.subarray(bodyStart, bodyEnd) });
      pos = bodyEnd;
    } else if (wt === 5) {
      if (pos + 4 > end) { truncated = true; break; }
      fields.push({ fn, wt, buf: buf.subarray(pos, pos + 4) });
      pos += 4;
    } else {
      truncated = true;
      break;
    }
    count += 1;
  }
  return { fields, truncated };
}

function decodePackedVarints(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length && out.length < 512) {
    const v = readVarint(buf, pos, buf.length);
    if (!v) break;
    out.push(v.value);
    pos = v.next;
  }
  return out;
}

function decodeDurationSec(buf) {
  if (!buf || buf.length === 0 || buf.length > 32) return null;
  const { fields, truncated } = parseProtobufFields(buf, 0, buf.length, 8);
  if (truncated || !fields.length) return null;
  let sec = 0;
  let nanos = 0;
  let sawAny = false;
  for (const f of fields) {
    if (f.wt !== 0) return null;
    if (f.fn === 1) { sec = f.val; sawAny = true; }
    else if (f.fn === 2) { nanos = f.val; sawAny = true; }
    else return null;
  }
  if (!sawAny || sec < 0 || sec > 86400 || nanos < 0 || nanos >= 1e9) return null;
  return Number((sec + nanos / 1e9).toFixed(3));
}

function parseUsageSubmessage(buf) {
  if (!buf || !buf.length) return null;
  const { fields } = parseProtobufFields(buf, 0, buf.length, 32);
  let outputTokens = 0;
  let thinkingTokens = 0;
  let responseTokens = 0;
  for (const f of fields) {
    if (f.wt !== 0 || f.val < 0 || f.val > MAX_STAT_VALUE) continue;
    if (f.fn === 3) outputTokens = f.val;
    else if (f.fn === 9) thinkingTokens = f.val;
    else if (f.fn === 10) responseTokens = f.val;
  }
  const effectiveOutput = Math.max(outputTokens, thinkingTokens + responseTokens);
  if (effectiveOutput <= 0) return null;
  return {
    outputTokens: effectiveOutput,
    thinkingTokens,
    responseTokens
  };
}

function applyF1TimingFields(fields, target) {
  for (const f of fields) {
    if (f.fn === 4 && f.wt === 2 && !f.truncated && !target.usage) {
      const u = parseUsageSubmessage(f.buf);
      if (u) target.usage = u;
    } else if (f.fn === 11 && f.wt === 2 && !f.truncated && target.ttft === null) {
      const sec = decodeDurationSec(f.buf);
      if (sec !== null) target.ttft = sec;
    } else if (f.fn === 12 && f.wt === 2 && !f.truncated && target.streamingSec === null) {
      const sec = decodeDurationSec(f.buf);
      if (sec !== null) target.streamingSec = sec;
    }
  }
}

function applyTopTimingFields(fields, target) {
  for (const f of fields) {
    if (f.fn === 1 && f.wt === 2) {
      const inner = parseProtobufFields(f.buf, 0, f.buf.length, 512);
      applyF1TimingFields(inner.fields, target);
    } else if (f.fn === 2) {
      if (f.wt === 2 && !f.truncated) {
        for (const n of decodePackedVarints(f.buf)) {
          if (n >= 0 && n < 1_000_000) target.stepIndices.add(n);
        }
      } else if (f.wt === 0 && f.val >= 0 && f.val < 1_000_000) {
        target.stepIndices.add(f.val);
      }
    }
  }
}

function scanTailForDurations(tailBuf, target) {
  if (!tailBuf || tailBuf.length < 4) return;
  if (target.ttft !== null && target.streamingSec !== null) return;
  const len = tailBuf.length;
  for (let i = 0; i < len - 3; i += 1) {
    const b = tailBuf[i];
    if ((b === 0x5a && target.ttft === null) || (b === 0x62 && target.streamingSec === null)) {
      const l = readVarint(tailBuf, i + 1, len);
      if (!l || l.value < 2 || l.value > 24 || l.next + l.value > len) continue;
      const sec = decodeDurationSec(tailBuf.subarray(l.next, l.next + l.value));
      if (sec === null) continue;
      const afterPos = l.next + l.value;
      if (afterPos < len) {
        const nextTag = readVarint(tailBuf, afterPos, len);
        if (!nextTag) continue;
        const nextFn = Number(nextTag.big >> 3n);
        const nextWt = Number(nextTag.big & 7n);
        if (nextFn <= 0 || nextFn > 64 || nextWt > 5) continue;
      }
      if (b === 0x5a) target.ttft = sec;
      else target.streamingSec = sec;
      if (target.ttft !== null && target.streamingSec !== null) return;
    }
  }
}

export function decodeGenMetadataTimingRow(headRaw, tailRaw = null, extraTailRaw = null) {
  const headBuf = toBuffer(headRaw);
  const tailBuf = toBuffer(tailRaw);
  const extraTailBuf = toBuffer(extraTailRaw);
  const target = {
    stepIndices: new Set(),
    usage: null,
    ttft: null,
    streamingSec: null
  };
  if (headBuf && headBuf.length > 0) {
    const top = parseProtobufFields(headBuf, 0, headBuf.length, 512);
    applyTopTimingFields(top.fields, target);
  }
  if (extraTailBuf && extraTailBuf.length > 0) {
    scanTailForDurations(extraTailBuf, target);
  }
  if (tailBuf && tailBuf.length > 0) {
    scanTailForDurations(tailBuf, target);
  }
  return {
    stepIndices: [...target.stepIndices].sort((a, b) => a - b),
    usage: target.usage,
    ttft: target.ttft,
    streamingSec: target.streamingSec
  };
}

function getTableColumns(db, tableName) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
    if (!Array.isArray(rows) || !rows.length) return new Set();
    return new Set(rows.map((r) => String(r?.name || '').trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * Reads the most recent completed generation timing from `gen_metadata`.
 * Walks up to 6 newest rows to skip in-progress / incomplete rows.
 *
 * Returns `{ status: 'ok', timing }` where `timing` may be `null` if no completed
 * row exists yet, or `{ status: 'unavailable' }` if SQLite cannot be opened.
 */
export async function readLatestGenTimingFromSqlite(convDbPath, { timeoutMs = 200 } = {}) {
  if (!convDbPath || typeof convDbPath !== 'string') {
    return { status: 'unavailable', timing: null };
  }
  if (!(await isSqliteAvailable())) {
    return { status: 'unavailable', timing: null };
  }
  let db = null;
  try {
    const safeTimeout = Math.max(20, Number(timeoutMs) || 200);
    db = new cachedDatabaseSync(convDbPath, { readOnly: true, timeout: safeTimeout });
    const cols = getTableColumns(db, 'gen_metadata');
    if (!cols.has('idx') || !cols.has('data')) {
      return { status: 'ok', timing: null };
    }

    const rows = db.prepare(`
      SELECT idx, length(data) AS len,
             CASE WHEN length(data) <= 16384 THEN data ELSE substr(data, 1, 8192) END AS head,
             CASE WHEN length(data) <= 16384 THEN NULL ELSE substr(data, -4096) END AS tail
      FROM gen_metadata
      ORDER BY idx DESC
      LIMIT 6
    `).all();
    if (!Array.isArray(rows) || !rows.length) {
      return { status: 'ok', timing: null };
    }

    for (const row of rows) {
      let decoded = decodeGenMetadataTimingRow(row.head, row.tail, null);
      if (
        Number(row.len) > 16384 &&
        decoded.usage?.outputTokens > 0 &&
        (decoded.ttft === null || decoded.streamingSec === null)
      ) {
        try {
          const extra = db
            .prepare('SELECT substr(data, -65536) AS tail64 FROM gen_metadata WHERE idx = ?')
            .get(row.idx);
          if (extra?.tail64) {
            decoded = decodeGenMetadataTimingRow(row.head, row.tail, extra.tail64);
          }
        } catch {}
      }

      const outputTokens = Number(decoded.usage?.outputTokens || 0);
      const ttft = typeof decoded.ttft === 'number' && Number.isFinite(decoded.ttft) ? decoded.ttft : null;
      const streamingSec = typeof decoded.streamingSec === 'number' && Number.isFinite(decoded.streamingSec)
        ? decoded.streamingSec
        : null;
      const durationSec = (ttft !== null && streamingSec !== null)
        ? (ttft + streamingSec)
        : (streamingSec ?? ttft ?? null);

      if (outputTokens > 0 && durationSec !== null && durationSec >= 0.05) {
        return {
          status: 'ok',
          timing: {
            idx: Number(row.idx ?? 0),
            step_indices: decoded.stepIndices,
            output_tokens: outputTokens,
            ttft_ms: ttft !== null ? Math.round(ttft * 1000) : null,
            streaming_ms: streamingSec !== null ? Math.round(streamingSec * 1000) : null,
            duration_ms: Math.round(durationSec * 1000),
            output_tps: Number((outputTokens / durationSec).toFixed(1)),
            source: 'sqlite'
          }
        };
      }
    }

    return { status: 'ok', timing: null };
  } catch {
    return { status: 'unavailable', timing: null };
  } finally {
    try { db?.close(); } catch {}
  }
}

/**
 * Enriches the active session and recent active sessions in `incrementalResult`
 * with exact server-side timing from SQLite `gen_metadata`, cached by DB+WAL signature.
 */
export async function enrichSessionsWithSqliteTiming({
  incrementalResult,
  paths,
  explicitSessionId = null,
  maxSessions = 6,
  timeoutMs = 200
} = {}) {
  if (!incrementalResult?.sessionsById || incrementalResult.sessionsById.size === 0 || !paths) {
    return { changed: false };
  }
  if (!(await isSqliteAvailable())) {
    return { changed: false };
  }

  const candidates = [];
  const seen = new Set();
  const addCandidate = (fState) => {
    if (!fState || !fState.sessionId || seen.has(fState.sessionId)) return;
    seen.add(fState.sessionId);
    candidates.push(fState);
  };

  if (explicitSessionId && incrementalResult.sessionsById.has(explicitSessionId)) {
    addCandidate(incrementalResult.sessionsById.get(explicitSessionId));
  }
  const recent = Array.from(incrementalResult.sessionsById.values())
    .filter((f) => f && f.sessionId && f.session && f.session.turns > 0)
    .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))
    .slice(0, Math.max(1, maxSessions));
  for (const f of recent) {
    addCandidate(f);
  }

  let changed = false;
  for (const fState of candidates) {
    const dbPath = resolveConversationDbPath(fState.sessionId, fState.source, paths);
    const sig = dbPath ? getSqliteFileSig(dbPath) : null;
    if (!sig) {
      if (fState.sqliteTimingSig || fState.sqliteTiming) {
        fState.sqliteTimingSig = null;
        fState.sqliteTiming = null;
        changed = true;
      }
      continue;
    }
    if (fState.sqliteTimingSig === sig) {
      continue;
    }
    const res = await readLatestGenTimingFromSqlite(dbPath, { timeoutMs });
    if (res.status !== 'ok') {
      // Preserve last known timing on transient lock/error
      continue;
    }
    fState.sqliteTimingSig = sig;
    fState.sqliteTiming = res.timing;
    changed = true;
  }

  return { changed };
}
