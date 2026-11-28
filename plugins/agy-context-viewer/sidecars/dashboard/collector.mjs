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
  readSync,
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
  MODEL_DISPLAY_NAMES,
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
import {
  classifyDiagnosticEventText,
  extractProjectNameFromUris,
  isSqliteAvailable,
  readConversationLatestGenSignal,
  readConversationSqliteSignals,
  readConversationSummariesIndex,
  sanitizeSqliteText,
  TOKEN_CATEGORIES
} from './sqlite_reader.mjs';

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
const TRANSCRIPT_HIST_CACHE_VERSION = 2;
const transcriptHistCache = new Map();  // filePath -> { cacheVersion, size, mtimeMs, firstDate, rawRecords, stepsNeedingGen }
const convGenMetaCache = new Map();     // convId -> { at, generatorList, callsByStep }
const lsGenMissCache = new Map();       // convId -> { lsAddr, size, mtimeMs, at, settled }
const recentConvMetaCache = new Map();  // logPath -> { key, title, lastContextTokens, turnsCount, isSubagent, lastUserInputAtMs, lastModelTurnAtMs, lastStepType, hasUserInput }
const subagentSummaryCache = new Map(); // logPath -> { key, summary }
const swarmMembersCache = new Map();    // filePath -> { key, memberIds }
const gitBranchCache = new Map();       // dirPath -> { at, branch }
const recentConvSignalsMap = new WeakMap(); // recentItem -> internal activity/workspace signals
let cliHistoryCache = { path: '', size: -1, mtimeMs: -1, parsedOffset: 0, byConvId: new Map() };
let cliLastConvsCache = { path: '', size: -1, mtimeMs: -1, byWorkspace: new Map(), byConvId: new Map() };
const ACTIVE_WORK_WINDOW_MS = 180_000;
let genStepModelsCache = { path: '', mtimeMs: -1, size: -1, data: null };
let hostDiskCacheMeta = { path: '', mtimeMs: -1, size: -1, data: null };
let activeConvGenDiskCache = { path: '', mtimeMs: -1, size: -1, data: null };
let inFlightHostStatus = null;
const inFlightGenMeta = new Map();
const observedActivityByRoot = new Map();
const HOST_STATUS_DISK_CACHE_VERSION = 1;
const HOST_STATUS_CACHE_MAX_ENTRIES = 4;
const ACTIVE_CONV_GEN_DISK_CACHE_VERSION = 2;
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
  if (process.env.AG_CLI_DIR) return process.env.AG_CLI_DIR;
  const appDataDir = String(process.env.ANTIGRAVITY_APP_DATA_DIR || '').trim();
  if (appDataDir && basename(appDataDir).toLowerCase() === 'antigravity-cli') {
    return appDataDir;
  }
  return join(homedir(), '.gemini', 'antigravity-cli');
}

export function findIdeDataDir() {
  if (process.env.AG_IDE_DIR) return process.env.AG_IDE_DIR;
  if (process.env.AG_DIR) {
    const defaultAgDir = join(homedir(), '.gemini', 'antigravity');
    if (resolve(process.env.AG_DIR) !== resolve(defaultAgDir)) {
      return join(dirname(process.env.AG_DIR), 'antigravity-ide');
    }
  }
  return join(homedir(), '.gemini', 'antigravity-ide');
}

