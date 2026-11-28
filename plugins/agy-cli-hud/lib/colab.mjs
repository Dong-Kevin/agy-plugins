/**
 * Compliant Google Colab OAuth 2.0 (PKCE) & official REST API client for agy-cli-hud.
 * Strictly zero CDP / DOM injection, zero spoofed client headers, zero auto-keepalive or GPU sniping.
 * Credentials stored with mode 0600 only.
 */

import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { readJsonSafe, resolveHudPaths, writeJsonAtomic } from './paths.mjs';

const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN_URL = process.env.AGY_HUD_OAUTH_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const OAUTH_SCOPE = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/colaboratory'
].join(' ');

function getColabApiBase() {
  return (process.env.AGY_HUD_COLAB_API_BASE || 'https://colaboratory.googleapis.com').replace(/\/$/, '');
}

function parseClientSecretJson(rawObj) {
  if (!rawObj || typeof rawObj !== 'object') return null;
  const section = rawObj.installed || rawObj.web || rawObj;
  if (!section.client_id) return null;
  return {
    client_id: String(section.client_id || '').trim(),
    client_secret: String(section.client_secret || '').trim(),
    quota_project_id: String(section.project_id || section.quota_project_id || '').trim()
  };
}

export function loadColabConfig(paths = resolveHudPaths()) {
  const saved = readJsonSafe(paths.colabConfigPath, null);
  if (saved && saved.client_id) {
    return {
      client_id: String(saved.client_id || '').trim(),
      client_secret: String(saved.client_secret || '').trim(),
      quota_project_id: String(saved.quota_project_id || '').trim()
    };
  }
  // Read-only fallback to existing agy-colab-panel OAuth client config if present
  const legacyCfg = readJsonSafe(join(paths.legacyColabDataDir, 'config.json'), null);
  if (legacyCfg && legacyCfg.client_id) {
    return {
      client_id: String(legacyCfg.client_id || '').trim(),
      client_secret: String(legacyCfg.client_secret || '').trim(),
      quota_project_id: String(legacyCfg.quota_project_id || '').trim()
    };
  }
  const secretFile = readJsonSafe(join(paths.colabDir, 'client_secret.json'), null);
  const parsed = parseClientSecretJson(secretFile);
  if (parsed) return parsed;
  return { client_id: '', client_secret: '', quota_project_id: '' };
}

export function saveColabConfig(partial, paths = resolveHudPaths()) {
  const cur = loadColabConfig(paths);
  const next = {
    client_id: partial.client_id !== undefined ? String(partial.client_id).trim() : cur.client_id,
    client_secret: partial.client_secret !== undefined ? String(partial.client_secret).trim() : cur.client_secret,
    quota_project_id: partial.quota_project_id !== undefined ? String(partial.quota_project_id).trim() : cur.quota_project_id
  };
  writeJsonAtomic(paths.colabConfigPath, next, { mode: 0o600, pretty: true });
  return next;
}

export function importClientSecretFile(filePath, paths = resolveHudPaths()) {
  const raw = readJsonSafe(filePath, null);
  const parsed = parseClientSecretJson(raw);
  if (!parsed || !parsed.client_id) {
    throw new Error('client_secret.json 无效或缺少 client_id 字段');
  }
  return saveColabConfig(parsed, paths);
}

export function loadColabToken(paths = resolveHudPaths()) {
  const own = readJsonSafe(paths.colabTokenPath, null);
  if (own && own.access_token) return own;
  const legacy = readJsonSafe(join(paths.legacyColabDataDir, 'token.json'), null);
  if (legacy && legacy.access_token) return legacy;
  return null;
}

export function saveColabToken(tokenObj, paths = resolveHudPaths()) {
  writeJsonAtomic(paths.colabTokenPath, tokenObj, { mode: 0o600, pretty: true });
}

export function clearColabToken(paths = resolveHudPaths()) {
  try {
    if (existsSync(paths.colabTokenPath)) unlinkSync(paths.colabTokenPath);
  } catch {}
  try {
    if (existsSync(paths.colabCachePath)) unlinkSync(paths.colabCachePath);
  } catch {}
}

