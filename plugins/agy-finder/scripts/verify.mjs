/**
 * Self-contained verification suite for agy-finder.
 * Zero external dependencies; cleans up all temporary test directories.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { deflateRawSync } from 'node:zlib';

import {
  CLI_GUARD_MESSAGE,
  buildSessionStartOutput,
  isCliHostSession
} from '../hooks/session_host_guard.mjs';
import {
  ackAuxPaneTrigger,
  getAuxShortcutConfig,
  getDrawerShortcutConfig,
  getShortcutSettings,
  markAuxPaneOpening,
  readActiveContextHint,
  readAuxPaneTrigger,
  recordActiveContextHint,
  recordAuxActiveConversation,
  saveShortcutSettings,
  setAuxShortcutConfig,
  setDrawerShortcutConfig,
  writeAuxPaneTrigger
} from '../sidecars/tree/drawer.mjs';
import { getConversationMentions } from '../sidecars/tree/mentions.mjs';
import {
  checkForUpdates,
  compareSemver,
  extractZipBuffer,
  parseSemver,
  performSelfUpdate
} from '../sidecars/tree/updater.mjs';
import {
  BROWSER_HTML_EXTS,
  isBrowserHtmlPath,
  listDirectoryEntries,
  normalizeRawPathInput,
  openInDefaultBrowser,
  readTextPreview,
  resolveTargetPath,
  searchWorkspaceFiles
} from '../sidecars/tree/path_utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function pass(name) {
  console.log(`[PASS] ${name}`);
}

// 1. Manifest, rules, skill, and sidecar config checks
function verifyManifestAndAssets() {
  const allowedKeys = new Set([
    '$schema', 'name', 'displayName', 'version', 'description',
    'author', 'homepage', 'repository', 'logo', 'suggestedPrompts', 'disabled'
  ]);
  const manifest = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8'));
  for (const k of Object.keys(manifest)) {
    assert.ok(allowedKeys.has(k), `Unexpected plugin.json top-level key: ${k}`);
  }
  assert.equal(manifest.name, 'agy-finder');
  assert.ok(existsSync(join(ROOT, manifest.logo)), 'logo file must exist');
  assert.ok(Array.isArray(manifest.suggestedPrompts) && manifest.suggestedPrompts.length <= 3);

  const rulesText = readFileSync(join(ROOT, 'rules/AGENTS.md'), 'utf8');
  assert.ok(!rulesText.trimStart().startsWith('---'), 'rules/AGENTS.md must NOT have YAML frontmatter');
  assert.ok(rulesText.includes('[🌐]') && rulesText.includes('open=browser'), 'rules/AGENTS.md must document [🌐] open=browser link');
  const cliGateIdx = rulesText.indexOf('antigravity-cli');
  const capsuleIdx = rulesText.indexOf('[📂](sidecar://');
  assert.ok(cliGateIdx > 0 && capsuleIdx > cliGateIdx, 'rules/AGENTS.md must place antigravity-cli host gate before sidecar:// capsule examples');

  const hooksJson = JSON.parse(readFileSync(join(ROOT, 'hooks.json'), 'utf8'));
  const sessionStartHandlers = hooksJson['agy-finder-cli-guard']?.SessionStart;
  assert.ok(Array.isArray(sessionStartHandlers) && sessionStartHandlers.length === 1, 'hooks.json must declare a flat SessionStart handler array');
  assert.equal(sessionStartHandlers[0].type, 'command');
  assert.equal(sessionStartHandlers[0].command, 'node hooks/session_host_guard.mjs');
  assert.ok(existsSync(join(ROOT, 'hooks/session_host_guard.mjs')), 'hooks/session_host_guard.mjs must exist');

  const skillText = readFileSync(join(ROOT, 'skills/agy-finder/SKILL.md'), 'utf8');
  assert.ok(skillText.trimStart().startsWith('---'), 'SKILL.md must have YAML frontmatter');
  assert.ok(skillText.includes('name: agy-finder'));
  assert.ok(skillText.includes('[🌐]') && skillText.includes('open=browser'), 'SKILL.md must document [🌐] open=browser link');

  const sidecar = JSON.parse(readFileSync(join(ROOT, 'sidecars/tree/sidecar.json'), 'utf8'));
  assert.equal(sidecar.has_web_ui, true);
  assert.ok(sidecar.ui_config.views.some((v) => v.entrypoint === 'SIDECAR_UI_ENTRYPOINT_AUX_PANE' && v.path === '/'));
  pass('Manifest, hooks.json, rules/AGENTS.md, SKILL.md, and sidecar.json schema');
}

// 2. JS syntax & macOS Swift typecheck
function verifySyntax() {
  const files = [
    'hooks/session_host_guard.mjs',
    'sidecars/tree/main.mjs',
    'sidecars/tree/path_utils.mjs',
    'sidecars/tree/mentions.mjs',
    'sidecars/tree/drawer.mjs',
    'sidecars/tree/updater.mjs',
    'sidecars/tree/cli.mjs',
    'sidecars/tree/app.js',
    'scripts/verify.mjs'
  ];
  for (const f of files) {
    execFileSync(process.execPath, ['--check', join(ROOT, f)], { stdio: 'pipe' });
  }

  if (process.platform === 'darwin' && existsSync('/usr/bin/swiftc')) {
    const modCache = mkdtempSync(join(tmpdir(), 'agy-finder-swiftcache-'));
    try {
      execFileSync(
        '/usr/bin/swiftc',
        ['-typecheck', '-module-cache-path', modCache, join(ROOT, 'sidecars/tree/native_drawer_macos.swift')],
        { stdio: 'pipe' }
      );
    } finally {
      rmSync(modCache, { recursive: true, force: true });
    }
    pass('Node.js syntax (--check) & macOS Swift (-typecheck) verification');
    return;
  }
  pass('Node.js syntax check (--check) for all JS/MJS files');
}

// 3. CSS namespace & HTML shell checks
function verifyCssAndHtml() {
  const css = readFileSync(join(ROOT, 'sidecars/tree/styles.css'), 'utf8');
  const declMatches = [...css.matchAll(/(?:^|[;\s{])(--[a-z0-9-]+)\s*:/gim)];
  assert.ok(declMatches.length > 0, 'styles.css should declare --af-* custom properties');
  for (const m of declMatches) {
    assert.ok(m[1].startsWith('--af-'), `CSS variable ${m[1]} must use --af-* prefix`);
  }

  const html = readFileSync(join(ROOT, 'sidecars/tree/index.html'), 'utf8');
  assert.ok(html.includes('<script src="/preload.js"></script>'), 'index.html must load /preload.js');
  assert.ok(html.includes('[hidden], .hidden'), 'index.html must guard [hidden], .hidden');
  for (const id of [
    'btn-drawer',
    'btn-shortcuts',
    'shortcut-panel',
    'hotkey-preset-select',
    'btn-record-drawer-shortcut',
    'btn-record-aux-shortcut',
    'btn-toggle-aux-shortcut',
    'btn-aux-open',
    'btn-update',
    'update-dot',
    'update-panel-row',
    'btn-panel-update',
    'update-banner',
    'preview-modal',
    'btn-preview-browser'
  ]) {
    assert.ok(html.includes(`id="${id}"`), `index.html must include #${id}`);
  }
  pass('CSS --af-* namespace isolation and index.html preload/hidden/shortcut UI checks');
}

// 4. Path normalization, resolution, hidden auto-enable, external root & traversal guard
async function verifyPathUtils() {
  // Windows path & line extraction safety
  const winNorm = normalizeRawPathInput('C:\\repo\\src\\app.ts:42:5');
  assert.equal(winNorm.cleanedPath, 'C:\\repo\\src\\app.ts');
  assert.equal(winNorm.line, 42);

  const hashNorm = normalizeRawPathInput('`sidecars/tree/main.mjs#L15`');
  assert.equal(hashNorm.cleanedPath, 'sidecars/tree/main.mjs');
  assert.equal(hashNorm.line, 15);

  const fileUriNorm = normalizeRawPathInput(pathToFileURL(join(ROOT, 'plugin.json')).href + '#L2');
  assert.equal(fileUriNorm.cleanedPath, join(ROOT, 'plugin.json'));
  assert.equal(fileUriNorm.line, 2);

  // Relative & absolute resolution inside workspace
  const relRes = resolveTargetPath('./sidecars/tree/main.mjs:10', [ROOT]);
  assert.equal(relRes.exists, true);
  assert.equal(relRes.relPath, 'sidecars/tree/main.mjs');
  assert.deepEqual(relRes.ancestorRelDirs, ['sidecars', 'sidecars/tree']);
  assert.equal(relRes.line, 10);
  assert.equal(relRes.isExternalRoot, false);
  assert.equal(relRes.requiresHidden, false);

  // Hidden dotfile detection & external temp path auto-root mounting
  const extDir = mkdtempSync(join(tmpdir(), 'agy-finder-ext-'));
  try {
    writeFileSync(join(extDir, '.hidden-check'), 'hidden\n');
    const hiddenRes = resolveTargetPath('.hidden-check', [extDir]);
    assert.equal(hiddenRes.exists, true);
    assert.equal(hiddenRes.requiresHidden, true);

    mkdirSync(join(extDir, 'docs'), { recursive: true });
    const extFile = join(extDir, 'docs', 'note.md');
    writeFileSync(extFile, '# hello\n');
    const extRes = resolveTargetPath(extFile, [ROOT]);
    assert.equal(extRes.exists, true);
    assert.equal(extRes.isExternalRoot, true);
    assert.equal(extRes.relPath, 'note.md');

    // Directory listing + path traversal rejection
    const listing = listDirectoryEntries(ROOT, 'sidecars/tree', { showHidden: false });
    assert.ok(listing.items.some((i) => i.name === 'main.mjs'));

    assert.throws(
      () => listDirectoryEntries(ROOT, '../', { showHidden: false }),
      (err) => err.status === 403
    );

    const searchRes = searchWorkspaceFiles(ROOT, 'path_utils');
    assert.ok(searchRes.results.some((r) => r.relPath === 'sidecars/tree/path_utils.mjs'));

    const previewOk = readTextPreview('plugin.json:2', [ROOT]);
    assert.equal(previewOk.ok, true);
    assert.equal(previewOk.line, 2);
    assert.equal(previewOk.isBinary, false);
    assert.ok(previewOk.content.includes('"agy-finder"'));

    const previewMissing = readTextPreview('missing-file-xyz.txt', [ROOT]);
    assert.equal(previewMissing.ok, false);

    // HTML detection & safe default-browser launcher checks (mocked execFile, zero real browser popups)
    assert.ok(BROWSER_HTML_EXTS.has('.html') && BROWSER_HTML_EXTS.has('.htm') && BROWSER_HTML_EXTS.has('.xhtml'));
    assert.equal(isBrowserHtmlPath('preview/index.html#L2'), true);
    assert.equal(isBrowserHtmlPath('preview/PAGE.HTM:10'), true);
    assert.equal(isBrowserHtmlPath('sidecars/tree/main.mjs'), false);

    mkdirSync(join(extDir, 'preview'), { recursive: true });
    const htmlFile = join(extDir, 'preview', 'index.html');
    writeFileSync(htmlFile, '<!doctype html><html><body>hi</body></html>\n');

    const htmlResolved = resolveTargetPath('preview/index.html', [extDir]);
    assert.equal(htmlResolved.exists, true);
    assert.equal(htmlResolved.isHtmlFile, true);

    const htmlListing = listDirectoryEntries(extDir, 'preview');
    assert.equal(htmlListing.items.find((i) => i.name === 'index.html')?.isHtmlFile, true);

    const htmlSearch = searchWorkspaceFiles(extDir, 'index.html');
    assert.equal(htmlSearch.results.find((r) => r.relPath === 'preview/index.html')?.isHtmlFile, true);

    const nonHtmlReject = await openInDefaultBrowser('plugin.json', [ROOT]);
    assert.equal(nonHtmlReject.ok, false);
    const dirReject = await openInDefaultBrowser('sidecars', [ROOT]);
    assert.equal(dirReject.ok, false);
    const missingHtmlReject = await openInDefaultBrowser('missing-page.html', [ROOT]);
    assert.equal(missingHtmlReject.ok, false);

    const execCalls = [];
    const fallbackLaunch = await openInDefaultBrowser(htmlFile, [extDir], {
      platform: 'darwin',
      execFileImpl: (cmd, args, cb) => {
        execCalls.push({ cmd, args });
        if (execCalls.length === 1) {
          cb(new Error('Simulated primary browser failure'));
        } else {
          cb(null);
        }
      }
    });
    assert.equal(fallbackLaunch.ok, true);
    assert.equal(fallbackLaunch.path, resolve(htmlFile));
    assert.equal(execCalls.length, 2, 'openInDefaultBrowser must fall back to secondary candidate on first failure');
  } finally {
    rmSync(extDir, { recursive: true, force: true });
  }
  pass('Path normalization, reveal resolution, preview reader, HTML browser launcher & 403 traversal guard');
}

// 5. Incremental transcript_full.jsonl extraction & ETag short-circuit
function verifyMentionsIncremental() {
  const tempBrain = mkdtempSync(join(tmpdir(), 'agy-finder-brain-'));
  const convId = '11111111-2222-3333-4444-555555555555';
  const logsDir = join(tempBrain, convId, '.system_generated', 'logs');
  mkdirSync(logsDir, { recursive: true });
  const logFile = join(logsDir, 'transcript_full.jsonl');

  try {
    const firstStep = {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      content: `查看 [plugin.json](${pathToFileURL(join(ROOT, 'plugin.json')).href}) [📂](sidecar://agy-finder/tree/?path=sidecars%2Ftree%2Fmain.mjs) 以及 \`README.md\`。`
    };
    writeFileSync(logFile, JSON.stringify(firstStep) + '\n');

    const r1 = getConversationMentions({
      conversationId: convId,
      roots: [ROOT],
      customBrainDirs: [tempBrain]
    });
    assert.equal(r1.ok, true);
    assert.equal(r1.unchanged, false);
    assert.ok(r1.items.some((i) => i.relPath === 'sidecars/tree/main.mjs'));
    assert.ok(r1.items.some((i) => i.relPath === 'plugin.json'));

    // Unchanged hit with matching ETag
    const r2 = getConversationMentions({
      conversationId: convId,
      roots: [ROOT],
      clientEtag: r1.etag,
      customBrainDirs: [tempBrain]
    });
    assert.equal(r2.unchanged, true);
    assert.equal(r2.etag, r1.etag);

    // Append new reply line -> byte-offset incremental read (including [🌐] + [📂] dedupe for HTML)
    const secondStep = {
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      content: '新增引用 `sidecars/tree/mentions.mjs:12`、[index.html](sidecars/tree/index.html) [🌐](sidecar://agy-finder/tree/?path=sidecars%2Ftree%2Findex.html&open=browser) [📂](sidecar://agy-finder/tree/?path=sidecars%2Ftree%2Findex.html) 与不存在的 `not/exists.ts`。'
    };
    appendFileSync(logFile, JSON.stringify(secondStep) + '\n');

    const r3 = getConversationMentions({
      conversationId: convId,
      roots: [ROOT],
      clientEtag: r1.etag,
      customBrainDirs: [tempBrain]
    });
    assert.equal(r3.unchanged, false);
    assert.ok(r3.items.some((i) => i.relPath === 'sidecars/tree/mentions.mjs'));
    const htmlMentions = r3.items.filter((i) => i.relPath === 'sidecars/tree/index.html');
    assert.equal(htmlMentions.length, 1, 'Duplicate [🌐] and [📂] mentions for the same HTML file must dedupe');
    assert.equal(htmlMentions[0].isHtmlFile, true);
    assert.ok(!r3.items.some((i) => i.relPath.includes('not/exists.ts')));
  } finally {
    rmSync(tempBrain, { recursive: true, force: true });
  }
  pass('Incremental byte-offset transcript_full.jsonl mention extractor & ETag cache');
}

function httpGetRaw(urlStr, headers = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const u = new URL(urlStr);
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
        headers
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolvePromise({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );
    req.on('error', rejectPromise);
    req.end();
  });
}

// 6. Shortcut settings persistence & CLI checks in isolated AGY_FINDER_DATA_DIR
function verifyShortcutAndCli() {
  const tempData = mkdtempSync(join(tmpdir(), 'agy-finder-data-'));
  const prevDataDir = process.env.AGY_FINDER_DATA_DIR;
  const prevDisableDrawer = process.env.AGY_FINDER_DISABLE_DRAWER;
  process.env.AGY_FINDER_DATA_DIR = tempData;
  process.env.AGY_FINDER_DISABLE_DRAWER = '1';

  try {
    const def = getShortcutSettings();
    assert.equal(def.hotkeyPreset, 'cmd+shift+e');
    assert.equal(def.drawerPinned, true);

    saveShortcutSettings({ hotkeyPreset: 'cmd+alt+e', drawerPinned: false });
    const updated = getShortcutSettings();
    assert.equal(updated.hotkeyPreset, 'cmd+alt+e');
    assert.equal(updated.drawerPinned, false);

    assert.throws(() => saveShortcutSettings({ hotkeyPreset: 'bad+key' }), (err) => err.status === 400);

    const cliEnv = {
      ...process.env,
      AGY_FINDER_DATA_DIR: tempData,
      AGY_FINDER_DISABLE_DRAWER: '1'
    };
    const stOut = execFileSync(process.execPath, [join(ROOT, 'sidecars/tree/cli.mjs'), 'status', '--json'], {
      env: cliEnv,
      encoding: 'utf8'
    });
    const stJson = JSON.parse(stOut);
    assert.equal(stJson.hotkeyPreset, 'cmd+alt+e');

    execFileSync(process.execPath, [join(ROOT, 'sidecars/tree/cli.mjs'), 'hotkey', 'cmd+shift+y'], {
      env: cliEnv,
      stdio: 'pipe'
    });
    assert.equal(getShortcutSettings().hotkeyPreset, 'cmd+shift+y');

    // Dual custom shortcut configs, automatic default shift on Alt+Meta+E, collision rejection & CLI aux/aux-shortcut
    saveShortcutSettings({ hotkeyPreset: 'cmd+alt+e' }, 'darwin');
    assert.equal(
      getAuxShortcutConfig('darwin').accelerator,
      'Ctrl+Alt+E',
      'Drawer preset cmd+alt+e must shift default auxShortcut to Ctrl+Alt+E to avoid collision'
    );
    setDrawerShortcutConfig({ reset: true }, 'darwin');
    assert.equal(getDrawerShortcutConfig('darwin').accelerator, 'Shift+Meta+E');
    assert.equal(getAuxShortcutConfig('darwin').accelerator, 'Alt+Meta+E');

    const auxCollision = setAuxShortcutConfig({ accelerator: 'Shift+Meta+E' }, 'darwin');
    assert.equal(auxCollision.ok, false, 'Aux shortcut colliding with drawer shortcut must be rejected');

    const auxSaved = setAuxShortcutConfig({ accelerator: 'Ctrl+Alt+F', scope: 'global' }, 'darwin');
    assert.equal(auxSaved.ok, true);
    assert.equal(auxSaved.auxShortcut.accelerator, 'Ctrl+Alt+F');
    assert.equal(auxSaved.auxShortcut.scope, 'global');

    const auxCliSet = execFileSync(process.execPath, [join(ROOT, 'sidecars/tree/cli.mjs'), 'aux-shortcut', 'Ctrl+Shift+O', '--json'], {
      env: cliEnv,
      encoding: 'utf8'
    });
    assert.equal(JSON.parse(auxCliSet).auxShortcut.accelerator, 'Ctrl+Shift+O');

    const auxTrigOut = execFileSync(process.execPath, [join(ROOT, 'sidecars/tree/cli.mjs'), 'aux', 'plugin.json', '--json'], {
      env: cliEnv,
      encoding: 'utf8'
    });
    const auxTrigJson = JSON.parse(auxTrigOut);
    assert.equal(auxTrigJson.trigger.targetPlugin, 'agy-finder');
    assert.equal(auxTrigJson.trigger.uri, 'sidecar://agy-finder/tree/');
    assert.equal(auxTrigJson.trigger.revealPath, 'plugin.json');

    // Hidden prewarmed iframe hint isolation & opening/deferred ack exclusivity
    recordActiveContextHint({ conversationId: 'b2000000-0000-4000-8000-000000000002', visible: true });
    recordActiveContextHint({ conversationId: 'c3000000-0000-4000-8000-000000000003', visible: false });
    assert.equal(
      readActiveContextHint().conversationId,
      'b2000000-0000-4000-8000-000000000002',
      'Hidden Aux iframe (visible=false) must not overwrite active conversation hint'
    );
    recordAuxActiveConversation({ convId: 'b2000000-0000-4000-8000-000000000002' });
    const auxOpen = writeAuxPaneTrigger({
      targetPlugin: 'agy-finder',
      uri: 'sidecar://agy-finder/tree/',
      action: 'toggle'
    });
    assert.equal(markAuxPaneOpening({ seq: auxOpen.seq }).claimed, true);
    assert.equal(markAuxPaneOpening({ seq: auxOpen.seq }).claimed, false);
    assert.ok(readAuxPaneTrigger().ackSeq < auxOpen.seq);
    assert.equal(ackAuxPaneTrigger({ seq: auxOpen.seq, plugin: 'agy-finder' }).claimed, true);
    assert.equal(readAuxPaneTrigger().ackSeq, auxOpen.seq);

    // Background conversation with newer mtimeMs & older viewTimeMs + subagent transcript isolation
    const prevAgDir = process.env.AG_DIR;
    const prevAppDataDir = process.env.ANTIGRAVITY_APPDATA_DIR;
    const tempAgDir = mkdtempSync(join(tmpdir(), 'agy-finder-ag-'));
    try {
      process.env.AG_DIR = tempAgDir;
      process.env.ANTIGRAVITY_APPDATA_DIR = tempAgDir;
      const bgId = '00000000-0000-4000-8000-000000000004';
      const fgId = '00000000-0000-4000-8000-000000000005';
      const subId = '00000000-0000-4000-8000-000000000006';
      for (const [id, lines] of [
        [bgId, [{ type: 'USER_INPUT', content: 'background thread' }]],
        [fgId, [{ type: 'USER_INPUT', content: 'foreground thread' }]],
        [subId, [{ type: 'SYSTEM_MESSAGE', content: 'subagent system prompt' }]]
      ]) {
        const logDir = join(tempAgDir, 'brain', id, '.system_generated', 'logs');
        mkdirSync(logDir, { recursive: true });
        writeFileSync(join(logDir, 'transcript.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      }
      mkdirSync(join(tempAgDir, 'annotations'), { recursive: true });
      const bgSec = Math.floor((Date.now() + 10000) / 1000);
      const fgSec = Math.floor((Date.now() + 30000) / 1000);
      writeFileSync(
        join(tempAgDir, 'annotations', `${bgId}.pbtxt`),
        `title: "bg"\nlast_user_view_time: {\n  seconds: ${bgSec}\n  nanos: 0\n}\n`
      );
      writeFileSync(
        join(tempAgDir, 'annotations', `${fgId}.pbtxt`),
        `title: "fg"\nlast_user_view_time: {\n  seconds: ${fgSec}\n  nanos: 0\n}\n`
      );
      const newerSec = fgSec + 60;
      utimesSync(join(tempAgDir, 'brain', bgId, '.system_generated', 'logs', 'transcript.jsonl'), newerSec, newerSec);
      utimesSync(join(tempAgDir, 'brain', subId, '.system_generated', 'logs', 'transcript.jsonl'), newerSec + 30, newerSec + 30);

      const trigFg = writeAuxPaneTrigger({ targetPlugin: 'agy-finder', uri: 'sidecar://agy-finder/tree/', action: 'toggle' });
      assert.equal(trigFg.convId, fgId, 'Background conversation or subagent mtimeMs must not hijack foreground convId');

      const trigFgRepeat = writeAuxPaneTrigger({ targetPlugin: 'agy-finder', uri: 'sidecar://agy-finder/tree/', action: 'toggle' });
      assert.equal(trigFgRepeat.convId, fgId, 'Repeated Aux hotkey without tab switch must stay on same foreground convId');
    } finally {
      if (prevAgDir === undefined) delete process.env.AG_DIR;
      else process.env.AG_DIR = prevAgDir;
      if (prevAppDataDir === undefined) delete process.env.ANTIGRAVITY_APPDATA_DIR;
      else process.env.ANTIGRAVITY_APPDATA_DIR = prevAppDataDir;
      rmSync(tempAgDir, { recursive: true, force: true });
    }

    const afAppSource = readFileSync(join(ROOT, 'sidecars/tree/app.js'), 'utf8');
    assert.ok(
      afAppSource.includes('IntersectionObserver') &&
        afAppSource.includes('intersectionRect') &&
        afAppSource.includes('agy_aux_ever_visible') &&
        afAppSource.includes('holdMs') &&
        afAppSource.includes('alreadyOpeningOrSwitched') &&
        afAppSource.includes('window.sidecar.ui.toggleConversation(targetConvId)') &&
        !afAppSource.includes('if (canToggleAux)') &&
        afAppSource.includes("toggleAuxPane({ tabType: 'sidecarView', uri: trig.uri })") &&
        afAppSource.includes('agy_aux_last_reveal_seq') &&
        !afAppSource.includes('return window.innerWidth > 40 && window.innerHeight > 40;'),
      'tree/app.js must implement IntersectionObserver visibility check, holdMs wakeup, hidden toggleConversation wakeup + visible toggleAuxPane bridge, and revealPath preservation'
    );

    pass('Shortcut settings persistence, dual custom chords, collision guard & cli.mjs aux commands');
  } finally {
    if (prevDataDir === undefined) delete process.env.AGY_FINDER_DATA_DIR;
    else process.env.AGY_FINDER_DATA_DIR = prevDataDir;
    if (prevDisableDrawer === undefined) delete process.env.AGY_FINDER_DISABLE_DRAWER;
    else process.env.AGY_FINDER_DISABLE_DRAWER = prevDisableDrawer;
    rmSync(tempData, { recursive: true, force: true });
  }
}

// 7. Standalone HTTP loopback & security guard tests
async function verifyStandaloneHttp() {
  const tempData = mkdtempSync(join(tmpdir(), 'agy-finder-httpdata-'));
  const child = spawn(
    process.execPath,
    [join(ROOT, 'sidecars/tree/main.mjs'), '--standalone', '--port', '0'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        ANTIGRAVITY_AGENTAPI_EXE: '',
        ANTIGRAVITY_CONVERSATION_ID: '',
        ANTIGRAVITY_WORKSPACE_ROOT: ROOT,
        AGY_FINDER_DATA_DIR: tempData,
        AGY_FINDER_DISABLE_DRAWER: '1',
        AGY_FINDER_DRY_RUN_BROWSER: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  try {
    const baseUrl = await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error('Server startup timeout')), 5000);
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        const m = buf.match(/AGY_FINDER_URL=(http:\/\/127\.0\.0\.1:\d+)/);
        if (m) {
          clearTimeout(timer);
          resolvePromise(m[1]);
        }
      });
      child.stderr.on('data', (d) => {
        buf += d.toString('utf8');
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        rejectPromise(new Error(`Server exited early (${code}): ${buf}`));
      });
    });

    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    const htmlBody = await htmlRes.text();
    const tokenMatch = htmlBody.match(/meta name="af-csrf-token" content="([^"]+)"/);
    assert.ok(tokenMatch?.[1], 'HTML must inject CSRF token');
    const csrfToken = tokenMatch[1];

    const wsRes = await fetch(`${baseUrl}/api/workspace`);
    assert.equal(wsRes.status, 200);
    const wsJson = await wsRes.json();
    assert.equal(wsJson.primaryRoot, ROOT);

    const resolveRes = await fetch(`${baseUrl}/api/resolve?path=${encodeURIComponent('sidecars/tree/main.mjs:10')}`);
    const resolveJson = await resolveRes.json();
    assert.equal(resolveJson.exists, true);
    assert.equal(resolveJson.relPath, 'sidecars/tree/main.mjs');

    const previewRes = await fetch(`${baseUrl}/api/preview?path=plugin.json`);
    const previewJson = await previewRes.json();
    assert.equal(previewJson.ok, true);
    assert.ok(previewJson.content.includes('agy-finder'));

    const searchRes = await fetch(`${baseUrl}/api/search?q=sidecar`);
    const searchJson = await searchRes.json();
    assert.ok(searchJson.results.some((r) => r.relPath === 'sidecars/tree/sidecar.json'));

    const scGet = await fetch(`${baseUrl}/api/shortcut`);
    assert.equal(scGet.status, 200);
    const scJson = await scGet.json();
    assert.equal(scJson.settings.hotkeyPreset, 'cmd+shift+e');
    assert.ok(Array.isArray(scJson.presets) && scJson.presets.length >= 4);

    const scPost = await fetch(`${baseUrl}/api/shortcut`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AF-Token': csrfToken
      },
      body: JSON.stringify({ action: 'set-hotkey', hotkeyPreset: 'ctrl+shift+e' })
    });
    assert.equal(scPost.status, 200);
    const scPostJson = await scPost.json();
    assert.equal(scPostJson.hotkeyPreset, 'ctrl+shift+e');

    // Dual custom shortcut & /api/aux-pane-trigger endpoints
    const scAuxPost = await fetch(`${baseUrl}/api/shortcut`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AF-Token': csrfToken
      },
      body: JSON.stringify({ action: 'set-aux-shortcut', accelerator: 'Ctrl+Shift+F' })
    });
    assert.equal(scAuxPost.status, 200);
    const scAuxPostJson = await scAuxPost.json();
    assert.equal(scAuxPostJson.ok, true);
    assert.equal(scAuxPostJson.auxShortcut.accelerator, 'Ctrl+Shift+F');

    const auxTrigPost = await fetch(`${baseUrl}/api/aux-pane-trigger`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AF-Token': csrfToken
      },
      body: JSON.stringify({ targetPlugin: 'agy-finder', uri: 'sidecar://agy-finder/tree/', action: 'toggle', revealPath: 'README.md' })
    });
    assert.equal(auxTrigPost.status, 200);
    const auxTrigResJson = await auxTrigPost.json();
    assert.ok(auxTrigResJson.ok && auxTrigResJson.trigger?.seq > 0);

    const auxPoll = await fetch(`${baseUrl}/api/aux-pane-trigger?since=0&waitMs=0`);
    const auxPollJson = await auxPoll.json();
    assert.equal(auxPollJson.changed, true);
    assert.equal(auxPollJson.trigger.revealPath, 'README.md');

    const auxHoldRes = await fetch(`${baseUrl}/api/aux-pane-trigger?waitMs=0&holdMs=20`);
    assert.equal(auxHoldRes.status, 200);
    const auxHoldJson = await auxHoldRes.json();
    assert.equal(auxHoldJson.trigger.revealPath, 'README.md');

    // Host header guard
    const evilHostRes = await httpGetRaw(`${baseUrl}/api/workspace`, { Host: 'evil.example:1234' });
    assert.equal(evilHostRes.status, 403);

    // CSRF guard on POST
    const noTokenPost = await fetch(`${baseUrl}/api/reveal-os`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'plugin.json' })
    });
    assert.equal(noTokenPost.status, 403);

    const noTokenBrowserPost = await fetch(`${baseUrl}/api/open-browser`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'sidecars/tree/index.html' })
    });
    assert.equal(noTokenBrowserPost.status, 403);

    const validHtmlBrowserPost = await fetch(`${baseUrl}/api/open-browser`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AF-Token': csrfToken
      },
      body: JSON.stringify({ path: 'sidecars/tree/index.html' })
    });
    assert.equal(validHtmlBrowserPost.status, 200);
    const validHtmlBrowserJson = await validHtmlBrowserPost.json();
    assert.equal(validHtmlBrowserJson.ok, true);
    assert.equal(validHtmlBrowserJson.dryRun, true);
    assert.equal(validHtmlBrowserJson.path, join(ROOT, 'sidecars/tree/index.html'));

    const nonHtmlBrowserPost = await fetch(`${baseUrl}/api/open-browser`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AF-Token': csrfToken
      },
      body: JSON.stringify({ path: 'plugin.json' })
    });
    assert.equal(nonHtmlBrowserPost.status, 200);
    const nonHtmlBrowserJson = await nonHtmlBrowserPost.json();
    assert.equal(nonHtmlBrowserJson.ok, false);

    pass('Standalone loopback HTTP APIs (/api/shortcut, /api/preview, /api/open-browser), Host guard (403), and CSRF guard (403)');
  } finally {
    child.kill('SIGTERM');
    rmSync(tempData, { recursive: true, force: true });
  }
}

// 8. Install & Uninstall script test in temp AGY_PLUGINS_DIR and AGY_BIN_DIR
function verifyInstaller() {
  const tempPluginsDir = mkdtempSync(join(tmpdir(), 'agy-finder-install-'));
  const tempBinDir = mkdtempSync(join(tmpdir(), 'agy-finder-bin-'));
  try {
    execFileSync('bash', [join(ROOT, 'install.sh')], {
      env: { ...process.env, AGY_PLUGINS_DIR: tempPluginsDir, AGY_BIN_DIR: tempBinDir },
      stdio: 'pipe'
    });
    const installedDir = join(tempPluginsDir, 'agy-finder');
    const cliLink = join(tempBinDir, 'agy-finder');
    assert.ok(existsSync(join(installedDir, 'plugin.json')));
    assert.ok(existsSync(join(installedDir, 'hooks.json')));
    assert.ok(existsSync(join(installedDir, 'hooks/session_host_guard.mjs')));
    assert.ok(existsSync(join(installedDir, 'rules/AGENTS.md')));
    assert.ok(existsSync(join(installedDir, 'sidecars/tree/sidecar.json')));
    assert.ok(existsSync(join(installedDir, 'sidecars/tree/drawer.mjs')));
    assert.ok(existsSync(join(installedDir, 'sidecars/tree/native_drawer_macos.swift')));
    assert.ok(existsSync(cliLink), 'Installer must create CLI symlink in AGY_BIN_DIR');

    const helpOut = execFileSync(cliLink, ['--help'], { encoding: 'utf8' });
    assert.ok(helpOut.includes('agy-finder toggle'));

    execFileSync('bash', [join(ROOT, 'install.sh'), '--uninstall'], {
      env: { ...process.env, AGY_PLUGINS_DIR: tempPluginsDir, AGY_BIN_DIR: tempBinDir },
      stdio: 'pipe'
    });
    assert.ok(!existsSync(installedDir), 'Uninstall must remove plugin directory');
    assert.ok(!existsSync(cliLink), 'Uninstall must remove CLI symlink');
    pass('install.sh install & --uninstall (incl. CLI symlink) in isolated dirs');
  } finally {
    rmSync(tempPluginsDir, { recursive: true, force: true });
    rmSync(tempBinDir, { recursive: true, force: true });
  }
}

// 9. Behavioral regression tests for R2 (relative dotfile / .. path resolution) & R5 (symlink loop / dedupe search)
function verifyPathResolutionAndSymlinkSearch() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'agy-finder-r2r5-'));
  const ws = join(tempRoot, 'ws');
  const outside = join(tempRoot, 'outside');
  try {
    mkdirSync(join(ws, 'src'), { recursive: true });
    mkdirSync(join(ws, 'dirA'), { recursive: true });
    mkdirSync(join(ws, 'dirB'), { recursive: true });
    mkdirSync(outside, { recursive: true });

    writeFileSync(join(ws, '.env'), 'SECRET=1\n');
    writeFileSync(join(ws, 'env'), 'PLAIN=1\n');
    writeFileSync(join(ws, 'README.md'), 'inner readme\n');
    writeFileSync(join(tempRoot, 'README.md'), 'outer readme\n');
    writeFileSync(join(outside, 'guide.md'), 'outside guide\n');
    writeFileSync(join(ws, 'src', 'real_target.txt'), 'needle\n');

    // R2: dotfiles and parent traversal must NOT be stripped by regex
    const dotEnvRes = resolveTargetPath('.env', [ws]);
    assert.equal(dotEnvRes.exists, true);
    assert.equal(dotEnvRes.absPath, resolve(ws, '.env'));
    assert.equal(dotEnvRes.relPath, '.env');
    assert.equal(dotEnvRes.isExternalRoot, false);

    const plainEnvRes = resolveTargetPath('env', [ws]);
    assert.equal(plainEnvRes.exists, true);
    assert.equal(plainEnvRes.absPath, resolve(ws, 'env'));
    assert.equal(plainEnvRes.relPath, 'env');

    const dotSlashEnvRes = resolveTargetPath('./.env', [ws]);
    assert.equal(dotSlashEnvRes.exists, true);
    assert.equal(dotSlashEnvRes.absPath, resolve(ws, '.env'));

    const parentReadmeRes = resolveTargetPath('../README.md', [ws]);
    assert.equal(parentReadmeRes.exists, true);
    assert.equal(parentReadmeRes.absPath, resolve(tempRoot, 'README.md'));
    assert.notEqual(parentReadmeRes.absPath, resolve(ws, 'README.md'));
    assert.equal(parentReadmeRes.isExternalRoot, true);

    const outsideGuideRes = resolveTargetPath('../outside/guide.md', [ws]);
    assert.equal(outsideGuideRes.exists, true);
    assert.equal(outsideGuideRes.absPath, resolve(outside, 'guide.md'));
    assert.equal(outsideGuideRes.isExternalRoot, true);

    // R5: self-loop, duplicate alias & mutual symlink directories must terminate cleanly without duplicates
    let symlinkCreated = false;
    try {
      symlinkSync('.', join(ws, 'self-loop'));
      symlinkSync('src', join(ws, 'src-alias'));
      symlinkSync('../dirB', join(ws, 'dirA', 'to-b'));
      symlinkSync('../dirA', join(ws, 'dirB', 'to-a'));
      symlinkCreated = true;
    } catch {}

    if (symlinkCreated) {
      const searchRes = searchWorkspaceFiles(ws, 'real_target', { maxVisited: 500 });
      assert.equal(searchRes.ok, true);
      assert.equal(searchRes.truncated, false, 'Symlink loops must not exhaust maxVisited');
      const exactMatches = searchRes.results.filter((r) => r.name === 'real_target.txt');
      assert.equal(exactMatches.length, 1, 'Duplicate directory symlink alias must not yield duplicate child entries');

      // S2: symlinked workspace root relative path reveal must stay inside symlink root namespace and pass listDirectoryEntries
      const physicalWs = join(tempRoot, 'physical-ws');
      const aliasWs = join(tempRoot, 'alias-ws');
      mkdirSync(join(physicalWs, 'nested'), { recursive: true });
      writeFileSync(join(physicalWs, 'README.md'), '# Physical README\n');
      writeFileSync(join(physicalWs, 'nested', 'item.ts'), 'export const ok = true;\n');
      symlinkSync(physicalWs, aliasWs, 'dir');

      const expectedAliasRoot = resolve(aliasWs);
      for (const relQuery of ['../physical-ws/README.md', '../physical-ws/nested/item.ts', join(physicalWs, 'nested', 'item.ts'), join(aliasWs, 'nested', 'item.ts')]) {
        const res = resolveTargetPath(relQuery, [aliasWs]);
        assert.equal(res.ok, true);
        assert.equal(res.exists, true, `Target should exist: ${relQuery}`);
        assert.equal(res.rootPath, expectedAliasRoot, `Root should stay aliasWs for ${relQuery}`);
        assert.equal(res.isExternalRoot, false, `Symlinked workspace target must not be marked external: ${relQuery}`);
        assert.ok(!res.relPath.startsWith('..') && !res.relPath.includes('/../'), `relPath must stay inside root: ${res.relPath}`);
        for (const anc of res.ancestorRelDirs) {
          assert.ok(!anc.startsWith('..'), `Ancestor relDir must not escape root: ${anc}`);
          const listed = listDirectoryEntries(res.rootPath, anc);
          assert.equal(listed.ok, true);
        }
      }
      const rootListed = listDirectoryEntries(expectedAliasRoot, '');
      assert.ok(rootListed.items.some((it) => it.name === 'README.md'));
    }

    pass('R2/S2 dotfile, parent & symlink root relative path resolution + R5 symlink cycle/alias deduplication');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

// 10. Behavioral VM test for R3 (cached expanded dir refresh on reveal + visible auto-sync) & UX #3 (search states)
async function verifyFinderFrontendBehavior() {
  const appCode = readFileSync(join(ROOT, 'sidecars', 'tree', 'app.js'), 'utf8');
  const wsRoot = '/mock-ws';
  const wsRootB = '/Users/demo/project-b';

  const makeEl = (id = '') => {
    const attrs = new Map();
    const classes = new Set();
    const listeners = new Map();
    return {
      id,
      value: '',
      innerHTML: '',
      textContent: '',
      scrollTop: 0,
      dataset: {},
      style: {},
      classList: {
        add: (...names) => names.forEach((n) => classes.add(n)),
        remove: (...names) => names.forEach((n) => classes.delete(n)),
        toggle: (n, force) => {
          const on = force === undefined ? !classes.has(n) : Boolean(force);
          if (on) classes.add(n);
          else classes.delete(n);
          return on;
        },
        contains: (n) => classes.has(n)
      },
      addEventListener: (type, fn) => {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatch: (type, ev = {}) => {
        for (const fn of listeners.get(type) || []) {
          fn({ target: ev.target || {}, ...ev });
        }
      },
      setAttribute: (k, v) => attrs.set(k, String(v)),
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
      querySelector: () => null,
      querySelectorAll: () => [],
      scrollIntoView: () => {},
      remove: () => {}
    };
  };

  const els = new Map();
  const getEl = (id) => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };

  const treeData = new Map([
    [
      '',
      [
        { name: 'src', relPath: 'src', absPath: `${wsRoot}/src`, fileUri: `file://${wsRoot}/src`, isDirectory: true, isHtmlFile: false },
        { name: 'preview', relPath: 'preview', absPath: `${wsRoot}/preview`, fileUri: `file://${wsRoot}/preview`, isDirectory: true, isHtmlFile: false }
      ]
    ],
    ['src', [{ name: 'alpha.js', relPath: 'src/alpha.js', absPath: `${wsRoot}/src/alpha.js`, fileUri: `file://${wsRoot}/src/alpha.js`, isDirectory: false, isHtmlFile: false }]],
    ['preview', [{ name: 'index.html', relPath: 'preview/index.html', absPath: `${wsRoot}/preview/index.html`, fileUri: `file://${wsRoot}/preview/index.html`, isDirectory: false, isHtmlFile: true }]]
  ]);
  const treeFetches = [];
  const openBrowserCalls = [];
  const previewApiCalls = [];
  const resolveApiCalls = [];
  let searchMode = 'truncated';
  const pendingSearchQueue = [];
  const intervalCbs = [];

  const mockLocation = {
    href: `http://127.0.0.1/?path=${encodeURIComponent(`${wsRoot}/src/alpha.js`)}`,
    search: `?path=${encodeURIComponent(`${wsRoot}/src/alpha.js`)}`,
    hash: '',
    pathname: '/',
    origin: 'http://127.0.0.1'
  };

  const docListeners = new Map();
  const winListeners = new Map();
  const sessionMap = new Map();

  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    URL,
    URLSearchParams,
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Promise,
    Error,
    decodeURIComponent,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
    clearInterval,
    setInterval: (fn, ms) => {
      intervalCbs.push({ fn, ms });
      return intervalCbs.length;
    },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    sessionStorage: {
      getItem: (k) => (sessionMap.has(k) ? sessionMap.get(k) : null),
      setItem: (k, v) => sessionMap.set(k, String(v))
    },
    navigator: { platform: 'MacIntel', clipboard: { writeText: async () => {} } },
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ color: 'rgb(255, 255, 255)', getPropertyValue: () => '' }),
    location: mockLocation,
    document: {
      documentElement: {
        clientWidth: 320,
        clientHeight: 600,
        appendChild: () => {},
        getAttribute: () => null,
        hasAttribute: () => false,
        removeAttribute: () => {},
        setAttribute: () => {},
        style: {}
      },
      hidden: false,
      visibilityState: 'visible',
      getElementById: getEl,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: (t, fn) => {
        if (!docListeners.has(t)) docListeners.set(t, []);
        docListeners.get(t).push(fn);
      },
      createElement: () => makeEl('')
    },
    window: null,
    fetch: async (urlStr, opts = {}) => {
      const u = new URL(urlStr, 'http://127.0.0.1');
      if (u.pathname === '/api/workspace') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            roots: [
              { path: wsRoot, name: 'mock-ws', fileUri: `file://${wsRoot}` },
              { path: wsRootB, name: 'mock-ws-b', fileUri: `file://${wsRootB}` }
            ],
            primaryRoot: wsRoot,
            showHidden: false
          })
        };
      }
      if (u.pathname === '/api/shortcut') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, settings: { hotkeyPreset: 'cmd+shift+e', auxShortcut: {} }, presets: [] })
        };
      }
      if (u.pathname === '/api/mentions') {
        return { ok: true, status: 200, json: async () => ({ ok: true, mentions: [] }) };
      }
      if (u.pathname === '/api/tree') {
        const reqRoot = u.searchParams.get('root') || wsRoot;
        const dir = u.searchParams.get('dir') || '';
        treeFetches.push(dir);
        if (reqRoot === wsRootB) {
          const items = dir === ''
            ? [{ name: 'only-in-b.ts', relPath: 'only-in-b.ts', absPath: `${wsRootB}/only-in-b.ts`, fileUri: `file://${wsRootB}/only-in-b.ts`, isDirectory: false }]
            : [];
          return { ok: true, status: 200, json: async () => ({ ok: true, items }) };
        }
        const items = (treeData.get(dir) || []).map((entry) => ({ ...entry }));
        return { ok: true, status: 200, json: async () => ({ ok: true, items }) };
      }
      if (u.pathname === '/api/resolve') {
        const p = u.searchParams.get('path') || '';
        resolveApiCalls.push(p);
        const name = p.split('/').pop();
        const isHtml = p.includes('preview/index.html');
        const relPath = isHtml ? 'preview/index.html' : `src/${name}`;
        const absPath = p.startsWith('/') ? p : `${wsRoot}/${relPath}`;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            exists: true,
            absPath,
            rootPath: wsRoot,
            rootName: 'mock-ws',
            relPath,
            isDirectory: false,
            isHtmlFile: isHtml,
            ancestorRelDirs: [isHtml ? 'preview' : 'src'],
            fileUri: `file://${absPath}`
          })
        };
      }
      if (u.pathname === '/api/open-browser') {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        openBrowserCalls.push({ url: urlStr, body });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            dryRun: true,
            path: body.path || ''
          })
        };
      }
      if (u.pathname === '/api/preview') {
        const p = u.searchParams.get('path') || '';
        previewApiCalls.push(p);
        const name = p.split('/').pop() || 'file';
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            absPath: p,
            relPath: p.startsWith(`${wsRoot}/`) ? p.slice(wsRoot.length + 1) : name,
            name,
            content: '<h1>preview</h1>',
            isBinary: false
          })
        };
      }
      if (u.pathname === '/api/search') {
        if (searchMode === 'deferred') {
          const reqRoot = u.searchParams.get('root') || '';
          const q = u.searchParams.get('q') || '';
          return new Promise((resolvePromise) => {
            pendingSearchQueue.push({
              root: reqRoot,
              q,
              resolve: (payload) => resolvePromise({ ok: true, status: 200, json: async () => payload }),
              reject: (msg = 'Simulated search error') => resolvePromise({ ok: false, status: 500, json: async () => ({ ok: false, error: msg }) })
            });
          });
        }
        if (searchMode === 'error') {
          return { ok: false, status: 500, json: async () => ({ ok: false, error: 'Simulated search failure' }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            truncated: searchMode === 'truncated',
            results: [{
              name: 'needle.js',
              relPath: 'src/needle.js',
              absPath: `${wsRoot}/src/needle.js`,
              fileUri: `file://${wsRoot}/src/needle.js`,
              isDirectory: false
            }]
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  };
  sandbox.window = {
    location: mockLocation,
    history: {
      replaceState: (_st, _title, nextUrl) => {
        const parsed = new URL(nextUrl, 'http://127.0.0.1');
        mockLocation.pathname = parsed.pathname;
        mockLocation.search = parsed.search;
        mockLocation.hash = parsed.hash;
        mockLocation.href = parsed.href;
      }
    },
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    getComputedStyle: () => ({ color: 'rgb(255, 255, 255)', getPropertyValue: () => '' }),
    addEventListener: (t, fn) => {
      if (!winListeners.has(t)) winListeners.set(t, []);
      winListeners.get(t).push(fn);
    },
    parent: null,
    self: null,
    top: null
  };
  sandbox.window.self = sandbox.window;
  sandbox.window.top = sandbox.window;
  sandbox.window.fetch = sandbox.fetch;
  sandbox.globalThis = sandbox;

  vm.runInNewContext(appCode, sandbox, { filename: 'app.js' });
  await new Promise((r) => setTimeout(r, 40));

  const container = getEl('tree-content');
  assert.ok(container.innerHTML.includes('alpha.js'), 'Initial deep link reveal must render alpha.js');

  // R3 check 1: mutate already-cached expanded `src` dir, then reveal newly created `beta.js`
  const fetchesBeforeSecondReveal = treeFetches.length;
  treeData.get('src').push({
    name: 'beta.js',
    relPath: 'src/beta.js',
    absPath: `${wsRoot}/src/beta.js`,
    fileUri: `file://${wsRoot}/src/beta.js`,
    isDirectory: false
  });
  mockLocation.search = `?path=${encodeURIComponent(`${wsRoot}/src/beta.js`)}`;
  mockLocation.href = `http://127.0.0.1/${mockLocation.search}`;
  const deepLinkInterval = intervalCbs.find((c) => c.ms === 350);
  assert.ok(deepLinkInterval, '350ms deep-link watcher must be registered');
  deepLinkInterval.fn();
  await new Promise((r) => setTimeout(r, 40));

  assert.ok(
    treeFetches.slice(fetchesBeforeSecondReveal).includes('src'),
    'revealPathInTree must force-refresh already-cached ancestor dir src (R3)'
  );
  assert.ok(container.innerHTML.includes('beta.js'), 'Tree UI must show newly created beta.js after reveal');

  // UX #1 check: visible expanded directory auto-sync picks up externally added `gamma.js`
  treeData.get('src').push({
    name: 'gamma.js',
    relPath: 'src/gamma.js',
    absPath: `${wsRoot}/src/gamma.js`,
    fileUri: `file://${wsRoot}/src/gamma.js`,
    isDirectory: false
  });
  const syncInterval = intervalCbs.find((c) => c.ms === 3500);
  assert.ok(syncInterval, '3500ms visible expanded-dir sync interval must be registered');
  await syncInterval.fn();
  await new Promise((r) => setTimeout(r, 25));
  assert.ok(container.innerHTML.includes('gamma.js'), 'Visible auto-sync must render newly added gamma.js');

  // S3 check: >25 expanded directories rotate across rounds and collapsed-ancestor dirs do not starve open ones
  const clickDirRow = async (relPath) => {
    const rowStub = { dataset: { relPath, isDir: '1', fileUri: `file://${wsRoot}/${relPath}` } };
    container.dispatch('click', { target: { closest: (sel) => (sel === '.af-tree-row[data-rel-path]' ? rowStub : null) } });
    await new Promise((r) => setTimeout(r, 15));
  };
  const rootItems = treeData.get('');
  for (let i = 1; i <= 30; i++) {
    const d = `dir${i}`;
    rootItems.push({ name: d, relPath: d, absPath: `${wsRoot}/${d}`, fileUri: `file://${wsRoot}/${d}`, isDirectory: true });
    treeData.set(d, [{ name: `f${i}.js`, relPath: `${d}/f${i}.js`, absPath: `${wsRoot}/${d}/f${i}.js`, fileUri: `file://${wsRoot}/${d}/f${i}.js`, isDirectory: false }]);
    await clickDirRow(d);
  }
  treeData.get('dir1').push({ name: 'open_sub', relPath: 'dir1/open_sub', absPath: `${wsRoot}/dir1/open_sub`, fileUri: `file://${wsRoot}/dir1/open_sub`, isDirectory: true });
  treeData.set('dir1/open_sub', []);
  await clickDirRow('dir1/open_sub');

  rootItems.push({ name: 'closed_parent', relPath: 'closed_parent', absPath: `${wsRoot}/closed_parent`, fileUri: `file://${wsRoot}/closed_parent`, isDirectory: true });
  treeData.set('closed_parent', [{ name: 'hidden_sub', relPath: 'closed_parent/hidden_sub', absPath: `${wsRoot}/closed_parent/hidden_sub`, fileUri: `file://${wsRoot}/closed_parent/hidden_sub`, isDirectory: true }]);
  treeData.set('closed_parent/hidden_sub', []);
  await clickDirRow('closed_parent');
  await clickDirRow('closed_parent/hidden_sub');
  // Collapse closed_parent so closed_parent/hidden_sub stays in expanded set under a closed ancestor
  await clickDirRow('closed_parent');

  // Re-select src/beta.js and set scrollTop before rotated sync renders
  const betaRowStub = { dataset: { relPath: 'src/beta.js', isDir: '0', fileUri: `file://${wsRoot}/src/beta.js` } };
  container.dispatch('click', { target: { closest: (sel) => (sel === '.af-tree-row[data-rel-path]' ? betaRowStub : null) } });
  const viewport = getEl('tree-viewport');
  viewport.scrollTop = 120;
  assert.equal(getEl('active-path-text').textContent, 'src/beta.js');

  // Mutate tail dir30 externally before syncing
  treeData.get('dir30').push({ name: 'late30.js', relPath: 'dir30/late30.js', absPath: `${wsRoot}/dir30/late30.js`, fileUri: `file://${wsRoot}/dir30/late30.js`, isDirectory: false });

  const round1Start = treeFetches.length;
  await syncInterval.fn();
  await new Promise((r) => setTimeout(r, 25));
  const round1Dirs = treeFetches.slice(round1Start);
  assert.ok(round1Dirs.length <= 25, `Single sync round must stay bounded (<=25), got ${round1Dirs.length}`);
  assert.ok(!round1Dirs.includes('closed_parent/hidden_sub'), 'Collapsed-ancestor dir must not consume sync quota');

  const round2Start = treeFetches.length;
  await syncInterval.fn();
  await new Promise((r) => setTimeout(r, 25));
  const round2Dirs = treeFetches.slice(round2Start);
  assert.ok(round2Dirs.length <= 25, `Second sync round must stay bounded (<=25), got ${round2Dirs.length}`);

  const twoRoundSet = new Set([...round1Dirs, ...round2Dirs]);
  assert.ok(twoRoundSet.has(''), 'Root directory must be included in sync rotation');
  assert.ok(twoRoundSet.has('dir1/open_sub'), 'Open child dir must be refreshed within two rounds');
  for (let i = 1; i <= 30; i++) {
    assert.ok(twoRoundSet.has(`dir${i}`), `Visible open dir${i} must be synced within two rounds without starvation`);
  }
  assert.ok(container.innerHTML.includes('late30.js'), 'Rotated sync must pick up newly added late30.js in dir30');
  assert.equal(viewport.scrollTop, 120, 'Scroll position must be preserved after rotated auto-sync render');
  assert.equal(getEl('active-path-text').textContent, 'src/beta.js', 'Selected path must be preserved after rotated auto-sync render');

  // UX #3 check: search loading / truncated banner / error banner
  const searchInput = getEl('search-input');
  searchInput.value = 'needle';
  searchInput.dispatch('input', { target: searchInput });
  assert.ok(container.innerHTML.includes('搜索中'), 'Search input must immediately show loading state');
  await new Promise((r) => setTimeout(r, 220));
  assert.ok(container.innerHTML.includes('af-search-note'), 'Truncated search result must display truncation note');
  assert.ok(container.innerHTML.includes('needle.js'), 'Search result must render matched item');

  searchMode = 'error';
  searchInput.value = 'errquery';
  searchInput.dispatch('input', { target: searchInput });
  await new Promise((r) => setTimeout(r, 220));
  assert.ok(container.innerHTML.includes('af-search-error'), 'Failed search request must display error banner');

  // T2 checks: workspace root switching invalidates stale searches & immediately searches new root
  const rootSelect = getEl('root-select');
  const clearBtn = getEl('btn-clear-search');
  searchMode = 'deferred';
  pendingSearchQueue.length = 0;

  // T2.1: Existing search results from A cleared on switch to B, then B searched automatically
  searchInput.value = 'readme';
  searchInput.dispatch('input', { target: searchInput });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(pendingSearchQueue.length, 1);
  assert.equal(pendingSearchQueue[0].root, wsRoot);
  pendingSearchQueue.shift().resolve({
    ok: true,
    truncated: false,
    results: [{ name: 'readme-a.md', relPath: 'readme-a.md', absPath: `${wsRoot}/readme-a.md`, fileUri: `file://${wsRoot}/readme-a.md`, isDirectory: false }]
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(container.innerHTML.includes('readme-a.md'), 'Pre-switch search on A must render readme-a.md');

  rootSelect.dispatch('change', { target: { value: wsRootB } });
  await Promise.resolve();
  assert.ok(!container.innerHTML.includes('readme-a.md'), 'Switching root A->B must clear previous root results');
  assert.ok(container.innerHTML.includes('搜索中'), 'Switching root with active query must enter loading state for B');
  assert.equal(pendingSearchQueue.length, 1);
  assert.equal(pendingSearchQueue[0].root, wsRootB);
  assert.equal(pendingSearchQueue[0].q, 'readme');
  pendingSearchQueue.shift().resolve({
    ok: true,
    truncated: false,
    results: [{ name: 'readme-b.md', relPath: 'readme-b.md', absPath: `${wsRootB}/readme-b.md`, fileUri: `file://${wsRootB}/readme-b.md`, isDirectory: false }]
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(container.innerHTML.includes('readme-b.md'), 'Switching root A->B must render new root search result');
  assert.ok(!container.innerHTML.includes('readme-a.md'), 'Old root result must never reappear after switch');

  // T2.2: In-flight A -> B ignores late response from A and keeps B loading until B resolves
  searchInput.value = '';
  clearBtn.dispatch('click');
  rootSelect.dispatch('change', { target: { value: wsRoot } });
  await new Promise((r) => setTimeout(r, 20));
  pendingSearchQueue.length = 0;

  searchInput.value = 'inflight';
  searchInput.dispatch('input', { target: searchInput });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(pendingSearchQueue.length, 1);
  const reqInflightA = pendingSearchQueue.shift();
  assert.equal(reqInflightA.root, wsRoot);

  rootSelect.dispatch('change', { target: { value: wsRootB } });
  await Promise.resolve();
  assert.equal(pendingSearchQueue.length, 1);
  const reqInflightB = pendingSearchQueue.shift();
  assert.equal(reqInflightB.root, wsRootB);

  reqInflightA.resolve({
    ok: true,
    truncated: false,
    results: [{ name: 'stale-a.md', relPath: 'stale-a.md', absPath: `${wsRoot}/stale-a.md`, fileUri: `file://${wsRoot}/stale-a.md`, isDirectory: false }]
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!container.innerHTML.includes('stale-a.md'), 'Stale in-flight response from A must be ignored after switching to B');
  assert.ok(container.innerHTML.includes('搜索中'), 'UI must stay in loading state while B request is still pending');

  reqInflightB.resolve({
    ok: true,
    truncated: false,
    results: [{ name: 'fresh-b.md', relPath: 'fresh-b.md', absPath: `${wsRootB}/fresh-b.md`, fileUri: `file://${wsRootB}/fresh-b.md`, isDirectory: false }]
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(container.innerHTML.includes('fresh-b.md'), 'B response must commit after ignoring stale A response');

  // T2.3: Rapid A -> B -> A ignores B and earlier A, committing only final A request
  searchInput.value = '';
  clearBtn.dispatch('click');
  rootSelect.dispatch('change', { target: { value: wsRoot } });
  await new Promise((r) => setTimeout(r, 20));
  pendingSearchQueue.length = 0;

  searchInput.value = 'bounce';
  searchInput.dispatch('input', { target: searchInput });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(pendingSearchQueue.length, 1);
  const reqBounceA1 = pendingSearchQueue.shift();

  rootSelect.dispatch('change', { target: { value: wsRootB } });
  await Promise.resolve();
  assert.equal(pendingSearchQueue.length, 1);
  const reqBounceB = pendingSearchQueue.shift();
  assert.equal(reqBounceB.root, wsRootB);

  rootSelect.dispatch('change', { target: { value: wsRoot } });
  await Promise.resolve();
  assert.equal(pendingSearchQueue.length, 1);
  const reqBounceA2 = pendingSearchQueue.shift();
  assert.equal(reqBounceA2.root, wsRoot);

  reqBounceB.resolve({
    ok: true,
    truncated: false,
    results: [{ name: 'bounce-b.md', relPath: 'bounce-b.md', absPath: `${wsRootB}/bounce-b.md`, fileUri: `file://${wsRootB}/bounce-b.md`, isDirectory: false }]
  });
  reqBounceA1.resolve({
    ok: true,
    truncated: false,
    results: [{ name: 'bounce-a-stale.md', relPath: 'bounce-a-stale.md', absPath: `${wsRoot}/bounce-a-stale.md`, fileUri: `file://${wsRoot}/bounce-a-stale.md`, isDirectory: false }]
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!container.innerHTML.includes('bounce-b.md'), 'Rapid A->B->A must ignore late B response');
  assert.ok(!container.innerHTML.includes('bounce-a-stale.md'), 'Rapid A->B->A must ignore superseded first A response');
  assert.ok(container.innerHTML.includes('搜索中'), 'UI must keep loading until final A request settles');

  reqBounceA2.resolve({
    ok: true,
    truncated: false,
    results: [{ name: 'bounce-a-current.md', relPath: 'bounce-a-current.md', absPath: `${wsRoot}/bounce-a-current.md`, fileUri: `file://${wsRoot}/bounce-a-current.md`, isDirectory: false }]
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(container.innerHTML.includes('bounce-a-current.md'), 'Rapid A->B->A must commit final A search result');

  // T2.4: Stale error response from previous root must not pollute new root
  searchInput.value = 'err-root';
  searchInput.dispatch('input', { target: searchInput });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(pendingSearchQueue.length, 1);
  const reqErrA = pendingSearchQueue.shift();

  rootSelect.dispatch('change', { target: { value: wsRootB } });
  await Promise.resolve();
  assert.equal(pendingSearchQueue.length, 1);
  const reqOkB = pendingSearchQueue.shift();

  reqErrA.reject('Previous root A search failed');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!container.innerHTML.includes('af-search-error'), 'Stale error from A must not render error banner on B');
  assert.ok(!container.innerHTML.includes('Previous root A search failed'), 'Stale error text from A must be ignored');
  assert.ok(container.innerHTML.includes('搜索中'), 'New root B must remain loading while reqOkB is in flight');

  reqOkB.resolve({
    ok: true,
    truncated: false,
    results: [{ name: 'recovered-in-b.ts', relPath: 'recovered-in-b.ts', absPath: `${wsRootB}/recovered-in-b.ts`, fileUri: `file://${wsRootB}/recovered-in-b.ts`, isDirectory: false }]
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(container.innerHTML.includes('recovered-in-b.ts'), 'Root B search must resolve cleanly after stale A error');

  // T2.5: Clearing search after switching displays current root directory tree
  clearBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(container.innerHTML.includes('only-in-b.ts'), 'Clearing search on B must display root B directory tree');
  assert.ok(!container.innerHTML.includes('recovered-in-b.ts'), 'Clearing search must exit search results view');

  // HTML browser-open deep link ([🌐] open=browser), replaceState dedupe, Alt+click source fallback & regular .js preview
  const htmlTargetAbs = `${wsRoot}/preview/index.html`;
  const expectedCleanSearch = `?path=${encodeURIComponent(htmlTargetAbs)}`;
  const browserDeepSearch = `${expectedCleanSearch}&open=browser`;

  mockLocation.search = browserDeepSearch;
  mockLocation.href = `http://127.0.0.1/${browserDeepSearch}`;
  deepLinkInterval.fn();
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(openBrowserCalls.length, 1, 'HTML open=browser deep link must trigger /api/open-browser once');
  assert.equal(openBrowserCalls[0].body.path, htmlTargetAbs);
  assert.equal(mockLocation.search, expectedCleanSearch, 'open=browser query param must be stripped via history.replaceState');
  assert.ok(container.innerHTML.includes('index.html'), 'HTML deep link must also reveal preview/index.html in tree');
  assert.equal(getEl('btn-preview-active').textContent, '🌐 浏览器', 'Selected HTML must label active preview button as browser');

  // Repeated 350ms poll on unchanged URL must NOT re-trigger browser open
  deepLinkInterval.fn();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(openBrowserCalls.length, 1, '350ms polling must not re-open browser on cleaned URL');

  // Clicking the same [🌐] link a second time must trigger again
  mockLocation.search = browserDeepSearch;
  mockLocation.href = `http://127.0.0.1/${browserDeepSearch}`;
  deepLinkInterval.fn();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(openBrowserCalls.length, 2, 'Clicking the same [🌐] deep link again must open browser again');

  // Pure [📂] reveal without open=browser must only reveal in tree without calling /api/open-browser
  const pureFileSearch = `?file=${encodeURIComponent(htmlTargetAbs)}`;
  mockLocation.search = pureFileSearch;
  mockLocation.href = `http://127.0.0.1/${pureFileSearch}`;
  deepLinkInterval.fn();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(openBrowserCalls.length, 2, 'Pure reveal link without open=browser must NOT launch browser');
  assert.equal(getEl('btn-preview-active').textContent, '🌐 浏览器');

  // Tree row data-act="preview" on .html: normal click opens browser, Alt+click opens source modal, .js opens source modal
  const dispatchRowPreviewAct = async (relPath, fileUri, altKey = false) => {
    const rowStub = { dataset: { relPath, isDir: '0', fileUri } };
    const actStub = { dataset: { act: 'preview' } };
    container.dispatch('click', {
      altKey,
      stopPropagation: () => {},
      target: {
        closest: (sel) => {
          if (sel === '.af-tree-row[data-rel-path]') return rowStub;
          if (sel === '[data-act]') return actStub;
          return null;
        }
      }
    });
    await new Promise((r) => setTimeout(r, 25));
  };

  await dispatchRowPreviewAct('preview/index.html', `file://${htmlTargetAbs}`, false);
  assert.equal(openBrowserCalls.length, 3, 'Clicking preview action on HTML row must open default browser');

  const previewCountBeforeAlt = previewApiCalls.length;
  await dispatchRowPreviewAct('preview/index.html', `file://${htmlTargetAbs}`, true);
  assert.equal(openBrowserCalls.length, 3, 'Alt+click on HTML row must NOT open browser');
  assert.equal(previewApiCalls.length, previewCountBeforeAlt + 1, 'Alt+click on HTML row must open source preview');
  assert.equal(previewApiCalls.at(-1), htmlTargetAbs);
  assert.equal(getEl('btn-preview-browser').classList.contains('hidden'), false, 'HTML source preview modal must show browser button');

  await dispatchRowPreviewAct('src/alpha.js', `file://${wsRoot}/src/alpha.js`, false);
  assert.equal(openBrowserCalls.length, 3, 'Clicking preview action on .js row must NOT open browser');
  assert.equal(previewApiCalls.length, previewCountBeforeAlt + 2);
  assert.equal(previewApiCalls.at(-1), `${wsRoot}/src/alpha.js`);
  assert.equal(getEl('btn-preview-browser').classList.contains('hidden'), true, 'Non-HTML source preview modal must hide browser button');

  // Z4: postMessage source, host-context & origin boundary checks
  const dispatchWindowMessage = async (ev) => {
    for (const fn of winListeners.get('message') || []) {
      fn(ev);
    }
    await new Promise((r) => setTimeout(r, 20));
  };

  // Negative 1: Standalone top-level window (!window.sidecar, window.parent === null) must reject postMessage actions
  const resolveCountBeforeMsg = resolveApiCalls.length;
  await dispatchWindowMessage({
    origin: 'http://127.0.0.1:8080',
    source: sandbox.window,
    data: { path: htmlTargetAbs, open: 'browser' }
  });
  assert.equal(openBrowserCalls.length, 3, 'Standalone window without sidecar/parent must reject postMessage open=browser');
  assert.equal(resolveApiCalls.length, resolveCountBeforeMsg, 'Standalone window without sidecar/parent must reject postMessage reveal');

  // Switch mock window to embedded Antigravity Sidecar iframe context
  const trustedHostParent = { name: 'host-parent' };
  sandbox.window.parent = trustedHostParent;
  sandbox.window.sidecar = { getWorkspaceUris: async () => [`file://${wsRoot}`] };

  // Negative 2: Untrusted origins from any window (even if source matches parent) must be rejected
  for (const badOrigin of ['https://untrusted.example', 'http://localhost.evil.example', 'http://evil@127.0.0.1:8080', 'null', '']) {
    await dispatchWindowMessage({
      origin: badOrigin,
      source: trustedHostParent,
      data: { path: htmlTargetAbs, open: 'browser' }
    });
    assert.equal(openBrowserCalls.length, 3, `Untrusted origin "${badOrigin}" must NOT trigger openInBrowser`);
    assert.equal(resolveApiCalls.length, resolveCountBeforeMsg, `Untrusted origin "${badOrigin}" must NOT trigger revealPathInTree`);
  }

  // Negative 3: Trusted origin with non-parent source (e.g. opener / sibling window) must be rejected
  await dispatchWindowMessage({
    origin: 'vscode-file://vscode-app',
    source: { name: 'unrelated-opener' },
    data: { path: htmlTargetAbs, open: 'browser' }
  });
  assert.equal(openBrowserCalls.length, 3, 'Non-parent event.source must NOT trigger openInBrowser');
  assert.equal(resolveApiCalls.length, resolveCountBeforeMsg, 'Non-parent event.source must NOT trigger revealPathInTree');

  // Positive 1: Trusted host parent reveal-only message reveals path without launching browser
  await dispatchWindowMessage({
    origin: 'vscode-file://vscode-app',
    source: trustedHostParent,
    data: { path: `${wsRoot}/src/alpha.js` }
  });
  assert.equal(openBrowserCalls.length, 3, 'Trusted reveal-only message must NOT launch browser');
  assert.equal(resolveApiCalls.length, resolveCountBeforeMsg + 1, 'Trusted host parent reveal message must resolve path');
  assert.equal(resolveApiCalls.at(-1), `${wsRoot}/src/alpha.js`);

  // Positive 2: Trusted host parent with vscode-file:// or loopback http origin allows open=browser
  await dispatchWindowMessage({
    origin: 'vscode-file://vscode-app',
    source: trustedHostParent,
    data: { path: htmlTargetAbs, open: 'browser' }
  });
  assert.equal(openBrowserCalls.length, 4, 'Trusted host parent vscode-file:// origin must allow open=browser');
  assert.equal(openBrowserCalls.at(-1).body.path, htmlTargetAbs);

  await dispatchWindowMessage({
    origin: 'http://127.0.0.1:54321',
    source: trustedHostParent,
    data: { path: htmlTargetAbs, open: 'browser' }
  });
  assert.equal(openBrowserCalls.length, 5, 'Trusted host parent loopback http origin must allow open=browser');
  assert.equal(openBrowserCalls.at(-1).body.path, htmlTargetAbs);

  // Negative 4: Drawer mode must reject postMessage bridge even from parent/loopback origin
  sandbox.window.__AF_DRAWER_MODE__ = true;
  await dispatchWindowMessage({
    origin: 'http://127.0.0.1:54321',
    source: trustedHostParent,
    data: { path: htmlTargetAbs, open: 'browser' }
  });
  assert.equal(openBrowserCalls.length, 5, 'Drawer mode must reject postMessage actions');
  sandbox.window.__AF_DRAWER_MODE__ = false;

  pass('VM behavioral checks: R3 reveal cache refresh, UX #1 visible sync, UX #3 search states, T2 multi-root search switch, HTML browser launch & Z4 message origin/source guard');
}

async function verifyFinderAuxBridgeBehavior() {
  const appCode = readFileSync(join(ROOT, 'sidecars/tree/app.js'), 'utf8');
  const wsRoot = '/tmp/agy-finder-vm-aux-bridge';

  const makeStubEl = (id = '') => {
    const classes = new Set();
    const attrs = new Map();
    return {
      id,
      value: '',
      textContent: '',
      innerHTML: '',
      scrollTop: 0,
      dataset: {},
      style: {},
      classList: {
        add: (...names) => names.forEach((n) => classes.add(n)),
        remove: (...names) => names.forEach((n) => classes.delete(n)),
        toggle: (n, force) => {
          const on = force === undefined ? !classes.has(n) : Boolean(force);
          if (on) classes.add(n);
          else classes.delete(n);
          return on;
        },
        contains: (n) => classes.has(n)
      },
      setAttribute: (k, v) => attrs.set(k, String(v)),
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      focus: () => {},
      scrollIntoView: () => {},
      remove: () => {}
    };
  };

  const runFinderScenario = async ({ initialTrigger }) => {
    const els = new Map();
    const getEl = (id) => {
      if (!els.has(id)) els.set(id, makeStubEl(id));
      return els.get(id);
    };
    const trigState = {
      seq: 0,
      targetPlugin: '',
      uri: '',
      action: 'toggle',
      convId: 'conv-af-1',
      revealPath: '',
      at: 0,
      openingSeq: 0,
      ackSeq: 0,
      switchedSeq: 0,
      ...initialTrigger
    };
    const resolvePaths = [];
    const toggleAuxCalls = [];
    const ignoredHiddenToggleAuxCalls = [];
    const toggleConvCalls = [];
    const parentMessages = [];
    const ioCallbacks = [];
    const longPollWaiters = [];
    let currentIoVisible = false;
    const sessionMap = new Map();
    const intervalCbs = [];

    const mockFetch = async (urlStr, opts = {}) => {
      const u = new URL(urlStr, 'http://127.0.0.1');
      if (u.pathname === '/api/aux-pane-trigger') {
        const method = String(opts.method || 'GET').toUpperCase();
        if (method === 'POST') {
          const body = opts.body ? JSON.parse(opts.body) : {};
          const act = String(body.action || '');
          const s = Number(body.seq || 0);
          if (act === 'opening') {
            if (s <= Number(trigState.openingSeq || 0)) {
              return { ok: true, status: 200, json: async () => ({ ok: true, claimed: false, trigger: { ...trigState } }) };
            }
            trigState.openingSeq = s;
            return { ok: true, status: 200, json: async () => ({ ok: true, claimed: true, trigger: { ...trigState } }) };
          }
          if (act === 'switched') {
            if (s <= Number(trigState.switchedSeq || 0)) {
              return { ok: true, status: 200, json: async () => ({ ok: true, claimed: false, trigger: { ...trigState } }) };
            }
            trigState.switchedSeq = s;
            return { ok: true, status: 200, json: async () => ({ ok: true, claimed: true, trigger: { ...trigState } }) };
          }
          if (act === 'ack') {
            if (s < Number(trigState.seq || 0) || Number(trigState.ackSeq || 0) >= s) {
              return { ok: true, status: 200, json: async () => ({ ok: true, claimed: false, trigger: { ...trigState } }) };
            }
            trigState.ackSeq = s;
            trigState.ackPlugin = body.plugin || 'agy-finder';
            return { ok: true, status: 200, json: async () => ({ ok: true, claimed: true, trigger: { ...trigState } }) };
          }
          return { ok: true, status: 200, json: async () => ({ ok: true, trigger: { ...trigState } }) };
        }
        const holdMs = Number(u.searchParams.get('holdMs') || 0);
        if (holdMs > 0) {
          await new Promise((r) => setTimeout(r, Math.min(12, holdMs)));
        }
        const sinceParam = u.searchParams.get('since');
        const waitMs = Number(u.searchParams.get('waitMs') ?? 8500);
        if (sinceParam !== null && Number(sinceParam) >= Number(trigState.seq || 0) && waitMs > 0) {
          const nextTrig = await new Promise((resolvePromise) => {
            longPollWaiters.push(resolvePromise);
          });
          return { ok: true, status: 200, json: async () => ({ ok: true, changed: true, trigger: nextTrig }) };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, trigger: { ...trigState } }) };
      }
      if (u.pathname === '/api/workspace') {
        return { ok: true, status: 200, json: async () => ({ ok: true, roots: [{ path: wsRoot, name: 'ws', fileUri: `file://${wsRoot}` }], primaryRoot: wsRoot, showHidden: false }) };
      }
      if (u.pathname === '/api/tree') {
        return { ok: true, status: 200, json: async () => ({ ok: true, items: [] }) };
      }
      if (u.pathname === '/api/shortcut') {
        return { ok: true, status: 200, json: async () => ({ ok: true, settings: { hotkeyPreset: 'cmd+shift+e', auxShortcut: {} }, presets: [] }) };
      }
      if (u.pathname === '/api/mentions') {
        return { ok: true, status: 200, json: async () => ({ ok: true, mentions: [] }) };
      }
      if (u.pathname === '/api/resolve') {
        const p = u.searchParams.get('path') || '';
        resolvePaths.push(p);
        const relPath = p.replace(/^\/+/, '');
        const absPath = p.startsWith('/') ? p : `${wsRoot}/${relPath}`;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            exists: true,
            absPath,
            rootPath: wsRoot,
            rootName: 'ws',
            relPath,
            isDirectory: false,
            isHtmlFile: relPath.endsWith('.html'),
            ancestorRelDirs: relPath.includes('/') ? [relPath.split('/')[0]] : [],
            fileUri: `file://${absPath}`
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    const loc = { origin: 'http://127.0.0.1', pathname: '/', search: '', hash: '', href: 'http://127.0.0.1/' };
    const sandbox = {
      console,
      Date,
      Math,
      JSON,
      URL,
      URLSearchParams,
      Set,
      Map,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Promise,
      Error,
      decodeURIComponent,
      encodeURIComponent,
      setTimeout,
      clearTimeout,
      clearInterval,
      setInterval: (fn, ms) => {
        intervalCbs.push({ fn, ms });
        return intervalCbs.length;
      },
      requestAnimationFrame: (fn) => { fn(); return 1; },
      sessionStorage: {
        getItem: (k) => (sessionMap.has(k) ? sessionMap.get(k) : null),
        setItem: (k, v) => sessionMap.set(k, String(v))
      },
      navigator: { platform: 'MacIntel', clipboard: { writeText: async () => {} } },
      MutationObserver: class { observe() {} disconnect() {} },
      ResizeObserver: class { observe() {} disconnect() {} },
      IntersectionObserver: class {
        constructor(cb) {
          ioCallbacks.push(cb);
        }
        observe() {}
        disconnect() {}
      },
      getComputedStyle: () => ({ color: 'rgb(255, 255, 255)', getPropertyValue: () => '' }),
      location: loc,
      document: {
        documentElement: {
          clientWidth: 320,
          clientHeight: 600,
          appendChild: () => {},
          getAttribute: () => null,
          hasAttribute: () => false,
          removeAttribute: () => {},
          setAttribute: () => {},
          style: {}
        },
        hidden: false,
        visibilityState: 'visible',
        getElementById: getEl,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {},
        createElement: () => makeStubEl('')
      },
      window: null,
      fetch: mockFetch
    };
    sandbox.window = {
      location: loc,
      history: { replaceState: () => {} },
      matchMedia: () => ({ matches: false, addEventListener: () => {} }),
      getComputedStyle: sandbox.getComputedStyle,
      addEventListener: () => {},
      parent: { postMessage: (msg) => parentMessages.push(msg) },
      sidecar: {
        conversationId: 'conv-af-1',
        fetch: mockFetch,
        getWorkspaceUris: async () => [`file://${wsRoot}`],
        onWorkspaceChange: () => () => {},
        ui: {
          toggleAuxPane: (req) => {
            // Host Cyc unmounts toggle-aux-pane while the iframe is hidden (visible === false).
            if (!currentIoVisible) {
              ignoredHiddenToggleAuxCalls.push(req);
              return;
            }
            toggleAuxCalls.push(req);
          },
          toggleConversation: (id) => toggleConvCalls.push(id)
        }
      },
      self: null,
      top: null,
      fetch: mockFetch
    };
    sandbox.window.self = sandbox.window;
    sandbox.window.top = sandbox.window;
    sandbox.globalThis = sandbox;

    vm.runInNewContext(appCode, sandbox, { filename: 'finder-aux-bridge.js' });
    await new Promise((r) => setTimeout(r, 25));

    return {
      trigState,
      resolvePaths,
      toggleAuxCalls,
      ignoredHiddenToggleAuxCalls,
      toggleConvCalls,
      parentMessages,
      setIoVisible: (visible) => {
        currentIoVisible = Boolean(visible);
        for (const cb of ioCallbacks) {
          cb([{
            isIntersecting: currentIoVisible,
            intersectionRect: currentIoVisible ? { width: 320, height: 600 } : { width: 0, height: 0 }
          }]);
        }
      },
      pushTrigger: (patch) => {
        Object.assign(trigState, patch);
        const snap = { ...trigState };
        for (const r of longPollWaiters.splice(0)) r(snap);
      }
    };
  };

  // Case 1: Hidden agy-finder expands Aux Pane via toggleConversation, then switches to peer via toggleAuxPane once visible
  const sc1 = await runFinderScenario({
    initialTrigger: { seq: 19, at: Date.now() - 10000, ackSeq: 19, openingSeq: 19, switchedSeq: 19 }
  });
  sc1.setIoVisible(false);
  sc1.pushTrigger({
    seq: 20,
    targetPlugin: 'context-viewer',
    uri: 'sidecar://context-viewer/dashboard/',
    action: 'toggle',
    convId: 'conv-af-1',
    at: Date.now(),
    openingSeq: 0,
    switchedSeq: 0
  });
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(sc1.trigState.openingSeq, 20, 'Hidden agy-finder must claim openingSeq=20');
  assert.equal(sc1.trigState.switchedSeq, 0, 'Hidden agy-finder must NOT pre-mark switchedSeq while hidden');
  assert.equal(sc1.ignoredHiddenToggleAuxCalls.length, 0, 'Hidden agy-finder must NOT call toggleAuxPane while hidden');
  assert.equal(sc1.toggleAuxCalls.length, 0, 'Visible toggleAuxPane must wait until iframe becomes visible');
  assert.deepEqual(sc1.toggleConvCalls, ['conv-af-1'], 'Hidden agy-finder must call toggleConversation to unfold Aux Pane');

  sc1.setIoVisible(true);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(sc1.trigState.switchedSeq, 20, 'Visible agy-finder peer must mark switchedSeq=20');
  assert.equal(sc1.trigState.ackSeq, 20, 'Visible agy-finder peer must mark ackSeq=20');
  assert.equal(sc1.ignoredHiddenToggleAuxCalls.length, 0, 'No hidden toggleAuxPane calls should occur');
  assert.equal(sc1.toggleAuxCalls.length, 1, 'Once visible, agy-finder must invoke toggleAuxPane for peer tab');
  assert.equal(sc1.toggleAuxCalls[0]?.tabType, 'sidecarView');
  assert.equal(sc1.toggleAuxCalls[0]?.uri, 'sidecar://context-viewer/dashboard/');

  // Case 2: Cold-mounted agy-finder acks seq=21, reveals preview/index.html, does NOT post close key, and closes on next visible toggle
  const sc2 = await runFinderScenario({
    initialTrigger: {
      seq: 21,
      targetPlugin: 'agy-finder',
      uri: 'sidecar://agy-finder/tree/',
      action: 'toggle',
      convId: 'conv-af-1',
      revealPath: 'preview/index.html',
      at: Date.now() - 25,
      openingSeq: 21,
      ackSeq: 20,
      switchedSeq: 0
    }
  });
  sc2.setIoVisible(true);
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(sc2.trigState.ackSeq, 21, 'Cold-mounted agy-finder must advance ackSeq=21');
  assert.ok(sc2.resolvePaths.includes('preview/index.html'), `Cold-mounted agy-finder must reveal preview/index.html: ${JSON.stringify(sc2.resolvePaths)}`);
  assert.equal(sc2.parentMessages.filter((m) => m?.type === 'sidecar-key-event').length, 0, 'Cold-mounted agy-finder must NOT post close shortcut');
  assert.equal(sc2.ignoredHiddenToggleAuxCalls.length, 0);
  await new Promise((r) => setTimeout(r, 55));
  sc2.pushTrigger({
    seq: 22,
    targetPlugin: 'agy-finder',
    uri: 'sidecar://agy-finder/tree/',
    action: 'toggle',
    convId: 'conv-af-1',
    revealPath: '',
    at: Date.now(),
    openingSeq: 0,
    switchedSeq: 0
  });
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(sc2.trigState.ackSeq, 22, 'Visible agy-finder toggle must advance ackSeq=22');
  assert.ok(
    sc2.parentMessages.some((m) => m?.type === 'sidecar-key-event' && m?.payload?.key === 'b' && m?.payload?.shiftKey === true),
    `Already-visible agy-finder receiving hotkey again must post close shortcut: ${JSON.stringify(sc2.parentMessages)}`
  );

  // Case 3: Cross-plugin switch into already-mounted hidden agy-finder still reveals revealPath even when ackSeq was pre-claimed by visible peer
  const sc3 = await runFinderScenario({
    initialTrigger: { seq: 21, at: Date.now() - 10000, ackSeq: 21, openingSeq: 21, switchedSeq: 21 }
  });
  sc3.setIoVisible(false);
  Object.assign(sc3.trigState, {
    seq: 23,
    targetPlugin: 'agy-finder',
    uri: 'sidecar://agy-finder/tree/',
    action: 'open',
    convId: 'conv-af-1',
    revealPath: 'src/alpha.js',
    at: Date.now(),
    openingSeq: 23,
    switchedSeq: 23,
    ackSeq: 23,
    ackPlugin: 'context-viewer'
  });
  sc3.setIoVisible(true);
  await new Promise((r) => setTimeout(r, 45));
  assert.ok(sc3.resolvePaths.includes('src/alpha.js'), `Mounted agy-finder becoming visible must still reveal src/alpha.js when peer pre-acked: ${JSON.stringify(sc3.resolvePaths)}`);

  pass('VM behavioral checks: Aux Pane hidden toggleConversation wakeup, visible toggleAuxPane handoff, cold-mount close guard & cross-plugin revealPath preservation');
}

// 12. SessionStart CLI host guard hook checks (unit + subprocess stdin/stdout)
function verifyCliSessionHostGuard() {
  assert.equal(
    isCliHostSession({ transcriptPath: '/mock/.gemini/antigravity-cli/brain/conv/transcript.jsonl' }, {}),
    true,
    'POSIX antigravity-cli transcriptPath must be detected as CLI'
  );
  assert.equal(
    isCliHostSession({ artifactDirectoryPath: 'D:\\mock\\.gemini\\antigravity-cli\\brain\\conv' }, {}),
    true,
    'Windows antigravity-cli artifactDirectoryPath must be detected as CLI'
  );
  assert.equal(
    isCliHostSession(
      { transcriptPath: '/mock/.gemini/antigravity/brain/conv/transcript.jsonl' },
      { ANTIGRAVITY_LS_VERSION: 'cli-1.5.13', ANTIGRAVITY_PROJECT_ID: 'default-cli-project' }
    ),
    false,
    'Desktop transcriptPath must take precedence over inherited CLI env vars'
  );
  assert.equal(
    isCliHostSession({ artifactDirectoryPath: '/mock/.gemini/antigravity-ide/brain/conv' }, {}),
    false,
    'IDE artifactDirectoryPath must not be treated as CLI'
  );
  assert.equal(
    isCliHostSession({}, { ANTIGRAVITY_APP_DATA_DIR: '/mock/.gemini/antigravity-cli' }),
    true
  );
  assert.equal(
    isCliHostSession({}, { ANTIGRAVITY_APP_DATA_DIR: '/mock/.gemini/antigravity-client' }),
    false,
    'Non-CLI directory name with antigravity-cli prefix must not false-positive'
  );
  assert.equal(
    isCliHostSession({}, { ANTIGRAVITY_LS_VERSION: 'cli-1.5.13' }),
    true
  );
  assert.equal(
    isCliHostSession({}, { ANTIGRAVITY_PROJECT_ID: 'default-cli-project' }),
    true
  );
  assert.equal(
    isCliHostSession({}, {}),
    false
  );

  const cliOutObj = buildSessionStartOutput({ transcriptPath: '/mock/.gemini/antigravity-cli/brain/c1/transcript.jsonl' }, {});
  assert.equal(cliOutObj.injectSteps?.length, 1);
  assert.equal(cliOutObj.injectSteps[0].systemMessage?.systemMessage, CLI_GUARD_MESSAGE);
  assert.deepEqual(buildSessionStartOutput({ transcriptPath: '/mock/.gemini/antigravity/brain/c1/transcript.jsonl' }, {}), {});

  const cleanEnv = { PATH: process.env.PATH || '' };
  const cliSubOut = JSON.parse(
    execFileSync(process.execPath, ['hooks/session_host_guard.mjs'], {
      cwd: ROOT,
      env: cleanEnv,
      input: JSON.stringify({
        hookEventName: 'SessionStart',
        transcriptPath: '/mock/.gemini/antigravity-cli/brain/c1/.system_generated/logs/transcript.jsonl'
      }),
      encoding: 'utf8'
    })
  );
  assert.equal(cliSubOut.injectSteps?.[0]?.systemMessage?.systemMessage, CLI_GUARD_MESSAGE);

  const desktopSubOut = JSON.parse(
    execFileSync(process.execPath, ['hooks/session_host_guard.mjs'], {
      cwd: ROOT,
      env: cleanEnv,
      input: JSON.stringify({
        hookEventName: 'SessionStart',
        transcriptPath: '/mock/.gemini/antigravity/brain/c1/.system_generated/logs/transcript.jsonl'
      }),
      encoding: 'utf8'
    })
  );
  assert.deepEqual(desktopSubOut, {});

  const badJsonSubOut = JSON.parse(
    execFileSync(process.execPath, ['hooks/session_host_guard.mjs'], {
      cwd: ROOT,
      env: cleanEnv,
      input: '{not-json',
      encoding: 'utf8'
    })
  );
  assert.deepEqual(badJsonSubOut, {});

  pass('SessionStart CLI host guard hook (POSIX/Win path detection, desktop/IDE precedence & stdin/stdout contract)');
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

async function verifyAutoUpdater() {
  assert.equal(compareSemver('0.3.1', '0.3.0'), 1);
  assert.equal(compareSemver('0.3.0', '0.3.0'), 0);
  assert.equal(compareSemver('0.3.0-beta.1', '0.3.0'), -1);
  assert.equal(parseSemver('invalid'), null);

  assert.throws(() => extractZipBuffer(buildTestZip([{ name: '../evil.txt', data: 'x' }])), /越界路径/);
  assert.throws(() => extractZipBuffer(buildTestZip([{ name: 'agy-finder/link', data: 'x', unixMode: 0o120777 }])), /符号链接/);
  assert.throws(() => extractZipBuffer(buildTestZip([{ name: 'agy-finder/a.txt', data: 'abc', badCrc: true }])), /CRC-32/);

  const work = mkdtempSync(join(tmpdir(), 'agy-finder-updater-test-'));
  const targetDir = join(work, 'installed', 'agy-finder');
  const dataDir = join(work, 'state');
  mkdirSync(join(targetDir, 'sidecars', 'tree'), { recursive: true });
  writeFileSync(join(targetDir, 'plugin.json'), JSON.stringify({
    name: 'agy-finder',
    version: '0.3.0',
    repository: 'https://github.com/Dong-Kevin/agy-plugins'
  }, null, 2));
  writeFileSync(join(targetDir, 'sidecars', 'tree', 'main.mjs'), '// old-v0.3.0\n');
  writeFileSync(join(targetDir, 'sidecars', 'tree', 'sidecar.json'), JSON.stringify({ version: '0.3.0' }));

  const nextZip = buildTestZip([
    {
      name: 'agy-finder/plugin.json',
      data: JSON.stringify({ name: 'agy-finder', version: '0.3.1', repository: 'https://github.com/Dong-Kevin/agy-plugins' })
    },
    { name: 'agy-finder/sidecars/tree/main.mjs', data: '// upgraded-v0.3.1\n' },
    { name: 'agy-finder/sidecars/tree/sidecar.json', data: JSON.stringify({ version: '0.3.1' }) },
    { name: 'agy-finder/sidecars/tree/cli.mjs', data: '#!/usr/bin/env node\n', executable: true }
  ]);
  const validSha = createHash('sha256').update(nextZip).digest('hex');

  let mode = 'normal';
  let apiHits = 0;
  let baseUrl = '';
  const srv = createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    if (u.pathname === '/api/latest') {
      apiHits += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        tag_name: 'v2026.12.01',
        name: 'v2026.12.01',
        html_url: 'https://github.com/Dong-Kevin/agy-plugins/releases/tag/v2026.12.01',
        published_at: '2026-12-01T00:00:00Z',
        body: 'Test release',
        assets: [
          { name: 'agy-finder-v0.3.1.zip', size: nextZip.length, browser_download_url: `${baseUrl}/dl/zip` },
          { name: 'agy-finder-v0.3.1.zip.sha256', size: 80, browser_download_url: `${baseUrl}/dl/sha` }
        ]
      }));
      return;
    }
    if (u.pathname === '/dl/sha') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`${mode === 'bad-sha' ? '0'.repeat(64) : validSha}  agy-finder-v0.3.1.zip\n`);
      return;
    }
    if (u.pathname === '/dl/zip') {
      if (mode === 'evil-redirect') {
        res.writeHead(302, { Location: 'https://evil.example.invalid/malware.zip' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      res.end(nextZip);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const prevEnv = {
    AGY_FINDER_DATA_DIR: process.env.AGY_FINDER_DATA_DIR,
    AGY_FINDER_UPDATE_TARGET_DIR: process.env.AGY_FINDER_UPDATE_TARGET_DIR,
    AGY_FINDER_UPDATE_API_URL: process.env.AGY_FINDER_UPDATE_API_URL,
    AGY_FINDER_UPDATE_ALLOWED_HOSTS: process.env.AGY_FINDER_UPDATE_ALLOWED_HOSTS
  };
  try {
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${srv.address().port}`;
    process.env.AGY_FINDER_DATA_DIR = dataDir;
    process.env.AGY_FINDER_UPDATE_TARGET_DIR = targetDir;
    process.env.AGY_FINDER_UPDATE_API_URL = `${baseUrl}/api/latest`;
    process.env.AGY_FINDER_UPDATE_ALLOWED_HOSTS = '127.0.0.1';

    const first = await checkForUpdates({ force: true });
    assert.equal(first.ok, true);
    assert.equal(first.hasUpdate, true);
    assert.equal(first.currentVersion, '0.3.0');
    assert.equal(first.latestVersion, '0.3.1');

    const cached = await checkForUpdates({ force: false });
    assert.equal(cached.fromCache, true);
    assert.equal(apiHits, 1, 'Second non-forced check must hit 6h cache');

    mode = 'evil-redirect';
    const evilRes = await performSelfUpdate();
    assert.equal(evilRes.ok, false);
    assert.match(evilRes.error || '', /不受信任的更新域名/);

    mode = 'bad-sha';
    const badShaRes = await performSelfUpdate();
    assert.equal(badShaRes.ok, false);
    assert.match(badShaRes.error || '', /SHA-256/);
    assert.ok(readFileSync(join(targetDir, 'sidecars', 'tree', 'main.mjs'), 'utf8').includes('old-v0.3.0'));

    mode = 'normal';
    const okRes = await performSelfUpdate();
    assert.equal(okRes.ok, true, `Expected update success: ${okRes.error}`);
    assert.equal(okRes.updated, true);
    assert.equal(okRes.previousVersion, '0.3.0');
    assert.equal(okRes.currentVersion, '0.3.1');
    assert.equal(JSON.parse(readFileSync(join(targetDir, 'plugin.json'), 'utf8')).version, '0.3.1');
    assert.ok(readFileSync(join(targetDir, 'sidecars', 'tree', 'main.mjs'), 'utf8').includes('upgraded-v0.3.1'));
    assert.equal(JSON.parse(readFileSync(join(targetDir, 'sidecars', 'tree', 'sidecar.json'), 'utf8')).version, '0.3.1');

    pass('Auto-updater (Semver, Zip-Slip/symlink/CRC-32, allowlist redirect, SHA-256 guard & atomic E2E upgrade)');
  } finally {
    srv.close();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  verifyManifestAndAssets();
  verifySyntax();
  verifyCssAndHtml();
  await verifyPathUtils();
  verifyMentionsIncremental();
  verifyShortcutAndCli();
  await verifyStandaloneHttp();
  verifyInstaller();
  verifyPathResolutionAndSymlinkSearch();
  await verifyFinderFrontendBehavior();
  await verifyFinderAuxBridgeBehavior();
  verifyCliSessionHostGuard();
  await verifyAutoUpdater();
  console.log('\nAll agy-finder verification checks passed.');
}

main().catch((err) => {
  console.error('\n[FAIL]', err);
  process.exit(1);
});
