/**
 * Context & Token Viewer — Official Antigravity Sidecar Frontend
 *
 * Works inside Antigravity's Aux Pane (`window.sidecar` injected by `preload.js`)
 * as well as standalone local preview mode.
 */

(() => {
  'use strict';

  const USD_TO_CNY = 6.72;

  const HEAT_PRESETS = {
    violet: {
      accentLight: '#7c3aed',
      accentDark: '#a78bfa',
      light: ['#edeef2', '#ddd6fe', '#c4b5fd', '#8b5cf6', '#6d28d9'],
      dark: ['#232329', '#3b1f6e', '#5b21b6', '#8b5cf6', '#c4b5fd']
    },
    emerald: {
      accentLight: '#059669',
      accentDark: '#34d399',
      light: ['#edeef2', '#d1fae5', '#6ee7b7', '#10b981', '#047857'],
      dark: ['#232329', '#064e3b', '#047857', '#10b981', '#6ee7b7']
    },
    sky: {
      accentLight: '#0284c7',
      accentDark: '#38bdf8',
      light: ['#edeef2', '#e0f2fe', '#7dd3fc', '#0ea5e9', '#0369a1'],
      dark: ['#232329', '#0c4a6e', '#0369a1', '#0ea5e9', '#7dd3fc']
    },
    amber: {
      accentLight: '#d97706',
      accentDark: '#fbbf24',
      light: ['#edeef2', '#fef3c7', '#fcd34d', '#f59e0b', '#b45309'],
      dark: ['#232329', '#5c330a', '#92400e', '#f59e0b', '#fcd34d']
    },
    rose: {
      accentLight: '#e11d48',
      accentDark: '#fb7185',
      light: ['#edeef2', '#ffe4e6', '#fda4af', '#f43f5e', '#be123c'],
      dark: ['#232329', '#60162a', '#9f1239', '#f43f5e', '#fda4af']
    }
  };

  const state = {
    activeTab: 'context',
    selectedConvId: '',
    hostConvId: window.sidecar?.conversationId || '',
    workspaceUri: '',
    recentConversations: [],
    activeConvId: '',
    pinSyncSeq: 0,
    pinSyncPending: 0,
    userModifiedConvSelection: false,
    convPicker: {
      open: false,
      search: '',
      projectFilter: '__all__', // '__all__' | '__current__' | 'proj:<name>'
      collapsePrefs: null,
      lastSelectSig: '',
      lastTriggerSig: '',
      lastPillsSig: '',
      lastBodySig: ''
    },
    contextEtag: '',
    contextEtagConv: '',
    contextReqSeq: 0,
    contextInFlight: false,
    contextInFlightConv: '',
    contextInFlightSince: 0,
    contextAbortCtrl: null,
    lastHiddenAt: 0,
    lastWakeRefreshAt: 0,
    copyMdTimer: null,
    historyEtag: '',
    historyReqSeq: 0,
    historyInFlight: false,
    contextData: null,
    historyData: null,
    settingsData: null,

    // History view controls
    sourceFilter: 'all',
    chartMode: 'daily',
    hourlyDay: 'today', // 'today' | 'yesterday'
    diagTab: 'events', // 'events' | 'routing'
    heatPageOffset: 0,
    chartScrollKey: '',
    chartScrollPending: '',
    chartScrollMode: 'latest',
    selectedBucketKey: '',
    customRange: {
      start: '',
      end: '',
      preset: '30d', // '7d' | '30d' | '90d' | 'mtd' | 'prevMonth' | 'all' | 'custom'
      granularity: 'auto' // 'auto' | 'day' | 'week' | 'month'
    },

    // Cost view controls
    costScope: 'period',
    costMode: 'hybrid',
    projectLimit: 5, // 5 | 10
    turnsFilter: 'all', // 'all' | 'spike' | 'tools'
    turnsView: 'steps', // 'steps' | 'prompts'
    promptTurnsFilter: 'all', // 'all' | 'cold'

    // Appearance & gauge preferences
    ui: {
      themeMode: 'auto', // 'auto' | 'light' | 'dark' | 'oled'
      glass: true,
      lang: 'zh',
      preset: 'violet',
      customLevels: null, // [c0, c1, c2, c3, c4] or null
      customAccent: ''
    },

    presetsPopulated: false,
    menubarEnabled: window.__CV_MENUBAR_ENABLED__ ?? true,
    menubarMode: window.__CV_MENUBAR_MODE__ || 'context',
    menubarSupported: true,
    shortcut: window.__CV_SHORTCUT_INIT__ || (() => {
      const mac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
      const defAcc = mac ? 'Alt+Meta+K' : 'Ctrl+Alt+K';
      const defDisp = mac ? '⌥⌘K' : 'Ctrl+Alt+K';
      return {
        enabled: true,
        accelerator: defAcc,
        display: defDisp,
        defaultAccelerator: defAcc,
        defaultDisplay: defDisp,
        isDefault: true,
        scope: 'app',
        nativeGlobalSupported: mac
      };
    })(),
    auxShortcut: window.__CV_AUX_SHORTCUT_INIT__ || (() => {
      const mac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
      const defAcc = mac ? 'Ctrl+Alt+K' : 'Ctrl+Alt+Shift+K';
      const defDisp = mac ? '⌃⌥K' : 'Ctrl+Alt+Shift+K';
      return {
        enabled: true,
        accelerator: defAcc,
        display: defDisp,
        defaultAccelerator: defAcc,
        defaultDisplay: defDisp,
        isDefault: true,
        scope: 'app',
        nativeGlobalSupported: mac
      };
    })(),
    recordingShortcut: false,
    recordingAuxShortcut: false,
    hostHidden: Boolean(window.__CV_INITIAL_HIDDEN__),
    floatRunning: Boolean(window.__CV_FLOAT_MODE__) && !Boolean(window.__CV_INITIAL_HIDDEN__),
    floatPinned: Boolean(window.__CV_FLOAT_PINNED__ ?? true),
    toastTimer: null,
    customTooltipsReady: false,
    openDetailsKeys: new Set(),
    hoveredSpectrumCat: '',
    heatScrollInited: false,
    lastHeatWindowKey: '',
    lastRenderSigs: {},
    themeSwitchTimer: null,
    sessionSwitchTimer: null,
    scrollIdleTimer: null,
    numTweenHandles: {},
    numTweenLastValues: {},
    refreshSpinPendingStop: false,
    refreshSpinFallbackTimer: null,
    capPopover: {
      open: false,
      pinned: false,
      activeKey: '',
      lastSig: '',
      closeTimer: null,
      hideTimer: null
    }
  };

  const $ = (id) => document.getElementById(id);

  // -------------------------------------------------------------------------
  // Deterministic Chinese-English / Number Typography Layer
  // -------------------------------------------------------------------------

  function formatZh(raw) {
    if (raw === null || raw === undefined) return '';
    const str = String(raw);
    if (!str) return '';
    if (str === '—' || str === '--') return '--';

    // Temporarily mask URLs / URI schemes so they remain untouched
    const masks = [];
    let out = str.replace(/(?:https?|file|sidecar|customization):\/\/[^\s)]+/g, (m) => {
      masks.push(m);
      return `\u0000URL${masks.length - 1}\u0000`;
    });

    // Normalize prose em-dashes to ` -- `
    out = out.replace(/\s*——\s*/g, ' -- ');

    // Insert space between CJK characters and ASCII letters/numbers/currency symbols
    out = out.replace(/([\u4e00-\u9fff])([A-Za-z0-9$¥€£₩₹₺₦₱฿₫])/g, '$1 $2');
    out = out.replace(/([A-Za-z0-9%])([\u4e00-\u9fff])/g, '$1 $2');

    // Collapse accidental double spaces around inserted boundaries
    out = out.replace(/ {2,}/g, ' ');

    if (masks.length) {
      out = out.replace(/\u0000URL(\d+)\u0000/g, (_, idx) => masks[Number(idx)] || '');
    }
    return out;
  }

  function setText(elOrId, val) {
    const el = typeof elOrId === 'string' ? $(elOrId) : elOrId;
    if (!el) return;
    el.textContent = formatZh(val);
  }

  function setElTooltip(elOrId, rawTip) {
    const el = typeof elOrId === 'string' ? $(elOrId) : elOrId;
    if (!el) return;
    const tip = rawTip ? formatZh(rawTip) : '';
    if (el.dataset && (el.dataset.cvTip !== undefined || state.customTooltipsReady)) {
      if (tip) {
        el.dataset.cvTip = tip;
      } else {
        delete el.dataset.cvTip;
      }
      el.removeAttribute?.('title');
    } else if (tip) {
      el.setAttribute?.('title', tip);
    } else if (typeof el.removeAttribute === 'function') {
      el.removeAttribute('title');
    } else {
      el.setAttribute?.('title', '');
    }
  }

  function esc(raw) {
    return String(raw ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escZh(raw) {
    return esc(formatZh(raw));
  }

  function normalizeStaticDomTypography() {
    const skipTags = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'INPUT', 'SELECT', 'TEXTAREA']);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const p = node.parentElement;
      if (!p || skipTags.has(p.tagName) || p.classList.contains('mono-tag')) continue;
      const v = node.nodeValue;
      if (v && /[\u4e00-\u9fff—]/.test(v)) {
        const formatted = formatZh(v);
        if (formatted !== v) node.nodeValue = formatted;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Formatting Helpers
  // -------------------------------------------------------------------------

  function fmtTokens(n, digits = 2) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '--';
    const v = Number(n);
    if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(digits)}B`;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(digits)}M`;
    if (v >= 10_000) return `${(v / 1_000).toFixed(1)}K`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(2)}K`;
    return Math.round(v).toLocaleString('en-US');
  }

  function fmtInt(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '--';
    return Math.round(Number(n)).toLocaleString('en-US');
  }

  function fmtIntZh(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '--';
    return new Intl.NumberFormat('zh-CN').format(Math.round(Number(n)));
  }

  function fmtCompactZh(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '--';
    const v = Number(n);
    if (v >= 10_000_000) return `${Math.round(v / 1_000_000)}M`;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if (v >= 100_000) return `${Math.round(v / 1_000)}K`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
    return String(Math.round(v));
  }

  function fmtUSD(v, minDec = 2) {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return '--';
    const num = Number(v);
    if (num === 0) return '$0.00';
    if (num > 0 && num < 0.01) return `$${num.toFixed(4)}`;
    return `$${num.toFixed(minDec)}`;
  }

  function fmtCNY(usdVal) {
    if (usdVal === null || usdVal === undefined || Number.isNaN(Number(usdVal))) return '--';
    const cny = Number(usdVal) * USD_TO_CNY;
    if (cny === 0) return '¥0.00';
    if (cny > 0 && cny < 0.05) return `¥${cny.toFixed(3)}`;
    return `¥${cny.toFixed(2)}`;
  }

  function isEn() {
    return typeof state !== 'undefined' && state?.ui?.lang === 'en';
  }

  function tr(zh, en) {
    return isEn() ? en : zh;
  }

  function fmtCacheSavings(usd, prefix = '缓存') {
    if (usd === null || usd === undefined || !Number.isFinite(Number(usd))) return null;
    const num = Number(usd);
    const en = isEn();
    if (num >= 0.0005) {
      const absStr = fmtUSD(num);
      if (en) {
        const lbl = prefix ? 'Cache saved' : 'Saved';
        return { text: `${lbl} ${absStr}`, savedText: `${lbl} ${absStr}`, shortText: `Saved ${absStr}`, cls: 'ok' };
      }
      return { text: `${prefix}省 ${absStr}`, savedText: `${prefix}已省 ${absStr}`, shortText: `省 ${absStr}`, cls: 'ok' };
    }
    if (num <= -0.0005) {
      const absStr = fmtUSD(Math.abs(num));
      if (en) {
        const lbl = prefix ? 'Cache +' : '+';
        return { text: `${lbl}${absStr}`, savedText: `${lbl}${absStr}`, shortText: `+${absStr}`, cls: 'warn' };
      }
      return { text: `${prefix}净增 ${absStr}`, savedText: `${prefix}净增 ${absStr}`, shortText: `净增 ${absStr}`, cls: 'warn' };
    }
    return null;
  }

  function escapeCsvCell(val) {
    if (val === null || val === undefined) return '';
    let str = String(val);
    if (/^[=+\-@\t\r]/.test(str) || /^[=+\-@\t\r]/.test(str.trimStart())) {
      str = `'${str}`;
    }
    if (/[",\r\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  function fmtSec(sec) {
    if (sec === null || sec === undefined || Number.isNaN(Number(sec))) return '--';
    const s = Number(sec);
    if (s >= 60) {
      const m = Math.floor(s / 60);
      const rem = (s - m * 60).toFixed(1);
      return `${m}m ${rem}s`;
    }
    return `${s.toFixed(s < 10 ? 2 : 1)}s`;
  }

  function fmtBytes(bytes) {
    const b = Number(bytes || 0);
    if (b <= 0) return '0 B';
    if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
    if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${b} B`;
  }

  function formatQuotaCalibrationText(cal) {
    if (!cal || typeof cal !== 'object') return '';
    const en = isEn();
    if (cal.estRemainingTokens != null && Number.isFinite(Number(cal.estRemainingTokens)) && Number(cal.estTotalTokens) > 0) {
      const samples = Number(cal.samples || 1);
      const remStr = fmtTokens(cal.estRemainingTokens);
      const totStr = fmtTokens(cal.estTotalTokens);
      return en
        ? `Est. ~${remStr} / ${totStr} tok left (EMA · ${samples}x)`
        : formatZh(`估算余 ~${remStr} / ${totStr} tok（EMA · ${samples}次校准）`);
    }
    if (cal.diverged) {
      return en
        ? 'Cross-device usage detected, recalibrating'
        : '检测到跨端消耗，待重新校准';
    }
    return '';
  }

  function formatQuotaCalibrationHtml(cal) {
    const text = formatQuotaCalibrationText(cal);
    if (!text) return '';
    const isDiverged = !(cal.estRemainingTokens != null && Number(cal.estTotalTokens) > 0) && Boolean(cal.diverged);
    const tip = isDiverged
      ? tr(
          '检测到配额变化与本机 Token 消耗不匹配（可能存在跨端或多设备消耗），暂停本次校准并在下一完整周期重新建立基准。',
          'Detected quota drop not matching local token usage (possible another device/IDE); EMA capacity estimate paused until next clean sample.'
        )
      : tr(
          '基于近期轮次 Δtokens / ΔremainingFraction 的指数移动平均（EMA）动态校准估算，仅供参考，非服务端官方额度上限。',
          'Dynamic estimate via EMA of Δtokens / ΔremainingFraction across recent turns (indicative only, not an official server cap).'
        );
    return `<div class="quota-cal-line${isDiverged ? ' is-diverged' : ''}" title="${escZh(tip)}">${escZh(text)}</div>`;
  }

  function pickTightestQuotaCalibration(q) {
    if (!q || typeof q !== 'object') return null;
    const isUsableCal = (cal) => Boolean(
      cal &&
      typeof cal === 'object' &&
      ((cal.estRemainingTokens != null && Number.isFinite(Number(cal.estRemainingTokens)) && Number(cal.estTotalTokens) > 0) || cal.diverged)
    );
    const candidates = [];
    const pushCand = (pct, cal) => {
      if (!isUsableCal(cal)) return;
      const num = Number(pct);
      candidates.push({
        pct: typeof pct === 'number' && Number.isFinite(num) ? num : Number.POSITIVE_INFINITY,
        cal
      });
    };
    if (q.fiveHour) pushCand(q.fiveHour.remainingPercent, q.fiveHour.calibration);
    if (q.weekly) pushCand(q.weekly.remainingPercent, q.weekly.calibration);
    const basePct = typeof q.baseRemainingPercent === 'number' && Number.isFinite(q.baseRemainingPercent)
      ? q.baseRemainingPercent
      : q.remainingPercent;
    pushCand(basePct, q.calibration);
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.pct - b.pct);
    return candidates[0].cal;
  }

  const I18N_EN = {
    'cap.ctx.title': 'Click to inspect or pin current session context lens',
    'cap.speed.title': 'Hover for speed & time split; click to jump or pin',
    'cap.tok.title': 'Hover for token & cache economics; click to jump or pin',
    'btn.cli.title': 'Launch agy CLI in current workspace',
    'btn.palette.title': 'Shortcuts, menu bar customization, floating window & palette',
    'btn.copyMd.title': 'Copy anonymized Markdown telemetry summary',
    'btn.refresh.title': 'Force refresh telemetry & stats',
    'drawer.title': 'Shortcuts & Appearance',
    'drawer.reset': 'Reset Defaults',
    'drawer.menubarEntry': 'Menu Bar Icon',
    'drawer.menubarEntry.title': 'Left-click toggles dashboard · Right-click switches mode',
    'common.on': 'On',
    'common.off': 'Off',
    'drawer.menubarMode': 'Menu Bar Display',
    'drawer.menubarMode.title': 'Auto-follows when switching active session',
    'menubar.context': 'Context %',
    'menubar.context.title': 'Show current context window usage %',
    'menubar.speed': 'Speed & Time',
    'menubar.speed.title': 'Show latest speed, latency, avg & peak',
    'menubar.quota': '5h/Week Quota',
    'menubar.quota.title': 'Show 5h / Weekly quota remaining & reset countdown',
    'drawer.float': 'Floating Window',
    'drawer.float.title': 'Pop out a dedicated always-on-top floating panel on the right',
    'drawer.floatSc': 'Floating Hotkey',
    'drawer.floatSc.title': 'Toggle the floating panel with one shortcut (no Accessibility prompt)',
    'drawer.auxSc': 'AGY Sidebar Hotkey',
    'drawer.auxSc.title': 'Toggle Antigravity right sidebar Context Viewer (pin tab to jump anytime)',
    'btn.recordSc.title': 'Click then press new key combo (Esc to cancel)',
    'btn.toggleFloatSc.title': 'Enable or disable floating window hotkey',
    'btn.resetFloatSc.title': 'Restore default shortcut',
    'btn.toggleAuxSc.title': 'Enable or disable AGY sidebar hotkey',
    'btn.resetAuxSc.title': 'Restore default shortcut',
    'common.default': 'Default',
    'drawer.scScope': 'Shortcut Scope',
    'drawer.scScope.title': 'By default active only when Antigravity or viewer is focused',
    'scope.app': 'Host Focused',
    'scope.app.title': 'Active only when Antigravity or viewer window is focused',
    'scope.global': 'Global',
    'scope.global.title': 'Toggle panel from any application',
    'drawer.theme': 'Theme',
    'theme.auto': 'Auto',
    'theme.light': 'Light',
    'theme.dark': 'Dark',
    'theme.oled': 'OLED Black',
    'drawer.glass': 'Glassmorphism',
    'glass.on': 'Frosted',
    'glass.off': 'Solid',
    'drawer.lang': 'Language',
    'drawer.heatPreset': 'Heatmap Palette',
    'preset.violet': 'Violet',
    'preset.emerald': 'Emerald',
    'preset.sky': 'Sky',
    'preset.amber': 'Amber',
    'preset.rose': 'Rose',
    'drawer.swatches': '5-Level Heatmap & Accent',
    'drawer.accent': 'Accent',
    'swatch.l0': 'Level 0 (None)',
    'swatch.l1': 'Level 1 (Low)',
    'swatch.l2': 'Level 2 (Medium)',
    'swatch.l3': 'Level 3 (High)',
    'swatch.l4': 'Level 4 (Peak)',
    'swatch.accent': 'Primary Accent',
    'tab.context': 'Session',
    'tab.history': 'Trends',
    'tab.cost': 'Cost & Plan',
    'conv.follow': 'Follow Live',
    'conv.follow.title': 'Switch back to auto-following active session',
    'conv.search.ph': 'Search session title or project…',
    'ctx.title': 'Context Window',
    'ctx.pending.title': 'Estimated tokens of unsent steps after last response',
    'ctx.used': 'Used',
    'ctx.budget': 'Budget Cap',
    'ctx.sessionCache': 'Session Avg Cache',
    'ctx.roundCache': 'Last Turn Cache',
    'ctx.segBar.title': 'Context composition',
    'ctx.sessionModels': 'Session Models',
    'ctx.cumTitle': 'Cumulative Throughput & Cost',
    'ctx.cumHistory': 'Includes archived turns in this session',
    'cum.cacheRead': 'Cache Read',
    'cum.input': 'New Input',
    'cum.output': 'Output',
    'cum.total': 'Session Total',
    'ctx.roundCost': 'Last Turn API Est.',
    'ctx.sessionCost': 'Session Cumulative Est.',
    'agentTree.title': 'Swarm / Subagent Tree',
    'agentTree.totalTok': 'Tree Total Tokens',
    'agentTree.totalCost': 'Tree Est. Cost',
    'agentTree.cacheSaved': 'Tree Cache Saved',
    'speed.title': 'Speed & Latency',
    'speed.tps': 'Overall Speed',
    'speed.dur': 'Total Latency',
    'speed.ttft': 'TTFT',
    'speed.ttftSub': 'Incl. reasoning',
    'speed.out': 'Last Output',
    'spark.total': 'Total Context',
    'spark.cache': 'Cache Read',
    'turns.title': 'Turns & Tool Timeline',
    'turns.cold.title': 'Latest user prompt triggered a cache cold start',
    'turns.view.steps': 'By Model Step',
    'turns.view.prompts': 'By Prompt',
    'common.all': 'All',
    'turns.filter.spike': 'Spike >5K',
    'turns.filter.tools': 'With Tools',
    'turns.filter.cold': 'Cold Start',
    'heavy.title': 'Top 10 Heavy Context Items',
    'compactions.title': 'Compaction History & Summaries',
    'breakdown.title': 'Server Context Breakdown (System / Tools / Messages)',
    'audit.title': 'Technical Audit & Attachments',
    'audit.reqSub': 'Latest Model Request Details',
    'audit.localSub': 'Full Session Archive · Local Heuristic',
    'audit.attSub': 'Attachments Audit',
    'audit.rescan': 'Rescan Files',
    'audit.finePrint': 'Note: Cumulative session totals include archived/compacted turns and do not equal the next prompt window size. Local token ranges are char/byte heuristics; images use dimensions & Gemini Vision tiles; unparsed binaries are marked unknown rather than 0. All scanning runs read-only locally.',
    'source.all': 'All Sources',
    'source.desktop': 'Desktop',
    'source.cli': 'CLI',
    'hist.exportCsv.title': 'Export anonymized CSV ledger for current source',
    'hist.exportJson.title': 'Export anonymized JSON ledger for current source',
    'kpi.total': 'Cumulative Tokens',
    'kpi.today': 'Today',
    'kpi.month': 'This Month',
    'kpi.year': 'This Year',
    'hist.trendTitle': 'Token Activity',
    'chart.hourly': '24h',
    'chart.daily': 'Daily',
    'chart.weekly': 'Weekly',
    'chart.monthly': 'Monthly',
    'chart.yearly': 'This Year',
    'chart.cumulative': 'Cumulative',
    'chart.custom': 'Custom',
    'heat.prev': '‹ Prev Year',
    'heat.next': 'Next Year ›',
    'hourly.today': 'Today',
    'hourly.yesterday': 'Yesterday',
    'custom.from': 'From',
    'custom.to': 'To',
    'custom.gran.auto': 'Auto',
    'custom.gran.day': 'Day',
    'custom.gran.week': 'Week',
    'custom.gran.month': 'Month',
    'custom.preset.7d': '7d',
    'custom.preset.30d': '30d',
    'custom.preset.90d': '90d',
    'custom.preset.mtd': 'MTD',
    'custom.preset.prevMonth': 'Last Mo',
    'custom.preset.all': 'All',
    'hist.inspectorHint': 'Click or hover any cell / bar to inspect input, cache, output & cost details',
    'rib.total': 'Period Total',
    'rib.cost': 'API Ref. Cost',
    'rib.daily': 'Calendar Avg',
    'rib.active': 'Active Day Avg',
    'rib.ratio': 'Plan Value',
    'hist.legendNote': 'Includes cache read tokens; click swatches to customize scale',
    'hist.less': 'Less',
    'hist.more': 'More',
    'diag.title': 'Anomaly & Shadow Routing Diagnostics',
    'diag.tab.events': 'Anomalies',
    'diag.tab.routing': 'Shadow Routing',
    'cost.planTitle': 'AI Subscription & Quota Pools',
    'cost.editPlan': 'Customize Plan ✎',
    'cost.quotaPoolsTitle': 'Live Model Quota Pools',
    'plan.formTitle': 'Edit Subscription & Paid Rate (saved locally in plugin dir only)',
    'plan.regionPreset': 'Region Reference Price',
    'plan.acquisition': 'Acquisition / Channel',
    'plan.accountCountry': 'Account Region (local note)',
    'plan.accountCountry.ph': 'e.g. United States (US)',
    'plan.acqName': 'Custom Channel Name (optional)',
    'plan.acqName.ph': 'e.g. Pixel Promo',
    'plan.priceMode': 'Pricing Mode',
    'plan.priceMode.preset': 'Follow region reference price',
    'plan.priceMode.custom': 'Custom paid amount',
    'plan.currencyPaid': 'Currency & Paid Amount',
    'plan.paid.ph': 'Amount',
    'plan.cycle': 'Billing Cycle',
    'plan.cycle.monthly': 'Monthly',
    'plan.cycle.annual': 'Annual (auto-amortized 1/12)',
    'plan.cycle.free': 'Free / Promo',
    'plan.validUntil': 'Valid Until (optional)',
    'plan.zeroExtra': 'No extra subscription fee during this promo period (count as 0)',
    'plan.note': 'Notes (optional)',
    'plan.note.ph': 'e.g. Family split / Student promo',
    'plan.clear': 'Clear Custom',
    'plan.cancel': 'Cancel',
    'plan.save': 'Save',
    'cost.refTitle': 'API Equivalent Reference',
    'cost.refChip': 'Retail API Est. · Not a Bill',
    'cost.scope.period': 'This Month',
    'cost.scope.allTime': 'All Time',
    'cost.modeLabel': 'Valuation',
    'cost.mode.hybrid': 'Hybrid Exact',
    'cost.mode.identified': 'Identified Only',
    'cost.mode.reference': 'Flash Baseline',
    'cost.dual.api': 'API Value',
    'cost.dual.sub': 'Plan Paid',
    'cost.cat.in': 'Input Tokens',
    'cost.cat.cache': 'Cache Read (Discounted)',
    'cost.cat.out': 'Output (Incl. Thinking)',
    'cost.modelBoard': 'Per-Model Usage & Value Breakdown',
    'cost.projBoard': 'Per-Project / Workspace Usage',
    'cost.projTop5': 'Top 5',
    'cost.projTop10': 'Top 10',
    'cost.finePrint': 'Note: API equivalent is estimated from public Google / Anthropic list prices (cache reads discounted; output includes thinking tokens) to gauge usage intensity. Flat-rate subscriptions differ from pay-as-you-go retail billing.'
  };

  function applyLanguageToDom() {
    if (typeof document === 'undefined' || !document.documentElement) return;
    const en = isEn();
    document.documentElement.setAttribute('lang', en ? 'en' : 'zh-CN');
    document.title = en ? 'Context & Token Viewer' : '上下文与 Token 看板';

    document.querySelectorAll?.('[data-i18n]')?.forEach((el) => {
      const key = el.dataset?.i18n || el.getAttribute?.('data-i18n');
      if (!key) return;
      if (el._cvZhText === undefined) el._cvZhText = el.textContent;
      el.textContent = en ? (I18N_EN[key] || el._cvZhText) : el._cvZhText;
    });
    document.querySelectorAll?.('[data-i18n-title]')?.forEach((el) => {
      const key = el.dataset?.i18nTitle || el.getAttribute?.('data-i18n-title');
      if (!key) return;
      if (el._cvZhTitle === undefined) {
        el._cvZhTitle = el.getAttribute?.('title') || el.dataset?.cvTip || el.title || '';
      }
      const next = en ? (I18N_EN[key] || el._cvZhTitle) : el._cvZhTitle;
      if (el.dataset && (el.dataset.cvTip !== undefined || state.customTooltipsReady)) {
        if (next) el.dataset.cvTip = next;
        else delete el.dataset.cvTip;
        el.removeAttribute?.('title');
      } else {
        el.title = next;
        el.setAttribute?.('title', next);
      }
    });
    document.querySelectorAll?.('[data-i18n-placeholder]')?.forEach((el) => {
      const key = el.dataset?.i18nPlaceholder || el.getAttribute?.('data-i18n-placeholder');
      if (!key) return;
      if (el._cvZhPlaceholder === undefined) el._cvZhPlaceholder = el.getAttribute?.('placeholder') ?? el.placeholder ?? '';
      const next = en ? (I18N_EN[key] || el._cvZhPlaceholder) : el._cvZhPlaceholder;
      el.placeholder = next;
      el.setAttribute?.('placeholder', next);
    });
  }

  let reducedMotionMql = null;
  let reducedMotionCached = false;
  function prefersReducedMotion() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    if (!reducedMotionMql) {
      try {
        reducedMotionMql = window.matchMedia('(prefers-reduced-motion: reduce)');
        reducedMotionCached = Boolean(reducedMotionMql?.matches);
        reducedMotionMql?.addEventListener?.('change', (ev) => {
          reducedMotionCached = Boolean(ev.matches);
        });
      } catch {
        reducedMotionCached = false;
      }
    }
    return Boolean(reducedMotionMql ? reducedMotionMql.matches : reducedMotionCached);
  }

  function setGpuBarRatio(el, pctVal) {
    if (!el || !el.style) return;
    const clamped = pctVal !== null && pctVal !== undefined && Number.isFinite(Number(pctVal))
      ? Math.min(100, Math.max(0, Number(pctVal)))
      : 0;
    const ratio = (clamped / 100).toFixed(4);
    el.style.width = `${clamped}%`;
    if (typeof el.style.setProperty === 'function') {
      el.style.setProperty('--cv-ratio', ratio);
    }
  }

  function tweenDisplayNumber(elId, targetNum, formatFn, key = elId) {
    const el = typeof elId === 'string' ? $(elId) : elId;
    if (!el) return;
    const handles = state.numTweenHandles || (state.numTweenHandles = {});
    const lastVals = state.numTweenLastValues || (state.numTweenLastValues = {});
    if (handles[key] && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(handles[key]);
      handles[key] = 0;
    }
    if (targetNum === null || targetNum === undefined || !Number.isFinite(Number(targetNum))) {
      delete lastVals[key];
      setText(el, formatFn(null));
      return;
    }
    const nextVal = Number(targetNum);
    const prevVal = lastVals[key];
    lastVals[key] = nextVal;
    const canAnimate = (
      typeof prevVal === 'number' &&
      Number.isFinite(prevVal) &&
      Math.abs(nextVal - prevVal) > 1e-4 &&
      !prefersReducedMotion() &&
      typeof document !== 'undefined' &&
      !document.hidden &&
      typeof requestAnimationFrame === 'function' &&
      typeof cancelAnimationFrame === 'function' &&
      typeof performance !== 'undefined' &&
      typeof performance.now === 'function'
    );
    if (!canAnimate) {
      setText(el, formatFn(nextVal));
      return;
    }
    const startTs = performance.now();
    const duration = 180;
    const step = (now) => {
      const t = Math.min(1, Math.max(0, (now - startTs) / duration));
      const eased = 1 - Math.pow(1 - t, 3);
      const cur = prevVal + (nextVal - prevVal) * eased;
      setText(el, formatFn(t >= 1 ? nextVal : cur));
      if (t < 1) {
        handles[key] = requestAnimationFrame(step);
      } else {
        handles[key] = 0;
      }
    };
    handles[key] = requestAnimationFrame(step);
  }

  function applySpectrumHoverState(catKey) {
    const bar = $('ctx-seg-bar');
    const leg = $('ctx-seg-legend');
    const active = Boolean(catKey);
    bar?.classList?.toggle('has-hover', active);
    leg?.classList?.toggle('has-hover', active);
    [bar, leg].forEach((container) => {
      container?.querySelectorAll?.('[data-cat-key]')?.forEach((node) => {
        node.classList?.toggle('is-highlighted', active && node.dataset?.catKey === catKey);
      });
    });
  }

  function showToast(msg, durationMs = 2400) {
    const el = $('toast');
    if (!el) return;
    setText(el, msg);
    el.classList.remove('hidden');
    el.setAttribute?.('aria-hidden', 'false');
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      el.classList.add('hidden');
      el.setAttribute?.('aria-hidden', 'true');
    }, durationMs);
  }

  // -------------------------------------------------------------------------
  // Host Theme & Palette Engine
  // -------------------------------------------------------------------------

  function resolveComputedLuminance(cssExpr) {
    if (!document.documentElement) return null;
    const probe = document.createElement('span');
    probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;color:${cssExpr}`;
    document.documentElement.appendChild(probe);
    const computed = getComputedStyle(probe).color || '';
    probe.remove();
    const nums = (computed.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return null;
    const scale = computed.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function detectHostDark() {
    const inlineBg = document.documentElement.style.getPropertyValue('--background').trim()
      || document.documentElement.style.getPropertyValue('--card').trim();
    if (inlineBg) {
      const lum = resolveComputedLuminance('var(--background, var(--card, #f6f7f9))');
      if (lum !== null) return lum < 0.5;
    }
    return Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  }

  function isEffectiveDark() {
    if (state.ui.themeMode === 'dark' || state.ui.themeMode === 'oled') return true;
    if (state.ui.themeMode === 'light') return false;
    return detectHostDark();
  }

  function setRootStyleVar(root, key, val) {
    if (root.style.getPropertyValue(key).trim() !== val) {
      root.style.setProperty(key, val);
    }
  }

  function triggerThemeTransition() {
    if (typeof document === 'undefined' || !document.documentElement?.classList || prefersReducedMotion()) return;
    const root = document.documentElement;
    root.classList.add('is-theme-switching');
    if (state.themeSwitchTimer) clearTimeout(state.themeSwitchTimer);
    state.themeSwitchTimer = setTimeout(() => {
      root.classList.remove('is-theme-switching');
      state.themeSwitchTimer = null;
    }, 200);
  }

  function applyAppearanceToDom({ animate = false } = {}) {
    if (typeof document === 'undefined' || !document.documentElement) return;
    if (animate) triggerThemeTransition();
    const root = document.documentElement;
    const dark = isEffectiveDark();

    if (root.getAttribute('data-theme') !== (dark ? 'dark' : 'light')) {
      root.setAttribute('data-theme', dark ? 'dark' : 'light');
    }
    if (state.ui.themeMode === 'light' || state.ui.themeMode === 'dark' || state.ui.themeMode === 'oled') {
      if (root.getAttribute('data-force-mode') !== state.ui.themeMode) {
        root.setAttribute('data-force-mode', state.ui.themeMode);
      }
    } else if (root.hasAttribute('data-force-mode')) {
      root.removeAttribute('data-force-mode');
    }

    const glassVal = state.ui.glass === false ? 'off' : 'on';
    if (root.getAttribute('data-glass') !== glassVal) {
      root.setAttribute('data-glass', glassVal);
    }

    const presetObj = HEAT_PRESETS[state.ui.preset] || HEAT_PRESETS.violet;
    const baseLevels = dark ? presetObj.dark : presetObj.light;
    const levels = Array.isArray(state.ui.customLevels) && state.ui.customLevels.length === 5
      ? state.ui.customLevels
      : baseLevels;
    const accent = state.ui.customAccent || (dark ? presetObj.accentDark : presetObj.accentLight);

    for (let i = 0; i < 5; i++) {
      setRootStyleVar(root, `--heat-${i}`, levels[i]);
      const picker = $(`col-lvl${i}`);
      if (picker && /^#[0-9a-f]{6}$/i.test(levels[i])) {
        picker.value = levels[i];
      }
    }
    setRootStyleVar(root, '--user-accent', accent);
    const accentPicker = $('col-accent');
    if (accentPicker && /^#[0-9a-f]{6}$/i.test(accent)) {
      accentPicker.value = accent;
    }

    // Update theme, glass & language buttons + icon
    document.querySelectorAll('#theme-seg .seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.themeMode === state.ui.themeMode);
    });
    document.querySelectorAll('#glass-seg .seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.glassMode === glassVal);
    });
    const langVal = isEn() ? 'en' : 'zh';
    document.querySelectorAll('#lang-seg .seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.langMode === langVal);
    });
    document.querySelectorAll('#heat-presets .preset-chip').forEach((chip) => {
      const active = !state.ui.customLevels && chip.dataset.preset === state.ui.preset;
      chip.classList.toggle('active', active);
    });

    const icTheme = $('ic-theme');
    const btnTheme = $('btn-theme');
    if (icTheme) {
      if (icTheme.classList?.contains('theme-ic-stack')) {
        if (icTheme.dataset) icTheme.dataset.themeIcon = state.ui.themeMode || 'auto';
        icTheme.setAttribute?.('data-theme-icon', state.ui.themeMode || 'auto');
      } else if (state.ui.themeMode === 'light') {
        icTheme.innerHTML = '<circle cx="8" cy="8" r="3.3"/><path d="M8 1.6v1.8M8 12.6v1.8M1.6 8h1.8M12.6 8h1.8M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3"/>';
      } else if (state.ui.themeMode === 'dark') {
        icTheme.innerHTML = '<path d="M8.4 2.1a5.8 5.8 0 1 0 5.5 7.5A4.6 4.6 0 0 1 8.4 2.1Z"/>';
      } else if (state.ui.themeMode === 'oled') {
        icTheme.innerHTML = '<circle cx="8" cy="8" r="5.8"/><circle cx="8" cy="8" r="3.4" class="fill"/>';
      } else {
        icTheme.innerHTML = '<circle cx="8" cy="8" r="5.8"/><path d="M8 2.2v11.6A5.8 5.8 0 0 0 8 2.2Z" class="fill"/>';
      }
    }
    if (btnTheme) {
      const tipMap = isEn()
        ? {
            auto: `Theme: Follow host (${dark ? 'Dark' : 'Light'} detected — click for Light)`,
            light: 'Theme: Light (click for Dark)',
            dark: 'Theme: Dark (click for OLED Pure Black)',
            oled: 'Theme: OLED Pure Black (click for Follow host)'
          }
        : {
            auto: `当前：跟随宿主主题（已识别为${dark ? '深色' : '浅色'}，点击切换为固定浅色）`,
            light: '当前：固定浅色主题（点击切换为固定深色）',
            dark: '当前：固定深色主题（点击切换为 OLED 纯黑）',
            oled: '当前：OLED 纯黑主题（点击切换回跟随宿主主题）'
          };
      const tip = tipMap[state.ui.themeMode] || tipMap.auto;
      setElTooltip(btnTheme, tip);
      btnTheme.setAttribute?.('aria-label', tip);
    }

    applyLanguageToDom();
    if (typeof syncAllSegIndicators === 'function') {
      syncAllSegIndicators({ animate: false });
    }
  }

  async function persistUiPreferences() {
    try {
      await apiFetch('/api/settings', {
        method: 'POST',
        body: {
          uiPreferences: {
            themeMode: state.ui.themeMode,
            glass: state.ui.glass !== false,
            lang: isEn() ? 'en' : 'zh',
            preset: state.ui.preset,
            customLevels: state.ui.customLevels,
            customAccent: state.ui.customAccent
          }
        }
      });
    } catch {}
  }

  // -------------------------------------------------------------------------
  // Sidecar API Client
  // -------------------------------------------------------------------------

  function getCsrfToken() {
    const el = typeof document !== 'undefined' ? document.querySelector('meta[name="cv-csrf-token"]') : null;
    return el ? (el.getAttribute('content') || '') : '';
  }

  async function apiFetch(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = { ...(options.headers || {}) };
    let body = options.body;
    if (method !== 'GET' && method !== 'HEAD') {
      const csrfToken = getCsrfToken();
      if (csrfToken && !headers['X-CV-Token']) {
        headers['X-CV-Token'] = csrfToken;
      }
      if (body === undefined) {
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
        body = '{}';
      } else if (body && typeof body === 'object') {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(body);
      }
    } else if (body && typeof body === 'object') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const fetcher = window.sidecar?.fetch
      ? window.sidecar.fetch.bind(window.sidecar)
      : window.fetch.bind(window);
    const fetchInit = { method, headers, body };
    if (options.signal) {
      fetchInit.signal = options.signal;
    }
    const res = await fetcher(path, fetchInit);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
  }

  const CONTEXT_INFLIGHT_STALE_MS = 25000;

  function beginSessionSwitchVisual() {
    if (state.sessionSwitchTimer) clearTimeout(state.sessionSwitchTimer);
    state.sessionSwitchTimer = setTimeout(() => {
      state.sessionSwitchTimer = null;
      document.querySelector?.('.viewport')?.classList?.add('is-switching');
      document.body?.classList?.add('is-session-switching');
    }, 120);
  }

  function endSessionSwitchVisual() {
    if (state.sessionSwitchTimer) {
      clearTimeout(state.sessionSwitchTimer);
      state.sessionSwitchTimer = null;
    }
    document.querySelector?.('.viewport')?.classList?.remove('is-switching');
    document.body?.classList?.remove('is-session-switching');
  }

  async function loadContext(force = false, opts = {}) {
    const syncLiveHost = () => {
      const liveHostId = window.sidecar?.conversationId || '';
      if (liveHostId && liveHostId !== state.hostConvId) {
        state.hostConvId = liveHostId;
        if (!state.selectedConvId) {
          state.contextEtag = '';
          state.contextEtagConv = '';
        }
      }
    };

    syncLiveHost();
    const targetConv = state.selectedConvId || state.hostConvId || '';
    const nowMs = Date.now();
    const inFlightStale = Boolean(
      state.contextInFlight &&
      state.contextInFlightSince > 0 &&
      (nowMs - state.contextInFlightSince > CONTEXT_INFLIGHT_STALE_MS)
    );
    const switchingConv = (state.contextInFlightConv || '') !== targetConv;
    const showSwitchVisual = Boolean(opts.showSwitchIndicator || (state.contextData && targetConv && state.contextData.conversationId && state.contextData.conversationId !== targetConv));

    if (!force && !inFlightStale && state.contextInFlight && !switchingConv) {
      return;
    }
    if (state.contextAbortCtrl && (force || inFlightStale || switchingConv)) {
      try { state.contextAbortCtrl.abort(); } catch {}
      state.contextAbortCtrl = null;
    }
    if (state.contextEtagConv !== targetConv) {
      state.contextEtag = '';
      state.contextEtagConv = targetConv;
    }

    const reqSeq = ++state.contextReqSeq;
    const pinSeqAtStart = state.pinSyncSeq;
    const abortCtrl = typeof AbortController === 'function' ? new AbortController() : null;
    state.contextAbortCtrl = abortCtrl;
    state.contextInFlight = true;
    state.contextInFlightConv = targetConv;
    state.contextInFlightSince = nowMs;
    if (showSwitchVisual) beginSessionSwitchVisual();
    const qs = new URLSearchParams();
    if (targetConv) qs.set('conversationId', targetConv);
    if (force) qs.set('force', '1');
    else if (state.contextEtag) qs.set('etag', state.contextEtag);

    try {
      const snap = await apiFetch(
        `/api/context?${qs.toString()}`,
        abortCtrl ? { signal: abortCtrl.signal } : {}
      );
      syncLiveHost();
      const activeTarget = state.selectedConvId || state.hostConvId || '';
      if (reqSeq !== state.contextReqSeq || targetConv !== activeTarget) {
        return;
      }

      let needReconcileRefetch = false;
      let expiredUnpinned = false;
      if (snap && snap.pinnedConvId !== undefined && !state.pinSyncPending && pinSeqAtStart === state.pinSyncSeq) {
        const backendPinned = typeof snap.pinnedConvId === 'string' ? snap.pinnedConvId.trim() : '';
        if (!backendPinned && state.selectedConvId) {
          state.selectedConvId = '';
          state.contextEtag = '';
          state.contextEtagConv = state.hostConvId || '';
          expiredUnpinned = true;
          needReconcileRefetch = Boolean(
            snap.unchanged || !snap.ok || (snap.conversationId && snap.conversationId === targetConv)
          );
        } else if (backendPinned && !state.hostConvId && state.selectedConvId !== backendPinned) {
          state.selectedConvId = backendPinned;
          state.contextEtag = '';
          state.contextEtagConv = backendPinned;
          needReconcileRefetch = Boolean(
            snap.unchanged || !snap.ok || snap.conversationId !== backendPinned
          );
        }
      }

      if (expiredUnpinned) {
        showToast(tr('原会话已结束，已切回当前会话', 'Session ended · Following active'), 2600);
      }

      if (snap?.recentConversations) {
        renderConversationPicker(snap.recentConversations, snap.conversationId);
      } else if (needReconcileRefetch) {
        renderConversationPicker(state.recentConversations, snap?.conversationId || state.activeConvId);
      }

      if (needReconcileRefetch) {
        setTimeout(() => loadContext(true).catch(() => {}), 0);
        return;
      }

      const expectedConv = state.selectedConvId || state.hostConvId || snap?.conversationId || '';
      if (
        snap?.unchanged &&
        state.contextData &&
        (!expectedConv || state.contextData.conversationId === expectedConv)
      ) {
        return;
      }
      if (snap?.ok) {
        const prevConvId = state.contextData?.conversationId || '';
        if (
          prevConvId &&
          snap.conversationId &&
          prevConvId !== snap.conversationId &&
          !state.capPopover?.pinned &&
          typeof closeCapPopover === 'function'
        ) {
          closeCapPopover();
        }
        state.contextEtag = snap.etag || '';
        state.contextEtagConv = state.selectedConvId || state.hostConvId || '';
        state.contextData = snap;
        renderConversationPicker(snap.recentConversations || state.recentConversations, snap.conversationId);
        renderContextPanel(snap);
        renderTopCapsules();
      }
    } catch (err) {
      if (err?.name === 'AbortError') {
        return;
      }
      throw err;
    } finally {
      if (reqSeq === state.contextReqSeq) {
        state.contextInFlight = false;
        state.contextInFlightConv = '';
        state.contextInFlightSince = 0;
        if (state.contextAbortCtrl === abortCtrl) {
          state.contextAbortCtrl = null;
        }
        endSessionSwitchVisual();
      }
    }
  }

  async function loadHistory(force = false) {
    if (!force && state.historyInFlight) return;
    const reqSeq = ++state.historyReqSeq;
    state.historyInFlight = true;
    const qs = new URLSearchParams();
    if (force) qs.set('force', '1');
    else if (state.historyEtag) qs.set('etag', state.historyEtag);

    try {
      const hist = await apiFetch(`/api/history?${qs.toString()}`);
      if (reqSeq !== state.historyReqSeq) {
        return;
      }
      if (hist?.unchanged && state.historyData) {
        return;
      }
      if (hist?.ok) {
        state.historyEtag = hist.etag || '';
        state.historyData = hist;
        populatePlanPresetsIfNeeded(hist.presets);
        renderHistoryPanel(hist);
        renderCostPanel(hist);
        renderTopCapsules();
      }
    } finally {
      if (reqSeq === state.historyReqSeq) {
        state.historyInFlight = false;
      }
    }
  }

  async function loadInitialSettings() {
    try {
      const s = await apiFetch('/api/settings');
      if (!s?.ok) return;
      state.settingsData = s;
      const prefs = s.uiPreferences || {};
      const prevLang = state.ui.lang;
      if (prefs.themeMode && ['auto', 'light', 'dark', 'oled'].includes(prefs.themeMode)) {
        state.ui.themeMode = prefs.themeMode;
      }
      if (typeof prefs.glass === 'boolean') {
        state.ui.glass = prefs.glass;
      }
      if (prefs.lang && ['zh', 'en'].includes(prefs.lang)) {
        state.ui.lang = prefs.lang;
      }
      if (prefs.preset && HEAT_PRESETS[prefs.preset]) {
        state.ui.preset = prefs.preset;
      }
      if (Array.isArray(prefs.customLevels) && prefs.customLevels.length === 5) {
        state.ui.customLevels = prefs.customLevels;
      }
      if (typeof prefs.customAccent === 'string') {
        state.ui.customAccent = prefs.customAccent;
      }
      if (typeof s.entrypoints?.sidebarEnabled === 'boolean') {
        state.sidebarEntryEnabled = s.entrypoints.sidebarEnabled;
      }
      if (s.entrypoints?.shortcut && typeof s.entrypoints.shortcut === 'object') {
        state.shortcut = { ...state.shortcut, ...s.entrypoints.shortcut };
      }
      const persistedPinned = typeof s.entrypoints?.pinnedConvId === 'string'
        ? s.entrypoints.pinnedConvId.trim()
        : '';
      if (
        persistedPinned &&
        !state.hostConvId &&
        !state.selectedConvId &&
        !state.pinSyncPending &&
        !state.userModifiedConvSelection
      ) {
        state.selectedConvId = persistedPinned;
        state.contextEtag = '';
        state.contextEtagConv = persistedPinned;
        renderConversationPicker(state.recentConversations, state.activeConvId || persistedPinned);
        if (
          (state.contextData && state.contextData.conversationId !== persistedPinned) ||
          (state.contextInFlight && state.contextInFlightConv !== persistedPinned)
        ) {
          loadContext(true).catch(() => {});
        }
      }
      applyAppearanceToDom();
      syncFloatButtonUi();
      populatePlanPresetsIfNeeded(s.presets);
      syncPlanFormInputs(s.planStatus, s.customPlan);
      if (state.ui.lang !== prevLang) {
        state.convPicker.lastTriggerSig = '';
        state.convPicker.lastSelectSig = '';
        state.convPicker.lastPillsSig = '';
        state.convPicker.lastBodySig = '';
        if (state.recentConversations?.length) {
          renderConversationPicker(state.recentConversations, state.activeConvId);
        }
        if (state.historyData) {
          renderHistoryPanel(state.historyData);
          renderCostPanel(state.historyData);
        }
      }
      if (state.contextData) {
        renderContextPanel(state.contextData);
        renderTopCapsules();
      }
    } catch {}
  }

  // -------------------------------------------------------------------------
  // Top Capsules & Conversation Switcher
  // -------------------------------------------------------------------------

  function isKnownPct(val) {
    return typeof val === 'number' && Number.isFinite(val);
  }

  function extractQuotaParts(obj) {
    if (!obj) {
      return {
        p5: null,
        pBase: null,
        pW: null,
        r5: '',
        rBase: '',
        rW: '',
        rAny: '',
        primaryResetTime: null
      };
    }
    const p5 = isKnownPct(obj.fiveHour?.remainingPercent) ? obj.fiveHour.remainingPercent : null;
    const rawBase = isKnownPct(obj.baseRemainingPercent)
      ? obj.baseRemainingPercent
      : (p5 === null && isKnownPct(obj.remainingPercent) ? obj.remainingPercent : null);
    const pBase = p5 === null ? rawBase : null;
    const pW = isKnownPct(obj.weekly?.remainingPercent) ? obj.weekly.remainingPercent : null;
    const r5 = obj.fiveHour?.resetTimeZh || '';
    const rBase = obj.baseResetTimeZh || (!obj.fiveHour ? obj.resetTimeZh : '') || '';
    const rW = obj.weekly?.resetTimeZh || '';
    const rAny = r5 || rW || rBase || obj.resetTimeZh || '';
    const primaryResetTime = obj.fiveHour?.resetTime || obj.weekly?.resetTime || obj.baseResetTime || obj.resetTime || null;
    return { p5, pBase, pW, r5, rBase, rW, rAny, primaryResetTime };
  }

  function fmtSyncClock(isoStr) {
    if (!isoStr) return '';
    const dt = new Date(isoStr);
    if (Number.isNaN(dt.getTime())) return '';
    const now = new Date();
    const hh = String(dt.getHours()).padStart(2, '0');
    const mm = String(dt.getMinutes()).padStart(2, '0');
    const sameDay = dt.getFullYear() === now.getFullYear() &&
      dt.getMonth() === now.getMonth() &&
      dt.getDate() === now.getDate();
    if (sameDay) return `${hh}:${mm}`;
    const mo = String(dt.getMonth() + 1).padStart(2, '0');
    const da = String(dt.getDate()).padStart(2, '0');
    return `${mo}-${da} ${hh}:${mm}`;
  }

  function computeEffectiveWindow(ctx = {}) {
    const rawServerBudget = Number(ctx?.budget);
    const serverBudget = Number.isFinite(rawServerBudget) && rawServerBudget > 0 ? rawServerBudget : null;
    const budget = serverBudget;
    const budgetSource = serverBudget ? (ctx?.budgetSource || 'server') : 'unknown';
    const used = typeof ctx?.used === 'number' && Number.isFinite(ctx.used) ? ctx.used : null;
    const pct = used !== null && budget !== null && budget > 0
      ? Number(((used / budget) * 100).toFixed(1))
      : null;
    const remaining = used !== null && budget !== null && budget > 0
      ? Math.max(0, budget - used)
      : null;
    return {
      budget,
      serverBudget,
      budgetSource,
      used,
      pct,
      serverPct: pct,
      remaining,
      serverRemaining: remaining
    };
  }

  function renderTopCapsules() {
    const ctx = state.contextData?.context;
    const spd = state.contextData?.speed;
    const hist = state.historyData;

    const win = computeEffectiveWindow(ctx);
    const pct = win.pct;
    const healthPct = win.serverBudget ? win.serverPct : pct;
    if (pct !== null) {
      tweenDisplayNumber('cap-ctx-pct', pct, (v) => (v !== null ? `${v.toFixed(0)}%` : '--%'), 'cap-ctx-pct');
    } else {
      tweenDisplayNumber('cap-ctx-pct', null, () => (win.used !== null ? fmtTokens(win.used) : '--%'), 'cap-ctx-pct');
    }

    const miniRing = $('mini-ring-fill');
    if (miniRing) {
      const circum = 45.24; // 2 * PI * 7.2
      const ratio = pct !== null ? Math.min(1, Math.max(0, pct / 100)) : 0;
      const offset = circum * (1 - ratio);
      miniRing.setAttribute('stroke-dasharray', `${circum}`);
      miniRing.setAttribute('stroke-dashoffset', `${offset.toFixed(2)}`);
      miniRing.style.stroke = resolveHealthStroke(healthPct, ctx?.error?.kind);
    }

    const tps = spd?.tps ?? spd?.streamingTps ?? null;
    tweenDisplayNumber(
      'cap-speed-val',
      tps !== null && Number.isFinite(Number(tps)) ? Number(tps) : null,
      (v) => (v !== null ? `${Number(v).toFixed(Number.isInteger(Number(tps)) ? 0 : 1)} tok/s` : '-- tok/s'),
      'cap-speed-val'
    );

    const srcSummary = hist?.analyticsBySource?.[state.sourceFilter]?.summary
      || hist?.analyticsBySource?.all?.summary;
    setText('cap-tok-val', srcSummary ? fmtTokens(srcSummary.grandTotalTokens) : '--');
    if (typeof refreshOpenCapPopover === 'function') refreshOpenCapPopover();
  }

  function resolveHealthStroke(pct, errKind) {
    if (errKind && errKind !== 'none' && errKind !== 'canceled') return 'var(--danger)';
    if (pct !== null && pct >= 90) return 'var(--danger)';
    if (pct !== null && pct >= 75) return 'var(--warn)';
    return 'var(--cv-accent)';
  }

  const CONV_COLLAPSE_STORAGE_KEY = 'cv_project_collapse_v1';
  const UNCATEGORIZED_PROJECT = '未归类工作区';

  function loadProjectCollapsePrefs() {
    if (state.convPicker.collapsePrefs) return state.convPicker.collapsePrefs;
    let parsed = {};
    try {
      const raw = window.localStorage?.getItem(CONV_COLLAPSE_STORAGE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          parsed = obj;
        }
      }
    } catch {}
    state.convPicker.collapsePrefs = parsed;
    return parsed;
  }

  function saveProjectCollapsePrefs(prefs) {
    state.convPicker.collapsePrefs = prefs;
    try {
      window.localStorage?.setItem(CONV_COLLAPSE_STORAGE_KEY, JSON.stringify(prefs));
    } catch {}
  }

  function getItemProjectName(item) {
    const raw = item?.projectName ? String(item.projectName).trim() : '';
    return raw || UNCATEGORIZED_PROJECT;
  }

  function truncateLabel(raw, maxLen = 22) {
    const str = String(raw || '').trim();
    if (!str) return '';
    return str.length > maxLen ? `${str.slice(0, maxLen - 1)}…` : str;
  }

  function fmtRelativeTime(tsMs, nowMs = Date.now()) {
    const t = Number(tsMs || 0);
    if (!Number.isFinite(t) || t <= 0) return tr('未知时间', 'Unknown');
    const diff = Math.max(0, nowMs - t);
    if (diff < 45_000) return tr('刚刚', 'Just now');
    if (diff < 3_600_000) {
      const m = Math.floor(diff / 60_000);
      return isEn() ? `${m}m ago` : `${m} 分钟前`;
    }
    if (diff < 86_400_000) {
      const h = Math.floor(diff / 3_600_000);
      return isEn() ? `${h}h ago` : `${h} 小时前`;
    }
    if (diff < 30 * 86_400_000) {
      const d = Math.floor(diff / 86_400_000);
      return isEn() ? `${d}d ago` : `${d} 天前`;
    }
    const dt = new Date(t);
    const mo = String(dt.getMonth() + 1).padStart(2, '0');
    const da = String(dt.getDate()).padStart(2, '0');
    return `${mo}-${da}`;
  }

  function buildGroupedConversations(list = [], activeId = '') {
    const displayConvId = state.selectedConvId || activeId || state.activeConvId || state.contextData?.conversationId || '';
    const groupsMap = new Map();
    let activeItem = null;

    for (const item of list) {
      if (!item || !item.id) continue;
      if (item.id === displayConvId) activeItem = item;
      const projName = getItemProjectName(item);
      if (!groupsMap.has(projName)) {
        groupsMap.set(projName, []);
      }
      groupsMap.get(projName).push(item);
    }

    let currentActiveProject = activeItem ? getItemProjectName(activeItem) : '';
    if (!currentActiveProject && state.contextData) {
      const ctxRepoName = state.contextData?.repoInfo?.name ? String(state.contextData.repoInfo.name).trim() : '';
      currentActiveProject = ctxRepoName || UNCATEGORIZED_PROJECT;
    }

    const groups = [];
    for (const [name, items] of groupsMap.entries()) {
      items.sort((a, b) => Number(b.effectiveActiveMs || b.updatedAtMs || 0) - Number(a.effectiveActiveMs || a.updatedAtMs || 0));
      let maxActiveMs = 0;
      for (const it of items) {
        const ts = Number(it.effectiveActiveMs || it.updatedAtMs || 0);
        if (ts > maxActiveMs) maxActiveMs = ts;
      }
      groups.push({
        name,
        items,
        maxActiveMs,
        hasActive: items.some((it) => it.id === displayConvId)
      });
    }

    groups.sort((a, b) => {
      const aUncat = a.name === UNCATEGORIZED_PROJECT;
      const bUncat = b.name === UNCATEGORIZED_PROJECT;
      if (aUncat !== bUncat) return aUncat ? 1 : -1;
      if (b.maxActiveMs !== a.maxActiveMs) return b.maxActiveMs - a.maxActiveMs;
      return a.name.localeCompare(b.name, 'zh-CN');
    });

    return {
      groups,
      displayConvId,
      currentActiveProject,
      firstProject: groups[0]?.name || ''
    };
  }

  function positionConvPopover() {
    const pop = $('conv-popover');
    const wrap = $('conv-dropdown');
    if (!pop || !wrap || pop.classList.contains('hidden')) return;
    pop.classList.remove('align-left');
    const wrapRect = wrap.getBoundingClientRect();
    const popWidth = Math.min(340, Math.max(200, window.innerWidth - 24));
    if (wrapRect.right - popWidth < 12 && wrapRect.left + popWidth <= window.innerWidth - 12) {
      pop.classList.add('align-left');
    }
  }

  function openConvPopover() {
    const pop = $('conv-popover');
    const trigger = $('conv-picker-trigger');
    if (!pop || !trigger) return;
    state.convPicker.open = true;
    pop.classList.remove('hidden');
    pop.setAttribute?.('aria-hidden', 'false');
    if ('inert' in pop) pop.inert = false;
    trigger.setAttribute('aria-expanded', 'true');
    renderConvPopoverPills(true);
    renderConvPopoverBody(true);
    positionConvPopover();
    const searchInput = $('conv-search-input');
    if (searchInput) {
      try { searchInput.focus({ preventScroll: true }); } catch {}
    }
  }

  function closeConvPopover({ restoreFocus = false } = {}) {
    const pop = $('conv-popover');
    const trigger = $('conv-picker-trigger');
    state.convPicker.open = false;
    if (pop) {
      pop.classList.add('hidden');
      pop.setAttribute?.('aria-hidden', 'true');
      if ('inert' in pop) pop.inert = true;
    }
    if (trigger) {
      trigger.setAttribute('aria-expanded', 'false');
      if (restoreFocus) {
        try { trigger.focus({ preventScroll: true }); } catch {}
      }
    }
  }

  function displayProjName(rawName) {
    return rawName === UNCATEGORIZED_PROJECT ? tr(UNCATEGORIZED_PROJECT, 'Uncategorized') : rawName;
  }

  function syncConvTriggerAndSelect(list = [], activeId = '') {
    const sel = $('conv-select');
    const followBtn = $('btn-follow-current');
    const trigger = $('conv-picker-trigger');
    const triggerLabel = $('conv-trigger-label');
    const pinnedId = state.selectedConvId || '';

    if (followBtn) followBtn.classList.toggle('hidden', !pinnedId);
    if (trigger) trigger.classList.toggle('is-pinned', Boolean(pinnedId));

    const effectiveActiveId = activeId || state.activeConvId || state.contextData?.conversationId || '';
    const activeItem = effectiveActiveId ? list.find((c) => c.id === effectiveActiveId) : null;
    const pinnedItem = pinnedId ? list.find((c) => c.id === pinnedId) : null;

    let labelText = tr('自动跟随当前对话', 'Auto-follow active session');
    let titleText = tr(
      '默认自动跟随当前活跃对话，点击可按项目分组筛选并切换会话',
      'Auto-follows active session by default; click to filter by project or switch session'
    );
    if (pinnedId) {
      const projName = pinnedItem
        ? displayProjName(getItemProjectName(pinnedItem))
        : (state.contextData?.conversationId === pinnedId && state.contextData?.repoInfo?.name
          ? String(state.contextData.repoInfo.name).trim()
          : tr('会话', 'Session'));
      const fullTitle = pinnedItem?.title || pinnedItem?.annTitle
        || (state.contextData?.conversationId === pinnedId ? state.contextData?.conversationTitle : '')
        || pinnedId.slice(0, 8);
      labelText = `[${projName}] ${truncateLabel(fullTitle, 20)}`;
      titleText = tr(`已固定查看：[${projName}] ${fullTitle}`, `Pinned: [${projName}] ${fullTitle}`);
    } else {
      const fullTitle = activeItem?.title || activeItem?.annTitle || state.contextData?.conversationTitle || '';
      if (fullTitle) {
        labelText = tr(`自动跟随 · ${truncateLabel(fullTitle, 18)}`, `Auto · ${truncateLabel(fullTitle, 18)}`);
        titleText = tr(`自动跟随当前对话：${fullTitle}`, `Auto-following active session: ${fullTitle}`);
      }
    }

    const triggerSig = `${isEn() ? 'en' : 'zh'}|${pinnedId}|${labelText}|${titleText}`;
    if (triggerSig !== state.convPicker.lastTriggerSig) {
      state.convPicker.lastTriggerSig = triggerSig;
      if (triggerLabel) setText(triggerLabel, labelText);
      if (trigger) setElTooltip(trigger, titleText);
    }

    if (!sel) return;
    const selectSig = [
      isEn() ? 'en' : 'zh',
      pinnedId,
      effectiveActiveId,
      ...list.map((c) => `${c.id}:${c.source || ''}:${c.title || ''}:${c.lastContextTokens || 0}`)
    ].join('\u0001');
    if (selectSig !== state.convPicker.lastSelectSig) {
      state.convPicker.lastSelectSig = selectSig;
      const optionsHtml = [`<option value="">${escZh(tr('自动跟随当前对话', 'Auto-follow active session'))}</option>`];
      let hasPinnedInList = !pinnedId;
      for (const item of list) {
        if (pinnedId && item.id === pinnedId) hasPinnedInList = true;
        const tag = item.source === 'cli' ? '[CLI] ' : '';
        const shortTitle = String(item.title || item.id.slice(0, 8)).slice(0, 22);
        const tokBadge = item.lastContextTokens > 0 ? ` · ${fmtTokens(item.lastContextTokens, 0)}` : '';
        const isCurrentAuto = !pinnedId && item.id === effectiveActiveId;
        const suffix = isCurrentAuto ? tr('（当前）', ' (Active)') : '';
        optionsHtml.push(
          `<option value="${esc(item.id)}">${escZh(`${tag}${shortTitle}${tokBadge}${suffix}`)}</option>`
        );
      }
      if (pinnedId && !hasPinnedInList) {
        optionsHtml.push(
          `<option value="${esc(pinnedId)}">${escZh(`${tr('[已固定]', '[Pinned]')} ${pinnedId.slice(0, 8)}`)}</option>`
        );
      }
      sel.innerHTML = optionsHtml.join('');
    }
    if (sel.value !== pinnedId) {
      sel.value = pinnedId;
    }
  }

  function renderConvPopoverPills(forceRender = false) {
    const pillsEl = $('conv-project-pills');
    if (!pillsEl) return;
    const list = state.recentConversations || [];
    const { groups, currentActiveProject } = buildGroupedConversations(list, state.activeConvId);

    const curProjGroup = currentActiveProject
      ? groups.find((g) => g.name === currentActiveProject)
      : null;
    const namedGroups = groups.filter((g) => g.name !== UNCATEGORIZED_PROJECT);

    if (
      state.convPicker.projectFilter.startsWith('proj:') &&
      !namedGroups.some((g) => `proj:${g.name}` === state.convPicker.projectFilter)
    ) {
      state.convPicker.projectFilter = '__all__';
    }

    const pills = [
      { key: '__all__', label: tr('全部', 'All'), count: list.length }
    ];
    if (curProjGroup) {
      pills.push({
        key: '__current__',
        label: tr('当前项目', 'Current'),
        count: curProjGroup.items.length,
        title: displayProjName(currentActiveProject)
      });
    }
    for (const g of namedGroups) {
      pills.push({ key: `proj:${g.name}`, label: g.name, count: g.items.length, title: g.name });
    }

    const pillsSig = `${isEn() ? 'en' : 'zh'}|${state.convPicker.projectFilter}|${pills.map((p) => `${p.key}:${p.count}`).join('\u0001')}`;
    if (!forceRender && pillsSig === state.convPicker.lastPillsSig) return;
    state.convPicker.lastPillsSig = pillsSig;

    const prevScrollLeft = pillsEl.scrollLeft;
    pillsEl.innerHTML = pills.map((p) => {
      const active = state.convPicker.projectFilter === p.key;
      const tipAttr = p.title ? ` title="${escZh(p.title)}"` : '';
      return (
        `<button type="button" role="tab" aria-selected="${active ? 'true' : 'false'}" ` +
        `class="conv-proj-pill${active ? ' active' : ''}" data-proj-filter="${esc(p.key)}"${tipAttr}>` +
        `<span class="conv-proj-pill-name">${escZh(p.label)}</span>` +
        `<span class="conv-proj-pill-cnt">${esc(p.count)}</span>` +
        `</button>`
      );
    }).join('');
    pillsEl.scrollLeft = prevScrollLeft;
  }

  function renderConvPopoverBody(forceRender = false) {
    const bodyEl = $('conv-pop-body');
    if (!bodyEl) return;
    const list = state.recentConversations || [];
    const {
      groups,
      displayConvId,
      currentActiveProject,
      firstProject
    } = buildGroupedConversations(list, state.activeConvId);

    const q = state.convPicker.search.trim().toLowerCase();
    const projFilter = state.convPicker.projectFilter;
    const forceExpandAll = Boolean(q) || projFilter !== '__all__';
    const prefs = loadProjectCollapsePrefs();
    const nowMs = Date.now();
    const minuteBucket = Math.floor(nowMs / 60_000);

    const filteredGroups = [];
    for (const g of groups) {
      if (projFilter === '__current__' && g.name !== currentActiveProject) continue;
      if (projFilter.startsWith('proj:') && g.name !== projFilter.slice(5)) continue;

      const matchedItems = q
        ? g.items.filter((item) => {
            const title = String(item.title || '').toLowerCase();
            const annTitle = String(item.annTitle || '').toLowerCase();
            const shortId = String(item.shortId || item.id || '').toLowerCase();
            const repoLabel = String(item.repoLabel || '').toLowerCase();
            const proj = g.name.toLowerCase();
            return (
              title.includes(q) ||
              annTitle.includes(q) ||
              shortId.includes(q) ||
              repoLabel.includes(q) ||
              proj.includes(q)
            );
          })
        : g.items;

      if (matchedItems.length) {
        const isExpanded = forceExpandAll
          ? true
          : (typeof prefs[g.name] === 'boolean'
            ? !prefs[g.name]
            : (g.name === currentActiveProject || g.name === firstProject));
        filteredGroups.push({
          ...g,
          items: matchedItems,
          expanded: isExpanded
        });
      }
    }

    const activePreviewId = state.activeConvId || state.contextData?.conversationId || '';
    const activePreviewItem = activePreviewId ? list.find((c) => c.id === activePreviewId) : null;
    const autoPreviewTitle = activePreviewItem?.title
      || activePreviewItem?.annTitle
      || state.contextData?.conversationTitle
      || tr('正在检测当前活跃对话…', 'Detecting active session…');
    const autoPreviewSource = activePreviewItem?.source || '';

    const bodySig = [
      isEn() ? 'en' : 'zh',
      state.selectedConvId || '',
      displayConvId,
      q,
      projFilter,
      minuteBucket,
      autoPreviewTitle,
      autoPreviewSource,
      ...filteredGroups.map((g) => (
        `${g.name}:${g.expanded ? 1 : 0}:${g.hasActive ? 1 : 0}:` +
        g.items.map((it) => `${it.id}:${it.title || ''}:${it.source || ''}:${it.isRunning ? 1 : 0}:${it.lastContextTokens || 0}:${it.turnsCount || 0}:${it.effectiveActiveMs || it.updatedAtMs || 0}`).join(',')
      ))
    ].join('\u0001');

    if (!forceRender && bodySig === state.convPicker.lastBodySig) return;
    state.convPicker.lastBodySig = bodySig;

    const prevScrollTop = bodyEl.scrollTop;
    const isAutoSelected = !state.selectedConvId;
    const autoSourceTag = autoPreviewSource === 'cli'
      ? `<span class="conv-src-tag cli">CLI</span>`
      : (autoPreviewSource ? `<span class="conv-src-tag">${escZh(tr('桌面端', 'Desktop'))}</span>` : '');
    const autoCurBadge = isAutoSelected ? `<span class="conv-cur-badge">${escZh(tr('当前', 'Active'))}</span>` : '';

    const htmlParts = [
      `<button type="button" class="conv-auto-row${isAutoSelected ? ' is-selected' : ''}" data-conv-auto="1">` +
      `<div class="conv-auto-top"><span>${escZh(tr('自动跟随当前对话', 'Auto-follow active session'))}</span>${autoCurBadge}</div>` +
      `<div class="conv-auto-sub">${autoSourceTag}<span class="conv-auto-preview" title="${escZh(autoPreviewTitle)}">${escZh(autoPreviewTitle)}</span></div>` +
      `</button>`
    ];

    if (!filteredGroups.length) {
      htmlParts.push(`<div class="conv-pop-empty">${escZh(tr('当前筛选条件下暂无匹配会话', 'No matching sessions'))}</div>`);
    } else {
      for (const g of filteredGroups) {
        const gDisplayName = displayProjName(g.name);
        const activeDot = g.hasActive ? `<span class="conv-group-active-dot" title="${escZh(tr('当前会话所在项目', 'Project of active session'))}"></span>` : '';
        const itemsHtml = g.items.map((item) => {
          const title = item.title || item.annTitle || item.shortId || item.id.slice(0, 8);
          const cliBadge = item.source === 'cli'
            ? `<span class="conv-cli-badge" title="${escZh(tr('agy CLI 会话', 'agy CLI session'))}">CLI</span>`
            : '';
          const runningBadge = item.isRunning
            ? `<span class="conv-running-pill" title="${escZh(tr('正在运行中', 'Running'))}"><i class="conv-running-dot"></i>${escZh(tr('运行中', 'Running'))}</span>`
            : '';
          const isCur = item.id === displayConvId;
          const curBadge = isCur ? `<span class="conv-cur-badge">${escZh(tr('当前', 'Active'))}</span>` : '';
          const tokText = `${fmtTokens(item.lastContextTokens || 0, 1)} tok`;
          const turnsText = tr(`${fmtInt(item.turnsCount || 0)} 轮`, `${fmtInt(item.turnsCount || 0)} turns`);
          const relText = fmtRelativeTime(item.effectiveActiveMs || item.updatedAtMs, nowMs);
          const line2 = `${tokText} · ${turnsText} · ${relText}`;
          const tipParts = [title, item.repoLabel || gDisplayName, line2].filter(Boolean);
          return (
            `<button type="button" class="conv-item${isCur ? ' is-selected' : ''}" data-conv-id="${esc(item.id)}" title="${escZh(tipParts.join(' · '))}">` +
            `<div class="conv-item-line1">${cliBadge}<span class="conv-item-title">${escZh(title)}</span>${runningBadge}${curBadge}</div>` +
            `<div class="conv-item-line2">${escZh(line2)}</div>` +
            `</button>`
          );
        }).join('');

        htmlParts.push(
          `<div class="conv-group${g.expanded ? '' : ' is-collapsed'}" data-proj-group="${esc(g.name)}">` +
          `<button type="button" class="conv-group-head" data-proj-toggle="${esc(g.name)}" aria-expanded="${g.expanded ? 'true' : 'false'}">` +
          `<span class="conv-group-chevron" aria-hidden="true">▸</span>` +
          `<span class="conv-group-name" title="${escZh(gDisplayName)}">${escZh(gDisplayName)}</span>` +
          activeDot +
          `<span class="conv-group-count">${esc(g.items.length)}</span>` +
          `</button>` +
          `<div class="conv-group-items-wrap"><div class="conv-group-items">${itemsHtml}</div></div>` +
          `</div>`
        );
      }
    }

    bodyEl.innerHTML = htmlParts.join('');
    bodyEl.scrollTop = prevScrollTop;
  }

  function renderConversationPicker(list = [], activeId = '') {
    if (Array.isArray(list)) {
      state.recentConversations = list;
    }
    if (typeof activeId === 'string' && activeId) {
      state.activeConvId = activeId;
    }
    const items = state.recentConversations || [];
    syncConvTriggerAndSelect(items, state.activeConvId);
    if (state.convPicker.open) {
      renderConvPopoverPills(false);
      renderConvPopoverBody(false);
    }
  }

  async function applyPinnedConversation(nextConvId, { showFollowToast = false, closePopover = true } = {}) {
    const normalized = typeof nextConvId === 'string' ? nextConvId.trim() : '';
    state.userModifiedConvSelection = true;
    state.pinSyncSeq += 1;
    state.pinSyncPending += 1;
    state.selectedConvId = normalized;
    state.contextEtag = '';
    state.contextEtagConv = normalized || state.hostConvId || '';
    if (state.contextAbortCtrl) {
      try { state.contextAbortCtrl.abort(); } catch {}
      state.contextAbortCtrl = null;
    }
    state.contextInFlight = false;
    state.contextInFlightConv = '';
    state.contextInFlightSince = 0;

    if (closePopover) closeConvPopover();
    if (!state.capPopover?.pinned && typeof closeCapPopover === 'function') closeCapPopover();
    renderConversationPicker(state.recentConversations, state.activeConvId || normalized);
    if (showFollowToast && !normalized) {
      showToast(tr('已恢复自动跟随', 'Auto-follow resumed'), 1800);
    }

    try {
      await apiFetch('/api/entrypoints', {
        method: 'POST',
        body: { pinnedConvId: normalized }
      }).catch(() => {});
    } finally {
      state.pinSyncPending = Math.max(0, state.pinSyncPending - 1);
    }
    loadContext(true, { showSwitchIndicator: true }).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // TAB 1: Context & Speed Renderer
  // -------------------------------------------------------------------------

  function renderContextPanel(snap) {
    const ctx = snap.context || {};
    const spd = snap.speed;
    const audit = snap.audit || {};
    const err = ctx.error || { kind: 'none' };
    const win = computeEffectiveWindow(ctx);
    const pct = win.pct;
    const en = isEn();

    setText('ctx-model-badge', ctx.model || tr('未识别模型', 'Unknown model'));

    const pendingBadge = $('ctx-pending-badge');
    if (pendingBadge) {
      if (ctx.pendingTokens > 0) {
        pendingBadge.classList.remove('hidden');
        setText(pendingBadge, en ? `+Pending ~${fmtTokens(ctx.pendingTokens, 1)}` : `+待发 ~${fmtTokens(ctx.pendingTokens, 1)}`);
      } else {
        pendingBadge.classList.add('hidden');
      }
    }

    const sqliteBadge = $('ctx-sqlite-badge');
    if (sqliteBadge) {
      const stTiming = ctx.sessionTiming;
      if (stTiming && (stTiming.sqliteStale || stTiming.sqlitePartial)) {
        sqliteBadge.classList.remove('hidden');
        const badgeTxt = stTiming.sqlitePartial && stTiming.sqliteStale
          ? tr('遥测待更新', 'Telemetry syncing')
          : (stTiming.sqliteStale ? tr('遥测略滞后', 'Telemetry lagging') : tr('部分遥测', 'Partial telemetry'));
        setText(sqliteBadge, badgeTxt);
        setElTooltip(
          sqliteBadge,
          stTiming.sqliteStale && stTiming.sqlitePartial
            ? tr(
                '本地 SQLite 遥测尚在同步且部分记录未就绪，耗时与分类占比可能略滞后',
                'Local SQLite telemetry is still syncing and partial; latency and category breakdown may lag slightly'
              )
            : (stTiming.sqliteStale
              ? tr(
                  '本地 SQLite 遥测尚在同步，耗时与分类占比可能略滞后',
                  'Local SQLite telemetry is syncing; latency and category breakdown may lag slightly'
                )
              : tr(
                  '部分 SQLite 历史记录未能解析，分类或耗时统计可能不完整',
                  'Some SQLite history records could not be parsed; category or latency stats may be incomplete'
                ))
        );
      } else {
        sqliteBadge.classList.add('hidden');
        setText(sqliteBadge, '');
        setElTooltip(sqliteBadge, '');
      }
    }

    setText('conv-live-title', snap.conversationTitle || `${tr('会话', 'Session')} ${snap.conversationId || ''}`);
    const repoChip = $('conv-repo-chip');
    if (repoChip) {
      const repoLabel = snap.repoInfo?.label ? String(snap.repoInfo.label).trim() : '';
      if (repoLabel) {
        repoChip.classList.remove('hidden');
        setText(repoChip, repoLabel);
        const repoTip = snap.repoInfo?.branch
          ? tr(
              `当前 Git 仓库：${snap.repoInfo.name || repoLabel}（分支 ${snap.repoInfo.branch}）`,
              `Git repo: ${snap.repoInfo.name || repoLabel} (branch ${snap.repoInfo.branch})`
            )
          : tr(`当前工作区仓库：${repoLabel}`, `Workspace repo: ${repoLabel}`);
        setElTooltip(repoChip, repoTip);
      } else {
        repoChip.classList.add('hidden');
        setText(repoChip, '');
        setElTooltip(repoChip, '');
      }
    }
    const branchBadge = $('conv-branch-badge');
    if (branchBadge) {
      const br = snap.branchInfo;
      if (br?.isBranch) {
        branchBadge.classList.remove('hidden');
        const kindLabel = br.kind
          ? (en ? `/${br.kind} branch` : `/${br.kind} 分支`)
          : (en ? '/btw branch' : '/btw 分支');
        setText(branchBadge, kindLabel);
        const dedup = Number(br.deduplicatedStepsCount || 0);
        const forkPart = br.forkStepIndex != null ? `Step ${br.forkStepIndex}` : tr('历史节点', 'prior step');
        const parentPart = br.parentConvId
          ? (en ? `parent ${String(br.parentConvId).slice(0, 8)} @ ` : `父会话 ${String(br.parentConvId).slice(0, 8)} 的 `)
          : '';
        setElTooltip(
          branchBadge,
          en
            ? `Branched from ${parentPart}${forkPart}; global totals deduplicated ${fmtInt(dedup)} prior steps`
            : `从${parentPart}${forkPart}分叉，全局统计已自动去重 ${fmtInt(dedup)} 步前置历史`
        );
      } else {
        branchBadge.classList.add('hidden');
        setText(branchBadge, '');
        setElTooltip(branchBadge, '');
      }
    }
    setText(
      'conv-live-steps',
      en
        ? `${fmtInt(audit.turnsCount || 0)} turns · ${fmtInt(audit.totalSteps || 0)} steps · ${fmtInt(audit.toolCallsCount || 0)} tools`
        : `${fmtInt(audit.turnsCount || 0)} 轮响应 · ${fmtInt(audit.totalSteps || 0)} 步 · ${fmtInt(audit.toolCallsCount || 0)} 次工具`
    );

    const budgetChip = $('ctx-budget-chip');
    if (budgetChip) {
      if (win.budget) {
        setText(budgetChip, en ? `Cap ${fmtTokens(win.budget)}` : `上限 ${fmtTokens(win.budget)}`);
        setElTooltip(
          budgetChip,
          en
            ? `Server live auto-compaction context window cap (${fmtInt(win.budget)} Tokens)`
            : `服务端实时下发的当前模型自动压缩阈值（${fmtInt(win.budget)} Tokens）`
        );
      } else if (win.used === null) {
        setText(budgetChip, tr('上限待同步', 'Cap pending'));
        setElTooltip(budgetChip, tr('待首轮模型响应后同步服务端窗口上限', 'Awaiting first model response to sync server context cap'));
      } else {
        setText(budgetChip, tr('上限未记录', 'Cap unrecorded'));
        setElTooltip(budgetChip, tr('本地归档未记录该轮模型的服务端窗口上限', 'Local archive did not record server context cap for this turn'));
      }
    }

    const healthPct = win.serverBudget ? win.serverPct : pct;

    // Health status pill
    const pill = $('ctx-health-pill');
    if (pill) {
      let cls = 'good';
      let label = tr('运行健康', 'Healthy');
      if (err.kind && err.kind !== 'none') {
        cls = err.kind === 'canceled' ? 'neutral' : 'danger';
        label = err.badgeText || err.title || tr('异常', 'Issue');
      } else if (win.used === null) {
        cls = 'neutral';
        label = tr('待首轮请求', 'Awaiting turn');
      } else if (pct === null) {
        cls = 'neutral';
        label = tr('容量未知', 'Unknown cap');
      } else if (pct >= 90) {
        cls = 'danger';
        label = tr('临近上限', 'Near limit');
      } else if (pct >= 75) {
        cls = 'warn';
        label = tr('占用偏高', 'High usage');
      }
      pill.className = `status-pill ${cls}`;
      setText(pill, label);
    }

    // Hero circular gauge (r = 35 => C = 219.91)
    const circum = 219.91;
    tweenDisplayNumber('ctx-pct-big', pct, (v) => (v !== null ? `${v.toFixed(1)}%` : '--%'), 'ctx-pct-big');
    setText('ctx-gauge-sub', win.budget ? tr('预算占比', '% of budget') : tr('上限未知', 'Cap unknown'));

    const heroFill = $('hero-ring-fill');
    const heroCache = $('hero-ring-cache');
    if (heroFill) {
      const ratio = pct !== null ? Math.min(1, Math.max(0, pct / 100)) : 0;
      heroFill.setAttribute('stroke-dasharray', `${(ratio * circum).toFixed(2)} ${circum}`);
      heroFill.style.stroke = resolveHealthStroke(healthPct, err.kind);
    }
    if (heroCache) {
      const cacheRatio = win.budget && win.budget > 0 && ctx.cacheTokens
        ? Math.min(1, Math.max(0, ctx.cacheTokens / win.budget))
        : 0;
      heroCache.setAttribute('stroke-dasharray', `${(cacheRatio * circum).toFixed(2)} ${circum}`);
    }

    // 4 Metric Cells
    setText('ctx-used', win.used !== null ? fmtTokens(win.used) : '--');
    const usedSubEl = $('ctx-used-sub');
    if (win.used !== null) {
      const pendNote = ctx.pendingTokens > 0
        ? (en ? ` · Pend ~${fmtTokens(ctx.pendingTokens, 1)}` : ` · 待发 ~${fmtTokens(ctx.pendingTokens, 1)}`)
        : '';
      const hasPromptBase = typeof ctx.promptUsed === 'number' && Number.isFinite(ctx.promptUsed) && ctx.promptUsed > 0;
      const hasNextMin = typeof ctx.projectedNextMin === 'number' && Number.isFinite(ctx.projectedNextMin) && ctx.projectedNextMin > 0;
      const hasDeltaTail = (ctx.outputTokens > 0 || ctx.pendingTokens > 0) && hasPromptBase;
      const nextMinVal = hasNextMin
        ? ctx.projectedNextMin
        : (hasPromptBase ? ctx.promptUsed + Number(ctx.outputTokens || 0) + Number(ctx.pendingTokens || 0) : null);
      const subText = en
        ? `In ${fmtTokens(ctx.inputTokens || 0, 1)} · Cache ${fmtTokens(ctx.cacheTokens || 0, 1)}${pendNote}`
        : `入 ${fmtTokens(ctx.inputTokens || 0, 1)} · 缓 ${fmtTokens(ctx.cacheTokens || 0, 1)}${pendNote}`;
      setText('ctx-used-sub', subText);
      if (usedSubEl) {
        if (hasDeltaTail && nextMinVal && nextMinVal > ctx.promptUsed) {
          const pctPart = typeof ctx.projectedNextPercent === 'number' && Number.isFinite(ctx.projectedNextPercent)
            ? (en ? ` (~${ctx.projectedNextPercent.toFixed(1)}%)` : `（约 ${ctx.projectedNextPercent.toFixed(1)}%）`)
            : '';
          setElTooltip(
            usedSubEl,
            en
              ? `Last Prompt ${fmtTokens(ctx.promptUsed, 1)} · Next floor incl. output/pending ${fmtTokens(nextMinVal, 1)}${pctPart}`
              : `本轮 Prompt ${fmtTokens(ctx.promptUsed, 1)} · 含输出 / 待发下轮底数 ${fmtTokens(nextMinVal, 1)}${pctPart}`
          );
        } else {
          setElTooltip(usedSubEl, subText);
        }
      }
    } else {
      setText(
        'ctx-used-sub',
        en
          ? `Local archive ~${fmtTokens(audit.localTotal?.low || 0, 1)}~${fmtTokens(audit.localTotal?.high || 0, 1)}`
          : `本地归档约 ${fmtTokens(audit.localTotal?.low || 0, 1)}~${fmtTokens(audit.localTotal?.high || 0, 1)}`
      );
      setElTooltip(usedSubEl, '');
    }

    setText('ctx-budget', win.budget ? fmtTokens(win.budget) : (win.used === null ? '--' : tr('未知', 'Unknown')));
    const budgetSubEl = $('ctx-budget-sub');
    if (win.budget) {
      if (win.remaining !== null && win.budget > 0) {
        const remPct = Math.max(0, 100 - (pct || 0)).toFixed(1);
        setText('ctx-budget-sub', en ? `Left ${fmtTokens(win.remaining, 1)} (${remPct}%)` : `余 ${fmtTokens(win.remaining, 1)} (${remPct}%)`);
        setElTooltip(
          budgetSubEl,
          en
            ? `Remaining ${fmtTokens(win.remaining)} (${remPct}%) · Server live limit`
            : `剩余可用 ${fmtTokens(win.remaining)}（${remPct}%）· 服务端实时阈值`
        );
      } else {
        setText('ctx-budget-sub', tr('服务端实时阈值', 'Server live limit'));
        setElTooltip(budgetSubEl, tr('服务端实时阈值', 'Server live limit'));
      }
    } else {
      const fallbackBudgetSub = win.used === null
        ? tr('待首轮同步', 'Pending 1st turn')
        : tr('本地未记录上限', 'Cap unrecorded');
      setText('ctx-budget-sub', fallbackBudgetSub);
      setElTooltip(budgetSubEl, fallbackBudgetSub);
    }

    const cacheRateClass = (val) => {
      if (val === null || val === undefined || !Number.isFinite(Number(val))) return 'm-val';
      const num = Number(val);
      if (num >= 70) return 'm-val good-text';
      if (num >= 30) return 'm-val accent-text';
      return 'm-val warn-text';
    };

    const st = ctx.sessionTotals || {};
    const sessCachePct = typeof st.cacheHitPercent === 'number' && Number.isFinite(st.cacheHitPercent)
      ? st.cacheHitPercent
      : null;
    const sessCacheEl = $('ctx-session-cache');
    if (sessCacheEl) {
      sessCacheEl.className = cacheRateClass(sessCachePct);
      setText(sessCacheEl, sessCachePct !== null ? `${sessCachePct.toFixed(1)}%` : '--');
    }
    const sessTurnsCount = Number(st.turnsCount || audit.turnsCount || 0);
    const sessCw = Number(st.cacheWriteTokens ?? st.cacheWrittenTokens ?? 0);
    const sessCacheSubText = sessCachePct !== null
      ? (en
          ? `${sessTurnsCount > 0 ? `${fmtInt(sessTurnsCount)} turns · ` : ''}Hit ${fmtTokens(st.cacheTokens || 0, 1)}${sessCw > 0 ? ` · Wrote ${fmtTokens(sessCw, 1)}` : ''}`
          : `${sessTurnsCount > 0 ? `${fmtInt(sessTurnsCount)} 轮 · ` : ''}命中 ${fmtTokens(st.cacheTokens || 0, 1)}${sessCw > 0 ? ` · 写入 ${fmtTokens(sessCw, 1)}` : ''}`)
      : (win.used === null
          ? tr('等待模型轮次', 'Awaiting turns')
          : (sessCw > 0 ? tr(`写入 ${fmtTokens(sessCw, 1)}`, `Wrote ${fmtTokens(sessCw, 1)}`) : tr('暂无缓存读取', 'No cache reads')));
    setText('ctx-session-cache-sub', sessCacheSubText);
    const sessCacheCell = $('ctx-session-cache-cell');
    if (sessCacheCell) {
      const sessPromptTot = Number(st.inputTokens || 0) + Number(st.cacheTokens || 0);
      const sessSav = fmtCacheSavings(ctx.sessionCacheSavingsUSD);
      const savedNote = sessSav ? ` · ${sessSav.text}` : '';
      const sessCwNote = sessCw > 0 ? (en ? ` · Wrote ${fmtTokens(sessCw, 1)}` : ` · 写入 ${fmtTokens(sessCw, 1)}`) : '';
      setElTooltip(
        sessCacheCell,
        sessCachePct !== null
          ? (
              en
                ? `Session avg cache hit ${sessCachePct.toFixed(1)}% (hit ${fmtInt(st.cacheTokens || 0)} / prompt ${fmtInt(sessPromptTot)} tok${sessCwNote}${savedNote})`
                : `当前会话平均缓存命中率 ${sessCachePct.toFixed(1)}%（累计命中 ${fmtInt(st.cacheTokens || 0)} / 提示输入 ${fmtInt(sessPromptTot)} tok${sessCwNote}${savedNote}）`
            )
          : tr(
              '当前会话全部有效轮次的加权平均缓存命中率（累计缓存读取 / 累计提示输入）',
              'Weighted average cache hit rate across all valid turns (total cache reads / total prompt input)'
            )
      );
    }

    const roundCachePct = typeof ctx.cacheHitPercent === 'number' && Number.isFinite(ctx.cacheHitPercent)
      ? ctx.cacheHitPercent
      : null;
    const cacheStatus = ctx.cacheStatus || null;
    const cacheState = cacheStatus?.state || '';
    const roundCacheEl = $('ctx-cache-rate');
    if (roundCacheEl) {
      if (cacheState === 'drop') {
        roundCacheEl.className = 'm-val danger-text';
      } else if (cacheState === 'compacted' || cacheState === 'warmup') {
        roundCacheEl.className = 'm-val accent-text';
      } else {
        roundCacheEl.className = cacheRateClass(roundCachePct);
      }
      setText(roundCacheEl, roundCachePct !== null ? `${roundCachePct.toFixed(1)}%` : '--');
    }
    const roundCw = Number(ctx.cacheWriteTokens || 0);
    const cacheSubEl = $('ctx-cache-sub');
    let roundCacheSubText = tr('缓存读取占比', 'Cache read ratio');
    let roundCacheSubCls = 'm-sub';
    if (cacheState === 'warmup') {
      roundCacheSubText = roundCw > 0
        ? tr(`首轮建库 · 写入 ${fmtTokens(roundCw, 1)}`, `Warmup · Wrote ${fmtTokens(roundCw, 1)}`)
        : tr('首轮建库', 'Warmup');
      roundCacheSubCls = 'm-sub accent-text';
    } else if (cacheState === 'compacted') {
      const dropPct = cacheStatus?.compactionDropPercent != null && Number.isFinite(Number(cacheStatus.compactionDropPercent))
        ? Math.round(Number(cacheStatus.compactionDropPercent))
        : null;
      roundCacheSubText = dropPct !== null
        ? tr(`自动压缩 -${dropPct}%`, `Auto-compacted -${dropPct}%`)
        : tr('自动压缩', 'Auto-compacted');
      roundCacheSubCls = 'm-sub accent-text';
    } else if (cacheState === 'drop') {
      const prevPct = cacheStatus?.breakPrevHitPercent != null && Number.isFinite(Number(cacheStatus.breakPrevHitPercent))
        ? Math.round(Number(cacheStatus.breakPrevHitPercent))
        : null;
      roundCacheSubText = prevPct !== null
        ? tr(`缓存断流（前轮 ${prevPct}%）`, `Cache break (prev ${prevPct}%)`)
        : tr('缓存断流', 'Cache break');
      roundCacheSubCls = 'm-sub danger-text';
    } else if (ctx.cacheTokens || roundCw > 0) {
      const parts = [];
      if (ctx.cacheTokens) parts.push(en ? `Hit ${fmtTokens(ctx.cacheTokens, 1)}` : `命中 ${fmtTokens(ctx.cacheTokens, 1)}`);
      if (roundCw > 0) parts.push(en ? `Wrote ${fmtTokens(roundCw, 1)}` : `写入 ${fmtTokens(roundCw, 1)}`);
      roundCacheSubText = parts.join(' · ');
    }
    if (cacheSubEl) {
      cacheSubEl.className = roundCacheSubCls;
      setText(cacheSubEl, roundCacheSubText);
    }
    const roundCacheCell = $('ctx-cache-rate-cell');
    if (roundCacheCell) {
      const tipParts = [tr('最近一轮已完成请求的缓存读取占比', 'Cache read ratio of the latest completed turn')];
      if (ctx.cacheTokens) tipParts.push(tr(`读取 ${fmtTokens(ctx.cacheTokens, 1)}`, `Read ${fmtTokens(ctx.cacheTokens, 1)}`));
      if (roundCw > 0) tipParts.push(tr(`写入 ${fmtTokens(roundCw, 1)}`, `Write ${fmtTokens(roundCw, 1)}`));
      if (cacheState === 'warmup') tipParts.push(tr('首轮建立缓存', 'Initial cache warmup'));
      else if (cacheState === 'compacted') tipParts.push(tr('本轮发生自动上下文压缩，缓存需重新预热（非异常断流）', 'Context auto-compacted; cache re-warming (not an unexpected break)'));
      else if (cacheState === 'drop') tipParts.push(tr(`缓存断流（前轮命中 ${cacheStatus?.breakPrevHitPercent ?? '--'}%）`, `Cache break (prev ${cacheStatus?.breakPrevHitPercent ?? '--'}%)`));
      if (Number(cacheStatus?.cacheBreakCount || 0) > 0) {
        tipParts.push(tr(`本会话累计断流 ${fmtInt(cacheStatus.cacheBreakCount)} 次`, `${fmtInt(cacheStatus.cacheBreakCount)} cache breaks in session`));
      }
      setElTooltip(roundCacheCell, tipParts.join(' · '));
    }

    // 3-Segment Context Bar (System / Tools / Messages)
    renderSegmentedBreakdown(ctx, audit);

    // Session Cumulative 4-Dimension Throughput
    setText('cum-cache-overall', st.cacheHitPercent != null ? tr(`累计缓存率 ${st.cacheHitPercent.toFixed(1)}%`, `Cum. cache ${st.cacheHitPercent.toFixed(1)}%`) : tr('累计缓存率 --', 'Cum. cache --'));
    setText('cum-cache-tok', fmtTokens(st.cacheTokens || 0));
    const cumCacheSavedEl = $('cum-cache-saved');
    if (cumCacheSavedEl) {
      const savedUSD = Number(ctx.sessionCacheSavingsUSD);
      const sav = fmtCacheSavings(savedUSD);
      if (sav) {
        cumCacheSavedEl.classList.remove('hidden', 'good-text', 'warn-text');
        cumCacheSavedEl.classList.add(sav.cls === 'ok' ? 'good-text' : 'warn-text');
        setText(cumCacheSavedEl, sav.savedText);
        const absUSD = Math.abs(savedUSD);
        setElTooltip(
          cumCacheSavedEl,
          sav.cls === 'ok'
            ? tr(`较原价输入预计净节省 ${fmtUSD(absUSD)}（约 ${fmtCNY(absUSD)}）`, `Net estimated savings vs. full-price input: ${fmtUSD(absUSD)} (~${fmtCNY(absUSD)})`)
            : tr(`缓存写入溢价高于读取节省，较原价输入净增加 ${fmtUSD(absUSD)}（约 ${fmtCNY(absUSD)}）`, `Cache write surcharge exceeded read savings by ${fmtUSD(absUSD)} (~${fmtCNY(absUSD)})`)
        );
      } else {
        cumCacheSavedEl.classList.remove('warn-text');
        cumCacheSavedEl.classList.add('good-text', 'hidden');
        setText(cumCacheSavedEl, '');
        setElTooltip(cumCacheSavedEl, '');
      }
    }
    setText('cum-input-tok', fmtTokens(st.inputTokens || 0));
    setText('cum-output-tok', fmtTokens(st.outputTokens || 0));
    setText('cum-think-sub', tr(`含思考 ${fmtTokens(st.thinkingTokens || 0, 1)}`, `Thinking ${fmtTokens(st.thinkingTokens || 0, 1)}`));
    setText('cum-total-tok', fmtTokens(st.totalTokens || 0));

    // Takeaway & Error Diagnostics
    const takeaway = $('ctx-takeaway');
    if (takeaway) {
      takeaway.classList.remove('warn', 'danger');
      if (err.kind && err.kind !== 'none') {
        if (err.kind !== 'canceled') takeaway.classList.add('danger');
        setText(takeaway, `${err.title}：${err.detail}`);
      } else if (win.used === null) {
        setText(
          takeaway,
          en
            ? `Session (${snap.conversationTitle}) has no completed model turns yet; live window metrics will sync after the next turn.`
            : `当前会话（${snap.conversationTitle}）暂无已完成模型轮次；发送消息后自动同步精确窗口占用。`
        );
      } else if (pct === null) {
        setText(
          takeaway,
          en
            ? `Session used ${fmtTokens(win.used)} tokens; server context cap was not recorded in local archive.`
            : `当前会话已用 ${fmtTokens(win.used)} Token；本地归档未记录该轮模型的服务端窗口上限，暂不推导健康百分比。`
        );
      } else if (pct >= 88) {
        takeaway.classList.add('danger');
        setText(
          takeaway,
          en
            ? `Context window is at ${pct.toFixed(1)}% (${fmtTokens(win.used)} / ${fmtTokens(win.budget)}), near capacity; consider /compact or starting a fresh session.`
            : `当前窗口已使用 ${pct.toFixed(1)}%（${fmtTokens(win.used)} / ${fmtTokens(win.budget)}），接近上限阈值，建议适时执行 /compact 或拆分新会话以保持响应速度。`
        );
      } else if (pct >= 72) {
        takeaway.classList.add('warn');
        const sessCachePart = sessCachePct !== null
          ? (en ? `, session avg cache ${sessCachePct.toFixed(1)}%` : `，会话平均缓存命中 ${sessCachePct.toFixed(1)}%`)
          : '';
        setText(
          takeaway,
          en
            ? `Context window is at ${pct.toFixed(1)}% (${fmtTokens(win.used)} / ${fmtTokens(win.budget)})${sessCachePart}; long turns may trigger auto-compaction.`
            : `当前窗口已使用 ${pct.toFixed(1)}%（${fmtTokens(win.used)} / ${fmtTokens(win.budget)}）${sessCachePart}，后续长输出轮次可能触发自动摘要。`
        );
      } else {
        const sessCacheNote = sessCachePct !== null
          ? (en
              ? `, avg cache ${sessCachePct.toFixed(1)}%${sessTurnsCount > 0 ? ` (${fmtInt(sessTurnsCount)} turns)` : ''}`
              : `，会话平均缓存命中 ${sessCachePct.toFixed(1)}%${sessTurnsCount > 0 ? `（${fmtInt(sessTurnsCount)} 轮）` : ''}`)
          : '';
        setText(
          takeaway,
          en
            ? `Session "${snap.conversationTitle}" window is healthy (${fmtTokens(win.used)} / ${fmtTokens(win.budget)})${sessCacheNote}.`
            : `会话「${snap.conversationTitle}」窗口健康（已用 ${fmtTokens(win.used)} / ${fmtTokens(win.budget)}）${sessCacheNote}。`
        );
      }
    }

    // Round & Session API Cost Strip
    setText(
      'ctx-round-cost',
      ctx.isPriced ? `${fmtUSD(ctx.roundCostUSD)}（${en ? '~' : '约 '}${fmtCNY(ctx.roundCostUSD)}）` : '--'
    );
    setText(
      'ctx-session-cost',
      ctx.sessionCostUSD > 0 ? `${fmtUSD(ctx.sessionCostUSD)}（${en ? '~' : '约 '}${fmtCNY(ctx.sessionCostUSD)}）` : '$0.00'
    );
    const cumSummaryCost = ctx.sessionCostUSD > 0 ? fmtUSD(ctx.sessionCostUSD) : '$0.00';
    setText(
      'cum-summary-chip',
      st.totalTokens > 0
        ? `${tr('累计', 'Total')} ${fmtTokens(st.totalTokens, 1)} · ${cumSummaryCost}`
        : `${tr('累计', 'Total')} -- · ${cumSummaryCost}`
    );

    // Card 1.2: Session Models & Per-Model Average Cache Hit Rate
    renderSessionModelsCard(ctx, snap.turns || []);

    // Card 1.5: Swarm / Subagent Tree Aggregation
    renderAgentTreeCard(snap.agentTree || null);

    // Card 2: Speed & Latency
    renderSpeedCard(spd, ctx, snap.sparkline || [], snap.quotaStatus || null);

    // Card 2.5: Per-Turn Timeline
    renderTurnsTimelineCard(
      snap.turns || [],
      audit.turnsCount || 0,
      snap.promptTurns || [],
      ctx.latestPromptStartup || null,
      ctx.cacheStatus || null
    );

    // Card 2.8: Top 10 Heavy Context Items
    renderHeavyItemsCard(snap.heavyItems || []);

    // Card 2.9: Compaction History & Summary Drawer
    renderCompactionsCard(snap.compactions || []);

    // Card 3: Server Context Breakdown Details
    renderServerBreakdownCard(ctx.breakdown);

    // Card 4: Technical Audit & Attachments
    renderTechnicalAuditCard(snap);

    if (typeof refreshOpenCapPopover === 'function') refreshOpenCapPopover();
  }

  const CONTEXT_CAT_META = {
    1: { key: 'system', label: '系统提示词', enLabel: 'System Prompt', color: 'var(--cv-cat-1, #9ca3af)' },
    2: { key: 'tools', label: '工具定义', enLabel: 'Tool Definitions', color: 'var(--cv-cat-2, #a78bfa)' },
    3: { key: 'rules', label: '规则', enLabel: 'Rules', color: 'var(--cv-cat-3, #f472b6)' },
    4: { key: 'mcp', label: 'MCP 工具', enLabel: 'MCP Tools', color: 'var(--cv-cat-4, #2dd4bf)' },
    5: { key: 'skills', label: '技能', enLabel: 'Skills', color: 'var(--cv-cat-5, #fbbf24)' },
    6: { key: 'subagent', label: '子代理', enLabel: 'Subagents', color: 'var(--cv-cat-6, #fb923c)' },
    7: { key: 'messages', label: '对话消息', enLabel: 'Messages', color: 'var(--cv-cat-7, #4c8df6)' },
    8: { key: 'workflow', label: '工作流', enLabel: 'Workflows', color: 'var(--cv-cat-8, #34d399)' },
    9: { key: 'plugin', label: '插件', enLabel: 'Plugins', color: 'var(--cv-cat-9, #c084fc)' },
    10: { key: 'flow', label: '流程', enLabel: 'Flows', color: 'var(--cv-cat-10, #38bdf8)' }
  };

  function resolveContextCategories(ctx = {}, audit = {}) {
    const en = isEn();
    const rawCats = ctx?.breakdown?.categories;
    if (Array.isArray(rawCats) && rawCats.length > 0) {
      const positive = rawCats.filter((c) => Number(c?.tokens || 0) > 0);
      const sum = positive.reduce((acc, c) => acc + Number(c.tokens || 0), 0);
      const items = positive.map((c, idx) => {
        const typeNum = Number(c.type || 0);
        const fallback = CONTEXT_CAT_META[typeNum] || {};
        const tokens = Number(c.tokens || 0);
        const percent = Number.isFinite(Number(c.percent))
          ? Number(c.percent)
          : (sum > 0 ? (tokens / sum) * 100 : 0);
        const resolvedLabel = en
          ? String(fallback.enLabel || c.key || c.label || 'Other')
          : String(c.label || fallback.label || '其他');
        return {
          type: typeNum || idx + 1,
          key: String(c.key || fallback.key || `cat_${idx + 1}`),
          label: resolvedLabel,
          color: String(c.color || fallback.color || 'var(--cv-accent)'),
          tokens,
          percent,
          rawTokens: c.rawTokens
        };
      });
      return { items, sum, isExact: true, isCategories: true };
    }

    const groups = ctx?.breakdown?.groups;
    if (Array.isArray(groups) && groups.length > 0) {
      const merged = [];
      for (const g of groups) {
        const tok = Number(g?.tokens || 0);
        if (tok <= 0) continue;
        if (g.key === 'skills' || g.name === 'Skills') {
          merged.push({ key: 'skills', label: tr('Skills 技能指令', 'Skills'), color: 'var(--cv-seg-skills-col, #10b981)', tokens: tok });
        } else if (g.name === 'System Prompt') {
          merged.push({ key: 'system', label: tr('系统提示词', 'System Prompt'), color: 'var(--seg-sys-col, #6366f1)', tokens: tok });
        } else if (g.name === 'Tools') {
          merged.push({ key: 'tools', label: tr('工具定义', 'Tools'), color: 'var(--seg-tools-col, #0ea5e9)', tokens: tok });
        } else {
          merged.push({ key: g.key || 'messages', label: en ? (g.name || 'Chat Messages') : (g.label || '对话与思考历史'), color: 'var(--seg-msgs-col, #a855f7)', tokens: tok });
        }
      }
      const sum = merged.reduce((acc, it) => acc + it.tokens, 0);
      const items = merged.map((it, idx) => ({
        type: idx + 1,
        key: it.key,
        label: it.label,
        color: it.color,
        tokens: it.tokens,
        percent: sum > 0 ? (it.tokens / sum) * 100 : 0
      }));
      return { items, sum, isExact: true, isCategories: false };
    }

    if (audit?.groups) {
      const g = audit.groups;
      const mid = (m) => (m ? Math.round(((m.low || 0) + (m.high || 0)) / 2) : 0);
      const sysTok = mid(g.system);
      const toolsTok = mid(g.definitions) + mid(g.tools);
      const msgsTok = mid(g.user) + mid(g.assistant) + mid(g.thinking) + mid(g.summaries) + mid(audit.attachmentTotal);
      const raw = [
        { key: 'system', label: tr('系统提示词', 'System Prompt'), color: 'var(--seg-sys-col, #6366f1)', tokens: sysTok },
        { key: 'tools', label: tr('工具定义与调用', 'Tools & Calls'), color: 'var(--seg-tools-col, #0ea5e9)', tokens: toolsTok },
        { key: 'messages', label: tr('对话与思考历史', 'Messages & Thinking'), color: 'var(--seg-msgs-col, #a855f7)', tokens: msgsTok }
      ].filter((it) => it.tokens > 0);
      const sum = raw.reduce((acc, it) => acc + it.tokens, 0);
      const items = raw.map((it, idx) => ({
        type: idx + 1,
        ...it,
        percent: sum > 0 ? (it.tokens / sum) * 100 : 0
      }));
      return { items, sum, isExact: false, isCategories: false };
    }

    return { items: [], sum: 0, isExact: false, isCategories: false };
  }

  function renderSegmentedBreakdown(ctx, audit) {
    const resolved = resolveContextCategories(ctx, audit);
    const { items, sum, isExact } = resolved;
    const bar = $('ctx-seg-bar');
    const leg = $('ctx-seg-legend');

    if (bar) {
      if (sum <= 0 || !items.length) {
        bar.innerHTML = '';
      } else {
        bar.innerHTML = items.map((it) => {
          const pctStr = it.percent.toFixed(1);
          const tip = `${it.label} · ${fmtIntZh(it.tokens)} tok (${pctStr}%)`;
          return (
            `<div class="seg-piece" data-cat-key="${esc(it.key)}" ` +
            `style="width:${Math.max(0.5, it.percent).toFixed(2)}%;background:${esc(it.color)}" ` +
            `title="${escZh(tip)}"></div>`
          );
        }).join('');
      }
    }

    if (leg) {
      if (sum <= 0 || !items.length) {
        leg.innerHTML = `<span class="muted">${escZh(tr('暂无上下文构成明细', 'No context breakdown available'))}</span>`;
      } else {
        leg.innerHTML = items.map((it) => {
          const pctStr = it.percent >= 10 ? it.percent.toFixed(0) : it.percent.toFixed(1);
          const tip = `${it.label} · ${fmtIntZh(it.tokens)} tok (${it.percent.toFixed(1)}%)`;
          return (
            `<button type="button" class="seg-leg-item" data-cat-key="${esc(it.key)}" title="${escZh(tip)}">` +
            `<i class="seg-dot" style="background:${esc(it.color)}"></i>` +
            `<span>${escZh(`${it.label} ${pctStr}%`)}</span>` +
            `</button>`
          );
        }).join('') + (!isExact ? `<span class="muted">${escZh(tr('· 本地启发式占比', '· Local heuristic'))}</span>` : '');
      }
    }

    // Preserve active spectrum hover across 1.5s polling redraws
    const hoveredCat = state.hoveredSpectrumCat || '';
    if (hoveredCat && items.some((it) => it.key === hoveredCat)) {
      applySpectrumHoverState(hoveredCat);
    } else {
      applySpectrumHoverState('');
    }
  }

  function renderSpeedCard(spd, ctx, sparkline, quotaStatus = null) {
    const en = isEn();
    setText('speed-source-tag', spd?.isServerExact ? tr('服务端精确计时', 'Server exact timing') : tr('归档时间戳估算', 'Archive estimate'));
    setText(
      'sp-avg-peak-chip',
      spd?.avgTps != null
        ? (en ? `Avg ${spd.avgTps} · Peak ${spd.peakTps ?? spd.avgTps} tok/s` : `均值 ${spd.avgTps} · 峰值 ${spd.peakTps ?? spd.avgTps} tok/s`)
        : tr('均值 -- · 峰值 --', 'Avg -- · Peak --')
    );

    const pill = $('speed-pill');
    if (pill) {
      if (!spd || (spd.tps === null && spd.duration === null)) {
        pill.className = 'status-pill neutral';
        setText(pill, tr('待生成', 'Awaiting'));
      } else if ((spd.tps || 0) >= 65) {
        pill.className = 'status-pill good';
        setText(pill, tr('极速响应', 'Blazing'));
      } else if ((spd.tps || 0) >= 28) {
        pill.className = 'status-pill good';
        setText(pill, tr('输出流畅', 'Smooth'));
      } else {
        pill.className = 'status-pill warn';
        setText(pill, spd.thinkingTokens > spd.responseTokens ? tr('深度思考轮次', 'Deep thinking') : tr('平稳生成', 'Steady'));
      }
    }

    const tpsVal = spd?.tps != null && Number.isFinite(Number(spd.tps)) ? Number(spd.tps) : null;
    tweenDisplayNumber(
      'sp-tps',
      tpsVal,
      (v) => (v !== null ? `${Number(v).toFixed(Number.isInteger(tpsVal) ? 0 : 1)} tok/s` : '--'),
      'sp-tps'
    );
    const hasEffTpsGap = Boolean(spd?.effectiveTps > 0 && (!(spd.tps > 0) || Math.abs(spd.effectiveTps - spd.tps) / spd.tps >= 0.2));
    const streamTpsText = spd?.streamingTps != null
      ? (hasEffTpsGap
          ? tr(`流式峰值 ${spd.streamingTps} · 整请求 ${spd.effectiveTps} tok/s`, `Stream peak ${spd.streamingTps} · Req avg ${spd.effectiveTps} tok/s`)
          : tr(`流式峰值 ${spd.streamingTps} tok/s`, `Stream peak ${spd.streamingTps} tok/s`))
      : (hasEffTpsGap
          ? tr(`整请求有效 ${spd.effectiveTps} tok/s`, `Req effective ${spd.effectiveTps} tok/s`)
          : tr('流式峰值 --', 'Stream peak --'));
    setText('sp-stream-tps', streamTpsText);
    setText('sp-dur', spd?.duration != null ? fmtSec(spd.duration) : '--');
    setText('sp-stream-sec', spd?.streamingSec != null ? `${tr('流传输', 'Stream')} ${fmtSec(spd.streamingSec)}` : tr('流传输 --', 'Stream --'));
    setText('sp-ttft', spd?.ttft != null ? fmtSec(spd.ttft) : '--');
    setText('sp-out', spd?.outputTokens != null ? `${fmtTokens(spd.outputTokens)} tok` : '--');
    setText(
      'sp-think-sub',
      spd
        ? (en
            ? `Think ${fmtTokens(spd.thinkingTokens || 0, 1)} / Reply ${fmtTokens(spd.responseTokens || 0, 1)}`
            : `思考 ${fmtTokens(spd.thinkingTokens || 0, 1)} / 正文 ${fmtTokens(spd.responseTokens || 0, 1)}`)
        : tr('思考 -- / 正文 --', 'Think -- / Reply --')
    );

    const timeWrap = $('time-split-wrap');
    if (timeWrap) {
      const t = ctx?.sessionTiming;
      const modelSec = Number(t?.modelTimeSec || 0);
      const toolSec = Number(t?.toolTimeSec || 0);
      const totalSec = Number(t?.totalActiveSec || (modelSec + toolSec));
      if (t && (modelSec > 0 || toolSec > 0 || totalSec > 0)) {
        timeWrap.classList.remove('hidden');
        const rounds = Number(t.rounds || 0);
        const calls = Number(t.calls || 0);
        const steps = Number(t.steps || 0);
        const avgTtftText = typeof t.avgTtftSec === 'number' && Number.isFinite(t.avgTtftSec) && t.avgTtftSec > 0
          ? `${tr('均值 TTFT', 'Avg TTFT')} ${fmtSec(t.avgTtftSec)}`
          : (t.sessionStreamTps > 0 ? `${tr('会话均值', 'Session avg')} ${t.sessionStreamTps} tok/s` : '');
        const sumActive = Math.max(0.001, modelSec + toolSec);
        const rawModelPct = typeof t.modelSharePercent === 'number' && Number.isFinite(t.modelSharePercent)
          ? t.modelSharePercent
          : (modelSec / sumActive) * 100;
        const modelPct = Math.max(0, Math.min(100, Math.round(rawModelPct)));
        const toolPct = toolSec > 0 ? Math.max(0, 100 - modelPct) : 0;
        const hasTools = toolSec > 0;
        const barHtml = hasTools
          ? `<div class="time-split-seg time-split-model" style="width:${Math.max(2, modelPct)}%" title="${escZh(`${tr('模型生成', 'Model gen')} ${fmtSec(modelSec)} (${modelPct}%)`)}"></div>` +
            `<div class="time-split-seg time-split-tool" style="width:${Math.max(2, toolPct)}%" title="${escZh(`${tr('工具执行', 'Tool exec')} ${fmtSec(toolSec)} (${toolPct}%)`)}"></div>`
          : `<div class="time-split-seg time-split-model" style="width:100%" title="${escZh(`${tr('模型生成', 'Model gen')} ${fmtSec(modelSec)}`)}"></div>`;
        const footHtml = hasTools
          ? `<span class="time-split-lbl"><i class="time-dot model"></i>${escZh(`${tr('模型', 'Model')} ${fmtSec(modelSec)} (${modelPct}%)`)}</span>` +
            `<span class="time-split-lbl"><i class="time-dot tool"></i>${escZh(`${tr('工具', 'Tools')} ${fmtSec(toolSec)} (${toolPct}%)`)}</span>`
          : `<span class="time-split-lbl"><i class="time-dot model"></i>${escZh(en ? `Model total ${fmtSec(modelSec)} · ${fmtInt(calls)} calls` : `模型总耗时 ${fmtSec(modelSec)} · ${fmtIntZh(calls)} 次调用`)}</span>`;
        timeWrap.innerHTML =
          `<div class="time-split-head">` +
          `<span class="time-split-title">${escZh(en ? `Time Split · ${fmtInt(rounds)} turns ${fmtInt(calls)} calls ${fmtInt(steps)} steps` : `时间构成 · ${fmtIntZh(rounds)} 轮 ${fmtIntZh(calls)} 次调用 ${fmtIntZh(steps)} 步`)}</span>` +
          (avgTtftText ? `<span class="muted xs num">${escZh(avgTtftText)}</span>` : '') +
          `</div>` +
          `<div class="time-split-bar">${barHtml}</div>` +
          `<div class="time-split-foot">${footHtml}</div>`;
      } else {
        timeWrap.classList.add('hidden');
        timeWrap.innerHTML = '';
      }
    }

    if (!spd) {
      setText('sp-takeaway', tr('当前会话尚无已完成输出轮次，等待首次模型响应后展示速度与首字延迟。', 'No completed model output turns yet; speed and TTFT will appear after the first response.'));
    } else if (spd.ttft !== null && spd.thinkingTokens > 0) {
      setText(
        'sp-takeaway',
        en
          ? `TTFT ${fmtSec(spd.ttft)} (incl. ${fmtInt(spd.thinkingTokens)} thinking tokens), streamed ${fmtInt(spd.responseTokens)} reply tokens, total ${fmtSec(spd.duration)}.`
          : `首字前推理准备耗时 ${fmtSec(spd.ttft)}（含 ${fmtInt(spd.thinkingTokens)} 思考 Token），正文流式输出 ${fmtInt(spd.responseTokens)} Token，总耗时 ${fmtSec(spd.duration)}。`
      );
    } else {
      setText(
        'sp-takeaway',
        en
          ? `Generated ${fmtInt(spd.outputTokens || 0)} tokens in ${fmtSec(spd.duration)} (${spd.tps ?? '--'} tok/s).`
          : `最近一轮共生成 ${fmtInt(spd.outputTokens || 0)} Token，总耗时 ${fmtSec(spd.duration)}，综合吞吐 ${spd.tps ?? '--'} tok/s。`
      );
    }

    // Active Model Quota Bar
    const qBox = $('ctx-quota-box');
    const qCalEl = $('ctx-quota-cal');
    const q = ctx.quota;
    if (qBox) {
      if (q) {
        qBox.classList.remove('hidden');
        const syncTime = fmtSyncClock(quotaStatus?.lastSuccessAt);
        const staleTag = quotaStatus?.stale
          ? (en ? ` (Cached${syncTime ? ` · ${syncTime}` : ''})` : `（缓存${syncTime ? ` · ${syncTime}` : ''}）`)
          : (quotaStatus?.summaryStale ? tr('（摘要降级）', ' (Degraded)') : '');
        setText(
          'ctx-quota-title',
          en ? `${q.label || 'Active model'} Quota${staleTag}` : `${q.label || '当前模型'} 配额余量${staleTag}`
        );

        const { p5, pBase, pW, r5, rBase, rW, rAny } = extractQuotaParts(q);

        let valText = '';
        let barPct = null;
        if (p5 !== null && pW !== null) {
          valText = en ? `5h ${p5.toFixed(1)}% · Week ${pW.toFixed(1)}%` : `5h ${p5.toFixed(1)}% · 周 ${pW.toFixed(1)}%`;
          barPct = Math.min(p5, pW);
        } else if (pBase !== null && pW !== null) {
          valText = en ? `Base ${pBase.toFixed(1)}% · Week ${pW.toFixed(1)}%` : `基础 ${pBase.toFixed(1)}% · 周 ${pW.toFixed(1)}%`;
          barPct = Math.min(pBase, pW);
        } else if (p5 !== null) {
          valText = en
            ? `5h ${p5.toFixed(1)}%${r5 ? ` · resets ${r5}` : ''}`
            : `5h ${p5.toFixed(1)}%${r5 ? ` · ${r5}重置` : ''}`;
          barPct = p5;
        } else if (pBase !== null) {
          const rstNote = r5
            ? (en ? `5h resets ${r5}` : `5h ${r5}重置`)
            : (rBase ? (en ? `resets ${rBase}` : `${rBase}重置`) : '');
          valText = en
            ? `Base ${pBase.toFixed(1)}%${rstNote ? ` · ${rstNote}` : ''}`
            : `基础 ${pBase.toFixed(1)}%${rstNote ? ` · ${rstNote}` : ''}`;
          barPct = pBase;
        } else if (pW !== null) {
          valText = en
            ? `Week ${pW.toFixed(1)}%${rW ? ` · resets ${rW}` : ''}`
            : `周 ${pW.toFixed(1)}%${rW ? ` · ${rW}重置` : ''}`;
          barPct = pW;
        } else {
          valText = en
            ? `Unknown${rAny ? ` · resets ${rAny}` : ''}`
            : `余量未知${rAny ? ` · ${rAny}重置` : ''}`;
          barPct = null;
        }
        setText('ctx-quota-val', valText);

        const bar = $('ctx-quota-bar');
        if (bar) {
          if (barPct !== null) {
            setGpuBarRatio(bar, barPct);
            bar.style.background = barPct <= 15
              ? 'var(--danger)'
              : barPct <= 40
                ? 'var(--warn)'
                : 'var(--good)';
          } else {
            setGpuBarRatio(bar, 0);
            bar.style.background = 'var(--cv-muted)';
          }
        }

        if (qCalEl) {
          const activeCal = pickTightestQuotaCalibration(q);
          const calText = formatQuotaCalibrationText(activeCal);
          if (calText) {
            const isDiverged = !(activeCal?.estRemainingTokens != null && Number(activeCal?.estTotalTokens) > 0) && Boolean(activeCal?.diverged);
            qCalEl.classList.remove('hidden', 'is-diverged');
            if (isDiverged) qCalEl.classList.add('is-diverged');
            setText(qCalEl, calText);
            const calTip = isDiverged
              ? tr(
                  '检测到配额变化与本机 Token 消耗不匹配（可能存在跨端或多设备消耗），暂停本次校准并在下一完整周期重新建立基准。',
                  'Detected quota drop not matching local token usage (possible another device/IDE); EMA capacity estimate paused until next clean sample.'
                )
              : tr(
                  '基于近期轮次 Δtokens / ΔremainingFraction 的指数移动平均（EMA）动态校准估算，仅供参考，非服务端官方额度上限。',
                  'Dynamic estimate via EMA of Δtokens / ΔremainingFraction across recent turns (indicative only, not an official server cap).'
                );
            setElTooltip(qCalEl, calTip);
          } else {
            qCalEl.classList.add('hidden');
            qCalEl.classList.remove('is-diverged');
            setText(qCalEl, '');
            setElTooltip(qCalEl, '');
          }
        }
      } else {
        qBox.classList.add('hidden');
        if (qCalEl) {
          qCalEl.classList.add('hidden');
          qCalEl.classList.remove('is-diverged');
          setText(qCalEl, '');
        }
      }
    }

    // Dual-Line Sparkline SVG (Total Context + Cache Read)
    const sparkWrap = $('spark-wrap');
    const sparkSvg = $('spark-svg');
    if (sparkWrap && sparkSvg) {
      if (sparkline.length >= 2) {
        sparkWrap.classList.remove('hidden');
        const maxTok = Math.max(...sparkline.map((s) => Math.max(Number(s.total || 0), Number(s.cache || 0))), 1);
        setText(
          'spark-meta',
          en ? `Last ${sparkline.length} turns · Peak ${fmtTokens(maxTok)}` : `近 ${sparkline.length} 轮 · 峰值 ${fmtTokens(maxTok)}`
        );

        const W = 360;
        const H = 48;
        const padX = 6;
        const padY = 6;
        const pts = sparkline.map((pt, i) => {
          const x = padX + (i / (sparkline.length - 1)) * (W - padX * 2);
          const y = H - padY - (Math.max(0, Number(pt.total || 0)) / maxTok) * (H - padY * 2);
          return { x: Number(x.toFixed(1)), y: Number(y.toFixed(1)), ...pt };
        });
        const cachePts = sparkline.map((pt, i) => {
          const x = padX + (i / (sparkline.length - 1)) * (W - padX * 2);
          const val = Math.max(0, Number(pt.cache || 0));
          const y = H - padY - (val / maxTok) * (H - padY * 2);
          return { x: Number(x.toFixed(1)), y: Number(y.toFixed(1)), val };
        });
        const hasCacheLine = cachePts.some((p) => p.val > 0);
        const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
        const areaPath = `${linePath} L${pts[pts.length - 1].x},${H} L${pts[0].x},${H} Z`;
        const cacheLinePath = cachePts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
        const cacheAreaPath = `${cacheLinePath} L${cachePts[cachePts.length - 1].x},${H} L${cachePts[0].x},${H} Z`;
        const last = pts[pts.length - 1];
        const lastCache = cachePts[cachePts.length - 1];

        sparkSvg.innerHTML =
          `<defs>` +
          `<linearGradient id="spkGrad" x1="0" y1="0" x2="0" y2="1">` +
          `<stop offset="0%" stop-color="var(--cv-accent)" stop-opacity="0.30"/>` +
          `<stop offset="100%" stop-color="var(--cv-accent)" stop-opacity="0.02"/>` +
          `</linearGradient>` +
          `<linearGradient id="spkCacheGrad" x1="0" y1="0" x2="0" y2="1">` +
          `<stop offset="0%" stop-color="var(--good)" stop-opacity="0.20"/>` +
          `<stop offset="100%" stop-color="var(--good)" stop-opacity="0.01"/>` +
          `</linearGradient>` +
          `</defs>` +
          `<path d="${areaPath}" fill="url(#spkGrad)"/>` +
          (hasCacheLine ? `<path d="${cacheAreaPath}" fill="url(#spkCacheGrad)"/>` : '') +
          `<path d="${linePath}" fill="none" stroke="var(--cv-accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>` +
          (hasCacheLine ? `<path d="${cacheLinePath}" fill="none" stroke="var(--good)" stroke-width="1.35" stroke-dasharray="3.2 2.2" stroke-linecap="round" stroke-linejoin="round"/>` : '') +
          `<circle cx="${last.x}" cy="${last.y}" r="2.8" fill="var(--cv-accent)"/>` +
          (hasCacheLine ? `<circle cx="${lastCache.x}" cy="${lastCache.y}" r="2.2" fill="var(--good)"/>` : '');
      } else {
        sparkWrap.classList.add('hidden');
      }
    }
  }

  function fmtLocalTime(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function renderTurnsTimelineCard(turns = [], totalTurnsCount = 0, promptTurns = [], latestPromptStartup = null, cacheStatus = null) {
    const en = isEn();
    const viewMode = state.turnsView === 'prompts' ? 'prompts' : 'steps';
    const effectiveTurnsCount = Number(totalTurnsCount || turns.length || 0);
    const coldBadge = $('turns-cold-badge');
    if (coldBadge) {
      if (cacheStatus?.latestTurnCacheBreak) {
        coldBadge.classList.remove('hidden');
        coldBadge.classList.add('status-pill', 'danger');
        setText(coldBadge, tr('最近断流', 'Cache break'));
        const prevPct = cacheStatus?.breakPrevHitPercent != null && Number.isFinite(Number(cacheStatus.breakPrevHitPercent))
          ? `${Math.round(Number(cacheStatus.breakPrevHitPercent))}%`
          : '--';
        setElTooltip(coldBadge, tr(`最近一轮发生缓存断流（前轮命中 ${prevPct}）`, `Latest turn had a cache break (prev hit ${prevPct})`));
      } else if (latestPromptStartup?.state === 'compacted' || cacheStatus?.latestTurnCompacted) {
        coldBadge.classList.add('hidden');
        setText(coldBadge, '');
        setElTooltip(coldBadge, '');
      } else {
        const isLatestCold = latestPromptStartup?.state === 'cold' && effectiveTurnsCount > 1;
        coldBadge.classList.toggle('hidden', !isLatestCold);
        if (isLatestCold) {
          const pctStr = latestPromptStartup?.cacheHitPercent != null && Number.isFinite(Number(latestPromptStartup.cacheHitPercent))
            ? `${Math.round(Number(latestPromptStartup.cacheHitPercent))}%`
            : '0%';
          setText(coldBadge, en ? `Cold start ${pctStr}` : `本 Prompt 首跳冷启动 ${pctStr}`);
          setElTooltip(
            coldBadge,
            en
              ? `Latest Prompt #P${latestPromptStartup.promptIndex || '?'} first hop cache hit was ${pctStr} (cold start)`
              : `最新 Prompt #P${latestPromptStartup.promptIndex || '?'} 首步缓存命中率仅 ${pctStr}（触发冷启动）`
          );
        }
      }
    }

    $('turns-filter-seg')?.classList.toggle('hidden', viewMode === 'prompts');
    $('prompt-filter-seg')?.classList.toggle('hidden', viewMode !== 'prompts');

    const listEl = $('turns-timeline');
    if (!listEl) return;
    const renderSigs = state.lastRenderSigs || (state.lastRenderSigs = {});
    const applyListHtmlPreservingScroll = (sigKey, html) => {
      if (renderSigs[sigKey] === html) return;
      renderSigs[sigKey] = html;
      const prevTop = listEl.scrollTop || 0;
      listEl.innerHTML = html;
      if (prevTop > 0) listEl.scrollTop = prevTop;
    };

    if (viewMode === 'prompts') {
      const safePrompts = Array.isArray(promptTurns) ? promptTurns : [];
      setText('turns-count-chip', en ? `${fmtInt(safePrompts.length)} prompts` : `${fmtInt(safePrompts.length)} 组 Prompt`);
      setText(
        'turns-toolbar-desc',
        tr(
          '按用户输入分组，诊断每轮冷 / 热启动缓存命中、调用次数与上下文增量',
          'Grouped by user prompt: cold/warm cache startup, calls & context delta'
        )
      );

      const filteredPrompts = state.promptTurnsFilter === 'cold'
        ? safePrompts.filter((p) => p?.startupState === 'cold' && !p?.isCompacted)
        : safePrompts;

      if (!filteredPrompts.length) {
        const emptyMsg = safePrompts.length > 0
          ? tr('当前筛选条件下没有匹配的 Prompt 轮次', 'No prompts match the current filter')
          : tr('暂无按 Prompt 分组的轮次记录', 'No prompt-grouped turns recorded yet');
        applyListHtmlPreservingScroll('turns-timeline', `<div class="kv-row"><span class="muted">${escZh(emptyMsg)}</span></div>`);
        return;
      }

      const promptsHtml = filteredPrompts.map((p) => {
        const st = p.startupState;
        const pctNum = p.startupCacheHitPercent != null && Number.isFinite(Number(p.startupCacheHitPercent))
          ? Math.round(Number(p.startupCacheHitPercent))
          : null;
        const pctSuffix = pctNum !== null ? ` ${pctNum}%` : '';
        let startupPillHtml = `<span class="startup-pill neutral">${escZh(tr('首轮', 'First turn'))}</span>`;
        if (st === 'compacted' || p.isCompacted) {
          const dropPct = p.compactionDropPercent != null && Number.isFinite(Number(p.compactionDropPercent))
            ? ` -${Math.round(Number(p.compactionDropPercent))}%`
            : '';
          startupPillHtml = `<span class="startup-pill compacted" title="${escZh(tr('本轮发生自动上下文压缩，非异常冷启动', 'Auto-compaction occurred (not an unexpected cold start)'))}">${escZh(`${tr('自动压缩', 'Auto-compacted')}${dropPct}`)}</span>`;
        } else if (st === 'hot') {
          startupPillHtml = `<span class="startup-pill hot" title="${escZh(tr('首步缓存高度命中', 'High first-hop cache hit'))}">${escZh(`${tr('热启动', 'Warm hit')}${pctSuffix}`)}</span>`;
        } else if (st === 'warm') {
          startupPillHtml = `<span class="startup-pill warm" title="${escZh(tr('首步部分命中缓存', 'Partial first-hop cache hit'))}">${escZh(`${tr('部分缓存', 'Partial cache')}${pctSuffix}`)}</span>`;
        } else if (st === 'cold') {
          startupPillHtml = `<span class="startup-pill cold" title="${escZh(tr('首步缓存未命中或偏低（冷启动）', 'First-hop cache miss or low hit (cold start)'))}">${escZh(`${tr('冷启动', 'Cold start')}${pctSuffix}`)}</span>`;
        }
        const breakPillHtml = (!p.isCompacted && st !== 'compacted' && st !== 'cold' && p.isCacheBreak)
          ? `<span class="startup-pill cold" title="${escZh(tr('本轮存在缓存断流', 'Cache break detected in this turn'))}">${escZh(tr('缓存断流', 'Cache break'))}</span>`
          : '';

        const delta = Number(p.deltaTokens || 0);
        const sign = delta >= 0 ? '+' : '-';
        const deltaCls = delta < -1000 ? 'compact' : delta >= 8000 ? 'spike' : '';
        const deltaStr = `${sign}${fmtTokens(Math.abs(delta), 1)}`;
        const timeStr = fmtLocalTime(p.createdAt);
        const previewText = p.promptPreview ? String(p.promptPreview) : tr('（无用户输入摘要）', '(No prompt preview)');
        const fullText = p.promptFull ? String(p.promptFull) : previewText;

        const modelChip = p.model ? `<span class="turn-chip">${esc(p.model)}</span>` : '';
        const speedParts = [];
        if (p.ttft != null) speedParts.push(en ? `TTFT ${p.ttft}s` : `首字 ${p.ttft}s`);
        if (p.avgTps != null) speedParts.push(en ? `Avg ${p.avgTps} tok/s` : `均速 ${p.avgTps} tok/s`);
        const speedChip = speedParts.length
          ? `<span class="turn-chip speed">${escZh(speedParts.join(' · '))}</span>`
          : '';
        const costChip = p.costUSD > 0
          ? `<span class="turn-chip cost" title="${escZh(tr('本轮 Prompt 累计 API 等值参考', 'Cumulative API est. for this prompt'))}">${esc(fmtUSD(p.costUSD))}</span>`
          : '';
        const toolsHtml = (p.tools || []).map((toolName) =>
          `<span class="turn-chip tool">${esc(toolName)}</span>`
        ).join('');

        return (
          `<div class="turn-item">` +
          `<div class="turn-top">` +
          `<span class="turn-top-left">` +
          `<span class="turn-idx">${esc(`#P${p.promptIndex ?? '?'}`)}</span>` +
          startupPillHtml +
          breakPillHtml +
          `<span class="turn-chip">${escZh(en ? `${fmtInt(p.callsCount || 0)} calls` : `${fmtInt(p.callsCount || 0)} 次调用`)}</span>` +
          `</span>` +
          `<span class="turn-ctx-group">` +
          `<span class="turn-ctx-num">${esc(`${fmtInt(p.endTokens || 0)} tok`)}</span>` +
          `<span class="delta-tag ${deltaCls}" title="${escZh(tr('较上一组 Prompt 结束窗口变化', 'Context delta vs. previous prompt'))}">${esc(deltaStr)}</span>` +
          `</span>` +
          `</div>` +
          `<div class="prompt-preview-line" title="${esc(fullText)}">${esc(previewText)}</div>` +
          `<div class="turn-meta-row">` +
          (timeStr ? `<span>${esc(timeStr)}</span><span>·</span>` : '') +
          `<span>${escZh(`${tr('输出', 'Out')} ${fmtTokens(p.outputTokens || 0, 1)}`)}</span>` +
          modelChip +
          speedChip +
          costChip +
          toolsHtml +
          `</div>` +
          `</div>`
        );
      }).join('');
      applyListHtmlPreservingScroll('turns-timeline', promptsHtml);
      return;
    }

    setText('turns-count-chip', en ? `${fmtInt(totalTurnsCount || turns.length)} turns` : `${fmtInt(totalTurnsCount || turns.length)} 轮`);
    setText(
      'turns-toolbar-desc',
      tr(
        '倒序展示最近 40 轮上下文涨跌（Δ）、缓存率、单轮耗时与调用工具',
        'Last 40 turns (newest first): context Δ, cache hit, latency & tools'
      )
    );

    let filtered = turns;
    if (state.turnsFilter === 'spike') {
      filtered = turns.filter((t) => Math.abs(t.deltaTokens || 0) >= 5000);
    } else if (state.turnsFilter === 'tools') {
      filtered = turns.filter((t) => Array.isArray(t.tools) && t.tools.length > 0);
    }

    if (!filtered.length) {
      const emptyMsg = turns.length > 0
        ? tr('当前筛选条件下没有匹配的轮次', 'No turns match the current filter')
        : tr('暂无已完成轮次记录', 'No completed turns yet');
      applyListHtmlPreservingScroll('turns-timeline', `<div class="kv-row"><span class="muted">${escZh(emptyMsg)}</span></div>`);
      return;
    }

    const stepsHtml = filtered.map((t) => {
      const delta = Number(t.deltaTokens || 0);
      const sign = delta >= 0 ? '+' : '-';
      const deltaCls = delta < -1000 ? 'compact' : delta >= 8000 ? 'spike' : '';
      const deltaStr = `${sign}${fmtTokens(Math.abs(delta), 1)}`;
      const timeStr = fmtLocalTime(t.createdAt);
      const stepLabel = t.stepIndex != null ? ` · Step ${t.stepIndex}` : '';
      const thinkPct = t.thinkingTokens > 0 && t.outputTokens > 0
        ? ` · ${Math.round((t.thinkingTokens / t.outputTokens) * 100)}%`
        : '';
      const thinkSub = t.thinkingTokens > 0
        ? (en ? ` (Think ${fmtTokens(t.thinkingTokens, 1)}${thinkPct})` : `（思 ${fmtTokens(t.thinkingTokens, 1)}${thinkPct}）`)
        : '';

      let turnStatusPillHtml = '';
      if (t.isCompacted) {
        const dropPct = t.compactionDropPercent != null && Number.isFinite(Number(t.compactionDropPercent))
          ? Math.round(Number(t.compactionDropPercent))
          : null;
        const compactLabel = dropPct !== null
          ? `${tr('自动压缩', 'Auto-compacted')} -${dropPct}%`
          : tr('自动压缩', 'Auto-compacted');
        turnStatusPillHtml = `<span class="startup-pill compacted" title="${escZh(tr('上下文自动压缩，重新构建缓存前缀', 'Context auto-compacted; rebuilding cache prefix'))}">${escZh(compactLabel)}</span>`;
      } else if (t.isCacheBreak) {
        const prevStr = t.cacheBreakPrevPercent != null && Number.isFinite(Number(t.cacheBreakPrevPercent))
          ? `${Math.round(Number(t.cacheBreakPrevPercent))}%`
          : '--';
        const curStr = t.cacheHitPercent != null && Number.isFinite(Number(t.cacheHitPercent))
          ? `${Math.round(Number(t.cacheHitPercent))}%`
          : '0%';
        turnStatusPillHtml = `<span class="startup-pill cold" title="${escZh(tr(`前轮命中 ${prevStr} → 本轮 ${curStr}`, `Prev ${prevStr} → This ${curStr}`))}">${escZh(tr('缓存断流', 'Cache break'))}</span>`;
      }

      const turnCw = Number(t.cacheWriteTokens || 0);
      const cacheMetaText = turnCw > 0
        ? (en ? `Cache ${t.cacheHitPercent ?? 0}% · Write ${fmtTokens(turnCw, 1)}` : `缓存 ${t.cacheHitPercent ?? 0}% · 写入 ${fmtTokens(turnCw, 1)}`)
        : `${tr('缓存', 'Cache')} ${t.cacheHitPercent ?? 0}%`;

      const costChip = t.isPriced && t.costUSD > 0
        ? `<span class="turn-chip cost" title="${escZh(tr('单轮 API 等值参考', 'Turn API ref. estimate'))}">${esc(fmtUSD(t.costUSD))}</span>`
        : '';
      const ttftSub = t.ttft != null ? ` · ${tr('首字', 'TTFT')} ${t.ttft}s` : (t.duration != null ? ` · ${t.duration}s` : '');
      const hasTurnEffGap = Boolean(t.effectiveTps > 0 && (!(t.tps > 0) || Math.abs(t.effectiveTps - t.tps) / t.tps >= 0.2));
      const effSub = hasTurnEffGap ? ` · ${tr('整请求', 'Req')} ${t.effectiveTps}` : '';
      const speedChip = t.tps != null
        ? `<span class="turn-chip speed">${esc(`${t.tps} tok/s${ttftSub}${effSub}`)}</span>`
        : (hasTurnEffGap ? `<span class="turn-chip speed">${esc(`${tr('整请求', 'Req')} ${t.effectiveTps} tok/s${ttftSub}`)}</span>` : '');
      const modelChip = t.model && t.model !== '未记录模型'
        ? `<span class="turn-chip">${esc(t.model)}</span>`
        : '';
      const toolsHtml = (t.tools || []).map((toolName) =>
        `<span class="turn-chip tool">${esc(toolName)}</span>`
      ).join('');

      return (
        `<div class="turn-item">` +
        `<div class="turn-top">` +
        `<span class="turn-top-left">` +
        `<span class="turn-idx">${escZh(en ? `Turn #${t.turnIndex}${stepLabel}` : `第 #${t.turnIndex} 轮${stepLabel}`)}</span>` +
        turnStatusPillHtml +
        `</span>` +
        `<span class="turn-ctx-group">` +
        `<span class="turn-ctx-num">${esc(`${fmtInt(t.totalTokens)} tok`)}</span>` +
        `<span class="delta-tag ${deltaCls}" title="${escZh(tr('较上一轮上下文窗口变化', 'Context delta vs. prior turn'))}">${esc(deltaStr)}</span>` +
        `</span>` +
        `</div>` +
        `<div class="turn-meta-row">` +
        (timeStr ? `<span>${esc(timeStr)}</span><span>·</span>` : '') +
        `<span>${escZh(cacheMetaText)}</span>` +
        `<span>·</span>` +
        `<span>${escZh(en ? `In ${fmtTokens(t.inputTokens, 1)} / Out ${fmtTokens(t.outputTokens, 1)}${thinkSub}` : `入 ${fmtTokens(t.inputTokens, 1)} / 出 ${fmtTokens(t.outputTokens, 1)}${thinkSub}`)}</span>` +
        modelChip +
        costChip +
        speedChip +
        toolsHtml +
        `</div>` +
        `</div>`
      );
    }).join('');
    applyListHtmlPreservingScroll('turns-timeline', stepsHtml);
  }

  function renderHeavyItemsCard(heavyItems = []) {
    const card = $('heavy-card');
    const list = $('heavy-items-list');
    if (!card || !list) return;
    const en = isEn();

    const items = Array.isArray(heavyItems) ? heavyItems.filter(Boolean).slice(0, 10) : [];
    if (!items.length) {
      card.classList.add('hidden');
      setText('heavy-count-chip', tr('0 项', '0 items'));
      list.innerHTML = '';
      return;
    }

    card.classList.remove('hidden');
    const sumTok = items.reduce((acc, it) => acc + Number(it.estTokens || 0), 0);
    setText('heavy-count-chip', en ? `${items.length} items · ~${fmtTokens(sumTok, 1)}` : `${items.length} 项 · 约 ${fmtTokens(sumTok, 1)}`);

    const kindMap = {
      tool: { text: tr('工具', 'Tool'), cls: 'tool' },
      user: { text: tr('用户', 'User'), cls: 'user' },
      assistant: { text: tr('回复', 'Reply'), cls: 'assistant' },
      thinking: { text: tr('思考', 'Think'), cls: 'thinking' },
      checkpoint: { text: tr('摘要', 'Summary'), cls: 'checkpoint' }
    };
    const maxTok = Math.max(...items.map((it) => Number(it.estTokens || 0)), 1);

    list.innerHTML = items.map((it, idx) => {
      const rank = it.rank ?? (idx + 1);
      const km = kindMap[it.kind] || { text: it.kind || tr('其他', 'Other'), cls: 'other' };
      const estTok = Number(it.estTokens || 0);
      const sharePct = it.sharePercent != null && Number.isFinite(Number(it.sharePercent))
        ? Number(it.sharePercent)
        : null;
      const barW = Math.max(2, Math.min(100, (estTok / maxTok) * 100)).toFixed(1);
      const stepNote = it.stepIndex != null ? `Step ${it.stepIndex}` : '';
      const charsNote = it.chars > 0 ? `${fmtInt(it.chars)} ${tr('字符', 'chars')}` : '';
      const metaTip = [stepNote, charsNote].filter(Boolean).join(' · ');
      const shareStr = sharePct !== null ? ` (${sharePct.toFixed(1)}%)` : '';
      const preview = it.preview ? String(it.preview).trim() : '';

      return (
        `<div class="heavy-item" title="${escZh(metaTip)}">` +
        `<div class="heavy-item-top">` +
        `<span class="heavy-left">` +
        `<span class="heavy-rank num">#${esc(rank)}</span>` +
        `<span class="heavy-kind-tag ${km.cls}">${escZh(km.text)}</span>` +
        `<span class="heavy-label" title="${esc(it.label || '')}">${esc(it.label || tr('未命名步骤', 'Unnamed step'))}</span>` +
        `</span>` +
        `<span class="heavy-val num-strong">${escZh(`~${fmtTokens(estTok, 1)} tok${shareStr}`)}</span>` +
        `</div>` +
        `<div class="heavy-bar-track"><div class="heavy-bar-fill is-gpu ${km.cls}" style="--cv-ratio:${(Number(barW) / 100).toFixed(4)};width:${barW}%"></div></div>` +
        (preview ? `<div class="heavy-preview" title="${esc(preview)}">${esc(preview)}</div>` : '') +
        `</div>`
      );
    }).join('');
  }

  function renderServerBreakdownCard(bd) {
    const card = $('breakdown-card');
    const list = $('breakdown-groups');
    if (!card || !list) return;
    const en = isEn();

    if (!bd?.groups?.length) {
      card.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');
    const nameMap = en
      ? {
          'System Prompt': 'System Prompt (Instructions & Rules)',
          'Skills': 'Skills',
          'Tools': 'Tools (MCP & Built-in Schemas)',
          'Chat Messages': 'Chat Messages (Dialogue, Thinking & Tool Results)'
        }
      : {
          'System Prompt': 'System Prompt（系统提示词与规则）',
          'Skills': 'Skills 技能指令',
          'Tools': 'Tools（MCP 与内置工具定义）',
          'Chat Messages': 'Chat Messages（对话消息、思考与工具结果）'
        };
    const total = Math.max(1, bd.totalTokens || bd.groups.reduce((a, g) => a + (g.tokens || 0), 0));
    const calibNote = bd.calibrated
      ? `<div class="bd-calib-note">${escZh(
          en
            ? `Calibrated to measured input (raw est. ${fmtInt(bd.reportedTotalTokens || total)} → actual ${fmtInt(total)} tok)`
            : `按实测输入比例校准（原始估算 ${fmtInt(bd.reportedTotalTokens || total)} → 实测 ${fmtInt(total)} tok）`
        )}</div>`
      : '';

    let catPanelHtml = '';
    if (Array.isArray(bd.categories) && bd.categories.length > 4) {
      const catItems = bd.categories.filter((c) => Number(c?.tokens || 0) > 0);
      if (catItems.length > 0) {
        const maxCatTok = Math.max(...catItems.map((c) => Number(c.tokens || 0)), 1);
        const catRowsHtml = catItems.map((c) => {
          const tok = Number(c.tokens || 0);
          const pct = Number.isFinite(Number(c.percent))
            ? Number(c.percent)
            : (total > 0 ? (tok / total) * 100 : 0);
          const barW = Math.max(2, (tok / maxCatTok) * 100).toFixed(1);
          const meta = CONTEXT_CAT_META[Number(c.type)];
          const col = c.color || meta?.color || 'var(--cv-accent)';
          const label = en ? (meta?.enLabel || c.key || c.label || 'Other') : (c.label || meta?.label || '其他');
          return (
            `<div class="bd-cat-row">` +
            `<span class="bd-cat-name"><i class="bd-cat-swatch" style="background:${esc(col)}"></i><span>${escZh(label)}</span></span>` +
            `<div class="bd-cat-track"><div class="bd-cat-fill" style="width:${barW}%;background:${esc(col)}"></div></div>` +
            `<span class="bd-cat-val num">${escZh(`${fmtIntZh(tok)} tok (${pct.toFixed(1)}%)`)}</span>` +
            `</div>`
          );
        }).join('');
        catPanelHtml =
          `<div class="bd-cat-panel">` +
          `<div class="bd-cat-head"><span>${escZh(tr('10 类上下文细分占比', '10-Category Context Breakdown'))}</span><span class="muted xs num">${escZh(en ? `${catItems.length} cats` : `${catItems.length} 类`)}</span></div>` +
          `<div class="bd-cat-list">${catRowsHtml}</div>` +
          `</div>`;
      }
    }

    list.innerHTML = calibNote + catPanelHtml + bd.groups.map((g) => {
      const pct = (((g.tokens || 0) / total) * 100).toFixed(1);
      const isSkills = g.key === 'skills' || g.name === 'Skills';
      const rawChildren = g.children || g.topChildren || [];
      const children = rawChildren.slice(0, 18).map((c) =>
        `<span class="bd-chip">${esc(c.name)} · ${fmtInt(c.tokens)}</span>`
      ).join('');
      const totalChildCount = g.childrenCount || rawChildren.length;
      const moreCount = Math.max(0, totalChildCount - 18);
      const moreChip = moreCount > 0 ? `<span class="bd-chip muted">+${moreCount} ${tr('项', 'more')}</span>` : '';
      return (
        `<div class="bd-group${isSkills ? ' is-skills' : ''}">` +
        `<div class="bd-head"><span>${escZh(nameMap[g.name] || (en ? g.name : g.label) || g.name)}</span>` +
        `<span class="num">${escZh(`${fmtInt(g.tokens)} tok (${pct}%)`)}</span></div>` +
        (children ? `<div class="bd-children">${children}${moreChip}</div>` : '') +
        `</div>`
      );
    }).join('');
  }

  function renderTechnicalAuditCard(snap) {
    const ctx = snap.context || {};
    const audit = snap.audit || {};
    const en = isEn();

    const reqRows = [
      [tr('会话标题', 'Session Title'), snap.conversationTitle || '--'],
      [tr('会话 ID', 'Session ID'), snap.conversationId || '--'],
      [tr('当前模型', 'Current Model'), ctx.model || '--'],
      [tr('输入 Token（未命中缓存）', 'Input Tokens (Uncached)'), fmtInt(ctx.inputTokens)],
      [tr('缓存读取 Token（优惠计费）', 'Cache Read Tokens'), fmtInt(ctx.cacheTokens)],
      ...(Number(ctx.cacheWriteTokens || 0) > 0 ? [[tr('缓存写入 Token', 'Cache Write Tokens'), fmtInt(ctx.cacheWriteTokens)]] : []),
      [tr('输出总 Token', 'Total Output Tokens'), fmtInt(ctx.outputTokens)],
      [tr('其中：推理思考 / 可见回复', 'Thinking / Visible Reply'), `${fmtInt(ctx.thinkingTokens)} / ${fmtInt(ctx.responseTokens)}`],
      [tr('服务端报告总计 / 下轮预估', 'Server Reported / Next Est.'), `${fmtInt(ctx.actual)} / ${fmtInt(ctx.estimate)}`],
      [tr('归档步数 / 模型请求轮数', 'Archived Steps / Turns'), en ? `${fmtInt(audit.totalSteps)} steps / ${fmtInt(audit.turnsCount)} turns` : `${fmtInt(audit.totalSteps)} 步 / ${fmtInt(audit.turnsCount)} 轮`],
      [tr('累计工具调用次数', 'Total Tool Calls'), en ? `${fmtInt(audit.toolCallsCount)} calls` : `${fmtInt(audit.toolCallsCount)} 次`]
    ];
    if (snap.sessionDiagnostics && (snap.sessionDiagnostics.eventsCount > 0 || snap.sessionDiagnostics.routingCount > 0)) {
      const sd = snap.sessionDiagnostics;
      reqRows.push([
        tr('本会话取证记录', 'Session Diagnostics'),
        en
          ? `${fmtInt(sd.eventsCount || 0)} anomalies · ${fmtInt(sd.routingCount || 0)} shadow routes (${sd.sqliteUsed ? 'SQLite' : 'Transcript'})`
          : `异常 ${fmtInt(sd.eventsCount || 0)} 条 · 灰度路由 ${fmtInt(sd.routingCount || 0)} 次（${sd.sqliteUsed ? 'SQLite' : 'Transcript'}）`
      ]);
    }

    const reqKv = $('req-kv');
    if (reqKv) {
      reqKv.innerHTML = reqRows.map(([k, v]) =>
        `<div class="kv-row"><span class="kv-k">${escZh(k)}</span><span class="kv-v">${escZh(v)}</span></div>`
      ).join('');
    }

    const g = audit.groups || {};
    const fmtRange = (m) => {
      if (!m || (!m.low && !m.high && !m.bytes)) return '0 tok';
      const tokRange = m.low === m.high ? `${fmtInt(m.low)} tok` : `${fmtInt(m.low)} ~ ${fmtInt(m.high)} tok`;
      return en ? `${tokRange} (${fmtBytes(m.bytes)})` : `${tokRange}（${fmtBytes(m.bytes)}）`;
    };

    const localRows = [
      [en ? `User Messages (${audit.userMessages || 0})` : `用户输入消息（共 ${audit.userMessages || 0} 条）`, fmtRange(g.user)],
      [en ? `Assistant Replies (${audit.assistantMessages || 0})` : `助手回复正文（共 ${audit.assistantMessages || 0} 条）`, fmtRange(g.assistant)],
      [tr('模型思考链归档', 'Archived Thinking'), fmtRange(g.thinking)],
      [tr('工具调用入参与返回日志', 'Tool Args & Results'), fmtRange(g.tools)],
      [tr('检查点压缩摘要', 'Compaction Checkpoints'), fmtRange(g.summaries)],
      [tr('系统提示词基准', 'System Prompt Base'), fmtRange(g.system)],
      [tr('工具 Schema 定义基准', 'Tool Schema Definitions'), fmtRange(g.definitions)],
      [tr('多媒体与文件附件（×引用次数）', 'Media & File Attachments (×refs)'), fmtRange(audit.attachmentTotal)],
      [tr('全会话归档内容本地合计', 'Total Archived Content (Local Est.)'), fmtRange(audit.localTotal)]
    ];

    const localKv = $('local-kv');
    if (localKv) {
      localKv.innerHTML = localRows.map(([k, v]) =>
        `<div class="kv-row"><span class="kv-k">${escZh(k)}</span><span class="kv-v">${escZh(v)}</span></div>`
      ).join('');
    }

    const attEl = $('attachments-list');
    const atts = audit.attachments || [];
    if (attEl) {
      if (!atts.length) {
        attEl.innerHTML = `<div class="kv-row"><span class="muted">${escZh(tr('当前会话未检测到图片或文档附件引用', 'No image or document attachments referenced in this session'))}</span></div>`;
      } else {
        attEl.innerHTML = atts.map((a) => {
          const refTag = (a.references || 1) > 1 ? ` ×${a.references}` : '';
          const dimTag = a.dimensions ? ` · ${a.dimensions}` : '';
          const sizeTag = a.bytes ? ` · ${fmtBytes(a.bytes)}` : '';
          const tokStr = a.status === 'parsed'
            ? (a.low === a.high ? `${tr('约', '~')}${fmtInt(a.low)} tok` : `${fmtInt(a.low)}~${fmtInt(a.high)} tok`)
            : (en ? `Unknown (${a.note || 'not treated as 0'})` : `未知（${a.note || '未按 0 计'}）`);
          return (
            `<div class="att-item">` +
            `<div><div class="att-name">${esc(a.name)}${esc(refTag)}</div>` +
            `<div class="att-meta">${escZh(`${a.kind || tr('文件', 'File')}${dimTag}${sizeTag}`)}</div></div>` +
            `<div class="kv-v">${escZh(tokStr)}</div>` +
            `</div>`
          );
        }).join('');
      }
    }
  }

  function deriveSessionModelsFallback(ctx = {}, turns = []) {
    if (!Array.isArray(turns) || !turns.length) return [];
    const suffixRe = /\s*\((?:XHigh|Low|Medium|High|Minimal|Thinking|Fast|Orchestrator)\)\s*$/i;
    const aggMap = new Map();
    for (const t of turns) {
      if (!t || !(Number(t.totalTokens || 0) > 0)) continue;
      const rawDisp = t.model && t.model !== '未记录模型' ? String(t.model).trim() : '';
      const cleanDisp = rawDisp ? rawDisp.replace(suffixRe, '').trim() : '';
      const mKey = t.modelKey || null;
      const groupKey = mKey ? `key:${mKey}` : (cleanDisp ? `name:${cleanDisp.toLowerCase()}` : 'unrecorded');
      const displayName = cleanDisp || '未记录模型';
      let item = aggMap.get(groupKey);
      if (!item) {
        item = {
          modelKey: mKey,
          displayName,
          turnsCount: 0,
          inputTokens: 0,
          cacheTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costUSD: 0,
          cacheSavingsUSD: 0,
          tpsSum: 0,
          tpsCount: 0,
          variants: new Set()
        };
        aggMap.set(groupKey, item);
      }
      item.turnsCount += 1;
      item.inputTokens += Number(t.inputTokens || 0);
      item.cacheTokens += Number(t.cacheTokens || 0);
      item.outputTokens += Number(t.outputTokens || 0);
      item.totalTokens += Number(t.totalTokens || 0);
      item.costUSD += Number(t.costUSD || 0);
      if (typeof t.tps === 'number' && t.tps > 0) {
        item.tpsSum += t.tps;
        item.tpsCount += 1;
      }
      if (rawDisp && rawDisp !== displayName) item.variants.add(rawDisp);
    }
    const activeDisp = String(ctx?.model || '').replace(suffixRe, '').trim().toLowerCase();
    return [...aggMap.values()]
      .map((m) => {
        const promptSum = m.inputTokens + m.cacheTokens;
        return {
          modelKey: m.modelKey,
          displayName: m.displayName,
          turnsCount: m.turnsCount,
          inputTokens: m.inputTokens,
          cacheTokens: m.cacheTokens,
          outputTokens: m.outputTokens,
          totalTokens: m.totalTokens,
          cacheHitPercent: promptSum > 0 ? Number(((m.cacheTokens / promptSum) * 100).toFixed(1)) : null,
          costUSD: Number(m.costUSD.toFixed(4)),
          cacheSavingsUSD: 0,
          avgTps: m.tpsCount > 0 ? Number((m.tpsSum / m.tpsCount).toFixed(1)) : null,
          variants: [...m.variants].slice(0, 4),
          isCurrent: Boolean(
            (ctx?.modelKey && m.modelKey && m.modelKey === ctx.modelKey) ||
            (!ctx?.modelKey && activeDisp && activeDisp !== '未记录模型' && m.displayName.toLowerCase() === activeDisp)
          )
        };
      })
      .sort((a, b) => (b.totalTokens - a.totalTokens) || (b.turnsCount - a.turnsCount));
  }

  function renderSessionModelsCard(ctx = {}, turns = []) {
    const wrap = $('ctx-session-models-wrap');
    const list = $('ctx-session-models-list');
    if (!wrap || !list) return;
    const en = isEn();

    const models = Array.isArray(ctx?.sessionModels)
      ? ctx.sessionModels.filter(Boolean)
      : deriveSessionModelsFallback(ctx, turns);

    if (!models.length) {
      wrap.classList.add('hidden');
      setText('ctx-session-models-count', tr('0 个模型', '0 models'));
      list.innerHTML = '';
      return;
    }

    wrap.classList.remove('hidden');
    setText('ctx-session-models-count', en ? `${fmtInt(models.length)} models` : `${fmtInt(models.length)} 个模型`);
    setText(
      'ctx-session-models-hint',
      models.length === 1
        ? (en ? `${fmtInt(models[0].turnsCount || 0)} turns · Single-model avg` : `共 ${fmtInt(models[0].turnsCount || 0)} 轮 · 单模型均值`)
        : tr('按消耗排序 · 模型级平均缓存', 'Sorted by tokens · Per-model avg cache')
    );

    const renderSigs = state.lastRenderSigs || (state.lastRenderSigs = {});
    const modelsHtml = models.map((m) => {
      const pct = typeof m.cacheHitPercent === 'number' && Number.isFinite(m.cacheHitPercent)
        ? m.cacheHitPercent
        : null;
      const rateCls = pct === null ? '' : (pct >= 70 ? 'good-text' : pct >= 30 ? 'accent-text' : 'warn-text');
      const barCol = pct === null ? 'var(--cv-muted)' : (pct >= 70 ? 'var(--good)' : pct >= 30 ? 'var(--cv-accent)' : 'var(--warn)');
      const barW = pct !== null ? Math.min(100, Math.max(2, pct)) : 0;
      const promptTot = Number(m.inputTokens || 0) + Number(m.cacheTokens || 0);
      const curTag = m.isCurrent ? `<span class="session-model-cur">${escZh(tr('当前', 'Active'))}</span>` : '';
      const variantsNote = Array.isArray(m.variants) && m.variants.length
        ? (en ? ` (tiers: ${m.variants.join(' / ')})` : `（含档位：${m.variants.join(' / ')}）`)
        : '';
      const mSav = fmtCacheSavings(m.cacheSavingsUSD);
      const mCw = Number(m.cacheWriteTokens || 0);
      const dispName = (m.displayName === '未记录模型' && en) ? 'Unrecorded model' : (m.displayName || tr('未记录模型', 'Unrecorded model'));
      const tipParts = [
        `${dispName}${variantsNote}`,
        en ? `${fmtInt(m.turnsCount || 0)} turns` : `${fmtInt(m.turnsCount || 0)} 轮`,
        pct !== null ? tr(`平均缓存命中 ${pct.toFixed(1)}%`, `Avg cache hit ${pct.toFixed(1)}%`) : tr('无缓存数据', 'No cache data'),
        en
          ? `Cache ${fmtTokens(m.cacheTokens || 0, 1)}${mCw > 0 ? ` / Write ${fmtTokens(mCw, 1)}` : ''} / In ${fmtTokens(m.inputTokens || 0, 1)} / Out ${fmtTokens(m.outputTokens || 0, 1)}`
          : `缓存 ${fmtTokens(m.cacheTokens || 0, 1)}${mCw > 0 ? ` / 写入 ${fmtTokens(mCw, 1)}` : ''} / 新增输入 ${fmtTokens(m.inputTokens || 0, 1)} / 输出 ${fmtTokens(m.outputTokens || 0, 1)}`,
        m.avgTps != null ? `${tr('均速', 'Avg')} ${m.avgTps} tok/s` : '',
        m.costUSD > 0 ? `${tr('折算', 'Est.')} ${fmtUSD(m.costUSD)}` : '',
        mSav ? mSav.text : ''
      ].filter(Boolean);

      return (
        `<div class="session-model-row${m.isCurrent ? ' is-current' : ''}" title="${escZh(tipParts.join(' · '))}">` +
        `<div class="session-model-top">` +
        `<span class="session-model-left">` +
        `<span class="session-model-name">${esc(dispName)}</span>` +
        curTag +
        `<span class="turn-chip">${escZh(en ? `${fmtInt(m.turnsCount || 0)} turns` : `${fmtInt(m.turnsCount || 0)} 轮`)}</span>` +
        `</span>` +
        `<span class="session-model-right">` +
        `<span class="session-model-tok num">${escZh(`${tr('命中', 'Hit')} ${fmtTokens(m.cacheTokens || 0, 1)} / ${fmtTokens(promptTot, 1)}`)}</span>` +
        `<span class="session-model-rate ${rateCls}">${esc(pct !== null ? `${pct.toFixed(1)}%` : '--')}</span>` +
        `</span>` +
        `</div>` +
        `<div class="thin-track xs"><div class="thin-fill is-gpu" style="--cv-ratio:${(barW / 100).toFixed(4)};width:${barW.toFixed(1)}%;background:${barCol}"></div></div>` +
        `</div>`
      );
    }).join('');
    if (renderSigs['session-models-list'] !== modelsHtml) {
      renderSigs['session-models-list'] = modelsHtml;
      const prevTop = list.scrollTop || 0;
      list.innerHTML = modelsHtml;
      if (prevTop > 0) list.scrollTop = prevTop;
    }
  }

  function renderAgentTreeCard(agentTree) {
    const card = $('agent-tree-card');
    const list = $('agent-tree-list');
    if (!card || !list) return;
    const en = isEn();

    if (!agentTree) {
      card.classList.add('hidden');
      setText('agent-tree-chip', tr('0 个子代理', '0 subagents'));
      const titleEl = $('agent-tree-title');
      if (titleEl) {
        titleEl.classList.add('hidden');
        setText(titleEl, '');
      }
      list.innerHTML = '';
      return;
    }

    card.classList.remove('hidden');
    const children = Array.isArray(agentTree.children) ? agentTree.children.filter(Boolean) : [];
    const childrenCount = Number(agentTree.childrenCount ?? children.length ?? 0);
    const activeCount = Number(agentTree.activeChildrenCount ?? 0);
    const totals = agentTree.treeTotals || {};
    const totTokens = Number(totals.totalTokens || 0);
    const totCost = Number(totals.costUSD || 0);
    const totSaved = Number(totals.cacheSavingsUSD || 0);
    const totTurns = Number(totals.turnsCount || 0);

    const titleEl = $('agent-tree-title');
    if (titleEl) {
      const swarmTitle = agentTree.isSwarm && agentTree.swarmTitle ? String(agentTree.swarmTitle).trim() : '';
      if (swarmTitle) {
        titleEl.classList.remove('hidden');
        setText(titleEl, swarmTitle);
        setElTooltip(titleEl, `${tr('Swarm 协作任务：', 'Swarm task: ')}${swarmTitle}`);
      } else {
        titleEl.classList.add('hidden');
        setText(titleEl, '');
        setElTooltip(titleEl, '');
      }
    }

    const chipEl = $('agent-tree-chip');
    setText(
      'agent-tree-chip',
      en
        ? `${fmtInt(childrenCount)} subagents · Total ${fmtTokens(totTokens, 1)} · ${fmtUSD(totCost)}`
        : `含 ${fmtInt(childrenCount)} 个子代理 · 总计 ${fmtTokens(totTokens, 1)} · ${fmtUSD(totCost)}`
    );
    if (chipEl) {
      const tipParts = [
        agentTree.isSwarm && agentTree.swarmTitle ? `Swarm: ${agentTree.swarmTitle}` : '',
        en ? `Active ${fmtInt(activeCount)} / ${fmtInt(childrenCount)} subagents` : `活跃 ${fmtInt(activeCount)} / 共 ${fmtInt(childrenCount)} 个子代理`,
        en ? `${fmtInt(totTurns)} tree turns` : `整树 ${fmtInt(totTurns)} 轮`
      ].filter(Boolean);
      setElTooltip(chipEl, tipParts.join(' · '));
    }

    setText('agent-tree-total-tok', fmtTokens(totTokens));
    setText(
      'agent-tree-total-sub',
      en
        ? `${fmtInt(totTurns)} turns · In ${fmtTokens(totals.inputTokens || 0, 1)} / Cache ${fmtTokens(totals.cacheTokens || 0, 1)}`
        : `${fmtInt(totTurns)} 轮 · 入 ${fmtTokens(totals.inputTokens || 0, 1)} / 缓 ${fmtTokens(totals.cacheTokens || 0, 1)}`
    );
    setText('agent-tree-total-cost', fmtUSD(totCost));
    setText('agent-tree-total-cny', `${tr('约 ', '~')}${fmtCNY(totCost)}`);
    const treeSavedEl = $('agent-tree-cache-saved');
    const treeSav = fmtCacheSavings(totSaved, '');
    if (treeSavedEl) {
      if (treeSav) {
        treeSavedEl.className = `m-val ${treeSav.cls === 'ok' ? 'good-text' : 'warn-text'}`;
        setText(treeSavedEl, treeSav.shortText);
      } else {
        treeSavedEl.className = 'm-val';
        setText(treeSavedEl, '--');
      }
    }
    setText(
      'agent-tree-cache-sub',
      treeSav
        ? `${treeSav.cls === 'ok' ? tr('约省 ', '~Saved ') : tr('约增 ', '~+')}${fmtCNY(Math.abs(totSaved))}`
        : `${tr('缓存', 'Cache')} ${fmtTokens(totals.cacheTokens || 0, 1)}`
    );

    if (!children.length) {
      list.innerHTML = `<div class="kv-row"><span class="muted">${escZh(tr('当前暂无子代理执行明细', 'No subagent execution details yet'))}</span></div>`;
      return;
    }

    const stateMap = {
      working: { text: tr('运行中', 'Running'), cls: 'good' },
      running: { text: tr('运行中', 'Running'), cls: 'good' },
      active: { text: tr('运行中', 'Running'), cls: 'good' },
      waiting: { text: tr('待命', 'Idle'), cls: 'neutral' },
      idle: { text: tr('待命', 'Idle'), cls: 'neutral' },
      done: { text: tr('已完成', 'Done'), cls: 'good' },
      completed: { text: tr('已完成', 'Done'), cls: 'good' },
      stopped: { text: tr('已停止', 'Stopped'), cls: 'neutral' },
      killed: { text: tr('已结束', 'Ended'), cls: 'neutral' },
      error: { text: tr('异常', 'Error'), cls: 'danger' },
      failed: { text: tr('失败', 'Failed'), cls: 'danger' }
    };

    const renderSigs = state.lastRenderSigs || (state.lastRenderSigs = {});
    const treeHtml = children.map((c) => {
      const name = c.name || (c.id ? String(c.id).slice(0, 8) : tr('未命名子代理', 'Unnamed subagent'));
      const roleChip = c.role ? `<span class="turn-chip">${escZh(c.role)}</span>` : '';
      const rawState = String(c.state || '').toLowerCase();
      const stInfo = stateMap[rawState] || { text: c.state || tr('未知', 'Unknown'), cls: 'neutral' };
      const modelChip = c.model ? `<span class="turn-chip">${esc(c.model)}</span>` : '';
      const cSav = fmtCacheSavings(c.cacheSavingsUSD);
      const savedHtml = cSav
        ? `<span class="${cSav.cls === 'ok' ? 'good-text' : 'warn-text'}">${escZh(cSav.shortText)}</span>`
        : '';
      return (
        `<div class="agent-tree-row">` +
        `<div class="agent-tree-top">` +
        `<span class="agent-tree-left">` +
        `<span class="agent-tree-name">${esc(name)}</span>` +
        roleChip +
        `<span class="status-pill ${stInfo.cls}">${escZh(stInfo.text)}</span>` +
        `</span>` +
        `<span class="agent-tree-right">` +
        `<strong>${esc(fmtTokens(c.totalTokens || 0, 1))}</strong>` +
        `<span class="muted">${esc(fmtUSD(c.costUSD || 0))}</span>` +
        `</span>` +
        `</div>` +
        `<div class="agent-tree-meta">` +
        `<span>${escZh(en ? `${fmtInt(c.turnsCount || 0)} turns` : `${fmtInt(c.turnsCount || 0)} 轮`)}</span>` +
        modelChip +
        savedHtml +
        `</div>` +
        `</div>`
      );
    }).join('');
    if (renderSigs['agent-tree-list'] !== treeHtml) {
      renderSigs['agent-tree-list'] = treeHtml;
      const prevTop = list.scrollTop || 0;
      list.innerHTML = treeHtml;
      if (prevTop > 0) list.scrollTop = prevTop;
    }
  }

  function renderCompactionsCard(compactions = []) {
    const card = $('compactions-card');
    const list = $('compactions-list');
    if (!card || !list) return;
    const en = isEn();

    const items = Array.isArray(compactions) ? compactions.filter(Boolean) : [];
    if (!items.length) {
      card.classList.add('hidden');
      setText('compactions-count-chip', tr('0 次压缩', '0 compactions'));
      list.innerHTML = '';
      return;
    }

    card.classList.remove('hidden');
    const totalSaved = items.reduce((acc, c) => acc + Number(c.savedTokens || 0), 0);
    setText('compactions-count-chip', en ? `${fmtInt(items.length)} compactions` : `${fmtInt(items.length)} 次压缩`);
    setElTooltip(
      $('compactions-count-chip'),
      en
        ? `Released ~${fmtTokens(totalSaved, 1)} context window tokens in total`
        : `累计释放约 ${fmtTokens(totalSaved, 1)} Token 上下文窗口`
    );

    const renderSigs = state.lastRenderSigs || (state.lastRenderSigs = {});
    const openKeys = state.openDetailsKeys instanceof Set ? state.openDetailsKeys : null;
    if (openKeys && typeof list.querySelectorAll === 'function') {
      list.querySelectorAll('.compaction-item[data-detail-key]').forEach((itemEl) => {
        const k = itemEl.dataset?.detailKey || itemEl.getAttribute?.('data-detail-key');
        const det = itemEl.querySelector?.('details.compaction-details');
        if (!k || !det) return;
        if (det.open) openKeys.add(k);
        else openKeys.delete(k);
      });
    }
    const convPrefix = state.contextData?.conversationId || '';
    const compHtml = items.map((c, idx) => {
      const cIdx = c.index ?? (items.length - idx);
      const beforeTok = Number(c.beforeTokens || 0);
      const afterTok = Number(c.afterTokens || 0);
      const savedTok = Number(c.savedTokens ?? Math.max(0, beforeTok - afterTok));
      const savedPct = c.savedPercent != null && Number.isFinite(Number(c.savedPercent))
        ? Number(c.savedPercent)
        : (beforeTok > 0 ? (savedTok / beforeTok) * 100 : 0);
      const timeStr = fmtLocalTime(c.createdAt);
      const stepStr = c.stepIndex != null ? `Step ${c.stepIndex}` : '';
      const preview = c.summaryPreview ? String(c.summaryPreview).trim() : tr('（点击展开查看压缩摘要原文）', '(Click to expand compaction summary)');
      const full = c.summaryFull ? String(c.summaryFull) : preview;
      const detailKey = `${convPrefix}:compaction:${cIdx}:${c.stepIndex ?? ''}`;
      const isOpenAttr = openKeys && openKeys.has(detailKey) ? ' open' : '';

      return (
        `<div class="compaction-item" data-detail-key="${esc(detailKey)}">` +
        `<div class="compaction-top">` +
        `<span class="turn-top-left">` +
        `<span class="turn-idx">${esc(`#C${cIdx}`)}</span>` +
        `<span class="num">${esc(`${fmtTokens(beforeTok, 1)} → ${fmtTokens(afterTok, 1)}`)}</span>` +
        `</span>` +
        `<span class="delta-tag compact" title="${escZh(en ? `Released ${fmtInt(savedTok)} tokens` : `本次释放 ${fmtInt(savedTok)} Token`)}">${esc(`-${fmtTokens(savedTok, 1)} (-${savedPct.toFixed(0)}%)`)}</span>` +
        `</div>` +
        `<div class="compaction-meta">` +
        (timeStr ? `<span>${esc(timeStr)}</span>` : '') +
        (timeStr && stepStr ? `<span>·</span>` : '') +
        (stepStr ? `<span>${esc(stepStr)}</span>` : '') +
        `</div>` +
        `<details class="compaction-details"${isOpenAttr}>` +
        `<summary class="compaction-summary-toggle"><span class="compaction-preview-text">${esc(preview)}</span></summary>` +
        `<pre class="compaction-summary">${esc(full)}</pre>` +
        `</details>` +
        `</div>`
      );
    }).join('');
    if (renderSigs['compactions-list'] !== compHtml) {
      renderSigs['compactions-list'] = compHtml;
      const prevTop = list.scrollTop || 0;
      list.innerHTML = compHtml;
      if (prevTop > 0) list.scrollTop = prevTop;
    }
  }

  // -------------------------------------------------------------------------
  // TAB 2: Token History & Interactive Multi-View Charts
  // -------------------------------------------------------------------------

  function renderHistoryPanel(hist) {
    const en = isEn();
    const srcKey = state.sourceFilter;
    const srcMeta = hist.sources?.[srcKey] || hist.sources?.all || {};
    const analytics = hist.analyticsBySource?.[srcKey] || hist.analyticsBySource?.all;
    const dailyMap = hist.dailyMapBySource?.[srcKey] || {};
    if (!analytics) return;

    const s = analytics.summary;
    const cAll = analytics.costs.allTime.hybrid;
    const cMonth = analytics.costs.period.hybrid;
    const todayRec = dailyMap[hist.todayKey] || { total: 0, steps: 0, costUSD: 0, refCostUSD: 0 };
    const todayUSD = todayRec.costUSD > 0 ? todayRec.costUSD : todayRec.refCostUSD;

    // Source meta label
    const cliExtra = srcKey === 'cli' && !hist.sources?.cli?.dirExists
      ? tr('（尚未生成 CLI 归档）', ' (no CLI archive yet)')
      : '';
    setText(
      'hist-source-meta',
      en
        ? `${fmtInt(srcMeta.conversationsCount || 0)} sessions · ${fmtInt(srcMeta.transcriptsCount || 0)} logs${cliExtra}`
        : `${fmtInt(srcMeta.conversationsCount || 0)} 个会话 · ${fmtInt(srcMeta.transcriptsCount || 0)} 份日志${cliExtra}`
    );

    // 4 KPI Cards
    setText('kpi-total', fmtTokens(s.grandTotalTokens));
    setText(
      'kpi-total-sub',
      en ? `Active ${s.activeDaysCount}d · ${fmtInt(s.totalSteps)} reqs` : `活跃 ${s.activeDaysCount} 天 · ${fmtInt(s.totalSteps)} 次请求`
    );
    setText('kpi-total-cost', `${tr('折算', 'Est.')} ${fmtUSD(cAll.totalCostUSD)}（${fmtCNY(cAll.totalCostUSD)}）`);

    setText('kpi-today', fmtTokens(s.todayTokens));
    setText('kpi-today-sub', en ? `Today ${fmtInt(todayRec.steps)} reqs` : `今日 ${fmtInt(todayRec.steps)} 次请求`);
    setText('kpi-today-cost', `${tr('折算', 'Est.')} ${fmtUSD(todayUSD)}（${fmtCNY(todayUSD)}）`);

    const domDayOfMonth = Math.max(1, Number(hist.todayKey?.slice(8, 10) || 1));
    setText('kpi-month', fmtTokens(s.monthTokens));
    setText(
      'kpi-month-sub',
      en
        ? `Avg ${fmtTokens(s.monthTokens / domDayOfMonth, 1)}/d · Active ${s.monthActiveDays}d`
        : `日均 ${fmtTokens(s.monthTokens / domDayOfMonth, 1)} · 活跃 ${s.monthActiveDays} 天`
    );
    setText('kpi-month-cost', `${tr('折算', 'Est.')} ${fmtUSD(cMonth.totalCostUSD)}（${fmtCNY(cMonth.totalCostUSD)}）`);

    // Year cost sum from dailyMap
    const yearPrefix = (hist.todayKey || '').slice(0, 4);
    let yearUSD = 0;
    for (const [d, rec] of Object.entries(dailyMap)) {
      if (d.startsWith(yearPrefix)) {
        yearUSD += rec.costUSD > 0 ? rec.costUSD : rec.refCostUSD;
      }
    }
    setText('kpi-year', fmtTokens(s.yearTokens));
    setText('kpi-year-sub', en ? `${yearPrefix} active ${s.yearActiveDays}d` : `${yearPrefix} 年活跃 ${s.yearActiveDays} 天`);
    setText('kpi-year-cost', `${tr('折算', 'Est.')} ${fmtUSD(yearUSD)}（${fmtCNY(yearUSD)}）`);

    setText('first-use-pill', `${tr('首次记录：', 'First seen: ')}${hist.firstUseDate || hist.todayKey}`);

    // Render active chart view
    const navRow = $('heat-nav-row');
    if (navRow) navRow.classList.toggle('hidden', state.chartMode !== 'daily');
    const hourlyRow = $('hourly-day-row');
    if (hourlyRow) hourlyRow.classList.toggle('hidden', state.chartMode !== 'hourly');
    const customRow = $('custom-range-row');
    if (customRow) customRow.classList.toggle('hidden', state.chartMode !== 'custom');
    const customSum = $('custom-range-summary');
    if (customSum) customSum.classList.toggle('hidden', state.chartMode !== 'custom');

    if (state.chartMode === 'hourly') {
      const hourlyObj = hist.hourlyBySource?.[srcKey] || hist.hourlyBySource?.all || null;
      renderHourlyBars(hourlyObj, hist);
    } else if (state.chartMode === 'daily') {
      renderDailyHeatmap(dailyMap, hist);
    } else if (state.chartMode === 'weekly') {
      renderWeeklyBars(dailyMap, hist);
    } else if (state.chartMode === 'monthly') {
      renderMonthlyBars(dailyMap, hist);
    } else if (state.chartMode === 'yearly') {
      renderYearlyBubbles(dailyMap, hist);
    } else if (state.chartMode === 'cumulative') {
      renderCumulativeCurve(dailyMap, hist);
    } else if (state.chartMode === 'custom') {
      renderCustomRangeChart(dailyMap, hist);
    }

    renderDiagnosticsCard(hist.diagnostics || null);
  }

  function parseLocalDate(ymd) {
    const [y, m, d] = String(ymd).split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }

  function toYmd(dt) {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function computeHeatmapDateWindow(todayKey, pageOffset = 0) {
    const today = parseLocalDate(todayKey);
    const offset = Math.max(0, Number(pageOffset) || 0);
    const endSat = new Date(today);
    endSat.setDate(endSat.getDate() + (6 - endSat.getDay()) - offset * 53 * 7);
    const startSun = new Date(endSat);
    startSun.setDate(startSun.getDate() - (53 * 7 - 1));
    const displayEnd = endSat > today ? new Date(today) : new Date(endSat);
    return { today, startSun, endSat, displayEnd };
  }

  function computeQuantileThresholds(values) {
    const nonZero = values.filter((v) => v > 0).sort((a, b) => a - b);
    if (!nonZero.length) return [1, 2, 3];
    const pick = (q) => nonZero[Math.min(nonZero.length - 1, Math.floor(nonZero.length * q))];
    return [pick(0.28), pick(0.58), pick(0.84)];
  }

  function levelForValue(val, thresholds) {
    if (!val || val <= 0) return 0;
    if (val <= thresholds[0]) return 1;
    if (val <= thresholds[1]) return 2;
    if (val <= thresholds[2]) return 3;
    return 4;
  }

  function updateInspector(title, rec) {
    const box = $('day-inspector');
    if (!box) return;
    const en = typeof state !== 'undefined' && state?.ui?.lang === 'en';
    if (!rec || !rec.total) {
      box.innerHTML =
        `<div class="inspector-main">` +
        `<span><strong>${escZh(title)}</strong></span>` +
        `<span class="muted">${escZh(en ? 'No token usage recorded for this date / period' : '当日 / 区间无 Token 消耗记录')}</span>` +
        `</div>`;
      return;
    }
    const usd = rec.costUSD > 0 ? rec.costUSD : rec.refCostUSD;
    const byModel = Array.isArray(rec.byModel)
      ? rec.byModel.filter((m) => m && m.name && Number(m.tokens || 0) > 0).slice(0, 4)
      : [];
    let modelsRowHtml = '';
    if (byModel.length) {
      const denom = Math.max(1, Number(rec.total || 0), byModel.reduce((s, m) => s + Number(m.tokens || 0), 0));
      const chips = byModel.map((m) => {
        const tok = Number(m.tokens || 0);
        const share = Math.round((tok / denom) * 100);
        const mPrompt = Number(m.input || 0) + Number(m.cache || 0);
        const mCachePct = mPrompt > 0 ? Number(((Number(m.cache || 0) / mPrompt) * 100).toFixed(1)) : null;
        const tipParts = [
          m.name,
          `${fmtTokens(tok, 1)} tok (${share}%)`,
          mCachePct !== null ? (en ? `Cache hit ${mCachePct.toFixed(1)}%` : `缓存命中 ${mCachePct.toFixed(1)}%`) : '',
          m.steps ? (en ? `${fmtInt(m.steps)} reqs` : `${fmtInt(m.steps)} 次`) : '',
          m.costUSD > 0 ? `${en ? '~' : '约 '}${fmtUSD(m.costUSD)}` : ''
        ].filter(Boolean);
        return (
          `<span class="inspector-model-chip" title="${escZh(tipParts.join(' · '))}">` +
          `<span class="inspector-model-name">${escZh(m.name)}</span>` +
          `<span class="num muted">${escZh(`${fmtTokens(tok, 1)} (${share}%)`)}${mCachePct !== null ? ` · ${mCachePct.toFixed(0)}%` : ''}</span>` +
          `</span>`
        );
      }).join('');
      modelsRowHtml = `<div class="inspector-models-row">${chips}</div>`;
    }
    box.innerHTML =
      `<div class="inspector-main">` +
      `<span><strong>${escZh(title)}</strong> · ${escZh(en ? `Total ${fmtTokens(rec.total)} (${fmtInt(rec.steps || 0)} reqs)` : `总计 ${fmtTokens(rec.total)} (${fmtInt(rec.steps || 0)} 次)`)}</span>` +
      `<span class="muted num">${escZh(en ? `In ${fmtTokens(rec.input, 1)} / Cache ${fmtTokens(rec.cache, 1)} / Out ${fmtTokens(rec.output, 1)} · ~${fmtUSD(usd)} (${fmtCNY(usd)})` : `输入 ${fmtTokens(rec.input, 1)} / 缓存 ${fmtTokens(rec.cache, 1)} / 输出 ${fmtTokens(rec.output, 1)} · 约 ${fmtUSD(usd)} (${fmtCNY(usd)})`)}</span>` +
      `</div>` +
      modelsRowHtml;
  }

  function updateSummaryRibbon(stats, planStatus, monthsSpan = 1) {
    const en = typeof state !== 'undefined' && state?.ui?.lang === 'en';
    setText('sum-tok', fmtTokens(stats.totalTokens));
    setText('sum-cost', `${fmtUSD(stats.costUSD)}（${fmtCNY(stats.costUSD)}）`);
    setText('sum-daily', fmtTokens(stats.calendarDays > 0 ? stats.totalTokens / stats.calendarDays : 0, 1));
    setText('sum-active', stats.activeDays > 0 ? fmtTokens(stats.totalTokens / stats.activeDays, 1) : '0');

    const monthlyUSD = planStatus?.monthlyUSD;
    if (monthlyUSD === 0) {
      setText('sum-ratio', en ? `$0 paid · Saved ${fmtUSD(stats.costUSD)}` : `0 实付 · 省 ${fmtUSD(stats.costUSD)}`);
    } else if (monthlyUSD > 0) {
      const denom = monthlyUSD * Math.max(1, monthsSpan);
      const ratio = stats.costUSD / denom;
      setText('sum-ratio', en ? `${ratio.toFixed(2)}x plan value` : `月费 ${ratio.toFixed(2)}x 等值`);
    } else {
      setText('sum-ratio', '--');
    }
  }

  function scrollChartStageNow(stage, mode = 'latest') {
    if (!stage) return false;
    const hasClientW = typeof stage.clientWidth === 'number';
    if (hasClientW && stage.clientWidth <= 0) return false;
    const maxScroll = hasClientW
      ? Math.max(0, (stage.scrollWidth || 0) - stage.clientWidth)
      : (stage.scrollWidth || 0);
    if (mode === 'selected' && hasClientW && maxScroll > 0 && typeof stage.querySelector === 'function') {
      const sel = stage.querySelector('.bar-col.selected, .heat-cell.selected');
      if (sel && typeof sel.offsetLeft === 'number') {
        const target = Math.max(0, sel.offsetLeft + (sel.offsetWidth || 0) - stage.clientWidth + 24);
        stage.scrollLeft = Math.min(maxScroll, target);
        return true;
      }
    }
    stage.scrollLeft = maxScroll;
    return true;
  }

  function applyChartStageScroll(stage, scopeKey, { prevScrollLeft = 0, mode = 'latest' } = {}) {
    if (!stage) return;
    const isNewScope = state.chartScrollKey !== scopeKey;
    const wasPending = state.chartScrollPending === scopeKey;
    state.chartScrollKey = scopeKey;
    state.chartScrollMode = mode;

    if (isNewScope || wasPending) {
      state.chartScrollPending = scopeKey;
      const run = () => {
        if (state.chartScrollKey !== scopeKey) return;
        if (scrollChartStageNow(stage, mode)) {
          state.chartScrollPending = '';
        }
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(run);
      } else {
        run();
      }
    } else if (prevScrollLeft > 0) {
      stage.scrollLeft = prevScrollLeft;
    }
  }

  function flushPendingChartStageScroll() {
    if (!state.chartScrollPending) return;
    const stage = $('chart-stage');
    if (!stage) return;
    if (scrollChartStageNow(stage, state.chartScrollMode || 'latest')) {
      state.chartScrollPending = '';
    }
  }

  function renderDailyHeatmap(dailyMap, hist) {
    const stage = $('chart-stage');
    if (!stage) return;
    const en = typeof state !== 'undefined' && state?.ui?.lang === 'en';
    const enMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const { today, startSun, displayEnd } = computeHeatmapDateWindow(hist.todayKey, state.heatPageOffset);

    const firstDate = parseLocalDate(hist.firstUseDate || hist.todayKey);
    if ($('btn-heat-prev')) $('btn-heat-prev').disabled = startSun <= firstDate;
    if ($('btn-heat-next')) $('btn-heat-next').disabled = state.heatPageOffset <= 0;
    setText('heat-range-label', en ? `${toYmd(startSun)} to ${toYmd(displayEnd)}` : `${toYmd(startSun)} 至 ${toYmd(displayEnd)}`);

    const windowValues = [];
    const weeks = [];
    const monthLabels = [];
    let lastMonth = -1;

    let rangeTotal = 0;
    let rangeCost = 0;
    let calendarDays = 0;
    let activeDays = 0;

    const cursor = new Date(startSun);
    for (let w = 0; w < 53; w++) {
      const days = [];
      let weekMonthLbl = '';
      for (let d = 0; d < 7; d++) {
        const key = toYmd(cursor);
        const isFuture = cursor > today;
        const rec = dailyMap[key] || null;
        const tot = !isFuture && rec ? rec.total : 0;
        if (!isFuture) {
          windowValues.push(tot);
          calendarDays++;
          if (tot > 0) {
            activeDays++;
            rangeTotal += tot;
            rangeCost += rec.costUSD > 0 ? rec.costUSD : rec.refCostUSD;
          }
        }
        if (d === 0 || cursor.getDate() === 1) {
          const m = cursor.getMonth();
          if (m !== lastMonth) {
            weekMonthLbl = en ? enMonths[m] : `${m + 1}月`;
            lastMonth = m;
          }
        }
        days.push({ key, isFuture, rec, tot });
        cursor.setDate(cursor.getDate() + 1);
      }
      weeks.push(days);
      monthLabels.push(weekMonthLbl);
    }

    const firstMonthIdx = monthLabels.findIndex(Boolean);
    if (firstMonthIdx >= 0) {
      const nextMonthIdx = monthLabels.findIndex((m, idx) => idx > firstMonthIdx && Boolean(m));
      if (nextMonthIdx >= 0 && nextMonthIdx - firstMonthIdx < 3) {
        monthLabels[firstMonthIdx] = '';
      }
    }

    const thresholds = computeQuantileThresholds(windowValues);

    const monthsHtml = monthLabels.map((m) => `<span class="heat-m-lbl">${escZh(m)}</span>`).join('');
    const colsHtml = weeks.map((days) => {
      const cells = days.map((cell) => {
        const lvl = cell.isFuture ? 0 : levelForValue(cell.tot, thresholds);
        const cls = `heat-cell${cell.isFuture ? ' future' : ''}${state.selectedBucketKey === cell.key ? ' selected' : ''}`;
        const todayAttr = !cell.isFuture && cell.key === hist.todayKey ? ' data-today="1"' : '';
        const tip = cell.isFuture ? cell.key : `${cell.key}：${fmtTokens(cell.tot)}`;
        return `<div class="${cls}" data-lvl="${lvl}" data-day="${cell.key}"${todayAttr} title="${escZh(tip)}"></div>`;
      }).join('');
      return `<div class="heat-week">${cells}</div>`;
    }).join('');

    const prevScrollLeft = stage.scrollLeft || 0;
    const scopeKey = `daily|${state.heatPageOffset || 0}|${state.sourceFilter || 'all'}|${hist.todayKey || ''}`;

    stage.innerHTML =
      `<div class="heatmap-wrap">` +
      `<div class="heat-months-row">${monthsHtml}</div>` +
      `<div class="heat-cols">${colsHtml}</div>` +
      `</div>`;

    applyChartStageScroll(stage, scopeKey, { prevScrollLeft, mode: 'latest' });

    stage.__cvStageInspect = (el, lock) => {
      const k = el?.dataset?.day;
      if (!k) return;
      if (lock) {
        state.selectedBucketKey = k;
        stage.querySelectorAll('.heat-cell.selected').forEach((n) => n.classList.remove('selected'));
        el.classList.add('selected');
      }
      updateInspector(k, dailyMap[k]);
    };

    const inCurrentWindow = Boolean(
      state.selectedBucketKey &&
      weeks.some((days) => days.some((c) => !c.isFuture && c.key === state.selectedBucketKey))
    );
    const inspectKey = state.selectedBucketKey && (inCurrentWindow || dailyMap[state.selectedBucketKey])
      ? state.selectedBucketKey
      : hist.todayKey;
    if (state.selectedBucketKey && !inCurrentWindow && !dailyMap[state.selectedBucketKey]) {
      state.selectedBucketKey = '';
    }
    updateInspector(inspectKey, dailyMap[inspectKey]);
    updateSummaryRibbon(
      { totalTokens: rangeTotal, costUSD: rangeCost, calendarDays, activeDays },
      hist.planStatus,
      Math.max(1, Math.round(calendarDays / 30))
    );
  }

  function renderWeeklyBars(dailyMap, hist) {
    const stage = $('chart-stage');
    if (!stage) return;
    const today = parseLocalDate(hist.todayKey);
    const endSun = new Date(today);
    endSun.setDate(today.getDate() - today.getDay());

    const buckets = [];
    for (let i = 23; i >= 0; i--) {
      const ws = new Date(endSun);
      ws.setDate(endSun.getDate() - i * 7);
      const we = new Date(ws);
      we.setDate(ws.getDate() + 6);
      const agg = { total: 0, input: 0, cache: 0, output: 0, steps: 0, costUSD: 0, refCostUSD: 0 };
      const cur = new Date(ws);
      for (let d = 0; d < 7; d++) {
        if (cur <= today) {
          const rec = dailyMap[toYmd(cur)];
          if (rec) {
            agg.total += rec.total;
            agg.input += rec.input;
            agg.cache += rec.cache;
            agg.output += rec.output;
            agg.steps += rec.steps;
            agg.costUSD += rec.costUSD;
            agg.refCostUSD += rec.refCostUSD;
            mergeDayByModel(agg, rec);
          }
        }
        cur.setDate(cur.getDate() + 1);
      }
      finalizeAggByModel(agg);
      buckets.push({
        key: `${toYmd(ws)} ~ ${toYmd(we > today ? today : we)}`,
        shortLabel: `${ws.getMonth() + 1}/${ws.getDate()}`,
        agg
      });
    }

    renderBarBuckets(stage, buckets, dailyMap, hist, 6, {
      scrollScopeKey: `weekly|${state.sourceFilter || 'all'}|${hist.todayKey || ''}`
    });
  }

  function mergeDayByModel(agg, rec) {
    if (!Array.isArray(rec?.byModel) || !rec.byModel.length) return;
    if (!agg._modelMap) agg._modelMap = new Map();
    for (const m of rec.byModel) {
      if (!m || !m.name) continue;
      const prev = agg._modelMap.get(m.name) || { name: m.name, tokens: 0, input: 0, cache: 0, steps: 0, costUSD: 0 };
      prev.tokens += Number(m.tokens || 0);
      prev.input += Number(m.input || 0);
      prev.cache += Number(m.cache || 0);
      prev.steps += Number(m.steps || 0);
      prev.costUSD += Number(m.costUSD || 0);
      agg._modelMap.set(m.name, prev);
    }
  }

  function finalizeAggByModel(agg) {
    if (!agg._modelMap || !agg._modelMap.size) {
      agg.byModel = [];
      return agg;
    }
    agg.byModel = [...agg._modelMap.values()]
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 6)
      .map((m) => ({
        name: m.name,
        tokens: m.tokens,
        input: m.input,
        cache: m.cache,
        steps: m.steps,
        costUSD: Number(m.costUSD.toFixed(6))
      }));
    delete agg._modelMap;
    return agg;
  }

  function renderMonthlyBars(dailyMap, hist) {
    const stage = $('chart-stage');
    if (!stage) return;
    const en = isEn();
    const enMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const today = parseLocalDate(hist.todayKey);
    const buckets = [];

    for (let i = 11; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const agg = { total: 0, input: 0, cache: 0, output: 0, steps: 0, costUSD: 0, refCostUSD: 0 };
      for (const [k, rec] of Object.entries(dailyMap)) {
        if (k.startsWith(ym)) {
          agg.total += rec.total;
          agg.input += rec.input;
          agg.cache += rec.cache;
          agg.output += rec.output;
          agg.steps += rec.steps;
          agg.costUSD += rec.costUSD;
          agg.refCostUSD += rec.refCostUSD;
          mergeDayByModel(agg, rec);
        }
      }
      finalizeAggByModel(agg);
      buckets.push({
        key: en ? ym : `${ym} 自然月`,
        shortLabel: en ? enMonths[d.getMonth()] : `${d.getMonth() + 1}月`,
        agg
      });
    }

    renderBarBuckets(stage, buckets, dailyMap, hist, 12, {
      scrollScopeKey: `monthly|${state.sourceFilter || 'all'}|${hist.todayKey || ''}`
    });
  }

  function renderBarBuckets(stage, buckets, dailyMap, hist, monthsSpan, opts = {}) {
    const prevScrollLeft = stage.scrollLeft || 0;
    const maxVal = Math.max(...buckets.map((b) => b.agg.total), 1);
    let sumTok = 0;
    let sumCost = 0;
    for (const b of buckets) {
      sumTok += b.agg.total;
      sumCost += b.agg.costUSD > 0 ? b.agg.costUSD : b.agg.refCostUSD;
    }
    const defaultIdx = opts.defaultSelectedIdx != null && opts.defaultSelectedIdx >= 0 && opts.defaultSelectedIdx < buckets.length
      ? opts.defaultSelectedIdx
      : (buckets.length - 1);
    const labelStep = buckets.length <= 12 ? 1 : (buckets.length <= 24 ? 2 : Math.ceil(buckets.length / 7));
    const labelMod = buckets.length > 1 ? ((buckets.length - 1) % labelStep) : 0;

    stage.innerHTML = `<div class="bar-chart">${buckets.map((b, idx) => {
      const hPct = b.agg.total > 0 ? Math.max(4, (b.agg.total / maxVal) * 100) : 2;
      const ratio = (hPct / 100).toFixed(4);
      const showLbl = labelStep === 1 || (idx % labelStep === labelMod) || idx === buckets.length - 1;
      return (
        `<div class="bar-col${idx === defaultIdx ? ' selected' : ''}" data-bidx="${idx}" title="${escZh(`${b.key}：${fmtTokens(b.agg.total)}`)}">` +
        `<div class="bar-pillar-track"><div class="bar-pillar" style="--cv-ratio:${ratio}"></div></div>` +
        `<span class="bar-lbl">${showLbl ? escZh(b.shortLabel) : ''}</span>` +
        `</div>`
      );
    }).join('')}</div>`;

    const scopeKey = opts.scrollScopeKey || `bars|${state.chartMode || ''}|${state.sourceFilter || 'all'}|${buckets.length}`;
    if (typeof applyChartStageScroll === 'function') {
      applyChartStageScroll(stage, scopeKey, { prevScrollLeft, mode: opts.scrollMode || 'latest' });
    }

    stage.__cvStageInspect = (col, lock) => {
      const idxAttr = col?.dataset?.bidx;
      if (idxAttr === undefined) return;
      const b = buckets[Number(idxAttr)];
      if (!b) return;
      if (lock) {
        stage.querySelectorAll('.bar-col.selected').forEach((n) => n.classList.remove('selected'));
        col.classList.add('selected');
      }
      updateInspector(b.key, b.agg);
    };

    const latest = buckets[defaultIdx];
    if (latest) updateInspector(latest.key, latest.agg);

    const activeDays = opts.activeDaysOverride != null
      ? opts.activeDaysOverride
      : Object.values(dailyMap).filter((v) => v.total > 0).length;
    const calendarDays = opts.calendarDaysOverride != null
      ? opts.calendarDaysOverride
      : (monthsSpan * 30);
    updateSummaryRibbon(
      {
        totalTokens: opts.rangeTotalOverride ?? sumTok,
        costUSD: opts.rangeCostOverride ?? sumCost,
        calendarDays,
        activeDays
      },
      hist.planStatus,
      monthsSpan
    );
  }

  function renderYearlyBubbles(dailyMap, hist) {
    const stage = $('chart-stage');
    if (!stage) return;
    const en = isEn();
    const enMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const year = (hist.todayKey || '').slice(0, 4);
    const months = [];
    for (let m = 1; m <= 12; m++) {
      const ym = `${year}-${String(m).padStart(2, '0')}`;
      const agg = { total: 0, input: 0, cache: 0, output: 0, steps: 0, costUSD: 0, refCostUSD: 0 };
      for (const [k, rec] of Object.entries(dailyMap)) {
        if (k.startsWith(ym)) {
          agg.total += rec.total;
          agg.input += rec.input;
          agg.cache += rec.cache;
          agg.output += rec.output;
          agg.steps += rec.steps;
          agg.costUSD += rec.costUSD;
          agg.refCostUSD += rec.refCostUSD;
          mergeDayByModel(agg, rec);
        }
      }
      finalizeAggByModel(agg);
      months.push({ m, key: en ? `${enMonths[m - 1]} ${year}` : `${year} 年 ${m} 月`, agg });
    }

    const maxVal = Math.max(...months.map((x) => x.agg.total), 1);
    let yearTok = 0;
    let yearCost = 0;
    for (const x of months) {
      yearTok += x.agg.total;
      yearCost += x.agg.costUSD > 0 ? x.agg.costUSD : x.agg.refCostUSD;
    }

    stage.innerHTML = `<div class="year-bubbles">${months.map((item, idx) => {
      const size = item.agg.total > 0 ? Math.round(22 + Math.sqrt(item.agg.total / maxVal) * 24) : 18;
      return (
        `<div class="month-bubble-card" data-midx="${idx}">` +
        `<span class="xs muted">${escZh(en ? enMonths[item.m - 1] : `${item.m} 月`)}</span>` +
        `<div class="bubble-circle" style="width:${size}px;height:${size}px"></div>` +
        `<strong class="xs num">${esc(item.agg.total > 0 ? fmtTokens(item.agg.total, 1) : '--')}</strong>` +
        `</div>`
      );
    }).join('')}</div>`;

    stage.__cvStageInspect = (card) => {
      const midx = card?.dataset?.midx;
      if (midx === undefined) return;
      const item = months[Number(midx)];
      if (item) updateInspector(item.key, item.agg);
    };

    const curMonthIdx = Math.max(0, Number((hist.todayKey || '').slice(5, 7)) - 1);
    updateInspector(months[curMonthIdx].key, months[curMonthIdx].agg);

    const yearActive = Object.entries(dailyMap).filter(([k, v]) => k.startsWith(year) && v.total > 0).length;
    state.chartScrollKey = `yearly|${year}`;
    state.chartScrollPending = '';
    stage.scrollLeft = 0;
    updateSummaryRibbon(
      { totalTokens: yearTok, costUSD: yearCost, calendarDays: 365, activeDays: yearActive },
      hist.planStatus,
      Math.max(1, curMonthIdx + 1)
    );
  }

  function renderCumulativeCurve(dailyMap, hist) {
    const stage = $('chart-stage');
    if (!stage) return;
    state.chartScrollKey = `cumulative|${state.sourceFilter || 'all'}`;
    state.chartScrollPending = '';
    stage.scrollLeft = 0;
    const en = isEn();
    const start = parseLocalDate(hist.firstUseDate || hist.todayKey);
    const end = parseLocalDate(hist.todayKey);
    const series = [];
    let runningTok = 0;
    let runningCost = 0;
    let activeDays = 0;

    const cur = new Date(start);
    let guard = 0;
    while (cur <= end && guard < 1500) {
      guard++;
      const k = toYmd(cur);
      const rec = dailyMap[k];
      if (rec && rec.total > 0) {
        runningTok += rec.total;
        runningCost += rec.costUSD > 0 ? rec.costUSD : rec.refCostUSD;
        activeDays++;
      }
      series.push({ key: k, cumTokens: runningTok, cumCost: runningCost, dayRec: rec });
      cur.setDate(cur.getDate() + 1);
    }

    if (!series.length) {
      stage.innerHTML = `<div class="muted xs">${escZh(tr('暂无累计曲线数据', 'No cumulative curve data yet'))}</div>`;
      return;
    }

    const W = 560;
    const H = 132;
    const padX = 10;
    const padY = 12;
    const maxTok = Math.max(runningTok, 1);
    const pts = series.map((s, i) => {
      const x = series.length === 1 ? W / 2 : padX + (i / (series.length - 1)) * (W - padX * 2);
      const y = H - padY - (s.cumTokens / maxTok) * (H - padY * 2);
      return { x: Number(x.toFixed(1)), y: Number(y.toFixed(1)), ...s };
    });

    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
    const area = pts.length > 1
      ? `${line} L${pts[pts.length - 1].x},${H - 4} L${pts[0].x},${H - 4} Z`
      : '';
    const last = pts[pts.length - 1];

    stage.innerHTML =
      `<svg id="cum-svg-el" class="cum-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
      `<defs><linearGradient id="cumFill" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0%" stop-color="var(--cv-accent)" stop-opacity="0.34"/>` +
      `<stop offset="100%" stop-color="var(--cv-accent)" stop-opacity="0.02"/>` +
      `</linearGradient></defs>` +
      (area ? `<path d="${area}" fill="url(#cumFill)"/>` : '') +
      `<path d="${line}" fill="none" stroke="var(--cv-accent)" stroke-width="2.1" stroke-linecap="round"/>` +
      `<line id="cum-crosshair" class="cum-crosshair" x1="0" y1="6" x2="0" y2="${H - 4}" style="transform:translate3d(${last.x}px,0,0)"/>` +
      `<circle id="cum-dot" class="cum-dot" cx="0" cy="0" r="3.5" fill="var(--cv-accent)" style="transform:translate3d(${last.x}px,${last.y}px,0)"/>` +
      `</svg>`;

    const svgEl = $('cum-svg-el');
    const dotEl = $('cum-dot');
    const crossEl = $('cum-crosshair');
    const box = $('day-inspector');
    const showPoint = (pt) => {
      if (!pt || !box) return;
      if (crossEl) {
        if (crossEl.style) crossEl.style.transform = `translate3d(${pt.x}px, 0, 0)`;
        else crossEl.setAttribute?.('transform', `translate(${pt.x}, 0)`);
      }
      if (dotEl) {
        if (dotEl.style) dotEl.style.transform = `translate3d(${pt.x}px, ${pt.y}px, 0)`;
        else {
          dotEl.setAttribute?.('cx', pt.x);
          dotEl.setAttribute?.('cy', pt.y);
        }
      }
      const dayTok = pt.dayRec?.total
        ? (en ? `Day +${fmtTokens(pt.dayRec.total)}` : `当日 +${fmtTokens(pt.dayRec.total)}`)
        : tr('当日无新增', 'No usage on day');
      box.innerHTML =
        `<div class="inspector-main">` +
        `<span><strong>${escZh(en ? `As of ${pt.key}` : `截至 ${pt.key}`)}</strong> · ${escZh(`${tr('累计', 'Total')} ${fmtTokens(pt.cumTokens)}`)}</span>` +
        `<span class="muted num">${escZh(en ? `${dayTok} · Cum. ~${fmtUSD(pt.cumCost)} (${fmtCNY(pt.cumCost)})` : `${dayTok} · 累计折算 ${fmtUSD(pt.cumCost)} (${fmtCNY(pt.cumCost)})`)}</span>` +
        `</div>`;
    };

    showPoint(last);
    if (svgEl) {
      svgEl.addEventListener('mousemove', (ev) => {
        const rect = svgEl.getBoundingClientRect();
        if (!rect.width) return;
        const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
        const idx = Math.round(ratio * (pts.length - 1));
        showPoint(pts[idx]);
      });
    }

    updateSummaryRibbon(
      { totalTokens: runningTok, costUSD: runningCost, calendarDays: series.length, activeDays },
      hist.planStatus,
      Math.max(1, Math.ceil(series.length / 30))
    );
  }

  function renderHourlyBars(hourlyObj, hist) {
    const stage = $('chart-stage');
    if (!stage) return;

    const dayKey = state.hourlyDay === 'yesterday' ? 'yesterday' : 'today';
    const dayLabel = dayKey === 'yesterday' ? tr('昨日', 'Yesterday') : tr('今日', 'Today');
    document.querySelectorAll('#hourly-day-seg .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.hday === dayKey);
    });

    let dateLabel = hist?.todayKey || '';
    if (dayKey === 'yesterday' && hist?.todayKey) {
      const yDt = parseLocalDate(hist.todayKey);
      yDt.setDate(yDt.getDate() - 1);
      dateLabel = toYmd(yDt);
    }
    setText('hourly-range-label', dateLabel ? `${dayLabel}（${dateLabel}）· 00:00–23:59` : `${dayLabel} · 00:00–23:59`);

    const rawList = Array.isArray(hourlyObj?.[dayKey]) ? hourlyObj[dayKey] : [];
    const byHour = new Map();
    for (let i = 0; i < rawList.length; i++) {
      const item = rawList[i];
      if (!item || typeof item !== 'object') continue;
      const h = item.hour != null && Number.isFinite(Number(item.hour)) ? Number(item.hour) : i;
      if (h >= 0 && h < 24) byHour.set(h, item);
    }

    const buckets = [];
    let sumTok = 0;
    let sumCost = 0;
    let lastActiveIdx = -1;
    for (let h = 0; h < 24; h++) {
      const r = byHour.get(h) || {};
      const total = Number(r.total || 0);
      const input = Number(r.input || 0);
      const cache = Number(r.cache || 0);
      const output = Number(r.output || 0);
      const steps = Number(r.steps || 0);
      const costUSD = Number(r.costUSD || 0);
      const refCostUSD = Number(r.refCostUSD ?? costUSD);
      const agg = {
        total,
        input,
        cache,
        output,
        steps,
        costUSD,
        refCostUSD,
        byModel: Array.isArray(r.byModel) ? r.byModel : []
      };
      sumTok += total;
      sumCost += costUSD > 0 ? costUSD : refCostUSD;
      if (total > 0) lastActiveIdx = h;
      const hh = String(h).padStart(2, '0');
      buckets.push({
        hour: h,
        key: `${dayLabel} ${hh}:00–${hh}:59`,
        shortLabel: hh,
        agg
      });
    }

    const defaultIdx = lastActiveIdx >= 0
      ? lastActiveIdx
      : (dayKey === 'today' ? Math.min(23, Math.max(0, new Date().getHours())) : 23);
    const maxVal = Math.max(...buckets.map((b) => b.agg.total), 1);

    const prevScrollLeft = stage.scrollLeft || 0;
    stage.innerHTML = `<div class="bar-chart bar-chart-hourly">${buckets.map((b, idx) => {
      const hPct = b.agg.total > 0 ? Math.max(4, (b.agg.total / maxVal) * 100) : 2;
      const ratio = (hPct / 100).toFixed(4);
      const showLbl = idx % 3 === 0 || idx === 23;
      return (
        `<div class="bar-col${idx === defaultIdx ? ' selected' : ''}" data-hidx="${idx}" title="${escZh(`${b.key}：${fmtTokens(b.agg.total)}`)}">` +
        `<div class="bar-pillar-track"><div class="bar-pillar" style="--cv-ratio:${ratio}"></div></div>` +
        `<span class="bar-lbl">${showLbl ? esc(b.shortLabel) : ''}</span>` +
        `</div>`
      );
    }).join('')}</div>`;

    if (typeof applyChartStageScroll === 'function') {
      applyChartStageScroll(stage, `hourly|${state.sourceFilter || 'all'}|${dayKey}|${hist?.todayKey || ''}`, {
        prevScrollLeft,
        mode: 'selected'
      });
    }

    stage.__cvStageInspect = (col, lock) => {
      const hidx = col?.dataset?.hidx;
      if (hidx === undefined) return;
      const b = buckets[Number(hidx)];
      if (!b) return;
      if (lock) {
        stage.querySelectorAll('.bar-col.selected').forEach((n) => n.classList.remove('selected'));
        col.classList.add('selected');
      }
      updateInspector(b.key, b.agg);
    };

    const defBucket = buckets[defaultIdx];
    if (defBucket) updateInspector(defBucket.key, defBucket.agg);

    updateSummaryRibbon(
      { totalTokens: sumTok, costUSD: sumCost, calendarDays: 1, activeDays: sumTok > 0 ? 1 : 0 },
      hist?.planStatus,
      1
    );
  }

  function resolveCustomDatePreset(presetId, hist) {
    const todayKey = hist?.todayKey || toYmd(new Date());
    const todayDt = parseLocalDate(todayKey);
    const firstUse = hist?.firstUseDate && hist.firstUseDate <= todayKey ? hist.firstUseDate : todayKey;
    const shift = (days) => {
      const d = new Date(todayDt);
      d.setDate(d.getDate() + days);
      return toYmd(d);
    };
    if (presetId === '7d') return { start: shift(-6), end: todayKey };
    if (presetId === '90d') return { start: shift(-89), end: todayKey };
    if (presetId === 'mtd') return { start: `${todayKey.slice(0, 7)}-01`, end: todayKey };
    if (presetId === 'prevMonth') {
      const firstPrev = new Date(todayDt.getFullYear(), todayDt.getMonth() - 1, 1);
      const lastPrev = new Date(todayDt.getFullYear(), todayDt.getMonth(), 0);
      return { start: toYmd(firstPrev), end: toYmd(lastPrev) };
    }
    if (presetId === 'all') return { start: firstUse, end: todayKey };
    return { start: shift(-29), end: todayKey };
  }

  function renderCustomRangeChart(dailyMap, hist) {
    const stage = $('chart-stage');
    if (!stage) return;
    const en = isEn();
    const enMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const todayKey = hist?.todayKey || toYmd(new Date());
    if (!state.customRange.start || !state.customRange.end) {
      const defRange = resolveCustomDatePreset(state.customRange.preset || '30d', hist);
      state.customRange.start = defRange.start;
      state.customRange.end = defRange.end;
    }

    let startYmd = state.customRange.start;
    let endYmd = state.customRange.end;
    if (startYmd > endYmd) {
      [startYmd, endYmd] = [endYmd, startYmd];
      state.customRange.start = startYmd;
      state.customRange.end = endYmd;
    }

    const startInput = $('custom-start-date');
    const endInput = $('custom-end-date');
    if (startInput) {
      startInput.value = startYmd;
      startInput.max = todayKey;
    }
    if (endInput) {
      endInput.value = endYmd;
      endInput.max = todayKey;
    }
    document.querySelectorAll('#custom-preset-seg .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.cpreset === state.customRange.preset);
    });
    const granChoice = state.customRange.granularity || 'auto';
    document.querySelectorAll('#custom-gran-seg .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.cgran === granChoice);
    });

    const startDt = parseLocalDate(startYmd);
    const endDt = parseLocalDate(endYmd);
    const daysList = [];
    const cur = new Date(startDt);
    let guard = 0;
    while (cur <= endDt && guard < 1500) {
      guard += 1;
      daysList.push({ dt: new Date(cur), ymd: toYmd(cur) });
      cur.setDate(cur.getDate() + 1);
    }

    const effectiveGran = granChoice === 'auto'
      ? (daysList.length <= 45 ? 'day' : daysList.length <= 180 ? 'week' : 'month')
      : granChoice;

    const rangeAgg = { total: 0, input: 0, cache: 0, output: 0, steps: 0, costUSD: 0, refCostUSD: 0 };
    let calendarDays = 0;
    let activeDays = 0;
    for (const item of daysList) {
      if (item.ymd <= todayKey) calendarDays += 1;
      const rec = dailyMap[item.ymd];
      if (rec && rec.total > 0) {
        activeDays += 1;
        rangeAgg.total += rec.total;
        rangeAgg.input += rec.input;
        rangeAgg.cache += rec.cache;
        rangeAgg.output += rec.output;
        rangeAgg.steps += rec.steps;
        rangeAgg.costUSD += rec.costUSD;
        rangeAgg.refCostUSD += rec.refCostUSD;
        mergeDayByModel(rangeAgg, rec);
      }
    }
    finalizeAggByModel(rangeAgg);

    const multiYear = startYmd.slice(0, 4) !== endYmd.slice(0, 4);
    const buckets = [];
    if (effectiveGran === 'day') {
      for (const item of daysList) {
        const rec = dailyMap[item.ymd] || { total: 0, input: 0, cache: 0, output: 0, steps: 0, costUSD: 0, refCostUSD: 0, byModel: [] };
        buckets.push({
          key: item.ymd,
          shortLabel: `${item.dt.getMonth() + 1}/${item.dt.getDate()}`,
          agg: rec
        });
      }
    } else if (effectiveGran === 'week') {
      const weekMap = new Map();
      for (const item of daysList) {
        const sun = new Date(item.dt);
        sun.setDate(sun.getDate() - sun.getDay());
        const wkKey = toYmd(sun);
        let wk = weekMap.get(wkKey);
        if (!wk) {
          wk = {
            startYmd: item.ymd,
            endYmd: item.ymd,
            shortLabel: `${item.dt.getMonth() + 1}/${item.dt.getDate()}`,
            agg: { total: 0, input: 0, cache: 0, output: 0, steps: 0, costUSD: 0, refCostUSD: 0 }
          };
          weekMap.set(wkKey, wk);
        }
        wk.endYmd = item.ymd;
        const rec = dailyMap[item.ymd];
        if (rec) {
          wk.agg.total += rec.total;
          wk.agg.input += rec.input;
          wk.agg.cache += rec.cache;
          wk.agg.output += rec.output;
          wk.agg.steps += rec.steps;
          wk.agg.costUSD += rec.costUSD;
          wk.agg.refCostUSD += rec.refCostUSD;
          mergeDayByModel(wk.agg, rec);
        }
      }
      for (const wk of weekMap.values()) {
        finalizeAggByModel(wk.agg);
        buckets.push({
          key: wk.startYmd === wk.endYmd ? wk.startYmd : `${wk.startYmd} ~ ${wk.endYmd}`,
          shortLabel: wk.shortLabel,
          agg: wk.agg
        });
      }
    } else {
      const monthMap = new Map();
      for (const item of daysList) {
        const ym = item.ymd.slice(0, 7);
        let mo = monthMap.get(ym);
        if (!mo) {
          const mNum = item.dt.getMonth() + 1;
          mo = {
            ym,
            shortLabel: multiYear ? `${String(item.dt.getFullYear()).slice(2)}/${mNum}` : (en ? enMonths[mNum - 1] : `${mNum}月`),
            agg: { total: 0, input: 0, cache: 0, output: 0, steps: 0, costUSD: 0, refCostUSD: 0 }
          };
          monthMap.set(ym, mo);
        }
        const rec = dailyMap[item.ymd];
        if (rec) {
          mo.agg.total += rec.total;
          mo.agg.input += rec.input;
          mo.agg.cache += rec.cache;
          mo.agg.output += rec.output;
          mo.agg.steps += rec.steps;
          mo.agg.costUSD += rec.costUSD;
          mo.agg.refCostUSD += rec.refCostUSD;
          mergeDayByModel(mo.agg, rec);
        }
      }
      for (const mo of monthMap.values()) {
        finalizeAggByModel(mo.agg);
        buckets.push({
          key: en ? mo.ym : `${mo.ym} 自然月`,
          shortLabel: mo.shortLabel,
          agg: mo.agg
        });
      }
    }

    const granLabelMap = en
      ? { day: 'Daily', week: 'Weekly', month: 'Monthly' }
      : { day: '按天', week: '按周', month: '按月' };
    setText(
      'custom-range-meta',
      en
        ? `${fmtInt(daysList.length)}d · Active ${fmtInt(activeDays)}d · ${granLabelMap[effectiveGran] || ''} (${fmtInt(buckets.length)} bars)`
        : `共 ${fmtInt(daysList.length)} 天 · 活跃 ${fmtInt(activeDays)} 天 · ${granLabelMap[effectiveGran] || ''} ${fmtInt(buckets.length)} 栏`
    );

    const sumBox = $('custom-range-summary');
    if (sumBox) {
      const rangePrompt = rangeAgg.input + rangeAgg.cache;
      const rangeCachePct = rangePrompt > 0 ? Number(((rangeAgg.cache / rangePrompt) * 100).toFixed(1)) : null;
      const rangeCost = rangeAgg.costUSD > 0 ? rangeAgg.costUSD : rangeAgg.refCostUSD;
      const pillCls = rangeCachePct === null ? 'neutral' : (rangeCachePct >= 70 ? 'good' : rangeCachePct >= 30 ? 'accent' : 'warn');
      const cachePillHtml = rangeCachePct !== null
        ? `<span class="diag-summary-pill ${pillCls}">${escZh(en ? `Period avg cache ${rangeCachePct.toFixed(1)}%` : `区间平均缓存 ${rangeCachePct.toFixed(1)}%`)}</span>`
        : `<span class="diag-summary-pill neutral">${escZh(tr('暂无缓存数据', 'No cache data'))}</span>`;
      let modelsHtml = '';
      if (rangeAgg.byModel.length > 0) {
        const denom = Math.max(1, rangeAgg.total, rangeAgg.byModel.reduce((s, m) => s + Number(m.tokens || 0), 0));
        modelsHtml = `<div class="inspector-models-row">` + rangeAgg.byModel.map((m) => {
          const tok = Number(m.tokens || 0);
          const share = Math.round((tok / denom) * 100);
          const mPrompt = Number(m.input || 0) + Number(m.cache || 0);
          const mCache = mPrompt > 0 ? Number(((Number(m.cache || 0) / mPrompt) * 100).toFixed(1)) : null;
          const tipParts = [
            m.name,
            `${fmtTokens(tok, 1)} tok (${share}%)`,
            mCache !== null ? `${tr('缓存命中', 'Cache hit')} ${mCache.toFixed(1)}%` : '',
            m.steps ? (en ? `${fmtInt(m.steps)} reqs` : `${fmtInt(m.steps)} 次`) : '',
            m.costUSD > 0 ? `${tr('约 ', '~')}${fmtUSD(m.costUSD)}` : ''
          ].filter(Boolean);
          return (
            `<span class="inspector-model-chip" title="${escZh(tipParts.join(' · '))}">` +
            `<span class="inspector-model-name">${escZh(m.name)}</span>` +
            `<span class="num muted">${escZh(`${fmtTokens(tok, 1)} (${share}%)`)}${mCache !== null ? ` · ${tr('缓', 'C')} ${mCache.toFixed(0)}%` : ''}</span>` +
            `</span>`
          );
        }).join('') + `</div>`;
      }
      sumBox.innerHTML =
        `<div class="custom-sum-head">` +
        `<span><strong>${escZh(en ? `${startYmd} to ${endYmd}` : `${startYmd} 至 ${endYmd}`)}</strong> · ${escZh(en ? `Total ${fmtTokens(rangeAgg.total)} (${fmtInt(rangeAgg.steps)} reqs)` : `总计 ${fmtTokens(rangeAgg.total)} (${fmtInt(rangeAgg.steps)} 次请求)`)}</span>` +
        cachePillHtml +
        `</div>` +
        `<div class="custom-sum-meta num">` +
        `<span>${escZh(en ? `In ${fmtTokens(rangeAgg.input, 1)} / Cache ${fmtTokens(rangeAgg.cache, 1)} / Out ${fmtTokens(rangeAgg.output, 1)}` : `输入 ${fmtTokens(rangeAgg.input, 1)} / 缓存 ${fmtTokens(rangeAgg.cache, 1)} / 输出 ${fmtTokens(rangeAgg.output, 1)}`)}</span>` +
        `<span>·</span>` +
        `<span>${escZh(`${tr('约 ', '~')}${fmtUSD(rangeCost)} (${fmtCNY(rangeCost)})`)}</span>` +
        `</div>` +
        modelsHtml;
    }

    let lastActiveBucketIdx = -1;
    for (let i = buckets.length - 1; i >= 0; i--) {
      if (buckets[i].agg.total > 0) {
        lastActiveBucketIdx = i;
        break;
      }
    }
    const effectiveCalDays = Math.max(1, calendarDays || daysList.length);
    const monthsSpan = Math.max(1, effectiveCalDays / 30);
    renderBarBuckets(stage, buckets, dailyMap, hist, monthsSpan, {
      defaultSelectedIdx: lastActiveBucketIdx >= 0 ? lastActiveBucketIdx : Math.max(0, buckets.length - 1),
      scrollScopeKey: `custom|${state.sourceFilter || 'all'}|${startYmd}|${endYmd}|${effectiveGran}`,
      calendarDaysOverride: effectiveCalDays,
      activeDaysOverride: activeDays,
      rangeTotalOverride: rangeAgg.total,
      rangeCostOverride: rangeAgg.costUSD > 0 ? rangeAgg.costUSD : rangeAgg.refCostUSD
    });
  }

  function fmtDiagTime(isoStr, fallbackDate = '') {
    if (isoStr) {
      const d = new Date(isoStr);
      if (!Number.isNaN(d.getTime())) {
        const mo = String(d.getMonth() + 1).padStart(2, '0');
        const da = String(d.getDate()).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${mo}-${da} ${hh}:${mm}`;
      }
    }
    return fallbackDate || '--';
  }

  function buildPrivacyCleanMarkdownSnapshot() {
    const snap = state.contextData || {};
    const ctx = snap.context || {};
    const spd = snap.speed || null;
    const audit = snap.audit || {};
    const st = ctx.sessionTotals || {};
    const win = computeEffectiveWindow(ctx);
    const en = isEn();

    const lines = [tr('### Antigravity 上下文遥测快照', '### Antigravity Context Telemetry Snapshot')];
    lines.push(en ? `- **Model**: ${ctx.model || 'Unknown model'}` : `- **模型**：${ctx.model || '未识别模型'}`);

    if (win.used !== null && win.budget) {
      lines.push(
        en
          ? `- **Context Window**: ${fmtTokens(win.used)} / ${fmtTokens(win.budget)} (${win.pct != null ? `${win.pct.toFixed(1)}%` : '--'})`
          : `- **上下文窗口**：${fmtTokens(win.used)} / ${fmtTokens(win.budget)}（${win.pct != null ? `${win.pct.toFixed(1)}%` : '--'}）`
      );
    } else if (win.used !== null) {
      lines.push(
        en
          ? `- **Context Window**: ${fmtTokens(win.used)} tok (cap unknown)`
          : `- **上下文窗口**：${fmtTokens(win.used)} tok（上限未知）`
      );
    } else {
      lines.push(tr('- **上下文窗口**：暂无已完成模型轮次', '- **Context Window**: No completed model turns yet'));
    }

    const sessCachePct = typeof st.cacheHitPercent === 'number' && Number.isFinite(st.cacheHitPercent)
      ? `${st.cacheHitPercent.toFixed(1)}%`
      : '--';
    const lastCachePct = typeof ctx.cacheHitPercent === 'number' && Number.isFinite(ctx.cacheHitPercent)
      ? `${ctx.cacheHitPercent.toFixed(1)}%`
      : '--';
    const cacheParts = [
      en ? `Session avg ${sessCachePct}` : `会话均值 ${sessCachePct}`,
      en ? `Last turn ${lastCachePct}` : `最近一轮 ${lastCachePct}`
    ];
    const sav = fmtCacheSavings(ctx.sessionCacheSavingsUSD);
    if (sav) cacheParts.push(sav.text);
    const totalCw = Number(st.cacheWriteTokens ?? st.cacheWrittenTokens ?? 0);
    if (totalCw > 0) cacheParts.push(en ? `Total write ${fmtTokens(totalCw, 1)}` : `累计写入 ${fmtTokens(totalCw, 1)}`);
    lines.push(en ? `- **Cache Hit**: ${cacheParts.join(' · ')}` : `- **缓存命中**：${cacheParts.join(' · ')}`);

    if (spd && (spd.tps != null || spd.duration != null)) {
      const spdParts = [];
      if (spd.tps != null) spdParts.push(`${spd.tps} tok/s`);
      if (spd.ttft != null) spdParts.push(`TTFT ${fmtSec(spd.ttft)}`);
      if (spd.duration != null) spdParts.push(`${tr('耗时', 'Latency')} ${fmtSec(spd.duration)}`);
      lines.push(en ? `- **Generation Speed**: ${spdParts.join(' · ')}` : `- **生成速度**：${spdParts.join(' · ')}`);
    } else {
      lines.push(tr('- **生成速度**：--', '- **Generation Speed**: --'));
    }

    const rounds = Number(ctx.sessionTiming?.rounds ?? audit.turnsCount ?? 0);
    const calls = Number(ctx.sessionTiming?.calls ?? audit.turnsCount ?? 0);
    const tools = Number(audit.toolCallsCount ?? 0);
    lines.push(
      en
        ? `- **Session Activity**: ${fmtInt(rounds)} turns · ${fmtInt(calls)} calls · ${fmtInt(tools)} tools`
        : `- **会话计数**：${fmtInt(rounds)} 轮响应 · ${fmtInt(calls)} 次调用 · ${fmtInt(tools)} 次工具`
    );

    if (ctx.quota) {
      const q = extractQuotaParts(ctx.quota);
      const qParts = [];
      if (q.p5 !== null) qParts.push(`5h ${q.p5.toFixed(1)}%${q.r5 ? (en ? ` (resets ${q.r5})` : `（${q.r5}重置）`) : ''}`);
      else if (q.pBase !== null) qParts.push(`${tr('基础', 'Base')} ${q.pBase.toFixed(1)}%${q.rBase ? (en ? ` (resets ${q.rBase})` : `（${q.rBase}重置）`) : ''}`);
      if (q.pW !== null) qParts.push(`${tr('周', 'Week')} ${q.pW.toFixed(1)}%${q.rW ? (en ? ` (resets ${q.rW})` : `（${q.rW}重置）`) : ''}`);
      if (qParts.length) {
        lines.push(en ? `- **Active Quota Pool**: ${qParts.join(' · ')}` : `- **当前配额池**：${qParts.join(' · ')}`);
      }
    }

    const hist = state.historyData;
    if (hist) {
      const src = state.sourceFilter || 'all';
      const srcLabelMap = en
        ? { all: 'All Sources', desktop: 'Desktop', cli: 'CLI' }
        : { all: '全部来源', desktop: '桌面端', cli: 'CLI' };
      const analytics = hist.analyticsBySource?.[src] || hist.analyticsBySource?.all;
      const dailyMap = hist.dailyMapBySource?.[src] || hist.dailyMapBySource?.all || {};
      if (analytics?.summary) {
        const s = analytics.summary;
        const todayRec = dailyMap[hist.todayKey] || {};
        const todayUSD = Number(todayRec.costUSD > 0 ? todayRec.costUSD : (todayRec.refCostUSD || 0));
        const monthUSD = Number(analytics.costs?.period?.hybrid?.totalCostUSD || 0);
        lines.push(
          en
            ? `- **Local Totals (${srcLabelMap[src] || src})**: Today ${fmtTokens(s.todayTokens)} (${fmtUSD(todayUSD)}) · Month ${fmtTokens(s.monthTokens)} (${fmtUSD(monthUSD)})`
            : `- **本机累计（${srcLabelMap[src] || src}）**：今日 ${fmtTokens(s.todayTokens)}（${fmtUSD(todayUSD)}）· 本月 ${fmtTokens(s.monthTokens)}（${fmtUSD(monthUSD)}）`
        );
      }
    }

    return lines.map((line) => formatZh(line)).join('\n');
  }

  async function copyTelemetryMarkdown() {
    const md = buildPrivacyCleanMarkdownSnapshot();
    let copied = false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(md);
        copied = true;
      }
    } catch {}

    if (!copied) {
      try {
        const ta = document.createElement('textarea');
        ta.value = md;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        copied = Boolean(document.execCommand?.('copy'));
        ta.remove();
      } catch {
        copied = false;
      }
    }

    if (!copied) {
      showToast(tr('复制失败 · 请检查剪贴板权限', 'Copy failed · Check clipboard permission'));
      return false;
    }

    const btn = $('btn-copy-md');
    const ic = $('ic-copy-md');
    const hasCheckIcon = Boolean($('ic-copy-check'));
    if (btn) btn.classList.add('cv-copied');
    if (ic && !hasCheckIcon) ic.innerHTML = '<path d="M3.2 8.4 6.5 11.7 12.8 4.8"/>';
    if (state.copyMdTimer) clearTimeout(state.copyMdTimer);
    state.copyMdTimer = setTimeout(() => {
      btn?.classList.remove('cv-copied');
      if (ic && !hasCheckIcon) {
        ic.innerHTML = '<rect x="5" y="4" width="8" height="9.5" rx="1.4"/><path d="M3.5 11V3.4A1.4 1.4 0 0 1 4.9 2h5.6"/>';
      }
      state.copyMdTimer = null;
    }, 1400);
    showToast(tr('已复制脱敏摘要', 'Summary copied'), 1800);
    return true;
  }

  function triggerBlobDownload(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try { a.remove(); } catch {}
      try { URL.revokeObjectURL(url); } catch {}
    }, 200);
  }

  function exportHistoryCsv() {
    const hist = state.historyData;
    if (!hist) {
      showToast(tr('当前范围暂无历史记录', 'No history in this range'));
      return;
    }
    const src = state.sourceFilter || 'all';
    const today = hist.todayKey || toYmd(new Date());
    const dailyMap = hist.dailyMapBySource?.[src] || hist.dailyMapBySource?.all || {};
    const analytics = hist.analyticsBySource?.[src] || hist.analyticsBySource?.all || {};
    const models = analytics.costs?.allTime?.identified?.byModel || analytics.costs?.period?.identified?.byModel || [];

    const rows = [
      ['date', 'source', 'total_tokens', 'input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens', 'requests', 'api_cost_usd']
    ];
    for (const date of Object.keys(dailyMap).sort()) {
      const rec = dailyMap[date] || {};
      const usd = Number(rec.costUSD > 0 ? rec.costUSD : (rec.refCostUSD || 0));
      rows.push([
        date,
        src,
        Number(rec.total || 0),
        Number(rec.input || 0),
        Number(rec.cache || 0),
        Number(rec.cacheWrite ?? rec.cacheWriteTokens ?? 0),
        Number(rec.output || 0),
        Number(rec.steps || 0),
        usd.toFixed(4)
      ]);
    }

    rows.push([]);
    rows.push(['model', 'requests', 'total_tokens', 'input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens', 'api_cost_usd', 'net_cache_savings_usd']);
    for (const m of models) {
      if (!m) continue;
      rows.push([
        m.displayName || m.modelKey || 'Unknown',
        Number(m.requests || 0),
        Number(m.tokens || 0),
        Number(m.inputTokens || 0),
        Number(m.cacheTokens || 0),
        Number(m.cacheWriteTokens || 0),
        Number(m.outputTokens || 0),
        Number(m.costUSD || 0).toFixed(4),
        Number(m.cacheSavingsUSD || 0).toFixed(4)
      ]);
    }

    const csvBody = '\uFEFF' + rows.map((r) => (r.length ? r.map(escapeCsvCell).join(',') : '')).join('\r\n');
    const filename = `agy-context-ledger-${src}-${today}.csv`;
    triggerBlobDownload(filename, csvBody, 'text/csv;charset=utf-8');
    showToast(tr(`已导出 CSV 台账：${filename}`, `Exported CSV ledger: ${filename}`));
  }

  function exportHistoryJson() {
    const hist = state.historyData;
    if (!hist) {
      showToast(tr('当前范围暂无历史记录', 'No history in this range'));
      return;
    }
    const src = state.sourceFilter || 'all';
    const today = hist.todayKey || toYmd(new Date());
    const dailyMap = hist.dailyMapBySource?.[src] || hist.dailyMapBySource?.all || {};
    const analytics = hist.analyticsBySource?.[src] || hist.analyticsBySource?.all || {};

    const payload = {
      exportedAt: new Date().toISOString(),
      source: src,
      todayKey: today,
      firstUseDate: hist.firstUseDate || null,
      summary: analytics.summary ? {
        grandTotalTokens: Number(analytics.summary.grandTotalTokens || 0),
        todayTokens: Number(analytics.summary.todayTokens || 0),
        monthTokens: Number(analytics.summary.monthTokens || 0),
        yearTokens: Number(analytics.summary.yearTokens || 0),
        activeDaysCount: Number(analytics.summary.activeDaysCount || 0),
        totalSteps: Number(analytics.summary.totalSteps || 0)
      } : null,
      daily: Object.keys(dailyMap).sort().map((date) => {
        const rec = dailyMap[date] || {};
        const usd = Number(rec.costUSD > 0 ? rec.costUSD : (rec.refCostUSD || 0));
        return {
          date,
          totalTokens: Number(rec.total || 0),
          inputTokens: Number(rec.input || 0),
          cacheReadTokens: Number(rec.cache || 0),
          cacheWriteTokens: Number(rec.cacheWrite ?? rec.cacheWriteTokens ?? 0),
          outputTokens: Number(rec.output || 0),
          requests: Number(rec.steps || 0),
          apiCostUSD: Number(usd.toFixed(6))
        };
      }),
      byModel: (analytics.costs?.allTime?.identified?.byModel || []).filter(Boolean).map((m) => ({
        displayName: m.displayName || 'Unknown',
        requests: Number(m.requests || 0),
        totalTokens: Number(m.tokens || 0),
        inputTokens: Number(m.inputTokens || 0),
        cacheReadTokens: Number(m.cacheTokens || 0),
        cacheWriteTokens: Number(m.cacheWriteTokens || 0),
        outputTokens: Number(m.outputTokens || 0),
        apiCostUSD: Number((m.costUSD || 0).toFixed(6)),
        netCacheSavingsUSD: Number((m.cacheSavingsUSD || 0).toFixed(6))
      })),
      byProject: (analytics.byProject || []).filter(Boolean).map((p) => ({
        name: p.name || '未归类工作区',
        conversations: Number(p.conversations || 0),
        requests: Number(p.requests || 0),
        totalTokens: Number(p.tokens || 0),
        inputTokens: Number(p.inputTokens || 0),
        cacheReadTokens: Number(p.cacheTokens || 0),
        cacheWriteTokens: Number(p.cacheWriteTokens || 0),
        outputTokens: Number(p.outputTokens || 0),
        apiCostUSD: Number((p.costUSD || 0).toFixed(6)),
        netCacheSavingsUSD: Number((p.cacheSavingsUSD || 0).toFixed(6))
      }))
    };

    const filename = `agy-context-ledger-${src}-${today}.json`;
    triggerBlobDownload(filename, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
    showToast(tr(`已导出 JSON 台账：${filename}`, `Exported JSON ledger: ${filename}`));
  }

  function renderDiagnosticsCard(diag) {
    const strip = $('diag-summary-strip');
    const list = $('diagnostics-list');
    if (!strip || !list) return;
    const en = isEn();

    const evSum = diag?.eventsSummary || {
      total: 0,
      safetyFilter: 0,
      safetyWastedUSD: 0,
      quota429: 0,
      upstreamRetry: 0,
      contextOverflow: 0
    };
    const rtSum = diag?.routingSummary || { total: 0, uniqueModels: 0 };
    const totalEvents = Number(evSum.total || 0);
    const totalRouting = Number(rtSum.total || 0);
    const totalAll = totalEvents + totalRouting;

    setText('diag-source-chip', diag?.sqliteEnabled ? tr('SQLite 只读增强', 'SQLite Read-Only') : tr('Transcript 模式', 'Transcript Mode'));
    setText(
      'diag-count-chip',
      totalAll > 0
        ? (en ? `${fmtInt(totalAll)} items` : `共 ${fmtInt(totalAll)} 条`)
        : tr('运行平稳 · 0 异常', 'Healthy · 0 issues')
    );

    const q429 = Number(evSum.quota429 || 0);
    const safetyCnt = Number(evSum.safetyFilter || 0);
    const safetyWaste = Number(evSum.safetyWastedUSD || 0);
    const retryCnt = Number(evSum.upstreamRetry || 0);
    const overflowCnt = Number(evSum.contextOverflow || 0);

    const pills = [
      {
        cls: q429 > 0 ? 'warn' : 'neutral',
        text: `${tr('429 限流', '429 Rate Limit')} ${fmtInt(q429)}`,
        tip: tr('上游或配额池触发 429 限流次数', 'Upstream or quota pool 429 rate-limit count')
      },
      {
        cls: safetyCnt > 0 ? 'danger' : 'neutral',
        text: en ? `Safety Filter ${fmtInt(safetyCnt)} · Wasted ${fmtUSD(safetyWaste)}` : `安全过滤 ${fmtInt(safetyCnt)} · 浪费 ${fmtUSD(safetyWaste)}`,
        tip: en
          ? `Safety filter interruptions and estimated wasted cost (~${fmtCNY(safetyWaste)})`
          : `安全过滤中断次数及预计浪费折算成本（约 ${fmtCNY(safetyWaste)}）`
      },
      {
        cls: retryCnt > 0 || overflowCnt > 0 ? 'warn' : 'neutral',
        text: `${tr('上游重试', 'Upstream Retry')} ${fmtInt(retryCnt)}`,
        tip: overflowCnt > 0
          ? (en ? `Upstream retries ${fmtInt(retryCnt)} · Context overflows ${fmtInt(overflowCnt)}` : `上游重试 ${fmtInt(retryCnt)} 次 · 上下文溢出 ${fmtInt(overflowCnt)} 次`)
          : tr('上游超时或服务波动自动重试次数', 'Auto-retry count on upstream timeouts or transient errors')
      },
      {
        cls: totalRouting > 0 ? 'accent' : 'neutral',
        text: `${tr('灰度路由', 'Shadow Routing')} ${fmtInt(totalRouting)}`,
        tip: rtSum.uniqueModels > 0
          ? (en ? `Involves ${fmtInt(rtSum.uniqueModels)} model route changes` : `涉及 ${fmtInt(rtSum.uniqueModels)} 个模型路由变化`)
          : tr('请求模型与实际响应模型不一致的路由记录', 'Requests where responded model differed from requested model')
      }
    ];
    strip.innerHTML = pills.map((p) =>
      `<span class="diag-summary-pill ${p.cls}" title="${escZh(p.tip)}">${escZh(p.text)}</span>`
    ).join('');

    const activeTab = state.diagTab === 'routing' ? 'routing' : 'events';
    document.querySelectorAll('#diag-tab-seg .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.dtab === activeTab);
    });
    const renderSigs = state.lastRenderSigs || (state.lastRenderSigs = {});
    const applyDiagListHtml = (html) => {
      if (renderSigs['diagnostics-list'] === html) return;
      renderSigs['diagnostics-list'] = html;
      const prevTop = list.scrollTop || 0;
      list.innerHTML = html;
      if (prevTop > 0) list.scrollTop = prevTop;
    };

    if (activeTab === 'routing') {
      const routing = Array.isArray(diag?.recentRouting) ? diag.recentRouting.filter(Boolean) : [];
      setText(
        'diag-toolbar-meta',
        rtSum.uniqueModels > 0
          ? (en
              ? `${fmtInt(totalRouting || routing.length)} routes · ${fmtInt(rtSum.uniqueModels)} models`
              : `共 ${fmtInt(totalRouting || routing.length)} 次 · 涉及 ${fmtInt(rtSum.uniqueModels)} 个模型`)
          : (en
              ? `${fmtInt(totalRouting || routing.length)} route changes`
              : `共 ${fmtInt(totalRouting || routing.length)} 次路由变化`)
      );
      if (!routing.length) {
        applyDiagListHtml(`<div class="kv-row"><span class="muted">${escZh(tr('暂未检测到服务端灰度路由或模型回退记录', 'No server shadow routing or model fallback detected'))}</span></div>`);
        return;
      }
      applyDiagListHtml(routing.map((r) => {
        const title = r.convTitle || (r.convId ? String(r.convId).slice(0, 8) : tr('未知会话', 'Unknown session'));
        const stepPart = r.stepIndex != null ? `Step ${r.stepIndex}` : '';
        const timePart = r.date || '--';
        const reasonPart = r.reason ? `<div class="diag-detail">${escZh(r.reason)}</div>` : '';
        return (
          `<div class="diag-item">` +
          `<div class="diag-item-top">` +
          `<span class="diag-item-left">` +
          `<span class="status-pill neutral">${escZh(tr('灰度路由', 'Shadow Route'))}</span>` +
          `<span class="diag-route-arrow">${esc(r.requestedModel || '--')} → ${esc(r.respondedModel || '--')}</span>` +
          `</span>` +
          `<span class="muted xs num">${esc(timePart)}${stepPart ? ` · ${esc(stepPart)}` : ''}</span>` +
          `</div>` +
          `<div class="diag-item-meta">` +
          `<span class="diag-item-title" title="${esc(title)}">${esc(title)}</span>` +
          `</div>` +
          reasonPart +
          `</div>`
        );
      }).join(''));
      return;
    }

    const events = Array.isArray(diag?.recentEvents) ? diag.recentEvents.filter(Boolean) : [];
    setText(
      'diag-toolbar-meta',
      overflowCnt > 0
        ? (en ? `${fmtInt(totalEvents || events.length)} anomalies · ${fmtInt(overflowCnt)} overflows` : `共 ${fmtInt(totalEvents || events.length)} 条异常 · 溢出 ${fmtInt(overflowCnt)}`)
        : (en ? `${fmtInt(totalEvents || events.length)} anomalies` : `共 ${fmtInt(totalEvents || events.length)} 条异常事件`)
    );
    if (!events.length) {
      applyDiagListHtml(`<div class="kv-row"><span class="muted">${escZh(tr('暂未检测到 429 限流、安全过滤或上游重试异常', 'No 429 rate limits, safety filters, or upstream retries detected'))}</span></div>`);
      return;
    }

    const kindMap = {
      quota_429: { text: tr('429 限流', '429 Rate Limit'), cls: 'warn' },
      rate_limit: { text: tr('429 限流', '429 Rate Limit'), cls: 'warn' },
      '429': { text: tr('429 限流', '429 Rate Limit'), cls: 'warn' },
      safety_filter: { text: tr('安全过滤', 'Safety Filter'), cls: 'danger' },
      safety: { text: tr('安全过滤', 'Safety Filter'), cls: 'danger' },
      upstream_retry: { text: tr('上游重试', 'Upstream Retry'), cls: 'warn' },
      retry: { text: tr('上游重试', 'Upstream Retry'), cls: 'warn' },
      context_overflow: { text: tr('上下文溢出', 'Context Overflow'), cls: 'danger' },
      overflow: { text: tr('上下文溢出', 'Context Overflow'), cls: 'danger' }
    };

    applyDiagListHtml(events.map((ev) => {
      const km = kindMap[String(ev.kind || '').toLowerCase()] || { text: ev.kind || tr('异常事件', 'Anomaly'), cls: 'neutral' };
      const title = ev.convTitle || (ev.convId ? String(ev.convId).slice(0, 8) : tr('未知会话', 'Unknown session'));
      const timeStr = fmtDiagTime(ev.createdAt, ev.date);
      const stepPart = ev.stepIndex != null ? `Step ${ev.stepIndex}` : '';
      const wastedHtml = Number(ev.wastedUSD || 0) > 0
        ? `<span class="turn-chip cost">${escZh(`${tr('浪费', 'Wasted')} ${fmtUSD(ev.wastedUSD)}`)}</span>`
        : '';
      const retriesHtml = Number(ev.retries || 0) > 0
        ? `<span class="diag-meta-badge warn">${escZh(en ? `${Number(ev.retries)} retries` : `重试 ${Number(ev.retries)} 次`)}</span>`
        : '';
      const reqIdHtml = ev.requestId
        ? `<span class="diag-meta-badge">${esc(`req:${String(ev.requestId).slice(0, 12)}`)}</span>`
        : '';
      const detailHtml = ev.detail ? `<div class="diag-detail">${esc(ev.detail)}</div>` : '';
      return (
        `<div class="diag-item">` +
        `<div class="diag-item-top">` +
        `<span class="diag-item-left">` +
        `<span class="status-pill ${km.cls}">${escZh(km.text)}</span>` +
        `<span class="diag-item-title" title="${esc(title)}">${esc(title)}</span>` +
        retriesHtml +
        reqIdHtml +
        wastedHtml +
        `</span>` +
        `<span class="muted xs num">${esc(timeStr)}${stepPart ? ` · ${esc(stepPart)}` : ''}</span>` +
        `</div>` +
        detailHtml +
        `</div>`
      );
    }).join(''));
  }

  // -------------------------------------------------------------------------
  // TAB 3: Subscription Plan & API Cost Breakdown
  // -------------------------------------------------------------------------

  function populatePlanPresetsIfNeeded(presets) {
    const langKey = isEn() ? 'en' : 'zh';
    if ((state.presetsPopulated && state.presetsLang === langKey) || !presets) return;
    const regSel = $('f-region-preset');
    const acqSel = $('f-acquisition');
    const curSel = $('f-currency');
    if (!regSel || !acqSel || !curSel) return;

    const prevReg = regSel.value;
    const prevAcq = acqSel.value;
    const prevCur = curSel.value;
    const perMo = isEn() ? '/mo' : '/月';

    regSel.innerHTML = (presets.regions || []).map((r) =>
      `<option value="${esc(r.id)}">${escZh(`${r.name} · ${r.symbol}${r.monthlyPrice}${perMo}`)}</option>`
    ).join('');

    acqSel.innerHTML = (presets.acquisitions || []).map((a) =>
      `<option value="${esc(a.id)}">${escZh(a.name)}</option>`
    ).join('');

    curSel.innerHTML = (presets.currencies || []).map((c) =>
      `<option value="${esc(c.code)}">${esc(`${c.code} (${c.symbol.trim()})`)}</option>`
    ).join('');

    if (prevReg) regSel.value = prevReg;
    if (prevAcq) acqSel.value = prevAcq;
    if (prevCur) curSel.value = prevCur;

    state.presetsPopulated = true;
    state.presetsLang = langKey;
  }

  function syncPlanFormInputs(planStatus, customPlan = null) {
    if (!planStatus) return;
    const c = customPlan || {};
    if ($('f-region-preset')) $('f-region-preset').value = planStatus.subscriptionRegion || 'US';
    if ($('f-acquisition')) $('f-acquisition').value = planStatus.acquisitionId || 'normal_paid';
    if ($('f-account-country')) $('f-account-country').value = c.accountCountry || '';
    if ($('f-acq-name')) $('f-acq-name').value = c.acquisitionName || '';
    if ($('f-price-mode')) $('f-price-mode').value = planStatus.priceMode || 'preset';
    if ($('f-currency')) $('f-currency').value = planStatus.currency || 'USD';
    if ($('f-paid')) {
      $('f-paid').value = c.actualPricePaid !== undefined && c.actualPricePaid !== null
        ? c.actualPricePaid
        : (planStatus.effectivePrice ?? '');
    }
    if ($('f-cycle')) $('f-cycle').value = planStatus.billingCycle || '月付';
    if ($('f-valid-until')) $('f-valid-until').value = planStatus.validUntil || '';
    if ($('f-zero-extra')) $('f-zero-extra').checked = Boolean(planStatus.zeroExtra);
    if ($('f-note')) $('f-note').value = planStatus.note || '';
  }

  function renderCostPanel(hist) {
    const plan = hist.planStatus || {};
    const quotas = hist.modelQuotas || [];
    const en = isEn();

    // Badge
    const badge = $('plan-tier-badge');
    if (badge) {
      badge.className = `status-pill ${plan.status === 'identified' ? 'good' : 'neutral'}`;
      setText(
        badge,
        plan.isCustomized
          ? tr('已自定义实付', 'Custom Rate')
          : (plan.status === 'identified' ? tr('档位已识别', 'Detected') : tr('待补充', 'Unset'))
      );
    }

    setText('plan-headline', plan.tierName || tr('未识别订阅', 'Unidentified Plan'));
    setText(
      'plan-subline',
      plan.isCustomized
        ? `${plan.subscriptionRegionName || tr('默认美区', 'Default US')} · ${plan.acquisitionLabel || tr('常规订阅', 'Standard Plan')}`
        : (plan.status === 'identified'
            ? tr('公开参考价 · 点右上角可改实付', 'Public list price · Customize in top-right')
            : tr('未连接语言服务 · 点右上角手动设置', 'Host offline · Set manually in top-right'))
    );

    if (plan.monthlyNormalized === 0) {
      setText('plan-price-main', en ? `${plan.symbol || '$'}0 / mo` : `${plan.symbol || '$'}0 / 月`);
      setText('plan-price-cny', tr('免额外付费（¥0.00）', 'No extra fee (¥0.00)'));
    } else if (plan.monthlyNormalized !== null && plan.monthlyNormalized !== undefined) {
      setText('plan-price-main', en ? `${plan.symbol || '$'}${plan.monthlyNormalized} / mo` : `${plan.symbol || '$'}${plan.monthlyNormalized} / 月`);
      setText(
        'plan-price-cny',
        plan.isCustomized
          ? (en ? `Paid ~¥${(plan.monthlyCNY ?? 0).toFixed(2)} / mo` : `实付约 ¥${(plan.monthlyCNY ?? 0).toFixed(2)} / 月`)
          : (en ? `~¥${(plan.monthlyCNY ?? 0).toFixed(2)} / mo` : `约 ¥${(plan.monthlyCNY ?? 0).toFixed(2)} / 月`)
      );
    } else {
      setText('plan-price-main', tr('待指定金额', 'Amount Unset'));
      setText('plan-price-cny', plan.priceRangeNote || '--');
    }

    const planRows = [
      [tr('当前账号', 'Account'), plan.maskedEmail || tr('本机已登录会话', 'Local signed-in session')],
      [
        plan.isCustomized ? tr('计价与周期', 'Billing Cycle') : tr('参考基准', 'Price Reference'),
        plan.isCustomized
          ? `${plan.subscriptionRegionName || '--'} · ${plan.billingCycle || tr('月付', 'Monthly')}`
          : tr(`${plan.subscriptionRegionName || '美国 (US)'} 标准价`, `${plan.subscriptionRegionName || 'US'} list price`),
        plan.isCustomized ? '' : tr('API 不返回家庭组与实付账单', 'Client API omits family split & receipt')
      ],
      [
        tr('获取渠道', 'Channel'),
        plan.isCustomized ? (plan.acquisitionLabel || '--') : tr('未指定', 'Not specified'),
        plan.isCustomized ? '' : tr('可设为家庭组共享 / AA 拼车 / 赠送', 'Supports family split / promo / gift')
      ]
    ];
    if (plan.accountCountry && plan.accountCountry !== '自动 / 未设置') {
      planRows.push([tr('账号归属地备注', 'Account Region Note'), plan.accountCountry]);
    }
    if (plan.validUntil) planRows.push([tr('权益到期日', 'Valid Until'), plan.validUntil]);
    if (plan.note) planRows.push([tr('本地备注', 'Local Note'), plan.note]);

    const quotaStatus = hist.quotaStatus || null;
    if (quotaStatus?.stale) {
      const tStr = fmtSyncClock(quotaStatus.lastSuccessAt);
      planRows.push([
        tr('配额同步状态', 'Quota Sync'),
        (quotaStatus.errorCode === 'ECONNREFUSED' || quotaStatus.errorCode === 'ECONNRESET')
          ? tr(
              `原宿主连接已断开，展示上次缓存${tStr ? `（${tStr} · 重启独立窗口可重新绑定）` : ''}`,
              `Host disconnected; showing cached snapshot${tStr ? ` (${tStr} · relaunch float window to rebind)` : ''}`
            )
          : tr(
              `语言服务暂不可达，展示上次缓存${tStr ? `（${tStr}）` : ''}`,
              `Language service unreachable; showing cached snapshot${tStr ? ` (${tStr})` : ''}`
            )
      ]);
    } else if (quotaStatus?.summaryStale) {
      planRows.push([tr('配额同步状态', 'Quota Sync'), tr('多窗口配额摘要暂不可用，仅展示基础池', 'Multi-window summary unavailable; showing base pool')]);
    } else if (quotaStatus?.state === 'error') {
      planRows.push([tr('配额同步状态', 'Quota Sync'), quotaStatus.reason || tr('语言服务请求失败，暂未获取到配额池', 'Language service request failed; quota pools unavailable')]);
    } else if (quotaStatus?.state === 'unavailable') {
      planRows.push([tr('配额同步状态', 'Quota Sync'), quotaStatus.reason || tr('未连接宿主语言服务（当前为离线模式）', 'Host language service not connected (offline mode)')]);
    }

    const planKv = $('plan-kv');
    if (planKv) {
      planKv.innerHTML = planRows.map(([k, v, sub]) => (
        `<div class="kv-row">` +
        `<span class="kv-k">${escZh(k)}</span>` +
        `<span class="kv-v-stack">` +
        `<span class="kv-v">${escZh(v)}</span>` +
        (sub ? `<span class="kv-v-sub">${escZh(sub)}</span>` : '') +
        `</span>` +
        `</div>`
      )).join('');
    }

    // Live Model Quota Pools (5h burst window + Weekly tier/family shared pool)
    const qWrap = $('quota-pools-wrap');
    const qList = $('quota-pools-list');
    const qSyncPill = $('quota-sync-pill');
    if (qSyncPill) {
      if (quotaStatus?.stale) {
        const tStr = fmtSyncClock(quotaStatus.lastSuccessAt);
        qSyncPill.className = 'status-pill warn';
        setText(qSyncPill, tr(`缓存快照${tStr ? ` · ${tStr}` : ''}`, `Cached${tStr ? ` · ${tStr}` : ''}`));
      } else if (quotaStatus?.summaryStale) {
        qSyncPill.className = 'status-pill warn';
        setText(qSyncPill, tr('摘要降级', 'Summary Degraded'));
      } else if (quotaStatus?.state === 'error') {
        qSyncPill.className = 'status-pill danger';
        setText(qSyncPill, tr('连接失败', 'Connection Error'));
      } else if (quotaStatus?.state === 'unavailable') {
        qSyncPill.className = 'status-pill neutral';
        setText(qSyncPill, tr('未连接宿主', 'Host Offline'));
      } else {
        qSyncPill.className = 'status-pill warn hidden';
        setText(qSyncPill, '');
      }
    }

    if (qWrap && qList) {
      if (quotas.length > 0) {
        const barColor = (p) => (p <= 15 ? 'var(--danger)' : p <= 40 ? 'var(--warn)' : 'var(--good)');
        const renderQuotaWinBlock = (winTitle, pctVal, resetZh, defaultResetText, cal = null) => {
          const calHtml = formatQuotaCalibrationHtml(cal);
          if (isKnownPct(pctVal)) {
            const rStr = resetZh
              ? (en ? `resets ${resetZh}` : `${resetZh} 重置`)
              : defaultResetText;
            const w = Math.min(100, Math.max(0, pctVal));
            return (
              `<div class="quota-win-block">` +
              `<div class="quota-inline-sub"><span>${escZh(winTitle)}</span><span class="num-strong">${escZh(`${pctVal.toFixed(1)}% · ${rStr}`)}</span></div>` +
              `<div class="thin-track"><div class="thin-fill" style="width:${w}%;background:${barColor(pctVal)}"></div></div>` +
              calHtml +
              `</div>`
            );
          }
          const unknownLabel = resetZh
            ? (en ? `Unknown · resets ${resetZh}` : `余量未知 · ${resetZh} 重置`)
            : tr('余量未知', 'Unknown');
          return (
            `<div class="quota-win-block">` +
            `<div class="quota-inline-sub"><span>${escZh(winTitle)}</span><span class="muted num">${escZh(unknownLabel)}</span></div>` +
            `<div class="thin-track"><div class="thin-fill" style="width:0%;background:var(--cv-muted)"></div></div>` +
            calHtml +
            `</div>`
          );
        };

        qWrap.classList.remove('hidden');
        qList.innerHTML = quotas.map((pool) => {
          const modelLabels = (pool.models || [])
            .map((m) => (typeof m === 'string' ? m : (m?.label || m?.modelId || '')))
            .filter(Boolean);
          const families = Array.isArray(pool.families) && pool.families.length
            ? pool.families
            : [...new Set(modelLabels.map((n) => n.replace(/\s*\((?:XHigh|Low|Medium|High|Minimal|Thinking|Fast|Orchestrator)\)\s*$/i, '').trim()))];
          const familySummary = families.length <= 3
            ? families.join(' / ')
            : (en ? `${families.slice(0, 3).join(' / ')} +${families.length - 3}` : `${families.slice(0, 3).join(' / ')} 等 ${families.length} 组`);
          const label = pool.displayTitle || familySummary;
          const variantCount = pool.modelsCount || modelLabels.length;
          const hoverDetail = modelLabels.length
            ? (en ? `${familySummary} (tiers: ${modelLabels.join(', ')})` : `${familySummary}（包含档位：${modelLabels.join('、')}）`)
            : familySummary;

          const { pBase, rBase } = extractQuotaParts(pool);
          if (pool.fiveHour || pool.weekly) {
            const winBlocks = [];
            if (pBase !== null) {
              winBlocks.push(renderQuotaWinBlock(
                tr('基础配额窗口', 'Base Quota Window'),
                pBase,
                rBase || pool.resetTimeZh,
                tr('自动周期重置', 'Auto cycle reset'),
                pool.calibration || null
              ));
            }
            if (pool.fiveHour) {
              winBlocks.push(renderQuotaWinBlock(
                tr('5 小时滚动限额', '5-Hour Rolling Limit'),
                pool.fiveHour.remainingPercent,
                pool.fiveHour.resetTimeZh,
                tr('5h 滚动重置', '5h rolling reset'),
                pool.fiveHour.calibration || null
              ));
            }
            if (pool.weekly) {
              winBlocks.push(renderQuotaWinBlock(
                tr('Week 周度总额度（档位共享池）', 'Weekly Total Quota (Shared Pool)'),
                pool.weekly.remainingPercent,
                pool.weekly.resetTimeZh,
                tr('按周重置', 'Weekly reset'),
                pool.weekly.calibration || null
              ));
            }
            return (
              `<div class="quota-inline" title="${escZh(hoverDetail)}">` +
              `<div class="quota-inline-head">` +
              `<span class="quota-name">${escZh(label)}</span>` +
              `<span class="quota-tag">${escZh(en ? `${variantCount} tiers` : `共 ${variantCount} 档`)}</span>` +
              `</div>` +
              winBlocks.join('') +
              `</div>`
            );
          }

          const hasPct = isKnownPct(pool.remainingPercent);
          const pctVal = hasPct ? pool.remainingPercent : null;
          const subLeft = variantCount > families.length
            ? tr(`共享配额池 · 含 ${variantCount} 个模型档位`, `Shared pool · ${variantCount} tiers`)
            : tr(`共享配额池 · ${variantCount || families.length} 个模型`, `Shared pool · ${variantCount || families.length} models`);
          const resetStr = pool.resetTimeZh
            ? (en ? `resets ${pool.resetTimeZh}` : `${pool.resetTimeZh} 重置`)
            : (hasPct ? tr('自动周期重置', 'Auto cycle reset') : tr('服务端未返回余量百分比', 'Percentage omitted by server'));
          const fillStyle = hasPct
            ? `width:${Math.min(100, Math.max(0, pctVal))}%;background:${barColor(pctVal)}`
            : 'width:0%;background:var(--cv-muted)';
          const calHtml = formatQuotaCalibrationHtml(pool.calibration || null);
          return (
            `<div class="quota-inline" title="${escZh(hoverDetail)}">` +
            `<div class="quota-inline-head">` +
            `<span class="quota-name">${escZh(label)}</span>` +
            `<span class="${hasPct ? 'num-strong' : 'muted num'} quota-val">${escZh(hasPct ? `${pctVal.toFixed(1)}%` : tr('余量未知', 'Unknown'))}</span>` +
            `</div>` +
            `<div class="thin-track"><div class="thin-fill" style="${fillStyle}"></div></div>` +
            `<div class="quota-inline-sub">` +
            `<span>${escZh(subLeft)}</span>` +
            `<span class="num">${escZh(resetStr)}</span>` +
            `</div>` +
            calHtml +
            `</div>`
          );
        }).join('');
      } else if (quotaStatus?.state === 'error') {
        qWrap.classList.remove('hidden');
        qList.innerHTML = `<div class="kv-row"><span class="muted">${escZh(quotaStatus.reason || tr('宿主语言服务暂不可达，尚未获取到模型配额池数据', 'Host language service unreachable; model quota pools unavailable'))}</span></div>`;
      } else if (quotaStatus?.state === 'unavailable') {
        qWrap.classList.remove('hidden');
        qList.innerHTML = `<div class="kv-row"><span class="muted">${escZh(tr('未连接宿主语言服务，暂无法获取实时模型额度；若从桌面端右侧栏打开看板并点击 📌，可同步实时配额与套餐', 'Host language service offline; live quota unavailable. Open from Desktop sidebar and click 📌 to sync live quota & plan.'))}</span></div>`;
      } else {
        qWrap.classList.add('hidden');
      }
    }

    // Card 2: API Cost Breakdown & Subscription Comparison
    const srcAnalytics = hist.analyticsBySource?.[state.sourceFilter] || hist.analyticsBySource?.all;
    if (!srcAnalytics) return;

    const scopeBundle = srcAnalytics.costs?.[state.costScope] || srcAnalytics.costs?.period;
    const ident = scopeBundle.identified;
    const ref = scopeBundle.reference;
    const hyb = scopeBundle.hybrid;

    let totalUSD = 0;
    let inUSD = 0;
    let cacheUSD = 0;
    let outUSD = 0;
    let cacheSavedUSD = 0;
    let inTok = ref.inputTokens;
    let cacheTok = ref.cacheTokens;
    let cacheWriteTok = Number(hyb?.cacheWriteTokens ?? ref?.cacheWriteTokens ?? 0);
    let outTok = ref.outputTokens;

    if (state.costMode === 'hybrid') {
      totalUSD = hyb.totalCostUSD;
      inUSD = hyb.inputCostUSD;
      cacheUSD = hyb.cacheCostUSD;
      outUSD = hyb.outputCostUSD;
      cacheSavedUSD = Number(hyb?.cacheSavingsUSD ?? 0);
      cacheWriteTok = Number(hyb?.cacheWriteTokens ?? ref?.cacheWriteTokens ?? 0);
    } else if (state.costMode === 'identified') {
      totalUSD = ident.pricedCostUSD;
      inUSD = ident.pricedInputCostUSD;
      cacheUSD = ident.pricedCacheCostUSD;
      outUSD = ident.pricedOutputCostUSD;
      inTok = ident.byCategory.inputTokens;
      cacheTok = ident.byCategory.cacheTokens;
      cacheWriteTok = Number(ident.byCategory?.cacheWriteTokens ?? ident?.cacheWriteTokens ?? 0);
      outTok = ident.byCategory.outputTokens;
      cacheSavedUSD = Number(ident?.pricedCacheSavingsUSD ?? ident?.cacheSavingsUSD ?? 0);
    } else {
      totalUSD = ref.totalCostUSD;
      inUSD = ref.inputCostUSD;
      cacheUSD = ref.cacheCostUSD;
      outUSD = ref.outputCostUSD;
      cacheSavedUSD = Number(ref?.cacheSavingsUSD ?? 0);
      cacheWriteTok = Number(ref?.cacheWriteTokens ?? 0);
    }

    setText('cost-big-usd', fmtUSD(totalUSD));
    setText('cost-big-cny', en ? `Approx. ${fmtCNY(totalUSD)}` : `折合人民币约 ${fmtCNY(totalUSD)}`);

    const covPill = $('cost-cov-pill');
    if (covPill) {
      const cov = ident.tokenCoveragePercent ?? 100;
      covPill.className = `status-pill ${cov >= 85 ? 'good' : cov >= 45 ? 'warn' : 'neutral'}`;
      setText(
        covPill,
        state.costMode === 'reference'
          ? tr('Flash 统一基准', 'Flash Baseline')
          : tr(`已精确识别 ${cov.toFixed(1)}% Token`, `${cov.toFixed(1)}% Token Exact`)
      );
    }
    setText(
      'cost-scope-label',
      state.costScope === 'period'
        ? (en
            ? `${hist.currentPeriod?.label || 'This Month'} · ${fmtInt(ident.totalRequestsCount)} requests`
            : `${hist.currentPeriod?.label || '本期自然月'} · ${fmtInt(ident.totalRequestsCount)} 次请求`)
        : (en
            ? `Since ${hist.firstUseDate || '--'} · ${fmtInt(ident.totalRequestsCount)} requests`
            : `自 ${hist.firstUseDate || '--'} 累计 · ${fmtInt(ident.totalRequestsCount)} 次请求`)
    );

    // Dual bar comparison: API value vs Subscription actual paid
    const dailyMap = hist.dailyMapBySource?.[state.sourceFilter] || {};
    const activeMonthsCount = state.costScope === 'period'
      ? 1
      : Math.max(1, new Set(Object.keys(dailyMap).map((d) => d.slice(0, 7))).size);

    const subUSD = plan.monthlyUSD !== null && plan.monthlyUSD !== undefined
      ? Number((plan.monthlyUSD * activeMonthsCount).toFixed(2))
      : null;

    setText(
      'compare-title',
      state.costScope === 'period'
        ? tr('本月 API 等值消耗 vs 月度订阅实付', 'Monthly API Equivalent vs. Subscription Paid')
        : tr(
            `全量 API 等值消耗 vs 累计订阅实付（按 ${activeMonthsCount} 个活跃月折算）`,
            `All-Time API Equivalent vs. Paid (${activeMonthsCount} active mo)`
          )
    );

    const maxBar = Math.max(totalUSD, subUSD || 0, 0.01);
    if ($('bar-api-val')) setGpuBarRatio($('bar-api-val'), Number(Math.min(100, (totalUSD / maxBar) * 100).toFixed(1)));
    setText('lbl-api-val', fmtUSD(totalUSD));

    if (subUSD !== null) {
      if ($('bar-sub-val')) setGpuBarRatio($('bar-sub-val'), Number(Math.min(100, (subUSD / maxBar) * 100).toFixed(1)));
      setText('lbl-sub-val', fmtUSD(subUSD));
      const diff = totalUSD - subUSD;
      if (subUSD === 0) {
        setText(
          'compare-diff',
          en ? `No extra fee · ${fmtUSD(totalUSD)} API value used` : `免额外付费 · 已白嫖等值 ${fmtUSD(totalUSD)}`
        );
      } else if (diff >= 0) {
        setText(
          'compare-diff',
          en
            ? `Exceeded plan cost +${fmtUSD(diff)} (${(totalUSD / subUSD).toFixed(2)}x ROI)`
            : `已超出订阅费 +${fmtUSD(diff)}（${(totalUSD / subUSD).toFixed(2)}x 回本）`
        );
      } else {
        setText(
          'compare-diff',
          en
            ? `${fmtUSD(Math.abs(diff))} below break-even (${(totalUSD / subUSD * 100).toFixed(0)}% used)`
            : `距回本还差 ${fmtUSD(Math.abs(diff))}（已用 ${(totalUSD / subUSD * 100).toFixed(0)}%）`
        );
      }
    } else {
      if ($('bar-sub-val')) setGpuBarRatio($('bar-sub-val'), 0);
      setText('lbl-sub-val', tr('未设实付', 'Unset'));
      setText('compare-diff', tr('设置订阅实付后可对比性价比', 'Set paid plan rate to compare ROI'));
    }

    // 3 Category Tiles
    setText('cat-in-cost', fmtUSD(inUSD));
    setText('cat-in-tok', `${fmtTokens(inTok)} tok`);
    setText('cat-cache-cost', fmtUSD(cacheUSD));
    setText(
      'cat-cache-tok',
      cacheWriteTok > 0
        ? tr(`${fmtTokens(cacheTok)} tok · 写 ${fmtTokens(cacheWriteTok, 1)}`, `${fmtTokens(cacheTok)} tok · W ${fmtTokens(cacheWriteTok, 1)}`)
        : `${fmtTokens(cacheTok)} tok`
    );
    const catCacheSavedEl = $('cat-cache-saved');
    if (catCacheSavedEl) {
      const catSav = fmtCacheSavings(cacheSavedUSD);
      if (catSav) {
        catCacheSavedEl.classList.remove('hidden', 'good-text', 'warn-text');
        catCacheSavedEl.classList.add(catSav.cls === 'ok' ? 'good-text' : 'warn-text');
        setText(catCacheSavedEl, catSav.savedText);
        const absUSD = Math.abs(cacheSavedUSD);
        setElTooltip(
          catCacheSavedEl,
          catSav.cls === 'ok'
            ? tr(`较原价输入预计净节省 ${fmtUSD(absUSD)}（约 ${fmtCNY(absUSD)}）`, `Net estimated savings vs. uncached input: ${fmtUSD(absUSD)} (~${fmtCNY(absUSD)})`)
            : tr(`缓存写入溢价高于读取节省，较原价输入净增加 ${fmtUSD(absUSD)}（约 ${fmtCNY(absUSD)}）`, `Cache write surcharge exceeded read savings by ${fmtUSD(absUSD)} (~${fmtCNY(absUSD)})`)
        );
      } else {
        catCacheSavedEl.classList.remove('warn-text');
        catCacheSavedEl.classList.add('good-text', 'hidden');
        setText(catCacheSavedEl, '');
        setElTooltip(catCacheSavedEl, '');
      }
    }
    setText('cat-out-cost', fmtUSD(outUSD));
    setText('cat-out-tok', `${fmtTokens(outTok)} tok`);

    // Model Leaderboard
    const board = $('model-leaderboard');
    if (board) {
      const models = ident.byModel || [];
      if (!models.length) {
        board.innerHTML = `<div class="kv-row"><span class="muted">${escZh(tr('当前统计范围内暂无模型请求记录', 'No model requests in selected scope'))}</span></div>`;
      } else {
        const maxModelTok = Math.max(...models.map((m) => m.tokens || 0), 1);
        board.innerHTML = models.map((m) => {
          const wPct = Math.max(2, ((m.tokens || 0) / maxModelTok) * 100).toFixed(1);
          const costLabel = m.unpriced
            ? (m.missingModel
                ? tr('未记模型（混合模式下按基准折算）', 'Model unrecorded (baseline est. in Hybrid)')
                : tr('未收录单价（混合模式下按基准折算）', 'Unlisted price (baseline est. in Hybrid)'))
            : `${fmtUSD(m.costUSD)}（${fmtCNY(m.costUSD)}）`;
          const mSav = fmtCacheSavings(m.cacheSavingsUSD);
          const mCw = Number(m.cacheWriteTokens || 0);
          const mSavSpan = mSav
            ? ` · <span class="${mSav.cls === 'ok' ? 'good-text' : 'warn-text'}">${escZh(mSav.text)}</span>`
            : '';
          const mCwPart = mCw > 0 ? tr(` / 写 ${fmtTokens(mCw, 1)}`, ` / W ${fmtTokens(mCw, 1)}`) : '';
          return (
            `<div class="model-row">` +
            `<div class="model-row-top">` +
            `<span class="model-name">${escZh(m.displayName)}</span>` +
            `<span class="num-strong">${escZh(costLabel)}</span>` +
            `</div>` +
            `<div class="thin-track"><div class="thin-fill accent is-gpu" style="--cv-ratio:${(Number(wPct) / 100).toFixed(4)};width:${wPct}%"></div></div>` +
            `<div class="model-row-sub">` +
            `<span>${escZh(en ? `${fmtInt(m.requests)} reqs · Total ${fmtTokens(m.tokens)}` : `${fmtInt(m.requests)} 次请求 · 总计 ${fmtTokens(m.tokens)}`)}${mSavSpan}</span>` +
            `<span class="num">${escZh(en ? `In ${fmtTokens(m.inputTokens, 1)} / C ${fmtTokens(m.cacheTokens, 1)}${mCwPart} / Out ${fmtTokens(m.outputTokens, 1)}` : `入 ${fmtTokens(m.inputTokens, 1)} / 缓 ${fmtTokens(m.cacheTokens, 1)}${mCwPart} / 出 ${fmtTokens(m.outputTokens, 1)}`)}</span>` +
            `</div>` +
            `</div>`
          );
        }).join('');
      }
    }

    // Project / Workspace Leaderboard (Default Top 5, switchable to Top 10)
    const projWrap = $('project-leaderboard-wrap');
    const projBoard = $('project-leaderboard');
    if (projWrap && projBoard) {
      const projLimit = state.projectLimit === 10 ? 10 : 5;
      const allProjects = Array.isArray(srcAnalytics.byProject)
        ? srcAnalytics.byProject.filter(Boolean).slice(0, 10)
        : [];
      const projects = allProjects.slice(0, projLimit);
      const projSeg = $('proj-limit-seg');
      if (projSeg && typeof projSeg.querySelectorAll === 'function') {
        projSeg.querySelectorAll('.seg-btn').forEach((btn) => {
          btn.classList.toggle('active', Number(btn.dataset.projLimit) === projLimit);
        });
      }
      if (!projects.length) {
        projWrap.classList.add('hidden');
        projBoard.innerHTML = '';
      } else {
        projWrap.classList.remove('hidden');
        if (projSeg && typeof syncSegIndicator === 'function') syncSegIndicator(projSeg, { animate: false });
        const maxProjTok = Math.max(...projects.map((p) => Number(p.tokens || 0)), 1);
        projBoard.innerHTML = projects.map((p) => {
          const tok = Number(p.tokens || 0);
          const costUSD = Number(p.costUSD || 0);
          const pSav = fmtCacheSavings(p.cacheSavingsUSD);
          const pCw = Number(p.cacheWriteTokens || 0);
          const pCwPart = pCw > 0 ? tr(` / 写入 ${fmtTokens(pCw, 1)}`, ` / Write ${fmtTokens(pCw, 1)}`) : '';
          const wPct = Math.max(2, (tok / maxProjTok) * 100).toFixed(1);
          const tip = en
            ? `In ${fmtTokens(p.inputTokens || 0, 1)} / Cache ${fmtTokens(p.cacheTokens || 0, 1)}${pCwPart} / Out ${fmtTokens(p.outputTokens || 0, 1)}${pSav ? ` · ${pSav.text}` : ''}`
            : `输入 ${fmtTokens(p.inputTokens || 0, 1)} / 缓存 ${fmtTokens(p.cacheTokens || 0, 1)}${pCwPart} / 输出 ${fmtTokens(p.outputTokens || 0, 1)}${pSav ? ` · ${pSav.text}` : ''}`;
          const rightSub = pSav
            ? `<span class="num ${pSav.cls === 'ok' ? 'good-text' : 'warn-text'}">${escZh(pSav.text)}</span>`
            : `<span class="num">${escZh(en ? `In ${fmtTokens(p.inputTokens || 0, 1)} / C ${fmtTokens(p.cacheTokens || 0, 1)} / Out ${fmtTokens(p.outputTokens || 0, 1)}` : `入 ${fmtTokens(p.inputTokens || 0, 1)} / 缓 ${fmtTokens(p.cacheTokens || 0, 1)} / 出 ${fmtTokens(p.outputTokens || 0, 1)}`)}</span>`;
          return (
            `<div class="model-row" title="${escZh(tip)}">` +
            `<div class="model-row-top">` +
            `<span class="model-name">${esc(displayProjName(p.name || UNCATEGORIZED_PROJECT))}</span>` +
            `<span class="num-strong">${escZh(`${fmtUSD(costUSD)}（${fmtCNY(costUSD)}）`)}</span>` +
            `</div>` +
            `<div class="thin-track"><div class="thin-fill accent is-gpu" style="--cv-ratio:${(Number(wPct) / 100).toFixed(4)};width:${wPct}%"></div></div>` +
            `<div class="model-row-sub">` +
            `<span>${escZh(en ? `${fmtInt(p.conversations || 0)} sessions · ${fmtInt(p.requests || 0)} reqs · Total ${fmtTokens(tok)}` : `${fmtInt(p.conversations || 0)} 会话 · ${fmtInt(p.requests || 0)} 次请求 · 总计 ${fmtTokens(tok)}`)}</span>` +
            rightSub +
            `</div>` +
            `</div>`
          );
        }).join('');
      }
    }
  }

  // -------------------------------------------------------------------------
  // Event Wiring & Lifecycle
  // -------------------------------------------------------------------------

  function switchTab(tabName) {
    state.activeTab = tabName;
    document.querySelectorAll('.main-tab').forEach((btn) => {
      const active = btn.dataset.tab === tabName;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `panel-${tabName}`);
    });
    syncSegIndicator(document.querySelector?.('.main-tabs'), { animate: true });
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        syncAllSegIndicators({ animate: false });
        if (tabName === 'history' && typeof flushPendingChartStageScroll === 'function') {
          flushPendingChartStageScroll();
          requestAnimationFrame(() => flushPendingChartStageScroll());
        }
      });
    } else if (tabName === 'history' && typeof flushPendingChartStageScroll === 'function') {
      flushPendingChartStageScroll();
    }
  }

  function syncSegIndicator(groupEl, { animate = true } = {}) {
    if (!groupEl || typeof document === 'undefined' || typeof document.createElement !== 'function') return;
    if (typeof groupEl.querySelector !== 'function' || typeof groupEl.querySelectorAll !== 'function') return;
    const isMain = groupEl.classList?.contains('main-tabs');
    const btns = [...groupEl.querySelectorAll(isMain ? '.main-tab' : '.seg-btn')];
    if (btns.length < 2) return;
    const activeBtn = btns.find((b) => b.classList?.contains('active'));
    const firstTop = btns[0]?.offsetTop;
    const isSingleRow = btns.every((b) => b.offsetTop === firstTop && b.offsetWidth > 0);
    if (!activeBtn || !isSingleRow || !(activeBtn.offsetWidth > 0)) {
      if (groupEl.dataset) delete groupEl.dataset.hasIndicator;
      const existing = groupEl.querySelector(':scope > .seg-indicator');
      if (existing?.style) existing.style.opacity = '0';
      return;
    }

    let ind = groupEl.querySelector(':scope > .seg-indicator');
    const isNew = !ind;
    if (!ind) {
      ind = document.createElement('span');
      ind.className = 'seg-indicator no-anim';
      ind.setAttribute?.('aria-hidden', 'true');
      groupEl.insertBefore ? groupEl.insertBefore(ind, groupEl.firstChild) : groupEl.appendChild(ind);
    }
    if (groupEl.dataset) groupEl.dataset.hasIndicator = '1';
    const noAnim = isNew || !animate || prefersReducedMotion();
    if (noAnim) ind.classList?.add('no-anim');
    else ind.classList?.remove('no-anim');

    ind.style.width = `${activeBtn.offsetWidth}px`;
    ind.style.transform = `translate3d(${activeBtn.offsetLeft}px, 0, 0)`;
    ind.style.opacity = '1';

    if (noAnim && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        ind.classList?.remove('no-anim');
      });
    }
  }

  function syncAllSegIndicators({ animate = false } = {}) {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    document.querySelectorAll('.main-tabs, .seg-group').forEach((grp) => {
      syncSegIndicator(grp, { animate });
    });
  }

  function withButtonPending(btn, fn) {
    if (!btn) return Promise.resolve().then(fn);
    if (btn.disabled || btn.classList?.contains('is-pending')) return Promise.resolve();
    const prevDisabled = Boolean(btn.disabled);
    btn.disabled = true;
    btn.classList?.add('is-pending');
    btn.setAttribute?.('aria-busy', 'true');
    return Promise.resolve()
      .then(fn)
      .finally(() => {
        btn.disabled = prevDisabled;
        btn.classList?.remove('is-pending');
        btn.removeAttribute?.('aria-busy');
      });
  }

  // -------------------------------------------------------------------------
  // Telemetry Capsule Popover & Responsive Compact Mode
  // -------------------------------------------------------------------------

  const CAP_BTN_IDS = {
    context: 'cap-context',
    speed: 'cap-speed',
    tokens: 'cap-tokens'
  };

  function syncCompactMode() {
    if (typeof document === 'undefined' || !document.body?.classList) return;
    const w = typeof window !== 'undefined' && typeof window.innerWidth === 'number'
      ? window.innerWidth
      : 999;
    if (isHostSidebarContext()) {
      document.body.classList.add('cv-compact');
      return;
    }
    const isCurrentlyCompact = document.body.classList.contains('cv-compact');
    if (isCurrentlyCompact) {
      if (w >= 415) document.body.classList.remove('cv-compact');
    } else if (w > 0 && w <= 385) {
      document.body.classList.add('cv-compact');
    }
  }

  function buildCapPopRows(rows) {
    return `<dl class="cap-pop-kv">${rows.map((r) => {
      const toneCls = r.tone ? ` ${esc(r.tone)}-text` : '';
      const swatch = r.color ? `<i class="cap-pop-swatch" style="background:${esc(r.color)}"></i>` : '';
      return (
        `<div class="cap-pop-row${r.sub ? ' is-sub' : ''}">` +
        `<dt class="cap-pop-dt">${swatch}<span class="cap-pop-dt-lbl">${escZh(r.label)}</span></dt>` +
        `<dd class="cap-pop-dd num${toneCls}">${escZh(r.value)}</dd>` +
        `</div>`
      );
    }).join('')}</dl>`;
  }

  function renderCapPopover(key, force = false) {
    const pop = $('cap-popover');
    if (!pop || !key) return;
    const snap = state.contextData || {};
    const ctx = snap.context || {};
    const spd = snap.speed || null;
    const audit = snap.audit || {};
    const hist = state.historyData || null;
    const pinned = Boolean(state.capPopover.pinned);
    const en = isEn();

    let title = '';
    let sub = '';
    let badgeText = '';
    let badgeTone = '';
    let bodyHtml = '';
    let footHtml = '';
    let noteHtml = '';
    const jumpTab = key === 'tokens' ? 'history' : 'context';
    const jumpLabel = key === 'tokens'
      ? tr('用量趋势 →', 'Trends →')
      : (key === 'speed' ? tr('速度详情 →', 'Speed Details →') : tr('会话详情 →', 'Session Details →'));
    const jumpTargetId = key === 'speed' ? 'speed-card' : '';

    if (key === 'context') {
      title = tr('上下文透视', 'Context Lens');
      const win = computeEffectiveWindow(ctx);
      const pctStr = win.pct !== null ? `${win.pct.toFixed(1)}%` : '--%';
      badgeText = pctStr;
      badgeTone = win.pct !== null ? (win.pct >= 90 ? 'danger' : win.pct >= 75 ? 'warn' : '') : '';
      sub = win.used !== null
        ? (win.budget ? `~${fmtCompactZh(win.used)} / ${fmtCompactZh(win.budget)}` : `~${fmtCompactZh(win.used)} tok`)
        : tr('等待首轮模型同步', 'Awaiting first turn');

      const { items } = resolveContextCategories(ctx, audit);
      if (win.used !== null && items.length > 0) {
        const denom = Math.max(win.budget || 0, win.used || 0, 1);
        const segsHtml = items.map((it) => {
          const wPct = Math.max(0.5, (it.tokens / denom) * 100).toFixed(2);
          return `<div class="cap-pop-seg" style="width:${wPct}%;background:${esc(it.color)}" title="${escZh(`${it.label}: ${fmtIntZh(it.tokens)} tok`)}"></div>`;
        }).join('');
        bodyHtml += `<div class="cap-pop-bar-wrap"><div class="cap-pop-bar">${segsHtml}</div></div>`;
        bodyHtml += buildCapPopRows(items.map((it) => ({
          label: it.label,
          color: it.color,
          value: `${fmtIntZh(it.tokens)} tok (${it.percent.toFixed(1)}%)`
        })));
      } else if (win.used !== null) {
        bodyHtml += buildCapPopRows([
          { label: tr('最近模型输入', 'Latest input'), value: `${fmtIntZh(win.used)} tok` }
        ]);
      } else {
        bodyHtml += buildCapPopRows([
          { label: tr('状态', 'Status'), value: tr('暂无已完成模型轮次', 'No completed turns yet') }
        ]);
      }

      const footParts = [];
      if (ctx.pendingTokens > 0) footParts.push(en ? `+Pending ~${fmtIntZh(ctx.pendingTokens)} tok` : `+待发 ~${fmtIntZh(ctx.pendingTokens)} tok`);
      if (ctx.quota) {
        const q = extractQuotaParts(ctx.quota);
        if (q.p5 !== null && q.pW !== null) footParts.push(en ? `Quota 5h ${q.p5.toFixed(0)}% · Week ${q.pW.toFixed(0)}%` : `配额 5h ${q.p5.toFixed(0)}% · 周 ${q.pW.toFixed(0)}%`);
        else if (q.p5 !== null) footParts.push(en ? `5h Quota ${q.p5.toFixed(0)}%` : `5h 配额 ${q.p5.toFixed(0)}%`);
        else if (q.pBase !== null) footParts.push(en ? `Base Quota ${q.pBase.toFixed(0)}%` : `基础配额 ${q.pBase.toFixed(0)}%`);
      }
      if (footParts.length) {
        footHtml = `<div class="cap-pop-foot">${escZh(footParts.join(' · '))}</div>`;
      }
      const stTiming = ctx.sessionTiming;
      if (stTiming?.sqliteStale || stTiming?.sqlitePartial) {
        noteHtml = `<p class="cap-pop-note">${escZh(
          stTiming.sqliteStale
            ? tr('SQLite 本地遥测同步中，分类与耗时可能略滞后。', 'Local SQLite telemetry is syncing; breakdown and timing may lag slightly.')
            : tr('部分 SQLite 历史记录未解析，明细可能不完整。', 'Some SQLite history records failed to parse; breakdown may be incomplete.')
        )}</p>`;
      }
    } else if (key === 'speed') {
      title = tr('效率与耗时拆分', 'Speed & Time Split');
      const t = ctx.sessionTiming;
      const tps = spd?.tps ?? spd?.streamingTps ?? null;
      badgeText = tps !== null ? `${tps} tok/s` : '-- tok/s';
      badgeTone = tps !== null ? (tps >= 65 ? 'good' : tps >= 28 ? '' : 'warn') : '';
      sub = spd?.avgTps != null
        ? (en ? `Avg ${spd.avgTps} · Peak ${spd.peakTps ?? spd.avgTps} tok/s` : `均值 ${spd.avgTps} · 峰值 ${spd.peakTps ?? spd.avgTps} tok/s`)
        : tr('实时响应遥测', 'Live response telemetry');

      const rounds = t?.rounds ?? audit.turnsCount ?? 0;
      const steps = t?.steps ?? audit.totalSteps ?? 0;
      const calls = t?.calls ?? audit.turnsCount ?? 0;
      const rows = [
        {
          label: tr('轮次 / 步数 / 调用', 'Turns / Steps / Calls'),
          value: en
            ? `${fmtInt(rounds)} turns · ${fmtInt(steps)} steps · ${fmtInt(calls)} calls`
            : `${fmtIntZh(rounds)} 轮 · ${fmtIntZh(steps)} 步 · ${fmtIntZh(calls)} 次`
        }
      ];

      const modelSec = Number(t?.modelTimeSec || 0);
      const toolSec = Number(t?.toolTimeSec || 0);
      let splitHtml = '';
      if (t && (modelSec > 0 || toolSec > 0)) {
        const sumActive = Math.max(0.001, modelSec + toolSec);
        const rawMPct = typeof t.modelSharePercent === 'number' && Number.isFinite(t.modelSharePercent)
          ? t.modelSharePercent
          : (modelSec / sumActive) * 100;
        const mPct = Math.max(0, Math.min(100, Math.round(rawMPct)));
        const tlPct = toolSec > 0 ? Math.max(0, 100 - mPct) : 0;
        splitHtml =
          `<div class="cap-pop-split">` +
          `<div class="cap-pop-split-bar">` +
          `<div class="time-split-seg time-split-model" style="width:${Math.max(2, mPct)}%"></div>` +
          (toolSec > 0 ? `<div class="time-split-seg time-split-tool" style="width:${Math.max(2, tlPct)}%"></div>` : '') +
          `</div>` +
          `<div class="cap-pop-split-labels">` +
          `<span>${escZh(`${tr('模型', 'Model')} ${fmtSec(modelSec)}${toolSec > 0 ? ` (${mPct}%)` : ''}`)}</span>` +
          (toolSec > 0 ? `<span>${escZh(`${tr('工具', 'Tools')} ${fmtSec(toolSec)} (${tlPct}%)`)}</span>` : '') +
          `</div></div>`;
      }

      const avgTtft = typeof t?.avgTtftSec === 'number' && t.avgTtftSec > 0
        ? fmtSec(t.avgTtftSec)
        : (spd?.ttft != null ? fmtSec(spd.ttft) : '--');
      rows.push({ label: tr('会话均值 TTFT', 'Avg Session TTFT'), value: avgTtft });
      rows.push({
        label: tr('本次思考 / 正文输出', 'Last Think / Reply'),
        value: spd ? `${fmtIntZh(spd.thinkingTokens || 0)} / ${fmtIntZh(spd.responseTokens || 0)} tok` : '--'
      });

      bodyHtml = buildCapPopRows(rows.slice(0, 1)) + splitHtml + buildCapPopRows(rows.slice(1));
    } else {
      title = tr('Token 与缓存经济学', 'Token & Cache Economics');
      const st = ctx.sessionTotals || {};
      const srcSummary = hist?.analyticsBySource?.[state.sourceFilter]?.summary
        || hist?.analyticsBySource?.all?.summary;
      badgeText = Number(st.totalTokens || 0) > 0 ? `${fmtCompactZh(st.totalTokens)} tok` : '--';
      sub = srcSummary
        ? (en ? `All-time ${fmtCompactZh(srcSummary.grandTotalTokens)} tok` : `本机累计 ${fmtCompactZh(srcSummary.grandTotalTokens)} tok`)
        : tr('当前会话吞吐', 'Session throughput');

      const sessCachePct = typeof st.cacheHitPercent === 'number' && Number.isFinite(st.cacheHitPercent)
        ? st.cacheHitPercent
        : null;
      const cacheTone = sessCachePct !== null
        ? (sessCachePct >= 70 ? 'good' : sessCachePct < 30 ? 'warn' : '')
        : '';

      const rows = [
        { label: tr('会话缓存命中率', 'Session Cache Hit'), value: sessCachePct !== null ? `${sessCachePct.toFixed(1)}%` : '--', tone: cacheTone },
        { label: tr('缓存读取', 'Cache Read'), value: `${fmtIntZh(st.cacheTokens || 0)} tok` }
      ];
      const stCw = Number(st.cacheWriteTokens ?? st.cacheWrittenTokens ?? 0);
      if (stCw > 0) {
        rows.push({ label: tr('缓存写入', 'Cache Write'), value: `${fmtIntZh(stCw)} tok` });
      }
      rows.push({ label: tr('未缓存输入', 'Uncached Input'), value: `${fmtIntZh(st.inputTokens || 0)} tok` });
      rows.push({ label: tr('模型输出', 'Model Output'), value: `${fmtIntZh(st.outputTokens || 0)} tok` });
      if (Number(st.thinkingTokens || 0) > 0) {
        rows.push({ label: tr('↳ 其中思考', '↳ Thinking'), value: `${fmtIntZh(st.thinkingTokens)} tok`, sub: true });
      }
      if (Number(st.retryTokens || 0) > 0 || Number(st.retryCalls || 0) > 0) {
        const retryVal = Number(st.retryCalls || 0) > 0
          ? (en ? `${fmtInt(st.retryTokens || 0)} tok (${fmtInt(st.retryCalls)}x)` : `${fmtIntZh(st.retryTokens || 0)} tok (${fmtIntZh(st.retryCalls)} 次)`)
          : `${fmtIntZh(st.retryTokens || 0)} tok`;
        rows.push({ label: tr('重试消耗', 'Retry Waste'), value: retryVal, tone: 'warn' });
      }
      const savedUSD = Number(ctx.sessionCacheSavingsUSD);
      const popSav = fmtCacheSavings(savedUSD);
      rows.push({
        label: popSav?.cls === 'warn'
          ? tr('本会话缓存净增', 'Session Cache +Cost')
          : tr('本会话缓存净省', 'Session Cache Saved'),
        value: popSav
          ? `${fmtUSD(Math.abs(savedUSD))} (${fmtCNY(Math.abs(savedUSD))})`
          : '--',
        tone: popSav ? (popSav.cls === 'ok' ? 'good' : 'warn') : ''
      });
      bodyHtml = buildCapPopRows(rows);
    }

    const sig = `${en ? 'en' : 'zh'}|${key}|${pinned ? 1 : 0}|${badgeText}|${sub}|${bodyHtml}|${footHtml}|${noteHtml}`;
    if (!force && sig === state.capPopover.lastSig) return;
    state.capPopover.lastSig = sig;

    const badgeCls = badgeTone ? ` ${esc(badgeTone)}-text` : '';
    const swapCls = force && state.capPopover.open && !prefersReducedMotion() ? ' is-swapping' : '';
    const pinLabelHtml = pinned
      ? `<span class="cap-pin-short">${escZh(tr('已钉住', 'Pinned'))}</span><span class="cap-pin-detail">${escZh(tr(' · 再次点击取消', ' · Click to unpin'))}</span>`
      : escZh(tr('钉住', 'Pin'));
    pop.setAttribute('aria-label', title);
    pop.innerHTML =
      `<div class="cap-pop-content${swapCls}">` +
      `<div class="cap-pop-head">` +
      `<div class="cap-pop-title-group">` +
      `<div class="cap-pop-title"><span>${escZh(title)}</span>` +
      (badgeText ? `<span class="cap-pop-metric-badge num${badgeCls}">${escZh(badgeText)}</span>` : '') +
      `</div>` +
      `<div class="cap-pop-sub num">${escZh(sub)}</div>` +
      `</div>` +
      `<div class="cap-pop-head-right">` +
      `<button type="button" class="cap-pop-act-btn${pinned ? ' is-pinned' : ''}" data-cap-pin="1" title="${escZh(pinned ? tr('再次点击取消钉住', 'Click again to unpin') : tr('钉住浮层便于细看', 'Pin popover open'))}">${pinLabelHtml}</button>` +
      `<button type="button" class="cap-pop-act-btn" data-cap-jump="${esc(jumpTab)}" data-cap-scroll="${esc(jumpTargetId)}">${escZh(jumpLabel)}</button>` +
      `</div>` +
      `</div>` +
      bodyHtml +
      footHtml +
      noteHtml +
      `</div>`;
  }

  function positionCapPopover() {
    const pop = $('cap-popover');
    const key = state.capPopover.activeKey;
    const btn = key ? $(CAP_BTN_IDS[key]) : null;
    if (!pop || !btn || !state.capPopover.open) return;
    if (typeof btn.getBoundingClientRect !== 'function' || typeof window === 'undefined' || typeof window.innerWidth !== 'number') {
      return;
    }
    const btnRect = btn.getBoundingClientRect();
    const popW = pop.offsetWidth || 292;
    const popH = pop.offsetHeight || 220;
    const vw = window.innerWidth;
    const vh = window.innerHeight || 600;
    const left = Math.round(Math.max(8, Math.min(btnRect.left, vw - popW - 8)));
    let top = btnRect.bottom + 8;
    if (top + popH > vh - 8 && btnRect.top >= popH + 12) {
      top = btnRect.top - popH - 8;
    }
    top = Math.round(Math.max(8, Math.min(top, vh - popH - 8)));
    if (typeof pop.style?.setProperty === 'function') {
      pop.style.setProperty('--cv-pop-x', `${left}px`);
      pop.style.setProperty('--cv-pop-y', `${top}px`);
    } else if (pop.style) {
      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
    }
  }

  function openCapPopover(key, { pin = false } = {}) {
    const pop = $('cap-popover');
    const btnId = CAP_BTN_IDS[key];
    const btn = btnId ? $(btnId) : null;
    if (!pop || !btn) return;

    if (state.capPopover.closeTimer) {
      clearTimeout(state.capPopover.closeTimer);
      state.capPopover.closeTimer = null;
    }
    if (state.capPopover.hideTimer) {
      clearTimeout(state.capPopover.hideTimer);
      state.capPopover.hideTimer = null;
    }
    if (pin) state.capPopover.pinned = true;

    const wasOpen = Boolean(state.capPopover.open);
    const prevKey = state.capPopover.activeKey;
    if (prevKey && prevKey !== key) {
      $(CAP_BTN_IDS[prevKey])?.setAttribute('aria-expanded', 'false');
    }
    state.capPopover.open = true;
    state.capPopover.activeKey = key;
    btn.setAttribute('aria-expanded', 'true');

    renderCapPopover(key, true);
    pop.classList.remove('hidden');
    pop.setAttribute?.('aria-hidden', 'false');
    if ('inert' in pop) pop.inert = false;
    if (typeof pop.showPopover === 'function' && typeof pop.matches === 'function' && !pop.matches(':popover-open')) {
      try {
        if (!pop.hasAttribute('popover')) pop.setAttribute('popover', 'manual');
        pop.showPopover();
      } catch {}
    }
    positionCapPopover();
    if (wasOpen) {
      pop.classList.add('is-open');
    } else if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (state.capPopover.open) {
          positionCapPopover();
          pop.classList.add('is-open');
        }
      });
    } else {
      pop.classList.add('is-open');
    }
  }

  function closeCapPopover() {
    if (state.capPopover.closeTimer) {
      clearTimeout(state.capPopover.closeTimer);
      state.capPopover.closeTimer = null;
    }
    if (state.capPopover.hideTimer) {
      clearTimeout(state.capPopover.hideTimer);
      state.capPopover.hideTimer = null;
    }
    const prevKey = state.capPopover.activeKey;
    if (prevKey && CAP_BTN_IDS[prevKey]) {
      $(CAP_BTN_IDS[prevKey])?.setAttribute('aria-expanded', 'false');
    }
    state.capPopover.open = false;
    state.capPopover.pinned = false;
    state.capPopover.activeKey = '';
    state.capPopover.lastSig = '';

    const pop = $('cap-popover');
    if (pop) {
      pop.classList.remove('is-open');
      pop.classList.add('hidden');
      pop.setAttribute?.('aria-hidden', 'true');
      if ('inert' in pop) pop.inert = true;
      if (typeof pop.hidePopover === 'function' && typeof pop.matches === 'function' && pop.matches(':popover-open')) {
        const delayMs = prefersReducedMotion() ? 0 : 140;
        if (delayMs === 0) {
          try { pop.hidePopover(); } catch {}
        } else {
          state.capPopover.hideTimer = setTimeout(() => {
            state.capPopover.hideTimer = null;
            if (!state.capPopover.open && pop.matches?.(':popover-open')) {
              try { pop.hidePopover(); } catch {}
            }
          }, delayMs);
        }
      }
    }
  }

  function scheduleCloseCapPopover() {
    if (state.capPopover.closeTimer) clearTimeout(state.capPopover.closeTimer);
    if (state.capPopover.pinned) return;
    state.capPopover.closeTimer = setTimeout(() => {
      closeCapPopover();
    }, 220);
  }

  function refreshOpenCapPopover() {
    if (!state.capPopover?.open || !state.capPopover.activeKey) return;
    renderCapPopover(state.capPopover.activeKey, false);
    positionCapPopover();
  }

  function wireEvents() {
    // Primary tabs & capsule telemetry popover / smart navigation
    document.querySelectorAll('.main-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        closeCapPopover();
        switchTab(btn.dataset.tab);
      });
    });

    document.querySelectorAll('[data-goto-tab]').forEach((pill) => {
      const capKey = pill.dataset.capKey || '';
      pill.addEventListener('pointerenter', () => {
        if (!capKey || state.capPopover.pinned) return;
        openCapPopover(capKey, { pin: false });
      });
      pill.addEventListener('pointerleave', () => {
        scheduleCloseCapPopover();
      });
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        const targetTab = pill.dataset.gotoTab;
        if (targetTab && targetTab !== state.activeTab) {
          closeCapPopover();
          switchTab(targetTab);
          return;
        }
        if (!capKey) {
          if (targetTab) switchTab(targetTab);
          return;
        }
        if (state.capPopover.open && state.capPopover.pinned && state.capPopover.activeKey === capKey) {
          closeCapPopover();
        } else {
          openCapPopover(capKey, { pin: true });
        }
      });
    });

    const capPopEl = $('cap-popover');
    if (capPopEl) {
      capPopEl.addEventListener('pointerenter', () => {
        if (state.capPopover.closeTimer) {
          clearTimeout(state.capPopover.closeTimer);
          state.capPopover.closeTimer = null;
        }
      });
      capPopEl.addEventListener('pointerleave', () => {
        scheduleCloseCapPopover();
      });
      capPopEl.addEventListener('click', (e) => {
        const pinBtn = e.target?.closest?.('[data-cap-pin]');
        if (pinBtn) {
          e.stopPropagation();
          state.capPopover.pinned = !state.capPopover.pinned;
          renderCapPopover(state.capPopover.activeKey, true);
          positionCapPopover();
          return;
        }
        const jumpBtn = e.target?.closest?.('[data-cap-jump]');
        if (jumpBtn) {
          e.stopPropagation();
          const tab = jumpBtn.dataset.capJump;
          const scrollId = jumpBtn.dataset.capScroll;
          closeCapPopover();
          if (tab) switchTab(tab);
          if (scrollId) {
            $(scrollId)?.scrollIntoView?.({
              behavior: prefersReducedMotion() ? 'instant' : 'smooth',
              block: 'nearest'
            });
          }
        }
      });
    }

    // Linked hover highlight between Context Spectrum Bar & Legend (preserved across polling)
    const setSegHover = (catKey) => {
      state.hoveredSpectrumCat = catKey || '';
      applySpectrumHoverState(state.hoveredSpectrumCat);
    };
    ['ctx-seg-bar', 'ctx-seg-legend'].forEach((cid) => {
      const el = $(cid);
      if (!el) return;
      el.addEventListener('pointerover', (e) => {
        const item = e.target?.closest?.('[data-cat-key]');
        if (item?.dataset?.catKey) setSegHover(item.dataset.catKey);
      });
      el.addEventListener('pointerleave', () => setSegHover(''));
      el.addEventListener('focusin', (e) => {
        const item = e.target?.closest?.('[data-cat-key]');
        if (item?.dataset?.catKey) setSegHover(item.dataset.catKey);
      });
      el.addEventListener('focusout', () => setSegHover(''));
    });

    // Preserve <details> open/close state across 1.5s polling
    $('compactions-list')?.addEventListener('toggle', (e) => {
      const det = e?.target;
      const hostItem = det?.closest?.('.compaction-item[data-detail-key]');
      const key = hostItem?.dataset?.detailKey || hostItem?.getAttribute?.('data-detail-key');
      if (!key || !(state.openDetailsKeys instanceof Set)) return;
      if (det.open) state.openDetailsKeys.add(key);
      else state.openDetailsKeys.delete(key);
    }, true);

    // Scroll shedding: add .is-scrolling during active scrolling, remove 120ms after idle
    const markScrolling = () => {
      if (typeof document === 'undefined' || !document.documentElement?.classList) return;
      document.documentElement.classList.add('is-scrolling');
      if (state.scrollIdleTimer) clearTimeout(state.scrollIdleTimer);
      state.scrollIdleTimer = setTimeout(() => {
        document.documentElement.classList.remove('is-scrolling');
        state.scrollIdleTimer = null;
      }, 120);
    };
    document.querySelector?.('.viewport')?.addEventListener?.('scroll', markScrolling, { passive: true });
    window.addEventListener?.('scroll', markScrolling, { passive: true });

    // Collapsible sections
    document.querySelectorAll('.collapse-trigger').forEach((btn) => {
      btn.addEventListener('click', () => {
        const body = $(btn.dataset.toggle);
        if (!body) return;
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', String(!expanded));
        body.classList.toggle('hidden', expanded);
      });
    });

    // Conversation selector popover, hidden native select & follow-current button
    $('conv-picker-trigger')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.convPicker.open) {
        closeConvPopover();
      } else {
        openConvPopover();
      }
    });

    const convSearchInput = $('conv-search-input');
    const convSearchClear = $('conv-search-clear');
    if (convSearchInput) {
      let searchComposing = false;
      const syncClearBtn = () => {
        if (convSearchClear) {
          convSearchClear.classList.toggle('hidden', !(convSearchInput.value || '').length);
        }
      };
      convSearchInput.addEventListener('compositionstart', () => {
        searchComposing = true;
      });
      convSearchInput.addEventListener('compositionend', () => {
        searchComposing = false;
        state.convPicker.search = convSearchInput.value || '';
        syncClearBtn();
        renderConvPopoverBody(true);
      });
      convSearchInput.addEventListener('input', () => {
        syncClearBtn();
        if (searchComposing) return;
        state.convPicker.search = convSearchInput.value || '';
        renderConvPopoverBody(true);
      });
      convSearchClear?.addEventListener('click', (e) => {
        e.stopPropagation();
        convSearchInput.value = '';
        state.convPicker.search = '';
        syncClearBtn();
        renderConvPopoverBody(true);
        try { convSearchInput.focus({ preventScroll: true }); } catch {}
      });
    }

    $('conv-project-pills')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-proj-filter]');
      if (!btn) return;
      const nextFilter = btn.dataset.projFilter || '__all__';
      if (nextFilter === state.convPicker.projectFilter) return;
      state.convPicker.projectFilter = nextFilter;
      renderConvPopoverPills(true);
      renderConvPopoverBody(true);
    });

    $('conv-pop-body')?.addEventListener('click', (e) => {
      const autoRow = e.target.closest('[data-conv-auto]');
      if (autoRow) {
        applyPinnedConversation('', { showFollowToast: true, closePopover: true });
        return;
      }
      const toggleBtn = e.target.closest('[data-proj-toggle]');
      if (toggleBtn) {
        const projName = toggleBtn.dataset.projToggle;
        if (!projName) return;
        const currentlyExpanded = toggleBtn.getAttribute('aria-expanded') === 'true';
        const prefs = { ...loadProjectCollapsePrefs(), [projName]: currentlyExpanded };
        saveProjectCollapsePrefs(prefs);
        const groupEl = typeof toggleBtn.closest === 'function' ? toggleBtn.closest('.conv-group') : null;
        if (groupEl && groupEl.classList && typeof toggleBtn.setAttribute === 'function') {
          toggleBtn.setAttribute('aria-expanded', String(!currentlyExpanded));
          groupEl.classList.toggle('is-collapsed', currentlyExpanded);
          state.convPicker.lastBodySig = '';
        } else {
          renderConvPopoverBody(true);
        }
        return;
      }
      const itemBtn = e.target.closest('[data-conv-id]');
      if (itemBtn) {
        const convId = itemBtn.dataset.convId || '';
        if (convId) {
          applyPinnedConversation(convId, { closePopover: true });
        }
      }
    });

    document.addEventListener('pointerdown', (e) => {
      if (state.convPicker.open) {
        const dropdown = $('conv-dropdown');
        if (dropdown && (!dropdown.contains || !dropdown.contains(e.target))) {
          closeConvPopover();
        }
      }
      if (state.capPopover.open) {
        const pop = $('cap-popover');
        const strip = document.querySelector?.('.capsule-strip');
        const inPop = pop && pop.contains && pop.contains(e.target);
        const inStrip = strip && strip.contains && strip.contains(e.target);
        if (!inPop && !inStrip) {
          closeCapPopover();
        }
      }
      const palDrawer = $('palette-drawer');
      if (palDrawer && !palDrawer.classList.contains('hidden')) {
        const palBtn = $('btn-palette');
        const legEl = $('heat-legend');
        const inDrawer = palDrawer.contains && palDrawer.contains(e.target);
        const inPalBtn = palBtn && palBtn.contains && palBtn.contains(e.target);
        const inLegend = legEl && legEl.contains && legEl.contains(e.target);
        if (!inDrawer && !inPalBtn && !inLegend) {
          closePaletteDrawer();
        }
      }
    });

    window.addEventListener('resize', () => {
      syncCompactMode();
      if (state.convPicker.open) positionConvPopover();
      if (state.capPopover.open) positionCapPopover();
      syncAllSegIndicators({ animate: false });
    });

    $('conv-select')?.addEventListener('change', (e) => {
      const val = e.target.value || '';
      applyPinnedConversation(val, { showFollowToast: !val, closePopover: true });
    });

    $('btn-follow-current')?.addEventListener('click', () => {
      applyPinnedConversation('', { showFollowToast: true, closePopover: true });
    });

    // When user clicks inside an Aux Pane bound to a specific host conversation, notify Menu Bar
    if (!window.__CV_FLOAT_MODE__) {
      let lastFocusSentAt = 0;
      document.addEventListener('pointerdown', () => {
        const hostId = window.sidecar?.conversationId || state.hostConvId || '';
        const now = Date.now();
        if (!hostId || state.selectedConvId || now - lastFocusSentAt < 2500) return;
        lastFocusSentAt = now;
        apiFetch('/api/entrypoints', {
          method: 'POST',
          body: { activeHostConvId: hostId }
        }).catch(() => {});
      }, { passive: true });
    }

    // Per-turn timeline view & filter buttons
    const rerenderTurns = () => {
      if (state.contextData) {
        renderTurnsTimelineCard(
          state.contextData.turns || [],
          state.contextData.audit?.turnsCount || 0,
          state.contextData.promptTurns || [],
          state.contextData.context?.latestPromptStartup || null,
          state.contextData.context?.cacheStatus || null
        );
      }
    };
    document.querySelectorAll('#turns-view-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.turnsView = btn.dataset.tview === 'prompts' ? 'prompts' : 'steps';
        document.querySelectorAll('#turns-view-seg .seg-btn').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
        syncSegIndicator($('turns-view-seg'), { animate: true });
        rerenderTurns();
        syncAllSegIndicators({ animate: false });
      });
    });
    document.querySelectorAll('#turns-filter-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.turnsFilter = btn.dataset.tfilter || 'all';
        document.querySelectorAll('#turns-filter-seg .seg-btn').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
        syncSegIndicator($('turns-filter-seg'), { animate: true });
        rerenderTurns();
      });
    });
    document.querySelectorAll('#prompt-filter-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.promptTurnsFilter = btn.dataset.pfilter === 'cold' ? 'cold' : 'all';
        document.querySelectorAll('#prompt-filter-seg .seg-btn').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
        syncSegIndicator($('prompt-filter-seg'), { animate: true });
        rerenderTurns();
      });
    });

    // Refresh & Rescan (Zero-FOUC, graceful full-rotation spin stop)
    const startRefreshSpin = (icon) => {
      if (!icon) return;
      state.refreshSpinPendingStop = false;
      if (state.refreshSpinFallbackTimer) {
        clearTimeout(state.refreshSpinFallbackTimer);
        state.refreshSpinFallbackTimer = null;
      }
      if (!prefersReducedMotion()) {
        icon.classList.add('spin');
      }
    };
    const stopRefreshSpin = (icon) => {
      if (!icon) return;
      if (prefersReducedMotion() || typeof icon.addEventListener !== 'function') {
        icon.classList.remove('spin');
        return;
      }
      if (!icon.classList.contains('spin')) return;
      state.refreshSpinPendingStop = true;
      const finish = () => {
        if (state.refreshSpinFallbackTimer) {
          clearTimeout(state.refreshSpinFallbackTimer);
          state.refreshSpinFallbackTimer = null;
        }
        if (state.refreshSpinPendingStop) {
          state.refreshSpinPendingStop = false;
          icon.classList.remove('spin');
        }
      };
      icon.addEventListener('animationiteration', finish, { once: true });
      state.refreshSpinFallbackTimer = setTimeout(finish, 750);
    };
    const triggerForceRefresh = async (ev) => {
      if (ev?.shiftKey) {
        if (window.__CV_FLOAT_MODE__ && !window.__CV_BROWSER_FALLBACK__) {
          await apiFetch('/api/reload-float-bundle', { method: 'POST' }).catch(() => {});
          return;
        }
        window.location.reload();
        return;
      }
      applyAppearanceToDom();
      const btn = $('btn-refresh');
      const icon = $('ic-refresh');
      startRefreshSpin(icon);
      btn?.setAttribute?.('aria-busy', 'true');
      try {
        await Promise.all([loadContext(true), loadHistory(true), refreshFloatStatus()]);
        showToast(tr('数据已更新', 'Data refreshed'), 1800);
      } catch (err) {
        showToast(tr(`刷新失败 · ${err.message}`, `Refresh failed · ${err.message}`));
      } finally {
        btn?.removeAttribute?.('aria-busy');
        stopRefreshSpin(icon);
      }
    };
    $('btn-copy-md')?.addEventListener('click', () => {
      copyTelemetryMarkdown().catch(() => {});
    });
    $('btn-refresh')?.addEventListener('click', triggerForceRefresh);
    $('btn-rescan-files')?.addEventListener('click', triggerForceRefresh);

    // Detached Right-Side Floating Window (`📌`)
    $('btn-float')?.addEventListener('click', async (ev) => {
      const floatBtn = $('btn-float');
      if (floatBtn?.classList?.contains('is-pending')) return;
      const en = typeof state !== 'undefined' && state?.ui?.lang === 'en';
      if (window.__CV_FLOAT_MODE__) {
        if (ev.shiftKey || window.__CV_BROWSER_FALLBACK__) {
          if (window.sidecar?.closeFloatWindow) {
            await window.sidecar.closeFloatWindow();
          } else {
            await apiFetch('/api/float-window', { method: 'POST', body: { action: 'close' } }).catch(() => {});
            try { window.close(); } catch {}
          }
          return;
        }
        const next = !state.floatPinned;
        state.floatPinned = next;
        window.sidecar?.setPinned?.(next);
        syncFloatButtonUi();
        showToast(
          en
            ? (next ? 'Pinned window always on top' : 'Unpinned (normal window; click close button to dismiss)')
            : (next ? '已重新钉在屏幕最前' : '已取消置顶（现为普通窗口，点击左上角红叉可关闭）')
        );
        return;
      }

      if (floatBtn) {
        floatBtn.disabled = true;
        floatBtn.classList?.add('is-pending');
        floatBtn.setAttribute?.('aria-busy', 'true');
      }
      try {
        const res = await apiFetch('/api/float-window', {
          method: 'POST',
          body: { action: 'toggle' }
        });
        if (!res.ok) {
          showToast(res.error || (en ? 'Floating window action failed' : '独立看板操作失败'));
          return;
        }
        state.floatRunning = Boolean(res.running);
        state.floatPinned = Boolean(res.pinned);
        syncFloatButtonUi();
        showToast(
          res.message ||
            (en
              ? (res.running ? 'Opened floating viewer on the right' : 'Closed floating viewer')
              : (res.running ? '已在屏幕右侧打开独立看板' : '已关闭右侧独立看板'))
        );
      } catch (err) {
        showToast(en ? `Floating window error: ${err.message}` : `操作独立看板失败：${err.message}`);
      } finally {
        if (floatBtn) {
          floatBtn.disabled = false;
          floatBtn.classList?.remove('is-pending');
          floatBtn.removeAttribute?.('aria-busy');
        }
      }
    });

    // CLI Launcher
    $('btn-cli')?.addEventListener('click', () => {
      withButtonPending($('btn-cli'), async () => {
        try {
          const res = await apiFetch('/api/launch-cli', {
            method: 'POST',
            body: {
              workspaceUri: state.workspaceUri || '',
              workspacePath: state.contextData?.workspacePath || ''
            }
          });
          showToast(res.ok ? res.message : (res.error || tr('唤起终端失败', 'Failed to launch terminal')));
        } catch (err) {
          showToast(tr(`唤起终端失败 · ${err.message}`, `Terminal launch failed · ${err.message}`));
        }
      });
    });

    // Palette drawer & quick theme cycle
    const drawer = $('palette-drawer');
    const openPaletteDrawer = () => {
      if (!drawer) return;
      drawer.classList.remove('hidden');
      drawer.setAttribute?.('aria-hidden', 'false');
      if ('inert' in drawer) drawer.inert = false;
      $('btn-palette')?.setAttribute('aria-expanded', 'true');
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => syncAllSegIndicators({ animate: false }));
      }
    };
    const closePaletteDrawer = ({ restoreFocus = false } = {}) => {
      if (state.recordingShortcut || state.recordingAuxShortcut) stopAllShortcutRecording();
      if (drawer) {
        drawer.classList.add('hidden');
        drawer.setAttribute?.('aria-hidden', 'true');
        if ('inert' in drawer) drawer.inert = true;
      }
      const palBtn = $('btn-palette');
      palBtn?.setAttribute('aria-expanded', 'false');
      if (restoreFocus && palBtn) {
        try { palBtn.focus({ preventScroll: true }); } catch {}
      }
    };
    $('btn-palette')?.addEventListener('click', (ev) => {
      ev.stopPropagation?.();
      if (!drawer) return;
      if (drawer.classList.contains('hidden')) openPaletteDrawer();
      else closePaletteDrawer();
    });
    $('btn-close-palette')?.addEventListener('click', () => {
      closePaletteDrawer({ restoreFocus: true });
    });

    // Persistent Top Menu Bar (`◈` / `⚡` / `⏳`) & Right Floating Window switches
    document.querySelectorAll('#menubar-entry-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const wantOn = btn.dataset.menubarEntry === 'on';
        withButtonPending(btn, async () => {
          try {
            const res = await apiFetch('/api/entrypoints', {
              method: 'POST',
              body: { menubarEnabled: wantOn }
            });
            if (!res.ok) {
              showToast(res.error || tr('切换顶部菜单栏常驻图标失败', 'Failed to toggle menu bar icon'));
              return;
            }
            state.menubarEnabled = Boolean(res.menubarEnabled);
            if (res.menubarMode) state.menubarMode = res.menubarMode;
            syncFloatButtonUi();
            syncSegIndicator($('menubar-entry-seg'), { animate: true });
            showToast(
              res.message ||
                (state.menubarEnabled
                  ? tr('已开启顶部菜单栏常驻图标', 'Menu bar icon enabled')
                  : tr('已关闭顶部菜单栏常驻图标', 'Menu bar icon disabled'))
            );
          } catch (err) {
            showToast(tr(`切换失败 · ${err.message}`, `Toggle failed · ${err.message}`));
          }
        });
      });
    });

    document.querySelectorAll('#menubar-mode-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextMode = btn.dataset.menubarMode || 'context';
        withButtonPending(btn, async () => {
          try {
            const res = await apiFetch('/api/entrypoints', {
              method: 'POST',
              body: { menubarMode: nextMode }
            });
            if (!res.ok) {
              showToast(res.error || tr('切换菜单栏显示内容失败', 'Failed to update menu bar mode'));
              return;
            }
            state.menubarMode = res.menubarMode || nextMode;
            if (typeof res.menubarEnabled === 'boolean') {
              state.menubarEnabled = res.menubarEnabled;
            }
            syncFloatButtonUi();
            syncSegIndicator($('menubar-mode-seg'), { animate: true });
            showToast(res.message || tr('已更新顶部菜单栏显示内容', 'Menu bar display updated'));
          } catch (err) {
            showToast(tr(`切换失败 · ${err.message}`, `Toggle failed · ${err.message}`));
          }
        });
      });
    });

    $('btn-drawer-float')?.addEventListener('click', () => {
      $('btn-float')?.click();
    });

    // Customizable Keyboard Shortcut Recorder & Scope Controls
    $('btn-record-shortcut')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (state.recordingShortcut) {
        stopShortcutRecording();
      } else {
        startShortcutRecording();
      }
    });

    $('btn-toggle-shortcut')?.addEventListener('click', () => {
      if (state.recordingShortcut || state.recordingAuxShortcut) stopAllShortcutRecording();
      withButtonPending($('btn-toggle-shortcut'), () => applyShortcutPatch({ enabled: !Boolean(state.shortcut?.enabled) }));
    });

    $('btn-reset-shortcut')?.addEventListener('click', () => {
      if (state.recordingShortcut || state.recordingAuxShortcut) stopAllShortcutRecording();
      withButtonPending($('btn-reset-shortcut'), () => applyShortcutPatch({ reset: true }));
    });

    $('btn-record-aux-shortcut')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (state.recordingAuxShortcut) {
        stopAuxShortcutRecording();
      } else {
        startAuxShortcutRecording();
      }
    });

    $('btn-toggle-aux-shortcut')?.addEventListener('click', () => {
      if (state.recordingShortcut || state.recordingAuxShortcut) stopAllShortcutRecording();
      withButtonPending($('btn-toggle-aux-shortcut'), () => applyAuxShortcutPatch({ enabled: !Boolean(state.auxShortcut?.enabled) }));
    });

    $('btn-reset-aux-shortcut')?.addEventListener('click', () => {
      if (state.recordingShortcut || state.recordingAuxShortcut) stopAllShortcutRecording();
      withButtonPending($('btn-reset-aux-shortcut'), () => applyAuxShortcutPatch({ reset: true }));
    });

    document.querySelectorAll('#shortcut-scope-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (state.recordingShortcut || state.recordingAuxShortcut) stopAllShortcutRecording();
        const nextScope = btn.dataset.shortcutScope || 'app';
        withButtonPending(btn, async () => {
          await applyShortcutPatch({ scope: nextScope });
          syncSegIndicator($('shortcut-scope-seg'), { animate: true });
        });
      });
    });

    document.addEventListener('pointerdown', (ev) => {
      if (!state.recordingShortcut && !state.recordingAuxShortcut) return;
      const recBtn = $('btn-record-shortcut');
      const auxBtn = $('btn-record-aux-shortcut');
      if ((!recBtn || !recBtn.contains(ev.target)) && (!auxBtn || !auxBtn.contains(ev.target))) {
        stopAllShortcutRecording();
      }
    });

    const triggerWakeupRefresh = () => {
      if (document.hidden || state.hostHidden) return;
      const now = Date.now();
      if (now - state.lastWakeRefreshAt < 1500) return;
      const hiddenForMs = state.lastHiddenAt > 0 ? (now - state.lastHiddenAt) : 0;
      const inFlightTimedOut = Boolean(
        state.contextInFlight &&
        state.contextInFlightSince > 0 &&
        (now - state.contextInFlightSince > CONTEXT_INFLIGHT_STALE_MS)
      );
      if (hiddenForMs > 5000 || inFlightTimedOut) {
        state.lastWakeRefreshAt = now;
        state.lastHiddenAt = 0;
        loadContext(false).catch(() => {});
      } else if (state.lastHiddenAt > 0) {
        state.lastHiddenAt = 0;
      }
    };

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        state.lastHiddenAt = Date.now();
      } else {
        triggerWakeupRefresh();
      }
    });

    window.addEventListener('blur', () => {
      if (state.recordingShortcut || state.recordingAuxShortcut) stopAllShortcutRecording();
      if (!state.lastHiddenAt) state.lastHiddenAt = Date.now();
    });

    window.addEventListener('focus', () => {
      triggerWakeupRefresh();
    });

    window.addEventListener('keydown', (ev) => {
      if (state.recordingShortcut || state.recordingAuxShortcut) {
        const isAux = Boolean(state.recordingAuxShortcut);
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.key === 'Escape' && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
          stopAllShortcutRecording();
          showToast(tr('已取消快捷键录制', 'Cancelled shortcut recording'));
          return;
        }
        const parsed = buildAcceleratorFromKeyEvent(ev);
        if (parsed.modifierOnly) {
          const kbdEl = $(isAux ? 'aux-shortcut-kbd-label' : 'shortcut-kbd-label');
          if (kbdEl) setText(kbdEl, parsed.preview || tr('按下组合键…', 'Press keys…'));
          return;
        }
        if (!parsed.ok) {
          showToast(parsed.error || tr('组合键无效，请包含 ⌘ / ⌥ / ⌃ 修饰键（Esc 取消）', 'Invalid shortcut: include ⌘ / ⌥ / ⌃ modifier (Esc cancels)'));
          syncFloatButtonUi();
          return;
        }
        stopAllShortcutRecording();
        if (isAux) {
          applyAuxShortcutPatch({ accelerator: parsed.accelerator, enabled: true });
        } else {
          applyShortcutPatch({ accelerator: parsed.accelerator, enabled: true });
        }
        return;
      }

      if (state.convPicker.open && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp' || ev.key === 'Enter')) {
        const popBody = $('conv-pop-body');
        if (popBody && typeof popBody.querySelectorAll === 'function') {
          const items = [...popBody.querySelectorAll('.conv-auto-row, .conv-group:not(.is-collapsed) .conv-item')];
          if (items.length > 0) {
            const curIdx = items.findIndex((el) => el.classList?.contains('is-kb-focus'));
            if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
              ev.preventDefault();
              const delta = ev.key === 'ArrowDown' ? 1 : -1;
              const nextIdx = curIdx < 0
                ? (delta > 0 ? 0 : items.length - 1)
                : (curIdx + delta + items.length) % items.length;
              items.forEach((el, i) => el.classList?.toggle('is-kb-focus', i === nextIdx));
              items[nextIdx]?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
              return;
            }
            if (ev.key === 'Enter' && curIdx >= 0) {
              ev.preventDefault();
              items[curIdx]?.click?.();
              return;
            }
          }
        }
      }

      if (ev.repeat) return;
      if (ev.key === 'Escape' && !ev.metaKey && !ev.ctrlKey && !ev.altKey && drawer && !drawer.classList.contains('hidden')) {
        ev.preventDefault();
        ev.stopPropagation();
        closePaletteDrawer({ restoreFocus: true });
        return;
      }
      if (ev.key === 'Escape' && !ev.metaKey && !ev.ctrlKey && !ev.altKey && state.capPopover.open) {
        ev.preventDefault();
        ev.stopPropagation();
        closeCapPopover();
        return;
      }
      if (ev.key === 'Escape' && !ev.metaKey && !ev.ctrlKey && !ev.altKey && state.convPicker.open) {
        ev.preventDefault();
        ev.stopPropagation();
        closeConvPopover({ restoreFocus: true });
        return;
      }
      if (state.shortcut?.enabled && state.shortcut?.accelerator && eventMatchesAccelerator(ev, state.shortcut.accelerator)) {
        ev.preventDefault();
        ev.stopPropagation();
        if (window.__CV_FLOAT_MODE__) {
          if (window.sidecar?.closeFloatWindow) {
            window.sidecar.closeFloatWindow();
          } else {
            apiFetch('/api/float-window', { method: 'POST', body: { action: 'close' } }).catch(() => {});
          }
          return;
        }
        apiFetch('/api/float-window', {
          method: 'POST',
          body: { action: 'toggle' }
        }).then((res) => {
          if (!res?.ok) {
            showToast(res?.error || tr('快捷键切换看板失败', 'Hotkey toggle failed'));
            return;
          }
          state.floatRunning = Boolean(res.running);
          state.floatPinned = Boolean(res.pinned);
          syncFloatButtonUi();
          showToast(
            res.message ||
              (res.running
                ? tr('已通过快捷键打开右侧看板', 'Opened floating panel via hotkey')
                : tr('已通过快捷键收回右侧看板', 'Closed floating panel via hotkey'))
          );
        }).catch(() => {});
        return;
      }

      if (state.auxShortcut?.enabled && state.auxShortcut?.accelerator && eventMatchesAccelerator(ev, state.auxShortcut.accelerator)) {
        ev.preventDefault();
        ev.stopPropagation();
        if (window.sidecar && !window.sidecar.isFloatWindow && !window.__CV_FLOAT_MODE__) {
          postSidecarCloseKeyEvent();
        } else {
          apiFetch('/api/aux-pane-trigger', {
            method: 'POST',
            body: {
              targetPlugin: 'context-viewer',
              uri: 'sidecar://context-viewer/dashboard/',
              action: 'toggle'
            }
          }).then(() => {
            showToast(tr('已发送切换 Antigravity 右侧辅助栏「上下文看板」指令', 'Toggled Antigravity sidebar Context Viewer'));
          }).catch(() => {});
        }
      }
    }, true);

    $('btn-theme')?.addEventListener('click', () => {
      const order = ['auto', 'light', 'dark', 'oled'];
      const next = order[(order.indexOf(state.ui.themeMode) + 1) % order.length];
      state.ui.themeMode = next;
      applyAppearanceToDom({ animate: true });
      persistUiPreferences();
      const labels = isEn()
        ? { auto: 'Follow Host', light: 'Light', dark: 'Dark', oled: 'OLED Pure Black' }
        : { auto: '跟随宿主主题', light: '浅色主题', dark: '深色主题', oled: 'OLED 纯黑主题' };
      showToast(isEn() ? `Theme: ${labels[next]}` : `已切换为${labels[next]}`, 1800);
    });

    document.querySelectorAll('#theme-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.themeMode;
        if (!['auto', 'light', 'dark', 'oled'].includes(mode)) return;
        state.ui.themeMode = mode;
        applyAppearanceToDom({ animate: true });
        syncSegIndicator($('theme-seg'), { animate: true });
        persistUiPreferences();
      });
    });

    document.querySelectorAll('#glass-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.ui.glass = btn.dataset.glassMode !== 'off';
        applyAppearanceToDom({ animate: true });
        syncSegIndicator($('glass-seg'), { animate: true });
        persistUiPreferences();
      });
    });

    const refreshOnLanguageChange = () => {
      applyAppearanceToDom();
      syncFloatButtonUi();
      persistUiPreferences();
      state.convPicker.lastTriggerSig = '';
      state.convPicker.lastSelectSig = '';
      state.convPicker.lastPillsSig = '';
      state.convPicker.lastBodySig = '';
      state.capPopover.lastSig = '';
      renderConversationPicker(state.recentConversations, state.activeConvId);
      if (state.historyData) {
        populatePlanPresetsIfNeeded(state.historyData.presets);
        renderHistoryPanel(state.historyData);
        renderCostPanel(state.historyData);
      } else if (state.settingsData?.presets) {
        populatePlanPresetsIfNeeded(state.settingsData.presets);
      }
      if (state.contextData) {
        renderContextPanel(state.contextData);
      } else {
        setText('ctx-takeaway', tr('正在同步当前对话上下文指标…', 'Syncing active session context metrics…'));
        setText('sp-takeaway', tr('等待模型返回生成耗时统计…', 'Awaiting model response speed stats…'));
      }
      renderTopCapsules();
    };

    document.querySelectorAll('#lang-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextLang = btn.dataset.langMode === 'en' ? 'en' : 'zh';
        if (state.ui.lang === nextLang) return;
        state.ui.lang = nextLang;
        refreshOnLanguageChange();
      });
    });

    document.querySelectorAll('#heat-presets .preset-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        state.ui.preset = chip.dataset.preset;
        state.ui.customLevels = null;
        state.ui.customAccent = '';
        applyAppearanceToDom();
        persistUiPreferences();
      });
    });

    for (let i = 0; i < 5; i++) {
      $(`col-lvl${i}`)?.addEventListener('input', (ev) => {
        const dark = isEffectiveDark();
        const presetObj = HEAT_PRESETS[state.ui.preset] || HEAT_PRESETS.violet;
        const base = [...(state.ui.customLevels || (dark ? presetObj.dark : presetObj.light))];
        base[i] = ev.target.value;
        state.ui.customLevels = base;
        applyAppearanceToDom();
        persistUiPreferences();
      });
    }
    $('col-accent')?.addEventListener('input', (ev) => {
      state.ui.customAccent = ev.target.value;
      applyAppearanceToDom();
      persistUiPreferences();
    });

    $('btn-reset-appearance')?.addEventListener('click', () => {
      const langChanged = state.ui.lang !== 'zh';
      state.ui = { themeMode: 'auto', glass: true, lang: 'zh', preset: 'violet', customLevels: null, customAccent: '' };
      if (langChanged) {
        triggerThemeTransition();
        refreshOnLanguageChange();
      } else {
        applyAppearanceToDom({ animate: true });
        syncFloatButtonUi();
        persistUiPreferences();
        if (state.contextData) {
          renderContextPanel(state.contextData);
          renderTopCapsules();
        }
      }
      showToast(tr('已恢复默认外观与色阶', 'Restored default appearance & palette'));
    });

    // Legend box click -> open palette & trigger corresponding color input
    document.querySelectorAll('#heat-legend .leg-box').forEach((box) => {
      box.addEventListener('click', (ev) => {
        ev.stopPropagation?.();
        const slot = box.dataset.legSlot;
        openPaletteDrawer();
        $(`col-lvl${slot}`)?.click();
      });
    });

    // History source & chart mode switches
    const triggerChartStageEnter = () => {
      const st = $('chart-stage');
      if (!st || prefersReducedMotion()) return;
      st.classList.remove('is-chart-enter');
      void st.offsetWidth;
      st.classList.add('is-chart-enter');
    };
    document.querySelectorAll('#source-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.sourceFilter = btn.dataset.source;
        document.querySelectorAll('#source-seg .seg-btn').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
        syncSegIndicator($('source-seg'), { animate: true });
        if (state.historyData) {
          renderHistoryPanel(state.historyData);
          renderCostPanel(state.historyData);
          renderTopCapsules();
        }
      });
    });

    document.querySelectorAll('#chart-mode-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.chartMode = btn.dataset.chart;
        state.chartScrollKey = '';
        document.querySelectorAll('#chart-mode-seg .seg-btn').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
        syncSegIndicator($('chart-mode-seg'), { animate: true });
        if (state.historyData) {
          renderHistoryPanel(state.historyData);
          triggerChartStageEnter();
          syncAllSegIndicators({ animate: false });
        }
      });
    });

    document.querySelectorAll('#hourly-day-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.hourlyDay = btn.dataset.hday === 'yesterday' ? 'yesterday' : 'today';
        document.querySelectorAll('#hourly-day-seg .seg-btn').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
        syncSegIndicator($('hourly-day-seg'), { animate: true });
        if (state.historyData) {
          renderHistoryPanel(state.historyData);
          triggerChartStageEnter();
        }
      });
    });

    document.querySelectorAll('#diag-tab-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.diagTab = btn.dataset.dtab === 'routing' ? 'routing' : 'events';
        document.querySelectorAll('#diag-tab-seg .seg-btn').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
        syncSegIndicator($('diag-tab-seg'), { animate: true });
        if (state.historyData) renderDiagnosticsCard(state.historyData.diagnostics || null);
      });
    });

    // History CSV / JSON Ledger Export
    $('btn-export-csv')?.addEventListener('click', () => {
      withButtonPending($('btn-export-csv'), () => exportHistoryCsv());
    });
    $('btn-export-json')?.addEventListener('click', () => {
      withButtonPending($('btn-export-json'), () => exportHistoryJson());
    });

    $('btn-heat-prev')?.addEventListener('click', () => {
      state.heatPageOffset += 1;
      if (state.historyData) renderHistoryPanel(state.historyData);
    });
    $('btn-heat-next')?.addEventListener('click', () => {
      state.heatPageOffset = Math.max(0, state.heatPageOffset - 1);
      if (state.historyData) renderHistoryPanel(state.historyData);
    });

    // Delegated hover & click inspection for heatmap, bar charts & year bubbles
    const chartStage = $('chart-stage');
    if (chartStage) {
      let lastHoverTarget = null;
      chartStage.addEventListener('mouseover', (ev) => {
        const el = ev.target?.closest?.('.heat-cell:not(.future), .bar-col, .month-bubble-card');
        if (!el || el === lastHoverTarget) return;
        lastHoverTarget = el;
        chartStage.__cvStageInspect?.(el, false);
      });
      chartStage.addEventListener('mouseleave', () => {
        lastHoverTarget = null;
      });
      chartStage.addEventListener('click', (ev) => {
        const el = ev.target?.closest?.('.heat-cell:not(.future), .bar-col, .month-bubble-card');
        if (el) chartStage.__cvStageInspect?.(el, true);
      });
    }

    // Custom date range presets, granularity & date pickers
    document.querySelectorAll('#custom-preset-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const presetId = btn.dataset.cpreset || '30d';
        const resolved = resolveCustomDatePreset(presetId, state.historyData);
        state.customRange.preset = presetId;
        state.customRange.start = resolved.start;
        state.customRange.end = resolved.end;
        if (state.historyData) renderHistoryPanel(state.historyData);
      });
    });

    document.querySelectorAll('#custom-gran-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.customRange.granularity = btn.dataset.cgran || 'auto';
        if (state.historyData) renderHistoryPanel(state.historyData);
      });
    });

    const handleCustomDateInput = (which, rawVal) => {
      const val = String(rawVal || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) return;
      state.customRange.preset = 'custom';
      if (which === 'start') {
        state.customRange.start = val;
        if (state.customRange.end && val > state.customRange.end) {
          state.customRange.end = val;
        }
      } else {
        state.customRange.end = val;
        if (state.customRange.start && val < state.customRange.start) {
          state.customRange.start = val;
        }
      }
      if (state.historyData) renderHistoryPanel(state.historyData);
    };
    $('custom-start-date')?.addEventListener('change', (ev) => handleCustomDateInput('start', ev.target.value));
    $('custom-end-date')?.addEventListener('change', (ev) => handleCustomDateInput('end', ev.target.value));

    // Cost scope, mode & project leaderboard limit switches
    document.querySelectorAll('#cost-scope-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.costScope = btn.dataset.scope;
        document.querySelectorAll('#cost-scope-seg .seg-btn').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
        syncSegIndicator($('cost-scope-seg'), { animate: true });
        if (state.historyData) renderCostPanel(state.historyData);
      });
    });

    document.querySelectorAll('#proj-limit-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextLimit = Number(btn.dataset.projLimit) === 10 ? 10 : 5;
        if (state.projectLimit === nextLimit) return;
        state.projectLimit = nextLimit;
        document.querySelectorAll('#proj-limit-seg .seg-btn').forEach((b) =>
          b.classList.toggle('active', Number(b.dataset.projLimit) === nextLimit)
        );
        syncSegIndicator($('proj-limit-seg'), { animate: true });
        if (state.historyData) renderCostPanel(state.historyData);
      });
    });

    document.querySelectorAll('#cost-mode-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.costMode = btn.dataset.cmode;
        document.querySelectorAll('#cost-mode-seg .seg-btn').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
        syncSegIndicator($('cost-mode-seg'), { animate: true });
        if (state.historyData) renderCostPanel(state.historyData);
      });
    });

    // Subscription Plan Form
    const planForm = $('plan-form');
    $('btn-toggle-plan-form')?.addEventListener('click', () => {
      if (!planForm) return;
      const opening = planForm.classList.contains('hidden');
      if (opening && state.historyData?.planStatus) {
        syncPlanFormInputs(state.historyData.planStatus, state.settingsData?.customPlan);
      }
      planForm.classList.toggle('hidden', !opening);
    });
    $('btn-cancel-plan')?.addEventListener('click', () => {
      planForm?.classList.add('hidden');
    });

    $('f-region-preset')?.addEventListener('change', (ev) => {
      const regions = state.historyData?.presets?.regions || state.settingsData?.presets?.regions || [];
      const found = regions.find((r) => r.id === ev.target.value);
      if (found) {
        if ($('f-currency')) $('f-currency').value = found.currency;
        if ($('f-price-mode')?.value === 'preset' && $('f-paid')) {
          const tierKey = state.historyData?.planStatus?.tierKey || 'pro';
          $('f-paid').value = tierKey === 'ultra' && typeof found.ultraMonthlyPrice === 'number'
            ? found.ultraMonthlyPrice
            : found.monthlyPrice;
        }
      }
    });

    $('f-acquisition')?.addEventListener('change', (ev) => {
      const acqs = state.historyData?.presets?.acquisitions || state.settingsData?.presets?.acquisitions || [];
      const found = acqs.find((a) => a.id === ev.target.value);
      if (!found) return;
      if (found.defaultPaid === 0 && $('f-zero-extra')) {
        $('f-zero-extra').checked = true;
      } else if (found.id === 'family_split' || found.id === 'official_promo' || found.id === 'custom_source') {
        if ($('f-zero-extra')) $('f-zero-extra').checked = false;
        if ($('f-price-mode')) $('f-price-mode').value = 'custom';
        $('f-paid')?.focus();
      }
    });

    planForm?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const submitBtn = planForm.querySelector?.('button[type="submit"]');
      withButtonPending(submitBtn, async () => {
        try {
          const customPlan = {
            subscriptionRegion: $('f-region-preset')?.value || 'US',
            acquisitionId: $('f-acquisition')?.value || 'normal_paid',
            accountCountry: $('f-account-country')?.value?.trim() || '',
            acquisitionName: $('f-acq-name')?.value?.trim() || '',
            priceMode: $('f-price-mode')?.value || 'preset',
            currency: $('f-currency')?.value || 'USD',
            actualPricePaid: $('f-paid')?.value !== '' ? Number($('f-paid').value) : null,
            billingCycle: $('f-cycle')?.value || '月付',
            validUntil: $('f-valid-until')?.value || '',
            zeroExtra: Boolean($('f-zero-extra')?.checked),
            note: $('f-note')?.value?.trim() || ''
          };
          const saved = await apiFetch('/api/settings', { method: 'POST', body: { customPlan } });
          state.settingsData = saved;
          planForm.classList.add('hidden');
          await loadHistory(true);
          showToast(tr('已保存订阅与实付设置', 'Saved subscription & rate'));
        } catch (err) {
          showToast(tr(`保存失败 · ${err.message}`, `Save failed · ${err.message}`));
        }
      });
    });

    $('btn-clear-plan')?.addEventListener('click', () => {
      withButtonPending($('btn-clear-plan'), async () => {
        try {
          const saved = await apiFetch('/api/settings', { method: 'POST', body: { clearPlan: true } });
          state.settingsData = saved;
          planForm?.classList.add('hidden');
          await loadHistory(true);
          showToast(tr('已恢复自动订阅识别', 'Restored automatic plan detection'));
        } catch (err) {
          showToast(tr(`重置失败 · ${err.message}`, `Reset failed · ${err.message}`));
        }
      });
    });

    // Observe host theme inline style mutations injected by sidecar_sdk preload.js
    const styleObserver = new MutationObserver(() => {
      if (state.ui.themeMode === 'auto') applyAppearanceToDom();
    });
    styleObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    window.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change', () => {
      if (state.ui.themeMode === 'auto') applyAppearanceToDom();
    });
  }

  const SPECIAL_EVENT_CODES = new Set([
    'Space', 'Backquote', 'Minus', 'Equal', 'BracketLeft', 'BracketRight',
    'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash'
  ]);

  const KEY_FALLBACK_MAP = {
    ' ': 'Space',
    '`': 'Backquote',
    '~': 'Backquote',
    '-': 'Minus',
    '_': 'Minus',
    '=': 'Equal',
    '+': 'Equal',
    '[': 'BracketLeft',
    '{': 'BracketLeft',
    ']': 'BracketRight',
    '}': 'BracketRight',
    '\\': 'Backslash',
    '|': 'Backslash',
    ';': 'Semicolon',
    ':': 'Semicolon',
    "'": 'Quote',
    '"': 'Quote',
    ',': 'Comma',
    '<': 'Comma',
    '.': 'Period',
    '>': 'Period',
    '/': 'Slash',
    '?': 'Slash'
  };

  function extractShortcutKeyFromEvent(ev) {
    const code = String(ev?.code || '');
    if (/^Key([A-Z])$/.test(code)) return code.slice(3);
    if (/^Digit([0-9])$/.test(code)) return code.slice(5);
    if (/^F([1-9]|1[0-2])$/.test(code)) return code;
    if (SPECIAL_EVENT_CODES.has(code)) return code;

    const key = String(ev?.key || '');
    if (KEY_FALLBACK_MAP[key]) return KEY_FALLBACK_MAP[key];
    if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase();
    if (/^[0-9]$/.test(key)) return key;
    if (/^F([1-9]|1[0-2])$/i.test(key)) return key.toUpperCase();
    return null;
  }

  function formatModifierPreview(ev) {
    const en = typeof state !== 'undefined' && state?.ui?.lang === 'en';
    const emptyPrompt = en ? 'Press keys…' : '按下组合键…';
    const mac = state.shortcut?.nativeGlobalSupported !== false;
    if (mac) {
      let s = '';
      if (ev.ctrlKey) s += '⌃';
      if (ev.altKey) s += '⌥';
      if (ev.shiftKey) s += '⇧';
      if (ev.metaKey) s += '⌘';
      return s ? `${s}…` : emptyPrompt;
    }
    const parts = [];
    if (ev.ctrlKey) parts.push('Ctrl');
    if (ev.altKey) parts.push('Alt');
    if (ev.shiftKey) parts.push('Shift');
    if (ev.metaKey) parts.push('Win');
    return parts.length ? `${parts.join('+')}+…` : emptyPrompt;
  }

  function buildAcceleratorFromKeyEvent(ev) {
    const en = typeof state !== 'undefined' && state?.ui?.lang === 'en';
    const code = String(ev?.code || '');
    const keyName = String(ev?.key || '');
    if (
      ['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Fn'].includes(keyName) ||
      /^(Meta|Control|Alt|Shift)(Left|Right)?$/.test(code)
    ) {
      return { modifierOnly: true, preview: formatModifierPreview(ev) };
    }

    const canonKey = extractShortcutKeyFromEvent(ev);
    if (!canonKey) {
      return {
        ok: false,
        error: en
          ? 'Unsupported key: use A-Z, 0-9, F1-F12, or punctuation'
          : '不支持该按键，请使用字母 A-Z、数字 0-9、F1-F12 或常用符号键'
      };
    }
    const isFnKey = /^F([1-9]|1[0-2])$/.test(canonKey);
    if (!ev.ctrlKey && !ev.altKey && !ev.metaKey && !isFnKey) {
      return {
        ok: false,
        error: en
          ? 'Include ⌘ / ⌥ / ⌃ or F1-F12'
          : '需含 ⌘ / ⌥ / ⌃ 或 F1–F12'
      };
    }

    const parts = [];
    if (ev.ctrlKey) parts.push('Ctrl');
    if (ev.altKey) parts.push('Alt');
    if (ev.shiftKey) parts.push('Shift');
    if (ev.metaKey) parts.push('Meta');
    parts.push(canonKey);
    return { ok: true, accelerator: parts.join('+') };
  }

  function eventMatchesAccelerator(ev, acc) {
    if (!acc) return false;
    const parts = String(acc).split('+').filter(Boolean);
    if (!parts.length) return false;
    const targetKey = parts[parts.length - 1];
    const modSet = new Set(parts.slice(0, -1));
    const evKey = extractShortcutKeyFromEvent(ev);
    if (!evKey || evKey !== targetKey) return false;
    return (
      Boolean(ev.ctrlKey) === modSet.has('Ctrl') &&
      Boolean(ev.altKey) === modSet.has('Alt') &&
      Boolean(ev.shiftKey) === modSet.has('Shift') &&
      Boolean(ev.metaKey) === modSet.has('Meta')
    );
  }

  function isHostAuxPaneContext() {
    return Boolean(
      window.sidecar &&
      !window.sidecar.isFloatWindow &&
      !window.__CV_FLOAT_MODE__ &&
      typeof window.sidecar.ui?.toggleAuxPane === 'function' &&
      !String(location.pathname || '').endsWith('/sidebar')
    );
  }

  function isHostSidebarContext() {
    return Boolean(
      window.sidecar &&
      !window.sidecar.isFloatWindow &&
      !window.__CV_FLOAT_MODE__ &&
      typeof window.sidecar.ui?.toggleAuxPane === 'function' &&
      String(location.pathname || '').endsWith('/sidebar')
    );
  }

  let auxViewportVisible = false;
  let auxEverBeenVisible = false;
  try {
    auxEverBeenVisible = sessionStorage.getItem('agy_aux_ever_visible') === '1';
  } catch {}
  let auxObserverInitialized = false;
  let auxInitialObservationAt = 0;
  const auxVisibilityCallbacks = new Set();

  function ensureAuxViewportObserver() {
    if (auxObserverInitialized || !isHostAuxPaneContext()) return;
    auxObserverInitialized = true;
    if (typeof IntersectionObserver === 'function') {
      const io = new IntersectionObserver(
        (entries) => {
          const entry = entries && entries[entries.length - 1];
          const rect = entry?.intersectionRect;
          const nextVisible = Boolean(
            entry &&
            entry.isIntersecting &&
            rect &&
            rect.width > 40 &&
            rect.height > 40
          );
          if (!auxInitialObservationAt) {
            auxInitialObservationAt = Date.now();
          }
          if (nextVisible && !auxEverBeenVisible) {
            auxEverBeenVisible = true;
            try {
              sessionStorage.setItem('agy_aux_ever_visible', '1');
            } catch {}
          }
          if (auxViewportVisible !== nextVisible) {
            auxViewportVisible = nextVisible;
            for (const fn of auxVisibilityCallbacks) {
              try {
                fn();
              } catch {}
            }
          }
        },
        { root: null, threshold: [0, 0.01] }
      );
      io.observe(document.documentElement);
    } else {
      auxViewportVisible = window.innerWidth > 40 && window.innerHeight > 40 && !document.hidden;
    }
  }

  function isAuxIframeVisible() {
    if (!isHostAuxPaneContext()) return true;
    ensureAuxViewportObserver();
    return auxViewportVisible && !document.hidden;
  }

  function syncRecordingPauseToDaemon(recording) {
    if (typeof window.sidecar?.setShortcutRecording === 'function') {
      window.sidecar.setShortcutRecording(Boolean(recording));
    } else {
      apiFetch('/api/entrypoints', {
        method: 'POST',
        body: { target: 'shortcut-recording', recording: Boolean(recording) }
      }).catch(() => {});
    }
  }

  function startShortcutRecording() {
    state.recordingAuxShortcut = false;
    state.recordingShortcut = true;
    syncRecordingPauseToDaemon(true);
    syncFloatButtonUi();
  }

  function stopShortcutRecording() {
    if (!state.recordingShortcut) return;
    state.recordingShortcut = false;
    syncRecordingPauseToDaemon(false);
    syncFloatButtonUi();
  }

  function startAuxShortcutRecording() {
    state.recordingShortcut = false;
    state.recordingAuxShortcut = true;
    syncRecordingPauseToDaemon(true);
    syncFloatButtonUi();
  }

  function stopAuxShortcutRecording() {
    if (!state.recordingAuxShortcut) return;
    state.recordingAuxShortcut = false;
    syncRecordingPauseToDaemon(false);
    syncFloatButtonUi();
  }

  function stopAllShortcutRecording() {
    if (!state.recordingShortcut && !state.recordingAuxShortcut) return;
    state.recordingShortcut = false;
    state.recordingAuxShortcut = false;
    syncRecordingPauseToDaemon(false);
    syncFloatButtonUi();
  }

  async function applyTargetShortcutPatch(target, patch) {
    const isAux = target === 'aux-shortcut';
    const stateKey = isAux ? 'auxShortcut' : 'shortcut';
    const fallbackMsg = isAux
      ? tr('已更新 AGY 侧栏看板快捷键', 'Updated AGY sidebar hotkey')
      : tr('已更新独立悬浮窗快捷键', 'Updated floating window hotkey');
    try {
      const res = await apiFetch('/api/entrypoints', {
        method: 'POST',
        body: { target, ...patch }
      });
      if (res?.shortcut && typeof res.shortcut === 'object') {
        state.shortcut = { ...state.shortcut, ...res.shortcut };
      }
      if (res?.auxShortcut && typeof res.auxShortcut === 'object') {
        state.auxShortcut = { ...state.auxShortcut, ...res.auxShortcut };
      }
      if (!isAux && res?.shortcut && typeof res.shortcut === 'object') {
        state[stateKey] = { ...state[stateKey], ...res.shortcut };
      }
      syncFloatButtonUi();
      if (!res?.ok) {
        showToast(res?.error || tr('设置快捷键失败', 'Failed to update hotkey'));
        return;
      }
      showToast(res.message || fallbackMsg);
    } catch (err) {
      syncFloatButtonUi();
      showToast(tr(`设置快捷键失败：${err.message}`, `Hotkey update failed: ${err.message}`));
    }
  }

  function applyShortcutPatch(patch) {
    return applyTargetShortcutPatch('shortcut', patch);
  }

  function applyAuxShortcutPatch(patch) {
    return applyTargetShortcutPatch('aux-shortcut', patch);
  }

  function syncShortcutControlUi({ recBtnId, kbdLblId, recHintId, toggleBtnId, resetBtnId, sc, recording, defaultFallback }) {
    const enabled = sc?.enabled !== false;
    const recBtn = $(recBtnId);
    const kbdLbl = $(kbdLblId);
    const recHint = $(recHintId);
    const toggleScBtn = $(toggleBtnId);
    const resetScBtn = $(resetBtnId);

    if (recBtn) {
      recBtn.classList.toggle('is-recording', Boolean(recording));
      recBtn.classList.toggle('is-disabled', !enabled && !recording);
    }
    if (kbdLbl) {
      setText(
        kbdLbl,
        recording
          ? tr('请按键', 'Press keys')
          : (sc?.display || sc?.defaultDisplay || defaultFallback)
      );
    }
    if (recHint) {
      setText(
        recHint,
        recording
          ? tr('· Esc 取消', '· Esc')
          : (enabled ? tr('修改', 'Edit') : tr('已停用', 'Disabled'))
      );
    }
    if (toggleScBtn) {
      setText(toggleScBtn, enabled ? tr('已开启', 'Enabled') : tr('已停用', 'Disabled'));
    }
    if (resetScBtn) {
      resetScBtn.disabled = Boolean(sc?.isDefault);
    }
  }

  function syncFloatButtonUi() {
    const en = isEn();
    const menubarRow = $('menubar-entry-row');
    if (menubarRow) {
      menubarRow.classList.toggle('hidden', state.menubarSupported === false);
    }
    const menubarModeRow = $('menubar-mode-row');
    if (menubarModeRow) {
      menubarModeRow.classList.toggle('hidden', state.menubarSupported === false);
    }
    document.querySelectorAll('#menubar-entry-seg .seg-btn').forEach((b) => {
      const active = (b.dataset.menubarEntry === 'on') === Boolean(state.menubarEnabled);
      b.classList.toggle('active', active);
    });
    document.querySelectorAll('#menubar-mode-seg .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.menubarMode === (state.menubarMode || 'context'));
    });

    const sc = state.shortcut || {};
    syncShortcutControlUi({
      recBtnId: 'btn-record-shortcut',
      kbdLblId: 'shortcut-kbd-label',
      recHintId: 'shortcut-record-hint',
      toggleBtnId: 'btn-toggle-shortcut',
      resetBtnId: 'btn-reset-shortcut',
      sc,
      recording: state.recordingShortcut,
      defaultFallback: '⌥⌘K'
    });
    syncShortcutControlUi({
      recBtnId: 'btn-record-aux-shortcut',
      kbdLblId: 'aux-shortcut-kbd-label',
      recHintId: 'aux-shortcut-record-hint',
      toggleBtnId: 'btn-toggle-aux-shortcut',
      resetBtnId: 'btn-reset-aux-shortcut',
      sc: state.auxShortcut || {},
      recording: state.recordingAuxShortcut,
      defaultFallback: '⌃⌥K'
    });
    const scScopeRow = $('shortcut-scope-row');
    if (scScopeRow) {
      scScopeRow.classList.toggle('hidden', sc.nativeGlobalSupported === false);
    }
    document.querySelectorAll('#shortcut-scope-seg .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.shortcutScope === (sc.scope || 'app'));
    });

    const drawerFloatBtn = $('btn-drawer-float');
    if (drawerFloatBtn) {
      if (window.__CV_FLOAT_MODE__) {
        setText(
          drawerFloatBtn,
          window.__CV_BROWSER_FALLBACK__
            ? tr('关闭当前小窗', 'Close Window')
            : (state.floatPinned
                ? tr('当前在小窗中 · 点击取消置顶', 'Floating · Click to Unpin')
                : tr('当前在小窗中 · 点击恢复置顶', 'Floating · Click to Pin'))
        );
      } else {
        setText(
          drawerFloatBtn,
          state.floatRunning
            ? tr('运行中 · 点击收回小窗', 'Running · Click to Close')
            : tr('弹出独立置顶小窗', 'Open Floating Window')
        );
      }
    }

    const btn = $('btn-float');
    if (!btn) return;
    const scEnabled = sc.enabled !== false;
    const scHint = scEnabled && sc.display ? (en ? `; hotkey ${sc.display}` : `；快捷键 ${sc.display}`) : '';
    if (window.__CV_FLOAT_MODE__) {
      const pinned = Boolean(state.floatPinned) && !window.__CV_BROWSER_FALLBACK__;
      btn.classList.toggle('pin-active', pinned);
      const tip = window.__CV_BROWSER_FALLBACK__
        ? formatZh(
            en
              ? `Close floating viewer${scHint ? ` (${sc.display})` : ''}`
              : `关闭右侧独立看板小窗${scHint ? `（${sc.display}）` : ''}`
          )
        : pinned
          ? formatZh(
              en
                ? `Pinned on top (click to unpin; Shift+click${scEnabled && sc.display ? ` or press ${sc.display}` : ''} to close)`
                : `当前：已钉在屏幕最前（点击取消置顶；Shift+点击${scHint ? `或按 ${sc.display} ` : ''}收回小窗）`
            )
          : formatZh(
              en
                ? `Unpinned (click to re-pin on top; Shift+click${scEnabled && sc.display ? ` or press ${sc.display}` : ''} to close)`
                : `当前：已取消置顶（点击重新钉在最前；Shift+点击${scHint ? `或按 ${sc.display} ` : ''}收回小窗）`
            );
      setElTooltip(btn, tip);
      btn.setAttribute?.('aria-label', tip);
    } else {
      const active = Boolean(state.floatRunning);
      btn.classList.toggle('pin-active', active);
      const tip = active
        ? formatZh(
            en
              ? `Floating viewer open (click or press ${scEnabled && sc.display ? sc.display : '📌'} to close)`
              : `右侧独立置顶看板显示中（点击或按 ${scEnabled && sc.display ? sc.display : '📌'} 收回小窗）`
          )
        : formatZh(
            en
              ? `Open always-on-top floating window on the right (independent of sidebar tabs${scHint})`
              : `钉在屏幕右侧独立置顶小窗（不受右侧栏切换影响${scHint}）`
          );
      setElTooltip(btn, tip);
      btn.setAttribute?.('aria-label', tip);
    }
  }

  async function refreshFloatStatus() {
    try {
      const res = await apiFetch('/api/entrypoints');
      if (typeof res.menubarSupported === 'boolean') {
        state.menubarSupported = res.menubarSupported;
      }
      if (typeof res.menubarEnabled === 'boolean') {
        state.menubarEnabled = res.menubarEnabled;
      }
      if (typeof res.menubarMode === 'string' && res.menubarMode) {
        state.menubarMode = res.menubarMode;
      }
      if (res.shortcut && typeof res.shortcut === 'object') {
        state.shortcut = { ...state.shortcut, ...res.shortcut };
      }
      if (res.auxShortcut && typeof res.auxShortcut === 'object') {
        state.auxShortcut = { ...state.auxShortcut, ...res.auxShortcut };
      }
      if (!window.__CV_FLOAT_MODE__ && res.floatWindow) {
        state.floatRunning = Boolean(res.floatWindow.running);
        state.floatPinned = Boolean(res.floatWindow.pinned);
      }
      syncFloatButtonUi();
    } catch {}
  }

  window.__cvOnHostPinChange = (pinned) => {
    state.floatPinned = Boolean(pinned);
    syncFloatButtonUi();
  };

  window.__cvOnHostMenubarChange = (enabled) => {
    state.menubarEnabled = Boolean(enabled);
    syncFloatButtonUi();
  };

  window.__cvOnHostMenubarModeChange = (mode) => {
    if (mode) state.menubarMode = String(mode);
    syncFloatButtonUi();
  };

  window.__cvOnHostShortcutChange = (scPatch) => {
    if (scPatch && typeof scPatch === 'object') {
      state.shortcut = { ...state.shortcut, ...scPatch };
      if (scPatch.scope && state.auxShortcut) {
        state.auxShortcut = { ...state.auxShortcut, scope: scPatch.scope };
      }
      syncFloatButtonUi();
    }
  };

  window.__cvOnHostAuxShortcutChange = (scPatch) => {
    if (scPatch && typeof scPatch === 'object') {
      state.auxShortcut = { ...state.auxShortcut, ...scPatch };
      if (scPatch.scope && state.shortcut) {
        state.shortcut = { ...state.shortcut, scope: scPatch.scope };
      }
      syncFloatButtonUi();
    }
  };

  function postSidecarCloseKeyEvent() {
    const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
    window.parent?.postMessage({
      type: 'sidecar-key-event',
      payload: {
        eventType: 'keydown',
        key: 'b',
        code: 'KeyB',
        ctrlKey: !isMac,
        metaKey: isMac,
        altKey: false,
        shiftKey: true,
        repeat: false
      }
    }, '*');
  }

  function startAuxPaneBridgeCoordinator() {
    const isSidebarRelay = isHostSidebarContext();
    if (!isHostAuxPaneContext() && !isSidebarRelay) {
      return;
    }

    if (!isSidebarRelay) {
      ensureAuxViewportObserver();
    }
    const isAuxPaneVisibleNow = () => !isSidebarRelay && isAuxIframeVisible();
    const coordinatorBootAt = Date.now();
    let visibleSince = isAuxPaneVisibleNow() ? coordinatorBootAt : 0;
    let lastSeenSeq = 0;
    let pendingOpenTrigger = null;

    const getMyConvId = () => window.sidecar.conversationId || state.hostConvId || '';

    const reportHello = () => {
      if (!isAuxPaneVisibleNow()) return;
      const convId = getMyConvId();
      if (convId) {
        apiFetch('/api/aux-pane-trigger', {
          method: 'POST',
          body: { action: 'hello', convId }
        }).catch(() => {});
      }
    };

    const claimPendingOpenAckIfVisible = async () => {
      if (!pendingOpenTrigger || !isAuxPaneVisibleNow()) return false;
      const pending = pendingOpenTrigger;
      if ((Date.now() - pending.at) > 2500 || !pending.isSelfTarget) {
        pendingOpenTrigger = null;
        return false;
      }
      pendingOpenTrigger = null;
      const ackRes = await apiFetch('/api/aux-pane-trigger', {
        method: 'POST',
        body: { action: 'ack', seq: pending.seq, plugin: 'context-viewer' }
      }).catch(() => null);
      if (ackRes?.claimed) {
        sessionStorage.setItem('agy_aux_last_ack_seq', String(pending.seq));
        return true;
      }
      return false;
    };

    const handleVisibilityChange = () => {
      const nowVisible = isAuxPaneVisibleNow();
      if (nowVisible) {
        const becameVisible = !visibleSince;
        if (becameVisible) {
          visibleSince = (Date.now() - coordinatorBootAt < 250) ? coordinatorBootAt : Date.now();
          reportHello();
          loadContext(false).catch(() => {});
          loadHistory(false).catch(() => {});
          refreshFloatStatus().catch(() => {});
          claimPendingOpenAckIfVisible().catch(() => {});
          apiFetch('/api/aux-pane-trigger?waitMs=0').then(async (res) => {
            const trig = res?.trigger;
            if (
              !trig?.seq ||
              (Date.now() - Number(trig.at || 0)) >= 2500 ||
              Number(trig.ackSeq || 0) >= trig.seq
            ) {
              return;
            }
            visibleSince = Date.now();
            if (
              trig.targetPlugin &&
              trig.targetPlugin !== 'context-viewer' &&
              Number(trig.switchedSeq || 0) < trig.seq &&
              trig.uri
            ) {
              const sw = await apiFetch('/api/aux-pane-trigger', {
                method: 'POST',
                body: { action: 'switched', seq: trig.seq }
              }).catch(() => null);
              if (sw?.claimed) {
                const ackRes = await apiFetch('/api/aux-pane-trigger', {
                  method: 'POST',
                  body: { action: 'ack', seq: trig.seq, plugin: 'context-viewer' }
                }).catch(() => null);
                if (ackRes?.claimed) {
                  sessionStorage.setItem('agy_aux_last_ack_seq', String(trig.seq));
                }
                if (pendingOpenTrigger?.seq === trig.seq) {
                  pendingOpenTrigger = null;
                }
                window.sidecar.ui.toggleAuxPane({ tabType: 'sidecarView', uri: trig.uri });
              }
            } else if (trig.targetPlugin === 'context-viewer') {
              const ackRes = await apiFetch('/api/aux-pane-trigger', {
                method: 'POST',
                body: { action: 'ack', seq: trig.seq, plugin: 'context-viewer' }
              }).catch(() => null);
              if (ackRes?.claimed) {
                sessionStorage.setItem('agy_aux_last_ack_seq', String(trig.seq));
                if (pendingOpenTrigger?.seq === trig.seq) {
                  pendingOpenTrigger = null;
                }
              }
            }
          }).catch(() => {});
        } else if (pendingOpenTrigger) {
          claimPendingOpenAckIfVisible().catch(() => {});
        }
      } else {
        visibleSince = 0;
      }
    };

    if (!isSidebarRelay) {
      if (visibleSince) {
        reportHello();
      }

      document.addEventListener('pointerdown', reportHello, { passive: true });
      document.addEventListener('keydown', reportHello, { passive: true });
      auxVisibilityCallbacks.add(handleVisibilityChange);
      document.addEventListener('visibilitychange', handleVisibilityChange);
      window.addEventListener('message', (ev) => {
        if (ev.data?.type === 'theme-change' || ev.data?.type === 'workspace-change') {
          handleVisibilityChange();
        }
      });

      if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(handleVisibilityChange);
        ro.observe(document.documentElement);
      }
    }

    const handleTrigger = async (trigger) => {
      const seq = Number(trigger?.seq || 0);
      if (!seq || seq <= lastSeenSeq) return;
      const sessionAck = Number(sessionStorage.getItem('agy_aux_last_ack_seq') || '0');
      if (seq <= sessionAck || seq <= Number(trigger?.ackSeq || 0)) {
        lastSeenSeq = seq;
        return;
      }
      lastSeenSeq = seq;
      if ((Date.now() - Number(trigger.at || 0)) > 5000) return;

      const myConvId = getMyConvId();
      const isVisibleNow = isAuxPaneVisibleNow();
      const alreadyOpeningOrSwitched =
        Number(trigger.openingSeq || 0) >= seq ||
        Number(trigger.switchedSeq || 0) >= seq;
      const wasAlreadyVisible =
        !isSidebarRelay &&
        !alreadyOpeningOrSwitched &&
        coordinatorBootAt <= Number(trigger.at || 0) - 40 &&
        visibleSince > 0 &&
        visibleSince <= Number(trigger.at || 0) - 40;
      const isSelfTarget = trigger.targetPlugin === 'context-viewer';
      const exactConvMatch = !trigger.convId || !myConvId || myConvId === trigger.convId;

      if (isVisibleNow) {
        if (!exactConvMatch) {
          const settle = await apiFetch('/api/aux-pane-trigger?waitMs=0&holdMs=25').catch(() => null);
          if (Number(settle?.trigger?.ackSeq || 0) >= seq || !isAuxPaneVisibleNow()) return;
        }
        if (!isSelfTarget) {
          if (trigger.uri) {
            const ackRes = await apiFetch('/api/aux-pane-trigger', {
              method: 'POST',
              body: { action: 'ack', seq, plugin: 'context-viewer' }
            }).catch(() => null);
            if (!ackRes?.claimed) return;
            await apiFetch('/api/aux-pane-trigger', {
              method: 'POST',
              body: { action: 'switched', seq }
            }).catch(() => null);
            sessionStorage.setItem('agy_aux_last_ack_seq', String(seq));
            window.sidecar.ui.toggleAuxPane({ tabType: 'sidecarView', uri: trigger.uri });
          }
          return;
        }

        if (wasAlreadyVisible) {
          const ackRes = await apiFetch('/api/aux-pane-trigger', {
            method: 'POST',
            body: { action: 'ack', seq, plugin: 'context-viewer' }
          }).catch(() => null);
          if (!ackRes?.claimed) return;
          sessionStorage.setItem('agy_aux_last_ack_seq', String(seq));
          if (trigger.action !== 'open') {
            postSidecarCloseKeyEvent();
          }
          return;
        }

        const ackRes = await apiFetch('/api/aux-pane-trigger', {
          method: 'POST',
          body: { action: 'ack', seq, plugin: 'context-viewer' }
        }).catch(() => null);
        if (ackRes?.claimed) {
          sessionStorage.setItem('agy_aux_last_ack_seq', String(seq));
        }
        return;
      }

      if (typeof window.sidecar.ui?.toggleConversation !== 'function') return;
      if (document.hidden) return;

      let waitBeforeClaim;
      if (isSidebarRelay) {
        waitBeforeClaim = 390;
      } else if (auxEverBeenVisible) {
        waitBeforeClaim = isSelfTarget
          ? (exactConvMatch ? 30 : 125)
          : (exactConvMatch ? 75 : 175);
      } else {
        waitBeforeClaim = isSelfTarget
          ? (exactConvMatch ? 235 : 320)
          : (exactConvMatch ? 280 : 365);
      }
      const recheck = await apiFetch(`/api/aux-pane-trigger?waitMs=0&holdMs=${waitBeforeClaim}`).catch(() => null);
      const latestTrig = recheck?.trigger;
      if (latestTrig && (Number(latestTrig.ackSeq || 0) >= seq || Number(latestTrig.openingSeq || 0) >= seq)) {
        return;
      }
      if (isAuxPaneVisibleNow()) {
        handleVisibilityChange();
        return;
      }

      const targetConvId = trigger.convId || myConvId;
      if (!targetConvId) return;

      const openRes = await apiFetch('/api/aux-pane-trigger', {
        method: 'POST',
        body: { action: 'opening', seq }
      }).catch(() => null);
      if (!openRes?.claimed) return;

      pendingOpenTrigger = isSidebarRelay ? null : { seq, convId: targetConvId, at: Date.now(), isSelfTarget };
      // Host unmounts toggle-aux-pane (Cyc) while the iframe is hidden; only root epc(toggle-conversation) expands a collapsed Aux Pane.
      window.sidecar.ui.toggleConversation(targetConvId);
      if (!isSidebarRelay) {
        apiFetch('/api/aux-pane-trigger?waitMs=0&holdMs=110').then(() => {
          if (isSelfTarget) {
            claimPendingOpenAckIfVisible().catch(() => {});
          }
          handleVisibilityChange();
        }).catch(() => {});
      }
    };

    (async () => {
      try {
        const initRes = await apiFetch('/api/aux-pane-trigger?waitMs=0');
        const initTrig = initRes?.trigger;
        if (initTrig?.seq) {
          const sessionAck = Number(sessionStorage.getItem('agy_aux_last_ack_seq') || '0');
          if (
            initTrig.seq > sessionAck &&
            initTrig.seq > Number(initTrig.ackSeq || 0) &&
            (Date.now() - Number(initTrig.at || 0)) < 3500
          ) {
            await handleTrigger(initTrig);
          } else {
            lastSeenSeq = Number(initTrig.seq || 0);
          }
        }
      } catch {}

      while (true) {
        try {
          const res = await apiFetch(`/api/aux-pane-trigger?since=${lastSeenSeq}&waitMs=8500`);
          if (res?.trigger) {
            await handleTrigger(res.trigger);
          }
        } catch {
          await new Promise((r) => setTimeout(r, 650));
        }
      }
    })();
  }

  window.__cvOnHostVisibility = (visible) => {
    const vis = Boolean(visible);
    state.hostHidden = !vis;
    if (vis) {
      loadContext(false).catch(() => {});
      loadHistory(false).catch(() => {});
      refreshFloatStatus().catch(() => {});
    }
  };

  async function initWorkspaceTracking() {
    if (!window.sidecar) return;
    try {
      const uris = await window.sidecar.getWorkspaceUris?.();
      if (Array.isArray(uris) && uris[0]) state.workspaceUri = uris[0];
    } catch {}
    try {
      window.sidecar.onWorkspaceChange?.((uris) => {
        if (Array.isArray(uris) && uris[0]) state.workspaceUri = uris[0];
      });
    } catch {}
  }

  function initCustomTooltips() {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    const tipEl = $('cv-tooltip');
    if (!tipEl) return;

    state.customTooltipsReady = true;

    const stripTitleToDataset = (node) => {
      if (!node || typeof node.getAttribute !== 'function') return '';
      const hasNativeAttr = typeof node.hasAttribute === 'function'
        ? node.hasAttribute('title')
        : (node.getAttribute('title') !== null && node.getAttribute('title') !== undefined);
      if (hasNativeAttr) {
        const nativeTitle = node.getAttribute('title') || '';
        node.removeAttribute?.('title');
        if (node.dataset) {
          if (nativeTitle) node.dataset.cvTip = nativeTitle;
          else delete node.dataset.cvTip;
        }
        return nativeTitle;
      }
      return node.dataset?.cvTip || '';
    };

    document.querySelectorAll?.('[title]')?.forEach((el) => {
      stripTitleToDataset(el);
    });

    let showTimer = null;
    let activeTarget = null;
    let showSeq = 0;
    let lastVisibleAt = 0;

    const hideTooltip = () => {
      showSeq += 1;
      if (showTimer) {
        clearTimeout(showTimer);
        showTimer = null;
      }
      if (tipEl.classList?.contains('is-visible')) {
        lastVisibleAt = Date.now();
      }
      activeTarget = null;
      tipEl.classList?.remove('is-visible', 'is-hot');
      tipEl.classList?.add('hidden');
      tipEl.setAttribute?.('aria-hidden', 'true');
    };

    const positionTooltip = (target) => {
      if (typeof target?.getBoundingClientRect !== 'function') return false;
      const vw = typeof window !== 'undefined' && typeof window.innerWidth === 'number'
        ? window.innerWidth
        : (document.documentElement?.clientWidth || 360);
      const vh = typeof window !== 'undefined' && typeof window.innerHeight === 'number'
        ? window.innerHeight
        : (document.documentElement?.clientHeight || 640);
      const rect = target.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0 && rect.left === 0 && rect.top === 0)) {
        return false;
      }

      if (tipEl.style) {
        tipEl.style.left = '0px';
        tipEl.style.top = '0px';
      }
      const tipW = tipEl.offsetWidth || 160;
      const tipH = tipEl.offsetHeight || 28;
      const margin = 8;
      const gap = 6;

      const centeredLeft = rect.left + (rect.width / 2) - (tipW / 2);
      const maxLeft = Math.max(margin, vw - tipW - margin);
      const left = Math.max(margin, Math.min(centeredLeft, maxLeft));

      let top = rect.bottom + gap;
      if (top + tipH > vh - margin && rect.top >= tipH + gap + margin) {
        top = rect.top - tipH - gap;
      }
      top = Math.max(margin, Math.min(top, Math.max(margin, vh - tipH - margin)));

      if (tipEl.style) {
        tipEl.style.left = `${Math.round(left)}px`;
        tipEl.style.top = `${Math.round(top)}px`;
      }
      return true;
    };

    const showTooltip = (target, text, { hot = false } = {}) => {
      if (!target || !text) {
        hideTooltip();
        return;
      }
      const seq = ++showSeq;
      tipEl.textContent = text;
      tipEl.classList?.toggle('is-hot', Boolean(hot));
      if (!hot) {
        tipEl.classList?.remove('is-visible');
      }
      tipEl.classList?.remove('hidden');
      tipEl.setAttribute?.('aria-hidden', 'false');

      if (!positionTooltip(target)) {
        hideTooltip();
        return;
      }
      lastVisibleAt = Date.now();
      if (hot) {
        tipEl.classList?.add('is-visible');
        return;
      }
      const reveal = () => {
        if (seq !== showSeq || activeTarget !== target) return;
        positionTooltip(target);
        tipEl.classList?.add('is-visible');
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(reveal);
      } else {
        reveal();
      }
    };

    const isSuppressedTarget = (target) => {
      if (!target) return true;
      const hasCapKey = typeof target.hasAttribute === 'function'
        ? target.hasAttribute('data-cap-key')
        : Boolean(target.dataset?.capKey);
      return hasCapKey || Boolean(target.closest?.('#cap-popover'));
    };

    document.addEventListener('pointerover', (e) => {
      const rawTarget = e?.target;
      const target = rawTarget?.closest?.('[title], [data-cv-tip]');
      if (!target) {
        if (activeTarget) hideTooltip();
        return;
      }

      const tipText = stripTitleToDataset(target);
      if (!tipText || isSuppressedTarget(target)) {
        hideTooltip();
        return;
      }

      if (target === activeTarget && (!tipEl.classList?.contains('hidden') || showTimer)) {
        return;
      }

      const isHotChannel = Boolean(
        !tipEl.classList?.contains('hidden') ||
        (lastVisibleAt > 0 && (Date.now() - lastVisibleAt) <= 400)
      );
      if (showTimer) {
        clearTimeout(showTimer);
        showTimer = null;
      }
      activeTarget = target;
      if (isHotChannel) {
        showTooltip(target, tipText, { hot: true });
        return;
      }
      const isTopIcon = Boolean(target.closest?.('.top-actions') || target.classList?.contains('icon-btn'));
      const delayMs = isTopIcon ? 120 : 220;
      showTimer = setTimeout(() => {
        showTimer = null;
        if (activeTarget !== target || target.isConnected === false) {
          hideTooltip();
          return;
        }
        const latestTip = stripTitleToDataset(target);
        if (!latestTip || isSuppressedTarget(target)) {
          hideTooltip();
          return;
        }
        showTooltip(target, latestTip, { hot: false });
      }, delayMs);
    });

    document.addEventListener('pointerout', (e) => {
      if (!activeTarget) return;
      const related = e?.relatedTarget;
      if (related && activeTarget.contains?.(related)) return;
      const leaving = e?.target?.closest?.('[title], [data-cv-tip]');
      if (!leaving || leaving === activeTarget || !activeTarget.contains?.(e?.target)) {
        hideTooltip();
      }
    });

    document.addEventListener('pointerdown', hideTooltip, true);
    document.addEventListener('scroll', hideTooltip, true);
    document.addEventListener('keydown', (e) => {
      if (e?.key === 'Escape') hideTooltip();
    });
    window.addEventListener?.('blur', hideTooltip);
    window.addEventListener?.('resize', hideTooltip);
  }

  async function boot() {
    normalizeStaticDomTypography();
    syncCompactMode();
    applyAppearanceToDom();
    syncFloatButtonUi();
    wireEvents();
    initCustomTooltips();
    initWorkspaceTracking();
    startAuxPaneBridgeCoordinator();
    syncAllSegIndicators({ animate: false });

    const initiallyVisible = !document.hidden && !state.hostHidden && isAuxIframeVisible();
    if (initiallyVisible) {
      loadHistory(false).catch(() => {});
    }

    await Promise.allSettled([
      loadInitialSettings(),
      initiallyVisible ? loadContext(false) : Promise.resolve(),
      refreshFloatStatus()
    ]);

    // Snappy ETag-backed background polling while panel is visible
    setInterval(() => {
      if (document.hidden || state.hostHidden || !isAuxIframeVisible()) return;
      loadContext(false).catch(() => {});
    }, 1500);

    setInterval(() => {
      if (document.hidden || state.hostHidden || !isAuxIframeVisible()) return;
      loadHistory(false).catch(() => {});
      refreshFloatStatus().catch(() => {});
    }, 10000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
