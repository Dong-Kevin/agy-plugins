#!/usr/bin/env node
/**
 * Self-contained verification suite for plugins/agy-cli-hud.
 * Covers incremental JSONL rollup, step deduplication, dual-pool quotas,
 * 1/2/3-line statusLine rendering, Solo bridge chaining, mock Colab API,
 * compliance (zero CDP), and isolated install/uninstall.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
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
import { hexToAnsi256, hexToAnsiFg, THEME_NAMES, THEMES } from '../lib/themes.mjs';

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
    'lib/themes.mjs',
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

  // Restrained Catppuccin/Nord/Dracula semantic theme checks (zero per-character rainbow, single-hue bar, 256 fallback & --no-color)
  const outMocha = renderStatusLine(stdinPayload, summary, { lines: 2, color: true, colorDepth: 'truecolor', theme: 'mocha', nowSec });
  const mochaMatches = new Set(outMocha.match(/\x1b\[38;2;\d+;\d+;\d+m/g) || []);
  assert.ok(mochaMatches.size >= 4 && mochaMatches.size <= 8, `Restrained mocha theme must emit 4..8 distinct RGB colors, got ${mochaMatches.size}`);
  assert.ok(outMocha.includes(`${hexToAnsiFg(THEMES.mocha.base.pink, 'truecolor')}Ctx\x1b[0m`), 'Ctx label must be a single flat color (no per-character gradient)');
  assert.ok(outMocha.includes(`${hexToAnsiFg(THEMES.mocha.base.blue, 'truecolor')}Gemini\x1b[0m`), 'Gemini header must be a single flat color (no per-character gradient)');
  assert.ok(outMocha.includes(`${hexToAnsiFg(THEMES.mocha.base.green, 'truecolor')}███░░░░░\x1b[0m`), 'Healthy 42% bar must render filled and empty cells in single barOk hue');
  assert.equal(stripAnsi(outMocha), out2, 'TrueColor stripped output must match plain output exactly');

  // Threshold bar colors: 0% muted, 65% warn (yellow), 88% danger (red)
  const outZero = renderStatusLine({ ...stdinPayload, context_window: { context_window_size: 1_000_000, used_percentage: 0 } }, summary, { lines: 2, color: true, colorDepth: 'truecolor', theme: 'mocha', nowSec });
  assert.ok(outZero.includes(`${hexToAnsiFg(THEMES.mocha.base.overlay0, 'truecolor')}░░░░░░░░\x1b[0m`), '0% bar must use muted overlay0');
  const outWarn = renderStatusLine({ ...stdinPayload, context_window: { context_window_size: 1_000_000, used_percentage: 65 } }, summary, { lines: 2, color: true, colorDepth: 'truecolor', theme: 'mocha', nowSec });
  assert.ok(outWarn.includes(`${hexToAnsiFg(THEMES.mocha.base.yellow, 'truecolor')}█████░░░\x1b[0m`), '65% bar must use single barWarn yellow');
  const outCrit = renderStatusLine({ ...stdinPayload, context_window: { context_window_size: 1_000_000, used_percentage: 88 } }, summary, { lines: 2, color: true, colorDepth: 'truecolor', theme: 'mocha', nowSec });
  assert.ok(outCrit.includes(`${hexToAnsiFg(THEMES.mocha.base.red, 'truecolor')}███████░\x1b[0m`), '88% bar must use single barDanger red');

  // All 6 curated themes render exact theme colors in TrueColor & 256-color fallback
  for (const name of THEME_NAMES) {
    const tTrue = renderStatusLine(stdinPayload, summary, { lines: 2, color: true, colorDepth: 'truecolor', theme: name, nowSec });
    assert.ok(tTrue.includes(hexToAnsiFg(THEMES[name].base.pink, 'truecolor')), `Theme ${name} must emit its exact label truecolor`);
    assert.equal(stripAnsi(tTrue), out2, `Theme ${name} stripped truecolor output must match plain output`);

    const t256 = renderStatusLine(stdinPayload, summary, { lines: 2, color: true, colorDepth: '256', theme: name, nowSec });
    assert.ok(t256.includes(`\x1b[38;5;${hexToAnsi256(THEMES[name].base.pink)}m`), `Theme ${name} must emit 256-color fallback`);
    assert.equal(stripAnsi(t256), out2, `Theme ${name} stripped 256 output must match plain output`);
  }
  assert.ok(!/\x1b\[/.test(renderStatusLine(stdinPayload, summary, { lines: 2, color: false, nowSec })), 'color=false must emit zero ANSI escapes');

  // Fresh startup session isolation: blank conversation_id MUST NOT inherit prior session cache/tps/cost
  const freshStartupPayload = {
    conversation_id: '',
    session_id: '',
    terminal_width: 120,
    context_window: { context_window_size: 1_000_000, used_percentage: 0, current_usage: null },
    cost: { total_cost_usd: 0 },
    quota: rawQuota
  };
  const outFresh = stripAnsi(renderStatusLine(freshStartupPayload, summary, { lines: 2, color: false, nowSec }));
  const freshRows = outFresh.split('\n');
  assert.equal(freshRows.length, 2);
  assert.ok(freshRows[0].includes('0%') && freshRows[0].includes('今日 2.42M'), `Fresh startup must keep 0% Ctx & global today rollup: ${freshRows[0]}`);
  assert.ok(!freshRows[0].includes('缓存均值') && !freshRows[0].includes('t/s') && !freshRows[0].includes('本会话'), `Fresh startup must NEVER leak prior session cache/tps/cost: ${freshRows[0]}`);
  assert.ok(freshRows[1].includes('Gemini 5h 余78%') && freshRows[1].includes('非Gemini 5h 余92%'), `Fresh startup must keep live dual-pool quotas: ${freshRows[1]}`);

  // Brand-new conversation_id not present in summary MUST NOT inherit prior session metrics
  const brandNewConvPayload = { ...freshStartupPayload, conversation_id: '00000000-0000-4000-8000-000000000099', session_id: '00000000-0000-4000-8000-000000000099' };
  const outNewConv = stripAnsi(renderStatusLine(brandNewConvPayload, summary, { lines: 2, color: false, nowSec }));
  assert.ok(!outNewConv.includes('缓存均值') && !outNewConv.includes('58.2') && !outNewConv.includes('$1.24'), `Brand-new convId must not leak prior session stats: ${outNewConv}`);

  pass('Dual-pool quota normalization, 6-theme restrained palette & fresh-session isolation statusLine renderer');
}

function testThemeCliAndPrecedence() {
  const work = mkdtempSync(join(tmpdir(), 'agy-hud-theme-'));
  const baseEnv = {
    ...process.env,
    AGY_HUD_HOME: work,
    AGY_HUD_NO_BG_SYNC: '1',
    COLORTERM: 'truecolor'
  };
  delete baseEnv.AGY_HUD_THEME;
  delete baseEnv.NO_COLOR;
  try {
    const listJson = JSON.parse(execFileSync(process.execPath, [BIN_PATH, 'theme', 'list', '--json'], {
      env: baseEnv,
      encoding: 'utf8'
    }));
    assert.equal(listJson.active, 'mocha');
    assert.deepEqual(listJson.themes.map((t) => t.name), [...THEME_NAMES]);

    const setRes = JSON.parse(execFileSync(process.execPath, [BIN_PATH, 'theme', 'set', 'nord', '--json'], {
      env: baseEnv,
      encoding: 'utf8'
    }));
    assert.equal(setRes.ok, true);
    assert.equal(setRes.theme, 'nord');

    const previewOut = execFileSync(process.execPath, [BIN_PATH, 'theme', 'preview', 'nord'], {
      env: baseEnv,
      encoding: 'utf8'
    });
    assert.ok(previewOut.includes('[nord]') && previewOut.includes(hexToAnsiFg(THEMES.nord.base.blue, 'truecolor')));

    const samplePayload = JSON.stringify({
      conversation_id: '11111111-2222-3333-4444-555555555555',
      terminal_width: 120,
      context_window: { context_window_size: 1_000_000, used_percentage: 35 }
    });

    // Persisted config theme (nord) applies automatically via summary
    const nordSl = execFileSync(process.execPath, [BIN_PATH, 'statusline'], {
      env: baseEnv,
      input: samplePayload,
      encoding: 'utf8'
    });
    assert.ok(nordSl.includes(hexToAnsiFg(THEMES.nord.base.pink, 'truecolor')), 'Persisted nord theme must flow through summary to statusline');

    // AGY_HUD_THEME overrides config
    const latteSl = execFileSync(process.execPath, [BIN_PATH, 'statusline'], {
      env: { ...baseEnv, AGY_HUD_THEME: 'latte' },
      input: samplePayload,
      encoding: 'utf8'
    });
    assert.ok(latteSl.includes(hexToAnsiFg(THEMES.latte.base.pink, 'truecolor')), 'AGY_HUD_THEME must override config theme');

    // Explicit --theme flag overrides AGY_HUD_THEME
    const draculaSl = execFileSync(process.execPath, [BIN_PATH, 'statusline', '--theme', 'dracula'], {
      env: { ...baseEnv, AGY_HUD_THEME: 'latte' },
      input: samplePayload,
      encoding: 'utf8'
    });
    assert.ok(draculaSl.includes(hexToAnsiFg(THEMES.dracula.base.pink, 'truecolor')), '--theme flag must override AGY_HUD_THEME');

    pass('CLI theme list/preview/set persistence & precedence (--theme > AGY_HUD_THEME > config > mocha)');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function testCrossSessionSnapshotIsolation() {
  const work = mkdtempSync(join(tmpdir(), 'agy-hud-iso-'));
  const prevHome = process.env.AGY_HUD_HOME;
  process.env.AGY_HUD_HOME = work;
  try {
    const paths = resolveHudPaths();
    const convA = '00000000-0000-4000-8000-00000000000a';
    const convB = '00000000-0000-4000-8000-00000000000b';
    const convNew = '00000000-0000-4000-8000-00000000000c';

    const dirA = join(paths.cliBrainDir, convA, '.system_generated', 'logs');
    const dirB = join(paths.cliBrainDir, convB, '.system_generated', 'logs');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });

    writeFileSync(
      join(dirA, 'transcript.jsonl'),
      [
        JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: '2026-11-26T10:00:00Z' }),
        JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', created_at: '2026-11-26T10:00:10Z', model: 'gemini-4-neon-xhigh', input_tokens: 60000, cache_read_tokens: 40000, output_tokens: 1428 })
      ].join('\n') + '\n',
      'utf8'
    );
    writeFileSync(
      join(dirB, 'transcript.jsonl'),
      [
        JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: '2026-11-26T10:05:00Z' }),
        JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', created_at: '2026-11-26T10:05:20Z', model: 'gemini-4-neon-xhigh', input_tokens: 10000, cache_read_tokens: 90000, output_tokens: 1000 })
      ].join('\n') + '\n',
      'utf8'
    );

    const now = new Date('2026-11-26T10:06:00Z');
    const inc = runIncrementalSync({ scope: 'cli_only', paths, now });
    const nowSec = Math.floor(Date.now() / 1000);

    // 1) Fresh uninitialized CLI session (blank conversation_id) must NOT pull convA/convB into active_session
    const { snapshot: snapBlank, summary: sumBlank } = composeSnapshot({
      incrementalResult: inc,
      buildSessionFn: buildSessionMetricsFromIncremental,
      liveFacts: {
        observed_at: nowSec,
        has_stdin_payload: true,
        conversation_id: null,
        context_used_tokens: 0,
        context_window_size: 1_000_000,
        context_used_percent: 0,
        last_turn_cache_hit_percent: null,
        session_cost_usd: 0
      },
      paths
    });
    assert.equal(snapBlank.active_session.conversation_id, null);
    assert.equal(snapBlank.active_session.session_avg_cache_hit_percent, null);
    assert.equal(snapBlank.active_session.output_tps, null);
    assert.equal(snapBlank.active_session.session_cost_usd, 0);
    assert.equal(sumBlank.avg_cache, null);
    assert.equal(sumBlank.tps, null);
    assert.equal(sumBlank.sess_cost, 0);
    assert.ok(statSync(paths.summaryPath).size < 4096, 'summary with multi-session map must stay < 4KB');

    // 2) Brand-new conversation_id before first transcript turn must NOT fall back to latestSessionState
    const { snapshot: snapNew, summary: sumNew } = composeSnapshot({
      incrementalResult: inc,
      buildSessionFn: buildSessionMetricsFromIncremental,
      liveFacts: {
        observed_at: nowSec,
        has_stdin_payload: true,
        conversation_id: convNew,
        context_used_tokens: 0,
        context_window_size: 1_000_000,
        context_used_percent: 0,
        last_turn_cache_hit_percent: null,
        session_cost_usd: 0
      },
      paths
    });
    assert.equal(snapNew.active_session.conversation_id, convNew);
    assert.equal(snapNew.active_session.session_avg_cache_hit_percent, null);
    assert.equal(snapNew.active_session.output_tps, null);
    assert.equal(snapNew.active_session.session_cost_usd, 0);

    // 3) Concurrent multi-session lookup: both convA and convB resolve their OWN stats from sumNew.sessions
    const outA = stripAnsi(renderStatusLine({ conversation_id: convA, terminal_width: 120, context_window: { context_window_size: 1_000_000, used_percentage: 10 } }, sumNew, { lines: 2, color: false }));
    const outB = stripAnsi(renderStatusLine({ conversation_id: convB, terminal_width: 120, context_window: { context_window_size: 1_000_000, used_percentage: 10 } }, sumNew, { lines: 2, color: false }));
    const outC = stripAnsi(renderStatusLine({ conversation_id: convNew, terminal_width: 120, context_window: { context_window_size: 1_000_000, used_percentage: 0 } }, sumNew, { lines: 2, color: false }));
    assert.ok(outA.includes('缓存均值 40%') && outA.includes('142.8 t/s'), `convA must resolve its own 40% cache & 142.8 t/s: ${outA}`);
    assert.ok(outB.includes('缓存均值 90%') && outB.includes('50 t/s'), `convB must resolve its own 90% cache & 50 t/s: ${outB}`);
    assert.ok(!outC.includes('缓存均值') && !outC.includes('t/s') && !outC.includes('本会话'), `convNew must stay clean before first turn: ${outC}`);

    pass('Cross-session snapshot isolation (blank convId, brand-new convId & concurrent multi-tab lookup)');
  } finally {
    if (prevHome === undefined) delete process.env.AGY_HUD_HOME;
    else process.env.AGY_HUD_HOME = prevHome;
    rmSync(work, { recursive: true, force: true });
  }
}

function assertShellSyntaxValid(command) {
  if (process.platform === 'win32') return;
  execFileSync('/bin/sh', ['-n', '-c', command], { stdio: 'pipe' });
}

function testSoloBridgeChaining() {
  const work = mkdtempSync(join(tmpdir(), 'agy-hud-solo-chain-'));
  const prevHome = process.env.AGY_HUD_HOME;
  process.env.AGY_HUD_HOME = work;
  const soloBgMatchRe =
    /^payload=\$\(cat\);\s*if\s+\[\s+-n\s+"\$CLI_AGENTS_SURFACE_ID"\s+\]\s+&&\s+\[\s+-x\s+"\$CLI_AGENTS_HOOK_CLI"\s+\];\s*then\s+\(printf\s+"%s"\s+"\$payload"\s+\|\s+"\$CLI_AGENTS_HOOK_CLI"\s+agent\s+hook\s+agy-statusline(?:\s+--forward-command\s+true)?\s*>\/dev\/null\s+2>&1\s*&\);\s*fi;\s*printf\s+"%s"\s+"\$payload"\s+\|\s+(.+)$/;
  try {
    const paths = resolveHudPaths();
    mkdirSync(dirname(paths.cliSettingsPath), { recursive: true });

    // 1) Legacy direct binary Solo bridge command (default async bypass + opt-in soloSync)
    const soloDirectCmd = '"/Applications/Solo.app/Contents/Resources/CoreRuntime/bin/cli-agents-hook" agent hook agy-statusline';
    writeFileSync(
      paths.cliSettingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: soloDirectCmd, enabled: true, stack_with_default: true } }, null, 2)
    );
    const installedDirectAsync = configureAgyStatusLine({ hudCommand: 'agy-hud statusline', paths });
    assert.equal(installedDirectAsync.mode, 'solo_async');
    assert.ok(installedDirectAsync.command.includes(soloDirectCmd) && installedDirectAsync.command.includes('>/dev/null 2>&1 &'));
    assert.ok(installedDirectAsync.command.endsWith('| agy-hud statusline'));
    assertShellSyntaxValid(installedDirectAsync.command);
    const uninstalledDirectAsync = configureAgyStatusLine({ uninstall: true, paths });
    assert.equal(uninstalledDirectAsync.mode, 'solo_preserved');
    assert.equal(uninstalledDirectAsync.command, soloDirectCmd, 'Uninstall from direct async must restore exact direct Solo bridge');

    const installedDirectSync = configureAgyStatusLine({ hudCommand: 'agy-hud statusline', soloSync: true, paths });
    assert.equal(installedDirectSync.mode, 'solo_chained');
    assert.ok(installedDirectSync.command.startsWith(soloDirectCmd), 'soloSync must preserve direct Solo prefix');
    assert.ok(installedDirectSync.command.includes('--forward-command') && installedDirectSync.command.includes('agy-hud statusline'));
    assertShellSyntaxValid(installedDirectSync.command);
    const uninstalledDirectSync = configureAgyStatusLine({ uninstall: true, paths });
    assert.equal(uninstalledDirectSync.mode, 'solo_preserved');
    assert.equal(uninstalledDirectSync.command, soloDirectCmd, 'Uninstall from direct sync must restore exact direct Solo bridge');

    // 2) Canonical Solo `if ...; then ...; fi` surface wrapper -> default non-blocking async bypass
    const canonicalNoForward =
      'if [ -n "$CLI_AGENTS_SURFACE_ID" ] && [ -x "$CLI_AGENTS_HOOK_CLI" ]; then "$CLI_AGENTS_HOOK_CLI" agent hook agy-statusline; fi';
    const canonicalSyncWithHud =
      'if [ -n "$CLI_AGENTS_SURFACE_ID" ] && [ -x "$CLI_AGENTS_HOOK_CLI" ]; then "$CLI_AGENTS_HOOK_CLI" agent hook agy-statusline --forward-command \'agy-hud statusline\'; else /bin/sh -c \'agy-hud statusline\'; fi';
    const canonicalAsyncWithHud =
      'payload=$(cat); if [ -n "$CLI_AGENTS_SURFACE_ID" ] && [ -x "$CLI_AGENTS_HOOK_CLI" ]; then (printf "%s" "$payload" | "$CLI_AGENTS_HOOK_CLI" agent hook agy-statusline >/dev/null 2>&1 &); fi; printf "%s" "$payload" | agy-hud statusline';
    writeFileSync(
      paths.cliSettingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: canonicalNoForward, enabled: true, stack_with_default: true } }, null, 2)
    );
    const installedAsync = configureAgyStatusLine({ hudCommand: 'agy-hud statusline', paths });
    assert.equal(installedAsync.mode, 'solo_async');
    assert.equal(installedAsync.command, canonicalAsyncWithHud, 'Default Solo install must use non-blocking async bypass');
    assert.ok(soloBgMatchRe.test(installedAsync.command), 'Async bypass must match Solo hook_configuration.py bg_match verbatim');
    assertShellSyntaxValid(installedAsync.command);

    // Re-running install on existing solo_async must stay idempotent
    const reinstalledAsync = configureAgyStatusLine({ hudCommand: 'agy-hud statusline', paths });
    assert.equal(reinstalledAsync.mode, 'solo_async');
    assert.equal(reinstalledAsync.command, canonicalAsyncWithHud);

    // Opt-in --solo-sync switches cleanly to canonical synchronous wrapper
    const installedSync = configureAgyStatusLine({ hudCommand: 'agy-hud statusline', soloSync: true, paths });
    assert.equal(installedSync.mode, 'solo_chained');
    assert.equal(installedSync.command, canonicalSyncWithHud, 'soloSync must match surface_hook_command("agy", forward)');
    assertShellSyntaxValid(installedSync.command);

    // Uninstall from either async or sync restores canonical Solo wrapper
    const uninstalledCanon = configureAgyStatusLine({ uninstall: true, paths });
    assert.equal(uninstalledCanon.mode, 'solo_preserved');
    assert.equal(uninstalledCanon.command, canonicalNoForward, 'Uninstall must restore canonical Solo wrapper ending with ; fi');
    assertShellSyntaxValid(uninstalledCanon.command);

    // 3) Canonical Solo wrapper with another existing --forward-command upgrades cleanly to solo_async
    const canonicalOtherForward =
      'if [ -n "$CLI_AGENTS_SURFACE_ID" ] && [ -x "$CLI_AGENTS_HOOK_CLI" ]; then "$CLI_AGENTS_HOOK_CLI" agent hook agy-statusline --forward-command \'agy-context statusline\'; else /bin/sh -c \'agy-context statusline\'; fi';
    writeFileSync(
      paths.cliSettingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: canonicalOtherForward, enabled: true, stack_with_default: true } }, null, 2)
    );
    const replacedForward = configureAgyStatusLine({ hudCommand: 'agy-hud statusline', paths });
    assert.equal(replacedForward.mode, 'solo_async');
    assert.equal(replacedForward.command, canonicalAsyncWithHud);
    assertShellSyntaxValid(replacedForward.command);

    // 4) Self-heal truncated/broken Solo wrapper missing `; else ...; fi`
    const brokenTruncated =
      'if [ -n "$CLI_AGENTS_SURFACE_ID" ] && [ -x "$CLI_AGENTS_HOOK_CLI" ]; then "$CLI_AGENTS_HOOK_CLI" agent hook agy-statusline --forward-command \'agy-hud statusline\'';
    writeFileSync(
      paths.cliSettingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: brokenTruncated, enabled: true, stack_with_default: true } }, null, 2)
    );
    const healedInstall = configureAgyStatusLine({ hudCommand: 'agy-hud statusline', paths });
    assert.equal(healedInstall.mode, 'solo_async');
    assert.equal(healedInstall.command, canonicalAsyncWithHud, 'Install must self-heal truncated Solo wrapper');
    assertShellSyntaxValid(healedInstall.command);

    writeFileSync(
      paths.cliSettingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: brokenTruncated, enabled: true, stack_with_default: true } }, null, 2)
    );
    const healedUninstall = configureAgyStatusLine({ uninstall: true, paths });
    assert.equal(healedUninstall.mode, 'solo_preserved');
    assert.equal(healedUninstall.command, canonicalNoForward, 'Uninstall must self-heal truncated Solo wrapper');
    assertShellSyntaxValid(healedUninstall.command);

    // 5) Real POSIX shell execution with a 2000ms slow Solo hook must finish non-blocking (<600ms)
    if (process.platform !== 'win32') {
      const slowHook = join(work, 'slow-solo-hook.sh');
      writeFileSync(slowHook, '#!/bin/sh\ncat >/dev/null\nsleep 2\n', 'utf8');
      chmodSync(slowHook, 0o755);
      const liveHudCmd = `'${process.execPath.replace(/'/g, "'\"'\"'")}' '${BIN_PATH.replace(/'/g, "'\"'\"'")}' statusline --no-color`;
      writeFileSync(
        paths.cliSettingsPath,
        JSON.stringify({ statusLine: { type: 'command', command: canonicalNoForward, enabled: true, stack_with_default: true } }, null, 2)
      );
      const liveAsync = configureAgyStatusLine({ hudCommand: liveHudCmd, paths });
      assert.ok(soloBgMatchRe.test(liveAsync.command), 'Live async command must satisfy bg_match');
      const t0 = Date.now();
      const out = execFileSync('/bin/sh', ['-c', liveAsync.command], {
        input: JSON.stringify({ conversation_id: '', terminal_width: 120, context_window: { context_window_size: 1_000_000, used_percentage: 12 } }),
        encoding: 'utf8',
        env: {
          ...process.env,
          AGY_HUD_HOME: work,
          AGY_HUD_NO_BG_SYNC: '1',
          CLI_AGENTS_SURFACE_ID: 'verify-surface',
          CLI_AGENTS_HOOK_CLI: slowHook
        },
        timeout: 1500
      });
      const elapsedMs = Date.now() - t0;
      assert.ok(out.includes('12%'), `Async bypass must render live agy-hud output: ${out}`);
      assert.ok(elapsedMs < 800, `Async bypass must not block on 2000ms slow Solo hook (took ${elapsedMs}ms)`);
    }

    pass('Solo agy-statusline async bypass (bg_match + non-blocking 2s hook), --solo-sync & clean uninstall');
  } finally {
    if (prevHome === undefined) delete process.env.AGY_HUD_HOME;
    else process.env.AGY_HUD_HOME = prevHome;
    rmSync(work, { recursive: true, force: true });
  }
}

async function testStatuslineAntiKillHardening() {
  const work = mkdtempSync(join(tmpdir(), 'agy-hud-harden-'));
  const prevHome = process.env.AGY_HUD_HOME;
  process.env.AGY_HUD_HOME = work;
  try {
    const paths = resolveHudPaths();
    mkdirSync(paths.dataDir, { recursive: true });
    writeFileSync(
      paths.summaryPath,
      JSON.stringify({
        v: 1,
        updated_at: Math.floor(Date.now() / 1000),
        sync_interval_ms: 2500,
        lines: 2,
        color: false,
        session_id: '11111111-2222-3333-4444-555555555555',
        ctx_pct: 33,
        ctx_used: 330_000,
        ctx_size: 1_000_000,
        today_tokens: 123_000,
        today_cost: 0.45
      }),
      'utf8'
    );

    // 1) Hanging stdin pipe must hit bounded timeout and exit 0 cleanly with summary fallback
    const hangStart = Date.now();
    const hangResult = await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [BIN_PATH, 'statusline', '--no-color'], {
        env: {
          ...process.env,
          AGY_HUD_HOME: work,
          AGY_HUD_NO_BG_SYNC: '1',
          AGY_HUD_STDIN_TIMEOUT_MS: '80'
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
      child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
      child.on('error', rejectPromise);
      child.on('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
      // Intentionally keep child.stdin open without ending it!
    });
    const hangElapsed = Date.now() - hangStart;
    assert.equal(hangResult.code, 0, `Hanging stdin must exit 0 (got code=${hangResult.code} signal=${hangResult.signal} err=${hangResult.stderr})`);
    assert.ok(hangResult.stdout.includes('33%'), `Hanging stdin must render cached summary fallback: ${hangResult.stdout}`);
    assert.ok(hangElapsed < 1200, `Bounded stdin timeout must exit quickly (took ${hangElapsed}ms)`);

    // 2) Live-session write deduplication: identical payload within 15s must not rewrite live_statusline.v1.json
    const payloadStr = JSON.stringify({
      conversation_id: '11111111-2222-3333-4444-555555555555',
      terminal_width: 120,
      context_window: { context_window_size: 1_000_000, used_percentage: 44 }
    });
    execFileSync(process.execPath, [BIN_PATH, 'statusline', '--no-color'], {
      env: { ...process.env, AGY_HUD_HOME: work, AGY_HUD_NO_BG_SYNC: '1' },
      input: payloadStr,
      encoding: 'utf8'
    });
    const st1 = statSync(paths.liveSessionPath);
    await new Promise((r) => setTimeout(r, 30));
    execFileSync(process.execPath, [BIN_PATH, 'statusline', '--no-color'], {
      env: { ...process.env, AGY_HUD_HOME: work, AGY_HUD_NO_BG_SYNC: '1' },
      input: payloadStr,
      encoding: 'utf8'
    });
    const st2 = statSync(paths.liveSessionPath);
    assert.equal(st2.ino, st1.ino, 'Identical payload within 15s must skip redundant atomic rewrite');
    assert.equal(st2.mtimeMs, st1.mtimeMs, 'Identical payload must keep mtime unchanged');

    // Changed payload must rewrite immediately
    execFileSync(process.execPath, [BIN_PATH, 'statusline', '--no-color'], {
      env: { ...process.env, AGY_HUD_HOME: work, AGY_HUD_NO_BG_SYNC: '1' },
      input: JSON.stringify({
        conversation_id: '11111111-2222-3333-4444-555555555555',
        terminal_width: 120,
        context_window: { context_window_size: 1_000_000, used_percentage: 48 }
      }),
      encoding: 'utf8'
    });
    const liveAfter = JSON.parse(readFileSync(paths.liveSessionPath, 'utf8'));
    assert.equal(liveAfter.context_used_percent, 48, 'Changed payload must persist immediately');

    // 3) Single-instance sync.lock prevents background sync spawn when another live PID holds lock
    writeFileSync(paths.syncLockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }), 'utf8');
    writeFileSync(paths.syncStampPath, '1000', 'utf8');
    const oldDate = new Date(Date.now() - 60_000);
    utimesSync(paths.syncStampPath, oldDate, oldDate);
    execFileSync(process.execPath, [BIN_PATH, 'statusline', '--no-color'], {
      env: { ...process.env, AGY_HUD_HOME: work, AGY_HUD_NO_BG_SYNC: '0' },
      input: JSON.stringify({ conversation_id: '', terminal_width: 120 }),
      encoding: 'utf8'
    });
    assert.equal(readFileSync(paths.syncStampPath, 'utf8'), '1000', 'Active sync.lock must block overlapping background sync spawn');
    rmSync(paths.syncLockPath, { force: true });

    // 4) Incremental seenSteps pruning for inactive >7d sessions keeps totals intact + summary.sync_interval_ms
    const oldConv = '00000000-0000-4000-8000-00000000007d';
    const txDir = join(paths.cliBrainDir, oldConv, '.system_generated', 'logs');
    mkdirSync(txDir, { recursive: true });
    const txFile = join(txDir, 'transcript.jsonl');
    writeFileSync(
      txFile,
      `${JSON.stringify({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-10T10:00:00Z',
        model: 'gemini-4-neon-xhigh',
        input_tokens: 10000,
        cache_read_tokens: 40000,
        output_tokens: 1000
      })}\n`,
      'utf8'
    );
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
    utimesSync(txFile, tenDaysAgo, tenDaysAgo);
    const inc = runIncrementalSync({ scope: 'cli_only', paths, now: new Date() });
    const savedState = JSON.parse(readFileSync(paths.cursorStatePath, 'utf8'));
    assert.deepEqual(savedState.files[txFile].seenSteps, {}, 'Inactive >7d file must prune seenSteps');
    assert.equal(savedState.files[txFile].session.turns, 1, 'Pruned file must retain session turns');
    assert.equal(savedState.files[txFile].session.inputTokens, 10000, 'Pruned file must retain token totals');
    const { summary: composedSum } = composeSnapshot({
      incrementalResult: inc,
      buildSessionFn: buildSessionMetricsFromIncremental,
      paths
    });
    assert.equal(composedSum.sync_interval_ms, 2000, 'Composed summary must expose sync_interval_ms');

    pass('Statusline anti-kill hardening (bounded stdin, write dedup, sync.lock & >7d seenSteps pruning)');
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

    // Compose full snapshot & verify CLI hot path + Solo usage_hud.py contract fields
    const inc = runIncrementalSync({ scope: 'cli_only', paths });
    const { snapshot, summary } = composeSnapshot({ incrementalResult: inc, buildSessionFn: buildSessionMetricsFromIncremental, colabSummary: st, paths });
    assert.ok(existsSync(paths.snapshotPath));
    assert.ok(existsSync(paths.summaryPath));
    assert.ok(statSync(paths.summaryPath).size < 4096, 'statusline_summary.v1.json must stay < 4KB');
    assert.equal(snapshot.generated_at, snapshot.updated_at);
    assert.equal(snapshot.colab.balance_cu, 84.25);
    assert.equal(snapshot.usage.today.total_tokens, snapshot.rollups.today.tokens);
    assert.equal(summary.colab_connected, true);
    assert.equal(summary.colab_cu, 84.25);
    assert.equal(summary.colab_gpu, 'A100');
    assert.equal(summary.colab_ram_total, 83.5);
    assert.equal(summary.colab_vram_used, 22);
    assert.equal(summary.today_usd, summary.today_cost);

    const cliOut = execFileSync(process.execPath, [BIN_PATH, 'statusline', '--no-color'], {
      env: { ...process.env, AGY_HUD_NO_BG_SYNC: '1' },
      input: JSON.stringify({
        conversation_id: '11111111-2222-3333-4444-555555555555',
        terminal_width: 120,
        context_window: { context_window_size: 1_000_000, used_percentage: 25, current_usage: { input_tokens: 5000, cache_read_input_tokens: 45000 } },
        cost: { total_cost_usd: 0.42 },
        quota: { 'gemini-5h': { remaining_fraction: 0.85 }, '3p-5h': { remaining_fraction: 0.95 } }
      }),
      encoding: 'utf8'
    });
    assert.ok(cliOut.includes('25%') && cliOut.includes('$0.42') && cliOut.includes('Gemini') && cliOut.includes('非Gemini') && cliOut.includes('84.3 CU'));

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
  testThemeCliAndPrecedence();
  testCrossSessionSnapshotIsolation();
  testSoloBridgeChaining();
  await testStatuslineAntiKillHardening();
  await testMockColabApiAndPermissions();
  testIsolatedInstallUninstall();
  console.log('[agy-cli-hud] All plugin checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