function base64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function openExternalBrowser(url) {
  try {
    if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'win32') {
      const esc = url.replace(/'/g, "''");
      spawn('powershell', ['-NoProfile', '-Command', `Start-Process '${esc}'`], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {}
}

export async function runColabOAuthLogin({ paths = resolveHudPaths(), openBrowser = true, timeoutMs = 180_000 } = {}) {
  const cfg = loadColabConfig(paths);
  if (!cfg.client_id) {
    throw new Error('尚未配置 Google OAuth Client ID。请先运行：agy-hud colab import-secret <client_secret.json>');
  }

  const state = base64Url(crypto.randomBytes(20));
  const codeVerifier = base64Url(crypto.randomBytes(32));
  const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());

  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { server.close(); } catch {}
      if (err) rejectPromise(err);
      else resolvePromise(val);
    };

    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
        if (reqUrl.pathname !== '/callback') {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        const errParam = reqUrl.searchParams.get('error');
        const retState = reqUrl.searchParams.get('state');
        const code = reqUrl.searchParams.get('code');
        if (errParam) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h2>Google Colab 授权已取消</h2><p>可关闭此页面。</p>');
          finish(new Error(`Google 拒绝授权：${errParam}`));
          return;
        }
        if (!code || retState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h2>OAuth state 校验失败</h2>');
          finish(new Error('OAuth 回调 state 校验失败'));
          return;
        }

        const addr = server.address();
        const redirectUri = `http://127.0.0.1:${addr.port}/callback`;
        const form = new URLSearchParams({
          code,
          client_id: cfg.client_id,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: codeVerifier
        });
        if (cfg.client_secret) form.set('client_secret', cfg.client_secret);

        const tokenRes = await fetch(OAUTH_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
          signal: AbortSignal.timeout(15_000)
        });
        const tokenJson = await tokenRes.json().catch(() => ({}));
        if (!tokenRes.ok || !tokenJson.access_token) {
          throw new Error(tokenJson.error_description || tokenJson.error || `HTTP ${tokenRes.status}`);
        }

        const prev = loadColabToken(paths) || {};
        saveColabToken({
          access_token: tokenJson.access_token,
          refresh_token: tokenJson.refresh_token || prev.refresh_token || '',
          token_type: tokenJson.token_type || 'Bearer',
          scope: tokenJson.scope || OAUTH_SCOPE,
          expiry_date: Date.now() + Number(tokenJson.expires_in || 3600) * 1000 - 60_000
        }, paths);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h2>Google Colab 授权成功</h2><p>可关闭此页面返回终端或 Solo。</p>');
        finish(null, { ok: true });
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h2>授权交换失败</h2>');
        finish(err);
      }
    });

    const timer = setTimeout(() => {
      finish(new Error('等待 Google OAuth 授权超时'));
    }, timeoutMs);

    server.on('error', (err) => finish(err));
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const redirectUri = `http://127.0.0.1:${addr.port}/callback`;
      const params = new URLSearchParams({
        client_id: cfg.client_id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: OAUTH_SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
      });
      const authUrl = `${OAUTH_AUTH_URL}?${params.toString()}`;
      process.stderr.write(`[agy-hud] 请在浏览器完成 Google Colab 授权：\n${authUrl}\n`);
      if (openBrowser) openExternalBrowser(authUrl);
    });
  });
}

