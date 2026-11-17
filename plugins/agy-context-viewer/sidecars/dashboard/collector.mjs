/**
 * Read-only Data Collector for Antigravity Context & Token Viewer Sidecar.
 *
 * Sanctioned data sources only:
 * 1. Official Sidecar environment variables (ANTIGRAVITY_EXECUTABLE_DATA_DIR,
 *    ANTIGRAVITY_LS_ADDRESS, ANTIGRAVITY_CSRF_TOKEN, ANTIGRAVITY_AGENTAPI_EXE).
 * 2. Local on-disk transcripts (<appData>/brain/<conv>/.system_generated/logs/transcript.jsonl
 *    and ~/.gemini/antigravity-cli/brain/).
 * 3. Sidecar's own runtime data directory for user settings persistence.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
  writeSync
} from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import {
  addMeasure,
  calcImageTokens,
  calculateReferenceCost,
  calculateRequestApiCost,
  classifyRequestError,
  CURRENCY_SYMBOLS,
  emptyMeasure,
  formatModelDisplayName,
  getImageDimensions,
  groupModelQuotas,
  measureText,
  normalizeModelId,
  parseUserPlanStatus,
  PRICING_VERIFIED_DATE,
  resolveEffectivePlanStatus,
  resolveModelQuota,
  sanitizeDiagnosticText,
  SUBSCRIPTION_ACQUISITION_PRESETS,
  SUBSCRIPTION_REGIONS_PRESET,
  summarizeApiCost
} from './pricing.mjs';

const CONV_ID_RE = /^[0-9a-f-]{8,64}$/i;
const MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024;
const SKIP_SCAN_DIRS = new Set(['steps', 'scratch', 'media', 'artifacts', 'node_modules', '.git', '__pycache__']);
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.swift', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.php', '.sh', '.zsh', '.bash', '.sql',
  '.html', '.htm', '.css', '.scss', '.less', '.xml', '.csv', '.tsv', '.log', '.vue', '.svelte'
]);

// Caches
const fileAuditCache = new Map();       // "realPath|size|mtimeMs" -> attachment result
const transcriptHistCache = new Map();  // filePath -> { size, mtimeMs, firstDate, rawRecords, stepsNeedingGen }
const convGenMetaCache = new Map();     // convId -> { at, generatorList, callsByStep }
const lsGenMissCache = new Map();       // convId -> { lsAddr, size, mtimeMs, at, settled }
const recentConvMetaCache = new Map();  // logPath -> { key, title, lastContextTokens, turnsCount }
let genStepModelsCache = { path: '', mtimeMs: -1, size: -1, data: null };
let hostDiskCacheMeta = { path: '', mtimeMs: -1, size: -1, data: null };
let activeConvGenDiskCache = { path: '', mtimeMs: -1, size: -1, data: null };
let inFlightHostStatus = null;
const inFlightGenMeta = new Map();
const observedActivityByRoot = new Map();
const HOST_STATUS_DISK_CACHE_VERSION = 1;
const HOST_STATUS_CACHE_MAX_ENTRIES = 4;
const ACTIVE_CONV_GEN_DISK_CACHE_VERSION = 1;
const ACTIVE_CONV_GEN_CACHE_MAX_CONVS = 6;
const CONV_META_SETTLE_AGE_MS = 180_000;
const CONV_META_RETRY_DELAYS_MS = [4000, 8000, 18000, 60000];
let cachedHostStatus = {
  at: 0,
  lsKey: '',
  sig: 'init',
  raw: null,
  plan: null,
  quotas: [],
  modelConfigs: [],
  quotaSummaryGroups: [],
  dynamicModelMap: {},
  quotaStatus: {
    state: 'unavailable',
    stale: false,
    summaryStale: false,
    source: 'none',
    lastSuccessAt: null,
    summaryLastSuccessAt: null,
    reason: ''
  }
};
let lastGoodHostData = null;
let cachedHistoryResult = { at: 0, hostSig: '', etag: '', data: null };

const GEN_BACKFILL_CONCURRENCY = 6;
const GEN_BACKFILL_RPC_TIMEOUT_MS = 900;
const GEN_BACKFILL_SYNC_BUDGET_MS = 350;
const GEN_MISS_TTL_MS = 60_000;

let genBackfillWaveSeq = 0;
let genBackfillDataSeq = 0;
const genBackfillState = {
  wave: null,
  stopping: null
};

export const LOOPBACK_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin'
};

export function createLoopbackSessionToken() {
  return randomBytes(24).toString('hex');
}

export function injectCsrfMeta(html, token) {
  if (!token || typeof html !== 'string') return html;
  const tag = `  <meta name="cv-csrf-token" content="${token}">\n`;
  if (html.includes('</head>')) {
    return html.replace('</head>', `${tag}</head>`);
  }
  return `${tag}${html}`;
}

function sendLoopbackJsonError(res, status, message, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...LOOPBACK_SECURITY_HEADERS,
    ...extraHeaders
  });
  res.end(JSON.stringify({ ok: false, error: message }));
}

export function guardLoopbackRequest(req, res, { port, token }) {
  const actualPort = Number(port || 0);
  const allowedHosts = new Set([
    `127.0.0.1:${actualPort}`,
    `localhost:${actualPort}`,
    `[::1]:${actualPort}`
  ]);
  const rawHost = String(req.headers?.host || '').trim().toLowerCase();
  if (!actualPort || !rawHost || !allowedHosts.has(rawHost)) {
    sendLoopbackJsonError(res, 403, 'Forbidden host');
    return { ok: false };
  }

  const rawUrl = req.url;
  if (
    typeof rawUrl !== 'string' ||
    !rawUrl.startsWith('/') ||
    rawUrl.startsWith('//') ||
    rawUrl.startsWith('/\\') ||
    rawUrl.includes('\\')
  ) {
    sendLoopbackJsonError(res, 400, 'Invalid request URL');
    return { ok: false };
  }

  const expectedOriginBase = `http://127.0.0.1:${actualPort}`;
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl, expectedOriginBase);
  } catch {
    sendLoopbackJsonError(res, 400, 'Invalid request URL');
    return { ok: false };
  }
  if (parsedUrl.origin !== expectedOriginBase) {
    sendLoopbackJsonError(res, 400, 'Invalid request URL');
    return { ok: false };
  }

  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
    sendLoopbackJsonError(res, 405, 'Method not allowed', { Allow: 'GET, POST' });
    return { ok: false };
  }

  const allowedOrigins = new Set([
    `http://127.0.0.1:${actualPort}`,
    `http://localhost:${actualPort}`,
    `http://[::1]:${actualPort}`
  ]);
  const rawOrigin = req.headers?.origin !== undefined ? String(req.headers.origin).trim().toLowerCase() : '';
  const secFetchSite = req.headers?.['sec-fetch-site'] ? String(req.headers['sec-fetch-site']).trim().toLowerCase() : '';

  const isSensitiveGet = parsedUrl.pathname === '/preload.js' || parsedUrl.pathname.startsWith('/api/');
  if (method === 'POST' || isSensitiveGet) {
    if (rawOrigin && !allowedOrigins.has(rawOrigin)) {
      sendLoopbackJsonError(res, 403, 'Forbidden origin');
      return { ok: false };
    }
    if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
      sendLoopbackJsonError(res, 403, 'Cross-site request blocked');
      return { ok: false };
    }
  }

  if (method === 'POST') {
    const contentType = String(req.headers?.['content-type'] || '').trim();
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      sendLoopbackJsonError(res, 415, 'Content-Type must be application/json');
      return { ok: false };
    }
    const providedToken = String(req.headers?.['x-cv-token'] || '');
    const expectedBuf = Buffer.from(String(token || ''), 'utf-8');
    const providedBuf = Buffer.from(providedToken, 'utf-8');
    if (!expectedBuf.length || providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
      sendLoopbackJsonError(res, 403, 'Invalid or missing session token');
      return { ok: false };
    }
  }

  return { ok: true, url: parsedUrl, method };
}

export function readLoopbackJsonBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (status, message) => {
      if (settled) return;
      settled = true;
      const err = new Error(message);
      err.status = status;
      rejectPromise(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += buf.length;
      if (total > maxBytes) {
        req.resume();
        fail(413, 'Request payload too large');
        return;
      }
      chunks.push(buf);
    });
    req.on('error', () => fail(400, 'Failed to read request body'));
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (total === 0) {
        resolvePromise({});
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) {
        resolvePromise({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const err = new Error('JSON body must be an object');
          err.status = 400;
          rejectPromise(err);
          return;
        }
        resolvePromise(parsed);
      } catch {
        const err = new Error('Malformed JSON body');
        err.status = 400;
        rejectPromise(err);
      }
    });
  });
}

function computeContentEtag(prefix, payload) {
  return `${prefix}:${createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16)}`;
}

export function findAppDataDir() {
  const execDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (execDataDir) {
    for (let d = execDataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        const candidate = dirname(d);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return process.env.AG_DIR || join(homedir(), '.gemini', 'antigravity');
}

export function findCliDataDir() {
  return process.env.AG_CLI_DIR || join(homedir(), '.gemini', 'antigravity-cli');
}

export function getPluginStateDir() {
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    return process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  }
  return join(findAppDataDir(), 'sidecar_data', 'context-viewer', 'dashboard', 'data');
}

function getSettingsPath() {
  return join(getPluginStateDir(), 'settings_v1.json');
}

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!existsSync(filePath)) return fallback;
    const raw = readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    const bak = `${filePath}.bak`;
    try {
      if (existsSync(bak)) return JSON.parse(readFileSync(bak, 'utf-8'));
    } catch {}
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const serialized = JSON.stringify(data, null, 2);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, serialized, 'utf-8');
  if (existsSync(filePath)) {
    try {
      writeFileSync(`${filePath}.bak`, readFileSync(filePath));
    } catch {}
  }
  renameSync(tmp, filePath);
}

function getGenStepModelsPath() {
  return join(getPluginStateDir(), 'gen_step_models_v1.json');
}

function mergePersistedConvsInto(targetConvs, srcConvs) {
  if (!targetConvs || !srcConvs || typeof srcConvs !== 'object') return;
  for (const [convId, entry] of Object.entries(srcConvs)) {
    if (!entry || typeof entry !== 'object' || !entry.steps || typeof entry.steps !== 'object') continue;
    const prev = targetConvs[convId];
    const combinedSteps = { ...(prev?.steps || {}) };
    for (const [k, v] of Object.entries(entry.steps)) {
      const val = String(v || '').trim();
      if (val) combinedSteps[String(k)] = val;
    }
    if (!Object.keys(combinedSteps).length) continue;
    const nextMtime = Number(entry.mtimeMs || 0);
    const prevMtime = Number(prev?.mtimeMs || 0);
    const nextSize = Number(entry.size || 0);
    const prevSize = Number(prev?.size || 0);
    const keepNextMeta = !prev || nextMtime > prevMtime || (nextMtime === prevMtime && nextSize >= prevSize);
    targetConvs[convId] = {
      size: keepNextMeta ? nextSize : prevSize,
      mtimeMs: keepNextMeta ? nextMtime : prevMtime,
      steps: combinedSteps
    };
  }
}

function loadPersistedStepModels(targetPath = getGenStepModelsPath()) {
  const defaultPath = getGenStepModelsPath();
  const p = targetPath || defaultPath;
  let st = null;
  try {
    if (existsSync(p)) st = statSync(p);
  } catch {}
  const stMtime = st ? st.mtimeMs : -1;
  const stSize = st ? st.size : -1;
  if (
    p === defaultPath &&
    genStepModelsCache.path === p &&
    genStepModelsCache.mtimeMs === stMtime &&
    genStepModelsCache.size === stSize &&
    genStepModelsCache.data
  ) {
    if (genBackfillState.wave?.persistPath === p) {
      mergePersistedConvsInto(genStepModelsCache.data.convs, genBackfillState.wave.pendingConvs);
    }
    return genStepModelsCache.data;
  }
  const raw = readJsonSafe(p, null);
  const cleanConvs = {};
  mergePersistedConvsInto(cleanConvs, raw?.convs);
  if (genBackfillState.wave?.persistPath === p) {
    mergePersistedConvsInto(cleanConvs, genBackfillState.wave.pendingConvs);
  }
  const data = { version: 1, convs: cleanConvs };
  if (p === defaultPath) {
    genStepModelsCache = { path: p, mtimeMs: stMtime, size: stSize, data };
  }
  return data;
}

function savePersistedStepModels(data, targetPath = getGenStepModelsPath()) {
  const defaultPath = getGenStepModelsPath();
  const p = targetPath || defaultPath;
  const diskRaw = readJsonSafe(p, null);
  const mergedConvs = {};

  mergePersistedConvsInto(mergedConvs, diskRaw?.convs);
  if (genBackfillState.wave?.persistPath === p) {
    mergePersistedConvsInto(mergedConvs, genBackfillState.wave.pendingConvs);
  }
  mergePersistedConvsInto(mergedConvs, data?.convs);

  const entries = Object.entries(mergedConvs);
  if (entries.length > 1500) {
    entries.sort((a, b) => Number(b[1]?.mtimeMs || 0) - Number(a[1]?.mtimeMs || 0));
  }
  const nextData = {
    version: 1,
    convs: Object.fromEntries(entries.slice(0, 1500))
  };
  if (data && typeof data === 'object') {
    data.version = 1;
    data.convs = nextData.convs;
  }
  try {
    writeJsonAtomic(p, nextData);
    if (p === defaultPath) {
      let st = null;
      try { st = statSync(p); } catch {}
      genStepModelsCache = {
        path: p,
        mtimeMs: st ? st.mtimeMs : -1,
        size: st ? st.size : -1,
        data: nextData
      };
    }
  } catch {
    if (p === defaultPath) {
      genStepModelsCache = { path: p, mtimeMs: -1, size: -1, data: nextData };
    }
  }
  return nextData;
}

function buildStepModelsRecord(generatorList = []) {
  const steps = {};
  for (const entry of generatorList) {
    const modelStr = extractStepModel(null, entry, '');
    if (!modelStr) continue;
    const indices = entry.stepIndices || (entry.stepIndex != null ? [entry.stepIndex] : []);
    for (const idx of indices) {
      const n = Number(idx);
      if (Number.isFinite(n)) steps[String(n)] = modelStr;
    }
  }
  return steps;
}

function mergePersistedConvStepModels(convsMap, convId, st, generatorList) {
  if (!convsMap || !convId || !st || !Array.isArray(generatorList) || !generatorList.length) return false;
  const nextSteps = buildStepModelsRecord(generatorList);
  const nextKeys = Object.keys(nextSteps);
  if (!nextKeys.length) return false;

  const prev = convsMap[convId];
  const prevSteps = (prev?.steps && typeof prev.steps === 'object') ? prev.steps : {};
  const mergedSteps = { ...prevSteps, ...nextSteps };
  const unchanged = Boolean(
    prev &&
    prev.size === st.size &&
    prev.mtimeMs === st.mtimeMs &&
    Object.keys(prevSteps).length === Object.keys(mergedSteps).length &&
    nextKeys.every((k) => prevSteps[k] === mergedSteps[k])
  );
  if (unchanged) return false;

  convsMap[convId] = {
    size: st.size,
    mtimeMs: st.mtimeMs,
    steps: mergedSteps
  };
  return true;
}

function maybePersistConvStepModels(convId, logPathForStat, generatorList) {
  if (!convId || !logPathForStat || !Array.isArray(generatorList) || !generatorList.length) return;
  try {
    if (!existsSync(logPathForStat)) return;
    const st = statSync(logPathForStat);
    const data = loadPersistedStepModels();
    if (mergePersistedConvStepModels(data.convs, convId, st, generatorList)) {
      savePersistedStepModels(data);
    }
  } catch {}
}

export function formatLocalDateKey(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseDurationSec(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  const m = String(value).trim().match(/^([\d.]+)\s*s?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function hashAccountKey(email) {
  if (!email || typeof email !== 'string') return 'default';
  return 'acct_' + createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 12);
}

function normalizeLsAddr(rawAddr) {
  const trimmed = String(rawAddr || '').trim();
  if (!trimmed) return '';
  try {
    const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    const u = new URL(withProto);
    const host = u.hostname.toLowerCase() === 'localhost' ? '127.0.0.1' : u.hostname.toLowerCase();
    return u.port ? `${host}:${u.port}` : host;
  } catch {
    return trimmed
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '')
      .replace(/^localhost(?=:|$)/, '127.0.0.1');
  }
}

function hashLsKey(lsKey) {
  if (!lsKey || typeof lsKey !== 'string') return '';
  return 'ls_' + createHash('sha256').update(lsKey).digest('hex').slice(0, 16);
}

function hashLsAddr(rawAddr) {
  const norm = normalizeLsAddr(rawAddr);
  if (!norm) return '';
  return 'ls_' + createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

function getActivityRootKey() {
  return `${findAppDataDir()}|${findCliDataDir()}`;
}

function noteObservedTranscriptActivity(mtimeMs, nowMs = Date.now()) {
  const mt = Number(mtimeMs || 0);
  if (!Number.isFinite(mt) || mt <= 0) return;
  const rootKey = getActivityRootKey();
  const prev = observedActivityByRoot.get(rootKey);
  if (!prev) {
    if (observedActivityByRoot.size > 32) {
      const firstK = observedActivityByRoot.keys().next().value;
      if (firstK) observedActivityByRoot.delete(firstK);
    }
    observedActivityByRoot.set(rootKey, { mtimeMs: mt, activityMs: mt });
    return;
  }
  if (mt > prev.mtimeMs) {
    prev.mtimeMs = mt;
    prev.activityMs = Math.max(Number(nowMs) || Date.now(), mt);
  }
}

function getObservedActivityMs() {
  const entry = observedActivityByRoot.get(getActivityRootKey());
  return entry ? Math.max(entry.activityMs || 0, entry.mtimeMs || 0) : 0;
}

// ---------------------------------------------------------------------------
// Official Language Server Connect RPC (uses env vars injected by Sidecar SDK)
// ---------------------------------------------------------------------------

function callLanguageServer(method, payload = {}, timeoutMs = 4500, options = {}) {
  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  const signal = options?.signal || null;
  if (!lsAddr || !csrf || signal?.aborted) return Promise.resolve(null);

  return new Promise((resolvePromise) => {
    let settled = false;
    let req = null;
    const onAbort = () => {
      try { req?.destroy(); } catch {}
      finish(null);
    };
    const finish = (val) => {
      if (!settled) {
        settled = true;
        if (signal) {
          try { signal.removeEventListener('abort', onAbort); } catch {}
        }
        resolvePromise(val);
      }
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const targetUrl = new URL(`http://${lsAddr}/exa.language_server_pb.LanguageServerService/${method}`);
      const bodyStr = JSON.stringify(payload);
      req = http.request(
        {
          hostname: targetUrl.hostname,
          port: targetUrl.port,
          path: targetUrl.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-codeium-csrf-token': csrf,
            'Content-Length': Buffer.byteLength(bodyStr)
          }
        },
        (res) => {
          const chunks = [];
          let total = 0;
          res.on('data', (chunk) => {
            total += chunk.length;
            if (total > 32 * 1024 * 1024) {
              req.destroy();
              finish(null);
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            if (res.statusCode !== 200) {
              finish(null);
              return;
            }
            try {
              finish(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
            } catch {
              finish(null);
            }
          });
        }
      );
      if (options?.unrefSocket) {
        req.on('socket', (sock) => {
          sock.unref?.();
        });
      }
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        finish(null);
      });
      req.on('error', () => finish(null));
      req.end(bodyStr);
    } catch {
      finish(null);
    }
  });
}

function makeQuotaStatus(state, opts = {}) {
  return {
    state,
    stale: Boolean(opts.stale),
    summaryStale: Boolean(opts.summaryStale),
    source: opts.source || 'none',
    lastSuccessAt: opts.lastSuccessAt || null,
    summaryLastSuccessAt: opts.summaryLastSuccessAt || null,
    reason: opts.reason || ''
  };
}

function toStableQuotaState(quotaStatus = {}) {
  return {
    state: quotaStatus.state || 'unavailable',
    stale: Boolean(quotaStatus.stale),
    summaryStale: Boolean(quotaStatus.summaryStale),
    source: quotaStatus.source || 'none'
  };
}

function getHostStatusCachePath() {
  return join(getPluginStateDir(), 'host_status_cache_v1.json');
}

function sanitizeModelConfigsForDiskCache(modelConfigs = []) {
  if (!Array.isArray(modelConfigs)) return [];
  return modelConfigs
    .filter((cfg) => cfg && typeof cfg === 'object')
    .map((cfg) => ({
      ...(cfg.label ? { label: cfg.label } : {}),
      ...(cfg.modelId ? { modelId: cfg.modelId } : {}),
      ...(cfg.modelOrAlias ? { modelOrAlias: cfg.modelOrAlias } : {}),
      ...(cfg.quotaPoolId ? { quotaPoolId: cfg.quotaPoolId } : {}),
      ...(cfg.quotaInfo ? { quotaInfo: cfg.quotaInfo } : {})
    }));
}

function sanitizeSummaryGroupsForDiskCache(groups = []) {
  if (!Array.isArray(groups)) return [];
  return groups
    .filter((g) => g && typeof g === 'object')
    .map((g) => ({
      ...(g.groupId ? { groupId: g.groupId } : {}),
      ...(g.poolId ? { poolId: g.poolId } : {}),
      ...(g.id ? { id: g.id } : {}),
      ...(g.displayName ? { displayName: g.displayName } : {}),
      ...(g.title ? { title: g.title } : {}),
      ...(g.name ? { name: g.name } : {}),
      ...(Array.isArray(g.modelIds) ? { modelIds: g.modelIds } : {}),
      ...(Array.isArray(g.models) ? { models: g.models } : {}),
      ...(Array.isArray(g.buckets) ? { buckets: g.buckets } : {})
    }));
}

function loadHostStatusDiskCache(targetPath = getHostStatusCachePath()) {
  const p = targetPath || getHostStatusCachePath();
  let st = null;
  try {
    if (existsSync(p)) st = statSync(p);
  } catch {}
  const stMtime = st ? st.mtimeMs : -1;
  const stSize = st ? st.size : -1;
  if (
    hostDiskCacheMeta.path === p &&
    hostDiskCacheMeta.mtimeMs === stMtime &&
    hostDiskCacheMeta.size === stSize &&
    hostDiskCacheMeta.data
  ) {
    return hostDiskCacheMeta.data;
  }
  const raw = readJsonSafe(p, null);
  const entries = {};
  if (raw?.version === HOST_STATUS_DISK_CACHE_VERSION && raw.entries && typeof raw.entries === 'object') {
    for (const [k, v] of Object.entries(raw.entries)) {
      if (/^ls_[0-9a-f]{16}$/i.test(k) && v && typeof v === 'object' && v.plan && v.quotaStatus) {
        entries[k] = v;
      }
    }
  }
  const data = { version: HOST_STATUS_DISK_CACHE_VERSION, entries };
  hostDiskCacheMeta = { path: p, mtimeMs: stMtime, size: stSize, data };
  return data;
}

function saveHostStatusDiskEntry(lsKeyHash, entry, targetPath = getHostStatusCachePath()) {
  if (!lsKeyHash || !entry) return;
  try {
    const data = loadHostStatusDiskCache(targetPath);
    const nextEntries = { ...data.entries, [lsKeyHash]: entry };
    const sorted = Object.entries(nextEntries)
      .sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0))
      .slice(0, HOST_STATUS_CACHE_MAX_ENTRIES);
    const payload = {
      version: HOST_STATUS_DISK_CACHE_VERSION,
      entries: Object.fromEntries(sorted)
    };
    writeJsonAtomic(targetPath, payload);
    const st = statSync(targetPath);
    hostDiskCacheMeta = { path: targetPath, mtimeMs: st.mtimeMs, size: st.size, data: payload };
  } catch {}
}

function hasCrossedQuotaResetBoundary(quotas, cachedAtMs, nowMs) {
  if (!Array.isArray(quotas) || !quotas.length || !cachedAtMs) return false;
  for (const pool of quotas) {
    if (!pool || typeof pool !== 'object') continue;
    for (const rawIso of [pool.resetTime, pool.fiveHour?.resetTime, pool.weekly?.resetTime]) {
      if (!rawIso || typeof rawIso !== 'string') continue;
      const ms = Date.parse(rawIso);
      if (Number.isFinite(ms) && ms > cachedAtMs && ms <= nowMs) {
        return true;
      }
    }
  }
  return false;
}

function computeHostStatusTtlMs(options = {}, entry = null, nowMs = Date.now()) {
  const stateStr = entry?.quotaStatus?.state || '';
  const background = Boolean(options.background);
  if (stateStr === 'error' || stateStr === 'stale') {
    return background ? 180_000 : 60_000;
  }
  const menubarMode = String(options.menubarMode || 'context');
  const activityMs = Number(options.latestActivityMs || options.latestTranscriptMtimeMs || getObservedActivityMs() || 0);
  const hasActivityTs = activityMs > 0;
  const idleAgeMs = hasActivityTs ? Math.max(0, nowMs - activityMs) : 0;

  if (background) {
    if (hasActivityTs && idleAgeMs >= 600_000) {
      return 1_800_000;
    }
    if (hasActivityTs && idleAgeMs >= 120_000) {
      return menubarMode === 'quota' ? 300_000 : 600_000;
    }
    return menubarMode === 'quota' ? 60_000 : 180_000;
  }

  if (hasActivityTs && idleAgeMs >= 600_000) {
    return 600_000;
  }
  if (hasActivityTs && idleAgeMs >= 120_000) {
    return 120_000;
  }
  return 30_000;
}

function buildDynamicModelMap(modelConfigs = []) {
  const map = {};
  for (const cfg of modelConfigs) {
    const mid = String(cfg?.modelOrAlias?.model || cfg?.modelId || '').trim().toLowerCase();
    const norm = normalizeModelId(cfg?.label || '') || normalizeModelId(mid);
    if (mid && norm) map[mid] = norm;
  }
  return map;
}

async function getHostUserStatus(force = false, options = {}) {
  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  const nowMs = Number(options.nowMs) || Date.now();
  if (!lsAddr || !csrf) {
    return {
      at: nowMs,
      lsKey: '',
      sig: 'no-ls',
      raw: null,
      plan: parseUserPlanStatus(null),
      quotas: [],
      modelConfigs: [],
      quotaSummaryGroups: [],
      dynamicModelMap: {},
      quotaStatus: makeQuotaStatus('unavailable', {
        source: 'none',
        reason: '未连接宿主语言服务'
      })
    };
  }
  const lsKey = `${lsAddr}|${csrf}`;
  const lsKeyHash = hashLsAddr(lsAddr);

  if (
    !force &&
    cachedHostStatus.at &&
    cachedHostStatus.lsKey === lsKey &&
    !hasCrossedQuotaResetBoundary(cachedHostStatus.quotas, cachedHostStatus.at, nowMs)
  ) {
    const ttlMs = computeHostStatusTtlMs(options, cachedHostStatus, nowMs);
    if ((nowMs - cachedHostStatus.at) < ttlMs) {
      return cachedHostStatus;
    }
  }

  const diskCache = loadHostStatusDiskCache();
  const diskEntry = diskCache?.entries?.[lsKeyHash] || null;
  const diskModelConfigs = Array.isArray(diskEntry?.modelConfigs) ? diskEntry.modelConfigs : [];
  const diskSummaryGroups = Array.isArray(diskEntry?.quotaSummaryGroups) ? diskEntry.quotaSummaryGroups : [];
  const hasHydratableConfigs = diskModelConfigs.length > 0;
  const hydratedDynamicModelMap = hasHydratableConfigs
    ? { ...(diskEntry?.dynamicModelMap || {}), ...buildDynamicModelMap(diskModelConfigs) }
    : (diskEntry?.dynamicModelMap || {});
  const hydratedQuotas = hasHydratableConfigs
    ? groupModelQuotas(diskModelConfigs, diskSummaryGroups)
    : (Array.isArray(diskEntry?.quotas) ? diskEntry.quotas : []);
  let hydratedSig = diskEntry?.sig || 'host:disk';
  if (hasHydratableConfigs && diskEntry?.plan) {
    const { updatedAt: _planUpdatedAt, ...stablePlan } = diskEntry.plan;
    hydratedSig = computeContentEtag('host', {
      plan: stablePlan,
      quotas: hydratedQuotas,
      dynamicModelMap: hydratedDynamicModelMap,
      quotaState: toStableQuotaState(diskEntry.quotaStatus)
    });
  }

  const diskGoodFallback = (
    diskEntry &&
    (diskEntry.quotaStatus?.state === 'live' || diskEntry.quotaStatus?.state === 'degraded') &&
    diskEntry.fetchedAt
  )
    ? {
        lsKey,
        fetchedAt: diskEntry.fetchedAt,
        summaryFetchedAt: diskEntry.summaryFetchedAt || null,
        accountKey: diskEntry.plan?.accountKey || 'default',
        plan: diskEntry.plan,
        quotas: hydratedQuotas,
        modelConfigs: diskModelConfigs,
        quotaSummaryGroups: diskSummaryGroups,
        dynamicModelMap: hydratedDynamicModelMap
      }
    : null;

  if (
    !force &&
    diskEntry &&
    diskEntry.at &&
    !hasCrossedQuotaResetBoundary(hydratedQuotas, diskEntry.at, nowMs)
  ) {
    const diskTtlMs = computeHostStatusTtlMs(options, diskEntry, nowMs);
    if ((nowMs - Number(diskEntry.at)) < diskTtlMs) {
      if (diskGoodFallback) {
        lastGoodHostData = diskGoodFallback;
      }
      cachedHostStatus = {
        at: Number(diskEntry.at),
        lsKey,
        sig: hydratedSig,
        raw: null,
        plan: diskEntry.plan,
        quotas: hydratedQuotas,
        modelConfigs: diskModelConfigs,
        quotaSummaryGroups: diskSummaryGroups,
        dynamicModelMap: hydratedDynamicModelMap,
        quotaStatus: diskEntry.quotaStatus
      };
      return cachedHostStatus;
    }
  }

  if (!force && inFlightHostStatus && !inFlightHostStatus.force && inFlightHostStatus.lsKey === lsKey) {
    return inFlightHostStatus.promise;
  }

  const runFetch = (async () => {
    const [res, quotaSummaryRes] = await Promise.all([
      callLanguageServer('GetUserStatus', {}),
      callLanguageServer('RetrieveUserQuotaSummary', {})
    ]);
    const fetchedAtMs = Number(options.nowMs) || Date.now();
    const cachedGood = (lastGoodHostData?.lsKey === lsKey ? lastGoodHostData : null) || diskGoodFallback;
    if (!res) {
      if (cachedGood) {
        const quotaStatus = makeQuotaStatus('stale', {
          stale: true,
          summaryStale: true,
          source: 'cache',
          lastSuccessAt: cachedGood.fetchedAt,
          summaryLastSuccessAt: cachedGood.summaryFetchedAt,
          reason: '语言服务连接失败，当前展示上次成功同步数据'
        });
        const { updatedAt: _planUpdatedAt, ...stablePlan } = cachedGood.plan || {};
        const sig = computeContentEtag('host', {
          plan: stablePlan,
          quotas: cachedGood.quotas,
          dynamicModelMap: cachedGood.dynamicModelMap,
          quotaState: toStableQuotaState(quotaStatus)
        });
        cachedHostStatus = {
          at: fetchedAtMs,
          lsKey,
          sig,
          raw: null,
          plan: cachedGood.plan,
          quotas: cachedGood.quotas,
          modelConfigs: cachedGood.modelConfigs,
          quotaSummaryGroups: cachedGood.quotaSummaryGroups,
          dynamicModelMap: cachedGood.dynamicModelMap,
          quotaStatus
        };
        return cachedHostStatus;
      }
      const plan = parseUserPlanStatus(null);
      const quotaStatus = makeQuotaStatus('error', {
        stale: false,
        summaryStale: false,
        source: 'none',
        lastSuccessAt: null,
        summaryLastSuccessAt: null,
        reason: '语言服务请求失败，暂未获取到配额数据'
      });
      const sig = computeContentEtag('host', { quotaState: toStableQuotaState(quotaStatus) });
      cachedHostStatus = {
        at: fetchedAtMs,
        lsKey,
        sig,
        raw: null,
        plan,
        quotas: [],
        modelConfigs: [],
        quotaSummaryGroups: [],
        dynamicModelMap: {},
        quotaStatus
      };
      return cachedHostStatus;
    }

    const nowIso = new Date(fetchedAtMs).toISOString();
    const plan = parseUserPlanStatus(res);
    const accountHash = hashAccountKey(res?.userStatus?.email || '');
    plan.accountKey = accountHash;
    const modelConfigs = sanitizeModelConfigsForDiskCache(res?.userStatus?.cascadeModelConfigData?.clientModelConfigs || []);
    const summaryOk = quotaSummaryRes !== null && typeof quotaSummaryRes === 'object';
    const quotaSummaryGroups = summaryOk
      ? sanitizeSummaryGroupsForDiskCache(quotaSummaryRes?.response?.groups || quotaSummaryRes?.groups || [])
      : [];
    const dynamicModelMap = buildDynamicModelMap(modelConfigs);
    const quotas = groupModelQuotas(modelConfigs, quotaSummaryGroups);
    const summaryFetchedAt = summaryOk ? nowIso : (cachedGood?.summaryFetchedAt || null);
    const quotaStatus = summaryOk
      ? makeQuotaStatus('live', {
          stale: false,
          summaryStale: false,
          source: 'live',
          lastSuccessAt: nowIso,
          summaryLastSuccessAt: nowIso,
          reason: ''
        })
      : makeQuotaStatus('degraded', {
          stale: false,
          summaryStale: true,
          source: 'live',
          lastSuccessAt: nowIso,
          summaryLastSuccessAt: summaryFetchedAt,
          reason: '多窗口配额摘要暂不可用，当前仅展示基础配额信息'
        });
    lastGoodHostData = {
      lsKey,
      fetchedAt: nowIso,
      summaryFetchedAt,
      accountKey: accountHash,
      plan,
      quotas,
      modelConfigs,
      quotaSummaryGroups,
      dynamicModelMap
    };
    const { updatedAt: _planUpdatedAt, ...stablePlan } = plan;
    const sig = computeContentEtag('host', {
      plan: stablePlan,
      quotas,
      dynamicModelMap,
      quotaState: toStableQuotaState(quotaStatus)
    });
    cachedHostStatus = {
      at: fetchedAtMs,
      lsKey,
      sig,
      raw: null,
      plan,
      quotas,
      modelConfigs,
      quotaSummaryGroups,
      dynamicModelMap,
      quotaStatus
    };
    saveHostStatusDiskEntry(lsKeyHash, {
      at: fetchedAtMs,
      sig,
      fetchedAt: nowIso,
      summaryFetchedAt,
      plan,
      quotas,
      modelConfigs,
      quotaSummaryGroups,
      dynamicModelMap,
      quotaStatus
    });
    return cachedHostStatus;
  })();

  if (!force) {
    const flightEntry = { lsKey, force: false, promise: runFetch };
    inFlightHostStatus = flightEntry;
    try {
      return await runFetch;
    } finally {
      if (inFlightHostStatus === flightEntry) {
        inFlightHostStatus = null;
      }
    }
  }

  return runFetch;
}

// ---------------------------------------------------------------------------
// Settings Persistence
// ---------------------------------------------------------------------------

function loadRawSettings() {
  const data = readJsonSafe(getSettingsPath(), null);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return {
      version: '1.0.0',
      lastAccountKey: data.lastAccountKey || 'default',
      accounts: data.accounts && typeof data.accounts === 'object' ? data.accounts : {},
      uiPreferences: data.uiPreferences && typeof data.uiPreferences === 'object' ? data.uiPreferences : {}
    };
  }
  // Read-only fallback migration from legacy custom_plan_v1.json if present
  const legacy = readJsonSafe(join(findAppDataDir(), 'custom_plan_v1.json'), null);
  if (legacy && typeof legacy === 'object') {
    return {
      version: '1.0.0',
      lastAccountKey: 'default',
      accounts: legacy.accounts?.default ? { default: legacy.accounts.default } : {},
      uiPreferences: legacy.uiPreferences || {}
    };
  }
  return { version: '1.0.0', lastAccountKey: 'default', accounts: {}, uiPreferences: {} };
}

export async function getSettings(options = {}) {
  const host = await getHostUserStatus(false, { background: true, ...options });
  const settings = loadRawSettings();
  const acctKey = host.plan?.accountKey || settings.lastAccountKey || 'default';
  const customPlan = settings.accounts[acctKey] || settings.accounts.default || null;
  const effectivePlan = resolveEffectivePlanStatus(host.plan, customPlan);
  return {
    ok: true,
    planStatus: effectivePlan,
    customPlan,
    uiPreferences: settings.uiPreferences || {},
    entrypoints: getSidebarEntryStatus(),
    presets: {
      regions: SUBSCRIPTION_REGIONS_PRESET,
      acquisitions: SUBSCRIPTION_ACQUISITION_PRESETS,
      currencies: Object.entries(CURRENCY_SYMBOLS).map(([code, symbol]) => ({ code, symbol }))
    }
  };
}

function getSidecarManifestPath() {
  return join(dirname(fileURLToPath(import.meta.url)), 'sidecar.json');
}

export const MENUBAR_MODES = ['context', 'speed', 'quota'];
export const DEFAULT_SHORTCUT_MAC = 'Alt+Meta+K';
export const DEFAULT_SHORTCUT_OTHER = 'Ctrl+Alt+K';
export const DEFAULT_AUX_SHORTCUT_MAC = 'Ctrl+Alt+K';
export const DEFAULT_AUX_SHORTCUT_OTHER = 'Ctrl+Alt+Shift+K';
export const SHORTCUT_SCOPES = ['app', 'global'];

// Exact macOS Carbon HIToolbox virtual keycodes (<Carbon/HIToolbox/Events.h>)
const MAC_CARBON_KEYCODES = Object.freeze({
  A: 0, B: 11, C: 8, D: 2, E: 14, F: 3, G: 5, H: 4, I: 34, J: 38,
  K: 40, L: 37, M: 46, N: 45, O: 31, P: 35, Q: 12, R: 15, S: 1, T: 17,
  U: 32, V: 9, W: 13, X: 7, Y: 16, Z: 6,
  '0': 29, '1': 18, '2': 19, '3': 20, '4': 21,
  '5': 23, '6': 22, '7': 26, '8': 28, '9': 25,
  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97,
  F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
  Space: 49,
  Backquote: 50,
  Minus: 27,
  Equal: 24,
  BracketLeft: 33,
  BracketRight: 30,
  Backslash: 42,
  Semicolon: 41,
  Quote: 39,
  Comma: 43,
  Period: 47,
  Slash: 44
});

const MAC_CARBON_MODS = Object.freeze({
  Meta: 256,   // cmdKey
  Shift: 512,  // shiftKey
  Alt: 2048,   // optionKey
  Ctrl: 4096   // controlKey
});

const SHORTCUT_KEY_DISPLAY = Object.freeze({
  Space: 'Space',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/'
});

const SHORTCUT_KEY_ALIASES = Object.freeze({
  space: 'Space',
  spacebar: 'Space',
  '`': 'Backquote',
  '~': 'Backquote',
  backquote: 'Backquote',
  grave: 'Backquote',
  tilde: 'Backquote',
  '-': 'Minus',
  '_': 'Minus',
  minus: 'Minus',
  '=': 'Equal',
  equal: 'Equal',
  plus: 'Equal',
  '[': 'BracketLeft',
  '{': 'BracketLeft',
  bracketleft: 'BracketLeft',
  ']': 'BracketRight',
  '}': 'BracketRight',
  bracketright: 'BracketRight',
  '\\': 'Backslash',
  '|': 'Backslash',
  backslash: 'Backslash',
  ';': 'Semicolon',
  ':': 'Semicolon',
  semicolon: 'Semicolon',
  "'": 'Quote',
  '"': 'Quote',
  quote: 'Quote',
  ',': 'Comma',
  '<': 'Comma',
  comma: 'Comma',
  '.': 'Period',
  '>': 'Period',
  period: 'Period',
  dot: 'Period',
  '/': 'Slash',
  '?': 'Slash',
  slash: 'Slash'
});

const RESERVED_MAC_META_ONLY_KEYS = new Set([
  'A', 'C', 'F', 'H', 'M', 'N', 'Q', 'R', 'S', 'T', 'V', 'W', 'X', 'Z', 'Space'
]);
const RESERVED_OTHER_CTRL_ONLY_KEYS = new Set(['A', 'C', 'V', 'W', 'X', 'Z']);

export function getDefaultShortcut(platform = process.platform) {
  return platform === 'darwin' ? DEFAULT_SHORTCUT_MAC : DEFAULT_SHORTCUT_OTHER;
}

export function getDefaultAuxShortcut(platform = process.platform, standaloneAccelerator = '') {
  const primary = platform === 'darwin' ? DEFAULT_AUX_SHORTCUT_MAC : DEFAULT_AUX_SHORTCUT_OTHER;
  const alt = platform === 'darwin' ? 'Alt+Shift+Meta+K' : 'Ctrl+Shift+K';
  if (standaloneAccelerator && standaloneAccelerator === primary) {
    return alt;
  }
  return primary;
}

function canonicalizeKeyToken(rawToken) {
  const trimmed = String(rawToken || '').trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (SHORTCUT_KEY_ALIASES[lower]) return SHORTCUT_KEY_ALIASES[lower];
  if (/^key([a-z])$/i.test(trimmed)) return trimmed.slice(3).toUpperCase();
  if (/^[a-z]$/i.test(trimmed)) return trimmed.toUpperCase();
  if (/^digit([0-9])$/i.test(trimmed)) return trimmed.slice(5);
  if (/^[0-9]$/.test(trimmed)) return trimmed;
  if (/^f([1-9]|1[0-2])$/i.test(trimmed)) return trimmed.toUpperCase();
  return null;
}

export function formatShortcutDisplay(spec, platform = process.platform) {
  const raw = String(spec || '').trim();
  if (!raw || /^(off|none|disabled?)$/i.test(raw)) return '已关闭';
  const parts = raw.split('+').filter(Boolean);
  if (!parts.length) return '已关闭';
  const keyPart = parts[parts.length - 1];
  const modSet = new Set(parts.slice(0, -1));
  const keyLabel = SHORTCUT_KEY_DISPLAY[keyPart] || keyPart;
  if (platform === 'darwin') {
    let out = '';
    if (modSet.has('Ctrl')) out += '⌃';
    if (modSet.has('Alt')) out += '⌥';
    if (modSet.has('Shift')) out += '⇧';
    if (modSet.has('Meta')) out += '⌘';
    return `${out}${keyLabel}`;
  }
  const mods = [];
  if (modSet.has('Ctrl')) mods.push('Ctrl');
  if (modSet.has('Alt')) mods.push('Alt');
  if (modSet.has('Shift')) mods.push('Shift');
  if (modSet.has('Meta')) mods.push(platform === 'win32' ? 'Win' : 'Super');
  return [...mods, keyLabel].join('+');
}

export function shortcutToMacCarbon(spec) {
  const raw = String(spec || '').trim();
  if (!raw) return null;
  const parts = raw.split('+').filter(Boolean);
  if (!parts.length) return null;
  const keyPart = parts[parts.length - 1];
  const keyCode = MAC_CARBON_KEYCODES[keyPart];
  if (typeof keyCode !== 'number') return null;
  let modifiers = 0;
  for (const mod of parts.slice(0, -1)) {
    if (MAC_CARBON_MODS[mod]) {
      modifiers |= MAC_CARBON_MODS[mod];
    }
  }
  return { keyCode, modifiers };
}

export function normalizeShortcutSpec(raw, platform = process.platform) {
  const str = String(raw ?? '').trim();
  if (!str) {
    return { ok: false, error: '快捷键不能为空' };
  }
  if (/^(off|none|disable|disabled)$/i.test(str)) {
    return {
      ok: true,
      disabled: true,
      accelerator: '',
      display: '已关闭',
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      key: '',
      macCarbon: null
    };
  }

  // Expand compact macOS modifier symbols (e.g. `⌥⌘K` or `⌃⇧L`) before splitting
  const expanded = str
    .replace(/⌃/g, 'Ctrl+')
    .replace(/⌥/g, 'Alt+')
    .replace(/⇧/g, 'Shift+')
    .replace(/⌘/g, 'Meta+')
    .replace(/\+\s*\+$/g, '+Equal');

  const rawTokens = expanded.split('+').map((t) => t.trim()).filter(Boolean);
  const mods = { ctrl: false, alt: false, shift: false, meta: false };
  const keys = [];

  for (const tok of rawTokens) {
    const low = tok.toLowerCase();
    if (['ctrl', 'control', 'ctl'].includes(low)) {
      mods.ctrl = true;
    } else if (['alt', 'opt', 'option'].includes(low)) {
      mods.alt = true;
    } else if (['shift', 'shft'].includes(low)) {
      mods.shift = true;
    } else if (['meta', 'cmd', 'command', 'super', 'win'].includes(low)) {
      mods.meta = true;
    } else {
      const canonKey = canonicalizeKeyToken(tok);
      if (!canonKey) {
        return {
          ok: false,
          error: `不支持的按键「${tok}」，请使用字母 A-Z、数字 0-9、F1-F12 或常用符号键`
        };
      }
      keys.push(canonKey);
    }
  }

  if (keys.length === 0) {
    return {
      ok: false,
      error: '请按下包含修饰键（如 ⌘ / ⌥ / ⌃）与单个主键的组合键'
    };
  }
  if (keys.length > 1) {
    return {
      ok: false,
      error: '快捷键只能包含一个主键，请使用「修饰键 + 单个按键」组合'
    };
  }

  const key = keys[0];
  const isFunctionKey = /^F([1-9]|1[0-2])$/.test(key);
  const hasPrimaryMod = mods.ctrl || mods.alt || mods.meta;
  if (!hasPrimaryMod && !isFunctionKey) {
    return {
      ok: false,
      error: '快捷键需至少包含 ⌘ / ⌥ / ⌃ 修饰键之一（或使用 F1-F12），避免干扰正常文字输入'
    };
  }

  if (platform === 'darwin') {
    const onlyMeta = mods.meta && !mods.alt && !mods.ctrl && !mods.shift;
    const onlyMetaShift = mods.meta && mods.shift && !mods.alt && !mods.ctrl;
    if ((onlyMeta && RESERVED_MAC_META_ONLY_KEYS.has(key)) || (onlyMetaShift && key === 'Z')) {
      return {
        ok: false,
        error: '该组合键为系统保留或基础编辑快捷键（如复制/粘贴/退出），请换用带 ⌥ 或 ⌃ 的组合（如 ⌥⌘K）'
      };
    }
  } else {
    const onlyCtrl = mods.ctrl && !mods.alt && !mods.meta && !mods.shift;
    if (onlyCtrl && RESERVED_OTHER_CTRL_ONLY_KEYS.has(key)) {
      return {
        ok: false,
        error: '该组合键为基础编辑快捷键（如复制/粘贴/撤销），请换用 Ctrl+Alt 组合（如 Ctrl+Alt+K）'
      };
    }
  }

  const orderedParts = [];
  if (mods.ctrl) orderedParts.push('Ctrl');
  if (mods.alt) orderedParts.push('Alt');
  if (mods.shift) orderedParts.push('Shift');
  if (mods.meta) orderedParts.push('Meta');
  orderedParts.push(key);
  const accelerator = orderedParts.join('+');

  return {
    ok: true,
    disabled: false,
    accelerator,
    display: formatShortcutDisplay(accelerator, platform),
    modifiers: mods,
    key,
    macCarbon: shortcutToMacCarbon(accelerator)
  };
}

export function getShortcutConfig(platform = process.platform) {
  const settings = loadRawSettings();
  const prefs = settings.uiPreferences || {};
  const defaultAccelerator = getDefaultShortcut(platform);
  const defaultDisplay = formatShortcutDisplay(defaultAccelerator, platform);
  const enabled = typeof prefs.shortcutEnabled === 'boolean' ? prefs.shortcutEnabled : true;
  const scope = SHORTCUT_SCOPES.includes(prefs.shortcutScope) ? prefs.shortcutScope : 'app';

  let accelerator = defaultAccelerator;
  if (typeof prefs.shortcutAccelerator === 'string' && prefs.shortcutAccelerator.trim()) {
    const parsed = normalizeShortcutSpec(prefs.shortcutAccelerator, platform);
    if (parsed.ok && !parsed.disabled) {
      accelerator = parsed.accelerator;
    }
  }
  const display = formatShortcutDisplay(accelerator, platform);

  return {
    enabled,
    accelerator,
    display,
    defaultAccelerator,
    defaultDisplay,
    isDefault: enabled === true && accelerator === defaultAccelerator && scope === 'app',
    scope,
    nativeGlobalSupported: platform === 'darwin',
    macCarbon: shortcutToMacCarbon(accelerator)
  };
}

export function setShortcutConfig(patch = {}, platform = process.platform) {
  const settings = loadRawSettings();
  const prevPrefs = settings.uiPreferences || {};
  const cur = getShortcutConfig(platform);

  let nextEnabled = cur.enabled;
  let nextAccelerator = cur.accelerator;
  let nextScope = cur.scope;

  if (patch.reset === true || patch.shortcutReset === true) {
    nextEnabled = true;
    nextAccelerator = getDefaultShortcut(platform);
    nextScope = 'app';
  } else {
    const rawAcc = patch.accelerator ?? patch.shortcutAccelerator;
    if (rawAcc !== undefined) {
      const parsed = normalizeShortcutSpec(rawAcc, platform);
      if (!parsed.ok) {
        return { ok: false, error: parsed.error, shortcut: cur };
      }
      if (parsed.disabled) {
        nextEnabled = false;
      } else {
        nextAccelerator = parsed.accelerator;
        if (typeof patch.enabled !== 'boolean' && typeof patch.shortcutEnabled !== 'boolean') {
          nextEnabled = true;
        }
      }
    }

    const rawEnabled = typeof patch.enabled === 'boolean'
      ? patch.enabled
      : (typeof patch.shortcutEnabled === 'boolean' ? patch.shortcutEnabled : undefined);
    if (typeof rawEnabled === 'boolean') {
      nextEnabled = rawEnabled;
    }

    const rawScope = patch.scope ?? patch.shortcutScope;
    if (rawScope !== undefined) {
      const normScope = String(rawScope).trim().toLowerCase();
      if (!SHORTCUT_SCOPES.includes(normScope)) {
        return { ok: false, error: '无效的快捷键生效范围（仅支持 app 或 global）', shortcut: cur };
      }
      nextScope = normScope;
    }
  }

  const auxCur = getAuxShortcutConfig(platform);
  if (nextEnabled && auxCur.enabled && nextAccelerator === auxCur.accelerator) {
    return {
      ok: false,
      error: `快捷键 ${formatShortcutDisplay(nextAccelerator, platform)} 已被「AGY 侧栏看板」占用，请先更换另一个组合键`,
      shortcut: cur
    };
  }

  settings.uiPreferences = {
    ...prevPrefs,
    shortcutEnabled: nextEnabled,
    shortcutAccelerator: nextAccelerator,
    shortcutScope: nextScope,
    updatedAt: new Date().toISOString()
  };
  writeJsonAtomic(getSettingsPath(), settings);
  return { ok: true, shortcut: getShortcutConfig(platform) };
}

export function getAuxShortcutConfig(platform = process.platform) {
  const settings = loadRawSettings();
  const prefs = settings.uiPreferences || {};
  const standalone = getShortcutConfig(platform);
  const defaultAccelerator = getDefaultAuxShortcut(platform, standalone.accelerator);
  const defaultDisplay = formatShortcutDisplay(defaultAccelerator, platform);
  const enabled = typeof prefs.auxShortcutEnabled === 'boolean' ? prefs.auxShortcutEnabled : true;
  const scope = SHORTCUT_SCOPES.includes(prefs.shortcutScope) ? prefs.shortcutScope : 'app';

  let accelerator = defaultAccelerator;
  if (typeof prefs.auxShortcutAccelerator === 'string' && prefs.auxShortcutAccelerator.trim()) {
    const parsed = normalizeShortcutSpec(prefs.auxShortcutAccelerator, platform);
    if (parsed.ok && !parsed.disabled) {
      accelerator = parsed.accelerator;
    }
  }
  const display = formatShortcutDisplay(accelerator, platform);

  return {
    enabled,
    accelerator,
    display,
    defaultAccelerator,
    defaultDisplay,
    isDefault: enabled === true && accelerator === defaultAccelerator && scope === 'app',
    scope,
    nativeGlobalSupported: platform === 'darwin',
    macCarbon: shortcutToMacCarbon(accelerator)
  };
}

export function setAuxShortcutConfig(patch = {}, platform = process.platform) {
  const settings = loadRawSettings();
  const prevPrefs = settings.uiPreferences || {};
  const cur = getAuxShortcutConfig(platform);
  const standalone = getShortcutConfig(platform);

  let nextEnabled = cur.enabled;
  let nextAccelerator = cur.accelerator;
  let nextScope = cur.scope;

  if (patch.reset === true || patch.auxShortcutReset === true) {
    nextEnabled = true;
    nextAccelerator = getDefaultAuxShortcut(platform, standalone.enabled ? standalone.accelerator : '');
  } else {
    const rawAcc = patch.accelerator ?? patch.auxAccelerator ?? patch.auxShortcutAccelerator;
    if (rawAcc !== undefined) {
      const parsed = normalizeShortcutSpec(rawAcc, platform);
      if (!parsed.ok) {
        return { ok: false, error: parsed.error, auxShortcut: cur };
      }
      if (parsed.disabled) {
        nextEnabled = false;
      } else {
        nextAccelerator = parsed.accelerator;
        if (typeof patch.enabled !== 'boolean' && typeof patch.auxShortcutEnabled !== 'boolean') {
          nextEnabled = true;
        }
      }
    }

    const rawEnabled = typeof patch.enabled === 'boolean'
      ? patch.enabled
      : (typeof patch.auxShortcutEnabled === 'boolean' ? patch.auxShortcutEnabled : undefined);
    if (typeof rawEnabled === 'boolean') {
      nextEnabled = rawEnabled;
    }

    const rawScope = patch.scope ?? patch.shortcutScope;
    if (rawScope !== undefined) {
      const normScope = String(rawScope).trim().toLowerCase();
      if (!SHORTCUT_SCOPES.includes(normScope)) {
        return { ok: false, error: '无效的快捷键生效范围（仅支持 app 或 global）', auxShortcut: cur };
      }
      nextScope = normScope;
    }
  }

  if (nextEnabled && standalone.enabled && nextAccelerator === standalone.accelerator) {
    return {
      ok: false,
      error: `快捷键 ${formatShortcutDisplay(nextAccelerator, platform)} 已被「独立悬浮窗」占用，请先更换另一个组合键`,
      auxShortcut: cur
    };
  }

  settings.uiPreferences = {
    ...prevPrefs,
    auxShortcutEnabled: nextEnabled,
    auxShortcutAccelerator: nextAccelerator,
    shortcutScope: nextScope,
    updatedAt: new Date().toISOString()
  };
  writeJsonAtomic(getSettingsPath(), settings);
  return { ok: true, auxShortcut: getAuxShortcutConfig(platform) };
}

export function getSharedAuxTriggerPath() {
  const override = String(process.env.AGY_AUX_TRIGGER_PATH || '').trim();
  if (override) return resolve(override);

  const dirs = [
    process.env.AGY_FINDER_DATA_DIR,
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR
  ].filter((v) => typeof v === 'string' && v.trim());

  for (const rawDir of dirs) {
    for (let d = resolve(rawDir); d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        return join(d, 'agy_aux_pane_trigger.json');
      }
    }
    return join(resolve(rawDir), 'agy_aux_pane_trigger.json');
  }
  return join(findAppDataDir(), 'sidecar_data', 'agy_aux_pane_trigger.json');
}

export function readAuxPaneTrigger() {
  const raw = readJsonSafe(getSharedAuxTriggerPath(), null);
  return {
    seq: Number(raw?.seq || 0),
    targetPlugin: typeof raw?.targetPlugin === 'string' ? raw.targetPlugin : '',
    uri: typeof raw?.uri === 'string' ? raw.uri : '',
    action: typeof raw?.action === 'string' ? raw.action : 'toggle',
    convId: typeof raw?.convId === 'string' ? raw.convId : '',
    revealPath: typeof raw?.revealPath === 'string' ? raw.revealPath : '',
    at: Number(raw?.at || 0),
    openingSeq: Number(raw?.openingSeq || 0),
    ackSeq: Number(raw?.ackSeq || 0),
    ackAt: Number(raw?.ackAt || 0),
    ackPlugin: typeof raw?.ackPlugin === 'string' ? raw.ackPlugin : '',
    switchedSeq: Number(raw?.switchedSeq || 0),
    activeConvId: typeof raw?.activeConvId === 'string' ? raw.activeConvId : '',
    activeConvUpdatedAt: Number(raw?.activeConvUpdatedAt || 0),
    viewBatchMs: Number(raw?.viewBatchMs || 0),
    viewWinnerId: typeof raw?.viewWinnerId === 'string' ? raw.viewWinnerId : ''
  };
}

/**
 * Resolves the most recently active Antigravity Desktop conversation ID by comparing
 * timestamps across Desktop view-time annotations, transcript mtimes, visible Aux focus
 * hints, and the previous Aux bridge active conversation.
 */
