/**
 * Optional Read-Only SQLite Signal Reader for Antigravity Context & Token Viewer.
 *
 * Strict compliance guarantees:
 * 1. Zero external dependencies; compatible with Node.js >= 18 via dynamic `import('node:sqlite')`.
 * 2. Strictly read-only (`{ readOnly: true, timeout: 1500 }`), always closed in `finally`.
 * 3. OOM-safe SQL slicing on large `gen_metadata` BLOBs (`substr(data, 1, 8192)` + `substr(data, -4096)`).
 * 4. All user-facing strings (titles, project names, event details) are sanitized to prevent
 *    leaking absolute home paths, raw emails, bearer/API tokens, or internal URLs.
 */

import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  formatModelDisplayName,
  normalizeModelId,
  sanitizeDiagnosticText
} from './pricing.mjs';

const CACHE_MAX_ENTRIES = 256;
const MAX_STAT_VALUE = 100_000_000;
const MAX_TOOL_DURATION_SECS = 31_536_000_000;
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const CANARY_RESPONSE_RE = /canary|experiment|exp-|abtest|shadow/i;
const ORCHESTRATOR_OR_PLAN_RE = /\b(?:plan|planner|orchestrator)\b/i;

export const TOKEN_CATEGORIES = Object.freeze({
  1: { type: 1, key: 'system', label: '系统提示词', color: '#94a3b8' },
  2: { type: 2, key: 'tools', label: '工具定义', color: '#a78bfa' },
  3: { type: 3, key: 'rules', label: '规则', color: '#f472b6' },
  4: { type: 4, key: 'mcp', label: 'MCP 工具', color: '#2dd4bf' },
  5: { type: 5, key: 'skills', label: '技能', color: '#f59e0b' },
  6: { type: 6, key: 'subagents', label: '子代理', color: '#fb923c' },
  7: { type: 7, key: 'messages', label: '对话消息', color: '#3b82f6' },
  8: { type: 8, key: 'workflows', label: '工作流', color: '#10b981' },
  9: { type: 9, key: 'plugins', label: '插件', color: '#c084fc' },
  10: { type: 10, key: 'flows', label: '流程', color: '#38bdf8' }
});

const EVENT_PATTERNS = [
  {
    kind: 'safety_filter',
    re: /safety|blocked|recitation|prohibited_content|HARM_CATEGORY/i,
    excludeRe: /permission check failed|sandbox|not permitted/i
  },
  {
    kind: 'context_overflow',
    re: /context[^\r\n]{0,30}length|token[^\r\n]{0,30}limit|maximum context|too long/i,
    excludeRe: /deadline exceeded|idle timeout/i
  },
  {
    kind: 'quota_429',
    re: /\b429\b|rate.?limit|too many requests|RESOURCE_EXHAUSTED/i
  },
  {
    kind: 'upstream_retry',
    re: /\b503\b|\b502\b|\b504\b|unavailable|overloaded|retry|idle timeout|ECONNRESET/i,
    excludeRe: /permission check failed|not permitted|sandbox|user rejected|cancelled|canceled|denied/i
  }
];

let sqliteLoadPromise = null;
let cachedDatabaseSync = null;
let sqliteProbed = false;

const summaryIndexCache = new Map(); // dbPath -> { sig, value }
const convSignalsCache = new Map();  // `${dbPath}|${detailFlag}` -> { sig, value }

function setBoundedCache(map, key, entry) {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= CACHE_MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, entry);
}

