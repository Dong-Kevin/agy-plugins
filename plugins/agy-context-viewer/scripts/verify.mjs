#!/usr/bin/env node
/**
 * Strict Verification & Privacy Audit Suite for Antigravity Context Viewer.
 * Run before packaging or pushing to GitHub:
 *   node scripts/verify.mjs
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function assert(cond, msg) {
  if (!cond) throw new Error(`校验失败：${msg}`);
}

function walkFiles(dir, out = []) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'dist', 'node_modules', 'data'].includes(d.name)) continue;
    const full = join(dir, d.name);
    if (d.isDirectory()) {
      walkFiles(full, out);
    } else if (d.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function rawHttpRequest({ port, method = 'GET', path = '/', headers = {}, body = '' }) {
  return new Promise((resolveReq, rejectReq) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        Host: `127.0.0.1:${port}`,
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolveReq({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf-8')
        });
      });
    });
    req.on('error', rejectReq);
    if (body) req.write(body);
    req.end();
  });
}

async function runHttpSecurityAndBoundarySuite(port, label) {
  // R7: malformed request targets must return 400 and keep server alive
  const rBadBracket = await rawHttpRequest({ port, path: '//[' });
  assert(rBadBracket.status === 400, `[${label}] GET //[ 应返回 400，实际 ${rBadBracket.status}`);
  const rBadOriginUrl = await rawHttpRequest({ port, path: '//evil.invalid/api/settings' });
  assert(rBadOriginUrl.status === 400, `[${label}] GET //evil.invalid 应返回 400，实际 ${rBadOriginUrl.status}`);

  // R1: untrusted Host or cross-site Origin must be rejected
  const rBadHost = await rawHttpRequest({ port, path: '/api/settings', headers: { Host: 'review.invalid' } });
  assert(rBadHost.status === 403, `[${label}] 外部 Host 应返回 403，实际 ${rBadHost.status}`);
  const rBadGetOrigin = await rawHttpRequest({
    port,
    path: '/api/settings',
    headers: { Origin: 'https://review.invalid' }
  });
  assert(rBadGetOrigin.status === 403, `[${label}] 外部 Origin 读取敏感 API 应返回 403，实际 ${rBadGetOrigin.status}`);

  // R1: simple POST with foreign Origin/Host/text/plain must be blocked and leave settings untouched
  const evilBody = JSON.stringify({ uiPreferences: { preset: 'pwned_marker' } });
  const rForeignPost = await rawHttpRequest({
    port,
    method: 'POST',
    path: '/api/settings',
    headers: {
      Host: 'review.invalid',
      Origin: 'https://review.invalid',
      'Content-Type': 'text/plain'
    },
    body: evilBody
  });
  assert(rForeignPost.status === 403, `[${label}] 外部 Origin/Host POST 应返回 403，实际 ${rForeignPost.status}`);

  const rTextPlain = await rawHttpRequest({
    port,
    method: 'POST',
    path: '/api/settings',
    headers: { 'Content-Type': 'text/plain' },
    body: evilBody
  });
  assert(rTextPlain.status === 415, `[${label}] text/plain POST 应返回 415，实际 ${rTextPlain.status}`);

  const rMissingToken = await rawHttpRequest({
    port,
    method: 'POST',
    path: '/api/settings',
    headers: { 'Content-Type': 'application/json' },
    body: evilBody
  });
  assert(rMissingToken.status === 403, `[${label}] 缺少 X-CV-Token 的 POST 应返回 403，实际 ${rMissingToken.status}`);

  const rWrongToken = await rawHttpRequest({
    port,
    method: 'POST',
    path: '/api/settings',
    headers: {
      'Content-Type': 'application/json',
      'X-CV-Token': '0'.repeat(48)
    },
    body: evilBody
  });
  assert(rWrongToken.status === 403, `[${label}] 错误 X-CV-Token 的 POST 应返回 403，实际 ${rWrongToken.status}`);

  // Protect terminal & entrypoint control routes as well
  const rCliBlocked = await rawHttpRequest({
    port,
    method: 'POST',
    path: '/api/launch-cli',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert(rCliBlocked.status === 403, `[${label}] 未授权 POST /api/launch-cli 应返回 403，实际 ${rCliBlocked.status}`);

  const rEntryBlocked = await rawHttpRequest({
    port,
    method: 'POST',
    path: '/api/entrypoints',
    headers: { 'Content-Type': 'application/json' },
    body: '{"sidebarEnabled":true}'
  });
  assert(rEntryBlocked.status === 403, `[${label}] 未授权 POST /api/entrypoints 应返回 403，实际 ${rEntryBlocked.status}`);

  const rBefore = await rawHttpRequest({ port, path: '/api/settings' });
  assert(rBefore.status === 200, `[${label}] 异常请求后 GET /api/settings 应仍返回 200，实际 ${rBefore.status}`);
  const beforeJson = JSON.parse(rBefore.body);
  assert(beforeJson.uiPreferences?.preset !== 'pwned_marker', `[${label}] 未授权 POST 不得修改已持久化设置`);

  // Authorized dashboard flow: load HTML -> extract CSRF meta -> POST JSON with X-CV-Token
  const rIndex = await rawHttpRequest({ port, path: '/' });
  assert(rIndex.status === 200, `[${label}] GET / 应返回 200，实际 ${rIndex.status}`);
  const tokenMatch = rIndex.body.match(/<meta\s+name="cv-csrf-token"\s+content="([0-9a-f]{48})">/i);
  assert(Boolean(tokenMatch?.[1]), `[${label}] GET / HTML 缺少 cv-csrf-token 元标签`);
  const csrfToken = tokenMatch[1];

  const rMalformedJson = await rawHttpRequest({
    port,
    method: 'POST',
    path: '/api/settings',
    headers: {
      Origin: `http://127.0.0.1:${port}`,
      'Content-Type': 'application/json',
      'X-CV-Token': csrfToken
    },
    body: '{bad json'
  });
  assert(rMalformedJson.status === 400, `[${label}] 畸形 JSON 请求体应返回 400，实际 ${rMalformedJson.status}`);

  const rValidSave = await rawHttpRequest({
    port,
    method: 'POST',
    path: '/api/settings',
    headers: {
      Origin: `http://127.0.0.1:${port}`,
      'Content-Type': 'application/json',
      'X-CV-Token': csrfToken
    },
    body: JSON.stringify({ uiPreferences: { preset: 'ocean' } })
  });
  assert(rValidSave.status === 200, `[${label}] 合法令牌保存设置应返回 200，实际 ${rValidSave.status}`);
  const rAfter = await rawHttpRequest({ port, path: '/api/settings' });
  const afterJson = JSON.parse(rAfter.body);
  assert(afterJson.uiPreferences?.preset === 'ocean', `[${label}] 合法保存后 preset 应更新为 ocean`);

  return { csrfToken };
}

async function main() {
  console.log('[verify] 1/6 检查 plugin.json 与 sidecar.json 规范...');
  const manifestPath = join(ROOT, 'plugin.json');
  assert(existsSync(manifestPath), '缺少根目录 plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

  const allowedKeys = new Set([
    '$schema', 'name', 'displayName', 'version', 'description',
    'logo', 'suggestedPrompts', 'author', 'homepage', 'repository', 'disabled'
  ]);
  for (const k of Object.keys(manifest)) {
    assert(allowedKeys.has(k), `plugin.json 包含未知顶层字段：${k}`);
  }
  assert(/^[a-z0-9-]+$/.test(manifest.name), `plugin.json name 必须为 kebab-case：${manifest.name}`);
  assert(/^\d+\.\d+\.\d+/.test(manifest.version), `plugin.json version 需符合语义化版本：${manifest.version}`);
  assert(manifest.logo && !manifest.logo.startsWith('/') && !/^https?:/i.test(manifest.logo), 'logo 必须为插件相对路径');
  assert(existsSync(join(ROOT, manifest.logo)), `logo 文件不存在：${manifest.logo}`);
  assert(Array.isArray(manifest.suggestedPrompts) && manifest.suggestedPrompts.length <= 3, 'suggestedPrompts 最多 3 条');

  const sidecarPath = join(ROOT, 'sidecars', 'dashboard', 'sidecar.json');
  assert(existsSync(sidecarPath), '缺少 sidecars/dashboard/sidecar.json');
  const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
  assert(sidecar.command === 'node' && Array.isArray(sidecar.args) && sidecar.args[0] === 'main.mjs', 'sidecar.json 启动命令配置异常');
  assert(sidecar.has_web_ui === true, 'sidecar.json 需开启 has_web_ui');
  assert(
    sidecar.ui_config?.views?.[0]?.entrypoint === 'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
    'sidecar.json 首视图入口必须为 SIDECAR_UI_ENTRYPOINT_AUX_PANE'
  );
  const validEntrypoints = new Set([
    'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
    'SIDECAR_UI_ENTRYPOINT_SIDEBAR',
    'SIDECAR_UI_ENTRYPOINT_FULL_PANE'
  ]);
  for (const v of sidecar.ui_config?.views || []) {
    assert(validEntrypoints.has(v.entrypoint), `sidecar.json 包含未知视图入口：${v.entrypoint}`);
  }

  const skillPath = join(ROOT, 'skills', 'context-viewer', 'SKILL.md');
  assert(existsSync(skillPath), '缺少 skills/context-viewer/SKILL.md');
  const skillRaw = readFileSync(skillPath, 'utf-8');
  assert(/^---\n[\s\S]*?name:\s*context-viewer[\s\S]*?description:\s*.+\n---/m.test(skillRaw), 'SKILL.md YAML frontmatter 缺失或不完整');

  console.log('[verify] 2/6 检查全部 JS / MJS 语法...');
  const allFiles = walkFiles(ROOT);
  for (const f of allFiles) {
    if (['.js', '.mjs'].includes(extname(f))) {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    }
  }

  console.log('[verify] 3/6 执行常见敏感路径、令牌模式、PNG 文本元数据块与 Git 身份隐私检查...');
  const strictGitIdentity = process.argv.includes('--strict-git-identity');
  const forbiddenPatterns = [
    { re: /\/Users\/[A-Za-z0-9._-]+/, label: 'macOS 个人主目录绝对路径 (/Users/...)' },
    { re: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/, label: 'Windows 个人主目录绝对路径 (C:\\Users\\...)' },
    { re: /\/home\/[a-z0-9._-]+\//, label: 'Linux 个人主目录绝对路径 (/home/...)' },
    { re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, label: '会话 UUID 硬编码' },
    { re: /\b(AIza[0-9A-Za-z-_]{35}|ghp_[0-9A-Za-z]{36}|sk-[0-9A-Za-z]{32,})\b/, label: '疑似 API Key / Token' },
    { re: /\b[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com\b|example\.(?:com|org|net)\b|localhost\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, label: '未脱敏邮箱地址' },
    { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, label: 'PEM 私钥头' },
    { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/, label: '疑似明文 Bearer Token' },
    { re: /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@/, label: '带内联凭据的 URL' }
  ];
  const verifyRel = relative(ROOT, fileURLToPath(import.meta.url));
  const binaryExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico']);
  const forbiddenPngChunks = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME']);
  for (const f of allFiles) {
    const rel = relative(ROOT, f);
    if (rel === verifyRel) continue;
    const ext = extname(f).toLowerCase();
    if (binaryExts.has(ext)) {
      if (ext === '.png') {
        const buf = readFileSync(f);
        assert(
          buf.length >= 8 &&
            buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47,
          `PNG 文件签名无效：${rel}`
        );
        let offset = 8;
        while (offset + 8 <= buf.length) {
          const chunkLen = buf.readUInt32BE(offset);
          const chunkType = buf.subarray(offset + 4, offset + 8).toString('ascii');
          assert(!forbiddenPngChunks.has(chunkType), `PNG 图片 ${rel} 残留未剥离的元数据块：${chunkType}`);
          offset += 12 + chunkLen;
        }
      }
      continue;
    }
    const st = statSync(f);
    if (st.size > 2 * 1024 * 1024) continue;
    const text = readFileSync(f, 'utf-8');
    for (const pat of forbiddenPatterns) {
      const m = text.match(pat.re);
      const preview = m?.[0] ? `${m[0].slice(0, 4)}***` : '';
      assert(!m, `文件 ${rel} 命中敏感内容规则 [${pat.label}]：${preview}`);
    }
  }

  // Verify repository-managed pre-push hook script syntax and executable bit
  const REPO_ROOT = existsSync(join(ROOT, '.git')) ? ROOT : resolve(ROOT, '..', '..');
  const prePushHookPath = existsSync(join(ROOT, 'scripts', 'pre-push'))
    ? join(ROOT, 'scripts', 'pre-push')
    : join(REPO_ROOT, 'scripts', 'pre-push');
  assert(existsSync(prePushHookPath), '缺少仓库管理的 scripts/pre-push 钩子脚本');
  execFileSync('bash', ['-n', prePushHookPath], { stdio: 'pipe' });
  if (process.platform !== 'win32') {
    assert((statSync(prePushHookPath).mode & 0o111) !== 0, 'scripts/pre-push 缺少可执行权限');
  }

  // V1: Check unpushed Git commit metadata for non-noreply personal emails without printing plaintext emails/names
  const gitRoot = existsSync(join(ROOT, '.git')) ? ROOT : (existsSync(join(REPO_ROOT, '.git')) ? REPO_ROOT : '');
  if (gitRoot) {
    const isSafeCommitEmail = (email) => /@(?:users\.noreply\.github\.com|example\.(?:com|org|net))$/i.test(String(email || '').trim());
    let localGitEmail = '';
    try {
      localGitEmail = execFileSync('git', ['config', '--local', '--get', 'user.email'], { cwd: gitRoot, stdio: 'pipe', encoding: 'utf-8' }).trim();
    } catch {}
    let revRange = '';
    try {
      execFileSync('git', ['rev-parse', '--verify', 'origin/main'], { cwd: gitRoot, stdio: 'pipe' });
      revRange = 'origin/main..HEAD';
    } catch {
      try {
        execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: gitRoot, stdio: 'pipe' });
        revRange = '-n5';
      } catch {}
    }
    let gitLogRaw = '';
    if (revRange) {
      try {
        gitLogRaw = execFileSync(
          'git',
          ['log', ...(revRange === '-n5' ? ['-n', '5'] : [revRange]), '--format=%h|%ae|%ce'],
          { cwd: gitRoot, stdio: 'pipe', encoding: 'utf-8' }
        ).trim();
      } catch {}
    }
    const nonNoreplyHashes = [];
    for (const line of gitLogRaw ? gitLogRaw.split(/\r?\n/) : []) {
      const [shortHash, ae, ce] = line.split('|');
      if (shortHash && (!isSafeCommitEmail(ae) || !isSafeCommitEmail(ce))) {
        nonNoreplyHashes.push(shortHash);
      }
    }
    const localEmailNeedsFix = Boolean(strictGitIdentity && localGitEmail && !isSafeCommitEmail(localGitEmail));
    if (nonNoreplyHashes.length > 0 || localEmailNeedsFix) {
      const msgParts = [];
      if (nonNoreplyHashes.length > 0) msgParts.push(`未推送提交 (${nonNoreplyHashes.join(', ')}) 包含非 GitHub noreply 邮箱`);
      if (localEmailNeedsFix) msgParts.push('仓库本地 user.email 为非 noreply 邮箱');
      const summaryMsg = `${msgParts.join('；')}，推送前请确认公开身份或配置仓库级 noreply`;
      if (strictGitIdentity || (localGitEmail && isSafeCommitEmail(localGitEmail))) {
        assert(false, `V1 Git 身份门禁阻断：${summaryMsg}`);
      } else {
        console.log(`[verify] ⚠ 隐私提示：${summaryMsg}（运行 node scripts/verify.mjs --strict-git-identity 可严格阻断）`);
      }
    }
  }

  console.log('[verify] 4/6 检查宿主 CSS 隔离、零外部静态外链 (S2)、精确模型代际 (S4)、热力图 (R2) 与配额一致性 (R4 / F1)...');
  const indexHtmlSrc = readFileSync(join(ROOT, 'sidecars', 'dashboard', 'index.html'), 'utf-8');
  assert(!/https?:\/\//i.test(indexHtmlSrc), 'S2 index.html 仍残留外部 http(s) 资源链接');
  assert(
    indexHtmlSrc.includes(`/styles.css?v=${manifest.version}`) &&
      indexHtmlSrc.includes(`/app.js?v=${manifest.version}`),
    `index.html 静态资源版本查询参数未同步至 v${manifest.version}`
  );
  assert(
    !indexHtmlSrc.includes('id="budget-seg"') && indexHtmlSrc.includes('id="ctx-budget-chip"'),
    'index.html 应移除手动 budget-seg 档位并改用动态 ctx-budget-chip 胶囊'
  );
  for (const f of ['styles.css', 'app.js']) {
    const p = join(ROOT, 'sidecars', 'dashboard', f);
    const s = readFileSync(p, 'utf-8');
    if (f === 'styles.css') {
      assert(!/https?:\/\//i.test(s), 'S2 styles.css 不得包含外部 http(s) 字体或资源链接');
    }
    const collisions = [...s.matchAll(/var\(--(muted|accent|bg|surface|surface-2|surface-3|fg|fg-2|border-strong)(?![-a-zA-Z0-9_])/g)];
    assert(collisions.length === 0, `${f} 存在未加 --cv- 前缀的易冲突变量引用：${collisions[0]?.[0]}`);
  }
  const appJsSrc = readFileSync(join(ROOT, 'sidecars', 'dashboard', 'app.js'), 'utf-8');
  assert(!/\(pool\.models\s*\|\|\s*\[\]\)\.slice\([^)]*\)\.join\(/.test(appJsSrc), 'app.js 直接对 pool.models 对象数组调用 join 会产生 [object Object]');

  // R2: Execute actual heatmap date & DOM rendering code from app.js across current, leap-year, cross-year & paged windows
  const heatSliceStart = appJsSrc.indexOf('  function parseLocalDate(ymd)');
  const heatSliceEnd = appJsSrc.indexOf('  function renderWeeklyBars(dailyMap, hist)');
  assert(heatSliceStart > 0 && heatSliceEnd > heatSliceStart, '未定位到 app.js 热力图函数区间');
  const domText = {};
  const domStage = {
    innerHTML: '',
    scrollWidth: 640,
    scrollLeft: 0,
    querySelectorAll: () => []
  };
  const domDayInspector = { innerHTML: '' };
  const domPrevBtn = { disabled: false };
  const domNextBtn = { disabled: false };
  const heatCtx = {
    state: { heatPageOffset: 0, selectedBucketKey: '' },
    $: (id) => {
      if (id === 'chart-stage') return domStage;
      if (id === 'day-inspector') return domDayInspector;
      if (id === 'btn-heat-prev') return domPrevBtn;
      if (id === 'btn-heat-next') return domNextBtn;
      return null;
    },
    setText: (id, val) => { domText[id] = String(val); },
    escZh: (v) => String(v ?? ''),
    fmtTokens: (n) => `${Number(n || 0)}`,
    fmtInt: (n) => `${Number(n || 0)}`,
    fmtUSD: (n) => `$${Number(n || 0).toFixed(2)}`,
    fmtCNY: (n) => `¥${(Number(n || 0) * 7.2).toFixed(2)}`,
    requestAnimationFrame: (fn) => fn()
  };
  const heatApi = runInNewContext(
    `${appJsSrc.slice(heatSliceStart, heatSliceEnd)}\n({ parseLocalDate, toYmd, computeHeatmapDateWindow, renderDailyHeatmap });`,
    heatCtx
  );

  const wCurr = heatApi.computeHeatmapDateWindow('2026-11-12', 0);
  assert(heatApi.toYmd(wCurr.startSun) === '2025-11-09', `R2 热力图起始日应为 2025-11-09，实际 ${heatApi.toYmd(wCurr.startSun)}`);
  assert(heatApi.toYmd(wCurr.endSat) === '2026-11-14', `R2 热力图结束周六应为 2026-11-14，实际 ${heatApi.toYmd(wCurr.endSat)}`);
  assert(wCurr.startSun.getDay() === 0 && wCurr.endSat.getDay() === 6, 'R2 热力图首末星期对齐异常');
  const walkDays = [];
  const walkCursor = new Date(wCurr.startSun);
  for (let i = 0; i < 371; i++) {
    walkDays.push(heatApi.toYmd(walkCursor));
    walkCursor.setDate(walkCursor.getDate() + 1);
  }
  assert(walkDays.length === 371 && new Set(walkDays).size === 371, 'R2 热力图 371 天不连续或存在重复日期');
  assert(walkDays[0] === '2025-11-09' && walkDays[370] === '2026-11-14' && walkDays.includes('2026-11-12'), 'R2 热力图未覆盖今日 2026-11-12');

  const wPrev = heatApi.computeHeatmapDateWindow('2026-11-12', 1);
  assert(
    heatApi.toYmd(wPrev.startSun) === '2024-11-03' &&
      heatApi.toYmd(wPrev.endSat) === '2025-11-08' &&
      heatApi.toYmd(wPrev.displayEnd) === '2025-11-08',
    `R2 热力图上一页区间异常：${heatApi.toYmd(wPrev.startSun)} ~ ${heatApi.toYmd(wPrev.endSat)}`
  );
  const wLeap = heatApi.computeHeatmapDateWindow('2024-02-29', 0);
  assert(
    heatApi.toYmd(wLeap.startSun) === '2023-02-26' && heatApi.toYmd(wLeap.endSat) === '2024-03-02',
    `R2 闰年热力图窗口异常：${heatApi.toYmd(wLeap.startSun)} ~ ${heatApi.toYmd(wLeap.endSat)}`
  );
  const wNewYear = heatApi.computeHeatmapDateWindow('2026-01-01', 0);
  assert(
    heatApi.toYmd(wNewYear.startSun) === '2024-12-29' && heatApi.toYmd(wNewYear.endSat) === '2026-01-03',
    `R2 跨年热力图窗口异常：${heatApi.toYmd(wNewYear.startSun)} ~ ${heatApi.toYmd(wNewYear.endSat)}`
  );

  heatApi.renderDailyHeatmap(
    { '2026-11-12': { total: 42000, input: 10000, cache: 30000, output: 2000, steps: 3, costUSD: 0.12, refCostUSD: 0.12 } },
    { todayKey: '2026-11-12', firstUseDate: '2026-11-01', planStatus: { monthlyUSD: 19.99 } }
  );
  assert(domText['heat-range-label'] === '2025-11-09 至 2026-11-12', `R2 热力图标题区间异常：${domText['heat-range-label']}`);
  assert(domPrevBtn.disabled === true, 'R2 起始窗口早于首次记录日期时前一年按钮应禁用');
  assert(/class="heat-cell" data-lvl="[1-4]" data-day="2026-11-12"/.test(domStage.innerHTML), 'R2 今日有记录时热力图单元格未点亮');
  assert(domText['sum-tok'] === '42000', `R2 热力图区间汇总异常：${domText['sum-tok']}`);

  // Pricing, S4 generational precision, R4 & F1 quota grouping / single-model parity checks
  const {
    classifyRequestError,
    formatModelDisplayName,
    getRegionTierMonthlyPrice,
    groupModelQuotas,
    maskEmail,
    normalizeModelId,
    parseUserPlanStatus,
    resolveEffectivePlanStatus,
    resolveModelQuota,
    sanitizeDiagnosticText,
    SUBSCRIPTION_REGIONS_PRESET,
    summarizeApiCost
  } = await import(join(ROOT, 'sidecars', 'dashboard', 'pricing.mjs'));

  // Privacy hardening: custom-domain email masking & error diagnostic sanitization
  assert(
    maskEmail('demo@gmail.com') === 'de***@gmail.com' &&
      maskEmail('owner@custom-studio.dev') === 'ow***@c***.dev' &&
      maskEmail('staff@eng.corp.co.uk') === 'st***@e***.co.uk',
    `自定义域邮箱掩码结果异常：gmail=${maskEmail('demo@gmail.com')}, custom=${maskEmail('owner@custom-studio.dev')}, uk=${maskEmail('staff@eng.corp.co.uk')}`
  );
  const rawSensitiveErr = '503 UNAVAILABLE https://api.internal.test/v1?key=1 Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 sk-abcdefghijklmnopqrstuvwxyz123456 /Users/secretuser/proj/a.js admin@private-corp.io';
  const cleanDiag = sanitizeDiagnosticText(rawSensitiveErr, 300);
  const cleanErrObj = classifyRequestError(rawSensitiveErr);
  assert(
    !cleanDiag.includes('api.internal.test') &&
      !cleanDiag.includes('eyJhbGci') &&
      !cleanDiag.includes('abcdefghijklmnopqrstuvwxyz') &&
      !cleanDiag.includes('secretuser') &&
      !cleanDiag.includes('private-corp') &&
      cleanErrObj.kind === 'service_unavailable' &&
      !cleanErrObj.diagnostic.includes('secretuser') &&
      !cleanErrObj.diagnostic.includes('private-corp') &&
      !cleanErrObj.diagnostic.includes('eyJhbGci'),
    `错误诊断脱敏失败或破坏错误分类：kind=${cleanErrObj.kind}, diag=${cleanErrObj.diagnostic}`
  );

  // S4: Exact generational matching only — unknown or older generations must return null (unpriced -> Hybrid)
  assert(normalizeModelId('Gemini 4 Carbon (High)') === 'gemini-4-carbon', 'S4 Gemini 4 Carbon 匹配异常');
  assert(normalizeModelId('Orchestrator (Carbon)') === 'gemini-4-carbon', 'S4 Orchestrator (Carbon) 匹配异常');
  assert(normalizeModelId('MODEL_PLACEHOLDER_M667') === 'gemini-4-carbon', 'S4 M667 placeholder 应映射 gemini-4-carbon');
  assert(normalizeModelId('Gemini 4 Argon') === 'gemini-4-argon', 'S4 Gemini 4 Argon 匹配异常');
  assert(normalizeModelId('Orchestrator (Argon)') === 'gemini-4-argon', 'S4 Orchestrator (Argon) 匹配异常');
  assert(normalizeModelId('MODEL_PLACEHOLDER_M681') === 'gemini-4-argon', 'S4 M681 placeholder 应映射 gemini-4-argon');
  assert(normalizeModelId('Gemini 4 Neon (High)') === 'gemini-4-neon', 'S4 Gemini 4 Neon (High) 匹配异常');
  assert(normalizeModelId('Gemini 4 Neon (XHigh)') === 'gemini-4-neon', 'S4 Gemini 4 Neon (XHigh) 匹配异常');
  assert(normalizeModelId('Gemini 4 Neon (Medium)') === 'gemini-4-neon', 'S4 Gemini 4 Neon (Medium) 匹配异常');
  assert(normalizeModelId('Gemini 4 Neon (Low)') === 'gemini-4-neon', 'S4 Gemini 4 Neon (Low) 匹配异常');
  assert(normalizeModelId('Gemini 4 Neon (Orchestrator)') === 'gemini-4-neon', 'S4 Gemini 4 Neon (Orchestrator) 匹配异常');
  assert(normalizeModelId('Orchestrator (Neon)') === 'gemini-4-neon', 'S4 Orchestrator (Neon) 匹配异常');
  assert(normalizeModelId('gemini-pro-orchestrator-neon') === 'gemini-4-neon', 'S4 gemini-pro-orchestrator-neon 匹配异常');
  assert(normalizeModelId('MODEL_PLACEHOLDER_M532') === 'gemini-4-neon', 'S4 M532 placeholder 应映射 gemini-4-neon');
  assert(normalizeModelId('MODEL_PLACEHOLDER_M533') === 'gemini-4-neon', 'S4 M533 placeholder 应映射 gemini-4-neon');
  assert(normalizeModelId('MODEL_PLACEHOLDER_M534') === 'gemini-4-neon', 'S4 M534 placeholder 应映射 gemini-4-neon');
  assert(normalizeModelId('MODEL_PLACEHOLDER_M535') === 'gemini-4-neon', 'S4 M535 placeholder 应映射 gemini-4-neon');
  assert(normalizeModelId('MODEL_PLACEHOLDER_M537') === 'gemini-4-neon', 'S4 M537 placeholder 应映射 gemini-4-neon');
  assert(formatModelDisplayName('gemini-pro-orchestrator-neon') === 'Gemini 4 Neon', 'S4 gemini-pro-orchestrator-neon 显示名异常');
  assert(formatModelDisplayName('MODEL_PLACEHOLDER_M537') === 'Gemini 4 Neon', 'S4 MODEL_PLACEHOLDER_M537 显示名异常');
  assert(formatModelDisplayName('Orchestrator (Neon)') === 'Orchestrator (Neon)', 'S4 Orchestrator (Neon) 显示名异常');
  assert(normalizeModelId('Gemini 4 Hydrogen (XHigh)') === 'gemini-4-hydrogen', 'S4 Gemini 4 Hydrogen (XHigh) 匹配异常');
  assert(normalizeModelId('Gemini 4 Hydrogen (Orchestrator)') === 'gemini-4-hydrogen', 'S4 Gemini 4 Hydrogen (Orchestrator) 匹配异常');
  assert(normalizeModelId('MODEL_PLACEHOLDER_M525') === 'gemini-4-hydrogen', 'S4 M525 placeholder 应映射 gemini-4-hydrogen');
  assert(normalizeModelId('MODEL_PLACEHOLDER_M528') === 'gemini-4-hydrogen', 'S4 M528 placeholder 应映射 gemini-4-hydrogen');
  assert(normalizeModelId('Gemini 3.8 Flash') === 'gemini-3.8-flash', 'S4 Gemini 3.8 Flash 匹配异常');
  assert(normalizeModelId('Gemini 3.5 Flash-Lite') === 'gemini-3.5-flash-lite', 'S4 Gemini 3.5 Flash-Lite 匹配异常');
  assert(normalizeModelId('Gemini 3.1 Pro (High)') === 'gemini-3.1-pro-preview', 'S4 Gemini 3.1 Pro 匹配异常');
  assert(normalizeModelId('Gemini 2.5 Pro') === 'gemini-2.5-pro', 'S4 Gemini 2.5 Pro 匹配异常');
  assert(normalizeModelId('Claude Opus 5.5 (Thinking)') === 'claude-opus-5-5', 'S4 Claude Opus 5.5 匹配异常');
  assert(normalizeModelId('Claude Sonnet 5.5') === 'claude-sonnet-5-5', 'S4 Claude Sonnet 5.5 匹配异常');
  assert(normalizeModelId('GPT-OSS 120B (Medium)') === 'gpt-oss-120b', 'S4 GPT-OSS 120B 匹配异常');
  for (const unpricedGen of [
    'Claude 3.5 Sonnet',
    'Claude Sonnet 4',
    'Claude Sonnet',
    'Claude 3 Opus',
    'Claude Opus 4',
    'Claude Opus',
    'Gemini 1.5 Flash',
    'Gemini 2.5 Flash',
    'Gemini Flash',
    'Gemini 2.0 Flash-Lite',
    'Flash-Lite',
    'GPT-OSS 20B',
    'gemini-pro-orchestrator',
    'gemini-flash-worker-agy',
    'Gemini Neon',
    'Gemini 5 Neon (XHigh)',
    'Gemini 5 Neon (Orchestrator)',
    'Gemini 5 Hydrogen',
    'MODEL_PLACEHOLDER_M669'
  ]) {
    assert(normalizeModelId(unpricedGen) === null, `S4 非当前代际或泛称模型 "${unpricedGen}" 不应误绑已知代际费率`);
  }
  const s4Summary = summarizeApiCost([
    { model: 'Claude 3.5 Sonnet', inputTokens: 1000, outputTokens: 200 },
    { model: '', inputTokens: 500, outputTokens: 100 }
  ]);
  assert(
    s4Summary.pricedRequestsCount === 0 &&
      s4Summary.unpricedRequestsCount === 2 &&
      s4Summary.unpricedReasons.unsupportedModel === 1 &&
      s4Summary.unpricedReasons.missingModel === 1 &&
      s4Summary.byModel.some((m) => m.displayName === 'Claude 3.5 Sonnet' && m.unpriced && !m.missingModel),
    'S4 未收录代际模型在 summarizeApiCost 中未正确归入 unsupportedModel / 保留真实显示名'
  );
  assert(normalizeModelId('MODEL_PLACEHOLDER_M322') === 'gemini-3.8-flash', 'S4 M322 placeholder 应映射 gemini-3.8-flash');
  const hydrogenMerged = summarizeApiCost([
    { model: 'Gemini 4 Hydrogen (XHigh)', inputTokens: 1_000_000, cacheTokens: 0, outputTokens: 0 },
    { model: 'Gemini 4 Hydrogen (High)', inputTokens: 0, cacheTokens: 1_000_000, outputTokens: 0 },
    { model: 'Gemini 4 Hydrogen (Orchestrator)', inputTokens: 0, cacheTokens: 0, outputTokens: 1_000_000 },
    { model: 'Orchestrator (Carbon)', inputTokens: 500_000, cacheTokens: 0, outputTokens: 0, date: '2026-11-15' }
  ]);
  const h4Row = hydrogenMerged.byModel.find((m) => m.displayName === 'Gemini 4 Hydrogen');
  const c4Row = hydrogenMerged.byModel.find((m) => m.displayName === 'Gemini 4 Carbon');
  assert(
    hydrogenMerged.pricedRequestsCount === 4 &&
      hydrogenMerged.unpricedRequestsCount === 0 &&
      hydrogenMerged.byModel.length === 2 &&
      h4Row && !h4Row.unpriced && h4Row.requests === 3 && h4Row.tokens === 3_000_000 &&
      Math.abs(h4Row.costUSD - 9.075) < 1e-6 &&
      c4Row && !c4Row.unpriced && c4Row.requests === 1 && Math.abs(c4Row.costUSD - 1.0) < 1e-6,
    `Gemini 4 Hydrogen / Orchestrator 合并计价异常：${JSON.stringify(hydrogenMerged.byModel)}`
  );
  const neonMerged = summarizeApiCost([
    { model: 'Gemini 4 Neon (High)', inputTokens: 1_000_000, cacheTokens: 0, outputTokens: 0 },
    { model: 'Orchestrator (Neon)', inputTokens: 0, cacheTokens: 1_000_000, outputTokens: 0 },
    { model: 'gemini-pro-orchestrator-neon', inputTokens: 0, cacheTokens: 0, outputTokens: 1_000_000 },
    { model: 'MODEL_PLACEHOLDER_M537', inputTokens: 1_000_000, cacheTokens: 0, outputTokens: 0 }
  ]);
  const n4Row = neonMerged.byModel.find((m) => m.displayName === 'Gemini 4 Neon');
  assert(
    neonMerged.pricedRequestsCount === 4 &&
      neonMerged.unpricedRequestsCount === 0 &&
      neonMerged.byModel.length === 1 &&
      n4Row && !n4Row.unpriced && n4Row.requests === 4 && n4Row.tokens === 4_000_000 &&
      Math.abs(n4Row.costUSD - 21.15) < 1e-6,
    `Gemini 4 Neon / Orchestrator 合并计价异常：${JSON.stringify(neonMerged.byModel)}`
  );
  const futureSuffixMerged = summarizeApiCost([
    { model: 'Gemini 5 Neon (XHigh)', inputTokens: 2000, outputTokens: 200 },
    { model: 'Gemini 5 Neon (High)', inputTokens: 1000, outputTokens: 100 },
    { model: 'Gemini 5 Neon (Orchestrator)', inputTokens: 500, outputTokens: 50 }
  ]);
  assert(
    futureSuffixMerged.byModel.length === 1 &&
      futureSuffixMerged.byModel[0].displayName === 'Gemini 5 Neon' &&
      futureSuffixMerged.byModel[0].unpriced === true &&
      futureSuffixMerged.byModel[0].requests === 3 &&
      futureSuffixMerged.byModel[0].tokens === 3850,
    `未收录模型剥离后缀合并异常：${JSON.stringify(futureSuffixMerged.byModel)}`
  );
  const ultraParsed = parseUserPlanStatus({
    userStatus: {
      userTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' },
      planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_PRO', planName: 'Pro' } }
    }
  });
  assert(ultraParsed.tierKey === 'ultra' && ultraParsed.tierName === 'Google AI Ultra', `Ultra 档位名称识别异常：${ultraParsed.tierName}`);
  const ultraDefaultEff = resolveEffectivePlanStatus(ultraParsed, null);
  assert(ultraDefaultEff.effectivePrice === 249.99 && !ultraDefaultEff.isCustomized, `Ultra 默认参考价异常：${ultraDefaultEff.effectivePrice}`);
  const ultraFamilyEff = resolveEffectivePlanStatus(ultraParsed, { acquisitionId: 'family_sharing', zeroExtra: true });
  assert(ultraFamilyEff.monthlyNormalized === 0 && ultraFamilyEff.isCustomized, '家庭组免额外付费折算异常');
  const unknownParsed = parseUserPlanStatus(null);
  const unknownDefaultEff = resolveEffectivePlanStatus(unknownParsed, null);
  assert(
    unknownParsed.tierKey === 'unknown' &&
      getRegionTierMonthlyPrice(SUBSCRIPTION_REGIONS_PRESET[0], 'unknown') === null &&
      unknownDefaultEff.effectivePrice === null &&
      unknownDefaultEff.monthlyNormalized === null &&
      unknownDefaultEff.monthlyUSD === null,
    `未识别套餐不应默认套用 $19.99/月参考价：${JSON.stringify(unknownDefaultEff)}`
  );
  const unknownExplicitEff = resolveEffectivePlanStatus(unknownParsed, { priceMode: 'preset', actualPricePaid: 19.99 });
  assert(unknownExplicitEff.effectivePrice === 19.99, '未识别套餐手动填写实付金额未生效');
  assert(
    appJsSrc.includes("quotaStatus?.state === 'unavailable'") &&
      appJsSrc.includes('未连接宿主'),
    'app.js 未显式提示 unavailable 离线配额状态'
  );

  const samplePools = groupModelQuotas([
    { label: 'Gemini 4 Carbon (High)', modelId: 'M1', quotaInfo: { remainingFraction: 0.934, resetTime: '2026-11-12T07:05:09Z' } },
    { label: 'Gemini 4 Carbon (Low)', modelId: 'M2', quotaInfo: { remainingFraction: 0.934, resetTime: '2026-11-12T07:05:09Z' } },
    { label: 'Gemini 3.8 Flash (High)', modelId: 'M3', quotaInfo: { remainingFraction: 0.934, resetTime: '2026-11-12T07:05:09Z' } }
  ], [
    {
      displayName: 'Gemini Models',
      buckets: [
        { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.998, resetTime: '2026-11-12T12:05:09Z' },
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.926, resetTime: '2026-11-18T02:35:16Z' }
      ]
    }
  ]);
  assert(samplePools.length === 1 && Array.isArray(samplePools[0].families) && samplePools[0].families.join(' / ') === 'Gemini 4 Carbon / Gemini 3.8 Flash', 'groupModelQuotas families 聚合结果异常');
  assert(samplePools[0].fiveHour?.remainingPercent === 99.8 && samplePools[0].weekly?.remainingPercent === 92.6, 'RetrieveUserQuotaSummary 5h + weekly 合并异常');
  assert(!JSON.stringify(samplePools).includes('[object Object]'), '配额池序列化包含 [object Object]');

  // R4: Distinct model groups with identical remainingFraction + resetTime (or missing quotaInfo) must never merge
  const sharedRawQuota = { remainingFraction: 1, resetTime: '2026-11-13T10:00:00Z' };
  const summaryGroupsAB = [
    { displayName: 'Gemini Models', buckets: [{ window: '5h', remainingFraction: 0.8 }] },
    { displayName: 'Claude Models', buckets: [{ window: '5h', remainingFraction: 0.2 }] }
  ];
  const r4Pools = groupModelQuotas([
    { label: 'Gemini 4 Carbon', quotaInfo: sharedRawQuota },
    { label: 'Claude Opus 5.5', quotaInfo: sharedRawQuota }
  ], summaryGroupsAB);
  assert(r4Pools.length === 2, `R4 同余额不同品牌池不应合并，实际池数 ${r4Pools.length}`);
  const geminiPoolA = r4Pools.find((p) => p.families.includes('Gemini 4 Carbon'));
  const claudePoolA = r4Pools.find((p) => p.families.includes('Claude Opus 5.5'));
  assert(geminiPoolA?.remainingPercent === 80 && claudePoolA?.remainingPercent === 20, 'R4 Gemini/Claude 分池百分比异常');

  const r4Reversed = groupModelQuotas([
    { label: 'Gemini 4 Carbon', quotaInfo: null },
    { label: 'Claude Opus 5.5', quotaInfo: null }
  ], [...summaryGroupsAB].reverse());
  const geminiPoolB = r4Reversed.find((p) => p.families.includes('Gemini 4 Carbon'));
  const claudePoolB = r4Reversed.find((p) => p.families.includes('Claude Opus 5.5'));
  assert(
    r4Reversed.length === 2 && geminiPoolB?.remainingPercent === 80 && claudePoolB?.remainingPercent === 20,
    'R4 翻转 summaryGroups 顺序或缺失 quotaInfo 时分池结果不一致'
  );

  const r4HighLow = groupModelQuotas([
    { label: 'Gemini 4 Carbon (High)', quotaInfo: sharedRawQuota },
    { label: 'Gemini 4 Carbon (Low)', quotaInfo: sharedRawQuota },
    { label: 'Claude Opus 5.5 (Thinking)', quotaInfo: sharedRawQuota }
  ], []);
  assert(r4HighLow.length === 2, `R4 无 summaryGroups 时同族 High/Low 应合并而跨族应隔离，实际池数 ${r4HighLow.length}`);

  // F1: Multi-pool same-brand resolution parity across groupModelQuotas & resolveModelQuota
  const f1Configs = [
    { label: 'Gemini 4 Carbon', modelId: 'M1', quotaInfo: { poolId: 'g-carbon', remainingFraction: 0.9 } },
    { label: 'Gemini 3.8 Flash', modelId: 'M2', quotaInfo: { poolId: 'g-flash', remainingFraction: 0.9 } }
  ];
  const f1Groups = [
    { groupId: 'g-carbon', displayName: 'Gemini Group A', modelIds: ['M1'], buckets: [{ window: '5h', remainingFraction: 0.8 }] },
    { groupId: 'g-flash', displayName: 'Gemini Group B', modelIds: ['M2'], buckets: [{ window: '5h', remainingFraction: 0.2 }] }
  ];
  const f1Pools = groupModelQuotas(f1Configs, f1Groups);
  const f1Carbon = resolveModelQuota('Gemini 4 Carbon', f1Configs, f1Groups);
  const f1Flash = resolveModelQuota('Gemini 3.8 Flash', f1Configs, f1Groups);
  const f1FlashRev = resolveModelQuota('Gemini 3.8 Flash', f1Configs, [...f1Groups].reverse());
  assert(
    f1Pools.length === 2 &&
      f1Pools.find((p) => p.families.includes('Gemini 4 Carbon'))?.remainingPercent === 80 &&
      f1Pools.find((p) => p.families.includes('Gemini 3.8 Flash'))?.remainingPercent === 20 &&
      f1Carbon?.remainingPercent === 80 &&
      f1Flash?.remainingPercent === 20 &&
      f1FlashRev?.remainingPercent === 20,
    `F1 同品牌双 Gemini 池列表与单模型配额不一致：Carbon=${f1Carbon?.remainingPercent} Flash=${f1Flash?.remainingPercent}`
  );
  assert(
    resolveModelQuota('Gemini Flash', f1Configs, f1Groups)?.remainingPercent === 20 &&
      resolveModelQuota('Gemini 5 Unknown', f1Configs, f1Groups) === null,
    'F1 多池下 Gemini Flash 应唯一定位 Flash 子池，无子族标签应返回 null'
  );
  const f1NeonConfigs = [
    { label: 'Gemini 4 Neon (High)', modelId: 'gemini-4-neon-high', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M532' }, quotaInfo: { poolId: 'g-neon', remainingFraction: 0.9 } },
    { label: 'Gemini 3.8 Flash', modelId: 'gemini-3.8-flash-high', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M318' }, quotaInfo: { poolId: 'g-flash', remainingFraction: 0.9 } }
  ];
  const f1NeonGroups = [
    { groupId: 'g-neon', displayName: 'Gemini Group Neon', modelIds: ['MODEL_PLACEHOLDER_M532'], buckets: [{ window: '5h', remainingFraction: 0.75 }] },
    { groupId: 'g-flash', displayName: 'Gemini Group Flash', modelIds: ['MODEL_PLACEHOLDER_M318'], buckets: [{ window: '5h', remainingFraction: 0.25 }] }
  ];
  assert(
    resolveModelQuota('Orchestrator (Neon)', f1NeonConfigs, f1NeonGroups)?.remainingPercent === 75 &&
      resolveModelQuota('Gemini 4 Neon (Orchestrator)', f1NeonConfigs, f1NeonGroups)?.remainingPercent === 75 &&
      resolveModelQuota('gemini-pro-orchestrator-neon', f1NeonConfigs, f1NeonGroups)?.remainingPercent === 75,
    'F1 多子池下 Orchestrator (Neon) 应唯一定位 Neon 子池'
  );

  // F1b: Explicit poolId-only (no modelIds) & explicit modelIds-only (identical displayName, no groupId)
  const f1PoolIdOnlyGroups = [
    { groupId: 'g-carbon', displayName: 'Gemini Models', buckets: [{ window: '5h', remainingFraction: 0.8 }] },
    { groupId: 'g-flash', displayName: 'Gemini Models', buckets: [{ window: '5h', remainingFraction: 0.2 }] }
  ];
  assert(
    resolveModelQuota('Gemini 3.8 Flash', f1Configs, f1PoolIdOnlyGroups)?.remainingPercent === 20,
    'F1 仅含显式 poolId/groupId 时未命中对应 Gemini 子池'
  );
  const f1ModelIdsOnlyConfigs = [
    { label: 'Gemini 4 Carbon', modelId: 'M1', quotaInfo: { remainingFraction: 0.9 } },
    { label: 'Gemini 3.8 Flash', modelId: 'M2', quotaInfo: { remainingFraction: 0.9 } }
  ];
  const f1ModelIdsOnlyGroups = [
    { displayName: 'Gemini', modelIds: ['M1'], buckets: [{ window: '5h', remainingFraction: 0.8 }] },
    { displayName: 'Gemini', modelIds: ['M2'], buckets: [{ window: '5h', remainingFraction: 0.2 }] }
  ];
  assert(
    groupModelQuotas(f1ModelIdsOnlyConfigs, f1ModelIdsOnlyGroups).length === 2 &&
      resolveModelQuota('Gemini 3.8 Flash', f1ModelIdsOnlyConfigs, f1ModelIdsOnlyGroups)?.remainingPercent === 20,
    'F1 同名 displayName 仅靠 modelIds 区分时配额分池或单模型解析异常'
  );

  // F1c: Ambiguous equal-score brand ties must reject arbitrary tie-breaking and preserve raw quotaInfo
  const f1AmbiguousConfigs = [
    { label: 'Gemini 3.8 Flash', modelId: 'M2', quotaInfo: { remainingFraction: 0.55 } }
  ];
  const f1AmbiguousGroups = [
    { displayName: 'Gemini Group A', buckets: [{ window: '5h', remainingFraction: 0.8 }] },
    { displayName: 'Gemini Group B', buckets: [{ window: '5h', remainingFraction: 0.2 }] }
  ];
  assert(
    resolveModelQuota('Gemini 3.8 Flash', f1AmbiguousConfigs, f1AmbiguousGroups)?.remainingPercent === 55 &&
      resolveModelQuota('Gemini 3.8 Flash', f1AmbiguousConfigs, [...f1AmbiguousGroups].reverse())?.remainingPercent === 55,
    'F1 歧义同分候选组不应按字母序猜测覆盖原始 quotaInfo'
  );

  // Q1: Hydrogen + XHigh + Orchestrator must merge into single Gemini umbrella pool despite descriptive group copy,
  // producing semantic brand titles ("Gemini 模型" / "非 Gemini 模型（Claude / GPT）")
  const q1Configs = [
    { label: 'Gemini 4 Carbon (High)', modelId: 'MODEL_PLACEHOLDER_M427', quotaInfo: { remainingFraction: 0.965, resetTime: '2026-11-14T16:07:19Z' } },
    { label: 'Gemini 4 Hydrogen (Low)', modelId: 'MODEL_PLACEHOLDER_M525', quotaInfo: { remainingFraction: 0.965, resetTime: '2026-11-14T16:07:19Z' } },
    { label: 'Gemini 4 Hydrogen (High)', modelId: 'MODEL_PLACEHOLDER_M527', quotaInfo: { remainingFraction: 0.965, resetTime: '2026-11-14T16:07:19Z' } },
    { label: 'Gemini 4 Hydrogen (XHigh)', modelId: 'MODEL_PLACEHOLDER_M528', quotaInfo: { remainingFraction: 0.965, resetTime: '2026-11-14T16:07:19Z' } },
    { label: 'Orchestrator (Carbon)', modelId: 'MODEL_PLACEHOLDER_M667', quotaInfo: { remainingFraction: 0.965, resetTime: '2026-11-14T16:07:19Z' } },
    { label: 'Claude Opus 5.5 (Thinking)', modelId: 'MODEL_PLACEHOLDER_M400', quotaInfo: { remainingFraction: 0.88, resetTime: '2026-11-14T16:38:00Z' } },
    { label: 'GPT-OSS 120B (Medium)', modelId: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM', quotaInfo: { remainingFraction: 0.88, resetTime: '2026-11-14T16:38:00Z' } }
  ];
  const q1Groups = [
    {
      displayName: 'Gemini Models',
      description: 'Includes Carbon, Argon, and Flash variants',
      buckets: [
        { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.965, resetTime: '2026-11-14T16:07:19Z' },
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.924, resetTime: '2026-11-21T01:07:00Z' }
      ]
    },
    {
      displayName: 'Claude and GPT Models',
      description: 'Third-party partner models including Claude and GPT-OSS',
      buckets: [
        { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: '2026-11-14T16:38:00Z' },
        { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.266, resetTime: '2026-11-19T02:03:00Z' }
      ]
    }
  ];
  const q1Pools = groupModelQuotas(q1Configs, q1Groups);
  const q1GemPool = q1Pools.find((p) => p.families.includes('Gemini 4 Hydrogen'));
  const q1NonGemPool = q1Pools.find((p) => p.families.includes('Claude Opus 5.5'));
  assert(
    q1Pools.length === 2 &&
      q1GemPool?.displayTitle === 'Gemini 模型' &&
      q1GemPool?.shortLabel === 'Gemini' &&
      q1GemPool?.modelsCount === 5 &&
      q1GemPool.families.filter((f) => f === 'Gemini 4 Hydrogen').length === 1 &&
      q1NonGemPool?.displayTitle === '非 Gemini 模型（Claude / GPT）' &&
      q1NonGemPool?.shortLabel === '非 Gemini' &&
      q1NonGemPool?.modelsCount === 2,
    `Q1 Hydrogen / XHigh 并池或语义标题异常：${JSON.stringify(q1Pools)}`
  );
  const q1OrchCarbon = resolveModelQuota('Orchestrator (Carbon)', q1Configs, q1Groups);
  const q1HydroOrch = resolveModelQuota('Gemini 4 Hydrogen (Orchestrator)', q1Configs, q1Groups);
  const q1GemFlash = resolveModelQuota('Gemini Flash', q1Configs, q1Groups);
  assert(
    q1OrchCarbon?.label === 'Orchestrator (Carbon)' &&
      q1OrchCarbon?.modelKey === 'gemini-4-carbon' &&
      q1OrchCarbon?.fiveHour?.remainingPercent === 96.5 &&
      q1OrchCarbon?.weekly?.remainingPercent === 92.4 &&
      q1HydroOrch?.label === 'Gemini 4 Hydrogen (Orchestrator)' &&
      q1HydroOrch?.modelKey === 'gemini-4-hydrogen' &&
      q1HydroOrch?.fiveHour?.remainingPercent === 96.5 &&
      q1HydroOrch?.weekly?.remainingPercent === 92.4 &&
      q1GemFlash?.label === 'Gemini Flash' &&
      q1GemFlash?.modelKey === null &&
      q1GemFlash?.fiveHour?.remainingPercent === 96.5 &&
      q1GemFlash?.weekly?.remainingPercent === 92.4 &&
      resolveModelQuota('未记录模型', q1Configs, q1Groups) === null &&
      resolveModelQuota('Unknown Custom Model', q1Configs, q1Groups) === null,
    `Q1 Orchestrator / Gemini 内部执行模型配额解析异常：Carbon=${JSON.stringify(q1OrchCarbon)}, HydroOrch=${JSON.stringify(q1HydroOrch)}, Flash=${JSON.stringify(q1GemFlash)}`
  );

  // Q1b: Gemini 4 Neon + Orchestrator (Neon) + future Orchestrator variant must merge cleanly into Gemini pool
  const q1bNeonConfigs = [
    { label: 'Gemini 4 Neon (High)', modelId: 'gemini-4-neon-high', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M532' }, quotaInfo: { remainingFraction: 0.94, resetTime: '2026-11-19T12:00:00Z' } },
    { label: 'Gemini 4 Neon (XHigh)', modelId: 'gemini-4-neon-xhigh', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M535' }, quotaInfo: { remainingFraction: 0.94, resetTime: '2026-11-19T12:00:00Z' } },
    { label: 'Gemini 4 Neon (Medium)', modelId: 'gemini-4-neon-medium', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M533' }, quotaInfo: { remainingFraction: 0.94, resetTime: '2026-11-19T12:00:00Z' } },
    { label: 'Gemini 4 Neon (Low)', modelId: 'gemini-4-neon-low', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M534' }, quotaInfo: { remainingFraction: 0.94, resetTime: '2026-11-19T12:00:00Z' } },
    { label: 'Orchestrator (Neon)', modelId: 'gemini-pro-orchestrator-neon', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M537' }, quotaInfo: { remainingFraction: 0.94, resetTime: '2026-11-19T12:00:00Z' } },
    { label: 'Orchestrator (Future)', modelId: 'gemini-pro-orchestrator-future', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M999' }, quotaInfo: { remainingFraction: 0.94, resetTime: '2026-11-19T12:00:00Z' } },
    { label: 'Claude Opus 5.5 (High)', modelId: 'claude-opus-5-5-high', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M402' }, quotaInfo: { remainingFraction: 0.80, resetTime: '2026-11-19T12:30:00Z' } }
  ];
  const q1bPools = groupModelQuotas(q1bNeonConfigs, q1Groups);
  const q1bGemPool = q1bPools.find((p) => p.displayTitle === 'Gemini 模型');
  assert(
    q1bPools.length === 2 &&
      Boolean(q1bGemPool) &&
      q1bGemPool.modelsCount === 6 &&
      q1bGemPool.families.filter((f) => f === 'Gemini 4 Neon').length === 1 &&
      q1bGemPool.fiveHour?.remainingPercent === 96.5 &&
      q1bGemPool.weekly?.remainingPercent === 92.4,
    `Q1b Neon / Orchestrator 配额池归并异常（不应拆出孤儿池）：${JSON.stringify(q1bPools)}`
  );
  for (const [mName, expLabel] of [
    ['Gemini 4 Neon (High)', 'Gemini 4 Neon (High)'],
    ['Orchestrator (Neon)', 'Orchestrator (Neon)'],
    ['Gemini 4 Neon (Orchestrator)', 'Gemini 4 Neon (Orchestrator)'],
    ['gemini-pro-orchestrator-neon', 'Orchestrator (Neon)'],
    ['MODEL_PLACEHOLDER_M537', 'Orchestrator (Neon)']
  ]) {
    const q = resolveModelQuota(mName, q1bNeonConfigs, q1Groups);
    assert(
      q &&
        q.label === expLabel &&
        q.modelKey === 'gemini-4-neon' &&
        q.fiveHour?.remainingPercent === 96.5 &&
        q.weekly?.remainingPercent === 92.4,
      `Q1b 单模型配额解析异常 (${mName})：${JSON.stringify(q)}`
    );
  }
  const q1bStaleCacheOrch = resolveModelQuota('Orchestrator (Neon)', q1Configs, q1Groups);
  assert(
    q1bStaleCacheOrch &&
      q1bStaleCacheOrch.label === 'Orchestrator (Neon)' &&
      q1bStaleCacheOrch.modelKey === 'gemini-4-neon' &&
      q1bStaleCacheOrch.fiveHour?.remainingPercent === 96.5 &&
      q1bStaleCacheOrch.weekly?.remainingPercent === 92.4,
    `Q1b 旧宿主缓存回退单 Gemini 池异常：${JSON.stringify(q1bStaleCacheOrch)}`
  );

  // Build reusable VM harness executing actual app.js renderers (Tab 1 Context/Quota + Tab 3 Quota Pools)
  const usdConstIdx = appJsSrc.indexOf('  const USD_TO_CNY =');
  const presetsIdx = appJsSrc.indexOf('  const HEAT_PRESETS =');
  const fmtZhIdx = appJsSrc.indexOf('  function formatZh(');
  const toastIdx = appJsSrc.indexOf('  function showToast(');
  const knownPctIdx = appJsSrc.indexOf('  function isKnownPct(');
  const tab2Idx = appJsSrc.indexOf('  // TAB 2: Token History');
  const costPanelIdx = appJsSrc.indexOf('  function renderCostPanel(hist)');
  const switchTabIdx = appJsSrc.indexOf('  function switchTab(tabName)');
  assert(
    usdConstIdx > 0 && fmtZhIdx > 0 && knownPctIdx > 0 && tab2Idx > knownPctIdx && costPanelIdx > tab2Idx && switchTabIdx > costPanelIdx,
    '未定位到 app.js 渲染函数代码切片边界'
  );
  const createAppRenderHarness = () => {
    const els = new Map();
    const getEl = (id) => {
      if (!els.has(id)) {
        const classes = new Set();
        const el = {
          id,
          textContent: '',
          innerHTML: '',
          style: {},
          attrs: {},
          set className(v) {
            classes.clear();
            String(v || '').split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
          },
          get className() {
            return [...classes].join(' ');
          },
          classList: {
            add: (...names) => names.forEach((n) => classes.add(n)),
            remove: (...names) => names.forEach((n) => classes.delete(n)),
            toggle: (n, force) => {
              const next = force === undefined ? !classes.has(n) : Boolean(force);
              if (next) classes.add(n);
              else classes.delete(n);
              return next;
            },
            contains: (n) => classes.has(n)
          },
          setAttribute: (k, v) => { el.attrs[k] = String(v); }
        };
        els.set(id, el);
      }
      return els.get(id);
    };
    const vmCtx = {
      $: (id) => getEl(id),
      state: {
        selectedConvId: '',
        sourceFilter: 'all',
        costScope: 'period',
        costMode: 'hybrid',
        turnsFilter: 'all',
        contextData: null,
        historyData: null,
        ui: {}
      },
      fmtLocalTime: () => '10:00'
    };
    const combinedSrc = [
      appJsSrc.slice(usdConstIdx, presetsIdx),
      appJsSrc.slice(fmtZhIdx, toastIdx),
      appJsSrc.slice(knownPctIdx, tab2Idx),
      appJsSrc.slice(costPanelIdx, switchTabIdx)
    ].join('\n');
    runInNewContext(combinedSrc, vmCtx);
    return { vmCtx, getEl };
  };

  // Q1 UI check: renderCostPanel must hide inaccurate Prompt/Flow Credits and render semantic Gemini / Non-Gemini labels
  const q1Harness = createAppRenderHarness();
  q1Harness.vmCtx.renderCostPanel({
    planStatus: {
      status: 'identified',
      tierName: 'Google AI Ultra',
      promptCredits: { available: 500, monthly: 50000 },
      flowCredits: { available: 100, monthly: 150000 }
    },
    modelQuotas: q1Pools
  });
  const q1PlanHtml = q1Harness.getEl('plan-kv').innerHTML;
  const q1PoolsHtml = q1Harness.getEl('quota-pools-list').innerHTML;
  assert(
    !q1PlanHtml.includes('Prompt Credits') && !q1PlanHtml.includes('Flow Credits'),
    `Q1 Tab3 plan-kv 不应再显示失真的 Prompt/Flow Credits：${q1PlanHtml}`
  );
  assert(
    q1PoolsHtml.includes('Gemini 模型') &&
      q1PoolsHtml.includes('非 Gemini 模型（Claude / GPT）') &&
      q1PoolsHtml.includes('Gemini 4 Hydrogen (XHigh)'),
    `Q1 Tab3 配额池语义标题或悬浮档位明细异常：${q1PoolsHtml}`
  );
  q1Harness.vmCtx.renderSpeedCard(null, { quota: q1HydroOrch }, [], null);
  assert(
    !q1Harness.getEl('ctx-quota-box').classList.contains('hidden') &&
      q1Harness.getEl('ctx-quota-val').textContent.includes('5h 96.5%') &&
      q1Harness.getEl('ctx-quota-val').textContent.includes('周 92.4%'),
    `Q1 Tab1 内部执行模型应正常展示 5h 与周额度：${q1Harness.getEl('ctx-quota-val').textContent}`
  );
  q1Harness.vmCtx.renderSpeedCard(null, { quota: q1bStaleCacheOrch }, [], null);
  assert(
    !q1Harness.getEl('ctx-quota-box').classList.contains('hidden') &&
      q1Harness.getEl('ctx-quota-title').textContent.includes('Orchestrator (Neon)') &&
      q1Harness.getEl('ctx-quota-val').textContent.includes('5h 96.5%') &&
      q1Harness.getEl('ctx-quota-val').textContent.includes('周 92.4%'),
    `Q1b Tab1 Neon 回退单 Gemini 池应正常展示 5h 与周额度：${q1Harness.getEl('ctx-quota-title').textContent} / ${q1Harness.getEl('ctx-quota-val').textContent}`
  );

  // T1: Exhaustive quota semantics matrix (5h+weekly, 5h-only, weekly-only, resetTime-only, all-missing, genuine 0%)
  const t1Configs = [
    { label: 'Model Both', modelId: 'T1_BOTH', quotaInfo: { poolId: 'p-both', remainingFraction: 0.8 } },
    { label: 'Model 5hOnly', modelId: 'T1_5H', quotaInfo: { poolId: 'p-5h' } },
    { label: 'Model WeekOnly', modelId: 'T1_WK', quotaInfo: { poolId: 'p-wk' } },
    { label: 'Model ResetOnly', modelId: 'T1_RST', quotaInfo: { poolId: 'p-rst', resetTime: '2026-11-12T16:00:00Z' } },
    { label: 'Model Missing', modelId: 'T1_MISS', quotaInfo: null },
    { label: 'Model Zero', modelId: 'T1_ZERO', quotaInfo: { poolId: 'p-zero', remainingFraction: 0, resetTime: '2026-11-12T15:00:00Z' } }
  ];
  const t1Groups = [
    {
      groupId: 'p-both',
      modelIds: ['T1_BOTH'],
      buckets: [
        { window: '5h', remainingFraction: 0.8, resetTime: '2026-11-12T15:00:00Z' },
        { window: 'weekly', remainingFraction: 0.2, resetTime: '2026-11-15T00:00:00Z' }
      ]
    },
    {
      groupId: 'p-5h',
      modelIds: ['T1_5H'],
      buckets: [{ window: '5h', remainingFraction: 0.65, resetTime: '2026-11-12T15:00:00Z' }]
    },
    {
      groupId: 'p-wk',
      modelIds: ['T1_WK'],
      buckets: [{ window: 'weekly', remainingFraction: 0.2, resetTime: '2026-11-15T00:00:00Z' }]
    },
    {
      groupId: 'p-rst',
      modelIds: ['T1_RST'],
      buckets: [{ window: '5h', resetTime: '2026-11-12T16:00:00Z' }]
    }
  ];
  const t1Pools = groupModelQuotas(t1Configs, t1Groups);
  const findT1Pool = (lbl) => t1Pools.find((p) => p.families.includes(lbl));
  assert(
    findT1Pool('Model Both')?.fiveHour?.remainingPercent === 80 &&
      findT1Pool('Model Both')?.weekly?.remainingPercent === 20,
    'T1 双窗口 (5h + weekly) 解析异常'
  );
  assert(
    findT1Pool('Model 5hOnly')?.fiveHour?.remainingPercent === 65 &&
      findT1Pool('Model 5hOnly')?.weekly === null,
    'T1 独立 5h 窗口解析异常'
  );
  const t1WkPool = findT1Pool('Model WeekOnly');
  const t1WkModelQ = resolveModelQuota('Model WeekOnly', t1Configs, t1Groups);
  assert(
    t1WkPool?.fiveHour === null &&
      t1WkPool?.remainingPercent === null &&
      t1WkPool?.weekly?.remainingPercent === 20 &&
      t1WkModelQ?.remainingPercent === null &&
      t1WkModelQ?.weekly?.remainingPercent === 20,
    `T1 仅含 weekly 窗口不应伪造 5h 或丢失周配额：${JSON.stringify(t1WkPool)}`
  );
  const t1RstPool = findT1Pool('Model ResetOnly');
  assert(
    t1RstPool?.remainingPercent === null &&
      t1RstPool?.fiveHour?.remainingPercent === null &&
      Boolean(t1RstPool?.fiveHour?.resetTimeZh),
    'T1 仅含 resetTime 时 remainingPercent 应保持 null 且保留重置时间'
  );
  assert(findT1Pool('Model Missing')?.remainingPercent === null, 'T1 全缺失配额应保持 null');
  assert(findT1Pool('Model Zero')?.remainingPercent === 0, 'T1 真实 0% 配额不得误判为缺失');

  const t1Harness = createAppRenderHarness();
  // T1 UI check 1: weekly-only pool + active model must show 20.0% Week and NEVER render 100.0%
  t1Harness.vmCtx.renderCostPanel({ planStatus: { status: 'identified', tierName: 'Pro' }, modelQuotas: [t1WkPool] });
  const wkListHtml = t1Harness.getEl('quota-pools-list').innerHTML;
  assert(
    wkListHtml.includes('Week') && wkListHtml.includes('20.0%') && !wkListHtml.includes('100.0%'),
    `T1 Tab3 仅 weekly 配额池未显示 20.0% 或误回退为 100.0%：${wkListHtml}`
  );
  t1Harness.vmCtx.renderSpeedCard(null, { quota: t1WkModelQ }, [], null);
  assert(
    !t1Harness.getEl('ctx-quota-box').classList.contains('hidden') &&
      t1Harness.getEl('ctx-quota-val').textContent.includes('周 20.0%') &&
      t1Harness.getEl('ctx-quota-bar').style.width === '20%',
    `T1 Tab1 仅 weekly 当前模型配额被隐藏或渲染异常：${t1Harness.getEl('ctx-quota-val').textContent}`
  );

  // T1 UI check 2: resetTime-only & all-missing must render "余量未知" with width 0%, NEVER 100.0% or 0.0%
  t1Harness.vmCtx.renderCostPanel({
    planStatus: { status: 'identified', tierName: 'Pro' },
    modelQuotas: [t1RstPool, findT1Pool('Model Missing')]
  });
  const unknownListHtml = t1Harness.getEl('quota-pools-list').innerHTML;
  assert(
    unknownListHtml.includes('余量未知') &&
      unknownListHtml.includes('width:0%') &&
      !unknownListHtml.includes('100.0%') &&
      !unknownListHtml.includes('0.0%'),
    `T1 未知配额误渲染为 100.0% 或 0.0%：${unknownListHtml}`
  );
  const t1MissModelQ = resolveModelQuota('Model Missing', t1Configs, t1Groups);
  t1Harness.vmCtx.renderSpeedCard(null, { quota: t1MissModelQ }, [], null);
  assert(
    !t1Harness.getEl('ctx-quota-box').classList.contains('hidden') &&
      t1Harness.getEl('ctx-quota-val').textContent.includes('余量未知') &&
      t1Harness.getEl('ctx-quota-bar').style.width === '0%',
    `T1 Tab1 缺失配额未显示余量未知：${t1Harness.getEl('ctx-quota-val').textContent}`
  );

  // T1 UI check 3: genuine 0% must render 0.0% with danger color
  t1Harness.vmCtx.renderCostPanel({
    planStatus: { status: 'identified', tierName: 'Pro' },
    modelQuotas: [findT1Pool('Model Zero')]
  });
  const zeroListHtml = t1Harness.getEl('quota-pools-list').innerHTML;
  assert(
    zeroListHtml.includes('0.0%') && zeroListHtml.includes('var(--danger)'),
    `T1 真实 0% 配额未渲染为 0.0% 告警态：${zeroListHtml}`
  );

  // U3: Base quota known (40% or 0%) + reset-only 5h summary bucket must NOT mask known base quota
  const u3FiveReset = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  const u3Configs = [
    {
      label: 'U3 Base 40 Reset5h',
      modelId: 'U3_BASE_40',
      quotaInfo: { poolId: 'u3-p-40', remainingFraction: 0.4, resetTime: u3FiveReset }
    },
    {
      label: 'U3 Base 0 Reset5h',
      modelId: 'U3_BASE_0',
      quotaInfo: { poolId: 'u3-p-0', remainingFraction: 0, resetTime: u3FiveReset }
    },
    {
      label: 'U3 Explicit 5h 80',
      modelId: 'U3_EXP_80',
      quotaInfo: { poolId: 'u3-p-80', remainingFraction: 0.4, resetTime: u3FiveReset }
    }
  ];
  const u3Groups = [
    { groupId: 'u3-p-40', modelIds: ['U3_BASE_40'], buckets: [{ window: '5h', resetTime: u3FiveReset }] },
    { groupId: 'u3-p-0', modelIds: ['U3_BASE_0'], buckets: [{ window: '5h', resetTime: u3FiveReset }] },
    { groupId: 'u3-p-80', modelIds: ['U3_EXP_80'], buckets: [{ window: '5h', remainingFraction: 0.8, resetTime: u3FiveReset }] }
  ];
  const u3Pools = groupModelQuotas(u3Configs, u3Groups);
  const findU3Pool = (lbl) => u3Pools.find((p) => p.families.includes(lbl));
  const u3Base40Pool = findU3Pool('U3 Base 40 Reset5h');
  const u3Base0Pool = findU3Pool('U3 Base 0 Reset5h');
  const u3Exp80Pool = findU3Pool('U3 Explicit 5h 80');
  const u3Base40ModelQ = resolveModelQuota('U3 Base 40 Reset5h', u3Configs, u3Groups);
  const u3Base0ModelQ = resolveModelQuota('U3 Base 0 Reset5h', u3Configs, u3Groups);
  const u3Exp80ModelQ = resolveModelQuota('U3 Explicit 5h 80', u3Configs, u3Groups);
  assert(
    u3Base40Pool?.baseRemainingPercent === 40 &&
      u3Base40Pool?.fiveHour?.remainingPercent === null &&
      u3Base0Pool?.baseRemainingPercent === 0 &&
      u3Base0Pool?.fiveHour?.remainingPercent === null &&
      u3Exp80Pool?.remainingPercent === 80 &&
      u3Exp80Pool?.fiveHour?.remainingPercent === 80 &&
      u3Base40ModelQ?.baseRemainingPercent === 40 &&
      u3Base0ModelQ?.baseRemainingPercent === 0 &&
      u3Exp80ModelQ?.fiveHour?.remainingPercent === 80,
    `U3 基础配额 + 重置时间摘要解析异常：40=${JSON.stringify(u3Base40Pool)}, 0=${JSON.stringify(u3Base0Pool)}`
  );
  t1Harness.vmCtx.renderCostPanel({
    planStatus: { status: 'identified', tierName: 'Pro' },
    modelQuotas: [u3Base40Pool, u3Base0Pool, u3Exp80Pool]
  });
  const u3CostHtml = t1Harness.getEl('quota-pools-list').innerHTML;
  assert(
    u3CostHtml.includes('基础配额窗口') &&
      u3CostHtml.includes('40.0%') &&
      u3CostHtml.includes('0.0%') &&
      u3CostHtml.includes('80.0%') &&
      u3CostHtml.includes('var(--danger)'),
    `U3 Tab3 基础配额未在仅含重置时间摘要时保留展示：${u3CostHtml}`
  );
  t1Harness.vmCtx.renderSpeedCard(null, { quota: u3Base40ModelQ }, [], null);
  assert(
    t1Harness.getEl('ctx-quota-val').textContent.includes('基础 40.0%') &&
      t1Harness.getEl('ctx-quota-bar').style.width === '40%',
    `U3 Tab1 基础 40% + reset-only 5h 显示异常：${t1Harness.getEl('ctx-quota-val').textContent}`
  );
  t1Harness.vmCtx.renderSpeedCard(null, { quota: u3Base0ModelQ }, [], null);
  assert(
    t1Harness.getEl('ctx-quota-val').textContent.includes('基础 0.0%') &&
      t1Harness.getEl('ctx-quota-bar').style.width === '0%',
    `U3 Tab1 基础 0% + reset-only 5h 显示异常：${t1Harness.getEl('ctx-quota-val').textContent}`
  );
  t1Harness.vmCtx.renderSpeedCard(null, { quota: u3Exp80ModelQ }, [], null);
  assert(
    t1Harness.getEl('ctx-quota-val').textContent.includes('5h 80.0%') &&
      !t1Harness.getEl('ctx-quota-val').textContent.includes('基础 40.0%'),
    `U3 Tab1 显式 5h 摘要应优先于基础配额：${t1Harness.getEl('ctx-quota-val').textContent}`
  );

  console.log('[verify] 5/6 执行隔离采集器回归测试（R3/T2 配额状态机与 ETag / R5 离线计费 / R6 版本号 / R8 中文路径 / F1-F2 / T3 预算上限）...');
  const tmpVerifyRoot = mkdtempSync(join(tmpdir(), 'ag-cv-verify-'));
  const savedEnv = {
    AG_DIR: process.env.AG_DIR,
    AG_CLI_DIR: process.env.AG_CLI_DIR,
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR,
    ANTIGRAVITY_LS_ADDRESS: process.env.ANTIGRAVITY_LS_ADDRESS,
    ANTIGRAVITY_CSRF_TOKEN: process.env.ANTIGRAVITY_CSRF_TOKEN
  };

  try {
    const isolatedAgDir = join(tmpVerifyRoot, 'ag-desktop');
    const isolatedCliDir = join(tmpVerifyRoot, 'ag-cli');
    const isolatedStateDir = join(tmpVerifyRoot, 'sidecar-data');
    mkdirSync(isolatedAgDir, { recursive: true });
    mkdirSync(isolatedCliDir, { recursive: true });
    mkdirSync(isolatedStateDir, { recursive: true });

    process.env.AG_DIR = isolatedAgDir;
    process.env.AG_CLI_DIR = isolatedCliDir;
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = isolatedStateDir;
    delete process.env.ANTIGRAVITY_LS_ADDRESS;
    delete process.env.ANTIGRAVITY_CSRF_TOKEN;

    const {
      ackAuxPaneTrigger,
      collectTokenHistory,
      DEFAULT_SHORTCUT_MAC,
      DEFAULT_SHORTCUT_OTHER,
      formatShortcutDisplay,
      getAuxShortcutConfig,
      getDefaultShortcut,
      getShortcutConfig,
      listRecentConversations,
      markAuxPaneOpening,
      normalizeShortcutSpec,
      parseModelSettingFromText,
      readAuxPaneTrigger,
      recordAuxActiveConversation,
      resolveDesktopForegroundConversationId,
      scanConversation,
      setAuxShortcutConfig,
      setMenubarPreference,
      setShortcutConfig,
      shortcutToMacCarbon,
      writeAuxPaneTrigger
    } = await import(join(ROOT, 'sidecars', 'dashboard', 'collector.mjs'));

    // R6: Model version decimals, parentheses & multi-switch sequences
    assert(
      parseModelSettingFromText('Model Selection from Gemini 4 Carbon to Gemini 3.8 Flash.') === 'Gemini 3.8 Flash',
      'R6 Gemini 3.8 Flash 小数点被截断'
    );
    assert(
      parseModelSettingFromText('Model Selection from Claude Sonnet 5.5 to Gemini 3.1 Pro (High). No need to comment on the model change.') === 'Gemini 3.1 Pro (High)',
      'R6 Gemini 3.1 Pro (High) 解析异常'
    );
    assert(
      parseModelSettingFromText(
        'Model Selection from Gemini 2.5 Pro to Claude Sonnet 5.5.\nLater: Model Selection from Claude Sonnet 5.5 to Claude Opus 5.5.'
      ) === 'Claude Opus 5.5',
      'R6 多次模型切换未保留最后一次完整名称'
    );

    // R5: Offline transcript with per-step `model` field and no "Model Selection" text
    const convId = 'a1b2c3d4e5f60001';
    const logDir = join(isolatedAgDir, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logDir, { recursive: true });
    const transcriptLines = [
      JSON.stringify({
        step_index: 1,
        type: 'USER_INPUT',
        created_at: '2026-11-12T08:00:00Z',
        content: 'Verify offline model attribution'
      }),
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-12T08:00:04Z',
        model: 'Gemini 4 Carbon',
        content: 'First answer',
        input_tokens: 1000,
        output_tokens: 100,
        cache_read_tokens: 200
      }),
      JSON.stringify({
        step_index: 3,
        type: 'USER_INPUT',
        created_at: '2026-11-12T08:05:00Z',
        content: 'Switch model on turn 2'
      }),
      JSON.stringify({
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-12T08:05:03Z',
        model: 'Gemini 3.8 Flash',
        content: 'Second answer',
        usage: { inputTokens: 2000, outputTokens: 200, cacheReadTokens: 0 }
      })
    ];
    writeFileSync(join(logDir, 'transcript.jsonl'), `${transcriptLines.join('\n')}\n`, 'utf-8');

    const offlineCtx = await scanConversation(convId, { force: true });
    const offlineHist = await collectTokenHistory({ force: true });
    assert(offlineCtx.context?.modelKey === 'gemini-3.8-flash', `R5 当前会话最新模型识别异常：${offlineCtx.context?.modelKey}`);
    const turn1 = offlineCtx.turns.find((t) => t.turnIndex === 1);
    const turn2 = offlineCtx.turns.find((t) => t.turnIndex === 2);
    assert(turn1?.modelKey === 'gemini-4-carbon' && turn1?.isPriced && turn1.costUSD > 0, 'R5 第 1 轮离线模型计费缺失');
    assert(turn2?.modelKey === 'gemini-3.8-flash' && turn2?.isPriced && turn2.costUSD > 0, 'R5 第 2 轮切换后离线模型计费缺失');
    const sessionIdentifiedUSD = Number(offlineCtx.context?.sessionCostUSD || 0);
    const histIdentifiedUSD = Number(offlineHist.analyticsBySource?.all?.costs?.allTime?.identified?.pricedCostUSD || 0);
    assert(
      sessionIdentifiedUSD > 0 &&
        Math.abs(sessionIdentifiedUSD - histIdentifiedUSD) < 1e-6,
      `R5 会话费用 (${sessionIdentifiedUSD}) 与全局历史费用 (${histIdentifiedUSD}) 不一致`
    );

    // F2: Generalized usage steps (e.g. MODEL_RESPONSE) must not double-count into pendingTokens
    const f2ConvId = 'f2b2c3d4e5f60002';
    const f2LogDir = join(isolatedAgDir, 'brain', f2ConvId, '.system_generated', 'logs');
    mkdirSync(f2LogDir, { recursive: true });
    const f2BaseLines = [
      JSON.stringify({
        step_index: 1,
        type: 'USER_INPUT',
        created_at: '2026-11-12T09:00:00Z',
        content: 'Hello'
      }),
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-12T09:00:02Z',
        model: 'Gemini 4 Carbon',
        input_tokens: 100,
        output_tokens: 10,
        content: 'Hi'
      }),
      JSON.stringify({
        step_index: 3,
        type: 'USER_INPUT',
        created_at: '2026-11-12T09:01:00Z',
        content: 'a'.repeat(400)
      }),
      JSON.stringify({
        step_index: 4,
        type: 'MODEL_RESPONSE',
        created_at: '2026-11-12T09:01:05Z',
        model: 'Gemini 3.8 Flash',
        usage: { inputTokens: 1000, outputTokens: 100 },
        content: 'b'.repeat(400)
      })
    ];
    writeFileSync(join(f2LogDir, 'transcript.jsonl'), `${f2BaseLines.join('\n')}\n`, 'utf-8');
    const f2DoneCtx = await scanConversation(f2ConvId, { force: true });
    assert(f2DoneCtx.turns.length === 2, `F2 泛化 usage 步骤未生成第 2 轮 turn，实际 ${f2DoneCtx.turns.length}`);
    assert(
      f2DoneCtx.context?.actual === 1100 &&
        f2DoneCtx.context?.pendingTokens === 0 &&
        f2DoneCtx.context?.pendingStepsCount === 0 &&
        f2DoneCtx.context?.used === 1100,
      `F2 已完成泛化 usage 轮次被重复计入 pendingTokens：actual=${f2DoneCtx.context?.actual}, pending=${f2DoneCtx.context?.pendingTokens}, used=${f2DoneCtx.context?.used}`
    );
    const f2RecentItem = listRecentConversations(24).find((c) => c.id === f2ConvId);
    assert(
      f2RecentItem?.turnsCount === 2 && f2RecentItem?.lastContextTokens === 1100,
      `F2 listRecentConversations 未同步泛化 usage 轮次：turns=${f2RecentItem?.turnsCount}, last=${f2RecentItem?.lastContextTokens}`
    );

    // F2b: Real unsent USER_INPUT after last turn must count in pendingTokens while ERROR_MESSAGE is excluded,
    // and switching to an unlisted model must clear currentModelKey to null instead of inheriting previous turn's key.
    const f2AppendedLines = [
      ...f2BaseLines,
      JSON.stringify({
        step_index: 5,
        type: 'USER_INPUT',
        created_at: '2026-11-12T09:02:00Z',
        content: `${'c'.repeat(200)}\nModel Selection from Gemini 3.8 Flash to Unlisted Experimental Model.`
      }),
      JSON.stringify({
        step_index: 6,
        type: 'ERROR_MESSAGE',
        created_at: '2026-11-12T09:02:01Z',
        content: 'd'.repeat(400)
      })
    ];
    writeFileSync(join(f2LogDir, 'transcript.jsonl'), `${f2AppendedLines.join('\n')}\n`, 'utf-8');
    const f2PendingCtx = await scanConversation(f2ConvId, { force: true });
    assert(
      f2PendingCtx.context?.pendingStepsCount === 1 &&
        f2PendingCtx.context?.pendingTokens > 0 &&
        f2PendingCtx.context?.used === 1100 + f2PendingCtx.context.pendingTokens,
      `F2 未发送 USER_INPUT 与 ERROR_MESSAGE 过滤计算异常：steps=${f2PendingCtx.context?.pendingStepsCount}, pending=${f2PendingCtx.context?.pendingTokens}`
    );
    assert(
      f2PendingCtx.context?.model === 'Unlisted Experimental Model' && f2PendingCtx.context?.modelKey === null,
      `F2 切换未知模型后残留旧 modelKey：model=${f2PendingCtx.context?.model}, key=${f2PendingCtx.context?.modelKey}`
    );
    rmSync(join(isolatedAgDir, 'brain', f2ConvId), { recursive: true, force: true });

    // R3: Mock Language Server quota mutation must invalidate ETag; unchanged poll must keep ETag stable
    let mockRemainingFraction = 0.9;
    const mockLsServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (req.url?.includes('GetUserStatus')) {
        res.end(JSON.stringify({
          userStatus: {
            userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
            cascadeModelConfigData: {
              clientModelConfigs: [
                {
                  label: 'Gemini 4 Carbon',
                  modelOrAlias: { model: 'MODEL_PLACEHOLDER_M400' },
                  quotaInfo: { poolId: 'g-carbon', remainingFraction: 0.8, resetTime: '2026-11-12T14:00:00Z' }
                },
                {
                  label: 'Gemini 3.8 Flash',
                  modelOrAlias: { model: 'MODEL_PLACEHOLDER_M318' },
                  quotaInfo: { poolId: 'g-flash', remainingFraction: mockRemainingFraction, resetTime: '2026-11-12T14:00:00Z' }
                }
              ]
            }
          }
        }));
        return;
      }
      if (req.url?.includes('RetrieveUserQuotaSummary')) {
        res.end(JSON.stringify({
          groups: [
            {
              groupId: 'g-carbon',
              displayName: 'Gemini Group A',
              modelIds: ['MODEL_PLACEHOLDER_M400'],
              buckets: [{ bucketId: 'g-carbon-5h', window: '5h', remainingFraction: 0.8, resetTime: '2026-11-12T14:00:00Z' }]
            },
            {
              groupId: 'g-flash',
              displayName: 'Gemini Group B',
              modelIds: ['MODEL_PLACEHOLDER_M318'],
              buckets: [{ bucketId: 'g-flash-5h', window: '5h', remainingFraction: mockRemainingFraction, resetTime: '2026-11-12T14:00:00Z' }]
            }
          ]
        }));
        return;
      }
      res.end('{}');
    });
    await new Promise((r) => mockLsServer.listen(0, '127.0.0.1', r));
    try {
      process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${mockLsServer.address().port}`;
      process.env.ANTIGRAVITY_CSRF_TOKEN = 'mock-ls-csrf';

      const c90 = await scanConversation(convId, { force: true });
      const h90 = await collectTokenHistory({ force: true });
      const flashPool90 = c90.quotas?.find((p) => p.families.includes('Gemini 3.8 Flash'));
      const histFlashPool90 = h90.modelQuotas?.find((p) => p.families.includes('Gemini 3.8 Flash'));
      assert(
        c90.quotas?.length === 2 &&
          flashPool90?.remainingPercent === 90 &&
          histFlashPool90?.remainingPercent === 90 &&
          c90.context?.quota?.remainingPercent === 90,
        'R3/F1 初始 90% Flash 配额池未精确命中'
      );

      const c90Repeat = await scanConversation(convId, { force: true });
      const h90Repeat = await collectTokenHistory({ force: true });
      assert(c90Repeat.etag === c90.etag && h90Repeat.etag === h90.etag, 'R3 数据未变化时 ETag 不应随扫描时间抖动');

      mockRemainingFraction = 0.2;
      const c20 = await scanConversation(convId, { force: true });
      const h20 = await collectTokenHistory({ force: true });
      const flashPool20 = c20.quotas?.find((p) => p.families.includes('Gemini 3.8 Flash'));
      const carbonPool80 = c20.quotas?.find((p) => p.families.includes('Gemini 4 Carbon'));
      const histFlashPool20 = h20.modelQuotas?.find((p) => p.families.includes('Gemini 3.8 Flash'));
      assert(
        carbonPool80?.remainingPercent === 80 &&
          flashPool20?.remainingPercent === 20 &&
          histFlashPool20?.remainingPercent === 20 &&
          c20.context?.quota?.remainingPercent === 20,
        `R3/F1 更新后 Carbon(80%)/Flash(20%) 双池与当前会话配额未同步：ctxQuota=${c20.context?.quota?.remainingPercent}`
      );
      assert(c20.etag !== c90.etag, 'R3 会话配额 90% -> 20% 变化后 context ETag 未更新');
      assert(h20.etag !== h90.etag, 'R3 历史配额 90% -> 20% 变化后 history ETag 未更新');
      var f1LiveSnap20 = c20;
    } finally {
      delete process.env.ANTIGRAVITY_LS_ADDRESS;
      delete process.env.ANTIGRAVITY_CSRF_TOKEN;
      await new Promise((r) => mockLsServer.close(r));
    }

    // T2: Language Server failure / partial degradation / continued outage / recovery state machine & ETag
    let t2Mode = 'error'; // 'error' -> 'live' -> 'summary-fail' -> 'error' -> 'live'
    let t2ResetIso = '2026-11-12T14:00:00Z';
    const t2LsServer = http.createServer((req, res) => {
      if (t2Mode === 'error') {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end('{"error":"ls unavailable"}');
        return;
      }
      if (req.url?.includes('GetUserStatus')) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          userStatus: {
            userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
            cascadeModelConfigData: {
              clientModelConfigs: [
                {
                  label: 'Gemini 3.8 Flash',
                  modelOrAlias: { model: 'MODEL_PLACEHOLDER_M318' },
                  quotaInfo: { poolId: 'g-flash', remainingFraction: 0.8, resetTime: t2ResetIso }
                }
              ]
            }
          }
        }));
        return;
      }
      if (req.url?.includes('RetrieveUserQuotaSummary')) {
        if (t2Mode === 'summary-fail') {
          res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end('{"error":"summary unavailable"}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          groups: [
            {
              groupId: 'g-flash',
              displayName: 'Gemini Flash Pool',
              modelIds: ['MODEL_PLACEHOLDER_M318'],
              buckets: [
                { bucketId: 'g-flash-5h', window: '5h', remainingFraction: 0.8, resetTime: t2ResetIso },
                { bucketId: 'g-flash-wk', window: 'weekly', remainingFraction: 0.6, resetTime: '2026-11-16T00:00:00Z' }
              ]
            }
          ]
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{}');
    });
    await new Promise((r) => t2LsServer.listen(0, '127.0.0.1', r));
    try {
      process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${t2LsServer.address().port}`;
      process.env.ANTIGRAVITY_CSRF_TOKEN = 't2-ls-csrf';

      // 1) Cold-start failure before any good snapshot -> error state, empty quotas
      const cColdErr = await scanConversation(convId, { force: true });
      const hColdErr = await collectTokenHistory({ force: true });
      assert(
        cColdErr.quotaStatus?.state === 'error' &&
          cColdErr.quotaStatus?.stale === false &&
          cColdErr.quotaStatus?.lastSuccessAt === null &&
          cColdErr.quotas?.length === 0 &&
          hColdErr.quotaStatus?.state === 'error',
        `T2 冷启动 LS 失败状态异常：${JSON.stringify(cColdErr.quotaStatus)}`
      );

      // 2) Healthy live sync -> state 'live', ETag changes from cold error, repeat poll keeps ETag stable
      t2Mode = 'live';
      const cLive1 = await scanConversation(convId, { force: true });
      const hLive1 = await collectTokenHistory({ force: true });
      assert(
        cLive1.quotaStatus?.state === 'live' &&
          cLive1.quotaStatus?.stale === false &&
          cLive1.quotaStatus?.summaryStale === false &&
          Boolean(cLive1.quotaStatus?.lastSuccessAt) &&
          cLive1.etag !== cColdErr.etag &&
          hLive1.etag !== hColdErr.etag,
        `T2 恢复 live 后状态或 ETag 异常：${JSON.stringify(cLive1.quotaStatus)}`
      );
      const cLive2 = await scanConversation(convId, { force: true });
      const hLive2 = await collectTokenHistory({ force: true });
      assert(
        cLive2.etag === cLive1.etag && hLive2.etag === hLive1.etag,
        'T2 无业务与状态变化时重复轮询不应因当前时间抖动 ETag'
      );

      // 3) Partial failure (RetrieveUserQuotaSummary 503, GetUserStatus 200) -> state 'degraded', ETag updates
      t2Mode = 'summary-fail';
      const cDeg = await scanConversation(convId, { force: true });
      const hDeg = await collectTokenHistory({ force: true });
      assert(
        cDeg.quotaStatus?.state === 'degraded' &&
          cDeg.quotaStatus?.summaryStale === true &&
          cDeg.quotaStatus?.stale === false &&
          cDeg.etag !== cLive2.etag &&
          hDeg.etag !== hLive2.etag,
        `T2 单接口失败未进入 degraded 或未更新 ETag：${JSON.stringify(cDeg.quotaStatus)}`
      );

      // Re-establish clean full live snapshot before testing full outage retention
      t2Mode = 'live';
      const cPreOutage = await scanConversation(convId, { force: true });
      const hPreOutage = await collectTokenHistory({ force: true });
      const preOutageTs = hPreOutage.quotaStatus?.lastSuccessAt;
      assert(Boolean(preOutageTs), 'T2 故障前成功时间缺失');

      // 4) Full outage (both endpoints 503) -> retains cached quota as reference, marks stale:true, preserves lastSuccessAt, updates ETag
      t2Mode = 'error';
      await new Promise((r) => setTimeout(r, 15));
      const cStale1 = await scanConversation(convId, { force: true });
      const hStale1 = await collectTokenHistory({ force: true });
      assert(
        cStale1.quotaStatus?.state === 'stale' &&
          cStale1.quotaStatus?.stale === true &&
          cStale1.quotaStatus?.source === 'cache' &&
          cStale1.quotaStatus?.lastSuccessAt === preOutageTs &&
          cStale1.quotas?.[0]?.remainingPercent === 80 &&
          cStale1.etag !== cPreOutage.etag &&
          hStale1.etag !== hPreOutage.etag,
        `T2 全接口失败未标记 stale 或未保留上次成功时间与缓存额度：${JSON.stringify(cStale1.quotaStatus)}`
      );

      // 5) Continued outage -> preserves original lastSuccessAt and keeps stale ETag stable
      await new Promise((r) => setTimeout(r, 15));
      const cStale2 = await scanConversation(convId, { force: true });
      const hStale2 = await collectTokenHistory({ force: true });
      assert(
        cStale2.quotaStatus?.lastSuccessAt === preOutageTs &&
          cStale2.etag === cStale1.etag &&
          hStale2.etag === hStale1.etag,
        'T2 持续故障期间不应覆盖上次成功时间或抖动 ETag'
      );

      // Verify UI stale & recovery rendering via app.js VM harness
      const t2Harness = createAppRenderHarness();
      t2Harness.vmCtx.renderCostPanel(hStale1);
      assert(
        !t2Harness.getEl('quota-sync-pill').classList.contains('hidden') &&
          t2Harness.getEl('quota-sync-pill').textContent.includes('缓存快照') &&
          t2Harness.getEl('plan-kv').innerHTML.includes('展示上次缓存'),
        `T2 Tab3 未渲染过期缓存提示：${t2Harness.getEl('quota-sync-pill').textContent}`
      );
      t2Harness.vmCtx.renderSpeedCard(cStale1.speed, cStale1.context, [], cStale1.quotaStatus);
      assert(
        t2Harness.getEl('ctx-quota-title').textContent.includes('缓存'),
        `T2 Tab1 未渲染配额缓存标识：${t2Harness.getEl('ctx-quota-title').textContent}`
      );

      // 6) Recovery -> clears stale, advances lastSuccessAt, updates ETag, hides UI stale pill
      await new Promise((r) => setTimeout(r, 15));
      t2Mode = 'live';
      const cRecov = await scanConversation(convId, { force: true });
      const hRecov = await collectTokenHistory({ force: true });
      assert(
        cRecov.quotaStatus?.state === 'live' &&
          cRecov.quotaStatus?.stale === false &&
          Date.parse(cRecov.quotaStatus.lastSuccessAt) > Date.parse(preOutageTs) &&
          cRecov.etag !== cStale1.etag &&
          hRecov.etag !== hStale1.etag,
        `T2 服务恢复后未清除 stale 或未更新成功时间：${JSON.stringify(cRecov.quotaStatus)}`
      );
      t2Harness.vmCtx.renderCostPanel(hRecov);
      assert(
        t2Harness.getEl('quota-sync-pill').classList.contains('hidden'),
        'T2 服务恢复后未隐藏过期提示标签'
      );

      // 7) Outage crossing quota reset boundary must clear expired cached quotas while keeping plan
      const resetBaseMs = Date.now();
      t2ResetIso = new Date(resetBaseMs + 60_000).toISOString();
      t2Mode = 'live';
      const cBeforeReset = await scanConversation(convId, { force: true, nowMs: resetBaseMs });
      assert(cBeforeReset.quotas?.length === 1, 'T2 重置边界测试前应先建立有效配额缓存');
      t2Mode = 'error';
      const cStalePreReset = await scanConversation(convId, { force: true, nowMs: resetBaseMs + 10_000 });
      assert(
        cStalePreReset.quotaStatus?.state === 'stale' && cStalePreReset.quotas?.length === 1,
        'T2 未跨过重置边界前断连应保留缓存配额'
      );
      const cCrossedReset = await scanConversation(convId, { force: true, nowMs: resetBaseMs + 120_000 });
      const hCrossedReset = await collectTokenHistory({ force: true, nowMs: resetBaseMs + 120_000 });
      assert(
        cCrossedReset.quotaStatus?.state === 'error' &&
          cCrossedReset.quotas?.length === 0 &&
          hCrossedReset.quotaStatus?.state === 'error' &&
          hCrossedReset.modelQuotas?.length === 0 &&
          hCrossedReset.planStatus?.tierKey === 'pro' &&
          hCrossedReset.quotaStatus?.reason?.includes('重置时间'),
        `T2 跨过重置时间后断连不应继续展示过期配额：${JSON.stringify(hCrossedReset.quotaStatus)}`
      );
      await new Promise((r) => t2LsServer.close(r));
      const hDeadHost = await collectTokenHistory({ force: true, nowMs: resetBaseMs + 120_000 });
      assert(
        hDeadHost.quotaStatus?.state === 'error' &&
          (hDeadHost.quotaStatus?.errorCode === 'ECONNREFUSED' || hDeadHost.quotaStatus?.errorCode === 'ECONNRESET') &&
          hDeadHost.modelQuotas?.length === 0 &&
          hDeadHost.quotaStatus?.reason?.includes('原宿主语言服务已退出'),
        `T2 原宿主退出 (ECONNREFUSED/ECONNRESET) 提示异常：${JSON.stringify(hDeadHost.quotaStatus)}`
      );
    } finally {
      delete process.env.ANTIGRAVITY_LS_ADDRESS;
      delete process.env.ANTIGRAVITY_CSRF_TOKEN;
      if (t2LsServer.listening) {
        await new Promise((r) => t2LsServer.close(r));
      }
    }

    // T3: Unknown model context window budget vs user benchmark vs server maxContextTokens
    const t3ConvId = 'f3c3d4e5f6a70003';
    const t3LogDir = join(isolatedAgDir, 'brain', t3ConvId, '.system_generated', 'logs');
    mkdirSync(t3LogDir, { recursive: true });
    writeFileSync(
      join(t3LogDir, 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 1,
          type: 'USER_INPUT',
          created_at: '2026-11-12T10:00:00Z',
          content: 'Check unknown model window capacity'
        }),
        JSON.stringify({
          step_index: 2,
          type: 'MODEL_RESPONSE',
          created_at: '2026-11-12T10:00:05Z',
          model: 'Unknown Review Model',
          usage: { inputTokens: 100000, outputTokens: 1000 },
          content: 'Completed turn without maxContextTokens'
        })
      ].join('\n') + '\n',
      'utf-8'
    );

    // T3a: Offline / no server maxContextTokens -> used=101000 preserved, budget/remaining/percent are null (NEVER 256000)
    const t3Offline = await scanConversation(t3ConvId, { force: true });
    assert(
      t3Offline.context?.used === 101000 &&
        t3Offline.context?.budget === null &&
        t3Offline.context?.budgetSource === 'unknown' &&
        t3Offline.context?.remaining === null &&
        t3Offline.context?.percent === null,
      `T3 无服务端容量依据时不应硬编码 256000：${JSON.stringify(t3Offline.context)}`
    );
    const t3Harness = createAppRenderHarness();
    t3Harness.vmCtx.state.contextData = t3Offline;
    t3Harness.vmCtx.renderTopCapsules();
    t3Harness.vmCtx.renderContextPanel(t3Offline);
    assert(
      t3Harness.getEl('ctx-used').textContent === '101.0K' &&
        t3Harness.getEl('ctx-budget').textContent === '未知' &&
        t3Harness.getEl('ctx-budget-chip').textContent === '上限未记录' &&
        t3Harness.getEl('ctx-session-cache').textContent === '0.0%' &&
        t3Harness.getEl('ctx-pct-big').textContent === '--%' &&
        t3Harness.getEl('ctx-health-pill').textContent === '容量未知' &&
        !t3Harness.getEl('ctx-takeaway').textContent.includes('窗口健康') &&
        !t3Harness.getEl('ctx-takeaway').textContent.includes('对比基准'),
      `T3 Auto 模式未知容量 UI 渲染异常：pill=${t3Harness.getEl('ctx-health-pill').textContent}, chip=${t3Harness.getEl('ctx-budget-chip').textContent}, budget=${t3Harness.getEl('ctx-budget').textContent}, sessCache=${t3Harness.getEl('ctx-session-cache').textContent}`
    );

    // T3b: Legacy persisted budgetOverride must be ignored completely (no manual benchmark override)
    t3Harness.vmCtx.state.ui.budgetOverride = 256000;
    t3Harness.vmCtx.renderContextPanel(t3Offline);
    assert(
      t3Harness.getEl('ctx-budget').textContent === '未知' &&
        t3Harness.getEl('ctx-budget-chip').textContent === '上限未记录' &&
        t3Harness.getEl('ctx-pct-big').textContent === '--%' &&
        t3Harness.getEl('ctx-health-pill').textContent === '容量未知',
      `T3 遗留 budgetOverride 字段不应继续覆盖或折算：chip=${t3Harness.getEl('ctx-budget-chip').textContent}, pct=${t3Harness.getEl('ctx-pct-big').textContent}`
    );

    // T3c: Server GetCascadeTrajectoryGeneratorMetadata dynamically updates maxContextTokens (200K -> 512K)
    let t3MaxContextTokens = 200000;
    const t3GenServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (req.url?.includes('GetCascadeTrajectoryGeneratorMetadata')) {
        res.end(JSON.stringify({
          generatorMetadata: [
            {
              stepIndices: [2],
              chatModel: {
                model: 'Unknown Review Model',
                usage: { inputTokens: 100000, outputTokens: 1000 },
                chatStartMetadata: {
                  contextWindowMetadata: {
                    maxContextTokens: t3MaxContextTokens,
                    estimatedTokensUsed: 101000
                  }
                }
              }
            }
          ]
        }));
        return;
      }
      res.end('{}');
    });
    await new Promise((r) => t3GenServer.listen(0, '127.0.0.1', r));
    try {
      process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${t3GenServer.address().port}`;
      process.env.ANTIGRAVITY_CSRF_TOKEN = 't3-ls-csrf';
      const t3ServerSnap = await scanConversation(t3ConvId, { force: true });
      assert(
        t3ServerSnap.context?.budget === 200000 &&
          t3ServerSnap.context?.budgetSource === 'server' &&
          t3ServerSnap.context?.used === 101000 &&
          t3ServerSnap.context?.remaining === 99000 &&
          t3ServerSnap.context?.percent === 50.5,
        `T3 服务端返回 maxContextTokens=200000 时计算异常：${JSON.stringify(t3ServerSnap.context)}`
      );
      t3Harness.vmCtx.renderContextPanel(t3ServerSnap);
      assert(
        t3Harness.getEl('ctx-budget').textContent === '200.0K' &&
          t3Harness.getEl('ctx-budget-sub').textContent.includes('余 99.0K') &&
          t3Harness.getEl('ctx-budget-chip').textContent === '上限 200.0K' &&
          t3Harness.getEl('ctx-pct-big').textContent === '50.5%' &&
          t3Harness.getEl('ctx-health-pill').textContent === '运行健康',
        'T3 服务端 200K 动态上限渲染异常'
      );

      // Server hot-expands maxContextTokens from 200K -> 512K without hardcoding
      t3MaxContextTokens = 512000;
      const t3ExpandedSnap = await scanConversation(t3ConvId, { force: true });
      assert(
        t3ExpandedSnap.context?.budget === 512000 &&
          t3ExpandedSnap.context?.budgetSource === 'server' &&
          t3ExpandedSnap.context?.remaining === 411000 &&
          t3ExpandedSnap.context?.percent === 19.7,
        `T3 服务端热扩容至 512000 时计算异常：${JSON.stringify(t3ExpandedSnap.context)}`
      );
      t3Harness.vmCtx.state.contextData = t3ExpandedSnap;
      t3Harness.vmCtx.renderTopCapsules();
      t3Harness.vmCtx.renderContextPanel(t3ExpandedSnap);
      assert(
        t3Harness.getEl('ctx-budget').textContent === '512.0K' &&
          t3Harness.getEl('ctx-budget-chip').textContent === '上限 512.0K' &&
          t3Harness.getEl('ctx-pct-big').textContent === '19.7%' &&
          t3Harness.getEl('ctx-health-pill').textContent === '运行健康',
        `T3 服务端 512K 动态上限渲染异常：chip=${t3Harness.getEl('ctx-budget-chip').textContent}, pct=${t3Harness.getEl('ctx-pct-big').textContent}`
      );

      // U1: Dynamic server threshold transitions (512K high usage -> 1M expansion -> empty session awaiting sync)
      const u1High512Snap = {
        ...t3ExpandedSnap,
        context: {
          ...t3ExpandedSnap.context,
          used: 480000,
          budget: 512000,
          budgetSource: 'server',
          remaining: 32000,
          percent: 93.8
        }
      };
      t3Harness.vmCtx.state.contextData = u1High512Snap;
      t3Harness.vmCtx.renderTopCapsules();
      t3Harness.vmCtx.renderContextPanel(u1High512Snap);
      assert(
        t3Harness.getEl('ctx-budget-chip').textContent === '上限 512.0K' &&
          t3Harness.getEl('ctx-pct-big').textContent === '93.8%' &&
          t3Harness.getEl('ctx-health-pill').textContent === '临近上限' &&
          t3Harness.getEl('ctx-health-pill').className.includes('danger') &&
          t3Harness.getEl('hero-ring-fill').style.stroke === 'var(--danger)' &&
          t3Harness.getEl('mini-ring-fill').style.stroke === 'var(--danger)' &&
          t3Harness.getEl('ctx-takeaway').classList.contains('danger') &&
          t3Harness.getEl('ctx-takeaway').textContent.includes('93.8%'),
        `U1 512K 高水位告警渲染异常：pill=${t3Harness.getEl('ctx-health-pill').textContent}, chip=${t3Harness.getEl('ctx-budget-chip').textContent}`
      );

      const u1Expanded1MSnap = {
        ...t3ExpandedSnap,
        context: {
          ...t3ExpandedSnap.context,
          used: 480000,
          budget: 1000000,
          budgetSource: 'server',
          remaining: 520000,
          percent: 48
        }
      };
      t3Harness.vmCtx.state.contextData = u1Expanded1MSnap;
      t3Harness.vmCtx.renderTopCapsules();
      t3Harness.vmCtx.renderContextPanel(u1Expanded1MSnap);
      assert(
        t3Harness.getEl('ctx-budget-chip').textContent === '上限 1.00M' &&
          t3Harness.getEl('ctx-budget').textContent === '1.00M' &&
          t3Harness.getEl('ctx-pct-big').textContent === '48.0%' &&
          t3Harness.getEl('ctx-health-pill').textContent === '运行健康' &&
          t3Harness.getEl('hero-ring-fill').style.stroke === 'var(--cv-accent)' &&
          !t3Harness.getEl('ctx-takeaway').classList.contains('danger') &&
          !t3Harness.getEl('ctx-takeaway').classList.contains('warn'),
        `U1 扩容至 1M 动态跟随异常：pill=${t3Harness.getEl('ctx-health-pill').textContent}, chip=${t3Harness.getEl('ctx-budget-chip').textContent}`
      );

      const u1EmptySnap = {
        ...t3ExpandedSnap,
        context: {
          ...t3ExpandedSnap.context,
          used: null,
          budget: null,
          budgetSource: 'unknown',
          remaining: null,
          percent: null
        }
      };
      t3Harness.vmCtx.state.contextData = u1EmptySnap;
      t3Harness.vmCtx.renderTopCapsules();
      t3Harness.vmCtx.renderContextPanel(u1EmptySnap);
      assert(
        t3Harness.getEl('ctx-budget-chip').textContent === '上限待同步' &&
          t3Harness.getEl('ctx-budget').textContent === '--' &&
          t3Harness.getEl('ctx-budget-sub').textContent === '待首轮同步' &&
          t3Harness.getEl('ctx-health-pill').textContent === '待首轮请求' &&
          t3Harness.getEl('ctx-pct-big').textContent === '--%',
        `U1 空会话待同步胶囊渲染异常：chip=${t3Harness.getEl('ctx-budget-chip').textContent}, budget=${t3Harness.getEl('ctx-budget').textContent}`
      );
      delete t3Harness.vmCtx.state.ui.budgetOverride;
    } finally {
      delete process.env.ANTIGRAVITY_LS_ADDRESS;
      delete process.env.ANTIGRAVITY_CSRF_TOKEN;
      await new Promise((r) => t3GenServer.close(r));
      rmSync(join(isolatedAgDir, 'brain', t3ConvId), { recursive: true, force: true });
    }

    // U2: Switching models must NEVER inherit the previous model's server budget
    const u2ConvId = 'b2000000-0000-4000-8000-000000000002';
    const u2LogDir = join(isolatedAgDir, 'brain', u2ConvId, '.system_generated', 'logs');
    mkdirSync(u2LogDir, { recursive: true });
    let u2Phase = 1;
    const u2Server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (req.url?.includes('GetCascadeTrajectoryGeneratorMetadata')) {
        const meta = [
          {
            stepIndices: [1],
            chatModel: {
              model: 'Claude Sonnet 4.6',
              usage: { inputTokens: 15000, outputTokens: 1000 },
              chatStartMetadata: {
                contextWindowMetadata: { maxContextTokens: 200000, estimatedTokensUsed: 16000 }
              }
            }
          }
        ];
        if (u2Phase >= 2) {
          meta.push({
            stepIndices: [3],
            chatModel: {
              model: 'Custom Unknown B',
              usage: { inputTokens: 49000, outputTokens: 1000 },
              chatStartMetadata: {
                contextWindowMetadata: { estimatedTokensUsed: 50000 }
              }
            }
          });
        }
        if (u2Phase >= 4) {
          meta.push({
            stepIndices: [5],
            chatModel: {
              model: 'Claude Opus 5.5',
              usage: { inputTokens: 58000, outputTokens: 2000 },
              chatStartMetadata: {
                contextWindowMetadata: { maxContextTokens: 1000000, estimatedTokensUsed: 60000 }
              }
            }
          });
        }
        res.end(JSON.stringify({ generatorMetadata: meta }));
        return;
      }
      res.end('{}');
    });
    await new Promise((r) => u2Server.listen(0, '127.0.0.1', r));
    try {
      process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${u2Server.address().port}`;
      process.env.ANTIGRAVITY_CSRF_TOKEN = 'u2-ls-csrf';
      const writeU2Steps = (steps) => {
        writeFileSync(
          join(u2LogDir, 'transcript.jsonl'),
          steps.map((s) => JSON.stringify(s)).join('\n') + '\n',
          'utf-8'
        );
      };
      // Phase 1: Switch from Claude Sonnet 4.6 (200K) to Custom Unknown B before Unknown B responds
      writeU2Steps([
        { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:00:00Z', content: 'start with sonnet' },
        { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-12T10:00:05Z', model: 'Claude Sonnet 4.6', content: 'sonnet reply' },
        { step_index: 2, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:01:00Z', content: 'Model Selection from Claude Sonnet 4.6 to Custom Unknown B.\nhi unknown b' }
      ]);
      const u2Snap1 = await scanConversation(u2ConvId, { force: true });
      assert(
        u2Snap1.context?.model === 'Custom Unknown B' &&
          u2Snap1.context?.budget === null &&
          u2Snap1.context?.budgetSource === 'unknown' &&
          u2Snap1.context?.percent === null,
        `U2 切换至未知模型(未出轮次)竟继承上一模型预算：${JSON.stringify(u2Snap1.context)}`
      );

      // Phase 2: Unknown B responds without maxContextTokens (latestValidTurn is still Model A!)
      u2Phase = 2;
      writeU2Steps([
        { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:00:00Z', content: 'start with sonnet' },
        { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-12T10:00:05Z', model: 'Claude Sonnet 4.6', content: 'sonnet reply' },
        { step_index: 2, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:01:00Z', content: 'Model Selection from Claude Sonnet 4.6 to Custom Unknown B.\nhi unknown b' },
        { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-12T10:01:10Z', model: 'Custom Unknown B', content: 'unknown b reply' }
      ]);
      const u2Snap2 = await scanConversation(u2ConvId, { force: true });
      assert(
        u2Snap2.context?.model === 'Custom Unknown B' &&
          u2Snap2.context?.budget === null &&
          u2Snap2.context?.budgetSource === 'unknown',
        `U2 无预算模型已响应时竟回退继承 Model A 预算：${JSON.stringify(u2Snap2.context)}`
      );

      // Phase 3: Switch to Claude Opus 5.5 before Opus 5.5 responds -> must still be unknown
      u2Phase = 3;
      writeU2Steps([
        { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:00:00Z', content: 'start with sonnet' },
        { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-12T10:00:05Z', model: 'Claude Sonnet 4.6', content: 'sonnet reply' },
        { step_index: 2, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:01:00Z', content: 'Model Selection from Claude Sonnet 4.6 to Custom Unknown B.\nhi unknown b' },
        { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-12T10:01:10Z', model: 'Custom Unknown B', content: 'unknown b reply' },
        { step_index: 4, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:02:00Z', content: 'Model Selection from Custom Unknown B to Claude Opus 5.5.\nhi opus' }
      ]);
      const u2Snap3 = await scanConversation(u2ConvId, { force: true });
      assert(
        u2Snap3.context?.model === 'Claude Opus 5.5' && u2Snap3.context?.budget === null,
        `U2 切至 Opus 5.5 首轮完成前不应伪造预算：${JSON.stringify(u2Snap3.context)}`
      );

      // Phase 4 & 5: Opus 5.5 finishes with 1M budget, then user sends next message on same Opus 5.5 -> retains 1M
      u2Phase = 4;
      writeU2Steps([
        { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:00:00Z', content: 'start with sonnet' },
        { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-12T10:00:05Z', model: 'Claude Sonnet 4.6', content: 'sonnet reply' },
        { step_index: 2, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:01:00Z', content: 'Model Selection from Claude Sonnet 4.6 to Custom Unknown B.\nhi unknown b' },
        { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-12T10:01:10Z', model: 'Custom Unknown B', content: 'unknown b reply' },
        { step_index: 4, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:02:00Z', content: 'Model Selection from Custom Unknown B to Claude Opus 5.5.\nhi opus' },
        { step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-12T10:02:10Z', model: 'Claude Opus 5.5', content: 'opus reply' },
        { step_index: 6, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:03:00Z', content: 'follow up on same model' }
      ]);
      const u2Snap4 = await scanConversation(u2ConvId, { force: true });
      assert(
        u2Snap4.context?.model === 'Claude Opus 5.5' &&
          u2Snap4.context?.budget === 1000000 &&
          u2Snap4.context?.budgetSource === 'server',
        `U2 同模型后续提问应保留 1M 预算：${JSON.stringify(u2Snap4.context)}`
      );

      // Phase 6: Switching back to earlier Claude Sonnet 4.6 restores its own 200K budget (not Opus's 1M)
      writeU2Steps([
        { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:00:00Z', content: 'start with sonnet' },
        { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-12T10:00:05Z', model: 'Claude Sonnet 4.6', content: 'sonnet reply' },
        { step_index: 2, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:01:00Z', content: 'Model Selection from Claude Sonnet 4.6 to Custom Unknown B.\nhi unknown b' },
        { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-12T10:01:10Z', model: 'Custom Unknown B', content: 'unknown b reply' },
        { step_index: 4, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:02:00Z', content: 'Model Selection from Custom Unknown B to Claude Opus 5.5.\nhi opus' },
        { step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-12T10:02:10Z', model: 'Claude Opus 5.5', content: 'opus reply' },
        { step_index: 6, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:03:00Z', content: 'follow up on same model' },
        { step_index: 7, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:04:00Z', content: 'Model Selection from Claude Opus 5.5 to Claude Sonnet 4.6.\nback to sonnet' }
      ]);
      const u2Snap5 = await scanConversation(u2ConvId, { force: true });
      assert(
        u2Snap5.context?.model === 'Claude Sonnet 4.6' &&
          u2Snap5.context?.budget === 200000 &&
          u2Snap5.context?.budgetSource === 'server',
        `U2 切回曾运行过的 Sonnet 4.6 应恢复其自身 200K 预算：${JSON.stringify(u2Snap5.context)}`
      );
    } finally {
      delete process.env.ANTIGRAVITY_LS_ADDRESS;
      delete process.env.ANTIGRAVITY_CSRF_TOKEN;
      await new Promise((r) => u2Server.close(r));
      rmSync(join(isolatedAgDir, 'brain', u2ConvId), { recursive: true, force: true });
    }

    // Privacy runtime check: synthetic error diagnostics & paths/tokens/emails in turnsPayload must be sanitized
    const privConvId = 'c3000000-0000-4000-8000-000000000003';
    const privLogDir = join(isolatedAgDir, 'brain', privConvId, '.system_generated', 'logs');
    mkdirSync(privLogDir, { recursive: true });
    try {
      const privSteps = [
        { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T10:00:00Z', content: 'run sensitive error test' },
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'ERROR',
          created_at: '2026-11-12T10:00:05Z',
          model: 'Claude Sonnet 5.5',
          usage: { input_tokens: 1200, output_tokens: 10 },
          content: 'Failed calling https://secret.internal.net/v1 with Bearer secret_bearer_token_1234567890 for /Users/mockuser/secret.txt and leak@mycorp-internal.io'
        }
      ];
      writeFileSync(
        join(privLogDir, 'transcript.jsonl'),
        privSteps.map((s) => JSON.stringify(s)).join('\n') + '\n',
        'utf-8'
      );
      const privSnap = await scanConversation(privConvId, { force: true });
      const privJson = JSON.stringify(privSnap);
      assert(
        !privJson.includes('secret_bearer_token') &&
          !privJson.includes('mockuser') &&
          !privJson.includes('mycorp-internal') &&
          !privJson.includes('secret.internal.net'),
        `运行时快照 turnsPayload/error 仍残留未脱敏诊断片段：${privJson}`
      );
    } finally {
      rmSync(join(isolatedAgDir, 'brain', privConvId), { recursive: true, force: true });
    }

    // H1: Unvisited historical conversation without inline transcript model must be enriched via
    // GetCascadeTrajectoryGeneratorMetadata during collectTokenHistory and survive offline via persisted cache
    const h1ConvId = '00000000-0000-4000-8000-000000000098';
    const h1LogDir = join(isolatedAgDir, 'brain', h1ConvId, '.system_generated', 'logs');
    mkdirSync(h1LogDir, { recursive: true });
    const h1Server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (req.url?.includes('GetCascadeTrajectoryGeneratorMetadata')) {
        let bodyRaw = '';
        req.on('data', (c) => { bodyRaw += c; });
        req.on('end', () => {
          let cascadeId = '';
          try { cascadeId = JSON.parse(bodyRaw || '{}').cascadeId || ''; } catch {}
          if (cascadeId === h1ConvId) {
            res.end(JSON.stringify({
              generatorMetadata: [
                {
                  stepIndices: [1],
                  chatModel: {
                    modelDisplayName: 'Gemini 4 Carbon (High)',
                    responseModel: 'gemini-4-carbon',
                    model: 'MODEL_PLACEHOLDER_M427'
                  }
                },
                {
                  stepIndices: [2],
                  chatModel: {
                    modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
                    responseModel: 'gemini-4-hydrogen',
                    model: 'MODEL_PLACEHOLDER_M528'
                  }
                },
                {
                  stepIndices: [3],
                  chatModel: {
                    modelDisplayName: 'Gemini 4 Hydrogen (High)',
                    responseModel: 'gemini-4-hydrogen',
                    model: 'MODEL_PLACEHOLDER_M525'
                  }
                }
              ]
            }));
            return;
          }
          res.end('{}');
        });
        return;
      }
      if (req.url?.includes('GetUserStatus')) {
        res.end(JSON.stringify({ userStatus: { userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } } }));
        return;
      }
      res.end('{}');
    });
    await new Promise((r) => h1Server.listen(0, '127.0.0.1', r));
    try {
      const h1TodayIso = new Date().toISOString();
      writeFileSync(
        join(h1LogDir, 'transcript.jsonl'),
        [
          { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: h1TodayIso, content: 'audit historical steps' },
          { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: h1TodayIso, input_tokens: 1200, cache_read_tokens: 800, output_tokens: 150 },
          { step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: h1TodayIso, input_tokens: 1500, cache_read_tokens: 900, output_tokens: 200 },
          { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: h1TodayIso, input_tokens: 900, cache_read_tokens: 600, output_tokens: 100 }
        ].map((s) => JSON.stringify(s)).join('\n') + '\n',
        'utf-8'
      );

      process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${h1Server.address().port}`;
      process.env.ANTIGRAVITY_CSRF_TOKEN = 'h1-ls-csrf';

      // Call collectTokenHistory directly without opening scanConversation(h1ConvId) first
      const h1Online = await collectTokenHistory({ force: true });
      const h1IdentOnline = h1Online.analyticsBySource?.all?.costs?.allTime?.identified;
      assert(
        h1IdentOnline?.unpricedReasons?.missingModel === 0 &&
          h1IdentOnline?.byModel?.some((m) => m.displayName === 'Gemini 4 Carbon' && m.requests >= 1) &&
          h1IdentOnline?.byModel?.some((m) => m.displayName === 'Gemini 4 Hydrogen' && m.requests === 2 && !m.missingModel),
        `H1 collectTokenHistory 未自动回溯 GeneratorMetadata 或 Hydrogen 档位未合并：${JSON.stringify(h1IdentOnline)}`
      );

      const stepCachePath = join(isolatedStateDir, 'gen_step_models_v1.json');
      assert(existsSync(stepCachePath), 'H1 未写入 gen_step_models_v1.json 持久化步骤模型缓存');

      // Simulate offline CLI run (LS down) and ensure zero unattributed fallback returns
      delete process.env.ANTIGRAVITY_LS_ADDRESS;
      delete process.env.ANTIGRAVITY_CSRF_TOKEN;
      const h1Offline = await collectTokenHistory({ force: true });
      const h1IdentOffline = h1Offline.analyticsBySource?.all?.costs?.allTime?.identified;
      assert(
        h1IdentOffline?.unpricedReasons?.missingModel === 0 &&
          h1IdentOffline?.byModel?.some((m) => m.displayName === 'Gemini 4 Hydrogen' && m.requests === 2),
        `H1 离线模式下未命中持久化步骤模型缓存：${JSON.stringify(h1IdentOffline)}`
      );
    } finally {
      delete process.env.ANTIGRAVITY_LS_ADDRESS;
      delete process.env.ANTIGRAVITY_CSRF_TOKEN;
      await new Promise((r) => h1Server.close(r));
      rmSync(join(isolatedAgDir, 'brain', h1ConvId), { recursive: true, force: true });
      rmSync(join(isolatedStateDir, 'gen_step_models_v1.json'), { force: true });
    }

    // H2 (X1): Empty / partial step model cache recovery, non-regression on transient empty response, and true cold-process offline persistence
    const h2ConvIdA = '00000000-0000-4000-8000-000000000099';
    const h2ConvIdB = '00000000-0000-4000-8000-00000000009a';
    const h2ConvIdC = '00000000-0000-4000-8000-00000000009b';
    const writeH2Transcript = (convId) => {
      const d = join(isolatedAgDir, 'brain', convId, '.system_generated', 'logs');
      mkdirSync(d, { recursive: true });
      const p = join(d, 'transcript.jsonl');
      const h2TodayIso = new Date().toISOString();
      writeFileSync(
        p,
        [
          { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: h2TodayIso, content: 'verify X1 cache recovery' },
          { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: h2TodayIso, input_tokens: 1200, cache_read_tokens: 300, output_tokens: 150 },
          { step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: h2TodayIso, input_tokens: 1400, cache_read_tokens: 400, output_tokens: 180 }
        ].map((s) => JSON.stringify(s)).join('\n') + '\n',
        'utf-8'
      );
      return statSync(p);
    };
    const h2CarbonMeta = {
      stepIndices: [1],
      chatModel: { modelDisplayName: 'Gemini 4 Carbon (High)', responseModel: 'gemini-4-carbon', model: 'MODEL_PLACEHOLDER_M427' }
    };
    const h2HydrogenMeta = {
      stepIndices: [2],
      chatModel: { modelDisplayName: 'Gemini 4 Hydrogen (High)', responseModel: 'gemini-4-hydrogen', model: 'MODEL_PLACEHOLDER_M525' }
    };
    let h2Mode = 'empty';
    const h2Server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (req.url?.includes('GetCascadeTrajectoryGeneratorMetadata')) {
        const list = h2Mode === 'empty'
          ? []
          : (h2Mode === 'partial' ? [h2CarbonMeta] : [h2CarbonMeta, h2HydrogenMeta]);
        res.end(JSON.stringify({ generatorMetadata: list }));
        return;
      }
      if (req.url?.includes('GetUserStatus')) {
        res.end(JSON.stringify({ userStatus: { userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } } }));
        return;
      }
      res.end('{}');
    });
    await new Promise((r) => h2Server.listen(0, '127.0.0.1', r));
    try {
      const h2Baseline = await collectTokenHistory({ force: true });
      const h2BaseCarbon = h2Baseline.analyticsBySource?.all?.costs?.allTime?.identified?.byModel?.find((m) => m.displayName === 'Gemini 4 Carbon')?.requests || 0;
      const stepCachePath = join(isolatedStateDir, 'gen_step_models_v1.json');

      process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${h2Server.address().port}`;
      process.env.ANTIGRAVITY_CSRF_TOKEN = 'h2-ls-csrf';

      // Case A: Empty [] -> never persisted as complete -> recovers to full when host recovers
      writeH2Transcript(h2ConvIdA);
      h2Mode = 'empty';
      const h2EmptyHist = await collectTokenHistory({ force: true });
      assert(
        h2EmptyHist.analyticsBySource?.all?.costs?.allTime?.identified?.unpricedReasons?.missingModel === 2,
        `H2 Case A 空元数据初始缺失数应为 2：${JSON.stringify(h2EmptyHist.analyticsBySource?.all?.costs?.allTime?.identified)}`
      );
      if (existsSync(stepCachePath)) {
        const cacheAfterEmpty = JSON.parse(readFileSync(stepCachePath, 'utf-8'));
        assert(!cacheAfterEmpty.convs?.[h2ConvIdA], 'H2 Case A 空映射不得写入持久化缓存');
      }
      h2Mode = 'full';
      const h2EmptyRecovered = await collectTokenHistory({ force: true });
      const h2EmptyIdent = h2EmptyRecovered.analyticsBySource?.all?.costs?.allTime?.identified;
      assert(
        h2EmptyIdent?.unpricedReasons?.missingModel === 0 &&
          h2EmptyIdent?.byModel?.some((m) => m.displayName === 'Gemini 4 Carbon' && m.requests === h2BaseCarbon + 1) &&
          h2EmptyIdent?.byModel?.some((m) => m.displayName === 'Gemini 4 Hydrogen' && m.requests === 1 && !m.missingModel),
        `H2 Case A 宿主恢复后强制刷新未能补齐：${JSON.stringify(h2EmptyIdent)}`
      );
      rmSync(join(isolatedAgDir, 'brain', h2ConvIdA), { recursive: true, force: true });
      rmSync(stepCachePath, { force: true });

      // Case B: Partial -> transient empty must NOT wipe step 1 -> full recovers step 2
      writeH2Transcript(h2ConvIdB);
      h2Mode = 'partial';
      const h2Part = await collectTokenHistory({ force: true });
      const h2PartIdent = h2Part.analyticsBySource?.all?.costs?.allTime?.identified;
      assert(
        h2PartIdent?.unpricedReasons?.missingModel === 1 &&
          h2PartIdent?.byModel?.some((m) => m.displayName === 'Gemini 4 Carbon' && m.requests === h2BaseCarbon + 1),
        `H2 Case B 部分结果应先识别 step 1 Carbon：${JSON.stringify(h2PartIdent)}`
      );
      h2Mode = 'empty';
      const h2TransientEmpty = await collectTokenHistory({ force: true });
      const h2TransIdent = h2TransientEmpty.analyticsBySource?.all?.costs?.allTime?.identified;
      assert(
        h2TransIdent?.unpricedReasons?.missingModel === 1 &&
          h2TransIdent?.byModel?.some((m) => m.displayName === 'Gemini 4 Carbon' && m.requests === h2BaseCarbon + 1),
        `H2 Case B 瞬时空响应不得覆盖已确认的 step 1 缓存：${JSON.stringify(h2TransIdent)}`
      );
      h2Mode = 'full';
      const h2PartRecovered = await collectTokenHistory({ force: true });
      const h2PartRecIdent = h2PartRecovered.analyticsBySource?.all?.costs?.allTime?.identified;
      assert(
        h2PartRecIdent?.unpricedReasons?.missingModel === 0 &&
          h2PartRecIdent?.byModel?.some((m) => m.displayName === 'Gemini 4 Hydrogen' && m.requests === 1 && !m.missingModel),
        `H2 Case B 部分缓存强制刷新未补齐 step 2：${JSON.stringify(h2PartRecIdent)}`
      );
      rmSync(join(isolatedAgDir, 'brain', h2ConvIdB), { recursive: true, force: true });
      rmSync(stepCachePath, { force: true });

      // Case C: Cold child processes (legacy empty/partial disk cache recovery + true offline cold-process read)
      const h2StatC = writeH2Transcript(h2ConvIdC);
      const collectorUrl = pathToFileURL(join(ROOT, 'sidecars', 'dashboard', 'collector.mjs')).href;
      const runChildHistory = (childEnv) => new Promise((resolveChild, rejectChild) => {
        const child = spawn(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `const m = await import(${JSON.stringify(collectorUrl)}); const h = await m.collectTokenHistory({ force: true }); console.log(JSON.stringify(h.analyticsBySource.all.costs.allTime.identified));`
          ],
          { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString('utf-8'); });
        child.stderr.on('data', (d) => { stderr += d.toString('utf-8'); });
        child.on('error', rejectChild);
        child.on('close', (code) => {
          if (code !== 0) {
            rejectChild(new Error(`child exited ${code}: ${stderr || stdout}`));
          } else {
            resolveChild(stdout.trim());
          }
        });
      });

      for (const legacySteps of [{}, { '1': 'Gemini 4 Carbon (High)' }]) {
        writeFileSync(
          stepCachePath,
          JSON.stringify({ version: 1, convs: { [h2ConvIdC]: { size: h2StatC.size, mtimeMs: h2StatC.mtimeMs, steps: legacySteps } } }),
          'utf-8'
        );
        const recoveredJson = await runChildHistory({ ...process.env });
        const childIdent = JSON.parse(recoveredJson);
        assert(
          childIdent?.unpricedReasons?.missingModel === 0 &&
            childIdent?.byModel?.some((m) => m.displayName === 'Gemini 4 Carbon' && m.requests === h2BaseCarbon + 1) &&
            childIdent?.byModel?.some((m) => m.displayName === 'Gemini 4 Hydrogen' && m.requests === 1 && !m.missingModel),
          `H2 Case C 新进程强刷旧缓存 (${JSON.stringify(legacySteps)}) 恢复失败：${recoveredJson}`
        );
      }

      const offlineEnv = { ...process.env };
      delete offlineEnv.ANTIGRAVITY_LS_ADDRESS;
      delete offlineEnv.ANTIGRAVITY_CSRF_TOKEN;
      const offlineChildJson = await runChildHistory(offlineEnv);
      const offlineChildIdent = JSON.parse(offlineChildJson);
      assert(
        offlineChildIdent?.unpricedReasons?.missingModel === 0 &&
          offlineChildIdent?.byModel?.some((m) => m.displayName === 'Gemini 4 Carbon' && m.requests === h2BaseCarbon + 1) &&
          offlineChildIdent?.byModel?.some((m) => m.displayName === 'Gemini 4 Hydrogen' && m.requests === 1 && !m.missingModel),
        `H2 Case C 纯离线冷进程未能读取完整持久化缓存：${offlineChildJson}`
      );
    } finally {
      delete process.env.ANTIGRAVITY_LS_ADDRESS;
      delete process.env.ANTIGRAVITY_CSRF_TOKEN;
      h2Server.closeAllConnections?.();
      await new Promise((r) => h2Server.close(r));
      for (const id of [h2ConvIdA, h2ConvIdB, h2ConvIdC]) {
        rmSync(join(isolatedAgDir, 'brain', id), { recursive: true, force: true });
      }
      rmSync(join(isolatedStateDir, 'gen_step_models_v1.json'), { force: true });
    }

    // H3 (X2): Inline-resolved transcripts skip metadata RPCs; hung/slow metadata obeys budget + concurrency cap and updates models/ETag on recovery
    const h3ConvIds = Array.from({ length: 18 }, (_, i) => `00000000-0000-4000-8000-${String(101 + i).padStart(12, '0')}`);
    let h3Mode = 'hung';
    let h3Calls = 0;
    let h3Active = 0;
    let h3MaxActive = 0;
    const h3Server = http.createServer((req, res) => {
      req.resume();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (req.url?.includes('GetCascadeTrajectoryGeneratorMetadata')) {
        h3Calls += 1;
        h3Active += 1;
        h3MaxActive = Math.max(h3MaxActive, h3Active);
        res.on('close', () => { h3Active = Math.max(0, h3Active - 1); });
        if (h3Mode === 'hung') {
          return;
        }
        const t = setTimeout(() => {
          if (res.writableEnded || res.destroyed) return;
          res.end(JSON.stringify({
            generatorMetadata: [
              { stepIndices: [1], chatModel: { modelDisplayName: 'Gemini 4 Carbon (High)', responseModel: 'gemini-4-carbon' } },
              { stepIndices: [2], chatModel: { modelDisplayName: 'Gemini 4 Hydrogen (High)', responseModel: 'gemini-4-hydrogen' } }
            ]
          }));
        }, 60);
        t.unref?.();
        return;
      }
      if (req.url?.includes('GetUserStatus')) {
        res.end(JSON.stringify({ userStatus: { userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } } }));
        return;
      }
      res.end('{}');
    });
    await new Promise((r) => h3Server.listen(0, '127.0.0.1', r));
    try {
      const h3Baseline = await collectTokenHistory({ force: true });
      const h3BaseCarbon = h3Baseline.analyticsBySource?.all?.costs?.allTime?.identified?.byModel?.find((m) => m.displayName === 'Gemini 4 Carbon')?.requests || 0;
      const h3TodayIso = new Date().toISOString();
      const writeH3Dataset = (withInlineModel) => {
        for (const id of h3ConvIds) {
          const d = join(isolatedAgDir, 'brain', id, '.system_generated', 'logs');
          mkdirSync(d, { recursive: true });
          const rows = [1, 2].map((step) => ({
            step_index: step,
            type: 'PLANNER_RESPONSE',
            status: 'DONE',
            created_at: h3TodayIso,
            input_tokens: 1200,
            output_tokens: 150,
            ...(withInlineModel ? { model: 'gemini-4-carbon' } : {})
          }));
          writeFileSync(join(d, 'transcript.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
        }
      };

      process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${h3Server.address().port}`;
      process.env.ANTIGRAVITY_CSRF_TOKEN = 'h3-ls-csrf';

      // Case A: 18 inline-resolved conversations with hung metadata server -> 0 RPCs, fast return
      writeH3Dataset(true);
      h3Mode = 'hung';
      h3Calls = 0;
      const tA0 = performance.now();
      const h3InlineHist = await collectTokenHistory({ force: true });
      const elapsedA = performance.now() - tA0;
      const h3InlineIdent = h3InlineHist.analyticsBySource?.all?.costs?.allTime?.identified;
      assert(
        elapsedA < 800 &&
          h3Calls === 0 &&
          h3InlineIdent?.unpricedReasons?.missingModel === 0 &&
          h3InlineIdent?.byModel?.some((m) => m.displayName === 'Gemini 4 Carbon' && m.requests === h3BaseCarbon + 36),
        `H3 Case A 内联模型会话不应触发 metadata RPC 或阻塞：elapsedMs=${Math.round(elapsedA)}, calls=${h3Calls}, ident=${JSON.stringify(h3InlineIdent)}`
      );

      // Case B: 18 unattributed conversations -> hung server returns within sync budget with full local tokens + concurrency <= 6, then recovered slow server updates models & ETag
      writeH3Dataset(false);
      h3Mode = 'hung';
      h3Calls = 0;
      h3MaxActive = 0;
      const tB0 = performance.now();
      const h3HungHist = await collectTokenHistory({ force: true });
      const elapsedB = performance.now() - tB0;
      assert(
        elapsedB < 1200 &&
          (h3HungHist.analyticsBySource?.all?.summary?.grandTotalTokens || 0) >= 48600 &&
          h3MaxActive <= 6,
        `H3 Case B 超时会话应受预算限制并保留完整本地 Token 总量：elapsedMs=${Math.round(elapsedB)}, maxActive=${h3MaxActive}, tokens=${h3HungHist.analyticsBySource?.all?.summary?.grandTotalTokens}`
      );

      h3Mode = 'slow';
      h3MaxActive = 0;
      let h3DoneHist = await collectTokenHistory({ force: true });
      for (let waitAttempt = 0; waitAttempt < 12 && (h3DoneHist.analyticsBySource?.all?.costs?.allTime?.identified?.unpricedReasons?.missingModel || 0) > 0; waitAttempt++) {
        await new Promise((r) => setTimeout(r, 150));
        h3DoneHist = await collectTokenHistory({ force: false });
      }
      const h3DoneIdent = h3DoneHist.analyticsBySource?.all?.costs?.allTime?.identified;
      assert(
        h3MaxActive <= 6 &&
          h3DoneIdent?.unpricedReasons?.missingModel === 0 &&
          h3DoneIdent?.byModel?.some((m) => m.displayName === 'Gemini 4 Carbon' && m.requests === h3BaseCarbon + 18) &&
          h3DoneIdent?.byModel?.some((m) => m.displayName === 'Gemini 4 Hydrogen' && m.requests === 18) &&
          h3DoneHist.etag !== h3HungHist.etag,
        `H3 Case B 宿主恢复后未能完成并发回溯并更新 ETag：maxActive=${h3MaxActive}, ident=${JSON.stringify(h3DoneIdent)}`
      );
    } finally {
      delete process.env.ANTIGRAVITY_LS_ADDRESS;
      delete process.env.ANTIGRAVITY_CSRF_TOKEN;
      h3Server.closeAllConnections?.();
      await new Promise((r) => h3Server.close(r));
      for (const id of h3ConvIds) {
        rmSync(join(isolatedAgDir, 'brain', id), { recursive: true, force: true });
      }
      rmSync(join(isolatedStateDir, 'gen_step_models_v1.json'), { force: true });
    }

    // H4 (Y1): Background backfill pending step models must flush before force refresh / directory switch
    const h4ConvIdA1 = '00000000-0000-4000-8000-000000000201';
    const h4ConvIdA2 = '00000000-0000-4000-8000-000000000202';
    const h4ConvIdB1 = '00000000-0000-4000-8000-000000000203';
    const h4ConvIdB2 = '00000000-0000-4000-8000-000000000204';
    const h4ConvIdC1 = '00000000-0000-4000-8000-000000000205';
    const h4ConvIdC2 = '00000000-0000-4000-8000-000000000206';
    const h4ConvIdC3 = '00000000-0000-4000-8000-000000000207';
    const h4SwitchDir1 = join(tmpVerifyRoot, 'h4_switch_dir1');
    const h4SwitchDir2 = join(tmpVerifyRoot, 'h4_switch_dir2');
    const writeH4Transcript = (agRoot, id) => {
      const d = join(agRoot, 'brain', id, '.system_generated', 'logs');
      mkdirSync(d, { recursive: true });
      const iso = new Date().toISOString();
      writeFileSync(
        join(d, 'transcript.jsonl'),
        [1, 2].map((step) => ({
          step_index: step,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: iso,
          input_tokens: 1200,
          output_tokens: 150
        })).map((r) => JSON.stringify(r)).join('\n') + '\n',
        'utf-8'
      );
    };
    const h4MetaPayload = JSON.stringify({
      generatorMetadata: [
        { stepIndices: [1], chatModel: { modelDisplayName: 'Gemini 4 Carbon (High)', responseModel: 'gemini-4-carbon' } },
        { stepIndices: [2], chatModel: { modelDisplayName: 'Gemini 4 Hydrogen (High)', responseModel: 'gemini-4-hydrogen' } }
      ]
    });
    let h4Mode = 'caseA';
    let h4MaxActive = 0;
    let h4Active = 0;
    let resolveH4B1Replied = null;
    let resolveH4C1Replied = null;
    const h4Timers = new Set();
    const h4Server = http.createServer((req, res) => {
      let rawBody = '';
      req.on('data', (c) => { rawBody += c; });
      req.on('end', () => {
        if (req.url?.includes('GetCascadeTrajectoryGeneratorMetadata')) {
          h4Active += 1;
          h4MaxActive = Math.max(h4MaxActive, h4Active);
          res.on('close', () => { h4Active = Math.max(0, h4Active - 1); });
          if (h4Mode === '503') {
            res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end('{}');
            return;
          }
          let cascadeId = '';
          try { cascadeId = JSON.parse(rawBody || '{}').cascadeId || ''; } catch {}
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          if (cascadeId === h4ConvIdA1 || cascadeId === h4ConvIdC3) {
            res.end(h4MetaPayload);
            return;
          }
          if (cascadeId === h4ConvIdB1 || cascadeId === h4ConvIdC1) {
            const t = setTimeout(() => {
              h4Timers.delete(t);
              if (!res.writableEnded && !res.destroyed) {
                res.end(h4MetaPayload);
              }
              if (cascadeId === h4ConvIdB1 && resolveH4B1Replied) {
                const done = resolveH4B1Replied;
                resolveH4B1Replied = null;
                done();
              }
              if (cascadeId === h4ConvIdC1 && resolveH4C1Replied) {
                const done = resolveH4C1Replied;
                resolveH4C1Replied = null;
                done();
              }
            }, 430);
            t.unref?.();
            h4Timers.add(t);
            return;
          }
          // h4ConvIdA2 / h4ConvIdB2 / h4ConvIdC2 stay pending until timeout or force-refresh abort
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        if (req.url?.includes('GetUserStatus')) {
          res.end(JSON.stringify({ userStatus: { userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } } }));
          return;
        }
        res.end('{}');
      });
    });
    await new Promise((r) => h4Server.listen(0, '127.0.0.1', r));
    const prevH4AgDir = process.env.AG_DIR;
    const prevH4CliDir = process.env.AG_CLI_DIR;
    const prevH4StateDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
    try {
      const h4Baseline = await collectTokenHistory({ force: true });
      const h4BaseIdent = h4Baseline.analyticsBySource?.all?.costs?.allTime?.identified;
      const h4BaseMissing = h4BaseIdent?.unpricedReasons?.missingModel || 0;
      const h4BaseCarbon = h4BaseIdent?.byModel?.find((m) => m.displayName === 'Gemini 4 Carbon')?.requests || 0;
      const h4BaseHydrogen = h4BaseIdent?.byModel?.find((m) => m.displayName === 'Gemini 4 Hydrogen')?.requests || 0;
      const stepCachePath = join(isolatedStateDir, 'gen_step_models_v1.json');
      const collectorUrl = pathToFileURL(join(ROOT, 'sidecars', 'dashboard', 'collector.mjs')).href;
      const runH4ColdOffline = (envOverrides = {}) => new Promise((resolveChild, rejectChild) => {
        const childEnv = { ...process.env, ...envOverrides };
        delete childEnv.ANTIGRAVITY_LS_ADDRESS;
        delete childEnv.ANTIGRAVITY_CSRF_TOKEN;
        const child = spawn(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `const m = await import(${JSON.stringify(collectorUrl)}); const h = await m.collectTokenHistory({ force: true }); console.log(JSON.stringify(h.analyticsBySource.all.costs.allTime.identified));`
          ],
          { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString('utf-8'); });
        child.stderr.on('data', (d) => { stderr += d.toString('utf-8'); });
        child.on('error', rejectChild);
        child.on('close', (code) => {
          if (code !== 0) rejectChild(new Error(`H4 cold child exited ${code}: ${stderr || stdout}`));
          else resolveChild(JSON.parse(stdout.trim()));
        });
      });

      process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${h4Server.address().port}`;
      process.env.ANTIGRAVITY_CSRF_TOKEN = 'h4-ls-csrf';

      // Case A: Partial success inside sync budget + hung peer -> force refresh with 503 -> cold offline retains confirmed models
      h4Mode = 'caseA';
      h4MaxActive = 0;
      writeH4Transcript(isolatedAgDir, h4ConvIdA1);
      writeH4Transcript(isolatedAgDir, h4ConvIdA2);
      const h4FirstA = await collectTokenHistory({ force: true });
      assert(
        h4FirstA.analyticsBySource?.all?.costs?.allTime?.identified?.unpricedReasons?.missingModel === h4BaseMissing + 2,
        `H4 Case A 首轮缺失数应为 ${h4BaseMissing + 2}：${JSON.stringify(h4FirstA.analyticsBySource?.all?.costs?.allTime?.identified)}`
      );
      h4Mode = '503';
      await collectTokenHistory({ force: true });
      const h4OfflineA = await runH4ColdOffline();
      assert(
        h4MaxActive <= 6 &&
          h4OfflineA?.unpricedReasons?.missingModel === h4BaseMissing + 2 &&
          h4OfflineA?.byModel?.some((m) => m.displayName === 'Gemini 4 Carbon' && m.requests === h4BaseCarbon + 1) &&
          h4OfflineA?.byModel?.some((m) => m.displayName === 'Gemini 4 Hydrogen' && m.requests === h4BaseHydrogen + 1),
        `H4 Case A 强刷且宿主 503 后冷进程离线丢失已识别模型：maxActive=${h4MaxActive}, ident=${JSON.stringify(h4OfflineA)}`
      );
      rmSync(join(isolatedAgDir, 'brain', h4ConvIdA1), { recursive: true, force: true });
      rmSync(join(isolatedAgDir, 'brain', h4ConvIdA2), { recursive: true, force: true });
      rmSync(stepCachePath, { force: true });

      // Case B: Background response completes after 350ms budget (dirtyCount < 6, still in memory pendingConvs) -> force refresh + 503 -> cold offline retains models
      h4Mode = 'caseB';
      h4MaxActive = 0;
      writeH4Transcript(isolatedAgDir, h4ConvIdB1);
      writeH4Transcript(isolatedAgDir, h4ConvIdB2);
      const h4B1Replied = new Promise((r) => { resolveH4B1Replied = r; });
      await collectTokenHistory({ force: true });
      const diskBeforeB1 = existsSync(stepCachePath) ? JSON.parse(readFileSync(stepCachePath, 'utf-8')) : null;
      assert(
        !diskBeforeB1?.convs?.[h4ConvIdB1],
        'H4 Case B 首轮 350ms 预算返回时 430ms 慢会话尚不应落盘'
      );
      await h4B1Replied;
      await new Promise((r) => setTimeout(r, 30));
      const diskBeforeRefreshB = existsSync(stepCachePath) ? JSON.parse(readFileSync(stepCachePath, 'utf-8')) : null;
      assert(
        !diskBeforeRefreshB?.convs?.[h4ConvIdB1],
        'H4 Case B 单条后台完成 (<6) 在强刷前处于内存待写态，尚未写盘'
      );
      h4Mode = '503';
      await collectTokenHistory({ force: true });
      const h4OfflineB = await runH4ColdOffline();
      assert(
        h4MaxActive <= 6 &&
          h4OfflineB?.unpricedReasons?.missingModel === h4BaseMissing + 2 &&
          h4OfflineB?.byModel?.some((m) => m.displayName === 'Gemini 4 Carbon' && m.requests === h4BaseCarbon + 1) &&
          h4OfflineB?.byModel?.some((m) => m.displayName === 'Gemini 4 Hydrogen' && m.requests === h4BaseHydrogen + 1),
        `H4 Case B 后台待写映射在强刷+503 后被丢弃：maxActive=${h4MaxActive}, ident=${JSON.stringify(h4OfflineB)}`
      );
      rmSync(join(isolatedAgDir, 'brain', h4ConvIdB1), { recursive: true, force: true });
      rmSync(join(isolatedAgDir, 'brain', h4ConvIdB2), { recursive: true, force: true });
      rmSync(stepCachePath, { force: true });

      // Case C: Switching data directory mid-backfill flushes to original dir1 without polluting dir2
      const d1Ag = join(h4SwitchDir1, 'desktop');
      const d1Cli = join(h4SwitchDir1, 'cli');
      const d1State = join(h4SwitchDir1, 'state');
      const d2Ag = join(h4SwitchDir2, 'desktop');
      const d2Cli = join(h4SwitchDir2, 'cli');
      const d2State = join(h4SwitchDir2, 'state');
      for (const p of [d1Ag, d1Cli, d1State, d2Ag, d2Cli, d2State]) mkdirSync(p, { recursive: true });
      process.env.AG_DIR = d1Ag;
      process.env.AG_CLI_DIR = d1Cli;
      process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = d1State;
      writeH4Transcript(d1Ag, h4ConvIdC1);
      writeH4Transcript(d1Ag, h4ConvIdC2);
      writeH4Transcript(d2Ag, h4ConvIdC3);

      h4Mode = 'caseC';
      const h4C1Replied = new Promise((r) => { resolveH4C1Replied = r; });
      await collectTokenHistory({ force: true });
      await h4C1Replied;
      await new Promise((r) => setTimeout(r, 30));

      process.env.AG_DIR = d2Ag;
      process.env.AG_CLI_DIR = d2Cli;
      process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = d2State;
      await collectTokenHistory({ force: true });

      const d1CachePath = join(d1State, 'gen_step_models_v1.json');
      const d2CachePath = join(d2State, 'gen_step_models_v1.json');
      const d1Disk = existsSync(d1CachePath) ? JSON.parse(readFileSync(d1CachePath, 'utf-8')) : null;
      const d2Disk = existsSync(d2CachePath) ? JSON.parse(readFileSync(d2CachePath, 'utf-8')) : null;
      assert(
        d1Disk?.convs?.[h4ConvIdC1]?.steps?.['1'] &&
          d1Disk?.convs?.[h4ConvIdC1]?.steps?.['2'] &&
          !d1Disk?.convs?.[h4ConvIdC3] &&
          !d2Disk?.convs?.[h4ConvIdC1] &&
          d2Disk?.convs?.[h4ConvIdC3]?.steps?.['1'],
        `H4 Case C 切换数据目录时旧批次落盘隔离异常：dir1=${JSON.stringify(d1Disk)}, dir2=${JSON.stringify(d2Disk)}`
      );
    } finally {
      for (const t of h4Timers) clearTimeout(t);
      h4Timers.clear();
      delete process.env.ANTIGRAVITY_LS_ADDRESS;
      delete process.env.ANTIGRAVITY_CSRF_TOKEN;
      if (prevH4AgDir === undefined) delete process.env.AG_DIR; else process.env.AG_DIR = prevH4AgDir;
      if (prevH4CliDir === undefined) delete process.env.AG_CLI_DIR; else process.env.AG_CLI_DIR = prevH4CliDir;
      if (prevH4StateDir === undefined) delete process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR; else process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = prevH4StateDir;
      h4Server.closeAllConnections?.();
      await new Promise((r) => h4Server.close(r));
      for (const id of [h4ConvIdA1, h4ConvIdA2, h4ConvIdB1, h4ConvIdB2]) {
        rmSync(join(isolatedAgDir, 'brain', id), { recursive: true, force: true });
      }
      rmSync(h4SwitchDir1, { recursive: true, force: true });
      rmSync(h4SwitchDir2, { recursive: true, force: true });
      rmSync(join(isolatedStateDir, 'gen_step_models_v1.json'), { force: true });
    }

    // I1: Idle RPC elimination, quota resetTime boundary wake, delayed commit settle, cross-process disk cache & redaction
    const i1ConvA = '00000000-0000-4000-8000-000000000301';
    const i1ConvB = '00000000-0000-4000-8000-000000000302';
    const i1ConvC = '00000000-0000-4000-8000-000000000303';
    const i1ConvD = '00000000-0000-4000-8000-000000000304';
    const i1ConvE = '00000000-0000-4000-8000-000000000305';
    const i1ConvF = '00000000-0000-4000-8000-000000000306';
    const i1ConvG = '00000000-0000-4000-8000-000000000307';
    const i1ConvH = '00000000-0000-4000-8000-000000000308';
    const i1ConvI = '00000000-0000-4000-8000-000000000309';
    const i1ConvJ = '00000000-0000-4000-8000-000000000310';
    const i1Csrf = 'i1-ls-csrf-secret-tok';
    const i1ChildCsrf = 'i1-ls-csrf-child-scoped-tok';
    const i1RawEmail = ['i1test', 'example.com'].join('@');
    const i1FakeBearer = ['Bea', 'rer', ' ', 'i1_secret_token_xyz'].join('');
    const i1BaseMs = Date.now();
    const i1ResetIso = new Date(i1BaseMs + 28 * 60_000).toISOString();
    let i1QuotaRemaining = 0.8;
    let i1MetaMode = 'full';
    let i1ConvCMetaMode = 'empty';
    let i1ConvCMetaCalls = 0;
    const i1ConvModes = {};
    const i1ConvCustomList = {};
    const i1ConvMetaCalls = {};
    const i1ConvUsage = {};
    const i1Counts = {
      GetUserStatus: 0,
      RetrieveUserQuotaSummary: 0,
      GetCascadeTrajectoryGeneratorMetadata: 0
    };
    const i1Server = http.createServer((req, res) => {
      let rawBody = '';
      req.on('data', (c) => { rawBody += c; });
      req.on('end', () => {
        const reqCsrf = String(req.headers['x-codeium-csrf-token'] || '');
        if (reqCsrf !== i1Csrf && reqCsrf !== i1ChildCsrf) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end('{"error":"forbidden"}');
          return;
        }
        if (req.url?.includes('GetUserStatus')) {
          i1Counts.GetUserStatus += 1;
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            userStatus: {
              email: i1RawEmail,
              userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
              cascadeModelConfigData: {
                clientModelConfigs: [
                  {
                    label: 'Gemini 3.8 Flash',
                    modelOrAlias: { model: 'MODEL_PLACEHOLDER_M318' },
                    quotaInfo: { poolId: 'i1-flash', remainingFraction: i1QuotaRemaining, resetTime: i1ResetIso }
                  }
                ]
              }
            }
          }));
          return;
        }
        if (req.url?.includes('RetrieveUserQuotaSummary')) {
          i1Counts.RetrieveUserQuotaSummary += 1;
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            groups: [
              {
                groupId: 'i1-flash',
                displayName: 'Gemini Flash Pool',
                modelIds: ['MODEL_PLACEHOLDER_M318'],
                buckets: [{ bucketId: 'i1-flash-5h', window: '5h', remainingFraction: i1QuotaRemaining, resetTime: i1ResetIso }]
              }
            ]
          }));
          return;
        }
        if (req.url?.includes('GetCascadeTrajectoryGeneratorMetadata')) {
          i1Counts.GetCascadeTrajectoryGeneratorMetadata += 1;
          let cascadeId = '';
          try { cascadeId = JSON.parse(rawBody || '{}').cascadeId || ''; } catch {}
          if (cascadeId) {
            i1ConvMetaCalls[cascadeId] = (i1ConvMetaCalls[cascadeId] || 0) + 1;
          }
          if (cascadeId && Array.isArray(i1ConvCustomList[cascadeId])) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ generatorMetadata: i1ConvCustomList[cascadeId] }));
            return;
          }
          const customMode = i1ConvModes[cascadeId];
          if (cascadeId === i1ConvC) {
            i1ConvCMetaCalls += 1;
            if (i1ConvCMetaMode === '503') {
              res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end('{"error":"unavailable"}');
              return;
            }
            if (i1ConvCMetaMode === 'empty') {
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ generatorMetadata: [] }));
              return;
            }
          }
          if (customMode === '503') {
            res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end('{"error":"unavailable"}');
            return;
          }
          if (customMode === 'partial') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
              generatorMetadata: [
                {
                  stepIndices: [2],
                  chatModel: {
                    modelDisplayName: 'Gemini 3.8 Flash',
                    responseModel: 'gemini-3.8-flash'
                  }
                }
              ]
            }));
            return;
          }
          if (cascadeId === i1ConvB && i1MetaMode === 'empty') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ generatorMetadata: [] }));
            return;
          }
          const customUsage = i1ConvUsage[cascadeId] || { input: 2000, output: 200 };
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            generatorMetadata: [
              {
                stepIndices: [2],
                chatModel: {
                  modelDisplayName: 'Gemini 3.8 Flash',
                  responseModel: 'gemini-3.8-flash',
                  usage: { inputTokens: customUsage.input, outputTokens: customUsage.output },
                  timeToFirstToken: '0.4s',
                  streamingDuration: '1.0s',
                  error: cascadeId === i1ConvB ? `upstream failed with ${i1FakeBearer}` : '',
                  chatStartMetadata: {
                    contextWindowMetadata: {
                      maxContextTokens: 200000,
                      estimatedTokensUsed: customUsage.input + customUsage.output,
                      tokenBreakdown: {
                        totalTokens: customUsage.input + customUsage.output,
                        groups: [{ name: 'System Prompt', numTokens: 1200 }]
                      }
                    }
                  }
                }
              }
            ]
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end('{}');
      });
    });
    await new Promise((r) => i1Server.listen(0, '127.0.0.1', r));
    const i1StateDir = join(tmpVerifyRoot, 'i1-state');
    mkdirSync(i1StateDir, { recursive: true });
    const prevI1StateDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
    const prevI1Ls = process.env.ANTIGRAVITY_LS_ADDRESS;
    const prevI1Csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
    try {
      const i1Port = i1Server.address().port;
      const i1LsAddr = `127.0.0.1:${i1Port}`;
      process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = i1StateDir;
      process.env.ANTIGRAVITY_LS_ADDRESS = i1LsAddr;
      process.env.ANTIGRAVITY_CSRF_TOKEN = i1Csrf;

      const writeI1Transcript = (id, mtimeMs, contentSuffix = '', outputTokens = 200) => {
        const d = join(isolatedAgDir, 'brain', id, '.system_generated', 'logs');
        mkdirSync(d, { recursive: true });
        const tp = join(d, 'transcript.jsonl');
        const iso = new Date(mtimeMs).toISOString();
        writeFileSync(
          tp,
          [
            { step_index: 1, type: 'USER_INPUT', created_at: iso, content: `i1 task ${id}` },
            { step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso, input_tokens: 2000, output_tokens: outputTokens, content: `ok${contentSuffix}` }
          ].map((r) => JSON.stringify(r)).join('\n') + '\n',
          'utf-8'
        );
        utimesSync(tp, new Date(mtimeMs), new Date(mtimeMs));
        return statSync(tp).mtimeMs;
      };

      // Case A: Background idle scans at +15s, +30s, +5m, +25m emit ZERO extra LS RPCs
      const mtimeA = writeI1Transcript(i1ConvA, i1BaseMs);
      const tA0 = Math.max(i1BaseMs, mtimeA);
      const snapA0 = await scanConversation(i1ConvA, { background: true, menubarMode: 'context', nowMs: tA0 });
      assert(
        i1Counts.GetUserStatus === 1 &&
          i1Counts.RetrieveUserQuotaSummary === 1 &&
          i1Counts.GetCascadeTrajectoryGeneratorMetadata === 1,
        `I1 Case A 首次扫描应精确触发各 1 次 RPC，实际：${JSON.stringify(i1Counts)}`
      );
      for (const offset of [15_000, 30_000, 5 * 60_000, 25 * 60_000]) {
        const snapIdle = await scanConversation(i1ConvA, {
          background: true,
          menubarMode: 'context',
          nowMs: tA0 + offset
        });
        assert(
          snapIdle.etag === snapA0.etag &&
            i1Counts.GetUserStatus === 1 &&
            i1Counts.RetrieveUserQuotaSummary === 1 &&
            i1Counts.GetCascadeTrajectoryGeneratorMetadata === 1,
          `I1 Case A 空闲 +${offset}ms 竟产生额外 RPC 或 ETag 漂移：counts=${JSON.stringify(i1Counts)}`
        );
      }

      // Case B: Crossing quota resetTime refreshes GetUserStatus + RetrieveUserQuotaSummary once, zero metadata RPCs
      i1QuotaRemaining = 1.0;
      const tResetCross = Date.parse(i1ResetIso) + 5_000;
      const snapReset = await scanConversation(i1ConvA, {
        background: true,
        menubarMode: 'quota',
        nowMs: tResetCross
      });
      assert(
        i1Counts.GetUserStatus === 2 &&
          i1Counts.RetrieveUserQuotaSummary === 2 &&
          i1Counts.GetCascadeTrajectoryGeneratorMetadata === 1 &&
          snapReset.etag !== snapA0.etag &&
          snapReset.quotas?.[0]?.remainingPercent === 100,
        `I1 Case B 跨越 resetTime 未按预期刷新配额：counts=${JSON.stringify(i1Counts)}, q=${JSON.stringify(snapReset.quotas)}`
      );
      await scanConversation(i1ConvA, {
        background: true,
        menubarMode: 'quota',
        nowMs: tResetCross + 30_000
      });
      assert(
        i1Counts.GetUserStatus === 2 &&
          i1Counts.RetrieveUserQuotaSummary === 2 &&
          i1Counts.GetCascadeTrajectoryGeneratorMetadata === 1,
        `I1 Case B 跨越 resetTime 后的下次轮询不应重复请求：counts=${JSON.stringify(i1Counts)}`
      );

      // Case C: Delayed generatorMetadata commit retries after backoff, then settles with 0 subsequent metadata RPCs
      i1MetaMode = 'empty';
      const metaBeforeC = i1Counts.GetCascadeTrajectoryGeneratorMetadata;
      const mtimeB = writeI1Transcript(i1ConvB, tResetCross + 60_000);
      const tB0 = Math.max(tResetCross + 60_000, mtimeB);
      const snapB0 = await scanConversation(i1ConvB, { background: true, nowMs: tB0 });
      assert(
        i1Counts.GetCascadeTrajectoryGeneratorMetadata === metaBeforeC + 1 &&
          snapB0.speed?.isServerExact === false,
        `I1 Case C 延迟提交初始响应应尝试 1 次并回退本地估算：meta=${i1Counts.GetCascadeTrajectoryGeneratorMetadata}`
      );
      await scanConversation(i1ConvB, { background: true, nowMs: tB0 + 1500 });
      assert(
        i1Counts.GetCascadeTrajectoryGeneratorMetadata === metaBeforeC + 1,
        'I1 Case C 退避窗口 1.5s 内不应重复查询 GetCascadeTrajectoryGeneratorMetadata'
      );
      i1MetaMode = 'full';
      const snapBSettled = await scanConversation(i1ConvB, { background: true, nowMs: tB0 + 4500 });
      assert(
        i1Counts.GetCascadeTrajectoryGeneratorMetadata === metaBeforeC + 2 &&
          snapBSettled.speed?.isServerExact === true &&
          snapBSettled.context?.budget === 200000,
        `I1 Case C 4.5s 重试命中后应收敛完整服务端指标：meta=${i1Counts.GetCascadeTrajectoryGeneratorMetadata}, exact=${snapBSettled.speed?.isServerExact}, budget=${snapBSettled.context?.budget}`
      );
      const metaAfterSettle = i1Counts.GetCascadeTrajectoryGeneratorMetadata;
      for (const offset of [10 * 60_000, 25 * 60_000]) {
        await scanConversation(i1ConvB, { background: true, nowMs: tB0 + offset });
      }
      assert(
        i1Counts.GetCascadeTrajectoryGeneratorMetadata === metaAfterSettle,
        `I1 Case C 已收敛对话在 +10m/+25m 不应再发 GetCascadeTrajectoryGeneratorMetadata：before=${metaAfterSettle}, after=${i1Counts.GetCascadeTrajectoryGeneratorMetadata}`
      );

      // Case D: Cross-process cold child (with a different Scoped CSRF & normalized localhost) reuses disk caches with 0 RPCs, redacts secrets, and force:true overwrites the same cache slot
      const i1CollectorUrl = pathToFileURL(join(ROOT, 'sidecars', 'dashboard', 'collector.mjs')).href;
      const runI1Child = (code, envOverrides = {}) => new Promise((resolveChild, rejectChild) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
          env: {
            ...process.env,
            AG_DIR: isolatedAgDir,
            AG_CLI_DIR: isolatedCliDir,
            ANTIGRAVITY_EXECUTABLE_DATA_DIR: i1StateDir,
            ANTIGRAVITY_LS_ADDRESS: i1LsAddr,
            ANTIGRAVITY_CSRF_TOKEN: i1ChildCsrf,
            ...envOverrides
          },
          stdio: ['ignore', 'pipe', 'pipe']
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d.toString('utf-8'); });
        child.stderr.on('data', (d) => { err += d.toString('utf-8'); });
        child.on('error', rejectChild);
        child.on('close', (codeExit) => {
          if (codeExit !== 0) rejectChild(new Error(`I1 child exited ${codeExit}: ${err || out}`));
          else resolveChild(JSON.parse(out.trim()));
        });
      });

      const beforeChildCounts = { ...i1Counts };
      const childCachedOut = await runI1Child(
        `const m = await import(${JSON.stringify(i1CollectorUrl)});
         const s = await m.scanConversation(${JSON.stringify(i1ConvB)}, { background: true, nowMs: ${tB0 + 4500} });
         const h = await m.collectTokenHistory({ background: true, nowMs: ${tB0 + 4500} });
         console.log(JSON.stringify({ etag: s.etag, budget: s.context?.budget, histOk: Boolean(h?.ok) }));`
      );
      assert(
        childCachedOut.etag === snapBSettled.etag &&
          childCachedOut.budget === 200000 &&
          childCachedOut.histOk === true &&
          i1Counts.GetUserStatus === beforeChildCounts.GetUserStatus &&
          i1Counts.RetrieveUserQuotaSummary === beforeChildCounts.RetrieveUserQuotaSummary &&
          i1Counts.GetCascadeTrajectoryGeneratorMetadata === beforeChildCounts.GetCascadeTrajectoryGeneratorMetadata,
        `I1 Case D 不同 CSRF 跨进程冷启动未零 RPC 命中磁盘缓存：out=${JSON.stringify(childCachedOut)}, before=${JSON.stringify(beforeChildCounts)}, after=${JSON.stringify(i1Counts)}`
      );

      const childLocalhostOut = await runI1Child(
        `const m = await import(${JSON.stringify(i1CollectorUrl)});
         const s = await m.scanConversation(${JSON.stringify(i1ConvB)}, { background: true, nowMs: ${tB0 + 4500} });
         console.log(JSON.stringify({ etag: s.etag, budget: s.context?.budget }));`,
        {
          ANTIGRAVITY_LS_ADDRESS: `localhost:${i1Port}`,
          ANTIGRAVITY_CSRF_TOKEN: i1ChildCsrf
        }
      );
      assert(
        childLocalhostOut.etag === snapBSettled.etag &&
          childLocalhostOut.budget === 200000 &&
          i1Counts.GetUserStatus === beforeChildCounts.GetUserStatus &&
          i1Counts.RetrieveUserQuotaSummary === beforeChildCounts.RetrieveUserQuotaSummary &&
          i1Counts.GetCascadeTrajectoryGeneratorMetadata === beforeChildCounts.GetCascadeTrajectoryGeneratorMetadata,
        `I1 Case D localhost 规范化地址冷启动未零 RPC 命中磁盘缓存：out=${JSON.stringify(childLocalhostOut)}, before=${JSON.stringify(beforeChildCounts)}, after=${JSON.stringify(i1Counts)}`
      );

      const hostDiskFile = join(i1StateDir, 'host_status_cache_v1.json');
      const convDiskFile = join(i1StateDir, 'active_conv_gen_cache_v1.json');
      assert(existsSync(hostDiskFile) && existsSync(convDiskFile), 'I1 Case D 共享磁盘缓存文件未生成');
      const hostDiskRaw = readFileSync(hostDiskFile, 'utf-8');
      const convDiskRaw = readFileSync(convDiskFile, 'utf-8');
      for (const forbidden of [i1Csrf, i1ChildCsrf, i1LsAddr, `localhost:${i1Port}`, i1RawEmail, 'i1_secret_token_xyz']) {
        assert(!hostDiskRaw.includes(forbidden), `I1 host_status_cache_v1.json 泄露敏感字段: ${forbidden}`);
        assert(!convDiskRaw.includes(forbidden), `I1 active_conv_gen_cache_v1.json 泄露敏感字段: ${forbidden}`);
      }
      const hostEntriesKeys = Object.keys(JSON.parse(hostDiskRaw).entries || {});
      const convHashBefore = JSON.parse(convDiskRaw).convs?.[i1ConvB]?.lsKeyHash || '';
      assert(
        hostEntriesKeys.length === 1 && /^ls_[0-9a-f]{16}$/.test(convHashBefore),
        `I1 Case D 磁盘缓存哈希槽结构异常：hostKeys=${JSON.stringify(hostEntriesKeys)}, convHash=${convHashBefore}`
      );

      await runI1Child(
        `const m = await import(${JSON.stringify(i1CollectorUrl)});
         await m.scanConversation(${JSON.stringify(i1ConvB)}, { force: true });
         console.log('{"forced":true}');`
      );
      assert(
        i1Counts.GetUserStatus === beforeChildCounts.GetUserStatus + 1 &&
          i1Counts.RetrieveUserQuotaSummary === beforeChildCounts.RetrieveUserQuotaSummary + 1 &&
          i1Counts.GetCascadeTrajectoryGeneratorMetadata === beforeChildCounts.GetCascadeTrajectoryGeneratorMetadata + 1,
        `I1 Case D force:true 必须穿透所有缓存直连 LS：before=${JSON.stringify(beforeChildCounts)}, after=${JSON.stringify(i1Counts)}`
      );
      const hostDiskAfterRaw = readFileSync(hostDiskFile, 'utf-8');
      const convDiskAfterRaw = readFileSync(convDiskFile, 'utf-8');
      const hostKeysAfter = Object.keys(JSON.parse(hostDiskAfterRaw).entries || {});
      const convHashAfter = JSON.parse(convDiskAfterRaw).convs?.[i1ConvB]?.lsKeyHash || '';
      assert(
        hostKeysAfter.length === 1 &&
          hostKeysAfter[0] === hostEntriesKeys[0] &&
          convHashAfter === convHashBefore &&
          !hostDiskAfterRaw.includes(i1ChildCsrf) &&
          !convDiskAfterRaw.includes(i1ChildCsrf),
        `I1 Case D 子进程 force:true 应同槽覆盖而非分裂新 CSRF 键：before=${hostEntriesKeys[0]}/${convHashBefore}, after=${JSON.stringify(hostKeysAfter)}/${convHashAfter}`
      );

      // Case E: collectTokenHistory lsGenMissCache settles quiet files >= 180s on clean LS responses, binds normalized lsAddr, and wakes on force or file change
      const tE0 = Date.parse(i1ResetIso) + 10 * 60_000;
      const mtimeC = writeI1Transcript(i1ConvC, tE0);
      i1ConvCMetaMode = 'empty';
      i1ConvCMetaCalls = 0;

      await collectTokenHistory({ background: true, nowMs: mtimeC + 10_000 });
      assert(
        i1ConvCMetaCalls === 1,
        `I1 Case E 首次缺模型历史扫描应触发 1 次 metadata RPC，实际：${i1ConvCMetaCalls}`
      );
      await collectTokenHistory({ background: true, nowMs: mtimeC + 35_000 });
      assert(
        i1ConvCMetaCalls === 1,
        `I1 Case E 60s miss TTL 内不应重查：calls=${i1ConvCMetaCalls}`
      );
      await collectTokenHistory({ background: true, nowMs: mtimeC + 75_000 });
      assert(
        i1ConvCMetaCalls === 2,
        `I1 Case E 年轻文件 (<180s) 过 60s TTL 后应重试 1 次：calls=${i1ConvCMetaCalls}`
      );

      i1ConvCMetaMode = '503';
      await collectTokenHistory({ background: true, nowMs: mtimeC + 190_000 });
      assert(
        i1ConvCMetaCalls === 3,
        `I1 Case E 过 TTL 后应触发第 3 次查询（返回 503）：calls=${i1ConvCMetaCalls}`
      );

      i1ConvCMetaMode = 'empty';
      await collectTokenHistory({ background: true, nowMs: mtimeC + 260_000 });
      assert(
        i1ConvCMetaCalls === 4,
        `I1 Case E 此前 503 失败不应误收敛，应继续查询并在此轮（>=180s 正常响应）收敛：calls=${i1ConvCMetaCalls}`
      );

      await collectTokenHistory({ background: true, nowMs: mtimeC + 330_000 });
      await collectTokenHistory({ background: true, nowMs: mtimeC + 480_000 });
      assert(
        i1ConvCMetaCalls === 4,
        `I1 Case E 已静默收敛会话在 +330s/+480s 不应再发 metadata RPC：calls=${i1ConvCMetaCalls}`
      );

      process.env.ANTIGRAVITY_CSRF_TOKEN = i1ChildCsrf;
      process.env.ANTIGRAVITY_LS_ADDRESS = `localhost:${i1Port}`;
      await collectTokenHistory({ background: true, nowMs: mtimeC + 600_000 });
      assert(
        i1ConvCMetaCalls === 4,
        `I1 Case E 切换 CSRF 与 localhost 后 lsGenMissCache 仍应命中已收敛条目：calls=${i1ConvCMetaCalls}`
      );

      await collectTokenHistory({ force: true, nowMs: mtimeC + 610_000 });
      assert(
        i1ConvCMetaCalls === 5,
        `I1 Case E force:true 必须穿透已收敛的 lsGenMissCache：calls=${i1ConvCMetaCalls}`
      );

      process.env.ANTIGRAVITY_LS_ADDRESS = i1LsAddr;
      process.env.ANTIGRAVITY_CSRF_TOKEN = i1Csrf;
      i1ConvCMetaMode = 'full';
      writeI1Transcript(i1ConvC, mtimeC + 620_000, ' updated');
      await collectTokenHistory({ background: true, nowMs: mtimeC + 680_000 });
      assert(
        i1ConvCMetaCalls === 6,
        `I1 Case E 文件 (size, mtimeMs) 变更后应打破静默收敛并补齐模型：calls=${i1ConvCMetaCalls}`
      );

      // Case F (Z1): Failed metadata RPC on quiet (>=180s) session must NOT write settled empty cache and must auto-recover
      const tF0 = mtimeC + 720_000;
      writeI1Transcript(i1ConvD, tF0 - 300_000);
      i1ConvModes[i1ConvD] = '503';
      i1ConvMetaCalls[i1ConvD] = 0;
      const snapDFail = await scanConversation(i1ConvD, { background: true, nowMs: tF0 });
      const diskAfterDFail = existsSync(convDiskFile) ? JSON.parse(readFileSync(convDiskFile, 'utf-8')) : { convs: {} };
      assert(
        i1ConvMetaCalls[i1ConvD] === 1 &&
          snapDFail.context?.budget === null &&
          snapDFail.speed?.isServerExact === false &&
          !diskAfterDFail.convs?.[i1ConvD]?.settled,
        `I1 Case F (Z1) 503 失败不得写入已收敛空缓存：calls=${i1ConvMetaCalls[i1ConvD]}, entry=${JSON.stringify(diskAfterDFail.convs?.[i1ConvD])}`
      );

      i1ConvModes[i1ConvD] = 'full';
      const snapDRecovered = await scanConversation(i1ConvD, { background: true, nowMs: tF0 + 20_000 });
      const diskAfterDRec = JSON.parse(readFileSync(convDiskFile, 'utf-8'));
      assert(
        i1ConvMetaCalls[i1ConvD] === 2 &&
          snapDRecovered.context?.budget === 200000 &&
          snapDRecovered.context?.inputTokens === 2000 &&
          snapDRecovered.context?.outputTokens === 200 &&
          snapDRecovered.speed?.isServerExact === true &&
          diskAfterDRec.convs?.[i1ConvD]?.settled === true,
        `I1 Case F (Z1) 宿主恢复后常规扫描应自动补齐并收敛：calls=${i1ConvMetaCalls[i1ConvD]}, budget=${snapDRecovered.context?.budget}, exact=${snapDRecovered.speed?.isServerExact}`
      );
      const coldDOut = await runI1Child(
        `const m = await import(${JSON.stringify(i1CollectorUrl)});
         const s = await m.scanConversation(${JSON.stringify(i1ConvD)}, { background: true, nowMs: ${tF0 + 21_000} });
         console.log(JSON.stringify({ budget: s.context?.budget, exact: s.speed?.isServerExact, output: s.context?.outputTokens }));`
      );
      assert(
        i1ConvMetaCalls[i1ConvD] === 2 &&
          coldDOut.budget === 200000 &&
          coldDOut.exact === true &&
          coldDOut.output === 200,
        `I1 Case F (Z1) 冷子进程应零 RPC 读取恢复后的收敛缓存：calls=${i1ConvMetaCalls[i1ConvD]}, out=${JSON.stringify(coldDOut)}`
      );

      // Case G (Z2): Model-only partial metadata preserves local non-zero tokens, marks isServerExact:false, and retries until full metrics settle
      const tG0 = writeI1Transcript(i1ConvE, tF0 + 30_000);
      i1ConvModes[i1ConvE] = 'partial';
      i1ConvMetaCalls[i1ConvE] = 0;
      const snapEPartial = await scanConversation(i1ConvE, { background: true, nowMs: tG0 });
      const diskAfterEPartial = JSON.parse(readFileSync(convDiskFile, 'utf-8'));
      assert(
        i1ConvMetaCalls[i1ConvE] === 1 &&
          snapEPartial.context?.inputTokens === 2000 &&
          snapEPartial.context?.outputTokens === 200 &&
          snapEPartial.context?.budget === null &&
          snapEPartial.speed?.isServerExact === false &&
          diskAfterEPartial.convs?.[i1ConvE]?.settled === false,
        `I1 Case G (Z2) 部分响应应保留本地用量、不标精确且不收敛：calls=${i1ConvMetaCalls[i1ConvE]}, ctx=${JSON.stringify(snapEPartial.context)}, exact=${snapEPartial.speed?.isServerExact}, disk=${JSON.stringify(diskAfterEPartial.convs?.[i1ConvE]?.settled)}`
      );

      i1ConvModes[i1ConvE] = 'full';
      const snapEFull = await scanConversation(i1ConvE, { background: true, nowMs: tG0 + 20_000 });
      const diskAfterEFull = JSON.parse(readFileSync(convDiskFile, 'utf-8'));
      assert(
        i1ConvMetaCalls[i1ConvE] === 2 &&
          snapEFull.context?.budget === 200000 &&
          snapEFull.context?.inputTokens === 2000 &&
          snapEFull.context?.outputTokens === 200 &&
          snapEFull.speed?.isServerExact === true &&
          diskAfterEFull.convs?.[i1ConvE]?.settled === true,
        `I1 Case G (Z2) 宿主补齐后常规扫描应更新为精确完整指标并收敛：calls=${i1ConvMetaCalls[i1ConvE]}, ctx=${JSON.stringify(snapEFull.context)}`
      );
      const coldEOut = await runI1Child(
        `const m = await import(${JSON.stringify(i1CollectorUrl)});
         const s = await m.scanConversation(${JSON.stringify(i1ConvE)}, { background: true, nowMs: ${tG0 + 21_000} });
         console.log(JSON.stringify({ budget: s.context?.budget, exact: s.speed?.isServerExact, output: s.context?.outputTokens }));`
      );
      assert(
        i1ConvMetaCalls[i1ConvE] === 2 &&
          coldEOut.budget === 200000 &&
          coldEOut.exact === true &&
          coldEOut.output === 200,
        `I1 Case G (Z2) 冷子进程应零 RPC 读取补齐后收敛缓存：calls=${i1ConvMetaCalls[i1ConvE]}, out=${JSON.stringify(coldEOut)}`
      );

      // Case H (Z3): In-place update on same step_index invalidates in-memory convGenMetaCache even inside 15s TTL while staying 0-RPC when unchanged
      const tH0 = writeI1Transcript(i1ConvF, tG0 + 30_000);
      i1ConvModes[i1ConvF] = 'full';
      i1ConvUsage[i1ConvF] = { input: 2000, output: 200 };
      i1ConvMetaCalls[i1ConvF] = 0;
      const snapF0 = await scanConversation(i1ConvF, { background: true, nowMs: tH0 });
      assert(
        i1ConvMetaCalls[i1ConvF] === 1 &&
          snapF0.context?.inputTokens === 2000 &&
          snapF0.context?.outputTokens === 200,
        `I1 Case H (Z3) 初始收敛异常：calls=${i1ConvMetaCalls[i1ConvF]}, ctx=${JSON.stringify(snapF0.context)}`
      );

      // Unchanged file within & beyond 15s keeps 0 extra RPCs
      await scanConversation(i1ConvF, { background: true, nowMs: tH0 + 2_000 });
      assert(i1ConvMetaCalls[i1ConvF] === 1, 'I1 Case H (Z3) 未变更文件不应重复请求 metadata');

      // Update same step_index=2 in place -> triggers refresh even within 15s window (tH0 + 3000)
      i1ConvUsage[i1ConvF] = { input: 6000, output: 300 };
      writeI1Transcript(i1ConvF, tH0 + 1_000, ' step2-updated', 300);
      const snapFUpdated = await scanConversation(i1ConvF, { background: true, nowMs: tH0 + 3_000 });
      assert(
        i1ConvMetaCalls[i1ConvF] === 2 &&
          snapFUpdated.context?.inputTokens === 6000 &&
          snapFUpdated.context?.outputTokens === 300,
        `I1 Case H (Z3) 同一步骤日志更新后内存缓存未失效：calls=${i1ConvMetaCalls[i1ConvF]}, input=${snapFUpdated.context?.inputTokens}, output=${snapFUpdated.context?.outputTokens}`
      );
      await scanConversation(i1ConvF, { background: true, nowMs: tH0 + 20_000 });
      const coldFOut = await runI1Child(
        `const m = await import(${JSON.stringify(i1CollectorUrl)});
         const s = await m.scanConversation(${JSON.stringify(i1ConvF)}, { background: true, nowMs: ${tH0 + 21_000} });
         console.log(JSON.stringify({ input: s.context?.inputTokens, output: s.context?.outputTokens, budget: s.context?.budget }));`
      );
      assert(
        i1ConvMetaCalls[i1ConvF] === 2 &&
          coldFOut.input === 6000 &&
          coldFOut.output === 300 &&
          coldFOut.budget === 200000,
        `I1 Case H (Z3) 更新后静默零额外 RPC 且与冷子进程一致：calls=${i1ConvMetaCalls[i1ConvF]}, cold=${JSON.stringify(coldFOut)}`
      );

      // Case I (AA1): Partial generatorMetadata missing older OR newer steps still preserves chronological turn order, deltaTokens, sessionTotals & latestTurn
      const makeFullMetaEntry = (stepIndices, input, output, sysTokens = 1200) => ({
        stepIndices: Array.isArray(stepIndices) ? stepIndices : [stepIndices],
        chatModel: {
          modelDisplayName: 'Gemini 3.8 Flash',
          responseModel: 'gemini-3.8-flash',
          usage: { inputTokens: input, outputTokens: output },
          timeToFirstToken: '0.4s',
          streamingDuration: '1.0s',
          chatStartMetadata: {
            contextWindowMetadata: {
              maxContextTokens: 200000,
              estimatedTokensUsed: input + output,
              tokenBreakdown: {
                totalTokens: input + output,
                groups: [{ name: 'System Prompt', numTokens: sysTokens }]
              }
            }
          }
        }
      });
      const writeMultiTurnTranscript = (id, mtimeMs, turnSpecs) => {
        const d = join(isolatedAgDir, 'brain', id, '.system_generated', 'logs');
        mkdirSync(d, { recursive: true });
        const tp = join(d, 'transcript.jsonl');
        const rows = [
          { step_index: 1, type: 'USER_INPUT', created_at: new Date(mtimeMs - (turnSpecs.length + 1) * 1000).toISOString(), content: `i1 multi task ${id}` }
        ];
        turnSpecs.forEach((spec, idx) => {
          rows.push({
            step_index: spec.stepIndex,
            type: 'PLANNER_RESPONSE',
            status: 'DONE',
            created_at: new Date(mtimeMs - (turnSpecs.length - idx) * 1000).toISOString(),
            input_tokens: spec.input,
            output_tokens: spec.output,
            model: 'gemini-3.8-flash',
            content: `synthetic turn ${spec.stepIndex}`
          });
        });
        writeFileSync(tp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
        utimesSync(tp, new Date(mtimeMs), new Date(mtimeMs));
        return statSync(tp).mtimeMs;
      };
      const assertOrderSnapshot = (snap, expectedExact, expectedSettled, label) => {
        const convDiskSnapshot = existsSync(convDiskFile) ? JSON.parse(readFileSync(convDiskFile, 'utf-8')).convs?.[i1ConvG] : null;
        assert(
          snap.context?.inputTokens === 6000 &&
            snap.context?.outputTokens === 300 &&
            snap.context?.budget === 200000 &&
            snap.context?.sessionTotals?.totalTokens === 8500 &&
            JSON.stringify(snap.turns?.map((t) => t.stepIndex)) === '[3,2]' &&
            JSON.stringify(snap.turns?.map((t) => t.turnIndex)) === '[2,1]' &&
            JSON.stringify(snap.turns?.map((t) => t.deltaTokens)) === '[4100,2200]' &&
            JSON.stringify(snap.sparkline?.map((p) => p.delta)) === '[2200,4100]' &&
            snap.speed?.isServerExact === expectedExact &&
            Boolean(convDiskSnapshot?.settled) === expectedSettled,
          `I1 Case I (${label}) 轮次排序或指标异常：ctx=${JSON.stringify(snap.context)}, speedExact=${snap.speed?.isServerExact}, turns=${JSON.stringify(snap.turns)}, sparkline=${JSON.stringify(snap.sparkline)}, diskSettled=${convDiskSnapshot?.settled}`
        );
      };

      const twoTurnSpecs = [
        { stepIndex: 2, input: 2000, output: 200 },
        { stepIndex: 3, input: 6000, output: 300 }
      ];
      const tI0 = writeMultiTurnTranscript(i1ConvG, tH0 + 30_000, twoTurnSpecs);
      i1ConvCustomList[i1ConvG] = [makeFullMetaEntry(3, 6000, 300)];
      const snapGMissingOld = await scanConversation(i1ConvG, { force: true, nowMs: tI0 });
      assertOrderSnapshot(snapGMissingOld, true, false, '仅缺旧轮次');
      assert(
        snapGMissingOld.context?.breakdown?.groups?.[0]?.tokens === 1200,
        `I1 Case I (仅缺旧轮次) 应保留最新服务端轮次的 contextBreakdown：${JSON.stringify(snapGMissingOld.context?.breakdown)}`
      );

      const tI1 = writeMultiTurnTranscript(i1ConvG, tI0 + 2000, twoTurnSpecs);
      i1ConvCustomList[i1ConvG] = [makeFullMetaEntry(2, 2000, 200)];
      const snapGMissingNew = await scanConversation(i1ConvG, { force: true, nowMs: tI1 });
      assertOrderSnapshot(snapGMissingNew, false, false, '仅缺最新轮次');
      assert(
        snapGMissingNew.context?.breakdown === null,
        `I1 Case I (仅缺最新轮次) 最新轮次为本地估算时 contextBreakdown 应为 null：${JSON.stringify(snapGMissingNew.context?.breakdown)}`
      );

      const tI2 = writeMultiTurnTranscript(i1ConvG, tI0 + 4000, twoTurnSpecs);
      i1ConvCustomList[i1ConvG] = [makeFullMetaEntry(2, 2000, 200), makeFullMetaEntry(3, 6000, 300)];
      const snapGFull = await scanConversation(i1ConvG, { force: true, nowMs: tI2 });
      assertOrderSnapshot(snapGFull, true, true, '完整对照');
      assert(
        snapGFull.context?.breakdown?.groups?.[0]?.tokens === 1200,
        `I1 Case I (完整对照) contextBreakdown 缺失：${JSON.stringify(snapGFull.context?.breakdown)}`
      );

      const multiStepSpecs = [
        { stepIndex: 2, input: 1500, output: 100 },
        { stepIndex: 3, input: 2000, output: 150 },
        { stepIndex: 4, input: 5000, output: 280 },
        { stepIndex: 5, input: 8000, output: 400 }
      ];
      const tI3 = writeMultiTurnTranscript(i1ConvG, tI0 + 6000, multiStepSpecs);
      i1ConvCustomList[i1ConvG] = [makeFullMetaEntry([2, 3], 3500, 250), makeFullMetaEntry(5, 8000, 400)];
      const snapGMulti = await scanConversation(i1ConvG, { force: true, nowMs: tI3 });
      assert(
        JSON.stringify(snapGMulti.turns?.map((t) => t.stepIndex)) === '[5,4,2]' &&
          JSON.stringify(snapGMulti.turns?.map((t) => t.turnIndex)) === '[3,2,1]' &&
          snapGMulti.context?.inputTokens === 8000 &&
          snapGMulti.context?.outputTokens === 400 &&
          snapGMulti.speed?.isServerExact === true &&
          snapGMulti.context?.sessionTotals?.totalTokens === 17430,
        `I1 Case I (多步骤 stepIndices 映射) 顺序或合计异常：turns=${JSON.stringify(snapGMulti.turns)}, ctx=${JSON.stringify(snapGMulti.context)}`
      );

      // Case J (AA2): Complete metrics -> model-only partial force refresh -> LS recovery -> fresh module & cold child reads preserve complete metrics, plus legacy degraded settled disk self-heal
      const tJ0 = writeI1Transcript(i1ConvH, tI3 + 10_000);
      i1ConvCustomList[i1ConvH] = [makeFullMetaEntry(2, 6000, 300)];
      i1ConvMetaCalls[i1ConvH] = 0;
      const snapHFull = await scanConversation(i1ConvH, { force: true, nowMs: tJ0 });
      const diskAfterH1 = JSON.parse(readFileSync(convDiskFile, 'utf-8')).convs?.[i1ConvH];
      assert(
        i1ConvMetaCalls[i1ConvH] === 1 &&
          snapHFull.context?.inputTokens === 6000 &&
          snapHFull.context?.outputTokens === 300 &&
          snapHFull.context?.budget === 200000 &&
          snapHFull.speed?.isServerExact === true &&
          snapHFull.context?.sessionTotals?.totalTokens === 6300 &&
          diskAfterH1?.settled === true &&
          diskAfterH1?.generatorList?.[0]?.chatModel?.usage?.outputTokens === 300,
        `I1 Case J (AA2) 初始完整响应异常：calls=${i1ConvMetaCalls[i1ConvH]}, ctx=${JSON.stringify(snapHFull.context)}, disk=${JSON.stringify(diskAfterH1)}`
      );

      i1ConvCustomList[i1ConvH] = [
        { stepIndices: [2], chatModel: { modelDisplayName: 'Gemini 3.8 Flash', responseModel: 'gemini-3.8-flash' } }
      ];
      const snapHPartialForce = await scanConversation(i1ConvH, { force: true, nowMs: tJ0 + 1000 });
      const diskAfterH2 = JSON.parse(readFileSync(convDiskFile, 'utf-8')).convs?.[i1ConvH];
      assert(
        i1ConvMetaCalls[i1ConvH] === 2 &&
          snapHPartialForce.context?.inputTokens === 6000 &&
          snapHPartialForce.context?.outputTokens === 300 &&
          snapHPartialForce.context?.budget === 200000 &&
          snapHPartialForce.speed?.isServerExact === true &&
          snapHPartialForce.context?.sessionTotals?.totalTokens === 6300 &&
          diskAfterH2?.settled === true &&
          diskAfterH2?.generatorList?.[0]?.chatModel?.usage?.outputTokens === 300,
        `I1 Case J (AA2) 同签名部分强刷不得覆盖完整指标或落盘退化载荷：calls=${i1ConvMetaCalls[i1ConvH]}, ctx=${JSON.stringify(snapHPartialForce.context)}, disk=${JSON.stringify(diskAfterH2)}`
      );

      const childHPartialForce = await runI1Child(
        `const m = await import(${JSON.stringify(i1CollectorUrl)});
         const s = await m.scanConversation(${JSON.stringify(i1ConvH)}, { force: true, nowMs: ${tJ0 + 1500} });
         console.log(JSON.stringify({ input: s.context?.inputTokens, output: s.context?.outputTokens, budget: s.context?.budget, exact: s.speed?.isServerExact, total: s.context?.sessionTotals?.totalTokens }));`
      );
      const diskAfterH2Child = JSON.parse(readFileSync(convDiskFile, 'utf-8')).convs?.[i1ConvH];
      assert(
        i1ConvMetaCalls[i1ConvH] === 3 &&
          childHPartialForce.input === 6000 &&
          childHPartialForce.output === 300 &&
          childHPartialForce.budget === 200000 &&
          childHPartialForce.exact === true &&
          childHPartialForce.total === 6300 &&
          diskAfterH2Child?.settled === true &&
          diskAfterH2Child?.generatorList?.[0]?.chatModel?.usage?.outputTokens === 300,
        `I1 Case J (AA2) 冷子进程部分强刷也应保留磁盘完整指标：calls=${i1ConvMetaCalls[i1ConvH]}, out=${JSON.stringify(childHPartialForce)}`
      );

      i1ConvCustomList[i1ConvH] = [makeFullMetaEntry(2, 6000, 300)];
      const freshCollectorMod = await import(`${i1CollectorUrl}?aa2-fresh=${Date.now()}`);
      const freshHSnap = await freshCollectorMod.scanConversation(i1ConvH, { background: true, nowMs: tJ0 + 2000 });
      const coldHRegular = await runI1Child(
        `const m = await import(${JSON.stringify(i1CollectorUrl)});
         const s = await m.scanConversation(${JSON.stringify(i1ConvH)}, { background: true, nowMs: ${tJ0 + 2500} });
         console.log(JSON.stringify({ input: s.context?.inputTokens, output: s.context?.outputTokens, budget: s.context?.budget, exact: s.speed?.isServerExact }));`
      );
      assert(
        i1ConvMetaCalls[i1ConvH] === 3 &&
          freshHSnap.context?.inputTokens === 6000 &&
          freshHSnap.context?.outputTokens === 300 &&
          freshHSnap.context?.budget === 200000 &&
          freshHSnap.speed?.isServerExact === true &&
          coldHRegular.input === 6000 &&
          coldHRegular.output === 300 &&
          coldHRegular.budget === 200000 &&
          coldHRegular.exact === true,
        `I1 Case J (AA2) 新模块与冷子进程常规读取应零额外 RPC 保留完整指标：calls=${i1ConvMetaCalls[i1ConvH]}, fresh=${JSON.stringify(freshHSnap.context)}, cold=${JSON.stringify(coldHRegular)}`
      );

      const corruptedDiskPayload = JSON.parse(readFileSync(convDiskFile, 'utf-8'));
      corruptedDiskPayload.convs[i1ConvH] = {
        ...corruptedDiskPayload.convs[i1ConvH],
        settled: true,
        generatorList: [{ stepIndices: [2], chatModel: { modelDisplayName: 'Gemini 3.8 Flash', responseModel: 'gemini-3.8-flash' } }]
      };
      writeFileSync(convDiskFile, JSON.stringify(corruptedDiskPayload, null, 2), 'utf-8');
      const healedColdH = await runI1Child(
        `const m = await import(${JSON.stringify(i1CollectorUrl)});
         const s = await m.scanConversation(${JSON.stringify(i1ConvH)}, { background: true, nowMs: ${tJ0 + 3000} });
         console.log(JSON.stringify({ input: s.context?.inputTokens, output: s.context?.outputTokens, budget: s.context?.budget, exact: s.speed?.isServerExact }));`
      );
      const diskAfterHeal = JSON.parse(readFileSync(convDiskFile, 'utf-8')).convs?.[i1ConvH];
      assert(
        i1ConvMetaCalls[i1ConvH] === 4 &&
          healedColdH.input === 6000 &&
          healedColdH.output === 300 &&
          healedColdH.budget === 200000 &&
          healedColdH.exact === true &&
          diskAfterHeal?.settled === true &&
          diskAfterHeal?.generatorList?.[0]?.chatModel?.usage?.outputTokens === 300,
        `I1 Case J (AA2) 遗留退化磁盘 settled 缓存未自愈恢复：calls=${i1ConvMetaCalls[i1ConvH]}, healed=${JSON.stringify(healedColdH)}, disk=${JSON.stringify(diskAfterHeal)}`
      );

      // Case K (AB1): Non-chronological generatorMetadata retains latest turn's tokenBreakdown identically across warm, fresh-module & cold-child reads
      const verifyAb1WarmFreshCold = async (convId, nowTs, expectedSysTokens, expectedStepsOrder, expectedTotal, label) => {
        i1ConvMetaCalls[convId] = 0;
        const warmSnap = await scanConversation(convId, { force: true, nowMs: nowTs });
        const diskEntry = JSON.parse(readFileSync(convDiskFile, 'utf-8')).convs?.[convId];
        const callsAfterWarm = i1ConvMetaCalls[convId];
        const freshMod = await import(`${i1CollectorUrl}?ab1=${convId}-${nowTs}`);
        const freshSnap = await freshMod.scanConversation(convId, { background: true, nowMs: nowTs + 200 });
        const coldOut = await runI1Child(
          `const m = await import(${JSON.stringify(i1CollectorUrl)});
           const s = await m.scanConversation(${JSON.stringify(convId)}, { background: true, nowMs: ${nowTs + 400} });
           console.log(JSON.stringify({ input: s.context?.inputTokens, output: s.context?.outputTokens, budget: s.context?.budget, total: s.context?.sessionTotals?.totalTokens, steps: s.turns?.map(t => t.stepIndex), breakdown: s.context?.breakdown }));`
        );
        const breakdownFlags = (diskEntry?.generatorList || []).map(
          (e) => Boolean(e?.chatModel?.chatStartMetadata?.contextWindowMetadata?.tokenBreakdown)
        );
        assert(
          callsAfterWarm === 1 &&
            i1ConvMetaCalls[convId] === 1 &&
            warmSnap.context?.breakdown?.groups?.[0]?.tokens === expectedSysTokens &&
            freshSnap.context?.breakdown?.groups?.[0]?.tokens === expectedSysTokens &&
            coldOut.breakdown?.groups?.[0]?.tokens === expectedSysTokens &&
            JSON.stringify(warmSnap.context?.breakdown) === JSON.stringify(coldOut.breakdown) &&
            coldOut.input === 6000 &&
            coldOut.output === 300 &&
            coldOut.budget === 200000 &&
            coldOut.total === expectedTotal &&
            JSON.stringify(warmSnap.turns?.map((t) => t.stepIndex)) === expectedStepsOrder &&
            JSON.stringify(coldOut.steps) === expectedStepsOrder &&
            diskEntry?.settled === true &&
            breakdownFlags.filter(Boolean).length === 1 &&
            breakdownFlags[breakdownFlags.length - 1] === true,
          `I1 Case K (${label}) AB1 暖/冷分组明细或缓存一致性失败：calls=${i1ConvMetaCalls[convId]}, warm=${warmSnap.context?.breakdown?.groups?.[0]?.tokens}, fresh=${freshSnap.context?.breakdown?.groups?.[0]?.tokens}, cold=${JSON.stringify(coldOut)}, breakdownFlags=${JSON.stringify(breakdownFlags)}`
        );
        return { warmSnap, coldOut };
      };

      const tK0 = writeMultiTurnTranscript(i1ConvI, tJ0 + 10_000, twoTurnSpecs);
      i1ConvCustomList[i1ConvI] = [
        makeFullMetaEntry(3, 6000, 300, 1600),
        makeFullMetaEntry(2, 2000, 200, 1200)
      ];
      const { coldOut: ab1ReversedCold } = await verifyAb1WarmFreshCold(i1ConvI, tK0, 1600, '[3,2]', 8500, '完整倒序');

      const tK1 = writeMultiTurnTranscript(i1ConvI, tK0 + 2000, twoTurnSpecs);
      i1ConvCustomList[i1ConvI] = [
        makeFullMetaEntry(2, 2000, 200, 1200),
        makeFullMetaEntry(3, 6000, 300, 1600)
      ];
      const { coldOut: ab1OrderedCold } = await verifyAb1WarmFreshCold(i1ConvI, tK1, 1600, '[3,2]', 8500, '完整顺序对照');
      assert(
        JSON.stringify(ab1ReversedCold.breakdown) === JSON.stringify(ab1OrderedCold.breakdown),
        'I1 Case K 倒序与顺序对照冷读取 breakdown 不一致'
      );

      // K.2: Partial [step 2] -> retry completion with reversed [step 3, step 2] -> fresh/cold reads retain breakdown=1600 with 0 extra RPCs
      const tK2 = writeMultiTurnTranscript(i1ConvI, tK1 + 2000, twoTurnSpecs);
      i1ConvMetaCalls[i1ConvI] = 0;
      i1ConvCustomList[i1ConvI] = [makeFullMetaEntry(2, 2000, 200, 1200)];
      await scanConversation(i1ConvI, { background: true, nowMs: tK2 });
      i1ConvCustomList[i1ConvI] = [
        makeFullMetaEntry(3, 6000, 300, 1600),
        makeFullMetaEntry(2, 2000, 200, 1200)
      ];
      const k2RetryWarm = await scanConversation(i1ConvI, { background: true, nowMs: tK2 + 4500 });
      const k2Fresh = await (await import(`${i1CollectorUrl}?ab1-k2=${Date.now()}`)).scanConversation(i1ConvI, { background: true, nowMs: tK2 + 4700 });
      const k2Cold = await runI1Child(
        `const m = await import(${JSON.stringify(i1CollectorUrl)});
         const s = await m.scanConversation(${JSON.stringify(i1ConvI)}, { background: true, nowMs: ${tK2 + 4900} });
         console.log(JSON.stringify({ breakdown: s.context?.breakdown, steps: s.turns?.map(t => t.stepIndex) }));`
      );
      assert(
        i1ConvMetaCalls[i1ConvI] === 2 &&
          k2RetryWarm.context?.breakdown?.groups?.[0]?.tokens === 1600 &&
          k2Fresh.context?.breakdown?.groups?.[0]?.tokens === 1600 &&
          k2Cold.breakdown?.groups?.[0]?.tokens === 1600 &&
          JSON.stringify(k2Cold.steps) === '[3,2]',
        `I1 Case K (部分补齐倒序恢复) 失败：calls=${i1ConvMetaCalls[i1ConvI]}, warm=${k2RetryWarm.context?.breakdown?.groups?.[0]?.tokens}, fresh=${k2Fresh.context?.breakdown?.groups?.[0]?.tokens}, cold=${JSON.stringify(k2Cold)}`
      );

      // K.3: Multi-step reversed [4,5] then [2,3], plus non-monotonic transcript step_index [10, 5]
      const tK3 = writeMultiTurnTranscript(i1ConvI, tK2 + 6000, [
        { stepIndex: 2, input: 1500, output: 100 },
        { stepIndex: 3, input: 2000, output: 150 },
        { stepIndex: 4, input: 3000, output: 200 },
        { stepIndex: 5, input: 6000, output: 300 }
      ]);
      i1ConvCustomList[i1ConvI] = [
        makeFullMetaEntry([4, 5], 6000, 300, 1800),
        makeFullMetaEntry([2, 3], 3500, 250, 1100)
      ];
      await verifyAb1WarmFreshCold(i1ConvI, tK3, 1800, '[4,2]', 10050, '多步骤倒序');

      const tK4 = writeMultiTurnTranscript(i1ConvI, tK3 + 2000, [
        { stepIndex: 10, input: 2000, output: 200 },
        { stepIndex: 5, input: 6000, output: 300 }
      ]);
      i1ConvCustomList[i1ConvI] = [
        makeFullMetaEntry(5, 6000, 300, 1900),
        makeFullMetaEntry(10, 2000, 200, 1100)
      ];
      await verifyAb1WarmFreshCold(i1ConvI, tK4, 1900, '[5,10]', 8500, '非单调 transcript 顺序');

      // Case L: In-flight 0-token generatorMetadata placeholders must not enter turns/sparkline/turnsCount or prematurely settle, while preserving budget/estimate/breakdown until completion
      const writeCaseLTranscript = (mtimeMs, completedThirdTurn = false) => {
        const d = join(isolatedAgDir, 'brain', i1ConvJ, '.system_generated', 'logs');
        mkdirSync(d, { recursive: true });
        const tp = join(d, 'transcript.jsonl');
        const rows = [
          { step_index: 1, type: 'USER_INPUT', created_at: new Date(mtimeMs - 5000).toISOString(), content: `i1 inflight task ${i1ConvJ}` },
          { step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(mtimeMs - 4000).toISOString(), input_tokens: 2000, output_tokens: 200, model: 'gemini-3.8-flash', content: 'turn 1 reply' },
          { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(mtimeMs - 3000).toISOString(), input_tokens: 6000, output_tokens: 300, model: 'gemini-3.8-flash', content: 'turn 2 reply' },
          { step_index: 4, type: 'USER_INPUT', created_at: new Date(mtimeMs - 1000).toISOString(), content: 'new turn prompt awaiting model response' }
        ];
        if (completedThirdTurn) {
          rows.push({
            step_index: 5,
            type: 'PLANNER_RESPONSE',
            status: 'DONE',
            created_at: new Date(mtimeMs).toISOString(),
            input_tokens: 8500,
            output_tokens: 350,
            model: 'gemini-3.8-flash',
            content: 'turn 3 completed reply'
          });
        }
        writeFileSync(tp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
        utimesSync(tp, new Date(mtimeMs), new Date(mtimeMs));
        return statSync(tp).mtimeMs;
      };

      const tL0 = writeCaseLTranscript(tK4 + 5000, false);
      i1ConvCustomList[i1ConvJ] = [
        makeFullMetaEntry(2, 2000, 200, 1200),
        makeFullMetaEntry(3, 6000, 300, 1600),
        {
          chatModel: {
            modelDisplayName: 'Gemini 3.8 Flash',
            responseModel: 'gemini-3.8-flash',
            chatStartMetadata: {
              contextWindowMetadata: {
                maxContextTokens: 512000,
                estimatedTokensUsed: 6500
              }
            }
          }
        }
      ];
      const snapL1 = await scanConversation(i1ConvJ, { force: true, nowMs: tL0 });
      const diskAfterL1 = JSON.parse(readFileSync(convDiskFile, 'utf-8')).convs?.[i1ConvJ];
      const coldL1 = await runI1Child(
        `const m = await import(${JSON.stringify(i1CollectorUrl)});
         const s = await m.scanConversation(${JSON.stringify(i1ConvJ)}, { background: true, nowMs: ${tL0 + 500} });
         console.log(JSON.stringify({ turnsLen: s.turns?.length, turnsCount: s.audit?.turnsCount, budget: s.context?.budget, estimate: s.context?.estimate, breakdownSys: s.context?.breakdown?.groups?.[0]?.tokens }));`
      );
      assert(
        snapL1.turns?.length === 2 &&
          snapL1.audit?.turnsCount === 2 &&
          snapL1.turns.every((t) => t.totalTokens > 0) &&
          JSON.stringify(snapL1.turns.map((t) => t.turnIndex)) === '[2,1]' &&
          snapL1.sparkline?.length === 2 &&
          snapL1.sparkline.every((p) => p.total > 0) &&
          snapL1.context?.inputTokens === 6000 &&
          snapL1.context?.budget === 512000 &&
          snapL1.context?.estimate === 6500 &&
          snapL1.context?.breakdown?.groups?.[0]?.tokens === 1600 &&
          diskAfterL1?.settled === false &&
          coldL1.turnsLen === 2 &&
          coldL1.turnsCount === 2 &&
          coldL1.budget === 512000 &&
          coldL1.estimate === 6500 &&
          coldL1.breakdownSys === 1600,
        `I1 Case L.1 生成中 0 tok 占位不应进入已完成轮次或丢失分组明细/提前收敛：snapTurns=${JSON.stringify(snapL1.turns)}, ctx=${JSON.stringify(snapL1.context)}, diskSettled=${diskAfterL1?.settled}, cold=${JSON.stringify(coldL1)}`
      );
      const l1Harness = createAppRenderHarness();
      l1Harness.vmCtx.renderContextPanel(snapL1);
      const l1TimelineHtml = l1Harness.getEl('turns-timeline').innerHTML;
      assert(
        !l1TimelineHtml.includes('第 #3 轮') && !l1TimelineHtml.includes('入 0 / 出 0'),
        `I1 Case L.1 时间线 DOM 不应渲染第 #3 轮或入 0 / 出 0 占位行：${l1TimelineHtml}`
      );

      // L.2: Pre-allocated stepIndices:[5] with 0 usage and updated tokenBreakdown (1750) still stays excluded from turns/sparkline
      i1ConvCustomList[i1ConvJ] = [
        makeFullMetaEntry(2, 2000, 200, 1200),
        makeFullMetaEntry(3, 6000, 300, 1600),
        {
          stepIndices: [5],
          chatModel: {
            modelDisplayName: 'Gemini 3.8 Flash',
            responseModel: 'gemini-3.8-flash',
            chatStartMetadata: {
              contextWindowMetadata: {
                maxContextTokens: 512000,
                estimatedTokensUsed: 6800,
                tokenBreakdown: {
                  totalTokens: 6800,
                  groups: [{ name: 'System Prompt', numTokens: 1750 }]
                }
              }
            }
          }
        }
      ];
      const snapL2 = await scanConversation(i1ConvJ, { background: true, nowMs: tL0 + 4500 });
      assert(
        snapL2.turns?.length === 2 &&
          snapL2.audit?.turnsCount === 2 &&
          snapL2.sparkline?.length === 2 &&
          snapL2.sparkline.every((p) => p.total > 0) &&
          snapL2.context?.budget === 512000 &&
          snapL2.context?.breakdown?.groups?.[0]?.tokens === 1750,
        `I1 Case L.2 预分配 stepIndices 且 0 用量生成中记录应继续过滤并更新分组明细：turns=${JSON.stringify(snapL2.turns)}, breakdown=${JSON.stringify(snapL2.context?.breakdown)}`
      );

      // L.3: Once model completes and transcript writes Step 5 + usage arrives, regular scan settles to 3 turns
      const tL2 = writeCaseLTranscript(tL0 + 6000, true);
      const step5Meta = makeFullMetaEntry(5, 8500, 350, 1850);
      step5Meta.chatModel.chatStartMetadata.contextWindowMetadata.maxContextTokens = 512000;
      i1ConvCustomList[i1ConvJ] = [
        makeFullMetaEntry(2, 2000, 200, 1200),
        makeFullMetaEntry(3, 6000, 300, 1600),
        step5Meta
      ];
      const snapL3 = await scanConversation(i1ConvJ, { background: true, nowMs: tL2 + 500 });
      const diskAfterL3 = JSON.parse(readFileSync(convDiskFile, 'utf-8')).convs?.[i1ConvJ];
      assert(
        snapL3.turns?.length === 3 &&
          snapL3.audit?.turnsCount === 3 &&
          snapL3.turns[0].turnIndex === 3 &&
          snapL3.turns[0].stepIndex === 5 &&
          snapL3.turns[0].totalTokens === 8850 &&
          snapL3.context?.breakdown?.groups?.[0]?.tokens === 1850 &&
          diskAfterL3?.settled === true,
        `I1 Case L.3 模型输出完成后常规扫描应收敛为 3 轮完整记录：turns=${JSON.stringify(snapL3.turns)}, diskSettled=${diskAfterL3?.settled}`
      );

      // L.4: Historical stepless 0-token cancel/timeout errors must NOT render 0 tok rows, pin to top, or pollute healthy completed sessions, while genuine trailing failures still surface top error banner
      const noStepStreamTimeoutErr = {
        chatModel: {
          model: 'MODEL_PLACEHOLDER_M667',
          usage: { model: 'MODEL_PLACEHOLDER_M667' },
          error: 'request failed: stream idle timeout (5m0s)'
        }
      };
      for (const [labelL4, customListL4] of [
        ['中间穿插无步骤报错', [makeFullMetaEntry(2, 2000, 200, 1200), noStepStreamTimeoutErr, makeFullMetaEntry(3, 6000, 300, 1600), step5Meta]],
        ['末尾残留历史无步骤报错', [makeFullMetaEntry(2, 2000, 200, 1200), makeFullMetaEntry(3, 6000, 300, 1600), step5Meta, noStepStreamTimeoutErr]]
      ]) {
        i1ConvCustomList[i1ConvJ] = customListL4;
        const snapL4a = await scanConversation(i1ConvJ, { force: true, nowMs: tL2 + 1000 });
        assert(
          snapL4a.turns?.length === 3 &&
            snapL4a.audit?.turnsCount === 3 &&
            snapL4a.turns.every((t) => t.totalTokens > 0) &&
            snapL4a.turns[0].stepIndex === 5 &&
            snapL4a.context?.error?.kind === 'none' &&
            snapL4a.context?.breakdown?.groups?.[0]?.tokens === 1850,
          `I1 Case L.4 (${labelL4}) 不应保留 0 tok 幽灵轮次或污染健康会话错误状态：turns=${JSON.stringify(snapL4a.turns)}, err=${JSON.stringify(snapL4a.context?.error)}, bd=${JSON.stringify(snapL4a.context?.breakdown)}`
        );
        const l4Harness = createAppRenderHarness();
        l4Harness.vmCtx.renderContextPanel(snapL4a);
        const l4Html = l4Harness.getEl('turns-timeline').innerHTML;
        assert(
          !l4Html.includes('>0 tok<') && !l4Html.includes('入 0 / 出 0') && !l4Html.includes('第 #4 轮'),
          `I1 Case L.4 (${labelL4}) 时间线 DOM 不应出现 0 tok 卡片：${l4Html}`
        );
      }

      // Genuine trailing failure after Step 6 USER_INPUT -> turns remain 3 non-zero rows, top context.error surfaces 503
      const l4LogPath = join(isolatedAgDir, 'brain', i1ConvJ, '.system_generated', 'logs', 'transcript.jsonl');
      const tL4b = tL2 + 2000;
      const existingRowsL4 = readFileSync(l4LogPath, 'utf-8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
      existingRowsL4.push({
        step_index: 6,
        type: 'USER_INPUT',
        created_at: new Date(tL4b).toISOString(),
        content: 'trailing request that hits 503'
      });
      writeFileSync(l4LogPath, existingRowsL4.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
      utimesSync(l4LogPath, new Date(tL4b), new Date(tL4b));
      i1ConvCustomList[i1ConvJ] = [
        makeFullMetaEntry(2, 2000, 200, 1200),
        makeFullMetaEntry(3, 6000, 300, 1600),
        step5Meta,
        {
          chatModel: {
            modelDisplayName: 'Gemini 3.8 Flash',
            error: 'UNAVAILABLE (code 503): No capacity available'
          }
        }
      ];
      const snapL4b = await scanConversation(i1ConvJ, { force: true, nowMs: tL4b + 500 });
      assert(
        snapL4b.turns?.length === 3 &&
          snapL4b.audit?.turnsCount === 3 &&
          snapL4b.turns.every((t) => t.totalTokens > 0) &&
          snapL4b.context?.error?.kind !== 'none' &&
          snapL4b.context?.breakdown?.groups?.[0]?.tokens === 1850,
        `I1 Case L.4 (末尾真实 503 失败) 应保持 3 轮非零记录同时顶部识别错误：turns=${JSON.stringify(snapL4b.turns)}, err=${JSON.stringify(snapL4b.context?.error)}`
      );
    } finally {
      if (prevI1StateDir === undefined) delete process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR; else process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = prevI1StateDir;
      if (prevI1Ls === undefined) delete process.env.ANTIGRAVITY_LS_ADDRESS; else process.env.ANTIGRAVITY_LS_ADDRESS = prevI1Ls;
      if (prevI1Csrf === undefined) delete process.env.ANTIGRAVITY_CSRF_TOKEN; else process.env.ANTIGRAVITY_CSRF_TOKEN = prevI1Csrf;
      i1Server.closeAllConnections?.();
      await new Promise((r) => i1Server.close(r));
      rmSync(join(isolatedAgDir, 'brain', i1ConvA), { recursive: true, force: true });
      rmSync(join(isolatedAgDir, 'brain', i1ConvB), { recursive: true, force: true });
      rmSync(join(isolatedAgDir, 'brain', i1ConvC), { recursive: true, force: true });
      rmSync(join(isolatedAgDir, 'brain', i1ConvD), { recursive: true, force: true });
      rmSync(join(isolatedAgDir, 'brain', i1ConvE), { recursive: true, force: true });
      rmSync(join(isolatedAgDir, 'brain', i1ConvF), { recursive: true, force: true });
      rmSync(join(isolatedAgDir, 'brain', i1ConvG), { recursive: true, force: true });
      rmSync(join(isolatedAgDir, 'brain', i1ConvH), { recursive: true, force: true });
      rmSync(join(isolatedAgDir, 'brain', i1ConvI), { recursive: true, force: true });
      rmSync(join(isolatedAgDir, 'brain', i1ConvJ), { recursive: true, force: true });
      rmSync(i1StateDir, { recursive: true, force: true });
      rmSync(join(isolatedStateDir, 'gen_step_models_v1.json'), { force: true });
      rmSync(join(isolatedStateDir, 'host_status_cache_v1.json'), { force: true });
      rmSync(join(isolatedStateDir, 'active_conv_gen_cache_v1.json'), { force: true });
    }

    // R8: Windows PowerShell Unicode-safe Base64 loader shim in non-ASCII + space directory
    const ps1Text = readFileSync(join(ROOT, 'install.ps1'), 'utf-8');
    assert(!/\$TargetDir.*-Encoding\s+ASCII/i.test(ps1Text), 'R8 install.ps1 仍将 $TargetDir 直接以 ASCII 编码写出');
    assert(ps1Text.includes('agy-context-loader.mjs') && ps1Text.includes('ToBase64String'), 'R8 install.ps1 缺少 UTF-8 Base64 loader 入口');
    const unicodePluginDir = join(tmpVerifyRoot, '中文 路径 测试', 'context-viewer');
    const unicodeDashDir = join(unicodePluginDir, 'sidecars', 'dashboard');
    const unicodeBinDir = join(tmpVerifyRoot, '命令 入口 目录');
    mkdirSync(unicodeDashDir, { recursive: true });
    mkdirSync(unicodeBinDir, { recursive: true });
    copyFileSync(join(ROOT, 'plugin.json'), join(unicodePluginDir, 'plugin.json'));
    for (const f of ['sidecar.json', 'package.json', 'pricing.mjs', 'sqlite_reader.mjs', 'collector.mjs', 'float_window.mjs', 'cli.mjs']) {
      copyFileSync(join(ROOT, 'sidecars', 'dashboard', f), join(unicodeDashDir, f));
    }
    const unicodeCliEntry = join(unicodeDashDir, 'cli.mjs');
    const entryB64 = Buffer.from(unicodeCliEntry, 'utf-8').toString('base64');
    const loaderScript = [
      "import { pathToFileURL } from 'node:url';",
      `const entry = Buffer.from('${entryB64}', 'base64').toString('utf8');`,
      'process.argv[1] = entry;',
      'await import(pathToFileURL(entry).href);',
      ''
    ].join('\n');
    assert(/^[\x00-\x7f]+$/.test(loaderScript), 'R8 生成的 agy-context-loader.mjs 必须为纯 ASCII 字节');
    const loaderPath = join(unicodeBinDir, 'agy-context-loader.mjs');
    writeFileSync(loaderPath, loaderScript, 'ascii');
    const isolatedEnv = {
      ...process.env,
      AG_DIR: isolatedAgDir,
      AG_CLI_DIR: isolatedCliDir,
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: isolatedStateDir,
      AGY_CONTEXT_VIEWER_DISABLE_DAEMON: '1',
      ANTIGRAVITY_CONVERSATION_ID: '',
      ANTIGRAVITY_LS_ADDRESS: '',
      ANTIGRAVITY_CSRF_TOKEN: ''
    };
    const unicodeHelpOut = execFileSync(process.execPath, [loaderPath, '--help'], {
      encoding: 'utf-8',
      env: isolatedEnv,
      timeout: 10000
    });
    assert(
      unicodeHelpOut.includes('agy-context') && unicodeHelpOut.includes(`(v${manifest.version})`),
      'R8 中文与空格路径下 loader --help 输出或版本号同步异常'
    );
    const unicodeJsonOut = execFileSync(process.execPath, [loaderPath, 'json'], {
      encoding: 'utf-8',
      env: isolatedEnv,
      timeout: 10000
    });
    const unicodeParsed = JSON.parse(unicodeJsonOut);
    assert(unicodeParsed.conversation?.id === convId, 'R8 中文与空格路径下 loader json 执行结果异常');

    console.log('[verify] 6/6 执行菜单栏格式化、CLI、守护热升级 (F4) 及双 HTTP 入口安全与关闭链路回归测试 (R1 / R7 / F3)...');
    const {
      controlFloatWindow,
      createFallbackHttpServer,
      DAEMON_BUILD_ID,
      DAEMON_VERSION,
      formatStatusItemFromSnapshot,
      getFloatWindowStatus
    } = await import(join(ROOT, 'sidecars', 'dashboard', 'float_window.mjs'));
    const f1MenubarQuota = formatStatusItemFromSnapshot(f1LiveSnap20, 'quota');
    assert(
      f1MenubarQuota.title.startsWith('⏳ 5h 20%'),
      `F1 菜单栏 quota 标题误用 Carbon 80% 池而非当前 Flash 20% 池：${f1MenubarQuota.title}`
    );
    const mockSnap = {
      ok: true,
      conversationId: 'conv_verify_sample',
      conversationTitle: '帮我安装 https://github.com/example-org/antigravity-context-monitor-plugin 并对比分析',
      context: {
        model: 'Gemini 4 Carbon (High)',
        used: 110080,
        budget: 256000,
        percent: 43.0,
        quota: {
          label: 'Gemini 4 Carbon',
          remainingPercent: 95.4,
          resetTime: new Date(Date.now() + 68 * 60 * 1000).toISOString()
        }
      },
      speed: { tps: 35.2, duration: 48.9, avgTps: 38.4, peakTps: 131.6 },
      quotas: [
        {
          title: 'Gemini 4 Carbon / Gemini 4 Argon / Gemini 3.8 Flash 配额池',
          families: ['Gemini 4 Carbon', 'Gemini 4 Argon', 'Gemini 3.8 Flash'],
          remainingPercent: 94.2,
          resetTime: new Date(Date.now() + 38 * 60 * 1000).toISOString()
        },
        {
          title: 'Claude Opus 5.5 / Claude Sonnet 5.5 / GPT-OSS 120B 配额池',
          families: ['Claude Opus 5.5', 'Claude Sonnet 5.5', 'GPT-OSS 120B'],
          remainingPercent: 90.7,
          resetTime: new Date(Date.now() + 36 * 60 * 1000).toISOString()
        }
      ]
    };
    const fmtCtx = formatStatusItemFromSnapshot(mockSnap, 'context');
    assert(fmtCtx.tooltip.includes('\n\n'), 'tooltip 缺少分段空行间距');
    for (const line of fmtCtx.tooltip.split('\n')) {
      let cols = 0;
      for (const ch of line) cols += (ch.codePointAt(0) || 0) > 0x2e7f ? 2 : 1;
      assert(cols <= 38, `tooltip 单行过长易折行（${cols} cols）：${line}`);
    }
    const fmtSpd = formatStatusItemFromSnapshot(mockSnap, 'speed');
    const fmtQ5h = formatStatusItemFromSnapshot(mockSnap, 'quota');
    const fmtQWk = formatStatusItemFromSnapshot({
      ...mockSnap,
      context: {
        ...mockSnap.context,
        quota: { label: 'Pro Weekly', remainingPercent: 82.0, resetTime: new Date(Date.now() + 102 * 3600 * 1000).toISOString() }
      }
    }, 'quota');
    assert(fmtCtx.title === '◈ 43%', `context 模式格式化异常：${fmtCtx.title}`);
    assert(fmtSpd.title === '⚡ 35t/s·49s (均38/峰132)', `speed 模式格式化异常：${fmtSpd.title}`);
    assert(fmtQ5h.title.startsWith('⏳ 5h 95%·1h'), `quota 5h 模式格式化异常：${fmtQ5h.title}`);
    assert(fmtQWk.title.startsWith('⏳ Week 82%·4d'), `quota Week 模式格式化异常：${fmtQWk.title}`);

    // T1 & T3 menu bar formatting checks (weekly-only bucket, unknown quota, 0% quota, unknown context budget)
    const fmtQStandaloneWeek = formatStatusItemFromSnapshot({
      ...mockSnap,
      quotas: [],
      context: {
        ...mockSnap.context,
        quota: {
          label: 'Pro Tier',
          remainingPercent: null,
          fiveHour: null,
          weekly: { remainingPercent: 20, resetTime: new Date(Date.now() + 72 * 3600 * 1000).toISOString() }
        }
      }
    }, 'quota');
    assert(
      fmtQStandaloneWeek.title.startsWith('⏳ Week 20%') && fmtQStandaloneWeek.tooltip.includes('(Week)：20%'),
      `T1 菜单栏独立 weekly 配额显示异常：${fmtQStandaloneWeek.title}`
    );
    const fmtQUnknown = formatStatusItemFromSnapshot({
      ...mockSnap,
      quotas: [{ title: 'Unknown Pool', families: ['Gemini 4 Carbon'], remainingPercent: null, resetTime: null }],
      context: { ...mockSnap.context, quota: { label: 'Gemini 4 Carbon', remainingPercent: null } }
    }, 'quota');
    assert(
      fmtQUnknown.title === '⏳ 额度 --%' &&
        fmtQUnknown.tooltip.includes('余量未知') &&
        !fmtQUnknown.tooltip.includes('100%'),
      `T1 菜单栏未知配额误显示为百分比：${fmtQUnknown.title} / ${fmtQUnknown.tooltip}`
    );
    const fmtQZero = formatStatusItemFromSnapshot({
      ...mockSnap,
      quotas: [{ title: 'Exhausted Pool', families: ['Claude Opus 5.5'], remainingPercent: 0, resetTime: new Date(Date.now() + 25 * 60 * 1000).toISOString() }],
      context: { ...mockSnap.context, quota: { label: 'Claude Opus 5.5', remainingPercent: 0, resetTime: new Date(Date.now() + 25 * 60 * 1000).toISOString() } }
    }, 'quota');
    assert(
      fmtQZero.title.startsWith('⚠ 5h 0%') && fmtQZero.tooltip.includes('0%'),
      `T1 菜单栏真实 0% 配额显示异常：${fmtQZero.title}`
    );
    const fmtCtxNoBudget = formatStatusItemFromSnapshot({
      ...mockSnap,
      quotaStatus: { state: 'stale', stale: true },
      context: { ...mockSnap.context, used: 101000, budget: null, percent: null }
    }, 'context');
    assert(
      fmtCtxNoBudget.title === '◈ 101.0K' &&
        fmtCtxNoBudget.tooltip.includes('上限未知') &&
        fmtCtxNoBudget.tooltip.includes('语言服务离线'),
      `T2/T3 菜单栏未知上限或离线状态显示异常：${fmtCtxNoBudget.title} / ${fmtCtxNoBudget.tooltip}`
    );
    for (const line of fmtCtxNoBudget.tooltip.split('\n')) {
      let cols = 0;
      for (const ch of line) cols += (ch.codePointAt(0) || 0) > 0x2e7f ? 2 : 1;
      assert(cols <= 38, `T2/T3 tooltip 单行超宽（${cols} cols）：${line}`);
    }
    const fmtU3Base40 = formatStatusItemFromSnapshot({
      ...mockSnap,
      quotas: [u3Base40Pool],
      context: { ...mockSnap.context, quota: u3Base40ModelQ }
    }, 'quota');
    assert(
      fmtU3Base40.title.startsWith('⏳ 基础 40%') &&
        fmtU3Base40.tooltip.includes('基础 40%') &&
        !fmtU3Base40.tooltip.includes('余量未知'),
      `U3 菜单栏基础 40% + reset-only 5h 被隐藏：${fmtU3Base40.title} / ${fmtU3Base40.tooltip}`
    );
    const fmtU3Base0 = formatStatusItemFromSnapshot({
      ...mockSnap,
      quotas: [u3Base0Pool],
      context: { ...mockSnap.context, quota: u3Base0ModelQ }
    }, 'quota');
    assert(
      fmtU3Base0.title.startsWith('⚠ 基础 0%') && fmtU3Base0.tooltip.includes('基础 0%'),
      `U3 菜单栏基础 0% + reset-only 5h 未触发告警：${fmtU3Base0.title} / ${fmtU3Base0.tooltip}`
    );
    for (const line of [...fmtU3Base40.tooltip.split('\n'), ...fmtU3Base0.tooltip.split('\n')]) {
      let cols = 0;
      for (const ch of line) cols += (ch.codePointAt(0) || 0) > 0x2e7f ? 2 : 1;
      assert(cols <= 38, `U3 tooltip 单行超宽（${cols} cols）：${line}`);
    }

    const cliOut = execFileSync(process.execPath, [join(ROOT, 'skills', 'context-viewer', 'scripts', 'status.mjs'), '--json'], {
      encoding: 'utf-8',
      env: isolatedEnv,
      timeout: 15000
    });
    const cliJson = JSON.parse(cliOut);
    assert(cliJson.entrypoints?.sidecarAuxPane?.startsWith('sidecar://'), 'CLI JSON 缺少 sidecar 入口字段');

    // 6a: Standalone HTTP server (`main.mjs --standalone`) full R1 + R7 regression
    await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [join(ROOT, 'sidecars', 'dashboard', 'main.mjs'), '--standalone', '--port', '0'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: isolatedEnv
      });
      let resolved = false;
      const timer = setTimeout(() => {
        child.kill();
        if (!resolved) rejectPromise(new Error('standalone 服务启动超时'));
      }, 8000);

      child.stdout.on('data', async (chunk) => {
        const line = String(chunk);
        const m = line.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (m && !resolved) {
          resolved = true;
          try {
            const port = Number(m[1]);
            const base = `http://127.0.0.1:${port}`;
            await runHttpSecurityAndBoundarySuite(port, 'standalone');
            const [rSide, rCss, rFloat, rEntry] = await Promise.all([
              fetch(`${base}/sidebar`),
              fetch(`${base}/styles.css?v=${manifest.version}`),
              fetch(`${base}/api/float-window`),
              fetch(`${base}/api/entrypoints`)
            ]);
            assert(rSide.status === 200, `GET /sidebar 返回 ${rSide.status}`);
            assert(rCss.status === 200, `GET /styles.css 返回 ${rCss.status}`);
            assert(rFloat.status === 200, `GET /api/float-window 返回 ${rFloat.status}`);
            assert(rEntry.status === 200, `GET /api/entrypoints 返回 ${rEntry.status}`);
            assert(child.exitCode === null, 'standalone 服务在异常请求测试后意外退出');
            clearTimeout(timer);
            child.kill();
            resolvePromise();
          } catch (err) {
            clearTimeout(timer);
            child.kill();
            rejectPromise(err);
          }
        }
      });
    });

    // 6b: Fallback browser-app HTTP server (`float_window.mjs`) full R1 + R7 regression
    let fallbackCloseTriggered = false;
    const fallbackState = {
      daemonRunning: true,
      running: true,
      windowVisible: true,
      pinned: false,
      menubarEnabled: false,
      mode: 'browser-app'
    };
    const { server: fbServer } = createFallbackHttpServer(fallbackState, {
      onCloseRequest: () => { fallbackCloseTriggered = true; }
    });
    await new Promise((r) => fbServer.listen(0, '127.0.0.1', r));
    try {
      const fbPort = fbServer.address().port;
      const { csrfToken: fbToken } = await runHttpSecurityAndBoundarySuite(fbPort, 'fallback-http');

      // F3: Execute actual served fallback bridge + app.js `#btn-float` click listener end-to-end
      const fbHtmlRes = await rawHttpRequest({ port: fbPort, path: '/' });
      const bridgeMatch = fbHtmlRes.body.match(/<script>(window\.__CV_FLOAT_MODE__\s*=\s*true;[\s\S]*?)<\/script>/);
      assert(Boolean(bridgeMatch?.[1]), 'F3 降级 HTML 未注入 window.__CV_FLOAT_MODE__ 桥接脚本');
      const floatHandlerStart = appJsSrc.indexOf("$('btn-float')?.addEventListener('click'");
      const floatHandlerEnd = appJsSrc.indexOf('// CLI Launcher', floatHandlerStart);
      assert(floatHandlerStart > 0 && floatHandlerEnd > floatHandlerStart, 'F3 未定位到 app.js #btn-float 点击事件代码');
      let capturedFloatClick = null;
      let windowCloseCount = 0;
      const fbVmWindow = {
        close: () => { windowCloseCount++; }
      };
      const fbVmCtx = {
        window: fbVmWindow,
        document: {
          querySelector: (sel) => (
            sel === 'meta[name="cv-csrf-token"]'
              ? { getAttribute: (attr) => (attr === 'content' ? fbToken : null) }
              : null
          )
        },
        fetch: (urlPath, opts = {}) => fetch(`http://127.0.0.1:${fbPort}${urlPath}`, {
          ...opts,
          headers: {
            Origin: `http://127.0.0.1:${fbPort}`,
            ...(opts.headers || {})
          }
        }),
        apiFetch: async () => { throw new Error('unexpected fallback apiFetch branch'); },
        $: (id) => (
          id === 'btn-float'
            ? { addEventListener: (evName, fn) => { if (evName === 'click') capturedFloatClick = fn; } }
            : null
        ),
        state: { floatRunning: true, floatPinned: false },
        syncFloatButtonUi: () => {},
        showToast: () => {}
      };
      runInNewContext(`${bridgeMatch[1]}\n${appJsSrc.slice(floatHandlerStart, floatHandlerEnd)}`, fbVmCtx);
      assert(typeof capturedFloatClick === 'function', 'F3 未捕获到 #btn-float click 回调');
      await capturedFloatClick({ shiftKey: false });
      assert(
        fallbackCloseTriggered && windowCloseCount === 1,
        `F3 浏览器降级小窗点击关闭按钮未同时通知后端与关闭窗口：closed=${fallbackCloseTriggered}, winClose=${windowCloseCount}`
      );

      // Verify fallback server /api/entrypoints pinnedConvId -> /api/context & unchanged:true preserves pinnedConvId
      const rPinSet = await rawHttpRequest({
        port: fbPort,
        method: 'POST',
        path: '/api/entrypoints',
        headers: {
          Origin: `http://127.0.0.1:${fbPort}`,
          'Content-Type': 'application/json',
          'X-CV-Token': fbToken
        },
        body: JSON.stringify({ pinnedConvId: convId })
      });
      assert(rPinSet.status === 200, `降级服务 POST /api/entrypoints 固定会话失败：${rPinSet.status}`);
      const rCtxFull = JSON.parse((await rawHttpRequest({ port: fbPort, path: `/api/context?conversationId=${convId}` })).body);
      assert(
        rCtxFull.ok && rCtxFull.pinnedConvId === convId && rCtxFull.etag,
        `降级服务完整 /api/context 未透传 pinnedConvId：${JSON.stringify({ ok: rCtxFull.ok, pinnedConvId: rCtxFull.pinnedConvId })}`
      );
      const rCtxUnchanged = JSON.parse(
        (await rawHttpRequest({ port: fbPort, path: `/api/context?conversationId=${convId}&etag=${encodeURIComponent(rCtxFull.etag)}` })).body
      );
      assert(
        rCtxUnchanged.unchanged === true && rCtxUnchanged.pinnedConvId === convId,
        `降级服务 unchanged:true 响应未透传 pinnedConvId：${JSON.stringify(rCtxUnchanged)}`
      );
      await rawHttpRequest({
        port: fbPort,
        method: 'POST',
        path: '/api/entrypoints',
        headers: {
          Origin: `http://127.0.0.1:${fbPort}`,
          'Content-Type': 'application/json',
          'X-CV-Token': fbToken
        },
        body: JSON.stringify({ pinnedConvId: '' })
      });

      fallbackCloseTriggered = false;
      const rUnauthClose = await rawHttpRequest({
        port: fbPort,
        method: 'POST',
        path: '/api/float-window',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      assert(rUnauthClose.status === 403 && !fallbackCloseTriggered, '未授权 POST /api/float-window 不得触发关闭小窗');
      const rAuthClose = await rawHttpRequest({
        port: fbPort,
        method: 'POST',
        path: '/api/float-window',
        headers: {
          Origin: `http://127.0.0.1:${fbPort}`,
          'Content-Type': 'application/json',
          'X-CV-Token': fbToken
        },
        body: '{}'
      });
      assert(rAuthClose.status === 200 && fallbackCloseTriggered, '授权 POST /api/float-window 应正常触发关闭回调');

      // Shortcut API CRUD over authenticated /api/entrypoints
      const rSetSc = await rawHttpRequest({
        port: fbPort,
        method: 'POST',
        path: '/api/entrypoints',
        headers: {
          Origin: `http://127.0.0.1:${fbPort}`,
          'Content-Type': 'application/json',
          'X-CV-Token': fbToken
        },
        body: JSON.stringify({ target: 'shortcut', accelerator: 'opt+cmd+l', scope: 'global' })
      });
      const setScBody = JSON.parse(rSetSc.body);
      assert(
        rSetSc.status === 200 &&
          setScBody.ok === true &&
          setScBody.shortcut?.accelerator === 'Alt+Meta+L' &&
          setScBody.shortcut?.scope === 'global' &&
          setScBody.shortcut?.enabled === true,
        `POST /api/entrypoints 自定义快捷键返回异常：${rSetSc.body}`
      );

      const rBadSc = await rawHttpRequest({
        port: fbPort,
        method: 'POST',
        path: '/api/entrypoints',
        headers: {
          Origin: `http://127.0.0.1:${fbPort}`,
          'Content-Type': 'application/json',
          'X-CV-Token': fbToken
        },
        body: JSON.stringify({ target: 'shortcut', accelerator: 'k' })
      });
      const badScBody = JSON.parse(rBadSc.body);
      assert(
        rBadSc.status === 200 &&
          badScBody.ok === false &&
          badScBody.shortcut?.accelerator === 'Alt+Meta+L',
        `非法单键快捷键应被拒绝且保留原有效配置：${rBadSc.body}`
      );

      const rResetSc = await rawHttpRequest({
        port: fbPort,
        method: 'POST',
        path: '/api/entrypoints',
        headers: {
          Origin: `http://127.0.0.1:${fbPort}`,
          'Content-Type': 'application/json',
          'X-CV-Token': fbToken
        },
        body: JSON.stringify({ target: 'shortcut', reset: true })
      });
      const resetScBody = JSON.parse(rResetSc.body);
      assert(
        rResetSc.status === 200 &&
          resetScBody.ok === true &&
          resetScBody.shortcut?.isDefault === true &&
          resetScBody.shortcut?.scope === 'app',
        `POST /api/entrypoints 恢复默认快捷键异常：${rResetSc.body}`
      );

      // Aux-pane shortcut CRUD + collision rejection + /api/aux-pane-trigger bus
      const rSetAuxSc = await rawHttpRequest({
        port: fbPort,
        method: 'POST',
        path: '/api/entrypoints',
        headers: {
          Origin: `http://127.0.0.1:${fbPort}`,
          'Content-Type': 'application/json',
          'X-CV-Token': fbToken
        },
        body: JSON.stringify({ target: 'aux-shortcut', accelerator: 'Ctrl+Shift+L' })
      });
      const setAuxScBody = JSON.parse(rSetAuxSc.body);
      assert(
        rSetAuxSc.status === 200 &&
          setAuxScBody.ok === true &&
          setAuxScBody.auxShortcut?.accelerator === 'Ctrl+Shift+L',
        `POST /api/entrypoints aux-shortcut 自定义保存异常：${rSetAuxSc.body}`
      );

      const defaultStandaloneAcc = resetScBody.shortcut?.accelerator || 'Alt+Meta+K';
      const rCollideAux = await rawHttpRequest({
        port: fbPort,
        method: 'POST',
        path: '/api/entrypoints',
        headers: {
          Origin: `http://127.0.0.1:${fbPort}`,
          'Content-Type': 'application/json',
          'X-CV-Token': fbToken
        },
        body: JSON.stringify({ target: 'aux-shortcut', accelerator: defaultStandaloneAcc })
      });
      const collideBody = JSON.parse(rCollideAux.body);
      assert(collideBody.ok === false, `侧栏快捷键与独立窗冲突时应拒绝保存：${rCollideAux.body}`);

      await rawHttpRequest({
        port: fbPort,
        method: 'POST',
        path: '/api/entrypoints',
        headers: {
          Origin: `http://127.0.0.1:${fbPort}`,
          'Content-Type': 'application/json',
          'X-CV-Token': fbToken
        },
        body: JSON.stringify({ target: 'aux-shortcut', reset: true })
      });

      const rAuxTrig = await rawHttpRequest({
        port: fbPort,
        method: 'POST',
        path: '/api/aux-pane-trigger',
        headers: {
          Origin: `http://127.0.0.1:${fbPort}`,
          'Content-Type': 'application/json',
          'X-CV-Token': fbToken
        },
        body: JSON.stringify({ targetPlugin: 'context-viewer', uri: 'sidecar://context-viewer/dashboard/', action: 'toggle' })
      });
      const auxTrigBody = JSON.parse(rAuxTrig.body);
      assert(auxTrigBody.ok === true && auxTrigBody.trigger?.seq > 0, `/api/aux-pane-trigger 触发失败：${rAuxTrig.body}`);

      const rAuxPoll = await rawHttpRequest({
        port: fbPort,
        method: 'GET',
        path: '/api/aux-pane-trigger?since=0&waitMs=0'
      });
      const auxPollBody = JSON.parse(rAuxPoll.body);
      assert(auxPollBody.changed === true && auxPollBody.trigger?.seq === auxTrigBody.trigger.seq, 'GET /api/aux-pane-trigger 未返回最新触发事件');

      const rAuxAck = await rawHttpRequest({
        port: fbPort,
        method: 'POST',
        path: '/api/aux-pane-trigger',
        headers: {
          Origin: `http://127.0.0.1:${fbPort}`,
          'Content-Type': 'application/json',
          'X-CV-Token': fbToken
        },
        body: JSON.stringify({ action: 'ack', seq: auxTrigBody.trigger.seq, plugin: 'context-viewer' })
      });
      assert(JSON.parse(rAuxAck.body).claimed === true, 'POST /api/aux-pane-trigger ack 声明失败');

      const rAuxSwitched = await rawHttpRequest({
        port: fbPort,
        method: 'POST',
        path: '/api/aux-pane-trigger',
        headers: {
          Origin: `http://127.0.0.1:${fbPort}`,
          'Content-Type': 'application/json',
          'X-CV-Token': fbToken
        },
        body: JSON.stringify({ action: 'switched', seq: auxTrigBody.trigger.seq })
      });
      assert(JSON.parse(rAuxSwitched.body).claimed === true, 'POST /api/aux-pane-trigger switched 声明失败');
    } finally {
      await new Promise((r) => fbServer.close(r));
    }

    // 6c: F4 daemon hot-upgrade on DAEMON_VERSION / DAEMON_BUILD_ID change + preference preservation
    const isTestPidAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const mockDaemonScript = join(tmpVerifyRoot, 'sidecars', 'dashboard', 'float_window.mjs');
    mkdirSync(dirname(mockDaemonScript), { recursive: true });
    writeFileSync(mockDaemonScript, 'setInterval(() => {}, 10000);\n', 'utf-8');
    const dummyProcs = [];
    const spawnDummyProc = () => {
      const p = spawn(process.execPath, [mockDaemonScript, '--daemon'], { stdio: 'ignore' });
      dummyProcs.push(p);
      return p;
    };
    try {
      const floatStateFile = join(isolatedStateDir, 'float_window_state.json');
      const staleProc = spawnDummyProc();
      const upgradedProc = spawnDummyProc();
      const hotReloadProc = spawnDummyProc();
      setMenubarPreference(true);

      writeFileSync(floatStateFile, JSON.stringify({
        daemonVersion: DAEMON_VERSION - 1,
        daemonBuildId: 'legacy-build-v4',
        daemonRunning: true,
        running: false,
        windowVisible: false,
        pid: staleProc.pid,
        pinned: false,
        menubarEnabled: true,
        menubarMode: 'quota',
        mode: 'native-macos',
        cmdSeq: 1
      }), 'utf-8');

      let spawnCalls = [];
      let nextDummyProc = upgradedProc;
      const mockSpawnDaemon = async (opts) => {
        spawnCalls.push(opts);
        writeFileSync(floatStateFile, JSON.stringify({
          daemonVersion: DAEMON_VERSION,
          daemonBuildId: DAEMON_BUILD_ID,
          daemonRunning: true,
          running: !opts.hiddenWindow,
          windowVisible: !opts.hiddenWindow,
          pid: nextDummyProc.pid,
          pinned: Boolean(opts.pinned),
          menubarEnabled: Boolean(opts.menubarEnabled),
          menubarMode: opts.menubarMode || 'context',
          mode: 'native-macos',
          cmdSeq: 1
        }), 'utf-8');
        return getFloatWindowStatus('darwin');
      };

      const upRes = await controlFloatWindow(
        { action: 'ensure-menubar' },
        { platform: 'darwin', spawnDaemon: mockSpawnDaemon }
      );
      assert(!isTestPidAlive(staleProc.pid), 'F4 旧版守护进程在 ensure-menubar 时未被终止');
      assert(
        spawnCalls.length === 1 &&
          spawnCalls[0].pinned === false &&
          spawnCalls[0].menubarEnabled === true &&
          spawnCalls[0].hiddenWindow === true &&
          spawnCalls[0].menubarMode === 'quota' &&
          upRes.pid === upgradedProc.pid,
        `F4 旧守护热升级未完整保留 pinned/mode 状态：${JSON.stringify(spawnCalls[0])}`
      );

      // Already-current daemon must NOT be restarted on subsequent ensure-menubar calls
      const noopRes = await controlFloatWindow(
        { action: 'ensure-menubar' },
        { platform: 'darwin', spawnDaemon: mockSpawnDaemon }
      );
      assert(
        isTestPidAlive(upgradedProc.pid) && spawnCalls.length === 1 && noopRes.pid === upgradedProc.pid,
        'F4 已是最新版本的守护进程在重复 ensure-menubar 时不应被重启'
      );

      // Code/asset fingerprint change (same DAEMON_VERSION, stale daemonBuildId) must also upgrade on refresh-session
      writeFileSync(floatStateFile, JSON.stringify({
        daemonVersion: DAEMON_VERSION,
        daemonBuildId: 'stale-fingerprint-0000',
        daemonRunning: true,
        running: false,
        windowVisible: false,
        pid: upgradedProc.pid,
        pinned: false,
        menubarEnabled: true,
        menubarMode: 'quota',
        mode: 'native-macos',
        cmdSeq: 2
      }), 'utf-8');
      nextDummyProc = hotReloadProc;
      const reloadRes = await controlFloatWindow(
        { action: 'refresh-session' },
        { platform: 'darwin', spawnDaemon: mockSpawnDaemon }
      );
      assert(
        !isTestPidAlive(upgradedProc.pid) &&
          spawnCalls.length === 2 &&
          spawnCalls[1].pinned === false &&
          spawnCalls[1].menubarMode === 'quota' &&
          reloadRes.pid === hotReloadProc.pid,
        'F4 源码构建指纹变化后 refresh-session 未触发守护平滑重建'
      );
    } finally {
      for (const p of dummyProcs) {
        try { p.kill('SIGKILL'); } catch {}
      }
    }

    // 6d: Customizable Shortcut Normalization, Carbon Keycodes, UI KeyEvent Matching, Resident Lifecycle & Swift Typecheck
    assert(getDefaultShortcut('darwin') === DEFAULT_SHORTCUT_MAC && DEFAULT_SHORTCUT_MAC === 'Alt+Meta+K', 'macOS 默认快捷键应为 Alt+Meta+K');
    assert(getDefaultShortcut('win32') === DEFAULT_SHORTCUT_OTHER && DEFAULT_SHORTCUT_OTHER === 'Ctrl+Alt+K', 'Windows/Linux 默认快捷键应为 Ctrl+Alt+K');
    assert(formatShortcutDisplay('Alt+Meta+K', 'darwin') === '⌥⌘K', 'macOS 快捷键显示符号应为 ⌥⌘K');
    assert(formatShortcutDisplay('Ctrl+Alt+K', 'win32') === 'Ctrl+Alt+K', 'Windows 快捷键显示格式应为 Ctrl+Alt+K');

    const macDefaultCarbon = shortcutToMacCarbon('Alt+Meta+K');
    assert(
      macDefaultCarbon?.keyCode === 40 && macDefaultCarbon?.modifiers === (2048 | 256),
      `Alt+Meta+K Carbon 键码映射异常：${JSON.stringify(macDefaultCarbon)}`
    );

    const normGlyph = normalizeShortcutSpec('⌃⇧⌘Space', 'darwin');
    assert(
      normGlyph.ok &&
        !normGlyph.disabled &&
        normGlyph.accelerator === 'Ctrl+Shift+Meta+Space' &&
        normGlyph.display === '⌃⇧⌘Space' &&
        normGlyph.macCarbon?.keyCode === 49 &&
        normGlyph.macCarbon?.modifiers === (4096 | 512 | 256),
      `紧凑符号快捷键解析异常：${JSON.stringify(normGlyph)}`
    );
    const normFn = normalizeShortcutSpec('f8', 'darwin');
    assert(normFn.ok && normFn.accelerator === 'F8' && normFn.macCarbon?.keyCode === 100, 'F8 功能键解析异常');
    const normOff = normalizeShortcutSpec('off', 'darwin');
    assert(normOff.ok && normOff.disabled === true, 'off 停用指令解析异常');

    for (const bad of ['K', 'Shift+K', 'Meta+Alt', 'Meta+C', 'Meta+Q', 'Meta+Space', 'Shift+Meta+Z', 'Alt+Meta+K+L']) {
      const r = normalizeShortcutSpec(bad, 'darwin');
      assert(!r.ok, `macOS 下非法或系统保留组合键「${bad}」必须被拦截`);
    }
    assert(!normalizeShortcutSpec('Ctrl+C', 'win32').ok, 'Windows 下 Ctrl+C 必须被拦截');

    // Persistence: custom -> off preserves accelerator -> reset restores default
    const savedCustom = setShortcutConfig({ accelerator: 'ctrl+opt+j', scope: 'global' }, 'darwin');
    assert(
      savedCustom.ok &&
        savedCustom.shortcut.accelerator === 'Ctrl+Alt+J' &&
        savedCustom.shortcut.display === '⌃⌥J' &&
        savedCustom.shortcut.scope === 'global' &&
        savedCustom.shortcut.isDefault === false,
      'setShortcutConfig 自定义保存异常'
    );
    const savedDisabled = setShortcutConfig({ accelerator: 'off' }, 'darwin');
    assert(
      savedDisabled.ok &&
        savedDisabled.shortcut.enabled === false &&
        savedDisabled.shortcut.accelerator === 'Ctrl+Alt+J',
      'setShortcutConfig off 停用时应保留原已选键位以便重新启用'
    );
    const savedReenabled = setShortcutConfig({ enabled: true }, 'darwin');
    assert(savedReenabled.ok && savedReenabled.shortcut.enabled === true && savedReenabled.shortcut.accelerator === 'Ctrl+Alt+J', '重新启用快捷键状态异常');
    const savedReset = setShortcutConfig({ reset: true }, 'darwin');
    assert(
      savedReset.ok &&
        savedReset.shortcut.isDefault === true &&
        savedReset.shortcut.accelerator === 'Alt+Meta+K' &&
        savedReset.shortcut.scope === 'app' &&
        getShortcutConfig('darwin').isDefault === true,
      'setShortcutConfig reset 恢复默认异常'
    );

    // UI KeyEvent matching in app.js (verifies macOS Option+Cmd+K dead-character `˚` handling via `ev.code`)
    const scFnStart = appJsSrc.indexOf('const SPECIAL_EVENT_CODES = new Set(');
    const scFnEnd = appJsSrc.indexOf('function startShortcutRecording()', scFnStart);
    assert(scFnStart > 0 && scFnEnd > scFnStart, '未定位到 app.js 快捷键事件解析函数区间');
    const scVmCtx = {
      state: { shortcut: { nativeGlobalSupported: true } },
      Set,
      String,
      Boolean
    };
    runInNewContext(
      `${appJsSrc.slice(scFnStart, scFnEnd)}\nthis.buildAcc = buildAcceleratorFromKeyEvent;\nthis.matchAcc = eventMatchesAccelerator;`,
      scVmCtx
    );
    const macDeadCharEv = {
      code: 'KeyK',
      key: '˚',
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
      metaKey: true
    };
    const builtMacChord = scVmCtx.buildAcc(macDeadCharEv);
    assert(
      builtMacChord.ok && builtMacChord.accelerator === 'Alt+Meta+K',
      `macOS Option+Cmd+K 特殊字符事件构建失败：${JSON.stringify(builtMacChord)}`
    );
    assert(
      scVmCtx.matchAcc(macDeadCharEv, 'Alt+Meta+K') === true &&
        scVmCtx.matchAcc({ ...macDeadCharEv, shiftKey: true }, 'Alt+Meta+K') === false,
      'eventMatchesAccelerator 精确修饰键匹配异常'
    );
    const modPreview = scVmCtx.buildAcc({ code: 'AltLeft', key: 'Alt', ctrlKey: false, altKey: true, shiftKey: false, metaKey: true });
    assert(modPreview.modifierOnly === true && modPreview.preview === '⌥⌘…', '录制中纯修饰键实时预览异常');

    // Resident daemon lifecycle when menubar is OFF while shortcut is ON
    const scProcs = [];
    const spawnScDummy = () => {
      const p = spawn(process.execPath, [mockDaemonScript, '--daemon'], { stdio: 'ignore' });
      scProcs.push(p);
      return p;
    };
    try {
      const floatStateFile = join(isolatedStateDir, 'float_window_state.json');
      try { rmSync(floatStateFile, { force: true }); } catch {}
      setMenubarPreference(false);
      setShortcutConfig({ reset: true }, 'darwin'); // enabled: true, menubarEnabled: false

      const scDaemonProc = spawnScDummy();
      let scSpawnCount = 0;
      let lastSentCmd = null;
      const mockScSpawn = async (opts) => {
        scSpawnCount += 1;
        writeFileSync(floatStateFile, JSON.stringify({
          daemonVersion: DAEMON_VERSION,
          daemonBuildId: DAEMON_BUILD_ID,
          daemonRunning: true,
          running: !opts.hiddenWindow,
          windowVisible: !opts.hiddenWindow,
          pid: scDaemonProc.pid,
          pinned: Boolean(opts.pinned),
          menubarEnabled: Boolean(opts.menubarEnabled),
          shortcutEnabled: true,
          shortcutAccelerator: 'Alt+Meta+K',
          shortcutScope: 'app',
          menubarMode: opts.menubarMode || 'context',
          mode: 'native-macos',
          cmdSeq: 1
        }), 'utf-8');
        return getFloatWindowStatus('darwin');
      };
      const mockScSendCmd = async (_cur, cmdObj) => {
        lastSentCmd = cmdObj;
        if (cmdObj.cmd === 'hideWindow') {
          const curObj = JSON.parse(readFileSync(floatStateFile, 'utf-8'));
          curObj.windowVisible = false;
          curObj.running = false;
          writeFileSync(floatStateFile, JSON.stringify(curObj), 'utf-8');
        }
        return getFloatWindowStatus('darwin');
      };

      // Menu bar is OFF, shortcut is ON -> ensure-menubar must still spawn hidden resident daemon for hotkey!
      const ensureScOnly = await controlFloatWindow(
        { action: 'ensure-menubar' },
        { platform: 'darwin', spawnDaemon: mockScSpawn, sendDaemonCommand: mockScSendCmd }
      );
      assert(
        scSpawnCount === 1 && ensureScOnly.daemonRunning === true && ensureScOnly.menubarEnabled === false && ensureScOnly.shortcutActive === true,
        `菜单栏关闭但快捷键开启时 ensure-menubar 应启动常驻守护以监听热键：${JSON.stringify(ensureScOnly)}`
      );

      // Mark window visible and call close -> must send hideWindow (NOT terminate daemon) while shortcut is ON
      const visObj = JSON.parse(readFileSync(floatStateFile, 'utf-8'));
      visObj.windowVisible = true;
      visObj.running = true;
      writeFileSync(floatStateFile, JSON.stringify(visObj), 'utf-8');
      const closeKeepResident = await controlFloatWindow(
        { action: 'close' },
        { platform: 'darwin', spawnDaemon: mockScSpawn, sendDaemonCommand: mockScSendCmd }
      );
      assert(
        lastSentCmd?.cmd === 'hideWindow' && isTestPidAlive(scDaemonProc.pid) && closeKeepResident.closed === true,
        '快捷键开启但菜单栏关闭时收回窗口不应杀死原生热键守护进程'
      );

      // When menubar and standalone shortcut are OFF, but auxShortcut is ON -> daemon still stays resident!
      setShortcutConfig({ enabled: false }, 'darwin');
      setAuxShortcutConfig({ reset: true }, 'darwin');
      visObj.shortcutEnabled = false;
      visObj.auxShortcutEnabled = true;
      visObj.windowVisible = true;
      visObj.running = true;
      writeFileSync(floatStateFile, JSON.stringify(visObj), 'utf-8');
      const closeKeepAuxResident = await controlFloatWindow(
        { action: 'close' },
        { platform: 'darwin', spawnDaemon: mockScSpawn, sendDaemonCommand: mockScSendCmd }
      );
      assert(
        lastSentCmd?.cmd === 'hideWindow' && isTestPidAlive(scDaemonProc.pid) && closeKeepAuxResident.closed === true,
        '仅侧栏快捷键开启时收回独立小窗不应杀死原生热键守护进程'
      );

      // When menubar, standalone shortcut, and auxShortcut are ALL OFF -> close terminates non-resident daemon, and ensure-menubar does not spawn
      setAuxShortcutConfig({ enabled: false }, 'darwin');
      visObj.auxShortcutEnabled = false;
      visObj.windowVisible = true;
      visObj.running = true;
      writeFileSync(floatStateFile, JSON.stringify(visObj), 'utf-8');
      await controlFloatWindow(
        { action: 'close' },
        { platform: 'darwin', spawnDaemon: mockScSpawn, sendDaemonCommand: mockScSendCmd }
      );
      assert(!isTestPidAlive(scDaemonProc.pid), '菜单栏与双快捷键均关闭时关闭小窗应退出守护进程');

      const noSpawnWhenAllOff = await controlFloatWindow(
        { action: 'ensure-menubar' },
        { platform: 'darwin', spawnDaemon: mockScSpawn, sendDaemonCommand: mockScSendCmd }
      );
      assert(scSpawnCount === 1 && noSpawnWhenAllOff.daemonRunning === false, '菜单栏与双快捷键均关闭时 ensure-menubar 不得拉起守护进程');
      setShortcutConfig({ reset: true }, 'darwin');
      setAuxShortcutConfig({ reset: true }, 'darwin');
    } finally {
      for (const p of scProcs) {
        try { p.kill('SIGKILL'); } catch {}
      }
    }

    // CLI shortcut status & validation check in isolated environment
    const cliEntryPath = join(ROOT, 'sidecars', 'dashboard', 'cli.mjs');
    const cliScStatusRaw = execFileSync(process.execPath, [cliEntryPath, 'shortcut', 'status', '--json'], {
      encoding: 'utf-8',
      env: isolatedEnv,
      timeout: 15000
    });
    const cliScStatus = JSON.parse(cliScStatusRaw);
    assert(
      cliScStatus.ok === true && cliScStatus.shortcut?.enabled === true && cliScStatus.shortcut?.isDefault === true,
      `cli.mjs shortcut status --json 输出异常：${cliScStatusRaw}`
    );
    let badCliRejected = false;
    try {
      execFileSync(process.execPath, [cliEntryPath, 'shortcut', 'k'], {
        encoding: 'utf-8',
        env: isolatedEnv,
        stdio: 'pipe',
        timeout: 15000
      });
    } catch (err) {
      badCliRejected = err.status === 1;
    }
    assert(badCliRejected, 'cli.mjs shortcut k 单字母非法快捷键必须返回退出码 1');

    // CLI aux-shortcut & aux trigger bus checks in isolated environment
    const cliAuxScRaw = execFileSync(process.execPath, [cliEntryPath, 'aux-shortcut', 'status', '--json'], {
      encoding: 'utf-8',
      env: isolatedEnv,
      timeout: 15000
    });
    const cliAuxSc = JSON.parse(cliAuxScRaw);
    assert(cliAuxSc.ok === true && cliAuxSc.auxShortcut?.enabled === true, `cli.mjs aux-shortcut status --json 异常：${cliAuxScRaw}`);

    execFileSync(process.execPath, [cliEntryPath, 'aux-shortcut', 'Ctrl+Shift+L'], {
      encoding: 'utf-8',
      env: isolatedEnv,
      stdio: 'pipe',
      timeout: 15000
    });
    assert(getAuxShortcutConfig().accelerator === 'Ctrl+Shift+L', 'cli.mjs aux-shortcut 设置未持久化');
    execFileSync(process.execPath, [cliEntryPath, 'aux-shortcut', 'reset'], {
      encoding: 'utf-8',
      env: isolatedEnv,
      stdio: 'pipe',
      timeout: 15000
    });

    const cliAuxRaw = execFileSync(process.execPath, [cliEntryPath, 'aux', '--json'], {
      encoding: 'utf-8',
      env: isolatedEnv,
      timeout: 15000
    });
    const cliAuxJson = JSON.parse(cliAuxRaw);
    const busTrig = readAuxPaneTrigger();
    assert(
      cliAuxJson.ok === true &&
        cliAuxJson.trigger?.targetPlugin === 'context-viewer' &&
        busTrig.seq === cliAuxJson.trigger.seq,
      `cli.mjs aux --json 触发写入异常：${cliAuxRaw}`
    );

    // CLI runtime source attribution & restricted-scandir fallback checks
    const cliEnvRoot = mkdtempSync(join(tmpdir(), 'agy-ctx-cli-env-'));
    const cliAppDataDir = join(cliEnvRoot, 'antigravity-cli');
    const cliBrainRoot = join(cliAppDataDir, 'brain');
    const cliTestConvId = 'd1e2c3b4a5f60009';
    const cliConvLogDir = join(cliBrainRoot, cliTestConvId, '.system_generated', 'logs');
    try {
      mkdirSync(cliConvLogDir, { recursive: true });
      writeFileSync(
        join(cliConvLogDir, 'transcript.jsonl'),
        [
          JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-18T03:00:00Z', content: 'CLI test' }),
          JSON.stringify({
            step_index: 1,
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-18T03:00:02Z',
            model: 'Gemini 4 Hydrogen',
            input_tokens: 1500,
            cache_read_tokens: 500,
            output_tokens: 120
          })
        ].join('\n') + '\n',
        'utf-8'
      );
      const cliRuntimeEnv = {
        ...isolatedEnv,
        ANTIGRAVITY_APP_DATA_DIR: cliAppDataDir,
        ANTIGRAVITY_LS_VERSION: 'cli-1.5.10',
        ANTIGRAVITY_CONVERSATION_ID: cliTestConvId
      };
      delete cliRuntimeEnv.AG_CLI_DIR;

      if (process.platform !== 'win32' && process.getuid?.() !== 0) {
        chmodSync(cliBrainRoot, 0o111);
      }
      const cliAdaptedRaw = execFileSync(process.execPath, [cliEntryPath, 'json'], {
        encoding: 'utf-8',
        env: cliRuntimeEnv,
        timeout: 15000
      });
      const cliAdaptedJson = JSON.parse(cliAdaptedRaw);
      assert(
        cliAdaptedJson.runtimeEnv === 'cli' &&
          cliAdaptedJson.conversation?.id === cliTestConvId &&
          cliAdaptedJson.conversation?.source === 'cli' &&
          Number(cliAdaptedJson.globalHistory?.cliConversations || 0) >= 1,
        `CLI 运行时来源识别或直读会话补录异常：${cliAdaptedRaw}`
      );
      if (process.platform !== 'win32' && process.getuid?.() !== 0) {
        assert(
          cliAdaptedJson.historyStatus?.state === 'restricted' &&
            cliAdaptedJson.historyStatus?.restrictedSources?.includes('cli'),
          `scandir 受限时应标记 historyStatus.state=restricted：${cliAdaptedRaw}`
        );
      }
      const cliPrettyOut = execFileSync(process.execPath, [cliEntryPath], {
        encoding: 'utf-8',
        env: cliRuntimeEnv,
        timeout: 15000
      });
      assert(
        cliPrettyOut.includes('[CLI]') && !cliPrettyOut.includes('[Desktop]'),
        `CLI 终端看板不应误标为 [Desktop]：\n${cliPrettyOut}`
      );
    } finally {
      if (process.platform !== 'win32' && existsSync(cliBrainRoot)) {
        try { chmodSync(cliBrainRoot, 0o755); } catch {}
      }
      rmSync(cliEnvRoot, { recursive: true, force: true });
    }

    // CLI statusline (render + disk cache hydration + settings.json lifecycle) & watch --once
    const slTestRoot = mkdtempSync(join(tmpdir(), 'agy-ctx-sl-'));
    try {
      const slCliDir = join(slTestRoot, 'antigravity-cli');
      const slAgDir = join(slTestRoot, 'antigravity');
      const slStateDir = join(slTestRoot, 'state');
      const slConvId = '00000000-0000-4000-8000-000000000009';
      const slConvLogDir = join(slCliDir, 'brain', slConvId, '.system_generated', 'logs');
      mkdirSync(slConvLogDir, { recursive: true });
      mkdirSync(slStateDir, { recursive: true });
      mkdirSync(join(slAgDir, 'brain'), { recursive: true });

      const slSettingsPath = join(slCliDir, 'settings.json');
      writeFileSync(slSettingsPath, JSON.stringify({ theme: 'dark', customFlag: 42 }, null, 2), 'utf-8');
      writeFileSync(
        join(slConvLogDir, 'transcript.jsonl'),
        [
          JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-18T06:00:00Z', content: 'Test statusline' }),
          JSON.stringify({
            step_index: 1,
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-18T06:00:02Z',
            model: 'gemini-4-carbon-high',
            input_tokens: 13880,
            cache_read_tokens: 0,
            output_tokens: 82
          })
        ].join('\n') + '\n',
        'utf-8'
      );

      // Seed isolated disk caches (no ANTIGRAVITY_LS_ADDRESS provided)
      writeFileSync(
        join(slStateDir, 'host_status_cache_v1.json'),
        JSON.stringify({
          version: 1,
          entries: {
            ls_0000000000000001: {
              at: Date.now(),
              sig: 'host:test',
              fetchedAt: new Date().toISOString(),
              plan: { tierName: 'Pro' },
              modelConfigs: [
                {
                  label: 'Gemini 4 Carbon (High)',
                  modelOrAlias: { model: 'gemini-4-carbon-high' },
                  quotaInfo: { remainingFraction: 0.91 }
                }
              ],
              quotas: [
                {
                  id: 'gemini',
                  displayTitle: 'Gemini 模型',
                  fiveHour: { remainingPercent: 91 },
                  weekly: { remainingPercent: 88 },
                  remainingPercent: 88
                }
              ],
              quotaStatus: { state: 'live', stale: false, source: 'live' }
            }
          }
        }),
        'utf-8'
      );
      writeFileSync(
        join(slStateDir, 'active_conv_gen_cache_v1.json'),
        JSON.stringify({
          version: 2,
          convs: {
            [slConvId]: {
              fetchedAt: Date.now(),
              size: 1,
              mtimeMs: 1,
              settled: true,
              generatorList: [
                {
                  stepIndex: 1,
                  model: 'gemini-4-carbon-high',
                  chatModel: {
                    model: 'gemini-4-carbon-high',
                    usage: { inputTokens: 13880, outputTokens: 82, cacheReadTokens: 0 },
                    timeToFirstToken: 1.0,
                    streamingDuration: 2.0,
                    chatStartMetadata: {
                      contextWindowMetadata: { maxContextTokens: 512000 }
                    }
                  }
                }
              ]
            }
          }
        }),
        'utf-8'
      );

      const slEnv = {
        ...isolatedEnv,
        AG_DIR: slAgDir,
        AG_CLI_DIR: slCliDir,
        ANTIGRAVITY_EXECUTABLE_DATA_DIR: slStateDir,
        ANTIGRAVITY_CONVERSATION_ID: '',
        ANTIGRAVITY_LS_ADDRESS: '',
        ANTIGRAVITY_CSRF_TOKEN: ''
      };

      const slInstall = JSON.parse(execFileSync(process.execPath, [cliEntryPath, 'statusline', 'install', '--json'], {
        encoding: 'utf-8',
        env: slEnv,
        timeout: 10000
      }));
      assert(
        slInstall.ok === true &&
          slInstall.enabled === true &&
          slInstall.stackWithDefault === true &&
          slInstall.command.includes('statusline'),
        `statusline install 失败：${JSON.stringify(slInstall)}`
      );
      const savedAfterInstall = JSON.parse(readFileSync(slSettingsPath, 'utf-8'));
      assert(
        savedAfterInstall.theme === 'dark' &&
          savedAfterInstall.customFlag === 42 &&
          savedAfterInstall.statusLine?.enabled === true &&
          savedAfterInstall.statusLine?.stack_with_default === true,
        'statusline install 不得覆盖 settings.json 原有字段'
      );

      const slOff = JSON.parse(execFileSync(process.execPath, [cliEntryPath, 'statusline', 'off', '--json'], {
        encoding: 'utf-8',
        env: slEnv,
        timeout: 10000
      }));
      assert(slOff.ok === true && slOff.enabled === false && slOff.configured === true, 'statusline off 状态异常');

      const slReplace = JSON.parse(execFileSync(process.execPath, [cliEntryPath, 'statusline', 'on', '--replace', '--json'], {
        encoding: 'utf-8',
        env: slEnv,
        timeout: 10000
      }));
      assert(slReplace.ok === true && slReplace.enabled === true && slReplace.stackWithDefault === false, 'statusline --replace 状态异常');

      const slEmptyOut = execFileSync(process.execPath, [cliEntryPath, 'statusline', '--format', 'plain'], {
        input: JSON.stringify({
          session_id: '',
          conversation_id: '',
          model: { display_name: 'Gemini 4 Carbon (High)' },
          terminal_width: 80
        }),
        encoding: 'utf-8',
        env: slEnv,
        timeout: 10000
      });
      assert(
        slEmptyOut.includes('◈ Carbon') && slEmptyOut.includes('就绪') && !slEmptyOut.includes('14.0K'),
        `空 session_id 的 statusline 不应串联其他会话：${slEmptyOut}`
      );

      const slActivePayload = JSON.stringify({
        session_id: slConvId,
        conversation_id: slConvId,
        model: { display_name: 'Gemini 4 Carbon (High)' },
        context_window: {
          total_input_tokens: 13880,
          total_output_tokens: 82,
          context_window_size: 0,
          used_percentage: 0,
          current_usage: { input_tokens: 13880, output_tokens: 82, cache_read_tokens: 0 }
        },
        terminal_width: 96
      });
      const slPlainOut = execFileSync(process.execPath, [cliEntryPath, 'statusline', '--format', 'plain'], {
        input: slActivePayload,
        encoding: 'utf-8',
        env: slEnv,
        timeout: 10000
      });
      assert(
        slPlainOut.includes('Carbon') &&
          slPlainOut.includes('512.0K') &&
          slPlainOut.includes('2.7%') &&
          slPlainOut.includes('C 0%') &&
          slPlainOut.includes('5h 91%'),
        `statusline plain 输出缺少磁盘缓存补齐的水位、缓存或配额：${slPlainOut}`
      );

      const slTmuxOut = execFileSync(process.execPath, [cliEntryPath, 'statusline', '--format', 'tmux'], {
        input: slActivePayload,
        encoding: 'utf-8',
        env: slEnv,
        timeout: 10000
      });
      assert(slTmuxOut.includes('#[fg=') && slTmuxOut.includes('#[default]'), `statusline tmux 格式异常：${slTmuxOut}`);

      const slNarrowOut = execFileSync(process.execPath, [cliEntryPath, 'statusline', '--format', 'plain'], {
        input: JSON.stringify({ ...JSON.parse(slActivePayload), terminal_width: 42 }),
        encoding: 'utf-8',
        env: slEnv,
        timeout: 10000
      });
      assert(slNarrowOut.trim().length <= 42, `窄终端 width=42 下 statusline 超宽：(${slNarrowOut.trim().length}) ${slNarrowOut}`);

      const slCacheConvId = '00000000-0000-4000-8000-000000000010';
      const slCacheLogDir = join(slCliDir, 'brain', slCacheConvId, '.system_generated', 'logs');
      mkdirSync(slCacheLogDir, { recursive: true });
      writeFileSync(
        join(slCacheLogDir, 'transcript.jsonl'),
        [
          JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-18T06:01:00Z', content: 'Test cache statusline' }),
          JSON.stringify({
            step_index: 1,
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-18T06:01:03Z',
            model: 'gemini-4-carbon-high',
            input_tokens: 1850,
            cache_read_tokens: 183650,
            output_tokens: 1200
          })
        ].join('\n') + '\n',
        'utf-8'
      );
      const existingGenCache = JSON.parse(readFileSync(join(slStateDir, 'active_conv_gen_cache_v1.json'), 'utf-8'));
      existingGenCache.convs[slCacheConvId] = {
        fetchedAt: Date.now(),
        size: 1,
        mtimeMs: 1,
        settled: true,
        generatorList: [
          {
            stepIndex: 1,
            model: 'gemini-4-carbon-high',
            chatModel: {
              model: 'gemini-4-carbon-high',
              usage: { inputTokens: 1850, cacheReadTokens: 183650, outputTokens: 1200 },
              timeToFirstToken: 0.6,
              streamingDuration: 2.0,
              chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
            }
          }
        ]
      };
      writeFileSync(join(slStateDir, 'active_conv_gen_cache_v1.json'), JSON.stringify(existingGenCache), 'utf-8');

      const slDefaultWidthOut = execFileSync(process.execPath, [cliEntryPath, 'statusline', '--format', 'plain'], {
        input: JSON.stringify({ session_id: slCacheConvId, conversation_id: slCacheConvId }),
        encoding: 'utf-8',
        env: slEnv,
        timeout: 10000
      });
      assert(
        slDefaultWidthOut.includes('C 99%') &&
          slDefaultWidthOut.includes('5h 91%') &&
          slDefaultWidthOut.includes('$'),
        `管道默认宽度下 statusline 应完整保留缓存命中率与全部状态段：${slDefaultWidthOut}`
      );
      const slWidth80Out = execFileSync(process.execPath, [cliEntryPath, 'statusline', '--format', 'plain'], {
        input: JSON.stringify({ session_id: slCacheConvId, conversation_id: slCacheConvId, terminal_width: 80 }),
        encoding: 'utf-8',
        env: slEnv,
        timeout: 10000
      });
      assert(
        slWidth80Out.includes('C 99%') && slWidth80Out.includes('5h 91%'),
        `80 列终端下 statusline 应优先保留缓存命中率：${slWidth80Out}`
      );

      // Neon CLI statusline, pricing & cached MODEL_PLACEHOLDER_M537 budget matching
      const slNeonConvId = '00000000-0000-4000-8000-000000000011';
      const slNeonBudgetConvId = '00000000-0000-4000-8000-000000000012';
      const slNeonLogDir = join(slCliDir, 'brain', slNeonConvId, '.system_generated', 'logs');
      mkdirSync(slNeonLogDir, { recursive: true });
      writeFileSync(
        join(slNeonLogDir, 'transcript.jsonl'),
        [
          JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-19T02:00:00Z', content: 'Test Neon statusline' }),
          JSON.stringify({
            step_index: 1,
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-19T02:00:03Z',
            model: 'gemini-pro-orchestrator-neon',
            input_tokens: 5000,
            cache_read_tokens: 185000,
            output_tokens: 1000
          })
        ].join('\n') + '\n',
        'utf-8'
      );
      const neonGenCache = JSON.parse(readFileSync(join(slStateDir, 'active_conv_gen_cache_v1.json'), 'utf-8'));
      neonGenCache.convs[slNeonBudgetConvId] = {
        fetchedAt: Date.now() + 1000,
        size: 1,
        mtimeMs: 1,
        settled: true,
        generatorList: [
          {
            stepIndex: 1,
            chatModel: {
              model: 'MODEL_PLACEHOLDER_M537',
              modelDisplayName: 'Orchestrator (Neon)',
              responseModel: 'gemini-pro-orchestrator-neon',
              chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 1000000 } }
            }
          }
        ]
      };
      writeFileSync(join(slStateDir, 'active_conv_gen_cache_v1.json'), JSON.stringify(neonGenCache), 'utf-8');

      const slNeonOut = execFileSync(process.execPath, [cliEntryPath, 'statusline', '--format', 'plain'], {
        input: JSON.stringify({ session_id: slNeonConvId, conversation_id: slNeonConvId }),
        encoding: 'utf-8',
        env: slEnv,
        timeout: 10000
      });
      assert(
        slNeonOut.includes('◈ Neon') &&
          !slNeonOut.includes('gemini-pro-orchestrator-neon') &&
          slNeonOut.includes('1.00M') &&
          slNeonOut.includes('C 97%') &&
          slNeonOut.includes('$') &&
          slNeonOut.includes('5h 91%'),
        `Neon CLI statusline 展示、计价或占位缓存窗口匹配异常：${slNeonOut}`
      );
      const slNeonStdinFallbackOut = execFileSync(process.execPath, [cliEntryPath, 'statusline', '--format', 'plain'], {
        input: JSON.stringify({ session_id: '', conversation_id: '', model: { id: 'gemini-pro-orchestrator-neon' } }),
        encoding: 'utf-8',
        env: slEnv,
        timeout: 10000
      });
      assert(
        slNeonStdinFallbackOut.includes('◈ Neon') && !slNeonStdinFallbackOut.includes('gemini-pro-orchestrator-neon'),
        `空会话下 stdin model.id 回退未规范化为 Neon：${slNeonStdinFallbackOut}`
      );

      const slUninstall = JSON.parse(execFileSync(process.execPath, [cliEntryPath, 'statusline', 'uninstall', '--json'], {
        encoding: 'utf-8',
        env: slEnv,
        timeout: 10000
      }));
      const savedAfterUninstall = JSON.parse(readFileSync(slSettingsPath, 'utf-8'));
      assert(
        slUninstall.ok === true && !('statusLine' in savedAfterUninstall) && savedAfterUninstall.theme === 'dark',
        'statusline uninstall 未干净移除配置或破坏原有设置'
      );

      const watchOut = execFileSync(process.execPath, [cliEntryPath, 'watch', slConvId, '--once'], {
        encoding: 'utf-8',
        env: slEnv,
        timeout: 10000
      });
      assert(
        watchOut.includes('上下文实时监控') && watchOut.includes('[CLI]') && watchOut.includes('512.0K'),
        `watch --once 输出异常：\n${watchOut}`
      );

      const cliJsonOut = JSON.parse(execFileSync(process.execPath, [cliEntryPath, 'json', slConvId], {
        encoding: 'utf-8',
        env: slEnv,
        timeout: 10000
      }));
      assert(
        cliJsonOut.quotaStatus?.state === 'stale' &&
          cliJsonOut.quotaStatus?.source === 'disk_cache' &&
          cliJsonOut.quotas?.length === 1 &&
          cliJsonOut.globalHistory?.plan?.includes('Pro'),
        `无语言服务时 cli.mjs json 未复用磁盘缓存套餐与配额：${JSON.stringify(cliJsonOut.quotaStatus)} / ${cliJsonOut.globalHistory?.plan}`
      );
    } finally {
      rmSync(slTestRoot, { recursive: true, force: true });
    }

    // Aux Pane freshness resolution vs stale activeConvId + opening/deferred ack state machine
    const staleConvId = 'b2000000-0000-4000-8000-000000000002';
    const freshConvId = 'c3000000-0000-4000-8000-000000000003';
    for (const [id, title] of [[staleConvId, '旧会话'], [freshConvId, '新会话']]) {
      const ldir = join(isolatedAgDir, 'brain', id, '.system_generated', 'logs');
      mkdirSync(ldir, { recursive: true });
      writeFileSync(
        join(ldir, 'transcript.jsonl'),
        `${JSON.stringify({ type: 'USER_INPUT', content: title })}\n`,
        'utf-8'
      );
    }
    mkdirSync(join(isolatedAgDir, 'annotations'), { recursive: true });
    const futureSec = Math.floor((Date.now() + 20000) / 1000);
    writeFileSync(
      join(isolatedAgDir, 'annotations', `${freshConvId}.pbtxt`),
      `title: "新会话"\nlast_user_view_time: {\n  seconds: ${futureSec}\n  nanos: 0\n}\n`,
      'utf-8'
    );
    recordAuxActiveConversation({ convId: staleConvId });
    assert(
      resolveDesktopForegroundConversationId() === freshConvId,
      `resolveDesktopForegroundConversationId 应优先更新的 Desktop 会话而非陈旧 activeConvId：${resolveDesktopForegroundConversationId()}`
    );
    const auxOpenTrig = writeAuxPaneTrigger({
      targetPlugin: 'context-viewer',
      uri: 'sidecar://context-viewer/dashboard/',
      action: 'toggle'
    });
    assert(
      auxOpenTrig.convId === freshConvId && auxOpenTrig.openingSeq === 0,
      `writeAuxPaneTrigger 应解析到最新 Desktop 会话并重置 openingSeq：${JSON.stringify(auxOpenTrig)}`
    );
    assert(
      markAuxPaneOpening({ seq: auxOpenTrig.seq }).claimed === true &&
        markAuxPaneOpening({ seq: auxOpenTrig.seq }).claimed === false &&
        readAuxPaneTrigger().ackSeq < auxOpenTrig.seq,
      'markAuxPaneOpening 应互斥抢占 openingSeq 且不提前推进 ackSeq'
    );
    assert(
      ackAuxPaneTrigger({ seq: auxOpenTrig.seq, plugin: 'context-viewer' }).claimed === true &&
        readAuxPaneTrigger().ackSeq === auxOpenTrig.seq,
      'ackAuxPaneTrigger 应在确认可见后正式推进 ackSeq'
    );

    // Background conversation with newer mtimeMs & older viewTimeMs must NOT hijack foreground convId;
    // cur.at must NOT artificially refresh stale activeConvId; BatchRecordUserLastUpdateTimes tie must stay stable.
    const bgConvId = '00000000-0000-4000-8000-000000000004';
    const fgTiedConvId = '00000000-0000-4000-8000-000000000005';
    for (const [id, title] of [[bgConvId, '后台任务会话'], [fgTiedConvId, '前台切换目标']]) {
      const ldir = join(isolatedAgDir, 'brain', id, '.system_generated', 'logs');
      mkdirSync(ldir, { recursive: true });
      writeFileSync(
        join(ldir, 'transcript.jsonl'),
        `${JSON.stringify({ type: 'USER_INPUT', content: title })}\n`,
        'utf-8'
      );
    }
    const bgViewSec = Math.floor((Date.now() + 10000) / 1000);
    const fgTiedViewSec = Math.floor((Date.now() + 30000) / 1000);
    writeFileSync(
      join(isolatedAgDir, 'annotations', `${bgConvId}.pbtxt`),
      `title: "后台任务会话"\nlast_user_view_time: {\n  seconds: ${bgViewSec}\n  nanos: 0\n}\n`,
      'utf-8'
    );
    writeFileSync(
      join(isolatedAgDir, 'annotations', `${freshConvId}.pbtxt`),
      `title: "新会话"\nlast_user_view_time: {\n  seconds: ${fgTiedViewSec}\n  nanos: 0\n}\n`,
      'utf-8'
    );
    writeFileSync(
      join(isolatedAgDir, 'annotations', `${fgTiedConvId}.pbtxt`),
      `title: "前台切换目标"\nlast_user_view_time: {\n  seconds: ${fgTiedViewSec}\n  nanos: 0\n}\n`,
      'utf-8'
    );
    const futureTurnSec = fgTiedViewSec + 60;
    utimesSync(
      join(isolatedAgDir, 'brain', bgConvId, '.system_generated', 'logs', 'transcript.jsonl'),
      futureTurnSec,
      futureTurnSec
    );
    // Simulate stale activeConvId (no recent activeConvUpdatedAt) and tie-break from freshConvId -> fgTiedConvId
    const staleTrigger = {
      seq: readAuxPaneTrigger().seq + 1,
      targetPlugin: 'context-viewer',
      at: (fgTiedViewSec + 120) * 1000,
      activeConvId: bgConvId,
      activeConvUpdatedAt: bgViewSec * 1000,
      viewBatchMs: bgViewSec * 1000,
      viewWinnerId: freshConvId
    };
    assert(
      resolveDesktopForegroundConversationId({ curTrigger: staleTrigger }) === fgTiedConvId,
      `后台会话 newer mtime 或陈旧 cur.at 不得劫持前台对话，应切到 fgTiedConvId，实际：${resolveDesktopForegroundConversationId({ curTrigger: staleTrigger })}`
    );
    // Once viewBatchMs is caught up, repeat resolution must remain stable on viewWinnerId
    const secondPressTrig = writeAuxPaneTrigger({
      targetPlugin: 'context-viewer',
      uri: 'sidecar://context-viewer/dashboard/',
      action: 'toggle'
    });
    const thirdPressTrig = writeAuxPaneTrigger({
      targetPlugin: 'context-viewer',
      uri: 'sidecar://context-viewer/dashboard/',
      action: 'toggle'
    });
    assert(
      secondPressTrig.convId === thirdPressTrig.convId && thirdPressTrig.convId !== bgConvId,
      `同一前台标签连续按键应稳定命中同一非后台对话：${secondPressTrig.convId} vs ${thirdPressTrig.convId}`
    );

    // Regression check for IntersectionObserver visibility detection, holdMs unthrottled wakeup, Pinned Tab & hidden toggleConversation -> visible toggleAuxPane bridge in dashboard/app.js
    const cvAppSource = readFileSync(join(ROOT, 'sidecars', 'dashboard', 'app.js'), 'utf-8');
    assert(
      cvAppSource.includes('IntersectionObserver') &&
        cvAppSource.includes('intersectionRect') &&
        cvAppSource.includes('agy_aux_ever_visible') &&
        cvAppSource.includes('holdMs=') &&
        cvAppSource.includes('isHostSidebarContext') &&
        cvAppSource.includes('alreadyOpeningOrSwitched') &&
        cvAppSource.includes('window.sidecar.ui.toggleConversation(targetConvId)') &&
        !cvAppSource.includes('if (canToggleAux)') &&
        cvAppSource.includes("toggleAuxPane({ tabType: 'sidecarView', uri: trig.uri })") &&
        !cvAppSource.includes('return window.innerWidth > 40 && window.innerHeight > 40;'),
      'dashboard/app.js 缺少 IntersectionObserver 真可见性检测、holdMs 无节流唤醒、隐藏态 toggleConversation 开栏或可见态 toggleAuxPane 保护'
    );

    // Verify Hero Card Quota promotion & collapsible cumulative block in index.html
    const cvHtmlSource = readFileSync(join(ROOT, 'sidecars', 'dashboard', 'index.html'), 'utf-8');
    const heroCardMatch = cvHtmlSource.match(/id="panel-context"[\s\S]*?<article class="card hero-card">([\s\S]*?)<\/article>/);
    assert(heroCardMatch, '未找到 #panel-context 首个 Hero 卡片');
    const heroHtml = heroCardMatch[1];
    assert(
      heroHtml.includes('id="ctx-quota-box"') &&
        heroHtml.includes('id="cum-collapse-body"') &&
        heroHtml.indexOf('id="ctx-quota-box"') < heroHtml.indexOf('id="ctx-takeaway"') &&
        heroHtml.indexOf('id="ctx-takeaway"') < heroHtml.indexOf('id="cum-collapse-body"'),
      'Hero 卡片应将 #ctx-quota-box 提升至首屏，并将 #cum-collapse-body 默认折叠后置于 takeaway 之后'
    );
    assert(
      (cvHtmlSource.match(/id="ctx-quota-box"/g) || []).length === 1,
      '#ctx-quota-box 在 index.html 中应仅出现一次（已从 Card 2 迁移至 Hero Card）'
    );

    // Real VM behavioral test for R4 (out-of-order conversation switches & per-conversation ETag) and UX #2 (collapsible summary & toggle)
    await verifyDashboardFrontendBehavior(cvAppSource);
    await verifyContextAuxBridgeBehavior(cvAppSource);
    await verifyBatch1Features(cvHtmlSource, cvAppSource);
    await verifyBatch2Features(cvHtmlSource, cvAppSource);
    await verifyStatuslineFastPath();
    await verifyPowertoolsP1P2Features(cvHtmlSource, cvAppSource);
    await verifyCacheStatsAndCustomRange(cvHtmlSource, cvAppSource);
    await verifyCliFollowAndProjectGrouping(cvHtmlSource, cvAppSource);

    // macOS Swift native host typecheck
    if (process.platform === 'darwin' && existsSync('/usr/bin/swiftc')) {
      execFileSync('/usr/bin/swiftc', ['-typecheck', join(ROOT, 'sidecars', 'dashboard', 'native_float_macos.swift')], {
        stdio: 'pipe',
        timeout: 25000
      });
    }
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmpVerifyRoot, { recursive: true, force: true });
  }

  console.log(`[verify] 全部校验通过！当前版本：v${manifest.version}（共检查 ${allFiles.length} 个源码文件）`);
}

async function verifyDashboardFrontendBehavior(appSource) {
  const makeEl = (id = '', initClasses = []) => {
    const classes = new Set(initClasses);
    const attrs = new Map();
    const listeners = new Map();
    return {
      id,
      value: '',
      textContent: '',
      innerHTML: '',
      scrollTop: 0,
      dataset: {},
      style: {},
      className: '',
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
      remove: () => {}
    };
  };

  const els = new Map();
  const getEl = (id) => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };

  const cumBody = makeEl('cum-collapse-body', ['cum-collapse-body', 'hidden']);
  els.set('cum-collapse-body', cumBody);
  const cumTrigger = makeEl('cum-collapse-trigger-btn', ['collapse-trigger', 'cum-collapse-trigger']);
  cumTrigger.dataset.toggle = 'cum-collapse-body';
  cumTrigger.setAttribute('aria-expanded', 'false');

  const convSelect = getEl('conv-select');
  const followBtn = getEl('btn-follow-current');
  const takeaway = getEl('ctx-takeaway');
  const cumSummaryChip = getEl('cum-summary-chip');

  const convA = ['11111111', '2222', '3333', '4444', '555555555501'].join('-');
  const convB = ['11111111', '2222', '3333', '4444', '555555555502'].join('-');
  const convC = ['11111111', '2222', '3333', '4444', '555555555503'].join('-');

  const mkSnap = (convId, title, etag, totalTok = 1200, cost = 0.12) => ({
    ok: true,
    etag,
    conversationId: convId,
    conversationTitle: title,
    source: 'desktop',
    modelName: 'gemini-3.1-pro',
    recentConversations: [
      { id: convA, title: 'Alpha', source: 'desktop' },
      { id: convB, title: 'Bravo', source: 'desktop' },
      { id: convC, title: 'Charlie', source: 'desktop' }
    ],
    window: { used: 1000, budget: 10000, remaining: 9000, pct: 10, serverBudget: 10000, serverPct: 10 },
    context: {
      usedTokens: 1000,
      budgetTokens: 10000,
      inputTokens: 400,
      cacheTokens: 600,
      outputTokens: 200,
      cacheHitPercent: 60,
      roundCostUSD: 0.02,
      sessionCostUSD: cost,
      isPriced: true,
      sessionTotals: {
        cacheTokens: 600,
        inputTokens: 400,
        outputTokens: 200,
        thinkingTokens: 50,
        totalTokens: totalTok,
        cacheHitPercent: 60
      },
      error: { kind: 'none' },
      breakdown: { groups: [] }
    },
    speed: { tps: 45, durationSec: 2.1, ttftSec: 0.3, outputTokens: 200 },
    audit: { groups: {} },
    quotaStatus: {
      active: { label: 'Pro 5h', remainingPercent: 85 },
      pools: [{ label: 'Pro 5h', remainingPercent: 85 }]
    },
    sparkline: [],
    turns: []
  });

  let resolveSlowA = null;
  let holdNextA = false;
  let resolveSlowB = null;
  let holdNextB = false;
  let holdInitialHistory = true;
  let resolveSlowHistory = null;
  const seenContextQueries = [];
  const intervalCbs = [];
  const sessionMap = new Map();
  const localMap = new Map();
  const rootAttrs = new Map();
  const rootStyles = new Map();

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
    NodeFilter: { SHOW_TEXT: 4 },
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ color: 'rgb(255, 255, 255)', getPropertyValue: () => '' }),
    setTimeout,
    clearTimeout,
    clearInterval,
    setInterval: (fn, ms) => {
      intervalCbs.push({ fn, ms });
      return intervalCbs.length;
    },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    localStorage: {
      getItem: (k) => (localMap.has(k) ? localMap.get(k) : null),
      setItem: (k, v) => localMap.set(k, String(v))
    },
    sessionStorage: {
      getItem: (k) => (sessionMap.has(k) ? sessionMap.get(k) : null),
      setItem: (k, v) => sessionMap.set(k, String(v))
    },
    navigator: { platform: 'MacIntel', userAgent: 'Mozilla/5.0' },
    document: {
      readyState: 'complete',
      hidden: false,
      visibilityState: 'visible',
      documentElement: {
        clientWidth: 340,
        clientHeight: 700,
        dataset: {},
        appendChild: () => {},
        style: {
          getPropertyValue: (k) => rootStyles.get(k) || '',
          setProperty: (k, v) => rootStyles.set(k, String(v)),
          removeProperty: (k) => rootStyles.delete(k)
        },
        getAttribute: (k) => (rootAttrs.has(k) ? rootAttrs.get(k) : null),
        setAttribute: (k, v) => rootAttrs.set(k, String(v)),
        hasAttribute: (k) => rootAttrs.has(k),
        removeAttribute: (k) => rootAttrs.delete(k)
      },
      head: { appendChild: () => {} },
      body: makeEl('body'),
      getElementById: getEl,
      querySelector: () => null,
      querySelectorAll: (sel) => (sel === '.collapse-trigger' ? [cumTrigger] : []),
      createTreeWalker: () => ({ nextNode: () => false, currentNode: null }),
      addEventListener: () => {},
      createElement: () => makeEl('')
    },
    window: null,
    fetch: async (urlStr) => {
      const u = new URL(urlStr, 'http://127.0.0.1');
      if (u.pathname === '/api/settings') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            settings: {},
            uiPreferences: { themeMode: 'auto', preset: 'violet', budgetOverride: 0 },
            shortcut: {},
            auxShortcut: {},
            menubar: { supported: false, enabled: false }
          })
        };
      }
      if (u.pathname === '/api/history') {
        if (holdInitialHistory) {
          holdInitialHistory = false;
          const histPayload = await new Promise((r) => { resolveSlowHistory = r; });
          return { ok: true, status: 200, json: async () => histPayload };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            etag: 'hist-1',
            presets: [],
            totals: { totalTokens: 1200 },
            daily: [],
            models: [],
            plans: []
          })
        };
      }
      if (u.pathname === '/api/float-window' || u.pathname === '/api/entrypoints' || u.pathname === '/api/aux-pane-trigger') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (u.pathname === '/api/context') {
        const qConv = u.searchParams.get('conversationId') || convA;
        const qEtag = u.searchParams.get('etag') || '';
        seenContextQueries.push({ convId: qConv, etag: qEtag, force: u.searchParams.get('force') === '1' });
        if (qConv === convA && holdNextA) {
          holdNextA = false;
          const payload = await new Promise((r) => { resolveSlowA = r; });
          return { ok: true, status: 200, json: async () => payload };
        }
        if (qConv === convB && holdNextB) {
          holdNextB = false;
          const payload = await new Promise((r) => { resolveSlowB = r; });
          return { ok: true, status: 200, json: async () => payload };
        }
        const map = {
          [convA]: mkSnap(convA, 'Alpha', 'etag-a', 1200, 0.12),
          [convB]: mkSnap(convB, 'Bravo', 'etag-b', 2400, 0.24),
          [convC]: mkSnap(convC, 'Charlie', 'etag-c', 3600, 0.36)
        };
        const snap = map[qConv] || mkSnap(convA, 'Alpha', 'etag-a', 1200, 0.12);
        if (qEtag && qEtag === snap.etag) {
          return { ok: true, status: 200, json: async () => ({ ok: true, unchanged: true, etag: snap.etag }) };
        }
        return { ok: true, status: 200, json: async () => snap };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  };
  sandbox.window = {
    location: { origin: 'http://127.0.0.1', href: 'http://127.0.0.1/' },
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    getComputedStyle: () => ({ color: 'rgb(255, 255, 255)', getPropertyValue: () => '' }),
    addEventListener: () => {},
    sidecar: { conversationId: convA },
    self: null,
    top: null,
    fetch: sandbox.fetch
  };
  sandbox.location = sandbox.window.location;
  sandbox.window.self = sandbox.window;
  sandbox.window.top = sandbox.window;
  sandbox.globalThis = sandbox;

  runInNewContext(appSource, sandbox, { filename: 'dashboard-app.js' });
  await new Promise((r) => setTimeout(r, 40));

  assert(typeof resolveSlowHistory === 'function', 'boot() 应立即并行发起 /api/history 请求');
  assert(
    intervalCbs.some((c) => c.ms === 1500),
    '慢 /api/history 不得阻塞 1500ms context 轮询定时器注册'
  );
  assert(takeaway.textContent.includes('Alpha'), `初始渲染应显示 Alpha，实际：${takeaway.textContent}`);
  resolveSlowHistory({
    ok: true,
    etag: 'hist-1',
    presets: [],
    totals: { totalTokens: 1200 },
    daily: [],
    models: [],
    plans: []
  });
  await new Promise((r) => setTimeout(r, 15));
  assert(
    cumSummaryChip.textContent.includes('1.20K') && cumSummaryChip.textContent.includes('$0.12'),
    `折叠摘要胶囊应显示累计 1.20K 与 $0.12，实际：${cumSummaryChip.textContent}`
  );

  // Verify UX #2 collapsible toggle works via real wired click handler
  assert(cumBody.classList.contains('hidden'), '累计吞吐默认应处于折叠状态');
  cumTrigger.dispatch('click', { target: cumTrigger });
  assert(!cumBody.classList.contains('hidden') && cumTrigger.getAttribute('aria-expanded') === 'true', '点击折叠标题后应展开累计区块');

  // Verify R4: start slow switch to convB, immediately switch to convC, then resolve stale convB
  holdNextB = true;
  convSelect.value = convB;
  convSelect.dispatch('change', { target: convSelect });
  await new Promise((r) => setTimeout(r, 10));
  assert(typeof resolveSlowB === 'function', '慢请求 B 应已发出并挂起');

  convSelect.value = convC;
  convSelect.dispatch('change', { target: convSelect });
  await new Promise((r) => setTimeout(r, 30));
  assert(takeaway.textContent.includes('Charlie'), `快速切换后应显示最新对话 Charlie，实际：${takeaway.textContent}`);

  // Resolve slow stale convB AFTER convC is active
  resolveSlowB(mkSnap(convB, 'Bravo', 'etag-b', 2400, 0.24));
  await new Promise((r) => setTimeout(r, 30));
  assert(
    takeaway.textContent.includes('Charlie') && !takeaway.textContent.includes('Bravo'),
    `滞后返回的历史对话 B 不得覆盖当前 Charlie，实际：${takeaway.textContent}`
  );

  // Trigger 1500ms ETag poll and verify it sends Charlie's etag-c (never stale etag-b)
  const pollInterval = intervalCbs.find((c) => c.ms === 1500);
  assert(pollInterval, '应注册 1500ms context 轮询定时器');
  const queryStart = seenContextQueries.length;
  pollInterval.fn();
  await new Promise((r) => setTimeout(r, 20));
  const pollReq = seenContextQueries.slice(queryStart).pop();
  assert(
    pollReq && pollReq.convId === convC && pollReq.etag === 'etag-c',
    `轮询必须携带当前对话 convC 的 etag-c，实际：${JSON.stringify(pollReq)}`
  );

  // Switch back to follow-current and verify reset to host convA
  followBtn.dispatch('click', { target: followBtn });
  await new Promise((r) => setTimeout(r, 30));
  assert(takeaway.textContent.includes('Alpha'), `点击跟随当前后应回到宿主对话 Alpha，实际：${takeaway.textContent}`);

  // Verify S4: auto-follow live window.sidecar.conversationId changes while an auto-follow request is in flight
  resolveSlowA = null;
  holdNextA = true;
  const beforeHoldA = seenContextQueries.length;
  pollInterval.fn();
  await new Promise((r) => setTimeout(r, 10));
  assert(typeof resolveSlowA === 'function', '自动跟随慢请求 A 应已发出并挂起');

  // Same live host target while request is in flight must coalesce (no extra request)
  const queriesDuringSameHost = seenContextQueries.length;
  pollInterval.fn();
  await new Promise((r) => setTimeout(r, 10));
  assert(
    seenContextQueries.length === queriesDuringSameHost,
    `同一宿主会话 A 请求在途时轮询应合并跳过，实际多发 ${seenContextQueries.length - queriesDuringSameHost} 次请求`
  );

  // Host switches live sidecar.conversationId to convB while A is still in flight
  sandbox.window.sidecar.conversationId = convB;
  pollInterval.fn();
  await new Promise((r) => setTimeout(r, 30));
  const queriesAfterLiveSwitch = seenContextQueries.slice(beforeHoldA);
  assert(
    queriesAfterLiveSwitch.some((q) => q.convId === convB && q.etag === ''),
    `宿主实时切到 convB 后轮询不得被旧 A 请求阻塞，且应清空 etag，实际：${JSON.stringify(queriesAfterLiveSwitch)}`
  );
  assert(takeaway.textContent.includes('Bravo'), `宿主切到 convB 后应渲染 Bravo，实际：${takeaway.textContent}`);

  // Late A response resolving afterward must be rejected and never overwrite Bravo
  resolveSlowA(mkSnap(convA, 'Alpha', 'etag-a', 1200, 0.12));
  await new Promise((r) => setTimeout(r, 25));
  assert(
    takeaway.textContent.includes('Bravo') && !takeaway.textContent.includes('Alpha'),
    `滞后返回的旧宿主会话 A 不得覆盖当前 Bravo，实际：${takeaway.textContent}`
  );

  // Also verify: if host switches mid-flight and old request resolves BEFORE any new poll fires, old response is still dropped
  holdNextB = true;
  pollInterval.fn();
  await new Promise((r) => setTimeout(r, 10));
  assert(typeof resolveSlowB === 'function', '挂起请求 B 应就绪');
  sandbox.window.sidecar.conversationId = convC;
  resolveSlowB(mkSnap(convB, 'BravoStale', 'etag-b-stale', 2400, 0.24));
  await new Promise((r) => setTimeout(r, 25));
  assert(
    !takeaway.textContent.includes('BravoStale'),
    `响应返回时检测到 live window.sidecar.conversationId 已变为 convC，旧 B 响应必须被丢弃，实际：${takeaway.textContent}`
  );

  // Verify hidden float-window boot skips /api/context and /api/history until __cvOnHostVisibility(true)
  const hiddenFetches = [];
  const hiddenIntervals = [];
  const hiddenEls = new Map();
  const makeHiddenEl = (id, initClasses = []) => {
    const classSet = new Set(initClasses);
    return {
      id,
      innerHTML: '',
      textContent: '',
      value: '',
      disabled: false,
      title: '',
      checked: false,
      dataset: {},
      style: {
        _props: new Map(),
        setProperty(k, v) { this._props.set(k, String(v)); },
        removeProperty(k) { this._props.delete(k); },
        getPropertyValue(k) { return this._props.get(k) || ''; }
      },
      attributes: new Map(),
      classList: {
        add: (...cls) => cls.forEach((c) => classSet.add(c)),
        remove: (...cls) => cls.forEach((c) => classSet.delete(c)),
        toggle: (c, force) => {
          const want = force === undefined ? !classSet.has(c) : Boolean(force);
          if (want) classSet.add(c); else classSet.delete(c);
          return want;
        },
        contains: (c) => classSet.has(c)
      },
      addEventListener: () => {},
      dispatchEvent: () => {},
      querySelectorAll: () => [],
      querySelector: () => null,
      appendChild: () => {},
      insertAdjacentHTML: () => {},
      setAttribute(k, v) { this.attributes.set(k, String(v)); },
      getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; },
      hasAttribute(k) { return this.attributes.has(k); },
      removeAttribute(k) { this.attributes.delete(k); }
    };
  };
  const getHiddenEl = (id) => {
    if (!hiddenEls.has(id)) hiddenEls.set(id, makeHiddenEl(id));
    return hiddenEls.get(id);
  };
  const hiddenRootAttrs = new Map();
  const hiddenRootStyles = new Map();
  const hiddenSandbox = {
    console, Date, Math, JSON, URL, URLSearchParams, Set, Map, Array, Object, String, Number, Boolean, Promise, Error,
    NodeFilter: { SHOW_TEXT: 4 },
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ color: 'rgb(255, 255, 255)', getPropertyValue: () => '' }),
    setTimeout, clearTimeout, clearInterval,
    setInterval: (fn, ms) => { hiddenIntervals.push({ fn, ms }); return hiddenIntervals.length; },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    navigator: { platform: 'MacIntel', userAgent: 'Mozilla/5.0' },
    document: {
      readyState: 'complete',
      hidden: false,
      visibilityState: 'visible',
      documentElement: {
        clientWidth: 340, clientHeight: 700, dataset: {}, appendChild: () => {},
        style: {
          getPropertyValue: (k) => hiddenRootStyles.get(k) || '',
          setProperty: (k, v) => hiddenRootStyles.set(k, String(v)),
          removeProperty: (k) => hiddenRootStyles.delete(k)
        },
        getAttribute: (k) => (hiddenRootAttrs.has(k) ? hiddenRootAttrs.get(k) : null),
        setAttribute: (k, v) => hiddenRootAttrs.set(k, String(v)),
        hasAttribute: (k) => hiddenRootAttrs.has(k),
        removeAttribute: (k) => hiddenRootAttrs.delete(k)
      },
      head: { appendChild: () => {} },
      body: makeHiddenEl('body'),
      getElementById: getHiddenEl,
      querySelector: () => null,
      querySelectorAll: () => [],
      createTreeWalker: () => ({ nextNode: () => false, currentNode: null }),
      addEventListener: () => {},
      createElement: () => makeHiddenEl('')
    },
    window: null,
    fetch: async (urlStr) => {
      const u = new URL(urlStr, 'http://127.0.0.1');
      hiddenFetches.push(u.pathname);
      if (u.pathname === '/api/settings') {
        return { ok: true, status: 200, json: async () => ({ ok: true, settings: {}, uiPreferences: {}, shortcut: {}, auxShortcut: {}, menubar: { supported: true, enabled: true } }) };
      }
      if (u.pathname === '/api/history') {
        return { ok: true, status: 200, json: async () => ({ ok: true, etag: 'hist-h', presets: [], totals: { totalTokens: 600 }, daily: [], models: [], plans: [] }) };
      }
      if (u.pathname === '/api/context') {
        return { ok: true, status: 200, json: async () => mkSnap(convA, 'Alpha', 'etag-h', 600, 0.06) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  };
  hiddenSandbox.window = {
    __CV_FLOAT_MODE__: true,
    __CV_INITIAL_HIDDEN__: true,
    location: { origin: 'http://127.0.0.1', href: 'http://127.0.0.1/' },
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    getComputedStyle: hiddenSandbox.getComputedStyle,
    addEventListener: () => {},
    self: null,
    top: null,
    fetch: hiddenSandbox.fetch
  };
  hiddenSandbox.location = hiddenSandbox.window.location;
  hiddenSandbox.window.self = hiddenSandbox.window;
  hiddenSandbox.window.top = hiddenSandbox.window;
  hiddenSandbox.__CV_FLOAT_MODE__ = true;
  hiddenSandbox.__CV_INITIAL_HIDDEN__ = true;
  hiddenSandbox.globalThis = hiddenSandbox;

  runInNewContext(appSource, hiddenSandbox, { filename: 'dashboard-app-hidden.js' });
  await new Promise((r) => setTimeout(r, 35));
  for (const iv of hiddenIntervals) iv.fn();
  await new Promise((r) => setTimeout(r, 20));
  assert(
    !hiddenFetches.includes('/api/context') && !hiddenFetches.includes('/api/history'),
    `隐藏浮窗启动及定时轮询不得触发 /api/context 或 /api/history，实际：${JSON.stringify(hiddenFetches)}`
  );
  hiddenSandbox.window.__cvOnHostVisibility(true);
  await new Promise((r) => setTimeout(r, 35));
  assert(
    hiddenFetches.includes('/api/context') &&
      hiddenFetches.includes('/api/history') &&
      getHiddenEl('ctx-takeaway').textContent.includes('Alpha'),
    `触发 __cvOnHostVisibility(true) 后应恢复加载 /api/context 与 /api/history 并渲染 Alpha，实际：fetches=${JSON.stringify(hiddenFetches)}, takeaway=${getHiddenEl('ctx-takeaway').textContent}`
  );
}

async function verifyContextAuxBridgeBehavior(appSource) {
  const convA = ['22222222', '3333', '4444', '5555', '666666666601'].join('-');
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
      className: '',
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
      hasAttribute: (k) => attrs.has(k),
      removeAttribute: (k) => attrs.delete(k),
      addEventListener: () => {},
      appendChild: () => {},
      focus: () => {},
      scrollIntoView: () => {}
    };
  };

  const runScenario = async ({ pathname = '/', initialTrigger }) => {
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
      convId: convA,
      at: 0,
      openingSeq: 0,
      ackSeq: 0,
      switchedSeq: 0,
      ...initialTrigger
    };
    const helloCalls = [];
    const toggleAuxCalls = [];
    const ignoredHiddenToggleAuxCalls = [];
    const toggleConvCalls = [];
    const parentMessages = [];
    const ioCallbacks = [];
    const longPollWaiters = [];
    let currentIoVisible = false;
    const sessionMap = new Map();
    const localMap = new Map();
    const rootAttrs = new Map();
    const rootStyles = new Map();
    const intervalCbs = [];

    const mockFetch = async (urlStr, opts = {}) => {
      const u = new URL(urlStr, 'http://127.0.0.1');
      if (u.pathname === '/api/aux-pane-trigger') {
        const method = String(opts.method || 'GET').toUpperCase();
        if (method === 'POST') {
          const body = opts.body ? JSON.parse(opts.body) : {};
          const act = String(body.action || '');
          const s = Number(body.seq || 0);
          if (act === 'hello') {
            helloCalls.push(body.convId || '');
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
          }
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
            trigState.ackPlugin = body.plugin || 'context-viewer';
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
      if (u.pathname === '/api/settings') {
        return { ok: true, status: 200, json: async () => ({ ok: true, settings: {}, uiPreferences: {}, shortcut: {}, auxShortcut: {}, menubar: { supported: false, enabled: false } }) };
      }
      if (u.pathname === '/api/history') {
        return { ok: true, status: 200, json: async () => ({ ok: true, etag: 'hist-aux', presets: [], totals: { totalTokens: 100 }, daily: [], models: [], plans: [] }) };
      }
      if (u.pathname === '/api/context') {
        return { ok: true, status: 200, json: async () => ({ ok: true, etag: 'ctx-aux', conversationId: convA, context: { usedTokens: 100, budgetTokens: 1000, breakdown: { groups: [] } }, window: { used: 100, budget: 1000, remaining: 900, pct: 10 }, speed: {}, quotaStatus: { pools: [] }, sparkline: [], turns: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

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
      NodeFilter: { SHOW_TEXT: 4 },
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
      setTimeout,
      clearTimeout,
      clearInterval,
      setInterval: (fn, ms) => {
        intervalCbs.push({ fn, ms });
        return intervalCbs.length;
      },
      requestAnimationFrame: (fn) => { fn(); return 1; },
      localStorage: {
        getItem: (k) => (localMap.has(k) ? localMap.get(k) : null),
        setItem: (k, v) => localMap.set(k, String(v))
      },
      sessionStorage: {
        getItem: (k) => (sessionMap.has(k) ? sessionMap.get(k) : null),
        setItem: (k, v) => sessionMap.set(k, String(v))
      },
      navigator: { platform: 'MacIntel', userAgent: 'Mozilla/5.0' },
      addEventListener: () => {},
      removeEventListener: () => {},
      document: {
        readyState: 'complete',
        hidden: false,
        visibilityState: 'visible',
        documentElement: {
          clientWidth: 340,
          clientHeight: 680,
          dataset: {},
          appendChild: () => {},
          style: {
            getPropertyValue: (k) => rootStyles.get(k) || '',
            setProperty: (k, v) => rootStyles.set(k, String(v)),
            removeProperty: (k) => rootStyles.delete(k)
          },
          getAttribute: (k) => (rootAttrs.has(k) ? rootAttrs.get(k) : null),
          setAttribute: (k, v) => rootAttrs.set(k, String(v)),
          hasAttribute: (k) => rootAttrs.has(k),
          removeAttribute: (k) => rootAttrs.delete(k)
        },
        head: { appendChild: () => {} },
        body: makeStubEl('body'),
        getElementById: getEl,
        querySelector: () => null,
        querySelectorAll: () => [],
        createTreeWalker: () => ({ nextNode: () => false, currentNode: null }),
        addEventListener: () => {},
        createElement: () => makeStubEl('')
      },
      window: null,
      fetch: mockFetch
    };

    const loc = { origin: 'http://127.0.0.1', pathname, href: `http://127.0.0.1${pathname}` };
    sandbox.window = {
      location: loc,
      matchMedia: () => ({ matches: false, addEventListener: () => {} }),
      getComputedStyle: sandbox.getComputedStyle,
      addEventListener: () => {},
      parent: { postMessage: (msg) => parentMessages.push(msg) },
      sidecar: {
        conversationId: convA,
        fetch: mockFetch,
        getWorkspaceUris: async () => [],
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
    sandbox.location = loc;
    sandbox.window.self = sandbox.window;
    sandbox.window.top = sandbox.window;
    sandbox.globalThis = sandbox;

    runInNewContext(appSource, sandbox, { filename: `dashboard-aux-bridge-${pathname}.js` });
    await new Promise((r) => setTimeout(r, 25));

    return {
      trigState,
      helloCalls,
      toggleAuxCalls,
      ignoredHiddenToggleAuxCalls,
      toggleConvCalls,
      parentMessages,
      setIoVisible: (visible) => {
        currentIoVisible = Boolean(visible);
        for (const cb of ioCallbacks) {
          cb([{
            isIntersecting: currentIoVisible,
            intersectionRect: currentIoVisible ? { width: 340, height: 680 } : { width: 0, height: 0 }
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

  // Case 1: Hidden Aux Pane iframe expands pane via toggleConversation, then visible peer switches tab via toggleAuxPane
  const sc1 = await runScenario({
    pathname: '/',
    initialTrigger: { seq: 9, at: Date.now() - 10000, ackSeq: 9, openingSeq: 9, switchedSeq: 9 }
  });
  sc1.setIoVisible(false);
  sc1.pushTrigger({
    seq: 10,
    targetPlugin: 'agy-finder',
    uri: 'sidecar://agy-finder/tree/',
    action: 'toggle',
    convId: convA,
    at: Date.now(),
    openingSeq: 0,
    switchedSeq: 0
  });
  await new Promise((r) => setTimeout(r, 45));
  assert(
    sc1.trigState.openingSeq === 10 &&
      sc1.trigState.switchedSeq === 0 &&
      sc1.toggleConvCalls.length === 1 &&
      sc1.toggleConvCalls[0] === convA &&
      sc1.ignoredHiddenToggleAuxCalls.length === 0 &&
      sc1.toggleAuxCalls.length === 0 &&
      !sc1.parentMessages.some((m) => m?.type === 'sidecar-key-event'),
    `隐藏态必须先调用 toggleConversation 展开侧栏且不得在隐藏态调用 toggleAuxPane：conv=${JSON.stringify(sc1.toggleConvCalls)}, hiddenAux=${JSON.stringify(sc1.ignoredHiddenToggleAuxCalls)}, trig=${JSON.stringify(sc1.trigState)}`
  );
  sc1.setIoVisible(true);
  await new Promise((r) => setTimeout(r, 40));
  assert(
    sc1.trigState.switchedSeq === 10 &&
      sc1.trigState.ackSeq === 10 &&
      sc1.ignoredHiddenToggleAuxCalls.length === 0 &&
      sc1.toggleAuxCalls.length === 1 &&
      sc1.toggleAuxCalls[0]?.tabType === 'sidecarView' &&
      sc1.toggleAuxCalls[0]?.uri === 'sidecar://agy-finder/tree/',
    `侧栏展开可见后对端句柄应在 visible===true 时切换至目标 sidecarView：aux=${JSON.stringify(sc1.toggleAuxCalls)}, trig=${JSON.stringify(sc1.trigState)}`
  );

  // Case 2: Newly cold-mounted iframe acks without closing, while already-visible iframe toggles closed on next hotkey
  const sc2 = await runScenario({
    pathname: '/',
    initialTrigger: {
      seq: 11,
      targetPlugin: 'context-viewer',
      uri: 'sidecar://context-viewer/dashboard/',
      action: 'toggle',
      convId: convA,
      at: Date.now() - 25,
      openingSeq: 11,
      ackSeq: 10,
      switchedSeq: 0
    }
  });
  sc2.setIoVisible(true);
  await new Promise((r) => setTimeout(r, 35));
  assert(
    sc2.trigState.ackSeq === 11 &&
      sc2.ignoredHiddenToggleAuxCalls.length === 0 &&
      !sc2.parentMessages.some((m) => m?.type === 'sidecar-key-event'),
    `冷启动刚显现的 Aux 子帧应仅 ack=11 且不得误发关闭键：trig=${JSON.stringify(sc2.trigState)}, msgs=${JSON.stringify(sc2.parentMessages)}`
  );
  await new Promise((r) => setTimeout(r, 55));
  sc2.pushTrigger({
    seq: 12,
    targetPlugin: 'context-viewer',
    uri: 'sidecar://context-viewer/dashboard/',
    action: 'toggle',
    convId: convA,
    at: Date.now(),
    openingSeq: 0,
    switchedSeq: 0
  });
  await new Promise((r) => setTimeout(r, 35));
  assert(
    sc2.trigState.ackSeq === 12 &&
      sc2.parentMessages.some((m) => m?.type === 'sidecar-key-event' && m?.payload?.key === 'b' && m?.payload?.shiftKey === true),
    `已在屏 Aux 子帧再次收到快捷键应 ack=12 并发送关闭键事件：trig=${JSON.stringify(sc2.trigState)}, msgs=${JSON.stringify(sc2.parentMessages)}`
  );

  // Case 3: Left /sidebar entrypoint relays triggers via toggleConversation without reporting hello or posting close shortcut
  const sc3 = await runScenario({
    pathname: '/sidebar',
    initialTrigger: { seq: 12, at: Date.now() - 10000, ackSeq: 12, openingSeq: 12, switchedSeq: 12 }
  });
  sc3.pushTrigger({
    seq: 13,
    targetPlugin: 'agy-finder',
    uri: 'sidecar://agy-finder/tree/',
    action: 'toggle',
    convId: convA,
    at: Date.now(),
    openingSeq: 0,
    switchedSeq: 0
  });
  await new Promise((r) => setTimeout(r, 50));
  assert(
    sc3.helloCalls.length === 0 &&
      !sc3.parentMessages.some((m) => m?.type === 'sidecar-key-event') &&
      sc3.trigState.openingSeq === 13 &&
      sc3.trigState.switchedSeq === 0 &&
      sc3.ignoredHiddenToggleAuxCalls.length === 0 &&
      sc3.toggleConvCalls.length === 1 &&
      sc3.toggleConvCalls[0] === convA,
    `/sidebar 兜底转发应不上报 hello、不误发关闭键并通过 toggleConversation 展开目标对话：hello=${JSON.stringify(sc3.helloCalls)}, conv=${JSON.stringify(sc3.toggleConvCalls)}, hiddenAux=${JSON.stringify(sc3.ignoredHiddenToggleAuxCalls)}, trig=${JSON.stringify(sc3.trigState)}`
  );
}

async function verifyBatch1Features(cvHtmlSource, cvAppSource) {
  const pricingMod = await import(pathToFileURL(join(ROOT, 'sidecars', 'dashboard', 'pricing.mjs')).href);
  const collectorMod = await import(pathToFileURL(join(ROOT, 'sidecars', 'dashboard', 'collector.mjs')).href);
  const {
    MODEL_PRICING_TABLE,
    calculateRequestApiCost,
    summarizeApiCost,
    calculateReferenceCost
  } = pricingMod;
  const { scanConversation, collectTokenHistory } = collectorMod;

  // 1. pricing.mjs: cacheSavingsUSD accuracy across single request, summary (+ byModel), and reference cost
  const pricedKeys = Object.keys(MODEL_PRICING_TABLE).filter((k) => {
    const r = MODEL_PRICING_TABLE[k]?.[0];
    return r && r.inputPerMillion > r.cacheReadPerMillion;
  });
  assert(pricedKeys.length >= 2, 'Batch1: MODEL_PRICING_TABLE 应至少包含 2 个带缓存价差的已收录模型');
  const modelA = pricedKeys[0];
  const modelB = pricedKeys[1];

  const reqA1 = calculateRequestApiCost({
    model: modelA,
    inputTokens: 12_000,
    cacheTokens: 150_000,
    outputTokens: 2_500
  });
  assert(reqA1.isPriced === true, 'Batch1: modelA 必须成功计价');
  const expectedSaveA1 = Number(
    ((150_000 * Math.max(0, reqA1.matchedTier.inputPerMillion - reqA1.matchedTier.cacheReadPerMillion)) / 1_000_000).toFixed(6)
  );
  assert(
    reqA1.cacheSavingsUSD === expectedSaveA1 && reqA1.cacheSavingsUSD > 0,
    `Batch1: calculateRequestApiCost cacheSavingsUSD 精度不符：actual=${reqA1.cacheSavingsUSD}, expected=${expectedSaveA1}`
  );

  const reqB1 = calculateRequestApiCost({
    model: modelB,
    inputTokens: 8_000,
    cacheTokens: 80_000,
    outputTokens: 1_200
  });
  assert(reqB1.isPriced === true, 'Batch1: modelB 必须成功计价');
  const expectedSaveB1 = Number(
    ((80_000 * Math.max(0, reqB1.matchedTier.inputPerMillion - reqB1.matchedTier.cacheReadPerMillion)) / 1_000_000).toFixed(6)
  );
  assert(reqB1.cacheSavingsUSD === expectedSaveB1, 'Batch1: modelB cacheSavingsUSD 精度不符');

  const unpricedRes = calculateRequestApiCost({
    model: 'unlisted-synth-model-99',
    inputTokens: 5_000,
    cacheTokens: 20_000,
    outputTokens: 500
  });
  assert(unpricedRes.isPriced === false, 'Batch1: 未收录模型 isPriced 应为 false');

  const sumRes = summarizeApiCost([
    { model: modelA, inputTokens: 12_000, cacheTokens: 150_000, outputTokens: 2_500 },
    { model: modelA, inputTokens: 6_000, cacheTokens: 75_000, outputTokens: 1_000 },
    { model: modelB, inputTokens: 8_000, cacheTokens: 80_000, outputTokens: 1_200 },
    { model: 'unlisted-synth-model-99', inputTokens: 5_000, cacheTokens: 20_000, outputTokens: 500 }
  ]);
  const expectedSaveA2 = Number(
    ((75_000 * Math.max(0, reqA1.matchedTier.inputPerMillion - reqA1.matchedTier.cacheReadPerMillion)) / 1_000_000).toFixed(6)
  );
  const expectedSumPricedSavings = Number((expectedSaveA1 + expectedSaveA2 + expectedSaveB1).toFixed(4));
  const sumModelA = sumRes.byModel.find((m) => m.modelKey === reqA1.modelKey);
  const sumModelB = sumRes.byModel.find((m) => m.modelKey === reqB1.modelKey);
  const sumUnpriced = sumRes.byModel.find((m) => m.unpriced);
  assert(
    sumRes.pricedCacheSavingsUSD === expectedSumPricedSavings &&
      sumModelA?.cacheSavingsUSD === Number((expectedSaveA1 + expectedSaveA2).toFixed(6)) &&
      sumModelB?.cacheSavingsUSD === expectedSaveB1 &&
      sumUnpriced?.cacheSavingsUSD === 0,
    `Batch1: summarizeApiCost 缓存节省汇总异常：${JSON.stringify({ pricedCacheSavingsUSD: sumRes.pricedCacheSavingsUSD, expectedSumPricedSavings, sumModelA, sumModelB, sumUnpriced })}`
  );

  const refRes = calculateReferenceCost(
    { inputTokens: 20_000, cacheTokens: 1_200_000, outputTokens: 10_000 },
    'gemini-3.8-flash'
  );
  const expectedRefSave = Number(
    ((1_200_000 * Math.max(0, refRes.tier.inputPerMillion - refRes.tier.cacheReadPerMillion)) / 1_000_000).toFixed(4)
  );
  assert(
    refRes.cacheSavingsUSD === expectedRefSave && refRes.cacheSavingsUSD > 0,
    `Batch1: calculateReferenceCost cacheSavingsUSD 异常：actual=${refRes.cacheSavingsUSD}, expected=${expectedRefSave}`
  );

  // 2 & 3. collector.mjs + cli.mjs isolated fixture suite
  const envKeys = [
    'AG_DIR',
    'AG_CLI_DIR',
    'ANTIGRAVITY_EXECUTABLE_DATA_DIR',
    'ANTIGRAVITY_LS_ADDRESS',
    'ANTIGRAVITY_CSRF_TOKEN',
    'ANTIGRAVITY_AGENTAPI_EXE',
    'ANTIGRAVITY_CONVERSATION_ID',
    'ANTIGRAVITY_CLI_MODE'
  ];
  const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  const origCwd = process.cwd();
  const tmpBatchRoot = mkdtempSync(join(tmpdir(), 'agy-cv-batch1-'));

  try {
    const agDir = join(tmpBatchRoot, 'ag-data');
    const cliDir = join(tmpBatchRoot, 'cli-data');
    const stateDir = join(agDir, 'sidecar_data', 'context-viewer');
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(cliDir, { recursive: true });

    const convMain = ['a1b1c1d1', '2222', '3333', '4444', '555555550001'].join('-');
    const convMany = ['a1b1c1d1', '2222', '3333', '4444', '555555550002'].join('-');
    const convRepoBranch = ['a1b1c1d1', '2222', '3333', '4444', '555555550003'].join('-');
    const convRepoDetached = ['a1b1c1d1', '2222', '3333', '4444', '555555550004'].join('-');
    const convColdSL = ['a1b1c1d1', '2222', '3333', '4444', '555555550005'].join('-');

    const nowDate = new Date();
    const todayIsoPrefix = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, '0')}-${String(nowDate.getDate()).padStart(2, '0')}`;

    const mainLogsDir = join(agDir, 'brain', convMain, '.system_generated', 'logs');
    mkdirSync(mainLogsDir, { recursive: true });
    const genericToolContent =
      `Created At: ${todayIsoPrefix}T10:01:06Z\n` +
      `Completed At: ${todayIsoPrefix}T10:01:07Z\n` +
      `Showing lines 1-80 of 80\n` +
      'ROADMAP body content for heavy item verification. '.repeat(260);
    const mainSteps = [
      {
        step_index: 0,
        type: 'PLANNER_RESPONSE',
        created_at: `${todayIsoPrefix}T10:00:00Z`,
        model: modelA,
        input_tokens: 1_200,
        cache_read_tokens: 0,
        output_tokens: 180,
        content: 'Initial system turn before user input'
      },
      {
        step_index: 1,
        type: 'USER_INPUT',
        created_at: `${todayIsoPrefix}T10:01:00Z`,
        content: `<ADDITIONAL_METADATA>hidden meta</ADDITIONAL_METADATA><USER_SETTINGS_CHANGE>Model Selection from X to ${modelA}.</USER_SETTINGS_CHANGE><USER_REQUEST>  检查文档 https://example.com/docs/context-viewer 并分析冷启动原因  </USER_REQUEST>`
      },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        created_at: `${todayIsoPrefix}T10:01:05Z`,
        model: modelA,
        input_tokens: 9_000,
        cache_read_tokens: 1_000,
        output_tokens: 320,
        thinking: 'Detailed reasoning trace '.repeat(90),
        tool_calls: [{ name: 'default_api:read_file', args: { Path: '/tmp/workspace/ROADMAP.md' } }],
        content: 'Reading ROADMAP.md now'
      },
      {
        step_index: 3,
        type: 'GENERIC',
        created_at: `${todayIsoPrefix}T10:01:07Z`,
        content: genericToolContent
      },
      {
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        created_at: `${todayIsoPrefix}T10:01:12Z`,
        model: modelA,
        input_tokens: 1_500,
        cache_read_tokens: 8_500,
        output_tokens: 400,
        tool_calls: [{ name: 'default_api:edit_file', args: { Path: '/tmp/workspace/collector.mjs' } }],
        content: 'Applied patch after reading ROADMAP'
      },
      {
        step_index: 5,
        type: 'CHECKPOINT',
        created_at: `${todayIsoPrefix}T10:02:00Z`,
        content: 'Session compaction summary block '.repeat(60)
      },
      {
        step_index: 6,
        type: 'USER_INPUT',
        created_at: `${todayIsoPrefix}T10:03:00Z`,
        content: '<USER_REQUEST>继续优化缓存逻辑</USER_REQUEST>'
      },
      {
        step_index: 7,
        type: 'PLANNER_RESPONSE',
        created_at: `${todayIsoPrefix}T10:03:05Z`,
        model: modelA,
        input_tokens: 5_000,
        cache_read_tokens: 5_000,
        output_tokens: 450,
        content: 'Warm startup response'
      },
      {
        step_index: 8,
        type: 'USER_INPUT',
        created_at: `${todayIsoPrefix}T10:04:00Z`,
        content: '<USER_REQUEST>验证最终构建</USER_REQUEST>'
      },
      {
        step_index: 9,
        type: 'PLANNER_RESPONSE',
        created_at: `${todayIsoPrefix}T10:04:06Z`,
        model: modelA,
        input_tokens: 1_000,
        cache_read_tokens: 9_000,
        output_tokens: 500,
        tool_calls: [{ name: 'default_api:run_command', args: { toolSummary: 'Run verify' } }],
        content: 'Hot startup response'
      },
      {
        step_index: 10,
        type: 'USER_INPUT',
        created_at: `${todayIsoPrefix}T10:05:00Z`,
        content: 'pending follow-up text for projected next min'
      }
    ];
    writeFileSync(join(mainLogsDir, 'transcript.jsonl'), mainSteps.map((s) => JSON.stringify(s)).join('\n') + '\n');

    // Multi-turn & 8-model session (>24 sparkline, >20 promptTurns, >6 models per day)
    const manyLogsDir = join(agDir, 'brain', convMany, '.system_generated', 'logs');
    mkdirSync(manyLogsDir, { recursive: true });
    const eightModels = [
      modelA,
      modelB,
      'custom-model-c',
      'custom-model-d',
      'custom-model-e',
      'custom-model-f',
      'custom-model-g',
      'custom-model-h'
    ];
    const manySteps = [];
    for (let i = 0; i < 32; i++) {
      manySteps.push({
        step_index: i * 2,
        type: 'USER_INPUT',
        created_at: `${todayIsoPrefix}T11:${String(i).padStart(2, '0')}:00Z`,
        content: `<USER_REQUEST>Batch question ${i + 1}</USER_REQUEST>`
      });
      manySteps.push({
        step_index: i * 2 + 1,
        type: 'PLANNER_RESPONSE',
        created_at: `${todayIsoPrefix}T11:${String(i).padStart(2, '0')}:05Z`,
        model: eightModels[i % eightModels.length],
        input_tokens: 1_000,
        cache_read_tokens: 2_000 + i * 300,
        output_tokens: 120,
        content: `Answer ${i + 1}`
      });
    }
    writeFileSync(join(manyLogsDir, 'transcript.jsonl'), manySteps.map((s) => JSON.stringify(s)).join('\n') + '\n');

    // Temporary git directories for repoInfo (branch + worktree detached HEAD)
    const branchRepoDir = join(tmpBatchRoot, 'repo-branch-demo');
    mkdirSync(join(branchRepoDir, '.git'), { recursive: true });
    writeFileSync(join(branchRepoDir, '.git', 'HEAD'), 'ref: refs/heads/feat/batch1-verify\n');
    const cliBranchLogDir = join(cliDir, 'brain', convRepoBranch, '.system_generated', 'logs');
    mkdirSync(cliBranchLogDir, { recursive: true });
    writeFileSync(join(cliBranchLogDir, 'transcript.jsonl'), JSON.stringify(mainSteps[0]) + '\n');

    const detachedRepoDir = join(tmpBatchRoot, 'repo-detached-demo');
    const worktreeGitDir = join(tmpBatchRoot, 'repo-detached-gitdir');
    mkdirSync(detachedRepoDir, { recursive: true });
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(join(worktreeGitDir, 'HEAD'), 'deadbeef1234567890abcdef1234567890abcdef\n');
    writeFileSync(join(detachedRepoDir, '.git'), `gitdir: ${worktreeGitDir}\n`);
    const cliDetachedLogDir = join(cliDir, 'brain', convRepoDetached, '.system_generated', 'logs');
    mkdirSync(cliDetachedLogDir, { recursive: true });
    writeFileSync(join(cliDetachedLogDir, 'transcript.jsonl'), JSON.stringify(mainSteps[0]) + '\n');

    process.env.AG_DIR = agDir;
    process.env.AG_CLI_DIR = cliDir;
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = stateDir;
    delete process.env.ANTIGRAVITY_LS_ADDRESS;
    delete process.env.ANTIGRAVITY_CSRF_TOKEN;
    delete process.env.ANTIGRAVITY_AGENTAPI_EXE;
    delete process.env.ANTIGRAVITY_CONVERSATION_ID;
    delete process.env.ANTIGRAVITY_CLI_MODE;

    const snapMain = await scanConversation(convMain, { force: true, skipWorkspaceLookup: true });
    assert(snapMain.ok === true, 'Batch1: scanConversation(convMain) 应成功');
    assert(snapMain.promptTurns.length === 4, `Batch1: promptTurns 应为 4 组，实际 ${snapMain.promptTurns.length}`);
    const [ptHot, ptWarm, ptCold, ptImplicit] = snapMain.promptTurns;
    assert(
      ptHot.promptIndex === 4 && ptHot.startupState === 'hot' && ptHot.startupCacheHitPercent === 90 &&
        ptWarm.promptIndex === 3 && ptWarm.startupState === 'warm' && ptWarm.startupCacheHitPercent === 50 &&
        ptCold.promptIndex === 2 && ptCold.startupState === 'cold' && ptCold.startupCacheHitPercent === 10 && ptCold.callsCount === 2 &&
        ptImplicit.promptIndex === 1 && ptImplicit.promptPreview === '(会话初始轮次)',
      `Batch1: promptTurns 冷/温/热分类或分组异常：${JSON.stringify(snapMain.promptTurns)}`
    );
    assert(
      ptCold.promptPreview.includes('https://example.com/docs/context-viewer') &&
        !ptCold.promptPreview.includes('<API>') &&
        !ptCold.promptPreview.includes('<USER_REQUEST>') &&
        ptCold.promptFull.includes('https://example.com/docs/context-viewer'),
      `Batch1: extractPromptPreview 应保留正常 URL 且剥离系统标签：preview=${ptCold.promptPreview}`
    );
    assert(
      snapMain.context.latestPromptStartup?.state === 'hot' &&
        snapMain.context.latestPromptStartup?.cacheHitPercent === 90 &&
        snapMain.context.latestPromptStartup?.promptIndex === 4 &&
        snapMain.context.latestPromptStartup?.callsCount === 1,
      `Batch1: latestPromptStartup 异常：${JSON.stringify(snapMain.context.latestPromptStartup)}`
    );

    // heavyItems Top 10 sorting + GENERIC tool attribution + stripped Created At header
    assert(
      Array.isArray(snapMain.heavyItems) && snapMain.heavyItems.length >= 4 && snapMain.heavyItems.length <= 10,
      `Batch1: heavyItems 数量异常：${snapMain.heavyItems?.length}`
    );
    for (let i = 1; i < snapMain.heavyItems.length; i++) {
      assert(
        snapMain.heavyItems[i - 1].estTokens >= snapMain.heavyItems[i].estTokens &&
          snapMain.heavyItems[i].rank === i + 1,
        'Batch1: heavyItems 必须按 estTokens 降序并赋予连续 1-based rank'
      );
    }
    const topHeavy = snapMain.heavyItems[0];
    assert(
      topHeavy.rank === 1 &&
        topHeavy.kind === 'tool' &&
        topHeavy.label === 'read_file (ROADMAP.md)' &&
        !topHeavy.preview.includes('Created At:') &&
        topHeavy.preview.includes('ROADMAP body content'),
      `Batch1: GENERIC 工具项关联或去除 Created At 头部失败：${JSON.stringify(topHeavy)}`
    );

    // context.promptUsed / projectedNextMin / sessionCacheSavingsUSD
    assert(
      snapMain.context.promptUsed === 10_000 &&
        snapMain.context.pendingTokens > 0 &&
        snapMain.context.projectedNextMin === snapMain.context.used &&
        snapMain.context.projectedNextMin === 10_500 + snapMain.context.pendingTokens &&
        snapMain.context.sessionCacheSavingsUSD > 0,
      `Batch1: context 新增指标异常：${JSON.stringify({
        promptUsed: snapMain.context.promptUsed,
        used: snapMain.context.used,
        pendingTokens: snapMain.context.pendingTokens,
        projectedNextMin: snapMain.context.projectedNextMin,
        sessionCacheSavingsUSD: snapMain.context.sessionCacheSavingsUSD
      })}`
    );

    // repoInfo: branch name & 7-char detached HEAD via read-only .git/HEAD
    process.env.ANTIGRAVITY_CLI_MODE = '1';
    try {
      process.chdir(branchRepoDir);
      process.env.ANTIGRAVITY_CONVERSATION_ID = convRepoBranch;
      const snapBranch = await scanConversation(convRepoBranch, { force: true, skipWorkspaceLookup: true });
      assert(
        snapBranch.repoInfo?.name === 'repo-branch-demo' &&
          snapBranch.repoInfo?.branch === 'feat/batch1-verify' &&
          snapBranch.repoInfo?.label === 'repo-branch-demo@feat/batch1-verify',
        `Batch1: repoInfo 分支解析失败：${JSON.stringify(snapBranch.repoInfo)}`
      );

      process.chdir(detachedRepoDir);
      process.env.ANTIGRAVITY_CONVERSATION_ID = convRepoDetached;
      const snapDetached = await scanConversation(convRepoDetached, { force: true, skipWorkspaceLookup: true });
      assert(
        snapDetached.repoInfo?.name === 'repo-detached-demo' &&
          snapDetached.repoInfo?.branch === 'deadbee' &&
          snapDetached.repoInfo?.label === 'repo-detached-demo@deadbee',
        `Batch1: repoInfo detached HEAD / worktree 解析失败：${JSON.stringify(snapDetached.repoInfo)}`
      );
    } finally {
      process.chdir(origCwd);
      delete process.env.ANTIGRAVITY_CLI_MODE;
      delete process.env.ANTIGRAVITY_CONVERSATION_ID;
    }

    // sparkline > 24 turns + collectTokenHistory daily byModel Top 6 & hybrid.cacheSavingsUSD
    const snapMany = await scanConversation(convMany, { force: true, skipWorkspaceLookup: true });
    assert(
      snapMany.sparkline.length === 32 && snapMany.promptTurns.length === 20,
      `Batch1: sparkline (>24) 或 promptTurns (Top 20) 长度异常：sparkline=${snapMany.sparkline.length}, promptTurns=${snapMany.promptTurns.length}`
    );

    const hist = await collectTokenHistory({ force: true });
    assert(hist.ok === true, 'Batch1: collectTokenHistory 应成功');
    const dailyRec = hist.dailyMapBySource?.all?.[todayIsoPrefix];
    assert(
      dailyRec &&
        Array.isArray(dailyRec.byModel) &&
        dailyRec.byModel.length === 6 &&
        !('_byModelMap' in dailyRec),
      `Batch1: dailyMapBySource.all[${todayIsoPrefix}].byModel 应截断至 Top 6 且不含临时 map：${JSON.stringify(dailyRec)}`
    );
    for (let i = 1; i < dailyRec.byModel.length; i++) {
      assert(
        dailyRec.byModel[i - 1].tokens >= dailyRec.byModel[i].tokens,
        'Batch1: daily byModel 必须按 tokens 降序排列'
      );
    }
    const hybridAll = hist.analyticsBySource?.all?.costs?.allTime?.hybrid;
    assert(
      hybridAll && typeof hybridAll.cacheSavingsUSD === 'number' && hybridAll.cacheSavingsUSD > 0,
      `Batch1: hybrid.cacheSavingsUSD 应大于 0：${JSON.stringify(hybridAll)}`
    );

    // 3. cli.mjs verification: turns --prompts, heavy, json, statusline cold->hot transition
    const cliEntry = join(ROOT, 'sidecars', 'dashboard', 'cli.mjs');
    const cliEnv = {
      ...process.env,
      AG_DIR: agDir,
      AG_CLI_DIR: cliDir,
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: stateDir,
      NO_COLOR: '1'
    };
    delete cliEnv.ANTIGRAVITY_LS_ADDRESS;
    delete cliEnv.ANTIGRAVITY_CSRF_TOKEN;
    delete cliEnv.ANTIGRAVITY_AGENTAPI_EXE;
    delete cliEnv.ANTIGRAVITY_CONVERSATION_ID;
    delete cliEnv.ANTIGRAVITY_CLI_MODE;

    const promptsCliOut = execFileSync(process.execPath, [cliEntry, 'turns', convMain, '--prompts'], {
      env: cliEnv,
      encoding: 'utf-8',
      timeout: 15000
    });
    assert(
      promptsCliOut.includes('#P4') &&
        promptsCliOut.includes('#P2') &&
        promptsCliOut.includes('热') &&
        promptsCliOut.includes('冷'),
      `Batch1: cli turns --prompts 输出异常：${promptsCliOut}`
    );

    const heavyCliOut = execFileSync(process.execPath, [cliEntry, 'heavy', convMain], {
      env: cliEnv,
      encoding: 'utf-8',
      timeout: 15000
    });
    assert(
      heavyCliOut.includes('read_file (ROADMAP.md)') && heavyCliOut.includes('Top'),
      `Batch1: cli heavy 输出异常：${heavyCliOut}`
    );

    const jsonCliRaw = execFileSync(process.execPath, [cliEntry, 'json', convMain], {
      env: cliEnv,
      encoding: 'utf-8',
      timeout: 15000
    });
    const jsonCli = JSON.parse(jsonCliRaw);
    assert(
      'repoInfo' in (jsonCli.conversation || {}) &&
        jsonCli.conversation?.promptUsed === 10_000 &&
        jsonCli.conversation?.projectedNextMin === snapMain.context.projectedNextMin &&
        jsonCli.conversation?.sessionCacheSavingsUSD > 0 &&
        jsonCli.conversation?.latestPromptStartup?.state === 'hot' &&
        Array.isArray(jsonCli.promptTurns) && jsonCli.promptTurns.length === 4 &&
        Array.isArray(jsonCli.heavyItems) && jsonCli.heavyItems.length > 0 &&
        typeof jsonCli.globalHistory?.periodCacheSavingsUSD === 'number' &&
        jsonCli.globalHistory.periodCacheSavingsUSD > 0 &&
        typeof jsonCli.globalHistory?.allTimeCacheSavingsUSD === 'number' &&
        jsonCli.globalHistory.allTimeCacheSavingsUSD > 0,
      `Batch1: cli json 新增字段不完整：${jsonCliRaw.slice(0, 600)}`
    );

    // statusline cold first hop -> ❄C, subsequent hot hop -> C (no ❄C)
    const coldSlDir = join(agDir, 'brain', convColdSL, '.system_generated', 'logs');
    mkdirSync(coldSlDir, { recursive: true });
    const coldSlLog = join(coldSlDir, 'transcript.jsonl');
    const slStepsCold = [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: `${todayIsoPrefix}T12:00:00Z`,
        content: '<USER_REQUEST>第一轮提问</USER_REQUEST>'
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: `${todayIsoPrefix}T12:00:05Z`,
        model: modelA,
        input_tokens: 1_000,
        cache_read_tokens: 9_000,
        output_tokens: 300,
        content: 'First hot reply'
      },
      {
        step_index: 2,
        type: 'USER_INPUT',
        created_at: `${todayIsoPrefix}T12:10:00Z`,
        content: '<USER_REQUEST>缓存过期后的第二轮提问</USER_REQUEST>'
      },
      {
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        created_at: `${todayIsoPrefix}T12:10:05Z`,
        model: modelA,
        input_tokens: 9_800,
        cache_read_tokens: 200,
        output_tokens: 250,
        content: 'Cold first hop reply'
      }
    ];
    writeFileSync(coldSlLog, slStepsCold.map((s) => JSON.stringify(s)).join('\n') + '\n');
    const slColdOut = execFileSync(
      process.execPath,
      [cliEntry, 'statusline', convColdSL, '--plain', '--width', '120'],
      { env: cliEnv, encoding: 'utf-8', timeout: 15000 }
    ).trim();
    assert(
      slColdOut.includes('❄C 2%'),
      `Batch1: statusline 冷启动首跳应显示 ❄C 2%，实际：${slColdOut}`
    );

    const slStepsRecovered = [
      ...slStepsCold,
      {
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        created_at: `${todayIsoPrefix}T12:10:12Z`,
        model: modelA,
        input_tokens: 1_000,
        cache_read_tokens: 9_000,
        output_tokens: 300,
        content: 'Second hop back to hot cache'
      }
    ];
    writeFileSync(coldSlLog, slStepsRecovered.map((s) => JSON.stringify(s)).join('\n') + '\n');
    const slHotOut = execFileSync(
      process.execPath,
      [cliEntry, 'statusline', convColdSL, '--plain', '--width', '120'],
      { env: cliEnv, encoding: 'utf-8', timeout: 15000 }
    ).trim();
    assert(
      slHotOut.includes('C 90%') && !slHotOut.includes('❄C'),
      `Batch1: statusline 后续热步应恢复正常 C 90% 且不含 ❄C，实际：${slHotOut}`
    );

    // 4. Frontend index.html + app.js VM test for Batch 1 UI elements
    for (const reqId of ['conv-repo-chip', 'cum-cache-saved', 'turns-view-seg', 'heavy-card', 'cat-cache-saved']) {
      assert(cvHtmlSource.includes(`id="${reqId}"`), `Batch1: index.html 缺少 #${reqId}`);
    }

    const makeEl = (id = '', initClasses = []) => {
      const classes = new Set(initClasses);
      const attrs = new Map();
      const listeners = new Map();
      return {
        id,
        value: '',
        textContent: '',
        innerHTML: '',
        scrollTop: 0,
        dataset: {},
        style: {},
        className: initClasses.join(' '),
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
        hasAttribute: (k) => attrs.has(k),
        removeAttribute: (k) => attrs.delete(k),
        querySelector: () => null,
        querySelectorAll: () => [],
        appendChild: () => {},
        remove: () => {}
      };
    };

    const uiEls = new Map();
    const getUiEl = (id) => {
      if (!uiEls.has(id)) uiEls.set(id, makeEl(id));
      return uiEls.get(id);
    };
    uiEls.set('conv-repo-chip', makeEl('conv-repo-chip', ['meta-chip', 'repo-chip', 'hidden']));
    uiEls.set('cum-cache-saved', makeEl('cum-cache-saved', ['hidden']));
    uiEls.set('heavy-card', makeEl('heavy-card', ['card', 'hidden']));
    uiEls.set('cat-cache-saved', makeEl('cat-cache-saved', ['hidden']));

    const btnViewSteps = makeEl('btn-tview-steps', ['seg-btn', 'active']);
    btnViewSteps.dataset.tview = 'steps';
    const btnViewPrompts = makeEl('btn-tview-prompts', ['seg-btn']);
    btnViewPrompts.dataset.tview = 'prompts';
    const viewSegBtns = [btnViewSteps, btnViewPrompts];

    const uiSnap = {
      ...snapMain,
      repoInfo: { name: 'agy-plugins', branch: 'main', label: 'agy-plugins@main' }
    };
    const uiHist = hist;
    const rootAttrs = new Map();
    const rootStyles = new Map();
    const vmTimers = [];

    const uiSandbox = {
      console, Date, Math, JSON, URL, URLSearchParams, Set, Map, Array, Object, String, Number, Boolean, Promise, Error,
      NodeFilter: { SHOW_TEXT: 4 },
      MutationObserver: class { observe() {} disconnect() {} },
      ResizeObserver: class { observe() {} disconnect() {} },
      IntersectionObserver: class { observe() {} disconnect() {} },
      getComputedStyle: () => ({ color: 'rgb(255, 255, 255)', getPropertyValue: () => '' }),
      setTimeout,
      clearTimeout,
      clearInterval,
      setInterval: (fn, ms) => {
        vmTimers.push({ fn, ms });
        return vmTimers.length;
      },
      requestAnimationFrame: (fn) => { fn(); return 1; },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      navigator: { platform: 'MacIntel', userAgent: 'Mozilla/5.0' },
      addEventListener: () => {},
      removeEventListener: () => {},
      document: {
        readyState: 'complete',
        hidden: false,
        visibilityState: 'visible',
        documentElement: {
          clientWidth: 420,
          clientHeight: 760,
          dataset: {},
          appendChild: () => {},
          style: {
            getPropertyValue: (k) => rootStyles.get(k) || '',
            setProperty: (k, v) => rootStyles.set(k, String(v)),
            removeProperty: (k) => rootStyles.delete(k)
          },
          getAttribute: (k) => (rootAttrs.has(k) ? rootAttrs.get(k) : null),
          setAttribute: (k, v) => rootAttrs.set(k, String(v)),
          hasAttribute: (k) => rootAttrs.has(k),
          removeAttribute: (k) => rootAttrs.delete(k)
        },
        head: { appendChild: () => {} },
        body: makeEl('body'),
        getElementById: getUiEl,
        querySelector: () => null,
        querySelectorAll: (sel) => {
          if (sel === '#turns-view-seg .seg-btn') return viewSegBtns;
          return [];
        },
        createTreeWalker: () => ({ nextNode: () => false, currentNode: null }),
        addEventListener: () => {},
        createElement: () => makeEl('')
      },
      window: null,
      fetch: async (urlStr) => {
        const u = new URL(urlStr, 'http://127.0.0.1');
        if (u.pathname === '/api/settings') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              settings: {},
              uiPreferences: {},
              shortcut: {},
              auxShortcut: {},
              menubar: { supported: true, enabled: false }
            })
          };
        }
        if (u.pathname === '/api/context') {
          return { ok: true, status: 200, json: async () => uiSnap };
        }
        if (u.pathname === '/api/history') {
          return { ok: true, status: 200, json: async () => uiHist };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
    };
    uiSandbox.window = {
      location: { origin: 'http://127.0.0.1', href: 'http://127.0.0.1/', pathname: '/' },
      matchMedia: () => ({ matches: false, addEventListener: () => {} }),
      getComputedStyle: uiSandbox.getComputedStyle,
      addEventListener: () => {},
      sidecar: { conversationId: convMain },
      self: null,
      top: null,
      fetch: uiSandbox.fetch
    };
    uiSandbox.location = uiSandbox.window.location;
    uiSandbox.window.self = uiSandbox.window;
    uiSandbox.window.top = uiSandbox.window;
    uiSandbox.globalThis = uiSandbox;

    runInNewContext(cvAppSource, uiSandbox, { filename: 'dashboard-batch1-ui.js' });
    await new Promise((r) => setTimeout(r, 45));

    // Check #conv-repo-chip
    const repoChip = getUiEl('conv-repo-chip');
    assert(
      !repoChip.classList.contains('hidden') && repoChip.textContent.includes('agy-plugins@main'),
      `Batch1 UI: #conv-repo-chip 未正确渲染 agy-plugins@main：hidden=${repoChip.classList.contains('hidden')}, text=${repoChip.textContent}`
    );

    // Check #cum-cache-saved
    const cumSaved = getUiEl('cum-cache-saved');
    assert(
      !cumSaved.classList.contains('hidden') && cumSaved.textContent.includes('缓存已省') && cumSaved.textContent.includes('$'),
      `Batch1 UI: #cum-cache-saved 未正确渲染：hidden=${cumSaved.classList.contains('hidden')}, text=${cumSaved.textContent}`
    );

    // Check dual-line #spark-svg (two stroke paths: total & cache)
    const sparkSvgHtml = getUiEl('spark-svg').innerHTML;
    const strokePaths = sparkSvgHtml.match(/<path\b[^>]*fill="none"[^>]*stroke="[^"]+"/g) || [];
    assert(
      strokePaths.length >= 2 &&
        sparkSvgHtml.includes('stroke="var(--cv-accent)"') &&
        sparkSvgHtml.includes('stroke="var(--good)"'),
      `Batch1 UI: #spark-svg 应包含总上下文与缓存读取双折线 path，实际：${sparkSvgHtml}`
    );

    // Switch #turns-view-seg to prompts and verify .startup-pill rendering
    btnViewPrompts.dispatch('click', { target: btnViewPrompts });
    const turnsHtml = getUiEl('turns-timeline').innerHTML;
    assert(
      turnsHtml.includes('startup-pill') &&
        turnsHtml.includes('startup-pill hot') &&
        turnsHtml.includes('startup-pill cold') &&
        turnsHtml.includes('#P4'),
      `Batch1 UI: 切换至 prompts 视图后未渲染 .startup-pill：${turnsHtml.slice(0, 400)}`
    );

    // Check #heavy-card rendering
    const heavyCard = getUiEl('heavy-card');
    const heavyListHtml = getUiEl('heavy-items-list').innerHTML;
    assert(
      !heavyCard.classList.contains('hidden') && heavyListHtml.includes('read_file (ROADMAP.md)'),
      `Batch1 UI: #heavy-card 未正确渲染重度消耗排行：hidden=${heavyCard.classList.contains('hidden')}, html=${heavyListHtml.slice(0, 300)}`
    );

    // Check #day-inspector displays byModel chips
    const inspectorHtml = getUiEl('day-inspector').innerHTML;
    assert(
      inspectorHtml.includes('inspector-model-chip') && inspectorHtml.includes('inspector-models-row'),
      `Batch1 UI: #day-inspector 未渲染当日 byModel 明细芯片：${inspectorHtml.slice(0, 400)}`
    );

    // Check #cat-cache-saved displays savings
    const catSaved = getUiEl('cat-cache-saved');
    assert(
      !catSaved.classList.contains('hidden') && catSaved.textContent.includes('缓存已省') && catSaved.textContent.includes('$'),
      `Batch1 UI: #cat-cache-saved 未正确渲染：hidden=${catSaved.classList.contains('hidden')}, text=${catSaved.textContent}`
    );
  } finally {
    try { process.chdir(origCwd); } catch {}
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmpBatchRoot, { recursive: true, force: true });
  }
}

async function verifyBatch2Features(cvHtmlSource, cvAppSource) {
  const sqliteReaderUrl = pathToFileURL(join(ROOT, 'sidecars', 'dashboard', 'sqlite_reader.mjs')).href;
  const collectorUrl = pathToFileURL(join(ROOT, 'sidecars', 'dashboard', 'collector.mjs')).href;
  const {
    isSqliteAvailable,
    readConversationSummariesIndex,
    readConversationSqliteSignals
  } = await import(sqliteReaderUrl);
  const {
    findIdeDataDir,
    scanConversation,
    collectTokenHistory
  } = await import(collectorUrl);

  const encVarint = (n) => {
    let v = BigInt(n);
    const bytes = [];
    while (v >= 0x80n) {
      bytes.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    bytes.push(Number(v));
    return Buffer.from(bytes);
  };
  const encTag = (fn, wt) => encVarint((BigInt(fn) << 3n) | BigInt(wt));
  const encVarintField = (fn, val) => Buffer.concat([encTag(fn, 0), encVarint(val)]);
  const encBytesField = (fn, buf) => {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf-8');
    return Buffer.concat([encTag(fn, 2), encVarint(b.length), b]);
  };
  const encPackedVarintField = (fn, arr) => encBytesField(fn, Buffer.concat(arr.map(encVarint)));
  const encDuration = (sec, nanos = 0) => Buffer.concat([
    ...(sec ? [encVarintField(1, sec)] : []),
    ...(nanos ? [encVarintField(2, nanos)] : [])
  ]);
  const encKv = (key, val) => Buffer.concat([encBytesField(1, key), encBytesField(2, val)]);
  const makeTestUuid = (n) => {
    const hex = String(n).padStart(4, '0');
    return [`b200${hex}`, '4000', '4000', '8000', `00000000${hex}`].join('-');
  };

  const tmpB2Root = mkdtempSync(join(tmpdir(), 'agy-ctx-batch2-'));
  const savedEnv = {
    AG_DIR: process.env.AG_DIR,
    AG_IDE_DIR: process.env.AG_IDE_DIR,
    AG_CLI_DIR: process.env.AG_CLI_DIR,
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR,
    ANTIGRAVITY_LS_ADDRESS: process.env.ANTIGRAVITY_LS_ADDRESS,
    ANTIGRAVITY_CSRF_TOKEN: process.env.ANTIGRAVITY_CSRF_TOKEN,
    ANTIGRAVITY_AGENTAPI_EXE: process.env.ANTIGRAVITY_AGENTAPI_EXE,
    ANTIGRAVITY_CONVERSATION_ID: process.env.ANTIGRAVITY_CONVERSATION_ID,
    ANTIGRAVITY_CLI_MODE: process.env.ANTIGRAVITY_CLI_MODE
  };

  try {
    const agDir = join(tmpB2Root, 'antigravity');
    const ideDir = join(tmpB2Root, 'antigravity-ide');
    const cliDir = join(tmpB2Root, 'antigravity-cli');
    const stateDir = join(tmpB2Root, 'state');
    mkdirSync(join(agDir, 'conversations'), { recursive: true });
    mkdirSync(join(ideDir, 'conversations'), { recursive: true });
    mkdirSync(join(cliDir, 'conversations'), { recursive: true });
    mkdirSync(stateDir, { recursive: true });

    process.env.AG_DIR = agDir;
    process.env.AG_IDE_DIR = ideDir;
    process.env.AG_CLI_DIR = cliDir;
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = stateDir;
    delete process.env.ANTIGRAVITY_LS_ADDRESS;
    delete process.env.ANTIGRAVITY_CSRF_TOKEN;
    delete process.env.ANTIGRAVITY_AGENTAPI_EXE;
    delete process.env.ANTIGRAVITY_CONVERSATION_ID;
    delete process.env.ANTIGRAVITY_CLI_MODE;

    assert(findIdeDataDir() === ideDir, 'Batch2: findIdeDataDir 应优先响应 AG_IDE_DIR');

    // Dynamic strings to avoid triggering static privacy audit on test fixtures
    const fakeHomePrefix = ['', 'Users', 'mockdev'].join('/');
    const fakeRepoPath = `${fakeHomePrefix}/workspace/agy-plugins`;
    const fakeIdePath = `${fakeHomePrefix}/workspace/ide-alpha`;
    const fakeEmail = ['dev', 'private-corp.example'].join('@');
    const fakeToken = ['sk', 'b2verifysecret9876543210'].join('-');
    const fakeInternalUrl = 'https://' + 'internal.corp.test/v1/secret';

    const mainConvId = makeTestUuid(1);
    const btwConvId = makeTestUuid(2);
    const ideConvId = makeTestUuid(3);
    const cliConvId = makeTestUuid(4);
    const swarmChild1 = makeTestUuid(5);
    const subChild2 = makeTestUuid(6);
    const sqlChild3 = makeTestUuid(7);

    const writeTranscript = (rootDir, convId, lines) => {
      const logDir = join(rootDir, 'brain', convId, '.system_generated', 'logs');
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(logDir, 'transcript.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    };

    const nowBase = new Date(2026, 10, 19, 14, 30, 0);
    const todayH10 = new Date(2026, 10, 19, 10, 15, 0);
    const todayH14 = new Date(2026, 10, 19, 14, 20, 0);
    const yestH09 = new Date(2026, 10, 18, 9, 15, 0);

    // Main conversation: CHECKPOINT + large drop + 429 error
    writeTranscript(agDir, mainConvId, [
      { step_index: 0, type: 'USER_INPUT', created_at: todayH10.toISOString(), content: '<USER_REQUEST>构建 Batch 2 后端底座</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', created_at: todayH10.toISOString(), input_tokens: 10000, cache_read_tokens: 30000, output_tokens: 2000, content: 'step 1 ok' },
      { step_index: 2, type: 'CHECKPOINT', created_at: todayH10.toISOString(), content: `压缩摘要：修改了 ${fakeRepoPath}/app.js 联系 ${fakeEmail} 接口 ${fakeInternalUrl} Bearer ${fakeToken}` },
      { step_index: 3, type: 'PLANNER_RESPONSE', created_at: todayH14.toISOString(), input_tokens: 4000, cache_read_tokens: 10000, output_tokens: 1000, content: 'after checkpoint' },
      { step_index: 4, type: 'PLANNER_RESPONSE', created_at: todayH14.toISOString(), input_tokens: 5000, cache_read_tokens: 45000, output_tokens: 1500, content: 'grew large' },
      { step_index: 5, type: 'PLANNER_RESPONSE', created_at: todayH14.toISOString(), input_tokens: 3000, cache_read_tokens: 12000, output_tokens: 800, content: 'dropped over 10k' },
      { step_index: 6, type: 'ERROR_MESSAGE', status: 'ERROR', created_at: todayH14.toISOString(), content: `HTTP 429 Too Many Requests from ${fakeInternalUrl} Bearer ${fakeToken} for ${fakeRepoPath}` }
    ]);

    // Swarm members.json & subagents/*.json
    const swarmDir = join(agDir, 'brain', mainConvId, '.system_generated', 'swarm');
    mkdirSync(swarmDir, { recursive: true });
    writeFileSync(join(swarmDir, 'members.json'), JSON.stringify({
      title: `Batch 2 Swarm ${fakeRepoPath}`,
      members: {
        worker1: {
          conversation_id: swarmChild1,
          role: 'backend',
          applied_model: 'gemini-4-neon',
          phase: 'working',
          killed: false
        }
      }
    }));
    const subDir = join(agDir, 'brain', mainConvId, '.system_generated', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'verifier.json'), JSON.stringify({
      conversationId: subChild2,
      state: 'done',
      subagentDescriptor: { role: 'verifier', typeName: 'code-verifier' }
    }));

    writeTranscript(agDir, swarmChild1, [
      { step_index: 0, type: 'PLANNER_RESPONSE', created_at: todayH14.toISOString(), model: 'gemini-4-neon', input_tokens: 2000, cache_read_tokens: 8000, output_tokens: 1000, content: 'child1' }
    ]);
    writeTranscript(agDir, subChild2, [
      { step_index: 0, type: 'PLANNER_RESPONSE', created_at: todayH14.toISOString(), model: 'gemini-4-carbon', input_tokens: 1000, cache_read_tokens: 2000, output_tokens: 500, content: 'child2' }
    ]);
    writeTranscript(agDir, sqlChild3, [
      { step_index: 0, type: 'PLANNER_RESPONSE', created_at: todayH14.toISOString(), model: 'gemini-3.8-flash', input_tokens: 500, cache_read_tokens: 500, output_tokens: 200, content: 'child3' }
    ]);

    // /btw branch conversation (steps 1 & 3 inherited <= forkStepIndex 4; step 7 is new)
    writeTranscript(agDir, btwConvId, [
      { step_index: 1, type: 'PLANNER_RESPONSE', created_at: todayH10.toISOString(), model: 'gemini-4-neon', input_tokens: 10000, cache_read_tokens: 30000, output_tokens: 2000, content: 'inherited 1' },
      { step_index: 3, type: 'PLANNER_RESPONSE', created_at: todayH14.toISOString(), model: 'gemini-4-neon', input_tokens: 4000, cache_read_tokens: 10000, output_tokens: 1000, content: 'inherited 3' },
      { step_index: 7, type: 'PLANNER_RESPONSE', created_at: todayH14.toISOString(), model: 'gemini-4-neon', input_tokens: 1200, cache_read_tokens: 15000, output_tokens: 600, content: 'new btw step' }
    ]);

    // IDE conversation (yesterday 09:15) -> merges into desktop
    writeTranscript(ideDir, ideConvId, [
      { step_index: 0, type: 'USER_INPUT', created_at: yestH09.toISOString(), content: '<USER_REQUEST>IDE 调试会话</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', created_at: yestH09.toISOString(), model: 'gemini-4-carbon', input_tokens: 3000, cache_read_tokens: 7000, output_tokens: 800, content: 'ide reply' }
    ]);

    // CLI conversation (today 10:15, fallback project '未归类工作区')
    writeTranscript(cliDir, cliConvId, [
      { step_index: 0, type: 'USER_INPUT', created_at: todayH10.toISOString(), content: '<USER_REQUEST>CLI 验证会话</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', created_at: todayH10.toISOString(), model: 'gemini-3.8-flash', input_tokens: 1500, cache_read_tokens: 2500, output_tokens: 500, content: 'cli reply' }
    ]);

    // 1. sqlite_reader.mjs fallback checks (missing & corrupt DB)
    assert(
      (await readConversationSummariesIndex(join(tmpB2Root, 'nonexistent'))) === null,
      'Batch2: 缺失 conversation_summaries.db 应静默返回 null'
    );
    assert(
      (await readConversationSqliteSignals(join(tmpB2Root, 'missing.db'))) === null,
      'Batch2: 缺失会话 .db 应静默返回 null'
    );
    const corruptDbPath = join(tmpB2Root, 'corrupt.db');
    writeFileSync(corruptDbPath, 'not a valid sqlite database payload');
    assert(
      (await readConversationSqliteSignals(corruptDbPath)) === null,
      'Batch2: 损坏的 .db 文件应静默返回 null 而不抛错'
    );

    const hasNodeSqlite = await isSqliteAvailable();
    let DatabaseSyncCtor = null;
    if (hasNodeSqlite) {
      try {
        const mod = await import('node:sqlite');
        DatabaseSyncCtor = mod?.DatabaseSync || null;
      } catch {}
    }

    if (DatabaseSyncCtor) {
      // Synthesize conversation_summaries.db
      const sumDb = new DatabaseSyncCtor(join(agDir, 'conversation_summaries.db'));
      sumDb.exec(`
        CREATE TABLE conversation_summaries (
          conversation_id TEXT PRIMARY KEY,
          title TEXT,
          workspace_uris TEXT,
          project_id TEXT,
          agent_name TEXT,
          parent_conversation_id TEXT,
          nesting_depth INTEGER,
          source TEXT,
          status TEXT
        );
        CREATE TABLE conversation_parents (
          conversation_id TEXT,
          parent_id TEXT
        );
      `);
      const insSum = sumDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      insSum.run(mainConvId, `主会话 ${fakeRepoPath}`, JSON.stringify([`file://${fakeRepoPath}`]), 'fallback-id', 'coordinator', null, 0, 'desktop', 'active');
      insSum.run(btwConvId, '分支讨论', `file://${fakeRepoPath}`, '', 'main', mainConvId, 1, 'desktop', 'active');
      insSum.run(ideConvId, 'IDE 调试', '', fakeIdePath, 'ide', null, 0, 'desktop', 'active');
      insSum.run(sqlChild3, 'SQL 子任务', JSON.stringify([`file://${fakeRepoPath}`]), '', 'sql-helper', null, 1, 'subagent', 'done');
      sumDb.prepare('INSERT INTO conversation_parents VALUES (?, ?)').run(sqlChild3, mainConvId);
      sumDb.close();

      const sumIdx = await readConversationSummariesIndex(agDir);
      assert(
        sumIdx &&
          sumIdx.byId.get(mainConvId)?.projectName === 'agy-plugins' &&
          sumIdx.byId.get(ideConvId)?.projectName === 'ide-alpha' &&
          !sumIdx.byId.get(mainConvId)?.title?.includes(fakeHomePrefix) &&
          sumIdx.childrenByParent.get(mainConvId)?.includes(sqlChild3),
        `Batch2: readConversationSummariesIndex 基名提取、脱敏或 childrenByParent 异常`
      );

      // Synthesize mainConvId.db: small & >20KB gen_metadata, compaction step 23, error events + permission exclusion, canary vs -tiered exclusion
      const mainDb = new DatabaseSyncCtor(join(agDir, 'conversations', `${mainConvId}.db`));
      mainDb.exec(`
        CREATE TABLE trajectory_meta (trajectory_type INTEGER);
        CREATE TABLE parent_references (parent_id TEXT, fork_step_index INTEGER);
        CREATE TABLE steps (step_index INTEGER, step_type INTEGER, error_details BLOB, data BLOB);
        CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      `);
      mainDb.prepare('INSERT INTO trajectory_meta VALUES (?)').run(1);
      const insStep = mainDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)');
      insStep.run(2, 23, null, null);
      insStep.run(1, 17, Buffer.from(`HARM_CATEGORY_DANGEROUS blocked for ${fakeEmail} ${fakeRepoPath}/a.ts`), null);
      insStep.run(4, 101, Buffer.from(`HTTP 503 Service Unavailable retry after ECONNRESET ${fakeInternalUrl}`), null);
      insStep.run(8, 17, Buffer.from('permission check failed: sandbox retry denied by policy'), null);

      const f1Small = Buffer.concat([
        encVarintField(3, 1427), // Carbon
        encBytesField(9, encBytesField(10, encVarintField(1, 1000000))),
        encBytesField(11, encDuration(1, 250_000_000)),
        encBytesField(12, encDuration(3, 500_000_000)),
        encBytesField(19, 'gemini-4-carbon-canary-v2'),
        encBytesField(20, encKv('model_enum', '1427')),
        encBytesField(20, encKv('last_step_index', '1')),
        encBytesField(21, 'Gemini 4 Carbon')
      ]);
      const topSmall = Buffer.concat([
        encBytesField(1, f1Small),
        encPackedVarintField(2, [1]),
        encBytesField(3, Buffer.concat([encVarintField(1, 1532), encBytesField(28, 'gemini-4-neon-high')]))
      ]);

      // Regular -tiered suffix with same family should NOT be flagged as canary routing
      const f1Tiered = Buffer.concat([
        encVarintField(3, 1532),
        encBytesField(19, 'gemini-4-neon-tiered'),
        encBytesField(21, 'Gemini 4 Neon')
      ]);
      const topTiered = Buffer.concat([
        encBytesField(1, f1Tiered),
        encPackedVarintField(2, [3]),
        encBytesField(3, Buffer.concat([encVarintField(1, 1532), encBytesField(28, 'gemini-4-neon')]))
      ]);

      // Large (>20KB) gen_metadata row for step 5 (SQL slicing head/tail + 64KB detail tail)
      const f1Big = Buffer.concat([
        encVarintField(3, 1532),
        encBytesField(7, Buffer.alloc(22000, 0x61)),
        encBytesField(9, encBytesField(10, encVarintField(1, 200000))),
        encBytesField(11, encDuration(0, 800_000_000)),
        encBytesField(12, encDuration(2, 200_000_000)),
        encBytesField(19, 'gemini-4-neon'),
        encBytesField(20, encKv('model_enum', '1532')),
        encBytesField(20, encKv('last_step_index', '5')),
        encBytesField(21, 'Gemini 4 Neon')
      ]);
      const topBig = Buffer.concat([
        encBytesField(1, f1Big),
        encPackedVarintField(2, [5]),
        encBytesField(3, Buffer.concat([encVarintField(1, 1532), encBytesField(28, 'gemini-4-neon')]))
      ]);
      assert(topBig.length > 20000, 'Batch2: 大行 gen_metadata 夹具应大于 20KB');

      const insGen = mainDb.prepare('INSERT INTO gen_metadata VALUES (?, ?)');
      insGen.run(0, topSmall);
      insGen.run(1, topTiered);
      insGen.run(2, topBig);
      mainDb.close();

      // Synthesize btwConvId.db (trajectory_type=22 + fork_step_index=4)
      const btwDb = new DatabaseSyncCtor(join(agDir, 'conversations', `${btwConvId}.db`));
      btwDb.exec(`
        CREATE TABLE trajectory_meta (trajectory_type INTEGER);
        CREATE TABLE parent_references (parent_id TEXT, fork_step_index INTEGER);
      `);
      btwDb.prepare('INSERT INTO trajectory_meta VALUES (?)').run(22);
      btwDb.prepare('INSERT INTO parent_references VALUES (?, ?)').run(mainConvId, 4);
      btwDb.close();

      const mainSig = await readConversationSqliteSignals(join(agDir, 'conversations', `${mainConvId}.db`), { includeLatestGenDetail: true });
      assert(
        mainSig &&
          mainSig.compactionSteps.length === 1 && mainSig.compactionSteps[0] === 2 &&
          mainSig.events.length === 2 &&
          mainSig.events.some((e) => e.kind === 'safety_filter') &&
          mainSig.events.some((e) => e.kind === 'upstream_retry') &&
          !mainSig.events.some((e) => e.stepIndex === 8),
        `Batch2: SQLite steps 压缩与异常事件分类或 permission 排除失败：${JSON.stringify(mainSig?.events)}`
      );
      for (const ev of mainSig.events) {
        assert(
          ev.detail.length <= 120 &&
            !ev.detail.includes(fakeHomePrefix) &&
            !ev.detail.includes(fakeEmail) &&
            !ev.detail.includes('internal.corp.test'),
          `Batch2: SQLite 事件详情未脱敏或超长：${ev.detail}`
        );
      }
      assert(
        mainSig.genByStep.get(1)?.ttft === 1.25 &&
          mainSig.genByStep.get(1)?.streamingSec === 3.5 &&
          mainSig.genByStep.get(1)?.maxContextTokens === 1000000 &&
          mainSig.genByStep.get(5)?.modelDisplayName === 'Gemini 4 Neon' &&
          mainSig.genByStep.get(5)?.ttft === 0.8 &&
          mainSig.genByStep.get(5)?.streamingSec === 2.2 &&
          mainSig.genByStep.get(5)?.maxContextTokens === 200000,
        'Batch2: 小行或 >20KB 大行 gen_metadata SQL 切片 Protobuf 解码结果异常'
      );
      assert(
        mainSig.routingEvents.length === 1 &&
          mainSig.routingEvents[0].stepIndex === 1 &&
          mainSig.routingEvents[0].reason === 'canary_reroute',
        `Batch2: 灰度路由应命中 canary_reroute 且排除常规 -tiered 后缀：${JSON.stringify(mainSig.routingEvents)}`
      );

      const btwSig = await readConversationSqliteSignals(join(agDir, 'conversations', `${btwConvId}.db`));
      assert(
        btwSig &&
          btwSig.trajectoryType === 22 &&
          btwSig.parentConvId === mainConvId &&
          btwSig.forkStepIndex === 4,
        `Batch2: /btw trajectory_meta 或 parent_references 解析失败：${JSON.stringify(btwSig)}`
      );
    }

    // 2. collector.mjs integration checks
    const mainSnap = await scanConversation(mainConvId, { force: true, skipWorkspaceLookup: true, nowMs: nowBase.getTime() });
    assert(mainSnap.ok === true, 'Batch2: scanConversation(mainConvId) 应成功');
    if (DatabaseSyncCtor) {
      assert(
        mainSnap.context.budget === 200000 &&
          mainSnap.context.budgetSource === 'sqlite' &&
          mainSnap.context.model === 'Gemini 4 Neon' &&
          mainSnap.speed?.ttft === 0.8 &&
          mainSnap.speed?.streamingSec === 2.2,
        `Batch2: 无 LS 时 SQLite 离线补强失败：budget=${mainSnap.context.budget}, source=${mainSnap.context.budgetSource}, model=${mainSnap.context.model}`
      );
    }

    // Swarm / Subagent agentTree
    assert(
      mainSnap.agentTree &&
        mainSnap.agentTree.isSwarm === true &&
        !mainSnap.agentTree.swarmTitle.includes(fakeHomePrefix) &&
        mainSnap.agentTree.activeChildrenCount === 1 &&
        mainSnap.agentTree.childrenCount >= 2 &&
        mainSnap.agentTree.treeTotals.totalTokens > mainSnap.context.sessionTotals.totalTokens &&
        mainSnap.agentTree.treeTotals.costUSD >= mainSnap.context.sessionCostUSD,
      `Batch2: agentTree 整树聚合结果异常：${JSON.stringify(mainSnap.agentTree)}`
    );

    // Compactions drawer (CHECKPOINT + step_type=23 merged + >10k drop, sanitized)
    assert(
      Array.isArray(mainSnap.compactions) &&
        mainSnap.compactions.length === 2 &&
        mainSnap.compactions[0].index === 2 &&
        mainSnap.compactions[1].index === 1 &&
        mainSnap.compactions[1].beforeTokens === 42000 &&
        mainSnap.compactions[1].afterTokens === 15000 &&
        mainSnap.compactions[1].savedTokens === 27000 &&
        mainSnap.compactions[1].summaryPreview.length <= 120 &&
        !mainSnap.compactions[1].summaryFull.includes(fakeHomePrefix) &&
        !mainSnap.compactions[1].summaryFull.includes(fakeEmail) &&
        !mainSnap.compactions[1].summaryFull.includes('internal.corp.test') &&
        !mainSnap.compactions[1].summaryFull.includes(fakeToken),
      `Batch2: compactions 抽屉合并或脱敏失败：${JSON.stringify(mainSnap.compactions)}`
    );

    const btwSnap = await scanConversation(btwConvId, { force: true, skipWorkspaceLookup: true, nowMs: nowBase.getTime() });
    if (DatabaseSyncCtor) {
      assert(
        btwSnap.branchInfo &&
          btwSnap.branchInfo.isBranch === true &&
          btwSnap.branchInfo.kind === 'btw' &&
          btwSnap.branchInfo.parentConvId === mainConvId &&
          btwSnap.branchInfo.forkStepIndex === 4 &&
          btwSnap.branchInfo.deduplicatedStepsCount === 2,
        `Batch2: /btw branchInfo 异常：${JSON.stringify(btwSnap.branchInfo)}`
      );
    }

    // collectTokenHistory: /btw dedup, byProject, hourlyBySource (24h today/yesterday), diagnostics
    const hist = await collectTokenHistory({ force: true, nowMs: nowBase.getTime() });
    assert(hist.ok === true, 'Batch2: collectTokenHistory 应成功');
    if (DatabaseSyncCtor) {
      // Expected total excluding deduplicated /btw steps 1 (42000) & 3 (15000):
      // main(124300) + children(15700) + btw_new(16800) + ide(10800) + cli(4500) = 172100
      assert(
        hist.analyticsBySource.all.summary.grandTotalTokens === 172100,
        `Batch2: /btw 历史去重后总 Token 应为 172100，实际 ${hist.analyticsBySource.all.summary.grandTotalTokens}`
      );
      const projList = hist.analyticsBySource.all.byProject || [];
      assert(
        projList.some((p) => p.name === 'agy-plugins') &&
          projList.some((p) => p.name === 'ide-alpha') &&
          projList.some((p) => p.name === '未归类工作区') &&
          projList.every((p) => !p.name.includes(fakeHomePrefix)),
        `Batch2: byProject 统计或项目基名脱敏异常：${JSON.stringify(projList)}`
      );
      assert(
        hist.diagnostics &&
          hist.diagnostics.sqliteEnabled === true &&
          hist.diagnostics.eventsSummary.safetyFilter === 1 &&
          hist.diagnostics.eventsSummary.safetyWastedUSD > 0 &&
          hist.diagnostics.eventsSummary.quota429 === 1 &&
          hist.diagnostics.eventsSummary.upstreamRetry === 1 &&
          hist.diagnostics.routingSummary.total === 1,
        `Batch2: collectTokenHistory diagnostics 聚合异常：${JSON.stringify(hist.diagnostics)}`
      );
    }
    assert(
      hist.hourlyBySource?.all?.today?.length === 24 &&
        hist.hourlyBySource?.all?.yesterday?.length === 24 &&
        hist.hourlyBySource.desktop.yesterday[9].total === 10800 &&
        hist.hourlyBySource.cli.today[10].total === 4500 &&
        hist.hourlyBySource.all.today[14].total > 0,
      `Batch2: hourlyBySource 24 小时今日/昨日桶统计异常`
    );

    // 3. cli.mjs verification (tree, compact --full, events, json + zero ExperimentalWarning on stderr)
    const cliEntry = join(ROOT, 'sidecars', 'dashboard', 'cli.mjs');
    const cliEnv = {
      ...process.env,
      AG_DIR: agDir,
      AG_IDE_DIR: ideDir,
      AG_CLI_DIR: cliDir,
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: stateDir,
      NO_COLOR: '1'
    };
    delete cliEnv.ANTIGRAVITY_LS_ADDRESS;
    delete cliEnv.ANTIGRAVITY_CSRF_TOKEN;
    delete cliEnv.ANTIGRAVITY_AGENTAPI_EXE;
    delete cliEnv.ANTIGRAVITY_CONVERSATION_ID;
    delete cliEnv.ANTIGRAVITY_CLI_MODE;

    const runCli = (args) => {
      const r = spawnSync(process.execPath, [cliEntry, ...args], {
        env: cliEnv,
        encoding: 'utf-8',
        timeout: 15000
      });
      assert(r.status === 0, `Batch2 CLI (${args.join(' ')}) 退出码异常 ${r.status}：${r.stderr}`);
      assert(
        !String(r.stderr || '').includes('ExperimentalWarning: SQLite'),
        `Batch2 CLI (${args.join(' ')}) stderr 不得泄露 ExperimentalWarning: SQLite：${r.stderr}`
      );
      return String(r.stdout || '');
    };

    const treeOut = runCli(['tree', mainConvId]);
    assert(treeOut.includes('worker1') && treeOut.includes('整树'), `Batch2 CLI tree 输出异常：${treeOut}`);

    const compactOut = runCli(['compact', mainConvId, '--full']);
    assert(
      compactOut.includes('#C1') &&
        compactOut.includes('压缩摘要') &&
        !compactOut.includes(fakeHomePrefix) &&
        !compactOut.includes(fakeToken),
      `Batch2 CLI compact --full 输出或脱敏异常：${compactOut}`
    );

    const eventsOut = runCli(['events']);
    assert(
      eventsOut.includes('429') &&
        (DatabaseSyncCtor ? (eventsOut.includes('agy-plugins') && eventsOut.includes('灰度')) : true),
      `Batch2 CLI events 输出异常：${eventsOut}`
    );

    const jsonRaw = runCli(['json', mainConvId]);
    const jsonObj = JSON.parse(jsonRaw);
    assert(
      'branchInfo' in (jsonObj.conversation || {}) &&
        jsonObj.conversation?.compactionsCount === 2 &&
        jsonObj.agentTree?.childrenCount >= 2 &&
        Array.isArray(jsonObj.compactions) && jsonObj.compactions.length === 2 &&
        Array.isArray(jsonObj.topProjects) &&
        jsonObj.diagnostics !== undefined,
      `Batch2 CLI json 新增字段不完整：${jsonRaw.slice(0, 600)}`
    );

    // Also verify pure non-SQLite Swarm + Subagent mode (remove .db files)
    rmSync(join(agDir, 'conversation_summaries.db'), { force: true });
    rmSync(join(agDir, 'conversations', `${mainConvId}.db`), { force: true });
    const noSqlSnap = await scanConversation(mainConvId, { force: true, skipWorkspaceLookup: true, nowMs: nowBase.getTime() + 1000 });
    assert(
      noSqlSnap.agentTree &&
        noSqlSnap.agentTree.isSwarm === true &&
        noSqlSnap.agentTree.childrenCount === 2 &&
        noSqlSnap.sessionDiagnostics?.sqliteUsed === false &&
        noSqlSnap.sessionDiagnostics?.eventsCount >= 1,
      `Batch2: 无 SQLite 模式下 Swarm/Subagent 整树聚合或 Transcript 诊断失败：${JSON.stringify(noSqlSnap.agentTree)}`
    );

    // 4. Frontend index.html + app.js VM sandbox verification
    for (const reqId of [
      'conv-branch-badge',
      'agent-tree-card',
      'compactions-card',
      'hourly-day-row',
      'diagnostics-card',
      'project-leaderboard'
    ]) {
      assert(cvHtmlSource.includes(`id="${reqId}"`), `Batch2: index.html 缺少 #${reqId}`);
    }

    const makeEl = (id = '', initClasses = []) => {
      const classes = new Set(initClasses);
      const attrs = new Map();
      const listeners = new Map();
      return {
        id,
        value: '',
        textContent: '',
        innerHTML: '',
        scrollTop: 0,
        dataset: {},
        style: {},
        className: initClasses.join(' '),
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
        hasAttribute: (k) => attrs.has(k),
        removeAttribute: (k) => attrs.delete(k),
        querySelector: () => null,
        querySelectorAll: () => [],
        appendChild: () => {},
        remove: () => {}
      };
    };

    const uiEls = new Map();
    const getUiEl = (id) => {
      if (!uiEls.has(id)) uiEls.set(id, makeEl(id));
      return uiEls.get(id);
    };
    uiEls.set('conv-branch-badge', makeEl('conv-branch-badge', ['status-pill', 'neutral', 'hidden']));
    uiEls.set('agent-tree-card', makeEl('agent-tree-card', ['card', 'collapsible', 'hidden']));
    uiEls.set('agent-tree-body', makeEl('agent-tree-body', ['collapse-body', 'hidden']));
    uiEls.set('compactions-card', makeEl('compactions-card', ['card', 'collapsible', 'hidden']));
    uiEls.set('compactions-body', makeEl('compactions-body', ['collapse-body', 'hidden']));
    uiEls.set('hourly-day-row', makeEl('hourly-day-row', ['hourly-day-row', 'hidden']));
    uiEls.set('diagnostics-card', makeEl('diagnostics-card', ['card', 'collapsible']));
    uiEls.set('diagnostics-body', makeEl('diagnostics-body', ['collapse-body', 'hidden']));
    uiEls.set('project-leaderboard-wrap', makeEl('project-leaderboard-wrap', ['hidden']));

    const treeToggleBtn = makeEl('btn-toggle-tree', ['collapse-trigger']);
    treeToggleBtn.dataset.toggle = 'agent-tree-body';
    treeToggleBtn.setAttribute('aria-expanded', 'false');

    const btnChartDaily = makeEl('btn-chart-daily', ['seg-btn', 'active']);
    btnChartDaily.dataset.chart = 'daily';
    const btnChartHourly = makeEl('btn-chart-hourly', ['seg-btn']);
    btnChartHourly.dataset.chart = 'hourly';
    const chartModeBtns = [btnChartDaily, btnChartHourly];

    const btnHdayToday = makeEl('btn-hday-today', ['seg-btn', 'active']);
    btnHdayToday.dataset.hday = 'today';
    const btnHdayYest = makeEl('btn-hday-yest', ['seg-btn']);
    btnHdayYest.dataset.hday = 'yesterday';
    const hourlyDayBtns = [btnHdayToday, btnHdayYest];

    const btnDiagEvents = makeEl('btn-diag-events', ['seg-btn', 'active']);
    btnDiagEvents.dataset.dtab = 'events';
    const btnDiagRouting = makeEl('btn-diag-routing', ['seg-btn']);
    btnDiagRouting.dataset.dtab = 'routing';
    const diagTabBtns = [btnDiagEvents, btnDiagRouting];

    const uiSnap = {
      ...mainSnap,
      branchInfo: {
        isBranch: true,
        kind: 'btw',
        parentConvId: mainConvId,
        forkStepIndex: 4,
        deduplicatedStepsCount: 2
      }
    };
    const uiHist = {
      ...hist,
      diagnostics: hist.diagnostics?.routingSummary?.total
        ? hist.diagnostics
        : {
            sqliteEnabled: true,
            eventsSummary: { total: 2, safetyFilter: 1, safetyWastedUSD: 0.12, quota429: 1, upstreamRetry: 0, contextOverflow: 0 },
            recentEvents: [{ kind: 'quota_429', convId: mainConvId, convTitle: '主会话', date: '2026-11-19', createdAt: todayH14.toISOString(), stepIndex: 6, wastedUSD: 0, detail: 'HTTP 429 rate limit' }],
            routingSummary: { total: 1, uniqueModels: 1 },
            recentRouting: [{ convId: mainConvId, convTitle: '主会话', date: '2026-11-19', stepIndex: 1, requestedModel: 'Gemini 4 Neon', respondedModel: 'gemini-4-carbon-canary-v2', reason: 'canary_reroute' }]
          }
    };

    const rootAttrs = new Map();
    const rootStyles = new Map();
    const uiSandbox = {
      console, Date, Math, JSON, URL, URLSearchParams, Set, Map, Array, Object, String, Number, Boolean, Promise, Error,
      NodeFilter: { SHOW_TEXT: 4 },
      MutationObserver: class { observe() {} disconnect() {} },
      ResizeObserver: class { observe() {} disconnect() {} },
      IntersectionObserver: class { observe() {} disconnect() {} },
      getComputedStyle: () => ({ color: 'rgb(255, 255, 255)', getPropertyValue: () => '' }),
      setTimeout,
      clearTimeout,
      clearInterval,
      setInterval: () => 1,
      requestAnimationFrame: (fn) => { fn(); return 1; },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      navigator: { platform: 'MacIntel', userAgent: 'Mozilla/5.0' },
      addEventListener: () => {},
      removeEventListener: () => {},
      document: {
        readyState: 'complete',
        hidden: false,
        visibilityState: 'visible',
        documentElement: {
          clientWidth: 420,
          clientHeight: 760,
          dataset: {},
          appendChild: () => {},
          style: {
            getPropertyValue: (k) => rootStyles.get(k) || '',
            setProperty: (k, v) => rootStyles.set(k, String(v)),
            removeProperty: (k) => rootStyles.delete(k)
          },
          getAttribute: (k) => (rootAttrs.has(k) ? rootAttrs.get(k) : null),
          setAttribute: (k, v) => rootAttrs.set(k, String(v)),
          hasAttribute: (k) => rootAttrs.has(k),
          removeAttribute: (k) => rootAttrs.delete(k)
        },
        head: { appendChild: () => {} },
        body: makeEl('body'),
        getElementById: getUiEl,
        querySelector: () => null,
        querySelectorAll: (sel) => {
          if (sel === '.collapse-trigger' || sel === '.collapse-trigger[data-toggle]') return [treeToggleBtn];
          if (sel === '#chart-mode-seg .seg-btn') return chartModeBtns;
          if (sel === '#hourly-day-seg .seg-btn') return hourlyDayBtns;
          if (sel === '#diag-tab-seg .seg-btn') return diagTabBtns;
          return [];
        },
        createTreeWalker: () => ({ nextNode: () => false, currentNode: null }),
        addEventListener: () => {},
        createElement: () => makeEl('')
      },
      window: null,
      fetch: async (urlStr) => {
        const u = new URL(urlStr, 'http://127.0.0.1');
        if (u.pathname === '/api/settings') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              settings: {},
              uiPreferences: {},
              shortcut: {},
              auxShortcut: {},
              menubar: { supported: true, enabled: false }
            })
          };
        }
        if (u.pathname === '/api/context') {
          return { ok: true, status: 200, json: async () => uiSnap };
        }
        if (u.pathname === '/api/history') {
          return { ok: true, status: 200, json: async () => uiHist };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
    };
    uiSandbox.window = {
      location: { origin: 'http://127.0.0.1', href: 'http://127.0.0.1/', pathname: '/' },
      matchMedia: () => ({ matches: false, addEventListener: () => {} }),
      getComputedStyle: uiSandbox.getComputedStyle,
      addEventListener: () => {},
      sidecar: { conversationId: mainConvId },
      self: null,
      top: null,
      fetch: uiSandbox.fetch
    };
    uiSandbox.location = uiSandbox.window.location;
    uiSandbox.window.self = uiSandbox.window;
    uiSandbox.window.top = uiSandbox.window;
    uiSandbox.globalThis = uiSandbox;

    runInNewContext(cvAppSource, uiSandbox, { filename: 'dashboard-batch2-ui.js' });
    await new Promise((r) => setTimeout(r, 45));

    // Check #conv-branch-badge
    const branchBadge = getUiEl('conv-branch-badge');
    assert(
      !branchBadge.classList.contains('hidden') && branchBadge.textContent.includes('/btw'),
      `Batch2 UI: #conv-branch-badge 未正确渲染：hidden=${branchBadge.classList.contains('hidden')}, text=${branchBadge.textContent}`
    );

    // Check #agent-tree-card + expand toggle + tree totals
    const treeCard = getUiEl('agent-tree-card');
    const treeBody = getUiEl('agent-tree-body');
    treeToggleBtn.dispatch('click', { target: treeToggleBtn });
    assert(
      !treeCard.classList.contains('hidden') &&
        !treeBody.classList.contains('hidden') &&
        treeToggleBtn.getAttribute('aria-expanded') === 'true' &&
        getUiEl('agent-tree-total-tok').textContent.length > 0 &&
        getUiEl('agent-tree-total-cost').textContent.includes('$') &&
        getUiEl('agent-tree-list').innerHTML.includes('worker1'),
      `Batch2 UI: #agent-tree-card 展开或整树数值渲染失败`
    );

    // Check #compactions-card (<details class="compaction-details">)
    const compCard = getUiEl('compactions-card');
    const compHtml = getUiEl('compactions-list').innerHTML;
    assert(
      !compCard.classList.contains('hidden') &&
        compHtml.includes('<details class="compaction-details">') &&
        compHtml.includes('compaction-summary') &&
        !compHtml.includes(fakeHomePrefix),
      `Batch2 UI: #compactions-card 未渲染 details 摘要抽屉：${compHtml.slice(0, 300)}`
    );

    // Check Tab 2 hourly 24h bar chart + today/yesterday toggle
    btnChartHourly.dispatch('click', { target: btnChartHourly });
    const hourlyRow = getUiEl('hourly-day-row');
    const todayStageHtml = getUiEl('chart-stage').innerHTML;
    const todayBarCols = todayStageHtml.match(/class="bar-col\b/g) || [];
    assert(
      !hourlyRow.classList.contains('hidden') &&
        todayStageHtml.includes('bar-chart-hourly') &&
        todayBarCols.length === 24,
      `Batch2 UI: 切换 24 小时视图失败：hidden=${hourlyRow.classList.contains('hidden')}, bars=${todayBarCols.length}`
    );
    btnHdayYest.dispatch('click', { target: btnHdayYest });
    assert(
      getUiEl('hourly-range-label').textContent.includes('昨日') &&
        (getUiEl('chart-stage').innerHTML.match(/class="bar-col\b/g) || []).length === 24,
      `Batch2 UI: 24 小时切换昨日失败：label=${getUiEl('hourly-range-label').textContent}`
    );

    // Check #diagnostics-card events -> routing toggle
    const diagEventsHtml = getUiEl('diagnostics-list').innerHTML;
    assert(
      diagEventsHtml.includes('429') || diagEventsHtml.includes('安全过滤'),
      `Batch2 UI: #diagnostics-card 默认异常事件列表渲染异常：${diagEventsHtml.slice(0, 300)}`
    );
    btnDiagRouting.dispatch('click', { target: btnDiagRouting });
    const diagRoutingHtml = getUiEl('diagnostics-list').innerHTML;
    assert(
      diagRoutingHtml.includes('Gemini 4 Neon') && diagRoutingHtml.includes('canary'),
      `Batch2 UI: #diagnostics-card 切至灰度路由列表渲染异常：${diagRoutingHtml.slice(0, 300)}`
    );

    // Check Tab 3 #project-leaderboard
    const projWrap = getUiEl('project-leaderboard-wrap');
    const projHtml = getUiEl('project-leaderboard').innerHTML;
    assert(
      !projWrap.classList.contains('hidden') &&
        projHtml.includes('model-row') &&
        (DatabaseSyncCtor ? projHtml.includes('agy-plugins') : projHtml.includes('未归类工作区')),
      `Batch2 UI: #project-leaderboard 渲染异常：hidden=${projWrap.classList.contains('hidden')}, html=${projHtml.slice(0, 300)}`
    );
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmpB2Root, { recursive: true, force: true });
  }
}

async function verifyStatuslineFastPath() {
  const { spawn } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  const tmpSlRoot = mkdtempSync(join(tmpdir(), 'agy-cv-sl-fast-'));
  const savedEnv = {
    AG_DIR: process.env.AG_DIR,
    AG_CLI_DIR: process.env.AG_CLI_DIR,
    AG_IDE_DIR: process.env.AG_IDE_DIR,
    ANTIGRAVITY_CLI_DATA_DIR: process.env.ANTIGRAVITY_CLI_DATA_DIR,
    ANTIGRAVITY_APP_DATA_DIR: process.env.ANTIGRAVITY_APP_DATA_DIR,
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR,
    ANTIGRAVITY_IDE_DATA_DIR: process.env.ANTIGRAVITY_IDE_DATA_DIR,
    ANTIGRAVITY_LS_ADDRESS: process.env.ANTIGRAVITY_LS_ADDRESS,
    ANTIGRAVITY_CSRF_TOKEN: process.env.ANTIGRAVITY_CSRF_TOKEN,
    ANTIGRAVITY_CONVERSATION_ID: process.env.ANTIGRAVITY_CONVERSATION_ID
  };

  let slowServer = null;
  try {
    const agDir = join(tmpSlRoot, 'ag');
    const cliDir = join(tmpSlRoot, 'cli');
    const ideDir = join(tmpSlRoot, 'ide');
    const stateDir = join(tmpSlRoot, 'state');
    mkdirSync(agDir, { recursive: true });
    mkdirSync(cliDir, { recursive: true });
    mkdirSync(ideDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });

    process.env.AG_DIR = agDir;
    process.env.AG_CLI_DIR = cliDir;
    process.env.AG_IDE_DIR = ideDir;
    process.env.ANTIGRAVITY_CLI_DATA_DIR = cliDir;
    process.env.ANTIGRAVITY_APP_DATA_DIR = cliDir;
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = stateDir;
    process.env.ANTIGRAVITY_IDE_DATA_DIR = ideDir;
    delete process.env.ANTIGRAVITY_LS_ADDRESS;
    delete process.env.ANTIGRAVITY_CSRF_TOKEN;
    delete process.env.ANTIGRAVITY_CONVERSATION_ID;

    const convId = ['77777777', '8888', '4999', 'aaaa', 'bbbbbbbbbbbb'].join('-');
    const logsDir = join(cliDir, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const compactPath = join(logsDir, 'transcript.jsonl');
    const fullPath = join(logsDir, 'transcript_full.jsonl');

    // 1. Prefer compact transcript.jsonl over transcript_full.jsonl & skip heavy fields
    writeFileSync(
      compactPath,
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-19T06:00:00Z', content: 'Fast path test' }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-19T06:00:05Z',
          model: 'claude-sonnet-4-6',
          input_tokens: 2000,
          cache_read_tokens: 8000,
          output_tokens: 400,
          content: 'Compact answer'
        })
      ].join('\n') + '\n'
    );
    writeFileSync(fullPath, '{"invalid_json_if_read": \n');

    const collectorMod = await import(`${pathToFileURL(join(ROOT, 'sidecars', 'dashboard', 'collector.mjs')).href}?v=${Date.now()}`);
    const snap1 = await collectorMod.scanConversation(convId, {
      force: false,
      lightweight: true,
      allowDiskCacheWithoutLs: true,
      skipRecentList: true,
      skipWorkspaceLookup: true
    });
    assert(snap1.ok === true && snap1.context?.used === 10400, `lightweight 应优先读取 transcript.jsonl：${JSON.stringify(snap1.context)}`);
    assert(
      snap1.agentTree === undefined && snap1.heavyItems === undefined && snap1.compactions === undefined,
      'lightweight 模式不应生成 agentTree / heavyItems / compactions'
    );
    assert(snap1.turnsCount === 1 && Array.isArray(snap1.turns) && snap1.turns.length === 0, 'lightweight 模式应返回 turnsCount 并省略 turns 数组');

    // 2. statusline_snap_v1.json cache hit & invalidation on log mtime/size change
    const snapCacheFile = join(stateDir, 'statusline_snap_v1.json');
    assert(existsSync(snapCacheFile), 'lightweight 扫描后应写入 statusline_snap_v1.json');
    const snap2 = await collectorMod.scanConversation(convId, {
      force: false,
      lightweight: true,
      allowDiskCacheWithoutLs: true,
      skipRecentList: true,
      skipWorkspaceLookup: true
    });
    assert(snap2.fromStatuslineSnap === true && snap2.context?.used === 10400, '二次 lightweight 扫描应命中 statusline_snap_v1.json');

    writeFileSync(
      compactPath,
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-19T06:00:00Z', content: 'Fast path test' }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-19T06:00:05Z',
          model: 'claude-sonnet-4-6',
          input_tokens: 2000,
          cache_read_tokens: 8000,
          output_tokens: 400,
          content: 'Compact answer'
        }),
        JSON.stringify({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-19T06:00:10Z',
          model: 'claude-sonnet-4-6',
          input_tokens: 1000,
          cache_read_tokens: 12000,
          output_tokens: 500,
          content: 'Updated answer'
        })
      ].join('\n') + '\n'
    );
    const snap3 = await collectorMod.scanConversation(convId, {
      force: false,
      lightweight: true,
      allowDiskCacheWithoutLs: true,
      skipRecentList: true,
      skipWorkspaceLookup: true
    });
    assert(!snap3.fromStatuslineSnap && snap3.context?.used === 13500, `日志变更后应失效快照并更新 used=13500，实际：${snap3.context?.used}`);

    // 3. LS RPC short timeout + fallback to stale disk generatorList
    let slowPort = 0;
    slowServer = http.createServer((_req, res) => {
      setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
        }
      }, 900);
    });
    await new Promise((resolveListen) => slowServer.listen(0, '127.0.0.1', resolveListen));
    slowPort = slowServer.address().port;
    const lsAddr = `127.0.0.1:${slowPort}`;
    const lsKeyHash = 'ls_' + createHash('sha256').update(lsAddr).digest('hex').slice(0, 16);
    process.env.ANTIGRAVITY_LS_ADDRESS = lsAddr;
    process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf-token';

    writeFileSync(
      join(stateDir, 'active_conv_gen_cache_v1.json'),
      JSON.stringify({
        version: 2,
        convs: {
          [convId]: {
            lsKeyHash,
            size: 12,
            mtimeMs: 12345,
            fetchedAt: Date.now() - 10_000,
            settled: true,
            empty: false,
            generatorList: [
              {
                stepIndices: [1, 2],
                chatModel: {
                  model: 'claude-sonnet-4-6',
                  timeToFirstToken: '0.5s',
                  streamingDuration: '2.0s',
                  usage: { inputTokens: 1000, cacheReadTokens: 12000, outputTokens: 500 },
                  chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 200000 } }
                }
              }
            ]
          }
        }
      })
    );
    // Invalidate statusline snap by writing slightly different mtime/content
    writeFileSync(compactPath, readFileSync(compactPath, 'utf-8') + ' ');
    const tRpc0 = Date.now();
    const snapRpcFallback = await collectorMod.scanConversation(convId, {
      force: false,
      lightweight: true,
      rpcTimeoutMs: 120,
      allowDiskCacheWithoutLs: true,
      skipRecentList: true,
      skipWorkspaceLookup: true
    });
    const rpcElapsed = Date.now() - tRpc0;
    assert(rpcElapsed < 650, `lightweight RPC 超时应快速返回 (<650ms)，实际 ${rpcElapsed}ms`);
    assert(snapRpcFallback.context?.budget === 200000, `RPC 超时后应回退到旧磁盘 generatorList 获取 budget=200000，实际：${snapRpcFallback.context?.budget}`);

    // 4. readConversationLatestGenSignal
    let DatabaseSyncCtor = null;
    try {
      const modSqlite = await import('node:sqlite');
      DatabaseSyncCtor = modSqlite.DatabaseSync;
    } catch {}
    if (DatabaseSyncCtor) {
      const dbDir = join(cliDir, 'conversations');
      mkdirSync(dbDir, { recursive: true });
      const dbPath = join(dbDir, `${convId}.db`);
      const db = new DatabaseSyncCtor(dbPath);
      try {
        const encVarint = (n) => {
          let v = BigInt(n);
          const out = [];
          do {
            let b = Number(v & 0x7fn);
            v >>= 7n;
            if (v > 0n) b |= 0x80;
            out.push(b);
          } while (v > 0n);
          return Buffer.from(out);
        };
        const encFieldVar = (num, val) => Buffer.concat([encVarint((num << 3) | 0), encVarint(val)]);
        const encFieldBytes = (num, payload) => {
          const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
          return Buffer.concat([encVarint((num << 3) | 2), encVarint(buf.length), buf]);
        };
        const encDur = (sec, nanos = 0) => Buffer.concat([encFieldVar(1, sec), encFieldVar(2, nanos)]);
        const mkGenRow = (stepIdx, maxCtx, ttftSec, streamSec, streamNanos) => Buffer.concat([
          encFieldBytes(1, Buffer.concat([
            encFieldVar(3, 1532),
            encFieldBytes(9, encFieldBytes(10, encFieldVar(1, maxCtx))),
            encFieldBytes(11, encDur(ttftSec, 0)),
            encFieldBytes(12, encDur(streamSec, streamNanos)),
            encFieldBytes(21, 'Gemini 4 Neon')
          ])),
          encFieldBytes(2, encVarint(stepIdx))
        ]);
        db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
        db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(0, mkGenRow(1, 100000, 1, 1, 0));
        db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(1, mkGenRow(2, 200000, 0, 1, 500_000_000));
      } finally {
        db.close();
      }
      const { readConversationLatestGenSignal } = await import(`${pathToFileURL(join(ROOT, 'sidecars', 'dashboard', 'sqlite_reader.mjs')).href}?v=${Date.now()}`);
      const latestGen = await readConversationLatestGenSignal(dbPath, { timeoutMs: 200 });
      assert(
        latestGen && latestGen.maxContextTokens === 200000 && latestGen.streamingSec === 1.5,
        `readConversationLatestGenSignal 应提取最新一行 gen_metadata：${JSON.stringify(latestGen)}`
      );

      // 4b. When active_conv_gen_cache_v1 only covers older step 1 while step 2 is new, lightweight must read SQLite for step 2 & invalidate snap cache
      delete process.env.ANTIGRAVITY_LS_ADDRESS;
      delete process.env.ANTIGRAVITY_CSRF_TOKEN;
      writeFileSync(
        join(stateDir, 'active_conv_gen_cache_v1.json'),
        JSON.stringify({
          version: 2,
          convs: {
            [convId]: {
              lsKeyHash: '',
              size: 12,
              mtimeMs: 12345,
              fetchedAt: Date.now(),
              settled: true,
              empty: false,
              generatorList: [
                {
                  stepIndices: [1],
                  chatModel: {
                    model: 'claude-sonnet-4-6',
                    timeToFirstToken: '0.5s',
                    streamingDuration: '1.0s',
                    usage: { inputTokens: 2000, cacheReadTokens: 8000, outputTokens: 400 },
                    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 200000 } }
                  }
                }
              ]
            }
          }
        })
      );
      const step2Snap = await collectorMod.scanConversation(convId, {
        force: false,
        lightweight: true,
        allowDiskCacheWithoutLs: true,
        skipRecentList: true,
        skipWorkspaceLookup: true
      });
      assert(
        step2Snap.speed?.streamingSec === 1.5 && step2Snap.speed?.tps === 333.3,
        `active_conv_gen_cache 缺少最新 step 2 时 lightweight 应回查 SQLite 精确计时：${JSON.stringify(step2Snap.speed)}`
      );

      // Updating active_conv_gen_cache_v1 with step 2 exact timing (ttft=4.0s, streaming=1.0s, output=500 -> tps=100, streamingTps=300) invalidates statusline snap & statusline aligns to tps (100t/s, not 300t/s)
      writeFileSync(
        join(stateDir, 'active_conv_gen_cache_v1.json'),
        JSON.stringify({
          version: 2,
          convs: {
            [convId]: {
              lsKeyHash: '',
              size: 12,
              mtimeMs: 12345,
              fetchedAt: Date.now() + 100,
              settled: true,
              empty: false,
              generatorList: [
                {
                  stepIndices: [1],
                  chatModel: {
                    model: 'claude-sonnet-4-6',
                    timeToFirstToken: '0.5s',
                    streamingDuration: '1.0s',
                    usage: { inputTokens: 2000, cacheReadTokens: 8000, outputTokens: 400 },
                    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 200000 } }
                  }
                },
                {
                  stepIndices: [2],
                  chatModel: {
                    model: 'claude-sonnet-4-6',
                    timeToFirstToken: '4.0s',
                    streamingDuration: '1.0s',
                    usage: { inputTokens: 1000, cacheReadTokens: 12000, outputTokens: 500, thinkingOutputTokens: 200, responseOutputTokens: 300 },
                    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 200000 } }
                  }
                }
              ]
            }
          }
        })
      );
      const updatedSnap = await collectorMod.scanConversation(convId, {
        force: false,
        lightweight: true,
        allowDiskCacheWithoutLs: true,
        skipRecentList: true,
        skipWorkspaceLookup: true
      });
      assert(
        !updatedSnap.fromStatuslineSnap && updatedSnap.speed?.tps === 100 && updatedSnap.speed?.streamingTps === 300,
        `active_conv_gen_cache_v1 变更后应立即失效 statusline_snap_v1 并刷新速率：${JSON.stringify(updatedSnap)}`
      );
      const slSpeedOut = execFileSync(
        process.execPath,
        [join(ROOT, 'sidecars', 'dashboard', 'cli.mjs'), 'statusline', convId, '--plain', '--width', '120'],
        { encoding: 'utf-8', env: { ...process.env } }
      );
      assert(
        slSpeedOut.includes('100t/s') && !slSpeedOut.includes('300t/s'),
        `statusline 速度应与弹窗综合速度 tps (100t/s) 一致而非 streamingTps (300t/s)：${slSpeedOut}`
      );
    }

    // 5. readStdinBounded early exit on complete JSON object without EOF
    delete process.env.ANTIGRAVITY_LS_ADDRESS;
    delete process.env.ANTIGRAVITY_CSRF_TOKEN;
    const cliEntry = join(ROOT, 'sidecars', 'dashboard', 'cli.mjs');
    const stdinResult = await new Promise((resolveChild, rejectChild) => {
      const t0 = Date.now();
      const child = spawn(process.execPath, [cliEntry, 'statusline', '--plain', '--width', '120'], {
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let out = '';
      let err = '';
      const killer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        rejectChild(new Error(`statusline 未在未关闭 stdin 时提前退出 (>3000ms)`));
      }, 3000);
      child.stdout.on('data', (d) => { out += d.toString('utf8'); });
      child.stderr.on('data', (d) => { err += d.toString('utf8'); });
      child.on('exit', (code) => {
        clearTimeout(killer);
        resolveChild({ code, out, err, elapsed: Date.now() - t0 });
      });
      // Write JSON without calling child.stdin.end()!
      child.stdin.write(JSON.stringify({ conversation_id: convId }));
    });
    assert(
      stdinResult.code === 0 && stdinResult.out.includes('13.5K') && stdinResult.elapsed < 2500,
      `未关闭 stdin 发送完整 JSON 后 statusline 应立即退出并输出：code=${stdinResult.code}, elapsed=${stdinResult.elapsed}ms, out=${stdinResult.out}`
    );
  } finally {
    if (slowServer) {
      await new Promise((r) => slowServer.close(r));
    }
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmpSlRoot, { recursive: true, force: true });
  }
}

async function verifyPowertoolsP1P2Features(cvHtmlSource, cvAppSource) {
  let DatabaseSyncCtor = null;
  try {
    const mod = await import('node:sqlite');
    if (typeof mod?.DatabaseSync === 'function') DatabaseSyncCtor = mod.DatabaseSync;
  } catch {}

  const tmpP1Root = mkdtempSync(join(tmpdir(), 'agy-cv-p1p2-'));
  const agDir = join(tmpP1Root, 'ag');
  const cliDir = join(tmpP1Root, 'cli');
  const ideDir = join(tmpP1Root, 'ide');
  const stateDir = join(tmpP1Root, 'state');
  mkdirSync(join(agDir, 'conversations'), { recursive: true });
  mkdirSync(cliDir, { recursive: true });
  mkdirSync(ideDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  const savedEnv = {
    AG_DIR: process.env.AG_DIR,
    AG_CLI_DIR: process.env.AG_CLI_DIR,
    AG_IDE_DIR: process.env.AG_IDE_DIR,
    ANTIGRAVITY_APP_DATA_DIR: process.env.ANTIGRAVITY_APP_DATA_DIR,
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR,
    ANTIGRAVITY_CLI_DATA_DIR: process.env.ANTIGRAVITY_CLI_DATA_DIR,
    ANTIGRAVITY_IDE_DATA_DIR: process.env.ANTIGRAVITY_IDE_DATA_DIR,
    ANTIGRAVITY_LS_ADDRESS: process.env.ANTIGRAVITY_LS_ADDRESS,
    ANTIGRAVITY_LS_ADDR: process.env.ANTIGRAVITY_LS_ADDR,
    ANTIGRAVITY_CSRF_TOKEN: process.env.ANTIGRAVITY_CSRF_TOKEN
  };

  try {
    const convId = 'beef-cafe-0001-0002';
    const fakeHome = ['', 'Users', 'alice_p1test'].join('/');
    const fakeLinuxHome = ['', 'home', 'bob_p1test'].join('/');
    const fakeBearer = 'Bearer ' + 'sk-' + 'p1p2mocksecret1234567890';

    // 1. sqlite_reader.mjs protobuf decoding + collector.mjs integration
    let p1Snap = null;
    let p1Hist = null;
    if (DatabaseSyncCtor) {
      const encVarint = (n) => {
        const out = [];
        let v = BigInt(n);
        do {
          let b = Number(v & 0x7fn);
          v >>= 7n;
          if (v > 0n) b |= 0x80;
          out.push(b);
        } while (v > 0n);
        return Buffer.from(out);
      };
      const encTag = (fn, wt) => encVarint((fn << 3) | wt);
      const encLd = (fn, buf) => Buffer.concat([encTag(fn, 2), encVarint(buf.length), buf]);
      const encVi = (fn, val) => Buffer.concat([encTag(fn, 0), encVarint(val)]);
      const encStr = (fn, s) => encLd(fn, Buffer.from(s, 'utf8'));

      const childSkills = Buffer.concat([encStr(1, 'skills'), encVi(3, 1200)]);
      const childRules = Buffer.concat([encStr(1, 'rules'), encVi(3, 800)]);
      const grpSys = Buffer.concat([encStr(1, 'System Prompt'), encVi(4, 2500), encLd(5, childSkills), encLd(5, childRules)]);
      const grpTools = Buffer.concat([encStr(1, 'Tools'), encVi(4, 1500)]);
      const grpChat = Buffer.concat([encStr(1, 'Chat Messages'), encVi(4, 1000)]);
      const bdMsg = Buffer.concat([encLd(1, grpSys), encLd(1, grpTools), encLd(1, grpChat)]);
      const ctxWin = Buffer.concat([encVi(1, 5000), encVi(4, 1000000), encLd(3, bdMsg)]);
      const chatStart = Buffer.concat([encVi(1, 1318), encStr(28, 'gemini-3-flash'), encLd(10, ctxWin)]);
      const usageMsg = Buffer.concat([encVi(2, 3000), encVi(3, 500), encVi(5, 2500), encVi(9, 200), encVi(10, 300)]);
      const dur1 = Buffer.concat([encVi(1, 1), encVi(2, 500_000_000)]);
      const dur2 = Buffer.concat([encVi(1, 2), encVi(2, 500_000_000)]);
      const retryErr1 = encStr(3, `HTTP 429 rate limit exceeded for ${fakeHome}/proj ${fakeBearer}`);
      const retryErr2 = encStr(3, `HTTP 429 rate limit duplicate for ${fakeHome}/proj`);
      const kvReqId = Buffer.concat([encStr(1, 'request_id'), encStr(2, 'req_p1p2_001')]);
      const f1 = Buffer.concat([
        encLd(4, usageMsg),
        encLd(9, chatStart),
        encLd(11, dur1),
        encLd(12, dur2),
        encVi(14, 2),
        encLd(17, retryErr1),
        encLd(17, retryErr2),
        encLd(20, kvReqId)
      ]);
      const top = Buffer.concat([
        encLd(1, f1),
        encVi(2, 1),
        encStr(5, `503 Service Unavailable upstream timeout at ${fakeLinuxHome}/key`)
      ]);

      const dbPath = join(agDir, 'conversations', `${convId}.db`);
      const db = new DatabaseSyncCtor(dbPath);
      try {
        db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
        db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(1, top);
      } finally {
        db.close();
      }

      const { readConversationSqliteSignals, readConversationLatestGenSignal } = await import(
        `${pathToFileURL(join(ROOT, 'sidecars', 'dashboard', 'sqlite_reader.mjs')).href}?p1=${Date.now()}`
      );
      const sig = await readConversationSqliteSignals(dbPath, { includeLatestGenDetail: true });
      const step1 = sig?.genByStep?.get(1);
      assert(
        step1 &&
          step1.usage?.inputTokens === 3000 &&
          step1.usage?.outputTokens === 500 &&
          step1.usage?.cacheReadTokens === 2500 &&
          step1.usage?.thinkingTokens === 200 &&
          step1.usage?.responseTokens === 300 &&
          step1.requestId === 'req_p1p2_001' &&
          step1.retries === 2,
        `P1 sqlite_reader usage/requestId/retries 解码失败：${JSON.stringify(step1)}`
      );
      assert(
        sig?.latestContextWindowMetadata?.tokenBreakdown?.groups?.length === 3 &&
          sig.latestContextWindowMetadata.tokenBreakdown.groups[0].children.some((c) => c.name === 'skills' && c.numTokens === 1200),
        `P1 sqlite_reader tokenBreakdown 解码失败：${JSON.stringify(sig?.latestContextWindowMetadata)}`
      );
      const q429Events = (sig?.events || []).filter((e) => e.kind === 'quota_429');
      const retryEv = (sig?.events || []).find((e) => e.kind === 'upstream_retry');
      assert(
        q429Events.length === 1 &&
          q429Events[0].requestId === 'req_p1p2_001' &&
          q429Events[0].retries === 2 &&
          q429Events[0].source === 'gen_metadata' &&
          !q429Events[0].detail.includes('alice_p1test') &&
          !q429Events[0].detail.includes('p1p2mocksecret') &&
          retryEv &&
          !retryEv.detail.includes('bob_p1test'),
        `P1 sqlite_reader events 去重或脱敏失败：${JSON.stringify(sig?.events)}`
      );
      const fastSig = await readConversationLatestGenSignal(dbPath, { timeoutMs: 200 });
      assert(
        fastSig && fastSig.maxContextTokens === 1000000 && fastSig.contextWindowMetadata === undefined,
        `P1 readConversationLatestGenSignal 快速通道不应解析 breakdown：${JSON.stringify(fastSig)}`
      );

      // 2. collector.mjs integration
      const logDir = join(agDir, 'brain', convId, '.system_generated', 'logs');
      mkdirSync(logDir, { recursive: true });
      const nowIso = new Date().toISOString();
      writeFileSync(
        join(logDir, 'transcript.jsonl'),
        [
          JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'hello p1p2', created_at: nowIso }),
          JSON.stringify({
            step_index: 1,
            type: 'PLANNER_RESPONSE',
            model: 'gemini-3-flash',
            usage: { inputTokens: 3000, cacheReadTokens: 2500, outputTokens: 500 },
            created_at: nowIso
          })
        ].join('\n') + '\n'
      );

      process.env.AG_DIR = agDir;
      process.env.AG_CLI_DIR = cliDir;
      process.env.AG_IDE_DIR = ideDir;
      process.env.ANTIGRAVITY_APP_DATA_DIR = agDir;
      process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = stateDir;
      process.env.ANTIGRAVITY_CLI_DATA_DIR = cliDir;
      process.env.ANTIGRAVITY_IDE_DATA_DIR = ideDir;
      delete process.env.ANTIGRAVITY_LS_ADDRESS;
      delete process.env.ANTIGRAVITY_LS_ADDR;
      delete process.env.ANTIGRAVITY_CSRF_TOKEN;

      const { scanConversation, collectTokenHistory } = await import(
        `${pathToFileURL(join(ROOT, 'sidecars', 'dashboard', 'collector.mjs')).href}?p1=${Date.now()}`
      );
      p1Snap = await scanConversation(convId, { force: true, skipWorkspaceLookup: true });
      p1Hist = await collectTokenHistory({ force: true });

      const bd = p1Snap?.context?.breakdown;
      const bdGroups = bd?.groups || [];
      const sumCalib = bdGroups.reduce((s, g) => s + (g.tokens || 0), 0);
      const skillsGroup = bdGroups.find((g) => g.key === 'skills' || g.name === 'Skills');
      const sysGroup = bdGroups.find((g) => g.name === 'System Prompt');
      assert(
        bd &&
          bd.calibrated === true &&
          bd.reportedTotalTokens === 5000 &&
          bd.totalTokens === 5500 &&
          sumCalib === 5500 &&
          skillsGroup &&
          skillsGroup.reportedTokens === 1200 &&
          sysGroup &&
          sysGroup.reportedTokens === 1300 &&
          p1Snap.context.skillsTokens === skillsGroup.tokens,
        `P1 collector Skills 拆出或最大余数法校准失败：${JSON.stringify(bd)}`
      );
      assert(
        p1Snap.turns?.[0]?.thinkingTokens === 200 &&
          p1Snap.turns?.[0]?.responseTokens === 300 &&
          p1Snap.turns?.[0]?.effectiveTps === 125 &&
          p1Snap.speed?.effectiveTps === 125 &&
          p1Snap.context?.sessionTotals?.responseTokens === 300,
        `P1 collector thinking/response/effectiveTps 失败：turn=${JSON.stringify(p1Snap.turns?.[0])}, speed=${JSON.stringify(p1Snap.speed)}`
      );
      const sessQ429 = (p1Snap.sessionDiagnostics?.events || []).filter((e) => e.kind === 'quota_429');
      const histQ429 = (p1Hist?.diagnostics?.recentEvents || []).filter((e) => e.kind === 'quota_429');
      assert(
        sessQ429.length === 1 &&
          sessQ429[0].requestId === 'req_p1p2_001' &&
          sessQ429[0].retries === 2 &&
          histQ429.length === 1 &&
          histQ429[0].requestId === 'req_p1p2_001' &&
          histQ429[0].retries === 2,
        `P1 collector requestId 去重或 retries 透传失败：sess=${JSON.stringify(sessQ429)}, hist=${JSON.stringify(histQ429)}`
      );
    }

    // 3. pricing.mjs regression tests
    const pricingMod = await import(
      `${pathToFileURL(join(ROOT, 'sidecars', 'dashboard', 'pricing.mjs')).href}?p1=${Date.now()}`
    );
    const sampleMd = [
      '## Gemini 3.1 Pro Preview <a id="gemini-3.1-pro-preview"></a>',
      '{% tab title="Standard" %}',
      '* Input price',
      '  * $2.00',
      '  * $4.00 (starting December 1, 2026)',
      '---',
      '* Output price',
      '  * $12.00',
      '  * $18.00 (starting December 1, 2026)',
      '---',
      '* Context caching price',
      '  * $0.20',
      '  * $0.40 (starting December 1, 2026)',
      '---',
      '{% /tab %}',
      '## Gemini 3.8 Flash <a id="gemini-3.8-flash"></a>',
      '<tab title="Standard">',
      '| Input price | $0.50 |',
      '| Output price | $3.00 |',
      '| Context caching price | $0.05 |',
      '</tab>',
      '## Gemini 3 Pro Image <a id="gemini-3-pro-image"></a>',
      '<tab title="Standard">',
      '| Input price | $2.00 |',
      '</tab>',
      '## Gemini 2.5 Pro <a id="gemini-2.5-pro"></a>',
      '{% tab title="Standard" %}',
      '* Input price',
      '  * $1.25, prompts <= 200k tokens',
      '  * $2.50, prompts > 200k tokens',
      '---',
      '{% /tab %}'
    ].join('\n');
    const parsedEntries = pricingMod.parseOfficialGeminiPricingMarkdown(sampleMd, '2026-11-19');
    const proEntry = parsedEntries.find((e) => e.modelKey === 'gemini-3.1-pro-preview');
    const flashEntry = parsedEntries.find((e) => e.modelKey === 'gemini-3.8-flash');
    assert(
      parsedEntries.length === 2 &&
        proEntry?.rules?.length === 2 &&
        proEntry.rules[0].effectiveTo === '2026-11-30' &&
        proEntry.rules[1].effectiveFrom === '2026-12-01' &&
        proEntry.rules[1].inputPerMillion === 4.0 &&
        flashEntry?.rules?.length === 1 &&
        flashEntry.rules[0].inputPerMillion === 0.5,
      `P1 pricing parseOfficialGeminiPricingMarkdown 解析失败：${JSON.stringify(parsedEntries)}`
    );

    const pricingCacheDir = join(tmpP1Root, 'pricing-cache');
    mkdirSync(pricingCacheDir, { recursive: true });
    const syncRes = await pricingMod.syncOfficialPricing({
      cacheDir: pricingCacheDir,
      fetcher: async () => ({ ok: true, status: 200, text: async () => sampleMd })
    });
    assert(syncRes.count === 2 && existsSync(syncRes.savedPath), `P1 syncOfficialPricing 落盘失败：${JSON.stringify(syncRes)}`);

    let zeroThrown = false;
    try {
      await pricingMod.syncOfficialPricing({
        cacheDir: pricingCacheDir,
        fetcher: async () => ({ ok: true, status: 200, text: async () => 'empty' })
      });
    } catch {
      zeroThrown = true;
    }
    const loadedOv = pricingMod.loadLocalPricingOverrides(pricingCacheDir);
    assert(zeroThrown && loadedOv?.models?.['gemini-3.1-pro-preview'], 'P1 syncOfficialPricing 0 条失败保护异常');

    const ruleBefore = pricingMod.matchPricingRule('gemini-3.1-pro-preview', '2026-11-19', 1000, loadedOv);
    const ruleAfter = pricingMod.matchPricingRule('gemini-3.1-pro-preview', '2026-12-05', 1000, loadedOv);
    const rule3Arg = pricingMod.matchPricingRule('gemini-3.8-flash', '2026-11-19', 1000);
    assert(
      ruleBefore?.inputPerMillion === 2.0 &&
        ruleAfter?.inputPerMillion === 4.0 &&
        rule3Arg?.inputPerMillion > 0,
      `P1 matchPricingRule 3/4 参兼容失败`
    );
    const catalog = pricingMod.getEffectivePricingCatalog({ reqDateStr: '2026-11-19', cacheDir: pricingCacheDir });
    const catPro = catalog.entries.find((e) => e.modelKey === 'gemini-3.1-pro-preview');
    assert(catPro?.source === 'synced' && catPro?.upcomingRule?.effectiveFrom === '2026-12-01', 'P1 getEffectivePricingCatalog 失败');
    const cleared = pricingMod.clearLocalPricingOverrides(pricingCacheDir);
    assert(cleared.removed === true && pricingMod.loadLocalPricingOverrides(pricingCacheDir) === null, 'P1 clearLocalPricingOverrides 失败');

    // 4. GUI VM regression for Skills breakdown, effectiveTps, and diagnostics retries/requestId badges
    const makeEl = (id = '', initClasses = []) => {
      const classes = new Set(initClasses);
      const attrs = new Map();
      return {
        id,
        value: '',
        textContent: '',
        innerHTML: '',
        dataset: {},
        style: {},
        className: initClasses.join(' '),
        classList: {
          add: (...n) => n.forEach((x) => classes.add(x)),
          remove: (...n) => n.forEach((x) => classes.delete(x)),
          toggle: (n, f) => (f === undefined ? !classes.has(n) : Boolean(f)) ? (classes.add(n), true) : (classes.delete(n), false),
          contains: (n) => classes.has(n)
        },
        addEventListener: () => {},
        setAttribute: (k, v) => attrs.set(k, String(v)),
        getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
        hasAttribute: (k) => attrs.has(k),
        removeAttribute: (k) => attrs.delete(k),
        querySelector: () => null,
        querySelectorAll: () => [],
        appendChild: () => {},
        remove: () => {}
      };
    };
    const uiEls = new Map();
    const getUiEl = (id) => {
      if (!uiEls.has(id)) uiEls.set(id, makeEl(id));
      return uiEls.get(id);
    };
    const vmSnap = p1Snap
      ? {
          ...p1Snap,
          speed: { ...p1Snap.speed, tps: 200, streamingTps: 220, effectiveTps: 125 }
        }
      : {
      ok: true,
      etag: 'vm-p1',
      conversationId: convId,
      conversationTitle: 'P1 VM Test',
      quotas: [],
      turns: [{ turnIndex: 1, stepIndex: 1, totalTokens: 6000, inputTokens: 3000, cacheTokens: 2500, outputTokens: 500, thinkingTokens: 200, responseTokens: 300, tps: 200, effectiveTps: 125 }],
      context: {
        model: 'Gemini 3 Flash',
        used: 6000,
        budget: 1000000,
        skillsTokens: 1320,
        thinkingTokens: 200,
        responseTokens: 300,
        sessionTotals: { inputTokens: 3000, cacheTokens: 2500, outputTokens: 500, thinkingTokens: 200, responseTokens: 300, totalTokens: 6000 },
        breakdown: {
          calibrated: true,
          reportedTotalTokens: 5000,
          totalTokens: 5500,
          groups: [
            { key: 'System Prompt', name: 'System Prompt', label: '系统提示与规则', tokens: 1430, reportedTokens: 1300, calibrated: true, children: [] },
            { key: 'skills', name: 'Skills', label: 'Skills 技能指令', tokens: 1320, reportedTokens: 1200, calibrated: true, children: [{ name: 'skills', tokens: 1200 }] },
            { key: 'Tools', name: 'Tools', label: '工具定义 Schema', tokens: 1650, reportedTokens: 1500, calibrated: true, children: [] },
            { key: 'Chat Messages', name: 'Chat Messages', label: '对话与工具历史', tokens: 1100, reportedTokens: 1000, calibrated: true, children: [] }
          ]
        }
      },
      speed: { tps: 200, streamingTps: 220, effectiveTps: 125, duration: 4.0, ttft: 1.5, streamingSec: 2.5, outputTokens: 500, thinkingTokens: 200, responseTokens: 300, isServerExact: true },
      audit: { totalSteps: 2, turnsCount: 1, groups: {} }
    };
    const vmHist = p1Hist || {
      ok: true,
      etag: 'vm-hist-p1',
      diagnostics: {
        sqliteEnabled: true,
        eventsSummary: { total: 1, safetyFilter: 0, safetyWastedUSD: 0, quota429: 1, upstreamRetry: 0, contextOverflow: 0 },
        recentEvents: [{ kind: 'quota_429', convId, convTitle: 'P1 VM Test', date: '2026-11-19', stepIndex: 1, retries: 2, requestId: 'req_p1p2_001', detail: 'HTTP 429 rate limit' }],
        routingSummary: { total: 0, uniqueModels: 0 },
        recentRouting: []
      }
    };
    const rootAttrs = new Map();
    const rootStyles = new Map();
    const uiSandbox = {
      console, Date, Math, JSON, URL, URLSearchParams, Set, Map, Array, Object, String, Number, Boolean, Promise, Error,
      NodeFilter: { SHOW_TEXT: 4 },
      MutationObserver: class { observe() {} disconnect() {} },
      ResizeObserver: class { observe() {} disconnect() {} },
      IntersectionObserver: class { observe() {} disconnect() {} },
      getComputedStyle: () => ({ color: 'rgb(255, 255, 255)', getPropertyValue: () => '' }),
      setTimeout, clearTimeout, clearInterval,
      setInterval: () => 1,
      requestAnimationFrame: (fn) => { fn(); return 1; },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      navigator: { platform: 'MacIntel', userAgent: 'Mozilla/5.0' },
      addEventListener: () => {},
      removeEventListener: () => {},
      document: {
        readyState: 'complete',
        hidden: false,
        visibilityState: 'visible',
        documentElement: {
          clientWidth: 420,
          clientHeight: 760,
          dataset: {},
          appendChild: () => {},
          style: {
            getPropertyValue: (k) => rootStyles.get(k) || '',
            setProperty: (k, v) => rootStyles.set(k, String(v)),
            removeProperty: (k) => rootStyles.delete(k)
          },
          getAttribute: (k) => (rootAttrs.has(k) ? rootAttrs.get(k) : null),
          setAttribute: (k, v) => rootAttrs.set(k, String(v)),
          hasAttribute: (k) => rootAttrs.has(k),
          removeAttribute: (k) => rootAttrs.delete(k)
        },
        body: makeEl('body'),
        getElementById: getUiEl,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {},
        createTreeWalker: () => ({ nextNode: () => null }),
        createElement: (tag) => makeEl(tag)
      },
      window: null,
      fetch: async (urlStr) => {
        const u = new URL(urlStr, 'http://127.0.0.1');
        if (u.pathname === '/api/settings') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, settings: {}, uiPreferences: {}, shortcut: {}, auxShortcut: {}, menubar: { supported: true, enabled: false } })
          };
        }
        if (u.pathname === '/api/context') return { ok: true, status: 200, json: async () => vmSnap };
        if (u.pathname === '/api/history') return { ok: true, status: 200, json: async () => vmHist };
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
    };
    uiSandbox.window = {
      location: { origin: 'http://127.0.0.1', href: 'http://127.0.0.1/', pathname: '/' },
      matchMedia: () => ({ matches: false, addEventListener: () => {} }),
      getComputedStyle: uiSandbox.getComputedStyle,
      addEventListener: () => {},
      removeEventListener: () => {},
      sidecar: { conversationId: convId },
      self: null,
      top: null,
      fetch: uiSandbox.fetch
    };
    uiSandbox.window.self = uiSandbox.window;
    uiSandbox.window.top = uiSandbox.window;
    uiSandbox.location = uiSandbox.window.location;
    runInNewContext(cvAppSource, uiSandbox);
    await new Promise((r) => setTimeout(r, 80));

    const bdHtml = getUiEl('breakdown-groups').innerHTML;
    const diagHtml = getUiEl('diagnostics-list').innerHTML;
    const spStreamText = getUiEl('sp-stream-tps').textContent;
    assert(
      bdHtml.includes('Skills 技能指令') && bdHtml.includes('按实测输入比例校准'),
      `P1 GUI VM breakdown-groups 渲染缺失 Skills 或校准提示：${bdHtml}`
    );
    assert(
      diagHtml.includes('重试 2 次') && diagHtml.includes('req:req_p1p2_001'),
      `P1 GUI VM diagnostics-list 渲染缺失重试或 requestId 徽章：${diagHtml}`
    );
    assert(
      spStreamText.includes('整请求'),
      `P1 GUI VM sp-stream-tps 应补充整请求有效吞吐：${spStreamText}`
    );

    // 5. CLI subprocess regression for pricing --json / pricing --reset / status / events
    const cliEntry = join(ROOT, 'sidecars', 'dashboard', 'cli.mjs');
    const p1CliEnv = {
      ...process.env,
      AG_DIR: agDir,
      AG_IDE_DIR: ideDir,
      AG_CLI_DIR: cliDir,
      ANTIGRAVITY_APP_DATA_DIR: agDir,
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: stateDir,
      ANTIGRAVITY_CLI_DATA_DIR: cliDir,
      ANTIGRAVITY_IDE_DATA_DIR: ideDir,
      NO_COLOR: '1'
    };
    delete p1CliEnv.ANTIGRAVITY_LS_ADDRESS;
    delete p1CliEnv.ANTIGRAVITY_LS_ADDR;
    delete p1CliEnv.ANTIGRAVITY_CSRF_TOKEN;
    const runP1Cli = (args) => {
      const r = spawnSync(process.execPath, [cliEntry, ...args], {
        env: p1CliEnv,
        encoding: 'utf-8',
        timeout: 15000
      });
      assert(r.status === 0, `P1 CLI (${args.join(' ')}) 退出码异常 ${r.status}：${r.stderr}`);
      assert(
        !String(r.stderr || '').includes('ExperimentalWarning: SQLite'),
        `P1 CLI (${args.join(' ')}) stderr 不得泄露 ExperimentalWarning: SQLite：${r.stderr}`
      );
      return String(r.stdout || '');
    };
    const pricingJsonOut = JSON.parse(runP1Cli(['pricing', '--json']));
    assert(
      Array.isArray(pricingJsonOut.entries) && pricingJsonOut.entries.length > 0,
      `P1 CLI pricing --json 输出异常：${JSON.stringify(pricingJsonOut).slice(0, 300)}`
    );
    const pricingResetOut = JSON.parse(runP1Cli(['pricing', '--reset', '--json']));
    assert(
      pricingResetOut.action === 'reset' &&
        typeof pricingResetOut.removed === 'boolean' &&
        Array.isArray(pricingResetOut.catalog?.entries),
      `P1 CLI pricing --reset --json 输出异常：${JSON.stringify(pricingResetOut)}`
    );
    if (DatabaseSyncCtor) {
      const statusOut = runP1Cli(['status', convId]);
      assert(
        statusOut.includes('Skills') && statusOut.includes('含思考'),
        `P1 CLI status 应展示 Skills 与思考/正文拆分：${statusOut}`
      );
      const eventsOut = runP1Cli(['events']);
      assert(
        eventsOut.includes('重试 2 次') && eventsOut.includes('req:req_p1p2_001'),
        `P1 CLI events 应展示 retries 与 requestId：${eventsOut}`
      );
    }
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmpP1Root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});

async function verifyCacheStatsAndCustomRange(cvHtmlSource, cvAppSource) {
  console.log('[verify] 7/7 会话平均缓存命中率、分模型平均缓存率与自定义日期趋势回归测试...');
  assert(
    !cvHtmlSource.includes('id="ctx-rem"') &&
      cvHtmlSource.includes('id="ctx-session-cache"') &&
      cvHtmlSource.includes('id="ctx-session-models-wrap"') &&
      cvHtmlSource.includes('id="custom-range-row"') &&
      cvHtmlSource.includes('id="custom-range-summary"') &&
      cvHtmlSource.includes('data-chart="custom"'),
    'HTML 缺少会话平均缓存、模型级缓存或自定义日期趋势控件'
  );

  const tmpRoot = mkdtempSync(join(tmpdir(), 'ag-cv-custom-'));
  const agDir = join(tmpRoot, 'ag');
  const cliDir = join(tmpRoot, 'cli');
  const ideDir = join(tmpRoot, 'ide');
  const stateDir = join(tmpRoot, 'state');
  mkdirSync(agDir, { recursive: true });
  mkdirSync(cliDir, { recursive: true });
  mkdirSync(ideDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  const savedEnv = {
    AG_DIR: process.env.AG_DIR,
    AG_CLI_DIR: process.env.AG_CLI_DIR,
    AG_IDE_DIR: process.env.AG_IDE_DIR,
    ANTIGRAVITY_APP_DATA_DIR: process.env.ANTIGRAVITY_APP_DATA_DIR,
    ANTIGRAVITY_CLI_DATA_DIR: process.env.ANTIGRAVITY_CLI_DATA_DIR,
    ANTIGRAVITY_IDE_DATA_DIR: process.env.ANTIGRAVITY_IDE_DATA_DIR,
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR,
    ANTIGRAVITY_LS_ADDRESS: process.env.ANTIGRAVITY_LS_ADDRESS,
    ANTIGRAVITY_CSRF_TOKEN: process.env.ANTIGRAVITY_CSRF_TOKEN
  };

  try {
    process.env.AG_DIR = agDir;
    process.env.AG_CLI_DIR = cliDir;
    process.env.AG_IDE_DIR = ideDir;
    process.env.ANTIGRAVITY_APP_DATA_DIR = agDir;
    process.env.ANTIGRAVITY_CLI_DATA_DIR = cliDir;
    process.env.ANTIGRAVITY_IDE_DATA_DIR = ideDir;
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = stateDir;
    delete process.env.ANTIGRAVITY_LS_ADDRESS;
    delete process.env.ANTIGRAVITY_CSRF_TOKEN;

    const { scanConversation, collectTokenHistory } = await import(
      `${pathToFileURL(join(ROOT, 'sidecars', 'dashboard', 'collector.mjs')).href}?cv_custom=${Date.now()}`
    );

    const convId = 'c1a2b3c4d5e60009';
    const logDir = join(agDir, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logDir, { recursive: true });
    const now = new Date();
    const ymdDaysAgo = (daysAgo) => {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 10, 0, 0);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return { ymd: `${y}-${m}-${day}`, iso: d.toISOString() };
    };
    const d10 = ymdDaysAgo(10);
    const d03 = ymdDaysAgo(3);
    const d00 = ymdDaysAgo(0);

    // Multi-model session: Carbon (High + XHigh -> merged) & Neon (current)
    const steps = [
      { step_index: 1, type: 'USER_INPUT', created_at: d10.iso, content: 'Start with Carbon' },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        created_at: d10.iso,
        chatModel: { modelDisplayName: 'Gemini 4 Carbon (High)', usage: { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 200 } },
        content: 'Carbon step 1'
      },
      {
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        created_at: d03.iso,
        chatModel: { modelDisplayName: 'Gemini 4 Carbon (XHigh)', usage: { inputTokens: 1000, cacheReadTokens: 8000, outputTokens: 300 } },
        content: 'Carbon step 2'
      },
      { step_index: 4, type: 'USER_INPUT', created_at: d00.iso, content: 'Model Selection from Gemini 4 Carbon (XHigh) to Gemini 4 Neon.' },
      {
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        created_at: d00.iso,
        chatModel: { modelDisplayName: 'Orchestrator (Neon)', usage: { inputTokens: 500, cacheReadTokens: 9500, outputTokens: 400 } },
        content: 'Neon step 3'
      }
    ];
    writeFileSync(join(logDir, 'transcript.jsonl'), steps.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf-8');

    const snap = await scanConversation(convId, { force: true });
    // Session totals: input = 2500, cache = 17500 -> cacheHitPercent = 17500 / 20000 = 87.5%
    assert(
      snap.context?.sessionTotals?.cacheHitPercent === 87.5 &&
        snap.context?.sessionTotals?.turnsCount === 3,
      `会话平均缓存率计算异常：${JSON.stringify(snap.context?.sessionTotals)}`
    );
    const models = snap.context?.sessionModels || [];
    const carbonM = models.find((m) => m.displayName === 'Gemini 4 Carbon');
    const neonM = models.find((m) => m.displayName === 'Gemini 4 Neon');
    // Carbon: input=2000, cache=8000 -> 80.0%; Neon: input=500, cache=9500 -> 95.0%
    assert(
      models.length === 2 &&
        carbonM?.turnsCount === 2 &&
        carbonM?.cacheHitPercent === 80 &&
        carbonM?.variants?.includes('Gemini 4 Carbon (High)') &&
        carbonM?.variants?.includes('Gemini 4 Carbon (XHigh)') &&
        carbonM?.isCurrent === false &&
        neonM?.turnsCount === 1 &&
        neonM?.cacheHitPercent === 95 &&
        neonM?.isCurrent === true,
      `分模型平均缓存率归并异常：${JSON.stringify(models)}`
    );

    const hist = await collectTokenHistory({ force: true });
    const d03Rec = hist.dailyMapBySource?.all?.[d03.ymd];
    assert(
      Array.isArray(d03Rec?.byModel) &&
        d03Rec.byModel[0]?.input === 1000 &&
        d03Rec.byModel[0]?.cache === 8000,
      `collectTokenHistory daily byModel 未携带 input/cache 字段：${JSON.stringify(d03Rec)}`
    );

    // GUI VM regression: Hero session cache, Session Models card, and Custom Date Range statistics
    const makeEl = (id = '', initClasses = []) => {
      const classes = new Set(initClasses);
      const attrs = new Map();
      const listeners = new Map();
      return {
        id,
        value: '',
        max: '',
        textContent: '',
        innerHTML: '',
        scrollTop: 0,
        dataset: {},
        style: {},
        className: initClasses.join(' '),
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
        hasAttribute: (k) => attrs.has(k),
        removeAttribute: (k) => attrs.delete(k),
        querySelector: () => null,
        querySelectorAll: () => [],
        appendChild: () => {},
        remove: () => {}
      };
    };
    const uiEls = new Map();
    const getUiEl = (id) => {
      if (!uiEls.has(id)) uiEls.set(id, makeEl(id));
      return uiEls.get(id);
    };
    uiEls.set('ctx-session-models-wrap', makeEl('ctx-session-models-wrap', ['session-models-wrap', 'hidden']));
    uiEls.set('heat-nav-row', makeEl('heat-nav-row', ['heat-nav-row']));
    uiEls.set('hourly-day-row', makeEl('hourly-day-row', ['hourly-day-row', 'hidden']));
    uiEls.set('custom-range-row', makeEl('custom-range-row', ['custom-range-row', 'hidden']));
    uiEls.set('custom-range-summary', makeEl('custom-range-summary', ['custom-range-summary', 'hidden']));

    const btnChartDaily = makeEl('btn-chart-daily', ['seg-btn', 'active']);
    btnChartDaily.dataset.chart = 'daily';
    const btnChartCustom = makeEl('btn-chart-custom', ['seg-btn']);
    btnChartCustom.dataset.chart = 'custom';
    const chartModeBtns = [btnChartDaily, btnChartCustom];

    const btnPreset7d = makeEl('btn-cp-7d', ['seg-btn']);
    btnPreset7d.dataset.cpreset = '7d';
    const btnPreset30d = makeEl('btn-cp-30d', ['seg-btn', 'active']);
    btnPreset30d.dataset.cpreset = '30d';
    const customPresetBtns = [btnPreset7d, btnPreset30d];

    const btnGranDay = makeEl('btn-cg-day', ['seg-btn']);
    btnGranDay.dataset.cgran = 'day';
    const btnGranWeek = makeEl('btn-cg-week', ['seg-btn']);
    btnGranWeek.dataset.cgran = 'week';
    const customGranBtns = [btnGranDay, btnGranWeek];

    const rootAttrs = new Map();
    const rootStyles = new Map();
    const uiSandbox = {
      console, Date, Math, JSON, URL, URLSearchParams, Set, Map, Array, Object, String, Number, Boolean, Promise, Error,
      NodeFilter: { SHOW_TEXT: 4 },
      MutationObserver: class { observe() {} disconnect() {} },
      ResizeObserver: class { observe() {} disconnect() {} },
      IntersectionObserver: class { observe() {} disconnect() {} },
      getComputedStyle: () => ({ color: 'rgb(255, 255, 255)', getPropertyValue: () => '' }),
      setTimeout, clearTimeout, clearInterval,
      setInterval: () => 1,
      requestAnimationFrame: (fn) => { fn(); return 1; },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      navigator: { platform: 'MacIntel', userAgent: 'Mozilla/5.0' },
      addEventListener: () => {},
      removeEventListener: () => {},
      document: {
        readyState: 'complete',
        hidden: false,
        visibilityState: 'visible',
        documentElement: {
          clientWidth: 480,
          clientHeight: 760,
          dataset: {},
          appendChild: () => {},
          style: {
            getPropertyValue: (k) => rootStyles.get(k) || '',
            setProperty: (k, v) => rootStyles.set(k, String(v)),
            removeProperty: (k) => rootStyles.delete(k)
          },
          getAttribute: (k) => (rootAttrs.has(k) ? rootAttrs.get(k) : null),
          setAttribute: (k, v) => rootAttrs.set(k, String(v)),
          hasAttribute: (k) => rootAttrs.has(k),
          removeAttribute: (k) => rootAttrs.delete(k)
        },
        body: makeEl('body'),
        getElementById: getUiEl,
        querySelector: () => null,
        querySelectorAll: (sel) => {
          if (sel === '#chart-mode-seg .seg-btn') return chartModeBtns;
          if (sel === '#custom-preset-seg .seg-btn') return customPresetBtns;
          if (sel === '#custom-gran-seg .seg-btn') return customGranBtns;
          return [];
        },
        createTreeWalker: () => ({ nextNode: () => false, currentNode: null }),
        addEventListener: () => {},
        createElement: (tag) => makeEl(tag)
      },
      window: null,
      fetch: async (urlStr) => {
        const u = new URL(urlStr, 'http://127.0.0.1');
        if (u.pathname === '/api/settings') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, settings: {}, uiPreferences: {}, shortcut: {}, auxShortcut: {}, menubar: { supported: true, enabled: false } })
          };
        }
        if (u.pathname === '/api/context') return { ok: true, status: 200, json: async () => snap };
        if (u.pathname === '/api/history') return { ok: true, status: 200, json: async () => hist };
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
    };
    uiSandbox.window = {
      location: { origin: 'http://127.0.0.1', href: 'http://127.0.0.1/', pathname: '/' },
      matchMedia: () => ({ matches: false, addEventListener: () => {} }),
      getComputedStyle: uiSandbox.getComputedStyle,
      addEventListener: () => {},
      removeEventListener: () => {},
      sidecar: { conversationId: convId },
      self: null,
      top: null,
      fetch: uiSandbox.fetch
    };
    uiSandbox.window.self = uiSandbox.window;
    uiSandbox.window.top = uiSandbox.window;
    uiSandbox.location = uiSandbox.window.location;
    runInNewContext(cvAppSource, uiSandbox);
    await new Promise((r) => setTimeout(r, 60));

    // Check Hero Session Average Cache + Session Models list
    const sessCacheText = getUiEl('ctx-session-cache').textContent;
    const sessCacheSub = getUiEl('ctx-session-cache-sub').textContent;
    const modelsWrap = getUiEl('ctx-session-models-wrap');
    const modelsListHtml = getUiEl('ctx-session-models-list').innerHTML;
    assert(
      sessCacheText === '87.5%' &&
        sessCacheSub.includes('3 轮') &&
        !modelsWrap.classList.contains('hidden') &&
        getUiEl('ctx-session-models-count').textContent === '2 个模型' &&
        modelsListHtml.includes('Gemini 4 Carbon') &&
        modelsListHtml.includes('80.0%') &&
        modelsListHtml.includes('Gemini 4 Neon') &&
        modelsListHtml.includes('95.0%') &&
        modelsListHtml.includes('当前'),
      `GUI VM 会话平均缓存或模型级缓存渲染异常：sessCache=${sessCacheText}, sub=${sessCacheSub}, models=${modelsListHtml}`
    );

    // Switch Tab 2 chart mode to Custom Date Statistics
    btnChartCustom.dispatch('click', { target: btnChartCustom });
    const customRow = getUiEl('custom-range-row');
    const customSummary = getUiEl('custom-range-summary');
    const stage30dHtml = getUiEl('chart-stage').innerHTML;
    const bars30d = stage30dHtml.match(/class="bar-col\b/g) || [];
    assert(
      !customRow.classList.contains('hidden') &&
        !customSummary.classList.contains('hidden') &&
        getUiEl('heat-nav-row').classList.contains('hidden') &&
        bars30d.length === 30 &&
        customSummary.innerHTML.includes('区间平均缓存 87.5%') &&
        customSummary.innerHTML.includes('Gemini 4 Carbon') &&
        customSummary.innerHTML.includes('Gemini 4 Neon') &&
        getUiEl('sum-tok').textContent.length > 0,
      `GUI VM 自定义日期统计默认 30 天渲染异常：bars=${bars30d.length}, summary=${customSummary.innerHTML}`
    );

    // Switch preset to 7 days -> should exclude d10 (only d03 + d00 -> 1000+8000+300 + 500+9500+400 = 19700)
    btnPreset7d.dispatch('click', { target: btnPreset7d });
    const bars7d = (getUiEl('chart-stage').innerHTML.match(/class="bar-col\b/g) || []).length;
    assert(
      bars7d === 7 &&
        getUiEl('sum-tok').textContent === '19.7K' &&
        customSummary.innerHTML.includes('区间平均缓存 92.1%'),
      `GUI VM 近 7 天预设统计异常：bars=${bars7d}, sumTok=${getUiEl('sum-tok').textContent}, summary=${customSummary.innerHTML}`
    );

    // Inverted date input (start > end) -> auto-normalizes without crash
    const startInput = getUiEl('custom-start-date');
    const endInput = getUiEl('custom-end-date');
    startInput.dispatch('change', { target: { value: d00.ymd } });
    endInput.dispatch('change', { target: { value: d10.ymd } });
    assert(
      startInput.value === d10.ymd &&
        endInput.value === d10.ymd &&
        (getUiEl('chart-stage').innerHTML.match(/class="bar-col\b/g) || []).length === 1,
      `GUI VM 倒置日期输入自动纠偏异常：start=${startInput.value}, end=${endInput.value}`
    );

    // CLI status & json checks for sessionModels + 会话均值
    const cliEntry = join(ROOT, 'sidecars', 'dashboard', 'cli.mjs');
    const cliEnv = { ...process.env, NO_COLOR: '1' };
    const cliJson = JSON.parse(execFileSync(process.execPath, [cliEntry, 'json', convId], { env: cliEnv, encoding: 'utf-8' }));
    assert(
      Array.isArray(cliJson.conversation?.sessionModels) &&
        cliJson.conversation.sessionModels.length === 2 &&
        cliJson.conversation.sessionTotals?.cacheHitPercent === 87.5,
      `CLI json 缺少 sessionModels 或 sessionTotals.cacheHitPercent：${JSON.stringify(cliJson.conversation)}`
    );
    const cliStatusOut = execFileSync(process.execPath, [cliEntry, 'status', convId], { env: cliEnv, encoding: 'utf-8' });
    assert(
      cliStatusOut.includes('会话均值 87.5%') &&
        cliStatusOut.includes('模型缓存') &&
        cliStatusOut.includes('Gemini 4 Neon 95%'),
      `CLI status 未输出会话均值或模型缓存：${cliStatusOut}`
    );
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function verifyCliFollowAndProjectGrouping(cvHtmlSource, cvAppSource) {
  console.log('[verify] 8/8 CLI 自动跟随灵敏度、项目分组筛选与 pinnedConvId 同步回归测试...');

  // 8.1: Float HTML bundle integrity & DOM hooks check
  const cvCssSource = readFileSync(join(ROOT, 'sidecars', 'dashboard', 'styles.css'), 'utf-8');
  assert(
    cvHtmlSource.includes('id="conv-picker-trigger"') &&
      cvHtmlSource.includes('id="conv-popover"') &&
      cvHtmlSource.includes('id="conv-search-input"') &&
      cvHtmlSource.includes('id="conv-project-pills"') &&
      cvHtmlSource.includes('id="conv-pop-body"') &&
      cvHtmlSource.includes('id="btn-follow-current"'),
    'index.html 缺少项目分组会话选择器关键 DOM ID'
  );
  const floatBundledHtml = cvHtmlSource
    .replace(/<script\s+src="\/preload\.js"><\/script>/i, '')
    .replace(/<link\s+rel="stylesheet"\s+href="\/styles\.css[^"]*">/i, () => `<style id="cv-inline-styles">\n${cvCssSource.replace(/<\/style/gi, '<\\/style')}\n</style>`)
    .replace(/<script\s+src="\/app\.js[^"]*"><\/script>/i, () => `<script>window.__CV_FLOAT_MODE__ = true;</script>\n<script>\n${cvAppSource.replace(/<\/script/gi, '<\\/script')}\n</script>`);
  assert(
    !/<script\s+src="\/preload\.js"><\/script>/i.test(floatBundledHtml) &&
      !/<link\s+rel="stylesheet"\s+href="\/styles\.css/i.test(floatBundledHtml) &&
      !/<script\s+src="\/app\.js/i.test(floatBundledHtml) &&
      floatBundledHtml.includes('<style id="cv-inline-styles">') &&
      floatBundledHtml.indexOf('window.__CV_FLOAT_MODE__ = true;') < floatBundledHtml.indexOf('renderConversationPicker'),
    'float_window.mjs 打包 index.html/styles.css/app.js 正则替换或注入顺序异常'
  );

  // 8.2: Isolated backend tests for CLI auto-follow, swarm keepalive, anti-pollution, history.jsonl, pinned cleanup, project metadata & ~ filtering
  const tmpRoot = mkdtempSync(join(tmpdir(), 'ag-cv-cli-proj-'));
  const agDir = join(tmpRoot, 'ag');
  const cliDir = join(tmpRoot, 'cli');
  const ideDir = join(tmpRoot, 'ide');
  const stateDir = join(tmpRoot, 'state');
  const repoAlphaDir = join(tmpRoot, 'repo-alpha');
  const repoBetaDir = join(tmpRoot, 'repo-beta');
  for (const d of [agDir, cliDir, ideDir, stateDir, join(repoAlphaDir, '.git'), repoBetaDir]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(repoAlphaDir, '.git', 'HEAD'), 'ref: refs/heads/feat/group\n', 'utf-8');

  const savedEnv = {
    AG_DIR: process.env.AG_DIR,
    AG_CLI_DIR: process.env.AG_CLI_DIR,
    AG_IDE_DIR: process.env.AG_IDE_DIR,
    ANTIGRAVITY_APP_DATA_DIR: process.env.ANTIGRAVITY_APP_DATA_DIR,
    ANTIGRAVITY_CLI_DATA_DIR: process.env.ANTIGRAVITY_CLI_DATA_DIR,
    ANTIGRAVITY_IDE_DATA_DIR: process.env.ANTIGRAVITY_IDE_DATA_DIR,
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR,
    ANTIGRAVITY_LS_ADDRESS: process.env.ANTIGRAVITY_LS_ADDRESS,
    ANTIGRAVITY_CSRF_TOKEN: process.env.ANTIGRAVITY_CSRF_TOKEN
  };

  const mkUuid = (n) => ['cc000000', '0000', '4000', '8000', String(n).padStart(12, '0')].join('-');
  const writeTranscript = (rootDir, convId, steps, mtimeMs) => {
    const logDir = join(rootDir, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, 'transcript.jsonl');
    writeFileSync(logPath, steps.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf-8');
    if (mtimeMs) {
      const sec = mtimeMs / 1000;
      utimesSync(logPath, sec, sec);
    }
    return logPath;
  };

  try {
    process.env.AG_DIR = agDir;
    process.env.AG_CLI_DIR = cliDir;
    process.env.AG_IDE_DIR = ideDir;
    process.env.ANTIGRAVITY_APP_DATA_DIR = agDir;
    process.env.ANTIGRAVITY_CLI_DATA_DIR = cliDir;
    process.env.ANTIGRAVITY_IDE_DATA_DIR = ideDir;
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = stateDir;
    delete process.env.ANTIGRAVITY_LS_ADDRESS;
    delete process.env.ANTIGRAVITY_CSRF_TOKEN;

    const collectorMod = await import(
      `${pathToFileURL(join(ROOT, 'sidecars', 'dashboard', 'collector.mjs')).href}?cv_cli_proj=${Date.now()}`
    );
    const {
      listRecentConversations,
      readActiveSessionHint,
      scanConversation,
      updateActiveSessionHint
    } = collectorMod;

    const nowMs = Date.now();
    // 28 newer desktop conversations (should not squeeze out older CLI sessions due to per-source floor)
    const desktopMainId = mkUuid(1);
    for (let i = 1; i <= 28; i++) {
      const did = mkUuid(i);
      const tMs = nowMs - (600_000 + i * 2000);
      writeTranscript(agDir, did, [
        { step_index: 0, type: 'USER_INPUT', created_at: new Date(tMs).toISOString(), content: `Desktop task ${i}` },
        { step_index: 1, type: 'PLANNER_RESPONSE', created_at: new Date(tMs + 500).toISOString(), model: 'Gemini 4 Carbon', input_tokens: 100, output_tokens: 20 }
      ], tMs);
    }

    // Old CLI session with stale swarm `phase: 'RUNNING'` and recent trailing `SYSTEM_MESSAGE` / `CHECKPOINT` noise
    const cliOldStaleId = mkUuid(101);
    const cliOldChildId = mkUuid(102);
    const staleTurnMs = nowMs - 15 * 60_000;
    writeTranscript(cliDir, cliOldStaleId, [
      { step_index: 0, type: 'USER_INPUT', created_at: new Date(staleTurnMs).toISOString(), content: 'Old CLI stale swarm' },
      { step_index: 1, type: 'PLANNER_RESPONSE', created_at: new Date(staleTurnMs + 1000).toISOString(), model: 'Gemini 4 Neon', input_tokens: 500, output_tokens: 50 },
      { step_index: 2, type: 'SYSTEM_MESSAGE', created_at: new Date(nowMs - 2000).toISOString(), content: 'Background timer ping' },
      { step_index: 3, type: 'CHECKPOINT', created_at: new Date(nowMs - 1000).toISOString(), content: 'checkpoint' }
    ], nowMs - 1000);
    writeTranscript(cliDir, cliOldChildId, [
      { step_index: 0, type: 'SYSTEM_MESSAGE', created_at: new Date(staleTurnMs).toISOString(), content: 'Worker boot' },
      { step_index: 1, type: 'PLANNER_RESPONSE', created_at: new Date(staleTurnMs + 2000).toISOString(), model: 'Gemini 4 Neon', input_tokens: 200, output_tokens: 20 },
      { step_index: 2, type: 'SYSTEM_MESSAGE', created_at: new Date(nowMs - 1500).toISOString(), content: 'Stale child ping' }
    ], nowMs - 1500);
    mkdirSync(join(cliDir, 'brain', cliOldStaleId, '.system_generated', 'swarm'), { recursive: true });
    writeFileSync(
      join(cliDir, 'brain', cliOldStaleId, '.system_generated', 'swarm', 'members.json'),
      JSON.stringify({ members: [{ conversation_id: cliOldChildId, phase: 'RUNNING' }] }),
      'utf-8'
    );

    // Active parent CLI session: parent USER_INPUT was 4m ago (outside 3m window), kept alive by active non-killed swarm child
    const cliActiveParentId = mkUuid(103);
    const cliActiveChildId = mkUuid(104);
    const parentTurnMs = nowMs - 4 * 60_000;
    const childProgressMs = nowMs - 15_000;
    writeTranscript(cliDir, cliActiveParentId, [
      { step_index: 0, type: 'USER_INPUT', created_at: new Date(parentTurnMs).toISOString(), content: 'Active swarm parent' },
      { step_index: 1, type: 'PLANNER_RESPONSE', created_at: new Date(parentTurnMs + 1000).toISOString(), model: 'Gemini 4 Neon', input_tokens: 800, output_tokens: 80 },
      { step_index: 2, type: 'SYSTEM_MESSAGE', created_at: new Date(nowMs - 5000).toISOString(), content: 'swarm_wait' }
    ], nowMs - 5000);
    writeTranscript(cliDir, cliActiveChildId, [
      { step_index: 0, type: 'SYSTEM_MESSAGE', created_at: new Date(parentTurnMs + 2000).toISOString(), content: 'Child start' },
      { step_index: 1, type: 'PLANNER_RESPONSE', created_at: new Date(childProgressMs).toISOString(), model: 'Gemini 4 Carbon', input_tokens: 400, output_tokens: 40 }
    ], childProgressMs);
    mkdirSync(join(cliDir, 'brain', cliActiveParentId, '.system_generated', 'swarm'), { recursive: true });
    writeFileSync(
      join(cliDir, 'brain', cliActiveParentId, '.system_generated', 'swarm', 'members.json'),
      JSON.stringify({ members: [{ conversation_id: cliActiveChildId, phase: 'WORKING' }] }),
      'utf-8'
    );

    // CLI session with tilde workspace in last_conversations.json (must filter '~' to null) + valid repoBeta
    const cliTildeId = mkUuid(105);
    const cliBetaId = mkUuid(106);
    writeTranscript(cliDir, cliTildeId, [
      { step_index: 0, type: 'USER_INPUT', created_at: new Date(nowMs - 900_000).toISOString(), content: 'Tilde home CLI' }
    ], nowMs - 900_000);
    writeTranscript(cliDir, cliBetaId, [
      { step_index: 0, type: 'USER_INPUT', created_at: new Date(nowMs - 850_000).toISOString(), content: 'Beta CLI' }
    ], nowMs - 850_000);
    mkdirSync(join(cliDir, 'cache'), { recursive: true });
    writeFileSync(
      join(cliDir, 'cache', 'last_conversations.json'),
      JSON.stringify({
        workspaces: {
          '~': cliTildeId,
          [repoBetaDir]: cliBetaId
        }
      }),
      'utf-8'
    );

    // Check per-source floor (limit=24 still retains CLI entries) + swarm keepalive vs stale RUNNING/SYSTEM_MESSAGE
    const recent24 = listRecentConversations(24, nowMs);
    assert(
      recent24.some((c) => c.source === 'desktop') && recent24.some((c) => c.source === 'cli'),
      `listRecentConversations(24) 分源保底失败（28 条 Desktop 不得挤掉 CLI）：sources=${[...new Set(recent24.map((c) => c.source))].join(',')}`
    );

    const snapParent = await scanConversation('', { force: true, nowMs });
    const oldItem = snapParent.recentConversations?.find((c) => c.id === cliOldStaleId);
    const parentItem = snapParent.recentConversations?.find((c) => c.id === cliActiveParentId);
    const tildeItem = snapParent.recentConversations?.find((c) => c.id === cliTildeId);
    const betaItem = snapParent.recentConversations?.find((c) => c.id === cliBetaId);
    assert(
      snapParent.conversationId === cliActiveParentId &&
        oldItem?.isRunning === false &&
        parentItem?.isRunning === true,
      `Swarm 保活与抗旧 RUNNING/SYSTEM_MESSAGE 污染异常：chosen=${snapParent.conversationId}, oldRun=${oldItem?.isRunning}, parentRun=${parentItem?.isRunning}`
    );
    assert(
      tildeItem?.projectName === null &&
        tildeItem?.repoLabel === null &&
        betaItem?.projectName === 'repo-beta',
      `recentConversations 项目元数据回填或 ~ 过滤异常：tilde=${JSON.stringify(tildeItem)}, beta=${JSON.stringify(betaItem)}`
    );

    // Append a new CLI session to history.jsonl -> immediate auto-follow switch + git branch repoLabel
    const cliNewId = mkUuid(107);
    const histTsMs = nowMs + 2000;
    writeTranscript(cliDir, cliNewId, [
      { step_index: 0, type: 'USER_INPUT', created_at: new Date(histTsMs - 500).toISOString(), content: 'New CLI alpha session' },
      { step_index: 1, type: 'PLANNER_RESPONSE', created_at: new Date(histTsMs).toISOString(), model: 'Gemini 4 Neon', input_tokens: 600, output_tokens: 60 }
    ], histTsMs);
    writeFileSync(
      join(cliDir, 'history.jsonl'),
      `${JSON.stringify({ conversationId: cliNewId, timestamp: histTsMs, workspace: repoAlphaDir })}\n`,
      'utf-8'
    );
    const snapNewCli = await scanConversation('', { force: true, nowMs: histTsMs + 500 });
    const alphaItem = snapNewCli.recentConversations?.find((c) => c.id === cliNewId);
    assert(
      snapNewCli.conversationId === cliNewId &&
        alphaItem?.projectName === 'repo-alpha' &&
        alphaItem?.repoLabel === 'repo-alpha@feat/group',
      `CLI history.jsonl 切主或 Git 分支标签回填异常：chosen=${snapNewCli.conversationId}, alpha=${JSON.stringify(alphaItem)}`
    );

    // Desktop Aux Pane explicit conversationId must never regress under active CLI sessions
    const snapDesktopAux = await scanConversation(desktopMainId, { force: true, nowMs: histTsMs + 500 });
    assert(
      snapDesktopAux.conversationId === desktopMainId,
      `Desktop Aux Pane 显式 conversationId 发生退化：${snapDesktopAux.conversationId}`
    );

    // Invalid / deleted pinnedConvId must auto-clear and fall back cleanly
    const deletedPinnedId = mkUuid(999);
    updateActiveSessionHint({ pinnedConvId: deletedPinnedId });
    const snapPinnedCleared = await scanConversation('', { force: true, nowMs: histTsMs + 600 });
    assert(
      snapPinnedCleared.pinnedConvId === null &&
        snapPinnedCleared.conversationId === cliNewId &&
        readActiveSessionHint().pinnedConvId === '',
      `失效 pinnedConvId 未自动清理或回退异常：snapPinned=${snapPinnedCleared.pinnedConvId}, hint=${readActiveSessionHint().pinnedConvId}`
    );

    // Monitor member in sleeping Swarm must NOT keep old parent alive or hijack a quiet-reading newer session (> 3m old)
    const monitorTestNowMs = histTsMs + 10 * 60_000;
    const cliQuietReadingId = mkUuid(109);
    const cliOldMonitorParentId = mkUuid(110);
    const cliMonitorWorkerId = mkUuid(111);
    const cliMonitorNumberedId = mkUuid(112);
    const quietTurnMs = monitorTestNowMs - 4 * 60_000; // 4m ago (> 3m ACTIVE_WORK_WINDOW_MS)
    const oldSwarmTurnMs = monitorTestNowMs - 20 * 60_000; // 20m ago
    const monitorWakeMs = monitorTestNowMs - 20_000; // 20s ago
    writeTranscript(cliDir, cliQuietReadingId, [
      { step_index: 0, type: 'USER_INPUT', created_at: new Date(quietTurnMs).toISOString(), content: 'Quiet reading session' },
      { step_index: 1, type: 'PLANNER_RESPONSE', created_at: new Date(quietTurnMs + 10_000).toISOString(), model: 'Gemini 4 Neon', input_tokens: 700, output_tokens: 70 }
    ], quietTurnMs + 10_000);
    writeTranscript(cliDir, cliOldMonitorParentId, [
      { step_index: 0, type: 'USER_INPUT', created_at: new Date(oldSwarmTurnMs).toISOString(), content: 'Old sleeping swarm parent' },
      { step_index: 1, type: 'PLANNER_RESPONSE', created_at: new Date(oldSwarmTurnMs + 5000).toISOString(), model: 'Gemini 4 Neon', input_tokens: 500, output_tokens: 50 }
    ], oldSwarmTurnMs + 5000);
    writeTranscript(cliDir, cliMonitorWorkerId, [
      { step_index: 0, type: 'SYSTEM_MESSAGE', created_at: new Date(oldSwarmTurnMs + 6000).toISOString(), content: 'Monitor start' },
      { step_index: 1, type: 'PLANNER_RESPONSE', created_at: new Date(monitorWakeMs).toISOString(), model: 'Gemini 4 Carbon', input_tokens: 150, output_tokens: 15 }
    ], monitorWakeMs);
    writeTranscript(cliDir, cliMonitorNumberedId, [
      { step_index: 0, type: 'SYSTEM_MESSAGE', created_at: new Date(oldSwarmTurnMs + 6000).toISOString(), content: 'Monitor-1 start' },
      { step_index: 1, type: 'PLANNER_RESPONSE', created_at: new Date(monitorWakeMs).toISOString(), model: 'Gemini 4 Carbon', input_tokens: 150, output_tokens: 15 }
    ], monitorWakeMs);
    mkdirSync(join(cliDir, 'brain', cliOldMonitorParentId, '.system_generated', 'swarm'), { recursive: true });
    writeFileSync(
      join(cliDir, 'brain', cliOldMonitorParentId, '.system_generated', 'swarm', 'members.json'),
      JSON.stringify({
        members: {
          monitor: { conversation_id: cliMonitorWorkerId, phase: 'WORKING' },
          'Monitor-1': { conversation_id: cliMonitorNumberedId, role: 'monitor-1', phase: 'RUNNING' }
        }
      }),
      'utf-8'
    );
    const snapMonitorIsolation = await scanConversation('', { force: true, nowMs: monitorTestNowMs });
    const oldMonitorParentItem = snapMonitorIsolation.recentConversations?.find((c) => c.id === cliOldMonitorParentId);
    assert(
      snapMonitorIsolation.conversationId === cliQuietReadingId &&
        oldMonitorParentItem?.isRunning === false,
      `旧 Swarm 的 monitor 巡检成员不应伪保活或抢占静默阅读中的新会话：chosen=${snapMonitorIsolation.conversationId}, expected=${cliQuietReadingId}, oldMonitorRun=${oldMonitorParentItem?.isRunning}`
    );

    // cli.mjs statusline: silent redraw on old conv must NOT write cliActiveConvId, while real progression DOES
    const cliEntry = join(ROOT, 'sidecars', 'dashboard', 'cli.mjs');
    const slEnv = { ...process.env, NO_COLOR: '1' };
    updateActiveSessionHint({ cliActiveConvId: '', cliActiveAt: 0 });
    // Cold statusline on old conv (mtime > 30s ago) -> no progression -> must not hijack cliActiveConvId
    execFileSync(process.execPath, [cliEntry, 'statusline', '--format', 'plain'], {
      input: JSON.stringify({ session_id: cliOldStaleId, conversation_id: cliOldStaleId }),
      env: slEnv,
      encoding: 'utf-8',
      timeout: 10000
    });
    assert(
      readActiveSessionHint().cliActiveConvId === '',
      `旧会话静默 statusline 重绘不应写入 cliActiveConvId：${readActiveSessionHint().cliActiveConvId}`
    );
    // Real progression on cliNewId (first cold read within 30s or file growth) -> writes cliActiveConvId
    const freshProgId = mkUuid(108);
    const freshNow = Date.now();
    const freshLogPath = writeTranscript(cliDir, freshProgId, [
      { step_index: 0, type: 'USER_INPUT', created_at: new Date(freshNow).toISOString(), content: 'Progressed CLI' }
    ], freshNow);
    execFileSync(process.execPath, [cliEntry, 'statusline', '--format', 'plain'], {
      input: JSON.stringify({ session_id: freshProgId, conversation_id: freshProgId }),
      env: slEnv,
      encoding: 'utf-8',
      timeout: 10000
    });
    // Append a new real turn so file size grows beyond cached statusline snap
    writeFileSync(
      freshLogPath,
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: new Date(freshNow).toISOString(), content: 'Progressed CLI' }),
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: new Date(freshNow + 500).toISOString(), model: 'Gemini 4 Neon', input_tokens: 300, output_tokens: 30 })
      ].join('\n') + '\n',
      'utf-8'
    );
    execFileSync(process.execPath, [cliEntry, 'statusline', '--format', 'plain'], {
      input: JSON.stringify({ session_id: freshProgId, conversation_id: freshProgId }),
      env: slEnv,
      encoding: 'utf-8',
      timeout: 10000
    });
    assert(
      readActiveSessionHint().cliActiveConvId === freshProgId,
      `真实步进后 statusline 未写入 cliActiveConvId：${readActiveSessionHint().cliActiveConvId}`
    );

    // 8.3: Frontend VM tests for project grouping, uncategorized bottom, filter pills not breaking auto-follow, search expand, collapse persistence & pinnedConvId sync
    const runFrontendPickerScenario = async ({
      hostConvId = '',
      initialSettingsPinned = '',
      initialContextPinned = '',
      initialContextConv = ''
    }) => {
      const els = new Map();
      const makeEl = (id = '', initClasses = []) => {
        const classes = new Set(initClasses);
        const attrs = new Map();
        const listeners = new Map();
        return {
          id,
          value: '',
          textContent: '',
          innerHTML: '',
          scrollTop: 0,
          scrollLeft: 0,
          focused: false,
          dataset: {},
          style: {},
          className: initClasses.join(' '),
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
              fn({ target: ev.target || {}, stopPropagation: () => {}, preventDefault: () => {}, ...ev });
            }
          },
          focus: function () { this.focused = true; },
          getBoundingClientRect: () => ({ left: 120, right: 340, top: 40, bottom: 68 }),
          contains: () => false,
          setAttribute: (k, v) => attrs.set(k, String(v)),
          getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
          hasAttribute: (k) => attrs.has(k),
          removeAttribute: (k) => attrs.delete(k),
          querySelector: () => null,
          querySelectorAll: () => [],
          remove: () => {}
        };
      };
      const getEl = (id) => {
        if (!els.has(id)) els.set(id, makeEl(id));
        return els.get(id);
      };
      els.set('conv-popover', makeEl('conv-popover', ['conv-popover', 'hidden']));
      els.set('btn-follow-current', makeEl('btn-follow-current', ['ghost-btn', 'xs', 'hidden']));

      const localMap = new Map();
      const intervalCbs = [];
      const postedEntrypoints = [];
      const contextQueries = [];
      let backendPinned = initialContextPinned;
      let contextReturnUnchanged = false;
      const convHot = mkUuid(201);
      const convOld = mkUuid(202);
      const convUncat = mkUuid(203);
      const recentList = [
        {
          id: convUncat,
          shortId: convUncat.slice(0, 8),
          source: 'desktop',
          title: 'Uncat newest',
          projectName: null,
          repoLabel: null,
          isRunning: false,
          lastContextTokens: 1200,
          turnsCount: 2,
          effectiveActiveMs: nowMs - 5_000,
          updatedAtMs: nowMs - 5_000
        },
        {
          id: convHot,
          shortId: convHot.slice(0, 8),
          source: 'cli',
          title: 'Hot CLI task',
          projectName: 'proj-hot',
          repoLabel: 'proj-hot@main',
          isRunning: true,
          lastContextTokens: 8400,
          turnsCount: 6,
          effectiveActiveMs: nowMs - 10_000,
          updatedAtMs: nowMs - 10_000
        },
        {
          id: convOld,
          shortId: convOld.slice(0, 8),
          source: 'desktop',
          title: 'Old Alpha task',
          projectName: 'proj-old',
          repoLabel: 'proj-old@dev',
          isRunning: false,
          lastContextTokens: 3200,
          turnsCount: 3,
          effectiveActiveMs: nowMs - 3_600_000,
          updatedAtMs: nowMs - 3_600_000
        }
      ];
      const mkVmSnap = (cid) => {
        const it = recentList.find((x) => x.id === cid) || recentList[1];
        return {
          ok: true,
          etag: `etag-${it.id}`,
          conversationId: it.id,
          conversationTitle: it.title,
          conversationSource: it.source,
          pinnedConvId: backendPinned || null,
          repoInfo: it.projectName ? { name: it.projectName, label: it.repoLabel } : null,
          recentConversations: recentList,
          window: { used: 1000, budget: 10000, remaining: 9000, pct: 10, serverBudget: 10000, serverPct: 10 },
          context: { usedTokens: 1000, budgetTokens: 10000, inputTokens: 400, cacheTokens: 600, outputTokens: 100, error: { kind: 'none' }, breakdown: { groups: [] } },
          speed: null,
          audit: { groups: {} },
          quotas: [],
          quotaStatus: { state: 'unavailable' },
          turns: []
        };
      };

      const rootAttrs = new Map();
      const rootStyles = new Map();
      const sandbox = {
        console, Date, Math, JSON, URL, URLSearchParams, Set, Map, Array, Object, String, Number, Boolean, Promise, Error,
        NodeFilter: { SHOW_TEXT: 4 },
        MutationObserver: class { observe() {} disconnect() {} },
        ResizeObserver: class { observe() {} disconnect() {} },
        IntersectionObserver: class { observe() {} disconnect() {} },
        getComputedStyle: () => ({ color: 'rgb(255, 255, 255)', getPropertyValue: () => '' }),
        setTimeout, clearTimeout, clearInterval,
        setInterval: (fn, ms) => { intervalCbs.push({ fn, ms }); return intervalCbs.length; },
        requestAnimationFrame: (fn) => { fn(); return 1; },
        localStorage: {
          getItem: (k) => (localMap.has(k) ? localMap.get(k) : null),
          setItem: (k, v) => localMap.set(k, String(v))
        },
        sessionStorage: { getItem: () => null, setItem: () => {} },
        navigator: { platform: 'MacIntel', userAgent: 'Mozilla/5.0' },
        document: {
          readyState: 'complete',
          hidden: false,
          visibilityState: 'visible',
          documentElement: {
            clientWidth: 380,
            clientHeight: 720,
            dataset: {},
            appendChild: () => {},
            style: {
              getPropertyValue: (k) => rootStyles.get(k) || '',
              setProperty: (k, v) => rootStyles.set(k, String(v)),
              removeProperty: (k) => rootStyles.delete(k)
            },
            getAttribute: (k) => (rootAttrs.has(k) ? rootAttrs.get(k) : null),
            setAttribute: (k, v) => rootAttrs.set(k, String(v)),
            hasAttribute: (k) => rootAttrs.has(k),
            removeAttribute: (k) => rootAttrs.delete(k)
          },
          body: makeEl('body'),
          getElementById: getEl,
          querySelector: () => null,
          querySelectorAll: () => [],
          createTreeWalker: () => ({ nextNode: () => false, currentNode: null }),
          addEventListener: () => {},
          createElement: () => makeEl('')
        },
        window: null,
        fetch: async (urlStr, opts = {}) => {
          const u = new URL(urlStr, 'http://127.0.0.1');
          if (u.pathname === '/api/settings') {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                ok: true,
                uiPreferences: {},
                entrypoints: { pinnedConvId: initialSettingsPinned },
                presets: []
              })
            };
          }
          if (u.pathname === '/api/history') {
            return { ok: true, status: 200, json: async () => ({ ok: true, etag: 'h1', presets: [], daily: [], totals: {} }) };
          }
          if (u.pathname === '/api/entrypoints' && String(opts.method || 'GET').toUpperCase() === 'POST') {
            const parsed = JSON.parse(opts.body || '{}');
            postedEntrypoints.push(parsed);
            if (typeof parsed.pinnedConvId === 'string') backendPinned = parsed.pinnedConvId;
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
          }
          if (u.pathname === '/api/context') {
            const qCid = u.searchParams.get('conversationId') || '';
            const qEtag = u.searchParams.get('etag') || '';
            contextQueries.push({ conversationId: qCid, etag: qEtag, force: u.searchParams.get('force') === '1' });
            const resolvedCid = qCid || initialContextConv || convHot;
            if (contextReturnUnchanged) {
              return {
                ok: true,
                status: 200,
                json: async () => ({
                  ok: true,
                  unchanged: true,
                  etag: qEtag || `etag-${resolvedCid}`,
                  conversationId: resolvedCid,
                  pinnedConvId: backendPinned || null,
                  recentConversations: recentList
                })
              };
            }
            return { ok: true, status: 200, json: async () => mkVmSnap(resolvedCid) };
          }
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
      };
      sandbox.window = {
        innerWidth: 380,
        location: { origin: 'http://127.0.0.1', href: 'http://127.0.0.1/' },
        matchMedia: () => ({ matches: false, addEventListener: () => {} }),
        getComputedStyle: sandbox.getComputedStyle,
        addEventListener: () => {},
        sidecar: { conversationId: hostConvId },
        self: null,
        top: null,
        fetch: sandbox.fetch
      };
      sandbox.location = sandbox.window.location;
      sandbox.window.self = sandbox.window;
      sandbox.window.top = sandbox.window;
      sandbox.window.localStorage = sandbox.localStorage;
      sandbox.globalThis = sandbox;

      runInNewContext(cvAppSource, sandbox, { filename: 'dashboard-app-picker.js' });
      await new Promise((r) => setTimeout(r, 50));

      return {
        getEl,
        localMap,
        intervalCbs,
        postedEntrypoints,
        contextQueries,
        convHot,
        convOld,
        convUncat,
        setBackendPinned: (v) => { backendPinned = v; },
        setContextReturnUnchanged: (v) => { contextReturnUnchanged = v; }
      };
    };

    // Scenario A: Grouping order, uncategorized bottom, filter pills keep auto-follow, search auto-expands, collapse persists, polling keeps search input
    const scA = await runFrontendPickerScenario({ hostConvId: '', initialContextConv: mkUuid(201) });
    const triggerBtn = scA.getEl('conv-picker-trigger');
    const popBody = scA.getEl('conv-pop-body');
    const pillsEl = scA.getEl('conv-project-pills');
    const searchInput = scA.getEl('conv-search-input');
    const convSelect = scA.getEl('conv-select');

    triggerBtn.dispatch('click', { target: triggerBtn });
    assert(!scA.getEl('conv-popover').classList.contains('hidden'), '点击触发按钮应打开分组 Popover');
    const bodyHtmlInit = popBody.innerHTML;
    const idxHot = bodyHtmlInit.indexOf('data-proj-toggle="proj-hot"');
    const idxOld = bodyHtmlInit.indexOf('data-proj-toggle="proj-old"');
    const idxUncat = bodyHtmlInit.indexOf('data-proj-toggle="未归类工作区"');
    assert(
      idxHot > 0 && idxOld > idxHot && idxUncat > idxOld,
      `项目分组排序异常（具名项目按活跃降序且未归类置底）：hot=${idxHot}, old=${idxOld}, uncat=${idxUncat}`
    );
    assert(
      bodyHtmlInit.includes('conv-cli-badge') && bodyHtmlInit.includes('运行中'),
      '分组 Popover 缺少 CLI 徽章或运行中绿点'
    );
    // proj-old should be collapsed by default (not active & not first)
    assert(
      /data-proj-toggle="proj-old"\s+aria-expanded="false"/.test(bodyHtmlInit) &&
        /data-proj-toggle="proj-hot"\s+aria-expanded="true"/.test(bodyHtmlInit),
      `默认折叠策略异常（仅当前/首个展开）：${bodyHtmlInit}`
    );

    // Filter pill click must NOT change selectedConvId or post /api/entrypoints
    const postsBeforeFilter = scA.postedEntrypoints.length;
    pillsEl.dispatch('click', {
      target: { closest: (sel) => (sel === '[data-proj-filter]' ? { dataset: { projFilter: 'proj:proj-old' } } : null) }
    });
    assert(
      convSelect.value === '' &&
        scA.postedEntrypoints.length === postsBeforeFilter &&
        scA.getEl('btn-follow-current').classList.contains('hidden') &&
        popBody.innerHTML.includes(`data-conv-id="${scA.convOld}"`) &&
        !popBody.innerHTML.includes(`data-conv-id="${scA.convHot}"`) &&
        !popBody.innerHTML.includes('data-proj-toggle="proj-hot"'),
      `切换项目筛选胶囊不应改变选中会话或打断自动跟随：val=${convSelect.value}, posts=${scA.postedEntrypoints.length}`
    );

    // Reset filter to __all__, then search "Old Alpha" -> auto-expands proj-old & poll preserves search input
    pillsEl.dispatch('click', {
      target: { closest: (sel) => (sel === '[data-proj-filter]' ? { dataset: { projFilter: '__all__' } } : null) }
    });
    searchInput.value = 'Old Alpha';
    searchInput.dispatch('input', { target: searchInput });
    assert(
      /data-proj-toggle="proj-old"\s+aria-expanded="true"/.test(popBody.innerHTML) &&
        popBody.innerHTML.includes(`data-conv-id="${scA.convOld}"`) &&
        !popBody.innerHTML.includes(`data-conv-id="${scA.convHot}"`),
      '搜索应自动展开命中分组并过滤未命中项'
    );
    const pollCb = scA.intervalCbs.find((c) => c.ms === 1500);
    assert(Boolean(pollCb), '应注册 1500ms 轮询');
    pollCb.fn();
    await new Promise((r) => setTimeout(r, 20));
    assert(
      scA.getEl('conv-search-input') === searchInput && searchInput.value === 'Old Alpha',
      '1.5s 轮询不应销毁或清空搜索输入框'
    );

    // Clear search & manually collapse proj-hot -> persists to localStorage['cv_project_collapse_v1']
    searchInput.value = '';
    searchInput.dispatch('input', { target: searchInput });
    popBody.dispatch('click', {
      target: {
        closest: (sel) => (sel === '[data-proj-toggle]'
          ? { dataset: { projToggle: 'proj-hot' }, getAttribute: () => 'true' }
          : null)
      }
    });
    const savedCollapse = JSON.parse(scA.localMap.get('cv_project_collapse_v1') || '{}');
    assert(
      savedCollapse['proj-hot'] === true &&
        /data-proj-toggle="proj-hot"\s+aria-expanded="false"/.test(popBody.innerHTML),
      `手动折叠偏好未持久化至 cv_project_collapse_v1：${scA.localMap.get('cv_project_collapse_v1')}`
    );

    // Scenario B: Boot with persisted pinnedConvId, then backend clears expired pinnedConvId on unchanged:true poll
    const scB = await runFrontendPickerScenario({
      hostConvId: '',
      initialSettingsPinned: mkUuid(202),
      initialContextPinned: mkUuid(202),
      initialContextConv: mkUuid(202)
    });
    assert(
      scB.getEl('conv-select').value === scB.convOld &&
        !scB.getEl('btn-follow-current').classList.contains('hidden') &&
        scB.getEl('conv-trigger-label').textContent.includes('[proj-old]') &&
        scB.contextQueries.some((q) => q.conversationId === scB.convOld),
      `boot 恢复 pinnedConvId 失败：sel=${scB.getEl('conv-select').value}, label=${scB.getEl('conv-trigger-label').textContent}`
    );
    // Simulate expired pinnedConvId cleared by backend while returning unchanged:true
    scB.setBackendPinned('');
    scB.setContextReturnUnchanged(true);
    const queriesBeforeExpire = scB.contextQueries.length;
    scB.intervalCbs.find((c) => c.ms === 1500).fn();
    await new Promise((r) => setTimeout(r, 40));
    const queriesAfterExpire = scB.contextQueries.slice(queriesBeforeExpire);
    assert(
      scB.getEl('conv-select').value === '' &&
        scB.getEl('btn-follow-current').classList.contains('hidden') &&
        queriesAfterExpire.some((q) => q.conversationId === '' && q.force === true),
      `后端清理失效 pinnedConvId 后前端未切回自动跟随并强制重拉：sel=${scB.getEl('conv-select').value}, queries=${JSON.stringify(queriesAfterExpire)}`
    );

    // Scenario C: Desktop Aux Pane with hostConvId must NOT be hijacked by persisted pinnedConvId
    const scC = await runFrontendPickerScenario({
      hostConvId: mkUuid(201),
      initialSettingsPinned: mkUuid(202),
      initialContextPinned: mkUuid(202),
      initialContextConv: mkUuid(201)
    });
    assert(
      scC.getEl('conv-select').value === '' &&
        scC.getEl('btn-follow-current').classList.contains('hidden') &&
        scC.contextQueries.every((q) => q.conversationId === scC.convHot),
      `Desktop Aux Pane 不得被后台 pinnedConvId 劫持：sel=${scC.getEl('conv-select').value}, queries=${JSON.stringify(scC.contextQueries)}`
    );
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}
