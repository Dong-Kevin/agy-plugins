/**
 * Official Antigravity UI Sidecar Backend for AGY Finder (Project File Tree).
 *
 * Uses `sidecar_sdk` (`SidecarApp`, `Response`) when launched by Antigravity,
 * and supports `--standalone` loopback mode on 127.0.0.1 for local testing.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, watchFile } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  controlDrawer,
  getDrawerStatus,
  getShortcutSettings,
  HOTKEY_PRESETS,
  recordActiveContextHint
} from './drawer.mjs';
import { CONV_ID_RE, getConversationMentions } from './mentions.mjs';
import {
  listDirectoryEntries,
  readTextPreview,
  resolveTargetPath,
  revealInOsFileManager,
  searchWorkspaceFiles,
  toFileUri,
  toLocalPath
} from './path_utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..', '..');

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store, must-revalidate' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin'
};

const convWorkspaceCache = new Map();

function getConversationWorkspaceFromHost(convId) {
  if (!convId || !CONV_ID_RE.test(convId)) return '';
  if (convWorkspaceCache.has(convId)) return convWorkspaceCache.get(convId);

  let found = '';
  const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
  if (exe && existsSync(exe)) {
    try {
      const out = execFileSync(exe, ['agentapi', 'get-conversation-metadata', convId], {
        encoding: 'utf8',
        timeout: 1500
      });
      const parsed = JSON.parse(out);
      const uri = parsed?.response?.conversationMetadata?.metadata?.workspaceUris?.[0] || '';
      const local = toLocalPath(uri);
      if (local && existsSync(local)) found = resolve(local);
    } catch {}
  }

  convWorkspaceCache.set(convId, found);
  return found;
}

function resolveActiveRoots(data = {}, getDefaultConvId) {
  const roots = [];
  const seen = new Set();
  const addRoot = (raw) => {
    const local = toLocalPath(raw);
    if (!local) return;
    const abs = resolve(local);
    if (!seen.has(abs) && existsSync(abs)) {
      seen.add(abs);
      roots.push(abs);
    }
  };

  if (typeof data.workspaceUri === 'string' && data.workspaceUri.trim()) {
    for (const part of data.workspaceUri.split(',')) addRoot(part);
  }
  if (typeof data.root === 'string' && data.root.trim()) {
    addRoot(data.root);
  }

  const convId = String(data.conversationId || getDefaultConvId() || '').trim();
  const convRoot = getConversationWorkspaceFromHost(convId);
  if (convRoot) addRoot(convRoot);

  addRoot(process.env.ANTIGRAVITY_WORKSPACE_ROOT);
  addRoot(process.env.WORKSPACE_ROOT);

  if (roots.length === 0) {
    addRoot(process.cwd());
  }
  return roots;
}

function readLocal(filePath) {
  return readFileSync(filePath, 'utf8');
}

function getHostShortcuts() {
  return {
    toggleSidePanel: process.platform === 'darwin' ? '⌘⇧B' : 'Ctrl+Shift+B',
    closeTab: process.platform === 'darwin' ? '⌘W' : 'Ctrl+W',
    reopenTab: process.platform === 'darwin' ? '⌘⇧T' : 'Ctrl+Shift+T'
  };
}

function createHandlers(getDefaultConvId, makeResponse, transformHtml = (html) => html) {
  return {
    indexHtml: () =>
      makeResponse(transformHtml(readLocal(join(__dirname, 'index.html'))), {
        contentType: 'text/html; charset=utf-8',
        headers: NO_CACHE_HEADERS
      }),

    staticAsset: (filePath, contentType) => () =>
      makeResponse(readLocal(filePath), {
        contentType,
        headers: NO_CACHE_HEADERS
      }),

    apiWorkspace: async (data = {}) => {
      const roots = resolveActiveRoots(data, getDefaultConvId);
      const convId = String(data.conversationId || getDefaultConvId() || '').trim();
      recordActiveContextHint({
        conversationId: convId,
        roots,
        primaryRoot: roots[0] || '',
        agentApiExe: process.env.ANTIGRAVITY_AGENTAPI_EXE || ''
      });
      return {
        ok: true,
        platform: process.platform,
        conversationId: convId,
        primaryRoot: roots[0] || '',
        roots: roots.map((r) => ({
          path: r,
          name: basename(r) || r,
          fileUri: toFileUri(r)
        }))
      };
    },

    apiTree: async (data = {}) => {
      const roots = resolveActiveRoots(data, getDefaultConvId);
      const root = data.root ? resolve(toLocalPath(data.root)) : roots[0];
      const showHidden = data.showHidden === '1' || data.showHidden === 'true' || data.showHidden === true;
      return listDirectoryEntries(root, String(data.dir || ''), { showHidden });
    },

    apiResolve: async (data = {}) => {
      const roots = resolveActiveRoots(data, getDefaultConvId);
      const res = resolveTargetPath(String(data.path || ''), roots);
      if (res.ok && res.exists && data.recordReveal === '1') {
        recordActiveContextHint({ lastRevealPath: res.absPath });
      }
      return res;
    },

    apiMentions: async (data = {}) => {
      const roots = resolveActiveRoots(data, getDefaultConvId);
      const convId = String(data.conversationId || getDefaultConvId() || '').trim();
      return getConversationMentions({
        conversationId: convId,
        roots,
        clientEtag: String(data.etag || '')
      });
    },

    apiSearch: async (data = {}) => {
      const roots = resolveActiveRoots(data, getDefaultConvId);
      const root = data.root ? resolve(toLocalPath(data.root)) : roots[0];
      const showHidden = data.showHidden === '1' || data.showHidden === 'true' || data.showHidden === true;
      return searchWorkspaceFiles(root, String(data.q || ''), { showHidden });
    },

    apiPreview: async (data = {}) => {
      const roots = resolveActiveRoots(data, getDefaultConvId);
      return readTextPreview(String(data.path || ''), roots);
    },

    apiRevealOs: async (data = {}) => {
      const roots = resolveActiveRoots(data, getDefaultConvId);
      return revealInOsFileManager(String(data.path || ''), roots);
    },

    apiShortcutGet: async () => ({
      ok: true,
      platform: process.platform,
      settings: getShortcutSettings(),
      presets: HOTKEY_PRESETS,
      drawer: getDrawerStatus(),
      hostShortcuts: getHostShortcuts()
    }),

    apiShortcutPost: async (data = {}) => {
      const action = String(data.action || 'toggle').toLowerCase();
      return controlDrawer({
        action,
        hotkeyPreset: data.hotkeyPreset,
        pinned: data.pinned,
        revealPath: data.revealPath
      });
    }
  };
}

async function startOfficialSidecar() {
  if (process.env.ANTIGRAVITY_SIDECAR_HOT_RELOAD !== '0') {
    let reloadTimer = null;
    for (const f of ['main.mjs', 'path_utils.mjs', 'mentions.mjs', 'drawer.mjs']) {
      watchFile(join(__dirname, f), { interval: 2500 }, (curr, prev) => {
        if (curr.mtimeMs > 0 && curr.mtimeMs !== prev.mtimeMs && !reloadTimer) {
          reloadTimer = setTimeout(() => process.exit(0), 350);
        }
      });
    }
  }

  const { SidecarApp, Response } = await import('sidecar_sdk');
  const app = new SidecarApp();
  const h = createHandlers(
    () => app.config.conversationId || '',
    (body, opts) => new Response(body, opts)
  );

  app.page('/', h.indexHtml);
  app.api('/styles.css', h.staticAsset(join(__dirname, 'styles.css'), 'text/css; charset=utf-8'), 'GET');
  app.api('/app.js', h.staticAsset(join(__dirname, 'app.js'), 'application/javascript; charset=utf-8'), 'GET');
  app.api('/assets/logo.svg', h.staticAsset(join(PLUGIN_ROOT, 'assets', 'logo.svg'), 'image/svg+xml'), 'GET');

  app.api('/api/workspace', h.apiWorkspace, 'GET');
  app.api('/api/tree', h.apiTree, 'GET');
  app.api('/api/resolve', h.apiResolve, 'GET');
  app.api('/api/mentions', h.apiMentions, 'GET');
  app.api('/api/search', h.apiSearch, 'GET');
  app.api('/api/preview', h.apiPreview, 'GET');
  app.api('/api/reveal-os', h.apiRevealOs, 'POST');
  app.api('/api/shortcut', h.apiShortcutGet, 'GET');
  app.api('/api/shortcut', h.apiShortcutPost, 'POST');

  recordActiveContextHint({
    conversationId: app.config.conversationId || '',
    agentApiExe: process.env.ANTIGRAVITY_AGENTAPI_EXE || ''
  });
  if (process.platform === 'darwin' && process.env.AGY_FINDER_DISABLE_DRAWER !== '1') {
    const t = setTimeout(() => {
      controlDrawer({ action: 'ensure-hotkey' }).catch(() => {});
    }, 1000);
    t.unref?.();
  }

  await app.run();
}

function sendJson(res, status, payload, isHead = false) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...NO_CACHE_HEADERS,
    ...SECURITY_HEADERS
  });
  res.end(isHead ? undefined : JSON.stringify(payload));
}

function tokensMatch(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  return ba.length > 0 && ba.length === bb.length && timingSafeEqual(ba, bb);
}

function readJsonBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 65536) {
        const err = new Error('Payload too large');
        err.status = 413;
        rejectPromise(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(raw));
      } catch {
        const err = new Error('Invalid JSON body');
        err.status = 400;
        rejectPromise(err);
      }
    });
    req.on('error', rejectPromise);
  });
}

async function startStandaloneServer() {
  const portIdx = process.argv.indexOf('--port');
  const port = portIdx >= 0 ? Number(process.argv[portIdx + 1] ?? 18980) : 18980;
  const sessionToken = randomBytes(24).toString('hex');

  const injectTokenMeta = (html) => {
    const tag = `  <meta name="af-csrf-token" content="${sessionToken}">\n`;
    return html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : `${tag}${html}`;
  };

  const h = createHandlers(
    () => process.env.ANTIGRAVITY_CONVERSATION_ID || '',
    (body, opts) => ({ __rawResponse: true, body, ...opts }),
    injectTokenMeta
  );

  const routes = new Map([
    ['GET:/', async () => h.indexHtml()],
    ['GET:/preload.js', async () => ({
      __rawResponse: true,
      body: 'window.sidecar = window.sidecar || { conversationId: new URLSearchParams(location.search).get("conversationId") || "", getWorkspaceUris: async () => [], onWorkspaceChange: () => () => {} };',
      contentType: 'application/javascript; charset=utf-8',
      headers: NO_CACHE_HEADERS
    })],
    ['GET:/styles.css', async () => h.staticAsset(join(__dirname, 'styles.css'), 'text/css; charset=utf-8')()],
    ['GET:/app.js', async () => h.staticAsset(join(__dirname, 'app.js'), 'application/javascript; charset=utf-8')()],
    ['GET:/assets/logo.svg', async () => h.staticAsset(join(PLUGIN_ROOT, 'assets', 'logo.svg'), 'image/svg+xml')()],
    ['GET:/api/workspace', h.apiWorkspace],
    ['GET:/api/tree', h.apiTree],
    ['GET:/api/resolve', h.apiResolve],
    ['GET:/api/mentions', h.apiMentions],
    ['GET:/api/search', h.apiSearch],
    ['GET:/api/preview', h.apiPreview],
    ['POST:/api/reveal-os', h.apiRevealOs],
    ['GET:/api/shortcut', h.apiShortcutGet],
    ['POST:/api/shortcut', h.apiShortcutPost]
  ]);

  const server = createServer(async (req, res) => {
    const isHead = req.method === 'HEAD';
    try {
      const actualPort = server.address()?.port || port;
      const allowedHosts = new Set([
        `127.0.0.1:${actualPort}`,
        `localhost:${actualPort}`,
        `[::1]:${actualPort}`
      ]);
      const reqHost = String(req.headers.host || '').trim().toLowerCase();
      if (!reqHost || !allowedHosts.has(reqHost)) {
        return sendJson(res, 403, { ok: false, error: 'Forbidden host' }, isHead);
      }

      const url = new URL(req.url || '/', `http://127.0.0.1:${actualPort}`);
      const lookupMethod = isHead ? 'GET' : req.method;
      const handler = routes.get(`${lookupMethod}:${url.pathname}`);
      if (!handler) {
        return sendJson(res, 404, { ok: false, error: 'Not found' }, isHead);
      }

      const data = Object.fromEntries(url.searchParams.entries());
      if (req.method === 'POST') {
        const provided = req.headers['x-af-token'];
        if (!tokensMatch(provided, sessionToken)) {
          return sendJson(res, 403, { ok: false, error: 'Forbidden CSRF token' }, false);
        }
        const ct = String(req.headers['content-type'] || '').toLowerCase();
        if (!ct.includes('application/json')) {
          return sendJson(res, 415, { ok: false, error: 'Expected application/json' }, false);
        }
        Object.assign(data, await readJsonBody(req));
      }

      const out = await handler(data);
      if (out?.__rawResponse) {
        res.writeHead(out.status || 200, {
          'Content-Type': out.contentType || 'text/plain; charset=utf-8',
          ...(out.headers || {}),
          ...SECURITY_HEADERS
        });
        res.end(isHead ? undefined : out.body);
        return;
      }

      sendJson(res, 200, out, isHead);
    } catch (err) {
      const status = Number.isInteger(err?.status) ? err.status : 500;
      sendJson(res, status, { ok: false, error: err?.message || 'Internal server error' }, isHead);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    const actualUrl = `http://127.0.0.1:${server.address().port}`;
    console.log(`AGY_FINDER_URL=${actualUrl}`);
  });
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  if (process.argv.includes('--standalone') || !process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
    startStandaloneServer();
  } else {
    startOfficialSidecar();
  }
}
