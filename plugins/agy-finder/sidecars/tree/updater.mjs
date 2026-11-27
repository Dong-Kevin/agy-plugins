/**
 * Zero-dependency Release Checker & Atomic Self-Updater for AGY Finder.
 *
 * Security & Compliance Invariants:
 * 1. Pure Node.js >= 18 standard library only (zero external packages).
 * 2. Checks official GitHub Releases (never arbitrary branches) and requires
 *    matching `.sha256` checksum verification before extracting any archive.
 * 3. Enforces strict HTTPS host allowlist across all redirect hops, CRC-32 +
 *    Zip-Slip / symlink / zip-bomb protection during pure-Node ZIP extraction.
 * 4. Stages in `os.tmpdir()` (NEVER inside `PLUGINS_ROOT`) and atomically
 *    replaces `sidecars/tree/sidecar.json` LAST so Antigravity reloads cleanly.
 * 5. Never overwrites a git working-tree checkout unless explicitly overridden
 *    via `AGY_FINDER_UPDATE_TARGET_DIR` (for isolated tests).
 */

import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..', '..');

const DEFAULT_REPO_SLUG = 'Dong-Kevin/agy-plugins';
const CHECK_CACHE_TTL_MS = 6 * 60 * 60 * 1000;      // 6 hours for successful checks
const ERROR_CACHE_TTL_MS = 15 * 60 * 1000;          // 15 minutes cooldown for background errors
const API_TIMEOUT_MS = 8000;
const DOWNLOAD_TIMEOUT_MS = 45000;
const MAX_API_BYTES = 1024 * 1024;                  // 1 MB
const MAX_ZIP_BYTES = 20 * 1024 * 1024;             // 20 MB
const MAX_SHA_BYTES = 4096;                         // 4 KB
const MAX_UNZIPPED_TOTAL_BYTES = 50 * 1024 * 1024;  // 50 MB
const MAX_ZIP_ENTRIES = 500;
const MAX_REDIRECTS = 5;

const ASSET_ZIP_RE = /^agy-finder-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.zip$/i;

const DEFAULT_ALLOWED_HTTPS_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'codeload.github.com',
  'raw.githubusercontent.com'
]);

const EXECUTABLE_REL_PATHS = new Set([
  'install.sh',
  'sidecars/tree/cli.mjs'
]);

const CRC_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    tbl[n] = c >>> 0;
  }
  return tbl;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function parseSemver(raw) {
  const s = String(raw || '').trim().replace(/^v/i, '');
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  const prerelease = m[4] ? m[4].split('.') : [];
  return { major, minor, patch, prerelease, normalized: `${major}.${minor}.${patch}${m[4] ? `-${m[4]}` : ''}` };
}

export function compareSemver(aRaw, bRaw) {
  const a = parseSemver(aRaw);
  const b = parseSemver(bRaw);
  if (!a || !b) return null;
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  const aPre = a.prerelease;
  const bPre = b.prerelease;
  if (aPre.length === 0 && bPre.length === 0) return 0;
  if (aPre.length === 0) return 1;
  if (bPre.length === 0) return -1;
  const len = Math.max(aPre.length, bPre.length);
  for (let i = 0; i < len; i++) {
    if (i >= aPre.length) return -1;
    if (i >= bPre.length) return 1;
    const x = aPre[i];
    const y = bPre[i];
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) return Number(x) > Number(y) ? 1 : -1;
    if (xNum) return -1;
    if (yNum) return 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function getFinderStateDir() {
  if (process.env.AGY_FINDER_DATA_DIR) {
    return resolve(process.env.AGY_FINDER_DATA_DIR);
  }
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    return resolve(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR);
  }
  return join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'agy-finder', 'tree', 'data');
}

function getTargetPluginRoot() {
  const override = String(process.env.AGY_FINDER_UPDATE_TARGET_DIR || '').trim();
  return override ? resolve(override) : PLUGIN_ROOT;
}

