/**
 * Self-contained verification suite for agy-finder.
 * Zero external dependencies; cleans up all temporary test directories.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
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
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

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
  listDirectoryEntries,
  normalizeRawPathInput,
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

  const skillText = readFileSync(join(ROOT, 'skills/agy-finder/SKILL.md'), 'utf8');
  assert.ok(skillText.trimStart().startsWith('---'), 'SKILL.md must have YAML frontmatter');
  assert.ok(skillText.includes('name: agy-finder'));

  const sidecar = JSON.parse(readFileSync(join(ROOT, 'sidecars/tree/sidecar.json'), 'utf8'));
  assert.equal(sidecar.has_web_ui, true);
  assert.ok(sidecar.ui_config.views.some((v) => v.entrypoint === 'SIDECAR_UI_ENTRYPOINT_AUX_PANE' && v.path === '/'));
  pass('Manifest, rules/AGENTS.md, SKILL.md, and sidecar.json schema');
}

// 2. JS syntax & macOS Swift typecheck
function verifySyntax() {
  const files = [
    'sidecars/tree/main.mjs',
    'sidecars/tree/path_utils.mjs',
    'sidecars/tree/mentions.mjs',
    'sidecars/tree/drawer.mjs',
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
    'preview-modal'
  ]) {
    assert.ok(html.includes(`id="${id}"`), `index.html must include #${id}`);
  }
  pass('CSS --af-* namespace isolation and index.html preload/hidden/shortcut UI checks');
}

// 4. Path normalization, resolution, hidden auto-enable, external root & traversal guard
function verifyPathUtils() {
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
  } finally {
    rmSync(extDir, { recursive: true, force: true });
  }
  pass('Path normalization (incl. Windows C:\\path:line), reveal resolution, preview reader & 403 traversal guard');
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

    // Append new reply line -> byte-offset incremental read
    const secondStep = {
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      content: '新增引用 `sidecars/tree/mentions.mjs:12` 与不存在的 `not/exists.ts`。'
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
        afAppSource.includes('toggleConversation(targetConvId)') &&
        afAppSource.includes('agy_aux_last_reveal_seq') &&
        !afAppSource.includes('return window.innerWidth > 40 && window.innerHeight > 40;'),
      'tree/app.js must implement IntersectionObserver visibility check, holdMs wakeup, toggleConversation bridge, and revealPath preservation'
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
        AGY_FINDER_DISABLE_DRAWER: '1'
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

    pass('Standalone loopback HTTP APIs (/api/shortcut, /api/preview), Host guard (403), and CSRF guard (403)');
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
    }

    pass('R2 dotfile/parent relative path resolution & R5 symlink cycle/alias deduplication');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

// 10. Behavioral VM test for R3 (cached expanded dir refresh on reveal + visible auto-sync) & UX #3 (search states)
async function verifyFinderFrontendBehavior() {
  const appCode = readFileSync(join(ROOT, 'sidecars', 'tree', 'app.js'), 'utf8');
  const wsRoot = '/mock-ws';

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
    ['', [{ name: 'src', relPath: 'src', absPath: `${wsRoot}/src`, fileUri: `file://${wsRoot}/src`, isDirectory: true }]],
    ['src', [{ name: 'alpha.js', relPath: 'src/alpha.js', absPath: `${wsRoot}/src/alpha.js`, fileUri: `file://${wsRoot}/src/alpha.js`, isDirectory: false }]]
  ]);
  const treeFetches = [];
  let searchMode = 'truncated';
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
    fetch: async (urlStr) => {
      const u = new URL(urlStr, 'http://127.0.0.1');
      if (u.pathname === '/api/workspace') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, roots: [{ path: wsRoot, name: 'mock-ws' }], primaryRoot: wsRoot, showHidden: false })
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
        const dir = u.searchParams.get('dir') || '';
        treeFetches.push(dir);
        const items = (treeData.get(dir) || []).map((entry) => ({ ...entry }));
        return { ok: true, status: 200, json: async () => ({ ok: true, items }) };
      }
      if (u.pathname === '/api/resolve') {
        const p = u.searchParams.get('path') || '';
        const name = p.split('/').pop();
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            exists: true,
            absPath: p,
            rootPath: wsRoot,
            rootName: 'mock-ws',
            relPath: `src/${name}`,
            isDirectory: false,
            ancestorRelDirs: ['src'],
            fileUri: `file://${p}`
          })
        };
      }
      if (u.pathname === '/api/search') {
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
    history: { replaceState: () => {} },
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

  pass('VM behavioral checks: R3 reveal cache refresh, UX #1 visible sync, and UX #3 search states');
}

async function main() {
  verifyManifestAndAssets();
  verifySyntax();
  verifyCssAndHtml();
  verifyPathUtils();
  verifyMentionsIncremental();
  verifyShortcutAndCli();
  await verifyStandaloneHttp();
  verifyInstaller();
  verifyPathResolutionAndSymlinkSearch();
  await verifyFinderFrontendBehavior();
  console.log('\nAll agy-finder verification checks passed.');
}

main().catch((err) => {
  console.error('\n[FAIL]', err);
  process.exit(1);
});