export function resolveDesktopForegroundConversationId({ curTrigger = null, persistViewBatch = false } = {}) {
  const cur = curTrigger && typeof curTrigger === 'object' ? curTrigger : readAuxPaneTrigger();
  const hint = readActiveSessionHint();
  const recent = listRecentConversations(24);
  const desktopTop = recent.filter((c) => c.source === 'desktop' && !c.isSubagent);
  const desktopAny = desktopTop.length ? desktopTop : recent.filter((c) => c.source === 'desktop');
  const pool = desktopAny.length ? desktopAny : recent.filter((c) => !c.isSubagent);
  const inPool = (id) => Boolean(id) && (!pool.length || pool.some((c) => c.id === id));

  const candidates = [];
  let maxViewMs = 0;
  let resolvedViewWinnerId = '';

  if (pool.length) {
    for (const c of pool) {
      if ((c.viewTimeMs || 0) > maxViewMs) maxViewMs = c.viewTimeMs;
    }
    if (maxViewMs > 0) {
      const tied = pool.filter((c) => Math.abs((c.viewTimeMs || 0) - maxViewMs) <= 80);
      const knownBatchMs = Math.max(Number(cur.viewBatchMs || 0), Number(hint.lastBatchViewMs || 0));
      const prevWinner = cur.viewWinnerId || hint.resolvedConvId || cur.activeConvId || '';
      const viewWinner = tied.length > 1 && prevWinner
        ? (maxViewMs > knownBatchMs
            ? (tied.find((c) => c.id !== prevWinner) || tied[0])
            : (tied.find((c) => c.id === prevWinner) || tied[0]))
        : tied[0];
      if (viewWinner?.id) {
        resolvedViewWinnerId = viewWinner.id;
        candidates.push({ id: viewWinner.id, ts: maxViewMs });
        if (persistViewBatch && maxViewMs > Number(hint.lastBatchViewMs || 0)) {
          updateActiveSessionHint({ resolvedConvId: viewWinner.id, lastBatchViewMs: maxViewMs });
        }
      }
    }

    const newestTurn = [...pool].sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0))[0];
    if (
      newestTurn?.id &&
      (newestTurn.updatedAtMs || 0) > 0 &&
      (maxViewMs === 0 || ((newestTurn.viewTimeMs || 0) === 0 && !newestTurn.isSubagent && newestTurn.updatedAtMs > maxViewMs))
    ) {
      candidates.push({ id: newestTurn.id, ts: newestTurn.updatedAtMs });
    }
  }

  if (CONV_ID_RE.test(String(hint.userFocusedConvId || '')) && (hint.userFocusedAt || 0) > 0 && inPool(hint.userFocusedConvId)) {
    candidates.push({ id: hint.userFocusedConvId, ts: hint.userFocusedAt });
  }

  if (CONV_ID_RE.test(String(cur.activeConvId || '')) && Number(cur.activeConvUpdatedAt || 0) > 0 && inPool(cur.activeConvId)) {
    candidates.push({ id: cur.activeConvId, ts: Number(cur.activeConvUpdatedAt) });
  }

  candidates.sort((a, b) => b.ts - a.ts);
  const chosenId = candidates[0]?.id || (
    (CONV_ID_RE.test(String(hint.userFocusedConvId || '')) ? hint.userFocusedConvId : '') ||
    (CONV_ID_RE.test(String(hint.resolvedConvId || '')) ? hint.resolvedConvId : '') ||
    (CONV_ID_RE.test(String(cur.activeConvId || '')) ? cur.activeConvId : '') ||
    pool[0]?.id ||
    ''
  );
  if (persistViewBatch && typeof persistViewBatch === 'object') {
    persistViewBatch.viewBatchMs = maxViewMs > 0 ? maxViewMs : Number(cur.viewBatchMs || 0);
    persistViewBatch.viewWinnerId = resolvedViewWinnerId || cur.viewWinnerId || '';
  }
  return chosenId;
}