function getFileCacheSig(dbPath) {
  try {
    const st = statSync(dbPath);
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

function isBusyError(err) {
  const msg = String(err?.message || err?.errstr || '');
  return (err?.code === 'ERR_SQLITE_ERROR' && /locked|busy/i.test(msg)) || /database is locked|SQLITE_BUSY/i.test(msg);
}

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

async function openReadOnlyDb(dbPath, timeoutMs = 1500, options = {}) {
  if (!dbPath || typeof dbPath !== 'string') return null;
  try {
    if (!existsSync(dbPath)) return null;
  } catch {
    return null;
  }
  if (!(await isSqliteAvailable())) return null;
  const safeTimeout = Math.max(20, Number(timeoutMs) || 1500);
  let db = null;
  try {
    db = new cachedDatabaseSync(dbPath, { readOnly: true, timeout: safeTimeout });
    db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
    return db;
  } catch (err) {
    try { db?.close(); } catch {}
    if (options?.rethrowBusy && isBusyError(err)) {
      throw err;
    }
    return null;
  }
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

export function sanitizeSqliteText(raw, maxLen = 120) {
  if (raw === null || raw === undefined) return '';
  const cleaned = String(raw)
    .replace(/file:\/\/\/[^\s"'<>]+/gi, '<FILE>')
    .replace(/(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s"'<>]+/g, '~')
    .replace(/\b(?:Bearer\s+[A-Za-z0-9._~+/=-]{8,}|(?:sk|ghp|gho|glpat|xoxb|AIza|ya29)[-_A-Za-z0-9.]{12,})\b/gi, '<REDACTED>')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitizeDiagnosticText(cleaned, maxLen);
}

function parseWorkspaceUriList(rawWorkspaceUris) {
  if (!rawWorkspaceUris) return [];
  if (Array.isArray(rawWorkspaceUris)) {
    return rawWorkspaceUris.map((x) => String(x || '').trim()).filter(Boolean);
  }
  const str = String(rawWorkspaceUris).trim();
  if (!str) return [];
  if (str.startsWith('[')) {
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) {
        return parsed.map((x) => String(x || '').trim()).filter(Boolean);
      }
    } catch {}
  }
  return str
    .split(/[\r\n,]+/)
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

export function extractProjectNameFromUris(rawWorkspaceUris, rawProjectId = '') {
  const uris = parseWorkspaceUriList(rawWorkspaceUris);
  for (const uri of uris) {
    let localPath = '';
    if (/^file:\/\//i.test(uri)) {
      try {
        localPath = fileURLToPath(uri);
      } catch {
        try {
          localPath = decodeURIComponent(uri.replace(/^file:\/\//i, ''));
        } catch {
          localPath = uri.replace(/^file:\/\//i, '');
        }
      }
    } else if (!/^https?:\/\//i.test(uri)) {
      localPath = uri;
    }
    const trimmed = localPath.replace(/[\\/]+$/, '');
    if (!trimmed) continue;
    const base = basename(trimmed).trim();
    if (base && base !== '.' && base !== '..' && base !== '~' && base !== '/' && base !== '\\') {
      return sanitizeSqliteText(base, 64);
    }
  }

  const pid = String(rawProjectId || '').trim();
  if (pid) {
    let candidate = pid;
    if (/^file:\/\//i.test(candidate)) {
      try { candidate = fileURLToPath(candidate); } catch { candidate = candidate.replace(/^file:\/\//i, ''); }
    }
    candidate = candidate.replace(/[\\/]+$/, '');
    if (candidate.includes('/') || candidate.includes('\\')) {
      candidate = basename(candidate);
    }
    const safe = sanitizeSqliteText(candidate, 64);
    if (safe && safe !== '~' && !safe.includes('<REDACTED>') && !safe.includes('<API>')) {
      return safe;
    }
  }
  return null;
}

export async function readConversationSummariesIndex(appDataDir) {
  if (!appDataDir || typeof appDataDir !== 'string') return null;
  const dbPath = join(appDataDir, 'conversation_summaries.db');
  const sig = getFileCacheSig(dbPath);
  if (!sig) return null;

  const hit = summaryIndexCache.get(dbPath);
  if (hit && hit.sig === sig) {
    return hit.value;
  }

  const db = await openReadOnlyDb(dbPath);
  if (!db) return null;

  try {
    const byId = new Map();
    const childrenByParent = new Map();
    const childSets = new Map();

    const addChildEdge = (parentId, childId) => {
      const p = String(parentId || '').trim();
      const c = String(childId || '').trim();
      if (!p || !c || p === c) return;
      let set = childSets.get(p);
      if (!set) {
        set = new Set();
        childSets.set(p, set);
      }
      set.add(c);
    };

    const sumCols = getTableColumns(db, 'conversation_summaries');
    if (sumCols.has('conversation_id')) {
      const wanted = [
        'conversation_id',
        'title',
        'workspace_uris',
        'project_id',
        'agent_name',
        'parent_conversation_id',
        'nesting_depth',
        'source',
        'status'
      ];
      const selectCols = wanted.filter((c) => sumCols.has(c));
      const rows = db.prepare(`SELECT ${selectCols.join(', ')} FROM conversation_summaries`).all();
      for (const row of rows) {
        const convId = String(row?.conversation_id || '').trim();
        if (!convId) continue;
        const uris = parseWorkspaceUriList(row.workspace_uris);
        const firstUri = uris[0] || '';
        const projectName = extractProjectNameFromUris(row.workspace_uris, row.project_id);
        const parentConvId = row.parent_conversation_id ? String(row.parent_conversation_id).trim() : null;
        const depthNum = Number(row.nesting_depth);
        const entry = {
          title: row.title ? sanitizeSqliteText(row.title, 80) : '',
          workspaceUri: firstUri || null,
          projectName: projectName || null,
          agentName: row.agent_name ? sanitizeSqliteText(row.agent_name, 64) : '',
          parentConvId,
          nestingDepth: Number.isFinite(depthNum) ? depthNum : 0,
          source: row.source ? String(row.source).trim() : '',
          status: row.status ? String(row.status).trim() : ''
        };
        byId.set(convId, entry);
        if (parentConvId) addChildEdge(parentConvId, convId);
      }
    }

    const parentCols = getTableColumns(db, 'conversation_parents');
    if (parentCols.has('conversation_id') && parentCols.has('parent_id')) {
      const rows = db.prepare('SELECT conversation_id, parent_id FROM conversation_parents').all();
      for (const row of rows) {
        const convId = String(row?.conversation_id || '').trim();
        const parentId = String(row?.parent_id || '').trim();
        if (!convId || !parentId || convId === parentId) continue;
        addChildEdge(parentId, convId);
        const existing = byId.get(convId);
        if (existing) {
          if (!existing.parentConvId) existing.parentConvId = parentId;
        } else {
          byId.set(convId, {
            title: '',
            workspaceUri: null,
            projectName: null,
            agentName: '',
            parentConvId: parentId,
            nestingDepth: 1,
            source: '',
            status: ''
          });
        }
      }
    }

    for (const [parentId, set] of childSets.entries()) {
      childrenByParent.set(parentId, [...set]);
    }

    const result = { byId, childrenByParent };
    setBoundedCache(summaryIndexCache, dbPath, { sig, value: result });
    return result;
  } catch {
    return null;
  } finally {
    try { db.close(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Minimal Protobuf Wire Decoder (zero dependencies, bounds-safe)
// ---------------------------------------------------------------------------

function toBuffer(val) {
  if (!val) return null;
  if (Buffer.isBuffer(val)) return val;
  if (val instanceof Uint8Array) return Buffer.from(val.buffer, val.byteOffset, val.byteLength);
  if (typeof val === 'string') return Buffer.from(val, 'utf-8');
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
      const num = result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : Number.MAX_SAFE_INTEGER;
      return { value: num, big: result, next: pos };
    }
    shift += 7n;
  }
  return null;
}

function parseProtobufFields(buf, start = 0, end = buf.length, maxFields = 1024) {
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
      fields.push({ fn, wt, val: v.value, big: v.big, start: tag.next, end: v.next });
      pos = v.next;
    } else if (wt === 1) {
      if (pos + 8 > end) { truncated = true; break; }
      fields.push({ fn, wt, buf: buf.subarray(pos, pos + 8), start: pos, end: pos + 8 });
      pos += 8;
    } else if (wt === 2) {
      const len = readVarint(buf, pos, end);
      if (!len || len.value < 0) { truncated = true; break; }
      const bodyStart = len.next;
      const bodyEnd = bodyStart + len.value;
      if (bodyEnd > end) {
        fields.push({ fn, wt, truncated: true, declaredLen: len.value, bodyStart, buf: buf.subarray(bodyStart, end) });
        truncated = true;
        break;
      }
      fields.push({ fn, wt, buf: buf.subarray(bodyStart, bodyEnd), start: bodyStart, end: bodyEnd });
      pos = bodyEnd;
    } else if (wt === 5) {
      if (pos + 4 > end) { truncated = true; break; }
      fields.push({ fn, wt, buf: buf.subarray(pos, pos + 4), start: pos, end: pos + 4 });
      pos += 4;
    } else {
      truncated = true;
      break;
    }
    count++;
  }
  return { fields, pos, truncated };
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

function decodeDuration(buf) {
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

function decodeToolTimestamp(buf) {
  if (!buf || buf.length === 0 || buf.length > 32) return null;
  const { fields, truncated } = parseProtobufFields(buf, 0, buf.length, 8);
  if (truncated || !fields.length) return null;
  let sec = 0;
  let nanos = 0;
  let sawAny = false;
  for (const f of fields) {
    if (f.wt !== 0) continue;
    if (f.fn === 1) { sec = f.val; sawAny = true; }
    else if (f.fn === 2) { nanos = f.val; sawAny = true; }
  }
  if (!sawAny || sec < 0 || sec >= MAX_TOOL_DURATION_SECS || nanos < 0 || nanos >= 1e9) return null;
  return sec + nanos / 1e9;
}

function buildCategoriesFromTypeTotals(typeTotals) {
  const ordered = [];
  for (const cat of Object.values(TOKEN_CATEGORIES)) {
    const tokens = typeTotals[cat.type] || 0;
    if (tokens > 0) {
      ordered.push({ ...cat, tokens });
    }
  }
  for (const [typeStr, tokens] of Object.entries(typeTotals)) {
    const typeNum = Number(typeStr);
    if (!TOKEN_CATEGORIES[typeNum] && tokens > 0) {
      ordered.push({
        type: typeNum,
        key: `other_${typeNum}`,
        label: `类别 ${typeNum}`,
        color: '#6b7280',
        tokens
      });
    }
  }
  return ordered;
}

function isPrintableAscii(buf, allowSpace = true) {
  if (!buf || !buf.length) return false;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b >= 0x21 && b <= 0x7e) continue;
    if (allowSpace && b === 0x20) continue;
    return false;
  }
  return true;
}

function isReasonableUtf8Text(buf) {
  if (!buf || !buf.length) return false;
  const s = buf.toString('utf-8');
  if (!s.trim() || s.includes('\uFFFD')) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return false;
  }
  return true;
}

function enumToPlaceholderModel(enumNum) {
  const n = Number(enumNum);
  if (!Number.isInteger(n) || n <= 1000 || n >= 100000) return '';
  return `MODEL_PLACEHOLDER_M${n - 1000}`;
}

function extractMaxContextFromCtxWindow(buf) {
  if (!buf || !buf.length) return null;
  const { fields } = parseProtobufFields(buf, 0, buf.length, 64);
  const candidates = [];
  let fn1Val = null;
  for (const f of fields) {
    if (f.wt !== 0) continue;
    if (f.val >= 8192 && f.val <= 10_000_000) {
      if (f.fn === 1) fn1Val = f.val;
      candidates.push({ fn: f.fn, val: f.val });
    }
  }
  if (!candidates.length) return null;
  const roundCandidates = candidates.filter((c) => c.val >= 16384 && (c.val % 1000 === 0 || c.val % 1024 === 0));
  if (roundCandidates.length) {
    return Math.max(...roundCandidates.map((c) => c.val));
  }
  if (fn1Val !== null) return fn1Val;
  return Math.max(...candidates.map((c) => c.val));
}

function extractContextWindowMetadata(buf, fallbackMaxCtx = null) {
  if (!buf || !buf.length) return null;
  const { fields } = parseProtobufFields(buf, 0, buf.length, 64);
  let usedTokens = 0;
  let bdFallbackUsed = 0;
  let maxTokens = 0;
  const groups = [];
  const typeTotals = Object.create(null);

  for (const f of fields) {
    if (f.fn === 1 && f.wt === 0 && f.val >= 0 && f.val <= MAX_STAT_VALUE) {
      usedTokens = f.val;
    } else if (f.fn === 4 && f.wt === 0 && f.val >= 8192 && f.val <= 10_000_000) {
      maxTokens = f.val;
    } else if (f.fn === 3 && f.wt === 2 && !f.truncated) {
      const bdParsed = parseProtobufFields(f.buf, 0, f.buf.length, 64);
      for (const gf of bdParsed.fields) {
        if (gf.fn === 2 && gf.wt === 0 && gf.val > 0 && gf.val <= MAX_STAT_VALUE) {
          bdFallbackUsed = gf.val;
          continue;
        }
        if (gf.fn !== 1 || gf.wt !== 2 || gf.truncated) continue;
        const gParsed = parseProtobufFields(gf.buf, 0, gf.buf.length, 128);
        let groupName = '';
        let categoryType = 0;
        let groupNumTokens = 0;
        const children = [];
        for (const cf of gParsed.fields) {
          if (cf.fn === 1 && cf.wt === 2 && !cf.truncated && isReasonableUtf8Text(cf.buf)) {
            groupName = sanitizeSqliteText(cf.buf.toString('utf-8'), 64);
          } else if (cf.fn === 2 && cf.wt === 0 && cf.val > 0 && cf.val < 1000) {
            categoryType = cf.val;
          } else if (cf.fn === 4 && cf.wt === 0 && cf.val >= 0 && cf.val <= MAX_STAT_VALUE) {
            groupNumTokens = cf.val;
          } else if (cf.fn === 5 && cf.wt === 2 && !cf.truncated) {
            const cParsed = parseProtobufFields(cf.buf, 0, cf.buf.length, 32);
            let childName = '';
            let childTokens = 0;
            for (const sub of cParsed.fields) {
              if (sub.fn === 1 && sub.wt === 2 && !sub.truncated && isReasonableUtf8Text(sub.buf)) {
                childName = sanitizeSqliteText(sub.buf.toString('utf-8'), 64);
              } else if (sub.fn === 3 && sub.wt === 0 && sub.val >= 0 && sub.val <= MAX_STAT_VALUE) {
                childTokens = sub.val;
              }
            }
            if (childName || childTokens > 0) {
              children.push({
                name: childName || 'item',
                numTokens: childTokens
              });
            }
          }
        }
        if (categoryType > 0 && groupNumTokens > 0 && groupNumTokens <= MAX_STAT_VALUE) {
          typeTotals[categoryType] = (typeTotals[categoryType] || 0) + groupNumTokens;
        }
        if (groupName || groupNumTokens > 0 || children.length > 0) {
          const catMeta = categoryType > 0 ? TOKEN_CATEGORIES[categoryType] : null;
          groups.push({
            name: groupName || catMeta?.label || '未命名分组',
            numTokens: groupNumTokens,
            children
          });
        }
      }
    }
  }

  if (!groups.length) return null;
  const categories = buildCategoriesFromTypeTotals(typeTotals);
  const groupSum = groups.reduce((acc, g) => acc + (g.numTokens > 0 ? g.numTokens : 0), 0);
  return {
    totalTokens: usedTokens > 0 ? usedTokens : (bdFallbackUsed > 0 ? bdFallbackUsed : groupSum),
    maxContextTokens: maxTokens || fallbackMaxCtx || null,
    tokenBreakdown: { groups, categories }
  };
}

function parseChatStartMetadata(buf, target) {
  if (!buf || !buf.length) return;
  const { fields } = parseProtobufFields(buf, 0, buf.length, 128);
  for (const f of fields) {
    if (f.fn === 1 && f.wt === 0 && f.val > 1000 && f.val < 100000) {
      if (!target.requestedModelEnum) target.requestedModelEnum = f.val;
    } else if (f.fn === 28 && f.wt === 2 && !f.truncated && f.buf.length > 0 && f.buf.length <= 128) {
      if (isPrintableAscii(f.buf, true) && !target.requestedSlug) {
        target.requestedSlug = f.buf.toString('utf-8').trim();
      }
    } else if (f.fn === 10 && f.wt === 2 && !f.truncated) {
      const maxCtx = extractMaxContextFromCtxWindow(f.buf);
      if (maxCtx && !target.maxContextTokens) target.maxContextTokens = maxCtx;
      if (target.parseBreakdown === true && !target.contextWindowMetadata) {
        const ctxMeta = extractContextWindowMetadata(f.buf, target.maxContextTokens || maxCtx || null);
        if (ctxMeta) target.contextWindowMetadata = ctxMeta;
      }
    }
  }
}

function parseKvEntry(buf) {
  if (!buf || buf.length < 4 || buf.length > 512) return null;
  const { fields, truncated } = parseProtobufFields(buf, 0, buf.length, 8);
  if (truncated || fields.length < 2) return null;
  let key = '';
  let value = '';
  for (const f of fields) {
    if (f.wt !== 2 || f.truncated) return null;
    if (f.fn === 1) {
      if (!isPrintableAscii(f.buf, false)) return null;
      key = f.buf.toString('utf-8');
    } else if (f.fn === 2) {
      if (!isReasonableUtf8Text(f.buf)) return null;
      value = f.buf.toString('utf-8').trim();
    }
  }
  if (!key || !value) return null;
  return { key, value };
}

function parseUsageSubmessage(buf) {
  if (!buf || !buf.length) return null;
  const { fields } = parseProtobufFields(buf, 0, buf.length, 32);
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let thinkingTokens = 0;
  let responseTokens = 0;
  let id11 = null;
  let id12 = null;
  let id7 = null;
  let hasPositive = false;
  for (const f of fields) {
    if (f.wt === 0 && f.val >= 0 && f.val <= MAX_STAT_VALUE) {
      if (f.fn === 2) { inputTokens = f.val; if (f.val > 0) hasPositive = true; }
      else if (f.fn === 3) { outputTokens = f.val; if (f.val > 0) hasPositive = true; }
      else if (f.fn === 4) { cacheWriteTokens = f.val; if (f.val > 0) hasPositive = true; }
      else if (f.fn === 5) { cacheReadTokens = f.val; if (f.val > 0) hasPositive = true; }
      else if (f.fn === 9) { thinkingTokens = f.val; if (f.val > 0) hasPositive = true; }
      else if (f.fn === 10) { responseTokens = f.val; if (f.val > 0) hasPositive = true; }
    } else if (f.wt === 2 && !f.truncated && f.buf.length > 0 && f.buf.length <= 512) {
      if (f.fn === 11) id11 = f.buf;
      else if (f.fn === 12) id12 = f.buf;
      else if (f.fn === 7) id7 = f.buf;
    }
  }
  const effectiveOutput = Math.max(outputTokens, thinkingTokens + responseTokens);
  if (effectiveOutput > 0) hasPositive = true;
  if (!hasPositive) return null;
  const idBuf = id11 ?? id12 ?? id7;
  return {
    usage: {
      inputTokens,
      outputTokens: effectiveOutput,
      cacheReadTokens,
      cacheWriteTokens,
      thinkingTokens,
      responseTokens
    },
    dedupId: idBuf ? idBuf.toString('hex') : null
  };
}

function applyF1Fields(fields, target) {
  for (const f of fields) {
    if (f.fn === 3 && f.wt === 0 && f.val > 1000 && f.val < 100000) {
      if (!target.respondedModelEnum) target.respondedModelEnum = f.val;
    } else if (f.fn === 4 && f.wt === 2 && !f.truncated) {
      const parsedUsage = parseUsageSubmessage(f.buf);
      if (parsedUsage && !target.usage) {
        target.usage = parsedUsage.usage;
        target.usageDedupId = parsedUsage.dedupId;
      }
    } else if (f.fn === 9 && f.wt === 2 && !f.truncated) {
      parseChatStartMetadata(f.buf, target);
    } else if (f.fn === 11 && f.wt === 2 && !f.truncated) {
      const sec = decodeDuration(f.buf);
      if (sec !== null && target.ttft === null) target.ttft = sec;
    } else if (f.fn === 12 && f.wt === 2 && !f.truncated) {
      const sec = decodeDuration(f.buf);
      if (sec !== null && target.streamingSec === null) target.streamingSec = sec;
    } else if (f.fn === 14 && f.wt === 0 && f.val >= 0 && f.val <= 100) {
      if (f.val > target.retries) target.retries = f.val;
    } else if (f.fn === 17 && f.wt === 2 && !f.truncated) {
      const sub = parseProtobufFields(f.buf, 0, f.buf.length, 32);
      for (const sf of sub.fields) {
        if (sf.fn === 2 && sf.wt === 2 && !sf.truncated) {
          const rParsed = parseUsageSubmessage(sf.buf);
          if (rParsed) {
            target.retryUsages.push(rParsed);
          }
        } else if (sf.fn === 3 && sf.wt === 2 && !sf.truncated && isReasonableUtf8Text(sf.buf)) {
          const errText = sanitizeSqliteText(sf.buf.toString('utf-8'), 220);
          if (errText && !target.retryErrors.includes(errText) && target.retryErrors.length < 8) {
            target.retryErrors.push(errText);
          }
        }
      }
    } else if (f.fn === 19 && f.wt === 2 && !f.truncated && f.buf.length >= 2 && f.buf.length <= 128) {
      if (isPrintableAscii(f.buf, false) && !target.responseModel) {
        const s = f.buf.toString('utf-8').trim();
        if (/[a-z]/i.test(s)) target.responseModel = s;
      }
    } else if (f.fn === 20 && f.wt === 2 && !f.truncated) {
      const kv = parseKvEntry(f.buf);
      if (kv) {
        target.kvMap[kv.key] = kv.value;
      }
    } else if (f.fn === 21 && f.wt === 2 && !f.truncated && f.buf.length >= 2 && f.buf.length <= 128) {
      if (isReasonableUtf8Text(f.buf) && !target.modelDisplayName) {
        target.modelDisplayName = f.buf.toString('utf-8').trim();
      }
    }
  }
}

function applyTopFields(fields, target) {
  for (const f of fields) {
    if (f.fn === 1 && f.wt === 2) {
      const inner = parseProtobufFields(f.buf, 0, f.buf.length, 512);
      applyF1Fields(inner.fields, target);
    } else if (f.fn === 2) {
      if (f.wt === 2 && !f.truncated) {
        const nums = decodePackedVarints(f.buf);
        for (const n of nums) {
          if (n >= 0 && n < 1_000_000) target.stepIndices.add(n);
        }
      } else if (f.wt === 0 && f.val >= 0 && f.val < 1_000_000) {
        target.stepIndices.add(f.val);
      }
    } else if (f.fn === 3 && f.wt === 2 && !f.truncated) {
      parseChatStartMetadata(f.buf, target);
    } else if (f.fn === 5 && f.wt === 2 && !f.truncated && isReasonableUtf8Text(f.buf)) {
      const errText = sanitizeSqliteText(f.buf.toString('utf-8'), 220);
      if (errText && !target.genError) target.genError = errText;
    }
  }
}

function scanLargeTailBuffer(tailBuf, target) {
  if (!tailBuf || tailBuf.length < 4) return;
  const len = tailBuf.length;

  // 1. High-confidence anchors inside F1 tail:
  //    - fn=20 map entries (tag bytes 0xa2 0x01)
  //    - fn=19 responseModel (tag bytes 0x9a 0x01)
  //    - fn=21 modelDisplayName (tag bytes 0xaa 0x01)
  const f1Anchors = [];
  for (let i = 0; i < len - 3; i++) {
    const b0 = tailBuf[i];
    const b1 = tailBuf[i + 1];
    if (b1 === 0x01 && (b0 === 0xa2 || b0 === 0x9a || b0 === 0xaa)) {
      const l = readVarint(tailBuf, i + 2, len);
      if (!l || l.value < 2 || l.value > 256 || l.next + l.value > len) continue;
      const body = tailBuf.subarray(l.next, l.next + l.value);
      if (b0 === 0xa2) {
        const kv = parseKvEntry(body);
        if (kv) {
          target.kvMap[kv.key] = kv.value;
          f1Anchors.push(i);
        }
      } else if (b0 === 0x9a) {
        if (isPrintableAscii(body, false)) {
          const s = body.toString('utf-8').trim();
          if (/[a-z]/i.test(s) && /[-_.:/0-9]/i.test(s)) {
            if (!target.responseModel) target.responseModel = s;
            f1Anchors.push(i);
          }
        }
      } else if (b0 === 0xaa) {
        if (isReasonableUtf8Text(body)) {
          const s = body.toString('utf-8').trim();
          if (s.length >= 3 && /[a-z]/i.test(s)) {
            if (!target.modelDisplayName) target.modelDisplayName = s;
            f1Anchors.push(i);
          }
        }
      }
    }
  }

  // From the earliest high-confidence F1 anchor, walk aligned protobuf fields forward.
  // Once F1 fields finish (or hit TOP fn=2 / fn=3), inspect remaining bytes as TOP tail.
  if (f1Anchors.length > 0) {
    const startOff = f1Anchors[0];
    const parsed = parseProtobufFields(tailBuf, startOff, len, 256);
    const f1Only = [];
    const topRest = [];
    let switchedToTop = false;
    for (const f of parsed.fields) {
      if (!switchedToTop && f.fn <= 3 && (f.fn === 2 || f.fn === 3)) {
        // Heuristic: fn=2 / fn=3 appearing after fn>=19 indicates we exited F1 into TOP
        switchedToTop = true;
      }
      if (switchedToTop) topRest.push(f);
      else f1Only.push(f);
    }
    applyF1Fields(f1Only, target);
    applyTopFields(topRest, target);
  }

  // 2. Scan for Duration fields fn=11 (0x5a) and fn=12 (0x62) if still missing
  if (target.ttft === null || target.streamingSec === null) {
    for (let i = 0; i < len - 3; i++) {
      const b = tailBuf[i];
      if ((b === 0x5a && target.ttft === null) || (b === 0x62 && target.streamingSec === null)) {
        const l = readVarint(tailBuf, i + 1, len);
        if (!l || l.value < 2 || l.value > 24 || l.next + l.value > len) continue;
        const sec = decodeDuration(tailBuf.subarray(l.next, l.next + l.value));
        if (sec === null) continue;
        // Require adjacent valid F1 field after duration to reduce false positives on random bytes
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
      }
    }
  }

  // 3. Scan for F1 fn=9 (0x4a) or TOP fn=3 (0x1a) carrying chatStartMetadata / maxContextTokens
  if (!target.maxContextTokens || !target.requestedModelEnum || !target.requestedSlug || (target.parseBreakdown && !target.contextWindowMetadata)) {
    for (let i = 0; i < len - 4; i++) {
      const b = tailBuf[i];
      if (b !== 0x4a && b !== 0x1a) continue;
      const l = readVarint(tailBuf, i + 1, len);
      if (!l || l.value < 3 || l.value > 4096 || l.next + l.value > len) continue;
      const body = tailBuf.subarray(l.next, l.next + l.value);
      const { fields, truncated } = parseProtobufFields(body, 0, body.length, 64);
      if (truncated || !fields.length) continue;
      const hasKnownStartField = fields.some((f) =>
        (f.fn === 1 && f.wt === 0 && f.val > 1000 && f.val < 100000) ||
        (f.fn === 28 && f.wt === 2 && !f.truncated && f.buf.length >= 2 && f.buf.length <= 128 && isPrintableAscii(f.buf, true)) ||
        (f.fn === 10 && f.wt === 2 && !f.truncated && Boolean(extractMaxContextFromCtxWindow(f.buf)))
      );
      if (!hasKnownStartField) continue;
      parseChatStartMetadata(body, target);
    }
  }
}

function decodeGenMetadataRow(headRaw, tailRaw, extraTailRaw = null, options = {}) {
  const headBuf = toBuffer(headRaw);
  const tailBuf = toBuffer(tailRaw);
  const extraTailBuf = toBuffer(extraTailRaw);
  const target = {
    stepIndices: new Set(),
    requestedModelEnum: 0,
    requestedSlug: '',
    respondedModelEnum: 0,
    responseModel: '',
    modelDisplayName: '',
    ttft: null,
    streamingSec: null,
    maxContextTokens: null,
    parseBreakdown: Boolean(options?.parseBreakdown),
    contextWindowMetadata: null,
    usage: null,
    usageDedupId: null,
    retryUsages: [],
    retries: 0,
    retryErrors: [],
    genError: '',
    kvMap: {},
    partial: false
  };

  if (headBuf && headBuf.length > 0) {
    const topParsed = parseProtobufFields(headBuf, 0, headBuf.length, 512);
    if (options?.rowLen > 0 && options.rowLen <= 16384 && topParsed.truncated) {
      target.partial = true;
    }
    applyTopFields(topParsed.fields, target);
  } else {
    target.partial = true;
  }
  if (extraTailBuf && extraTailBuf.length > 0) {
    scanLargeTailBuffer(extraTailBuf, target);
  }
  if (tailBuf && tailBuf.length > 0) {
    scanLargeTailBuffer(tailBuf, target);
  }

  // Reconcile KV map values (`model_enum`, `last_step_index`)
  if (!target.respondedModelEnum && target.kvMap.model_enum) {
    const rawEnum = String(target.kvMap.model_enum).trim();
    if (/^\d+$/.test(rawEnum)) {
      const n = Number(rawEnum);
      if (n > 1000 && n < 100000) target.respondedModelEnum = n;
    } else {
      const m = rawEnum.match(/MODEL_PLACEHOLDER_M(\d+)/i);
      if (m) target.respondedModelEnum = 1000 + Number(m[1]);
    }
  }
  if (target.stepIndices.size === 0 && target.kvMap.last_step_index && /^\d+$/.test(target.kvMap.last_step_index)) {
    target.stepIndices.add(Number(target.kvMap.last_step_index));
  }

  const rawReqId = String(target.kvMap.request_id || '').trim();
  const requestId = /^[A-Za-z0-9_.:-]{4,96}$/.test(rawReqId) ? rawReqId : null;

  const requestedPlaceholder = enumToPlaceholderModel(target.requestedModelEnum);
  const respondedPlaceholder = enumToPlaceholderModel(target.respondedModelEnum);
  const requestedModel = requestedPlaceholder || target.requestedSlug || '';
  const model = target.modelDisplayName
    || target.responseModel
    || respondedPlaceholder
    || requestedModel
    || '';

  return {
    stepIndices: [...target.stepIndices].sort((a, b) => a - b),
    requestedModelEnum: target.requestedModelEnum,
    respondedModelEnum: target.respondedModelEnum,
    requestedModel,
    requestedSlug: target.requestedSlug || '',
    responseModel: target.responseModel || '',
    modelDisplayName: target.modelDisplayName || '',
    model,
    ttft: target.ttft,
    streamingSec: target.streamingSec,
    maxContextTokens: target.maxContextTokens,
    contextWindowMetadata: target.contextWindowMetadata || null,
    usage: target.usage || null,
    usageDedupId: target.usageDedupId || null,
    retryUsages: target.retryUsages,
    requestId,
    retries: target.retries,
    retryErrors: target.retryErrors,
    genError: target.genError || '',
    partial: target.partial
  };
}

export function classifyDiagnosticEventText(text) {
  if (!text) return null;
  const s = String(text);
  for (const pat of EVENT_PATTERNS) {
    if (pat.excludeRe && pat.excludeRe.test(s)) continue;
    if (pat.re.test(s)) return pat.kind;
  }
  return null;
}

function extractReadableTextFromBlob(val, maxBytes = 4096) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val.slice(0, maxBytes);
  const buf = toBuffer(val);
  if (!buf || !buf.length) return '';
  const slice = buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
  const raw = slice.toString('utf-8');
  // Keep readable UTF-8 segments and drop protobuf binary control noise
  return raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\uFFFD]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function readConversationSqliteSignals(convDbPath, { includeLatestGenDetail = false } = {}) {
  if (!convDbPath || typeof convDbPath !== 'string') return null;
  const sig = getFileCacheSig(convDbPath);
  if (!sig) return null;

  const cacheKey = `${convDbPath}|${includeLatestGenDetail ? '1' : '0'}`;
  const hit = convSignalsCache.get(cacheKey);
  if (hit && hit.sig === sig) {
    return hit.value;
  }

  let db = null;
  try {
    db = await openReadOnlyDb(convDbPath, 1500, { rethrowBusy: true });
    if (!db) return null;

    let trajectoryType = 0;
    let parentConvId = null;
    let forkStepIndex = 0;
    const compactionSteps = [];
    const events = [];
    const genByStep = new Map();
    const genUsageByStep = new Map();
    const routingEvents = [];
    let latestMaxContextTokens = null;
    let latestContextWindowMetadata = null;

    // Session metrics accumulators
    let stepsCount = 0;
    let roundsCount = 0;
    let callsCount = 0;
    let modelTimeSum = 0;
    let hasModelTime = false;
    let toolTimeSum = 0;
    let hasToolTime = false;
    let ttftTotal = 0;
    let ttftCount = 0;
    let streamTimeSum = 0;
    let streamedOutputSum = 0;
    let cacheWrittenTokens = 0;
    let retryTokens = 0;
    let retryCalls = 0;
    let partial = false;

    // 1. trajectory_meta
    const metaCols = getTableColumns(db, 'trajectory_meta');
    if (metaCols.has('trajectory_type')) {
      try {
        const row = db.prepare('SELECT trajectory_type FROM trajectory_meta LIMIT 1').get();
        if (row && Number.isFinite(Number(row.trajectory_type))) {
          trajectoryType = Number(row.trajectory_type);
        }
      } catch (err) {
        if (isBusyError(err)) throw err;
      }
    }

    // 2. parent_references
    const parentRefCols = getTableColumns(db, 'parent_references');
    if (parentRefCols.size > 0) {
      try {
        const rows = db.prepare('SELECT * FROM parent_references LIMIT 32').all();
        for (const row of rows) {
          for (const [colName, colVal] of Object.entries(row || {})) {
            if (colVal === null || colVal === undefined) continue;
            const lowerCol = colName.toLowerCase();
            if (typeof colVal === 'number' && Number.isInteger(colVal) && colVal > 0 && colVal < 1_000_000) {
              if (/step|fork|index|idx/.test(lowerCol) && colVal > forkStepIndex) {
                forkStepIndex = colVal;
              }
              continue;
            }
            const asText = extractReadableTextFromBlob(colVal, 2048);
            if (!parentConvId && asText) {
              const m = asText.match(UUID_RE);
              if (m) parentConvId = m[1];
            }
            const buf = toBuffer(colVal);
            if (buf && buf.length > 0 && typeof colVal !== 'string') {
              const { fields } = parseProtobufFields(buf, 0, Math.min(buf.length, 2048), 64);
              for (const f of fields) {
                if (f.wt === 0 && f.val > 0 && f.val < 1_000_000) {
                  if (f.val > forkStepIndex) forkStepIndex = f.val;
                } else if (f.wt === 2 && !f.truncated && !parentConvId) {
                  const s = f.buf.toString('utf-8');
                  const m = s.match(UUID_RE);
                  if (m) parentConvId = m[1];
                }
              }
            }
          }
        }
      } catch (err) {
        if (isBusyError(err)) throw err;
      }
    }

    // 3. steps (counts, tool timing, compactions & error events)
    const stepCols = getTableColumns(db, 'steps');
    if (stepCols.size > 0) {
      const idxCol = stepCols.has('step_index')
        ? 'step_index'
        : (stepCols.has('idx') ? 'idx' : (stepCols.has('id') ? 'id' : 'rowid'));
      const hasStepType = stepCols.has('step_type');
      const hasErrorDetails = stepCols.has('error_details');
      const hasData = stepCols.has('data');
      const hasMetadata = stepCols.has('metadata');

      try {
        const countSql = hasStepType
          ? 'SELECT count(*) AS total, coalesce(sum(step_type = 14), 0) AS rounds FROM steps'
          : 'SELECT count(*) AS total, 0 AS rounds FROM steps';
        const stepSummary = db.prepare(countSql).get();
        stepsCount = Number(stepSummary?.total ?? 0);
        roundsCount = Number(stepSummary?.rounds ?? 0);
      } catch (err) {
        if (isBusyError(err)) throw err;
      }

      if (hasMetadata) {
        try {
          const toolSql = hasStepType
            ? 'SELECT metadata FROM steps WHERE metadata IS NOT NULL AND length(metadata) > 0 AND length(metadata) <= 65536 AND step_type NOT IN (14, 15)'
            : 'SELECT metadata FROM steps WHERE metadata IS NOT NULL AND length(metadata) > 0 AND length(metadata) <= 65536';
          const toolRows = db.prepare(toolSql).all();
          for (const tr of toolRows) {
            const buf = toBuffer(tr?.metadata);
            if (!buf || !buf.length) continue;
            const { fields } = parseProtobufFields(buf, 0, buf.length, 128);
            let hasFn4Block = false;
            let fn32Buf = null;
            let fn8Buf = null;
            for (const f of fields) {
              if (f.wt !== 2 || f.truncated) continue;
              if (f.fn === 4) hasFn4Block = true;
              else if (f.fn === 32) fn32Buf = f.buf;
              else if (f.fn === 8) fn8Buf = f.buf;
            }
            if (!hasFn4Block || !fn32Buf || !fn8Buf) continue;
            const start = decodeToolTimestamp(fn32Buf);
            const end = decodeToolTimestamp(fn8Buf);
            if (start !== null && end !== null && start > 0 && end >= start) {
              toolTimeSum += (end - start);
              hasToolTime = true;
            }
          }
        } catch (err) {
          if (isBusyError(err)) throw err;
        }
      }

      if (hasStepType) {
        try {
          const compRows = db
            .prepare(`SELECT ${idxCol} AS sidx FROM steps WHERE step_type = 23 ORDER BY ${idxCol} ASC`)
            .all();
          const seenComp = new Set();
          for (const r of compRows) {
            const n = Number(r?.sidx);
            if (Number.isFinite(n) && !seenComp.has(n)) {
              seenComp.add(n);
              compactionSteps.push(n);
            }
          }
        } catch (err) {
          if (isBusyError(err)) throw err;
        }
      }

      if (hasStepType || hasErrorDetails) {
        try {
          const whereParts = [];
          if (hasStepType) whereParts.push('step_type IN (17, 101)');
          if (hasErrorDetails) whereParts.push('(error_details IS NOT NULL AND length(error_details) > 0)');
          const selParts = [`${idxCol} AS sidx`];
          if (hasStepType) selParts.push('step_type AS stype');
          if (hasErrorDetails) selParts.push('substr(error_details, 1, 4096) AS err_raw');
          if (hasData) selParts.push('substr(data, 1, 4096) AS data_raw');
          const errRows = db
            .prepare(`SELECT ${selParts.join(', ')} FROM steps WHERE ${whereParts.join(' OR ')} ORDER BY ${idxCol} ASC LIMIT 200`)
            .all();
          const seenEv = new Set();
          for (const r of errRows) {
            const stepIndex = Number(r?.sidx ?? 0);
            const errText = extractReadableTextFromBlob(r?.err_raw, 4096);
            const dataText = errText ? '' : extractReadableTextFromBlob(r?.data_raw, 4096);
            const combined = errText || dataText;
            const kind = classifyDiagnosticEventText(combined);
            if (!kind) continue;
            const dedupKey = `${kind}:${stepIndex}`;
            if (seenEv.has(dedupKey)) continue;
            seenEv.add(dedupKey);
            events.push({
              kind,
              stepIndex,
              detail: sanitizeSqliteText(combined, 120)
            });
          }
        } catch (err) {
          if (isBusyError(err)) throw err;
        }
      }
    }

    // 4. gen_metadata (OOM-safe SQL slicing)
    const genCols = getTableColumns(db, 'gen_metadata');
    if (genCols.has('idx') && genCols.has('data')) {
      try {
        const rows = db.prepare(`
          SELECT idx, length(data) AS len,
                 CASE WHEN length(data) <= 16384 THEN data ELSE substr(data, 1, 8192) END AS head,
                 CASE WHEN length(data) <= 16384 THEN NULL ELSE substr(data, -4096) END AS tail
          FROM gen_metadata
          ORDER BY idx ASC
        `).all();

        let latestExtraTail = null;
        const lastRow = rows.length ? rows[rows.length - 1] : null;
        if (includeLatestGenDetail && lastRow && Number(lastRow.len) > 16384) {
          try {
            const extra = db
              .prepare('SELECT substr(data, -65536) AS tail64 FROM gen_metadata WHERE idx = ?')
              .get(lastRow.idx);
            latestExtraTail = extra?.tail64 || null;
          } catch (err) {
            if (isBusyError(err)) throw err;
          }
        }

        const seenIds = new Set();
        const seenRouting = new Set();
        const seenGenEvByReq = new Set();
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const extraTail = (i === rows.length - 1) ? latestExtraTail : null;
          const parseBreakdown = Boolean(includeLatestGenDetail) && (i === rows.length - 1 || Number(row.len) <= 16384);
          let decoded;
          try {
            decoded = decodeGenMetadataRow(row.head, row.tail, extraTail, {
              parseBreakdown,
              rowLen: Number(row.len || 0)
            });
          } catch {
            partial = true;
            continue;
          }
          if (decoded.partial) partial = true;

          if (decoded.maxContextTokens) {
            latestMaxContextTokens = decoded.maxContextTokens;
          }
          if (includeLatestGenDetail && decoded.contextWindowMetadata) {
            latestContextWindowMetadata = decoded.contextWindowMetadata;
          }

          // Deduplicated session-level call & retry metrics
          const u = decoded.usage;
          const mainTotal = u
            ? ((u.inputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0) + (u.outputTokens || 0))
            : 0;
          let isDuplicateMain = false;
          if (u && mainTotal > 0) {
            if (decoded.usageDedupId) {
              if (seenIds.has(decoded.usageDedupId)) {
                isDuplicateMain = true;
              } else {
                seenIds.add(decoded.usageDedupId);
              }
            }
            if (!isDuplicateMain) {
              callsCount += 1;
              cacheWrittenTokens += u.cacheWriteTokens || 0;
              const first = decoded.ttft;
              const stream = decoded.streamingSec;
              if (first !== null && first > 0) {
                ttftTotal += first;
                ttftCount += 1;
              }
              if (first !== null && stream !== null && first + stream > 0) {
                modelTimeSum += first + stream;
                hasModelTime = true;
              } else if (stream === null && first !== null && first > 0) {
                modelTimeSum += first;
                hasModelTime = true;
              }
              if (stream !== null && stream > 0 && u.outputTokens > 0) {
                streamTimeSum += stream;
                streamedOutputSum += u.outputTokens;
              }
            }
          }
          if (!isDuplicateMain && Array.isArray(decoded.retryUsages) && decoded.retryUsages.length > 0) {
            for (const rItem of decoded.retryUsages) {
              const ru = rItem?.usage;
              if (!ru) continue;
              const ruTotal = (ru.inputTokens || 0) + (ru.cacheReadTokens || 0) + (ru.cacheWriteTokens || 0) + (ru.outputTokens || 0);
              if (ruTotal <= 0) continue;
              if (rItem.dedupId) {
                if (seenIds.has(rItem.dedupId)) continue;
                seenIds.add(rItem.dedupId);
              }
              retryCalls += 1;
              retryTokens += ruTotal;
              cacheWrittenTokens += ru.cacheWriteTokens || 0;
            }
          }

          const stepEntry = {
            model: decoded.model,
            modelDisplayName: decoded.modelDisplayName,
            responseModel: decoded.responseModel,
            requestedModel: decoded.requestedModel,
            requestedSlug: decoded.requestedSlug,
            ttft: decoded.ttft,
            streamingSec: decoded.streamingSec,
            maxContextTokens: decoded.maxContextTokens,
            usage: decoded.usage || null,
            requestId: decoded.requestId || null,
            retries: decoded.retries || 0,
            retryErrors: decoded.retryErrors,
            genError: decoded.genError || ''
          };
          const usageEntry = {
            usage: decoded.usage || null,
            requestId: decoded.requestId || null,
            retries: decoded.retries || 0,
            retryErrors: decoded.retryErrors,
            genError: decoded.genError || ''
          };
          for (const sIdx of decoded.stepIndices) {
            genByStep.set(sIdx, stepEntry);
            genUsageByStep.set(sIdx, usageEntry);
          }

          // Merge genError and retryErrors into events with requestId+kind dedup
          const primaryStepIdx = decoded.stepIndices.length ? decoded.stepIndices[0] : Number(row.idx || 0);
          const candidateErrTexts = [];
          if (decoded.genError) candidateErrTexts.push(decoded.genError);
          for (const rErr of decoded.retryErrors) {
            if (rErr && !candidateErrTexts.includes(rErr)) candidateErrTexts.push(rErr);
          }
          for (const errText of candidateErrTexts) {
            const evKind = classifyDiagnosticEventText(errText);
            if (!evKind) continue;
            const reqId = decoded.requestId || null;
            if (reqId) {
              const reqKey = `${reqId}:${evKind}`;
              if (seenGenEvByReq.has(reqKey)) continue;
              seenGenEvByReq.add(reqKey);
            }
            const stepMatch = events.find((e) =>
              e.kind === evKind &&
              (e.stepIndex === primaryStepIdx || decoded.stepIndices.includes(e.stepIndex))
            );
            if (stepMatch) {
              if (reqId && !stepMatch.requestId) stepMatch.requestId = reqId;
              if (decoded.retries > 0 && !stepMatch.retries) stepMatch.retries = decoded.retries;
              continue;
            }
            events.push({
              kind: evKind,
              stepIndex: primaryStepIdx,
              detail: sanitizeSqliteText(errText, 220),
              ...(reqId ? { requestId: reqId } : {}),
              ...(decoded.retries > 0 ? { retries: decoded.retries } : {}),
              source: 'gen_metadata'
            });
          }

          // Routing / canary detection
          const reqEnum = decoded.requestedModelEnum;
          const respEnum = decoded.respondedModelEnum;
          const isCanary = Boolean(decoded.responseModel && CANARY_RESPONSE_RE.test(decoded.responseModel));
          let isReroute = false;

          if (reqEnum > 1000 && respEnum > 1000 && reqEnum !== respEnum) {
            const reqPh = enumToPlaceholderModel(reqEnum);
            const respPh = enumToPlaceholderModel(respEnum);
            const reqFam = normalizeModelId(reqPh) || reqPh;
            const respFam = normalizeModelId(respPh) || respPh;
            const contextTag = `${decoded.requestedSlug} ${decoded.modelDisplayName} ${decoded.responseModel}`;
            const isNormalPlanOrOrch = ORCHESTRATOR_OR_PLAN_RE.test(contextTag);
            if (reqFam && respFam && reqFam !== respFam && !isNormalPlanOrOrch) {
              isReroute = true;
            }
          }

          if (isReroute || isCanary) {
            const reqRaw = decoded.requestedModel || decoded.requestedSlug || '未记录模型';
            const respRaw = decoded.modelDisplayName || decoded.responseModel || enumToPlaceholderModel(respEnum) || '未记录模型';
            const reqDisp = formatModelDisplayName(reqRaw, normalizeModelId(reqRaw));
            const respDisp = isCanary && decoded.responseModel
              ? sanitizeSqliteText(decoded.responseModel, 80)
              : formatModelDisplayName(respRaw, normalizeModelId(respRaw));
            const reason = (isReroute && isCanary)
              ? 'canary_reroute'
              : (isCanary ? 'canary_experiment' : 'model_reroute');
            const rKey = `${primaryStepIdx}:${reqDisp}:${respDisp}:${reason}`;
            if (!seenRouting.has(rKey)) {
              seenRouting.add(rKey);
              routingEvents.push({
                stepIndex: primaryStepIdx,
                requestedModel: sanitizeSqliteText(reqDisp, 80),
                respondedModel: sanitizeSqliteText(respDisp, 80),
                reason
              });
            }
          }
        }
      } catch (err) {
        if (isBusyError(err)) throw err;
      }
    }

    const sessionMetrics = {
      rounds: roundsCount,
      steps: stepsCount,
      calls: callsCount,
      modelTimeSec: hasModelTime ? Number(modelTimeSum.toFixed(2)) : null,
      toolTimeSec: hasToolTime ? Number(toolTimeSum.toFixed(2)) : null,
      avgTtftSec: ttftCount > 0 ? Number((ttftTotal / ttftCount).toFixed(2)) : null,
      sessionStreamTps: (streamTimeSum > 0 && streamedOutputSum > 0)
        ? Number((streamedOutputSum / streamTimeSum).toFixed(1))
        : null,
      cacheWrittenTokens,
      retryTokens,
      retryCalls,
      partial,
      stale: false
    };

    const result = {
      trajectoryType,
      isBtwBranch: trajectoryType === 22 || forkStepIndex > 0,
      parentConvId,
      forkStepIndex,
      compactionSteps,
      events,
      genByStep,
      genUsageByStep,
      routingEvents,
      latestMaxContextTokens,
      latestContextWindowMetadata,
      sessionMetrics
    };
    setBoundedCache(convSignalsCache, cacheKey, { sig, value: result });
    return result;
  } catch (err) {
    if (isBusyError(err) && hit?.value) {
      return {
        ...hit.value,
        stale: true,
        ...(hit.value.sessionMetrics ? { sessionMetrics: { ...hit.value.sessionMetrics, stale: true } } : {})
      };
    }
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

/**
 * Lightweight read-only query for only the latest `gen_metadata` row,
 * avoiding full table/DB scans on statusline fast-path fallbacks.
 */
export async function readConversationLatestGenSignal(convDbPath, options = {}) {
  if (!convDbPath || typeof convDbPath !== 'string') return null;
  const sig = getFileCacheSig(convDbPath);
  if (!sig) return null;

  const cacheKey = `${convDbPath}|latestGen`;
  const cached = convSignalsCache.get(cacheKey);
  if (cached && cached.sig === sig) {
    return cached.value;
  }

  const timeoutMs = Math.max(20, Number(options.timeoutMs) || 200);
  const db = await openReadOnlyDb(convDbPath, timeoutMs);
  if (!db) return null;

  try {
    const genCols = getTableColumns(db, 'gen_metadata');
    if (!genCols.has('idx') || !genCols.has('data')) return null;

    const rows = db.prepare(`
      SELECT idx, length(data) AS len,
             CASE WHEN length(data) <= 16384 THEN data ELSE substr(data, 1, 8192) END AS head,
             CASE WHEN length(data) <= 16384 THEN NULL ELSE substr(data, -4096) END AS tail
      FROM gen_metadata
      ORDER BY idx DESC
      LIMIT 6
    `).all();
    if (!Array.isArray(rows) || !rows.length) return null;

    const recentEntries = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      let decoded = decodeGenMetadataRow(r.head, r.tail, null);
      if (i === 0 && Number(r.len) > 16384 && (!decoded.maxContextTokens || decoded.streamingSec === null)) {
        try {
          const extra = db
            .prepare('SELECT substr(data, -65536) AS tail64 FROM gen_metadata WHERE idx = ?')
            .get(r.idx);
          if (extra?.tail64) {
            decoded = decodeGenMetadataRow(r.head, r.tail, extra.tail64);
          }
        } catch {}
      }
      recentEntries.push({
        idx: Number(r.idx ?? 0),
        maxContextTokens: decoded.maxContextTokens || null,
        ttft: decoded.ttft,
        streamingSec: decoded.streamingSec,
        model: decoded.model,
        modelDisplayName: decoded.modelDisplayName,
        responseModel: decoded.responseModel,
        requestedModel: decoded.requestedModel,
        usage: decoded.usage || null,
        stepIndices: decoded.stepIndices
      });
    }

    const latest = recentEntries[0];
    const result = {
      ...latest,
      recentEntries
    };
    setBoundedCache(convSignalsCache, cacheKey, { sig, value: result });
    return result;
  } catch {
    return null;
  } finally {
    try { db.close(); } catch {}
  }
}
