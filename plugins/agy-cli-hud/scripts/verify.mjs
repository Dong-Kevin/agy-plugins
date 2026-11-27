#!/usr/bin/env node
/**
 * Self-contained verification suite for plugins/agy-cli-hud.
 * Covers incremental JSONL rollup, step deduplication, dual-pool quotas,
 * 1/2/3-line statusLine rendering, Solo bridge chaining, mock Colab API,
 * compliance (zero CDP), and isolated install/uninstall.
 */

import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

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
import {
  applyWeeklyPoolObservation,
  extractHostCacheObservations,
  normalizeAgyQuotaMap,
  normalizeHostCacheQuotas,
  updateWeeklyQuotaLedger
} from '../lib/quota.mjs';
import { composeSnapshot } from '../lib/snapshot.mjs';
import {
  decodeGenMetadataTimingRow,
  enrichSessionsWithSqliteTiming,
  isSqliteAvailable
} from '../lib/sqlite_timing.mjs';
import { configureAgyStatusLine, measureDisplayWidth, renderStatusLine } from '../lib/statusline.mjs';
import { hexToAnsi256, hexToAnsiFg, THEME_NAMES, THEMES } from '../lib/themes.mjs';
import { compareSemver, extractZipBuffer, parseSemver } from '../lib/updater.mjs';

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
    'lib/sqlite_timing.mjs',
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
        JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-26T10:00:00Z', model: 'gemini-4-neon-xhigh', input_tokens: 60000, cache_read_tokens: 40000, output_tokens: 1428 }),
        JSON.stringify({ step_index: 3, type: 'GENERIC', status: 'DONE', created_at: '2026-11-26T10:00:10Z' })
      ].join('\n') + '\n',
      'utf8'
    );
    writeFileSync(
      join(dirB, 'transcript.jsonl'),
      [
        JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: '2026-11-26T10:05:00Z' }),
        JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-26T10:05:00Z', model: 'gemini-4-neon-xhigh', input_tokens: 10000, cache_read_tokens: 90000, output_tokens: 1000 }),
        JSON.stringify({ step_index: 3, type: 'GENERIC', status: 'DONE', created_at: '2026-11-26T10:05:20Z' })
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

    // 4b) Default configureAgyStatusLine emits `agy-hud render` (immune to Solo's legacy `statusline` hijacker)
    writeFileSync(
      paths.cliSettingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: canonicalNoForward, enabled: true, stack_with_default: true } }, null, 2)
    );
    const defaultAsyncRender = configureAgyStatusLine({ paths });
    assert.equal(defaultAsyncRender.mode, 'solo_async');
    assert.ok(defaultAsyncRender.command.endsWith('| agy-hud render'), `Default Solo async must use agy-hud render: ${defaultAsyncRender.command}`);
    assert.ok(soloBgMatchRe.test(defaultAsyncRender.command), 'Default agy-hud render async bypass must satisfy Solo bg_match');
    assertShellSyntaxValid(defaultAsyncRender.command);
    const defaultSyncRender = configureAgyStatusLine({ soloSync: true, paths });
    assert.equal(defaultSyncRender.mode, 'solo_chained');
    assert.ok(defaultSyncRender.command.includes("--forward-command 'agy-hud render'"), 'Default soloSync must forward to agy-hud render');
    assert.ok(!defaultSyncRender.command.includes("'agy-hud statusline'"), 'Default soloSync must not trigger Solo legacy statusline hijacker');
    assertShellSyntaxValid(defaultSyncRender.command);
    const uninstalledDefaultRender = configureAgyStatusLine({ uninstall: true, paths });
    assert.equal(uninstalledDefaultRender.mode, 'solo_preserved');
    assert.equal(uninstalledDefaultRender.command, canonicalNoForward);

    // 4c) CLI `agy-hud render` alias must produce identical output to `agy-hud statusline`
    const aliasInput = JSON.stringify({
      conversation_id: '11111111-2222-3333-4444-555555555555',
      terminal_width: 120,
      context_window: { context_window_size: 1_000_000, used_percentage: 33 }
    });
    const outStatuslineAlias = execFileSync(process.execPath, [BIN_PATH, 'statusline', '--no-color'], {
      env: { ...process.env, AGY_HUD_HOME: work, AGY_HUD_NO_BG_SYNC: '1' },
      input: aliasInput,
      encoding: 'utf8'
    });
    const outRenderAlias = execFileSync(process.execPath, [BIN_PATH, 'render', '--no-color'], {
      env: { ...process.env, AGY_HUD_HOME: work, AGY_HUD_NO_BG_SYNC: '1' },
      input: aliasInput,
      encoding: 'utf8'
    });
    assert.equal(outRenderAlias, outStatuslineAlias, 'agy-hud render alias must match agy-hud statusline byte-for-byte');

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

    // 4) Incremental seenSteps pruning for inactive >24h sessions keeps totals intact while retaining active <24h sessions
    const oldConv = '00000000-0000-4000-8000-00000000007d';
    const recentConv = '00000000-0000-4000-8000-00000000002a';
    const txDir = join(paths.cliBrainDir, oldConv, '.system_generated', 'logs');
    const recentDir = join(paths.cliBrainDir, recentConv, '.system_generated', 'logs');
    mkdirSync(txDir, { recursive: true });
    mkdirSync(recentDir, { recursive: true });
    const txFile = join(txDir, 'transcript.jsonl');
    const recentFile = join(recentDir, 'transcript.jsonl');
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
    writeFileSync(
      recentFile,
      `${JSON.stringify({
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        created_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        model: 'gemini-4-neon-xhigh',
        input_tokens: 5000,
        cache_read_tokens: 20000,
        output_tokens: 500
      })}\n`,
      'utf8'
    );
    const thirtyHoursAgo = new Date(Date.now() - 30 * 3_600_000);
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(txFile, thirtyHoursAgo, thirtyHoursAgo);
    utimesSync(recentFile, twoHoursAgo, twoHoursAgo);
    const inc = runIncrementalSync({ scope: 'cli_only', paths, now: new Date() });
    const savedState = JSON.parse(readFileSync(paths.cursorStatePath, 'utf8'));
    assert.deepEqual(savedState.files[txFile].seenSteps, {}, 'Inactive >24h file must prune seenSteps');
    assert.equal(savedState.files[txFile].session.turns, 1, 'Pruned file must retain session turns');
    assert.equal(savedState.files[txFile].session.inputTokens, 10000, 'Pruned file must retain token totals');
    assert.ok(Object.keys(savedState.files[recentFile].seenSteps).length === 1, 'Recent <24h active file must retain seenSteps');
    const { summary: composedSum } = composeSnapshot({
      incrementalResult: inc,
      buildSessionFn: buildSessionMetricsFromIncremental,
      paths
    });
    assert.equal(composedSum.sync_interval_ms, 2000, 'Composed summary must expose sync_interval_ms');

    pass('Statusline anti-kill hardening (bounded stdin, write dedup, sync.lock & >24h seenSteps pruning)');
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
    assert.ok(existsSync(join(tempPlugins, 'agy-cli-hud', 'lib', 'sqlite_timing.mjs')));
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

function encodeVarint(value) {
  let v = BigInt(value);
  const bytes = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    bytes.push(b);
  } while (v > 0n);
  return Buffer.from(bytes);
}