function isInsideGitRepo(dir) {
  if (String(process.env.AGY_FINDER_UPDATE_TARGET_DIR || '').trim()) {
    return false;
  }
  let cur = resolve(dir);
  for (let depth = 0; depth < 4; depth++) {
    if (existsSync(join(cur, '.git'))) return true;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return false;
}

export function readInstalledPluginInfo(targetDir = getTargetPluginRoot()) {
  const manifestPath = join(targetDir, 'plugin.json');
  let version = '0.0.0';
  let repoSlug = DEFAULT_REPO_SLUG;
  let name = 'agy-finder';
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    if (typeof raw.version === 'string' && raw.version.trim()) {
      version = raw.version.trim().replace(/^v/i, '');
    }
    if (typeof raw.name === 'string' && raw.name.trim()) {
      name = raw.name.trim();
    }
    if (typeof raw.repository === 'string' && raw.repository.trim()) {
      const m = /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:\/|$)/i.exec(raw.repository.trim());
      if (m) repoSlug = m[1];
    }
  } catch {}
  return {
    name,
    version,
    repoSlug,
    targetDir,
    isDevRepo: isInsideGitRepo(targetDir)
  };
}

function getUpdateCachePath() {
  return join(getFinderStateDir(), 'update_check_v1.json');
}

function readUpdateCache() {
  try {
    const p = getUpdateCachePath();
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeUpdateCache(payload) {
  try {
    const dir = getFinderStateDir();
    mkdirSync(dir, { recursive: true });
    const target = getUpdateCachePath();
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
    renameSync(tmp, target);
  } catch {}
}

function getExtraAllowedHosts() {
  const raw = String(process.env.AGY_FINDER_UPDATE_ALLOWED_HOSTS || '').trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function assertAllowedUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('更新地址格式无效');
  }
  const host = u.hostname.toLowerCase();
  const extraHosts = getExtraAllowedHosts();
  if (u.protocol === 'https:' && DEFAULT_ALLOWED_HTTPS_HOSTS.has(host)) {
    return u;
  }
  if ((u.protocol === 'https:' || u.protocol === 'http:') && extraHosts.has(host)) {
    return u;
  }
  throw new Error(`拒绝访问不受信任的更新域名：${u.protocol}//${host}`);
}

function fetchBufferSafe(rawUrl, { timeoutMs = API_TIMEOUT_MS, maxBytes = MAX_API_BYTES, headers = {} } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const deadlineAt = Date.now() + timeoutMs;
    let settled = false;
    let activeReq = null;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      try { activeReq?.destroy(); } catch {}
      rejectPromise(err instanceof Error ? err : new Error(String(err)));
    };
    const succeed = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      resolvePromise(result);
    };

    const hardTimer = setTimeout(() => {
      fail(new Error('请求 GitHub 更新服务超时'));
    }, timeoutMs);
    hardTimer.unref?.();

    const doRequest = (targetUrl, redirectCount) => {
      let u;
      try {
        u = assertAllowedUrl(targetUrl);
      } catch (err) {
        fail(err);
        return;
      }

      const client = u.protocol === 'http:' ? http : https;
      const remainingMs = Math.max(500, deadlineAt - Date.now());
      const req = client.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (u.protocol === 'http:' ? 80 : 443),
          path: `${u.pathname}${u.search}`,
          method: 'GET',
          headers: {
            'User-Agent': 'agy-finder-updater',
            ...headers
          },
          agent: false,
          timeout: remainingMs
        },
        (res) => {
          const status = Number(res.statusCode || 0);
          if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
            res.resume();
            if (redirectCount >= MAX_REDIRECTS) {
              fail(new Error('更新请求重定向次数过多'));
              return;
            }
            let nextUrl;
            try {
              nextUrl = new URL(res.headers.location, u).href;
            } catch {
              fail(new Error('更新重定向地址无效'));
              return;
            }
            doRequest(nextUrl, redirectCount + 1);
            return;
          }

          const chunks = [];
          let total = 0;
          res.on('data', (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
              res.destroy();
              fail(new Error('更新响应体积超出安全上限'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('error', (err) => fail(err));
          res.on('end', () => {
            succeed({
              status,
              headers: res.headers || {},
              buffer: Buffer.concat(chunks)
            });
          });
        }
      );

      activeReq = req;
      req.on('timeout', () => {
        req.destroy();
        fail(new Error('请求 GitHub 更新服务超时'));
      });
      req.on('error', (err) => fail(err));
      req.end();
    };

    doRequest(rawUrl, 0);
  });
}

