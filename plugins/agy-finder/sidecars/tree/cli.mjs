#!/usr/bin/env node
/**
 * Cross-platform CLI for toggling or configuring the AGY Finder File Tree drawer
 * and Antigravity Right-Hand Auxiliary Side Pane.
 * Usage:
 *   agy-finder [toggle|open [path]|close|aux [path]|status [--json]|hotkey <preset>|shortcut [arg]|aux-shortcut [arg]|quit]
 */

import { controlDrawer, getDrawerStatus, HOTKEY_PRESETS, readActiveContextHint } from './drawer.mjs';
import { openInDefaultBrowser } from './path_utils.mjs';
import { checkForUpdates, performSelfUpdate } from './updater.mjs';

function printHelp() {
  console.log(`AGY Finder CLI

用法:
  agy-finder toggle                       打开或关闭右侧独立目录树抽屉（默认）
  agy-finder open [path]                  打开独立抽屉并可选定位到指定路径
  agy-finder browser <path>               在系统默认浏览器中打开本地 HTML 文件
  agy-finder close                        关闭/隐藏独立抽屉
  agy-finder aux [path]                   在 AGY 右侧辅助栏打开/切换目录树（可选定位路径）
  agy-finder status [--json]              查看独立抽屉、右侧辅助栏与快捷键状态
  agy-finder update [--check|--apply]     检查或自动更新至最新 GitHub Release（含 SHA-256 校验）
  agy-finder shortcut [arg]               设置独立抽屉自定义快捷键（off/on/reset/app/global/Ctrl+Shift+E）
  agy-finder aux-shortcut [arg]           设置 AGY 侧栏目录树快捷键（off/on/reset/app/global/Alt+Meta+E）
  agy-finder hotkey <preset>              兼容切换预设快捷键:
                                          ${HOTKEY_PRESETS.map((p) => p.id).join(' | ')}
  agy-finder quit                         退出后台抽屉守护进程`);
}