export function isCliRuntimeEnv() {
  const lsVer = String(process.env.ANTIGRAVITY_LS_VERSION || '').trim().toLowerCase();
  if (lsVer.startsWith('cli')) return true;
  const appDataBase = basename(String(process.env.ANTIGRAVITY_APP_DATA_DIR || '').trim()).toLowerCase();
  if (appDataBase === 'antigravity-cli') return true;
  if (!process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    const exeBase = basename(String(process.env.ANTIGRAVITY_AGENTAPI_EXE || '').trim()).toLowerCase();
    if (exeBase === 'agy' || exeBase === 'agy.exe') return true;
  }
  return false;
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

export function parseDurationSec(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const hasSeconds = value.seconds !== undefined && value.seconds !== null;
    const hasNanos = value.nanos !== undefined && value.nanos !== null;
    if (!hasSeconds && !hasNanos) return null;
    const s = hasSeconds ? Number(value.seconds) : 0;
    const ns = hasNanos ? Number(value.nanos) : 0;
    if (!Number.isFinite(s) || !Number.isFinite(ns) || s < 0 || ns < 0) return null;
    const total = s + ns / 1e9;
    return Number.isFinite(total) && total >= 0 ? total : null;
  }
  const str = String(value).trim();
  if (!str) return null;
  const msMatch = str.match(/^([\d.]+)\s*ms$/i);
  if (msMatch) {
    const ms = parseFloat(msMatch[1]);
    return Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null;
  }
  const sMatch = str.match(/^([\d.]+)\s*s?$/i);
  if (!sMatch) return null;
  const n = parseFloat(sMatch[1]);
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
  return `${findAppDataDir()}|${findIdeDataDir()}|${findCliDataDir()}`;
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
// Zero-Quota-RPC Guard & Settings Helpers
// ---------------------------------------------------------------------------

const QUOTA_RPC_METHODS = new Set(['GetUserStatus', 'RetrieveUserQuotaSummary']);

function isEnvZeroQuotaRpcForced() {
  const raw = String(process.env.AGY_CV_ZERO_QUOTA_RPC || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

function resetQuotaRuntimeCaches() {
  cachedHostStatus = {
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
  lastGoodHostData = null;
  cachedHistoryResult.at = 0;
  try { scanSnapCache.clear(); } catch {}
  try {
    const snapPath = join(getPluginStateDir(), 'statusline_snap_v1.json');
    if (existsSync(snapPath)) unlinkSync(snapPath);
  } catch {}
}

export function getQuotaRpcConfig() {
  const settings = loadRawSettings();
  const persistedEnabled = settings.uiPreferences?.quotaRpcEnabled !== false;
  const forcedByEnv = isEnvZeroQuotaRpcForced();
  const enabled = forcedByEnv ? false : persistedEnabled;
  return {
    enabled,
    zeroQuotaRpc: !enabled,
    forcedByEnv,
    persistedEnabled
  };
}

export function getQuotaRpcEnabled() {
  return getQuotaRpcConfig().enabled;
}

export function setQuotaRpcEnabled(enabled) {
  const wantEnabled = Boolean(enabled);
  const settings = loadRawSettings();
  settings.uiPreferences = {
    ...settings.uiPreferences,
    quotaRpcEnabled: wantEnabled,
    updatedAt: new Date().toISOString()
  };
  writeJsonAtomic(getSettingsPath(), settings);
  resetQuotaRuntimeCaches();
  return getQuotaRpcConfig();
}

// ---------------------------------------------------------------------------
// Official Language Server Connect RPC (uses env vars injected by Sidecar SDK)
// ---------------------------------------------------------------------------

export function callLanguageServerWithStatus(method, payload = {}, timeoutMs = 4500, options = {}) {
  if (QUOTA_RPC_METHODS.has(method) && !getQuotaRpcEnabled()) {
    return Promise.resolve({ data: null, errorCode: 'QUOTA_RPC_DISABLED' });
  }
  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  const signal = options?.signal || null;
  if (!lsAddr || !csrf || signal?.aborted) {
    return Promise.resolve({ data: null, errorCode: signal?.aborted ? 'ABORTED' : 'NO_CONFIG' });
  }

  const safeTimeoutMs = Math.max(1, Number(timeoutMs) || 4500);
  const useNoKeepAlive = Boolean(options?.unrefSocket || options?.noKeepAlive);

  return new Promise((resolvePromise) => {
    let settled = false;
    let req = null;
    let hardTimer = null;
    const onAbort = () => {
      try { req?.destroy(); } catch {}
      finish({ data: null, errorCode: 'ABORTED' });
    };
    const finish = (val) => {
      if (!settled) {
        settled = true;
        if (hardTimer) {
          clearTimeout(hardTimer);
          hardTimer = null;
        }
        if (signal) {
          try { signal.removeEventListener('abort', onAbort); } catch {}
        }
        resolvePromise(val);
      }
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    hardTimer = setTimeout(() => {
      try { req?.destroy(); } catch {}
      finish({ data: null, errorCode: 'ETIMEDOUT' });
    }, safeTimeoutMs);
    hardTimer.unref?.();

    try {
      const targetUrl = new URL(`http://${lsAddr}/exa.language_server_pb.LanguageServerService/${method}`);
      const bodyStr = JSON.stringify(payload);
      req = http.request(
        {
          hostname: targetUrl.hostname,
          port: targetUrl.port,
          path: targetUrl.pathname,
          method: 'POST',
          ...(useNoKeepAlive ? { agent: false } : {}),
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
              finish({ data: null, errorCode: 'RESPONSE_TOO_LARGE' });
              return;
            }
            chunks.push(chunk);
          });
          res.on('error', (err) => {
            finish({ data: null, errorCode: String(err?.code || 'ERR_RESPONSE') });
          });
          res.on('end', () => {
            if (res.statusCode !== 200) {
              finish({ data: null, errorCode: `HTTP_${res.statusCode}` });
              return;
            }
            try {
              finish({ data: JSON.parse(Buffer.concat(chunks).toString('utf-8')), errorCode: '' });
            } catch {
              finish({ data: null, errorCode: 'INVALID_JSON' });
            }
          });
        }
      );
      if (options?.unrefSocket) {
        req.on('socket', (sock) => {
          sock.unref?.();
        });
      }
      req.setTimeout(safeTimeoutMs, () => {
        req.destroy();
        finish({ data: null, errorCode: 'ETIMEDOUT' });
      });
      req.on('error', (err) => finish({ data: null, errorCode: String(err?.code || 'ERR_NETWORK') }));
      req.end(bodyStr);
    } catch (err) {
      finish({ data: null, errorCode: String(err?.code || 'ERR_REQUEST') });
    }
  });
}

async function callLanguageServer(method, payload = {}, timeoutMs = 4500, options = {}) {
  const res = await callLanguageServerWithStatus(method, payload, timeoutMs, options);
  return res.data;
}

function makeQuotaStatus(state, opts = {}) {
  return {
    state,
    stale: Boolean(opts.stale),
    summaryStale: Boolean(opts.summaryStale),
    source: opts.source || 'none',
    lastSuccessAt: opts.lastSuccessAt || null,
    summaryLastSuccessAt: opts.summaryLastSuccessAt || null,
    reason: opts.reason || '',
    ...(opts.errorCode ? { errorCode: opts.errorCode } : {})
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

// ---------------------------------------------------------------------------
// Quota Pool Token Capacity EMA Calibration
// ---------------------------------------------------------------------------

const QUOTA_CAL_TTL_5H_MS = 7 * 24 * 3600 * 1000;
const QUOTA_CAL_TTL_WEEKLY_MS = 21 * 24 * 3600 * 1000;
const QUOTA_CAL_MIN_DELTA_F = 0.02;
const QUOTA_CAL_MIN_DELTA_TOK = 2000;
const QUOTA_CAL_MIN_TOTAL = 50_000;
const QUOTA_CAL_MAX_TOTAL = 500_000_000;
let quotaCalibrationCache = { path: '', mtimeMs: -1, size: -1, data: null };

export function getQuotaCalibrationPath() {
  return join(getPluginStateDir(), 'quota_capacity_cal_v1.json');
}

function loadQuotaCalibrationStore(calPath = getQuotaCalibrationPath(), forMutation = false) {
  const p = calPath || getQuotaCalibrationPath();
  let st = null;
  try {
    if (existsSync(p)) st = statSync(p);
  } catch {}
  const stMtime = st ? st.mtimeMs : -1;
  const stSize = st ? st.size : -1;
  if (
    quotaCalibrationCache.path === p &&
    quotaCalibrationCache.mtimeMs === stMtime &&
    quotaCalibrationCache.size === stSize &&
    quotaCalibrationCache.data
  ) {
    return forMutation ? structuredClone(quotaCalibrationCache.data) : quotaCalibrationCache.data;
  }
  const raw = readJsonSafe(p, { version: 1, entries: {} });
  const entries = (
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    raw.entries &&
    typeof raw.entries === 'object' &&
    !Array.isArray(raw.entries)
  )
    ? raw.entries
    : {};
  const data = { version: 1, entries };
  quotaCalibrationCache = { path: p, mtimeMs: stMtime, size: stSize, data };
  return forMutation ? structuredClone(data) : data;
}

function formatQuotaCalibrationResult(entry, remainingFraction) {
  if (!entry || typeof entry !== 'object') return null;
  const hasEma = typeof entry.emaTotalTokens === 'number' && Number.isFinite(entry.emaTotalTokens) && entry.emaTotalTokens > 0;
  const diverged = Boolean(entry.diverged);
  if (!hasEma && !diverged) return null;
  const samples = Number(entry.samples) > 0 ? Number(entry.samples) : 0;
  const hasFrac = typeof remainingFraction === 'number' && Number.isFinite(remainingFraction) && remainingFraction >= 0 && remainingFraction <= 1;
  return {
    estTotalTokens: hasEma ? entry.emaTotalTokens : null,
    estRemainingTokens: (hasEma && hasFrac)
      ? Math.max(0, Math.round(entry.emaTotalTokens * Math.max(0, Math.min(1, remainingFraction))))
      : null,
    samples,
    updatedAt: entry.updatedAt || null,
    diverged,
    confidence: samples >= 3 ? 'high' : (samples >= 1 ? 'low' : 'none')
  };
}

export function updateQuotaCapacityCalibration(store, observation, nowMs = Date.now()) {
  if (!store || typeof store !== 'object') {
    return { changed: false, calibration: null };
  }
  if (!store.entries || typeof store.entries !== 'object' || Array.isArray(store.entries)) {
    store.entries = {};
  }
  if (store.version == null) {
    store.version = 1;
  }
  const { poolId, windowKey, remainingFraction, totalTokens, resetTime } = observation || {};
  const safePoolId = typeof poolId === 'string'
    ? poolId.trim()
    : (typeof poolId === 'number' && Number.isFinite(poolId) ? String(poolId) : '');
  if (
    !safePoolId ||
    (windowKey !== '5h' && windowKey !== 'weekly' && windowKey !== 'base') ||
    !Number.isFinite(remainingFraction) ||
    remainingFraction < 0 ||
    remainingFraction > 1 ||
    !Number.isFinite(totalTokens) ||
    totalTokens < 0
  ) {
    return { changed: false, calibration: null };
  }

  const tsNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const key = `${safePoolId}|${windowKey}`;
  let entry = store.entries[key];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    entry = {};
    store.entries[key] = entry;
  }
  const ttlMs = windowKey === 'weekly' ? QUOTA_CAL_TTL_WEEKLY_MS : QUOTA_CAL_TTL_5H_MS;
  let changed = false;

  if (entry.emaTotalTokens > 0 && entry.updatedAt && (tsNow - entry.updatedAt > ttlMs)) {
    entry.emaTotalTokens = null;
    entry.samples = 0;
    entry.updatedAt = null;
    changed = true;
  }

  const prevObs = entry.lastObs && typeof entry.lastObs === 'object' ? entry.lastObs : null;
  const nextResetTime = resetTime || null;
  if (
    prevObs && (
      (nextResetTime && prevObs.resetTime && nextResetTime !== prevObs.resetTime) ||
      remainingFraction > prevObs.fraction + 0.02 ||
      totalTokens < prevObs.totalTokens
    )
  ) {
    entry.lastObs = { fraction: remainingFraction, totalTokens, ts: tsNow, resetTime: nextResetTime };
    entry.diverged = false;
    changed = true;
  } else if (prevObs) {
    const deltaF = prevObs.fraction - remainingFraction;
    const deltaTok = totalTokens - prevObs.totalTokens;
    if ((deltaF >= 0.03 && deltaTok < 500) || (deltaF >= 0.15 && deltaTok < 2000)) {
      entry.diverged = true;
      entry.divergedAt = tsNow;
      entry.lastObs = { fraction: remainingFraction, totalTokens, ts: tsNow, resetTime: nextResetTime };
      changed = true;
    } else if (deltaF >= QUOTA_CAL_MIN_DELTA_F && deltaTok >= QUOTA_CAL_MIN_DELTA_TOK && deltaTok <= 200_000_000) {
      const sampleTotal = deltaTok / deltaF;
      if (sampleTotal >= QUOTA_CAL_MIN_TOTAL && sampleTotal <= QUOTA_CAL_MAX_TOTAL) {
        entry.emaTotalTokens = entry.emaTotalTokens > 0
          ? Math.round(entry.emaTotalTokens * 0.6 + sampleTotal * 0.4)
          : Math.round(sampleTotal);
        entry.samples = (entry.samples || 0) + 1;
        entry.updatedAt = tsNow;
        entry.diverged = false;
      }
      entry.lastObs = { fraction: remainingFraction, totalTokens, ts: tsNow, resetTime: nextResetTime };
      changed = true;
    }
  } else {
    entry.lastObs = { fraction: remainingFraction, totalTokens, ts: tsNow, resetTime: nextResetTime };
    changed = true;
  }

  return {
    changed,
    calibration: formatQuotaCalibrationResult(entry, remainingFraction)
  };
}

export function buildQuotaCalibrationSnapshot(store, poolId, windowKey, remainingFraction, nowMs = Date.now()) {
  if (!store || typeof store !== 'object' || !store.entries || typeof store.entries !== 'object') {
    return null;
  }
  const safePoolId = typeof poolId === 'string'
    ? poolId.trim()
    : (typeof poolId === 'number' && Number.isFinite(poolId) ? String(poolId) : '');
  if (!safePoolId || (windowKey !== '5h' && windowKey !== 'weekly' && windowKey !== 'base')) {
    return null;
  }
  if (
    remainingFraction !== null &&
    remainingFraction !== undefined &&
    (!Number.isFinite(remainingFraction) || remainingFraction < 0 || remainingFraction > 1)
  ) {
    return null;
  }
  const entry = store.entries[`${safePoolId}|${windowKey}`];
  if (!entry || typeof entry !== 'object') return null;
  const tsNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const ttlMs = windowKey === 'weekly' ? QUOTA_CAL_TTL_WEEKLY_MS : QUOTA_CAL_TTL_5H_MS;
  const expired = Boolean(entry.emaTotalTokens > 0 && entry.updatedAt && (tsNow - entry.updatedAt > ttlMs));
  const viewEntry = expired
    ? { ...entry, emaTotalTokens: null, samples: 0, updatedAt: null }
    : entry;
  return formatQuotaCalibrationResult(viewEntry, remainingFraction);
}

export function computePoolTokenTotals(byModel = [], modelConfigs = [], quotaSummaryGroups = []) {
  const totals = new Map();
  if (!Array.isArray(byModel) || !byModel.length || !Array.isArray(modelConfigs) || !modelConfigs.length) {
    return totals;
  }
  for (const m of byModel) {
    if (!m || typeof m !== 'object') continue;
    const tokens = Number(m.tokens || 0);
    if (!Number.isFinite(tokens) || tokens <= 0) continue;
    const primaryTarget = (m.modelKey && !String(m.modelKey).startsWith('unpriced:') && m.modelKey !== 'unidentified')
      ? m.modelKey
      : (m.displayName || m.modelKey);
    let q = resolveModelQuota(primaryTarget, modelConfigs, quotaSummaryGroups);
    if (!q && m.displayName && primaryTarget !== m.displayName) {
      q = resolveModelQuota(m.displayName, modelConfigs, quotaSummaryGroups);
    }
    if (q?.poolId) {
      totals.set(q.poolId, (totals.get(q.poolId) || 0) + tokens);
    }
  }
  return totals;
}

export function enrichQuotasWithCalibration(quotas, poolTokenTotals = null, opts = {}) {
  if (!Array.isArray(quotas) || !quotas.length) return [];
  const calPath = getQuotaCalibrationPath();
  const nowMs = Number(opts.nowMs) > 0 ? Number(opts.nowMs) : Date.now();
  const hasTotalsObj = poolTokenTotals instanceof Map
    ? poolTokenTotals.size > 0
    : Boolean(poolTokenTotals && typeof poolTokenTotals === 'object' && Object.keys(poolTokenTotals).length > 0);
  const store = loadQuotaCalibrationStore(calPath, hasTotalsObj);
  let anyChanged = false;

  const enriched = quotas.map((pool) => {
    if (!pool || typeof pool !== 'object') return pool;
    const rawTok = poolTokenTotals instanceof Map
      ? poolTokenTotals.get(pool.id)
      : (poolTokenTotals && typeof poolTokenTotals === 'object' ? poolTokenTotals[pool.id] : undefined);
    const hasPoolTokens = typeof rawTok === 'number' && Number.isFinite(rawTok) && rawTok >= 0;

    const resolveWin = (windowKey, remainingFraction, resetTime) => {
      if (hasPoolTokens) {
        const res = updateQuotaCapacityCalibration(
          store,
          { poolId: pool.id, windowKey, remainingFraction, totalTokens: rawTok, resetTime },
          nowMs
        );
        if (res.changed) anyChanged = true;
        return res.calibration;
      }
      return buildQuotaCalibrationSnapshot(store, pool.id, windowKey, remainingFraction, nowMs);
    };

    const nextPool = { ...pool };
    if (pool.fiveHour && typeof pool.fiveHour === 'object') {
      nextPool.fiveHour = {
        ...pool.fiveHour,
        calibration: resolveWin('5h', pool.fiveHour.remainingFraction, pool.fiveHour.resetTime)
      };
    }
    if (pool.weekly && typeof pool.weekly === 'object') {
      nextPool.weekly = {
        ...pool.weekly,
        calibration: resolveWin('weekly', pool.weekly.remainingFraction, pool.weekly.resetTime)
      };
    }
    nextPool.calibration = resolveWin(
      'base',
      pool.baseRemainingFraction ?? pool.remainingFraction,
      pool.baseResetTime ?? pool.resetTime
    );
    return nextPool;
  });

  if (anyChanged && opts.persist !== false) {
    try {
      writeJsonAtomic(calPath, store);
      let st = null;
      try { st = statSync(calPath); } catch {}
      quotaCalibrationCache = {
        path: calPath,
        mtimeMs: st ? st.mtimeMs : -1,
        size: st ? st.size : -1,
        data: structuredClone(store)
      };
    } catch {}
  }

  return enriched;
}

function attachCalibrationToModelQuota(modelQuota, enrichedQuotas, nowMs = Date.now()) {
  if (!modelQuota || typeof modelQuota !== 'object' || !modelQuota.poolId) return modelQuota;
  const matchedPool = Array.isArray(enrichedQuotas)
    ? enrichedQuotas.find((p) => p && p.id === modelQuota.poolId)
    : null;
  const store = matchedPool ? null : loadQuotaCalibrationStore(getQuotaCalibrationPath(), false);
  const baseCal = matchedPool
    ? (matchedPool.calibration ?? null)
    : buildQuotaCalibrationSnapshot(
        store,
        modelQuota.poolId,
        'base',
        modelQuota.baseRemainingFraction ?? modelQuota.remainingFraction,
        nowMs
      );
  const next = { ...modelQuota, calibration: baseCal };
  if (modelQuota.fiveHour && typeof modelQuota.fiveHour === 'object') {
    next.fiveHour = {
      ...modelQuota.fiveHour,
      calibration: matchedPool?.fiveHour
        ? (matchedPool.fiveHour.calibration ?? null)
        : buildQuotaCalibrationSnapshot(store, modelQuota.poolId, '5h', modelQuota.fiveHour.remainingFraction, nowMs)
    };
  }
  if (modelQuota.weekly && typeof modelQuota.weekly === 'object') {
    next.weekly = {
      ...modelQuota.weekly,
      calibration: matchedPool?.weekly
        ? (matchedPool.weekly.calibration ?? null)
        : buildQuotaCalibrationSnapshot(store, modelQuota.poolId, 'weekly', modelQuota.weekly.remainingFraction, nowMs)
    };
  }
  return next;
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

function hydrateHostDiskEntry(diskEntry) {
  if (!diskEntry || typeof diskEntry !== 'object') return null;
  const diskModelConfigs = Array.isArray(diskEntry.modelConfigs) ? diskEntry.modelConfigs : [];
  const diskSummaryGroups = Array.isArray(diskEntry.quotaSummaryGroups) ? diskEntry.quotaSummaryGroups : [];
  const hasHydratableConfigs = diskModelConfigs.length > 0;
  const dynamicModelMap = hasHydratableConfigs
    ? { ...(diskEntry.dynamicModelMap || {}), ...buildDynamicModelMap(diskModelConfigs) }
    : (diskEntry.dynamicModelMap || {});
  const quotas = hasHydratableConfigs
    ? groupModelQuotas(diskModelConfigs, diskSummaryGroups)
    : (Array.isArray(diskEntry.quotas) ? diskEntry.quotas : []);
  return {
    plan: diskEntry.plan || parseUserPlanStatus(null),
    modelConfigs: diskModelConfigs,
    quotaSummaryGroups: diskSummaryGroups,
    dynamicModelMap,
    quotas,
    sig: diskEntry.sig || 'host:disk'
  };
}

function buildOutageFallbackHostStatus({
  lsKey,
  fetchedAtMs,
  snapshot,
  source,
  summaryStale,
  errCode,
  isSandboxBlocked
}) {
  const cachedAtMs = Date.parse(snapshot.fetchedAt || '') || 0;
  const ageMs = cachedAtMs > 0 ? Math.max(0, fetchedAtMs - cachedAtMs) : 0;
  const crossed = hasCrossedQuotaResetBoundary(snapshot.quotas, cachedAtMs, fetchedAtMs);
  const quotaFresh = !crossed && ageMs <= 30 * 60_000;
  const isConnRefused = errCode === 'ECONNREFUSED' || errCode === 'ECONNRESET';
  const quotaStatus = quotaFresh
    ? makeQuotaStatus('stale', {
        stale: true,
        summaryStale,
        source,
        lastSuccessAt: snapshot.fetchedAt || null,
        summaryLastSuccessAt: snapshot.summaryFetchedAt || null,
        reason: isSandboxBlocked
          ? '受当前运行环境沙箱限制无法连接本地语言服务，当前展示上次成功同步数据'
          : isConnRefused
            ? '原宿主连接已断开，当前展示上次成功同步数据（重启独立窗口可重新绑定）'
            : '语言服务连接失败，当前展示上次成功同步数据',
        errorCode: errCode
      })
    : makeQuotaStatus('error', {
        stale: false,
        summaryStale: false,
        source: 'none',
        lastSuccessAt: snapshot.fetchedAt || null,
        summaryLastSuccessAt: snapshot.summaryFetchedAt || null,
        reason: isSandboxBlocked
          ? '沙箱限制无法连接本地语言服务（EPERM），请在外部终端运行 agy-context 查看实时配额与窗口上限'
          : crossed
            ? (isConnRefused
                ? '原宿主语言服务已退出且配额已过重置时间，请重启独立窗口重新绑定宿主'
                : '配额已过重置时间且语言服务请求失败，暂未获取到最新余量')
            : (isConnRefused
                ? '原宿主语言服务已退出，请重启独立窗口重新绑定宿主'
                : '语言服务请求失败，暂未获取到配额数据'),
        errorCode: errCode
      });
  const { updatedAt: _planUpdatedAt, ...stablePlan } = snapshot.plan || {};
  const quotas = quotaFresh ? snapshot.quotas : [];
  const sig = computeContentEtag('host', {
    plan: stablePlan,
    quotas,
    dynamicModelMap: snapshot.dynamicModelMap,
    quotaState: toStableQuotaState(quotaStatus)
  });
  return {
    at: fetchedAtMs,
    lsKey,
    sig,
    raw: null,
    plan: snapshot.plan,
    quotas,
    modelConfigs: snapshot.modelConfigs,
    quotaSummaryGroups: snapshot.quotaSummaryGroups,
    dynamicModelMap: snapshot.dynamicModelMap,
    quotaStatus
  };
}

function readLatestDiskHostFallback(nowMs) {
  const diskCache = loadHostStatusDiskCache();
  const entries = Object.values(diskCache?.entries || {})
    .filter((e) => e && typeof e === 'object' && e.at)
    .sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
  const diskEntry = entries[0] || null;
  const hydrated = hydrateHostDiskEntry(diskEntry);
  if (!hydrated) return null;
  const ageMs = Math.max(0, nowMs - Number(diskEntry.at || 0));
  const crossed = hasCrossedQuotaResetBoundary(hydrated.quotas, diskEntry.at, nowMs);
  const quotaFresh = ageMs <= 30 * 60_000 && !crossed;
  return { diskEntry, hydrated, quotaFresh };
}

async function getHostUserStatus(force = false, options = {}) {
  const nowMs = Number(options.nowMs) || Date.now();
  const quotaRpcCfg = getQuotaRpcConfig();
  if (!quotaRpcCfg.enabled) {
    const reason = quotaRpcCfg.forcedByEnv
      ? '已通过环境变量 AGY_CV_ZERO_QUOTA_RPC=1 强制开启零额度 RPC 模式（纯本地统计）'
      : '已开启零额度 RPC 模式（不向宿主请求配额与账号状态，仅使用本地日志与 SQLite 统计）';
    const quotaStatus = makeQuotaStatus('disabled', {
      stale: false,
      summaryStale: false,
      source: 'disabled',
      lastSuccessAt: null,
      summaryLastSuccessAt: null,
      reason,
      errorCode: 'QUOTA_RPC_DISABLED'
    });
    return {
      at: nowMs,
      lsKey: '',
      sig: quotaRpcCfg.forcedByEnv ? 'quota-rpc-disabled:env' : 'quota-rpc-disabled',
      raw: null,
      plan: parseUserPlanStatus(null),
      quotas: [],
      modelConfigs: [],
      quotaSummaryGroups: [],
      dynamicModelMap: {},
      quotaStatus
    };
  }
  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!lsAddr || !csrf) {
    if (options.allowDiskCacheWithoutLs) {
      const fb = readLatestDiskHostFallback(nowMs);
      if (fb) {
        const { diskEntry, hydrated, quotaFresh } = fb;
        const quotaStatus = quotaFresh
          ? makeQuotaStatus('stale', {
              stale: true,
              summaryStale: Boolean(diskEntry.quotaStatus?.summaryStale),
              source: 'disk_cache',
              lastSuccessAt: diskEntry.fetchedAt || null,
              summaryLastSuccessAt: diskEntry.summaryFetchedAt || null,
              reason: '离线缓存配额快照'
            })
          : makeQuotaStatus('unavailable', {
              source: 'none',
              reason: '未连接宿主语言服务'
            });
        return {
          at: Number(diskEntry.at || nowMs),
          lsKey: '',
          sig: `${hydrated.sig}:${quotaFresh ? 'disk' : 'expired'}`,
          raw: null,
          plan: hydrated.plan,
          quotas: quotaFresh ? hydrated.quotas : [],
          modelConfigs: hydrated.modelConfigs,
          quotaSummaryGroups: hydrated.quotaSummaryGroups,
          dynamicModelMap: hydrated.dynamicModelMap,
          quotaStatus
        };
      }
    }
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
  const hydratedDisk = hydrateHostDiskEntry(diskEntry);
  const diskModelConfigs = hydratedDisk?.modelConfigs || [];
  const diskSummaryGroups = hydratedDisk?.quotaSummaryGroups || [];
  const hydratedDynamicModelMap = hydratedDisk?.dynamicModelMap || {};
  const hydratedQuotas = hydratedDisk?.quotas || [];
  let hydratedSig = hydratedDisk?.sig || 'host:disk';
  if (diskModelConfigs.length > 0 && diskEntry?.plan) {
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

  if (options.skipLiveRpc === true) {
    const cachedGood = (lastGoodHostData?.lsKey === lsKey ? lastGoodHostData : null) || diskGoodFallback;
    if (cachedGood) {
      return buildOutageFallbackHostStatus({
        lsKey,
        fetchedAtMs: nowMs,
        snapshot: cachedGood,
        source: lastGoodHostData?.lsKey === lsKey ? 'cache' : 'disk_cache',
        summaryStale: true,
        errCode: 'BUDGET_SKIPPED',
        isSandboxBlocked: false
      });
    }
    if (options.allowDiskCacheWithoutLs) {
      const fb = readLatestDiskHostFallback(nowMs);
      if (fb) {
        const { diskEntry: fbEntry, hydrated: fbHydrated } = fb;
        return buildOutageFallbackHostStatus({
          lsKey,
          fetchedAtMs: nowMs,
          snapshot: {
            ...fbHydrated,
            fetchedAt: fbEntry.fetchedAt || null,
            summaryFetchedAt: fbEntry.summaryFetchedAt || null
          },
          source: 'disk_cache',
          summaryStale: Boolean(fbEntry.quotaStatus?.summaryStale),
          errCode: 'BUDGET_SKIPPED',
          isSandboxBlocked: false
        });
      }
    }
    const plan = parseUserPlanStatus(null);
    const quotaStatus = makeQuotaStatus('unavailable', {
      source: 'none',
      reason: '预算不足已跳过实时语言服务查询'
    });
    const sig = computeContentEtag('host', { quotaState: toStableQuotaState(quotaStatus) });
    return {
      at: nowMs,
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
  }

  if (!force && inFlightHostStatus && !inFlightHostStatus.force && inFlightHostStatus.lsKey === lsKey) {
    return inFlightHostStatus.promise;
  }

  const rpcTimeoutMs = Number(options.rpcTimeoutMs) > 0 ? Number(options.rpcTimeoutMs) : 4500;
  const rpcOpts = {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.unrefSocket ? { unrefSocket: true } : {}),
    ...(options.noKeepAlive ? { noKeepAlive: true } : {})
  };
  const runFetch = (async () => {
    const [statusResp, summaryResp] = await Promise.all([
      callLanguageServerWithStatus('GetUserStatus', {}, rpcTimeoutMs, rpcOpts),
      callLanguageServerWithStatus('RetrieveUserQuotaSummary', {}, rpcTimeoutMs, rpcOpts)
    ]);
    const res = statusResp.data;
    const quotaSummaryRes = summaryResp.data;
    const errCode = statusResp.errorCode || summaryResp.errorCode || '';
    const isSandboxBlocked = errCode === 'EPERM' || errCode === 'EACCES';
    const fetchedAtMs = Number(options.nowMs) || Date.now();
    const cachedGood = (lastGoodHostData?.lsKey === lsKey ? lastGoodHostData : null) || diskGoodFallback;
    if (!res) {
      if (cachedGood) {
        cachedHostStatus = buildOutageFallbackHostStatus({
          lsKey,
          fetchedAtMs,
          snapshot: cachedGood,
          source: 'cache',
          summaryStale: true,
          errCode,
          isSandboxBlocked
        });
        return cachedHostStatus;
      }
      if (options.allowDiskCacheWithoutLs) {
        const fb = readLatestDiskHostFallback(fetchedAtMs);
        if (fb) {
          const { diskEntry, hydrated } = fb;
          cachedHostStatus = buildOutageFallbackHostStatus({
            lsKey,
            fetchedAtMs,
            snapshot: {
              ...hydrated,
              fetchedAt: diskEntry.fetchedAt || null,
              summaryFetchedAt: diskEntry.summaryFetchedAt || null
            },
            source: 'disk_cache',
            summaryStale: Boolean(diskEntry.quotaStatus?.summaryStale),
            errCode,
            isSandboxBlocked
          });
          return cachedHostStatus;
        }
      }
      const plan = parseUserPlanStatus(null);
      const quotaStatus = makeQuotaStatus('error', {
        stale: false,
        summaryStale: false,
        source: 'none',
        lastSuccessAt: null,
        summaryLastSuccessAt: null,
        reason: isSandboxBlocked
          ? '沙箱限制无法连接本地语言服务（EPERM），请在外部终端运行 agy-context 查看实时配额与窗口上限'
          : (errCode === 'ECONNREFUSED' || errCode === 'ECONNRESET')
            ? '原宿主语言服务已退出，请重启独立窗口重新绑定宿主'
            : '语言服务请求失败，暂未获取到配额数据',
        errorCode: errCode
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
  const quotaRpc = getQuotaRpcConfig();
  const host = await getHostUserStatus(false, { background: true, ...options });
  const settings = loadRawSettings();
  const acctKey = host.plan?.accountKey || settings.lastAccountKey || 'default';
  const customPlan = settings.accounts[acctKey] || settings.accounts.default || null;
  const effectivePlan = resolveEffectivePlanStatus(host.plan, customPlan);
  return {
    ok: true,
    planStatus: effectivePlan,
    customPlan,
    quotaRpc,
    uiPreferences: {
      ...(settings.uiPreferences || {}),
      quotaRpcEnabled: quotaRpc.enabled
    },
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
      cliActiveConvId: '',
      cliActiveAt: 0,
      resolvedConvId: '',
      lastBatchViewMs: 0
    };
  }
  return {
    pinnedConvId: CONV_ID_RE.test(data.pinnedConvId || '') ? data.pinnedConvId : '',
    userFocusedConvId: CONV_ID_RE.test(data.userFocusedConvId || '') ? data.userFocusedConvId : '',
    userFocusedAt: Number(data.userFocusedAt || 0),
    cliActiveConvId: CONV_ID_RE.test(data.cliActiveConvId || '') ? data.cliActiveConvId : '',
    cliActiveAt: Number(data.cliActiveAt || 0),
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
  if (typeof patch.cliActiveConvId === 'string') {
    next.cliActiveConvId = CONV_ID_RE.test(patch.cliActiveConvId) ? patch.cliActiveConvId : '';
    next.cliActiveAt = next.cliActiveConvId ? Number(patch.cliActiveAt || Date.now()) : 0;
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

export function noteCliActiveHint(convId, nowMs = Date.now()) {
  const cleanId = String(convId || '').trim();
  if (!CONV_ID_RE.test(cleanId)) return null;
  const cur = readActiveSessionHint();
  const ts = Number(nowMs) || Date.now();
  if (cur.cliActiveConvId === cleanId && (ts - Number(cur.cliActiveAt || 0)) < 2000) {
    return cur;
  }
  return updateActiveSessionHint({
    cliActiveConvId: cleanId,
    cliActiveAt: ts
  });
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

export function getCliSettingsPath() {
  return join(findCliDataDir(), 'settings.json');
}

export function buildCliStatusLineCommand(cliEntryPath) {
  const target = String(cliEntryPath || '').trim();
  return target ? `node "${target}" statusline` : 'agy-context statusline';
}

export function getCliStatusLineConfig() {
  const settingsPath = getCliSettingsPath();
  let settings = null;
  let parseError = '';
  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, 'utf-8');
      if (raw.trim()) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          settings = parsed;
        } else {
          parseError = 'settings.json 根节点必须为 JSON 对象';
        }
      } else {
        settings = {};
      }
    } catch (err) {
      parseError = err?.message || 'settings.json 解析失败';
    }
  }
  const sl = settings?.statusLine && typeof settings.statusLine === 'object' && !Array.isArray(settings.statusLine)
    ? settings.statusLine
    : null;
  const cmd = typeof sl?.command === 'string' ? sl.command : '';
  const enabled = Boolean(sl && sl.enabled !== false && cmd.trim());
  const isContextViewer = Boolean(cmd && /statusline\b/.test(cmd) && /(?:agy-context|context-viewer|cli\.mjs|status\.mjs)/.test(cmd));
  return {
    ok: !parseError,
    settingsPath,
    exists: existsSync(settingsPath),
    configured: Boolean(sl && cmd.trim()),
    enabled,
    isContextViewer,
    stackWithDefault: sl ? sl.stack_with_default !== false : true,
    command: cmd,
    ...(parseError ? { error: parseError } : {})
  };
}

export function setCliStatusLineConfig(actionOrOpts = {}) {
  const opts = typeof actionOrOpts === 'string' ? { action: actionOrOpts } : (actionOrOpts || {});
  const action = String(opts.action || 'install').toLowerCase();
  const stackWithDefault = opts.stackWithDefault !== false;
  const settingsPath = getCliSettingsPath();
  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, 'utf-8');
      if (raw.trim()) {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { ok: false, settingsPath, error: 'CLI settings.json 根节点不是有效的 JSON 对象，已中止写入以保护原有配置' };
        }
        settings = { ...parsed };
      }
    } catch (err) {
      return { ok: false, settingsPath, error: `读取 CLI settings.json 失败：${err.message}` };
    }
  }

  const command = buildCliStatusLineCommand(opts.cliEntryPath);
  if (action === 'uninstall' || action === 'remove' || action === 'delete') {
    if ('statusLine' in settings) {
      delete settings.statusLine;
      writeJsonAtomic(settingsPath, settings);
    }
    return {
      ok: true,
      action: 'uninstall',
      ...getCliStatusLineConfig(),
      message: `已从 ${settingsPath} 移除 statusLine 配置`
    };
  }

  if (action === 'off' || action === 'disable') {
    const prev = settings.statusLine && typeof settings.statusLine === 'object' ? settings.statusLine : {};
    settings.statusLine = {
      type: prev.type || 'command',
      command: prev.command || command,
      enabled: false,
      stack_with_default: prev.stack_with_default !== undefined ? prev.stack_with_default : stackWithDefault
    };
    writeJsonAtomic(settingsPath, settings);
    return {
      ok: true,
      action: 'off',
      ...getCliStatusLineConfig(),
      message: '已暂停 agy CLI 底部状态栏（保留配置，可用 agy-context statusline on 恢复）'
    };
  }

  settings.statusLine = {
    type: 'command',
    command,
    enabled: true,
    stack_with_default: stackWithDefault
  };
  writeJsonAtomic(settingsPath, settings);
  return {
    ok: true,
    action: 'install',
    ...getCliStatusLineConfig(),
    message: `已启用 agy CLI 底部实时状态栏（${stackWithDefault ? '与默认状态栏叠加显示' : '替换默认状态栏'} · 写入 ${settingsPath}）`
  };
}

function findCachedModelBudget(modelKey, modelDisplay, dynamicModelMap = {}) {
  const normTarget = modelKey || normalizeModelId(modelDisplay, dynamicModelMap) || '';
  const normDisp = String(modelDisplay || '').trim().toLowerCase();
  if (!normTarget && (!normDisp || normDisp === '未记录模型')) return null;
  const diskCache = loadActiveConvGenDiskCache();
  const entries = Object.values(diskCache?.convs || {})
    .filter((e) => e && Array.isArray(e.generatorList) && e.generatorList.length > 0)
    .sort((a, b) => Number(b.fetchedAt || 0) - Number(a.fetchedAt || 0));
  for (const entry of entries) {
    for (let i = entry.generatorList.length - 1; i >= 0; i--) {
      const gm = entry.generatorList[i];
      const cm = gm?.chatModel || gm?.chatMetadata || {};
      const ctxMeta = cm?.chatStartMetadata?.contextWindowMetadata;
      const budget = Number(ctxMeta?.maxContextTokens || 0);
      if (!(budget > 0)) continue;
      const rawModel = String(
        cm?.modelDisplayName || cm?.responseModel || cm?.model ||
        gm?.modelDisplayName || gm?.responseModel || gm?.model || ''
      ).trim();
      const mk = normalizeModelId(rawModel, dynamicModelMap)
        || normalizeModelId(cm?.model || gm?.model || '', dynamicModelMap);
      if (normTarget && mk && mk === normTarget) return budget;
      if (normDisp && rawModel && formatModelDisplayName(rawModel, mk).toLowerCase() === normDisp) return budget;
    }
  }
  return null;
}

const VALID_UI_THEME_MODES = new Set(['auto', 'light', 'dark', 'oled']);
const VALID_UI_LANGS = new Set(['zh', 'en']);

export async function saveSettings(payload = {}) {
  const settings = loadRawSettings();
  const prevQuotaRpcEnabled = settings.uiPreferences?.quotaRpcEnabled !== false;
  const incomingQuotaRpc = (payload.uiPreferences && typeof payload.uiPreferences.quotaRpcEnabled === 'boolean')
    ? payload.uiPreferences.quotaRpcEnabled
    : prevQuotaRpcEnabled;
  const shouldSkipHostRpc = isEnvZeroQuotaRpcForced() || !incomingQuotaRpc || !prevQuotaRpcEnabled;
  const host = shouldSkipHostRpc
    ? null
    : await getHostUserStatus(false, { background: true });
  const acctKey = host?.plan?.accountKey || settings.lastAccountKey || 'default';

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

  let quotaRpcChanged = false;
  if (payload.uiPreferences && typeof payload.uiPreferences === 'object') {
    const nextPrefs = {
      ...settings.uiPreferences,
      ...payload.uiPreferences,
      updatedAt: new Date().toISOString()
    };
    if (nextPrefs.themeMode !== undefined) {
      nextPrefs.themeMode = VALID_UI_THEME_MODES.has(nextPrefs.themeMode) ? nextPrefs.themeMode : 'auto';
    }
    if (nextPrefs.glass !== undefined) {
      nextPrefs.glass = Boolean(nextPrefs.glass);
    }
    if (nextPrefs.lang !== undefined) {
      nextPrefs.lang = VALID_UI_LANGS.has(nextPrefs.lang) ? nextPrefs.lang : 'zh';
    }
    if (nextPrefs.quotaRpcEnabled !== undefined) {
      nextPrefs.quotaRpcEnabled = Boolean(nextPrefs.quotaRpcEnabled);
      quotaRpcChanged = nextPrefs.quotaRpcEnabled !== prevQuotaRpcEnabled;
    }
    delete nextPrefs.budgetOverride;
    settings.uiPreferences = nextPrefs;
  }

  writeJsonAtomic(getSettingsPath(), settings);
  if (quotaRpcChanged) {
    resetQuotaRuntimeCaches();
  } else {
    cachedHistoryResult.at = 0; // Invalidate history cache so updated plan reflects immediately
  }
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

function truncateCleanText(text, maxLen = 96) {
  const s = String(text || '')
    .replace(/(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^/\\\s"'`]+/g, '~')
    .replace(/\b(?:Bearer\s+[A-Za-z0-9._~+/=-]{8,}|(?:sk|ghp|gho|glpat|xoxb|AIza)[-_A-Za-z0-9]{12,})\b/gi, '<REDACTED>')
    .replace(/\b([A-Za-z0-9._%+-]{1,2})[A-Za-z0-9._%+-]*@([A-Za-z0-9-]{1,2})[A-Za-z0-9.-]*(\.[A-Za-z]{2,})\b/g, '$1***@$2***$3')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  return s.length > maxLen ? `${s.slice(0, Math.max(1, maxLen - 1))}…` : s;
}

function extractPromptPreview(contentStr) {
  if (!contentStr || typeof contentStr !== 'string') {
    return { promptPreview: '', promptFull: '' };
  }
  const withoutMeta = contentStr
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, '')
    .replace(/<EPHEMERAL_MESSAGE>[\s\S]*?<\/EPHEMERAL_MESSAGE>/gi, '');
  const reqMatches = [...withoutMeta.matchAll(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/gi)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  const rawText = reqMatches.length > 0
    ? reqMatches.join(' ')
    : withoutMeta.replace(/<\/?USER_REQUEST>/gi, '');
  const compact = rawText.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return { promptPreview: '', promptFull: '' };
  }
  return {
    promptPreview: truncateCleanText(compact, 96),
    promptFull: truncateCleanText(compact, 400)
  };
}

function formatToolCallLabel(tc) {
  const rawName = String(tc?.name || tc?.tool_name || tc?.function?.name || 'tool')
    .trim()
    .replace(/^default_api:/, '');
  const args = tc?.args || tc?.arguments || tc?.function?.arguments || null;
  let parsedArgs = args;
  if (typeof args === 'string') {
    try { parsedArgs = JSON.parse(args); } catch { parsedArgs = null; }
  }
  if (parsedArgs && typeof parsedArgs === 'object') {
    const fileTarget = parsedArgs.Path || parsedArgs.path || parsedArgs.file_path || parsedArgs.ScriptPath;
    if (typeof fileTarget === 'string' && fileTarget.trim()) {
      const base = fileTarget.trim().split(/[\\/]/).pop();
      if (base) return `${rawName} (${base})`;
    }
    const summaryTarget = parsedArgs.toolSummary || parsedArgs.action || parsedArgs.Action || parsedArgs.query;
    if (typeof summaryTarget === 'string' && summaryTarget.trim()) {
      const short = summaryTarget.trim().slice(0, 24);
      return `${rawName} (${short})`;
    }
  }
  return rawName || '工具输出';
}

function resolveToolStepLabel(step, queuedLabel = '') {
  const rawTool = String(step?.tool_name || step?.toolName || step?.name || '')
    .trim()
    .replace(/^default_api:/, '');
  if (rawTool) return rawTool;
  if (queuedLabel) return queuedLabel;
  const type = String(step?.type || '').trim();
  if (type === 'ERROR_MESSAGE') return '错误消息';
  if (type === 'GENERIC') return '工具返回';
  if (type) return type.toLowerCase();
  return '工具输出';
}

function stripToolResultHeader(rawText) {
  return String(rawText || '')
    .replace(/^(?:(?:Created At|Completed At|Showing lines|Partial read)[^\r\n]*\r?\n)+/i, '')
    .replace(/^(?:Created At:\s*\S+\s+Completed At:\s*\S+\s*)+/i, '')
    .trim();
}

function readGitBranchFromDir(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return null;
  try {
    const dotGitPath = join(dirPath, '.git');
    if (!existsSync(dotGitPath)) return null;
    const st = statSync(dotGitPath);
    let headPath = '';
    if (st.isDirectory()) {
      headPath = join(dotGitPath, 'HEAD');
    } else if (st.isFile()) {
      const ptr = readFileSync(dotGitPath, 'utf-8');
      const m = ptr.match(/^gitdir:\s*(.+)$/im);
      if (!m) return null;
      headPath = join(resolve(dirPath, m[1].trim()), 'HEAD');
    } else {
      return null;
    }
    if (!headPath || !existsSync(headPath)) return null;
    const headRaw = readFileSync(headPath, 'utf-8').trim();
    if (!headRaw) return null;
    const refHead = headRaw.match(/^ref:\s*refs\/heads\/(.+)$/i);
    if (refHead) return refHead[1].trim() || null;
    const refOther = headRaw.match(/^ref:\s*refs\/(?:remotes|tags)\/(.+)$/i);
    if (refOther) return refOther[1].trim() || null;
    const shaMatch = headRaw.match(/^([0-9a-f]{7,40})$/i);
    if (shaMatch) return shaMatch[1].slice(0, 7);
    return null;
  } catch {
    return null;
  }
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

function resolveThinkingAndResponse(rawThinking, rawResponse, output, sqlUsage) {
  const thinking = rawThinking > 0 ? rawThinking : (sqlUsage?.thinkingTokens > 0 ? sqlUsage.thinkingTokens : 0);
  let responseTokens = (rawThinking <= 0 && thinking > 0) || (rawResponse + thinking > output)
    ? (sqlUsage?.responseTokens > 0 ? sqlUsage.responseTokens : Math.max(0, output - thinking))
    : (rawResponse > 0 ? rawResponse : (sqlUsage?.responseTokens > 0 ? sqlUsage.responseTokens : 0));
  if (responseTokens <= 0 && output > 0 && thinking >= 0) {
    responseTokens = Math.max(0, output - thinking);
  }
  return { thinking, responseTokens };
}

function extractStepUsage(step) {
  if (
    step?.input_tokens != null ||
    step?.output_tokens != null ||
    step?.cache_read_tokens != null ||
    step?.cache_write_tokens != null ||
    step?.cache_creation_input_tokens != null
  ) {
    const input = Number(step.input_tokens || 0);
    const cache = Number(step.cache_read_tokens || 0);
    const cacheWrite = Math.max(0, Number(step.cache_write_tokens ?? step.cache_creation_input_tokens ?? 0) || 0);
    const output = Number(step.output_tokens || 0);
    const thinking = Number(step.thinking_output_tokens || 0);
    return { input, cache, cacheWrite, output, thinking, response: Math.max(0, output - thinking) };
  }
  const u = step?.chatModel?.usage || step?.usage;
  if (u && typeof u === 'object') {
    const input = Number(u.inputTokens ?? u.input_tokens ?? 0);
    const cache = Number(u.cacheReadTokens ?? u.cache_read_tokens ?? 0);
    const cacheWrite = Math.max(
      0,
      Number(u.cacheWriteTokens ?? u.cacheCreationInputTokens ?? u.cache_creation_input_tokens ?? u.cache_write_tokens ?? 0) || 0
    );
    const output = Number(u.outputTokens ?? u.output_tokens ?? 0);
    const thinking = Number(u.thinkingOutputTokens ?? u.thinking_output_tokens ?? 0);
    const response = Number(u.responseOutputTokens ?? u.response_output_tokens ?? Math.max(0, output - thinking));
    return { input, cache, cacheWrite, output, thinking, response };
  }
  return { input: 0, cache: 0, cacheWrite: 0, output: 0, thinking: 0, response: 0 };
}

function isModelTurnStep(step) {
  const type = String(step?.type || '');
  if (type === 'USER_INPUT' || type === 'CHECKPOINT' || type === 'ERROR_MESSAGE' || step?.checkpoint) {
    return false;
  }
  if (type === 'PLANNER_RESPONSE') return true;
  const u = extractStepUsage(step);
  return (u.input + u.cache + (u.cacheWrite || 0) + u.output) > 0;
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

function parseTimestampMs(val) {
  if (typeof val === 'number') {
    if (!Number.isFinite(val) || val <= 0) return 0;
    return val > 1e11 ? val : (val > 1e9 ? val * 1000 : 0);
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return 0;
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      return parseTimestampMs(Number(trimmed));
    }
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  }
  if (val && typeof val === 'object') {
    const sec = Number(val.seconds || 0);
    const nanos = Number(val.nanos || 0);
    if (Number.isFinite(sec) && sec > 0) {
      return sec * 1000 + Math.round((Number.isFinite(nanos) ? nanos : 0) / 1e6);
    }
  }
  return 0;
}

function readCliHistoryIndex(cliDir) {
  const empty = { byConvId: new Map() };
  if (!cliDir || typeof cliDir !== 'string') return empty;
  const histPath = join(cliDir, 'history.jsonl');
  if (!existsSync(histPath)) return empty;
  let st = null;
  try {
    st = statSync(histPath);
  } catch {
    return empty;
  }
  if (!st || st.size <= 0) return empty;
  if (
    cliHistoryCache.path === histPath &&
    cliHistoryCache.size === st.size &&
    cliHistoryCache.mtimeMs === st.mtimeMs
  ) {
    return { byConvId: cliHistoryCache.byConvId };
  }

  const TAIL_MAX_BYTES = 2 * 1024 * 1024;
  let byConvId;
  let startOffset = 0;
  let skipPartialFirstLine = false;

  if (
    cliHistoryCache.path === histPath &&
    cliHistoryCache.parsedOffset > 0 &&
    st.size >= cliHistoryCache.parsedOffset
  ) {
    byConvId = cliHistoryCache.byConvId;
    startOffset = cliHistoryCache.parsedOffset;
  } else {
    byConvId = new Map();
    if (st.size > TAIL_MAX_BYTES) {
      startOffset = st.size - TAIL_MAX_BYTES;
      skipPartialFirstLine = true;
    }
  }

  const bytesToRead = st.size - startOffset;
  let nextParsedOffset = startOffset;
  if (bytesToRead > 0) {
    let fd = null;
    try {
      fd = openSync(histPath, 'r');
      const buf = Buffer.allocUnsafe(bytesToRead);
      let totalRead = 0;
      while (totalRead < bytesToRead) {
        const n = readSync(fd, buf, totalRead, bytesToRead - totalRead, startOffset + totalRead);
        if (n <= 0) break;
        totalRead += n;
      }
      if (totalRead > 0) {
        const chunkBuf = buf.subarray(0, totalRead);
        const lastNlIdx = chunkBuf.lastIndexOf(0x0a);
        nextParsedOffset = lastNlIdx >= 0 ? (startOffset + lastNlIdx + 1) : startOffset;
        let text = chunkBuf.toString('utf-8');
        if (skipPartialFirstLine) {
          const firstNl = text.indexOf('\n');
          text = firstNl >= 0 ? text.slice(firstNl + 1) : '';
        }
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed);
            if (!obj || typeof obj !== 'object') continue;
            const cid = String(
              obj.conversationId || obj.conversation_id || obj.sessionId || obj.session_id || ''
            ).trim();
            if (!CONV_ID_RE.test(cid)) continue;
            const tsMs = parseTimestampMs(
              obj.timestamp ?? obj.timestampMs ?? obj.created_at ?? obj.createdAt ?? obj.time
            );
            const ws = typeof obj.workspace === 'string'
              ? obj.workspace.trim()
              : (typeof obj.cwd === 'string' ? obj.cwd.trim() : '');
            const prev = byConvId.get(cid);
            if (!prev) {
              byConvId.set(cid, { timestampMs: tsMs, workspace: ws });
            } else {
              const newer = tsMs >= prev.timestampMs;
              byConvId.set(cid, {
                timestampMs: Math.max(prev.timestampMs, tsMs),
                workspace: newer ? (ws || prev.workspace) : (prev.workspace || ws)
              });
            }
          } catch {}
        }
      }
    } catch {
      // Keep accumulated entries on transient read failure
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch {}
      }
    }
  } else {
    nextParsedOffset = st.size;
  }

  cliHistoryCache = {
    path: histPath,
    size: st.size,
    mtimeMs: st.mtimeMs,
    parsedOffset: nextParsedOffset,
    byConvId
  };
  return { byConvId };
}

function readCliLastConversationsMap(cliDir) {
  const empty = { byWorkspace: new Map(), byConvId: new Map() };
  if (!cliDir || typeof cliDir !== 'string') return empty;
  const p = join(cliDir, 'cache', 'last_conversations.json');
  if (!existsSync(p)) return empty;
  let st = null;
  try {
    st = statSync(p);
  } catch {
    return empty;
  }
  if (!st || st.size <= 0) return empty;
  if (
    cliLastConvsCache.path === p &&
    cliLastConvsCache.size === st.size &&
    cliLastConvsCache.mtimeMs === st.mtimeMs
  ) {
    return { byWorkspace: cliLastConvsCache.byWorkspace, byConvId: cliLastConvsCache.byConvId };
  }
  const byWorkspace = new Map();
  const byConvId = new Map();
  const raw = readJsonSafe(p, null);
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const sourceObj = (raw.workspaces && typeof raw.workspaces === 'object' && !Array.isArray(raw.workspaces))
      ? raw.workspaces
      : raw;
    for (const [wsKey, val] of Object.entries(sourceObj)) {
      const ws = String(wsKey || '').trim();
      if (!ws) continue;
      const cid = typeof val === 'string'
        ? val.trim()
        : String(val?.conversationId || val?.conversation_id || val?.id || '').trim();
      if (!CONV_ID_RE.test(cid)) continue;
      byWorkspace.set(ws, cid);
      if (!byConvId.has(cid)) byConvId.set(cid, ws);
    }
  }
  cliLastConvsCache = { path: p, size: st.size, mtimeMs: st.mtimeMs, byWorkspace, byConvId };
  return { byWorkspace, byConvId };
}

function readGitBranchCached(dirPath, nowMs = Date.now()) {
  if (!dirPath || typeof dirPath !== 'string') return null;
  const hit = gitBranchCache.get(dirPath);
  if (hit && (nowMs - hit.at) < 10_000) {
    return hit.branch;
  }
  const branch = readGitBranchFromDir(dirPath);
  if (gitBranchCache.size > 256) {
    const firstK = gitBranchCache.keys().next().value;
    if (firstK) gitBranchCache.delete(firstK);
  }
  gitBranchCache.set(dirPath, { at: nowMs, branch });
  return branch;
}

function readRecentConvTranscriptMeta(logPath, mtimeMs, size) {
  const cacheKey = `${mtimeMs}:${size}`;
  const cached = recentConvMetaCache.get(logPath);
  if (cached && cached.key === cacheKey) {
    return cached;
  }
  let title = '';
  let lastContextTokens = 0;
  let turnsCount = 0;
  let hasUserInput = false;
  let firstType = '';
  let lastUserInputAtMs = 0;
  let lastModelTurnAtMs = 0;
  let lastStepType = '';
  try {
    const raw = readFileSync(logPath, 'utf-8');
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (!firstType && obj.type) firstType = obj.type;
        if (obj.type) lastStepType = String(obj.type);
        const stepTs = parseTimestampMs(obj.created_at ?? obj.createdAt ?? obj.timestamp);
        if (obj.type === 'USER_INPUT') {
          hasUserInput = true;
          if (!title && obj.content) {
            title = extractCleanUserTitle(obj.content);
          }
          if (stepTs > lastUserInputAtMs) lastUserInputAtMs = stepTs;
        }
        const isModelStep = obj.type === 'PLANNER_RESPONSE' || (obj.type !== 'SYSTEM_MESSAGE' && isModelTurnStep(obj));
        if (isModelStep && stepTs > lastModelTurnAtMs) {
          lastModelTurnAtMs = stepTs;
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
  const meta = {
    key: cacheKey,
    title,
    lastContextTokens,
    turnsCount,
    hasUserInput,
    firstType,
    lastUserInputAtMs,
    lastModelTurnAtMs,
    lastStepType
  };
  if (recentConvMetaCache.size > 2000) {
    const firstK = recentConvMetaCache.keys().next().value;
    if (firstK) recentConvMetaCache.delete(firstK);
  }
  recentConvMetaCache.set(logPath, meta);
  return meta;
}

function readSwarmNonKilledMemberIds(swarmMembersPath, parentConvId) {
  if (!swarmMembersPath || !existsSync(swarmMembersPath)) return [];
  let st = null;
  try {
    st = statSync(swarmMembersPath);
  } catch {
    return [];
  }
  const cacheKey = `${st.mtimeMs}:${st.size}`;
  const cached = swarmMembersCache.get(swarmMembersPath);
  if (cached && cached.key === cacheKey) {
    return cached.memberIds;
  }
  const rawSwarm = readJsonSafe(swarmMembersPath, null);
  const memberIds = [];
  const isMonitorMember = (val) => /^monitor(?:-\d+)?$/i.test(String(val || '').trim());
  if (rawSwarm && typeof rawSwarm === 'object') {
    const rawMembers = rawSwarm.members;
    const entries = Array.isArray(rawMembers)
      ? rawMembers.map((mObj) => ['', mObj])
      : (rawMembers && typeof rawMembers === 'object' ? Object.entries(rawMembers) : []);
    for (const [mKey, mObj] of entries) {
      if (!mObj || typeof mObj !== 'object') continue;
      if (mObj.killed === true) continue;
      const phase = String(mObj.phase || mObj.state || mObj.status || '').trim().toLowerCase();
      if (phase === 'killed') continue;
      if (
        isMonitorMember(mKey) ||
        isMonitorMember(mObj.name) ||
        isMonitorMember(mObj.role) ||
        isMonitorMember(mObj.agent_name) ||
        isMonitorMember(mObj.member_name)
      ) {
        continue;
      }
      const cid = String(mObj.conversation_id || mObj.conversationId || mObj.id || '').trim();
      if (!cid || cid === parentConvId || !CONV_ID_RE.test(cid)) continue;
      memberIds.push(cid);
    }
  }
  if (swarmMembersCache.size > 512) {
    const firstK = swarmMembersCache.keys().next().value;
    if (firstK) swarmMembersCache.delete(firstK);
  }
  swarmMembersCache.set(swarmMembersPath, { key: cacheKey, memberIds });
  return memberIds;
}

function computeSwarmActiveMs(convBrainDir, parentConvId, transcriptByConvId, nowMs) {
  const swarmMembersPath = join(convBrainDir, '.system_generated', 'swarm', 'members.json');
  const memberIds = readSwarmNonKilledMemberIds(swarmMembersPath, parentConvId);
  if (!memberIds.length) return 0;

  let swarmActiveMs = 0;
  for (const cid of memberIds) {
    const childFile = transcriptByConvId.get(cid);
    if (!childFile) continue;
    const childMeta = readRecentConvTranscriptMeta(childFile.logPath, childFile.mtimeMs, childFile.size);
    const childTurnMs = Math.max(childMeta.lastUserInputAtMs || 0, childMeta.lastModelTurnAtMs || 0);
    const isNoiseLastStep = childMeta.lastStepType === 'SYSTEM_MESSAGE' || childMeta.lastStepType === 'CHECKPOINT';
    let childActiveMs = 0;
    if (childTurnMs > 0) {
      childActiveMs = isNoiseLastStep ? childTurnMs : Math.max(childTurnMs, childFile.mtimeMs || 0);
    } else if (!isNoiseLastStep) {
      childActiveMs = childFile.mtimeMs || 0;
    }
    if (childActiveMs > 0 && (nowMs - childActiveMs) <= ACTIVE_WORK_WINDOW_MS) {
      swarmActiveMs = Math.max(swarmActiveMs, childActiveMs);
    }
  }
  return swarmActiveMs;
}

export function listRecentConversations(limit = 24, nowMs = Date.now()) {
  const annMap = readConversationAnnotationsMap();
  const agDir = findAppDataDir();
  const ideDir = findIdeDataDir();
  const cliDir = findCliDataDir();
  const cliHistoryIndex = readCliHistoryIndex(cliDir);
  const cliLastConvs = readCliLastConversationsMap(cliDir);
  const roots = [
    { dir: join(agDir, 'brain'), source: 'desktop' }
  ];
  if (ideDir && ideDir !== agDir && ideDir !== cliDir) {
    roots.push({ dir: join(ideDir, 'brain'), source: 'desktop' });
  }
  roots.push({ dir: join(cliDir, 'brain'), source: 'cli' });

  const desktopEntries = [];
  const cliEntries = [];
  const transcriptByConvId = new Map();
  const seenConvKeys = new Set();
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
        const dedupKey = `${root.source}:${dirent.name}`;
        if (seenConvKeys.has(dedupKey)) continue;
        seenConvKeys.add(dedupKey);
        try {
          const st = statSync(logPath);
          if (st.size <= 0) continue;
          if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
          const prevFile = transcriptByConvId.get(dirent.name);
          if (!prevFile || st.mtimeMs > prevFile.mtimeMs) {
            transcriptByConvId.set(dirent.name, { logPath, mtimeMs: st.mtimeMs, size: st.size });
          }
          const ann = annMap.get(dirent.name) || null;
          const histEntry = cliHistoryIndex.byConvId.get(dirent.name) || null;
          const entry = {
            id: dirent.name,
            source: root.source,
            rootDir: root.dir,
            logPath,
            mtimeMs: st.mtimeMs,
            size: st.size,
            viewTimeMs: ann?.viewTimeMs || 0,
            annMtimeMs: ann?.mtimeMs || 0,
            annTitle: ann?.annTitle || '',
            cliHistoryTs: histEntry?.timestampMs || 0,
            cliWorkspace: histEntry?.workspace || cliLastConvs.byConvId.get(dirent.name) || ''
          };
          if (root.source === 'cli') {
            cliEntries.push(entry);
          } else {
            desktopEntries.push(entry);
          }
        } catch {}
      }
    } catch {}
  }
  if (maxMtimeMs > 0) {
    noteObservedTranscriptActivity(maxMtimeMs, nowMs);
  }

  desktopEntries.sort((a, b) => {
    const aEff = Math.max(a.viewTimeMs || 0, a.mtimeMs || 0);
    const bEff = Math.max(b.viewTimeMs || 0, b.mtimeMs || 0);
    if (bEff !== aEff) return bEff - aEff;
    return (b.mtimeMs || 0) - (a.mtimeMs || 0);
  });
  cliEntries.sort((a, b) => {
    const aEff = Math.max(a.viewTimeMs || 0, a.cliHistoryTs || 0, a.mtimeMs || 0);
    const bEff = Math.max(b.viewTimeMs || 0, b.cliHistoryTs || 0, b.mtimeMs || 0);
    if (bEff !== aEff) return bEff - aEff;
    return (b.mtimeMs || 0) - (a.mtimeMs || 0);
  });

  const perSourceLimit = (Number.isFinite(limit) && limit > 0) ? limit : Infinity;
  const enriched = [];

  const scanSourceEntries = (sourceEntries) => {
    let nonSubCount = 0;
    for (const item of sourceEntries) {
      const meta = readRecentConvTranscriptMeta(item.logPath, item.mtimeMs, item.size);
      const isSubagent = !meta.hasUserInput && meta.firstType === 'SYSTEM_MESSAGE' && !item.viewTimeMs;
      const lastUserInputAtMs = meta.lastUserInputAtMs || 0;
      const lastModelTurnAtMs = meta.lastModelTurnAtMs || 0;
      const parsedTurnActiveMs = Math.max(lastUserInputAtMs, lastModelTurnAtMs);
      const turnActiveMs = parsedTurnActiveMs > 0 ? parsedTurnActiveMs : item.mtimeMs;
      const isNoiseLastStep = meta.lastStepType === 'SYSTEM_MESSAGE' || meta.lastStepType === 'CHECKPOINT';

      const convBrainDir = join(item.rootDir, item.id);
      const swarmActiveMs = isSubagent
        ? 0
        : computeSwarmActiveMs(convBrainDir, item.id, transcriptByConvId, nowMs);

      const realProgressMs = Math.max(
        parsedTurnActiveMs > 0 ? parsedTurnActiveMs : (isNoiseLastStep ? 0 : item.mtimeMs),
        swarmActiveMs
      );
      const isRunning = !isSubagent && realProgressMs > 0 && (nowMs - realProgressMs) <= ACTIVE_WORK_WINDOW_MS;
      const updatedAtMs = Math.max(turnActiveMs, swarmActiveMs, item.cliHistoryTs || 0);
      const effectiveActiveMs = isSubagent
        ? 0
        : Math.max(item.viewTimeMs || 0, turnActiveMs, swarmActiveMs, item.cliHistoryTs || 0);

      const record = {
        id: item.id,
        shortId: item.id.slice(0, 8),
        source: item.source,
        title: meta.title || item.annTitle || `会话 ${item.id.slice(0, 8)}`,
        annTitle: item.annTitle || '',
        isSubagent: Boolean(isSubagent),
        lastContextTokens: meta.lastContextTokens || 0,
        turnsCount: meta.turnsCount || 0,
        viewTimeMs: item.viewTimeMs || 0,
        annMtimeMs: item.annMtimeMs || 0,
        lastUserInputAtMs,
        isRunning,
        effectiveActiveMs,
        updatedAtMs,
        updatedAt: new Date(updatedAtMs).toISOString()
      };
      recentConvSignalsMap.set(record, {
        lastModelTurnAtMs,
        turnActiveMs: parsedTurnActiveMs,
        swarmActiveMs,
        cliHistoryTs: item.cliHistoryTs || 0,
        cliWorkspace: item.cliWorkspace || '',
        lastStepType: meta.lastStepType || '',
        hasUserInput: Boolean(meta.hasUserInput)
      });
      enriched.push(record);
      if (!isSubagent) nonSubCount++;
      if (nonSubCount >= perSourceLimit) break;
    }
  };

  scanSourceEntries(desktopEntries);
  scanSourceEntries(cliEntries);

  enriched.sort((a, b) => {
    if (a.isSubagent !== b.isSubagent) return a.isSubagent ? 1 : -1;
    if (b.effectiveActiveMs !== a.effectiveActiveMs) return b.effectiveActiveMs - a.effectiveActiveMs;
    return b.updatedAtMs - a.updatedAtMs;
  });

  return Number.isFinite(limit) && limit > 0 ? enriched.slice(0, limit) : enriched;
}

function getValidatedPinnedConvId(recentConversations = [], searchRoots = null) {
  const hint = readActiveSessionHint();
  if (!hint.pinnedConvId) return '';
  if (Array.isArray(recentConversations) && recentConversations.some((c) => c.id === hint.pinnedConvId)) {
    return hint.pinnedConvId;
  }
  const effectiveRoots = (Array.isArray(searchRoots) && searchRoots.length)
    ? searchRoots
    : [findAppDataDir(), findIdeDataDir(), findCliDataDir()].filter(Boolean);
  if (findConvTranscriptPath(hint.pinnedConvId, effectiveRoots)) {
    return hint.pinnedConvId;
  }
  updateActiveSessionHint({ pinnedConvId: '' });
  return '';
}

function resolveActiveConversationId(recentConversations, nowMs = Date.now(), searchRoots = null) {
  if (!Array.isArray(recentConversations) || !recentConversations.length) {
    getValidatedPinnedConvId([], searchRoots);
    return '';
  }

  // 1. Explicit conversation lock chosen in `#conv-select` (auto-clear if deleted from disk)
  const validPinned = getValidatedPinnedConvId(recentConversations, searchRoots);
  if (validPinned) {
    return validPinned;
  }

  const hint = readActiveSessionHint();
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
  let nextBatchViewMs = 0;
  if (maxViewMs > 0) {
    const tied = pool.filter((c) => Math.abs((c.viewTimeMs || 0) - maxViewMs) <= 80);
    if (maxViewMs > (hint.lastBatchViewMs || 0)) {
      viewWinner = (tied.length > 1 && hint.resolvedConvId)
        ? (tied.find((c) => c.id !== hint.resolvedConvId) || tied[0])
        : tied[0];
      if (viewWinner) {
        nextBatchViewMs = maxViewMs;
      }
    } else {
      viewWinner = tied.find((c) => c.id === hint.resolvedConvId) || tied[0];
    }
  }

  // 3. Unified explicit user-interaction + active work window model
  const scored = pool.map((c) => {
    const sig = recentConvSignalsMap.get(c) || {};
    let effectiveViewTimeMs = c.viewTimeMs || 0;
    if (maxViewMs > 0 && Math.abs(effectiveViewTimeMs - maxViewMs) <= 80) {
      effectiveViewTimeMs = (viewWinner && c.id === viewWinner.id) ? maxViewMs : 0;
    }
    const focusedTs = (hint.userFocusedConvId === c.id && hint.userFocusedAt > 0) ? hint.userFocusedAt : 0;
    const cliHistoryTs = Number(sig.cliHistoryTs || 0);
    const lastUserInputAtMs = Number(c.lastUserInputAtMs || 0);
    const lastModelTurnAtMs = Number(sig.lastModelTurnAtMs || 0);
    const swarmActiveMs = Number(sig.swarmActiveMs || 0);
    const turnActiveMs = Number(sig.turnActiveMs || 0);
    const isNoiseLastStep = sig.lastStepType === 'SYSTEM_MESSAGE' || sig.lastStepType === 'CHECKPOINT';

    let validatedCliActiveAt = 0;
    if (hint.cliActiveConvId === c.id && hint.cliActiveAt > 0) {
      const baseActivityMs = Math.max(turnActiveMs, swarmActiveMs);
      const validByTurn = turnActiveMs > 0 && baseActivityMs >= (hint.cliActiveAt - ACTIVE_WORK_WINDOW_MS);
      const validByFallback = turnActiveMs === 0 && !isNoiseLastStep && (c.updatedAtMs || 0) >= (hint.cliActiveAt - ACTIVE_WORK_WINDOW_MS);
      if (validByTurn || validByFallback || swarmActiveMs > 0) {
        validatedCliActiveAt = hint.cliActiveAt;
      }
    }

    const legacyFallbackMs = (lastUserInputAtMs === 0 && lastModelTurnAtMs === 0 && !isNoiseLastStep)
      ? (c.updatedAtMs || 0)
      : 0;
    const userInteractionMs = Math.max(effectiveViewTimeMs, focusedTs, cliHistoryTs, lastUserInputAtMs);
    const workActiveMs = Math.max(userInteractionMs, lastModelTurnAtMs, swarmActiveMs, validatedCliActiveAt, legacyFallbackMs);
    const isInActiveWindow = workActiveMs > 0 && (nowMs - workActiveMs) <= ACTIVE_WORK_WINDOW_MS;

    return {
      c,
      userInteractionMs,
      workActiveMs,
      isInActiveWindow
    };
  });

  scored.sort((a, b) => {
    if (a.isInActiveWindow !== b.isInActiveWindow) {
      return a.isInActiveWindow ? -1 : 1;
    }
    if (b.userInteractionMs !== a.userInteractionMs) {
      return b.userInteractionMs - a.userInteractionMs;
    }
    if (b.workActiveMs !== a.workActiveMs) {
      return b.workActiveMs - a.workActiveMs;
    }
    if (a.c.id === hint.resolvedConvId && b.c.id !== hint.resolvedConvId) return -1;
    if (b.c.id === hint.resolvedConvId && a.c.id !== hint.resolvedConvId) return 1;
    return (b.c.updatedAtMs || 0) - (a.c.updatedAtMs || 0);
  });

  const chosenId = scored[0]?.c?.id || pool[0]?.id || '';
  const hintPatch = {};
  if (chosenId && chosenId !== hint.resolvedConvId) {
    hintPatch.resolvedConvId = chosenId;
  }
  if (nextBatchViewMs > (hint.lastBatchViewMs || 0)) {
    hintPatch.lastBatchViewMs = nextBatchViewMs;
  }
  if (Object.keys(hintPatch).length) {
    updateActiveSessionHint(hintPatch);
  }
  return chosenId;
}

function enrichRecentConversationsMetadata(recentConversations = [], {
  convId = '',
  repoInfo = null,
  summariesIndex = null,
  cliDataDir = '',
  nowMs = Date.now()
} = {}) {
  if (!Array.isArray(recentConversations) || !recentConversations.length) return [];
  const cliHist = cliDataDir ? readCliHistoryIndex(cliDataDir) : { byConvId: new Map() };
  const cliLast = cliDataDir ? readCliLastConversationsMap(cliDataDir) : { byConvId: new Map() };

  return recentConversations.map((c) => {
    const cachedWs = convWorkspaceCache.get(c.id) || null;
    const sqlEntry = summariesIndex?.byId?.get(c.id) || null;
    const sig = recentConvSignalsMap.get(c) || null;
    const cliWsPath = sig?.cliWorkspace || cliLast.byConvId.get(c.id) || cliHist.byConvId.get(c.id)?.workspace || '';

    let projectName = null;
    if (cachedWs) {
      if (cachedWs.metaRepoName) {
        projectName = extractProjectNameFromUris(null, cachedWs.metaRepoName);
      }
      if (!projectName && cachedWs.workspacePath) {
        projectName = extractProjectNameFromUris([cachedWs.workspacePath]);
      }
    }
    if (!projectName && sqlEntry?.projectName) {
      projectName = extractProjectNameFromUris(null, sqlEntry.projectName) || null;
    }
    if (!projectName && cliWsPath) {
      projectName = extractProjectNameFromUris([cliWsPath]);
    }
    if (!projectName && c.id === convId && repoInfo?.name) {
      projectName = extractProjectNameFromUris(null, repoInfo.name) || null;
    }

    let repoLabel = null;
    if (c.id === convId && repoInfo?.label) {
      repoLabel = repoInfo.label;
    } else if (projectName) {
      let branch = cachedWs?.metaBranchName || null;
      if (!branch && cachedWs?.workspacePath) {
        branch = readGitBranchCached(cachedWs.workspacePath, nowMs);
      }
      if (!branch && sqlEntry?.workspaceUri && /^file:\/\//i.test(sqlEntry.workspaceUri)) {
        try {
          branch = readGitBranchCached(fileURLToPath(sqlEntry.workspaceUri), nowMs);
        } catch {}
      }
      if (!branch && cliWsPath) {
        branch = readGitBranchCached(cliWsPath, nowMs);
      }
      repoLabel = branch ? `${projectName}@${branch}` : projectName;
    }

    return {
      ...c,
      projectName: projectName || null,
      repoLabel: repoLabel || null,
      lastUserInputAtMs: Number(c.lastUserInputAtMs || 0),
      isRunning: Boolean(c.isRunning)
    };
  });
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
  const resolveBaseList = (allowStale = false) => {
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
    if (allowStale && options.allowStaleDiskFallback) {
      const diskCache = loadActiveConvGenDiskCache();
      const diskEntry = diskCache?.convs?.[convId];
      if (
        diskEntry &&
        (!diskEntry.lsKeyHash || !lsDiskHash || diskEntry.lsKeyHash === lsDiskHash) &&
        Array.isArray(diskEntry.generatorList) &&
        diskEntry.generatorList.length > 0
      ) {
        return diskEntry.generatorList;
      }
    }
    return [];
  };

  if (options.skipLiveRpc === true) {
    const baseList = resolveBaseList(true);
    if (baseList.length > 0) {
      return {
        at: nowMs,
        lsKey,
        generatorList: baseList,
        callsByStep: buildCallsByStepFromList(baseList),
        ...(hasLogSig ? { logSize: options.logSize, logMtimeMs: options.logMtimeMs } : {}),
        fromFallbackCache: true,
        rpcFailed: true,
        rpcTimedOut: true
      };
    }
    return { at: nowMs, lsKey, generatorList: [], callsByStep: new Map(), rpcFailed: true, rpcTimedOut: true };
  }

  const flightKey = `${lsKey}|${convId}|${hasLogSig ? `${options.logSize}:${options.logMtimeMs}` : ''}`;
  const canCoalesce = !force && !options.signal && !bypassMemTtl;
  if (canCoalesce && inFlightGenMeta.has(flightKey)) {
    return inFlightGenMeta.get(flightKey);
  }

  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 4500;
  const run = (async () => {
    const rpcResp = await callLanguageServerWithStatus(
      'GetCascadeTrajectoryGeneratorMetadata',
      {
        cascadeId: convId,
        generatorMetadataOffset: 0,
        includeMessages: false
      },
      timeoutMs,
      {
        signal: options.signal || null,
        unrefSocket: Boolean(options.unrefSocket),
        noKeepAlive: Boolean(options.noKeepAlive)
      }
    );
    const res = rpcResp.data;
    const rpcTimedOut = rpcResp.errorCode === 'ETIMEDOUT' || rpcResp.errorCode === 'ABORTED';
    const baseList = resolveBaseList(res === null);
    if (res === null) {
      if (baseList.length > 0) {
        return {
          at: nowMs,
          lsKey,
          generatorList: baseList,
          callsByStep: buildCallsByStepFromList(baseList),
          ...(hasLogSig ? { logSize: options.logSize, logMtimeMs: options.logMtimeMs } : {}),
          fromFallbackCache: true,
          rpcFailed: true,
          rpcTimedOut
        };
      }
      return { at: nowMs, lsKey, generatorList: [], callsByStep: new Map(), rpcFailed: true, rpcTimedOut };
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
        return { ...value, fromFallbackCache: true, rpcFailed: false, rpcTimedOut: false };
      }
      return { at: nowMs, lsKey, generatorList: [], callsByStep: new Map(), emptyFromHost: true, rpcFailed: false, rpcTimedOut: false };
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
    return { ...value, rpcFailed: false, rpcTimedOut: false };
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

const STATUSLINE_SNAP_CACHE_VERSION = 1;
const STATUSLINE_SNAP_CACHE_MAX_CONVS = 8;

function getStatuslineSnapCachePath() {
  return join(getPluginStateDir(), 'statusline_snap_v1.json');
}

function loadStatuslineSnapCache(targetPath = getStatuslineSnapCachePath()) {
  const raw = readJsonSafe(targetPath, null);
  const convs = {};
  if (raw?.version === STATUSLINE_SNAP_CACHE_VERSION && raw.convs && typeof raw.convs === 'object') {
    for (const [cid, v] of Object.entries(raw.convs)) {
      if (CONV_ID_RE.test(cid) && v && typeof v === 'object') {
        convs[cid] = v;
      }
    }
  }
  return { version: STATUSLINE_SNAP_CACHE_VERSION, convs };
}

function saveStatuslineSnapEntry(convId, entry, targetPath = getStatuslineSnapCachePath()) {
  if (!convId || !CONV_ID_RE.test(convId) || !entry) return;
  try {
    const data = loadStatuslineSnapCache(targetPath);
    const nextConvs = { ...data.convs, [convId]: entry };
    const sorted = Object.entries(nextConvs)
      .sort((a, b) => Number(b[1]?.savedAt || 0) - Number(a[1]?.savedAt || 0))
      .slice(0, STATUSLINE_SNAP_CACHE_MAX_CONVS);
    writeJsonAtomic(targetPath, {
      version: STATUSLINE_SNAP_CACHE_VERSION,
      convs: Object.fromEntries(sorted)
    });
  } catch {}
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
    ? (
        Number(usage.inputTokens || 0) +
        Number(usage.cacheReadTokens || 0) +
        Math.max(0, Number(usage.cacheWriteTokens ?? usage.cacheCreationInputTokens ?? usage.cache_creation_input_tokens ?? usage.cache_write_tokens ?? 0) || 0) +
        Number(usage.outputTokens || 0)
      )
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

function computeGenListSortKeys(generatorList = [], stepArrayIdxByStepNum = null, stepMetaMap = null) {
  const valid = Array.isArray(generatorList) ? generatorList : [];
  const directKeys = valid.map((entry, idx) => {
    if (!entry || typeof entry !== 'object') return null;
    const numericSteps = getGenEntryStepNums(entry);
    if (!numericSteps.length) return null;
    let minMatchedArrayIdx = -1;
    for (const n of numericSteps) {
      const matchedArr = stepArrayIdxByStepNum?.has(n)
        ? stepArrayIdxByStepNum.get(n)
        : (stepMetaMap?.get(n)?.arrayIdx ?? -1);
      if (matchedArr >= 0 && (minMatchedArrayIdx < 0 || matchedArr < minMatchedArrayIdx)) {
        minMatchedArrayIdx = matchedArr;
      }
    }
    const minStepIdx = Math.min(...numericSteps);
    return computeChronoSortKey(minMatchedArrayIdx, minStepIdx, idx, stepArrayIdxByStepNum);
  });

  const nonNullKeys = directKeys.filter(Boolean);
  const firstDirect = nonNullKeys.length ? nonNullKeys[0] : null;
  const lastDirect = nonNullKeys.length > 1 ? nonNullKeys[nonNullKeys.length - 1] : firstDirect;
  const isDescending = Boolean(
    firstDirect &&
    lastDirect &&
    compareChronoSortKeys(firstDirect, lastDirect) > 0
  );

  return valid.map((entry, idx) => {
    if (directKeys[idx]) return directKeys[idx];
    let prevDirect = null;
    for (let p = idx - 1; p >= 0; p--) {
      if (directKeys[p]) {
        prevDirect = directKeys[p];
        break;
      }
    }
    let nextDirect = null;
    for (let q = idx + 1; q < valid.length; q++) {
      if (directKeys[q]) {
        nextDirect = directKeys[q];
        break;
      }
    }
    let primary = Number.MAX_SAFE_INTEGER;
    let secondary = idx;
    if (prevDirect && nextDirect) {
      if (prevDirect.primary !== nextDirect.primary) {
        primary = (prevDirect.primary + nextDirect.primary) / 2;
      } else {
        primary = prevDirect.primary;
        secondary = (prevDirect.secondary + nextDirect.secondary) / 2;
      }
    } else if (!prevDirect && nextDirect) {
      primary = isDescending ? Number.MAX_SAFE_INTEGER : (nextDirect.primary - 0.5);
    } else if (prevDirect && !nextDirect) {
      primary = isDescending ? (prevDirect.primary - 0.5) : Number.MAX_SAFE_INTEGER;
    }
    return { primary, secondary, seq: idx };
  });
}

function orderGeneratorListChronologically(generatorList = [], stepArrayIdxByStepNum = null, stepMetaMap = null) {
  const valid = Array.isArray(generatorList) ? generatorList.filter((e) => e && typeof e === 'object') : [];
  if (valid.length <= 1) return valid.slice();
  const keys = computeGenListSortKeys(valid, stepArrayIdxByStepNum, stepMetaMap);
  return valid
    .map((entry, idx) => ({ entry, key: keys[idx] }))
    .sort((a, b) => compareChronoSortKeys(a.key, b.key))
    .map((item) => item.entry);
}

function mergeGeneratorMetadataLists(baseList = [], incomingList = []) {
  const base = Array.isArray(baseList) ? baseList.filter((e) => e && typeof e === 'object') : [];
  const incoming = Array.isArray(incomingList) ? incomingList.filter((e) => e && typeof e === 'object') : [];
  if (!base.length) return orderGeneratorListChronologically(incoming);
  if (!incoming.length) return orderGeneratorListChronologically(base);

  const orderedIncoming = orderGeneratorListChronologically(incoming);
  const incomingStepBounds = orderedIncoming.map((e) => {
    const steps = getGenEntryStepNums(e);
    return steps.length ? Math.min(...steps) : null;
  });
  const baseByStep = buildCallsByStepFromList(base);
  const accepted = [];
  const coveredSteps = new Set();
  let seq = 0;

  for (let i = 0; i < orderedIncoming.length; i++) {
    const entry = orderedIncoming[i];
    const steps = getGenEntryStepNums(entry);
    if (!steps.length) {
      let prevStep = null;
      for (let p = i - 1; p >= 0; p--) {
        if (incomingStepBounds[p] !== null) {
          prevStep = incomingStepBounds[p];
          break;
        }
      }
      let nextStep = null;
      for (let q = i + 1; q < orderedIncoming.length; q++) {
        if (incomingStepBounds[q] !== null) {
          nextStep = incomingStepBounds[q];
          break;
        }
      }
      let interpStep = Number.MAX_SAFE_INTEGER;
      if (prevStep !== null && nextStep !== null) {
        interpStep = (prevStep + nextStep) / 2;
      } else if (prevStep === null && nextStep !== null) {
        interpStep = nextStep - 0.5;
      }
      accepted.push({ entry, minStep: interpStep, seq: seq++ });
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

function calibrateByLargestRemainder(items, getVal, targetTotal) {
  const rawSum = items.reduce((sum, item) => {
    const v = Number(getVal(item) || 0);
    return sum + (v > 0 ? v : 0);
  }, 0);
  if (!(Number.isFinite(targetTotal) && targetTotal > 0 && rawSum > 0)) {
    return null;
  }
  const slots = items.map((item, idx) => {
    const reported = Math.max(0, Number(getVal(item) || 0));
    if (reported <= 0) {
      return { idx, reported: 0, floored: 0, remainder: -1 };
    }
    const exact = (reported / rawSum) * targetTotal;
    const floored = Math.floor(exact);
    return { idx, reported, floored, remainder: exact - floored };
  });
  const allocated = slots.reduce((sum, it) => sum + it.floored, 0);
  const deficit = targetTotal - allocated;
  if (deficit > 0) {
    const positiveItems = slots
      .filter((it) => it.reported > 0)
      .sort((a, b) => (b.remainder - a.remainder) || (b.reported - a.reported) || (a.idx - b.idx));
    for (let i = 0; i < deficit && i < positiveItems.length; i++) {
      positiveItems[i].floored += 1;
    }
  }
  return { rawSum, slots };
}

function buildCategoriesForBreakdown(contextWindowMetadata, parsedGroups, fallbackCategories) {
  const rawMetaCats = contextWindowMetadata?.tokenBreakdown?.categories;
  const sourceCats = (Array.isArray(rawMetaCats) && rawMetaCats.length > 0)
    ? rawMetaCats
    : (Array.isArray(fallbackCategories) && fallbackCategories.length > 0 ? fallbackCategories : null);

  if (sourceCats) {
    const normalized = [];
    for (const c of sourceCats) {
      const tokens = Number(c?.tokens || 0);
      if (!(tokens > 0)) continue;
      const typeNum = Number(c?.type || 0);
      const known = TOKEN_CATEGORIES[typeNum];
      normalized.push({
        type: typeNum,
        key: String(c?.key || known?.key || `other_${typeNum}`),
        label: String(c?.label || known?.label || `类别 ${typeNum}`),
        color: String(c?.color || known?.color || '#6b7280'),
        tokens
      });
    }
    if (normalized.length > 0) return normalized;
  }

  // Synthesize from parsedGroups when neither contextWindowMetadata nor SQLite provides categories
  const GROUP_TO_CAT_TYPE = {
    'System Prompt': 1,
    system: 1,
    Tools: 2,
    tools: 2,
    Rules: 3,
    rules: 3,
    MCP: 4,
    mcp: 4,
    Skills: 5,
    skills: 5,
    Subagents: 6,
    subagents: 6,
    'Chat Messages': 7,
    messages: 7,
    Workflows: 8,
    workflows: 8,
    Plugins: 9,
    plugins: 9,
    Flows: 10,
    flows: 10
  };
  const totalsByType = Object.create(null);
  const extraCats = [];
  for (const g of parsedGroups) {
    const tokens = Number(g?.tokens || 0);
    if (!(tokens > 0)) continue;
    const catType = GROUP_TO_CAT_TYPE[g.name] || GROUP_TO_CAT_TYPE[g.key] || 0;
    if (catType > 0 && TOKEN_CATEGORIES[catType]) {
      totalsByType[catType] = (totalsByType[catType] || 0) + tokens;
    } else {
      extraCats.push({
        type: 0,
        key: String(g.key || g.name || 'other'),
        label: String(g.label || g.name || '其他'),
        color: '#6b7280',
        tokens
      });
    }
  }
  const out = [];
  for (const cat of Object.values(TOKEN_CATEGORIES)) {
    const tokens = totalsByType[cat.type] || 0;
    if (tokens > 0) {
      out.push({ ...cat, tokens });
    }
  }
  return out.concat(extraCats);
}

function extractContextBreakdown(contextWindowMetadata, actualInputTokens = null, fallbackCategories = null) {
  const groups = contextWindowMetadata?.tokenBreakdown?.groups;
  if (!Array.isArray(groups) || !groups.length) return null;
  const total = Number(contextWindowMetadata.totalTokens || contextWindowMetadata.estimatedTokensUsed || 0);
  const labelMap = {
    'System Prompt': '系统提示与规则',
    Skills: 'Skills 技能指令',
    Tools: '工具定义 Schema',
    'Chat Messages': '对话与工具历史'
  };
  const parsedGroups = [];
  for (const g of groups) {
    let numTokens = Number(g.numTokens || 0);
    const allChildren = Array.isArray(g.children)
      ? g.children
          .map((c) => ({ name: String(c.name || ''), tokens: Number(c.numTokens || 0) }))
          .filter((c) => c.tokens > 0)
          .sort((a, b) => b.tokens - a.tokens)
      : [];
    let groupChildren = allChildren;
    let skillsSplitGroup = null;
    if (g.name === 'System Prompt' && allChildren.length) {
      const skillsChildren = allChildren.filter((c) => /^skills$/i.test(c.name.trim()) && c.tokens > 0);
      if (skillsChildren.length) {
        const skillsTokens = skillsChildren.reduce((sum, c) => sum + c.tokens, 0);
        if (skillsTokens > 0) {
          numTokens = Math.max(0, numTokens - skillsTokens);
          groupChildren = allChildren.filter((c) => !(/^skills$/i.test(c.name.trim()) && c.tokens > 0));
          skillsSplitGroup = {
            key: 'skills',
            name: 'Skills',
            label: 'Skills 技能指令',
            tokens: skillsTokens,
            percent: total > 0 ? Number(((skillsTokens / total) * 100).toFixed(1)) : 0,
            children: skillsChildren,
            topChildren: skillsChildren,
            childrenCount: skillsChildren.length
          };
        }
      }
    }
    const slicedChildren = g.name === 'Chat Messages' ? groupChildren.slice(0, 8) : groupChildren.slice(0, 18);
    parsedGroups.push({
      key: g.type || g.name || 'group',
      name: g.name || '未命名分组',
      label: labelMap[g.name] || g.name || '上下文分组',
      tokens: numTokens,
      percent: total > 0 ? Number(((numTokens / total) * 100).toFixed(1)) : 0,
      children: slicedChildren,
      topChildren: slicedChildren,
      childrenCount: groupChildren.length
    });
    if (skillsSplitGroup) {
      parsedGroups.push(skillsSplitGroup);
    }
  }

  const rawCategories = buildCategoriesForBreakdown(contextWindowMetadata, parsedGroups, fallbackCategories);
  const targetTotal = Math.round(Number(actualInputTokens || 0));
  const groupCalib = calibrateByLargestRemainder(parsedGroups, (g) => g.tokens, targetTotal);
  if (groupCalib) {
    for (const it of groupCalib.slots) {
      const g = parsedGroups[it.idx];
      g.reportedTokens = it.reported;
      g.calibrated = true;
      g.tokens = it.floored;
      g.percent = Number(((g.tokens / targetTotal) * 100).toFixed(1));
    }
    const catCalib = calibrateByLargestRemainder(rawCategories, (c) => c.tokens, targetTotal);
    const categories = rawCategories.map((c, idx) => {
      const slot = catCalib?.slots[idx];
      const calTok = slot ? slot.floored : c.tokens;
      return {
        ...c,
        rawTokens: c.tokens,
        tokens: calTok,
        percent: Number(((calTok / targetTotal) * 100).toFixed(1))
      };
    });
    return {
      totalTokens: targetTotal,
      reportedTotalTokens: groupCalib.rawSum,
      calibrated: true,
      maxContextTokens: Number(contextWindowMetadata.maxContextTokens || 0) || null,
      groups: parsedGroups,
      categories
    };
  }

  const catSum = rawCategories.reduce((s, c) => s + (c.tokens > 0 ? c.tokens : 0), 0);
  const catDenom = catSum > 0 ? catSum : total;
  const categories = rawCategories.map((c) => ({
    ...c,
    percent: catDenom > 0 ? Number(((c.tokens / catDenom) * 100).toFixed(1)) : 0
  }));

  return {
    totalTokens: total,
    maxContextTokens: Number(contextWindowMetadata.maxContextTokens || 0) || null,
    groups: parsedGroups,
    categories
  };
}

// ---------------------------------------------------------------------------
// Optional SQLite, Swarm/Subagent Tree, Compaction & Project Attribution Helpers
// ---------------------------------------------------------------------------

function resolveConvDbPath(convId, source, agDir, cliDir, ideDir) {
  if (!convId || !CONV_ID_RE.test(convId)) return '';
  const dirs = source === 'cli'
    ? [cliDir, agDir, ideDir]
    : [agDir, ideDir, cliDir];
  const seen = new Set();
  for (const d of dirs) {
    if (!d || seen.has(d)) continue;
    seen.add(d);
    const p = join(d, 'conversations', `${convId}.db`);
    try {
      if (existsSync(p)) return p;
    } catch {}
  }
  return '';
}

function findConvTranscriptPath(convId, rootDirs = []) {
  if (!convId || !CONV_ID_RE.test(convId)) return '';
  const seen = new Set();
  for (const d of rootDirs) {
    if (!d || seen.has(d)) continue;
    seen.add(d);
    const std = join(d, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
    const direct = join(d, 'brain', convId, 'transcript.jsonl');
    try {
      if (existsSync(std)) return std;
      if (existsSync(direct)) return direct;
    } catch {}
  }
  return '';
}

async function readMergedSummariesIndex(agDir, cliDir, ideDir) {
  const dirs = [];
  for (const d of [agDir, ideDir, cliDir]) {
    if (d && !dirs.includes(d)) dirs.push(d);
  }
  const byId = new Map();
  const childSets = new Map();
  let anyLoaded = false;

  for (const d of dirs) {
    const idx = await readConversationSummariesIndex(d);
    if (!idx) continue;
    anyLoaded = true;
    for (const [cid, entry] of idx.byId.entries()) {
      const prev = byId.get(cid);
      if (!prev) {
        byId.set(cid, { ...entry });
      } else {
        byId.set(cid, {
          title: prev.title || entry.title,
          workspaceUri: prev.workspaceUri || entry.workspaceUri,
          projectName: prev.projectName || entry.projectName,
          agentName: prev.agentName || entry.agentName,
          parentConvId: prev.parentConvId || entry.parentConvId,
          nestingDepth: Math.max(prev.nestingDepth || 0, entry.nestingDepth || 0),
          source: prev.source || entry.source,
          status: prev.status || entry.status
        });
      }
    }
    for (const [pid, children] of idx.childrenByParent.entries()) {
      let set = childSets.get(pid);
      if (!set) {
        set = new Set();
        childSets.set(pid, set);
      }
      for (const ch of children) {
        if (ch && ch !== pid) set.add(ch);
      }
    }
  }

  if (!anyLoaded) return null;
  const childrenByParent = new Map();
  for (const [pid, set] of childSets.entries()) {
    childrenByParent.set(pid, [...set]);
  }
  return { byId, childrenByParent };
}

function summarizeChildTranscript(logPath, dynamicModelMap = {}) {
  if (!logPath) {
    return {
      turnsCount: 0,
      inputTokens: 0,
      cacheTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUSD: 0,
      cacheSavingsUSD: 0,
      latestModel: ''
    };
  }
  let st = null;
  try {
    if (!existsSync(logPath)) return null;
    st = statSync(logPath);
  } catch {
    return null;
  }
  const cacheKey = `${st.size}:${st.mtimeMs}`;
  const cached = subagentSummaryCache.get(logPath);
  if (cached && cached.key === cacheKey) {
    return cached.summary;
  }

  let turnsCount = 0;
  let inputTokens = 0;
  let cacheTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let costUSD = 0;
  let cacheSavingsUSD = 0;
  let runningModel = '';
  let latestModel = '';

  try {
    const lines = readFileSync(logPath, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'USER_INPUT' && ev.content) {
        const sw = parseModelSettingFromText(ev.content);
        if (sw) runningModel = sw;
      }
      if (!isModelTurnStep(ev)) continue;
      const u = extractStepUsage(ev);
      const tot = u.input + u.cache + u.output;
      if (tot <= 0) continue;
      turnsCount++;
      inputTokens += u.input;
      cacheTokens += u.cache;
      outputTokens += u.output;
      totalTokens += tot;
      const rawModel = extractStepModel(ev, null, runningModel);
      if (rawModel) latestModel = rawModel;
      const modelKey = normalizeModelId(rawModel, dynamicModelMap);
      const priced = calculateRequestApiCost(
        {
          model: rawModel,
          modelKey,
          inputTokens: u.input,
          cacheTokens: u.cache,
          outputTokens: u.output,
          thinkingTokens: u.thinking,
          date: ev.created_at
        },
        dynamicModelMap
      );
      if (priced.isPriced) {
        costUSD += priced.costUSD || 0;
        cacheSavingsUSD += priced.cacheSavingsUSD || 0;
      } else {
        const ref = calculateReferenceCost(
          { inputTokens: u.input, cacheTokens: u.cache, outputTokens: u.output },
          'gemini-3.8-flash',
          ev.created_at
        );
        costUSD += ref.totalCostUSD || 0;
        cacheSavingsUSD += ref.cacheSavingsUSD || 0;
      }
    }
  } catch {}

  const summary = {
    turnsCount,
    inputTokens,
    cacheTokens,
    outputTokens,
    totalTokens,
    costUSD: Number(costUSD.toFixed(4)),
    cacheSavingsUSD: Number(cacheSavingsUSD.toFixed(4)),
    latestModel
  };
  if (subagentSummaryCache.size > 512) {
    const firstK = subagentSummaryCache.keys().next().value;
    if (firstK) subagentSummaryCache.delete(firstK);
  }
  subagentSummaryCache.set(logPath, { key: cacheKey, summary });
  return summary;
}

function getFileMtimeSigSafe(filePath) {
  try {
    if (!filePath || !existsSync(filePath)) return '0';
    const st = statSync(filePath);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return '0';
  }
}

function getSqliteFileSigSafe(dbPath) {
  const base = getFileMtimeSigSafe(dbPath);
  if (base === '0') return '0';
  const wal = getFileMtimeSigSafe(`${dbPath}-wal`);
  return wal === '0' ? base : `${base}|${wal}`;
}

function collectAgentTree(convId, convBrainDir, {
  agDir,
  cliDir,
  ideDir,
  summariesIndex,
  dynamicModelMap = {},
  parentTurnsCount = 0,
  parentSessionTotals = { inputTokens: 0, cacheTokens: 0, outputTokens: 0, totalTokens: 0 },
  parentCostUSD = 0,
  parentCacheSavingsUSD = 0
} = {}) {
  const childMap = new Map(); // childConvId -> descriptor
  let swarmData = null;

  const upsertChild = (childId, patch) => {
    const cid = String(childId || '').trim();
    if (!cid || cid === convId || !CONV_ID_RE.test(cid)) return;
    const prev = childMap.get(cid);
    if (!prev) {
      childMap.set(cid, {
        id: cid,
        name: patch.name || cid.slice(0, 8),
        role: patch.role || 'subagent',
        model: patch.model || '',
        state: patch.state || 'done'
      });
    } else {
      childMap.set(cid, {
        id: cid,
        name: prev.name && prev.name !== cid.slice(0, 8) ? prev.name : (patch.name || prev.name),
        role: prev.role && prev.role !== 'subagent' ? prev.role : (patch.role || prev.role),
        model: prev.model || patch.model || '',
        state: prev.state || patch.state || 'done'
      });
    }
  };

  // 1. Swarm members.json
  if (convBrainDir) {
    const swarmMembersPath = join(convBrainDir, '.system_generated', 'swarm', 'members.json');
    const rawSwarm = readJsonSafe(swarmMembersPath, null);
    if (rawSwarm && typeof rawSwarm === 'object') {
      swarmData = {
        title: rawSwarm.title || rawSwarm.swarm_title || rawSwarm.name || null
      };
      const members = rawSwarm.members;
      if (members && typeof members === 'object' && !Array.isArray(members)) {
        for (const [mName, mObj] of Object.entries(members)) {
          if (!mObj || typeof mObj !== 'object') continue;
          const cid = mObj.conversation_id || mObj.conversationId || mObj.id || '';
          if (!cid || cid === convId) continue;
          const state = mObj.killed
            ? 'killed'
            : String(mObj.phase || mObj.state || mObj.status || 'waiting').trim().toLowerCase();
          upsertChild(cid, {
            name: mObj.name || mName,
            role: mObj.role || 'worker',
            model: mObj.applied_model || mObj.model || mObj.desired_model || '',
            state
          });
        }
      } else if (Array.isArray(members)) {
        for (const mObj of members) {
          if (!mObj || typeof mObj !== 'object') continue;
          const cid = mObj.conversation_id || mObj.conversationId || mObj.id || '';
          if (!cid || cid === convId) continue;
          const state = mObj.killed
            ? 'killed'
            : String(mObj.phase || mObj.state || mObj.status || 'waiting').trim().toLowerCase();
          upsertChild(cid, {
            name: mObj.name || cid.slice(0, 8),
            role: mObj.role || 'worker',
            model: mObj.applied_model || mObj.model || mObj.desired_model || '',
            state
          });
        }
      }
    }

    // 2. Subagents directory (*.json)
    const subagentsDir = join(convBrainDir, '.system_generated', 'subagents');
    try {
      if (existsSync(subagentsDir)) {
        const files = readdirSync(subagentsDir).filter((f) => f.endsWith('.json')).slice(0, 64);
        for (const f of files) {
          const obj = readJsonSafe(join(subagentsDir, f), null);
          if (!obj || typeof obj !== 'object') continue;
          const cid = obj.conversationId || obj.conversation_id || obj.id || '';
          if (!cid || cid === convId) continue;
          const desc = obj.subagentDescriptor && typeof obj.subagentDescriptor === 'object'
            ? obj.subagentDescriptor
            : {};
          const role = desc.role || desc.typeName || obj.role || 'subagent';
          const name = obj.name || desc.name || desc.typeName || f.replace(/\.json$/i, '');
          const state = String(obj.state || obj.status || 'done').trim().toLowerCase();
          const model = obj.model || obj.applied_model || desc.model || '';
          upsertChild(cid, { name, role, model, state });
        }
      }
    } catch {}
  }

  // 3. SQLite conversation_summaries / conversation_parents children
  const sqlChildren = summariesIndex?.childrenByParent?.get(convId) || [];
  for (const cid of sqlChildren) {
    if (!cid || cid === convId) continue;
    const sumEntry = summariesIndex?.byId?.get(cid) || null;
    upsertChild(cid, {
      name: sumEntry?.agentName || sumEntry?.title || cid.slice(0, 8),
      role: sumEntry?.agentName ? 'subagent' : (sumEntry?.source || 'subagent'),
      model: '',
      state: sumEntry?.status ? String(sumEntry.status).toLowerCase() : 'done'
    });
  }

  if (childMap.size === 0) return null;

  const searchRoots = [agDir, cliDir, ideDir].filter(Boolean);
  const children = [];
  let sumChildrenTurns = 0;
  let sumChildrenTotal = 0;
  let sumChildrenInput = 0;
  let sumChildrenCache = 0;
  let sumChildrenOutput = 0;
  let sumChildrenCost = 0;
  let sumChildrenSavings = 0;

  for (const desc of childMap.values()) {
    const logPath = findConvTranscriptPath(desc.id, searchRoots);
    const stats = summarizeChildTranscript(logPath, dynamicModelMap) || {
      turnsCount: 0,
      inputTokens: 0,
      cacheTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUSD: 0,
      cacheSavingsUSD: 0,
      latestModel: ''
    };
    const rawModel = desc.model || stats.latestModel || '';
    const modelKey = normalizeModelId(rawModel, dynamicModelMap);
    const displayModel = rawModel ? formatModelDisplayName(rawModel, modelKey) : '未记录模型';

    sumChildrenTurns += stats.turnsCount;
    sumChildrenTotal += stats.totalTokens;
    sumChildrenInput += stats.inputTokens;
    sumChildrenCache += stats.cacheTokens;
    sumChildrenOutput += stats.outputTokens;
    sumChildrenCost += stats.costUSD;
    sumChildrenSavings += stats.cacheSavingsUSD;

    children.push({
      id: desc.id,
      name: truncateCleanText(desc.name || desc.id.slice(0, 8), 48) || desc.id.slice(0, 8),
      role: truncateCleanText(desc.role || 'subagent', 32) || 'subagent',
      model: truncateCleanText(displayModel, 48) || '未记录模型',
      state: String(desc.state || 'done').toLowerCase(),
      turnsCount: stats.turnsCount,
      totalTokens: stats.totalTokens,
      costUSD: Number(stats.costUSD.toFixed(4)),
      cacheSavingsUSD: Number(stats.cacheSavingsUSD.toFixed(4))
    });
  }

  children.sort((a, b) => (b.totalTokens - a.totalTokens) || (b.costUSD - a.costUSD) || (b.turnsCount - a.turnsCount));

  return {
    isSwarm: Boolean(swarmData),
    swarmTitle: swarmData?.title ? truncateCleanText(swarmData.title, 80) : null,
    childrenCount: children.length,
    activeChildrenCount: children.filter((c) => c.state === 'working' || c.state === 'running').length,
    children: children.slice(0, 20),
    treeTotals: {
      turnsCount: parentTurnsCount + sumChildrenTurns,
      totalTokens: (parentSessionTotals.totalTokens || 0) + sumChildrenTotal,
      inputTokens: (parentSessionTotals.inputTokens || 0) + sumChildrenInput,
      cacheTokens: (parentSessionTotals.cacheTokens || 0) + sumChildrenCache,
      outputTokens: (parentSessionTotals.outputTokens || 0) + sumChildrenOutput,
      costUSD: Number((parentCostUSD + sumChildrenCost).toFixed(4)),
      cacheSavingsUSD: Number((parentCacheSavingsUSD + sumChildrenSavings).toFixed(4))
    }
  };
}

function sanitizeCompactionFull(raw, maxLen = 2400) {
  if (!raw || typeof raw !== 'string') return '';
  const lines = raw.split(/\r?\n/).map((line) =>
    sanitizeDiagnosticText(
      line
        .replace(/file:\/\/\/[^\s"'<>]+/gi, '<FILE>')
        .replace(/(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s"'<>]+/g, '~')
        .replace(/\b(?:Bearer\s+[A-Za-z0-9._~+/=-]{8,}|(?:sk|ghp|gho|glpat|xoxb|AIza|ya29)[-_A-Za-z0-9.]{12,})\b/gi, '<REDACTED>'),
      0
    )
  );
  let joined = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (maxLen > 0 && joined.length > maxLen) {
    joined = `${joined.slice(0, Math.max(1, maxLen - 3))}...`;
  }
  return joined;
}

function buildCompactionsList(rawSteps = [], turns = [], sqliteCompactionSteps = []) {
  const events = [];
  const coveredStepNums = new Set();

  // 1. Transcript CHECKPOINT steps
  for (let i = 0; i < rawSteps.length; i++) {
    const step = rawSteps[i];
    if (!step) continue;
    const type = String(step.type || '');
    if (type !== 'CHECKPOINT' && !step.checkpoint) continue;
    const sIdx = Number(step.step_index ?? i);
    const cpText = (typeof step.content === 'string' ? step.content : '')
      || step.checkpoint?.sessionSummary
      || step.checkpoint?.summary
      || '';
    coveredStepNums.add(sIdx);
    events.push({
      stepIndex: sIdx,
      arrayIdx: i,
      createdAt: step.created_at || '',
      rawSummary: cpText,
      source: 'checkpoint'
    });
  }

  // 2. SQLite step_type = 23 compaction steps
  if (Array.isArray(sqliteCompactionSteps)) {
    for (const rawSIdx of sqliteCompactionSteps) {
      const sIdx = Number(rawSIdx);
      if (!Number.isFinite(sIdx) || coveredStepNums.has(sIdx)) continue;
      // Avoid duplicating if a checkpoint step exists within +-1 step index
      if ([...coveredStepNums].some((k) => Math.abs(k - sIdx) <= 1)) continue;
      coveredStepNums.add(sIdx);
      const matchedRawIdx = rawSteps.findIndex((s, idx) => Number(s?.step_index ?? idx) === sIdx);
      const matchedStep = matchedRawIdx >= 0 ? rawSteps[matchedRawIdx] : null;
      const cpText = (typeof matchedStep?.content === 'string' ? matchedStep.content : '')
        || matchedStep?.checkpoint?.sessionSummary
        || matchedStep?.checkpoint?.summary
        || '';
      events.push({
        stepIndex: sIdx,
        arrayIdx: matchedRawIdx,
        createdAt: matchedStep?.created_at || '',
        rawSummary: cpText,
        source: 'sqlite'
      });
    }
  }

  // Compute before/after tokens for each explicit compaction event using turns
  const findBeforeAfterTurns = (ev) => {
    let prevTurn = null;
    let nextTurn = null;
    for (const t of turns) {
      const tStep = t.stepIndex != null && Number.isFinite(Number(t.stepIndex)) ? Number(t.stepIndex) : null;
      const tArr = typeof t._arrayIdx === 'number' ? t._arrayIdx : -1;
      const isBefore = (ev.arrayIdx >= 0 && tArr >= 0)
        ? tArr < ev.arrayIdx
        : (tStep !== null ? tStep < ev.stepIndex : false);
      const isAfter = (ev.arrayIdx >= 0 && tArr >= 0)
        ? tArr > ev.arrayIdx
        : (tStep !== null ? tStep > ev.stepIndex : false);
      if (isBefore) prevTurn = t;
      else if (isAfter && !nextTurn) nextTurn = t;
    }
    return { prevTurn, nextTurn };
  };

  // Track which turn indices are already explained by an explicit compaction
  const explainedDropTurnIdx = new Set();
  const resolved = [];
  for (const ev of events) {
    const { prevTurn, nextTurn } = findBeforeAfterTurns(ev);
    if (nextTurn) explainedDropTurnIdx.add(nextTurn.turnIndex);
    const beforeTokens = prevTurn?.totalTokens || 0;
    const afterTokens = nextTurn?.totalTokens || 0;
    const savedTokens = beforeTokens > afterTokens ? (beforeTokens - afterTokens) : 0;
    const savedPercent = beforeTokens > 0 && savedTokens > 0
      ? Number(((savedTokens / beforeTokens) * 100).toFixed(1))
      : 0;
    const fallbackText = ev.source === 'sqlite'
      ? '检测到上下文自动压缩（SQLite 压缩节点）'
      : '检测到上下文压缩检查点';
    const rawText = (ev.rawSummary || '').trim() || fallbackText;
    const item = {
      stepIndex: ev.stepIndex,
      createdAt: ev.createdAt || nextTurn?.createdAt || prevTurn?.createdAt || '',
      beforeTokens,
      afterTokens,
      savedTokens,
      savedPercent,
      summaryPreview: sanitizeSqliteText(rawText, 120),
      summaryFull: sanitizeCompactionFull(rawText, 2400)
    };
    Object.defineProperty(item, '_compactionMeta', {
      value: { isExplicit: true, matchedTurnIndex: nextTurn?.turnIndex ?? null },
      enumerable: false
    });
    resolved.push(item);
  }

  // 3. Large context drop turns (deltaTokens <= -10000) not already matched by a checkpoint
  for (let i = 1; i < turns.length; i++) {
    const cur = turns[i];
    const prev = turns[i - 1];
    if (!cur || !prev) continue;
    if (explainedDropTurnIdx.has(cur.turnIndex)) continue;
    if ((cur.deltaTokens || 0) > -10000) continue;
    const beforeTokens = prev.totalTokens || 0;
    const afterTokens = cur.totalTokens || 0;
    if (beforeTokens <= afterTokens) continue;
    const savedTokens = beforeTokens - afterTokens;
    const savedPercent = beforeTokens > 0 ? Number(((savedTokens / beforeTokens) * 100).toFixed(1)) : 0;
    const stepIndex = cur.stepIndex != null && Number.isFinite(Number(cur.stepIndex))
      ? Number(cur.stepIndex)
      : cur.turnIndex;
    const fallbackText = `上下文窗口从 ${beforeTokens.toLocaleString()} 回落至 ${afterTokens.toLocaleString()} tokens（释放 ${savedTokens.toLocaleString()} tokens）`;
    const item = {
      stepIndex,
      createdAt: cur.createdAt || '',
      beforeTokens,
      afterTokens,
      savedTokens,
      savedPercent,
      summaryPreview: sanitizeSqliteText(fallbackText, 120),
      summaryFull: sanitizeCompactionFull(fallbackText, 2400)
    };
    Object.defineProperty(item, '_compactionMeta', {
      value: { isExplicit: false, matchedTurnIndex: cur.turnIndex },
      enumerable: false
    });
    resolved.push(item);
  }

  resolved.sort((a, b) => (a.stepIndex - b.stepIndex) || String(a.createdAt).localeCompare(String(b.createdAt)));
  const numbered = resolved.map((item, idx) => {
    const out = {
      index: idx + 1,
      ...item
    };
    if (item._compactionMeta) {
      Object.defineProperty(out, '_compactionMeta', {
        value: item._compactionMeta,
        enumerable: false
      });
    }
    return out;
  });
  return numbered.slice(-20).reverse();
}

export function annotateTurnsCompactionAndCacheBreak(turns = [], compactions = []) {
  if (!Array.isArray(turns) || !turns.length) return turns;

  const explicitCompacted = new Map();
  if (Array.isArray(compactions)) {
    for (const c of compactions) {
      if (!c || typeof c !== 'object') continue;
      if (c._compactionMeta && c._compactionMeta.isExplicit === false) continue;
      const savedPct = Number(c.savedPercent || 0);
      let matchedIdx = -1;
      const targetTurnIdx = c._compactionMeta?.matchedTurnIndex ?? c.turnIndex ?? null;
      if (targetTurnIdx != null && Number.isFinite(Number(targetTurnIdx))) {
        matchedIdx = turns.findIndex((t, idx) => (t.turnIndex ?? (idx + 1)) === Number(targetTurnIdx));
      }
      if (matchedIdx < 0 && c.stepIndex != null && Number.isFinite(Number(c.stepIndex))) {
        const cStep = Number(c.stepIndex);
        matchedIdx = turns.findIndex((t) => t.stepIndex != null && Number(t.stepIndex) === cStep);
        if (matchedIdx < 0) {
          matchedIdx = turns.findIndex((t) => t.stepIndex != null && Number(t.stepIndex) > cStep);
        }
      }
      if (matchedIdx >= 0) {
        const prevPct = explicitCompacted.get(matchedIdx) || 0;
        explicitCompacted.set(matchedIdx, Math.max(prevPct, savedPct > 0 ? savedPct : 0));
      }
    }
  }

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (!t || typeof t !== 'object') continue;
    const promptTotal = (t.inputTokens || 0) + (t.cacheTokens || 0) + (t.cacheWriteTokens || 0);
    const prev = i > 0 ? turns[i - 1] : null;
    const prevPrompt = prev
      ? ((prev.inputTokens || 0) + (prev.cacheTokens || 0) + (prev.cacheWriteTokens || 0))
      : 0;
    const hasExplicit = explicitCompacted.has(i);
    const explicitSavedPct = hasExplicit ? explicitCompacted.get(i) : 0;
    const heuristicCompacted = Boolean(prevPrompt >= 12000 && promptTotal > 0 && promptTotal < prevPrompt * 0.72);

    if (hasExplicit || heuristicCompacted) {
      t.isCompacted = true;
      t.compactionDropPercent = explicitSavedPct > 0
        ? Number(explicitSavedPct.toFixed(1))
        : (prevPrompt > promptTotal && prevPrompt > 0
            ? Number((((prevPrompt - promptTotal) / prevPrompt) * 100).toFixed(1))
            : 0);
      t.isCacheBreak = false;
      t.cacheBreakPrevPercent = null;
    } else if (
      prev &&
      (prev.cacheHitPercent || 0) >= 45 &&
      promptTotal >= 6000 &&
      (t.cacheHitPercent || 0) < 10
    ) {
      t.isCompacted = false;
      t.compactionDropPercent = null;
      t.isCacheBreak = true;
      t.cacheBreakPrevPercent = prev.cacheHitPercent;
    } else {
      t.isCompacted = false;
      t.compactionDropPercent = null;
      t.isCacheBreak = false;
      t.cacheBreakPrevPercent = null;
    }
  }
  return turns;
}

function resolveProjectNameForConv(convId, summariesById = null) {
  const fromSql = summariesById?.get(convId)?.projectName;
  if (fromSql) return fromSql;
  const cachedWs = convWorkspaceCache.get(convId);
  if (cachedWs) {
    const raw = cachedWs.metaRepoName || (cachedWs.workspacePath ? basename(cachedWs.workspacePath) : '');
    if (raw) {
      const safe = extractProjectNameFromUris(null, raw);
      if (safe) return safe;
    }
  }
  return '未归类工作区';
}

export async function scanConversation(requestedConvId = '', options = {}) {
  const force = Boolean(options.force);
  const lightweight = Boolean(options.lightweight);
  const rpcTimeoutMs = Number(options.rpcTimeoutMs) > 0 ? Number(options.rpcTimeoutMs) : 4500;
  const sqliteTimeoutMs = Number(options.sqliteTimeoutMs) > 0 ? Number(options.sqliteTimeoutMs) : 1500;
  const deadlineAt = Number(options.deadlineAt) > 0 ? Number(options.deadlineAt) : 0;
  const getRemainingBudgetMs = () => (deadlineAt > 0 ? Math.max(0, deadlineAt - Date.now()) : Infinity);
  const rpcSignal = options.signal || null;
  const nowMs = Number(options.nowMs) || Date.now();
  const background = Boolean(options.background);
  const menubarMode = String(options.menubarMode || 'context');
  const allowDiskCacheWithoutLs = Boolean(options.allowDiskCacheWithoutLs);
  const skipWorkspaceLookup = Boolean(options.skipWorkspaceLookup);
  const stateDir = getPluginStateDir();
  const agDir = findAppDataDir();
  const ideDataDir = findIdeDataDir();
  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS || '';
  const lsCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN || '';
  const hasLsConfig = Boolean(lsAddr && lsCsrf);
  const lsKey = hasLsConfig ? `${lsAddr}|${lsCsrf}` : '';
  const lsMemHash = hashLsKey(lsKey);
  const lsDiskHash = hasLsConfig ? hashLsAddr(lsAddr) : '';
  if (force) {
    fileAuditCache.clear();
    scanSnapCache.clear();
    subagentSummaryCache.clear();
  }

  const hasValidRequestedConv = Boolean(requestedConvId && CONV_ID_RE.test(requestedConvId));
  const noFallbackToRecent = Boolean(options.noFallbackToRecent);
  const cliMode = isCliRuntimeEnv();
  const cliDataDir = findCliDataDir();
  const searchRoots = [agDir, ideDataDir, cliDataDir].filter(Boolean);
  const recentConversations = ((options.skipRecentList && hasValidRequestedConv) || (noFallbackToRecent && !hasValidRequestedConv))
    ? []
    : listRecentConversations(48, nowMs);
  let convId = hasValidRequestedConv
    ? requestedConvId
    : (noFallbackToRecent ? '' : resolveActiveConversationId(recentConversations, nowMs, searchRoots));
  const validatedPinnedConvId = lightweight ? '' : getValidatedPinnedConvId(recentConversations, searchRoots);

  if (!convId && !noFallbackToRecent) {
    const envConvId = String(process.env.ANTIGRAVITY_CONVERSATION_ID || '').trim();
    if (CONV_ID_RE.test(envConvId)) {
      const hasEnvLog =
        existsSync(join(agDir, 'brain', envConvId, '.system_generated', 'logs', 'transcript.jsonl')) ||
        existsSync(join(agDir, 'brain', envConvId, '.system_generated', 'logs', 'transcript_full.jsonl')) ||
        existsSync(join(ideDataDir, 'brain', envConvId, '.system_generated', 'logs', 'transcript.jsonl')) ||
        existsSync(join(ideDataDir, 'brain', envConvId, '.system_generated', 'logs', 'transcript_full.jsonl')) ||
        existsSync(join(cliDataDir, 'brain', envConvId, '.system_generated', 'logs', 'transcript.jsonl')) ||
        existsSync(join(cliDataDir, 'brain', envConvId, '.system_generated', 'logs', 'transcript_full.jsonl')) ||
        existsSync(join(cliDataDir, 'brain', envConvId, 'transcript.jsonl'));
      if (hasEnvLog) convId = envConvId;
    }
  }

  if (!convId) {
    const effEmptyRpcTimeoutMs = lightweight
      ? Math.min(rpcTimeoutMs, Math.floor(getRemainingBudgetMs() - 70))
      : rpcTimeoutMs;
    const emptyHost = allowDiskCacheWithoutLs
      ? await getHostUserStatus(false, {
          background: true,
          nowMs,
          allowDiskCacheWithoutLs: true,
          ...(lightweight
            ? (effEmptyRpcTimeoutMs < 35
                ? { skipLiveRpc: true }
                : { rpcTimeoutMs: effEmptyRpcTimeoutMs, unrefSocket: true, noKeepAlive: true, ...(rpcSignal ? { signal: rpcSignal } : {}) })
            : {})
        })
      : null;
    const emptyQuotas = emptyHost
      ? (lightweight
          ? (emptyHost.quotas || [])
          : enrichQuotasWithCalibration(emptyHost.quotas || [], null, { persist: false, nowMs }))
      : null;
    return {
      ok: true,
      conversationId: null,
      conversationSource: cliMode ? 'cli' : 'desktop',
      pinnedConvId: validatedPinnedConvId || null,
      recentConversations: [],
      ...(emptyHost ? { quotas: emptyQuotas, quotaStatus: emptyHost.quotaStatus } : {}),
      empty: true,
      etag: 'empty'
    };
  }

  const desktopLogsDir = join(agDir, 'brain', convId, '.system_generated', 'logs');
  const ideLogsDir = join(ideDataDir, 'brain', convId, '.system_generated', 'logs');
  const cliLogsDir = join(cliDataDir, 'brain', convId, '.system_generated', 'logs');
  const cliDirectLog = join(cliDataDir, 'brain', convId, 'transcript.jsonl');
  const hasDesktopLogs = existsSync(desktopLogsDir);
  const hasIdeLogs = !hasDesktopLogs && ideDataDir !== agDir && existsSync(ideLogsDir);
  const hasAnyDesktopLogs = hasDesktopLogs || hasIdeLogs;
  const hasCliLogs = existsSync(cliLogsDir) || existsSync(cliDirectLog);
  const useCliLogs = (cliMode && hasCliLogs) || (!hasAnyDesktopLogs && hasCliLogs);
  const conversationSource = useCliLogs ? 'cli' : (cliMode && !hasAnyDesktopLogs ? 'cli' : 'desktop');
  const brainBase = useCliLogs
    ? cliLogsDir
    : (hasDesktopLogs ? desktopLogsDir : (hasIdeLogs ? ideLogsDir : cliLogsDir));
  const convBrainDir = useCliLogs
    ? join(cliDataDir, 'brain', convId)
    : (hasDesktopLogs ? join(agDir, 'brain', convId) : (hasIdeLogs ? join(ideDataDir, 'brain', convId) : join(cliDataDir, 'brain', convId)));
  const fullPath = join(brainBase, 'transcript_full.jsonl');
  const compactPath = join(brainBase, 'transcript.jsonl');
  let fullStatMtime = 0;
  let fullStatSize = 0;
  if (existsSync(fullPath)) {
    try {
      const fst = statSync(fullPath);
      fullStatMtime = fst.mtimeMs;
      fullStatSize = fst.size;
    } catch {}
  }
  let compactStatMtime = 0;
  let compactStatSize = 0;
  if (existsSync(compactPath)) {
    try {
      const cst = statSync(compactPath);
      compactStatMtime = cst.mtimeMs;
      compactStatSize = cst.size;
    } catch {}
  }
  const targetLogPath = lightweight
    ? (compactStatSize > 0 || existsSync(compactPath)
        ? compactPath
        : ((fullStatMtime > 0 && fullStatSize <= 4 * 1024 * 1024) ? fullPath : cliDirectLog))
    : ((fullStatMtime > 0 && fullStatSize <= 32 * 1024 * 1024)
        ? fullPath
        : (existsSync(compactPath) ? compactPath : cliDirectLog));

  let logStatMtime = 0;
  let logStatSize = 0;
  if (targetLogPath === fullPath && fullStatMtime > 0) {
    logStatMtime = fullStatMtime;
    logStatSize = fullStatSize;
  } else if (targetLogPath === compactPath && compactStatMtime > 0) {
    logStatMtime = compactStatMtime;
    logStatSize = compactStatSize;
  } else if (existsSync(targetLogPath)) {
    try {
      const st = statSync(targetLogPath);
      logStatMtime = st.mtimeMs;
      logStatSize = st.size;
    } catch {}
  }
  if (logStatMtime > 0) {
    noteObservedTranscriptActivity(logStatMtime, nowMs);
  }

  const hostCacheMtimeMs = getFileMtimeSigSafe(getHostStatusCachePath());
  const convDbPath = resolveConvDbPath(convId, conversationSource, agDir, cliDataDir, ideDataDir);
  const convDbSig = getSqliteFileSigSafe(convDbPath);
  const genCacheMtimeMs = lightweight ? getFileMtimeSigSafe(getActiveConvGenCachePath()) : '0';
  const prevStatuslineSnap = (lightweight && convId)
    ? (loadStatuslineSnapCache()?.convs?.[convId] || null)
    : null;
  if (lightweight && !force && prevStatuslineSnap) {
    const snap = prevStatuslineSnap;
    const age = Math.max(0, nowMs - Number(snap.savedAt || 0));
    const ttl = snap.metaSettled ? 15_000 : 2_000;
    const sigMatches = (
      snap.targetLogPath === targetLogPath &&
      snap.logSize === logStatSize &&
      snap.logMtimeMs === logStatMtime &&
      snap.fullSize === fullStatSize &&
      snap.fullMtimeMs === fullStatMtime &&
      snap.hostCacheMtimeMs === hostCacheMtimeMs &&
      snap.convDbSig === convDbSig &&
      snap.genCacheMtimeMs === genCacheMtimeMs &&
      snap.lsKeyHash === lsDiskHash &&
      age < ttl
    );
    if (sigMatches) {
      return {
        ok: true,
        fromStatuslineSnap: true,
        transcriptProgressed: false,
        scannedAt: Number(snap.savedAt || nowMs),
        conversationId: convId,
        conversationSource,
        quotas: snap.quotas || [],
        context: snap.context || {},
        speed: snap.speed || null,
        turnsCount: Number(snap.turnsCount || 0),
        turns: []
      };
    }
  }

  const effHostRpcTimeoutMs = lightweight
    ? Math.min(rpcTimeoutMs, Math.floor(getRemainingBudgetMs() - 50))
    : rpcTimeoutMs;
  const hostPromise = getHostUserStatus(force, {
    background,
    menubarMode,
    nowMs,
    latestTranscriptMtimeMs: logStatMtime,
    allowDiskCacheWithoutLs,
    ...(lightweight
      ? (effHostRpcTimeoutMs < 35
          ? { skipLiveRpc: true }
          : {
              rpcTimeoutMs: effHostRpcTimeoutMs,
              unrefSocket: true,
              noKeepAlive: true,
              ...(rpcSignal ? { signal: rpcSignal } : {})
            })
      : {})
  });
  let host = lightweight ? null : await hostPromise;

  const swarmSig = lightweight ? '' : getFileMtimeSigSafe(join(convBrainDir, '.system_generated', 'swarm', 'members.json'));
  const subagentsSig = lightweight ? '' : getFileMtimeSigSafe(join(convBrainDir, '.system_generated', 'subagents'));
  const calSig = lightweight ? '' : getFileMtimeSigSafe(getQuotaCalibrationPath());
  const baseSnapKey = lightweight ? '' : `${convId}|${logStatMtime}|${logStatSize}|${convDbSig}|${swarmSig}|${subagentsSig}|${calSig}|${host.sig}|${lsMemHash}|${agDir}|${stateDir}`;
  const prevHit = lightweight ? null : scanSnapCache.get(convId);
  const sameBaseKey = Boolean(!lightweight && prevHit && prevHit.baseKey === baseSnapKey);
  if (!lightweight && !force && sameBaseKey) {
    if (prevHit.metaSettled || !hasLsConfig || nowMs < (prevHit.nextMetaCheckAt || 0)) {
      const cachedSummariesIndex = recentConversations.length
        ? await readMergedSummariesIndex(agDir, cliDataDir, ideDataDir)
        : null;
      const enrichedRecent = enrichRecentConversationsMetadata(recentConversations, {
        convId,
        repoInfo: prevHit.snap?.repoInfo || null,
        summariesIndex: cachedSummariesIndex,
        cliDataDir,
        nowMs
      });
      return {
        ...prevHit.snap,
        pinnedConvId: validatedPinnedConvId || null,
        recentConversations: enrichedRecent
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
  if (targetLogPath && (logStatMtime > 0 || existsSync(targetLogPath))) {
    try {
      logMtimeMs = logStatMtime > 0 ? logStatMtime : statSync(targetLogPath).mtimeMs;
      const lines = readFileSync(targetLogPath, 'utf-8').split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          rawSteps.push(JSON.parse(line));
        } catch {}
      }
    } catch {}
  }

  totalSteps = rawSteps.length;
  const stepMetaMap = new Map();
  const stepArrayIdxByStepNum = new Map();
  const requiredModelSteps = [];
  const userInputs = [];
  const heavyCandidates = [];
  let pendingToolLabels = [];
  let latestErrorStepIdx = -1;
  let lastTranscriptPlannerArrayIdx = -1;
  let transcriptIsBtw = false;
  let transcriptParentConvId = null;
  let transcriptForkStepIndex = 0;
  const transcriptDiagEvents = [];

  const pushHeavyCandidate = (stepIndex, kind, label, rawText, m) => {
    const estTokens = Math.round(((m?.low || 0) + (m?.high || 0)) / 2);
    if (estTokens <= 0) return;
    heavyCandidates.push({
      stepIndex,
      kind,
      label,
      rawText,
      estTokens,
      chars: m?.chars || 0
    });
  };

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
    if (
      step.trajectory_type === 22 ||
      step.is_btw === true ||
      step.branch_kind === 'btw'
    ) {
      transcriptIsBtw = true;
    }
    if (!transcriptParentConvId && (step.parent_conversation_id || step.parentConversationId)) {
      transcriptParentConvId = String(step.parent_conversation_id || step.parentConversationId).trim() || null;
    }
    const rawForkStep = Number(step.fork_step_index ?? step.forkStepIndex ?? 0);
    if (Number.isInteger(rawForkStep) && rawForkStep > transcriptForkStepIndex) {
      transcriptForkStepIndex = rawForkStep;
    }
    const type = step.type || '';
    const contentStr = typeof step.content === 'string' ? step.content : '';

    if (type === 'USER_INPUT') {
      pendingToolLabels = [];
      userMessages++;
      if (!lightweight && !conversationTitle && contentStr) {
        conversationTitle = extractCleanUserTitle(contentStr);
      }
      const switchedModel = parseModelSettingFromText(contentStr);
      if (switchedModel) {
        activeSettingModel = switchedModel;
        lastSettingStepIdx = sIdx;
      }
      if (lightweight) {
        userInputs.push({
          arrayIdx: i,
          stepIndex: sIdx,
          createdAt: step.created_at || ''
        });
      } else {
        const { promptPreview, promptFull } = extractPromptPreview(contentStr);
        userInputs.push({
          arrayIdx: i,
          stepIndex: sIdx,
          createdAt: step.created_at || '',
          promptPreview,
          promptFull
        });
        const mUser = measureText(contentStr);
        addMeasure(groups.user, mUser);
        pushHeavyCandidate(sIdx, 'user', '用户消息', promptFull || contentStr, mUser);
      }
    } else if (isModelTurnStep(step)) {
      assistantMessages++;
      requiredModelSteps.push(sIdx);
      const toolBadges = lightweight ? [] : summarizeToolNames(step.tool_calls);
      if (!lightweight) {
        const mAsst = measureText(contentStr);
        addMeasure(groups.assistant, mAsst);
        pushHeavyCandidate(sIdx, 'assistant', '模型回复', contentStr, mAsst);
        if (step.thinking) {
          const mThink = measureText(step.thinking);
          addMeasure(groups.thinking, mThink);
          pushHeavyCandidate(sIdx, 'thinking', '模型思考', step.thinking, mThink);
        }
        pendingToolLabels = Array.isArray(step.tool_calls)
          ? step.tool_calls.map(formatToolCallLabel)
          : [];
        if (Array.isArray(step.tool_calls) && step.tool_calls.length) {
          toolCallsCount += step.tool_calls.length;
          const tcRaw = JSON.stringify(step.tool_calls);
          const mTc = measureText(tcRaw);
          addMeasure(groups.tools, mTc);
          const tcLabel = toolBadges.length ? `调用 ${toolBadges.slice(0, 2).join(', ')}` : '工具调用';
          pushHeavyCandidate(sIdx, 'tool', tcLabel, tcRaw, mTc);
        }
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
      if ((stepUsage.input || stepUsage.cache || stepUsage.cacheWrite || stepUsage.output) && step.status !== 'ERROR') {
        lastTranscriptPlannerArrayIdx = i;
      }
      if (step.status === 'ERROR') {
        latestErrorStepIdx = Math.max(latestErrorStepIdx, sIdx);
        if (contentStr) {
          latestStepError = { stepIndex: sIdx, text: contentStr };
          if (!lightweight) {
            const dKind = classifyDiagnosticEventText(contentStr);
            if (dKind) {
              transcriptDiagEvents.push({
                kind: dKind,
                stepIndex: sIdx,
                createdAt: step.created_at || '',
                detail: sanitizeSqliteText(contentStr, 120)
              });
            }
          }
        }
      }
    } else if (type === 'CHECKPOINT' || step.checkpoint) {
      if (!lightweight) {
        const cpText = contentStr || step.checkpoint?.sessionSummary || '';
        const mCp = measureText(cpText);
        addMeasure(groups.summaries, mCp);
        pushHeavyCandidate(sIdx, 'checkpoint', '压缩摘要', cpText, mCp);
      }
    } else if (type === 'ERROR_MESSAGE' || step.status === 'ERROR') {
      latestErrorStepIdx = Math.max(latestErrorStepIdx, sIdx);
      if (contentStr) {
        latestStepError = { stepIndex: sIdx, text: contentStr };
        if (!lightweight) {
          const dKind = classifyDiagnosticEventText(contentStr);
          if (dKind) {
            transcriptDiagEvents.push({
              kind: dKind,
              stepIndex: sIdx,
              createdAt: step.created_at || '',
              detail: sanitizeSqliteText(contentStr, 120)
            });
          }
        }
      }
      if (!lightweight) {
        const mErr = measureText(contentStr);
        addMeasure(groups.tools, mErr);
        const queuedLbl = type === 'GENERIC' && pendingToolLabels.length ? pendingToolLabels.shift() : '';
        pushHeavyCandidate(sIdx, 'tool', resolveToolStepLabel(step, queuedLbl), contentStr, mErr);
      }
    } else if (!lightweight) {
      const mTool = measureText(contentStr);
      addMeasure(groups.tools, mTool);
      const queuedLbl = type === 'GENERIC' && pendingToolLabels.length ? pendingToolLabels.shift() : '';
      pushHeavyCandidate(sIdx, 'tool', resolveToolStepLabel(step, queuedLbl), contentStr, mTool);
    }

    if (!lightweight && Array.isArray(step.media)) {
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
  const logSigMatches = (entry) => Boolean(
    entry && (
      (entry.size === logStatSize && entry.mtimeMs === logStatMtime) ||
      (entry.logSize === logStatSize && entry.logMtimeMs === logStatMtime) ||
      (compactStatMtime > 0 && entry.compactSize === compactStatSize && entry.compactMtimeMs === compactStatMtime) ||
      (fullStatMtime > 0 && (
        (entry.size === fullStatSize && entry.mtimeMs === fullStatMtime) ||
        (entry.logSize === fullStatSize && entry.logMtimeMs === fullStatMtime)
      ))
    )
  );
  let genMetaBundle = null;
  let genFromCache = false;
  let existingConvDiskEntry = null;
  if (!force && hasLsConfig && !isRetryCheck) {
    const memGen = convGenMetaCache.get(convId);
    const memCovers = Boolean(
      memGen &&
      memGen.lsKey === lsKey &&
      logSigMatches(memGen) &&
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
      existingConvDiskEntry = diskEntry || null;
      if (
        diskEntry &&
        lsDiskHash &&
        diskEntry.lsKeyHash === lsDiskHash &&
        logSigMatches(diskEntry) &&
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
    const effGenRpcTimeoutMs = lightweight
      ? Math.min(rpcTimeoutMs, Math.floor(getRemainingBudgetMs() - 50))
      : rpcTimeoutMs;
    const genOpts = {
      bypassMemTtl: isRetryCheck,
      nowMs,
      logSize: logStatSize,
      logMtimeMs: logStatMtime,
      ...(lightweight
        ? (effGenRpcTimeoutMs < 35
            ? { skipLiveRpc: true, allowStaleDiskFallback: true }
            : {
                timeoutMs: effGenRpcTimeoutMs,
                unrefSocket: true,
                noKeepAlive: true,
                allowStaleDiskFallback: true,
                ...(rpcSignal ? { signal: rpcSignal } : {})
              })
        : {})
    };
    const genPromise = fetchGeneratorMetadataForConv(convId, force, genOpts);
    if (lightweight) {
      [host, genMetaBundle] = await Promise.all([hostPromise, genPromise]);
    } else {
      genMetaBundle = await genPromise;
    }
  } else {
    if (lightweight) {
      host = await hostPromise;
    }
    if (!genFromCache && !hasLsConfig && allowDiskCacheWithoutLs && rawSteps.length > 0) {
      const diskCache = loadActiveConvGenDiskCache();
      const diskEntry = diskCache?.convs?.[convId];
      existingConvDiskEntry = existingConvDiskEntry || diskEntry || null;
      if (diskEntry && Array.isArray(diskEntry.generatorList) && diskEntry.generatorList.length > 0) {
        const diskList = diskEntry.generatorList;
        genMetaBundle = {
          at: Number(diskEntry.fetchedAt || nowMs),
          lsKey: '',
          logSize: diskEntry.size,
          logMtimeMs: diskEntry.mtimeMs,
          generatorList: diskList,
          callsByStep: buildCallsByStepFromList(diskList),
          emptyFromHost: Boolean(diskEntry.empty),
          rpcFailed: false,
          fromDiskCache: true
        };
        genFromCache = true;
      }
    }
  }

  const rawBundleList = Array.isArray(genMetaBundle?.generatorList) ? genMetaBundle.generatorList : [];
  const bundleList = orderGeneratorListChronologically(rawBundleList, stepArrayIdxByStepNum, stepMetaMap);
  const bundleSortKeys = computeGenListSortKeys(bundleList, stepArrayIdxByStepNum, stepMetaMap);
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

  // Optional read-only SQLite offline enrichment (zero-crash fallback when unavailable)
  let sqliteSignals = null;
  let summariesIndex = null;
  if (lightweight) {
    let hasBundleBudget = false;
    for (let i = bundleList.length - 1; i >= 0; i--) {
      const gm = bundleList[i];
      const cm = gm?.chatModel || gm?.chatMetadata || null;
      if (cm && Number(cm?.chatStartMetadata?.contextWindowMetadata?.maxContextTokens || 0) > 0) {
        hasBundleBudget = true;
        break;
      }
    }
    const lastModelStep = requiredModelSteps.length ? requiredModelSteps[requiredModelSteps.length - 1] : null;
    const latestBundleEntry = lastModelStep !== null
      ? (bundleCallsByStep.get(lastModelStep) || null)
      : (bundleList.length ? bundleList[bundleList.length - 1] : null);
    const latestCm = latestBundleEntry?.chatModel || latestBundleEntry?.chatMetadata || null;
    const hasLatestTiming = Boolean(
      latestCm && (
        parseDurationSec(latestCm.timeToFirstToken) !== null ||
        parseDurationSec(latestCm.streamingDuration) !== null
      )
    );
    const remForSqliteMs = getRemainingBudgetMs();
    if (convDbPath && (!hasBundleBudget || !hasLatestTiming) && !genMetaBundle?.rpcTimedOut && remForSqliteMs >= 65) {
      const effSqliteTimeoutMs = deadlineAt > 0
        ? Math.min(sqliteTimeoutMs, Math.max(20, Math.floor(remForSqliteMs - 30)))
        : sqliteTimeoutMs;
      const latestSqlGen = await readConversationLatestGenSignal(convDbPath, { timeoutMs: effSqliteTimeoutMs });
      if (latestSqlGen) {
        const genByStep = new Map();
        const sqlEntries = Array.isArray(latestSqlGen.recentEntries) && latestSqlGen.recentEntries.length
          ? latestSqlGen.recentEntries
          : [latestSqlGen];
        let anySqlHasStepIndices = false;
        for (const sqlEntry of sqlEntries) {
          const steps = Array.isArray(sqlEntry?.stepIndices) ? sqlEntry.stepIndices : [];
          if (steps.length > 0) anySqlHasStepIndices = true;
          for (const sIdx of steps) {
            genByStep.set(sIdx, sqlEntry);
          }
        }
        // Only fall back to lastModelStep when SQLite row omits stepIndices, so stale SQLite rows cannot bleed into newer turns
        if (!anySqlHasStepIndices && lastModelStep !== null && !genByStep.has(lastModelStep)) {
          genByStep.set(lastModelStep, latestSqlGen);
        }
        sqliteSignals = {
          latestMaxContextTokens: latestSqlGen.maxContextTokens || null,
          genByStep
        };
      }
    }
  } else {
    [sqliteSignals, summariesIndex] = await Promise.all([
      convDbPath ? readConversationSqliteSignals(convDbPath, { includeLatestGenDetail: true }) : Promise.resolve(null),
      readMergedSummariesIndex(agDir, cliDataDir, ideDataDir)
    ]);
  }

  // Build turn-by-turn metrics combining GeneratorMetadata + SQLite + Transcript steps
  const turnCandidates = [];
  let sessionCostUSD = 0;
  let sessionCacheSavingsUSD = 0;
  let turnCandidateSeq = 0;

  const appendFallbackTurnFromTranscriptStep = (s, arrayIdx, fallbackModel) => {
    const {
      input,
      cache,
      cacheWrite: localCacheWrite,
      output,
      thinking: rawThinking,
      response: rawResponseTokens
    } = extractStepUsage(s);
    const sIdx = Number(s.step_index ?? arrayIdx);
    const sqlGen = sqliteSignals?.genByStep?.get(sIdx) || null;
    const sqlUsage = sqlGen?.usage || null;
    const cacheWrite = localCacheWrite > 0
      ? localCacheWrite
      : Math.max(0, Number(sqlUsage?.cacheWriteTokens || 0) || 0);
    const total = input + cache + cacheWrite + output;
    if (total <= 0) return;

    const { thinking, responseTokens } = resolveThinkingAndResponse(rawThinking, rawResponseTokens, output, sqlUsage);
    const sqlModel = sqlGen
      ? String(sqlGen.modelDisplayName || sqlGen.responseModel || sqlGen.model || sqlGen.requestedModel || '').trim()
      : '';
    const sqlTtft = typeof sqlGen?.ttft === 'number' && Number.isFinite(sqlGen.ttft) ? sqlGen.ttft : null;
    const sqlStreamingSec = typeof sqlGen?.streamingSec === 'number' && Number.isFinite(sqlGen.streamingSec)
      ? sqlGen.streamingSec
      : null;
    const hasSqlTiming = sqlTtft !== null || sqlStreamingSec !== null;
    const duration = hasSqlTiming
      ? (sqlTtft !== null && sqlStreamingSec !== null ? sqlTtft + sqlStreamingSec : (sqlTtft ?? sqlStreamingSec ?? null))
      : estimateStepDuration(rawSteps, arrayIdx, logMtimeMs);
    const tps = hasSqlTiming
      ? (output > 0 && duration !== null && duration >= 0.05 ? Number((output / duration).toFixed(1)) : null)
      : (output > 0 && duration && duration > 0.1 ? Number((output / duration).toFixed(1)) : null);
    const streamTokBase = thinking > 0 && responseTokens > 0 ? responseTokens : output;
    const streamingTps = streamTokBase > 0 && sqlStreamingSec && sqlStreamingSec >= 0.4
      ? Number((streamTokBase / sqlStreamingSec).toFixed(1))
      : null;
    const effectiveTps = (output > 0 && sqlTtft !== null && sqlTtft >= 0 && sqlStreamingSec !== null && sqlStreamingSec >= 0 && (sqlTtft + sqlStreamingSec) >= 0.05)
      ? Number((output / (sqlTtft + sqlStreamingSec)).toFixed(1))
      : null;
    const rawModel = extractStepModel(s, null, sqlModel || fallbackModel);
    const modelKey = normalizeModelId(rawModel, host.dynamicModelMap);
    const displayModel = rawModel ? formatModelDisplayName(rawModel, modelKey) : '';
    const costInfo = calculateRequestApiCost(
      {
        model: rawModel,
        modelKey,
        inputTokens: input,
        cacheTokens: cache,
        cacheWriteTokens: cacheWrite,
        outputTokens: output,
        thinkingTokens: thinking,
        date: s.created_at
      },
      host.dynamicModelMap
    );
    if (costInfo.isPriced && costInfo.costUSD) {
      sessionCostUSD += costInfo.costUSD;
    }
    if (costInfo.isPriced && typeof costInfo.cacheSavingsUSD === 'number' && Number.isFinite(costInfo.cacheSavingsUSD)) {
      sessionCacheSavingsUSD += costInfo.cacheSavingsUSD;
    }
    const sMeta = stepMetaMap.get(sIdx);
    const promptSum = input + cache + cacheWrite;
    const turnCachePct = promptSum > 0 ? Number(((cache / promptSum) * 100).toFixed(1)) : 0;
    const sqlBudget = Number(sqlGen?.maxContextTokens || 0) || null;

    turnCandidates.push({
      turnIndex: 0,
      stepIndex: sIdx,
      _arrayIdx: arrayIdx,
      _minArrayIdx: arrayIdx,
      _minStepIdx: Number.isFinite(sIdx) ? sIdx : null,
      _orderSeq: turnCandidateSeq++,
      _rawCtxMeta: null,
      _sourceGm: null,
      _budgetFromSqlite: Boolean(sqlBudget),
      createdAt: s.created_at || '',
      tools: sMeta?.tools || [],
      model: displayModel || '未记录模型',
      hasRecordedModel: Boolean(rawModel),
      modelKey,
      inputTokens: input,
      cacheTokens: cache,
      cacheWriteTokens: cacheWrite,
      outputTokens: output,
      thinkingTokens: thinking,
      responseTokens,
      totalTokens: total,
      deltaTokens: 0,
      cacheHitPercent: turnCachePct,
      budget: sqlBudget,
      estimate: null,
      ttft: sqlTtft !== null ? Number(sqlTtft.toFixed(2)) : null,
      streamingSec: sqlStreamingSec !== null ? Number(sqlStreamingSec.toFixed(2)) : null,
      duration: duration !== null ? Number(duration.toFixed(2)) : null,
      tps,
      streamingTps,
      effectiveTps,
      costUSD: costInfo.costUSD ?? 0,
      _cacheSavingsUSD: costInfo.cacheSavingsUSD ?? 0,
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
        if (m && (!matchedLocalMeta || (m.stepUsage && (m.stepUsage.input + m.stepUsage.cache + (m.stepUsage.cacheWrite || 0) + m.stepUsage.output) > 0))) {
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
      const srvCacheWrite = Math.max(
        0,
        Number(srvUsage?.cacheWriteTokens ?? srvUsage?.cacheCreationInputTokens ?? srvUsage?.cache_creation_input_tokens ?? srvUsage?.cache_write_tokens ?? 0) || 0
      );
      const srvOutput = Number(srvUsage?.outputTokens || 0);
      const hasServerUsage = Boolean(srvUsage && (srvInput + srvCache + srvCacheWrite + srvOutput) > 0);
      const localUsage = matchedLocalMeta?.stepUsage || sMeta?.stepUsage || null;
      const hasLocalUsage = Boolean(localUsage && (localUsage.input + localUsage.cache + (localUsage.cacheWrite || 0) + localUsage.output) > 0);
      const input = hasServerUsage ? srvInput : (hasLocalUsage ? localUsage.input : 0);
      const cache = hasServerUsage ? srvCache : (hasLocalUsage ? localUsage.cache : 0);
      const output = hasServerUsage ? srvOutput : (hasLocalUsage ? localUsage.output : 0);
      let sqlGen = null;
      if (sqliteSignals?.genByStep) {
        for (const n of numericGmSteps) {
          const sg = sqliteSignals.genByStep.get(n);
          if (sg) { sqlGen = sg; break; }
        }
      }
      const sqlUsage = sqlGen?.usage || null;
      const localCacheWrite = hasLocalUsage ? (localUsage.cacheWrite || 0) : 0;
      const sqlCacheWrite = Math.max(0, Number(sqlUsage?.cacheWriteTokens || 0) || 0);
      const cacheWrite = srvCacheWrite > 0
        ? srvCacheWrite
        : (localCacheWrite > 0 ? localCacheWrite : sqlCacheWrite);
      const rawThinking = hasServerUsage
        ? Number(srvUsage?.thinkingOutputTokens || 0)
        : (hasLocalUsage ? localUsage.thinking : 0);
      const rawResponseTokens = hasServerUsage
        ? Number(srvUsage?.responseOutputTokens ?? 0)
        : (hasLocalUsage ? localUsage.response : 0);
      const { thinking, responseTokens } = resolveThinkingAndResponse(rawThinking, rawResponseTokens, output, sqlUsage);
      const total = input + cache + cacheWrite + output;
      const timingMeta = matchedLocalMeta || sMeta;
      const rawModel = extractStepModel(null, gm, timingMeta?.stepModel || timingMeta?.runningSettingModel || activeSettingModel);
      const modelKey = normalizeModelId(rawModel, host.dynamicModelMap);
      const displayModel = rawModel ? formatModelDisplayName(rawModel, modelKey) : '';

      const lsTtft = parseDurationSec(cm.timeToFirstToken);
      const lsStreamingSec = parseDurationSec(cm.streamingDuration);
      const hasLsTiming = lsTtft !== null || lsStreamingSec !== null;
      const sqlTtft = typeof sqlGen?.ttft === 'number' && Number.isFinite(sqlGen.ttft) ? sqlGen.ttft : null;
      const sqlStreamingSec = typeof sqlGen?.streamingSec === 'number' && Number.isFinite(sqlGen.streamingSec)
        ? sqlGen.streamingSec
        : null;
      const hasSqlTiming = !hasLsTiming && (sqlTtft !== null || sqlStreamingSec !== null);
      const ttft = hasLsTiming ? lsTtft : (hasSqlTiming ? sqlTtft : null);
      const streamingSec = hasLsTiming ? lsStreamingSec : (hasSqlTiming ? sqlStreamingSec : null);
      const hasServerTiming = hasLsTiming || hasSqlTiming;
      const duration = hasServerTiming
        ? (ttft !== null && streamingSec !== null ? ttft + streamingSec : (ttft ?? streamingSec ?? null))
        : (timingMeta?.arrayIdx >= 0 ? estimateStepDuration(rawSteps, timingMeta.arrayIdx, logMtimeMs) : null);
      const tps = hasServerTiming
        ? (output > 0 && duration !== null && duration >= 0.05 ? Number((output / duration).toFixed(1)) : null)
        : (output > 0 && duration && duration > 0.1 ? Number((output / duration).toFixed(1)) : null);
      const streamTokBase = thinking > 0 && responseTokens > 0 ? responseTokens : output;
      const streamingTps = streamTokBase > 0 && streamingSec && streamingSec >= 0.4
        ? Number((streamTokBase / streamingSec).toFixed(1))
        : null;
      const effectiveTps = (output > 0 && ttft !== null && ttft >= 0 && streamingSec !== null && streamingSec >= 0 && (ttft + streamingSec) >= 0.05)
        ? Number((output / (ttft + streamingSec)).toFixed(1))
        : null;

      const costInfo = calculateRequestApiCost(
        {
          model: rawModel,
          modelKey,
          inputTokens: input,
          cacheTokens: cache,
          cacheWriteTokens: cacheWrite,
          outputTokens: output,
          thinkingTokens: thinking,
          date: timingMeta?.createdAt
        },
        host.dynamicModelMap
      );
      if (costInfo.isPriced && costInfo.costUSD) {
        sessionCostUSD += costInfo.costUSD;
      }
      if (costInfo.isPriced && typeof costInfo.cacheSavingsUSD === 'number' && Number.isFinite(costInfo.cacheSavingsUSD)) {
        sessionCacheSavingsUSD += costInfo.cacheSavingsUSD;
      }

      const promptSum = input + cache + cacheWrite;
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
        _precomputedSortKey: bundleSortKeys[idx] || null,
        _rawCtxMeta: ctxMeta || null,
        _sourceGm: gm,
        createdAt: timingMeta?.createdAt || '',
        tools: timingMeta?.tools || [],
        model: displayModel || '未记录模型',
        hasRecordedModel: Boolean(rawModel),
        modelKey,
        inputTokens: input,
        cacheTokens: cache,
        cacheWriteTokens: cacheWrite,
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
        effectiveTps,
        costUSD: costInfo.costUSD ?? 0,
        _cacheSavingsUSD: costInfo.cacheSavingsUSD ?? 0,
        isPriced: costInfo.isPriced,
        error: turnError,
        contextBreakdown: null,
        _isServerExact: Boolean(hasServerUsage && hasLsTiming)
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

  // Restore chronological transcript order before filtering completed turns and computing turnIndex, deltaTokens, contextBreakdown, cache persistence & latestTurn
  let latestTurnSourceGm = null;
  let latestCandidate = null;
  let latestInFlight = null;
  let candidateContextBreakdown = null;
  const turns = [];
  if (turnCandidates.length > 0) {
    for (const t of turnCandidates) {
      t._sortKey = t._precomputedSortKey || computeChronoSortKey(t._minArrayIdx, t._minStepIdx, t._orderSeq, stepArrayIdxByStepNum);
    }
    turnCandidates.sort((a, b) => compareChronoSortKeys(a._sortKey, b._sortKey));
    latestCandidate = turnCandidates[turnCandidates.length - 1] || null;
    for (const t of turnCandidates) {
      if (t.totalTokens > 0) {
        turns.push(t);
      }
    }
    const latestTurnObj = turns.length ? turns[turns.length - 1] : null;
    const latestValidTurnForCalib = [...turns].reverse().find((t) => t.totalTokens > 0 && !t.error) || latestTurnObj;
    const actualInputForCalib = latestValidTurnForCalib
      ? ((latestValidTurnForCalib.inputTokens || 0) + (latestValidTurnForCalib.cacheTokens || 0) + (latestValidTurnForCalib.cacheWriteTokens || 0))
      : 0;
    latestInFlight = (latestCandidate && latestCandidate.totalTokens <= 0 && !latestCandidate.error)
      ? latestCandidate
      : null;
    const hasInFlightBd = Boolean(latestInFlight?._rawCtxMeta?.tokenBreakdown?.groups?.length);
    const hasTurnBd = Boolean(latestTurnObj?._rawCtxMeta?.tokenBreakdown?.groups?.length);
    const hasSqliteBd = Boolean(!lightweight && sqliteSignals?.latestContextWindowMetadata?.tokenBreakdown?.groups?.length);
    const rawCtxMetaForBd = hasInFlightBd
      ? latestInFlight._rawCtxMeta
      : (hasTurnBd
          ? latestTurnObj._rawCtxMeta
          : (hasSqliteBd ? sqliteSignals.latestContextWindowMetadata : null));
    const canCalibrateBd = Boolean(
      (rawCtxMetaForBd?.tokenBreakdown?.groups?.length >= 2 || rawCtxMetaForBd?.tokenBreakdown?.categories?.length >= 2) &&
      actualInputForCalib > 0
    );
    const fallbackCategories = (!lightweight && sqliteSignals?.latestContextWindowMetadata?.tokenBreakdown?.categories?.length)
      ? sqliteSignals.latestContextWindowMetadata.tokenBreakdown.categories
      : null;
    candidateContextBreakdown = rawCtxMetaForBd
      ? extractContextBreakdown(rawCtxMetaForBd, canCalibrateBd ? actualInputForCalib : null, fallbackCategories)
      : null;
    if (hasInFlightBd) {
      latestTurnSourceGm = latestInFlight?._sourceGm || null;
    } else if (hasTurnBd) {
      latestTurnSourceGm = latestTurnObj?._sourceGm || null;
    } else {
      latestTurnSourceGm = latestInFlight?._sourceGm || latestTurnObj?._sourceGm || latestCandidate?._sourceGm || null;
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
  }

  // Compaction history & auto-compaction vs. cache-break disambiguation (runs before prompt-group classification)
  const compactions = buildCompactionsList(rawSteps, turns, sqliteSignals?.compactionSteps || []);
  annotateTurnsCompactionAndCacheBreak(turns, compactions);

  // Group completed chronological model turns by preceding USER_INPUT for prompt cold/warm/hot startup diagnostics
  const promptGroupsMap = new Map();
  for (const t of turns) {
    const turnArrIdx = (typeof t._minArrayIdx === 'number' && t._minArrayIdx >= 0)
      ? t._minArrayIdx
      : (typeof t._arrayIdx === 'number' && t._arrayIdx >= 0 ? t._arrayIdx : -1);
    let matchedUser = null;
    if (turnArrIdx >= 0) {
      for (let uIdx = userInputs.length - 1; uIdx >= 0; uIdx--) {
        if (userInputs[uIdx].arrayIdx <= turnArrIdx) {
          matchedUser = userInputs[uIdx];
          break;
        }
      }
    } else if (t.stepIndex != null && Number.isFinite(Number(t.stepIndex))) {
      const tStepNum = Number(t.stepIndex);
      for (let uIdx = userInputs.length - 1; uIdx >= 0; uIdx--) {
        if (Number.isFinite(userInputs[uIdx].stepIndex) && userInputs[uIdx].stepIndex <= tStepNum) {
          matchedUser = userInputs[uIdx];
          break;
        }
      }
    }
    const groupKey = matchedUser ? `u:${matchedUser.arrayIdx}` : 'implicit';
    let grp = promptGroupsMap.get(groupKey);
    if (!grp) {
      grp = matchedUser
        ? {
            createdAt: matchedUser.createdAt || t.createdAt || '',
            promptPreview: matchedUser.promptPreview || '(用户消息)',
            promptFull: matchedUser.promptFull || matchedUser.promptPreview || '(用户消息)',
            turns: []
          }
        : {
            createdAt: t.createdAt || '',
            promptPreview: '(会话初始轮次)',
            promptFull: '(会话初始轮次)',
            turns: []
          };
      promptGroupsMap.set(groupKey, grp);
    }
    grp.turns.push(t);
  }

  const allPromptTurns = [];
  let prevGroupEndTokens = 0;
  let promptGroupSeq = 0;
  for (const grp of promptGroupsMap.values()) {
    if (!grp.turns.length) continue;
    promptGroupSeq++;
    const firstTurn = grp.turns[0];
    const lastTurn = grp.turns[grp.turns.length - 1];
    const startTokens = (firstTurn.inputTokens || 0) + (firstTurn.cacheTokens || 0) + (firstTurn.cacheWriteTokens || 0);
    const startupCacheHitPercent = startTokens > 0
      ? Number((((firstTurn.cacheTokens || 0) / startTokens) * 100).toFixed(1))
      : null;
    const groupCompactedTurn = firstTurn.isCompacted
      ? firstTurn
      : (grp.turns.find((x) => x.isCompacted) || null);
    const isGroupCompacted = Boolean(groupCompactedTurn);
    const isGroupCacheBreak = Boolean(grp.turns.some((x) => x.isCacheBreak));
    let startupState = null;
    if (startTokens > 0) {
      if ((firstTurn.cacheTokens || 0) === 0 || startupCacheHitPercent < 25) {
        startupState = firstTurn.isCompacted ? 'compacted' : 'cold';
      } else if (startupCacheHitPercent < 70) {
        startupState = 'warm';
      } else {
        startupState = 'hot';
      }
    }
    const endTokens = lastTurn.totalTokens || 0;
    const deltaTokens = endTokens - prevGroupEndTokens;
    prevGroupEndTokens = endTokens;

    let outputTokensSum = 0;
    let costSum = 0;
    const groupTpsVals = [];
    const groupToolSet = new Set();
    for (const gt of grp.turns) {
      outputTokensSum += gt.outputTokens || 0;
      costSum += gt.costUSD || 0;
      if (typeof gt.tps === 'number' && gt.tps > 0) groupTpsVals.push(gt.tps);
      if (Array.isArray(gt.tools)) {
        for (const badge of gt.tools) {
          const cleanName = String(badge || '').replace(/\s*×\d+$/, '').trim();
          if (cleanName) groupToolSet.add(cleanName);
          if (groupToolSet.size >= 6) break;
        }
      }
    }
    const groupAvgTps = groupTpsVals.length > 0
      ? Number((groupTpsVals.reduce((a, b) => a + b, 0) / groupTpsVals.length).toFixed(1))
      : null;

    allPromptTurns.push({
      promptIndex: promptGroupSeq,
      createdAt: grp.createdAt || firstTurn.createdAt || '',
      promptPreview: grp.promptPreview,
      promptFull: grp.promptFull,
      startupState,
      startupCacheHitPercent,
      isCompacted: isGroupCompacted,
      compactionDropPercent: firstTurn.isCompacted
        ? (firstTurn.compactionDropPercent ?? null)
        : (groupCompactedTurn?.compactionDropPercent ?? null),
      isCacheBreak: isGroupCacheBreak,
      callsCount: grp.turns.length,
      startTokens,
      endTokens,
      deltaTokens,
      outputTokens: outputTokensSum,
      costUSD: Number(costSum.toFixed(5)),
      model: lastTurn.model || '未记录模型',
      ttft: firstTurn.ttft ?? null,
      avgTps: groupAvgTps,
      tools: [...groupToolSet].slice(0, 6)
    });
  }
  const promptTurnsPayload = allPromptTurns.slice(-20).reverse();
  const latestPromptGroup = allPromptTurns.length ? allPromptTurns[allPromptTurns.length - 1] : null;
  const latestPromptStartup = latestPromptGroup
    ? {
        state: latestPromptGroup.startupState,
        cacheHitPercent: latestPromptGroup.startupCacheHitPercent,
        promptIndex: latestPromptGroup.promptIndex,
        callsCount: latestPromptGroup.callsCount,
        isCompacted: Boolean(latestPromptGroup.isCompacted),
        compactionDropPercent: latestPromptGroup.compactionDropPercent ?? null,
        isCacheBreak: Boolean(latestPromptGroup.isCacheBreak)
      }
    : null;

  if (turnCandidates.length > 0) {
    for (const t of turnCandidates) {
      delete t._minArrayIdx;
      delete t._minStepIdx;
      delete t._orderSeq;
      delete t._precomputedSortKey;
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
    const shouldPersistInLightweight = Boolean(
      diskSettledEligible ||
      !existingConvDiskEntry ||
      (nowMs - Number(existingConvDiskEntry.fetchedAt || 0)) >= 5000
    );
    if (!lightweight || shouldPersistInLightweight) {
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
          size: fullStatMtime > 0 ? fullStatSize : logStatSize,
          mtimeMs: fullStatMtime > 0 ? fullStatMtime : logStatMtime,
          ...(compactStatMtime > 0 ? { compactSize: compactStatSize, compactMtimeMs: compactStatMtime } : {}),
          fetchedAt: nowMs,
          settled: diskSettledEligible,
          empty: !bundleList.length,
          generatorList: slimGeneratorListForCache(bundleList, latestTurnSourceGm)
        });
      }
    }
  }

  const latestTurn = turns.length ? turns[turns.length - 1] : null;
  const latestValidTurn = [...turns].reverse().find((t) => t.totalTokens > 0 && !t.error) || latestTurn;

  // Session cumulative throughput, per-model breakdown & session-wide TPS stats
  const sqlMetrics = (!lightweight && sqliteSignals?.sessionMetrics) ? sqliteSignals.sessionMetrics : null;
  const sessionTotals = {
    turnsCount: turns.length,
    inputTokens: 0,
    cacheTokens: 0,
    cacheWriteTokens: 0,
    cacheWrittenTokens: Number(sqlMetrics?.cacheWrittenTokens || 0),
    outputTokens: 0,
    thinkingTokens: 0,
    responseTokens: 0,
    retryTokens: Number(sqlMetrics?.retryTokens || 0),
    retryCalls: Number(sqlMetrics?.retryCalls || 0),
    totalTokens: 0,
    cacheHitPercent: null
  };
  const sessionModelAggMap = new Map();
  const SESSION_MODEL_SUFFIX_RE = /\s*\((?:XHigh|Low|Medium|High|Minimal|Thinking|Fast|Orchestrator)\)\s*$/i;
  const validTpsValues = [];
  for (const t of turns) {
    const tIn = t.inputTokens || 0;
    const tCache = t.cacheTokens || 0;
    const tCacheWrite = t.cacheWriteTokens || 0;
    const tOut = t.outputTokens || 0;
    const tThink = t.thinkingTokens || 0;
    const tTot = t.totalTokens || 0;
    sessionTotals.inputTokens += tIn;
    sessionTotals.cacheTokens += tCache;
    sessionTotals.cacheWriteTokens += tCacheWrite;
    sessionTotals.outputTokens += tOut;
    sessionTotals.thinkingTokens += tThink;
    sessionTotals.responseTokens += t.responseTokens || 0;
    sessionTotals.totalTokens += tTot;
    if (typeof t.tps === 'number' && t.tps > 0) validTpsValues.push(t.tps);

    const rawDisp = t.hasRecordedModel && t.model && t.model !== '未记录模型'
      ? String(t.model).trim()
      : '';
    const cleanRawDisp = rawDisp ? rawDisp.replace(SESSION_MODEL_SUFFIX_RE, '').trim() : '';
    const mKey = t.modelKey || null;
    const groupKey = mKey
      ? `key:${mKey}`
      : (cleanRawDisp ? `name:${cleanRawDisp.toLowerCase()}` : 'unrecorded');
    const displayName = (mKey && MODEL_DISPLAY_NAMES[mKey])
      ? MODEL_DISPLAY_NAMES[mKey]
      : (cleanRawDisp || '未记录模型');

    let mAgg = sessionModelAggMap.get(groupKey);
    if (!mAgg) {
      mAgg = {
        groupKey,
        modelKey: mKey,
        displayName,
        turnsCount: 0,
        inputTokens: 0,
        cacheTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        totalTokens: 0,
        costUSD: 0,
        cacheSavingsUSD: 0,
        tpsSum: 0,
        tpsCount: 0,
        variants: new Set()
      };
      sessionModelAggMap.set(groupKey, mAgg);
    }
    mAgg.turnsCount += 1;
    mAgg.inputTokens += tIn;
    mAgg.cacheTokens += tCache;
    mAgg.cacheWriteTokens += tCacheWrite;
    mAgg.outputTokens += tOut;
    mAgg.thinkingTokens += tThink;
    mAgg.totalTokens += tTot;
    mAgg.costUSD += Number(t.costUSD || 0);
    mAgg.cacheSavingsUSD += Number(t._cacheSavingsUSD || 0);
    if (typeof t.tps === 'number' && t.tps > 0) {
      mAgg.tpsSum += t.tps;
      mAgg.tpsCount += 1;
    }
    if (rawDisp && rawDisp !== displayName) {
      mAgg.variants.add(rawDisp);
    }
  }
  const cumPrompt = sessionTotals.inputTokens + sessionTotals.cacheTokens + sessionTotals.cacheWriteTokens;
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
  if (!lightweight && contextBreakdown?.groups?.length) {
    const sysG = contextBreakdown.groups.find((g) => g.name === 'System Prompt');
    const toolG = contextBreakdown.groups.find((g) => g.name === 'Tools');
    if (sysG) groups.system = { chars: sysG.tokens * 4, bytes: sysG.tokens * 4, low: sysG.tokens, high: sysG.tokens };
    if (toolG) groups.definitions = { chars: toolG.tokens * 4, bytes: toolG.tokens * 4, low: toolG.tokens, high: toolG.tokens };
  }

  // Inspect attachments
  const attachments = lightweight ? [] : [...mediaMap.values()].map(inspectAttachmentItem);
  const attachmentTotal = emptyMeasure();
  if (!lightweight) {
    for (const att of attachments) {
      const mult = att.references || 1;
      addMeasure(attachmentTotal, {
        chars: (att.chars || 0) * mult,
        bytes: (att.bytes || 0) * mult,
        low: (att.low || 0) * mult,
        high: (att.high || 0) * mult
      });
    }
  }

  const localTotal = emptyMeasure();
  if (!lightweight) {
    for (const g of Object.values(groups)) addMeasure(localTotal, g);
    addMeasure(localTotal, attachmentTotal);
  }

  const localTotalMid = Math.round((localTotal.low + localTotal.high) / 2);
  const heavyItems = lightweight
    ? []
    : heavyCandidates
        .filter((item) => item.estTokens > 0)
        .sort((a, b) => (b.estTokens - a.estTokens) || (a.stepIndex - b.stepIndex))
        .slice(0, 10)
        .map((item, idx) => {
          const cleanedRaw = item.kind === 'tool' ? stripToolResultHeader(item.rawText) : item.rawText;
          return {
            rank: idx + 1,
            stepIndex: item.stepIndex,
            kind: item.kind,
            label: item.label,
            preview: sanitizeDiagnosticText(cleanedRaw, 72),
            estTokens: item.estTokens,
            sharePercent: localTotalMid > 0
              ? Number(((item.estTokens / localTotalMid) * 100).toFixed(1))
              : 0,
            chars: item.chars
          };
        });

  const lastRawStep = rawSteps.length ? rawSteps[rawSteps.length - 1] : null;
  const hasTrailingZeroTokError = Boolean(
    latestCandidate?.error &&
    latestCandidate !== latestTurn && (
      !latestTurn ||
      (latestCandidate.stepIndex != null && (latestTurn.stepIndex == null || latestCandidate.stepIndex >= latestTurn.stepIndex)) ||
      lastRawStep?.type === 'USER_INPUT' ||
      lastRawStep?.type === 'ERROR_MESSAGE' ||
      lastRawStep?.status === 'ERROR'
    )
  );
  const activeErrorText = latestTurn?.error
    || (latestStepError && (latestTurn?.stepIndex == null || latestStepError.stepIndex >= latestTurn.stepIndex) ? latestStepError.text : '')
    || (hasTrailingZeroTokError ? latestCandidate.error : '');
  const modelSourceTurn = (latestInFlight?.hasRecordedModel ? latestInFlight : latestTurn) || latestInFlight || latestCandidate;
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
  const cleanActiveModelDisp = String(currentModelDisplay || '')
    .replace(SESSION_MODEL_SUFFIX_RE, '')
    .trim()
    .toLowerCase();
  const sessionModels = [...sessionModelAggMap.values()]
    .map((m) => {
      const mPrompt = m.inputTokens + m.cacheTokens + m.cacheWriteTokens;
      const isCurrent = Boolean(
        (currentModelKey && m.modelKey && m.modelKey === currentModelKey) ||
        (!currentModelKey && cleanActiveModelDisp && cleanActiveModelDisp !== '未记录模型' && m.displayName.toLowerCase() === cleanActiveModelDisp)
      );
      return {
        modelKey: m.modelKey,
        displayName: m.displayName,
        turnsCount: m.turnsCount,
        inputTokens: m.inputTokens,
        cacheTokens: m.cacheTokens,
        cacheWriteTokens: m.cacheWriteTokens,
        outputTokens: m.outputTokens,
        thinkingTokens: m.thinkingTokens,
        totalTokens: m.totalTokens,
        cacheHitPercent: mPrompt > 0 ? Number(((m.cacheTokens / mPrompt) * 100).toFixed(1)) : null,
        costUSD: Number(m.costUSD.toFixed(4)),
        cacheSavingsUSD: Number(m.cacheSavingsUSD.toFixed(4)),
        avgTps: m.tpsCount > 0 ? Number((m.tpsSum / m.tpsCount).toFixed(1)) : null,
        variants: [...m.variants].slice(0, 4),
        isCurrent
      };
    })
    .sort((a, b) => (b.totalTokens - a.totalTokens) || (b.turnsCount - a.turnsCount));
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
  const latestEstimateTurn = (
    latestCandidate?.estimate > 0 &&
    (latestCandidate === latestInFlight || latestCandidate === latestTurn || !latestTurn || hasTrailingZeroTokError)
  )
    ? latestCandidate
    : latestTurn;
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
  const budgetLookupTurns = latestInFlight
    ? [...turns, latestInFlight]
    : (hasTrailingZeroTokError && latestCandidate ? [...turns, latestCandidate] : turns);
  const matchedServerBudgetTurn = [...budgetLookupTurns].reverse().find((t) => !t._budgetFromSqlite && isTurnMatchingCurrentModel(t));
  const matchedSqliteBudgetTurn = [...budgetLookupTurns].reverse().find((t) => t._budgetFromSqlite && isTurnMatchingCurrentModel(t));
  const directBudgetTokens = matchedServerBudgetTurn?.budget || null;
  const sqliteBudgetTokens = !directBudgetTokens
    ? (matchedSqliteBudgetTurn?.budget || Number(sqliteSignals?.latestMaxContextTokens || 0) || null)
    : null;
  const cachedBudgetTokens = (!directBudgetTokens && !sqliteBudgetTokens && allowDiskCacheWithoutLs)
    ? findCachedModelBudget(currentModelKey, currentModelDisplay, host.dynamicModelMap)
    : null;
  const budgetTokens = directBudgetTokens || sqliteBudgetTokens || cachedBudgetTokens || null;
  const budgetSource = directBudgetTokens
    ? 'server'
    : (sqliteBudgetTokens ? 'sqlite' : (cachedBudgetTokens ? 'disk_cache' : 'unknown'));
  const remainingTokens = usedTokens !== null && budgetTokens !== null && budgetTokens > 0
    ? Math.max(0, budgetTokens - usedTokens)
    : null;
  const usedPercent = usedTokens !== null && budgetTokens !== null && budgetTokens > 0
    ? Number(((usedTokens / budgetTokens) * 100).toFixed(1))
    : null;
  const promptTotal = (latestValidTurn?.inputTokens || 0) + (latestValidTurn?.cacheTokens || 0) + (latestValidTurn?.cacheWriteTokens || 0);
  const cacheHitPercent = promptTotal > 0
    ? Number((((latestValidTurn?.cacheTokens || 0) / promptTotal) * 100).toFixed(1))
    : null;

  const cacheBreakCount = turns.filter((t) => t.isCacheBreak).length;
  let cacheStatusState = 'idle';
  if (!latestValidTurn) {
    cacheStatusState = 'idle';
  } else if (latestValidTurn.isCompacted) {
    cacheStatusState = 'compacted';
  } else if (latestValidTurn.isCacheBreak) {
    cacheStatusState = 'drop';
  } else if (turns.length === 1 && (latestValidTurn.cacheHitPercent || 0) < 10) {
    cacheStatusState = 'warmup';
  } else if ((latestValidTurn.cacheHitPercent || 0) >= 50) {
    cacheStatusState = 'good';
  } else {
    cacheStatusState = 'low';
  }
  const cacheStatus = {
    state: cacheStatusState,
    latestTurnCompacted: Boolean(latestValidTurn?.isCompacted),
    latestTurnCacheBreak: Boolean(latestValidTurn?.isCacheBreak),
    compactionDropPercent: latestValidTurn?.compactionDropPercent ?? null,
    breakPrevHitPercent: latestValidTurn?.cacheBreakPrevPercent ?? null,
    cacheBreakCount
  };

  const modelQuota = resolveModelQuota(currentModelDisplay, host.modelConfigs, host.quotaSummaryGroups);
  const unknownAttachmentsCount = attachments.filter((a) => a.status !== 'parsed').length;

  if (lightweight) {
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
      cacheWriteTokens: latestValidTurn?.cacheWriteTokens ?? null,
      outputTokens: latestValidTurn?.outputTokens ?? null,
      cacheHitPercent,
      cacheStatus,
      sessionCostUSD: Number(sessionCostUSD.toFixed(4)),
      latestPromptStartup,
      quota: modelQuota
    };
    const speedPayload = latestValidTurn ? {
      tps: latestValidTurn.tps,
      streamingTps: latestValidTurn.streamingTps,
      effectiveTps: latestValidTurn.effectiveTps ?? null,
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
    const latestHostCacheMtimeMs = getFileMtimeSigSafe(getHostStatusCachePath());
    const latestGenCacheMtimeMs = getFileMtimeSigSafe(getActiveConvGenCachePath());
    const latestTurnHasExactTiming = Boolean(
      latestValidTurn && (
        latestValidTurn._isServerExact ||
        latestValidTurn.ttft !== null ||
        latestValidTurn.streamingSec !== null
      )
    );
    const snapSettled = Boolean(
      metaSettled && (
        !latestValidTurn ||
        latestTurnHasExactTiming ||
        ageMs >= CONV_META_SETTLE_AGE_MS
      )
    );
    const lastRawStepType = rawSteps.length ? String(rawSteps[rawSteps.length - 1]?.type || '') : '';
    const isTrailingNoiseStep = lastRawStepType === 'SYSTEM_MESSAGE' || lastRawStepType === 'CHECKPOINT';
    let transcriptProgressed = false;
    if (!isTrailingNoiseStep && (logStatSize > 0 || fullStatSize > 0)) {
      if (prevStatuslineSnap) {
        transcriptProgressed = (
          logStatSize > Number(prevStatuslineSnap.logSize || 0) ||
          fullStatSize > Number(prevStatuslineSnap.fullSize || 0) ||
          logStatMtime > Number(prevStatuslineSnap.logMtimeMs || 0) ||
          fullStatMtime > Number(prevStatuslineSnap.fullMtimeMs || 0) ||
          turns.length > Number(prevStatuslineSnap.turnsCount || 0)
        );
      } else {
        const latestStatMtime = Math.max(logStatMtime || 0, fullStatMtime || 0);
        transcriptProgressed = latestStatMtime > 0 && (nowMs - latestStatMtime) <= 30_000;
      }
    }
    const rpcTimedOutOrSkipped = Boolean(
      genMetaBundle?.rpcTimedOut ||
      host?.quotaStatus?.errorCode === 'ETIMEDOUT' ||
      host?.quotaStatus?.errorCode === 'ABORTED' ||
      host?.quotaStatus?.errorCode === 'BUDGET_SKIPPED'
    );
    const samePrevLogSig = Boolean(
      prevStatuslineSnap &&
      prevStatuslineSnap.targetLogPath === targetLogPath &&
      prevStatuslineSnap.logSize === logStatSize &&
      prevStatuslineSnap.logMtimeMs === logStatMtime
    );
    if (convId && !rpcSignal?.aborted) {
      if (rpcTimedOutOrSkipped && samePrevLogSig) {
        // Preserve previous good metrics/quotas while refreshing signature & short cooldown
        // so slow/unreachable LS never causes an infinite cache-miss storm on every tick.
        saveStatuslineSnapEntry(convId, {
          ...prevStatuslineSnap,
          targetLogPath,
          logSize: logStatSize,
          logMtimeMs: logStatMtime,
          fullSize: fullStatSize,
          fullMtimeMs: fullStatMtime,
          hostCacheMtimeMs: latestHostCacheMtimeMs,
          convDbSig,
          genCacheMtimeMs: latestGenCacheMtimeMs,
          lsKeyHash: lsDiskHash,
          metaSettled: false,
          savedAt: nowMs
        });
      } else {
        saveStatuslineSnapEntry(convId, {
          targetLogPath,
          logSize: logStatSize,
          logMtimeMs: logStatMtime,
          fullSize: fullStatSize,
          fullMtimeMs: fullStatMtime,
          hostCacheMtimeMs: latestHostCacheMtimeMs,
          convDbSig,
          genCacheMtimeMs: latestGenCacheMtimeMs,
          lsKeyHash: lsDiskHash,
          metaSettled: snapSettled,
          savedAt: nowMs,
          quotas: host.quotas || [],
          context: contextPayload,
          speed: speedPayload,
          turnsCount: turns.length
        });
      }
    }
    return {
      ok: true,
      transcriptProgressed,
      scannedAt: nowMs,
      conversationId: convId,
      conversationSource,
      quotas: host.quotas || [],
      quotaStatus: host.quotaStatus,
      context: contextPayload,
      speed: speedPayload,
      turnsCount: turns.length,
      turns: []
    };
  }

  // Resolve workspace URI & repository metadata via official agentapi if available (in-memory cache only)
  let wsMeta = convWorkspaceCache.get(convId) ?? null;
  if (!skipWorkspaceLookup && wsMeta === null && !convWorkspaceCache.has(convId)) {
    let resolvedWorkspacePath = null;
    let metaRepoName = null;
    let metaBranchName = null;
    try {
      const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
      if (exe) {
        const out = execFileSync(exe, ['agentapi', 'get-conversation-metadata', convId], {
          encoding: 'utf-8',
          timeout: 2000
        });
        const parsedMeta = JSON.parse(out);
        const convMetaObj = parsedMeta?.response?.conversationMetadata || {};
        const metaInner = convMetaObj?.metadata || {};
        const uri = metaInner?.workspaceUris?.[0] || '';
        if (uri.startsWith('file://')) resolvedWorkspacePath = fileURLToPath(uri);
        metaRepoName = String(
          metaInner?.repositories?.[0]?.computedName ||
          metaInner?.workspaces?.[0]?.repository?.computedName ||
          convMetaObj?.repositories?.[0]?.computedName ||
          convMetaObj?.workspaces?.[0]?.repository?.computedName ||
          ''
        ).trim() || null;
        metaBranchName = String(
          metaInner?.repositories?.[0]?.branchName ||
          metaInner?.workspaces?.[0]?.repository?.branchName ||
          metaInner?.branchName ||
          convMetaObj?.repositories?.[0]?.branchName ||
          convMetaObj?.workspaces?.[0]?.repository?.branchName ||
          ''
        ).trim() || null;
      }
    } catch {}
    wsMeta = { workspacePath: resolvedWorkspacePath, metaRepoName, metaBranchName };
    convWorkspaceCache.set(convId, wsMeta);
  }
  const workspacePath = wsMeta?.workspacePath ?? null;
  const sqlSummaryEntry = summariesIndex?.byId?.get(convId) || null;
  const cliWsFallback = (!workspacePath && useCliLogs)
    ? (readCliLastConversationsMap(cliDataDir).byConvId.get(convId) || readCliHistoryIndex(cliDataDir).byConvId.get(convId)?.workspace || '')
    : '';
  const effectiveWsPath = workspacePath || cliWsFallback || null;
  let repoName = wsMeta?.metaRepoName
    || (effectiveWsPath ? extractProjectNameFromUris([effectiveWsPath]) : null)
    || sqlSummaryEntry?.projectName
    || null;
  let repoBranch = wsMeta?.metaBranchName || (effectiveWsPath ? readGitBranchCached(effectiveWsPath, nowMs) : null);
  if (!workspacePath && isCliRuntimeEnv() && convId && convId === String(process.env.ANTIGRAVITY_CONVERSATION_ID || '').trim()) {
    try {
      const cwd = process.cwd();
      if (cwd && existsSync(join(cwd, '.git'))) {
        const cwdBranch = readGitBranchFromDir(cwd);
        if (!repoName) repoName = basename(cwd) || null;
        if (!repoBranch && cwdBranch) repoBranch = cwdBranch;
      }
    } catch {}
  }
  const repoInfo = {
    name: repoName || null,
    branch: repoBranch || null,
    label: (repoName && repoBranch) ? `${repoName}@${repoBranch}` : (repoName || null)
  };
  const enrichedRecentConversations = enrichRecentConversationsMetadata(recentConversations, {
    convId,
    repoInfo,
    summariesIndex,
    cliDataDir,
    nowMs
  });

  // Swarm / Subagent full-tree aggregation (works even without SQLite)
  const agentTree = collectAgentTree(convId, convBrainDir, {
    agDir,
    cliDir: cliDataDir,
    ideDir: ideDataDir,
    summariesIndex,
    dynamicModelMap: host.dynamicModelMap,
    parentTurnsCount: turns.length,
    parentSessionTotals: sessionTotals,
    parentCostUSD: sessionCostUSD,
    parentCacheSavingsUSD: sessionCacheSavingsUSD
  });

  // /btw branch info & fork step deduplication metadata
  const effectiveForkStep = Math.max(
    Number(sqliteSignals?.forkStepIndex || 0),
    Number(transcriptForkStepIndex || 0)
  );
  const isBtwBranch = Boolean(
    sqliteSignals?.trajectoryType === 22 ||
    effectiveForkStep > 0 ||
    transcriptIsBtw
  );
  const branchParentConvId = sqliteSignals?.parentConvId || transcriptParentConvId || sqlSummaryEntry?.parentConvId || null;
  let deduplicatedStepsCount = 0;
  if (isBtwBranch && effectiveForkStep > 0) {
    for (let i = 0; i < rawSteps.length; i++) {
      const stp = rawSteps[i];
      const sNum = Number(stp?.step_index ?? i);
      if (Number.isFinite(sNum) && sNum <= effectiveForkStep && isModelTurnStep(stp)) {
        deduplicatedStepsCount++;
      }
    }
  }
  const branchInfo = isBtwBranch
    ? {
        isBranch: true,
        kind: 'btw',
        parentConvId: branchParentConvId,
        forkStepIndex: effectiveForkStep,
        deduplicatedStepsCount
      }
    : null;

  // Per-session diagnostics (transcript errors + SQLite events & routing)
  const sessionEventMap = new Map();
  const seenSessionEventReq = new Set();
  const pushSessionEvent = (ev) => {
    if (!ev || !ev.kind) return;
    if (ev.requestId) {
      const reqDedupKey = `${ev.kind}:${ev.requestId}`;
      if (seenSessionEventReq.has(reqDedupKey)) return;
      seenSessionEventReq.add(reqDedupKey);
    }
    const key = `${ev.kind}:${ev.stepIndex ?? 0}`;
    if (sessionEventMap.has(key)) {
      const existing = sessionEventMap.get(key);
      if (ev.requestId && !existing.requestId) existing.requestId = String(ev.requestId);
      if (Number(ev.retries) > 0 && !existing.retries) existing.retries = Number(ev.retries);
      return;
    }
    sessionEventMap.set(key, {
      kind: ev.kind,
      stepIndex: Number(ev.stepIndex ?? 0),
      ...(ev.createdAt ? { createdAt: ev.createdAt } : {}),
      ...(ev.requestId ? { requestId: String(ev.requestId) } : {}),
      ...(Number(ev.retries) > 0 ? { retries: Number(ev.retries) } : {}),
      ...(ev.source ? { source: String(ev.source) } : {}),
      detail: sanitizeSqliteText(ev.detail || '', 220)
    });
  };
  for (const ev of (sqliteSignals?.events || [])) pushSessionEvent(ev);
  for (const ev of transcriptDiagEvents) pushSessionEvent(ev);
  for (const t of turns) {
    if (!t.error) continue;
    const dKind = classifyDiagnosticEventText(t.error);
    if (dKind) {
      pushSessionEvent({
        kind: dKind,
        stepIndex: t.stepIndex ?? t.turnIndex,
        createdAt: t.createdAt || '',
        detail: t.error
      });
    }
  }
  const allSessionDiagEvents = [...sessionEventMap.values()]
    .sort((a, b) => (a.stepIndex - b.stepIndex));
  const allSessionRouting = Array.isArray(sqliteSignals?.routingEvents)
    ? sqliteSignals.routingEvents.map((r) => ({
        stepIndex: Number(r.stepIndex ?? 0),
        requestedModel: sanitizeSqliteText(r.requestedModel || '', 80),
        respondedModel: sanitizeSqliteText(r.respondedModel || '', 80),
        reason: String(r.reason || 'model_reroute')
      }))
    : [];
  const sessionDiagnostics = {
    sqliteUsed: Boolean(sqliteSignals),
    eventsCount: allSessionDiagEvents.length,
    routingCount: allSessionRouting.length,
    events: allSessionDiagEvents.slice(-15).reverse(),
    routing: allSessionRouting.slice(-15).reverse()
  };

  let fallbackModelTimeSum = 0;
  let fallbackHasModelTime = false;
  let fallbackTtftSum = 0;
  let fallbackTtftCount = 0;
  let fallbackStreamSecSum = 0;
  let fallbackStreamOutSum = 0;
  for (const t of turns) {
    if (typeof t.duration === 'number' && t.duration > 0) {
      fallbackModelTimeSum += t.duration;
      fallbackHasModelTime = true;
    }
    if (typeof t.ttft === 'number' && t.ttft > 0) {
      fallbackTtftSum += t.ttft;
      fallbackTtftCount += 1;
    }
    if (typeof t.streamingSec === 'number' && t.streamingSec > 0 && t.outputTokens > 0) {
      fallbackStreamSecSum += t.streamingSec;
      fallbackStreamOutSum += t.outputTokens;
    }
  }
  const stRounds = (sqlMetrics && Number(sqlMetrics.rounds) > 0)
    ? Number(sqlMetrics.rounds)
    : (allPromptTurns.length || userMessages || 0);
  const stSteps = (sqlMetrics && Number(sqlMetrics.steps) > 0)
    ? Number(sqlMetrics.steps)
    : (totalSteps || 0);
  const stCalls = (sqlMetrics && Number(sqlMetrics.calls) > 0)
    ? Number(sqlMetrics.calls)
    : (turns.length || 0);
  const stModelTimeSec = (sqlMetrics && sqlMetrics.modelTimeSec !== null && sqlMetrics.modelTimeSec > 0)
    ? sqlMetrics.modelTimeSec
    : (fallbackHasModelTime ? Number(fallbackModelTimeSum.toFixed(2)) : null);
  const stToolTimeSec = (sqlMetrics && sqlMetrics.toolTimeSec !== null)
    ? sqlMetrics.toolTimeSec
    : null;
  const stTotalActiveSec = (stModelTimeSec !== null || stToolTimeSec !== null)
    ? Number(((stModelTimeSec || 0) + (stToolTimeSec || 0)).toFixed(2))
    : null;
  let stModelSharePercent = null;
  let stToolSharePercent = null;
  if (stTotalActiveSec !== null && stTotalActiveSec > 0 && stModelTimeSec !== null && stToolTimeSec !== null) {
    stModelSharePercent = Number(((stModelTimeSec / stTotalActiveSec) * 100).toFixed(1));
    stToolSharePercent = Number((100 - stModelSharePercent).toFixed(1));
  }
  const stAvgTtftSec = (sqlMetrics && sqlMetrics.avgTtftSec !== null)
    ? sqlMetrics.avgTtftSec
    : (fallbackTtftCount > 0 ? Number((fallbackTtftSum / fallbackTtftCount).toFixed(2)) : null);
  const stSessionStreamTps = (sqlMetrics && sqlMetrics.sessionStreamTps !== null)
    ? sqlMetrics.sessionStreamTps
    : (fallbackStreamSecSum > 0 && fallbackStreamOutSum > 0
        ? Number((fallbackStreamOutSum / fallbackStreamSecSum).toFixed(1))
        : (avgTps ?? null));
  const sessionTiming = {
    rounds: stRounds,
    steps: stSteps,
    calls: stCalls,
    modelTimeSec: stModelTimeSec,
    toolTimeSec: stToolTimeSec,
    totalActiveSec: stTotalActiveSec,
    modelSharePercent: stModelSharePercent,
    toolSharePercent: stToolSharePercent,
    avgTtftSec: stAvgTtftSec,
    sessionStreamTps: stSessionStreamTps,
    sqliteStale: Boolean(sqliteSignals?.stale || sqlMetrics?.stale),
    sqlitePartial: Boolean(sqlMetrics?.partial)
  };

  const resolvedTitle = conversationTitle || sqlSummaryEntry?.title || `会话 ${convId.slice(0, 8)}`;
  const promptUsed = latestValidTurn
    ? ((latestValidTurn.inputTokens || 0) + (latestValidTurn.cacheTokens || 0) + (latestValidTurn.cacheWriteTokens || 0))
    : null;
  const skillsTokens = (contextBreakdown?.groups?.find((g) => g.key === 'skills' || g.name === 'Skills')?.tokens)
    || (contextBreakdown?.categories?.find((c) => c.key === 'skills' || c.type === 5)?.tokens)
    || 0;
  const enrichedQuotas = enrichQuotasWithCalibration(host.quotas || [], null, { persist: false, nowMs });
  const enrichedModelQuota = attachCalibrationToModelQuota(modelQuota, enrichedQuotas, nowMs);
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
    promptUsed,
    projectedNextMin: usedTokens,
    projectedNextPercent: usedPercent,
    inputTokens: latestValidTurn?.inputTokens ?? null,
    cacheTokens: latestValidTurn?.cacheTokens ?? null,
    cacheWriteTokens: latestValidTurn?.cacheWriteTokens ?? null,
    outputTokens: latestValidTurn?.outputTokens ?? null,
    thinkingTokens: latestValidTurn?.thinkingTokens ?? 0,
    responseTokens: latestValidTurn?.responseTokens ?? (latestValidTurn?.outputTokens ?? 0),
    skillsTokens,
    cacheHitPercent,
    cacheStatus,
    roundCostUSD: Number((latestValidTurn?.costUSD || 0).toFixed(5)),
    sessionCostUSD: Number(sessionCostUSD.toFixed(4)),
    sessionCacheSavingsUSD: Number(sessionCacheSavingsUSD.toFixed(4)),
    isPriced: Boolean(latestValidTurn?.isPriced),
    latestPromptStartup,
    error: errorInfo,
    quota: enrichedModelQuota,
    breakdown: contextBreakdown,
    sessionTotals,
    sessionTiming,
    sessionModels
  };
  const speedPayload = latestValidTurn ? {
    tps: latestValidTurn.tps,
    streamingTps: latestValidTurn.streamingTps,
    effectiveTps: latestValidTurn.effectiveTps ?? null,
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
  const sparklinePayload = turns.slice(-40).map((t) => ({
    turn: t.turnIndex,
    total: t.totalTokens,
    delta: t.deltaTokens,
    cache: t.cacheTokens,
    cacheWrite: t.cacheWriteTokens || 0,
    output: t.outputTokens,
    tps: t.tps,
    costUSD: t.costUSD
  }));
  const turnsPayload = turns.slice(-40).reverse().map(({
    contextBreakdown: _cb,
    hasRecordedModel: _hrm,
    _arrayIdx: _ai,
    _isServerExact: _ise,
    _budgetFromSqlite: _bfs,
    _cacheSavingsUSD: _csusd,
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
    repoInfo,
    branchInfo,
    agentTree,
    compactions,
    sessionDiagnostics,
    quotas: host.quotas || [],
    quotaState: toStableQuotaState(host.quotaStatus),
    context: modelQuota !== enrichedModelQuota ? { ...contextPayload, quota: modelQuota } : contextPayload,
    speed: speedPayload,
    sparkline: sparklinePayload,
    turns: turnsPayload,
    promptTurns: promptTurnsPayload,
    heavyItems,
    audit: auditPayload
  });

  const resultSnap = {
    ok: true,
    etag,
    scannedAt: nowMs,
    conversationId: convId,
    conversationSource,
    conversationTitle: resolvedTitle,
    pinnedConvId: validatedPinnedConvId || null,
    workspacePath,
    repoInfo,
    branchInfo,
    agentTree,
    compactions,
    sessionDiagnostics,
    recentConversations: enrichedRecentConversations,
    quotas: enrichedQuotas,
    quotaStatus: host.quotaStatus,
    context: contextPayload,
    speed: speedPayload,
    sparkline: sparklinePayload,
    turns: turnsPayload,
    promptTurns: promptTurnsPayload,
    heavyItems,
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

function walkTranscriptFiles(rootBrainDir, sourceName, scanMeta = null) {
  const jobs = [];
  if (!existsSync(rootBrainDir)) return jobs;
  const visited = new Set();

  const walk = (dir, depth) => {
    if (depth > 4) return;
    let real;
    try { real = realpathSync(dir); } catch (err) {
      if (scanMeta && depth === 0 && (err?.code === 'EPERM' || err?.code === 'EACCES')) {
        scanMeta.restrictedRoots.push({ dir, source: sourceName, code: err.code });
      }
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);

    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (err) {
      if (scanMeta && depth === 0 && (err?.code === 'EPERM' || err?.code === 'EACCES')) {
        scanMeta.restrictedRoots.push({ dir, source: sourceName, code: err.code });
      }
      return;
    }
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
  const allowDiskCacheWithoutLs = Boolean(options.allowDiskCacheWithoutLs);
  const host = await getHostUserStatus(force, {
    background,
    menubarMode,
    nowMs,
    allowDiskCacheWithoutLs
  });
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
  const ideDir = findIdeDataDir();
  const cliDir = findCliDataDir();
  const scanMeta = { restrictedRoots: [] };
  const desktopJobs = walkTranscriptFiles(join(agDir, 'brain'), 'desktop', scanMeta);
  if (ideDir && ideDir !== agDir && ideDir !== cliDir) {
    const ideJobs = walkTranscriptFiles(join(ideDir, 'brain'), 'desktop', scanMeta);
    const seenDesktopConvs = new Set(desktopJobs.map((j) => j.convId));
    for (const j of ideJobs) {
      if (!seenDesktopConvs.has(j.convId)) {
        seenDesktopConvs.add(j.convId);
        desktopJobs.push(j);
      }
    }
  }
  const cliJobs = walkTranscriptFiles(join(cliDir, 'brain'), 'cli', scanMeta);
  const activeHintConvId = String(options.convId || process.env.ANTIGRAVITY_CONVERSATION_ID || '').trim();
  if (CONV_ID_RE.test(activeHintConvId)) {
    const appendDirectConvJob = (baseDir, targetJobs, sourceName) => {
      if (!baseDir || targetJobs.some((j) => j.convId === activeHintConvId)) return;
      const std = join(baseDir, 'brain', activeHintConvId, '.system_generated', 'logs', 'transcript.jsonl');
      const direct = join(baseDir, 'brain', activeHintConvId, 'transcript.jsonl');
      const p = existsSync(std) ? std : (existsSync(direct) ? direct : '');
      if (!p) return;
      try {
        statSync(p);
        targetJobs.push({ path: p, convId: activeHintConvId, source: sourceName });
      } catch {}
    };
    if (isCliRuntimeEnv()) {
      appendDirectConvJob(cliDir, cliJobs, 'cli');
      appendDirectConvJob(agDir, desktopJobs, 'desktop');
      if (ideDir !== agDir && ideDir !== cliDir) appendDirectConvJob(ideDir, desktopJobs, 'desktop');
    } else {
      appendDirectConvJob(agDir, desktopJobs, 'desktop');
      if (ideDir !== agDir && ideDir !== cliDir) appendDirectConvJob(ideDir, desktopJobs, 'desktop');
      appendDirectConvJob(cliDir, cliJobs, 'cli');
    }
  }
  const allJobs = [...desktopJobs, ...cliJobs];
  const restrictedSources = [...new Set(scanMeta.restrictedRoots.map((r) => r.source))];
  const historyStatus = restrictedSources.length > 0
    ? {
        state: 'restricted',
        restrictedSources,
        reason: '受当前运行环境沙箱限制，无法扫描全量历史会话目录；请在外部终端运行 agy-context 查看跨会话汇总'
      }
    : { state: 'ok', restrictedSources: [], reason: '' };

  const desktopSessionFiles = countSessionFiles(join(agDir, 'conversations'))
    + (ideDir && ideDir !== agDir && ideDir !== cliDir ? countSessionFiles(join(ideDir, 'conversations')) : 0);
  const cliSessionFiles = countSessionFiles(join(cliDir, 'conversations'));

  const now = hasExplicitNow ? new Date(nowMs) : new Date();
  const todayKey = formatLocalDateKey(now);
  const yesterdayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yesterdayKey = formatLocalDateKey(yesterdayDate);
  const monthPrefix = todayKey.slice(0, 7);
  const yearPrefix = todayKey.slice(0, 4);

  const createEmpty24h = () => Array.from({ length: 24 }, (_, hour) => ({
    hour,
    total: 0,
    input: 0,
    cache: 0,
    cacheWrite: 0,
    output: 0,
    steps: 0,
    costUSD: 0
  }));
  const hourlyBySource = {
    all: { today: createEmpty24h(), yesterday: createEmpty24h() },
    desktop: { today: createEmpty24h(), yesterday: createEmpty24h() },
    cli: { today: createEmpty24h(), yesterday: createEmpty24h() }
  };

  const addHourly = (srcKey, dayBucket, hour, inp, cap, outp, cost, cw = 0) => {
    const arr = hourlyBySource[srcKey]?.[dayBucket];
    if (!arr || hour < 0 || hour > 23) return;
    const h = arr[hour];
    h.total += inp + cap + cw + outp;
    h.input += inp;
    h.cache += cap;
    h.cacheWrite += cw;
    h.output += outp;
    h.steps += 1;
    h.costUSD = Number((h.costUSD + cost).toFixed(6));
  };

  const dailyBySource = { all: {}, desktop: {}, cli: {} };
  const requestsBySource = { all: [], desktop: [], cli: [] };
  const seenEvents = new Set();
  let firstUseDate = null;

  const trackDate = (d) => {
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      if (!firstUseDate || d < firstUseDate) firstUseDate = d;
    }
  };

  const addDaily = (bucketMap, dateKey, inp, cap, outp, pricedCost, refCost, modelName = '未记录模型', cw = 0) => {
    if (!bucketMap[dateKey]) {
      bucketMap[dateKey] = {
        total: 0,
        input: 0,
        cache: 0,
        cacheWrite: 0,
        output: 0,
        steps: 0,
        costUSD: 0,
        refCostUSD: 0,
        _byModelMap: new Map()
      };
    }
    const b = bucketMap[dateKey];
    const tok = inp + cap + cw + outp;
    b.total += tok;
    b.input += inp;
    b.cache += cap;
    b.cacheWrite += cw;
    b.output += outp;
    b.steps += 1;
    b.costUSD = Number((b.costUSD + pricedCost).toFixed(6));
    b.refCostUSD = Number((b.refCostUSD + refCost).toFixed(6));
    const mName = String(modelName || '未记录模型').trim() || '未记录模型';
    let mEntry = b._byModelMap.get(mName);
    if (!mEntry) {
      mEntry = { name: mName, tokens: 0, input: 0, cache: 0, cacheWrite: 0, steps: 0, costUSD: 0 };
      b._byModelMap.set(mName, mEntry);
    }
    mEntry.tokens += tok;
    mEntry.input += inp;
    mEntry.cache += cap;
    mEntry.cacheWrite += cw;
    mEntry.steps += 1;
    mEntry.costUSD = Number((mEntry.costUSD + pricedCost).toFixed(6));
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

      if (
        !cached ||
        cached.cacheVersion !== TRANSCRIPT_HIST_CACHE_VERSION ||
        cached.size !== st.size ||
        cached.mtimeMs !== st.mtimeMs ||
        !Array.isArray(cached.errorEvents)
      ) {
        const rawRecords = [];
        const errorEvents = [];
        const missingStepSet = new Set();
        let firstDate = null;
        let lastDate = null;
        let activeModel = '';
        let convTitle = '';
        let transcriptIsBtw = false;
        let transcriptForkStepIndex = 0;
        const lines = readFileSync(job.path, 'utf-8').split(/\r?\n/);

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          const line = lines[lineIdx];
          if (!line.trim()) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }

          if (ev.trajectory_type === 22 || ev.is_btw === true || ev.branch_kind === 'btw') {
            transcriptIsBtw = true;
          }
          const rawFork = Number(ev.fork_step_index ?? ev.forkStepIndex ?? 0);
          if (Number.isInteger(rawFork) && rawFork > transcriptForkStepIndex) {
            transcriptForkStepIndex = rawFork;
          }

          if (ev.type === 'USER_INPUT' && ev.content) {
            if (!convTitle) convTitle = truncateCleanText(extractCleanUserTitle(ev.content), 60);
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
          if (dateKey && (!lastDate || dateKey > lastDate)) {
            lastDate = dateKey;
          }

          const stepNum = Number(ev.step_index ?? lineIdx);
          if (ev.type === 'ERROR_MESSAGE' || ev.status === 'ERROR') {
            const errStr = typeof ev.content === 'string' ? ev.content : '';
            const dKind = classifyDiagnosticEventText(errStr);
            if (dKind) {
              errorEvents.push({
                kind: dKind,
                stepIndex: stepNum,
                date: dateKey || lastDate || firstDate || '',
                createdAt: ev.created_at || dateKey || '',
                detail: sanitizeSqliteText(errStr, 120)
              });
            }
          }

          if (!isModelTurnStep(ev)) continue;
          const { input: inp, cache: cap, cacheWrite: cw, output: outp, thinking } = extractStepUsage(ev);
          const tot = inp + cap + cw + outp;
          if (tot <= 0 || !dateKey) continue;

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
            cacheWriteTokens: cw,
            outputTokens: outp,
            thinkingTokens: thinking,
            totalTokens: tot,
            isError: ev.status === 'ERROR'
          });
        }

        cached = {
          cacheVersion: TRANSCRIPT_HIST_CACHE_VERSION,
          size: st.size,
          mtimeMs: st.mtimeMs,
          firstDate,
          lastDate,
          convTitle,
          transcriptIsBtw,
          transcriptForkStepIndex,
          errorEvents,
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

  const [sqliteEnabled, summariesIndex] = await Promise.all([
    isSqliteAvailable(),
    readMergedSummariesIndex(agDir, cliDir, ideDir)
  ]);
  const summariesById = summariesIndex?.byId || null;

  const resultBuiltSeq = genBackfillDataSeq;
  const latestPersistedConvs = loadPersistedStepModels().convs;

  const diagEventsSummary = {
    total: 0,
    safetyFilter: 0,
    safetyWastedUSD: 0,
    quota429: 0,
    upstreamRetry: 0,
    contextOverflow: 0
  };
  const allDiagEvents = [];
  const allDiagRouting = [];
  const diagEventDedup = new Set();
  const diagRoutingDedup = new Set();
  const routingUniqueModels = new Set();

  for (let pIdx = 0; pIdx < parsedJobs.length; pIdx++) {
    const { job, cached } = parsedJobs[pIdx];
    if (pIdx > 0 && pIdx % 25 === 0) {
      await new Promise((r) => setImmediate(r));
    }
    if (cached.firstDate) trackDate(cached.firstDate);
    const genCached = convGenMetaCache.get(job.convId);
    const persistedSteps = latestPersistedConvs[job.convId]?.steps || null;
    const convDbPath = sqliteEnabled ? resolveConvDbPath(job.convId, job.source, agDir, cliDir, ideDir) : '';
    const sqlSignals = convDbPath
      ? await readConversationSqliteSignals(convDbPath, { includeLatestGenDetail: false })
      : null;

    const forkStepIndex = Math.max(
      Number(sqlSignals?.forkStepIndex || 0),
      Number(cached.transcriptForkStepIndex || 0)
    );
    const isBtwBranch = Boolean(
      sqlSignals?.trajectoryType === 22 ||
      forkStepIndex > 0 ||
      cached.transcriptIsBtw
    );
    const projectName = resolveProjectNameForConv(job.convId, summariesById);
    const convTitle = truncateCleanText(
      summariesById?.get(job.convId)?.title || cached.convTitle || `会话 ${job.convId.slice(0, 8)}`,
      60
    );

    const stepCostByNum = new Map();
    const stepTimeByNum = new Map();

    for (const rawRec of cached.rawRecords) {
      // /btw branch deduplication: skip inherited parent steps (stepNum <= forkStepIndex)
      if (isBtwBranch && forkStepIndex > 0 && rawRec.stepNum <= forkStepIndex) {
        continue;
      }

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
      const sqlStepGen = sqlSignals?.genByStep?.get(rawRec.stepNum) || null;
      const sqlModel = sqlStepGen
        ? String(sqlStepGen.modelDisplayName || sqlStepGen.responseModel || sqlStepGen.model || sqlStepGen.requestedModel || '').trim()
        : '';
      const recCacheWrite = (rawRec.cacheWriteTokens || 0) > 0
        ? rawRec.cacheWriteTokens
        : Math.max(0, Number(sqlStepGen?.usage?.cacheWriteTokens || 0) || 0);
      const recTotalTokens = rawRec.inputTokens + rawRec.cacheTokens + recCacheWrite + rawRec.outputTokens;

      const rec = {
        eventId: rawRec.eventId,
        source: rawRec.source,
        convId: rawRec.convId,
        projectName,
        date: rawRec.date,
        created_at: rawRec.created_at,
        model: String(gmModel || rawRec.stepOwnModel || sqlModel || rawRec.fallbackRunningModel || '').trim(),
        inputTokens: rawRec.inputTokens,
        cacheTokens: rawRec.cacheTokens,
        cacheWriteTokens: recCacheWrite,
        outputTokens: rawRec.outputTokens,
        thinkingTokens: rawRec.thinkingTokens,
        totalTokens: recTotalTokens
      };

      const priced = calculateRequestApiCost(rec, host.dynamicModelMap);
      const refCalc = calculateReferenceCost(rec, 'gemini-3.8-flash', rec.date);
      const pCost = priced.isPriced ? (priced.costUSD || 0) : 0;
      const rCost = refCalc.totalCostUSD || 0;
      const effCost = priced.isPriced ? pCost : rCost;
      const effSavings = priced.isPriced ? (priced.cacheSavingsUSD || 0) : (refCalc.cacheSavingsUSD || 0);
      rec._effCostUSD = effCost;
      rec._effSavingsUSD = effSavings;
      rec._modelKey = priced.modelKey || normalizeModelId(rec.model, host.dynamicModelMap) || null;

      stepCostByNum.set(rawRec.stepNum, effCost);
      stepTimeByNum.set(rawRec.stepNum, { date: rawRec.date, createdAt: rawRec.created_at });

      const modelDisp = priced.modelDisplayName
        || (rec.model ? formatModelDisplayName(rec.model, priced.modelKey || null) : '未记录模型');

      addDaily(dailyBySource.all, rec.date, rec.inputTokens, rec.cacheTokens, rec.outputTokens, pCost, rCost, modelDisp, rec.cacheWriteTokens);
      addDaily(dailyBySource[rec.source] || dailyBySource.desktop, rec.date, rec.inputTokens, rec.cacheTokens, rec.outputTokens, pCost, rCost, modelDisp, rec.cacheWriteTokens);

      if (rec.date === todayKey || rec.date === yesterdayKey) {
        const dt = new Date(rec.created_at);
        if (!Number.isNaN(dt.getTime())) {
          const dayBucket = rec.date === todayKey ? 'today' : 'yesterday';
          const hr = dt.getHours();
          addHourly('all', dayBucket, hr, rec.inputTokens, rec.cacheTokens, rec.outputTokens, effCost, rec.cacheWriteTokens);
          addHourly(rec.source === 'cli' ? 'cli' : 'desktop', dayBucket, hr, rec.inputTokens, rec.cacheTokens, rec.outputTokens, effCost, rec.cacheWriteTokens);
        }
      }

      requestsBySource.all.push(rec);
      (requestsBySource[rec.source] || requestsBySource.desktop).push(rec);
    }

    // Aggregate cross-session diagnostic events (SQLite + Transcript)
    const convFallbackDate = cached.lastDate || cached.firstDate || todayKey;
    const convFallbackCreatedAt = new Date(cached.mtimeMs || nowMs).toISOString();
    const recordDiagEvent = (ev) => {
      if (!ev || !ev.kind) return;
      const stepIdx = Number(ev.stepIndex ?? 0);
      if (isBtwBranch && forkStepIndex > 0 && stepIdx > 0 && stepIdx <= forkStepIndex) return;
      if (ev.requestId) {
        const reqKey = `${job.convId}:${ev.kind}:req:${ev.requestId}`;
        if (diagEventDedup.has(reqKey)) return;
        diagEventDedup.add(reqKey);
      }
      const dKey = `${job.convId}:${ev.kind}:${stepIdx}`;
      if (diagEventDedup.has(dKey)) return;
      diagEventDedup.add(dKey);

      const stepTime = stepTimeByNum.get(stepIdx) || stepTimeByNum.get(stepIdx - 1) || null;
      const evDate = ev.date || stepTime?.date || convFallbackDate;
      const evCreatedAt = ev.createdAt || stepTime?.createdAt || convFallbackCreatedAt;
      let wastedUSD = 0;
      if (ev.kind === 'safety_filter') {
        wastedUSD = Number((stepCostByNum.get(stepIdx) || stepCostByNum.get(stepIdx - 1) || 0).toFixed(4));
        diagEventsSummary.safetyFilter += 1;
        diagEventsSummary.safetyWastedUSD = Number((diagEventsSummary.safetyWastedUSD + wastedUSD).toFixed(4));
      } else if (ev.kind === 'quota_429') {
        diagEventsSummary.quota429 += 1;
      } else if (ev.kind === 'upstream_retry') {
        diagEventsSummary.upstreamRetry += 1;
      } else if (ev.kind === 'context_overflow') {
        diagEventsSummary.contextOverflow += 1;
      } else {
        return;
      }
      diagEventsSummary.total += 1;
      allDiagEvents.push({
        kind: ev.kind,
        convId: job.convId,
        convTitle,
        date: evDate,
        createdAt: evCreatedAt,
        stepIndex: stepIdx,
        ...(ev.requestId ? { requestId: String(ev.requestId) } : {}),
        ...(Number(ev.retries) > 0 ? { retries: Number(ev.retries) } : {}),
        wastedUSD,
        detail: sanitizeSqliteText(ev.detail || '', 220)
      });
    };

    for (const ev of (sqlSignals?.events || [])) recordDiagEvent(ev);
    for (const ev of (cached.errorEvents || [])) recordDiagEvent(ev);

    // Aggregate cross-session canary/routing events from SQLite
    for (const r of (sqlSignals?.routingEvents || [])) {
      const stepIdx = Number(r.stepIndex ?? 0);
      if (isBtwBranch && forkStepIndex > 0 && stepIdx > 0 && stepIdx <= forkStepIndex) continue;
      const reqModel = sanitizeSqliteText(r.requestedModel || '', 80);
      const respModel = sanitizeSqliteText(r.respondedModel || '', 80);
      const reason = String(r.reason || 'model_reroute');
      const rKey = `${job.convId}:${stepIdx}:${reqModel}:${respModel}:${reason}`;
      if (diagRoutingDedup.has(rKey)) continue;
      diagRoutingDedup.add(rKey);
      if (respModel) routingUniqueModels.add(respModel);
      const stepTime = stepTimeByNum.get(stepIdx) || null;
      allDiagRouting.push({
        convId: job.convId,
        convTitle,
        date: stepTime?.date || convFallbackDate,
        createdAt: stepTime?.createdAt || convFallbackCreatedAt,
        stepIndex: stepIdx,
        requestedModel: reqModel,
        respondedModel: respModel,
        reason
      });
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
      addDaily(dailyBySource.all, dateKey, lRec.input || 0, lRec.cache || 0, lRec.output || 0, 0, refCalc.totalCostUSD || 0, '未记录模型');
      addDaily(dailyBySource.desktop, dateKey, lRec.input || 0, lRec.cache || 0, lRec.output || 0, 0, refCalc.totalCostUSD || 0, '未记录模型');
    }
  }

  for (const dMap of Object.values(dailyBySource)) {
    for (const b of Object.values(dMap)) {
      const mapObj = b._byModelMap;
      b.byModel = mapObj
        ? [...mapObj.values()]
            .sort((a, c) => (c.tokens - a.tokens) || (c.costUSD - a.costUSD))
            .slice(0, 6)
        : [];
      delete b._byModelMap;
    }
  }

  if (!firstUseDate) firstUseDate = todayKey;

  const buildSourceAnalytics = (srcKey) => {
    const dMap = dailyBySource[srcKey] || {};
    const reqs = requestsBySource[srcKey] || [];
    let grandTotal = 0, totalInput = 0, totalCache = 0, totalCacheWrite = 0, totalOutput = 0, totalSteps = 0;
    let todayTokens = 0, monthTokens = 0, yearTokens = 0;
    let monthInput = 0, monthCache = 0, monthCacheWrite = 0, monthOutput = 0, monthSteps = 0;
    let yearActiveDays = 0, monthActiveDays = 0;

    for (const [dKey, v] of Object.entries(dMap)) {
      grandTotal += v.total;
      totalInput += v.input;
      totalCache += v.cache;
      totalCacheWrite += v.cacheWrite || 0;
      totalOutput += v.output;
      totalSteps += v.steps;
      if (dKey === todayKey) todayTokens += v.total;
      if (dKey.startsWith(monthPrefix)) {
        monthTokens += v.total;
        monthInput += v.input;
        monthCache += v.cache;
        monthCacheWrite += v.cacheWrite || 0;
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

    const refAll = calculateReferenceCost(
      { inputTokens: totalInput, cacheTokens: totalCache, cacheWriteTokens: totalCacheWrite, outputTokens: totalOutput, totalTokens: grandTotal },
      'gemini-3.8-flash',
      PRICING_VERIFIED_DATE
    );
    const refPeriod = calculateReferenceCost(
      { inputTokens: monthInput, cacheTokens: monthCache, cacheWriteTokens: monthCacheWrite, outputTokens: monthOutput, totalTokens: monthTokens },
      'gemini-3.8-flash',
      PRICING_VERIFIED_DATE
    );

    // Hybrid = identified priced requests + reference rate for residual unpriced tokens
    const buildHybrid = (ident, refBase) => {
      const resIn = Math.max(0, refBase.inputTokens - ident.byCategory.inputTokens);
      const resCache = Math.max(0, refBase.cacheTokens - ident.byCategory.cacheTokens);
      const resCacheWrite = Math.max(0, (refBase.cacheWriteTokens || 0) - (ident.byCategory.cacheWriteTokens || 0));
      const resOut = Math.max(0, refBase.outputTokens - ident.byCategory.outputTokens);
      const resCalc = calculateReferenceCost(
        { inputTokens: resIn, cacheTokens: resCache, cacheWriteTokens: resCacheWrite, outputTokens: resOut },
        'gemini-3.8-flash',
        PRICING_VERIFIED_DATE
      );
      return {
        totalCostUSD: Number((ident.pricedCostUSD + resCalc.totalCostUSD).toFixed(4)),
        inputCostUSD: Number((ident.pricedInputCostUSD + resCalc.inputCostUSD).toFixed(4)),
        cacheCostUSD: Number((ident.pricedCacheCostUSD + resCalc.cacheCostUSD).toFixed(4)),
        cacheWriteCostUSD: Number(((ident.pricedCacheWriteCostUSD || 0) + (resCalc.cacheWriteCostUSD || 0)).toFixed(4)),
        outputCostUSD: Number((ident.pricedOutputCostUSD + resCalc.outputCostUSD).toFixed(4)),
        cacheSavingsUSD: Number(((ident.pricedCacheSavingsUSD || 0) + (resCalc.cacheSavingsUSD || 0)).toFixed(4)),
        knownCostUSD: ident.pricedCostUSD,
        residualCostUSD: resCalc.totalCostUSD,
        residualTokens: resIn + resCache + resCacheWrite + resOut
      };
    };

    // By-project aggregation (Top 12 by costUSD / tokens)
    const projectMap = new Map();
    for (const r of reqs) {
      const pName = String(r.projectName || '未归类工作区').trim() || '未归类工作区';
      let p = projectMap.get(pName);
      if (!p) {
        p = {
          name: pName,
          _convSet: new Set(),
          requests: 0,
          tokens: 0,
          inputTokens: 0,
          cacheTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          costUSD: 0,
          cacheSavingsUSD: 0
        };
        projectMap.set(pName, p);
      }
      if (r.convId) p._convSet.add(r.convId);
      p.requests += 1;
      p.tokens += r.totalTokens || 0;
      p.inputTokens += r.inputTokens || 0;
      p.cacheTokens += r.cacheTokens || 0;
      p.cacheWriteTokens += r.cacheWriteTokens || 0;
      p.outputTokens += r.outputTokens || 0;
      p.costUSD += r._effCostUSD || 0;
      p.cacheSavingsUSD += r._effSavingsUSD || 0;
    }
    const byProject = [...projectMap.values()]
      .map((p) => ({
        name: p.name,
        conversations: p._convSet.size,
        requests: p.requests,
        tokens: p.tokens,
        inputTokens: p.inputTokens,
        cacheTokens: p.cacheTokens,
        cacheWriteTokens: p.cacheWriteTokens,
        outputTokens: p.outputTokens,
        costUSD: Number(p.costUSD.toFixed(4)),
        cacheSavingsUSD: Number(p.cacheSavingsUSD.toFixed(4))
      }))
      .sort((a, b) => (b.costUSD - a.costUSD) || (b.tokens - a.tokens))
      .slice(0, 12);

    return {
      summary: {
        grandTotalTokens: grandTotal,
        totalInputTokens: totalInput,
        totalCacheTokens: totalCache,
        totalCacheWriteTokens: totalCacheWrite,
        totalOutputTokens: totalOutput,
        totalSteps,
        todayTokens,
        monthTokens,
        yearTokens,
        monthInput,
        monthCache,
        monthCacheWrite,
        monthOutput,
        monthSteps,
        activeDaysCount,
        monthActiveDays,
        yearActiveDays
      },
      byProject,
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

  allDiagEvents.sort((a, b) => String(b.createdAt || b.date).localeCompare(String(a.createdAt || a.date)) || (b.stepIndex - a.stepIndex));
  allDiagRouting.sort((a, b) => String(b.createdAt || b.date).localeCompare(String(a.createdAt || a.date)) || (b.stepIndex - a.stepIndex));
  const diagnostics = {
    sqliteEnabled: Boolean(sqliteEnabled),
    eventsSummary: diagEventsSummary,
    recentEvents: allDiagEvents.slice(0, 30),
    routingSummary: {
      total: allDiagRouting.length,
      uniqueModels: routingUniqueModels.size
    },
    recentRouting: allDiagRouting.slice(0, 20).map(({ createdAt: _ca, ...rest }) => rest)
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
  const allByModel = analyticsBySource.all?.costs?.allTime?.identified?.byModel || [];
  const poolTokenTotals = computePoolTokenTotals(allByModel, host.modelConfigs, host.quotaSummaryGroups);
  const enrichedModelQuotas = enrichQuotasWithCalibration(host.quotas || [], poolTokenTotals, {
    persist: true,
    nowMs
  });
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
    hourlyBySource,
    analyticsBySource,
    diagnostics
  });

  const result = {
    ok: true,
    etag,
    updatedAt: new Date().toISOString(),
    todayKey,
    currentPeriod,
    firstUseDate,
    sources,
    historyStatus,
    planStatus: effectivePlan,
    modelQuotas: enrichedModelQuotas,
    quotaStatus: host.quotaStatus,
    uiPreferences: rawSettings.uiPreferences || {},
    dailyMapBySource: dailyBySource,
    hourlyBySource,
    analyticsBySource,
    diagnostics,
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
