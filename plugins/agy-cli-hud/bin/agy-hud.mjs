#!/usr/bin/env node
/**
 * agy-hud: Zero-dependency, low-latency CLI HUD for agy CLI & Solo.
 *
 * Hot path (`agy-hud statusline`) ONLY loads fs/path/paths/statusline/quota
 * so cold execution stays lightweight and never blocks the TUI prompt.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensurePrivateDir, readJsonSafe, resolveHudPaths, writeJsonAtomic } from '../lib/paths.mjs';
import { formatTokensCompact, formatUsdCompact, renderStatusLine } from '../lib/statusline.mjs';

const SELF_PATH = fileURLToPath(import.meta.url);

function readStdinSyncSafe() {
  if (process.stdin.isTTY) return '';
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseFlagValue(args, name, fallback = null) {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  const prefix = `${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function maybeSpawnBackgroundSync(paths, syncIntervalMs = 2000) {
  if (process.env.AGY_HUD_NO_BG_SYNC === '1') return;
  try {
    if (existsSync(paths.syncStampPath)) {
      const ageMs = Date.now() - statSync(paths.syncStampPath).mtimeMs;
      if (ageMs < syncIntervalMs) return;
    }
    ensurePrivateDir(paths.dataDir);
    writeFileSync(paths.syncStampPath, String(Date.now()), { mode: 0o600 });
    const child = spawn(process.execPath, [SELF_PATH, 'sync', '--quiet'], {
      detached: true,
      stdio: 'ignore',
      env: process.env
    });
    child.unref();
  } catch {}
}

function persistLiveStdinFast(payload, paths) {
  if (!payload || typeof payload !== 'object') return;
  try {
    // Only keep lightweight scalar facts, never raw prompts or email
    const cw = payload.context_window && typeof payload.context_window === 'object' ? payload.context_window : null;
    const cu = cw?.current_usage && typeof cw.current_usage === 'object' ? cw.current_usage : null;
    const curIn = Math.max(0, Number(cu?.input_tokens || 0) || 0);
    const curCache = Math.max(0, Number(cu?.cache_read_input_tokens || 0) || 0);
    const curCacheW = Math.max(0, Number(cu?.cache_creation_input_tokens || 0) || 0);
    const curPrompt = curIn + curCache + curCacheW;
    const model = payload.model && typeof payload.model === 'object' ? payload.model : {};
    const live = {
      observed_at: Math.floor(Date.now() / 1000),
      conversation_id: String(payload.conversation_id || payload.session_id || '').trim() || null,
      agent_state: typeof payload.agent_state === 'string' ? payload.agent_state : null,
      plan_tier: typeof payload.plan_tier === 'string' ? payload.plan_tier : null,
      model_id: String(model.id || '').trim() || null,
      model_display: String(model.display_name || '').trim() || null,
      effort: String(model.effort || '').trim() || null,
      context_used_tokens: curPrompt > 0 ? curPrompt : null,
      context_window_size: Number(cw?.context_window_size) > 0 ? Number(cw.context_window_size) : null,
      context_used_percent: typeof cw?.used_percentage === 'number' ? Number(cw.used_percentage.toFixed(1)) : null,
      total_input_tokens: Number.isFinite(Number(cw?.total_input_tokens)) ? Number(cw.total_input_tokens) : null,
      total_output_tokens: Number.isFinite(Number(cw?.total_output_tokens)) ? Number(cw.total_output_tokens) : null,
      last_turn_cache_hit_percent: curPrompt > 0 ? Number(((curCache / curPrompt) * 100).toFixed(1)) : null,
      cold_start_alert: Boolean(curPrompt >= 8000 && (curCache / curPrompt) * 100 < 25),
      session_cost_usd: typeof payload.cost?.total_usd === 'number' ? Number(payload.cost.total_usd.toFixed(4)) : null,
      raw_quota: payload.quota && typeof payload.quota === 'object' ? payload.quota : null
    };
    writeJsonAtomic(paths.liveSessionPath, live, { mode: 0o600, pretty: false });
  } catch {}
}

function handleStatuslineFast(args) {
  const paths = resolveHudPaths();
  const raw = readStdinSyncSafe().trim();
  let stdinPayload = null;
  if (raw) {
    try { stdinPayload = JSON.parse(raw); } catch {}
  }

  const summary = readJsonSafe(paths.summaryPath, null);
  const linesArg = parseFlagValue(args, '--lines', null);
  const noColor = args.includes('--no-color') || process.env.NO_COLOR !== undefined;
  const output = renderStatusLine(stdinPayload, summary, {
    lines: linesArg ? Number(linesArg) : undefined,
    color: noColor ? false : undefined
  });

  if (output) {
    process.stdout.write(`${output}\n`);
  }

  if (stdinPayload) {
    persistLiveStdinFast(stdinPayload, paths);
  }
  maybeSpawnBackgroundSync(paths, Number(summary?.sync_interval_ms) || 2000);
}

async function runSync(args) {
  const paths = resolveHudPaths();
  const [{ buildSessionMetricsFromIncremental, runIncrementalSync }, { composeSnapshot, extractLiveStatuslineFacts, loadHudConfig }, { normalizeAgyQuotaMap }] = await Promise.all([
    import('../lib/incremental.mjs'),
    import('../lib/snapshot.mjs'),
    import('../lib/quota.mjs')
  ]);

  const cfg = loadHudConfig(paths);
  const scopeArg = parseFlagValue(args, '--scope', null);
  const sessionId = parseFlagValue(args, '--session', null);
  const withColab = args.includes('--with-colab');
  const quiet = args.includes('--quiet');

  const inc = runIncrementalSync({ scope: scopeArg || cfg.scope, paths });

  let liveFacts = readJsonSafe(paths.liveSessionPath, null);
  if (liveFacts && liveFacts.raw_quota && !liveFacts.quotas) {
    liveFacts = {
      ...liveFacts,
      quotas: normalizeAgyQuotaMap(liveFacts.raw_quota, { source: 'agy_statusline', stale: false })
    };
  }
  const stdinRaw = args.includes('--from-stdin') ? readStdinSyncSafe().trim() : '';
  if (stdinRaw) {
    try {
      const parsed = JSON.parse(stdinRaw);
      liveFacts = extractLiveStatuslineFacts(parsed);
      writeJsonAtomic(paths.liveSessionPath, liveFacts, { mode: 0o600, pretty: false });
    } catch {}
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

  if (!quiet) {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
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

  lines.push(`=== AGY CLI HUD (${snap.rollups?.scope === 'all' ? 'CLI + Desktop' : '仅 CLI'}) ===`);
  lines.push(
    `当前会话: ${s.model_display || '--'}${s.effort ? ` (${s.effort})` : ''} | 上下文 ${s.context_used_percent ?? '--'}% (${formatTokensCompact(s.context_used_tokens)}/${formatTokensCompact(s.context_window_size)}) | 平均缓存 ${s.session_avg_cache_hit_percent ?? '--'}% | 折算 ${formatUsdCompact(s.session_cost_usd)}`
  );
  lines.push(
    `今日用量: ${formatTokensCompact(today.tokens)} tokens (${today.sessions || 0} 会话, 缓存 ${today.cache_hit_percent ?? '--'}%, API 等值 ${formatUsdCompact(today.api_cost_usd)}, 省 ${formatUsdCompact(today.cache_saved_usd)})`
  );
  lines.push(
    `本月用量: ${formatTokensCompact(month.tokens)} tokens (${month.active_days || 0} 活跃天, API 等值 ${formatUsdCompact(month.api_cost_usd)}, 省 ${formatUsdCompact(month.cache_saved_usd)}${sub.leverage_x ? `, 回本 ${sub.leverage_x}×` : ''})`
  );
  if (pools.length) {
    for (const p of pools) {
      lines.push(
        `额度 [${p.label}]: 5h 剩余 ${p.five_hour_remaining_percent ?? '--'}% | 周 剩余 ${p.weekly_remaining_percent ?? '--'}%`
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
    const status = await colab.refreshColabStatus({ paths, force: args.includes('--force') });
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
  const { loadHudConfig, saveHudConfig } = await import('../lib/snapshot.mjs');
  const sub = args[0] || 'show';
  if (sub === 'show') {
    console.log(JSON.stringify(loadHudConfig(paths), null, 2));
    return;
  }
  if (sub === 'set') {
    const key = args[1];
    const val = args[2];
    if (!key || val === undefined) throw new Error('用法：agy-hud config set <lines|scope|color|plan_tier|monthly_paid_usd> <value>');
    const patch = {};
    if (key === 'lines') patch.lines = Number(val);
    else if (key === 'color') patch.color = val === 'true' || val === '1';
    else if (key === 'monthly_paid_usd') patch.monthly_paid_usd = val === 'null' || val === 'auto' ? null : Number(val);
    else patch[key] = val;
    const saved = saveHudConfig(patch, paths);
    await runSync(['--quiet']);
    console.log(JSON.stringify(saved, null, 2));
    return;
  }
  throw new Error(`未知 config 子命令：${sub}`);
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
  const hudCmd = parseFlagValue(args, '--command', 'agy-hud statusline');
  const res = configureAgyStatusLine({
    hudCommand: hudCmd,
    uninstall,
    stackWithDefault: !args.includes('--replace-default'),
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
  agy-hud statusline [--lines 1|2|3] [--no-color]  读取 agy stdin 输出分层状态栏（热路径）
  agy-hud sync [--quiet] [--with-colab]            执行 IncrementalJSONL 增量聚合与快照刷新
  agy-hud snapshot [--refresh] [--with-colab]      输出 usage-hud.v1.json 机读快照
  agy-hud status [--json] [--with-colab]           查看当前会话/今日/本月/双池额度/Colab 概览
  agy-hud watch [--interval 1500]                  非 Solo 终端下的轻量实时看板
  agy-hud install-statusline [--lines 2]           安全写入 agy settings.json（自动兼容 Solo 桥接）
  agy-hud install-statusline --uninstall           移除 HUD 底栏并完好保留 Solo 桥接
  agy-hud config show | set <key> <value>          配置分层行数（1/2/3）、统计范围、月费折算
  agy-hud colab <import-secret|login|logout|status|keepalive|release|snipe>
`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'status';
  const rest = args.slice(1);

  if (cmd === 'statusline') {
    handleStatuslineFast(rest);
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
      await runSync(['--quiet', ...(rest.includes('--with-colab') ? ['--with-colab'] : [])]);
    }
    const snap = readJsonSafe(paths.snapshotPath, null);
    process.stdout.write(`${JSON.stringify(snap || {}, null, 2)}\n`);
    return;
  }
  if (cmd === 'status') {
    const paths = resolveHudPaths();
    await runSync(['--quiet', ...(rest.includes('--with-colab') ? ['--with-colab'] : [])]);
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