const AUX_TRIGGER_WAIT_ARR = new Int32Array(new SharedArrayBuffer(4));

function isAuxLockPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function parseAuxBakeryEntry(name) {
  if (name.startsWith('ticket-')) {
    const parts = name.split('-');
    if (parts.length !== 4 || parts[1].length !== 16) return null;
    let ticket;
    try {
      ticket = BigInt(`0x${parts[1]}`);
    } catch {
      return null;
    }
    const pid = Number(parts[2]);
    if (!Number.isInteger(pid) || pid <= 0 || !parts[3]) return null;
    return { kind: 'ticket', name, ticket, pid, nonce: parts[3] };
  }
  if (name.startsWith('entering-') || name.startsWith('cand-')) {
    const parts = name.split('-');
    if (parts.length !== 3) return null;
    const pid = Number(parts[1]);
    if (!Number.isInteger(pid) || pid <= 0 || !parts[2]) return null;
    return { kind: name.startsWith('entering-') ? 'entering' : 'cand', name, pid, nonce: parts[2] };
  }
  return null;
}

function compareAuxTickets(aTicket, aPid, aNonce, bTicket, bPid, bNonce) {
  if (aTicket !== bTicket) return aTicket < bTicket ? -1 : 1;
  if (aPid !== bPid) return aPid < bPid ? -1 : 1;
  if (aNonce === bNonce) return 0;
  return aNonce < bNonce ? -1 : 1;
}

// Two-layer Lamport Bakery (.lock.d) + .lock protocol (requires agy-finder >= 0.2.4 and context-viewer >= 1.7.4).
// All .lock.d filenames carry unique immutable (pid, nonce) suffixes so dead-PID reaping unlinks can never delete a newer contender's entry.
function withAuxTriggerLock(fn, options = {}) {
  const filePath = getSharedAuxTriggerPath();
  const lockPath = `${filePath}.lock`;
  const lockDir = `${lockPath}.d`;
  const pid = process.pid;
  const nonce = randomBytes(6).toString('hex');
  const token = `${pid}:${Date.now()}:${nonce}`;
  const rawTimeout = Number(options.timeoutMs ?? process.env.AGY_AUX_LOCK_TIMEOUT_MS ?? 1200);
  const timeoutMs = Number.isFinite(rawTimeout) ? Math.max(20, Math.min(4000, rawTimeout)) : 1200;
  const deadline = Date.now() + timeoutMs;

  let enteringPath = '';
  let ticketPath = '';
  let candPath = '';
  let bakeryAcquired = false;
  let lockAcquired = false;

  try {
    try {
      mkdirSync(lockDir, { recursive: true });
      const enteringName = `entering-${pid}-${nonce}`;
      enteringPath = join(lockDir, enteringName);
      closeSync(openSync(enteringPath, 'wx', 0o600));

      let maxTicket = 0n;
      for (const name of readdirSync(lockDir)) {
        const parsed = parseAuxBakeryEntry(name);
        if (parsed?.kind === 'ticket' && parsed.ticket > maxTicket) {
          maxTicket = parsed.ticket;
        }
      }
      const myTicket = maxTicket + 1n;
      const ticketName = `ticket-${myTicket.toString(16).padStart(16, '0')}-${pid}-${nonce}`;
      ticketPath = join(lockDir, ticketName);
      closeSync(openSync(ticketPath, 'wx', 0o600));

      try { unlinkSync(enteringPath); } catch {}
      enteringPath = '';

      // A single entering snapshot taken after creating ticketPath suffices: any later entrant will observe ticketPath and draw a ticket > myTicket.
      let snapshot = readdirSync(lockDir);
      const pendingEntering = new Map();
      for (const name of snapshot) {
        const parsed = parseAuxBakeryEntry(name);
        if (parsed?.kind === 'entering' && name !== enteringName) {
          pendingEntering.set(name, parsed.pid);
        }
      }

      let attempt = 0;
      while (!bakeryAcquired && Date.now() < deadline) {
        const currentNames = (snapshot ?? readdirSync(lockDir)).sort();
        snapshot = null;
        const currentSet = new Set(currentNames);
        let blocked = false;
        let reapedDead = false;

        for (const [eName, ePid] of Array.from(pendingEntering.entries())) {
          if (!currentSet.has(eName)) {
            pendingEntering.delete(eName);
          } else if (!isAuxLockPidAlive(ePid)) {
            try { unlinkSync(join(lockDir, eName)); } catch {}
            pendingEntering.delete(eName);
            reapedDead = true;
          } else {
            blocked = true;
            break;
          }
        }

        if (!blocked && !reapedDead) {
          for (const name of currentNames) {
            if (name === ticketName) continue;
            const parsed = parseAuxBakeryEntry(name);
            if (
              parsed?.kind === 'ticket' &&
              compareAuxTickets(parsed.ticket, parsed.pid, parsed.nonce, myTicket, pid, nonce) < 0
            ) {
              if (!isAuxLockPidAlive(parsed.pid)) {
                try { unlinkSync(join(lockDir, name)); } catch {}
                reapedDead = true;
              } else {
                blocked = true;
                break;
              }
            }
          }
        }

        if (reapedDead && !blocked) {
          continue;
        }

        if (!blocked && !reapedDead) {
          for (const name of currentNames) {
            const parsed = parseAuxBakeryEntry(name);
            if (parsed?.kind === 'cand' && !isAuxLockPidAlive(parsed.pid)) {
              try { unlinkSync(join(lockDir, name)); } catch {}
            }
          }
          bakeryAcquired = true;
          break;
        }

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        const waitMs = Math.min(remainingMs, Math.min(16, 2 + attempt * 2));
        attempt += 1;
        try {
          Atomics.wait(AUX_TRIGGER_WAIT_ARR, 0, 0, waitMs);
        } catch {}
      }

      if (bakeryAcquired) {
        candPath = join(lockDir, `cand-${pid}-${nonce}`);
        writeFileSync(candPath, token, { mode: 0o600 });
        let lockAttempt = 0;
        while (!lockAcquired && Date.now() < deadline) {
          let fd = null;
          try {
            linkSync(candPath, lockPath);
            lockAcquired = true;
            break;
          } catch (linkErr) {
            let err = linkErr;
            if (linkErr?.code === 'ENOSYS' || linkErr?.code === 'EPERM' || linkErr?.code === 'EXDEV' || linkErr?.code === 'EACCES') {
              err = null;
              try {
                fd = openSync(lockPath, 'wx', 0o600);
                writeSync(fd, token);
                lockAcquired = true;
                break;
              } catch (openErr) {
                err = openErr;
                if (fd !== null && !lockAcquired) {
                  try { closeSync(fd); } catch {}
                  fd = null;
                  try { unlinkSync(lockPath); } catch {}
                }
              } finally {
                if (fd !== null) {
                  try { closeSync(fd); } catch {}
                }
              }
            }
            if (err?.code === 'ENOENT') {
              try { mkdirSync(lockDir, { recursive: true }); } catch {}
              try { writeFileSync(candPath, token, { mode: 0o600 }); } catch {}
              continue;
            }
            if (err?.code !== 'EEXIST') break;

            try {
              const st = statSync(lockPath);
              const ageMs = Date.now() - Number(st.mtimeMs || 0);
              let raw = '';
              try { raw = readFileSync(lockPath, 'utf8'); } catch {}
              const trimmed = String(raw || '').trim();
              const hasPidSep = trimmed.includes(':');
              const ownerPid = hasPidSep ? Number(trimmed.split(':')[0]) : 0;
              const deadOwner = hasPidSep && Number.isInteger(ownerPid) && ownerPid > 0 && !isAuxLockPidAlive(ownerPid);
              const orphanedBlank = !hasPidSep && ageMs >= 2000;
              if (deadOwner || orphanedBlank) {
                const stalePath = `${lockPath}.stale.${pid}.${Date.now()}.${lockAttempt}`;
                try {
                  renameSync(lockPath, stalePath);
                  try { unlinkSync(stalePath); } catch {}
                  continue;
                } catch {}
              }
            } catch (statErr) {
              if (statErr?.code === 'ENOENT') continue;
            }

            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) break;
            const waitMs = Math.min(remainingMs, Math.min(16, 2 + lockAttempt * 2));
            lockAttempt += 1;
            try {
              Atomics.wait(AUX_TRIGGER_WAIT_ARR, 0, 0, waitMs);
            } catch {}
          }
        }
        if (candPath) {
          try { unlinkSync(candPath); } catch {}
          candPath = '';
        }
      }
    } catch {}

    if (!bakeryAcquired || !lockAcquired) {
      return typeof options.onFail === 'function' ? options.onFail(filePath) : null;
    }
    return fn(filePath);
  } finally {
    if (candPath) {
      try { unlinkSync(candPath); } catch {}
    }
    if (lockAcquired) {
      // Must unlink .lock before ticketPath so waiting contenders only enter the .lock phase after .lock is released.
      try {
        if (readFileSync(lockPath, 'utf8') === token) {
          unlinkSync(lockPath);
        }
      } catch {}
    }
    if (ticketPath) {
      try { unlinkSync(ticketPath); } catch {}
    }
    if (enteringPath) {
      try { unlinkSync(enteringPath); } catch {}
    }
  }
}

export function writeAuxPaneTrigger({ targetPlugin = 'context-viewer', uri = '', action = 'toggle', convId = '', revealPath = '' } = {}) {
  const explicitConvId = (typeof convId === 'string' && CONV_ID_RE.test(convId.trim())) ? convId.trim() : '';
  if (!explicitConvId) {
    // Warm read-only transcript metadata cache outside the cross-process lock
    try { listRecentConversations(24); } catch {}
  }
  return withAuxTriggerLock((filePath) => {
    const cur = readAuxPaneTrigger();
    const batchMeta = {};
    const resolvedActive = explicitConvId || resolveDesktopForegroundConversationId({ curTrigger: cur, persistViewBatch: batchMeta });
    const next = {
      seq: Math.max(0, Number(cur.seq || 0)) + 1,
      targetPlugin: String(targetPlugin || 'context-viewer'),
      uri: String(uri || ''),
      action: String(action || 'toggle'),
      convId: (typeof convId === 'string' && convId.trim()) ? convId.trim() : resolvedActive,
      revealPath: typeof revealPath === 'string' ? revealPath : '',
      at: Date.now(),
      openingSeq: 0,
      ackSeq: cur.ackSeq,
      ackAt: cur.ackAt,
      ackPlugin: cur.ackPlugin,
      switchedSeq: 0,
      activeConvId: resolvedActive,
      activeConvUpdatedAt: explicitConvId ? Date.now() : Number(cur.activeConvUpdatedAt || 0),
      viewBatchMs: batchMeta.viewBatchMs ?? Number(cur.viewBatchMs || 0),
      viewWinnerId: explicitConvId || batchMeta.viewWinnerId || cur.viewWinnerId || ''
    };
    writeJsonAtomic(filePath, next);
    return next;
  }, {
    onFail: () => ({ ...readAuxPaneTrigger(), ok: false, seq: 0, lockBusy: true })
  });
}

export function markAuxPaneOpening({ seq } = {}) {
  const targetSeq = Number(seq || 0);
  if (!targetSeq) {
    return { ok: true, claimed: false, trigger: readAuxPaneTrigger() };
  }
  return withAuxTriggerLock((filePath) => {
    const cur = readAuxPaneTrigger();
    if (targetSeq <= cur.openingSeq) {
      return { ok: true, claimed: false, trigger: cur };
    }
    const next = {
      ...cur,
      openingSeq: targetSeq
    };
    writeJsonAtomic(filePath, next);
    return { ok: true, claimed: true, trigger: next };
  }, {
    onFail: () => ({ ok: false, claimed: false, lockBusy: true, trigger: readAuxPaneTrigger() })
  });
}

export function ackAuxPaneTrigger({ seq, plugin = 'context-viewer' } = {}) {
  const targetSeq = Number(seq || 0);
  if (!targetSeq) {
    return { ok: true, claimed: false, trigger: readAuxPaneTrigger() };
  }
  return withAuxTriggerLock((filePath) => {
    const cur = readAuxPaneTrigger();
    if (targetSeq < cur.seq || cur.ackSeq >= targetSeq) {
      return { ok: true, claimed: false, trigger: cur };
    }
    const next = {
      ...cur,
      ackSeq: targetSeq,
      ackAt: Date.now(),
      ackPlugin: String(plugin || 'context-viewer')
    };
    writeJsonAtomic(filePath, next);
    return { ok: true, claimed: true, trigger: next };
  }, {
    onFail: () => ({ ok: false, claimed: false, lockBusy: true, trigger: readAuxPaneTrigger() })
  });
}

export function markAuxPaneSwitched({ seq } = {}) {
  const targetSeq = Number(seq || 0);
  if (!targetSeq) {
    return { ok: true, claimed: false, trigger: readAuxPaneTrigger() };
  }
  return withAuxTriggerLock((filePath) => {
    const cur = readAuxPaneTrigger();
    if (targetSeq <= cur.switchedSeq) {
      return { ok: true, claimed: false, trigger: cur };
    }
    const next = {
      ...cur,
      switchedSeq: targetSeq
    };
    writeJsonAtomic(filePath, next);
    return { ok: true, claimed: true, trigger: next };
  }, {
    onFail: () => ({ ok: false, claimed: false, lockBusy: true, trigger: readAuxPaneTrigger() })
  });
}