function pbVarintField(fn, value) {
  return Buffer.concat([encodeVarint((fn << 3) | 0), encodeVarint(value)]);
}

function pbBytesField(fn, buf) {
  return Buffer.concat([encodeVarint((fn << 3) | 2), encodeVarint(buf.length), buf]);
}

function pbDurationField(fn, sec, nanos) {
  const parts = [];
  if (sec > 0) parts.push(pbVarintField(1, sec));
  if (nanos > 0) parts.push(pbVarintField(2, nanos));
  return pbBytesField(fn, Buffer.concat(parts));
}

function buildMockGenMetadataBlob({ outputTokens = 0, thinkingTokens = 0, responseTokens = 0, ttft = null, streaming = null, stepIndices = [], padBytes = 0 } = {}) {
  const f1Parts = [];
  if (outputTokens > 0 || thinkingTokens > 0 || responseTokens > 0) {
    const uParts = [];
    if (outputTokens > 0) uParts.push(pbVarintField(3, outputTokens));
    if (thinkingTokens > 0) uParts.push(pbVarintField(9, thinkingTokens));
    if (responseTokens > 0) uParts.push(pbVarintField(10, responseTokens));
    f1Parts.push(pbBytesField(4, Buffer.concat(uParts)));
  }
  if (padBytes > 0) {
    // Simulated large fn=9 chatStartMetadata payload (>16KB slicing path)
    f1Parts.push(pbBytesField(9, Buffer.alloc(padBytes, 0x41)));
  }
  if (ttft) {
    f1Parts.push(pbDurationField(11, ttft.sec, ttft.nanos));
  }
  if (streaming) {
    f1Parts.push(pbDurationField(12, streaming.sec, streaming.nanos));
  }
  // Trailing anchor field fn=19 responseModel so adjacent-tag validation after fn=12 always succeeds
  f1Parts.push(pbBytesField(19, Buffer.from('gemini-4-neon-xhigh', 'utf8')));

  const topParts = [pbBytesField(1, Buffer.concat(f1Parts))];
  if (stepIndices.length) {
    topParts.push(pbBytesField(2, Buffer.concat(stepIndices.map((n) => encodeVarint(n)))));
  }
  return Buffer.concat(topParts);
}

async function testAccurateSpeedTiming() {
  const work = mkdtempSync(join(tmpdir(), 'agy-hud-speed-'));
  const prevHome = process.env.AGY_HUD_HOME;
  process.env.AGY_HUD_HOME = work;
  try {
    const paths = resolveHudPaths();
    const convA = '00000000-0000-4000-8000-0000000000a1';
    const convB = '00000000-0000-4000-8000-0000000000b2';
    const dirA = join(paths.cliBrainDir, convA, '.system_generated', 'logs');
    const dirB = join(paths.cliBrainDir, convB, '.system_generated', 'logs');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const txA = join(dirA, 'transcript.jsonl');
    const txB = join(dirB, 'transcript.jsonl');

    // 1) Regression: previous tool step took only 2s, while actual PLANNER_RESPONSE took 10s (811 tokens).
    //    Old buggy formula computed 811 / 2 = 405.5 t/s; fixed forward duration must yield 811 / 10 = 81.1 t/s.
    //    Subsequent USER_INPUT 120s later (human reading pause) must NOT corrupt 81.1 t/s.
    writeFileSync(
      txA,
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-27T01:00:00Z' }),
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-27T01:00:00Z', model: 'gemini-4-neon-xhigh', input_tokens: 10000, cache_read_tokens: 90000, output_tokens: 400 }),
        JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', created_at: '2026-11-27T01:00:05Z' }),
        // Fast 2s gap from step 2 -> step 3 (tool runtime!), then step 3 actually runs 10s (01:00:07 -> 01:00:17)
        JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-27T01:00:07Z', model: 'gemini-4-neon-xhigh', input_tokens: 5000, cache_read_tokens: 95000, output_tokens: 811 }),
        JSON.stringify({ step_index: 4, type: 'GENERIC', status: 'DONE', created_at: '2026-11-27T01:00:17Z' }),
        // Human pause 120s before next USER_INPUT must never clobber 81.1 t/s
        JSON.stringify({ step_index: 5, type: 'USER_INPUT', created_at: '2026-11-27T01:02:17Z' })
      ].join('\n') + '\n',
      'utf8'
    );

    // Seed stale v1 cursor cache with bogus 405.5 t/s to verify STATE_VERSION=2 invalidates it cleanly
    mkdirSync(paths.dataDir, { recursive: true });
    writeFileSync(
      paths.cursorStatePath,
      JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        files: {
          [txA]: {
            sessionId: convA,
            source: 'cli',
            offset: statSync(txA).size,
            size: statSync(txA).size,
            mtimeMs: statSync(txA).mtimeMs,
            seenSteps: {},
            session: { sessionId: convA, source: 'cli', turns: 2, lastOutputTps: 405.5 },
            byDay: {}
          }
        }
      }),
      'utf8'
    );

    // 2) Final reply with no following tool step: EOF mtimeMs fallback (start + 8s -> 800 / 8 = 100.0 t/s)
    const startB = Date.parse('2026-11-27T01:10:00Z');
    writeFileSync(
      txB,
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-27T01:10:00Z' }),
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-27T01:10:00Z', model: 'gemini-4-neon-xhigh', input_tokens: 8000, cache_read_tokens: 32000, output_tokens: 800 })
      ].join('\n') + '\n',
      'utf8'
    );
    const flushB = new Date(startB + 8000);
    utimesSync(txB, flushB, flushB);

    const inc = runIncrementalSync({ scope: 'cli_only', paths, now: new Date('2026-11-27T01:15:00Z') });
    const mA = buildSessionMetricsFromIncremental(inc.sessionsById.get(convA));
    const mB = buildSessionMetricsFromIncremental(inc.sessionsById.get(convB));
    assert.equal(mA.output_tps, 81.1, `Forward step duration must yield 81.1 t/s (never 405.5 t/s), got ${mA.output_tps}`);
    assert.equal(mB.output_tps, 100.0, `EOF mtimeMs fallback must yield 100.0 t/s, got ${mB.output_tps}`);

    // Verify protobuf decoder directly on large >16KB blob slicing
    const largeBlob = buildMockGenMetadataBlob({
      outputTokens: 1638,
      thinkingTokens: 728,
      responseTokens: 910,
      ttft: { sec: 4, nanos: 952_000_000 },
      streaming: { sec: 10, nanos: 133_000_000 },
      stepIndices: [9, 10],
      padBytes: 24_000
    });
    const decodedLarge = decodeGenMetadataTimingRow(largeBlob.subarray(0, 8192), largeBlob.subarray(-4096));
    assert.equal(decodedLarge.usage?.outputTokens, 1638);
    assert.equal(decodedLarge.ttft, 4.952);
    assert.equal(decodedLarge.streamingSec, 10.133);

    // 3) SQLite gen_metadata exact server timing priority + skipping in-progress row + CLI e2e
    if (await isSqliteAvailable()) {
      const { DatabaseSync } = await import('node:sqlite');
      mkdirSync(paths.cliConversationsDir, { recursive: true });
      const dbPath = join(paths.cliConversationsDir, `${convA}.db`);
      const db = new DatabaseSync(dbPath);
      try {
        db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
        const ins = db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)');
        // idx=1: completed large row (1638 / (4.952 + 10.133) = 108.6 t/s, ttft_ms = 4952)
        ins.run(1, largeBlob);
        // idx=2: newest row currently IN PROGRESS (no usage / no ttft / no streamingSec)
        ins.run(2, buildMockGenMetadataBlob({ stepIndices: [11] }));
      } finally {
        db.close();
      }

      const enrich1 = await enrichSessionsWithSqliteTiming({
        incrementalResult: inc,
        paths,
        explicitSessionId: convA
      });
      assert.equal(enrich1.changed, true, 'SQLite timing enrichment must detect new DB');
      const mASql = buildSessionMetricsFromIncremental(inc.sessionsById.get(convA));
      assert.equal(mASql.output_tps, 108.6, `SQLite exact timing must yield 108.6 t/s (skipping in-progress idx=2), got ${mASql.output_tps}`);
      assert.equal(mASql.ttft_ms, 4952, `SQLite exact timing must populate ttft_ms=4952, got ${mASql.ttft_ms}`);

      // Second call with unchanged DB signature must hit cache (changed=false)
      const enrich2 = await enrichSessionsWithSqliteTiming({
        incrementalResult: inc,
        paths,
        explicitSessionId: convA
      });
      assert.equal(enrich2.changed, false, 'Unchanged DB signature must skip re-reading SQLite');

      // End-to-end `agy-hud sync` -> `agy-hud statusline` must display 108.6 t/s (never 405.5)
      const syncSnap = JSON.parse(execFileSync(process.execPath, [BIN_PATH, 'sync', '--session', convA], {
        env: { ...process.env, AGY_HUD_HOME: work },
        encoding: 'utf8'
      }));
      assert.equal(syncSnap.active_session.output_tps, 108.6);
      assert.equal(syncSnap.active_session.ttft_ms, 4952);

      const slOut = stripAnsi(execFileSync(process.execPath, [BIN_PATH, 'statusline', '--no-color'], {
        env: { ...process.env, AGY_HUD_HOME: work, AGY_HUD_NO_BG_SYNC: '1' },
        input: JSON.stringify({
          conversation_id: convA,
          terminal_width: 120,
          context_window: { context_window_size: 1_000_000, used_percentage: 14 }
        }),
        encoding: 'utf8'
      }));
      assert.ok(slOut.includes('108.6 t/s') && !slOut.includes('405.5'), `Statusline must render exact 108.6 t/s: ${slOut}`);
    }

    pass('Accurate speed timing (SQLite exact ttft+streaming, in-progress skip, forward transcript fallback & v1 cache reset)');
  } finally {
    if (prevHome === undefined) delete process.env.AGY_HUD_HOME;
    else process.env.AGY_HUD_HOME = prevHome;
    rmSync(work, { recursive: true, force: true });
  }
}

