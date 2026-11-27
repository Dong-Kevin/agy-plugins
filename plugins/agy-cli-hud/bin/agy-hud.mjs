#!/usr/bin/env node
/**
 * agy-hud: Zero-dependency, low-latency CLI HUD for agy CLI & Solo.
 *
 * Hot path (`agy-hud statusline`) ONLY loads fs/path/paths/statusline/quota
 * so cold execution stays lightweight and never blocks the TUI prompt.
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensurePrivateDir, formatLocalDateKey, readJsonSafe, resolveHudPaths, writeJsonAtomic } from '../lib/paths.mjs';
import { normalizeAgyQuotaMap, updateWeeklyQuotaLedger } from '../lib/quota.mjs';
import { formatTokensCompact, formatUsdCompact, formatWeeklyUsedPercent, renderStatusLine } from '../lib/statusline.mjs';

const SELF_PATH = fileURLToPath(import.meta.url);
const SYNC_LOCK_STALE_MS = 30_000;
const LIVE_DEDUP_TTL_SEC = 15;

function readStdinBounded(defaultTimeoutMs = 120, maxBytes = 256 * 1024) {
  if (process.stdin.isTTY) return Promise.resolve('');
  const rawEnv = Number(process.env.AGY_HUD_STDIN_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawEnv) && rawEnv > 0
    ? Math.max(20, Math.min(1000, Math.round(rawEnv)))
    : defaultTimeoutMs;
  return new Promise((resolvePromise) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onErr);
      try { process.stdin.pause(); } catch {}
      resolvePromise(Buffer.concat(chunks).toString('utf8'));
    };
    const onData = (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (totalBytes + buf.length > maxBytes) {
        const remain = Math.max(0, maxBytes - totalBytes);
        if (remain > 0) chunks.push(buf.subarray(0, remain));
        finish();
        return;
      }
      chunks.push(buf);
      totalBytes += buf.length;
    };
    const onEnd = () => finish();
    const onErr = () => finish();
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onErr);
    process.stdin.resume();
  });
}

function parseFlagValue(args, name, fallback = null) {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  const prefix = `${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function isSyncLockHeld(lockPath, staleMs = SYNC_LOCK_STALE_MS) {
  const lock = readJsonSafe(lockPath, null);
  if (!lock || typeof lock !== 'object') return false;
  const ageMs = Date.now() - Number(lock.ts || 0);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= staleMs) return false;
  const pid = Number(lock.pid);
  if (pid === process.pid) return false;
  return isPidAlive(pid);
}

function acquireSyncLock(paths) {
  try {
    writeJsonAtomic(paths.syncLockPath, { pid: process.pid, ts: Date.now() }, { mode: 0o600, pretty: false });
  } catch {}
}

function releaseSyncLock(paths) {
  try {
    const lock = readJsonSafe(paths.syncLockPath, null);
    if (lock && Number(lock.pid) === process.pid && existsSync(paths.syncLockPath)) {
      unlinkSync(paths.syncLockPath);
    }
  } catch {}
}

function newestStampAgeMs(paths) {
  const now = Date.now();
  let minAge = Infinity;
  for (const p of [paths.syncStampPath, paths.soloSyncStampPath]) {
    if (!p) continue;
    try {
      if (existsSync(p)) {
        const age = Math.max(0, now - statSync(p).mtimeMs);
        if (age < minAge) minAge = age;
      }
    } catch {}
  }
  return minAge;
}

function maybeSpawnBackgroundSync(paths, syncIntervalMs = 2000) {
  if (process.env.AGY_HUD_NO_BG_SYNC === '1') return;
  try {
    if (isSyncLockHeld(paths.syncLockPath)) return;
    if (newestStampAgeMs(paths) < syncIntervalMs) return;
    ensurePrivateDir(paths.dataDir);
    writeFileSync(paths.syncStampPath, String(Date.now()), { mode: 0o600 });
    const child = spawn(process.execPath, [SELF_PATH, 'sync', '--quiet'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env
    });
    child.unref();
  } catch {}
}

function isLivePayloadEquivalent(prev, next) {
  if (!prev || typeof prev !== 'object') return false;
  const scalarKeys = [
    'conversation_id',
    'agent_state',
    'plan_tier',
    'model_id',
    'model_display',
    'effort',
    'context_used_tokens',
    'context_window_size',
    'context_used_percent',
    'total_input_tokens',
    'total_output_tokens',
    'last_turn_cache_hit_percent',
    'cold_start_alert',
    'session_cost_usd'
  ];
  for (const k of scalarKeys) {
    if (prev[k] !== next[k]) return false;
  }
  return JSON.stringify(prev.raw_quota ?? null) === JSON.stringify(next.raw_quota ?? null);
}

function persistLiveStdinFast(payload, paths, nowMs = Date.now()) {
  if (!payload || typeof payload !== 'object') return;
  try {
    // Only keep lightweight scalar facts, never raw prompts or email
    const cw = payload.context_window && typeof payload.context_window === 'object' ? payload.context_window : null;
    const cu = cw?.current_usage && typeof cw.current_usage === 'object' ? cw.current_usage : null;
    const curIn = Math.max(0, Number(cu?.input_tokens || 0) || 0);
    const curCache = Math.max(0, Number(cu?.cache_read_input_tokens ?? cu?.cache_read_tokens ?? 0) || 0);
    const curCacheW = Math.max(0, Number(cu?.cache_creation_input_tokens ?? cu?.cache_write_tokens ?? 0) || 0);
    const curPrompt = curIn + curCache + curCacheW;
    const windowSize = Number(cw?.context_window_size) > 0 ? Number(cw.context_window_size) : null;
    const usedPct = typeof cw?.used_percentage === 'number' && Number.isFinite(cw.used_percentage)
      ? Number(Math.max(0, Math.min(100, cw.used_percentage)).toFixed(1))
      : (windowSize && curPrompt > 0 ? Number(Math.min(100, (curPrompt / windowSize) * 100).toFixed(1)) : null);
    const contextUsedTokens = curPrompt > 0
      ? curPrompt
      : (usedPct === 0 ? 0 : (windowSize && usedPct !== null ? Math.round((usedPct / 100) * windowSize) : null));
    const model = payload.model && typeof payload.model === 'object' ? payload.model : {};
    const rawSessionCost = payload.cost?.total_cost_usd ?? payload.cost?.total_usd;
    const nowSec = Math.floor(nowMs / 1000);
    const live = {
      observed_at: nowSec,
      observed_at_ms: nowMs,
      has_stdin_payload: true,
      conversation_id: String(payload.conversation_id || payload.session_id || '').trim() || null,
      agent_state: typeof payload.agent_state === 'string' ? payload.agent_state : null,
      plan_tier: typeof payload.plan_tier === 'string' ? payload.plan_tier : null,
      model_id: String(model.id || '').trim() || null,
      model_display: String(model.display_name || '').trim() || null,
      effort: String(model.effort || '').trim() || null,
      context_used_tokens: contextUsedTokens,
      context_window_size: windowSize,
      context_used_percent: usedPct,
      total_input_tokens: cw?.total_input_tokens != null && Number.isFinite(Number(cw.total_input_tokens)) ? Number(cw.total_input_tokens) : null,
      total_output_tokens: cw?.total_output_tokens != null && Number.isFinite(Number(cw.total_output_tokens)) ? Number(cw.total_output_tokens) : null,
      last_turn_cache_hit_percent: curPrompt > 0 ? Number(((curCache / curPrompt) * 100).toFixed(1)) : null,
      cold_start_alert: Boolean(curPrompt >= 8000 && (curCache / curPrompt) * 100 < 25),
      session_cost_usd: typeof rawSessionCost === 'number' && Number.isFinite(rawSessionCost) ? Number(rawSessionCost.toFixed(4)) : null,
      raw_quota: payload.quota && typeof payload.quota === 'object' ? payload.quota : null
    };
    const prev = readJsonSafe(paths.liveSessionPath, null);
    if (
      prev &&
      Number.isFinite(Number(prev.observed_at)) &&
      (nowSec - Number(prev.observed_at)) < LIVE_DEDUP_TTL_SEC &&
      isLivePayloadEquivalent(prev, live)
    ) {
      return;
    }
    writeJsonAtomic(paths.liveSessionPath, live, { mode: 0o600, pretty: false });
  } catch {}
}

async function handleStatuslineFast(args) {
  const paths = resolveHudPaths();
  const raw = (await readStdinBounded()).trim();
  let stdinPayload = null;
  if (raw) {
    try { stdinPayload = JSON.parse(raw); } catch {}
  }

  const nowMs = Date.now();
  const summary = readJsonSafe(paths.summaryPath, null);
  const quotaLedger = readJsonSafe(paths.quotaLedgerPath, null);
  let nextQuotaLedger = quotaLedger;
  let quotaLedgerChanged = false;
  if (stdinPayload?.quota && typeof stdinPayload.quota === 'object') {
    const livePools = normalizeAgyQuotaMap(stdinPayload.quota, { nowMs }).pools;
    if (livePools.length) {
      const updated = updateWeeklyQuotaLedger(quotaLedger, livePools, { nowMs });
      nextQuotaLedger = updated.ledger;
      quotaLedgerChanged = updated.changed;
    }
  }

  const linesArg = parseFlagValue(args, '--lines', null);
  const themeArg = parseFlagValue(args, '--theme', null);
  const noColor = args.includes('--no-color') || process.env.NO_COLOR !== undefined;
  const output = renderStatusLine(stdinPayload, summary, {
    lines: linesArg ? Number(linesArg) : undefined,
    theme: themeArg || undefined,
    color: noColor ? false : undefined,
    nowMs,
    quotaLedger: nextQuotaLedger
  });

  if (output) {
    process.stdout.write(`${output}\n`);
  }

  if (quotaLedgerChanged && nextQuotaLedger) {
    try {
      writeJsonAtomic(paths.quotaLedgerPath, nextQuotaLedger, { mode: 0o600, pretty: false });
    } catch {}
  }
  if (stdinPayload) {
    persistLiveStdinFast(stdinPayload, paths, nowMs);
  }
  const curConvId = stdinPayload && typeof stdinPayload === 'object'
    ? (String(stdinPayload.conversation_id || stdinPayload.session_id || '').trim() || null)
    : undefined;
  const baseIntervalMs = Math.max(1000, Number(summary?.sync_interval_ms) || 2000);
  const summaryAgeSec = summary?.updated_at
    ? Math.max(0, Math.floor(Date.now() / 1000) - Number(summary.updated_at))
    : Infinity;
  const needsQuickBootstrap = Boolean(
    !summary ||
    (stdinPayload && curConvId && summary.session_id !== curConvId && !summary.sessions?.[curConvId] && summaryAgeSec >= 2)
  );
  maybeSpawnBackgroundSync(paths, needsQuickBootstrap ? Math.min(1000, baseIntervalMs) : baseIntervalMs);

  process.stdout.write('', () => process.exit(0));
}

async function runSync(args) {
  const paths = resolveHudPaths();
  const quiet = args.includes('--quiet');
  if (quiet && isSyncLockHeld(paths.syncLockPath)) {
    return;
  }
  acquireSyncLock(paths);
  try {
    const [
      { buildSessionMetricsFromIncremental, runIncrementalSync, saveIncrementalState },
      { enrichSessionsWithSqliteTiming },
      { composeSnapshot, extractLiveStatuslineFacts, loadHudConfig },
      { normalizeAgyQuotaMap }
    ] = await Promise.all([
      import('../lib/incremental.mjs'),
      import('../lib/sqlite_timing.mjs'),
      import('../lib/snapshot.mjs'),
      import('../lib/quota.mjs')
    ]);

    const cfg = loadHudConfig(paths);
    const scopeArg = parseFlagValue(args, '--scope', null);
    const sessionId = parseFlagValue(args, '--session', null);
    const withColab = args.includes('--with-colab') || args.includes('--colab');

    const inc = runIncrementalSync({ scope: scopeArg || cfg.scope, paths });

    let liveFacts = readJsonSafe(paths.liveSessionPath, null);
    if (liveFacts && liveFacts.raw_quota && !liveFacts.quotas) {
      liveFacts = {
        ...liveFacts,
        quotas: normalizeAgyQuotaMap(liveFacts.raw_quota, { source: 'agy_statusline', stale: false })
      };
    }
    const stdinRaw = args.includes('--from-stdin') ? (await readStdinBounded(500)).trim() : '';
    if (stdinRaw) {
      try {
        const parsed = JSON.parse(stdinRaw);
        liveFacts = extractLiveStatuslineFacts(parsed);
        writeJsonAtomic(paths.liveSessionPath, liveFacts, { mode: 0o600, pretty: false });
      } catch {}
    }

    const sqliteRes = await enrichSessionsWithSqliteTiming({
      incrementalResult: inc,
      paths,
      explicitSessionId: sessionId || liveFacts?.conversation_id || null
    });
    if (sqliteRes.changed && inc.state) {
      saveIncrementalState(inc.state, paths);
    }

    let colabSummary = null;
    if (withColab) {
      try {
        const { refreshColabStatus } = await import('../lib/colab.mjs');
        colabSummary = await refreshColabStatus({ paths, force: args.includes('--force-colab') });
      } catch {}
    }

    const { snapshot } = composeSnapshot({
      incrementalResult: inc,
      buildSessionFn: buildSessionMetricsFromIncremental,
      liveFacts,
      colabSummary,
      config: cfg,
      paths,
      sessionId
    });

    try {
      ensurePrivateDir(paths.dataDir);
      writeFileSync(paths.syncStampPath, String(Date.now()), { mode: 0o600 });
    } catch {}

    if (!quiet) {
      process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    }
  } finally {
    releaseSyncLock(paths);
  }
}

function formatReadableStatus(snap) {
  const s = snap.active_session || {};
  const today = snap.rollups?.today || {};
  const month = snap.rollups?.month || {};
  const sub = snap.rollups?.subscription || {};
  const pools = snap.quotas?.pools || [];
  const colab = snap.colab || {};
  const lines = [];

  const speedPart = s.output_tps != null
    ? ` | 速度 ${s.output_tps} t/s${s.ttft_ms != null ? ` (TTFT ${(s.ttft_ms / 1000).toFixed(1)}s)` : ''}`
    : '';
  lines.push(`=== AGY CLI HUD (${snap.rollups?.scope === 'all' ? 'CLI + Desktop' : '仅 CLI'}) ===`);
  lines.push(
    `当前会话: ${s.model_display || '--'}${s.effort ? ` (${s.effort})` : ''} | 上下文 ${s.context_used_percent ?? '--'}% (${formatTokensCompact(s.context_used_tokens)}/${formatTokensCompact(s.context_window_size)}) | 平均缓存 ${s.session_avg_cache_hit_percent ?? '--'}%${speedPart} | 折算 ${formatUsdCompact(s.session_cost_usd)}`
  );
  lines.push(
    `今日用量: ${formatTokensCompact(today.tokens)} tokens (${today.sessions || 0} 会话, 缓存 ${today.cache_hit_percent ?? '--'}%, API 等值 ${formatUsdCompact(today.api_cost_usd)}, 省 ${formatUsdCompact(today.cache_saved_usd)})`
  );
  lines.push(
    `本月用量: ${formatTokensCompact(month.tokens)} tokens (${month.active_days || 0} 活跃天, API 等值 ${formatUsdCompact(month.api_cost_usd)}, 省 ${formatUsdCompact(month.cache_saved_usd)}${sub.leverage_x ? `, 回本 ${sub.leverage_x}×` : ''})`
  );
  if (pools.length) {
    for (const p of pools) {
      let weeklyTodayPart = '';
      if (p.weekly_used_today_percent != null) {
        const usedStr = formatWeeklyUsedPercent(p.weekly_used_today_percent) || `${p.weekly_used_today_percent}%`;
        const resetCount = Number(p.weekly_reset_count_today) || 0;
        const preUsed = Number(p.weekly_pre_reset_used_percent) || 0;
        const postUsed = p.weekly_post_reset_used_percent != null
          ? Number(p.weekly_post_reset_used_percent)
          : Math.max(0, Number(p.weekly_used_today_percent) - preUsed);
        let resetNote = '';
        if (resetCount > 0 && preUsed > 0) {
          resetNote = `（今日已重置：重置前 ${formatWeeklyUsedPercent(preUsed)} + 重置后 ${formatWeeklyUsedPercent(postUsed)}）`;
        } else if (resetCount > 0) {
          resetNote = '（今日已重置）';
        }
        weeklyTodayPart = ` | 今日周耗 ${usedStr}${resetNote}`;
      }
      lines.push(
        `额度 [${p.label}]: 5h 剩余 ${p.five_hour_remaining_percent ?? '--'}% | 周 剩余 ${p.weekly_remaining_percent ?? '--'}%${weeklyTodayPart}`
      );
    }
  } else {
    lines.push('额度: 暂无实时配额缓存（将在下次 agy 对话回调时自动同步）');
  }
  if (colab.connected) {
    lines.push(
      `Colab [${colab.tier || 'ON'}]: 剩余 ${colab.cu_balance ?? '--'} CU | 速率 ${colab.cu_rate_hourly ?? '--'} CU/h | 活跃实例 ${(colab.runtimes || []).length} 台`
    );
    for (const rt of colab.runtimes || []) {
      lines.push(
        `  - ${rt.accelerator} (${rt.shape}${rt.region ? `, ${rt.region}` : ''}) RAM ${rt.ram_used_gb ?? '--'}/${rt.ram_total_gb ?? '--'}G | VRAM ${rt.vram_used_gb ?? '--'}/${rt.vram_total_gb ?? '--'}G | GPU ${rt.gpu_util_percent ?? '--'}% | 闲置剩 ${rt.idle_remaining_minutes ?? '--'}m`
      );
    }
  } else {
    lines.push('Colab: 未连接（可运行 agy-hud colab import-secret <client_secret.json> && agy-hud colab login）');
  }
  return lines.join('\n');
}

async function runWatch(args) {
  const intervalMs = Math.max(500, Number(parseFlagValue(args, '--interval', '1500')) || 1500);
  const paths = resolveHudPaths();
  const renderOnce = async () => {
    await runSync(['--quiet']);
    const snap = readJsonSafe(paths.snapshotPath, null);
    if (!snap) return;
    process.stdout.write('\x1b[2J\x1b[H');
    process.stdout.write(`${formatReadableStatus(snap)}\n`);
    process.stdout.write(`\n[每 ${(intervalMs / 1000).toFixed(1)}s 增量刷新 · Ctrl+C 退出 · 在 Solo 内可按 ⌘U 打开原生右侧抽屉]\n`);
  };
  await renderOnce();
  const timer = setInterval(() => { renderOnce().catch(() => {}); }, intervalMs);
  process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
  process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
}

async function runColabCommand(args) {
  const sub = args[0] || 'status';
  const paths = resolveHudPaths();
  const colab = await import('../lib/colab.mjs');
  const asJson = args.includes('--json');

  if (sub === 'import-secret') {
    const file = args[1];
    if (!file) throw new Error('用法：agy-hud colab import-secret <path/to/client_secret.json>');
    const saved = colab.importClientSecretFile(file, paths);
    const out = { ok: true, configured: Boolean(saved.client_id), quota_project_id: saved.quota_project_id || null };
    console.log(asJson ? JSON.stringify(out) : '[agy-hud] 已安全导入 Google OAuth Client 配置（mode 0600）。下一步运行：agy-hud colab login');
    return;
  }
  if (sub === 'login') {
    await colab.runColabOAuthLogin({ paths, openBrowser: !args.includes('--no-browser') });
    const status = await colab.refreshColabStatus({ paths, force: true });
    console.log(asJson ? JSON.stringify(status, null, 2) : `[agy-hud] Google Colab 登录成功（${status.tier || '已连接'}，剩余 ${status.cu_balance ?? '--'} CU）。`);
    return;
  }
  if (sub === 'logout') {
    colab.clearColabToken(paths);
    console.log(asJson ? JSON.stringify({ ok: true, connected: false }) : '[agy-hud] 已清除本地 Google Colab 登录凭证。');
    return;
  }
  if (sub === 'status') {
    const status = await colab.refreshColabStatus({ paths, force: args.includes('--force') || args.includes('--refresh') });
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  if (sub === 'keepalive') {
    const id = args[1] && !args[1].startsWith('--') ? args[1] : null;
    const status = await colab.keepAliveColabRuntime(id, { paths });
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  if (sub === 'release') {
    const id = args[1];
    const status = await colab.releaseColabRuntime(id, { paths });
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  if (sub === 'snipe') {
    if (args.includes('--stop') || args[1] === 'stop') {
      const st = colab.stopColabSniper(paths);
      console.log(JSON.stringify(st, null, 2));
      return;
    }
    const gpu = (args[1] && !args[1].startsWith('--')) ? args[1] : (parseFlagValue(args, '--gpu', 'T4') || 'T4');
    const shape = parseFlagValue(args, '--shape', 'STANDARD') || 'STANDARD';
    const intervalSec = Math.max(15, Number(parseFlagValue(args, '--interval', '30')) || 30);
    if (args.includes('--once')) {
      const op = await colab.tryAcquireColabRuntimeOnce({ accelerator: gpu, shape, paths });
      console.log(JSON.stringify({ ok: true, operation: op }, null, 2));
      return;
    }
    // Start a detached low-frequency sniper worker
    if (args.includes('--worker')) {
      let attempts = 0;
      while (true) {
        attempts += 1;
        writeJsonAtomic(paths.colabSniperPath, {
          active: true,
          pid: process.pid,
          target_accelerator: gpu.toUpperCase(),
          interval_sec: intervalSec,
          attempts,
          status_text: `第 ${attempts} 次尝试申请 ${gpu.toUpperCase()}...`,
          updated_at: Math.floor(Date.now() / 1000)
        }, { mode: 0o600, pretty: false });
        try {
          const op = await colab.tryAcquireColabRuntimeOnce({ accelerator: gpu, shape, paths });
          if (op && !op.error) {
            writeJsonAtomic(paths.colabSniperPath, {
              active: false,
              pid: null,
              target_accelerator: gpu.toUpperCase(),
              interval_sec: intervalSec,
              attempts,
              status_text: `已提交 ${gpu.toUpperCase()} 分配请求`,
              updated_at: Math.floor(Date.now() / 1000)
            }, { mode: 0o600, pretty: false });
            await colab.refreshColabStatus({ paths, force: true }).catch(() => {});
            process.exit(0);
          }
        } catch (err) {
          writeJsonAtomic(paths.colabSniperPath, {
            active: true,
            pid: process.pid,
            target_accelerator: gpu.toUpperCase(),
            interval_sec: intervalSec,
            attempts,
            status_text: `第 ${attempts} 次暂未分配，${intervalSec}s 后重试`,
            last_error: String(err.message || err),
            updated_at: Math.floor(Date.now() / 1000)
          }, { mode: 0o600, pretty: false });
        }
        await new Promise((r) => setTimeout(r, intervalSec * 1000));
      }
    }
    colab.stopColabSniper(paths);
    const child = spawn(process.execPath, [SELF_PATH, 'colab', 'snipe', gpu, '--shape', shape, '--interval', String(intervalSec), '--worker'], {
      detached: true,
      stdio: 'ignore',
      env: process.env
    });
    child.unref();
    const st = {
      active: true,
      pid: child.pid,
      target_accelerator: gpu.toUpperCase(),
      interval_sec: intervalSec,
      attempts: 0,
      status_text: `排队中 (${gpu.toUpperCase()} · ${intervalSec}s)`
    };
    writeJsonAtomic(paths.colabSniperPath, st, { mode: 0o600, pretty: false });
    console.log(JSON.stringify(st, null, 2));
    return;
  }
  throw new Error(`未知 colab 子命令：${sub}`);
}

async function runConfigCommand(args) {
  const paths = resolveHudPaths();
  const [{ loadHudConfig, saveHudConfig }, { isValidTheme, normalizeThemeName, THEME_NAMES }] = await Promise.all([
    import('../lib/snapshot.mjs'),
    import('../lib/themes.mjs')
  ]);
  const sub = args[0] || 'show';
  if (sub === 'show') {
    console.log(JSON.stringify(loadHudConfig(paths), null, 2));
    return;
  }
  if (sub === 'set') {
    const key = args[1];
    const val = args[2];
    if (!key || val === undefined) {
      throw new Error('用法：agy-hud config set <lines|scope|color|theme|plan_tier|monthly_paid_usd> <value>');
    }
    const patch = {};
    if (key === 'lines') patch.lines = Number(val);
    else if (key === 'color') patch.color = val === 'true' || val === '1';
    else if (key === 'theme') {
      if (!isValidTheme(val)) {
        throw new Error(`未知主题：${val}（可选：${THEME_NAMES.join(', ')}）`);
      }
      patch.theme = normalizeThemeName(val);
    }
    else if (key === 'monthly_paid_usd') patch.monthly_paid_usd = val === 'null' || val === 'auto' ? null : Number(val);
    else patch[key] = val;
    const saved = saveHudConfig(patch, paths);
    await runSync(['--quiet']);
    console.log(JSON.stringify(saved, null, 2));
    return;
  }
  throw new Error(`未知 config 子命令：${sub}`);
}

function buildThemeSample(themeName, { color = true, colorDepth = null, lines = 2 } = {}) {
  const nowSec = 1764150000;
  const samplePayload = {
    conversation_id: 'sample',
    terminal_width: 120,
    context_window: {
      context_window_size: 1_000_000,
      used_percentage: 42,
      current_usage: { input_tokens: 25200, cache_read_input_tokens: 394800, cache_creation_input_tokens: 0 }
    },
    cost: { total_usd: 1.24 },
    quota: {
      'gemini-5h': { remaining_fraction: 0.78, resets_at: nowSec + 8040 },
      'gemini-weekly': { remaining_fraction: 0.64, resets_at: nowSec + 280000 },
      '3p-5h': { remaining_fraction: 0.92, resets_at: nowSec + 17460 },
      '3p-weekly': { remaining_fraction: 0.88, resets_at: nowSec + 471600 }
    }
  };
  const sampleSummary = {
    lines,
    color,
    theme: themeName,
    quota_day: formatLocalDateKey(nowSec * 1000),
    session_id: 'sample',
    avg_cache: 86,
    last_cache: 94,
    tps: 58,
    sess_cost: 1.24,
    sess_saved: 4.8,
    today_tokens: 2_420_000,
    today_cost: 6.8,
    month_tokens: 68_500_000,
    month_cost: 192.4,
    pools: [
      { id: 'gemini', weekly_remaining_percent: 64, weekly_resets_at: nowSec + 280000, weekly_used_today_percent: 14, weekly_reset_count_today: 0, weekly_pre_reset_used_percent: 0 },
      { id: 'non_gemini', weekly_remaining_percent: 88, weekly_resets_at: nowSec + 471600, weekly_used_today_percent: 3, weekly_reset_count_today: 0, weekly_pre_reset_used_percent: 0 }
    ],
    colab: { tier: 'PRO+', cu: 84.2, rate: 13.1, hrs: 6.4, rt: { gpu: 'A100', ram_u: 14, ram_t: 83, vram_u: 22, vram_t: 40, idle_m: 72 } }
  };
  return renderStatusLine(samplePayload, sampleSummary, {
    lines,
    color,
    colorDepth: colorDepth || undefined,
    theme: themeName,
    nowSec
  });
}

async function runThemeCommand(args) {
  const paths = resolveHudPaths();
  const [{ loadHudConfig, saveHudConfig }, themes] = await Promise.all([
    import('../lib/snapshot.mjs'),
    import('../lib/themes.mjs')
  ]);
  const sub = args[0] && !args[0].startsWith('--') ? args[0] : 'show';
  const asJson = args.includes('--json');
  const noColor = args.includes('--no-color') || process.env.NO_COLOR !== undefined;
  const depth = themes.detectColorDepth(!noColor);
  const cfg = loadHudConfig(paths);
  const envTheme = themes.isValidTheme(process.env.AGY_HUD_THEME) ? themes.normalizeThemeName(process.env.AGY_HUD_THEME) : null;
  const active = envTheme || cfg.theme || themes.DEFAULT_THEME;
  const source = envTheme ? 'AGY_HUD_THEME' : (existsSync(paths.configPath) ? 'config' : 'default');

  if (sub === 'show') {
    if (asJson) {
      console.log(JSON.stringify({ theme: active, source, available: themes.THEME_NAMES }, null, 2));
      return;
    }
    const spec = themes.getThemeSpec(active);
    console.log(`当前主题: ${active} (${spec.note}) [来源: ${source}]`);
    console.log(`色板:     ${themes.formatThemeSwatches(active, depth)}`);
    console.log('');
    console.log(buildThemeSample(active, { color: !noColor, lines: cfg.lines }));
    return;
  }

  if (sub === 'list') {
    if (asJson) {
      console.log(JSON.stringify({
        active,
        source,
        themes: themes.THEME_NAMES.map((name) => ({
          name,
          is_light: themes.THEMES[name].isLight,
          note: themes.THEMES[name].note,
          base: themes.THEMES[name].base
        }))
      }, null, 2));
      return;
    }
    for (const name of themes.THEME_NAMES) {
      const mark = name === active ? '›' : ' ';
      const pad = name.padEnd(10, ' ');
      const swatches = themes.formatThemeSwatches(name, depth);
      console.log(`${mark} ${pad} ${swatches}  ${themes.THEMES[name].note}`);
    }
    return;
  }

  if (sub === 'preview') {
    const target = args[1] && !args[1].startsWith('--') ? args[1] : null;
    if (target && !themes.isValidTheme(target)) {
      throw new Error(`未知主题：${target}（可选：${themes.THEME_NAMES.join(', ')}）`);
    }
    const list = target ? [themes.normalizeThemeName(target)] : themes.THEME_NAMES;
    for (let i = 0; i < list.length; i += 1) {
      const name = list[i];
      if (i > 0) console.log('');
      console.log(`[${name}] ${themes.THEMES[name].note}  ${themes.formatThemeSwatches(name, depth)}`);
      console.log(buildThemeSample(name, { color: !noColor, lines: cfg.lines }));
    }
    return;
  }

  if (sub === 'set') {
    const target = args[1];
    if (!target || !themes.isValidTheme(target)) {
      throw new Error(`用法：agy-hud theme set <${themes.THEME_NAMES.join('|')}>`);
    }
    const normalized = themes.normalizeThemeName(target);
    const saved = saveHudConfig({ theme: normalized }, paths);
    await runSync(['--quiet']);
    if (asJson) {
      console.log(JSON.stringify({ ok: true, theme: saved.theme }, null, 2));
      return;
    }
    console.log(`[agy-hud] 已切换主题为 ${saved.theme}（${themes.THEMES[saved.theme].note}）。`);
    console.log(buildThemeSample(saved.theme, { color: !noColor, lines: saved.lines }));
    return;
  }

  throw new Error(`未知 theme 子命令：${sub}（支持：show | list | preview [name] | set <name>）`);
}

async function runInstallStatusline(args) {
  const paths = resolveHudPaths();
  const { configureAgyStatusLine } = await import('../lib/statusline.mjs');
  const { saveHudConfig } = await import('../lib/snapshot.mjs');
  const uninstall = args.includes('--uninstall');
  const linesArg = parseFlagValue(args, '--lines', null);
  if (!uninstall && linesArg && [1, 2, 3].includes(Number(linesArg))) {
    saveHudConfig({ lines: Number(linesArg) }, paths);
  }
  const hudCmd = parseFlagValue(args, '--command', 'agy-hud render');
  const res = configureAgyStatusLine({
    hudCommand: hudCmd,
    uninstall,
    stackWithDefault: !args.includes('--replace-default'),
    soloSync: args.includes('--solo-sync'),
    paths
  });
  if (!uninstall) {
    await runSync(['--quiet']);
  }
  console.log(JSON.stringify(res, null, 2));
}

function printHelp() {
  console.log(`agy-hud — 轻量低延迟 agy CLI & Solo 监控命令行

用法:
  agy-hud render [--lines 1|2|3] [--theme <name>] [--no-color]      读取 agy stdin 输出分层状态栏（默认热路径，兼容 statusline）
  agy-hud statusline [--lines 1|2|3] [--theme <name>] [--no-color]  同 render（向后兼容别名）
  agy-hud sync [--quiet] [--with-colab]            执行 IncrementalJSONL 增量聚合与快照刷新
  agy-hud snapshot [--refresh] [--with-colab]      输出 usage-hud.v1.json 机读快照
  agy-hud status [--json] [--with-colab]           查看当前会话/今日/本月/双池额度/Colab 概览
  agy-hud watch [--interval 1500]                  非 Solo 终端下的轻量实时看板
  agy-hud theme [list|preview [name]|set <name>]   查看、预览或切换配色主题（mocha/latte/frappe/macchiato/nord/dracula）
  agy-hud install-statusline [--lines 2] [--solo-sync] 安全写入 agy settings.json（Solo 下默认异步旁路防强杀）
  agy-hud install-statusline --uninstall           移除 HUD 底栏并完好保留 Solo 桥接
  agy-hud config show | set <key> <value>          配置分层行数（1/2/3）、主题、统计范围、月费折算
  agy-hud colab <import-secret|login|logout|status|keepalive|release|snipe>
`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'status';
  const rest = args.slice(1);

  if (cmd === 'statusline' || cmd === 'render') {
    await handleStatuslineFast(rest);
    return;
  }
  if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
    printHelp();
    return;
  }
  if (cmd === 'sync') {
    await runSync(rest);
    return;
  }
  if (cmd === 'snapshot') {
    const paths = resolveHudPaths();
    if (rest.includes('--refresh') || !existsSync(paths.snapshotPath)) {
      await runSync(['--quiet', ...(rest.includes('--with-colab') || rest.includes('--colab') ? ['--with-colab'] : [])]);
    }
    const snap = readJsonSafe(paths.snapshotPath, null);
    process.stdout.write(`${JSON.stringify(snap || {}, null, 2)}\n`);
    return;
  }
  if (cmd === 'status') {
    const paths = resolveHudPaths();
    await runSync(['--quiet', ...(rest.includes('--with-colab') || rest.includes('--colab') ? ['--with-colab'] : [])]);
    const snap = readJsonSafe(paths.snapshotPath, null);
    if (rest.includes('--json')) {
      console.log(JSON.stringify(snap || {}, null, 2));
    } else {
      console.log(formatReadableStatus(snap || {}));
    }
    return;
  }
  if (cmd === 'watch') {
    await runWatch(rest);
    return;
  }
  if (cmd === 'install-statusline') {
    await runInstallStatusline(rest);
    return;
  }
  if (cmd === 'theme') {
    await runThemeCommand(rest);
    return;
  }
  if (cmd === 'config') {
    await runConfigCommand(rest);
    return;
  }
  if (cmd === 'colab') {
    await runColabCommand(rest);
    return;
  }
  throw new Error(`未知命令：${cmd}（运行 agy-hud --help 查看用法）`);
}

main().catch((err) => {
  process.stderr.write(`[agy-hud] 错误：${err?.message || err}\n`);
  process.exit(1);
});