function buildShortcutPatch(rawArg) {
  const token = String(rawArg || '').trim();
  const low = token.toLowerCase();
  if (!token || low === 'status') return null;
  if (low === 'reset' || low === 'default') return { reset: true };
  if (low === 'on' || low === 'enable') return { enabled: true };
  if (low === 'off' || low === 'disable' || low === 'disabled') return { enabled: false };
  if (low === 'app' || low === 'global') return { scope: low };
  return { accelerator: token, enabled: true };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
    return;
  }

  if (args.includes('--ensure-hotkey') || args.includes('--ensure-daemon')) {
    const st = await controlDrawer({ action: 'ensure-hotkey' });
    if (args.includes('--json')) console.log(JSON.stringify(st, null, 2));
    return;
  }

  const wantsJson = args.includes('--json');
  const positional = args.filter((a) => !a.startsWith('-'));
  const cmd = String(positional[0] || 'toggle').toLowerCase();

  if (cmd === 'status') {
    const st = getDrawerStatus();
    if (wantsJson) {
      console.log(JSON.stringify(st, null, 2));
      return;
    }
    const hostKey = process.platform === 'darwin' ? '⌘⇧B' : 'Ctrl+Shift+B';
    const drawerLabel = st.drawerShortcut?.enabled ? st.drawerShortcut.display : '已关闭';
    const auxLabel = st.auxShortcut?.enabled ? st.auxShortcut.display : '已关闭';
    console.log(
      `[agy-finder] 抽屉状态：${st.windowVisible ? '已打开' : '已隐藏'} | 独立抽屉快捷键：${drawerLabel} | AGY 侧栏快捷键：${auxLabel} | 宿主显隐：${hostKey}`
    );
    return;
  }

  if (cmd === 'hotkey') {
    const preset = String(positional[1] || '').trim().toLowerCase();
    if (!preset) {
      console.error('请指定快捷键预设，例如：agy-finder hotkey cmd+shift+e');
      process.exit(1);
    }
    const res = await controlDrawer({ action: 'set-hotkey', hotkeyPreset: preset });
    if (wantsJson) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`[agy-finder] ${res.message || res.error || '已完成'}`);
    }
    if (res.ok === false) process.exit(1);
    return;
  }

  if (cmd === 'shortcut' || cmd === 'aux-shortcut' || cmd === 'aux-hotkey') {
    const isAux = cmd !== 'shortcut';
    const arg = positional.slice(1).join(' ');
    const patch = buildShortcutPatch(arg);
    if (!patch) {
      const st = getDrawerStatus();
      const target = isAux ? st.auxShortcut : st.drawerShortcut;
      if (wantsJson) {
        console.log(JSON.stringify({ ok: true, shortcut: target }, null, 2));
      } else {
        console.log(
          `[agy-finder] ${isAux ? 'AGY 侧栏目录树快捷键' : '独立抽屉快捷键'}：${target?.enabled ? target.display : '已关闭'} (${target?.accelerator || '-'}) · 范围 ${target?.scope || 'app'}`
        );
      }
      return;
    }
    const res = await controlDrawer({
      action: isAux ? 'set-aux-shortcut' : 'set-drawer-shortcut',
      ...patch
    });
    if (wantsJson) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`[agy-finder] ${res.message || res.error || '已完成'}`);
    }
    if (res.ok === false) process.exit(1);
    return;
  }

  if (cmd === 'aux' || cmd === 'open-aux' || cmd === 'toggle-aux') {
    const revealPath = positional.slice(1).join(' ');
    const res = await controlDrawer({ action: 'aux', revealPath });
    if (wantsJson) console.log(JSON.stringify(res, null, 2));
    else console.log(`[agy-finder] ${res.message || res.error || '已触发侧栏目录树'}`);
    if (res.ok === false) process.exit(1);
    return;
  }

  if (cmd === 'open') {
    const revealPath = positional.slice(1).join(' ');
    const res = await controlDrawer({ action: 'open', revealPath });
    if (wantsJson) console.log(JSON.stringify(res, null, 2));
    else console.log(`[agy-finder] ${res.message || res.error || '已打开'}`);
    if (res.ok === false) process.exit(1);
    return;
  }

  if (cmd === 'browser' || cmd === 'open-browser') {
    const targetPath = positional.slice(1).join(' ').trim();
    if (!targetPath) {
      const msg = '请指定要打开的本地 HTML 文件路径，例如：agy-finder browser preview/index.html';
      if (wantsJson) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
      else console.error(`[agy-finder] ${msg}`);
      process.exit(1);
    }
    const hintRoots = Array.isArray(readActiveContextHint()?.roots) ? readActiveContextHint().roots : [];
    const roots = [process.cwd(), ...hintRoots.filter((r) => r && r !== process.cwd())];
    const res = await openInDefaultBrowser(targetPath, roots);
    if (wantsJson) console.log(JSON.stringify(res, null, 2));
    else if (res.ok) console.log(`[agy-finder] 已在默认浏览器中打开：${res.path}`);
    else console.error(`[agy-finder] ${res.error || '无法在默认浏览器中打开'}`);
    if (res.ok === false) process.exit(1);
    return;
  }

  if (cmd === 'update') {
    const checkOnly = args.includes('--check') || positional[1] === 'check';
    const force = args.includes('--force');
    const res = checkOnly ? await checkForUpdates({ force: true }) : await performSelfUpdate({ force });
    if (res?.ok && res?.updated && process.platform === 'darwin' && !process.env.AGY_FINDER_UPDATE_TARGET_DIR) {
      const st = getDrawerStatus();
      if (st?.daemonRunning) {
        await controlDrawer({ action: 'ensure-hotkey' }).catch(() => {});
      }
    }
    if (wantsJson) {
      console.log(JSON.stringify(res, null, 2));
    } else if (!res.ok) {
      console.error(`[agy-finder] ${res.error || '更新失败'}`);
    } else if (checkOnly) {
      console.log(
        res.hasUpdate
          ? `[agy-finder] 发现新版本 v${res.latestVersion}（当前 v${res.currentVersion}），运行 agy-finder update 自动升级。`
          : `[agy-finder] 当前已是最新版本 v${res.currentVersion}`
      );
    } else {
      console.log(`[agy-finder] ${res.message || `已更新至 v${res.currentVersion}`}`);
    }
    if (res.ok === false) process.exit(1);
    return;
  }

  if (cmd === 'close' || cmd === 'toggle' || cmd === 'quit') {
    const res = await controlDrawer({ action: cmd });
    if (wantsJson) console.log(JSON.stringify(res, null, 2));
    else if (res.warning) console.error(res.warning);
    else console.log(`[agy-finder] ${res.message || res.error || '已完成'}`);
    if (res.ok === false) process.exit(1);
    return;
  }

  console.error(`未知子命令：${cmd}`);
  printHelp();
  process.exit(1);
}

main().catch((err) => {
  console.error('[agy-finder]', err?.message || err);
  process.exit(1);
});