export function recordAuxActiveConversation({ convId = '' } = {}) {
  const cleanId = String(convId || '').trim();
  if (!CONV_ID_RE.test(cleanId)) {
    return { ok: false, activeConvId: '' };
  }
  return withAuxTriggerLock((filePath) => {
    const raw = readJsonSafe(filePath, null);
    const cur = readAuxPaneTrigger();
    const now = Date.now();
    if (raw && cur.activeConvId === cleanId && now - Number(cur.activeConvUpdatedAt || 0) < 1000) {
      return { ok: true, activeConvId: cleanId };
    }
    writeJsonAtomic(filePath, {
      ...cur,
      activeConvId: cleanId,
      activeConvUpdatedAt: now
    });
    return { ok: true, activeConvId: cleanId };
  }, {
    onFail: () => ({ ok: false, activeConvId: '', lockBusy: true })
  });
}

export function waitForAuxPaneTrigger({ since = 0, timeoutMs = 8000 } = {}) {
  const sinceSeq = Math.max(0, Number(since || 0));
  const clampedMs = Math.max(0, Math.min(9500, Number(timeoutMs ?? 8000) || 0));
  const initial = readAuxPaneTrigger();
  if (initial.seq > sinceSeq || clampedMs === 0) {
    return Promise.resolve({ ok: true, changed: initial.seq > sinceSeq, trigger: initial });
  }

  const filePath = getSharedAuxTriggerPath();
  const dir = dirname(filePath);
  const name = basename(filePath);
  try { mkdirSync(dir, { recursive: true }); } catch {}

  return new Promise((resolvePromise) => {
    let settled = false;
    let watcher = null;
    let pollTimer = null;
    let timeoutTimer = null;

    const finish = (trigger) => {
      if (settled) return;
      settled = true;
      try { watcher?.close(); } catch {}
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolvePromise({ ok: true, changed: trigger.seq > sinceSeq, trigger });
    };

    const checkNow = () => {
      const cur = readAuxPaneTrigger();
      if (cur.seq > sinceSeq) finish(cur);
    };

    try {
      watcher = watch(dir, (_ev, filename) => {
        if (!filename || String(filename) === name) {
          checkNow();
        }
      });
      watcher.on('error', () => {});
    } catch {}

    pollTimer = setInterval(checkNow, 90);
    pollTimer.unref?.();
    timeoutTimer = setTimeout(() => {
      finish(readAuxPaneTrigger());
    }, clampedMs);
    timeoutTimer.unref?.();
  });
}

export function getMenubarPreference() {
  const settings = loadRawSettings();
  if (typeof settings.uiPreferences?.menubarEnabled === 'boolean') {
    return settings.uiPreferences.menubarEnabled;
  }
  return process.platform === 'darwin';
}

export function setMenubarPreference(enabled) {
  const wantEnabled = Boolean(enabled);
  const settings = loadRawSettings();
  settings.uiPreferences = {
    ...settings.uiPreferences,
    menubarEnabled: wantEnabled,
    updatedAt: new Date().toISOString()
  };
  writeJsonAtomic(getSettingsPath(), settings);
  return wantEnabled;
}

export function getMenubarMode() {
  const settings = loadRawSettings();
  const raw = String(settings.uiPreferences?.menubarMode || 'context').toLowerCase();
  return MENUBAR_MODES.includes(raw) ? raw : 'context';
}

export function setMenubarMode(mode) {
  const norm = String(mode || 'context').toLowerCase();
  const validMode = MENUBAR_MODES.includes(norm) ? norm : 'context';
  const settings = loadRawSettings();
  settings.uiPreferences = {
    ...settings.uiPreferences,
    menubarMode: validMode,
    updatedAt: new Date().toISOString()
  };
  writeJsonAtomic(getSettingsPath(), settings);
  return validMode;
}

function getActiveSessionHintPath() {
  return join(getPluginStateDir(), 'active_session_hint.json');
}

export function readActiveSessionHint() {
  const data = readJsonSafe(getActiveSessionHintPath(), null);
  if (!data || typeof data !== 'object') {
    return {
      pinnedConvId: '',
      userFocusedConvId: '',
      userFocusedAt: 0,
      resolvedConvId: '',
      lastBatchViewMs: 0
    };
  }
  return {
    pinnedConvId: CONV_ID_RE.test(data.pinnedConvId || '') ? data.pinnedConvId : '',
    userFocusedConvId: CONV_ID_RE.test(data.userFocusedConvId || '') ? data.userFocusedConvId : '',
    userFocusedAt: Number(data.userFocusedAt || 0),
    resolvedConvId: CONV_ID_RE.test(data.resolvedConvId || '') ? data.resolvedConvId : '',
    lastBatchViewMs: Number(data.lastBatchViewMs || 0)
  };
}

export function updateActiveSessionHint(patch = {}) {
  const cur = readActiveSessionHint();
  const next = { ...cur };
  if (typeof patch.pinnedConvId === 'string') {
    next.pinnedConvId = CONV_ID_RE.test(patch.pinnedConvId) ? patch.pinnedConvId : '';
  }
  if (typeof patch.userFocusedConvId === 'string' && CONV_ID_RE.test(patch.userFocusedConvId)) {
    next.userFocusedConvId = patch.userFocusedConvId;
    next.userFocusedAt = Number(patch.userFocusedAt || Date.now());
  }
  if (typeof patch.resolvedConvId === 'string') {
    next.resolvedConvId = CONV_ID_RE.test(patch.resolvedConvId) ? patch.resolvedConvId : '';
  }
  if (typeof patch.lastBatchViewMs === 'number') {
    next.lastBatchViewMs = patch.lastBatchViewMs;
  }
  writeJsonAtomic(getActiveSessionHintPath(), next);
  return next;
}

export function getSidebarEntryStatus() {
  const manifestPath = getSidecarManifestPath();
  const manifest = readJsonSafe(manifestPath, null);
  const views = Array.isArray(manifest?.ui_config?.views) ? manifest.ui_config.views : [];
  const sidebarEnabled = views.some((v) => v?.entrypoint === 'SIDECAR_UI_ENTRYPOINT_SIDEBAR');
  const hint = readActiveSessionHint();
  return {
    ok: true,
    menubarEnabled: getMenubarPreference(),
    menubarMode: getMenubarMode(),
    menubarSupported: process.platform === 'darwin',
    shortcut: getShortcutConfig(),
    auxShortcut: getAuxShortcutConfig(),
    pinnedConvId: hint.pinnedConvId || '',
    sidebarEnabled,
    viewsCount: views.length
  };
}

export function setSidebarEntrypoint(enabled, { persist = true } = {}) {
  const wantEnabled = Boolean(enabled);
  const manifestPath = getSidecarManifestPath();
  const manifest = readJsonSafe(manifestPath, null);
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, error: '未找到 sidecar.json 配置文件' };
  }

  const existingViews = Array.isArray(manifest.ui_config?.views) ? manifest.ui_config.views : [];
  const auxView = existingViews.find((v) => v?.entrypoint === 'SIDECAR_UI_ENTRYPOINT_AUX_PANE') || {
    path: '/',
    entrypoint: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
    title: '上下文看板'
  };
  const otherViews = existingViews.filter(
    (v) => v?.entrypoint !== 'SIDECAR_UI_ENTRYPOINT_AUX_PANE' && v?.entrypoint !== 'SIDECAR_UI_ENTRYPOINT_SIDEBAR'
  );
  const nextViews = [auxView, ...otherViews];
  if (wantEnabled) {
    nextViews.push({
      path: '/sidebar',
      entrypoint: 'SIDECAR_UI_ENTRYPOINT_SIDEBAR',
      title: '上下文看板'
    });
  }

  const currentlyEnabled = existingViews.some((v) => v?.entrypoint === 'SIDECAR_UI_ENTRYPOINT_SIDEBAR');
  if (currentlyEnabled !== wantEnabled || existingViews.length !== nextViews.length) {
    manifest.ui_config = {
      ...(manifest.ui_config || { display_name: '上下文与 Token 看板' }),
      views: nextViews
    };
    const tmp = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    renameSync(tmp, manifestPath);
  }

  if (persist) {
    const settings = loadRawSettings();
    settings.uiPreferences = {
      ...settings.uiPreferences,
      sidebarEntryEnabled: wantEnabled,
      updatedAt: new Date().toISOString()
    };
    writeJsonAtomic(getSettingsPath(), settings);
  }

  return {
    ok: true,
    sidebarEnabled: wantEnabled,
    message: wantEnabled
      ? '已开启方案 A：左侧栏 Plugins 区「上下文看板」常驻一级入口已激活'
      : '已关闭方案 A：已从左侧栏移除常驻入口（仍可用 📌 右侧置顶小窗或右侧栏）'
  };
}

export function syncSidebarManifestFromSettings() {
  const settings = loadRawSettings();
  if (typeof settings.uiPreferences?.sidebarEntryEnabled === 'boolean') {
    return setSidebarEntrypoint(settings.uiPreferences.sidebarEntryEnabled, { persist: false });
  }
  return getSidebarEntryStatus();
}

export async function saveSettings(payload = {}) {
  const host = await getHostUserStatus(false, { background: true });
  const settings = loadRawSettings();
  const acctKey = host.plan?.accountKey || settings.lastAccountKey || 'default';

  if (payload.clearPlan === true) {
    delete settings.accounts[acctKey];
    delete settings.accounts.default;
  } else if (payload.customPlan && typeof payload.customPlan === 'object') {
    const prev = settings.accounts[acctKey] || settings.accounts.default || {};
    const next = { ...prev, ...payload.customPlan, updatedAt: new Date().toISOString() };
    settings.accounts[acctKey] = next;
    settings.accounts.default = next;
    settings.lastAccountKey = acctKey;
  }

  if (payload.uiPreferences && typeof payload.uiPreferences === 'object') {
    settings.uiPreferences = {
      ...settings.uiPreferences,
      ...payload.uiPreferences,
      updatedAt: new Date().toISOString()
    };
    delete settings.uiPreferences.budgetOverride;
  }

  writeJsonAtomic(getSettingsPath(), settings);
  cachedHistoryResult.at = 0; // Invalidate history cache so updated plan reflects immediately
  return getSettings();
}

// ---------------------------------------------------------------------------
// Attachment Read-only Scanner (Images, Text/Code, PDF text streams, Office XML)
// ---------------------------------------------------------------------------

function extractOfficeXmlChars(buf) {
  // Minimal read-only ZIP central directory parser for .docx / .xlsx / .pptx XML entries
  try {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const totalEntries = buf.readUInt16LE(eocd + 10);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    let ptr = cdOffset;
    let extractedText = '';
    for (let idx = 0; idx < totalEntries && ptr + 46 <= buf.length; idx++) {
      if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
      const method = buf.readUInt16LE(ptr + 10);
      const compSize = buf.readUInt32LE(ptr + 20);
      const uncompSize = buf.readUInt32LE(ptr + 24);
      const nameLen = buf.readUInt16LE(ptr + 28);
      const extraLen = buf.readUInt16LE(ptr + 30);
      const commentLen = buf.readUInt16LE(ptr + 32);
      const localHeaderOffset = buf.readUInt32LE(ptr + 42);
      const entryName = buf.toString('utf-8', ptr + 46, ptr + 46 + nameLen);
      ptr += 46 + nameLen + extraLen + commentLen;

      if (!/\.(xml|rels|txt|csv|md)$/i.test(entryName)) continue;
      if (!/(word\/document|xl\/sharedStrings|xl\/worksheets\/sheet|ppt\/slides\/slide)/i.test(entryName)) continue;
      if (uncompSize > 8 * 1024 * 1024 || localHeaderOffset + 30 > buf.length) continue;

      const lNameLen = buf.readUInt16LE(localHeaderOffset + 26);
      const lExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + lNameLen + lExtraLen;
      if (dataStart + compSize > buf.length) continue;
      const slice = buf.subarray(dataStart, dataStart + compSize);
      let xml = '';
      if (method === 0) xml = slice.toString('utf-8');
      else if (method === 8) xml = inflateRawSync(slice).toString('utf-8');
      if (xml) {
        extractedText += ' ' + xml.replace(/<[^>]+>/g, ' ');
      }
    }
    return extractedText.trim() || null;
  } catch {
    return null;
  }
}

function inspectAttachmentItem(item) {
  const baseName = item.name || (item.uri ? item.uri.split(/[\\/]/).pop() : '附件');
  const refs = item.references || 1;
  try {
    if (item.inlineData) {
      const buf = Buffer.from(item.inlineData, 'base64');
      const mime = String(item.mime || '').toLowerCase();
      if (mime.startsWith('image/')) {
        const dims = getImageDimensions(buf);
        const [low, high] = calcImageTokens(dims.width, dims.height);
        return {
          name: baseName,
          mime,
          source: item.source || 'user',
          references: refs,
          status: 'parsed',
          bytes: buf.length,
          chars: 0,
          dimensions: dims.width ? `${dims.width}×${dims.height}` : null,
          low,
          high,
          note: dims.width ? `${dims.width}×${dims.height} 像素` : '内嵌图像'
        };
      }
      const text = buf.toString('utf-8');
      const m = measureText(text);
      return {
        name: baseName,
        mime,
        source: item.source || 'user',
        references: refs,
        status: 'parsed',
        ...m,
        dimensions: null,
        note: `${m.chars.toLocaleString()} 字符`
      };
    }

    if (!item.uri || /^https?:/i.test(item.uri)) {
      return { name: baseName, mime: item.mime || '', source: item.source || 'user', references: refs, status: 'unknown', ...emptyMeasure(), note: '远程或无本地路径，未计入零值' };
    }
    const rawPath = item.uri.startsWith('file://') ? fileURLToPath(item.uri) : item.uri;
    if (!existsSync(rawPath)) {
      return { name: baseName, mime: item.mime || '', source: item.source || 'user', references: refs, status: 'unknown', ...emptyMeasure(), note: '本地文件已移除或不可访问' };
    }
    const real = realpathSync(rawPath);
    const st = statSync(real);
    if (!st.isFile()) {
      return { name: baseName, mime: item.mime || '', source: item.source || 'user', references: refs, status: 'unknown', ...emptyMeasure(), note: '非常规文件' };
    }
    if (st.size > MAX_ATTACHMENT_BYTES) {
      return { name: baseName, mime: item.mime || '', source: item.source || 'user', references: refs, status: 'unknown', ...emptyMeasure(), bytes: st.size, note: '文件超过 24 MB 安全扫描上限' };
    }

    const cacheKey = `${real}|${st.size}|${st.mtimeMs}`;
    if (fileAuditCache.has(cacheKey)) {
      return { ...fileAuditCache.get(cacheKey), name: baseName, references: refs, source: item.source || 'user' };
    }

    const ext = extname(real).toLowerCase();
    const mime = String(item.mime || '').toLowerCase();
    const buf = readFileSync(real);
    let parsed = null;

    if (mime.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) {
      const dims = getImageDimensions(buf);
      const [low, high] = calcImageTokens(dims.width, dims.height);
      parsed = {
        mime: mime || `image/${ext.slice(1)}`,
        status: 'parsed',
        bytes: st.size,
        chars: 0,
        dimensions: dims.width ? `${dims.width}×${dims.height}` : null,
        low,
        high,
        note: dims.width ? `${dims.width}×${dims.height} 像素` : '图像文件'
      };
    } else if (mime.startsWith('text/') || TEXT_EXTENSIONS.has(ext) || ext === '.svg') {
      const text = buf.toString('utf-8');
      const m = measureText(text);
      parsed = {
        mime: mime || 'text/plain',
        status: 'parsed',
        ...m,
        dimensions: null,
        note: `${m.chars.toLocaleString()} 字符`
      };
    } else if (['.docx', '.xlsx', '.pptx'].includes(ext)) {
      const xmlText = extractOfficeXmlChars(buf);
      if (xmlText) {
        const m = measureText(xmlText);
        parsed = {
          mime: mime || 'application/octet-stream',
          status: 'parsed',
          bytes: st.size,
          chars: m.chars,
          low: m.low,
          high: m.high,
          dimensions: null,
          note: `Office 文档文本约 ${m.chars.toLocaleString()} 字符`
        };
      }
    }

    if (!parsed) {
      parsed = {
        mime: mime || 'application/octet-stream',
        status: 'unknown',
        ...emptyMeasure(),
        bytes: st.size,
        dimensions: null,
        note: ext === '.pdf' ? 'PDF 多模态页内容未按零处理，以服务端实际统计为准' : '二进制或多媒体格式，未按零处理'
      };
    }

    if (fileAuditCache.size > 500) {
      const oldest = fileAuditCache.keys().next().value;
      if (oldest) fileAuditCache.delete(oldest);
    }
    fileAuditCache.set(cacheKey, parsed);
    return { ...parsed, name: baseName, references: refs, source: item.source || 'user' };
  } catch (err) {
    return {
      name: baseName,
      mime: item.mime || '',
      source: item.source || 'user',
      references: refs,
      status: 'unknown',
      ...emptyMeasure(),
      note: `读取受阻：${err.message || '未知原因'}`
    };
  }
}

// ---------------------------------------------------------------------------
// Recent Conversations Discovery
// ---------------------------------------------------------------------------

function extractCleanUserTitle(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') return '';
  const reqMatch = rawContent.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  const text = (reqMatch ? reqMatch[1] : rawContent)
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 44 ? `${text.slice(0, 44)}…` : text;
}

export function parseModelSettingFromText(text) {
  if (!text || typeof text !== 'string' || !/Model Selection/i.test(text)) return null;
  const re = /Model Selection[`"']?\s+from\s+[^\r\n]+?\s+to\s+([^\r\n<]+?)(?:\.(?=\s|$|<)|[;，。]|\r?\n|<|$)/gi;
  let lastPicked = null;
  for (const m of text.matchAll(re)) {
    const cleaned = m[1].trim().replace(/^[`"']+|[`"']+$/g, '').trim();
    if (!cleaned) continue;
    lastPicked = cleaned.toLowerCase() === 'none' ? null : cleaned;
  }
  return lastPicked;
}

function extractStepModel(step, gmEntry = null, fallbackRunningModel = '') {
  const gmModel = gmEntry?.chatModel?.modelDisplayName
    || gmEntry?.chatModel?.responseModel
    || gmEntry?.chatModel?.model
    || '';
  const stepModel = step?.chatModel?.modelDisplayName
    || step?.chatModel?.responseModel
    || step?.chatModel?.model
    || step?.modelDisplayName
    || step?.responseModel
    || step?.model
    || step?.modelId
    || '';
  return String(gmModel || stepModel || fallbackRunningModel || '').trim();
}

function extractStepUsage(step) {
  if (step?.input_tokens != null || step?.output_tokens != null || step?.cache_read_tokens != null) {
    const input = Number(step.input_tokens || 0);
    const cache = Number(step.cache_read_tokens || 0);
    const output = Number(step.output_tokens || 0);
    const thinking = Number(step.thinking_output_tokens || 0);
    return { input, cache, output, thinking, response: Math.max(0, output - thinking) };
  }
  const u = step?.chatModel?.usage || step?.usage;
  if (u && typeof u === 'object') {
    const input = Number(u.inputTokens ?? u.input_tokens ?? 0);
    const cache = Number(u.cacheReadTokens ?? u.cache_read_tokens ?? 0);
    const output = Number(u.outputTokens ?? u.output_tokens ?? 0);
    const thinking = Number(u.thinkingOutputTokens ?? u.thinking_output_tokens ?? 0);
    const response = Number(u.responseOutputTokens ?? u.response_output_tokens ?? Math.max(0, output - thinking));
    return { input, cache, output, thinking, response };
  }
  return { input: 0, cache: 0, output: 0, thinking: 0, response: 0 };
}

function isModelTurnStep(step) {
  const type = String(step?.type || '');
  if (type === 'USER_INPUT' || type === 'CHECKPOINT' || type === 'ERROR_MESSAGE' || step?.checkpoint) {
    return false;
  }
  if (type === 'PLANNER_RESPONSE') return true;
  const u = extractStepUsage(step);
  return (u.input + u.cache + u.output) > 0;
}

const annotationFileCache = new Map();
const convWorkspaceCache = new Map();
const scanSnapCache = new Map();

function readConversationAnnotationsMap() {
  const annDir = join(findAppDataDir(), 'annotations');
  const map = new Map();
  if (!existsSync(annDir)) return map;
  try {
    for (const f of readdirSync(annDir)) {
      if (!f.endsWith('.pbtxt')) continue;
      const id = f.slice(0, -6);
      if (!CONV_ID_RE.test(id)) continue;
      const p = join(annDir, f);
      try {
        const st = statSync(p);
        let cached = annotationFileCache.get(p);
        if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
          const raw = readFileSync(p, 'utf-8');
          const mView = raw.match(/last_user_view_time:\s*\{\s*seconds:\s*(\d+)(?:\s+nanos:\s*(\d+))?\s*\}/);
          let viewTimeMs = 0;
          if (mView) {
            viewTimeMs = Number(mView[1]) * 1000 + Math.round(Number(mView[2] || 0) / 1e6);
          }
          const mTitle = raw.match(/title:\s*"((?:[^"\\]|\\.)*)"/);
          const annTitle = mTitle ? mTitle[1].replace(/\\"/g, '"').trim() : '';
          cached = { mtimeMs: st.mtimeMs, size: st.size, viewTimeMs, annTitle };
          annotationFileCache.set(p, cached);
        }
        map.set(id, cached);
      } catch {}
    }
  } catch {}
  return map;
}

export function listRecentConversations(limit = 24, nowMs = Date.now()) {
  const annMap = readConversationAnnotationsMap();
  const roots = [
    { dir: join(findAppDataDir(), 'brain'), source: 'desktop' },
    { dir: join(findCliDataDir(), 'brain'), source: 'cli' }
  ];
  const entries = [];
  let maxMtimeMs = 0;
  for (const root of roots) {
    if (!existsSync(root.dir)) continue;
    try {
      for (const dirent of readdirSync(root.dir, { withFileTypes: true })) {
        if (!dirent.isDirectory() || !CONV_ID_RE.test(dirent.name)) continue;
        const stdLog = join(root.dir, dirent.name, '.system_generated', 'logs', 'transcript.jsonl');
        const directLog = join(root.dir, dirent.name, 'transcript.jsonl');
        const logPath = existsSync(stdLog) ? stdLog : (existsSync(directLog) ? directLog : '');
        if (!logPath) continue;
        try {
          const st = statSync(logPath);
          if (st.size <= 0) continue;
          if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
          const ann = annMap.get(dirent.name) || null;
          entries.push({
            id: dirent.name,
            source: root.source,
            rootDir: root.dir,
            logPath,
            mtimeMs: st.mtimeMs,
            size: st.size,
            viewTimeMs: ann?.viewTimeMs || 0,
            annMtimeMs: ann?.mtimeMs || 0,
            annTitle: ann?.annTitle || ''
          });
        } catch {}
      }
    } catch {}
  }
  if (maxMtimeMs > 0) {
    noteObservedTranscriptActivity(maxMtimeMs, nowMs);
  }

  entries.sort((a, b) => {
    const aEff = Math.max(a.viewTimeMs || 0, a.mtimeMs || 0);
    const bEff = Math.max(b.viewTimeMs || 0, b.mtimeMs || 0);
    if (bEff !== aEff) return bEff - aEff;
    return (b.mtimeMs || 0) - (a.mtimeMs || 0);
  });

  const enriched = [];
  let nonSubCount = 0;
  for (const item of entries) {
    const cacheKey = `${item.mtimeMs}:${item.size}`;
    let meta = recentConvMetaCache.get(item.logPath);
    if (!meta || meta.key !== cacheKey) {
      let title = '';
      let lastContextTokens = 0;
      let turnsCount = 0;
      let hasUserInput = false;
      let firstType = '';
      try {
        const raw = readFileSync(item.logPath, 'utf-8');
        const lines = raw.split(/\r?\n/);
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (!firstType && obj.type) firstType = obj.type;
            if (obj.type === 'USER_INPUT') {
              hasUserInput = true;
              if (!title && obj.content) {
                title = extractCleanUserTitle(obj.content);
              }
            }
            if (isModelTurnStep(obj)) {
              const u = extractStepUsage(obj);
              const tot = u.input + u.cache + u.output;
              if (tot > 0) {
                turnsCount++;
                lastContextTokens = tot;
              }
            }
          } catch {}
        }
      } catch {}
      const isSubagent = !hasUserInput && firstType === 'SYSTEM_MESSAGE' && !item.viewTimeMs;
      meta = { key: cacheKey, title, lastContextTokens, turnsCount, isSubagent };
      if (recentConvMetaCache.size > 2000) {
        const firstK = recentConvMetaCache.keys().next().value;
        if (firstK) recentConvMetaCache.delete(firstK);
      }
      recentConvMetaCache.set(item.logPath, meta);
    }

    const effectiveActiveMs = meta.isSubagent
      ? 0
      : Math.max(item.viewTimeMs || 0, item.mtimeMs || 0);

    enriched.push({
      id: item.id,
      shortId: item.id.slice(0, 8),
      source: item.source,
      title: meta.title || item.annTitle || `会话 ${item.id.slice(0, 8)}`,
      annTitle: item.annTitle || '',
      isSubagent: Boolean(meta.isSubagent),
      lastContextTokens: meta.lastContextTokens || 0,
      turnsCount: meta.turnsCount || 0,
      viewTimeMs: item.viewTimeMs || 0,
      annMtimeMs: item.annMtimeMs || 0,
      effectiveActiveMs,
      updatedAtMs: item.mtimeMs,
      updatedAt: new Date(item.mtimeMs).toISOString()
    });
    if (!meta.isSubagent) nonSubCount++;
    if (Number.isFinite(limit) && limit > 0 && nonSubCount >= limit) break;
  }

  enriched.sort((a, b) => {
    if (a.isSubagent !== b.isSubagent) return a.isSubagent ? 1 : -1;
    if (b.effectiveActiveMs !== a.effectiveActiveMs) return b.effectiveActiveMs - a.effectiveActiveMs;
    return b.updatedAtMs - a.updatedAtMs;
  });

  return enriched.slice(0, limit);
}

