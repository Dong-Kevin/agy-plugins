/**
 * Deterministic, incremental byte-offset reader over the active conversation's
 * transcript_full.jsonl (fallback: transcript.jsonl).
 *
 * - Zero background file watchers; only runs when the UI panel requests it.
 * - Stat-cached (size + mtimeMs) + client ETag short-circuit (~2 us when idle).
 * - Tail/offset delta read so multi-MB transcripts never get re-read in full.
 */

import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { resolveTargetPath } from './path_utils.mjs';

export const CONV_ID_RE = /^[0-9a-f-]{8,64}$/i;
const MAX_CONVS = 16;
const INITIAL_TAIL_BYTES = 262144; // 256 KB
const MAX_DELTA_BYTES = 524288;    // 512 KB
const MAX_RAW_CANDIDATES = 120;
const MAX_MENTIONS_RETURNED = 24;

const convCache = new Map();

function touchLru(convId, value) {
  if (convCache.has(convId)) convCache.delete(convId);
  convCache.set(convId, value);
  while (convCache.size > MAX_CONVS) {
    const oldestKey = convCache.keys().next().value;
    convCache.delete(oldestKey);
  }
}

/**
 * Discover candidate Antigravity brain directories.
 * @param {string[]} [customBrainDirs]
 * @returns {string[]}
 */