function testDailyWeeklyQuotaTrackerAndReset() {
  const work = mkdtempSync(join(tmpdir(), 'agy-hud-weekly-'));
  const prevHome = process.env.AGY_HUD_HOME;
  process.env.AGY_HUD_HOME = work;
  try {
    // Use local-time Date constructors so calendar-day assertions work in every timezone
    const localMs = (y, m, d, hh, mm, ss = 0) => new Date(y, m - 1, d, hh, mm, ss, 0).getTime();
    const localSec = (y, m, d, hh, mm, ss = 0) => Math.floor(localMs(y, m, d, hh, mm, ss) / 1000);

    // 1) Normal mid-week accumulation + oscillation & stale multi-tab protection
    const t0900 = localMs(2026, 11, 27, 9, 0);
    const midWeekReset = localSec(2026, 12, 1, 14, 0);
    let e = applyWeeklyPoolObservation(null, { weekly_remaining_percent: 64, weekly_resets_at: midWeekReset }, { nowMs: t0900 });
    assert.equal(e.changed, true);
    assert.equal(e.entry.used_today_percent, 0);
    assert.equal(e.entry.reset_count_today, 0);

    e = applyWeeklyPoolObservation(e.entry, { weekly_remaining_percent: 60.5, weekly_resets_at: midWeekReset }, { nowMs: localMs(2026, 11, 27, 10, 0) });
    assert.equal(e.changed, true);
    assert.equal(e.entry.used_today_percent, 3.5);

    e = applyWeeklyPoolObservation(e.entry, { weekly_remaining_percent: 50, weekly_resets_at: midWeekReset }, { nowMs: localMs(2026, 11, 27, 11, 0) });
    assert.equal(e.entry.used_today_percent, 14);

    // Rounding jitter (+0.2%) & stale idle tab (61%) in same cycle must NOT inflate usage
    const jitter = applyWeeklyPoolObservation(e.entry, { weekly_remaining_percent: 50.2, weekly_resets_at: midWeekReset }, { nowMs: localMs(2026, 11, 27, 11, 5) });
    assert.equal(jitter.changed, false);
    assert.equal(jitter.entry.used_today_percent, 14);
    const staleTab = applyWeeklyPoolObservation(jitter.entry, { weekly_remaining_percent: 61, weekly_resets_at: midWeekReset }, { nowMs: localMs(2026, 11, 27, 11, 6) });
    assert.equal(staleTab.changed, false);
    assert.equal(staleTab.entry.used_today_percent, 14);
    e = applyWeeklyPoolObservation(staleTab.entry, { weekly_remaining_percent: 48, weekly_resets_at: midWeekReset }, { nowMs: localMs(2026, 11, 27, 11, 10) });
    assert.equal(e.entry.used_today_percent, 16);

    // 2) Mid-day weekly reset: pre-reset 23% (35% -> 12%) + post-reset 6% (100% -> 94%) -> 29%, then 82% -> 41%
    const resetToday14 = localSec(2026, 11, 27, 14, 0);
    const resetNextWk14 = localSec(2026, 12, 4, 14, 0);
    let r = applyWeeklyPoolObservation(null, { weekly_remaining_percent: 35, weekly_resets_at: resetToday14 }, { nowMs: localMs(2026, 11, 27, 9, 0) });
    r = applyWeeklyPoolObservation(r.entry, { weekly_remaining_percent: 12, weekly_resets_at: resetToday14 }, { nowMs: localMs(2026, 11, 27, 13, 50) });
    assert.equal(r.entry.used_today_percent, 23);
    assert.equal(r.entry.reset_count_today, 0);

    r = applyWeeklyPoolObservation(r.entry, { weekly_remaining_percent: 94, weekly_resets_at: resetNextWk14 }, { nowMs: localMs(2026, 11, 27, 14, 5) });
    assert.equal(r.changed, true);
    assert.equal(r.entry.reset_count_today, 1);
    assert.equal(r.entry.pre_reset_used_percent, 23);
    assert.equal(r.entry.used_today_percent, 29);

    r = applyWeeklyPoolObservation(r.entry, { weekly_remaining_percent: 82, weekly_resets_at: resetNextWk14 }, { nowMs: localMs(2026, 11, 27, 16, 0) });
    assert.equal(r.entry.used_today_percent, 41);
    assert.equal(r.entry.pre_reset_used_percent, 23);
    assert.equal(r.entry.reset_count_today, 1);

    // Stale pre-reset tab arriving AFTER reset must be completely ignored
    const staleOldCycle = applyWeeklyPoolObservation(r.entry, { weekly_remaining_percent: 10, weekly_resets_at: resetToday14 }, { nowMs: localMs(2026, 11, 27, 16, 1) });
    assert.equal(staleOldCycle.changed, false);
    assert.equal(staleOldCycle.entry.used_today_percent, 41);

    // 3) Extreme mid-day reset cases: >100% cumulative across reset & post-reset rem lower than pre-reset rem
    let over = applyWeeklyPoolObservation(null, { weekly_remaining_percent: 90, weekly_resets_at: resetToday14 }, { nowMs: localMs(2026, 11, 27, 9, 0) });
    over = applyWeeklyPoolObservation(over.entry, { weekly_remaining_percent: 10, weekly_resets_at: resetToday14 }, { nowMs: localMs(2026, 11, 27, 13, 0) });
    assert.equal(over.entry.used_today_percent, 80);
    over = applyWeeklyPoolObservation(over.entry, { weekly_remaining_percent: 65, weekly_resets_at: resetNextWk14 }, { nowMs: localMs(2026, 11, 27, 17, 0) });
    assert.equal(over.entry.used_today_percent, 115, 'Cumulative today usage across a reset may exceed 100%');

    let lowerAfter = applyWeeklyPoolObservation(null, { weekly_remaining_percent: 100, weekly_resets_at: resetToday14 }, { nowMs: localMs(2026, 11, 27, 9, 0) });
    lowerAfter = applyWeeklyPoolObservation(lowerAfter.entry, { weekly_remaining_percent: 90, weekly_resets_at: resetToday14 }, { nowMs: localMs(2026, 11, 27, 13, 0) });
    lowerAfter = applyWeeklyPoolObservation(lowerAfter.entry, { weekly_remaining_percent: 85, weekly_resets_at: resetNextWk14 }, { nowMs: localMs(2026, 11, 27, 15, 0) });
    assert.equal(lowerAfter.entry.used_today_percent, 25, 'New cycle resets_at shift must add 100 - 85 = 15% even when rem < prevRem');

    // Missing resets_at fallback (>=10% upward jump)
    let noTs = applyWeeklyPoolObservation(null, { weekly_remaining_percent: 30, weekly_resets_at: null }, { nowMs: localMs(2026, 11, 27, 9, 0) });
    noTs = applyWeeklyPoolObservation(noTs.entry, { weekly_remaining_percent: 15, weekly_resets_at: null }, { nowMs: localMs(2026, 11, 27, 12, 0) });
    noTs = applyWeeklyPoolObservation(noTs.entry, { weekly_remaining_percent: 96, weekly_resets_at: null }, { nowMs: localMs(2026, 11, 27, 14, 10) });
    assert.equal(noTs.entry.reset_count_today, 1);
    assert.equal(noTs.entry.used_today_percent, 19);

    // 4) First-ever observation when weekly window started earlier TODAY (resets_at - 7d is today)
    const resetToday08NextWk = localSec(2026, 12, 4, 8, 0);
    const firstPostReset = applyWeeklyPoolObservation(null, { weekly_remaining_percent: 92, weekly_resets_at: resetToday08NextWk }, { nowMs: localMs(2026, 11, 27, 11, 30) });
    assert.equal(firstPostReset.entry.used_today_percent, 8);
    assert.equal(firstPostReset.entry.reset_count_today, 1);

    // 5) Midnight day rollovers, heartbeat refresh & baseline completeness:
    // 5a) Long overnight gap with unobserved drop (yesterday 18:00 @ 80% -> today 09:00 @ 60%) -> 0%+ with gap=20
    const yest18 = applyWeeklyPoolObservation(null, { weekly_remaining_percent: 80, weekly_resets_at: midWeekReset }, { nowMs: localMs(2026, 11, 26, 18, 0) }).entry;
    const today09 = applyWeeklyPoolObservation(yest18, { weekly_remaining_percent: 60, weekly_resets_at: midWeekReset }, { nowMs: localMs(2026, 11, 27, 9, 0) }).entry;
    assert.equal(today09.used_today_percent, 0);
    assert.equal(today09.reset_count_today, 0);
    assert.equal(today09.baseline_complete, false, 'Overnight unobserved drop must mark baseline_complete=false');
    assert.equal(today09.unobserved_gap_percent, 20, 'Overnight unobserved drop must record gap=20%');

    // 5a-2) Clean overnight rollover with zero drop (yesterday 22:00 @ 80% -> today 09:00 @ 80%) -> complete baseline
    const yest22 = applyWeeklyPoolObservation(null, { weekly_remaining_percent: 80, weekly_resets_at: midWeekReset }, { nowMs: localMs(2026, 11, 26, 22, 0) }).entry;
    const today09Clean = applyWeeklyPoolObservation(yest22, { weekly_remaining_percent: 80, weekly_resets_at: midWeekReset }, { nowMs: localMs(2026, 11, 27, 9, 0) }).entry;
    assert.equal(today09Clean.used_today_percent, 0);
    assert.equal(today09Clean.baseline_complete, true, 'Zero overnight drop from yesterday must mark baseline_complete=true');
    assert.equal(today09Clean.unobserved_gap_percent, 0);
    const cold100 = applyWeeklyPoolObservation(null, { weekly_remaining_percent: 100, weekly_resets_at: midWeekReset }, { nowMs: localMs(2026, 11, 27, 9, 0) }).entry;
    assert.equal(cold100.baseline_complete, true, '100% remaining on cold start has complete baseline');

    // Legacy v1 entry without first_observed_at_ms that already consumed quota must NOT misreport last_observed_at_ms as start time
    const legacyMigrated = applyWeeklyPoolObservation({
      day_key: '2026-11-27',
      used_today_percent: 1.6,
      pre_reset_used_percent: 0,
      reset_count_today: 0,
      cycle_start_remaining_percent: 88.1,
      cycle_min_remaining_percent: 86.5,
      last_remaining_percent: 86.5,
      last_resets_at: midWeekReset,
      last_observed_at_ms: localMs(2026, 11, 27, 13, 55)
    }, { weekly_remaining_percent: 86.4, weekly_resets_at: midWeekReset }, { nowMs: localMs(2026, 11, 27, 13, 58) }).entry;
    assert.equal(legacyMigrated.baseline_complete, false);
    assert.equal(legacyMigrated.first_observed_at_ms, null, 'Legacy entry with used > 0 must keep first_observed_at_ms=null');
    assert.equal(legacyMigrated.used_today_percent, 1.7);

    // 5b) Active midnight-spanning turn (yesterday 23:50 @ 72% -> today 00:05 @ 70%) -> bridges 2%
    const yest2350 = applyWeeklyPoolObservation(null, { weekly_remaining_percent: 72, weekly_resets_at: midWeekReset }, { nowMs: localMs(2026, 11, 26, 23, 50) }).entry;
    const today0005 = applyWeeklyPoolObservation(yest2350, { weekly_remaining_percent: 70, weekly_resets_at: midWeekReset }, { nowMs: localMs(2026, 11, 27, 0, 5) }).entry;
    assert.equal(today0005.used_today_percent, 2);
    assert.equal(today0005.baseline_complete, true);

    // 5b-2) Heartbeat refresh regression: 21:00 drop (80%), active again at 23:55 (still 80%) refreshes
    // last_observed_at_ms while stale tab (85%) does NOT, so 00:05 turn (78%) bridges 2% accurately
    const yest21 = applyWeeklyPoolObservation(null, { weekly_remaining_percent: 80, weekly_resets_at: midWeekReset }, { nowMs: localMs(2026, 11, 26, 21, 0) }).entry;
    const hb2355 = applyWeeklyPoolObservation(yest21, { weekly_remaining_percent: 80, weekly_resets_at: midWeekReset }, { nowMs: localMs(2026, 11, 26, 23, 55) });
    assert.equal(hb2355.changed, true, 'Throttled heartbeat (>=8m) with current rem must refresh last_observed_at_ms');
    assert.equal(hb2355.entry.last_observed_at_ms, localMs(2026, 11, 26, 23, 55));
    const stale2356 = applyWeeklyPoolObservation(hb2355.entry, { weekly_remaining_percent: 85, weekly_resets_at: midWeekReset }, { nowMs: localMs(2026, 11, 26, 23, 56) });
    assert.equal(stale2356.changed, false, 'Stale tab with higher rem must not trigger heartbeat refresh');
    const bridgedAfterHb = applyWeeklyPoolObservation(hb2355.entry, { weekly_remaining_percent: 78, weekly_resets_at: midWeekReset }, { nowMs: localMs(2026, 11, 27, 0, 5) }).entry;
    assert.equal(bridgedAfterHb.used_today_percent, 2, 'Heartbeat-refreshed late-night session must bridge midnight turn');
    assert.equal(bridgedAfterHb.baseline_complete, true);

    // 5c) Overnight reset that happened TODAY at 08:00 (first sample at 09:30 is 95%) -> 5% + reset_count_today=1
    const yestBeforeReset = applyWeeklyPoolObservation(null, { weekly_remaining_percent: 20, weekly_resets_at: localSec(2026, 11, 27, 8, 0) }, { nowMs: localMs(2026, 11, 26, 22, 0) }).entry;
    const todayAfterMorningReset = applyWeeklyPoolObservation(yestBeforeReset, { weekly_remaining_percent: 95, weekly_resets_at: resetToday08NextWk }, { nowMs: localMs(2026, 11, 27, 9, 30) }).entry;
    assert.equal(todayAfterMorningReset.used_today_percent, 5);
    assert.equal(todayAfterMorningReset.reset_count_today, 1);
    assert.equal(todayAfterMorningReset.baseline_complete, true);

    // 5d) Reset happened 2 days ago (not today) -> clean 0%+ partial baseline
    const threeDaysAgo = applyWeeklyPoolObservation(null, { weekly_remaining_percent: 20, weekly_resets_at: localSec(2026, 11, 25, 8, 0) }, { nowMs: localMs(2026, 11, 24, 18, 0) }).entry;
    const todayOldReset = applyWeeklyPoolObservation(threeDaysAgo, { weekly_remaining_percent: 85, weekly_resets_at: localSec(2026, 12, 2, 8, 0) }, { nowMs: localMs(2026, 11, 27, 9, 30) }).entry;
    assert.equal(todayOldReset.used_today_percent, 0);
    assert.equal(todayOldReset.reset_count_today, 0);
    assert.equal(todayOldReset.baseline_complete, false);

    // 5e) Desktop host_status_cache_v1.json multi-LS entries parsing & same-day earlier anchor backfill
    const mockDesktopHostCache = {
      version: 1,
      entries: {
        ls_stale: {
          at: localMs(2026, 11, 27, 8, 0),
          quotaStatus: { stale: true, summaryStale: true },
          quotaSummaryGroups: [{
            displayName: 'Gemini Models',
            buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.99, resetTime: new Date(midWeekReset * 1000).toISOString() }]
          }]
        },
        ls_afternoon: {
          at: localMs(2026, 11, 27, 12, 0),
          quotaStatus: { stale: false, summaryStale: false },
          quotaSummaryGroups: [
            {
              displayName: 'Gemini Models',
              buckets: [
                { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.80, resetTime: new Date(localMs(2026, 11, 27, 14, 0)).toISOString() },
                { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.85, resetTime: new Date(midWeekReset * 1000).toISOString() }
              ]
            },
            {
              displayName: 'Claude and GPT models',
              buckets: [
                { bucketId: '3p-5h', window: '5h', remainingFraction: 1 },
                { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.63, resetTime: new Date(midWeekReset * 1000).toISOString() }
              ]
            }
          ]
        },
        ls_morning: {
          at: localMs(2026, 11, 27, 9, 0),
          quotaStatus: { stale: false, summaryStale: false },
          quotas: [
            {
              id: 'summary:gemini models|gemini-5h+gemini-weekly',
              fiveHour: { remainingFraction: 0.95 },
              weekly: { remainingFraction: 0.95, resetTime: new Date(midWeekReset * 1000).toISOString() }
            }
          ]
        }
      }
    };
    const hostObs = extractHostCacheObservations(mockDesktopHostCache);
    assert.equal(hostObs.length, 2, 'extractHostCacheObservations must parse multi-LS entries and skip stale entries');
    assert.equal(hostObs[0].observed_at_ms, localMs(2026, 11, 27, 9, 0));
    assert.equal(hostObs[0].pools[0].weekly_remaining_percent, 95);
    assert.equal(hostObs[1].observed_at_ms, localMs(2026, 11, 27, 12, 0));
    assert.equal(hostObs[1].pools[0].weekly_remaining_percent, 85);
    const normNewest = normalizeHostCacheQuotas(mockDesktopHostCache);
    assert.equal(normNewest.pools.find((p) => p.id === 'gemini')?.weekly_remaining_percent, 85);

    // Backfill earlier-same-day Desktop anchor (09:00 @ 95%) after CLI cold-started at 11:00 @ 88%,
    // then apply later Desktop observation (12:00 @ 85%) -> 10% total (95% -> 85%)
    let merged = updateWeeklyQuotaLedger(null, [{ id: 'gemini', weekly_remaining_percent: 88, weekly_resets_at: midWeekReset }], { nowMs: localMs(2026, 11, 27, 11, 0) });
    assert.equal(merged.byPool.gemini.used_today_percent, 0);
    assert.equal(merged.byPool.gemini.baseline_complete, false);
    for (const obs of hostObs) {
      merged = updateWeeklyQuotaLedger(merged.ledger, obs.pools, {
        nowMs: obs.observed_at_ms,
        onlyIfNewer: true,
        allowEarlierSameDayAnchor: true
      });
    }
    assert.equal(merged.byPool.gemini.used_today_percent, 10, 'Earlier-same-day Desktop anchor + forward sync must compute 95% -> 85% = 10%');
    assert.equal(merged.byPool.gemini.first_observed_at_ms, localMs(2026, 11, 27, 9, 0));

    // End-to-end composeSnapshot wiring with Desktop host_status_cache_v1.json (backfill + forward)
    const snapDeskWork = mkdtempSync(join(tmpdir(), 'agy-hud-desk-'));
    const prevDeskHome = process.env.AGY_HUD_HOME;
    try {
      process.env.AGY_HUD_HOME = snapDeskWork;
      const dPaths = resolveHudPaths();
      const nowLiveMs = Date.now();
      const todayStart = new Date(nowLiveMs);
      todayStart.setHours(0, 0, 0, 0);
      const dayStartMs = todayStart.getTime();
      const span = Math.max(3000, nowLiveMs - dayStartMs);
      const tAnchorMs = dayStartMs + Math.floor(span * 0.25);
      const tCliMs = dayStartMs + Math.floor(span * 0.6);
      const tLiveMs = dayStartMs + span;
      const liveResetIso = new Date(tLiveMs + 4 * 86_400_000).toISOString();
      mkdirSync(dirname(dPaths.desktopHostCachePath), { recursive: true });
      writeFileSync(dPaths.desktopHostCachePath, JSON.stringify({
        version: 1,
        entries: {
          ls_morning: {
            at: tAnchorMs,
            quotaStatus: { stale: false, summaryStale: false },
            quotaSummaryGroups: [{
              displayName: 'Gemini Models',
              buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.96, resetTime: liveResetIso }]
            }]
          }
        }
      }));
      // Simulate CLI cold-starting later today at 90% before background sync runs composeSnapshot
      mkdirSync(dPaths.dataDir, { recursive: true });
      const cliInit = updateWeeklyQuotaLedger(null, [{
        id: 'gemini',
        weekly_remaining_percent: 90,
        weekly_resets_at: Math.round(Date.parse(liveResetIso) / 1000)
      }], { nowMs: tCliMs });
      writeFileSync(dPaths.quotaLedgerPath, JSON.stringify(cliInit.ledger));
      const { snapshot: deskSnap } = composeSnapshot({
        incrementalResult: null,
        buildSessionFn: null,
        liveFacts: {
          observed_at: Math.floor(tLiveMs / 1000),
          observed_at_ms: tLiveMs,
          has_stdin_payload: true,
          quotas: normalizeAgyQuotaMap({
            'gemini-weekly': { remaining_fraction: 0.89, resets_at: Math.round(Date.parse(liveResetIso) / 1000) }
          }, { nowMs: tLiveMs })
        },
        paths: dPaths
      });
      assert.equal(deskSnap.quotas.gemini.weekly.used_today_percent, 7, 'composeSnapshot must backfill morning Desktop 96% anchor -> live 89% = 7%');
      assert.equal(deskSnap.quotas.gemini.weekly.first_observed_at_ms, tAnchorMs);
    } finally {
      if (prevDeskHome === undefined) delete process.env.AGY_HUD_HOME;
      else process.env.AGY_HUD_HOME = prevDeskHome;
      rmSync(snapDeskWork, { recursive: true, force: true });
    }

    // 6) Statusline rendering: complete vs partial baseline (+), 2-line + genuine 3-line + reset ↻ tag + stale-day guard
    const now16 = localMs(2026, 11, 27, 16, 0);
    const ledgerWithReset = {
      version: 1,
      updated_at_ms: now16,
      pools: {
        gemini: { ...r.entry, baseline_complete: true },
        non_gemini: {
          ...applyWeeklyPoolObservation(
            applyWeeklyPoolObservation(null, { weekly_remaining_percent: 91, weekly_resets_at: midWeekReset }, { nowMs: localMs(2026, 11, 27, 9, 0) }).entry,
            { weekly_remaining_percent: 88, weekly_resets_at: midWeekReset },
            { nowMs: now16 }
          ).entry,
          baseline_complete: true
        }
      }
    };
    const renderPayload = {
      conversation_id: '11111111-2222-3333-4444-555555555555',
      terminal_width: 120,
      context_window: { context_window_size: 1_000_000, used_percentage: 40 },
      quota: {
        'gemini-5h': { remaining_fraction: 0.75, resets_at: Math.floor(now16 / 1000) + 7200 },
        'gemini-weekly': { remaining_fraction: 0.82, resets_at: resetNextWk14 },
        '3p-5h': { remaining_fraction: 0.90, resets_at: Math.floor(now16 / 1000) + 14400 },
        '3p-weekly': { remaining_fraction: 0.88, resets_at: midWeekReset }
      }
    };
    const renderSummaryNoColab = {
      lines: 3,
      color: false,
      session_id: '11111111-2222-3333-4444-555555555555',
      avg_cache: 85,
      tps: 60,
      sess_cost: 1.2,
      sess_saved: 3.4,
      today_tokens: 2_000_000,
      today_cost: 5.5,
      month_tokens: 40_000_000,
      month_cost: 110
    };
    const out3NoColab = stripAnsi(renderStatusLine(renderPayload, renderSummaryNoColab, {
      lines: 3,
      color: false,
      nowMs: now16,
      quotaLedger: ledgerWithReset
    }));
    const rows3NoColab = out3NoColab.split('\n');
    assert.equal(rows3NoColab.length, 3, `3-line mode without Colab must produce 3 balanced lines:\n${out3NoColab}`);
    assert.ok(rows3NoColab[0].includes('40%') && rows3NoColab[0].includes('本会话 $1.20'));
    assert.ok(rows3NoColab[1].includes('今日 2.00M') && rows3NoColab[1].includes('本月 40.0M'));
    assert.ok(
      rows3NoColab[2].includes('周 余82% (今用41%↻)') && rows3NoColab[2].includes('周 余88% (今用3%)'),
      `3-line L3 must show clean complete-baseline weekly consumption:\n${rows3NoColab[2]}`
    );

    // Partial baseline must clearly surface `+` so mid-day cold starts never masquerade as full-day totals
    const partialLedger = {
      ...ledgerWithReset,
      pools: {
        gemini: { ...r.entry, baseline_complete: false },
        non_gemini: { ...ledgerWithReset.pools.non_gemini, baseline_complete: false }
      }
    };
    const outPartial = stripAnsi(renderStatusLine(renderPayload, renderSummaryNoColab, {
      lines: 2,
      color: false,
      nowMs: now16,
      quotaLedger: partialLedger
    }));
    assert.ok(
      outPartial.includes('周 余82% (今用41%+↻)') && outPartial.includes('周 余88% (今用3%+)'),
      `Partial baseline must render '+' suffix transparently:\n${outPartial}`
    );

    // 2-line wide also displays today's weekly consumption cleanly
    const out2Reset = stripAnsi(renderStatusLine(renderPayload, renderSummaryNoColab, {
      lines: 2,
      color: false,
      nowMs: now16,
      quotaLedger: ledgerWithReset
    }));
    assert.equal(out2Reset.split('\n').length, 2);
    assert.ok(out2Reset.split('\n')[1].includes('周 余82% (今用41%↻)') && out2Reset.split('\n')[1].includes('周 余88% (今用3%)'));

    // Stale summary from yesterday without live quota must NOT show yesterday's weekly usage
    const staleSummaryOut = stripAnsi(renderStatusLine(null, {
      lines: 2,
      color: false,
      quota_day: '2026-11-26',
      today_tokens: 0,
      today_cost: 0,
      pools: [{ id: 'gemini', five_hour_remaining_percent: 80, weekly_remaining_percent: 64, weekly_used_today_percent: 25, weekly_reset_count_today: 1 }]
    }, { lines: 2, color: false, nowMs: now16 }));
    assert.ok(!staleSummaryOut.includes('今用'), `Stale yesterday summary must hide weekly_used_today_percent: ${staleSummaryOut}`);

    // 7) CLI end-to-end across multiple statusline turns + mid-day weekly reset -> status & snapshot
    const paths = resolveHudPaths();
    const envCli = { ...process.env, AGY_HUD_HOME: work, AGY_HUD_NO_BG_SYNC: '1' };
    const nowSecLive = Math.floor(Date.now() / 1000);
    const oldResetLive = nowSecLive + 7200; // resets in 2h (today)
    const newResetLive = oldResetLive + 7 * 86_400; // shifted +7d after reset
    const runSl = (quota) => stripAnsi(execFileSync(process.execPath, [BIN_PATH, 'statusline', '--no-color'], {
      env: envCli,
      input: JSON.stringify({
        conversation_id: '11111111-2222-3333-4444-555555555555',
        terminal_width: 120,
        context_window: { context_window_size: 1_000_000, used_percentage: 20 },
        quota
      }),
      encoding: 'utf8'
    }));

    const turn1 = runSl({ 'gemini-5h': { remaining_fraction: 0.9 }, 'gemini-weekly': { remaining_fraction: 0.40, resets_at: oldResetLive } });
    assert.ok(turn1.includes('周 余40% (今用0%+)'), `Cold-start mid-week Turn 1 must initialize at 0%+: ${turn1}`);

    const turn2 = runSl({ 'gemini-5h': { remaining_fraction: 0.8 }, 'gemini-weekly': { remaining_fraction: 0.25, resets_at: oldResetLive } });
    assert.ok(turn2.includes('周 余25% (今用15%+)'), `Turn 2 must accumulate 15%+: ${turn2}`);

    const turn3 = runSl({ 'gemini-5h': { remaining_fraction: 0.95 }, 'gemini-weekly': { remaining_fraction: 0.92, resets_at: newResetLive } });
    assert.ok(turn3.includes('周 余92% (今用23%+↻)'), `Turn 3 after reset on partial-start day must show 23%+↻: ${turn3}`);

    assert.ok(existsSync(paths.quotaLedgerPath), 'quota_daily.v1.json must be persisted');
    const statusText = execFileSync(process.execPath, [BIN_PATH, 'status'], { env: envCli, encoding: 'utf8' });
    assert.ok(
      /今日周耗 23%\+（自 \d{2}:\d{2} 起计；今日已重置：重置前 15% \+ 重置后 8%）/.test(statusText),
      `agy-hud status must display transparent start-time & pre/post reset breakdown:\n${statusText}`
    );
    const snapJson = JSON.parse(readFileSync(paths.snapshotPath, 'utf8'));
    assert.equal(snapJson.quotas.gemini.weekly.used_today_percent, 23);
    assert.equal(snapJson.quotas.gemini.weekly.pre_reset_used_percent, 15);
    assert.equal(snapJson.quotas.gemini.weekly.post_reset_used_percent, 8);
    assert.equal(snapJson.quotas.gemini.weekly.reset_count_today, 1);
    assert.equal(snapJson.quotas.gemini.weekly.baseline_complete, false);
    assert.ok(statSync(paths.summaryPath).size < 4096, 'summary with daily weekly fields must remain < 4KB');

    // Quick updateWeeklyQuotaLedger multi-pool sanity
    const multi = updateWeeklyQuotaLedger(null, normalizeAgyQuotaMap({
      'gemini-weekly': { remaining_fraction: 0.8, resets_at: midWeekReset },
      '3p-weekly': { remaining_fraction: 0.9, resets_at: midWeekReset }
    }).pools, { nowMs: t0900 });
    assert.equal(multi.byPool.gemini.used_today_percent, 0);
    assert.equal(multi.byPool.non_gemini.used_today_percent, 0);

    // 8) CJK display-width anti-overflow matrix across 1/2/3 lines, +/- Colab, heavy worst-case metrics (including +↻) & widths 60..140
    const heavyPayload = (width) => ({
      conversation_id: '11111111-2222-3333-4444-555555555555',
      terminal_width: width,
      context_window: {
        context_window_size: 1_048_576,
        used_percentage: 98,
        current_usage: { input_tokens: 800_000, cache_read_input_tokens: 180_000, cache_creation_input_tokens: 0 }
      },
      cost: { total_usd: 12.45 },
      quota: {
        'gemini-5h': { remaining_fraction: 0.12, resets_at: Math.floor(now16 / 1000) + 17460 },
        'gemini-weekly': { remaining_fraction: 0.64, resets_at: resetNextWk14 },
        '3p-5h': { remaining_fraction: 0.15, resets_at: Math.floor(now16 / 1000) + 17460 },
        '3p-weekly': { remaining_fraction: 0.88, resets_at: midWeekReset }
      }
    });
    const heavyBaseSummary = {
      lines: 2,
      color: false,
      session_id: '11111111-2222-3333-4444-555555555555',
      avg_cache: 18,
      last_cache: 18,
      cold_start: true,
      tps: 142.8,
      sess_cost: 12.45,
      sess_saved: 48.2,
      today_tokens: 24_200_000,
      today_cost: 68.5,
      month_tokens: 685_000_000,
      month_cost: 1924
    };
    const heavyColab = {
      tier: 'PRO+',
      cu: 184.2,
      rate: 13.1,
      hrs: 14.1,
      rt: { gpu: 'A100-40G', ram_u: 14, ram_t: 83, vram_u: 22, vram_t: 40, idle_m: 12 }
    };
    const heavyLedger = {
      version: 1,
      updated_at_ms: now16,
      pools: {
        gemini: {
          day_key: '2026-11-27',
          used_today_percent: 115,
          pre_reset_used_percent: 79,
          reset_count_today: 1,
          cycle_start_remaining_percent: 100,
          cycle_min_remaining_percent: 64,
          last_remaining_percent: 64,
          last_resets_at: resetNextWk14,
          first_observed_at_ms: localMs(2026, 11, 27, 12, 0),
          last_observed_at_ms: now16 - 1000,
          baseline_complete: false,
          unobserved_gap_percent: 8.6
        },
        non_gemini: {
          day_key: '2026-11-27',
          used_today_percent: 24,
          pre_reset_used_percent: 12,
          reset_count_today: 1,
          cycle_start_remaining_percent: 100,
          cycle_min_remaining_percent: 88,
          last_remaining_percent: 88,
          last_resets_at: midWeekReset,
          first_observed_at_ms: localMs(2026, 11, 27, 12, 0),
          last_observed_at_ms: now16 - 1000,
          baseline_complete: false,
          unobserved_gap_percent: 0
        }
      }
    };
    for (const linesCount of [1, 2, 3]) {
      for (const withColab of [false, true]) {
        const sum = withColab ? { ...heavyBaseSummary, colab: heavyColab } : heavyBaseSummary;
        for (const w of [60, 68, 74, 75, 80, 90, 100, 104, 105, 110, 117, 118, 120, 130, 140]) {
          const out = renderStatusLine(heavyPayload(w), sum, {
            lines: linesCount,
            color: true,
            colorDepth: 'truecolor',
            theme: 'nord',
            nowMs: now16,
            quotaLedger: heavyLedger
          });
          const rows = out.split('\n');
          assert.equal(rows.length, linesCount, `lines=${linesCount} colab=${withColab} w=${w} must render ${linesCount} rows`);
          rows.forEach((row, idx) => {
            const cols = measureDisplayWidth(row);
            assert.ok(
              cols <= w,
              `Display width overflow (+${cols - w}) at lines=${linesCount} colab=${withColab} w=${w} L${idx + 1}: ${stripAnsi(row)}`
            );
          });
        }
      }
    }

    pass('Daily weekly-quota consumption tracker, reset merge & CJK width anti-overflow matrix (1/2/3-line, +/- Colab)');
  } finally {
    if (prevHome === undefined) delete process.env.AGY_HUD_HOME;
    else process.env.AGY_HUD_HOME = prevHome;
    rmSync(work, { recursive: true, force: true });
  }
}