function resolveActiveConversationId(recentConversations) {
  if (!Array.isArray(recentConversations) || !recentConversations.length) return '';
  const hint = readActiveSessionHint();

  // 1. Explicit conversation lock chosen in `#conv-select`
  if (hint.pinnedConvId && recentConversations.some((c) => c.id === hint.pinnedConvId)) {
    return hint.pinnedConvId;
  }

  const topConvs = recentConversations.filter((c) => !c.isSubagent);
  const pool = topConvs.length ? topConvs : recentConversations;

  // 2. Host UI view-switch tracking (`annotations/<id>.pbtxt` `last_user_view_time`)
  //    Handles Antigravity's `BatchRecordUserLastUpdateTimes`, which writes the SAME
  //    timestamp to `{previousConv, newlyEnteredConv}` when the user switches tabs!
  let maxViewMs = 0;
  for (const c of pool) {
    if ((c.viewTimeMs || 0) > maxViewMs) maxViewMs = c.viewTimeMs;
  }

  let viewWinner = null;
  if (maxViewMs > 0) {
    const tied = pool.filter((c) => Math.abs((c.viewTimeMs || 0) - maxViewMs) <= 80);
    if (maxViewMs > (hint.lastBatchViewMs || 0)) {
      viewWinner = (tied.length > 1 && hint.resolvedConvId)
        ? (tied.find((c) => c.id !== hint.resolvedConvId) || tied[0])
        : tied[0];
      if (viewWinner) {
        updateActiveSessionHint({
          resolvedConvId: viewWinner.id,
          lastBatchViewMs: maxViewMs
        });
      }
    } else {
      viewWinner = tied.find((c) => c.id === hint.resolvedConvId) || tied[0];
    }
  }

  // 3. Compare most recent UI view switch vs explicit Aux Pane click vs latest new turn (e.g. agy CLI)
  const candidates = [];
  if (viewWinner) {
    candidates.push({ id: viewWinner.id, ts: maxViewMs });
  }
  if (hint.userFocusedConvId && hint.userFocusedAt > 0 && pool.some((c) => c.id === hint.userFocusedConvId)) {
    candidates.push({ id: hint.userFocusedConvId, ts: hint.userFocusedAt });
  }
  const newestTurnConv = [...pool].sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0];
  if (newestTurnConv) {
    candidates.push({ id: newestTurnConv.id, ts: newestTurnConv.updatedAtMs });
  }

  candidates.sort((a, b) => b.ts - a.ts);
  const chosenId = candidates[0]?.id || pool[0]?.id || '';
  if (chosenId && chosenId !== hint.resolvedConvId && (!maxViewMs || candidates[0]?.ts > maxViewMs)) {
    updateActiveSessionHint({ resolvedConvId: chosenId });
  }
  return chosenId;
}

// ---------------------------------------------------------------------------
// Active Conversation Context & Audit Scanner
// ---------------------------------------------------------------------------

async function fetchGeneratorMetadataForConv(convId, force = false, options = {}) {
  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS || '';
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN || '';
  const lsKey = (lsAddr && csrf) ? `${lsAddr}|${csrf}` : '';
  if (!lsKey) return null;

  const nowMs = Number(options.nowMs) || Date.now();
  const bypassMemTtl = Boolean(options.bypassMemTtl);
  const hasLogSig = options.logSize !== undefined && options.logMtimeMs !== undefined;
  const lsDiskHash = hashLsAddr(lsAddr);
  const cached = convGenMetaCache.get(convId);
  const cachedMatchesLogSig = !hasLogSig || (
    cached?.logSize === options.logSize &&
    cached?.logMtimeMs === options.logMtimeMs
  );
  if (!force && !bypassMemTtl && cached && cached.lsKey === lsKey && cachedMatchesLogSig && (nowMs - cached.at) < 15_000) {
    return cached;
  }

  const cachedDiskHash = cached?.lsKey ? hashLsAddr(cached.lsKey.split('|')[0] || '') : '';
  const hasMemBase = Boolean(
    cached &&
    lsDiskHash &&
    cachedDiskHash === lsDiskHash &&
    cachedMatchesLogSig &&
    Array.isArray(cached.generatorList) &&
    cached.generatorList.length > 0
  );
  const resolveBaseList = () => {
    if (hasMemBase) return cached.generatorList;
    if (hasLogSig && lsDiskHash) {
      const diskCache = loadActiveConvGenDiskCache();
      const diskEntry = diskCache?.convs?.[convId];
      if (
        diskEntry &&
        diskEntry.lsKeyHash === lsDiskHash &&
        diskEntry.size === options.logSize &&
        diskEntry.mtimeMs === options.logMtimeMs &&
        Array.isArray(diskEntry.generatorList) &&
        diskEntry.generatorList.length > 0
      ) {
        return diskEntry.generatorList;
      }
    }
    return [];
  };

  const flightKey = `${lsKey}|${convId}|${hasLogSig ? `${options.logSize}:${options.logMtimeMs}` : ''}`;
  const canCoalesce = !force && !options.signal && !bypassMemTtl;
  if (canCoalesce && inFlightGenMeta.has(flightKey)) {
    return inFlightGenMeta.get(flightKey);
  }

  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 4500;
  const run = (async () => {
    const res = await callLanguageServer(
      'GetCascadeTrajectoryGeneratorMetadata',
      {
        cascadeId: convId,
        generatorMetadataOffset: 0,
        includeMessages: false
      },
      timeoutMs,
      {
        signal: options.signal || null,
        unrefSocket: Boolean(options.unrefSocket)
      }
    );
    const baseList = resolveBaseList();
    if (res === null) {
      if (baseList.length > 0) {
        return {
          at: nowMs,
          lsKey,
          generatorList: baseList,
          callsByStep: buildCallsByStepFromList(baseList),
          ...(hasLogSig ? { logSize: options.logSize, logMtimeMs: options.logMtimeMs } : {}),
          fromFallbackCache: true,
          rpcFailed: true
        };
      }
      return { at: nowMs, lsKey, generatorList: [], callsByStep: new Map(), rpcFailed: true };
    }
    if (!Array.isArray(res.generatorMetadata) || res.generatorMetadata.length === 0) {
      if (baseList.length > 0) {
        const callsByStep = buildCallsByStepFromList(baseList);
        const value = {
          at: nowMs,
          lsKey,
          generatorList: baseList,
          callsByStep,
          ...(hasLogSig ? { logSize: options.logSize, logMtimeMs: options.logMtimeMs } : {})
        };
        if (callsByStep.size > 0) {
          convGenMetaCache.set(convId, value);
        }
        return { ...value, fromFallbackCache: true, rpcFailed: false };
      }
      return { at: nowMs, lsKey, generatorList: [], callsByStep: new Map(), emptyFromHost: true, rpcFailed: false };
    }

    const generatorList = mergeGeneratorMetadataLists(baseList, res.generatorMetadata);
    const callsByStep = buildCallsByStepFromList(generatorList);
    const value = {
      at: nowMs,
      lsKey,
      generatorList,
      callsByStep,
      ...(hasLogSig ? { logSize: options.logSize, logMtimeMs: options.logMtimeMs } : {})
    };
    if (callsByStep.size > 0) {
      convGenMetaCache.set(convId, value);
    }
    return { ...value, rpcFailed: false };
  })();

  if (canCoalesce) {
    inFlightGenMeta.set(flightKey, run);
  }
  try {
    return await run;
  } finally {
    if (inFlightGenMeta.get(flightKey) === run) {
      inFlightGenMeta.delete(flightKey);
    }
  }
}

function getActiveConvGenCachePath() {
  return join(getPluginStateDir(), 'active_conv_gen_cache_v1.json');
}

function slimGeneratorListForCache(generatorList = [], keepBreakdownEntry = undefined) {
  if (!Array.isArray(generatorList) || !generatorList.length) return [];
  const targetEntry = keepBreakdownEntry !== undefined
    ? keepBreakdownEntry
    : generatorList[generatorList.length - 1];
  return generatorList.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const cm = entry.chatModel && typeof entry.chatModel === 'object' ? entry.chatModel : null;
    if (!cm) {
      return {
        ...(entry.stepIndices ? { stepIndices: entry.stepIndices } : {}),
        ...(entry.stepIndex != null ? { stepIndex: entry.stepIndex } : {}),
        ...(entry.model ? { model: entry.model } : {}),
        ...(entry.modelDisplayName ? { modelDisplayName: entry.modelDisplayName } : {}),
        ...(entry.responseModel ? { responseModel: entry.responseModel } : {})
      };
    }
    const ctxMeta = cm.chatStartMetadata?.contextWindowMetadata;
    const keepBreakdown = Boolean(targetEntry && entry === targetEntry && ctxMeta?.tokenBreakdown);
    const slimCtxMeta = ctxMeta ? {
      maxContextTokens: ctxMeta.maxContextTokens,
      estimatedTokensUsed: ctxMeta.estimatedTokensUsed,
      totalTokens: ctxMeta.totalTokens,
      ...(keepBreakdown ? { tokenBreakdown: ctxMeta.tokenBreakdown } : {})
    } : undefined;
    const slimRetryInfos = Array.isArray(cm.retryInfos)
      ? cm.retryInfos.map((r) => (r && typeof r === 'object' ? {
          ...(r.usage ? { usage: r.usage } : {}),
          ...(r.error ? { error: sanitizeDiagnosticText(String(r.error), 240) } : {})
        } : r))
      : undefined;
    return {
      ...(entry.stepIndices ? { stepIndices: entry.stepIndices } : {}),
      ...(entry.stepIndex != null ? { stepIndex: entry.stepIndex } : {}),
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.modelDisplayName ? { modelDisplayName: entry.modelDisplayName } : {}),
      ...(entry.responseModel ? { responseModel: entry.responseModel } : {}),
      chatModel: {
        ...(cm.model ? { model: cm.model } : {}),
        ...(cm.modelDisplayName ? { modelDisplayName: cm.modelDisplayName } : {}),
        ...(cm.responseModel ? { responseModel: cm.responseModel } : {}),
        ...(cm.usage ? { usage: cm.usage } : {}),
        ...(cm.timeToFirstToken !== undefined ? { timeToFirstToken: cm.timeToFirstToken } : {}),
        ...(cm.streamingDuration !== undefined ? { streamingDuration: cm.streamingDuration } : {}),
        ...(cm.error ? { error: sanitizeDiagnosticText(String(cm.error), 240) } : {}),
        ...(slimRetryInfos ? { retryInfos: slimRetryInfos } : {}),
        ...(slimCtxMeta ? { chatStartMetadata: { contextWindowMetadata: slimCtxMeta } } : {})
      }
    };
  });
}

function getGenStepServerUsage(entry) {
  const cm = entry?.chatModel;
  if (!cm || typeof cm !== 'object') return null;
  const lastRetry = Array.isArray(cm.retryInfos) && cm.retryInfos.length
    ? cm.retryInfos[cm.retryInfos.length - 1]
    : null;
  return lastRetry?.usage || cm.usage || null;
}

function getGenStepServerError(entry) {
  const cm = entry?.chatModel;
  if (!cm || typeof cm !== 'object') return '';
  const lastRetry = Array.isArray(cm.retryInfos) && cm.retryInfos.length
    ? cm.retryInfos[cm.retryInfos.length - 1]
    : null;
  return String(lastRetry?.error || cm.error || '');
}

function hasValidGenStepEntry(entry) {
  return Boolean(entry && (
    extractStepModel(null, entry, '') ||
    entry?.chatModel?.usage ||
    entry?.chatModel?.chatStartMetadata?.contextWindowMetadata
  ));
}

function hasCompleteGenStepMetrics(entry, sMeta = null) {
  if (!entry || typeof entry !== 'object') return false;
  const errText = getGenStepServerError(entry);
  if (errText || sMeta?.isError) {
    return hasValidGenStepEntry(entry) || Boolean(errText);
  }
  const hasModel = Boolean(extractStepModel(null, entry, ''));
  const usage = getGenStepServerUsage(entry);
  const srvTotal = usage
    ? (Number(usage.inputTokens || 0) + Number(usage.cacheReadTokens || 0) + Number(usage.outputTokens || 0))
    : 0;
  return hasModel && srvTotal > 0;
}

function isGenListFullySettled(generatorList = [], stepMetaMap = null) {
  if (!Array.isArray(generatorList)) return true;
  for (const entry of generatorList) {
    if (!entry || typeof entry !== 'object') continue;
    const stepNums = getGenEntryStepNums(entry);
    const sMeta = stepNums.length && stepMetaMap ? stepMetaMap.get(stepNums[0]) : null;
    if (!hasCompleteGenStepMetrics(entry, sMeta)) return false;
  }
  return true;
}

function shouldReplaceGenStepEntry(prevEntry, nextEntry) {
  if (!prevEntry) return true;
  const prevComplete = hasCompleteGenStepMetrics(prevEntry);
  const nextComplete = hasCompleteGenStepMetrics(nextEntry);
  if (nextComplete && !prevComplete) return true;
  if (!nextComplete && prevComplete) return false;
  return Boolean(extractStepModel(null, nextEntry, ''));
}

function estimateStepDuration(rawSteps, arrayIdx, logMtimeMs) {
  if (!Array.isArray(rawSteps) || arrayIdx < 0 || arrayIdx >= rawSteps.length) return null;
  const s = rawSteps[arrayIdx];
  const startMs = s?.created_at ? Date.parse(s.created_at) : NaN;
  const nextStep = rawSteps[arrayIdx + 1];
  const endMs = nextStep?.created_at
    ? Date.parse(nextStep.created_at)
    : (arrayIdx === rawSteps.length - 1 && logMtimeMs > startMs ? logMtimeMs : NaN);
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs && (endMs - startMs) < 300_000) {
    return Number(((endMs - startMs) / 1000).toFixed(2));
  }
  return null;
}

