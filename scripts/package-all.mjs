#!/usr/bin/env node
/**
 * Zero-dependency Release Packager for Dong-Kevin/agy-plugins.
 * Builds deterministic ZIP + SHA-256 artifacts into root `dist/`.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST_DIR = join(ROOT, 'dist');

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

function buildZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const dosTime = 0x0000;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.zipPath, 'utf-8');
    const rawData = entry.data;
    const crc = crc32(rawData);
    const deflated = deflateRawSync(rawData, { level: 9 });
    const useDeflate = deflated.length < rawData.length;
    const compData = useDeflate ? deflated : rawData;
    const method = useDeflate ? 8 : 0;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x0800, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(dosTime, 10);
    lfh.writeUInt16LE(dosDate, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compData.length, 18);
    lfh.writeUInt32LE(rawData.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    localParts.push(lfh, nameBuf, compData);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE((3 << 8) | 20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(dosTime, 12);
    cdh.writeUInt16LE(dosDate, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(compData.length, 20);
    cdh.writeUInt32LE(rawData.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    const unixMode = entry.executable ? 0o100755 : 0o100644;
    cdh.writeUInt32LE((unixMode << 16) >>> 0, 38);
    cdh.writeUInt32LE(offset, 42);
    centralParts.push(cdh, nameBuf);
    offset += lfh.length + nameBuf.length + compData.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralBuf, eocd]);
}

function packageAgyFinder() {
  const pluginDir = join(ROOT, 'plugins', 'agy-finder');
  const manifest = JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf-8'));
  const version = manifest.version;
  const prefix = 'agy-finder';
  const relFiles = [
    ['plugin.json', false],
    ['README.md', false],
    ['README_EN.md', false],
    ['LICENSE', false],
    ['install.sh', true],
    ['install.ps1', false],
    ['assets/logo.svg', false],
    ['rules/AGENTS.md', false],
    ['skills/agy-finder/SKILL.md', false],
    ['sidecars/tree/sidecar.json', false],
    ['sidecars/tree/package.json', false],
    ['sidecars/tree/main.mjs', false],
    ['sidecars/tree/path_utils.mjs', false],
    ['sidecars/tree/mentions.mjs', false],
    ['sidecars/tree/drawer.mjs', false],
    ['sidecars/tree/cli.mjs', true],
    ['sidecars/tree/native_drawer_macos.swift', false],
    ['sidecars/tree/index.html', false],
    ['sidecars/tree/styles.css', false],
    ['sidecars/tree/app.js', false]
  ];

  const repoSlug = String(manifest.repository || 'https://github.com/Dong-Kevin/agy-plugins')
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const releaseRef = process.env.RELEASE_REF || 'main';
  const onlineDocsImagesBase = `https://raw.githubusercontent.com/${repoSlug}/${releaseRef}/plugins/agy-finder/docs/images/`;

  const entries = relFiles.map(([rel, executable]) => {
    const abs = join(pluginDir, rel);
    statSync(abs);
    let data = readFileSync(abs);
    if (rel === 'README.md' || rel === 'README_EN.md') {
      const rewritten = data
        .toString('utf-8')
        .replace(/(src=["'])docs\/images\//g, `$1${onlineDocsImagesBase}`)
        .replace(/(\]\()docs\/images\//g, `$1${onlineDocsImagesBase}`);
      data = Buffer.from(rewritten, 'utf-8');
    }
    return {
      zipPath: `${prefix}/${rel}`,
      data,
      executable
    };
  });

  const zipName = `agy-finder-v${version}.zip`;
  const zipPath = join(DIST_DIR, zipName);
  const zipBuf = buildZipBuffer(entries);
  writeFileSync(zipPath, zipBuf);
  const sha256 = createHash('sha256').update(zipBuf).digest('hex');
  writeFileSync(`${zipPath}.sha256`, `${sha256}  ${zipName}\n`, 'utf-8');
  console.log(`[package-all] 已生成发布包：${zipPath} (${(zipBuf.length / 1024).toFixed(1)} KB, ${entries.length} 个文件)`);
}

function packageContextViewer() {
  const pluginDir = join(ROOT, 'plugins', 'agy-context-viewer');
  const manifest = JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf-8'));
  const version = manifest.version;
  execFileSync(process.execPath, [join(pluginDir, 'scripts', 'package-release.mjs')], {
    cwd: pluginDir,
    stdio: 'inherit'
  });

  const pluginDist = join(pluginDir, 'dist');
  const zipName = `context-viewer-v${version}.zip`;
  const shaName = `${zipName}.sha256`;
  copyFileSync(join(pluginDist, zipName), join(DIST_DIR, zipName));
  copyFileSync(join(pluginDist, shaName), join(DIST_DIR, shaName));
  rmSync(pluginDist, { recursive: true, force: true });
  console.log(`[package-all] 已同步发布包至根目录：${join(DIST_DIR, zipName)}`);
}

function main() {
  rmSync(DIST_DIR, { recursive: true, force: true });
  mkdirSync(DIST_DIR, { recursive: true });
  packageAgyFinder();
  packageContextViewer();
}

main();