function buildTestZip(entries) {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const crc = e.badCrc ? (crc32(raw) ^ 0x12345678) >>> 0 : crc32(raw);
    const comp = deflateRawSync(raw);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(8, 8);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(comp.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    localParts.push(lfh, nameBuf, comp);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE((3 << 8) | 20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(8, 10);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(comp.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    const mode = e.unixMode ?? (e.executable ? 0o100755 : 0o100644);
    cdh.writeUInt32LE((mode << 16) >>> 0, 38);
    cdh.writeUInt32LE(offset, 42);
    centralParts.push(cdh, nameBuf);
    offset += lfh.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralBuf, eocd]);
}

async function testAutoUpdater() {
  // Hot path must remain lazy: bin/agy-hud.mjs must not statically import updater.mjs
  const binSrc = readFileSync(BIN_PATH, 'utf8');
  assert.ok(!/^import\s+.*updater\.mjs/m.test(binSrc), 'bin/agy-hud.mjs must dynamically import updater.mjs only on update command');

  assert.equal(compareSemver('0.1.1', '0.1.0'), 1);
  assert.equal(compareSemver('0.1.0', '0.1.0'), 0);
  assert.equal(parseSemver('bad-ver'), null);
  assert.throws(() => extractZipBuffer(buildTestZip([{ name: '../evil.txt', data: 'x' }])), /越界路径/);
  assert.throws(() => extractZipBuffer(buildTestZip([{ name: 'agy-cli-hud/link', data: 'x', unixMode: 0o120777 }])), /符号链接/);
  assert.throws(() => extractZipBuffer(buildTestZip([{ name: 'agy-cli-hud/a.txt', data: 'abc', badCrc: true }])), /CRC-32/);

  const work = mkdtempSync(join(tmpdir(), 'agy-hud-upd-test-'));
  const targetDir = join(work, 'installed', 'agy-cli-hud');
  mkdirSync(join(targetDir, 'bin'), { recursive: true });
  mkdirSync(join(targetDir, 'lib'), { recursive: true });
  writeFileSync(join(targetDir, 'plugin.json'), JSON.stringify({
    name: 'agy-cli-hud',
    version: '0.1.0',
    repository: 'https://github.com/Dong-Kevin/agy-plugins'
  }));
  writeFileSync(join(targetDir, 'bin', 'agy-hud.mjs'), '#!/usr/bin/env node\n// old-0.1.0\n');
  writeFileSync(join(targetDir, 'lib', 'statusline.mjs'), '// old-0.1.0\n');

  const nextZip = buildTestZip([
    {
      name: 'agy-cli-hud/plugin.json',
      data: JSON.stringify({ name: 'agy-cli-hud', version: '0.1.1', repository: 'https://github.com/Dong-Kevin/agy-plugins' })
    },
    { name: 'agy-cli-hud/bin/agy-hud.mjs', data: '#!/usr/bin/env node\n// upgraded-0.1.1\n', executable: true },
    { name: 'agy-cli-hud/lib/statusline.mjs', data: '// upgraded-0.1.1\n' }
  ]);
  const validSha = createHash('sha256').update(nextZip).digest('hex');

  let mode = 'normal';
  let baseUrl = '';
  const srv = createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    if (u.pathname === '/api/latest') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        tag_name: 'v2026.12.01',
        name: 'v2026.12.01',
        html_url: 'https://github.com/Dong-Kevin/agy-plugins/releases/tag/v2026.12.01',
        published_at: '2026-12-01T00:00:00Z',
        body: 'Test HUD release',
        assets: [
          { name: 'agy-cli-hud-v0.1.1.zip', size: nextZip.length, browser_download_url: `${baseUrl}/dl/zip` },
          { name: 'agy-cli-hud-v0.1.1.zip.sha256', size: 80, browser_download_url: `${baseUrl}/dl/sha` }
        ]
      }));
      return;
    }
    if (u.pathname === '/dl/sha') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`${mode === 'bad-sha' ? '0'.repeat(64) : validSha}  agy-cli-hud-v0.1.1.zip\n`);
      return;
    }
    if (u.pathname === '/dl/zip') {
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      res.end(nextZip);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${srv.address().port}`;
    const env = {
      ...process.env,
      AGY_HUD_HOME: work,
      AGY_HUD_UPDATE_TARGET_DIR: targetDir,
      AGY_HUD_UPDATE_API_URL: `${baseUrl}/api/latest`,
      AGY_HUD_UPDATE_ALLOWED_HOSTS: '127.0.0.1'
    };

    const runHudAsync = (args) => new Promise((resolveRun) => {
      execFile(process.execPath, [BIN_PATH, ...args], { env, encoding: 'utf8' }, (error, stdout, stderr) => {
        resolveRun({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    });

    const chkRun = await runHudAsync(['update', '--check', '--json']);
    assert.equal(chkRun.error, null, `Expected update --check success: ${chkRun.stderr || chkRun.stdout}`);
    const chk = JSON.parse(chkRun.stdout);
    assert.equal(chk.ok, true);
    assert.equal(chk.hasUpdate, true);
    assert.equal(chk.currentVersion, '0.1.0');
    assert.equal(chk.latestVersion, '0.1.1');

    mode = 'bad-sha';
    const badShaRun = await runHudAsync(['update', '--json']);
    assert.ok(badShaRun.error, 'Tampered SHA-256 must fail update');
    const errOut = JSON.parse(badShaRun.stdout || '{}');
    assert.equal(errOut.ok, false);
    assert.match(errOut.error || '', /SHA-256/);
    assert.ok(readFileSync(join(targetDir, 'lib', 'statusline.mjs'), 'utf8').includes('old-0.1.0'));

    mode = 'normal';
    const updRun = await runHudAsync(['update', '--json']);
    assert.equal(updRun.error, null, `Expected update success: ${updRun.stderr || updRun.stdout}`);
    const upd = JSON.parse(updRun.stdout);
    assert.equal(upd.ok, true);
    assert.equal(upd.updated, true);
    assert.equal(upd.currentVersion, '0.1.1');
    assert.equal(JSON.parse(readFileSync(join(targetDir, 'plugin.json'), 'utf8')).version, '0.1.1');
    assert.ok(readFileSync(join(targetDir, 'lib', 'statusline.mjs'), 'utf8').includes('upgraded-0.1.1'));

    pass('CLI auto-updater (lazy import, Zip-Slip/symlink/CRC-32, SHA-256 guard & agy-hud update E2E)');
  } finally {
    srv.close();
    rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  testZeroCdpCompliance();
  testIncrementalJsonlAndRollup();
  testDualPoolQuotaAndLayeredStatusline();
  testDailyWeeklyQuotaTrackerAndReset();
  testThemeCliAndPrecedence();
  testCrossSessionSnapshotIsolation();
  await testAccurateSpeedTiming();
  testSoloBridgeChaining();
  await testStatuslineAntiKillHardening();
  await testMockColabApiAndPermissions();
  testIsolatedInstallUninstall();
  await testAutoUpdater();
  console.log('[agy-cli-hud] All plugin checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