function sanitizeReleaseNotes(raw) {
  const text = String(raw || '')
    .replace(/\r\n/g, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .trim();
  if (!text) return '';
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 8);
  const joined = lines.join('\n');
  return joined.length > 480 ? `${joined.slice(0, 477)}…` : joined;
}

function extractFinderRelease(release) {
  if (!release || typeof release !== 'object') return null;
  if (release.draft || release.prerelease) return null;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  let zipAsset = null;
  let version = '';
  for (const asset of assets) {
    const name = String(asset?.name || '').trim();
    const m = ASSET_ZIP_RE.exec(name);
    if (m && asset?.browser_download_url) {
      zipAsset = asset;
      version = m[1];
      break;
    }
  }
  if (!zipAsset || !version) return null;

  const expectedShaName = `${zipAsset.name}.sha256`.toLowerCase();
  const shaAsset = assets.find((a) => String(a?.name || '').trim().toLowerCase() === expectedShaName) || null;

  return {
    latestVersion: version,
    releaseTag: String(release.tag_name || '').trim(),
    releaseName: String(release.name || release.tag_name || `v${version}`).trim(),
    releaseUrl: String(release.html_url || '').trim(),
    publishedAt: String(release.published_at || '').trim(),
    releaseNotes: sanitizeReleaseNotes(release.body || ''),
    assetName: String(zipAsset.name || '').trim(),
    assetSize: Number(zipAsset.size || 0),
    downloadUrl: String(zipAsset.browser_download_url || '').trim(),
    sha256Url: String(shaAsset?.browser_download_url || '').trim(),
    hasSha256: Boolean(shaAsset?.browser_download_url)
  };
}

function parseSha256Digest(rawText) {
  const m = /\b([0-9a-fA-F]{64})\b/.exec(String(rawText || ''));
  return m ? m[1].toLowerCase() : '';
}

function findEocdOffset(buf) {
  const minOffset = Math.max(0, buf.length - 65557);
  for (let pos = buf.length - 22; pos >= minOffset; pos--) {
    if (buf.readUInt32LE(pos) === 0x06054b50) {
      const commentLen = buf.readUInt16LE(pos + 20);
      if (pos + 22 + commentLen === buf.length) {
        return pos;
      }
    }
  }
  return -1;
}

function sanitizeZipEntryPath(rawPath) {
  const norm = String(rawPath || '').replace(/\\/g, '/');
  if (!norm || norm.includes('\0')) {
    throw new Error('压缩包内包含非法路径字符');
  }
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) {
    throw new Error(`压缩包包含绝对路径：${norm}`);
  }
  const clean = posix.normalize(norm).replace(/^\.\//, '');
  if (!clean || clean === '.' || clean === '..' || clean.startsWith('../') || clean.split('/').includes('..')) {
    throw new Error(`压缩包包含越界路径：${norm}`);
  }
  return clean;
}

/**
 * Pure-Node.js zero-dependency ZIP extractor with CRC-32, symlink, Zip-Slip & zip-bomb protection.
 */
