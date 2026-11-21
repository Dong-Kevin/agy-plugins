#!/usr/bin/env node
/**
 * AGY Finder SessionStart Hook -- CLI Host Guard.
 *
 * When a conversation runs inside the terminal `agy` CLI (no desktop Aux Pane
 * Sidecar), injects a single concise systemMessage at session start forbidding
 * `sidecar://`, `[📂]`, and `[🌐]` capsules so the terminal Markdown renderer
 * never expands unclickable raw `sidecar://agy-finder/...` URLs inline.
 *
 * On Antigravity Desktop / IDE sessions, emits `{}` with zero overhead.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CLI_DIR_RE = /(?:^|\/)antigravity-cli(?:\/|$)/i;
const DESKTOP_OR_IDE_DIR_RE = /(?:^|\/)antigravity(?:-ide)?(?:\/|$)/i;
const CLI_VERSION_RE = /^cli(?:[-_.\s]|$)/i;

export const CLI_GUARD_MESSAGE =
  '[agy-finder] 当前会话运行在终端 agy CLI（无桌面端 Sidecar 面板）。严禁在回复中输出任何 sidecar:// 链接、[📂] 或 [🌐] 胶囊（终端 Markdown 渲染器会将其展开为不可点击的长 URL 并破坏排版）。引用本地文件仅保留标准 [文件名](file:///绝对路径) 链接。';

function normalizePath(p) {
  return String(p || '').trim().replace(/\\/g, '/');
}

export function isCliHostSession(payload = {}, env = process.env) {
  const payloadPaths = [
    normalizePath(payload?.transcriptPath),
    normalizePath(payload?.artifactDirectoryPath)
  ].filter(Boolean);

  if (payloadPaths.some((p) => CLI_DIR_RE.test(p))) return true;
  if (payloadPaths.some((p) => DESKTOP_OR_IDE_DIR_RE.test(p))) return false;

  const appDataDir = normalizePath(env?.ANTIGRAVITY_APP_DATA_DIR);
  if (appDataDir) {
    if (CLI_DIR_RE.test(appDataDir)) return true;
    if (DESKTOP_OR_IDE_DIR_RE.test(appDataDir)) return false;
  }

  const lsVersion = String(env?.ANTIGRAVITY_LS_VERSION || '').trim();
  if (CLI_VERSION_RE.test(lsVersion)) return true;

  const projectId = String(env?.ANTIGRAVITY_PROJECT_ID || '').trim();
  if (projectId === 'default-cli-project') return true;

  return false;
}

export function buildSessionStartOutput(payload = {}, env = process.env) {
  if (!isCliHostSession(payload, env)) {
    return {};
  }
  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: CLI_GUARD_MESSAGE
        }
      }
    ]
  };
}

function readStdinJson(timeoutMs = 1500) {
  return new Promise((resolvePromise) => {
    if (process.stdin.isTTY) {
      resolvePromise({});
      return;
    }
    let settled = false;
    let raw = '';
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      try {
        process.stdin.pause();
      } catch {}
      const trimmed = raw.trim();
      if (!trimmed) {
        resolvePromise({});
        return;
      }
      try {
        const parsed = JSON.parse(trimmed);
        resolvePromise(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        resolvePromise({});
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 512 * 1024) finish();
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    try {
      process.stdin.resume();
    } catch {
      finish();
    }
  });
}

const isEntrypoint =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntrypoint) {
  readStdinJson()
    .then((payload) => {
      const out = buildSessionStartOutput(payload, process.env);
      process.stdout.write(`${JSON.stringify(out)}\n`);
    })
    .catch(() => {
      process.stdout.write('{}\n');
    });
}
