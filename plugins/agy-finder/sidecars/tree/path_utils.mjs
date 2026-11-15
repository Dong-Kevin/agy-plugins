/**
 * Cross-platform path normalization, workspace boundary enforcement,
 * directory tree listing, and bounded BFS search utilities.
 */

import { execFile, execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_IGNORED_NAMES = new Set([
  '.git',
  'node_modules',
  '.DS_Store',
  'Thumbs.db',
  '__pycache__',
  '.pytest_cache',
  '.venv'
]);

const ALWAYS_SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db']);

export const BROWSER_HTML_EXTS = new Set(['.html', '.htm', '.xhtml']);

/**
 * Check whether a raw path or file URI points to an HTML document.
 * @param {string} rawPath
 * @returns {boolean}
 */
export function isBrowserHtmlPath(rawPath) {
  const { cleanedPath } = normalizeRawPathInput(String(rawPath || ''));
  if (!cleanedPath) return false;
  return BROWSER_HTML_EXTS.has(extname(cleanedPath).toLowerCase());
}

/**
 * Convert a local path or file:// URI into a clean local filesystem path.
 * @param {string} uriOrPath
 * @returns {string}
 */
export function toLocalPath(uriOrPath) {
  if (!uriOrPath || typeof uriOrPath !== 'string') return '';
  const str = uriOrPath.trim();
  if (!str) return '';
  if (/^file:\/\//i.test(str)) {
    try {
      return fileURLToPath(str);
    } catch {
      return decodeURIComponent(str.replace(/^file:\/\/\/?/i, '/').split(/[?#]/)[0]);
    }
  }
  return str;
}

/**
 * Convert an absolute path into a valid file:// URI cross-platform.
 * @param {string} absPath
 * @returns {string}
 */
export function toFileUri(absPath) {
  try {
    return pathToFileURL(absPath).href;
  } catch {
    const posix = String(absPath).replace(/\\/g, '/');
    return posix.startsWith('/') ? `file://${posix}` : `file:///${posix}`;
  }
}

/**
 * Normalize relative paths to uniform POSIX slashes for frontend tree keys.
 * @param {string} relPath
 * @returns {string}
 */
export function toPosixRel(relPath) {
  return String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * Normalize raw path input from URL params, markdown links, clipboard, or search box.
 * Preserves Windows drive prefixes (C:\...) while stripping :line(:col) and #Lline suffixes.
 * @param {string} raw
 * @returns {{ cleanedPath: string, line: number | null }}
 */
export function normalizeRawPathInput(raw) {
  if (!raw || typeof raw !== 'string') return { cleanedPath: '', line: null };
  let s = raw.trim();
  if (!s) return { cleanedPath: '', line: null };

  // Strip surrounding quotes / backticks / angle brackets / leading @ mention
  s = s.replace(/^[`"'<]+|[`"'>]+$/g, '').trim();
  if (s.startsWith('@') && !s.startsWith('@/')) {
    s = s.slice(1).trim();
  }
  if (!s) return { cleanedPath: '', line: null };

  let line = null;

  // Handle file:// URI
  if (/^file:\/\//i.test(s)) {
    const hashMatch = s.match(/#L(\d+)(?:-L?\d+)?$/i);
    if (hashMatch) line = Number(hashMatch[1]);
    try {
      const u = new URL(s);
      u.search = '';
      u.hash = '';
      s = fileURLToPath(u.href);
    } catch {
      s = decodeURIComponent(s.replace(/^file:\/\//i, '').split(/[?#]/)[0]);
      if (/^\/[A-Za-z]:[\\/]/.test(s)) s = s.slice(1);
    }
  } else {
    // Strip #L42 or #L42-L50
    const hashMatch = s.match(/#L(\d+)(?:-L?\d+)?$/i);
    if (hashMatch) {
      line = Number(hashMatch[1]);
      s = s.slice(0, hashMatch.index);
    }
    // Strip trailing :42 or :42:10 without touching Windows drive letter C:\
    const hasWinDrive = /^[A-Za-z]:[\\/]/.test(s);
    const colonMatch = s.match(/:(\d+)(?::\d+)?$/);
    if (colonMatch && (!hasWinDrive || colonMatch.index > 2)) {
      line = Number(colonMatch[1]);
      s = s.slice(0, colonMatch.index);
    }
  }

  // Expand ~ or ~/... or ~\...
  if (s === '~') {
    s = homedir();
  } else if (s.startsWith('~/') || s.startsWith('~\\')) {
    s = join(homedir(), s.slice(2));
  }

  return { cleanedPath: s.trim(), line: Number.isFinite(line) && line > 0 ? line : null };
}

/**
 * Check whether targetAbs is equal to or nested under rootAbs.
 * @param {string} rootAbs
 * @param {string} targetAbs
 * @returns {boolean}
 */
export function isSubpath(rootAbs, targetAbs) {
  const r = resolve(rootAbs);
  const t = resolve(targetAbs);
  const normR = process.platform === 'win32' ? r.toLowerCase() : r;
  const normT = process.platform === 'win32' ? t.toLowerCase() : t;
  const rel = relative(normR, normT);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Find an enclosing project root (e.g. nearest .git up to 5 levels) for external paths.
 * @param {string} absFileOrDir
 * @returns {string}
 */
export function findEnclosingProjectRoot(absFileOrDir) {
  let startDir = absFileOrDir;
  try {
    if (!statSync(absFileOrDir).isDirectory()) {
      startDir = dirname(absFileOrDir);
    }
  } catch {
    startDir = dirname(absFileOrDir);
  }

  const home = resolve(homedir());
  let cur = resolve(startDir);
  for (let depth = 0; depth < 5; depth++) {
    if (existsSync(join(cur, '.git'))) {
      return cur;
    }
    const parent = dirname(cur);
    if (parent === cur || cur === home) break;
    cur = parent;
  }
  return resolve(startDir);
}

function buildAncestorDirs(relPosix, isDirectory) {
  if (!relPosix) return [];
  const parts = relPosix.split('/').filter(Boolean);
  const limit = isDirectory ? parts.length : Math.max(0, parts.length - 1);
  const out = [];
  for (let i = 1; i <= limit; i++) {
    out.push(parts.slice(0, i).join('/'));
  }
  return out;
}

function pathRequiresHidden(relPosix) {
  if (!relPosix) return false;
  return relPosix.split('/').some((seg) => seg && (seg.startsWith('.') || DEFAULT_IGNORED_NAMES.has(seg)));
}

function matchWorkspaceRoot(targetAbs, exists, validRoots) {
  for (const r of validRoots) {
    if (isSubpath(r, targetAbs)) {
      return { matchedRoot: r, absPath: targetAbs };
    }
  }
  if (exists) {
    let realTarget = '';
    try {
      realTarget = realpathSync(targetAbs);
    } catch {}
    if (realTarget) {
      for (const r of validRoots) {
        try {
          const realR = realpathSync(r);
          if (isSubpath(realR, realTarget)) {
            const relFromRealRoot = relative(realR, realTarget);
            const mappedAbs = relFromRealRoot ? join(r, relFromRealRoot) : r;
            if (existsSync(mappedAbs)) {
              return { matchedRoot: r, absPath: mappedAbs };
            }
          }
        } catch {}
      }
    }
  }
  return { matchedRoot: '', absPath: targetAbs };
}

/**
 * Resolve any relative path, absolute path, file:// URI, or path:line against active roots.
 * @param {string} rawInput
 * @param {string[]} roots
 */
export function resolveTargetPath(rawInput, roots = []) {
  const { cleanedPath, line } = normalizeRawPathInput(rawInput);
  if (!cleanedPath) {
    return { ok: false, error: '路径不能为空' };
  }

  const validRoots = [];
  const seenRoots = new Set();
  for (const r of roots) {
    const local = toLocalPath(r);
    if (!local) continue;
    const abs = resolve(local);
    if (!seenRoots.has(abs) && existsSync(abs)) {
      seenRoots.add(abs);
      validRoots.push(abs);
    }
  }

  const isAbs = isAbsolute(cleanedPath) || /^[A-Za-z]:[\\/]/.test(cleanedPath);
  let absPath = '';
  let matchedRoot = '';
  let exists = false;

  if (isAbs) {
    absPath = resolve(cleanedPath);
    exists = existsSync(absPath);
    const matched = matchWorkspaceRoot(absPath, exists, validRoots);
    matchedRoot = matched.matchedRoot;
    absPath = matched.absPath;
  } else {
    for (const r of validRoots) {
      const candidate = resolve(r, cleanedPath);
      if (existsSync(candidate)) {
        exists = true;
        const orderedRoots = [r, ...validRoots.filter((vr) => vr !== r)];
        const matched = matchWorkspaceRoot(candidate, true, orderedRoots);
        matchedRoot = matched.matchedRoot;
        absPath = matched.absPath;
        break;
      }
    }
    if (!absPath) {
      const fallbackRoot = validRoots[0] || process.cwd();
      absPath = resolve(fallbackRoot, cleanedPath);
      exists = existsSync(absPath);
      const matched = matchWorkspaceRoot(absPath, exists, [fallbackRoot]);
      matchedRoot = matched.matchedRoot;
      absPath = matched.absPath;
    }
  }

  if (!exists) {
    return {
      ok: true,
      exists: false,
      absPath,
      line,
      error: `未找到路径：${cleanedPath}`
    };
  }

  let isDirectory = false;
  try {
    isDirectory = statSync(absPath).isDirectory();
  } catch {}

  let isExternalRoot = false;
  if (!matchedRoot) {
    matchedRoot = findEnclosingProjectRoot(absPath);
    isExternalRoot = true;
  }

  const relPosix = toPosixRel(relative(matchedRoot, absPath));
  const ancestorRelDirs = buildAncestorDirs(relPosix, isDirectory);

  return {
    ok: true,
    exists: true,
    absPath,
    fileUri: toFileUri(absPath),
    rootPath: matchedRoot,
    rootName: basename(matchedRoot) || matchedRoot,
    isExternalRoot,
    relPath: relPosix,
    name: basename(absPath) || absPath,
    isDirectory,
    isHtmlFile: !isDirectory && isBrowserHtmlPath(absPath),
    line,
    ancestorRelDirs,
    requiresHidden: pathRequiresHidden(relPosix)
  };
}

/**
 * List entries inside a single directory scoped under rootPath.
 * @param {string} rootPath
 * @param {string} relDir
 * @param {{ showHidden?: boolean, maxEntries?: number }} opts
 */
export function listDirectoryEntries(rootPath, relDir = '', opts = {}) {
  const showHidden = Boolean(opts.showHidden);
  const maxEntries = Number.isFinite(opts.maxEntries) ? opts.maxEntries : 2000;
  const rootAbs = resolve(toLocalPath(rootPath));
  if (!rootAbs || !existsSync(rootAbs)) {
    const err = new Error(`Workspace root not found: ${rootPath}`);
    err.status = 404;
    throw err;
  }

  const targetDir = relDir ? resolve(rootAbs, relDir) : rootAbs;
  if (!isSubpath(rootAbs, targetDir)) {
    const err = new Error('Forbidden path outside workspace root');
    err.status = 403;
    throw err;
  }
  if (!existsSync(targetDir)) {
    const err = new Error(`Directory not found: ${relDir || '.'}`);
    err.status = 404;
    throw err;
  }

  const entries = readdirSync(targetDir, { withFileTypes: true });
  const items = [];

  for (const entry of entries) {
    const name = entry.name;
    if (ALWAYS_SKIP_NAMES.has(name)) continue;
    if (!showHidden && (name.startsWith('.') || DEFAULT_IGNORED_NAMES.has(name))) {
      continue;
    }

    const fullPath = join(targetDir, name);
    let isDirectory = entry.isDirectory();
    let size = 0;
    let mtimeMs = 0;
    try {
      const st = statSync(fullPath);
      if (entry.isSymbolicLink()) {
        isDirectory = st.isDirectory();
      }
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      continue;
    }

    const relPath = toPosixRel(relative(rootAbs, fullPath));
    const ext = isDirectory ? '' : extname(name).toLowerCase();
    items.push({
      name,
      relPath,
      fileUri: toFileUri(fullPath),
      isDirectory,
      size,
      mtimeMs,
      ext,
      isHtmlFile: !isDirectory && BROWSER_HTML_EXTS.has(ext)
    });
  }

  items.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });

  const truncated = items.length > maxEntries;
  return {
    ok: true,
    root: rootAbs,
    dir: toPosixRel(relative(rootAbs, targetDir)),
    truncated,
    items: truncated ? items.slice(0, maxEntries) : items
  };
}

/**
 * Bounded BFS search across rootPath matching query against relative paths.
 * @param {string} rootPath
 * @param {string} query
 * @param {{ showHidden?: boolean, maxResults?: number, maxVisited?: number }} opts
 */
export function searchWorkspaceFiles(rootPath, query, opts = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { ok: true, results: [], truncated: false };

  const showHidden = Boolean(opts.showHidden);
  const maxResults = Number.isFinite(opts.maxResults) ? opts.maxResults : 150;
  const maxVisited = Number.isFinite(opts.maxVisited) ? opts.maxVisited : 15000;
  const rootAbs = resolve(toLocalPath(rootPath));
  if (!rootAbs || !existsSync(rootAbs)) {
    return { ok: false, error: 'Root not found', results: [], truncated: false };
  }

  const queue = [''];
  let realRoot = rootAbs;
  try {
    realRoot = realpathSync(rootAbs);
  } catch {}
  const visitedRealDirs = new Set([realRoot]);
  const matches = [];
  let visited = 0;
  let truncated = false;

  while (queue.length > 0) {
    const relDir = queue.shift();
    const absDir = relDir ? join(rootAbs, relDir) : rootAbs;
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const name = entry.name;
      if (ALWAYS_SKIP_NAMES.has(name)) continue;
      if (!showHidden && (name.startsWith('.') || DEFAULT_IGNORED_NAMES.has(name))) {
        continue;
      }

      visited++;
      if (visited > maxVisited) {
        truncated = true;
        break;
      }

      const relPath = relDir ? `${relDir}/${name}` : name;
      const fullPath = join(absDir, name);
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDirectory = statSync(fullPath).isDirectory();
        } catch {
          continue;
        }
      }

      const lowerName = name.toLowerCase();
      const lowerRel = relPath.toLowerCase();
      if (lowerRel.includes(q)) {
        let score = 1;
        if (lowerName === q) score = 4;
        else if (lowerName.startsWith(q)) score = 3;
        else if (lowerName.includes(q)) score = 2;

        const ext = isDirectory ? '' : extname(name).toLowerCase();
        matches.push({
          name,
          relPath,
          absPath: fullPath,
          fileUri: toFileUri(fullPath),
          isDirectory,
          isHtmlFile: !isDirectory && BROWSER_HTML_EXTS.has(ext),
          score
        });
      }

      if (isDirectory) {
        let dirReal = '';
        try {
          dirReal = realpathSync(fullPath);
        } catch {
          continue;
        }
        if (dirname(dirReal) === dirReal || visitedRealDirs.has(dirReal)) {
          continue;
        }
        visitedRealDirs.add(dirReal);
        queue.push(relPath);
      }
    }
    if (truncated) break;
  }

  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.relPath.length - b.relPath.length || a.relPath.localeCompare(b.relPath);
  });

  if (matches.length > maxResults) {
    truncated = true;
  }

  return {
    ok: true,
    results: matches.slice(0, maxResults),
    truncated
  };
}

/**
 * Reveal a resolved target file or directory in the OS native file manager.
 * @param {string} rawPath
 * @param {string[]} roots
 */
export function revealInOsFileManager(rawPath, roots) {
  const res = resolveTargetPath(rawPath, roots);
  if (!res.ok || !res.exists) {
    return Promise.resolve({ ok: false, error: res.error || '路径不存在' });
  }

  return new Promise((resolvePromise) => {
    const target = res.absPath;
    if (process.platform === 'darwin') {
      execFile('/usr/bin/open', ['-R', target], (err) => {
        resolvePromise(err ? { ok: false, error: err.message } : { ok: true, path: target });
      });
    } else if (process.platform === 'win32') {
      execFile('explorer.exe', [`/select,${target}`], (err) => {
        resolvePromise(err ? { ok: false, error: err.message } : { ok: true, path: target });
      });
    } else {
      const openDir = res.isDirectory ? target : dirname(target);
      execFile('xdg-open', [openDir], (err) => {
        resolvePromise(err ? { ok: false, error: err.message } : { ok: true, path: openDir });
      });
    }
  });
}

let macBrowserCache = { bundleId: '', expiresAt: 0 };

function resolveMacDefaultBrowserBundleId() {
  const now = Date.now();
  if (now < macBrowserCache.expiresAt) {
    return macBrowserCache.bundleId;
  }
  let bundleId = '';
  try {
    const plistPath = join(
      homedir(),
      'Library',
      'Preferences',
      'com.apple.LaunchServices',
      'com.apple.launchservices.secure.plist'
    );
    if (existsSync(plistPath)) {
      const rawJson = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], {
        encoding: 'utf8',
        timeout: 800
      });
      const parsed = JSON.parse(rawJson);
      const handlers = Array.isArray(parsed?.LSHandlers) ? parsed.LSHandlers : [];
      for (const scheme of ['https', 'http']) {
        const hit = handlers.find(
          (h) => String(h?.LSHandlerURLScheme || '').toLowerCase() === scheme &&
            typeof h?.LSHandlerRoleAll === 'string'
        );
        const role = String(hit?.LSHandlerRoleAll || '').trim();
        if (role && role !== '-' && /^[A-Za-z0-9.-]+$/.test(role)) {
          bundleId = role;
          break;
        }
      }
    }
  } catch {}
  macBrowserCache = { bundleId, expiresAt: now + 30000 };
  return bundleId;
}

function resolveWinDefaultBrowserExe() {
  try {
    const ucOut = execFileSync(
      'reg.exe',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'],
      { encoding: 'utf8', timeout: 800 }
    );
    const m = ucOut.match(/ProgId\s+REG_SZ\s+([^\r\n]+)/i);
    const progId = m ? m[1].trim() : '';
    if (!progId || !/^[A-Za-z0-9._-]+$/.test(progId) || /^AppX/i.test(progId)) {
      return '';
    }
    const cmdOut = execFileSync(
      'reg.exe',
      ['query', `HKCR\\${progId}\\shell\\open\\command`, '/ve'],
      { encoding: 'utf8', timeout: 800 }
    );
    const cm = cmdOut.match(/REG_(?:SZ|EXPAND_SZ)\s+([^\r\n]+)/i);
    const cmdLine = cm ? cm[1].trim() : '';
    if (!cmdLine) return '';
    const quoted = cmdLine.match(/^"([^"]+?\.exe)"/i);
    const unquoted = cmdLine.match(/^([^\s"]+?\.exe)\b/i);
    const exePath = (quoted?.[1] || unquoted?.[1] || '').trim();
    return exePath && existsSync(exePath) ? exePath : '';
  } catch {
    return '';
  }
}

function resolveLinuxDefaultBrowserDesktop() {
  try {
    const out = execFileSync('xdg-settings', ['get', 'default-web-browser'], {
      encoding: 'utf8',
      timeout: 800
    }).trim();
    return /^[A-Za-z0-9._-]+\.desktop$/.test(out) ? out : '';
  } catch {
    return '';
  }
}

function buildBrowserLaunchCandidates(absPath, fileUri, platform = process.platform) {
  if (platform === 'darwin') {
    const bundleId = resolveMacDefaultBrowserBundleId();
    const candidates = [];
    if (bundleId) {
      candidates.push(['/usr/bin/open', ['-b', bundleId, absPath]]);
    }
    if (bundleId !== 'com.apple.Safari') {
      candidates.push(['/usr/bin/open', ['-b', 'com.apple.Safari', absPath]]);
    }
    candidates.push(['/usr/bin/open', [absPath]]);
    return candidates;
  }
  if (platform === 'win32') {
    const exePath = resolveWinDefaultBrowserExe();
    const candidates = [];
    if (exePath) {
      candidates.push([exePath, [fileUri]]);
    }
    candidates.push(['rundll32.exe', ['url.dll,FileProtocolHandler', fileUri]]);
    return candidates;
  }
  const desktopId = resolveLinuxDefaultBrowserDesktop();
  const candidates = [];
  if (desktopId) {
    candidates.push(['gtk-launch', [desktopId, fileUri]]);
  }
  candidates.push(['xdg-open', [absPath]]);
  return candidates;
}

/**
 * Open a local HTML document (.html / .htm / .xhtml) in the OS default HTTPS browser.
 * Rejects non-HTML files, directories, and nonexistent paths.
 * @param {string} rawPath
 * @param {string[]} roots
 * @param {{ dryRun?: boolean, execFileImpl?: Function, platform?: string }} opts
 */
export function openInDefaultBrowser(rawPath, roots = [], opts = {}) {
  const res = resolveTargetPath(rawPath, roots);
  if (!res.ok || !res.exists) {
    return Promise.resolve({ ok: false, error: res.error || '路径不存在' });
  }
  if (res.isDirectory) {
    return Promise.resolve({ ok: false, error: '目标不是普通文件，无法在浏览器中打开' });
  }
  let isRegularFile = false;
  try {
    isRegularFile = statSync(res.absPath).isFile();
  } catch (err) {
    return Promise.resolve({ ok: false, error: err?.message || '无法读取文件状态' });
  }
  if (!isRegularFile) {
    return Promise.resolve({ ok: false, error: '目标不是普通文件，无法在浏览器中打开' });
  }
  if (!isBrowserHtmlPath(res.absPath)) {
    return Promise.resolve({ ok: false, error: '仅支持在默认浏览器中打开本地 HTML 文件（.html / .htm / .xhtml）' });
  }

  const candidates = buildBrowserLaunchCandidates(res.absPath, res.fileUri, opts.platform);
  if (opts.dryRun || process.env.AGY_FINDER_DRY_RUN_BROWSER === '1') {
    return Promise.resolve({
      ok: true,
      dryRun: true,
      path: res.absPath,
      fileUri: res.fileUri,
      candidates
    });
  }

  const execFn = typeof opts.execFileImpl === 'function' ? opts.execFileImpl : execFile;
  return new Promise((resolvePromise) => {
    let lastErr = null;
    const tryNext = (idx) => {
      if (idx >= candidates.length) {
        resolvePromise({
          ok: false,
          error: lastErr?.message || '无法调用默认浏览器打开文件'
        });
        return;
      }
      const [cmd, args] = candidates[idx];
      try {
        execFn(cmd, args, (err) => {
          if (!err) {
            resolvePromise({
              ok: true,
              path: res.absPath,
              fileUri: res.fileUri,
              command: cmd
            });
            return;
          }
          lastErr = err;
          tryNext(idx + 1);
        });
      } catch (err) {
        lastErr = err;
        tryNext(idx + 1);
      }
    };
    tryNext(0);
  });
}

/**
 * Safely read up to `maxBytes` of a workspace/target file for lightweight in-drawer preview.
 * @param {string} rawPath
 * @param {string[]} roots
 * @param {number} maxBytes
 */
export function readTextPreview(rawPath, roots = [], maxBytes = 65536) {
  const res = resolveTargetPath(rawPath, roots);
  if (!res.ok || !res.exists) {
    return { ok: false, error: res.error || '文件不存在' };
  }
  if (res.isDirectory) {
    return { ok: false, error: '目标为目录，无法预览文本内容' };
  }

  const limit = Math.max(1024, Math.min(262144, Number(maxBytes) || 65536));
  let fd;
  try {
    const st = statSync(res.absPath);
    const toRead = Math.min(st.size, limit);
    const buf = Buffer.alloc(toRead);
    if (toRead > 0) {
      fd = openSync(res.absPath, 'r');
      let offset = 0;
      while (offset < toRead) {
        const bytesRead = readSync(fd, buf, offset, toRead - offset, offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;
      }
      if (offset < toRead) {
        return readPreviewFromBuffer(buf.subarray(0, offset), res, st.size, st.size > offset);
      }
    }
    return readPreviewFromBuffer(buf, res, st.size, st.size > toRead);
  } catch (err) {
    return { ok: false, error: err?.message || '读取文件失败' };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

function readPreviewFromBuffer(buf, res, totalSize, truncated) {
  const probeLen = Math.min(buf.length, 4096);
  let isBinary = false;
  for (let i = 0; i < probeLen; i++) {
    if (buf[i] === 0) {
      isBinary = true;
      break;
    }
  }
  return {
    ok: true,
    absPath: res.absPath,
    relPath: res.relPath,
    name: res.name,
    line: res.line,
    size: totalSize,
    truncated,
    isBinary,
    content: isBinary ? '' : buf.toString('utf8')
  };
}