export function extractZipBuffer(zipBuf) {
  if (!Buffer.isBuffer(zipBuf) || zipBuf.length < 22) {
    throw new Error('下载的更新包格式损坏（非有效 ZIP 文件）');
  }
  const eocdPos = findEocdOffset(zipBuf);
  if (eocdPos < 0) {
    throw new Error('更新包缺少 ZIP 目录尾（EOCD）');
  }
  const totalEntries = zipBuf.readUInt16LE(eocdPos + 10);
  const centralSize = zipBuf.readUInt32LE(eocdPos + 12);
  const centralOffset = zipBuf.readUInt32LE(eocdPos + 16);

  if (totalEntries === 0 || totalEntries > MAX_ZIP_ENTRIES) {
    throw new Error(`更新包条目数量异常（${totalEntries}）`);
  }
  if (centralOffset + centralSize > eocdPos) {
    throw new Error('更新包中央目录边界越界');
  }

  const files = new Map();
  let cursor = centralOffset;
  let totalUnzipped = 0;

  for (let i = 0; i < totalEntries; i++) {
    if (cursor + 46 > centralOffset + centralSize) {
      throw new Error('更新包中央目录提前截断');
    }
    const sig = zipBuf.readUInt32LE(cursor);
    if (sig !== 0x02014b50) {
      throw new Error('更新包中央目录签名损坏');
    }
    const method = zipBuf.readUInt16LE(cursor + 10);
    const expectedCrc = zipBuf.readUInt32LE(cursor + 16);
    const compSize = zipBuf.readUInt32LE(cursor + 20);
    const uncompSize = zipBuf.readUInt32LE(cursor + 24);
    const nameLen = zipBuf.readUInt16LE(cursor + 28);
    const extraLen = zipBuf.readUInt16LE(cursor + 30);
    const commentLen = zipBuf.readUInt16LE(cursor + 32);
    const extAttr = zipBuf.readUInt32LE(cursor + 38);
    const lfhOffset = zipBuf.readUInt32LE(cursor + 42);

    const nameEnd = cursor + 46 + nameLen;
    if (nameEnd + extraLen + commentLen > centralOffset + centralSize) {
      throw new Error('更新包条目元数据越界');
    }
    const rawName = zipBuf.subarray(cursor + 46, nameEnd).toString('utf-8');
    cursor = nameEnd + extraLen + commentLen;

    const unixMode = (extAttr >>> 16) & 0xffff;
    if ((unixMode & 0o170000) === 0o120000) {
      throw new Error(`更新包包含不支持的符号链接：${rawName}`);
    }

    if (rawName.endsWith('/')) {
      continue;
    }

    const safePath = sanitizeZipEntryPath(rawName);
    if (lfhOffset + 30 > zipBuf.length || zipBuf.readUInt32LE(lfhOffset) !== 0x04034b50) {
      throw new Error(`更新包本地文件头损坏：${safePath}`);
    }
    const lfhNameLen = zipBuf.readUInt16LE(lfhOffset + 26);
    const lfhExtraLen = zipBuf.readUInt16LE(lfhOffset + 28);
    const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > zipBuf.length) {
      throw new Error(`更新包文件数据越界：${safePath}`);
    }

    totalUnzipped += uncompSize;
    if (totalUnzipped > MAX_UNZIPPED_TOTAL_BYTES) {
      throw new Error('更新包解压体积超出安全上限');
    }

    const compSlice = zipBuf.subarray(dataStart, dataEnd);
    let data;
    if (method === 0) {
      data = Buffer.from(compSlice);
    } else if (method === 8) {
      data = inflateRawSync(compSlice);
    } else {
      throw new Error(`更新包使用了不支持的压缩算法（${method}）：${safePath}`);
    }

    if (data.length !== uncompSize) {
      throw new Error(`更新包文件长度校验失败：${safePath}`);
    }
    const actualCrc = crc32(data);
    if (actualCrc !== expectedCrc) {
      throw new Error(`更新包 CRC-32 校验失败：${safePath}`);
    }

    files.set(safePath, {
      data,
      executable: Boolean(unixMode & 0o111)
    });
  }

  return files;
}

function resolveZipPluginRootPrefix(files) {
  if (files.has('agy-finder/plugin.json')) return 'agy-finder/';
  if (files.has('plugin.json')) return '';
  for (const p of files.keys()) {
    if (p.endsWith('/plugin.json')) {
      const idx = p.lastIndexOf('/plugin.json');
      const prefix = p.slice(0, idx + 1);
      if (files.has(`${prefix}sidecars/tree/sidecar.json`)) {
        return prefix;
      }
    }
  }
  return null;
}

function writeFileAtomic(targetPath, data, executable = false) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.upd.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, data);
  if (process.platform !== 'win32' && executable) {
    try { chmodSync(tmpPath, 0o755); } catch {}
  }
  renameSync(tmpPath, targetPath);
}

