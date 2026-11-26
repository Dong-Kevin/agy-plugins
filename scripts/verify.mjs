#!/usr/bin/env node
/**
 * Repository-wide Verification & Privacy Audit Suite for Dong-Kevin/agy-plugins.
 * Usage:
 *   node scripts/verify.mjs [--strict-git-identity]
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Script } from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const STRICT_GIT_IDENTITY = process.argv.includes('--strict-git-identity');

function pass(msg) {
  console.log(`[PASS] ${msg}`);
}

function walkFiles(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'dist', 'node_modules', 'data'].includes(ent.name)) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, out);
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

function verifyRootStructureAndSyntax(allFiles) {
  const requiredRootFiles = [
    'README.md',
    'README_EN.md',
    'LICENSE',
    'AGENTS.md',
    'ROADMAP.md',
    '.gitignore',
    'install.sh',
    'install.ps1',
    'scripts/pre-push',
    'scripts/package-all.mjs',
    'scripts/verify.mjs'
  ];
  for (const rel of requiredRootFiles) {
    assert.ok(existsSync(join(ROOT, rel)), `缺少根目录文件：${rel}`);
  }

  if (process.platform !== 'win32') {
    for (const rel of ['install.sh', 'scripts/pre-push', 'scripts/package-all.mjs', 'scripts/verify.mjs']) {
      assert.ok((statSync(join(ROOT, rel)).mode & 0o111) !== 0, `脚本缺少可执行权限：${rel}`);
    }
  }

  for (const f of allFiles) {
    const rel = relative(ROOT, f);
    const ext = extname(f);
    if (ext === '.sh' || rel === 'scripts/pre-push') {
      execFileSync('bash', ['-n', f], { stdio: 'pipe' });
    } else if (ext === '.js' || ext === '.mjs') {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } else if (ext === '.ps1') {
      const psSrc = readFileSync(f, 'utf-8');
      const re = /\$VerifyJs\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/g;
      let match;
      let count = 0;
      while ((match = re.exec(psSrc)) !== null) {
        count++;
        new Script(match[1], { filename: `${rel}#VerifyJs#${count}` });
      }
      if (rel.startsWith('plugins/') && rel.endsWith('/install.ps1')) {
        assert.ok(count >= 1, `${rel} 缺少可解析的 $VerifyJs JS 校验块`);
      }
    }
  }
  pass('Repository structure, executable bits, bash (-n) & Node.js (--check) syntax');
}

function verifyPluginCatalog() {
  const pluginsDir = join(ROOT, 'plugins');
  assert.ok(existsSync(pluginsDir), '缺少 plugins/ 目录');
  const pluginDirs = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  assert.ok(pluginDirs.length >= 2, 'plugins/ 下至少应包含 2 个已迁移插件');

  const allowedKeys = new Set([
    '$schema', 'name', 'displayName', 'display_name', 'description', 'version',
    'disabled', 'logo', 'suggestedPrompts', 'suggested_prompts', 'skills',
    'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'
  ]);
  const seenNames = new Set();
  const seenSkills = new Set();

  for (const dirName of pluginDirs) {
    const pDir = join(pluginsDir, dirName);
    const manifestPath = join(pDir, 'plugin.json');
    assert.ok(existsSync(manifestPath), `plugins/${dirName} 缺少 plugin.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

    for (const k of Object.keys(manifest)) {
      assert.ok(allowedKeys.has(k), `plugins/${dirName}/plugin.json 包含未知顶层字段：${k}`);
    }
    assert.ok(typeof manifest.name === 'string' && /^[a-z0-9-]+$/.test(manifest.name), `无效插件 name：${manifest.name}`);
    assert.ok(!seenNames.has(manifest.name), `插件 name 全局冲突：${manifest.name}`);
    seenNames.add(manifest.name);

    assert.equal(
      manifest.repository,
      'https://github.com/Dong-Kevin/agy-plugins',
      `plugins/${dirName}/plugin.json repository 必须为字符串 https://github.com/Dong-Kevin/agy-plugins`
    );
    assert.ok(typeof manifest.homepage === 'string' && manifest.homepage.includes(`/plugins/${dirName}`), `plugins/${dirName} homepage 应指向插件子目录`);
    assert.ok(manifest.logo && !manifest.logo.startsWith('/') && !/^https?:/i.test(manifest.logo), `plugins/${dirName} logo 必须为相对路径`);
    assert.ok(existsSync(join(pDir, manifest.logo)), `plugins/${dirName} logo 不存在：${manifest.logo}`);
    if (manifest.suggestedPrompts) {
      assert.ok(Array.isArray(manifest.suggestedPrompts) && manifest.suggestedPrompts.length <= 3);
    }

    assert.ok(existsSync(join(pDir, 'README.md')), `plugins/${dirName} 缺少 README.md`);
    assert.ok(existsSync(join(pDir, 'install.sh')), `plugins/${dirName} 缺少 install.sh`);
    assert.ok(existsSync(join(pDir, 'install.ps1')), `plugins/${dirName} 缺少 install.ps1`);

    const skillsDir = join(pDir, 'skills');
    if (existsSync(skillsDir)) {
      for (const sEnt of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!sEnt.isDirectory()) continue;
        assert.ok(!seenSkills.has(sEnt.name), `全局 skill 名称冲突：${sEnt.name}`);
        seenSkills.add(sEnt.name);
        const skillMd = join(skillsDir, sEnt.name, 'SKILL.md');
        assert.ok(existsSync(skillMd), `缺少 ${relative(ROOT, skillMd)}`);
      }
    }
  }
  pass(`Plugin catalog & official schema integrity (${pluginDirs.join(', ')})`);
  return pluginDirs;
}

function verifyPrivacyPngAndGitIdentity(allFiles) {
  const verifySelfRel = relative(ROOT, fileURLToPath(import.meta.url));
  const binaryExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico']);
  const forbiddenPngChunks = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME']);

  const patterns = [
    { re: /\/Users\/[A-Za-z0-9._-]+/g, label: 'macOS 个人主目录路径 (/Users/...)' },
    { re: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/g, label: 'Windows 个人主目录路径 (C:\\Users\\...)' },
    { re: /\/home\/[a-z0-9._-]+\//g, label: 'Linux 个人主目录路径 (/home/...)' },
    { re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, label: '会话 UUID 硬编码' },
    { re: /\b(AIza[0-9A-Za-z-_]{35}|ghp_[0-9A-Za-z]{36}|sk-[0-9A-Za-z]{32,})\b/g, label: '疑似 API Key / Token' },
    { re: /\b[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com\b|example\.(?:com|org|net)\b|localhost\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, label: '未脱敏邮箱地址' },
    { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g, label: 'PEM 私钥头' },
    { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g, label: '疑似明文 Bearer Token' },
    { re: /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@/g, label: '带内联凭据的 URL' }
  ];

  for (const f of allFiles) {
    const rel = relative(ROOT, f).replace(/\\/g, '/');
    if (rel === verifySelfRel) continue;
    const ext = extname(f).toLowerCase();
    if (binaryExts.has(ext)) {
      if (ext === '.png') {
        const buf = readFileSync(f);
        assert.ok(buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47, `PNG 签名无效：${rel}`);
        let offset = 8;
        while (offset + 8 <= buf.length) {
          const chunkLen = buf.readUInt32BE(offset);
          const chunkType = buf.subarray(offset + 4, offset + 8).toString('ascii');
          assert.ok(!forbiddenPngChunks.has(chunkType), `PNG 图片 ${rel} 存在未剥离元数据块：${chunkType}`);
          offset += 12 + chunkLen;
        }
      }
      continue;
    }

    const st = statSync(f);
    if (st.size > 2 * 1024 * 1024) continue;
    const text = readFileSync(f, 'utf-8');
    const isPluginVerify = rel.endsWith('/scripts/verify.mjs');

    for (const pat of patterns) {
      pat.re.lastIndex = 0;
      const matches = text.match(pat.re) || [];
      for (const hit of matches) {
        if (isPluginVerify) {
          if (
            /^\/(?:Users|home)\/(?:alice|bob|demo|user|example|secretuser|mockuser|\.\.\.)\b/i.test(hit) ||
            /^\/Users\/\.\.\./.test(hit) ||
            /^[A-Za-z]:\\Users\\(?:alice|bob|demo|user|example)\b/i.test(hit) ||
            /^(?:11111111-2222-3333-4444-555555555555|00000000-|b2000000-0000-4000-8000-000000000002|c3000000-0000-4000-8000-000000000003)/i.test(hit) ||
            /@(?:custom-studio\.dev|eng\.corp\.co\.uk|private-corp\.io|mycorp-internal\.io)$/i.test(hit) ||
            hit === 'demo@gmail.com' ||
            hit === 'sk-abcdefghijklmnopqrstuvwxyz123456' ||
            hit === 'Bearer secret_bearer_token_1234567890' ||
            hit === 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
          ) {
            continue;
          }
        }
        assert.fail(`文件 ${rel} 命中隐私规则 [${pat.label}]：${hit.slice(0, 6)}***`);
      }
    }
  }

  if (existsSync(join(ROOT, '.git'))) {
    const isSafeCommitEmail = (email) => /@(?:users\.noreply\.github\.com|example\.(?:com|org|net))$/i.test(String(email || '').trim());
    let localGitEmail = '';
    try {
      localGitEmail = execFileSync('git', ['config', '--local', '--get', 'user.email'], { cwd: ROOT, stdio: 'pipe', encoding: 'utf-8' }).trim();
    } catch {}
    assert.ok(isSafeCommitEmail(localGitEmail), '仓库本地 git user.email 必须配置为 GitHub noreply 地址');

    let revRange = '';
    try {
      execFileSync('git', ['rev-parse', '--verify', 'origin/main'], { cwd: ROOT, stdio: 'pipe' });
      revRange = 'origin/main..HEAD';
    } catch {
      try {
        execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: ROOT, stdio: 'pipe' });
        revRange = '-n20';
      } catch {}
    }
    if (revRange) {
      const logArgs = ['log', ...(revRange === '-n20' ? ['-n', '20'] : [revRange]), '--format=%h|%ae|%ce'];
      const gitLogRaw = execFileSync('git', logArgs, { cwd: ROOT, stdio: 'pipe', encoding: 'utf-8' }).trim();
      for (const line of gitLogRaw ? gitLogRaw.split(/\r?\n/) : []) {
        const [hash, ae, ce] = line.split('|');
        if (hash && (!isSafeCommitEmail(ae) || !isSafeCommitEmail(ce))) {
          const msg = `提交 ${hash} 包含非 GitHub noreply 邮箱`;
          if (STRICT_GIT_IDENTITY) assert.fail(`Git 身份门禁阻断：${msg}`);
          else console.warn(`[WARN] ${msg}`);
        }
      }
    }

    const hookPath = join(ROOT, '.git', 'hooks', 'pre-push');
    assert.ok(existsSync(hookPath), '缺少 .git/hooks/pre-push 钩子');
  }

  pass('Repo-wide privacy scan, PNG chunk audit & Git noreply identity gate');
}

function verifyIndividualPlugins(pluginDirs) {
  for (const dirName of pluginDirs) {
    const verifyScript = join(ROOT, 'plugins', dirName, 'scripts', 'verify.mjs');
    assert.ok(existsSync(verifyScript), `缺少 plugins/${dirName}/scripts/verify.mjs`);
    console.log(`\n--- Running plugin suite: ${dirName} ---`);
    const args = [verifyScript];
    if (STRICT_GIT_IDENTITY && dirName === 'agy-context-viewer') {
      args.push('--strict-git-identity');
    }
    execFileSync(process.execPath, args, {
      cwd: join(ROOT, 'plugins', dirName),
      stdio: 'inherit'
    });
  }
  console.log('');
  pass(`All plugin verification suites passed (${pluginDirs.join(', ')})`);
}

function verifyRootInstaller() {
  const tempPlugins = mkdtempSync(join(tmpdir(), 'agy-plugins-root-install-'));
  const tempBin = mkdtempSync(join(tmpdir(), 'agy-plugins-root-bin-'));
  const env = {
    ...process.env,
    AGY_PLUGINS_DIR: tempPlugins,
    ANTIGRAVITY_PLUGINS_DIR: tempPlugins,
    AGY_BIN_DIR: tempBin,
    ANTIGRAVITY_BIN_DIR: tempBin
  };

  try {
    const listOut = execFileSync('bash', [join(ROOT, 'install.sh'), '--list'], { cwd: ROOT, env, encoding: 'utf-8' });
    assert.ok(listOut.includes('agy-finder') && listOut.includes('agy-context-viewer') && listOut.includes('agy-cli-hud'));

    execFileSync('bash', [join(ROOT, 'install.sh'), 'agy-finder'], { cwd: ROOT, env, stdio: 'pipe' });
    assert.ok(existsSync(join(tempPlugins, 'agy-finder', 'plugin.json')));
    assert.ok(existsSync(join(tempPlugins, 'agy-finder', 'sidecars', 'tree', 'sidecar.json')));
    assert.ok(existsSync(join(tempBin, 'agy-finder')));

    execFileSync('bash', [join(ROOT, 'install.sh'), 'context-viewer'], { cwd: ROOT, env, stdio: 'pipe' });
    assert.ok(existsSync(join(tempPlugins, 'context-viewer', 'plugin.json')));
    assert.ok(existsSync(join(tempPlugins, 'context-viewer', 'sidecars', 'dashboard', 'sidecar.json')));
    assert.ok(existsSync(join(tempBin, 'agy-context')));

    execFileSync('bash', [join(ROOT, 'install.sh'), 'agy-cli-hud'], { cwd: ROOT, env, stdio: 'pipe' });
    assert.ok(existsSync(join(tempPlugins, 'agy-cli-hud', 'plugin.json')));
    assert.ok(existsSync(join(tempPlugins, 'agy-cli-hud', 'bin', 'agy-hud.mjs')));
    assert.ok(existsSync(join(tempBin, 'agy-hud')));

    execFileSync('bash', [join(ROOT, 'install.sh'), '--uninstall'], { cwd: ROOT, env, stdio: 'pipe' });
    assert.ok(!existsSync(join(tempPlugins, 'agy-finder')));
    assert.ok(!existsSync(join(tempPlugins, 'context-viewer')));
    assert.ok(!existsSync(join(tempPlugins, 'agy-cli-hud')));
    assert.ok(!existsSync(join(tempBin, 'agy-finder')));
    assert.ok(!existsSync(join(tempBin, 'agy-context')));
    assert.ok(!existsSync(join(tempBin, 'agy-hud')));

    // U1: Coexisting outdated-peer [WARN] on single-plugin install (strictly read-only), silent when batch-upgrading or up-to-date
    const expectedFinderVer = JSON.parse(readFileSync(join(ROOT, 'plugins', 'agy-finder', 'plugin.json'), 'utf-8')).version;
    const expectedCvVer = JSON.parse(readFileSync(join(ROOT, 'plugins', 'agy-context-viewer', 'plugin.json'), 'utf-8')).version;

    mkdirSync(join(tempPlugins, 'context-viewer'), { recursive: true });
    writeFileSync(join(tempPlugins, 'context-viewer', 'plugin.json'), JSON.stringify({ name: 'context-viewer', version: '1.7.3' }));
    const finderWarnOut = execFileSync('bash', [join(ROOT, 'install.sh'), 'agy-finder'], { cwd: ROOT, env, encoding: 'utf-8' });
    assert.ok(finderWarnOut.includes('[WARN]') && finderWarnOut.includes('v1.7.3') && finderWarnOut.includes('v1.7.4'), 'Installing agy-finder alone with v1.7.3 peer must warn');
    assert.equal(JSON.parse(readFileSync(join(tempPlugins, 'context-viewer', 'plugin.json'), 'utf-8')).version, '1.7.3', 'Single-plugin install must never modify peer plugin');

    writeFileSync(join(tempPlugins, 'agy-finder', 'plugin.json'), JSON.stringify({ name: 'agy-finder', version: '0.2.3' }));
    const cvWarnOut = execFileSync('bash', [join(ROOT, 'install.sh'), 'context-viewer'], { cwd: ROOT, env, encoding: 'utf-8' });
    assert.ok(cvWarnOut.includes('[WARN]') && cvWarnOut.includes('v0.2.3') && cvWarnOut.includes('v0.2.4'), 'Installing context-viewer alone with v0.2.3 peer must warn');
    assert.equal(JSON.parse(readFileSync(join(tempPlugins, 'agy-finder', 'plugin.json'), 'utf-8')).version, '0.2.3', 'Single-plugin install must never modify agy-finder peer');

    writeFileSync(join(tempPlugins, 'context-viewer', 'plugin.json'), JSON.stringify({ name: 'context-viewer', version: '1.7.3' }));
    const batchUpgradeOut = execFileSync('bash', [join(ROOT, 'install.sh')], { cwd: ROOT, env, encoding: 'utf-8' });
    assert.ok(!batchUpgradeOut.includes('[WARN]'), `Full batch upgrade must not emit stale-peer [WARN]:\n${batchUpgradeOut}`);
    assert.equal(JSON.parse(readFileSync(join(tempPlugins, 'agy-finder', 'plugin.json'), 'utf-8')).version, expectedFinderVer);
    assert.equal(JSON.parse(readFileSync(join(tempPlugins, 'context-viewer', 'plugin.json'), 'utf-8')).version, expectedCvVer);

    const upToDateSingleOut = execFileSync('bash', [join(ROOT, 'install.sh'), 'agy-finder'], { cwd: ROOT, env, encoding: 'utf-8' });
    assert.ok(!upToDateSingleOut.includes('[WARN]'), 'Single-plugin install with >=1.7.4 peer must not warn');

    execFileSync('bash', [join(ROOT, 'install.sh'), '--uninstall'], { cwd: ROOT, env, stdio: 'pipe' });

    // R6: isolated AGY_PLUGINS_DIR install & uninstall WITHOUT AGY_BIN_DIR must preserve existing $HOME/.local/bin CLI tools
    const fakeHome = mkdtempSync(join(tmpdir(), 'agy-plugins-fakehome-'));
    const isolatedPlugins = mkdtempSync(join(tmpdir(), 'agy-plugins-iso-'));
    const fakeBinDir = join(fakeHome, '.local', 'bin');
    const sentinelFinder = join(fakeBinDir, 'agy-finder');
    const sentinelContext = join(fakeBinDir, 'agy-context');
    try {
      mkdirSync(fakeBinDir, { recursive: true });
      writeFileSync(sentinelFinder, '#!/usr/bin/env bash\necho SENTINEL_FINDER\n');
      writeFileSync(sentinelContext, '#!/usr/bin/env bash\necho SENTINEL_CONTEXT\n');

      const isoEnv = {
        ...process.env,
        HOME: fakeHome,
        AGY_PLUGINS_DIR: isolatedPlugins,
        ANTIGRAVITY_PLUGINS_DIR: isolatedPlugins
      };
      delete isoEnv.AGY_BIN_DIR;
      delete isoEnv.ANTIGRAVITY_BIN_DIR;

      execFileSync('bash', [join(ROOT, 'install.sh')], { cwd: ROOT, env: isoEnv, stdio: 'pipe' });
      assert.equal(readFileSync(sentinelFinder, 'utf-8'), '#!/usr/bin/env bash\necho SENTINEL_FINDER\n');
      assert.equal(readFileSync(sentinelContext, 'utf-8'), '#!/usr/bin/env bash\necho SENTINEL_CONTEXT\n');

      execFileSync('bash', [join(ROOT, 'install.sh'), '--uninstall'], { cwd: ROOT, env: isoEnv, stdio: 'pipe' });
      assert.ok(existsSync(sentinelFinder), 'Isolated uninstall must preserve existing HOME agy-finder CLI');
      assert.ok(existsSync(sentinelContext), 'Isolated uninstall must preserve existing HOME agy-context CLI');
      assert.equal(readFileSync(sentinelFinder, 'utf-8'), '#!/usr/bin/env bash\necho SENTINEL_FINDER\n');
      assert.equal(readFileSync(sentinelContext, 'utf-8'), '#!/usr/bin/env bash\necho SENTINEL_CONTEXT\n');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(isolatedPlugins, { recursive: true, force: true });
    }

    pass('Unified root install.sh (--list, selective install, U1 peer warning, R6 isolated HOME bin safety & --uninstall)');
  } finally {
    rmSync(tempPlugins, { recursive: true, force: true });
    rmSync(tempBin, { recursive: true, force: true });
  }
}

async function verifyCrossPluginAuxTriggerLock() {
  const auxDir = mkdtempSync(join(tmpdir(), 'agy-plugins-auxlock-'));
  const fakeHome = join(auxDir, 'home');
  const fakeAgDir = join(fakeHome, '.gemini', 'antigravity');
  const fakeExecDataDir = join(auxDir, 'exec-data');
  mkdirSync(join(fakeAgDir, 'brain'), { recursive: true });
  mkdirSync(fakeExecDataDir, { recursive: true });
  const triggerPath = join(auxDir, 'agy_aux_pane_trigger.json');
  const finderModUrl = pathToFileURL(join(ROOT, 'plugins', 'agy-finder', 'sidecars', 'tree', 'drawer.mjs')).href;
  const cvModUrl = pathToFileURL(join(ROOT, 'plugins', 'agy-context-viewer', 'sidecars', 'dashboard', 'collector.mjs')).href;

  const spawnWorker = (workerScript, extraEnv = {}) =>
    new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', workerScript], {
        env: {
          ...process.env,
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          AG_DIR: fakeAgDir,
          ANTIGRAVITY_EXECUTABLE_DATA_DIR: fakeExecDataDir,
          AGY_AUX_TRIGGER_PATH: triggerPath,
          ...extraEnv
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d.toString('utf8'); });
      child.stderr.on('data', (d) => { err += d.toString('utf8'); });
      child.on('exit', (code) => {
        if (code !== 0) rejectPromise(new Error(`Worker exited ${code}: ${err || out}`));
        else resolvePromise(out.trim());
      });
    });

  try {
    // 1. 8 concurrent processes (4 agy-finder + 4 context-viewer) performing 5 trigger writes each (= 40 increments)
    const writeJobs = [];
    for (let i = 0; i < 8; i++) {
      const modUrl = i < 4 ? finderModUrl : cvModUrl;
      const pluginName = i < 4 ? 'agy-finder' : 'context-viewer';
      const code = `
        import { writeAuxPaneTrigger } from ${JSON.stringify(modUrl)};
        for (let k = 0; k < 5; k++) {
          writeAuxPaneTrigger({ targetPlugin: ${JSON.stringify(pluginName)}, action: 'open', convId: 'conv-' + ${i} + '-' + k });
        }
      `;
      writeJobs.push(spawnWorker(code));
    }
    await Promise.all(writeJobs);

    const afterWrites = JSON.parse(readFileSync(triggerPath, 'utf-8'));
    assert.equal(afterWrites.seq, 40, `Expected seq=40 after 8x5 locked increments, got ${afterWrites.seq}`);
    assert.ok(!existsSync(`${triggerPath}.lock`), 'Trigger lock file must be released after writes');
    if (existsSync(`${triggerPath}.lock.d`)) {
      assert.equal(readdirSync(`${triggerPath}.lock.d`).length, 0, 'Trigger bakery lock dir must be empty after writes');
    }

    // 2. 8 concurrent processes race to claim openingSeq and ackSeq on seq=40 (only 1 winner per claim)
    const claimJobs = [];
    for (let i = 0; i < 8; i++) {
      const modUrl = i < 4 ? finderModUrl : cvModUrl;
      const pluginName = i < 4 ? 'agy-finder' : 'context-viewer';
      const code = `
        import { markAuxPaneOpening, ackAuxPaneTrigger } from ${JSON.stringify(modUrl)};
        const openRes = markAuxPaneOpening({ seq: 40 });
        const ackRes = ackAuxPaneTrigger({ seq: 40, plugin: ${JSON.stringify(pluginName)} });
        console.log(JSON.stringify({ openClaimed: Boolean(openRes.claimed), ackClaimed: Boolean(ackRes.claimed) }));
      `;
      claimJobs.push(spawnWorker(code));
    }
    const claimResults = (await Promise.all(claimJobs)).map((line) => JSON.parse(line));
    const openWinners = claimResults.filter((r) => r.openClaimed).length;
    const ackWinners = claimResults.filter((r) => r.ackClaimed).length;
    assert.equal(openWinners, 1, `Expected exactly 1 markAuxPaneOpening winner, got ${openWinners}`);
    assert.equal(ackWinners, 1, `Expected exactly 1 ackAuxPaneTrigger winner, got ${ackWinners}`);

    // 3. Stale dead-PID lock recovery (immediate without waiting for 5s age threshold)
    const lockPath = `${triggerPath}.lock`;
    writeFileSync(lockPath, `999999:${Date.now()}:deadtoken`);

    await spawnWorker(`
      import { writeAuxPaneTrigger } from ${JSON.stringify(cvModUrl)};
      const next = writeAuxPaneTrigger({ targetPlugin: 'context-viewer', action: 'toggle' });
      if (next.seq !== 41) throw new Error('Expected seq=41 after stale lock recovery, got ' + next.seq);
    `);
    const finalTrigger = JSON.parse(readFileSync(triggerPath, 'utf-8'));
    assert.equal(finalTrigger.seq, 41, 'Stale dead-PID lock must be recovered cleanly');
    assert.ok(!existsSync(lockPath), 'Lock file must not linger after stale recovery');
    if (existsSync(`${lockPath}.d`)) {
      assert.equal(readdirSync(`${lockPath}.d`).length, 0, 'Bakery lock dir must be empty after stale recovery');
    }

    // 4. S1: Active live-PID lock timeout must fail closed (never overwrite shared trigger or claim)
    const ownerToken = `${process.pid}:${Date.now()}:verify-live-owner`;
    const frozenTrigger = JSON.stringify({
      seq: 41,
      targetPlugin: 'context-viewer',
      action: 'toggle',
      openingSeq: 0,
      ackSeq: 0,
      switchedSeq: 0,
      activeConvId: 'conv-frozen'
    });
    writeFileSync(triggerPath, frozenTrigger);
    writeFileSync(lockPath, ownerToken, { flag: 'wx' });

    const s1Results = await Promise.all([finderModUrl, cvModUrl].map((modUrl, idx) =>
      spawnWorker(`
        import { writeAuxPaneTrigger, markAuxPaneOpening, ackAuxPaneTrigger, markAuxPaneSwitched, recordAuxActiveConversation } from ${JSON.stringify(modUrl)};
        const openRes = markAuxPaneOpening({ seq: 41 });
        const ackRes = ackAuxPaneTrigger({ seq: 41, plugin: ${JSON.stringify(idx === 0 ? 'agy-finder' : 'context-viewer')} });
        const swRes = markAuxPaneSwitched({ seq: 41 });
        const trigRes = writeAuxPaneTrigger({ targetPlugin: 'agy-finder', action: 'open', convId: 'conv-intruder' });
        const helloRes = recordAuxActiveConversation({ convId: '11111111-1111-4111-8111-111111111111' });
        console.log(JSON.stringify({ openRes, ackRes, swRes, trigRes, helloRes }));
      `, { AGY_AUX_LOCK_TIMEOUT_MS: '120' }).then((raw) => JSON.parse(raw))
    ));

    for (const r of s1Results) {
      assert.equal(r.openRes.ok, false, 'markAuxPaneOpening must return ok:false on lock timeout');
      assert.equal(r.openRes.claimed, false, 'markAuxPaneOpening must return claimed:false on lock timeout');
      assert.equal(r.ackRes.ok, false, 'ackAuxPaneTrigger must return ok:false on lock timeout');
      assert.equal(r.ackRes.claimed, false, 'ackAuxPaneTrigger must return claimed:false on lock timeout');
      assert.equal(r.swRes.ok, false, 'markAuxPaneSwitched must return ok:false on lock timeout');
      assert.equal(r.swRes.claimed, false, 'markAuxPaneSwitched must return claimed:false on lock timeout');
      assert.equal(r.trigRes.ok, false, 'writeAuxPaneTrigger must return ok:false on lock timeout');
      assert.equal(r.trigRes.seq, 0, 'writeAuxPaneTrigger must return seq:0 on lock timeout');
      assert.equal(r.helloRes.ok, false, 'recordAuxActiveConversation must return ok:false on lock timeout');
    }
    assert.equal(readFileSync(lockPath, 'utf-8'), ownerToken, 'Live-PID lock must never be stolen or removed by waiters');
    assert.equal(readFileSync(triggerPath, 'utf-8'), frozenTrigger, 'Shared trigger JSON must stay untouched while locked');

    // Release live lock and confirm subsequent claim succeeds cleanly
    rmSync(lockPath, { force: true });
    const postRelease = JSON.parse(await spawnWorker(`
      import { markAuxPaneOpening } from ${JSON.stringify(finderModUrl)};
      console.log(JSON.stringify(markAuxPaneOpening({ seq: 41 })));
    `));
    assert.equal(postRelease.ok, true);
    assert.equal(postRelease.claimed, true);
    assert.equal(JSON.parse(readFileSync(triggerPath, 'utf-8')).openingSeq, 41);

    // 5. T1: Bidirectional stale-lock reclamation interleaving across Finder & Context Viewer
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    assert.throws(() => process.kill(deadPid, 0), 'Dead helper PID must have exited');

    const waitForMarker = async (markerPath, label, childProc = null) => {
      const deadline = Date.now() + 5000;
      while (!existsSync(markerPath)) {
        if (childProc && childProc.exitCode !== null) {
          throw new Error(`Worker exited (${childProc.exitCode}) before reaching barrier: ${label}`);
        }
        if (Date.now() > deadline) throw new Error(`Timed out waiting for barrier marker: ${label}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    };

    const spawnBarrierWorker = ({ modUrl, seq, trigger, timeoutMs, hookScript, allowSignal = '' }) => {
      const workerScript = `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        import { basename, join } from 'node:path';
        const triggerPath = process.env.AGY_AUX_TRIGGER_PATH;
        const lockPath = triggerPath + '.lock';
        const lockDir = lockPath + '.d';
        function waitForResume(resumeFile) {
          const deadline = Date.now() + 5000;
          const wait = new Int32Array(new SharedArrayBuffer(4));
          while (!fs.existsSync(resumeFile)) {
            if (Date.now() > deadline) throw new Error('Worker barrier timeout: ' + resumeFile);
            Atomics.wait(wait, 0, 0, 5);
          }
        }
        ${hookScript}
        syncBuiltinESMExports();
        const mod = await import(${JSON.stringify(modUrl)});
        console.log(JSON.stringify(mod.markAuxPaneOpening({ seq: ${seq} })));
      `;
      const child = spawn(process.execPath, ['--input-type=module', '-e', workerScript], {
        env: {
          ...process.env,
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          AG_DIR: fakeAgDir,
          ANTIGRAVITY_EXECUTABLE_DATA_DIR: fakeExecDataDir,
          AGY_AUX_TRIGGER_PATH: trigger,
          AGY_AUX_LOCK_TIMEOUT_MS: String(timeoutMs)
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d.toString('utf8'); });
      child.stderr.on('data', (d) => { err += d.toString('utf8'); });
      const done = new Promise((resolvePromise, rejectPromise) => {
        child.on('error', rejectPromise);
        child.on('exit', (code, signal) => {
          if (allowSignal && signal === allowSignal) {
            resolvePromise({ killed: true, signal });
          } else if (code !== 0) {
            rejectPromise(new Error(`Barrier worker exited ${code} (${signal || 'none'}): ${err || out}`));
          } else {
            resolvePromise(JSON.parse(out.trim()));
          }
        });
      });
      return { pid: child.pid, child, done };
    };

    const modPairs = [
      ['agy-finder', finderModUrl, 'context-viewer', cvModUrl],
      ['context-viewer', cvModUrl, 'agy-finder', finderModUrl]
    ];

    for (let idx = 0; idx < modPairs.length; idx += 1) {
      const [reaperName, reaperUrl, contenderName, contenderUrl] = modPairs[idx];

      // Case A: Reaper pauses mid-reclamation right before renameSync(lockPath, stalePath); contender must wait & fail closed
      const caseADir = join(auxDir, `t1-case-a-${idx}`);
      mkdirSync(caseADir, { recursive: true });
      const caseATrigger = join(caseADir, 'trigger.json');
      const caseALock = `${caseATrigger}.lock`;
      const caseABarriers = join(caseADir, 'barriers');
      mkdirSync(caseABarriers, { recursive: true });
      const seqA = 50 + idx;
      writeFileSync(caseATrigger, JSON.stringify({ seq: seqA, openingSeq: 0 }));
      writeFileSync(caseALock, `${deadPid}:0:synthetic-dead-owner`);

      const readyReaperA = join(caseABarriers, 'ready-reaper');
      const resumeReaperA = join(caseABarriers, 'resume-reaper');
      const reaperA = spawnBarrierWorker({
        modUrl: reaperUrl,
        seq: seqA,
        trigger: caseATrigger,
        timeoutMs: 2500,
        hookScript: `
          const origRename = fs.renameSync;
          let paused = false;
          fs.renameSync = function(from, to, ...args) {
            if (!paused && from === lockPath && to.startsWith(lockPath + '.stale.')) {
              paused = true;
              fs.writeFileSync(${JSON.stringify(readyReaperA)}, 'ready');
              waitForResume(${JSON.stringify(resumeReaperA)});
            }
            return origRename.call(fs, from, to, ...args);
          };
        `
      });
      try {
        await waitForMarker(readyReaperA, `${reaperName} Case A ready`);
        const contenderRes = JSON.parse(await spawnWorker(`
          import { markAuxPaneOpening } from ${JSON.stringify(contenderUrl)};
          console.log(JSON.stringify(markAuxPaneOpening({ seq: ${seqA} })));
        `, { AGY_AUX_TRIGGER_PATH: caseATrigger, AGY_AUX_LOCK_TIMEOUT_MS: '160' }));
        assert.equal(contenderRes.ok, false, `${contenderName} must fail closed while ${reaperName} holds bakery turn (${idx})`);
        assert.equal(contenderRes.claimed, false, `${contenderName} must not claim seq while ${reaperName} is reclaiming (${idx})`);

        writeFileSync(resumeReaperA, 'go');
        const reaperRes = await reaperA.done;
        assert.equal(reaperRes.ok, true, `${reaperName} must succeed after resume (${idx})`);
        assert.equal(reaperRes.claimed, true, `${reaperName} must win seq ${seqA} (${idx})`);
        assert.equal(Number(reaperRes.claimed) + Number(contenderRes.claimed), 1, `Case A totalWinners must be 1 (${idx})`);
        assert.equal(JSON.parse(readFileSync(caseATrigger, 'utf-8')).openingSeq, seqA);
        assert.ok(!existsSync(caseALock), 'Case A .lock must be released');
        assert.equal(readdirSync(`${caseALock}.d`).length, 0, 'Case A .lock.d must be clean');
      } finally {
        if (reaperA.child.exitCode === null) reaperA.child.kill();
      }

      // Case B: Delayed reaper attempts to unlink dead bakery ticket while live holder is paused inside markAuxPaneOpening
      const caseBDir = join(auxDir, `t1-case-b-${idx}`);
      mkdirSync(caseBDir, { recursive: true });
      const caseBTrigger = join(caseBDir, 'trigger.json');
      const caseBLock = `${caseBTrigger}.lock`;
      const caseBLockDir = `${caseBLock}.d`;
      const caseBBarriers = join(caseBDir, 'barriers');
      mkdirSync(caseBLockDir, { recursive: true });
      mkdirSync(caseBBarriers, { recursive: true });
      const seqB = 60 + idx;
      const deadTicketName = `ticket-0000000000000000-${deadPid}-dead00000000`;
      const deadTicketPath = join(caseBLockDir, deadTicketName);
      writeFileSync(caseBTrigger, JSON.stringify({ seq: seqB, openingSeq: 0 }));
      writeFileSync(caseBLock, `${deadPid}:0:synthetic-dead-owner`);
      writeFileSync(deadTicketPath, '');

      const readyHolderTicket = join(caseBBarriers, 'ready-holder-ticket');
      const resumeHolderTicket = join(caseBBarriers, 'resume-holder-ticket');
      const readyHolderCS = join(caseBBarriers, 'ready-holder-cs');
      const resumeHolderCS = join(caseBBarriers, 'resume-holder-cs');
      const readyReaperB = join(caseBBarriers, 'ready-reaper');
      const resumeReaperB = join(caseBBarriers, 'resume-reaper');

      const holderB = spawnBarrierWorker({
        modUrl: contenderUrl,
        seq: seqB,
        trigger: caseBTrigger,
        timeoutMs: 3500,
        hookScript: `
          const origUnlink = fs.unlinkSync;
          const origRead = fs.readFileSync;
          let pausedTicket = false;
          let pausedCS = false;
          fs.unlinkSync = function(targetPath, ...args) {
            if (!pausedTicket && targetPath === join(lockDir, ${JSON.stringify(deadTicketName)})) {
              pausedTicket = true;
              fs.writeFileSync(${JSON.stringify(readyHolderTicket)}, 'ready');
              waitForResume(${JSON.stringify(resumeHolderTicket)});
            }
            return origUnlink.call(fs, targetPath, ...args);
          };
          fs.readFileSync = function(targetPath, ...args) {
            const bytes = origRead.call(fs, targetPath, ...args);
            if (!pausedCS && targetPath === triggerPath) {
              pausedCS = true;
              fs.writeFileSync(${JSON.stringify(readyHolderCS)}, 'ready');
              waitForResume(${JSON.stringify(resumeHolderCS)});
            }
            return bytes;
          };
        `
      });

      let reaperB = null;
      try {
        await waitForMarker(readyHolderTicket, `${contenderName} Case B ticket barrier`);
        reaperB = spawnBarrierWorker({
          modUrl: reaperUrl,
          seq: seqB,
          trigger: caseBTrigger,
          timeoutMs: 320,
          hookScript: `
            const origUnlink = fs.unlinkSync;
            let paused = false;
            fs.unlinkSync = function(targetPath, ...args) {
              if (!paused && targetPath === join(lockDir, ${JSON.stringify(deadTicketName)})) {
                paused = true;
                fs.writeFileSync(${JSON.stringify(readyReaperB)}, 'ready');
                waitForResume(${JSON.stringify(resumeReaperB)});
              }
              return origUnlink.call(fs, targetPath, ...args);
            };
          `
        });
        await waitForMarker(readyReaperB, `${reaperName} Case B reaper ticket barrier`);

        writeFileSync(resumeHolderTicket, 'go');
        await waitForMarker(readyHolderCS, `${contenderName} Case B critical section`);

        const liveToken = readFileSync(caseBLock, 'utf-8');
        assert.ok(liveToken.startsWith(`${holderB.pid}:`), `Live lock must belong to holder ${holderB.pid}, got ${liveToken}`);
        process.kill(holderB.pid, 0);

        writeFileSync(resumeReaperB, 'go');
        const reaperBRes = await reaperB.done;
        assert.equal(reaperBRes.ok, false, `Delayed ${reaperName} must fail closed while ${contenderName} holds CS (${idx})`);
        assert.equal(reaperBRes.claimed, false, `Delayed ${reaperName} must not claim seq ${seqB} (${idx})`);
        assert.ok(existsSync(caseBLock), `Live lock must remain intact while holder ${contenderName} is inside CS (${idx})`);
        assert.ok(readFileSync(caseBLock, 'utf-8').startsWith(`${holderB.pid}:`), 'Holder lock owner must remain unchanged');

        writeFileSync(resumeHolderCS, 'go');
        const holderBRes = await holderB.done;
        assert.equal(holderBRes.ok, true, `${contenderName} must complete CS cleanly (${idx})`);
        assert.equal(holderBRes.claimed, true, `${contenderName} must win seq ${seqB} (${idx})`);
        assert.equal(Number(reaperBRes.claimed) + Number(holderBRes.claimed), 1, `Case B totalWinners must be 1 (${idx})`);
        assert.equal(JSON.parse(readFileSync(caseBTrigger, 'utf-8')).openingSeq, seqB);
        assert.ok(!existsSync(caseBLock), 'Case B .lock must be released');
        assert.equal(readdirSync(caseBLockDir).length, 0, 'Case B .lock.d must be clean');
      } finally {
        if (reaperB && reaperB.child.exitCode === null) reaperB.child.kill();
        if (holderB.child.exitCode === null) holderB.child.kill();
      }
    }

    // 6. U1: 6-stage SIGKILL crash-recovery matrix (entering / ticket / critical x bidirectional finder <-> context)
    for (let idx = 0; idx < modPairs.length; idx += 1) {
      const [holderName, holderUrl, successorName, successorUrl] = modPairs[idx];
      for (const phase of ['entering', 'ticket', 'critical']) {
        const crashDir = join(auxDir, `u1-crash-${idx}-${phase}`);
        const crashBarriers = join(crashDir, 'barriers');
        mkdirSync(crashBarriers, { recursive: true });
        const crashTrigger = join(crashDir, 'trigger.json');
        const crashSeq = 70 + idx * 10 + ['entering', 'ticket', 'critical'].indexOf(phase);
        writeFileSync(crashTrigger, JSON.stringify({ seq: crashSeq, openingSeq: 0 }));

        const readyCrash = join(crashBarriers, `ready-${phase}`);
        const resumeCrash = join(crashBarriers, `resume-${phase}`);
        const hookScript = phase === 'critical'
          ? `
            const origRead = fs.readFileSync;
            let paused = false;
            fs.readFileSync = function(targetPath, ...args) {
              const bytes = origRead.call(fs, targetPath, ...args);
              if (!paused && targetPath === triggerPath) {
                paused = true;
                fs.writeFileSync(${JSON.stringify(readyCrash)}, 'ready');
                waitForResume(${JSON.stringify(resumeCrash)});
              }
              return bytes;
            };
          `
          : `
            const origOpen = fs.openSync;
            let paused = false;
            fs.openSync = function(targetPath, ...args) {
              const fd = origOpen.call(fs, targetPath, ...args);
              if (!paused && typeof targetPath === 'string' && basename(targetPath).startsWith(${JSON.stringify(`${phase}-`)})) {
                paused = true;
                fs.writeFileSync(${JSON.stringify(readyCrash)}, 'ready');
                waitForResume(${JSON.stringify(resumeCrash)});
              }
              return fd;
            };
          `;

        const holder = spawnBarrierWorker({
          modUrl: holderUrl,
          seq: crashSeq,
          trigger: crashTrigger,
          timeoutMs: 4000,
          allowSignal: 'SIGKILL',
          hookScript
        });
        try {
          await waitForMarker(readyCrash, `${holderName} ${phase} crash barrier`, holder.child);
          const blocked = JSON.parse(await spawnWorker(`
            import { markAuxPaneOpening } from ${JSON.stringify(successorUrl)};
            console.log(JSON.stringify(markAuxPaneOpening({ seq: ${crashSeq} })));
          `, { AGY_AUX_TRIGGER_PATH: crashTrigger, AGY_AUX_LOCK_TIMEOUT_MS: '80' }));
          assert.equal(blocked.ok, false, `${successorName} must fail closed while ${holderName} is live at ${phase}`);
          assert.equal(blocked.lockBusy, true, `${successorName} must report lockBusy while ${holderName} is live at ${phase}`);
          assert.equal(blocked.claimed, false, `${successorName} must not claim seq ${crashSeq} while ${holderName} is live at ${phase}`);

          holder.child.kill('SIGKILL');
          const crashExit = await holder.done;
          assert.equal(crashExit.killed, true, `${holderName} at ${phase} must exit via SIGKILL`);

          const recovered = JSON.parse(await spawnWorker(`
            import { markAuxPaneOpening } from ${JSON.stringify(successorUrl)};
            console.log(JSON.stringify(markAuxPaneOpening({ seq: ${crashSeq} })));
          `, { AGY_AUX_TRIGGER_PATH: crashTrigger }));
          assert.equal(recovered.ok, true, `${successorName} must recover cleanly after ${holderName} SIGKILL at ${phase}`);
          assert.equal(recovered.claimed, true, `${successorName} must claim seq ${crashSeq} after ${holderName} SIGKILL at ${phase}`);
          assert.equal(JSON.parse(readFileSync(crashTrigger, 'utf-8')).openingSeq, crashSeq);
          assert.ok(!existsSync(`${crashTrigger}.lock`), `Crash recovery (${holderName} -> ${successorName} @ ${phase}) must release .lock`);
          assert.equal(readdirSync(`${crashTrigger}.lock.d`).length, 0, `Crash recovery (${holderName} -> ${successorName} @ ${phase}) must leave .lock.d empty`);
        } finally {
          if (holder.child.exitCode === null && holder.child.signalCode === null) {
            holder.child.kill('SIGKILL');
            await holder.done.catch(() => {});
          }
        }
      }
    }

    pass('R1/S1/T1/U1 cross-plugin 8-process Aux trigger lock integrity, stale recovery, bidirectional reclamation race, 6-stage crash recovery & fail-closed timeout');
  } finally {
    rmSync(auxDir, { recursive: true, force: true });
  }
}

async function verifyDaemonQuitAndUpgradePidSafety() {
  const workDir = mkdtempSync(join(tmpdir(), 'agy-plugins-pid-safety-'));
  const isoBinDir = join(workDir, 'iso-bin');
  mkdirSync(isoBinDir, { recursive: true });
  symlinkSync(process.execPath, join(isoBinDir, 'node'));

  const spawnedChildren = [];
  const trackProc = (child) => {
    spawnedChildren.push(child);
    return child;
  };
  const isChildAlive = (child) => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return false;
    try {
      process.kill(child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const runAsync = (cmd, args, { env, stdinText = '' } = {}) =>
    new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
      child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
      child.on('error', rejectPromise);
      child.on('exit', (status, signal) => resolvePromise({ status, signal, stdout, stderr }));
      if (stdinText) child.stdin.write(stdinText);
      child.stdin.end();
    });

  const spawnWaitReady = (cmd, args, { env } = {}) =>
    new Promise((resolvePromise, rejectPromise) => {
      const child = trackProc(spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] }));
      let done = false;
      let errBuf = '';
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          rejectPromise(new Error(`Helper did not emit ready in time: ${cmd} ${args.join(' ')} (${errBuf})`));
        }
      }, 5000);
      child.stdout.on('data', () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolvePromise(child);
        }
      });
      child.stderr.on('data', (d) => { errBuf += d.toString('utf8'); });
      child.on('error', (err) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          rejectPromise(err);
        }
      });
      child.on('exit', (code) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          rejectPromise(new Error(`Helper exited prematurely (${code}): ${errBuf}`));
        }
      });
    });

  const baseIsoEnv = (fakeHome, extraEnv = {}) => {
    const env = {
      ...process.env,
      HOME: fakeHome,
      PATH: `${isoBinDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      AGY_FINDER_DISABLE_DRAWER: '1',
      AGY_CONTEXT_VIEWER_DISABLE_DAEMON: '1',
      ...extraEnv
    };
    delete env.AGY_PLUGINS_DIR;
    delete env.ANTIGRAVITY_PLUGINS_DIR;
    delete env.AGY_BIN_DIR;
    delete env.ANTIGRAVITY_BIN_DIR;
    delete env.AG_DIR;
    delete env.AGY_FINDER_DATA_DIR;
    delete env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
    delete env.AGY_AUX_TRIGGER_PATH;
    delete env.AGY_TEST_PID_IDENTITY_MODE;
    if (extraEnv.AGY_TEST_PID_IDENTITY_MODE !== undefined) {
      env.AGY_TEST_PID_IDENTITY_MODE = extraEnv.AGY_TEST_PID_IDENTITY_MODE;
    }
    return env;
  };

  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  const pluginSpecs = [
    {
      name: 'agy-finder',
      dirName: 'agy-finder',
      expectedVer: JSON.parse(readFileSync(join(ROOT, 'plugins', 'agy-finder', 'plugin.json'), 'utf-8')).version,
      cliRel: join('sidecars', 'tree', 'cli.mjs'),
      daemonRel: join('sidecars', 'tree', 'drawer.mjs'),
      quitArgs: ['quit'],
      getStatePath: (fakeHome) => join(fakeHome, '.gemini', 'antigravity', 'sidecar_data', 'agy-finder', 'tree', 'data', 'drawer_state.json'),
      installerPath: join(ROOT, 'plugins', 'agy-finder', 'install.sh')
    },
    {
      name: 'context-viewer',
      dirName: 'context-viewer',
      expectedVer: JSON.parse(readFileSync(join(ROOT, 'plugins', 'agy-context-viewer', 'plugin.json'), 'utf-8')).version,
      cliRel: join('sidecars', 'dashboard', 'cli.mjs'),
      daemonRel: join('sidecars', 'dashboard', 'float_window.mjs'),
      quitArgs: ['float', 'quit'],
      getStatePath: (fakeHome) => join(fakeHome, '.gemini', 'antigravity', 'sidecar_data', 'context-viewer', 'dashboard', 'data', 'float_window_state.json'),
      installerPath: join(ROOT, 'plugins', 'agy-context-viewer', 'install.sh')
    }
  ];

  try {
    const sentinel = trackProc(spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' }));
    assert.ok(isChildAlive(sentinel), 'Unrelated sentinel process must be running');

    for (const spec of pluginSpecs) {
      const fakeHome = join(workDir, `home-${spec.name}`);
      const targetCli = join(fakeHome, '.gemini', 'config', 'plugins', spec.dirName, spec.cliRel);
      const statePath = spec.getStatePath(fakeHome);
      const env = baseIsoEnv(fakeHome);
      mkdirSync(dirname(statePath), { recursive: true });

      const seedPoisonTargetCli = (markerPath) => {
        mkdirSync(dirname(targetCli), { recursive: true });
        writeFileSync(
          targetCli,
          [
            "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
            `writeFileSync(${JSON.stringify(markerPath)}, 'old-cli-invoked');`,
            `if (existsSync(${JSON.stringify(statePath)})) {`,
            `  try { const st = JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf8')); if (st.pid) process.kill(st.pid, 'SIGTERM'); } catch {}`,
            '}'
          ].join('\n')
        );
      };

      // Case 1: Missing state file & dead-PID state file on new CLI quit
      const srcCli = join(ROOT, 'plugins', spec.name === 'agy-finder' ? 'agy-finder' : 'agy-context-viewer', spec.cliRel);
      const quitEmpty = await runAsync(process.execPath, [srcCli, ...spec.quitArgs, '--json'], { env });
      assert.equal(quitEmpty.status, 0, `${spec.name} quit without state must succeed`);
      assert.equal(JSON.parse(quitEmpty.stdout).closed, true);

      writeFileSync(statePath, JSON.stringify({ pid: deadPid, daemonVersion: 1, cmdSeq: 1 }));
      const quitDead = await runAsync(process.execPath, [srcCli, ...spec.quitArgs, '--json'], { env });
      assert.equal(quitDead.status, 0, `${spec.name} quit with dead PID must succeed`);
      assert.ok(!existsSync(statePath), `${spec.name} quit must clean dead-PID state file`);

      // Case 2: Reused PID pointing to live unrelated sentinel -> new CLI quit must NOT signal sentinel
      writeFileSync(statePath, JSON.stringify({ pid: sentinel.pid, daemonVersion: 1, daemonBuildId: 'legacy-build', cmdSeq: 1 }));
      const quitReused = await runAsync(process.execPath, [srcCli, ...spec.quitArgs, '--json'], { env });
      assert.equal(quitReused.status, 0, `${spec.name} quit on reused PID must exit 0`);
      const quitReusedJson = JSON.parse(quitReused.stdout);
      assert.equal(quitReusedJson.terminated, false, `${spec.name} must not report terminating reused PID`);
      assert.equal(quitReusedJson.staleStateCleaned, true, `${spec.name} must clean reused-PID stale state`);
      assert.ok(isChildAlive(sentinel), `${spec.name} CLI quit must leave unrelated sentinel PID ${sentinel.pid} alive`);
      assert.ok(!existsSync(statePath), `${spec.name} must remove mismatched state file after reused-PID check`);

      // Case 3a: Upgrade from old <= 0.2.5 / <= 1.7.5 blind-kill CLI in TARGET_DIR must invoke STAGE_DIR CLI and leave sentinel alive
      const upgradeMarker = join(fakeHome, 'old-cli-upgrade.marker');
      seedPoisonTargetCli(upgradeMarker);
      writeFileSync(statePath, JSON.stringify({ pid: sentinel.pid, daemonVersion: 1, daemonBuildId: 'old-025-175', cmdSeq: 1 }));
      const upgRes = await runAsync('bash', [spec.installerPath], { env });
      assert.equal(upgRes.status, 0, `${spec.name} install.sh upgrade failed: ${upgRes.stderr}`);
      assert.ok(!existsSync(upgradeMarker), `${spec.name} upgrade must invoke STAGE_DIR cli.mjs, NEVER old TARGET_DIR cli.mjs`);
      assert.ok(isChildAlive(sentinel), `${spec.name} upgrade with reused PID must leave unrelated sentinel alive`);
      assert.ok(!existsSync(statePath), `${spec.name} upgrade must remove mismatched stale state file`);
      const installedVer = JSON.parse(readFileSync(join(fakeHome, '.gemini', 'config', 'plugins', spec.dirName, 'plugin.json'), 'utf-8')).version;
      assert.equal(installedVer, spec.expectedVer, `${spec.name} upgraded manifest version mismatch`);

      // Case 3b: Standalone piped uninstall (empty BASH_SOURCE[0]) must verify PID identity before invoking TARGET_DIR cli.mjs
      const uninstMarker = join(fakeHome, 'old-cli-uninstall.marker');
      seedPoisonTargetCli(uninstMarker);
      writeFileSync(statePath, JSON.stringify({ pid: sentinel.pid, daemonVersion: 1, cmdSeq: 1 }));
      const installerSrc = readFileSync(spec.installerPath, 'utf-8');
      const uninstRes = await runAsync('bash', ['-s', '--', '--uninstall'], { env, stdinText: installerSrc });
      assert.equal(uninstRes.status, 0, `${spec.name} standalone --uninstall failed: ${uninstRes.stderr}`);
      assert.ok(!existsSync(uninstMarker), `${spec.name} standalone --uninstall must block poison old CLI on mismatched PID`);
      assert.ok(isChildAlive(sentinel), `${spec.name} standalone --uninstall must leave unrelated sentinel alive`);
      assert.ok(!existsSync(statePath), `${spec.name} standalone --uninstall must clean mismatched state file`);

      // Case 4: Legitimate older-version daemon IS recognized and cleanly terminated by install.sh upgrade
      const legacyDaemonEntry = join(fakeHome, 'legacy-runtime', spec.daemonRel);
      mkdirSync(dirname(legacyDaemonEntry), { recursive: true });
      writeFileSync(legacyDaemonEntry, 'setInterval(() => {}, 10000);\n');
      const oldDaemon = trackProc(spawn(process.execPath, [legacyDaemonEntry, '--daemon'], { stdio: 'ignore' }));
      assert.ok(isChildAlive(oldDaemon), `${spec.name} mock legacy daemon must start alive`);
      mkdirSync(dirname(targetCli), { recursive: true });
      writeFileSync(targetCli, '// placeholder old cli\n');
      writeFileSync(statePath, JSON.stringify({
        pid: oldDaemon.pid,
        daemonVersion: 1,
        daemonBuildId: 'legacy-older-build',
        daemonRunning: true,
        cmdSeq: 1
      }));
      const upgRealRes = await runAsync('bash', [spec.installerPath], { env });
      assert.equal(upgRealRes.status, 0, `${spec.name} upgrade stopping legacy daemon failed: ${upgRealRes.stderr}`);
      assert.ok(!isChildAlive(oldDaemon), `${spec.name} upgrade must cleanly terminate legitimate older daemon (regardless of daemonBuildId)`);
      assert.ok(!existsSync(statePath), `${spec.name} upgrade must clear stopped legacy daemon state file`);

      // Case 5: Unverifiable PID identity (unknown probe failure) skips signals, preserves state file & emits [WARN]
      const unknownEnv = baseIsoEnv(fakeHome, { AGY_TEST_PID_IDENTITY_MODE: 'unknown' });
      writeFileSync(statePath, JSON.stringify({ pid: sentinel.pid, daemonVersion: 1, cmdSeq: 1 }));
      const quitUnknown = await runAsync(process.execPath, [srcCli, ...spec.quitArgs], { env: unknownEnv });
      assert.equal(quitUnknown.status, 0, `${spec.name} quit on unknown identity must exit 0`);
      assert.ok(quitUnknown.stderr.includes('[WARN]'), `${spec.name} quit on unknown identity must print [WARN] to stderr`);
      assert.ok(isChildAlive(sentinel), `${spec.name} quit on unknown identity must not signal sentinel`);
      assert.ok(existsSync(statePath), `${spec.name} quit on unknown identity must preserve state file`);

      const upgUnknown = await runAsync('bash', [spec.installerPath], { env: unknownEnv });
      assert.equal(upgUnknown.status, 0, `${spec.name} install.sh on unknown identity must complete cleanly`);
      assert.ok(upgUnknown.stderr.includes('[WARN]'), `${spec.name} install.sh must surface pre-upgrade [WARN] when identity is unknown`);
      assert.ok(isChildAlive(sentinel), `${spec.name} install.sh on unknown identity must leave sentinel alive`);
      assert.ok(existsSync(statePath), `${spec.name} install.sh on unknown identity must preserve state file`);

      // W1 Cases: distinguish actual argv[1] entry + argv[2]==--daemon from ordinary data/positional arguments
      const srcDaemonPath = join(ROOT, 'plugins', spec.name === 'agy-finder' ? 'agy-finder' : 'agy-context-viewer', spec.daemonRel);
      const daemonMod = await import(pathToFileURL(srcDaemonPath).href);
      const expectedRelNorm = spec.daemonRel.replace(/\\/g, '/');
      const ordinaryHelper = join(workDir, 'ordinary-helper.mjs');
      writeFileSync(ordinaryHelper, 'console.log("ready"); setInterval(() => {}, 10000);\n');

      // W1-1: Real process carrying `--input <daemonPath> --daemon` must NOT be recognized or killed across quit / upgrade / uninstall
      const helperInput = await spawnWaitReady(process.execPath, [ordinaryHelper, '--input', srcDaemonPath, '--daemon']);
      assert.equal(daemonMod.verifyDaemonProcessIdentity({ pid: helperInput.pid }).status, 'mismatch', `${spec.name} must reject --input daemon path as mismatch`);

      writeFileSync(statePath, JSON.stringify({ pid: helperInput.pid, daemonVersion: 1, cmdSeq: 1 }));
      const w1Quit = await runAsync(process.execPath, [srcCli, ...spec.quitArgs, '--json'], { env });
      assert.equal(w1Quit.status, 0);
      const w1QuitJson = JSON.parse(w1Quit.stdout);
      assert.equal(w1QuitJson.terminated, false, `${spec.name} W1-1 quit must not kill ordinary helper`);
      assert.equal(w1QuitJson.staleStateCleaned, true, `${spec.name} W1-1 quit must clean stale state`);
      assert.ok(isChildAlive(helperInput), `${spec.name} W1-1 helper must remain alive after quit`);
      assert.ok(!existsSync(statePath), `${spec.name} W1-1 state file must be cleaned after quit`);

      const w1UpgMarker = join(fakeHome, 'w1-old-cli-upgrade.marker');
      seedPoisonTargetCli(w1UpgMarker);
      writeFileSync(statePath, JSON.stringify({ pid: helperInput.pid, daemonVersion: 1, cmdSeq: 1 }));
      const w1UpgRes = await runAsync('bash', [spec.installerPath], { env });
      assert.equal(w1UpgRes.status, 0, `${spec.name} W1-1 upgrade failed: ${w1UpgRes.stderr}`);
      assert.ok(!existsSync(w1UpgMarker), `${spec.name} W1-1 upgrade must not invoke old TARGET_DIR cli.mjs`);
      assert.ok(isChildAlive(helperInput), `${spec.name} W1-1 upgrade must leave helper alive`);
      assert.ok(!existsSync(statePath), `${spec.name} W1-1 upgrade must clean mismatched state`);

      const w1UninstMarker = join(fakeHome, 'w1-old-cli-uninstall.marker');
      seedPoisonTargetCli(w1UninstMarker);
      writeFileSync(statePath, JSON.stringify({ pid: helperInput.pid, daemonVersion: 1, cmdSeq: 1 }));
      const w1UninstRes = await runAsync('bash', ['-s', '--', '--uninstall'], { env, stdinText: installerSrc });
      assert.equal(w1UninstRes.status, 0, `${spec.name} W1-1 standalone --uninstall failed: ${w1UninstRes.stderr}`);
      assert.ok(!existsSync(w1UninstMarker), `${spec.name} W1-1 standalone --uninstall must block poison CLI`);
      assert.ok(isChildAlive(helperInput), `${spec.name} W1-1 standalone --uninstall must leave helper alive`);
      assert.ok(!existsSync(statePath), `${spec.name} W1-1 standalone --uninstall must clean mismatched state`);

      // W1-2: Positional argument confusion, `.mjs.bak` suffix confusion, and non-Node `/bin/sh` process
      const helperPositional = await spawnWaitReady(process.execPath, [ordinaryHelper, srcDaemonPath, '--daemon']);
      assert.equal(daemonMod.verifyDaemonProcessIdentity({ pid: helperPositional.pid }).status, 'mismatch', `${spec.name} positional daemon arg must be mismatch`);
      writeFileSync(statePath, JSON.stringify({ pid: helperPositional.pid, daemonVersion: 1, cmdSeq: 1 }));
      const posQuit = JSON.parse((await runAsync(process.execPath, [srcCli, ...spec.quitArgs, '--json'], { env })).stdout);
      assert.equal(posQuit.terminated, false);
      assert.ok(isChildAlive(helperPositional), `${spec.name} positional helper must stay alive`);

      const bakEntry = join(fakeHome, 'bak-runtime', `${spec.daemonRel}.bak`);
      mkdirSync(dirname(bakEntry), { recursive: true });
      writeFileSync(bakEntry, 'console.log("ready"); setInterval(() => {}, 10000);\n');
      const bakProc = await spawnWaitReady(process.execPath, [bakEntry, '--daemon']);
      assert.equal(daemonMod.verifyDaemonProcessIdentity({ pid: bakProc.pid }).status, 'mismatch', `${spec.name} .bak suffix must be mismatch`);
      writeFileSync(statePath, JSON.stringify({ pid: bakProc.pid, daemonVersion: 1, cmdSeq: 1 }));
      const bakQuit = JSON.parse((await runAsync(process.execPath, [srcCli, ...spec.quitArgs, '--json'], { env })).stdout);
      assert.equal(bakQuit.terminated, false);
      assert.ok(isChildAlive(bakProc), `${spec.name} .bak helper must stay alive`);

      const shProc = await spawnWaitReady('/bin/sh', ['-c', 'echo ready; sleep 30', 'sh', srcDaemonPath, '--daemon']);
      assert.equal(daemonMod.verifyDaemonProcessIdentity({ pid: shProc.pid }).status, 'mismatch', `${spec.name} /bin/sh process must be mismatch`);
      writeFileSync(statePath, JSON.stringify({ pid: shProc.pid, daemonVersion: 1, cmdSeq: 1 }));
      const shQuit = JSON.parse((await runAsync(process.execPath, [srcCli, ...spec.quitArgs, '--json'], { env })).stdout);
      assert.equal(shQuit.terminated, false);
      assert.ok(isChildAlive(shProc), `${spec.name} /bin/sh process must stay alive`);

      // W1-3: Legitimate spaced-path daemon IS verified/terminated, and importing module under `--daemon` does NOT auto-start
      const spacedDaemonEntry = join(fakeHome, 'dir with space', spec.daemonRel);
      mkdirSync(dirname(spacedDaemonEntry), { recursive: true });
      writeFileSync(spacedDaemonEntry, 'console.log("ready"); setInterval(() => {}, 10000);\n');
      const spacedDaemon = await spawnWaitReady(process.execPath, [spacedDaemonEntry, '--daemon']);
      assert.equal(daemonMod.verifyDaemonProcessIdentity({ pid: spacedDaemon.pid }).status, 'verified', `${spec.name} spaced-path real daemon must verify`);
      writeFileSync(statePath, JSON.stringify({ pid: spacedDaemon.pid, daemonVersion: 1, cmdSeq: 1 }));
      const spacedQuit = await runAsync(process.execPath, [srcCli, ...spec.quitArgs, '--json'], { env });
      assert.equal(spacedQuit.status, 0);
      assert.equal(JSON.parse(spacedQuit.stdout).terminated, true, `${spec.name} spaced-path real daemon must terminate on quit`);
      assert.ok(!isChildAlive(spacedDaemon), `${spec.name} spaced-path daemon must stop`);
      assert.ok(!existsSync(statePath), `${spec.name} spaced-path state file must be cleared`);

      const importGuardScript = join(workDir, `import-guard-${spec.name}.mjs`);
      writeFileSync(importGuardScript, `await import(${JSON.stringify(pathToFileURL(srcDaemonPath).href)}); console.log('imported-ok');\n`);
      const importGuardRes = spawnSync(process.execPath, [importGuardScript, '--daemon'], { env, encoding: 'utf8', timeout: 2000 });
      assert.equal(importGuardRes.status, 0, `${spec.name} importing module under --daemon must exit cleanly: ${importGuardRes.stderr}`);
      assert.ok(importGuardRes.stdout.includes('imported-ok'), `${spec.name} import guard must finish without starting daemon`);

      // W1-4: Cross-platform pure parser unit assertions (Windows quotes, Linux argv, POSIX ps whitespace ambiguity)
      assert.equal(
        daemonMod.evaluateStructuredDaemonArgv(
          daemonMod.tokenizeWindowsCommandLine(`"C:\\Program Files\\nodejs\\node.exe" "C:\\Projects\\My App\\${spec.daemonRel.replace(/\//g, '\\')}" --daemon --mode speed`),
          expectedRelNorm
        ).status,
        'verified',
        `${spec.name} Win32 spaced quoted daemon path must verify`
      );
      assert.equal(
        daemonMod.evaluateStructuredDaemonArgv(
          daemonMod.tokenizeWindowsCommandLine(`"C:\\Program Files\\nodejs\\node.exe" C:\\tmp\\helper.mjs --input "C:\\repo\\${spec.daemonRel.replace(/\//g, '\\')}" --daemon`),
          expectedRelNorm
        ).status,
        'mismatch',
        `${spec.name} Win32 helper --input daemon path must mismatch`
      );
      assert.equal(
        daemonMod.evaluateStructuredDaemonArgv(['/usr/bin/node', `/opt/agy/${expectedRelNorm}`, '--daemon'], expectedRelNorm).status,
        'verified'
      );
      assert.equal(
        daemonMod.evaluateStructuredDaemonArgv(['/usr/bin/node', '/tmp/helper.mjs', `/opt/agy/${expectedRelNorm}`, '--daemon'], expectedRelNorm).status,
        'mismatch'
      );
      assert.equal(
        daemonMod.evaluateStructuredDaemonArgv(['/usr/bin/node', `/opt/my-${expectedRelNorm}`, '--daemon'], expectedRelNorm).status,
        'mismatch'
      );
      assert.equal(
        daemonMod.evaluateStructuredDaemonArgv(['/usr/bin/node', `/opt/agy/${expectedRelNorm}`, 'status', '--daemon'], expectedRelNorm).status,
        'mismatch'
      );
      assert.equal(
        daemonMod.evaluateStructuredDaemonArgv(['/usr/bin/python3', `/opt/agy/${expectedRelNorm}`, '--daemon'], expectedRelNorm).status,
        'mismatch'
      );
      assert.equal(
        daemonMod.evaluatePsDaemonCommand(
          '/usr/local/bin/node',
          `/usr/local/bin/node /nonexistent/dir with space/${expectedRelNorm} --daemon`,
          expectedRelNorm,
          () => false
        ).status,
        'unknown'
      );
      assert.equal(
        daemonMod.evaluatePsDaemonCommand(
          '/usr/local/bin/node',
          `/usr/local/bin/node /real/dir with space/${expectedRelNorm} --daemon`,
          expectedRelNorm,
          (p) => p.endsWith(expectedRelNorm)
        ).status,
        'verified'
      );
      assert.equal(
        daemonMod.evaluatePsDaemonCommand(
          '/usr/local/bin/node',
          `/usr/local/bin/node /tmp/helper.mjs /real/dir with space/${expectedRelNorm} --daemon`,
          expectedRelNorm,
          (p) => p === '/tmp/helper.mjs' || p === `/real/dir with space/${expectedRelNorm}`
        ).status,
        'mismatch'
      );
      assert.equal(
        daemonMod.evaluatePsDaemonCommand(
          '/usr/local/bin/node',
          `/usr/local/bin/node /tmp/helper.mjs /real/dir with space/${expectedRelNorm} --daemon`,
          expectedRelNorm,
          (p) => p.endsWith('helper.mjs') || p.endsWith(expectedRelNorm)
        ).status,
        'unknown'
      );
    }

    pass('V1 daemon PID identity verification, entry boundary W1, reused-PID non-termination, STAGE_DIR upgrade boundary, standalone uninstall guard & unknown [WARN]');
  } finally {
    for (const c of spawnedChildren) {
      try { c.kill('SIGKILL'); } catch {}
    }
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function main() {
  const allFiles = walkFiles(ROOT);
  verifyRootStructureAndSyntax(allFiles);
  const pluginDirs = verifyPluginCatalog();
  verifyPrivacyPngAndGitIdentity(allFiles);
  verifyIndividualPlugins(pluginDirs);
  verifyRootInstaller();
  await verifyCrossPluginAuxTriggerLock();
  await verifyDaemonQuitAndUpgradePidSafety();
  console.log('\nAll agy-plugins repository checks passed.');
}

main();