export async function getValidColabAccessToken(paths = resolveHudPaths(), { fetchImpl = globalThis.fetch } = {}) {
  const token = loadColabToken(paths);
  if (!token || !token.access_token) return null;
  if (token.expiry_date && Date.now() < Number(token.expiry_date)) {
    return token.access_token;
  }
  if (!token.refresh_token) return null;
  const cfg = loadColabConfig(paths);
  if (!cfg.client_id) return null;

  const form = new URLSearchParams({
    client_id: cfg.client_id,
    refresh_token: token.refresh_token,
    grant_type: 'refresh_token'
  });
  if (cfg.client_secret) form.set('client_secret', cfg.client_secret);

  const res = await fetchImpl(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(10_000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) return null;

  const updated = {
    ...token,
    access_token: data.access_token,
    scope: data.scope || token.scope || '',
    expiry_date: Date.now() + Number(data.expires_in || 3600) * 1000 - 60_000
  };
  saveColabToken(updated, paths);
  return updated.access_token;
}

async function colabApiRequest(method, apiPath, { body = null, paths = resolveHudPaths(), fetchImpl = globalThis.fetch } = {}) {
  const accessToken = await getValidColabAccessToken(paths, { fetchImpl });
  if (!accessToken) {
    const err = new Error('尚未登录 Google Colab 或授权已过期');
    err.status = 401;
    throw err;
  }
  const cfg = loadColabConfig(paths);
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  };
  if (cfg.quota_project_id) {
    headers['X-Goog-User-Project'] = cfg.quota_project_id;
  }
  const res = await fetchImpl(`${getColabApiBase()}${apiPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000)
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = json?.error?.message || text || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

function formatTierLabel(sub) {
  const raw = String(sub?.tier || sub?.subscriptionTier || sub?.plan || '').toUpperCase();
  if (raw.includes('PRO_PLUS') || raw.includes('PRO+')) return 'PRO+';
  if (raw.includes('PRO')) return 'PRO';
  if (raw.includes('PAYG') || raw.includes('PAY_AS_YOU_GO')) return 'PAYG';
  if (raw.includes('FREE') || raw.includes('NONE')) return 'FREE';
  return raw ? raw.replace(/^SUBSCRIPTION_TIER_/, '') : null;
}

function formatShapeShort(shape) {
  const raw = String(shape || 'STANDARD').replace(/^SHAPE_/, '').toUpperCase();
  if (raw === 'HIGHMEM') return 'High-RAM';
  if (raw === 'STANDARD') return 'Standard';
  return raw;
}

function parseRegionFromUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const m = rawUrl.match(/\b((?:us|europe|asia|northamerica|southamerica|australia|me)-[a-z]+[0-9]+)\b/i);
  return m ? m[1].toLowerCase() : null;
}

function bytesToGb(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Number((n / (1024 ** 3)).toFixed(1));
}

async function probeRuntimeProxy(rt, { fetchImpl = globalThis.fetch } = {}) {
  const conn = rt?.connectionInfo || {};
  if (!conn.url || !conn.token) return { jupyterStatus: null, resources: null };
  const base = String(conn.url).replace(/\/$/, '');
  const headers = { 'X-Colab-Runtime-Proxy-Token': conn.token };
  const [stRes, resRes] = await Promise.allSettled([
    fetchImpl(`${base}/api/status`, { headers, signal: AbortSignal.timeout(7000) }),
    fetchImpl(`${base}/api/colab/resources`, { headers, signal: AbortSignal.timeout(7000) })
  ]);
  let jupyterStatus = null;
  let resources = null;
  if (stRes.status === 'fulfilled' && stRes.value.ok) {
    jupyterStatus = await stRes.value.json().catch(() => null);
  }
  if (resRes.status === 'fulfilled' && resRes.value.ok) {
    try {
      const txt = await resRes.value.text();
      resources = JSON.parse(txt.replace(/^\)\]\}'\s*/, ''));
    } catch {}
  }
  return { jupyterStatus, resources };
}

function normalizeRuntimeSummary(rt, { jupyterStatus, resources }, nowMs = Date.now()) {
  const spec = rt?.runtimeSpec || {};
  const conn = rt?.connectionInfo || {};
  const name = String(rt?.name || '');
  const id = name.replace(/^runtimes\//, '') || name;
  const rawAccel = String(spec.accelerator || 'NONE').replace(/^ACCELERATOR_TYPE_/, '');
  const accelerator = rawAccel && rawAccel !== 'NONE' ? rawAccel : 'CPU';

  const startedMs = jupyterStatus?.started ? Date.parse(jupyterStatus.started) : NaN;
  const lastActMs = jupyterStatus?.last_activity ? Date.parse(jupyterStatus.last_activity) : NaN;
  const uptimeMinutes = Number.isFinite(startedMs) ? Math.max(0, Math.round((nowMs - startedMs) / 60_000)) : null;
  const idleMs = Number.isFinite(lastActMs) ? Math.max(0, nowMs - lastActMs) : null;
  const idleRemainingMinutes = idleMs !== null ? Math.max(0, Math.round((90 * 60_000 - idleMs) / 60_000)) : null;

  const memTotal = Number(resources?.memory?.totalBytes || 0);
  const memFree = Number(resources?.memory?.freeBytes || 0);
  const memUsed = memTotal > 0 ? Math.max(0, memTotal - memFree) : 0;

  const gpu0 = Array.isArray(resources?.gpus) && resources.gpus.length ? resources.gpus[0] : null;
  const gpuUtilRaw = typeof gpu0?.gpuUtilization === 'number' ? gpu0.gpuUtilization : null;
  const gpuUtilPct = gpuUtilRaw !== null
    ? Math.min(100, Math.round(gpuUtilRaw <= 1 && gpuUtilRaw > 0 ? gpuUtilRaw * 100 : gpuUtilRaw))
    : null;

  return {
    id,
    name,
    accelerator,
    gpu_name: gpu0?.name || accelerator,
    shape: formatShapeShort(spec.shape),
    region: parseRegionFromUrl(conn.url),
    ram_used_gb: bytesToGb(memUsed),
    ram_total_gb: bytesToGb(memTotal),
    vram_used_gb: bytesToGb(gpu0?.memoryUsedBytes),
    vram_total_gb: bytesToGb(gpu0?.memoryTotalBytes),
    gpu_util_percent: gpuUtilPct,
    kernels: Number.isFinite(Number(jupyterStatus?.kernels)) ? Number(jupyterStatus.kernels) : null,
    uptime_minutes: uptimeMinutes,
    idle_remaining_minutes: idleRemainingMinutes
  };
}

export async function refreshColabStatus({ paths = resolveHudPaths(), force = false, fetchImpl = globalThis.fetch } = {}) {
  const cfg = loadColabConfig(paths);
  const configured = Boolean(cfg.client_id);
  const cached = readJsonSafe(paths.colabCachePath, null);

  const accessToken = await getValidColabAccessToken(paths, { fetchImpl });
  if (!accessToken) {
    const empty = {
      connected: false,
      configured,
      tier: null,
      cu_balance: null,
      cu_rate_hourly: null,
      estimated_hours_left: null,
      runtimes: [],
      updated_at: Math.floor(Date.now() / 1000)
    };
    writeJsonAtomic(paths.colabCachePath, empty, { mode: 0o600, pretty: false });
    return empty;
  }

  if (!force && cached && cached.connected && (Math.floor(Date.now() / 1000) - (cached.updated_at || 0)) < 25) {
    return {
      ...cached,
      cu_balance: null,
      cu_rate_hourly: null,
      estimated_hours_left: null
    };
  }

  const [subRes, rtRes] = await Promise.allSettled([
    colabApiRequest('GET', '/v1beta/subscription', { paths, fetchImpl }),
    colabApiRequest('GET', '/v1beta/runtimes', { paths, fetchImpl })
  ]);

  const sub = subRes.status === 'fulfilled' ? subRes.value : {};
  const rawRuntimes = rtRes.status === 'fulfilled' && Array.isArray(rtRes.value?.runtimes)
    ? rtRes.value.runtimes
    : [];

  const enriched = await Promise.all(
    rawRuntimes.map(async (rt) => {
      const probed = await probeRuntimeProxy(rt, { fetchImpl });
      return normalizeRuntimeSummary(rt, probed);
    })
  );

  const summary = {
    connected: true,
    configured,
    tier: formatTierLabel(sub) || cached?.tier || null,
    cu_balance: null,
    cu_rate_hourly: null,
    estimated_hours_left: null,
    runtimes: enriched,
    updated_at: Math.floor(Date.now() / 1000)
  };
  writeJsonAtomic(paths.colabCachePath, summary, { mode: 0o600, pretty: false });
  return summary;
}

export async function releaseColabRuntime(runtimeId, { paths = resolveHudPaths(), fetchImpl = globalThis.fetch } = {}) {
  if (!runtimeId) throw new Error('请指定要释放的 Colab 实例 ID');
  const fullName = runtimeId.startsWith('runtimes/') ? runtimeId : `runtimes/${runtimeId}`;
  await colabApiRequest('DELETE', `/v1beta/${fullName}`, { paths, fetchImpl });
  return await refreshColabStatus({ paths, force: true, fetchImpl });
}

function inspectLegacyWorkerCmdline(pid) {
  if (process.platform === 'win32') return null;
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500
    }).trim();
  } catch {
    return null;
  }
}

function isLegacyColabWorkerCmdline(cmdline) {
  if (!cmdline || typeof cmdline !== 'string') return false;
  return /\bagy-hud\b/.test(cmdline) && /\bcolab\b/.test(cmdline) && /\bsnipe\b/.test(cmdline) && /--worker\b/.test(cmdline);
}

/**
 * Stop-only compatibility cleanup for detached legacy workers started before upgrading.
 * Verifies process command line on POSIX to avoid signalling a reused PID.
 */
export function stopLegacyColabSniper(paths = resolveHudPaths()) {
  const legacyPath = join(paths.colabDir, 'sniper_state.v1.json');
  if (!existsSync(legacyPath)) {
    return {
      ok: true,
      active: false,
      stopped: false,
      removed: false,
      skipped_pid_reuse: false,
      message: '未发现旧版遗留的 Colab 后台抢卡进程。'
    };
  }
  const saved = readJsonSafe(legacyPath, null);
  const pid = Number(saved?.pid);
  let stopped = false;
  let skippedPidReuse = false;
  let alive = false;

  if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (err) {
      alive = err?.code === 'EPERM';
    }
    if (alive) {
      const cmdline = inspectLegacyWorkerCmdline(pid);
      if (cmdline !== null) {
        if (isLegacyColabWorkerCmdline(cmdline)) {
          try {
            process.kill(pid, 'SIGTERM');
            stopped = true;
          } catch {}
        } else {
          skippedPidReuse = true;
        }
      } else {
        skippedPidReuse = true;
      }
    }
  }

  let removed = false;
  try {
    unlinkSync(legacyPath);
    removed = true;
  } catch {}

  const message = stopped
    ? `已终止升级前遗留的旧版 Colab 后台进程（PID ${pid}）并清理状态文件。`
    : skippedPidReuse
      ? `检测到记录的 PID ${pid} 非旧版 agy-hud worker（疑似 PID 复用或无法校验），已跳过发信号并清理旧状态文件。`
      : '已清理旧版遗留的 Colab 后台状态文件（未发现存活旧进程）。';

  return {
    ok: true,
    active: false,
    pid: stopped ? pid : null,
    stopped,
    removed,
    skipped_pid_reuse: skippedPidReuse,
    message
  };
}