let inFlightCheck = null;
let inFlightUpdate = null;
let activeUpdateState = {
  updating: false,
  stage: 'idle',
  startedAt: 0
};

function buildApiUrls(repoSlug) {
  const customApi = String(process.env.AGY_FINDER_UPDATE_API_URL || '').trim();
  if (customApi) {
    return {
      latestUrl: customApi,
      listUrl: ''
    };
  }
  return {
    latestUrl: `https://api.github.com/repos/${repoSlug}/releases/latest`,
    listUrl: `https://api.github.com/repos/${repoSlug}/releases?per_page=10`
  };
}

export async function checkForUpdates({ force = false, _internal = false } = {}) {
  const installed = readInstalledPluginInfo();
  const now = Date.now();

  if (activeUpdateState.updating && !_internal) {
    const cached = readUpdateCache();
    return {
      ok: true,
      state: 'updating',
      stage: activeUpdateState.stage,
      updating: true,
      currentVersion: installed.version,
      latestVersion: cached?.latestVersion || installed.version,
      hasUpdate: Boolean(cached?.latestVersion && (compareSemver(cached.latestVersion, installed.version) || 0) > 0),
      releaseTag: cached?.releaseTag || '',
      releaseName: cached?.releaseName || '',
      releaseUrl: cached?.releaseUrl || '',
      publishedAt: cached?.publishedAt || '',
      releaseNotes: cached?.releaseNotes || '',
      assetName: cached?.assetName || '',
      hasSha256: Boolean(cached?.hasSha256),
      checkedAt: cached?.checkedAt || now,
      fromCache: true,
      isDevRepo: installed.isDevRepo
    };
  }

  if (!force) {
    const cached = readUpdateCache();
    if (cached && cached.repoSlug === installed.repoSlug && cached.checkedAt) {
      const age = now - Number(cached.checkedAt || 0);
      if (cached.ok && age >= 0 && age < CHECK_CACHE_TTL_MS && cached.latestVersion) {
        const cmp = compareSemver(cached.latestVersion, installed.version);
        const hasUpdate = cmp !== null && cmp > 0;
        return {
          ok: true,
          state: hasUpdate ? 'available' : 'up-to-date',
          updating: false,
          currentVersion: installed.version,
          latestVersion: cached.latestVersion,
          hasUpdate,
          releaseTag: cached.releaseTag || '',
          releaseName: cached.releaseName || '',
          releaseUrl: cached.releaseUrl || '',
          publishedAt: cached.publishedAt || '',
          releaseNotes: cached.releaseNotes || '',
          assetName: cached.assetName || '',
          hasSha256: Boolean(cached.hasSha256),
          checkedAt: cached.checkedAt,
          fromCache: true,
          isDevRepo: installed.isDevRepo
        };
      }
      if (!cached.ok && age >= 0 && age < ERROR_CACHE_TTL_MS) {
        return {
          ok: false,
          state: 'error',
          updating: false,
          currentVersion: installed.version,
          latestVersion: cached.latestVersion || installed.version,
          hasUpdate: false,
          checkedAt: cached.checkedAt,
          fromCache: true,
          isDevRepo: installed.isDevRepo,
          rateLimited: Boolean(cached.rateLimited),
          error: cached.error || '暂时无法连接 GitHub 检查更新'
        };
      }
    }
  }

  if (inFlightCheck) {
    return inFlightCheck;
  }

  inFlightCheck = (async () => {
    const { latestUrl, listUrl } = buildApiUrls(installed.repoSlug);
    const reqHeaders = {
      Accept: 'application/vnd.github+json',
      'User-Agent': `agy-finder/${installed.version}`
    };

    try {
      const res = await fetchBufferSafe(latestUrl, {
        timeoutMs: API_TIMEOUT_MS,
        maxBytes: MAX_API_BYTES,
        headers: reqHeaders
      });

      if (res.status === 403 || res.status === 429) {
        const errPayload = {
          ok: false,
          state: 'error',
          updating: false,
          repoSlug: installed.repoSlug,
          currentVersion: installed.version,
          latestVersion: installed.version,
          hasUpdate: false,
          checkedAt: Date.now(),
          fromCache: false,
          isDevRepo: installed.isDevRepo,
          rateLimited: true,
          error: 'GitHub API 请求频率受限，请稍后再试'
        };
        writeUpdateCache(errPayload);
        return errPayload;
      }

      if (res.status < 200 || res.status >= 300) {
        throw new Error(`GitHub Release 接口返回 HTTP ${res.status}`);
      }

      const parsedLatest = JSON.parse(res.buffer.toString('utf-8'));
      let matched = null;
      if (Array.isArray(parsedLatest)) {
        for (const rel of parsedLatest) {
          matched = extractFinderRelease(rel);
          if (matched) break;
        }
      } else {
        matched = extractFinderRelease(parsedLatest);
      }

      if (!matched && listUrl) {
        const listRes = await fetchBufferSafe(listUrl, {
          timeoutMs: API_TIMEOUT_MS,
          maxBytes: MAX_API_BYTES,
          headers: reqHeaders
        });
        if (listRes.status >= 200 && listRes.status < 300) {
          const releases = JSON.parse(listRes.buffer.toString('utf-8'));
          if (Array.isArray(releases)) {
            for (const rel of releases) {
              matched = extractFinderRelease(rel);
              if (matched) break;
            }
          }
        }
      }

      if (!matched) {
        throw new Error('最新 GitHub Release 中未找到 agy-finder 发布包');
      }

      const cmp = compareSemver(matched.latestVersion, installed.version);
      if (cmp === null) {
        throw new Error(`发布包版本号无效：${matched.latestVersion}`);
      }

      const hasUpdate = cmp > 0;
      const result = {
        ok: true,
        state: hasUpdate ? 'available' : 'up-to-date',
        updating: false,
        repoSlug: installed.repoSlug,
        currentVersion: installed.version,
        latestVersion: matched.latestVersion,
        hasUpdate,
        releaseTag: matched.releaseTag,
        releaseName: matched.releaseName,
        releaseUrl: matched.releaseUrl,
        publishedAt: matched.publishedAt,
        releaseNotes: matched.releaseNotes,
        assetName: matched.assetName,
        assetSize: matched.assetSize,
        downloadUrl: matched.downloadUrl,
        sha256Url: matched.sha256Url,
        hasSha256: matched.hasSha256,
        checkedAt: Date.now(),
        fromCache: false,
        isDevRepo: installed.isDevRepo
      };

      writeUpdateCache(result);
      const { downloadUrl: _d, sha256Url: _s, repoSlug: _r, ...publicResult } = result;
      return publicResult;
    } catch (err) {
      const errPayload = {
        ok: false,
        state: 'error',
        updating: false,
        repoSlug: installed.repoSlug,
        currentVersion: installed.version,
        latestVersion: installed.version,
        hasUpdate: false,
        checkedAt: Date.now(),
        fromCache: false,
        isDevRepo: installed.isDevRepo,
        rateLimited: false,
        error: err?.message || '检查更新失败，请检查网络连接'
      };
      writeUpdateCache(errPayload);
      const { repoSlug: _r, ...publicErr } = errPayload;
      return publicErr;
    } finally {
      inFlightCheck = null;
    }
  })();

  return inFlightCheck;
}