export function discoverBrainDirs(customBrainDirs = []) {
  const dirs = [];
  const seen = new Set();
  const addDir = (d) => {
    if (!d) return;
    const abs = resolve(d);
    if (!seen.has(abs) && existsSync(abs)) {
      seen.add(abs);
      dirs.push(abs);
    }
  };

  for (const d of customBrainDirs) addDir(d);
  if (process.env.AGY_FINDER_BRAIN_DIR) addDir(process.env.AGY_FINDER_BRAIN_DIR);

  const execDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (execDataDir) {
    let cur = resolve(execDataDir);
    for (let i = 0; i < 5; i++) {
      addDir(join(cur, 'brain'));
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }

  addDir(join(homedir(), '.gemini', 'antigravity', 'brain'));
  addDir(join(homedir(), '.gemini', 'antigravity-cli', 'brain'));
  return dirs;
}

/**
 * Locate transcript_full.jsonl (preferred) or transcript.jsonl for a conversation.
 * @param {string} convId
 * @param {string[]} [customBrainDirs]
 * @returns {string}
 */
export function findTranscriptLogPath(convId, customBrainDirs = []) {
  if (!convId || !CONV_ID_RE.test(convId)) return '';
  const brainDirs = discoverBrainDirs(customBrainDirs);
  for (const brainDir of brainDirs) {
    const logsDir = join(brainDir, convId, '.system_generated', 'logs');
    const fullPath = join(logsDir, 'transcript_full.jsonl');
    if (existsSync(fullPath)) return fullPath;
    const compactPath = join(logsDir, 'transcript.jsonl');
    if (existsSync(compactPath)) return compactPath;
  }
  return '';
}

function isLikelyPathToken(token) {
  if (!token || token.length < 2 || token.length > 260) return false;
  if (/\s/.test(token) && !/^file:\/\//i.test(token) && !/[\\/]/.test(token)) return false;
  if (/^(https?|mailto|customization|conversation|javascript|data):/i.test(token)) return false;
  if (token.startsWith('--') || token.startsWith('-')) return false;
  if (token.includes('.system_generated')) return false;
  if (/[\\/]/.test(token)) return true;
  return /^[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?$/.test(token);
}

/**
 * Extract candidate file/directory path tokens from a PLANNER_RESPONSE markdown reply.
 * @param {string} markdownText
 * @returns {string[]}
 */
export function extractCandidateTokens(markdownText) {
  if (!markdownText || typeof markdownText !== 'string') return [];
  const found = [];

  // 1. sidecar:// links carrying ?path= / ?file= / ?reveal=
  const sidecarRe = /sidecar:\/\/[^\s)"']+\?[^\s)"']*/gi;
  for (const m of markdownText.matchAll(sidecarRe)) {
    try {
      const u = new URL(m[0]);
      const p = u.searchParams.get('path') || u.searchParams.get('file') || u.searchParams.get('reveal') || u.searchParams.get('browser');
      if (p) found.push(p);
    } catch {}
  }

  // 2. file:// URIs
  const fileUriRe = /file:\/\/\/[^\s)"'\]]+/gi;
  for (const m of markdownText.matchAll(fileUriRe)) {
    found.push(m[0]);
  }

  // 3. Markdown link targets [label](target)
  const mdLinkRe = /\[[^\]\n]+\]\(([^)\s]+)\)/g;
  for (const m of markdownText.matchAll(mdLinkRe)) {
    const target = m[1];
    if (
      target &&
      !/^(https?|mailto|sidecar|customization|conversation):/i.test(target) &&
      !target.startsWith('#')
    ) {
      found.push(target);
    }
  }

  // 4. Inline code spans `...`
  const codeSpanRe = /`([^`\n]{2,260})`/g;
  for (const m of markdownText.matchAll(codeSpanRe)) {
    const inner = m[1].trim();
    if (isLikelyPathToken(inner)) {
      found.push(inner);
    }
  }

  return found;
}

function readByteRange(filePath, startOffset, length) {
  if (length <= 0) return '';
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    let totalRead = 0;
    while (totalRead < length) {
      const n = readSync(fd, buf, totalRead, length - totalRead, startOffset + totalRead);
      if (n <= 0) break;
      totalRead += n;
    }
    return buf.subarray(0, totalRead).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function pushCandidateRecent(list, token) {
  const idx = list.indexOf(token);
  if (idx !== -1) list.splice(idx, 1);
  list.unshift(token);
  if (list.length > MAX_RAW_CANDIDATES) {
    list.length = MAX_RAW_CANDIDATES;
  }
}

/**
 * Incrementally extract and resolve mentioned paths for a conversation.
 * @param {{ conversationId?: string, roots?: string[], clientEtag?: string, customBrainDirs?: string[] }} opts
 */
export function getConversationMentions(opts = {}) {
  const conversationId = String(opts.conversationId || '').trim();
  const roots = Array.isArray(opts.roots) ? opts.roots : [];
  const clientEtag = String(opts.clientEtag || '').trim();
  const customBrainDirs = Array.isArray(opts.customBrainDirs) ? opts.customBrainDirs : [];

  if (!conversationId || !CONV_ID_RE.test(conversationId)) {
    return { ok: true, unchanged: false, etag: 'empty', items: [] };
  }

  const logPath = findTranscriptLogPath(conversationId, customBrainDirs);
  if (!logPath) {
    return { ok: true, unchanged: false, etag: 'no-log', items: [] };
  }

  let st;
  try {
    st = statSync(logPath);
  } catch {
    return { ok: true, unchanged: false, etag: 'no-stat', items: [] };
  }

  const fileSig = `${logPath}|${st.size}|${st.mtimeMs}`;
  const rootsSig = roots.join('|');
  let state = convCache.get(conversationId);

  if (state && state.logPath === logPath && state.fileSig === fileSig && state.resolvedCacheKey === rootsSig) {
    touchLru(conversationId, state);
    if (clientEtag && clientEtag === state.etag) {
      return { ok: true, unchanged: true, etag: state.etag };
    }
    return { ok: true, unchanged: false, etag: state.etag, items: state.resolvedItems };
  }

  if (!state || state.logPath !== logPath || st.size < state.lastSize) {
    state = {
      logPath,
      lastSize: 0,
      lastMtimeMs: 0,
      fileSig: '',
      carry: '',
      rawCandidates: [],
      resolvedCacheKey: '',
      resolvedItems: [],
      etag: ''
    };
  }

  if (st.size !== state.lastSize || st.mtimeMs !== state.lastMtimeMs) {
    const isInitialOrLargeJump = state.lastSize === 0 || (st.size - state.lastSize) > MAX_DELTA_BYTES;
    const startOffset = isInitialOrLargeJump
      ? Math.max(0, st.size - INITIAL_TAIL_BYTES)
      : state.lastSize;

    if (isInitialOrLargeJump) {
      state.carry = '';
      if (state.lastSize === 0) state.rawCandidates = [];
    }

    const readLen = Math.max(0, st.size - startOffset);
    let chunk = readByteRange(logPath, startOffset, readLen);

    if (startOffset > 0 && isInitialOrLargeJump) {
      const nl = chunk.indexOf('\n');
      chunk = nl >= 0 ? chunk.slice(nl + 1) : '';
    }

    const combined = state.carry + chunk;
    const endsWithNewline = combined.endsWith('\n');
    const lines = combined.split('\n');
    state.carry = endsWithNewline ? '' : (lines.pop() || '');

    for (const line of lines) {
      if (!line || !line.includes('"PLANNER_RESPONSE"')) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj?.type !== 'PLANNER_RESPONSE' || typeof obj.content !== 'string' || !obj.content) {
        continue;
      }
      const tokens = extractCandidateTokens(obj.content);
      for (const tok of tokens) {
        pushCandidateRecent(state.rawCandidates, tok);
      }
    }

    state.lastSize = st.size;
    state.lastMtimeMs = st.mtimeMs;
    state.fileSig = fileSig;
  }

  // Resolve existing files/dirs on disk (newest first, deduped by absPath)
  const resolvedItems = [];
  const seenAbs = new Set();
  for (const rawTok of state.rawCandidates) {
    const resolved = resolveTargetPath(rawTok, roots);
    if (!resolved.ok || !resolved.exists) continue;
    if (resolved.absPath.includes('.system_generated')) continue;
    if (seenAbs.has(resolved.absPath)) continue;
    seenAbs.add(resolved.absPath);
    resolvedItems.push({
      name: resolved.name,
      relPath: resolved.relPath,
      absPath: resolved.absPath,
      fileUri: resolved.fileUri,
      isDirectory: resolved.isDirectory,
      isHtmlFile: Boolean(resolved.isHtmlFile),
      isExternalRoot: resolved.isExternalRoot,
      line: resolved.line
    });
    if (resolvedItems.length >= MAX_MENTIONS_RETURNED) break;
  }

  const etag = createHash('sha1')
    .update(`${fileSig}|${rootsSig}|${resolvedItems.map((i) => i.absPath).join(',')}`)
    .digest('hex')
    .slice(0, 16);

  state.resolvedCacheKey = rootsSig;
  state.resolvedItems = resolvedItems;
  state.etag = etag;
  touchLru(conversationId, state);

  if (clientEtag && clientEtag === etag) {
    return { ok: true, unchanged: true, etag };
  }
  return { ok: true, unchanged: false, etag, items: resolvedItems };
}
