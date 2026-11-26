#!/usr/bin/env node
/**
 * Self-contained verification suite for plugins/agy-cli-hud.
 * Covers incremental JSONL rollup, step deduplication, dual-pool quotas,
 * 1/2/3-line statusLine rendering, Solo bridge chaining, mock Colab API,
 * compliance (zero CDP), and isolated install/uninstall.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  importClientSecretFile,
  keepAliveColabRuntime,
  refreshColabStatus,
  releaseColabRuntime,
  saveColabToken
} from '../lib/colab.mjs';
import {
  buildSessionMetricsFromIncremental,
  runIncrementalSync
} from '../lib/incremental.mjs';
import { resolveHudPaths } from '../lib/paths.mjs';
import { normalizeAgyQuotaMap } from '../lib/quota.mjs';
import { composeSnapshot } from '../lib/snapshot.mjs';
import { configureAgyStatusLine, renderStatusLine } from '../lib/statusline.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const BIN_PATH = join(PLUGIN_ROOT, 'bin', 'agy-hud.mjs');

function pass(msg) {
  console.log(`[PASS] ${msg}`);
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

function testZeroCdpCompliance() {
  for (const rel of [
    'bin/agy-hud.mjs',
    'lib/paths.mjs',
    'lib/pricing.mjs',
    'lib/quota.mjs',
    'lib/incremental.mjs',
    'lib/colab.mjs',
    'lib/snapshot.mjs',
    'lib/statusline.mjs'
  ]) {
    const src = readFileSync(join(PLUGIN_ROOT, rel), 'utf8');
    assert.ok(!/DevToolsActivePort/i.test(src), `${rel} must never touch DevToolsActivePort / CDP`);
    assert.ok(!/app\.asar/i.test(src), `${rel} must never touch app.asar`);
    assert.ok(!/config\/config\.json/i.test(src), `${rel} must never modify host config.json`);
  }
  pass('Compliance gate: zero CDP, zero host config mutation, zero app.asar access');
}

function testIncrementalJsonlAndRollup() {
  const work = mkdtempSync(join(tmpdir(), 'agy-hud-inc-'));
  const prevHome = process.env.AGY_HUD_HOME;
  process.env.AGY_HUD_HOME = work;
  try {
    const paths = resolveHudPaths();
    const convA = '11111111-2222-3333-4444-555555555555';
    const txDir = join(paths.cliBrainDir, convA, '.system_generated', 'logs');
    mkdirSync(txDir, { recursive: true });
    const txFile = join(txDir, 'transcript.jsonl');

    const now = new Date('2026-11-26T10:10:00Z');
    const lines1 = [
      JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: '2026-11-26T10:00:00Z', content: 'hi' }),
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'RUNNING',
        created_at: '2026-11-26T10:00:05Z',
        model: 'gemini-4-neon-xhigh',
        input_tokens: 10000,
        cache_read_tokens: 40000,
        output_tokens: 500
      }),
      // Same step_index=2 finalized -> must replace, never double count!
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T10:00:10Z',
        model: 'gemini-4-neon-xhigh',
        input_tokens: 10000,
        cache_read_tokens: 90000,
        output_tokens: 1000
      })
    ];
    writeFileSync(txFile, `${lines1.join('\n')}\n`, 'utf8');

    const res1 = runIncrementalSync({ scope: 'cli_only', paths, now });
    assert.equal(res1.changed, true);
    assert.equal(res1.rollups.today.tokens, 101000);
    assert.equal(res1.rollups.today.turns, 1);
    assert.equal(res1.rollups.today.cache_hit_percent, 90.0);
    assert.equal(res1.rollups.today.sessions, 1);
    assert.equal(res1.rollups.month.active_days, 1);
    assert.equal(res1.rollups.month.last_7d_tokens.length, 7);
    assert.equal(res1.rollups.month.last_7d_tokens[6], 101000);

    // Second run with no changes must skip reading
    const resNoop = runIncrementalSync({ scope: 'cli_only', paths, now });
    assert.equal(resNoop.changed, false);

    // Append second turn incrementally
    appendFileSync(
      txFile,
      `${JSON.stringify({
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T10:00:30Z',
        model: 'gemini-4-neon-xhigh',
        input_tokens: 20000,
        cache_read_tokens: 80000,
        output_tokens: 2000
      })}\n`,
      'utf8'
    );
    const res2 = runIncrementalSync({ scope: 'cli_only', paths, now });
    assert.equal(res2.changed, true);
    assert.equal(res2.rollups.today.turns, 2);
    assert.equal(res2.rollups.today.tokens, 203000);
    assert.equal(res2.rollups.today.cache_hit_percent, 85.0);
    assert.ok(res2.rollups.today.api_cost_usd > 0);
    assert.ok(res2.rollups.today.cache_saved_usd > 0);

    const sessMetrics = buildSessionMetricsFromIncremental(res2.sessionsById.get(convA));
    assert.equal(sessMetrics.session_avg_cache_hit_percent, 85.0);
    assert.equal(sessMetrics.last_turn_cache_hit_percent, 80.0);
    assert.equal(sessMetrics.effort, 'xhigh');
    assert.equal(sessMetrics.model_display, 'Gemini 4 Neon');

    pass('IncrementalJSONL byte-cursor, step_index dedup, session avg cache & daily/monthly rollups');
  } finally {
    if (prevHome === undefined) delete process.env.AGY_HUD_HOME;
    else process.env.AGY_HUD_HOME = prevHome;
    rmSync(work, { recursive: true, force: true });
  }
}

function testDualPoolQuotaAndLayeredStatusline() {
  const nowSec = 1764150000;
  const rawQuota = {
    'gemini-5h': { remaining_fraction: 0.78, resets_at: nowSec + 8040 },
    'gemini-weekly': { remaining_fraction: 0.64, resets_at: nowSec + 280000 },
    '3p-5h': { remaining_fraction: 0.92, resets_at: nowSec + 17460 },
    '3p-weekly': { remaining_fraction: 0.88, resets_at: nowSec + 471600 }
  };
  const q = normalizeAgyQuotaMap(rawQuota);
  assert.equal(q.pools.length, 2);
  assert.equal(q.pools[0].id, 'gemini');
  assert.equal(q.pools[0].five_hour_remaining_percent, 78);
  assert.equal(q.pools[0].weekly_remaining_percent, 64);
  assert.equal(q.pools[1].id, 'non_gemini');
  assert.equal(q.pools[1].five_hour_remaining_percent, 92);
  assert.equal(q.pools[1].weekly_remaining_percent, 88);

  const stdinPayload = {
    conversation_id: '11111111-2222-3333-4444-555555555555',
    terminal_width: 120,
    context_window: {
      context_window_size: 1_000_000,
      used_percentage: 42,
      current_usage: { input_tokens: 25200, cache_read_input_tokens: 394800, cache_creation_input_tokens: 0 }
    },
    cost: { total_usd: 1.24 },
    quota: rawQuota
  };
  const summary = {
    lines: 2,
    color: false,
    session_id: '11111111-2222-3333-4444-555555555555',
    avg_cache: 86.4,
    last_cache: 94.0,
    tps: 58.2,
    sess_cost: 1.24,
    sess_saved: 4.8,
    today_tokens: 2_420_000,
    today_cost: 6.8,
    month_tokens: 68_500_000,
    month_cost: 192.4,
    pools: q.pools,
    colab: {
      tier: 'PRO+',
      cu: 84.2,
      rate: 13.1,
      hrs: 6.4,
      rt: { gpu: 'A100-40G', ram_u: 14, ram_t: 83, vram_u: 22, vram_t: 40, idle_m: 72 }
    }
  };

  const out2 = stripAnsi(renderStatusLine(stdinPayload, summary, { lines: 2, color: false, nowSec }));
  const rows2 = out2.split('\n');
  assert.equal(rows2.length, 2, `2-line mode must produce 2 lines:\n${out2}`);
  assert.ok(rows2[0].includes('42%') && rows2[0].includes('缓存均值 86%') && rows2[0].includes('今日 2.42M'));
  assert.ok(rows2[1].includes('Gemini 5h 余78%') && rows2[1].includes('非Gemini 5h 余92%') && rows2[1].includes('84.2 CU'));

  const out3 = stripAnsi(renderStatusLine(stdinPayload, summary, { lines: 3, color: false, nowSec }));
  const rows3 = out3.split('\n');
  assert.equal(rows3.length, 3, `3-line mode with Colab must produce 3 lines:\n${out3}`);
  assert.ok(rows3[2].includes('Colab [PRO+]') && rows3[2].includes('RAM 14/83G') && rows3[2].includes('VRAM 22/40G'));

  const outNarrow = stripAnsi(renderStatusLine({ ...stdinPayload, terminal_width: 68 }, summary, { lines: 2, color: false, nowSec }));
  assert.equal(outNarrow.split('\n').length, 2);
  assert.ok(outNarrow.split('\n')[0].length < 68, `Narrow L1 should stay concise: ${outNarrow}`);

  pass('Dual-pool quota normalization & 1/2/3-line width-adaptive statusLine renderer');
}

function testSoloBridgeChaining() {
  const work = mkdtempSync(join(tmpdir(), 'agy-hud-solo-chain-'));
  const prevHome = process.env.AGY_HUD_HOME;
  process.env.AGY_HUD_HOME = work;
  try {
    const paths = resolveHudPaths();
    mkdirSync(dirname(paths.cliSettingsPath), { recursive: true });
    const soloCmd = '"/Applications/Solo.app/Contents/Resources/CoreRuntime/bin/cli-agents-hook" agent hook agy-statusline';
    writeFileSync(
      paths.cliSettingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: soloCmd, enabled: true, stack_with_default: true } }, null, 2)
    );

    const installed = configureAgyStatusLine({ hudCommand: 'agy-hud statusline', paths });
    assert.equal(installed.mode, 'solo_chained');
    assert.ok(installed.command.startsWith(soloCmd), 'Must preserve Solo agy-statusline prefix');
    assert.ok(installed.command.includes('--forward-command') && installed.command.includes('agy-hud statusline'));

    const uninstalled = configureAgyStatusLine({ uninstall: true, paths });
    assert.equal(uninstalled.mode, 'solo_preserved');
    assert.equal(uninstalled.command, soloCmd, 'Uninstall must restore exact Solo bridge command');

    pass('Solo agy-statusline --forward-command zero-conflict install & uninstall');
  } finally {
    if (prevHome === undefined) delete process.env.AGY_HUD_HOME;
    else process.env.AGY_HUD_HOME = prevHome;
    rmSync(work, { recursive: true, force: true });
  }
}

async function testMockColabApiAndPermissions() {
  const work = mkdtempSync(join(tmpdir(), 'agy-hud-colab-'));
  const prevHome = process.env.AGY_HUD_HOME;
  process.env.AGY_HUD_HOME = work;

  let released = false;
  let keepAliveHit = false;
  const mockJsonRes = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body)
  });

  const mockFetch = async (url, init = {}) => {
    const u = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    if (u.endsWith('/v1beta/subscription')) {
      return mockJsonRes({ tier: 'SUBSCRIPTION_TIER_PRO_PLUS' });
    }
    if (u.endsWith('/v1beta/runtimes') && method === 'GET') {
      return mockJsonRes({
        runtimes: released ? [] : [
          {
            name: 'runtimes/rt-mock-1',
            runtimeSpec: { variant: 'GPU', accelerator: 'A100', shape: 'HIGHMEM' },
            connectionInfo: { url: 'https://mock-proxy.example.com/proxy/us-central1', token: 'mock-proxy-tok' }
          }
        ]
      });
    }
    if (u.endsWith('/v1beta/runtimes/rt-mock-1') && method === 'DELETE') {
      released = true;
      return mockJsonRes({ done: true });
    }
    if (u.includes('ccu-info')) {
      return mockJsonRes(`)]}'\n${JSON.stringify({ currentBalance: 84.25, consumptionRateHourly: 13.08 })}`);
    }
    if (u.endsWith('/api/status')) {
      return mockJsonRes({
        started: new Date(Date.now() - 40 * 60_000).toISOString(),
        last_activity: new Date(Date.now() - 18 * 60_000).toISOString(),
        kernels: 1,
        connections: 1
      });
    }
    if (u.endsWith('/api/colab/resources')) {
      return mockJsonRes(`)]}'\n${JSON.stringify({
        memory: { totalBytes: 83.5 * 1024 ** 3, freeBytes: 69.3 * 1024 ** 3 },
        gpus: [{ name: 'NVIDIA A100-SXM4-40GB', memoryTotalBytes: 40 * 1024 ** 3, memoryUsedBytes: 22 * 1024 ** 3, gpuUtilization: 0.62 }]
      })}`);
    }
    if (u.endsWith('/api/kernels')) {
      keepAliveHit = true;
      return mockJsonRes([{ id: 'k1', name: 'python3' }]);
    }
    return mockJsonRes({}, 404);
  };

  try {
    const paths = resolveHudPaths();
    const secretFile = join(work, 'secret.json');
    writeFileSync(secretFile, JSON.stringify({ installed: { client_id: 'mock-client.apps.googleusercontent.com', client_secret: 'mock-sec' } }));
    importClientSecretFile(secretFile, paths);
    saveColabToken({ access_token: 'mock-access', expiry_date: Date.now() + 3600_000, scope: 'openid userinfo.email colaboratory' }, paths);

    if (process.platform !== 'win32') {
      assert.equal(statSync(paths.colabTokenPath).mode & 0o777, 0o600, 'token.json must have mode 0600');
    }

    const st = await refreshColabStatus({ paths, force: true, fetchImpl: mockFetch });
    assert.equal(st.connected, true);
    assert.equal(st.tier, 'PRO+');
    assert.equal(st.cu_balance, 84.25);
    assert.equal(st.runtimes.length, 1);
    assert.equal(st.runtimes[0].accelerator, 'A100');
    assert.equal(st.runtimes[0].region, 'us-central1');
    assert.equal(st.runtimes[0].gpu_util_percent, 62);
    assert.equal(st.runtimes[0].ram_total_gb, 83.5);
    assert.equal(st.runtimes[0].vram_used_gb, 22);
    assert.ok(st.runtimes[0].idle_remaining_minutes >= 70 && st.runtimes[0].idle_remaining_minutes <= 73);

    await keepAliveColabRuntime('rt-mock-1', { paths, fetchImpl: mockFetch });
    assert.equal(keepAliveHit, true);

    const afterRelease = await releaseColabRuntime('rt-mock-1', { paths, fetchImpl: mockFetch });
    assert.equal(afterRelease.runtimes.length, 0);

    // Compose full snapshot & verify CLI hot path
    const inc = runIncrementalSync({ scope: 'cli_only', paths });
    composeSnapshot({ incrementalResult: inc, buildSessionFn: buildSessionMetricsFromIncremental, colabSummary: st, paths });
    assert.ok(existsSync(paths.snapshotPath));
    assert.ok(existsSync(paths.summaryPath));

    const cliOut = execFileSync(process.execPath, [BIN_PATH, 'statusline', '--no-color'], {
      env: { ...process.env, AGY_HUD_NO_BG_SYNC: '1' },
      input: JSON.stringify({
        conversation_id: '11111111-2222-3333-4444-555555555555',
        terminal_width: 120,
        context_window: { context_window_size: 1_000_000, used_percentage: 25, current_usage: { input_tokens: 5000, cache_read_input_tokens: 45000 } },
        quota: { 'gemini-5h': { remaining_fraction: 0.85 }, '3p-5h': { remaining_fraction: 0.95 } }
      }),
      encoding: 'utf8'
    });
    assert.ok(cliOut.includes('25%') && cliOut.includes('Gemini') && cliOut.includes('非Gemini') && cliOut.includes('84.3 CU'));

    pass('Mock Colab REST API (CCU/RAM/VRAM/GPU/idle/keepalive/release), mode 0600 & CLI statusline e2e');
  } finally {
    if (prevHome === undefined) delete process.env.AGY_HUD_HOME;
    else process.env.AGY_HUD_HOME = prevHome;
    rmSync(work, { recursive: true, force: true });
  }
}

function testIsolatedInstallUninstall() {
  const tempPlugins = mkdtempSync(join(tmpdir(), 'agy-hud-inst-p-'));
  const tempBin = mkdtempSync(join(tmpdir(), 'agy-hud-inst-b-'));
  const env = {
    ...process.env,
    AGY_PLUGINS_DIR: tempPlugins,
    ANTIGRAVITY_PLUGINS_DIR: tempPlugins,
    AGY_BIN_DIR: tempBin,
    ANTIGRAVITY_BIN_DIR: tempBin
  };
  try {
    execFileSync('bash', [join(PLUGIN_ROOT, 'install.sh')], { cwd: PLUGIN_ROOT, env, stdio: 'pipe' });
    assert.ok(existsSync(join(tempPlugins, 'agy-cli-hud', 'plugin.json')));
    assert.ok(existsSync(join(tempPlugins, 'agy-cli-hud', 'bin', 'agy-hud.mjs')));
    assert.ok(existsSync(join(tempBin, 'agy-hud')));

    const helpOut = execFileSync(join(tempBin, 'agy-hud'), ['--help'], { env, encoding: 'utf8' });
    assert.ok(helpOut.includes('agy-hud'));

    execFileSync('bash', [join(PLUGIN_ROOT, 'install.sh'), '--uninstall'], { cwd: PLUGIN_ROOT, env, stdio: 'pipe' });
    assert.ok(!existsSync(join(tempPlugins, 'agy-cli-hud')));
    assert.ok(!existsSync(join(tempBin, 'agy-hud')));

    pass('Isolated install.sh & --uninstall lifecycle');
  } finally {
    rmSync(tempPlugins, { recursive: true, force: true });
    rmSync(tempBin, { recursive: true, force: true });
  }
}

async function main() {
  testZeroCdpCompliance();
  testIncrementalJsonlAndRollup();
  testDualPoolQuotaAndLayeredStatusline();
  testSoloBridgeChaining();
  await testMockColabApiAndPermissions();
  testIsolatedInstallUninstall();
  console.log('[agy-cli-hud] All plugin checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