function syncPosixCliLinkIfManaged(targetDir) {
  if (process.platform === 'win32') return;
  if (String(process.env.AGY_FINDER_UPDATE_TARGET_DIR || '').trim()) return;
  try {
    const binDir = process.env.AGY_BIN_DIR || process.env.ANTIGRAVITY_BIN_DIR || join(homedir(), '.local', 'bin');
    const linkPath = join(binDir, 'agy-finder');
    const cliEntry = join(targetDir, 'sidecars', 'tree', 'cli.mjs');
    if (!existsSync(cliEntry)) return;
    if (existsSync(linkPath)) {
      const st = lstatSync(linkPath);
      if (!st.isSymbolicLink()) return;
      unlinkSync(linkPath);
      symlinkSync(cliEntry, linkPath);
    }
  } catch {}
}

export async function performSelfUpdate({ force = false } = {}) {
  if (inFlightUpdate) {
    return inFlightUpdate;
  }

  inFlightUpdate = (async () => {
    const installed = readInstalledPluginInfo();
    if (installed.isDevRepo) {
      return {
        ok: false,
        state: 'error',
        isDevRepo: true,
        currentVersion: installed.version,
        error: '当前运行在本地源码仓库中，请使用 git pull 与 ./install.sh 更新，避免覆盖开发改动。'
      };
    }

    let stageDir = '';
    activeUpdateState = { updating: true, stage: 'checking', startedAt: Date.now() };
    try {
      const fresh = await checkForUpdates({ force: true, _internal: true });
      const cached = readUpdateCache();
      if (!fresh.ok) {
        return {
          ok: false,
          state: 'error',
          currentVersion: installed.version,
          error: fresh.error || '检查最新版本失败'
        };
      }
      if (!fresh.hasUpdate && !force) {
        return {
          ok: true,
          updated: false,
          state: 'up-to-date',
          currentVersion: installed.version,
          latestVersion: fresh.latestVersion,
          message: `当前已是最新版本 v${installed.version}`
        };
      }
      if (!cached?.downloadUrl) {
        throw new Error('未找到可用的更新包下载地址');
      }
      if (!cached?.sha256Url) {
        throw new Error('发布包缺少 SHA-256 校验文件，已中止自动更新');
      }

      activeUpdateState.stage = 'downloading';
      const [shaRes, zipRes] = await Promise.all([
        fetchBufferSafe(cached.sha256Url, {
          timeoutMs: API_TIMEOUT_MS,
          maxBytes: MAX_SHA_BYTES,
          headers: { 'User-Agent': `agy-finder/${installed.version}` }
        }),
        fetchBufferSafe(cached.downloadUrl, {
          timeoutMs: DOWNLOAD_TIMEOUT_MS,
          maxBytes: MAX_ZIP_BYTES,
          headers: { 'User-Agent': `agy-finder/${installed.version}` }
        })
      ]);

      if (shaRes.status < 200 || shaRes.status >= 300) {
        throw new Error(`下载 SHA-256 校验文件失败（HTTP ${shaRes.status}）`);
      }
      if (zipRes.status < 200 || zipRes.status >= 300) {
        throw new Error(`下载更新包失败（HTTP ${zipRes.status}）`);
      }

      activeUpdateState.stage = 'verifying';
      const expectedHash = parseSha256Digest(shaRes.buffer.toString('utf-8'));
      if (!expectedHash) {
        throw new Error('SHA-256 校验文件格式无效');
      }
      const actualHash = createHash('sha256').update(zipRes.buffer).digest('hex').toLowerCase();
      if (actualHash !== expectedHash) {
        throw new Error('更新包 SHA-256 完整性校验不通过，已中止安装');
      }

      const entries = extractZipBuffer(zipRes.buffer);
      const prefix = resolveZipPluginRootPrefix(entries);
      if (prefix === null) {
        throw new Error('更新包结构异常：缺少 plugin.json 或 sidecar.json');
      }

      const manifestEntry = entries.get(`${prefix}plugin.json`);
      const sidecarEntry = entries.get(`${prefix}sidecars/tree/sidecar.json`);
      const mainEntry = entries.get(`${prefix}sidecars/tree/main.mjs`);
      if (!manifestEntry || !sidecarEntry || !mainEntry) {
        throw new Error('更新包缺少核心运行文件（plugin.json / sidecar.json / main.mjs）');
      }

      const nextManifest = JSON.parse(manifestEntry.data.toString('utf-8'));
      if (nextManifest?.name !== 'agy-finder') {
        throw new Error(`更新包插件名不匹配：${nextManifest?.name || 'unknown'}`);
      }
      const nextVersion = String(nextManifest?.version || '').trim().replace(/^v/i, '');
      if (!parseSemver(nextVersion)) {
        throw new Error(`更新包版本号无效：${nextVersion}`);
      }
      if (compareSemver(nextVersion, fresh.latestVersion) !== 0) {
        throw new Error(`更新包内版本号（v${nextVersion}）与发布声明（v${fresh.latestVersion}）不一致`);
      }

      activeUpdateState.stage = 'installing';
      stageDir = mkdtempSync(join(tmpdir(), 'agy-finder-upd-'));
      const stageFiles = [];
      for (const [zipRel, entry] of entries.entries()) {
        if (!zipRel.startsWith(prefix)) continue;
        const rel = zipRel.slice(prefix.length);
        if (!rel || rel.endsWith('/')) continue;
        const absStage = resolve(stageDir, rel);
        const relCheck = relative(stageDir, absStage);
        if (relCheck.startsWith('..') || isAbsolute(relCheck)) {
          throw new Error(`暂存路径越界：${rel}`);
        }
        mkdirSync(dirname(absStage), { recursive: true });
        writeFileSync(absStage, entry.data);
        const execFlag = entry.executable || EXECUTABLE_REL_PATHS.has(rel);
        if (process.platform !== 'win32' && execFlag) {
          try { chmodSync(absStage, 0o755); } catch {}
        }
        stageFiles.push({ rel, absStage, executable: execFlag });
      }

      const targetDir = installed.targetDir;
      mkdirSync(targetDir, { recursive: true });
      let deferredSidecar = null;
      let deferredMain = null;

      for (const item of stageFiles) {
        if (item.rel === 'sidecars/tree/sidecar.json') {
          deferredSidecar = item;
          continue;
        }
        if (item.rel === 'sidecars/tree/main.mjs') {
          deferredMain = item;
          continue;
        }
        const dest = resolve(targetDir, item.rel);
        const destCheck = relative(targetDir, dest);
        if (destCheck.startsWith('..') || isAbsolute(destCheck)) {
          throw new Error(`目标安装路径越界：${item.rel}`);
        }
        writeFileAtomic(dest, readFileSync(item.absStage), item.executable);
      }

      if (deferredMain) {
        writeFileAtomic(
          resolve(targetDir, deferredMain.rel),
          readFileSync(deferredMain.absStage),
          deferredMain.executable
        );
      }

      if (deferredSidecar) {
        writeFileAtomic(
          resolve(targetDir, deferredSidecar.rel),
          readFileSync(deferredSidecar.absStage),
          false
        );
      }

      syncPosixCliLinkIfManaged(targetDir);

      const updatedAt = Date.now();
      writeUpdateCache({
        ok: true,
        state: 'up-to-date',
        updating: false,
        repoSlug: installed.repoSlug,
        currentVersion: nextVersion,
        latestVersion: nextVersion,
        hasUpdate: false,
        releaseTag: fresh.releaseTag || '',
        releaseName: fresh.releaseName || '',
        releaseUrl: fresh.releaseUrl || '',
        publishedAt: fresh.publishedAt || '',
        releaseNotes: fresh.releaseNotes || '',
        assetName: fresh.assetName || '',
        hasSha256: true,
        checkedAt: updatedAt,
        updatedAt,
        isDevRepo: false
      });

      return {
        ok: true,
        updated: true,
        state: 'updated',
        previousVersion: installed.version,
        currentVersion: nextVersion,
        latestVersion: nextVersion,
        hasUpdate: false,
        releaseTag: fresh.releaseTag || '',
        releaseUrl: fresh.releaseUrl || '',
        sha256: actualHash,
        filesUpdated: stageFiles.length,
        requiresReload: true,
        updatedAt,
        message: `已安全更新至 v${nextVersion}（SHA-256 校验通过）`
      };
    } catch (err) {
      return {
        ok: false,
        updated: false,
        state: 'error',
        currentVersion: installed.version,
        error: err?.message || '自动更新失败，请稍后重试'
      };
    } finally {
      activeUpdateState = { updating: false, stage: 'idle', startedAt: 0 };
      if (stageDir && existsSync(stageDir)) {
        try { rmSync(stageDir, { recursive: true, force: true }); } catch {}
      }
      inFlightUpdate = null;
    }
  })();

  return inFlightUpdate;
}
