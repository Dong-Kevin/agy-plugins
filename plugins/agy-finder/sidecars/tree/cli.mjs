#!/usr/bin/env node
/**
 * Cross-platform CLI for toggling or configuring the AGY Finder File Tree drawer.
 * Usage:
 *   agy-finder [toggle|open [path]|close|status [--json]|hotkey <preset>|quit]
 */

import { controlDrawer, getDrawerStatus, HOTKEY_PRESETS } from './drawer.mjs';

function printHelp() {
  console.log(`AGY Finder CLI

用法:
  agy-finder toggle              打开或关闭右侧独立目录树抽屉（默认）
  agy-finder open [path]         打开抽屉并可选定位到指定路径
  agy-finder close               关闭/隐藏抽屉
  agy-finder status [--json]     查看抽屉、快捷键与宿主快捷键状态
  agy-finder hotkey <preset>     设置全局应用内快捷键预设:
                                 ${HOTKEY_PRESETS.map((p) => p.id).join(' | ')}
  agy-finder quit                退出后台抽屉守护进程`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
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
    const presetObj = HOTKEY_PRESETS.find((p) => p.id === st.hotkeyPreset);
    const label = process.platform === 'darwin' ? presetObj?.macLabel : presetObj?.winLabel;
    console.log(
      `[agy-finder] 抽屉状态：${st.windowVisible ? '已打开' : '已隐藏'} | 快捷键：${label || st.hotkeyPreset} | 宿主 Aux Pane：${hostKey}`
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

  if (cmd === 'open') {
    const revealPath = positional.slice(1).join(' ');
    const res = await controlDrawer({ action: 'open', revealPath });
    if (wantsJson) console.log(JSON.stringify(res, null, 2));
    else console.log(`[agy-finder] ${res.message || res.error || '已打开'}`);
    if (res.ok === false) process.exit(1);
    return;
  }

  if (cmd === 'close' || cmd === 'toggle' || cmd === 'quit') {
    const res = await controlDrawer({ action: cmd });
    if (wantsJson) console.log(JSON.stringify(res, null, 2));
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
