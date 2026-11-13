#!/usr/bin/env node
/**
 * Repository-wide Verification & Privacy Audit Suite for Dong-Kevin/agy-plugins.
 * Usage:
 *   node scripts/verify.mjs [--strict-git-identity]
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    assert.ok(listOut.includes('agy-finder') && listOut.includes('agy-context-viewer'));

    execFileSync('bash', [join(ROOT, 'install.sh'), 'agy-finder'], { cwd: ROOT, env, stdio: 'pipe' });
    assert.ok(existsSync(join(tempPlugins, 'agy-finder', 'plugin.json')));
    assert.ok(existsSync(join(tempPlugins, 'agy-finder', 'sidecars', 'tree', 'sidecar.json')));
    assert.ok(existsSync(join(tempBin, 'agy-finder')));

    execFileSync('bash', [join(ROOT, 'install.sh'), 'context-viewer'], { cwd: ROOT, env, stdio: 'pipe' });
    assert.ok(existsSync(join(tempPlugins, 'context-viewer', 'plugin.json')));
    assert.ok(existsSync(join(tempPlugins, 'context-viewer', 'sidecars', 'dashboard', 'sidecar.json')));
    assert.ok(existsSync(join(tempBin, 'agy-context')));

    execFileSync('bash', [join(ROOT, 'install.sh'), '--uninstall'], { cwd: ROOT, env, stdio: 'pipe' });
    assert.ok(!existsSync(join(tempPlugins, 'agy-finder')));
    assert.ok(!existsSync(join(tempPlugins, 'context-viewer')));
    assert.ok(!existsSync(join(tempBin, 'agy-finder')));
    assert.ok(!existsSync(join(tempBin, 'agy-context')));

    pass('Unified root install.sh (--list, selective install, alias match & --uninstall)');
  } finally {
    rmSync(tempPlugins, { recursive: true, force: true });
    rmSync(tempBin, { recursive: true, force: true });
  }
}

function main() {
  const allFiles = walkFiles(ROOT);
  verifyRootStructureAndSyntax(allFiles);
  const pluginDirs = verifyPluginCatalog();
  verifyPrivacyPngAndGitIdentity(allFiles);
  verifyIndividualPlugins(pluginDirs);
  verifyRootInstaller();
  console.log('\nAll agy-plugins repository checks passed.');
}

main();