function getGenEntryStepNums(entry) {
  if (!entry || typeof entry !== 'object') return [];
  const raw = Array.isArray(entry.stepIndices) && entry.stepIndices.length
    ? entry.stepIndices
    : (entry.stepIndex != null ? [entry.stepIndex] : []);
  const out = [];
  const seen = new Set();
  for (const idx of raw) {
    const n = Number(idx);
    if (!Number.isFinite(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function withNarrowedGenStepIndices(entry, steps) {
  if (!entry || typeof entry !== 'object' || !Array.isArray(steps) || !steps.length) return entry;
  const copy = { ...entry };
  if (Array.isArray(entry.stepIndices) || entry.stepIndex == null || steps.length > 1) {
    copy.stepIndices = [...steps];
    if (entry.stepIndex != null) copy.stepIndex = steps[0];
  } else {
    copy.stepIndex = steps[0];
  }
  return copy;
}

function mergeSingleGenEntry(prevEntry, nextEntry) {
  if (!prevEntry || !nextEntry || typeof prevEntry !== 'object' || typeof nextEntry !== 'object') {
    return nextEntry;
  }
  const prevModel = extractStepModel(null, prevEntry, '');
  const nextModel = extractStepModel(null, nextEntry, '');
  const prevCtxMeta = prevEntry.chatModel?.chatStartMetadata?.contextWindowMetadata;
  const nextCtxMeta = nextEntry.chatModel?.chatStartMetadata?.contextWindowMetadata;
  if (prevModel && nextModel && prevModel === nextModel && prevCtxMeta && nextEntry.chatModel) {
    if (!nextCtxMeta) {
      return {
        ...nextEntry,
        chatModel: {
          ...nextEntry.chatModel,
          chatStartMetadata: {
            ...(nextEntry.chatModel.chatStartMetadata || {}),
            contextWindowMetadata: prevCtxMeta
          }
        }
      };
    }
    if (prevCtxMeta.tokenBreakdown && !nextCtxMeta.tokenBreakdown) {
      return {
        ...nextEntry,
        chatModel: {
          ...nextEntry.chatModel,
          chatStartMetadata: {
            ...(nextEntry.chatModel.chatStartMetadata || {}),
            contextWindowMetadata: {
              ...nextCtxMeta,
              tokenBreakdown: prevCtxMeta.tokenBreakdown
            }
          }
        }
      };
    }
  }
  return nextEntry;
}

function buildCallsByStepFromList(generatorList = []) {
  const callsByStep = new Map();
  if (!Array.isArray(generatorList)) return callsByStep;
  for (const entry of generatorList) {
    if (!entry || typeof entry !== 'object') continue;
    for (const stepNum of getGenEntryStepNums(entry)) {
      if (shouldReplaceGenStepEntry(callsByStep.get(stepNum), entry)) {
        callsByStep.set(stepNum, entry);
      }
    }
  }
  return callsByStep;
}

function computeChronoSortKey(minArrayIdx, minStepIdx, orderSeq, stepArrayIdxByStepNum = null) {
  if (minArrayIdx >= 0) {
    return { primary: minArrayIdx, secondary: 0, seq: orderSeq };
  }
  if (Number.isFinite(minStepIdx)) {
    let predStep = -Infinity;
    let predArr = -1;
    let succStep = Infinity;
    let succArr = -1;
    if (stepArrayIdxByStepNum instanceof Map) {
      for (const [sNum, arrIdx] of stepArrayIdxByStepNum.entries()) {
        if (sNum <= minStepIdx && sNum > predStep) {
          predStep = sNum;
          predArr = arrIdx;
        }
        if (sNum > minStepIdx && sNum < succStep) {
          succStep = sNum;
          succArr = arrIdx;
        }
      }
    }
    let primary = 0;
    if (predArr >= 0 && succArr >= 0) {
      primary = (predArr + succArr) / 2;
    } else if (predArr >= 0) {
      primary = predArr + 0.5;
    } else if (succArr >= 0) {
      primary = succArr - 0.5;
    }
    return { primary, secondary: minStepIdx, seq: orderSeq };
  }
  return { primary: Number.MAX_SAFE_INTEGER, secondary: orderSeq, seq: orderSeq };
}

function compareChronoSortKeys(a, b) {
  return a.primary - b.primary || a.secondary - b.secondary || a.seq - b.seq;
}

function orderGeneratorListChronologically(generatorList = [], stepArrayIdxByStepNum = null, stepMetaMap = null) {
  const valid = Array.isArray(generatorList) ? generatorList.filter((e) => e && typeof e === 'object') : [];
  if (valid.length <= 1) return valid.slice();
  return valid
    .map((entry, idx) => {
      const numericSteps = getGenEntryStepNums(entry);
      let minMatchedArrayIdx = -1;
      for (const n of numericSteps) {
        const matchedArr = stepArrayIdxByStepNum?.has(n)
          ? stepArrayIdxByStepNum.get(n)
          : (stepMetaMap?.get(n)?.arrayIdx ?? -1);
        if (matchedArr >= 0 && (minMatchedArrayIdx < 0 || matchedArr < minMatchedArrayIdx)) {
          minMatchedArrayIdx = matchedArr;
        }
      }
      const minStepIdx = numericSteps.length ? Math.min(...numericSteps) : null;
      return {
        entry,
        key: computeChronoSortKey(minMatchedArrayIdx, minStepIdx, idx, stepArrayIdxByStepNum)
      };
    })
    .sort((a, b) => compareChronoSortKeys(a.key, b.key))
    .map((item) => item.entry);
}

function mergeGeneratorMetadataLists(baseList = [], incomingList = []) {
  const base = Array.isArray(baseList) ? baseList.filter((e) => e && typeof e === 'object') : [];
  const incoming = Array.isArray(incomingList) ? incomingList.filter((e) => e && typeof e === 'object') : [];
  if (!base.length) return orderGeneratorListChronologically(incoming);
  if (!incoming.length) return orderGeneratorListChronologically(base);

  const baseByStep = buildCallsByStepFromList(base);
  const accepted = [];
  const coveredSteps = new Set();
  let seq = 0;

  for (const entry of incoming) {
    const steps = getGenEntryStepNums(entry);
    if (!steps.length) {
      accepted.push({ entry, minStep: Number.MAX_SAFE_INTEGER, seq: seq++ });
      continue;
    }
    const keptSteps = steps.filter((s) => shouldReplaceGenStepEntry(baseByStep.get(s), entry));
    if (!keptSteps.length) continue;
    const prevSample = keptSteps.map((s) => baseByStep.get(s)).find(Boolean);
    let mergedEntry = prevSample ? mergeSingleGenEntry(prevSample, entry) : entry;
    if (keptSteps.length < steps.length) {
      mergedEntry = withNarrowedGenStepIndices(mergedEntry, keptSteps);
    }
    for (const s of keptSteps) coveredSteps.add(s);
    accepted.push({ entry: mergedEntry, minStep: Math.min(...keptSteps), seq: seq++ });
  }

  for (const baseEntry of base) {
    const bSteps = getGenEntryStepNums(baseEntry);
    if (!bSteps.length) continue;
    const uncovered = bSteps.filter((s) => !coveredSteps.has(s));
    if (!uncovered.length) continue;
    const keptBase = uncovered.length < bSteps.length
      ? withNarrowedGenStepIndices(baseEntry, uncovered)
      : baseEntry;
    for (const s of uncovered) coveredSteps.add(s);
    accepted.push({ entry: keptBase, minStep: Math.min(...uncovered), seq: seq++ });
  }

  accepted.sort((a, b) => a.minStep - b.minStep || a.seq - b.seq);
  return accepted.map((item) => item.entry);
}

function getMaxGenStepIdx(generatorList = []) {
  let maxIdx = -1;
  if (!Array.isArray(generatorList)) return maxIdx;
  for (const entry of generatorList) {
    for (const n of getGenEntryStepNums(entry)) {
      if (n > maxIdx) maxIdx = n;
    }
  }
  return maxIdx;
}

function loadActiveConvGenDiskCache(targetPath = getActiveConvGenCachePath()) {
  const p = targetPath || getActiveConvGenCachePath();
  let st = null;
  try {
    if (existsSync(p)) st = statSync(p);
  } catch {}
  const stMtime = st ? st.mtimeMs : -1;
  const stSize = st ? st.size : -1;
  if (
    activeConvGenDiskCache.path === p &&
    activeConvGenDiskCache.mtimeMs === stMtime &&
    activeConvGenDiskCache.size === stSize &&
    activeConvGenDiskCache.data
  ) {
    return activeConvGenDiskCache.data;
  }
  const raw = readJsonSafe(p, null);
  const convs = {};
  if (raw?.version === ACTIVE_CONV_GEN_DISK_CACHE_VERSION && raw.convs && typeof raw.convs === 'object') {
    for (const [cid, v] of Object.entries(raw.convs)) {
      if (CONV_ID_RE.test(cid) && v && typeof v === 'object') {
        convs[cid] = v;
      }
    }
  }
  const data = { version: ACTIVE_CONV_GEN_DISK_CACHE_VERSION, convs };
  activeConvGenDiskCache = { path: p, mtimeMs: stMtime, size: stSize, data };
  return data;
}

function saveActiveConvGenDiskEntry(convId, entry, targetPath = getActiveConvGenCachePath()) {
  if (!convId || !CONV_ID_RE.test(convId) || !entry) return;
  try {
    const data = loadActiveConvGenDiskCache(targetPath);
    const nextConvs = { ...data.convs, [convId]: entry };
    const sorted = Object.entries(nextConvs)
      .sort((a, b) => Number(b[1]?.fetchedAt || 0) - Number(a[1]?.fetchedAt || 0))
      .slice(0, ACTIVE_CONV_GEN_CACHE_MAX_CONVS);
    const payload = {
      version: ACTIVE_CONV_GEN_DISK_CACHE_VERSION,
      convs: Object.fromEntries(sorted)
    };
    writeJsonAtomic(targetPath, payload);
    const st = statSync(targetPath);
    activeConvGenDiskCache = { path: targetPath, mtimeMs: st.mtimeMs, size: st.size, data: payload };
  } catch {}
}

function extractContextBreakdown(contextWindowMetadata) {
  const groups = contextWindowMetadata?.tokenBreakdown?.groups;
  if (!Array.isArray(groups) || !groups.length) return null;
  const total = Number(contextWindowMetadata.totalTokens || contextWindowMetadata.estimatedTokensUsed || 0);
  const parsedGroups = groups.map((g) => {
    const numTokens = Number(g.numTokens || 0);
    const children = Array.isArray(g.children)
      ? g.children
          .map((c) => ({ name: String(c.name || ''), tokens: Number(c.numTokens || 0) }))
          .filter((c) => c.tokens > 0)
          .sort((a, b) => b.tokens - a.tokens)
      : [];
    const labelMap = {
      'System Prompt': '系统提示与规则',
      Tools: '工具定义 Schema',
      'Chat Messages': '对话与工具历史'
    };
    const slicedChildren = g.name === 'Chat Messages' ? children.slice(0, 8) : children.slice(0, 18);
    return {
      key: g.type || g.name || 'group',
      name: g.name || '未命名分组',
      label: labelMap[g.name] || g.name || '上下文分组',
      tokens: numTokens,
      percent: total > 0 ? Number(((numTokens / total) * 100).toFixed(1)) : 0,
      children: slicedChildren,
      topChildren: slicedChildren,
      childrenCount: children.length
    };
  });
  return {
    totalTokens: total,
    maxContextTokens: Number(contextWindowMetadata.maxContextTokens || 0) || null,
    groups: parsedGroups
  };
}

export async function scanConversation(requestedConvId = '', options = {}) {
  const force = Boolean(options.force);
  const nowMs = Number(options.nowMs) || Date.now();
  const background = Boolean(options.background);
  const menubarMode = String(options.menubarMode || 'context');
  const stateDir = getPluginStateDir();
  const agDir = findAppDataDir();
  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS || '';
  const lsCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN || '';
  const hasLsConfig = Boolean(lsAddr && lsCsrf);
  const lsKey = hasLsConfig ? `${lsAddr}|${lsCsrf}` : '';
  const lsMemHash = hashLsKey(lsKey);
  const lsDiskHash = hasLsConfig ? hashLsAddr(lsAddr) : '';
  if (force) {
    fileAuditCache.clear();
    scanSnapCache.clear();
  }

  const recentConversations = listRecentConversations(24, nowMs);
  const convId = (requestedConvId && CONV_ID_RE.test(requestedConvId))
    ? requestedConvId
    : resolveActiveConversationId(recentConversations);

  if (!convId) {
    return {
      ok: true,
      conversationId: null,
      recentConversations: [],
      empty: true,
      etag: 'empty'
    };
  }

  const desktopLogsDir = join(agDir, 'brain', convId, '.system_generated', 'logs');
  const cliLogsDir = join(findCliDataDir(), 'brain', convId, '.system_generated', 'logs');
  const cliDirectLog = join(findCliDataDir(), 'brain', convId, 'transcript.jsonl');
  const brainBase = existsSync(desktopLogsDir) ? desktopLogsDir : cliLogsDir;
  const fullPath = join(brainBase, 'transcript_full.jsonl');
  const compactPath = join(brainBase, 'transcript.jsonl');
  const targetLogPath = (existsSync(fullPath) && statSync(fullPath).size <= 32 * 1024 * 1024)
    ? fullPath
    : (existsSync(compactPath) ? compactPath : cliDirectLog);

  let logStatMtime = 0;
  let logStatSize = 0;
  if (existsSync(targetLogPath)) {
    try {
      const st = statSync(targetLogPath);
      logStatMtime = st.mtimeMs;
      logStatSize = st.size;
    } catch {}
  }
  if (logStatMtime > 0) {
    noteObservedTranscriptActivity(logStatMtime, nowMs);
  }

  const host = await getHostUserStatus(force, {
    background,
    menubarMode,
    nowMs,
    latestTranscriptMtimeMs: logStatMtime
  });

  const baseSnapKey = `${convId}|${logStatMtime}|${logStatSize}|${host.sig}|${lsMemHash}|${agDir}|${stateDir}`;
  const prevHit = scanSnapCache.get(convId);
  const sameBaseKey = Boolean(prevHit && prevHit.baseKey === baseSnapKey);
  if (!force && sameBaseKey) {
    if (prevHit.metaSettled || !hasLsConfig || nowMs < (prevHit.nextMetaCheckAt || 0)) {
      return {
        ...prevHit.snap,
        recentConversations
      };
    }
  }

  // Parse transcript steps BEFORE deciding whether Language Server GeneratorMetadata RPC is needed
  const groups = {
    user: emptyMeasure(),
    assistant: emptyMeasure(),
    thinking: emptyMeasure(),
    tools: emptyMeasure(),
    summaries: emptyMeasure(),
    system: emptyMeasure(),
    definitions: emptyMeasure()
  };
  const mediaMap = new Map();
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCallsCount = 0;
  let totalSteps = 0;
  let activeSettingModel = '';
  let lastSettingStepIdx = -1;
  let latestStepError = null;
  let conversationTitle = '';
  let logMtimeMs = 0;

  const rawSteps = [];
  if (existsSync(targetLogPath)) {
    const st = statSync(targetLogPath);
    logMtimeMs = st.mtimeMs;
    const lines = readFileSync(targetLogPath, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        rawSteps.push(JSON.parse(line));
      } catch {}
    }
  }

  totalSteps = rawSteps.length;
  const stepMetaMap = new Map();
  const stepArrayIdxByStepNum = new Map();
  const requiredModelSteps = [];
  let latestErrorStepIdx = -1;
  let lastTranscriptPlannerArrayIdx = -1;

  const summarizeToolNames = (toolCalls) => {
    if (!Array.isArray(toolCalls) || !toolCalls.length) return [];
    const counts = new Map();
    for (const tc of toolCalls) {
      const rawName = String(tc?.name || tc?.tool_name || tc?.function?.name || 'tool').trim();
      const shortName = rawName.replace(/^default_api:/, '');
      counts.set(shortName, (counts.get(shortName) || 0) + 1);
    }
    return [...counts.entries()].slice(0, 6).map(([name, cnt]) => (cnt > 1 ? `${name} ×${cnt}` : name));
  };

  for (let i = 0; i < rawSteps.length; i++) {
    const step = rawSteps[i];
    const sIdx = Number(step.step_index ?? i);
    if (Number.isFinite(sIdx) && !stepArrayIdxByStepNum.has(sIdx)) {
      stepArrayIdxByStepNum.set(sIdx, i);
    }
    const type = step.type || '';
    const contentStr = typeof step.content === 'string' ? step.content : '';

    if (type === 'USER_INPUT') {
      userMessages++;
      if (!conversationTitle && contentStr) {
        conversationTitle = extractCleanUserTitle(contentStr);
      }
      const switchedModel = parseModelSettingFromText(contentStr);
      if (switchedModel) {
        activeSettingModel = switchedModel;
        lastSettingStepIdx = sIdx;
      }
      addMeasure(groups.user, measureText(contentStr));
    } else if (isModelTurnStep(step)) {
      assistantMessages++;
      requiredModelSteps.push(sIdx);
      addMeasure(groups.assistant, measureText(contentStr));
      if (step.thinking) addMeasure(groups.thinking, measureText(step.thinking));
      const toolBadges = summarizeToolNames(step.tool_calls);
      if (Array.isArray(step.tool_calls) && step.tool_calls.length) {
        toolCallsCount += step.tool_calls.length;
        addMeasure(groups.tools, measureText(JSON.stringify(step.tool_calls)));
      }
      const stepUsage = extractStepUsage(step);
      stepMetaMap.set(sIdx, {
        arrayIdx: i,
        createdAt: step.created_at || '',
        tools: toolBadges,
        stepModel: extractStepModel(step, null, ''),
        runningSettingModel: activeSettingModel,
        stepUsage,
        isError: step.status === 'ERROR'
      });
      if ((stepUsage.input || stepUsage.cache || stepUsage.output) && step.status !== 'ERROR') {
        lastTranscriptPlannerArrayIdx = i;
      }
      if (step.status === 'ERROR') {
        latestErrorStepIdx = Math.max(latestErrorStepIdx, sIdx);
        if (contentStr) {
          latestStepError = { stepIndex: sIdx, text: contentStr };
        }
      }
    } else if (type === 'CHECKPOINT' || step.checkpoint) {
      addMeasure(groups.summaries, measureText(contentStr || step.checkpoint?.sessionSummary || ''));
    } else if (type === 'ERROR_MESSAGE' || step.status === 'ERROR') {
      latestErrorStepIdx = Math.max(latestErrorStepIdx, sIdx);
      if (contentStr) latestStepError = { stepIndex: sIdx, text: contentStr };
      addMeasure(groups.tools, measureText(contentStr));
    } else {
      addMeasure(groups.tools, measureText(contentStr));
    }

    if (Array.isArray(step.media)) {
      const mediaSource = type === 'USER_INPUT' ? 'user' : 'assistant';
      for (const m of step.media) {
        if (!m || (!m.uri && !m.inline_data && !m.inlineData)) continue;
        const uriKey = String(m.uri || `inline-${mediaMap.size}`);
        const prev = mediaMap.get(uriKey);
        if (prev) {
          prev.references++;
        } else {
          mediaMap.set(uriKey, {
            uri: uriKey,
            inlineData: m.inline_data || m.inlineData || null,
            mime: m.mime_type || m.mimeType || '',
            name: m.description || uriKey.split(/[\\/]/).pop() || '附件',
            references: 1,
            source: mediaSource
          });
        }
      }
    }
  }

  const ageMs = logStatMtime > 0 ? Math.max(0, nowMs - logStatMtime) : 0;
  const isRetryCheck = Boolean(!force && sameBaseKey && !prevHit?.metaSettled);
  const prevRetryCount = sameBaseKey ? Number(prevHit?.retryCount || 0) : 0;
  let genMetaBundle = null;
  let genFromCache = false;
  if (!force && hasLsConfig && !isRetryCheck) {
    const memGen = convGenMetaCache.get(convId);
    const memCovers = Boolean(
      memGen &&
      memGen.lsKey === lsKey &&
      memGen.logSize === logStatSize &&
      memGen.logMtimeMs === logStatMtime &&
      memGen.generatorList?.length &&
      requiredModelSteps.every((stepNum) => hasCompleteGenStepMetrics(memGen.callsByStep?.get(stepNum), stepMetaMap.get(stepNum))) &&
      isGenListFullySettled(memGen.generatorList, stepMetaMap) &&
      (latestErrorStepIdx < 0 || getMaxGenStepIdx(memGen.generatorList) >= latestErrorStepIdx)
    );
    if (memCovers) {
      genMetaBundle = { ...memGen, rpcFailed: false, fromMemCache: true };
      genFromCache = true;
    } else {
      const diskCache = loadActiveConvGenDiskCache();
      const diskEntry = diskCache?.convs?.[convId];
      if (
        diskEntry &&
        lsDiskHash &&
        diskEntry.lsKeyHash === lsDiskHash &&
        diskEntry.size === logStatSize &&
        diskEntry.mtimeMs === logStatMtime &&
        diskEntry.settled === true
      ) {
        const diskList = Array.isArray(diskEntry.generatorList) ? diskEntry.generatorList : [];
        const callsByStep = buildCallsByStepFromList(diskList);
        const diskAllRequiredCovered = requiredModelSteps.every((stepNum) => (
          hasCompleteGenStepMetrics(callsByStep.get(stepNum), stepMetaMap.get(stepNum))
        )) && isGenListFullySettled(diskList, stepMetaMap);
        const diskMaxGenStepIdx = getMaxGenStepIdx(diskList);
        const diskErrorCovered = (
          latestErrorStepIdx < 0 ||
          diskMaxGenStepIdx >= latestErrorStepIdx ||
          Boolean(diskList.some((e) => Boolean(getGenStepServerError(e))))
        );
        const diskSettledValid = Boolean(
          (diskAllRequiredCovered && diskErrorCovered && (requiredModelSteps.length > 0 || latestErrorStepIdx >= 0 || ageMs >= 10_000)) ||
          ageMs >= CONV_META_SETTLE_AGE_MS
        );
        if (diskSettledValid) {
          if (callsByStep.size > 0) {
            convGenMetaCache.set(convId, {
              at: Number(diskEntry.fetchedAt || nowMs),
              lsKey,
              logSize: diskEntry.size,
              logMtimeMs: diskEntry.mtimeMs,
              generatorList: diskList,
              callsByStep
            });
          }
          genMetaBundle = {
            at: Number(diskEntry.fetchedAt || nowMs),
            lsKey,
            logSize: diskEntry.size,
            logMtimeMs: diskEntry.mtimeMs,
            generatorList: diskList,
            callsByStep,
            emptyFromHost: Boolean(diskEntry.empty),
            rpcFailed: false,
            fromDiskCache: true
          };
          genFromCache = true;
        }
      }
    }
  }

  if (!genFromCache && hasLsConfig && (rawSteps.length > 0 || force)) {
    genMetaBundle = await fetchGeneratorMetadataForConv(convId, force, {
      bypassMemTtl: isRetryCheck,
      nowMs,
      logSize: logStatSize,
      logMtimeMs: logStatMtime
    });
  }

  const rawBundleList = Array.isArray(genMetaBundle?.generatorList) ? genMetaBundle.generatorList : [];
  const bundleList = orderGeneratorListChronologically(rawBundleList, stepArrayIdxByStepNum, stepMetaMap);
  const bundleCallsByStep = buildCallsByStepFromList(bundleList);
  const maxGenStepIdx = getMaxGenStepIdx(bundleList);
  const genRpcSucceeded = Boolean(genMetaBundle && !genMetaBundle.rpcFailed);
  const allRequiredCovered = requiredModelSteps.every((stepNum) => (
    hasCompleteGenStepMetrics(bundleCallsByStep.get(stepNum), stepMetaMap.get(stepNum))
  )) && isGenListFullySettled(bundleList, stepMetaMap);
  const errorCovered = (
    latestErrorStepIdx < 0 ||
    maxGenStepIdx >= latestErrorStepIdx ||
    Boolean(bundleList.some((e) => Boolean(getGenStepServerError(e))))
  );
  const diskSettledEligible = Boolean(
    genRpcSucceeded && (
      (allRequiredCovered && errorCovered && (requiredModelSteps.length > 0 || latestErrorStepIdx >= 0 || ageMs >= 10_000)) ||
      ageMs >= CONV_META_SETTLE_AGE_MS
    )
  );
  const nextRetryCount = isRetryCheck ? (prevRetryCount + 1) : (sameBaseKey ? prevRetryCount : 0);
  let metaSettled = false;
  let nextMetaCheckAt = 0;

  if (!hasLsConfig || !rawSteps.length) {
    metaSettled = true;
  } else if (genMetaBundle?.fromDiskCache) {
    metaSettled = true;
  } else if (diskSettledEligible) {
    metaSettled = true;
  } else if (nextRetryCount >= CONV_META_RETRY_DELAYS_MS.length) {
    metaSettled = true;
  } else {
    metaSettled = false;
    const delayMs = CONV_META_RETRY_DELAYS_MS[Math.min(nextRetryCount, CONV_META_RETRY_DELAYS_MS.length - 1)];
    nextMetaCheckAt = nowMs + delayMs;
  }

  // Build turn-by-turn metrics combining GeneratorMetadata + Transcript steps
  const turnCandidates = [];
  let sessionCostUSD = 0;
  let turnCandidateSeq = 0;

  const appendFallbackTurnFromTranscriptStep = (s, arrayIdx, fallbackModel) => {
    const { input, cache, output, thinking, response: responseTokens } = extractStepUsage(s);
    const total = input + cache + output;
    if (total <= 0) return;

    const duration = estimateStepDuration(rawSteps, arrayIdx, logMtimeMs);
    const tps = output > 0 && duration && duration > 0.1 ? Number((output / duration).toFixed(1)) : null;
    const rawModel = extractStepModel(s, null, fallbackModel);
    const modelKey = normalizeModelId(rawModel, host.dynamicModelMap);
    const displayModel = rawModel ? formatModelDisplayName(rawModel, modelKey) : '';
    const costInfo = calculateRequestApiCost(
      {
        model: rawModel,
        modelKey,
        inputTokens: input,
        cacheTokens: cache,
        outputTokens: output,
        thinkingTokens: thinking,
        date: s.created_at
      },
      host.dynamicModelMap
    );
    if (costInfo.isPriced && costInfo.costUSD) {
      sessionCostUSD += costInfo.costUSD;
    }
    const sIdx = Number(s.step_index ?? arrayIdx);
    const sMeta = stepMetaMap.get(sIdx);
    const promptSum = input + cache;
    const turnCachePct = promptSum > 0 ? Number(((cache / promptSum) * 100).toFixed(1)) : 0;

    turnCandidates.push({
      turnIndex: 0,
      stepIndex: sIdx,
      _arrayIdx: arrayIdx,
      _minArrayIdx: arrayIdx,
      _minStepIdx: Number.isFinite(sIdx) ? sIdx : null,
      _orderSeq: turnCandidateSeq++,
      _rawCtxMeta: null,
      _sourceGm: null,
      createdAt: s.created_at || '',
      tools: sMeta?.tools || [],
      model: displayModel || '未记录模型',
      hasRecordedModel: Boolean(rawModel),
      modelKey,
      inputTokens: input,
      cacheTokens: cache,
      outputTokens: output,
      thinkingTokens: thinking,
      responseTokens,
      totalTokens: total,
      deltaTokens: 0,
      cacheHitPercent: turnCachePct,
      budget: null,
      estimate: null,
      ttft: null,
      streamingSec: null,
      duration,
      tps,
      streamingTps: null,
      costUSD: costInfo.costUSD ?? 0,
      isPriced: costInfo.isPriced,
      error: s.status === 'ERROR' ? String(s.content || '请求报错') : '',
      contextBreakdown: null,
      _isServerExact: false
    });
  };

  if (bundleList.length) {
    const coveredStepNums = new Set();
    for (let idx = 0; idx < bundleList.length; idx++) {
      const gm = bundleList[idx];
      const cm = gm.chatModel || {};
      const numericGmSteps = getGenEntryStepNums(gm);
      let matchedLocalMeta = null;
      let minMatchedArrayIdx = -1;
      let maxMatchedArrayIdx = -1;
      for (const n of numericGmSteps) {
        coveredStepNums.add(n);
        const m = stepMetaMap.get(n);
        if (m && (!matchedLocalMeta || (m.stepUsage && (m.stepUsage.input + m.stepUsage.cache + m.stepUsage.output) > 0))) {
          matchedLocalMeta = m;
        }
        const matchedArr = stepArrayIdxByStepNum.has(n) ? stepArrayIdxByStepNum.get(n) : (m?.arrayIdx ?? -1);
        if (matchedArr >= 0) {
          if (minMatchedArrayIdx < 0 || matchedArr < minMatchedArrayIdx) minMatchedArrayIdx = matchedArr;
          if (matchedArr > maxMatchedArrayIdx) maxMatchedArrayIdx = matchedArr;
        }
      }
      const stepIdx = numericGmSteps[0] ?? null;
      const minGmStepIdx = numericGmSteps.length ? Math.min(...numericGmSteps) : null;
      const sMeta = (stepIdx !== null ? stepMetaMap.get(stepIdx) : null) || matchedLocalMeta;
      const srvUsage = getGenStepServerUsage(gm);
      const srvInput = Number(srvUsage?.inputTokens || 0);
      const srvCache = Number(srvUsage?.cacheReadTokens || 0);
      const srvOutput = Number(srvUsage?.outputTokens || 0);
      const hasServerUsage = Boolean(srvUsage && (srvInput + srvCache + srvOutput) > 0);
      const localUsage = matchedLocalMeta?.stepUsage || sMeta?.stepUsage || null;
      const hasLocalUsage = Boolean(localUsage && (localUsage.input + localUsage.cache + localUsage.output) > 0);
      const input = hasServerUsage ? srvInput : (hasLocalUsage ? localUsage.input : 0);
      const cache = hasServerUsage ? srvCache : (hasLocalUsage ? localUsage.cache : 0);
      const output = hasServerUsage ? srvOutput : (hasLocalUsage ? localUsage.output : 0);
      const thinking = hasServerUsage
        ? Number(srvUsage?.thinkingOutputTokens || 0)
        : (hasLocalUsage ? localUsage.thinking : 0);
      const responseTokens = hasServerUsage
        ? Number(srvUsage?.responseOutputTokens ?? Math.max(0, output - thinking))
        : (hasLocalUsage ? localUsage.response : 0);
      const total = input + cache + output;
      const timingMeta = matchedLocalMeta || sMeta;
      const rawModel = extractStepModel(null, gm, timingMeta?.stepModel || timingMeta?.runningSettingModel || activeSettingModel);
      const modelKey = normalizeModelId(rawModel, host.dynamicModelMap);
      const displayModel = rawModel ? formatModelDisplayName(rawModel, modelKey) : '';

      const ttft = parseDurationSec(cm.timeToFirstToken);
      const streamingSec = parseDurationSec(cm.streamingDuration);
      const hasServerTiming = ttft !== null || streamingSec !== null;
      const duration = hasServerTiming
        ? (ttft !== null && streamingSec !== null ? ttft + streamingSec : (ttft ?? streamingSec ?? null))
        : (timingMeta?.arrayIdx >= 0 ? estimateStepDuration(rawSteps, timingMeta.arrayIdx, logMtimeMs) : null);
      const tps = hasServerTiming
        ? (output > 0 && duration && duration > 0 ? Number((output / duration).toFixed(1)) : null)
        : (output > 0 && duration && duration > 0.1 ? Number((output / duration).toFixed(1)) : null);
      const streamTokBase = thinking > 0 && responseTokens > 0 ? responseTokens : output;
      const streamingTps = streamTokBase > 0 && streamingSec && streamingSec >= 0.4
        ? Number((streamTokBase / streamingSec).toFixed(1))
        : null;

      const costInfo = calculateRequestApiCost(
        {
          model: rawModel,
          modelKey,
          inputTokens: input,
          cacheTokens: cache,
          outputTokens: output,
          thinkingTokens: thinking,
          date: timingMeta?.createdAt
        },
        host.dynamicModelMap
      );
      if (costInfo.isPriced && costInfo.costUSD) {
        sessionCostUSD += costInfo.costUSD;
      }

      const promptSum = input + cache;
      const turnCachePct = promptSum > 0 ? Number(((cache / promptSum) * 100).toFixed(1)) : 0;

      const ctxMeta = cm.chatStartMetadata?.contextWindowMetadata || null;
      const turnError = getGenStepServerError(gm)
        || (timingMeta?.isError ? String(rawSteps[timingMeta.arrayIdx]?.content || '请求报错') : '');
      turnCandidates.push({
        turnIndex: 0,
        stepIndex: stepIdx,
        _arrayIdx: maxMatchedArrayIdx >= 0 ? maxMatchedArrayIdx : (timingMeta?.arrayIdx ?? -1),
        _minArrayIdx: minMatchedArrayIdx,
        _minStepIdx: minGmStepIdx,
        _orderSeq: turnCandidateSeq++,
        _rawCtxMeta: ctxMeta || null,
        _sourceGm: gm,
        createdAt: timingMeta?.createdAt || '',
        tools: timingMeta?.tools || [],
        model: displayModel || '未记录模型',
        hasRecordedModel: Boolean(rawModel),
        modelKey,
        inputTokens: input,
        cacheTokens: cache,
        outputTokens: output,
        thinkingTokens: thinking,
        responseTokens,
        totalTokens: total,
        deltaTokens: 0,
        cacheHitPercent: turnCachePct,
        budget: Number(ctxMeta?.maxContextTokens || 0) || null,
        estimate: Number(ctxMeta?.estimatedTokensUsed || 0) || null,
        ttft: ttft !== null ? Number(ttft.toFixed(2)) : null,
        streamingSec: streamingSec !== null ? Number(streamingSec.toFixed(2)) : null,
        duration: duration !== null ? Number(duration.toFixed(2)) : null,
        tps,
        streamingTps,
        costUSD: costInfo.costUSD ?? 0,
        isPriced: costInfo.isPriced,
        error: turnError,
        contextBreakdown: null,
        _isServerExact: Boolean(hasServerUsage && hasServerTiming)
      });
    }
    for (const reqStepIdx of requiredModelSteps) {
      if (coveredStepNums.has(reqStepIdx)) continue;
      const sMeta = stepMetaMap.get(reqStepIdx);
      const stepObj = sMeta && sMeta.arrayIdx >= 0 ? rawSteps[sMeta.arrayIdx] : null;
      if (stepObj) {
        appendFallbackTurnFromTranscriptStep(stepObj, sMeta.arrayIdx, sMeta.runningSettingModel || activeSettingModel);
      }
    }
  } else {
    // Pure transcript fallback when Language Server GeneratorMetadata is unavailable
    let runningModel = '';
    for (let i = 0; i < rawSteps.length; i++) {
      const s = rawSteps[i];
      if (s.type === 'USER_INPUT' && s.content) {
        const m = parseModelSettingFromText(s.content);
        if (m) runningModel = m;
      }
      if (isModelTurnStep(s)) {
        appendFallbackTurnFromTranscriptStep(s, i, runningModel);
      }
    }
  }

  // Restore chronological transcript order before filtering completed/error turns and computing turnIndex, deltaTokens, contextBreakdown, cache persistence & latestTurn
  let latestTurnSourceGm = null;
  let latestCandidate = null;
  let candidateContextBreakdown = null;
  const turns = [];
  if (turnCandidates.length > 0) {
    for (const t of turnCandidates) {
      t._sortKey = computeChronoSortKey(t._minArrayIdx, t._minStepIdx, t._orderSeq, stepArrayIdxByStepNum);
    }
    turnCandidates.sort((a, b) => compareChronoSortKeys(a._sortKey, b._sortKey));
    latestCandidate = turnCandidates[turnCandidates.length - 1] || null;
    for (const t of turnCandidates) {
      if (t.totalTokens > 0 || Boolean(t.error)) {
        turns.push(t);
      }
    }
    const latestTurnObj = turns.length ? turns[turns.length - 1] : null;
    const latestCandidateBreakdown = latestCandidate?._rawCtxMeta
      ? extractContextBreakdown(latestCandidate._rawCtxMeta)
      : null;
    const latestTurnBreakdown = latestTurnObj?._rawCtxMeta
      ? extractContextBreakdown(latestTurnObj._rawCtxMeta)
      : null;
    if (latestCandidateBreakdown) {
      candidateContextBreakdown = latestCandidateBreakdown;
      latestTurnSourceGm = latestCandidate?._sourceGm || null;
    } else if (latestTurnBreakdown) {
      candidateContextBreakdown = latestTurnBreakdown;
      latestTurnSourceGm = latestTurnObj?._sourceGm || null;
    } else {
      latestTurnSourceGm = latestCandidate?._sourceGm || latestTurnObj?._sourceGm || null;
    }

    let prevTotalTokens = 0;
    for (let idx = 0; idx < turns.length; idx++) {
      const t = turns[idx];
      t.turnIndex = idx + 1;
      t.deltaTokens = t.totalTokens > 0
        ? (prevTotalTokens > 0 ? t.totalTokens - prevTotalTokens : t.totalTokens)
        : 0;
      if (t.totalTokens > 0) prevTotalTokens = t.totalTokens;
      t.contextBreakdown = idx === turns.length - 1 ? candidateContextBreakdown : null;
    }
    for (const t of turnCandidates) {
      delete t._minArrayIdx;
      delete t._minStepIdx;
      delete t._orderSeq;
      delete t._rawCtxMeta;
      delete t._sortKey;
      delete t._sourceGm;
    }
  }

  if (!genFromCache && hasLsConfig && genRpcSucceeded) {
    if (bundleCallsByStep.size > 0) {
      convGenMetaCache.set(convId, {
        at: Number(genMetaBundle?.at || nowMs),
        lsKey,
        logSize: logStatSize,
        logMtimeMs: logStatMtime,
        generatorList: bundleList,
        callsByStep: bundleCallsByStep
      });
    }
    if (bundleList.length) {
      maybePersistConvStepModels(
        convId,
        existsSync(compactPath) ? compactPath : targetLogPath,
        bundleList
      );
    }
    if (diskSettledEligible || bundleList.length) {
      saveActiveConvGenDiskEntry(convId, {
        lsKeyHash: lsDiskHash,
        size: logStatSize,
        mtimeMs: logStatMtime,
        fetchedAt: nowMs,
        settled: diskSettledEligible,
        empty: !bundleList.length,
        generatorList: slimGeneratorListForCache(bundleList, latestTurnSourceGm)
      });
    }
  }

  const latestTurn = turns.length ? turns[turns.length - 1] : null;
  const latestValidTurn = [...turns].reverse().find((t) => t.totalTokens > 0 && !t.error) || latestTurn;

  // Session cumulative throughput & session-wide TPS stats
  const sessionTotals = {
    inputTokens: 0,
    cacheTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    responseTokens: 0,
    totalTokens: 0,
    cacheHitPercent: null
  };
  const validTpsValues = [];
  for (const t of turns) {
    sessionTotals.inputTokens += t.inputTokens || 0;
    sessionTotals.cacheTokens += t.cacheTokens || 0;
    sessionTotals.outputTokens += t.outputTokens || 0;
    sessionTotals.thinkingTokens += t.thinkingTokens || 0;
    sessionTotals.responseTokens += t.responseTokens || 0;
    sessionTotals.totalTokens += t.totalTokens || 0;
    if (typeof t.tps === 'number' && t.tps > 0) validTpsValues.push(t.tps);
  }
  const cumPrompt = sessionTotals.inputTokens + sessionTotals.cacheTokens;
  if (cumPrompt > 0) {
    sessionTotals.cacheHitPercent = Number(((sessionTotals.cacheTokens / cumPrompt) * 100).toFixed(1));
  }
  const avgTps = validTpsValues.length > 0
    ? Number((validTpsValues.reduce((a, b) => a + b, 0) / validTpsValues.length).toFixed(1))
    : null;
  const peakTps = validTpsValues.length > 0
    ? Number(Math.max(...validTpsValues).toFixed(1))
    : null;

  // Populate system & tool definition token estimates from server contextBreakdown if present
  const contextBreakdown = candidateContextBreakdown;
  if (contextBreakdown?.groups?.length) {
    const sysG = contextBreakdown.groups.find((g) => g.name === 'System Prompt');
    const toolG = contextBreakdown.groups.find((g) => g.name === 'Tools');
    if (sysG) groups.system = { chars: sysG.tokens * 4, bytes: sysG.tokens * 4, low: sysG.tokens, high: sysG.tokens };
    if (toolG) groups.definitions = { chars: toolG.tokens * 4, bytes: toolG.tokens * 4, low: toolG.tokens, high: toolG.tokens };
  }

  // Inspect attachments
  const attachments = [...mediaMap.values()].map(inspectAttachmentItem);
  const attachmentTotal = emptyMeasure();
  for (const att of attachments) {
    const mult = att.references || 1;
    addMeasure(attachmentTotal, {
      chars: (att.chars || 0) * mult,
      bytes: (att.bytes || 0) * mult,
      low: (att.low || 0) * mult,
      high: (att.high || 0) * mult
    });
  }

  const localTotal = emptyMeasure();
  for (const g of Object.values(groups)) addMeasure(localTotal, g);
  addMeasure(localTotal, attachmentTotal);

  const activeErrorText = latestTurn?.error || (
    latestStepError && (!latestTurn?.stepIndex || latestStepError.stepIndex >= latestTurn.stepIndex)
      ? latestStepError.text
      : ''
  );
  const modelSourceTurn = (latestCandidate?.hasRecordedModel ? latestCandidate : latestTurn) || latestCandidate;
  const refStepIdx = modelSourceTurn?.stepIndex ?? latestTurn?.stepIndex ?? null;
  const switchedAfterLatestTurn = Boolean(
    activeSettingModel &&
    lastSettingStepIdx >= 0 &&
    (refStepIdx == null || lastSettingStepIdx > Number(refStepIdx))
  );
  const currentModelKey = switchedAfterLatestTurn
    ? (normalizeModelId(activeSettingModel, host.dynamicModelMap) || null)
    : (modelSourceTurn?.modelKey || normalizeModelId(activeSettingModel, host.dynamicModelMap) || null);
  const currentModelDisplay = switchedAfterLatestTurn
    ? formatModelDisplayName(activeSettingModel, currentModelKey)
    : (modelSourceTurn?.hasRecordedModel
        ? modelSourceTurn.model
        : (activeSettingModel ? formatModelDisplayName(activeSettingModel, currentModelKey) : '未记录模型'));
  const errorInfo = classifyRequestError(activeErrorText, {
    currentModel: currentModelDisplay,
    clientModelConfigs: host.modelConfigs,
    quotaSummaryGroups: host.quotaSummaryGroups
  });

  // Compute pending unsent tokens appended after the last completed model turn
  let lastCoveredArrayIdx = lastTranscriptPlannerArrayIdx;
  if (latestValidTurn && latestValidTurn.totalTokens > 0 && !latestValidTurn.error) {
    lastCoveredArrayIdx = Math.max(lastCoveredArrayIdx, latestValidTurn._arrayIdx ?? -1);
  }
  const latestEstimateTurn = (latestCandidate?.estimate > 0 ? latestCandidate : null) || latestTurn;
  if (errorInfo.kind === 'context_overflow' && latestEstimateTurn?.estimate > 0) {
    lastCoveredArrayIdx = Math.max(lastCoveredArrayIdx, latestEstimateTurn._arrayIdx ?? -1);
  }
  const pendingMeasure = emptyMeasure();
  let pendingStepsCount = 0;
  if (lastCoveredArrayIdx >= 0 && lastCoveredArrayIdx < rawSteps.length - 1) {
    for (let i = lastCoveredArrayIdx + 1; i < rawSteps.length; i++) {
      const stp = rawSteps[i];
      if (stp.type === 'ERROR_MESSAGE' || stp.status === 'ERROR') continue;
      if (typeof stp.content === 'string' && stp.content) {
        addMeasure(pendingMeasure, measureText(stp.content));
        pendingStepsCount++;
      }
    }
  }
  const pendingTokens = pendingStepsCount > 0
    ? Math.round((pendingMeasure.low + pendingMeasure.high) / 2)
    : 0;

  const baseUsedTokens = errorInfo.kind === 'context_overflow'
    ? (latestEstimateTurn?.estimate || latestValidTurn?.totalTokens || null)
    : (latestValidTurn?.totalTokens ?? latestEstimateTurn?.estimate ?? null);
  const usedTokens = baseUsedTokens !== null ? baseUsedTokens + pendingTokens : null;
  const curNormDisplay = String(currentModelDisplay || '').trim().toLowerCase();
  const isTurnMatchingCurrentModel = (t) => {
    if (!t || !(t.budget > 0)) return false;
    if (!switchedAfterLatestTurn && (t === modelSourceTurn || t === latestTurn)) return true;
    if (currentModelKey && t.modelKey && t.modelKey === currentModelKey) return true;
    if (t.hasRecordedModel && curNormDisplay && curNormDisplay !== '未记录模型') {
      return String(t.model || '').trim().toLowerCase() === curNormDisplay;
    }
    return false;
  };
  const matchedBudgetTurn = [...turnCandidates].reverse().find(isTurnMatchingCurrentModel);
  const budgetTokens = matchedBudgetTurn?.budget || null;
  const budgetSource = budgetTokens ? 'server' : 'unknown';
  const remainingTokens = usedTokens !== null && budgetTokens !== null && budgetTokens > 0
    ? Math.max(0, budgetTokens - usedTokens)
    : null;
  const usedPercent = usedTokens !== null && budgetTokens !== null && budgetTokens > 0
    ? Number(((usedTokens / budgetTokens) * 100).toFixed(1))
    : null;
  const promptTotal = (latestValidTurn?.inputTokens || 0) + (latestValidTurn?.cacheTokens || 0);
  const cacheHitPercent = promptTotal > 0
    ? Number((((latestValidTurn?.cacheTokens || 0) / promptTotal) * 100).toFixed(1))
    : null;

  const modelQuota = resolveModelQuota(currentModelDisplay, host.modelConfigs, host.quotaSummaryGroups);
  const unknownAttachmentsCount = attachments.filter((a) => a.status !== 'parsed').length;

  // Resolve workspace URI via official agentapi if available (cached per conversation)
  let workspacePath = convWorkspaceCache.get(convId) ?? null;
  if (workspacePath === null && !convWorkspaceCache.has(convId)) {
    try {
      const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
      if (exe) {
        const out = execFileSync(exe, ['agentapi', 'get-conversation-metadata', convId], {
          encoding: 'utf-8',
          timeout: 2000
        });
        const parsedMeta = JSON.parse(out);
        const uri = parsedMeta?.response?.conversationMetadata?.metadata?.workspaceUris?.[0] || '';
        if (uri.startsWith('file://')) workspacePath = fileURLToPath(uri);
      }
    } catch {}
    convWorkspaceCache.set(convId, workspacePath);
  }

  const resolvedTitle = conversationTitle || `会话 ${convId.slice(0, 8)}`;
  const contextPayload = {
    model: currentModelDisplay,
    modelKey: currentModelKey,
    used: usedTokens,
    baseUsed: baseUsedTokens,
    pendingTokens,
    pendingStepsCount,
    actual: latestValidTurn?.totalTokens ?? null,
    estimate: latestEstimateTurn?.estimate ?? null,
    budget: budgetTokens,
    budgetSource,
    remaining: remainingTokens,
    percent: usedPercent,
    inputTokens: latestValidTurn?.inputTokens ?? null,
    cacheTokens: latestValidTurn?.cacheTokens ?? null,
    outputTokens: latestValidTurn?.outputTokens ?? null,
    thinkingTokens: latestValidTurn?.thinkingTokens ?? 0,
    responseTokens: latestValidTurn?.responseTokens ?? (latestValidTurn?.outputTokens ?? 0),
    cacheHitPercent,
    roundCostUSD: Number((latestValidTurn?.costUSD || 0).toFixed(5)),
    sessionCostUSD: Number(sessionCostUSD.toFixed(4)),
    isPriced: Boolean(latestValidTurn?.isPriced),
    error: errorInfo,
    quota: modelQuota,
    breakdown: contextBreakdown,
    sessionTotals
  };
  const speedPayload = latestValidTurn ? {
    tps: latestValidTurn.tps,
    streamingTps: latestValidTurn.streamingTps,
    avgTps,
    peakTps,
    duration: latestValidTurn.duration,
    ttft: latestValidTurn.ttft,
    streamingSec: latestValidTurn.streamingSec,
    outputTokens: latestValidTurn.outputTokens,
    thinkingTokens: latestValidTurn.thinkingTokens,
    responseTokens: latestValidTurn.responseTokens,
    isServerExact: Boolean(latestValidTurn?._isServerExact)
  } : null;
  const sparklinePayload = turns.slice(-24).map((t) => ({
    turn: t.turnIndex,
    total: t.totalTokens,
    delta: t.deltaTokens,
    cache: t.cacheTokens,
    output: t.outputTokens,
    tps: t.tps,
    costUSD: t.costUSD
  }));
  const turnsPayload = turns.slice(-40).reverse().map(({
    contextBreakdown: _cb,
    hasRecordedModel: _hrm,
    _arrayIdx: _ai,
    _isServerExact: _ise,
    ...rest
  }) => ({
    ...rest,
    error: rest.error ? sanitizeDiagnosticText(rest.error, 200) : ''
  }));
  const auditPayload = {
    totalSteps,
    turnsCount: turns.length,
    userMessages,
    assistantMessages,
    toolCallsCount,
    groups,
    attachmentTotal,
    localTotal,
    attachments,
    unknownAttachmentsCount
  };

  const etag = computeContentEtag('ctx', {
    conversationId: convId,
    conversationTitle: resolvedTitle,
    workspacePath,
    quotas: host.quotas || [],
    quotaState: toStableQuotaState(host.quotaStatus),
    context: contextPayload,
    speed: speedPayload,
    sparkline: sparklinePayload,
    turns: turnsPayload,
    audit: auditPayload
  });

  const resultSnap = {
    ok: true,
    etag,
    scannedAt: nowMs,
    conversationId: convId,
    conversationTitle: resolvedTitle,
    workspacePath,
    recentConversations,
    quotas: host.quotas || [],
    quotaStatus: host.quotaStatus,
    context: contextPayload,
    speed: speedPayload,
    sparkline: sparklinePayload,
    turns: turnsPayload,
    audit: auditPayload
  };
  if (scanSnapCache.size > 32) {
    const oldest = scanSnapCache.keys().next().value;
    if (oldest) scanSnapCache.delete(oldest);
  }
  scanSnapCache.set(convId, {
    key: baseSnapKey,
    baseKey: baseSnapKey,
    retryCount: nextRetryCount,
    metaSettled,
    nextMetaCheckAt,
    snap: resultSnap
  });
  return resultSnap;
}

// ---------------------------------------------------------------------------
// Global Token History & Multi-Source Cost Aggregator
// ---------------------------------------------------------------------------

function walkTranscriptFiles(rootBrainDir, sourceName) {
  const jobs = [];
  if (!existsSync(rootBrainDir)) return jobs;
  const visited = new Set();

  const walk = (dir, depth) => {
    if (depth > 4) return;
    let real;
    try { real = realpathSync(dir); } catch { return; }
    if (visited.has(real)) return;
    visited.add(real);

    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (SKIP_SCAN_DIRS.has(ent.name)) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory() || ent.isSymbolicLink()) {
        if (depth === 0) {
          const fastStd = join(full, '.system_generated', 'logs', 'transcript.jsonl');
          const fastDirect = join(full, 'transcript.jsonl');
          if (existsSync(fastStd)) {
            jobs.push({ path: fastStd, convId: ent.name, source: sourceName });
            continue;
          }
          if (existsSync(fastDirect)) {
            jobs.push({ path: fastDirect, convId: ent.name, source: sourceName });
            continue;
          }
        }
        walk(full, depth + 1);
      } else if (ent.name === 'transcript.jsonl') {
        jobs.push({ path: full, convId: basename(dirname(full)), source: sourceName });
      }
    }
  };

  walk(rootBrainDir, 0);
  return jobs;
}

function countSessionFiles(convDir) {
  if (!existsSync(convDir)) return 0;
  let count = 0;
  try {
    for (const name of readdirSync(convDir)) {
      const lower = name.toLowerCase();
      if (lower.endsWith('-wal') || lower.endsWith('-shm') || lower.endsWith('-journal') || lower.endsWith('.tmp')) continue;
      if (lower.endsWith('.pb') || lower.endsWith('.db')) count++;
    }
  } catch {}
  return count;
}

function invalidateHistoryResultCache() {
  genBackfillDataSeq += 1;
  cachedHistoryResult = { at: 0, hostSig: '', persistPath: '', lsKey: '', etag: '', data: null };
}

function flushGenBackfillPersisted(wave) {
  if (!wave) return;
  const pendingKeys = Object.keys(wave.pendingConvs || {});
  if (wave.dirtyCount <= 0 && pendingKeys.length === 0) return;
  const pendingSnapshot = wave.pendingConvs;
  wave.pendingConvs = {};
  wave.dirtyCount = 0;
  if (
    pendingKeys.length > 0 &&
    ((wave.agDir && existsSync(wave.agDir)) || (wave.persistPath && existsSync(dirname(wave.persistPath))))
  ) {
    savePersistedStepModels({ version: 1, convs: pendingSnapshot }, wave.persistPath);
  }
  invalidateHistoryResultCache();
}

function notifyWaveIdle(wave) {
  if (!wave || wave.activeWorkers > 0) return;
  for (const resolveFn of wave.idleWaiters) {
    resolveFn();
  }
  wave.idleWaiters.clear();
}

function waitForWaveIdle(wave) {
  if (!wave || wave.activeWorkers <= 0) return Promise.resolve();
  return new Promise((resolvePromise) => {
    wave.idleWaiters.add(resolvePromise);
  });
}

async function stopGenBackfillWave(wave) {
  if (!wave) return;
  if (wave.stopPromise) {
    await wave.stopPromise;
    return;
  }
  wave.stopPromise = (async () => {
    flushGenBackfillPersisted(wave);
    const hadActive = wave.activeWorkers > 0;
    wave.aborted = true;
    wave.queue.length = 0;
    wave.queuedById.clear();
    wave.abortController.abort();
    if (genBackfillState.wave === wave) {
      genBackfillState.wave = null;
    }
    if (hadActive) {
      let abortWaitTimer = null;
      await Promise.race([
        waitForWaveIdle(wave),
        new Promise((r) => { abortWaitTimer = setTimeout(r, 50); })
      ]);
      if (abortWaitTimer) clearTimeout(abortWaitTimer);
      // Allow loopback server sockets to process TCP FIN before opening the next wave.
      await new Promise((r) => setTimeout(r, 15));
    }
    flushGenBackfillPersisted(wave);
  })();
  genBackfillState.stopping = wave.stopPromise;
  try {
    await wave.stopPromise;
  } finally {
    if (genBackfillState.stopping === wave.stopPromise) {
      genBackfillState.stopping = null;
    }
  }
}

async function waitGenBackfillWithBudget(wave, budgetMs) {
  if (!wave || wave.activeWorkers <= 0) return;
  let timer = null;
  await Promise.race([
    waitForWaveIdle(wave),
    new Promise((resolvePromise) => {
      timer = setTimeout(resolvePromise, budgetMs);
    })
  ]);
  if (timer) clearTimeout(timer);
}

function isConvStepsCovered(convId, stepsNeedingGen, persistPath = getGenStepModelsPath()) {
  if (!stepsNeedingGen?.length) return true;
  const persistedSteps = loadPersistedStepModels(persistPath).convs?.[convId]?.steps;
  const memCalls = convGenMetaCache.get(convId)?.callsByStep;
  return stepsNeedingGen.every((stepKey) => (
    Boolean(persistedSteps?.[stepKey]) ||
    Boolean(extractStepModel(null, memCalls?.get(Number(stepKey)), ''))
  ));
}

function ensureGenBackfillWorkers(wave) {
  const ac = wave.abortController;
  while (
    !wave.aborted &&
    !ac.signal.aborted &&
    wave.activeWorkers < GEN_BACKFILL_CONCURRENCY &&
    wave.queue.length > 0
  ) {
    wave.activeWorkers += 1;
    (async () => {
      try {
        while (!wave.aborted && !ac.signal.aborted) {
          if (wave.consecutiveRpcFailures >= GEN_BACKFILL_CONCURRENCY) {
            wave.queue.length = 0;
            wave.queuedById.clear();
            break;
          }
          const item = wave.queue.shift();
          if (!item) break;
          wave.queuedById.delete(item.convId);
          wave.inFlightIds.add(item.convId);
          try {
            const reqNowMs = item.explicitNow ? Number(item.nowMs) : Date.now();
            const existingGen = convGenMetaCache.get(item.convId);
            const genFetchForce = item.force
              || Boolean(existingGen && existingGen.at < item.st.mtimeMs)
              || Boolean(
                existingGen &&
                existingGen.logSize !== undefined &&
                (existingGen.logSize !== item.st?.size || existingGen.logMtimeMs !== item.st?.mtimeMs)
              )
              || Boolean(
                existingGen &&
                !item.stepsNeedingGen.every((k) => Boolean(extractStepModel(null, existingGen.callsByStep?.get(Number(k)), '')))
              );
            const gm = await fetchGeneratorMetadataForConv(item.convId, genFetchForce, {
              timeoutMs: GEN_BACKFILL_RPC_TIMEOUT_MS,
              signal: ac.signal,
              unrefSocket: true,
              nowMs: reqNowMs,
              logSize: item.st?.size,
              logMtimeMs: item.st?.mtimeMs
            });

            if (gm && !gm.fromFallbackCache && Array.isArray(gm.generatorList) && gm.generatorList.length > 0) {
              const persistedModels = loadPersistedStepModels(wave.persistPath);
              if (mergePersistedConvStepModels(persistedModels.convs, item.convId, item.st, gm.generatorList)) {
                const mergedEntry = persistedModels.convs[item.convId];
                if (mergedEntry) {
                  wave.pendingConvs[item.convId] = {
                    size: mergedEntry.size,
                    mtimeMs: mergedEntry.mtimeMs,
                    steps: { ...mergedEntry.steps }
                  };
                }
                wave.dirtyCount += 1;
                invalidateHistoryResultCache();
                if (wave.dirtyCount >= GEN_BACKFILL_CONCURRENCY) {
                  flushGenBackfillPersisted(wave);
                }
              }
            }

            if (wave.aborted || ac.signal.aborted) break;

            if (!gm || gm.rpcFailed) {
              wave.consecutiveRpcFailures += 1;
            } else {
              wave.consecutiveRpcFailures = 0;
            }

            if (isConvStepsCovered(item.convId, item.stepsNeedingGen, wave.persistPath)) {
              lsGenMissCache.delete(item.convId);
            } else {
              const evalNowMs = item.explicitNow ? Number(item.nowMs) : Date.now();
              const ageMs = Math.max(0, evalNowMs - Number(item.st?.mtimeMs || 0));
              const settled = Boolean(gm && !gm.rpcFailed && ageMs >= CONV_META_SETTLE_AGE_MS);
              lsGenMissCache.set(item.convId, {
                lsAddr: wave.lsAddr,
                size: item.st.size,
                mtimeMs: item.st.mtimeMs,
                at: evalNowMs,
                settled
              });
            }
          } finally {
            wave.inFlightIds.delete(item.convId);
          }
        }
      } finally {
        wave.activeWorkers -= 1;
        if (wave.activeWorkers === 0) {
          flushGenBackfillPersisted(wave);
          if (genBackfillState.wave === wave) {
            genBackfillState.wave = null;
          }
          notifyWaveIdle(wave);
        }
      }
    })();
  }
}

async function enqueueAndWaitGenBackfill(
  candidates,
  { force = false, lsKey = '', lsAddr = '', agDir = findAppDataDir(), persistPath = getGenStepModelsPath(), budgetMs = GEN_BACKFILL_SYNC_BUDGET_MS } = {}
) {
  if (!candidates.length) return;
  const oldWave = genBackfillState.wave;
  if (oldWave && (force || (oldWave.lsKey && oldWave.lsKey !== lsKey) || oldWave.persistPath !== persistPath)) {
    await stopGenBackfillWave(oldWave);
  } else if (genBackfillState.stopping) {
    await genBackfillState.stopping;
  }

  let wave = genBackfillState.wave;
  if (!wave || wave.aborted) {
    wave = {
      id: ++genBackfillWaveSeq,
      lsKey,
      lsAddr,
      agDir,
      persistPath,
      abortController: new AbortController(),
      queue: [],
      queuedById: new Map(),
      inFlightIds: new Set(),
      activeWorkers: 0,
      consecutiveRpcFailures: 0,
      dirtyCount: 0,
      pendingConvs: {},
      aborted: false,
      idleWaiters: new Set(),
      stopPromise: null
    };
    genBackfillState.wave = wave;
  }
  wave.consecutiveRpcFailures = 0;

  for (const item of candidates) {
    if (wave.inFlightIds.has(item.convId)) continue;
    const queued = wave.queuedById.get(item.convId);
    if (queued) {
      queued.st = item.st;
      queued.stepsNeedingGen = item.stepsNeedingGen;
      queued.force = queued.force || item.force;
      queued.nowMs = item.nowMs;
      queued.explicitNow = item.explicitNow;
    } else {
      const entry = { ...item };
      wave.queue.push(entry);
      wave.queuedById.set(item.convId, entry);
    }
  }

  if (wave.queue.length > 0) {
    ensureGenBackfillWorkers(wave);
  }
  if (wave.activeWorkers > 0) {
    await waitGenBackfillWithBudget(wave, budgetMs);
  }
  flushGenBackfillPersisted(wave);
}

export async function collectTokenHistory(options = {}) {
  const force = Boolean(options.force);
  const hasExplicitNow = Number.isFinite(Number(options.nowMs)) && Number(options.nowMs) > 0;
  const nowMs = hasExplicitNow ? Number(options.nowMs) : Date.now();
  const background = Boolean(options.background);
  const menubarMode = String(options.menubarMode || 'context');
  const curPersistPath = getGenStepModelsPath();
  const curLsAddr = process.env.ANTIGRAVITY_LS_ADDRESS || '';
  const curLsCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN || '';
  const hasLsConfig = Boolean(curLsAddr && curLsCsrf);
  const curLsKey = hasLsConfig ? `${curLsAddr}|${curLsCsrf}` : '';
  const normLsAddr = hasLsConfig ? normalizeLsAddr(curLsAddr) : '';
  const existingWave = genBackfillState.wave;
  if (
    existingWave &&
    (force || existingWave.persistPath !== curPersistPath || existingWave.lsKey !== curLsKey)
  ) {
    await stopGenBackfillWave(existingWave);
  } else if (genBackfillState.stopping) {
    await genBackfillState.stopping;
  }
  if (force) {
    transcriptHistCache.clear();
    genStepModelsCache = { path: '', mtimeMs: -1, size: -1, data: null };
    lsGenMissCache.clear();
  }
  const host = await getHostUserStatus(force, { background, menubarMode, nowMs });
  const observedAct = getObservedActivityMs();
  const histTtlMs = (observedAct > 0 && (nowMs - observedAct) >= 120_000) ? 60_000 : 12_000;
  if (
    !force &&
    cachedHistoryResult.data &&
    cachedHistoryResult.hostSig === host.sig &&
    cachedHistoryResult.persistPath === curPersistPath &&
    cachedHistoryResult.lsKey === curLsKey &&
    (nowMs - cachedHistoryResult.at) < histTtlMs
  ) {
    return cachedHistoryResult.data;
  }

  const rawSettings = loadRawSettings();
  const acctKey = host.plan?.accountKey || rawSettings.lastAccountKey || 'default';
  const customPlan = rawSettings.accounts[acctKey] || rawSettings.accounts.default || null;
  const effectivePlan = resolveEffectivePlanStatus(host.plan, customPlan);

  const agDir = findAppDataDir();
  const cliDir = findCliDataDir();
  const desktopJobs = walkTranscriptFiles(join(agDir, 'brain'), 'desktop');
  const cliJobs = walkTranscriptFiles(join(cliDir, 'brain'), 'cli');
  const allJobs = [...desktopJobs, ...cliJobs];

  const desktopSessionFiles = countSessionFiles(join(agDir, 'conversations'));
  const cliSessionFiles = countSessionFiles(join(cliDir, 'conversations'));

  const dailyBySource = { all: {}, desktop: {}, cli: {} };
  const requestsBySource = { all: [], desktop: [], cli: [] };
  const seenEvents = new Set();
  let firstUseDate = null;

  const trackDate = (d) => {
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      if (!firstUseDate || d < firstUseDate) firstUseDate = d;
    }
  };

  const addDaily = (bucketMap, dateKey, inp, cap, outp, pricedCost, refCost) => {
    if (!bucketMap[dateKey]) {
      bucketMap[dateKey] = { total: 0, input: 0, cache: 0, output: 0, steps: 0, costUSD: 0, refCostUSD: 0 };
    }
    const b = bucketMap[dateKey];
    b.total += inp + cap + outp;
    b.input += inp;
    b.cache += cap;
    b.output += outp;
    b.steps += 1;
    b.costUSD = Number((b.costUSD + pricedCost).toFixed(6));
    b.refCostUSD = Number((b.refCostUSD + refCost).toFixed(6));
  };

  const persistedModels = loadPersistedStepModels();
  const persistedConvs = persistedModels.convs;

  const parsedJobs = [];
  const backfillCandidates = [];
  let maxJobMtimeMs = 0;

  for (let idx = 0; idx < allJobs.length; idx++) {
    const job = allJobs[idx];
    if (idx > 0 && idx % 20 === 0) {
      await new Promise((r) => setImmediate(r));
    }
    try {
      const st = statSync(job.path);
      if (st.mtimeMs > maxJobMtimeMs) maxJobMtimeMs = st.mtimeMs;
      let cached = transcriptHistCache.get(job.path);

      if (!cached || cached.size !== st.size || cached.mtimeMs !== st.mtimeMs) {
        const rawRecords = [];
        const missingStepSet = new Set();
        let firstDate = null;
        let activeModel = '';
        const lines = readFileSync(job.path, 'utf-8').split(/\r?\n/);

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          const line = lines[lineIdx];
          if (!line.trim()) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }

          if (ev.type === 'USER_INPUT' && ev.content) {
            const switched = parseModelSettingFromText(ev.content);
            if (switched) activeModel = switched;
          }

          let dateKey = null;
          if (ev.created_at) {
            const dt = new Date(ev.created_at);
            if (!Number.isNaN(dt.getTime())) dateKey = formatLocalDateKey(dt);
          }
          if (dateKey && (!firstDate || dateKey < firstDate)) {
            firstDate = dateKey;
          }

          if (!isModelTurnStep(ev)) continue;
          const { input: inp, cache: cap, output: outp, thinking } = extractStepUsage(ev);
          const tot = inp + cap + outp;
          if (tot <= 0 || !dateKey) continue;

          const stepNum = Number(ev.step_index ?? lineIdx);
          const stepKey = String(stepNum);
          const stepOwnModel = extractStepModel(ev, null, '');
          if (!stepOwnModel) missingStepSet.add(stepKey);

          rawRecords.push({
            eventId: String(ev.callId || ev.responseId || `${job.convId}#${stepNum}`),
            source: job.source,
            convId: job.convId,
            date: dateKey,
            created_at: ev.created_at || dateKey,
            stepNum,
            stepKey,
            stepOwnModel,
            fallbackRunningModel: activeModel,
            inputTokens: inp,
            cacheTokens: cap,
            outputTokens: outp,
            thinkingTokens: thinking,
            totalTokens: tot
          });
        }

        cached = {
          size: st.size,
          mtimeMs: st.mtimeMs,
          firstDate,
          rawRecords,
          stepsNeedingGen: [...missingStepSet]
        };
        if (transcriptHistCache.size > 1200) {
          const firstKey = transcriptHistCache.keys().next().value;
          if (firstKey) transcriptHistCache.delete(firstKey);
        }
        transcriptHistCache.set(job.path, cached);
      }

      parsedJobs.push({ job, cached });

      if (!hasLsConfig || job.source === 'cli' || !cached.stepsNeedingGen.length) continue;

      const persistedEntry = persistedConvs[job.convId];
      const isPersistedComplete = Boolean(
        persistedEntry &&
        persistedEntry.size === st.size &&
        persistedEntry.mtimeMs === st.mtimeMs &&
        persistedEntry.steps &&
        cached.stepsNeedingGen.every((stepKey) => Boolean(persistedEntry.steps[stepKey]))
      );
      if (isPersistedComplete) continue;

      const miss = lsGenMissCache.get(job.convId);
      if (
        !force &&
        miss &&
        normLsAddr &&
        miss.lsAddr === normLsAddr &&
        miss.size === st.size &&
        miss.mtimeMs === st.mtimeMs &&
        (miss.settled === true || (nowMs - miss.at) < GEN_MISS_TTL_MS)
      ) {
        continue;
      }
      backfillCandidates.push({
        convId: job.convId,
        st,
        stepsNeedingGen: cached.stepsNeedingGen,
        force,
        nowMs,
        explicitNow: hasExplicitNow
      });
    } catch {}
  }

  if (maxJobMtimeMs > 0) {
    noteObservedTranscriptActivity(maxJobMtimeMs, nowMs);
  }

  if (hasLsConfig && backfillCandidates.length > 0) {
    backfillCandidates.sort((a, b) => Number(b.st.mtimeMs || 0) - Number(a.st.mtimeMs || 0));
    await enqueueAndWaitGenBackfill(backfillCandidates, {
      force,
      lsKey: curLsKey,
      lsAddr: normLsAddr,
      agDir,
      persistPath: curPersistPath,
      budgetMs: GEN_BACKFILL_SYNC_BUDGET_MS
    });
  }

  const resultBuiltSeq = genBackfillDataSeq;
  const latestPersistedConvs = loadPersistedStepModels().convs;

  for (const { job, cached } of parsedJobs) {
    if (cached.firstDate) trackDate(cached.firstDate);
    const genCached = convGenMetaCache.get(job.convId);
    const persistedSteps = latestPersistedConvs[job.convId]?.steps || null;

    for (const rawRec of cached.rawRecords) {
      trackDate(rawRec.date);
      if (seenEvents.has(rawRec.eventId)) continue;
      seenEvents.add(rawRec.eventId);

      const gmEntry = genCached?.callsByStep?.get(rawRec.stepNum)
        || (persistedSteps?.[rawRec.stepKey]
          ? { chatModel: { modelDisplayName: persistedSteps[rawRec.stepKey] } }
          : null);
      const gmModel = gmEntry?.chatModel?.modelDisplayName
        || gmEntry?.chatModel?.responseModel
        || gmEntry?.chatModel?.model
        || '';
      const rec = {
        eventId: rawRec.eventId,
        source: rawRec.source,
        convId: rawRec.convId,
        date: rawRec.date,
        created_at: rawRec.created_at,
        model: String(gmModel || rawRec.stepOwnModel || rawRec.fallbackRunningModel || '').trim(),
        inputTokens: rawRec.inputTokens,
        cacheTokens: rawRec.cacheTokens,
        outputTokens: rawRec.outputTokens,
        thinkingTokens: rawRec.thinkingTokens,
        totalTokens: rawRec.totalTokens
      };

      const priced = calculateRequestApiCost(rec, host.dynamicModelMap);
      const refCalc = calculateReferenceCost(rec, 'gemini-3.8-flash', rec.date);
      const pCost = priced.isPriced ? (priced.costUSD || 0) : 0;
      const rCost = refCalc.totalCostUSD || 0;

      addDaily(dailyBySource.all, rec.date, rec.inputTokens, rec.cacheTokens, rec.outputTokens, pCost, rCost);
      addDaily(dailyBySource[rec.source] || dailyBySource.desktop, rec.date, rec.inputTokens, rec.cacheTokens, rec.outputTokens, pCost, rCost);

      requestsBySource.all.push(rec);
      (requestsBySource[rec.source] || requestsBySource.desktop).push(rec);
    }
  }

  // Optional read-only merge of legacy unallocated daily totals if user previously had token_usage_archive_v2.json
  const legacyV2 = readJsonSafe(join(agDir, 'token_usage_archive_v2.json'), null);
  if (legacyV2?.dailyMapBySource?.legacyUnallocated) {
    for (const [dateKey, lRec] of Object.entries(legacyV2.dailyMapBySource.legacyUnallocated)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !lRec?.total) continue;
      trackDate(dateKey);
      const refCalc = calculateReferenceCost(
        { inputTokens: lRec.input || 0, cacheTokens: lRec.cache || 0, outputTokens: lRec.output || 0, totalTokens: lRec.total || 0 },
        'gemini-3.8-flash',
        dateKey
      );
      addDaily(dailyBySource.all, dateKey, lRec.input || 0, lRec.cache || 0, lRec.output || 0, 0, refCalc.totalCostUSD || 0);
      addDaily(dailyBySource.desktop, dateKey, lRec.input || 0, lRec.cache || 0, lRec.output || 0, 0, refCalc.totalCostUSD || 0);
    }
  }

  const now = new Date();
  const todayKey = formatLocalDateKey(now);
  const monthPrefix = todayKey.slice(0, 7);
  const yearPrefix = todayKey.slice(0, 4);
  if (!firstUseDate) firstUseDate = todayKey;

  const buildSourceAnalytics = (srcKey) => {
    const dMap = dailyBySource[srcKey] || {};
    const reqs = requestsBySource[srcKey] || [];
    let grandTotal = 0, totalInput = 0, totalCache = 0, totalOutput = 0, totalSteps = 0;
    let todayTokens = 0, monthTokens = 0, yearTokens = 0;
    let monthInput = 0, monthCache = 0, monthOutput = 0, monthSteps = 0;
    let yearActiveDays = 0, monthActiveDays = 0;

    for (const [dKey, v] of Object.entries(dMap)) {
      grandTotal += v.total;
      totalInput += v.input;
      totalCache += v.cache;
      totalOutput += v.output;
      totalSteps += v.steps;
      if (dKey === todayKey) todayTokens += v.total;
      if (dKey.startsWith(monthPrefix)) {
        monthTokens += v.total;
        monthInput += v.input;
        monthCache += v.cache;
        monthOutput += v.output;
        monthSteps += v.steps;
        if (v.total > 0) monthActiveDays++;
      }
      if (dKey.startsWith(yearPrefix)) {
        yearTokens += v.total;
        if (v.total > 0) yearActiveDays++;
      }
    }

    const activeDaysCount = Object.values(dMap).filter((v) => v.total > 0).length;
    const periodReqs = reqs.filter((r) => r.date && r.date.startsWith(monthPrefix));

    const identifiedAll = summarizeApiCost(reqs, host.dynamicModelMap);
    const identifiedPeriod = summarizeApiCost(periodReqs, host.dynamicModelMap);

    const refAll = calculateReferenceCost({ inputTokens: totalInput, cacheTokens: totalCache, outputTokens: totalOutput, totalTokens: grandTotal }, 'gemini-3.8-flash', PRICING_VERIFIED_DATE);
    const refPeriod = calculateReferenceCost({ inputTokens: monthInput, cacheTokens: monthCache, outputTokens: monthOutput, totalTokens: monthTokens }, 'gemini-3.8-flash', PRICING_VERIFIED_DATE);

    // Hybrid = identified priced requests + reference rate for residual unpriced tokens
    const buildHybrid = (ident, refBase) => {
      const resIn = Math.max(0, refBase.inputTokens - ident.byCategory.inputTokens);
      const resCache = Math.max(0, refBase.cacheTokens - ident.byCategory.cacheTokens);
      const resOut = Math.max(0, refBase.outputTokens - ident.byCategory.outputTokens);
      const resCalc = calculateReferenceCost({ inputTokens: resIn, cacheTokens: resCache, outputTokens: resOut }, 'gemini-3.8-flash', PRICING_VERIFIED_DATE);
      return {
        totalCostUSD: Number((ident.pricedCostUSD + resCalc.totalCostUSD).toFixed(4)),
        inputCostUSD: Number((ident.pricedInputCostUSD + resCalc.inputCostUSD).toFixed(4)),
        cacheCostUSD: Number((ident.pricedCacheCostUSD + resCalc.cacheCostUSD).toFixed(4)),
        outputCostUSD: Number((ident.pricedOutputCostUSD + resCalc.outputCostUSD).toFixed(4)),
        knownCostUSD: ident.pricedCostUSD,
        residualCostUSD: resCalc.totalCostUSD,
        residualTokens: resIn + resCache + resOut
      };
    };

    return {
      summary: {
        grandTotalTokens: grandTotal,
        totalInputTokens: totalInput,
        totalCacheTokens: totalCache,
        totalOutputTokens: totalOutput,
        totalSteps,
        todayTokens,
        monthTokens,
        yearTokens,
        monthInput,
        monthCache,
        monthOutput,
        monthSteps,
        activeDaysCount,
        monthActiveDays,
        yearActiveDays
      },
      costs: {
        allTime: {
          reference: refAll,
          identified: identifiedAll,
          hybrid: buildHybrid(identifiedAll, refAll)
        },
        period: {
          reference: refPeriod,
          identified: identifiedPeriod,
          hybrid: buildHybrid(identifiedPeriod, refPeriod)
        }
      }
    };
  };

  const analyticsBySource = {
    all: buildSourceAnalytics('all'),
    desktop: buildSourceAnalytics('desktop'),
    cli: buildSourceAnalytics('cli')
  };

  const desktopConvCount = Math.max(desktopJobs.length, desktopSessionFiles);
  const cliConvCount = Math.max(cliJobs.length, cliSessionFiles);
  const totalConversations = desktopConvCount + cliConvCount;

  const currentPeriod = {
    key: monthPrefix,
    label: `${monthPrefix} 自然月`
  };
  const sources = {
    all: { conversationsCount: totalConversations, transcriptsCount: allJobs.length },
    desktop: { conversationsCount: desktopConvCount, transcriptsCount: desktopJobs.length },
    cli: { dirExists: existsSync(cliDir), conversationsCount: cliConvCount, transcriptsCount: cliJobs.length }
  };
  const { updatedAt: _planUpdatedAt, ...stablePlan } = effectivePlan || {};
  const { updatedAt: _uiUpdatedAt, ...stableUiPrefs } = rawSettings.uiPreferences || {};
  const etag = computeContentEtag('hist', {
    todayKey,
    currentPeriod,
    firstUseDate,
    sources,
    planStatus: stablePlan,
    modelQuotas: host.quotas || [],
    quotaState: toStableQuotaState(host.quotaStatus),
    uiPreferences: stableUiPrefs,
    dailyMapBySource: dailyBySource,
    analyticsBySource
  });

  const result = {
    ok: true,
    etag,
    updatedAt: new Date().toISOString(),
    todayKey,
    currentPeriod,
    firstUseDate,
    sources,
    planStatus: effectivePlan,
    modelQuotas: host.quotas,
    quotaStatus: host.quotaStatus,
    uiPreferences: rawSettings.uiPreferences || {},
    dailyMapBySource: dailyBySource,
    analyticsBySource,
    presets: {
      regions: SUBSCRIPTION_REGIONS_PRESET,
      acquisitions: SUBSCRIPTION_ACQUISITION_PRESETS,
      currencies: Object.entries(CURRENCY_SYMBOLS).map(([code, symbol]) => ({ code, symbol }))
    }
  };

  if (resultBuiltSeq === genBackfillDataSeq) {
    cachedHistoryResult = {
      at: nowMs,
      hostSig: host.sig,
      persistPath: curPersistPath,
      lsKey: curLsKey,
      etag,
      data: result
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Safe CLI Terminal Launcher (macOS / Linux / Windows)
// ---------------------------------------------------------------------------

function resolveCliBinary() {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    const winCandidates = [
      join(localAppData, 'Programs', 'Antigravity', 'bin', 'agy.cmd'),
      join(localAppData, 'Programs', 'Antigravity', 'bin', 'agy.exe'),
      join(homedir(), '.local', 'bin', 'agy.cmd'),
      join(homedir(), '.local', 'bin', 'agy.exe'),
      join(appData, 'npm', 'agy.cmd')
    ];
    for (const p of winCandidates) {
      if (existsSync(p)) return p;
    }
    try {
      const out = execFileSync('where.exe', ['agy'], { encoding: 'utf-8', timeout: 1500 })
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean);
      if (out && existsSync(out)) return out;
    } catch {}
    return null;
  }

  const candidates = [
    '/opt/homebrew/bin/agy',
    '/usr/local/bin/agy',
    '/usr/bin/agy',
    join(homedir(), '.local', 'bin', 'agy'),
    join(homedir(), '.antigravity', 'bin', 'agy'),
    '/Applications/Antigravity.app/Contents/Resources/app/bin/agy'
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  try {
    const out = execFileSync('which', ['agy'], { encoding: 'utf-8', timeout: 1500 }).trim();
    if (out && existsSync(out)) return out;
  } catch {}
  return null;
}

export async function launchCliTerminal(payload = {}) {
  let targetDir = homedir();
  const candidates = [payload.workspacePath];
  if (payload.workspaceUri && String(payload.workspaceUri).startsWith('file://')) {
    try { candidates.unshift(fileURLToPath(payload.workspaceUri)); } catch {}
  }
  for (const c of candidates) {
    if (c && typeof c === 'string') {
      try {
        const resolved = resolve(c);
        if (existsSync(resolved) && statSync(resolved).isDirectory()) {
          targetDir = resolved;
          break;
        }
      } catch {}
    }
  }

  const agyBin = resolveCliBinary();

  if (process.platform === 'darwin') {
    const script = [
      'on run argv',
      '  set targetDir to item 1 of argv',
      '  set agyBin to item 2 of argv',
      '  if agyBin is not "" then',
      '    set shellCmd to "cd " & quoted form of targetDir & " && clear && " & quoted form of agyBin',
      '  else',
      '    set shellCmd to "cd " & quoted form of targetDir & " && clear && echo " & quoted form of "已进入当前工作区目录；当前系统尚未安装 agy CLI 命令。"',
      '  end if',
      '  tell application "Terminal"',
      '    activate',
      '    do script shellCmd',
      '  end tell',
      'end run'
    ].join('\n');

    return new Promise((resolvePromise) => {
      execFile('/usr/bin/osascript', ['-e', script, targetDir, agyBin || ''], { timeout: 6000 }, (err) => {
        if (err) {
          resolvePromise({ ok: false, error: `打开终端失败：${err.message}` });
        } else {
          resolvePromise({
            ok: true,
            agyInstalled: Boolean(agyBin),
            workspacePath: targetDir,
            message: agyBin
              ? `已在 Terminal 启动 agy CLI（${basename(targetDir)}）`
              : `已在 Terminal 打开工作区 ${basename(targetDir)}（本机暂未安装 agy CLI）`
          });
        }
      });
    });
  }

  if (process.platform === 'win32') {
    return new Promise((resolvePromise) => {
      const innerCmd = agyBin ? `"${agyBin}"` : 'echo 当前系统尚未安装 agy CLI 命令。';
      execFile('cmd.exe', ['/c', 'start', 'Antigravity CLI', '/D', targetDir, 'cmd.exe', '/k', innerCmd], { timeout: 6000 }, (err) => {
        if (err) {
          resolvePromise({ ok: false, error: `打开终端失败：${err.message}` });
        } else {
          resolvePromise({
            ok: true,
            agyInstalled: Boolean(agyBin),
            workspacePath: targetDir,
            message: agyBin
              ? `已在终端启动 agy CLI（${basename(targetDir)}）`
              : `已在终端打开工作区 ${basename(targetDir)}（本机暂未安装 agy CLI）`
          });
        }
      });
    });
  }

  if (process.platform === 'linux') {
    const terms = [
      ['x-terminal-emulator', ['--working-directory', targetDir, '-e', agyBin || 'bash']],
      ['gnome-terminal', ['--working-directory', targetDir, '--', agyBin || 'bash']],
      ['konsole', ['--workdir', targetDir, '-e', agyBin || 'bash']],
      ['xfce4-terminal', ['--working-directory', targetDir, '-e', agyBin || 'bash']]
    ];
    for (const [bin, args] of terms) {
      try {
        const found = execFileSync('which', [bin], { encoding: 'utf-8', timeout: 1000 }).trim();
        if (found) {
          execFile(found, args, { cwd: targetDir });
          return {
            ok: true,
            agyInstalled: Boolean(agyBin),
            workspacePath: targetDir,
            message: agyBin
              ? `已在终端启动 agy CLI（${basename(targetDir)}）`
              : `已在终端打开工作区 ${basename(targetDir)}（本机暂未安装 agy CLI）`
          };
        }
      } catch {}
    }
  }

  return {
    ok: false,
    error: '当前环境未检测到可用桌面终端模拟器，请直接在终端运行 agy。'
  };
}
