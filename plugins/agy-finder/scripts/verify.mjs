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
  writeFileSync
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  getAuxShortcutConfig,
  getDrawerShortcutConfig,
  getShortcutSettings,
  saveShortcutSettings,
  setAuxShortcutConfig,
  setDrawerShortcutConfig
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

async function main() {
  verifyManifestAndAssets();
  verifySyntax();
  verifyCssAndHtml();
  verifyPathUtils();
  verifyMentionsIncremental();
  verifyShortcutAndCli();
  await verifyStandaloneHttp();
  verifyInstaller();
  console.log('\nAll agy-finder verification checks passed.');
}

main().catch((err) => {
  console.error('\n[FAIL]', err);
  process.exit(1);
});
