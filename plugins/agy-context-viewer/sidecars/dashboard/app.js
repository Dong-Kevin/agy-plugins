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
    contextEtag: '',
    contextEtagConv: '',
    contextReqSeq: 0,
    contextInFlight: false,
    contextInFlightConv: '',
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
    turnsFilter: 'all', // 'all' | 'spike' | 'tools'
    turnsView: 'steps', // 'steps' | 'prompts'
    promptTurnsFilter: 'all', // 'all' | 'cold'

    // Appearance & gauge preferences
    ui: {
      themeMode: 'auto', // 'auto' | 'light' | 'dark'
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
    toastTimer: null
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

  function showToast(msg, durationMs = 2600) {
    const el = $('toast');
    if (!el) return;
    setText(el, msg);
    el.classList.remove('hidden');
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      el.classList.add('hidden');
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
    if (state.ui.themeMode === 'dark') return true;
    if (state.ui.themeMode === 'light') return false;
    return detectHostDark();
  }

  function setRootStyleVar(root, key, val) {
    if (root.style.getPropertyValue(key).trim() !== val) {
      root.style.setProperty(key, val);
    }
  }

  function applyAppearanceToDom() {
    const root = document.documentElement;
    const dark = isEffectiveDark();

    if (root.getAttribute('data-theme') !== (dark ? 'dark' : 'light')) {
      root.setAttribute('data-theme', dark ? 'dark' : 'light');
    }
    if (state.ui.themeMode === 'light' || state.ui.themeMode === 'dark') {
      if (root.getAttribute('data-force-mode') !== state.ui.themeMode) {
        root.setAttribute('data-force-mode', state.ui.themeMode);
      }
    } else if (root.hasAttribute('data-force-mode')) {
      root.removeAttribute('data-force-mode');
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

    // Update theme buttons & icon
    document.querySelectorAll('#theme-seg .seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.themeMode === state.ui.themeMode);
    });
    document.querySelectorAll('#heat-presets .preset-chip').forEach((chip) => {
      const active = !state.ui.customLevels && chip.dataset.preset === state.ui.preset;
      chip.classList.toggle('active', active);
    });

    const icTheme = $('ic-theme');
    const btnTheme = $('btn-theme');
    if (icTheme) {
      if (state.ui.themeMode === 'light') {
        icTheme.innerHTML = '<circle cx="8" cy="8" r="3.3"/><path d="M8 1.6v1.8M8 12.6v1.8M1.6 8h1.8M12.6 8h1.8M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3"/>';
      } else if (state.ui.themeMode === 'dark') {
        icTheme.innerHTML = '<path d="M8.4 2.1a5.8 5.8 0 1 0 5.5 7.5A4.6 4.6 0 0 1 8.4 2.1Z"/>';
      } else {
        icTheme.innerHTML = '<circle cx="8" cy="8" r="5.8"/><path d="M8 2.2v11.6A5.8 5.8 0 0 0 8 2.2Z" class="fill"/>';
      }
    }
    if (btnTheme) {
      const tipMap = {
        auto: `当前：跟随宿主主题（已识别为${dark ? '深色' : '浅色'}，点击切换为固定浅色）`,
        light: '当前：固定浅色主题（点击切换为固定深色）',
        dark: '当前：固定深色主题（点击切换回跟随宿主主题）'
      };
      const tip = tipMap[state.ui.themeMode] || tipMap.auto;
      btnTheme.title = tip;
      btnTheme.setAttribute('aria-label', tip);
    }
  }

  async function persistUiPreferences() {
    try {
      await apiFetch('/api/settings', {
        method: 'POST',
        body: {
          uiPreferences: {
            themeMode: state.ui.themeMode,
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
    const res = await fetcher(path, { method, headers, body });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
  }

  async function loadContext(force = false) {
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
    if (!force && state.contextInFlight && (state.contextInFlightConv || '') === targetConv) {
      return;
    }
    if (state.contextEtagConv !== targetConv) {
      state.contextEtag = '';
      state.contextEtagConv = targetConv;
    }

    const reqSeq = ++state.contextReqSeq;
    state.contextInFlight = true;
    state.contextInFlightConv = targetConv;
    const qs = new URLSearchParams();
    if (targetConv) qs.set('conversationId', targetConv);
    if (force) qs.set('force', '1');
    else if (state.contextEtag) qs.set('etag', state.contextEtag);

    try {
      const snap = await apiFetch(`/api/context?${qs.toString()}`);
      syncLiveHost();
      const activeTarget = state.selectedConvId || state.hostConvId || '';
      if (reqSeq !== state.contextReqSeq || targetConv !== activeTarget) {
        return;
      }
      if (snap?.recentConversations) {
        renderConversationPicker(snap.recentConversations, snap.conversationId);
      }
      if (snap?.unchanged && state.contextData && (!targetConv || state.contextData.conversationId === targetConv)) {
        return;
      }
      if (snap?.ok) {
        state.contextEtag = snap.etag || '';
        state.contextEtagConv = targetConv;
        state.contextData = snap;
        renderContextPanel(snap);
        renderTopCapsules();
      }
    } finally {
      if (reqSeq === state.contextReqSeq) {
        state.contextInFlight = false;
        state.contextInFlightConv = '';
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
      if (prefs.themeMode && ['auto', 'light', 'dark'].includes(prefs.themeMode)) {
        state.ui.themeMode = prefs.themeMode;
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
      applyAppearanceToDom();
      syncFloatButtonUi();
      populatePlanPresetsIfNeeded(s.presets);
      syncPlanFormInputs(s.planStatus, s.customPlan);
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
    setText('cap-ctx-pct', pct !== null ? `${pct.toFixed(0)}%` : (win.used !== null ? fmtTokens(win.used) : '--%'));

    const miniRing = $('mini-ring-fill');
    if (miniRing) {
      const circum = 45.24; // 2 * PI * 7.2
      const ratio = pct !== null ? Math.min(1, Math.max(0, pct / 100)) : 0;
      miniRing.setAttribute('stroke-dasharray', `${(ratio * circum).toFixed(2)} ${circum}`);
      miniRing.style.stroke = resolveHealthStroke(healthPct, ctx?.error?.kind);
    }

    const tps = spd?.tps ?? spd?.streamingTps ?? null;
    setText('cap-speed-val', tps !== null ? `${tps} tok/s` : '-- tok/s');

    const srcSummary = hist?.analyticsBySource?.[state.sourceFilter]?.summary
      || hist?.analyticsBySource?.all?.summary;
    setText('cap-tok-val', srcSummary ? fmtTokens(srcSummary.grandTotalTokens) : '--');
  }

  function resolveHealthStroke(pct, errKind) {
    if (errKind && errKind !== 'none' && errKind !== 'canceled') return 'var(--danger)';
    if (pct !== null && pct >= 90) return 'var(--danger)';
    if (pct !== null && pct >= 75) return 'var(--warn)';
    return 'var(--cv-accent)';
  }

  function renderConversationPicker(list = [], activeId = '') {
    const sel = $('conv-select');
    const followBtn = $('btn-follow-current');
    if (followBtn) followBtn.classList.toggle('hidden', !state.selectedConvId);
    if (!sel) return;
    const prevVal = state.selectedConvId;
    const optionsHtml = [
      `<option value="">${escZh('自动跟随当前对话')}</option>`
    ];
    for (const item of list) {
      const tag = item.source === 'cli' ? '[CLI] ' : '';
      const shortTitle = String(item.title || item.id.slice(0, 8)).slice(0, 22);
      const tokBadge = item.lastContextTokens > 0 ? ` · ${fmtTokens(item.lastContextTokens, 0)}` : '';
      const isCurrentAuto = !prevVal && item.id === activeId;
      const suffix = isCurrentAuto ? '（当前）' : '';
      optionsHtml.push(
        `<option value="${esc(item.id)}">${escZh(`${tag}${shortTitle}${tokBadge}${suffix}`)}</option>`
      );
    }
    sel.innerHTML = optionsHtml.join('');
    sel.value = prevVal || '';
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

    setText('ctx-model-badge', ctx.model || '未识别模型');

    const pendingBadge = $('ctx-pending-badge');
    if (pendingBadge) {
      if (ctx.pendingTokens > 0) {
        pendingBadge.classList.remove('hidden');
        setText(pendingBadge, `+待发 ~${fmtTokens(ctx.pendingTokens, 1)}`);
      } else {
        pendingBadge.classList.add('hidden');
      }
    }

    setText('conv-live-title', snap.conversationTitle || `会话 ${snap.conversationId || ''}`);
    const repoChip = $('conv-repo-chip');
    if (repoChip) {
      const repoLabel = snap.repoInfo?.label ? String(snap.repoInfo.label).trim() : '';
      if (repoLabel) {
        repoChip.classList.remove('hidden');
        setText(repoChip, repoLabel);
        const repoTip = snap.repoInfo?.branch
          ? `当前 Git 仓库：${snap.repoInfo.name || repoLabel}（分支 ${snap.repoInfo.branch}）`
          : `当前工作区仓库：${repoLabel}`;
        repoChip.setAttribute('title', formatZh(repoTip));
      } else {
        repoChip.classList.add('hidden');
        setText(repoChip, '');
      }
    }
    const branchBadge = $('conv-branch-badge');
    if (branchBadge) {
      const br = snap.branchInfo;
      if (br?.isBranch) {
        branchBadge.classList.remove('hidden');
        const kindLabel = br.kind ? `/${br.kind} 分支` : '/btw 分支';
        setText(branchBadge, kindLabel);
        const dedup = Number(br.deduplicatedStepsCount || 0);
        const forkPart = br.forkStepIndex != null ? `Step ${br.forkStepIndex}` : '历史节点';
        const parentPart = br.parentConvId ? `父会话 ${String(br.parentConvId).slice(0, 8)} 的 ` : '';
        branchBadge.setAttribute(
          'title',
          formatZh(`从${parentPart}${forkPart}分叉，全局统计已自动去重 ${fmtInt(dedup)} 步前置历史`)
        );
      } else {
        branchBadge.classList.add('hidden');
        setText(branchBadge, '');
        branchBadge.setAttribute('title', '');
      }
    }
    setText(
      'conv-live-steps',
      `${fmtInt(audit.turnsCount || 0)} 轮响应 · ${fmtInt(audit.totalSteps || 0)} 步 · ${fmtInt(audit.toolCallsCount || 0)} 次工具`
    );

    const budgetChip = $('ctx-budget-chip');
    if (budgetChip) {
      if (win.budget) {
        setText(budgetChip, `上限 ${fmtTokens(win.budget)}`);
        budgetChip.setAttribute('title', `服务端实时下发的当前模型自动压缩阈值（${fmtInt(win.budget)} Tokens）`);
      } else if (win.used === null) {
        setText(budgetChip, '上限待同步');
        budgetChip.setAttribute('title', '待首轮模型响应后同步服务端窗口上限');
      } else {
        setText(budgetChip, '上限未记录');
        budgetChip.setAttribute('title', '本地归档未记录该轮模型的服务端窗口上限');
      }
    }

    const healthPct = win.serverBudget ? win.serverPct : pct;

    // Health status pill
    const pill = $('ctx-health-pill');
    if (pill) {
      let cls = 'good';
      let label = '运行健康';
      if (err.kind && err.kind !== 'none') {
        cls = err.kind === 'canceled' ? 'neutral' : 'danger';
        label = err.badgeText || err.title || '异常';
      } else if (win.used === null) {
        cls = 'neutral';
        label = '待首轮请求';
      } else if (pct === null) {
        cls = 'neutral';
        label = '容量未知';
      } else if (pct >= 90) {
        cls = 'danger';
        label = '临近上限';
      } else if (pct >= 75) {
        cls = 'warn';
        label = '占用偏高';
      }
      pill.className = `status-pill ${cls}`;
      setText(pill, label);
    }

    // Hero circular gauge (r = 35 => C = 219.91)
    const circum = 219.91;
    setText('ctx-pct-big', pct !== null ? `${pct.toFixed(1)}%` : '--%');
    setText('ctx-gauge-sub', win.budget ? '预算占比' : '上限未知');

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
      const pendNote = ctx.pendingTokens > 0 ? ` · 待发 ~${fmtTokens(ctx.pendingTokens, 1)}` : '';
      const hasPromptBase = typeof ctx.promptUsed === 'number' && Number.isFinite(ctx.promptUsed) && ctx.promptUsed > 0;
      const hasNextMin = typeof ctx.projectedNextMin === 'number' && Number.isFinite(ctx.projectedNextMin) && ctx.projectedNextMin > 0;
      const hasDeltaTail = (ctx.outputTokens > 0 || ctx.pendingTokens > 0) && hasPromptBase;
      const nextMinVal = hasNextMin
        ? ctx.projectedNextMin
        : (hasPromptBase ? ctx.promptUsed + Number(ctx.outputTokens || 0) + Number(ctx.pendingTokens || 0) : null);
      const subText = `入 ${fmtTokens(ctx.inputTokens || 0, 1)} · 缓 ${fmtTokens(ctx.cacheTokens || 0, 1)}${pendNote}`;
      setText('ctx-used-sub', subText);
      if (usedSubEl) {
        if (hasDeltaTail && nextMinVal && nextMinVal > ctx.promptUsed) {
          const pctPart = typeof ctx.projectedNextPercent === 'number' && Number.isFinite(ctx.projectedNextPercent)
            ? `（约 ${ctx.projectedNextPercent.toFixed(1)}%）`
            : '';
          usedSubEl.setAttribute(
            'title',
            formatZh(`本轮 Prompt ${fmtTokens(ctx.promptUsed, 1)} · 含输出 / 待发下轮底数 ${fmtTokens(nextMinVal, 1)}${pctPart}`)
          );
        } else {
          usedSubEl.setAttribute('title', formatZh(subText));
        }
      }
    } else {
      setText('ctx-used-sub', `本地归档约 ${fmtTokens(audit.localTotal?.low || 0, 1)}~${fmtTokens(audit.localTotal?.high || 0, 1)}`);
      usedSubEl?.setAttribute('title', '');
    }

    setText('ctx-budget', win.budget ? fmtTokens(win.budget) : (win.used === null ? '--' : '未知'));
    const budgetSubEl = $('ctx-budget-sub');
    if (win.budget) {
      if (win.remaining !== null && win.budget > 0) {
        const remPct = Math.max(0, 100 - (pct || 0)).toFixed(1);
        setText('ctx-budget-sub', `余 ${fmtTokens(win.remaining, 1)} (${remPct}%)`);
        budgetSubEl?.setAttribute('title', formatZh(`剩余可用 ${fmtTokens(win.remaining)}（${remPct}%）· 服务端实时阈值`));
      } else {
        setText('ctx-budget-sub', '服务端实时阈值');
        budgetSubEl?.setAttribute('title', '服务端实时阈值');
      }
    } else {
      const fallbackBudgetSub = win.used === null ? '待首轮同步' : '本地未记录上限';
      setText('ctx-budget-sub', fallbackBudgetSub);
      budgetSubEl?.setAttribute('title', fallbackBudgetSub);
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
    const sessCacheSubText = sessCachePct !== null
      ? `${sessTurnsCount > 0 ? `${fmtInt(sessTurnsCount)} 轮 · ` : ''}命中 ${fmtTokens(st.cacheTokens || 0, 1)}`
      : (win.used === null ? '等待模型轮次' : '暂无缓存读取');
    setText('ctx-session-cache-sub', sessCacheSubText);
    const sessCacheCell = $('ctx-session-cache-cell');
    if (sessCacheCell) {
      const sessPromptTot = Number(st.inputTokens || 0) + Number(st.cacheTokens || 0);
      const savedNote = Number(ctx.sessionCacheSavingsUSD || 0) > 0
        ? ` · 缓存已省 ${fmtUSD(ctx.sessionCacheSavingsUSD)}`
        : '';
      sessCacheCell.setAttribute(
        'title',
        sessCachePct !== null
          ? formatZh(`当前会话平均缓存命中率 ${sessCachePct.toFixed(1)}%（累计命中 ${fmtInt(st.cacheTokens || 0)} / 提示输入 ${fmtInt(sessPromptTot)} tok${savedNote}）`)
          : '当前会话全部有效轮次的加权平均缓存命中率（累计缓存读取 / 累计提示输入）'
      );
    }

    const roundCachePct = typeof ctx.cacheHitPercent === 'number' && Number.isFinite(ctx.cacheHitPercent)
      ? ctx.cacheHitPercent
      : null;
    const roundCacheEl = $('ctx-cache-rate');
    if (roundCacheEl) {
      roundCacheEl.className = cacheRateClass(roundCachePct);
      setText(roundCacheEl, roundCachePct !== null ? `${roundCachePct.toFixed(1)}%` : '--');
    }
    setText(
      'ctx-cache-sub',
      ctx.cacheTokens ? `命中 ${fmtTokens(ctx.cacheTokens, 1)}` : '缓存读取占比'
    );

    // 3-Segment Context Bar (System / Tools / Messages)
    renderSegmentedBreakdown(ctx, audit);

    // Session Cumulative 4-Dimension Throughput
    setText('cum-cache-overall', st.cacheHitPercent != null ? `累计缓存率 ${st.cacheHitPercent.toFixed(1)}%` : '累计缓存率 --');
    setText('cum-cache-tok', fmtTokens(st.cacheTokens || 0));
    const cumCacheSavedEl = $('cum-cache-saved');
    if (cumCacheSavedEl) {
      const savedUSD = Number(ctx.sessionCacheSavingsUSD || 0);
      if (Number.isFinite(savedUSD) && savedUSD > 0) {
        cumCacheSavedEl.classList.remove('hidden');
        setText(cumCacheSavedEl, `缓存已省 ${fmtUSD(savedUSD)}`);
        cumCacheSavedEl.setAttribute(
          'title',
          formatZh(`较原价输入预计已节省 ${fmtUSD(savedUSD)}（约 ${fmtCNY(savedUSD)}）`)
        );
      } else {
        cumCacheSavedEl.classList.add('hidden');
        setText(cumCacheSavedEl, '');
      }
    }
    setText('cum-input-tok', fmtTokens(st.inputTokens || 0));
    setText('cum-output-tok', fmtTokens(st.outputTokens || 0));
    setText('cum-think-sub', `含思考 ${fmtTokens(st.thinkingTokens || 0, 1)}`);
    setText('cum-total-tok', fmtTokens(st.totalTokens || 0));

    // Takeaway & Error Diagnostics
    const takeaway = $('ctx-takeaway');
    if (takeaway) {
      takeaway.classList.remove('warn', 'danger');
      if (err.kind && err.kind !== 'none') {
        if (err.kind !== 'canceled') takeaway.classList.add('danger');
        setText(takeaway, `${err.title}：${err.detail}`);
      } else if (win.used === null) {
        setText(takeaway, `当前会话（${snap.conversationTitle}）暂无已完成模型轮次；发送消息后自动同步精确窗口占用。`);
      } else if (pct === null) {
        setText(
          takeaway,
          `当前会话已用 ${fmtTokens(win.used)} Token；本地归档未记录该轮模型的服务端窗口上限，暂不推导健康百分比。`
        );
      } else if (pct >= 88) {
        takeaway.classList.add('danger');
        setText(
          takeaway,
          `当前窗口已使用 ${pct.toFixed(1)}%（${fmtTokens(win.used)} / ${fmtTokens(win.budget)}），接近上限阈值，建议适时执行 /compact 或拆分新会话以保持响应速度。`
        );
      } else if (pct >= 72) {
        takeaway.classList.add('warn');
        setText(
          takeaway,
          `当前窗口已使用 ${pct.toFixed(1)}%（${fmtTokens(win.used)} / ${fmtTokens(win.budget)}），缓存命中率 ${ctx.cacheHitPercent ?? 0}%，后续长输出轮次可能触发自动摘要。`
        );
      } else {
        const cacheNote = ctx.cacheHitPercent !== null && ctx.cacheHitPercent >= 50
          ? `缓存命中高达 ${ctx.cacheHitPercent.toFixed(1)}%，显著降低首字延迟与折算成本。`
          : '上下文容量充裕，推理与工具调用处于最佳窗口区间。';
        setText(
          takeaway,
          `会话「${snap.conversationTitle}」窗口健康（已用 ${fmtTokens(win.used)} / ${fmtTokens(win.budget)}）。${cacheNote}`
        );
      }
    }

    // Round & Session API Cost Strip
    setText(
      'ctx-round-cost',
      ctx.isPriced ? `${fmtUSD(ctx.roundCostUSD)}（约 ${fmtCNY(ctx.roundCostUSD)}）` : '--'
    );
    setText(
      'ctx-session-cost',
      ctx.sessionCostUSD > 0 ? `${fmtUSD(ctx.sessionCostUSD)}（约 ${fmtCNY(ctx.sessionCostUSD)}）` : '$0.00'
    );
    const cumSummaryCost = ctx.sessionCostUSD > 0 ? fmtUSD(ctx.sessionCostUSD) : '$0.00';
    setText(
      'cum-summary-chip',
      st.totalTokens > 0
        ? `累计 ${fmtTokens(st.totalTokens, 1)} · ${cumSummaryCost}`
        : `累计 -- · ${cumSummaryCost}`
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
      ctx.latestPromptStartup || null
    );

    // Card 2.8: Top 10 Heavy Context Items
    renderHeavyItemsCard(snap.heavyItems || []);

    // Card 2.9: Compaction History & Summary Drawer
    renderCompactionsCard(snap.compactions || []);

    // Card 3: Server Context Breakdown Details
    renderServerBreakdownCard(ctx.breakdown);

    // Card 4: Technical Audit & Attachments
    renderTechnicalAuditCard(snap);
  }

  function renderSegmentedBreakdown(ctx, audit) {
    let sysTok = 0;
    let skillsTok = 0;
    let toolsTok = 0;
    let msgsTok = 0;
    let isExact = false;

    if (ctx.breakdown?.groups?.length) {
      isExact = true;
      for (const g of ctx.breakdown.groups) {
        if (g.key === 'skills' || g.name === 'Skills') skillsTok += g.tokens || 0;
        else if (g.name === 'System Prompt') sysTok += g.tokens || 0;
        else if (g.name === 'Tools') toolsTok += g.tokens || 0;
        else msgsTok += g.tokens || 0;
      }
    } else if (audit?.groups) {
      const g = audit.groups;
      const mid = (m) => (m ? Math.round(((m.low || 0) + (m.high || 0)) / 2) : 0);
      sysTok = mid(g.system);
      toolsTok = mid(g.definitions) + mid(g.tools);
      msgsTok = mid(g.user) + mid(g.assistant) + mid(g.thinking) + mid(g.summaries) + mid(audit.attachmentTotal);
    }

    const sum = sysTok + skillsTok + toolsTok + msgsTok;
    const pSys = sum > 0 ? ((sysTok + skillsTok) / sum) * 100 : 0;
    const pSysOnly = sum > 0 ? (sysTok / sum) * 100 : 0;
    const pSkills = sum > 0 ? (skillsTok / sum) * 100 : 0;
    const pTools = sum > 0 ? (toolsTok / sum) * 100 : 0;
    const pMsgs = sum > 0 ? Math.max(0, 100 - pSys - pTools) : 0;

    if ($('seg-sys')) $('seg-sys').style.width = `${pSys.toFixed(1)}%`;
    if ($('seg-tools')) $('seg-tools').style.width = `${pTools.toFixed(1)}%`;
    if ($('seg-msgs')) $('seg-msgs').style.width = `${pMsgs.toFixed(1)}%`;

    const leg = $('ctx-seg-legend');
    if (leg) {
      if (sum <= 0) {
        leg.innerHTML = `<span class="muted">${escZh('暂无上下文构成明细')}</span>`;
      } else {
        const items = [
          { label: '系统提示词', tok: sysTok, pct: pSysOnly, col: 'var(--seg-sys-col)' },
          ...(skillsTok > 0 ? [{ label: 'Skills 技能指令', tok: skillsTok, pct: pSkills, col: 'var(--cv-seg-skills-col)' }] : []),
          { label: '工具定义与调用', tok: toolsTok, pct: pTools, col: 'var(--seg-tools-col)' },
          { label: '对话与思考历史', tok: msgsTok, pct: pMsgs, col: 'var(--seg-msgs-col)' }
        ];
        leg.innerHTML = items.map((it) => (
          `<span class="seg-leg-item">` +
          `<i class="seg-dot" style="background:${it.col}"></i>` +
          `<span>${escZh(`${it.label} ${fmtTokens(it.tok, 1)} (${it.pct.toFixed(0)}%)`)}</span>` +
          `</span>`
        )).join('') + (!isExact ? `<span class="muted">${escZh('· 本地启发式占比')}</span>` : '');
      }
    }
  }

  function renderSpeedCard(spd, ctx, sparkline, quotaStatus = null) {
    setText('speed-source-tag', spd?.isServerExact ? '服务端精确计时' : '归档时间戳估算');
    setText(
      'sp-avg-peak-chip',
      spd?.avgTps != null
        ? `均值 ${spd.avgTps} · 峰值 ${spd.peakTps ?? spd.avgTps} tok/s`
        : '均值 -- · 峰值 --'
    );

    const pill = $('speed-pill');
    if (pill) {
      if (!spd || (spd.tps === null && spd.duration === null)) {
        pill.className = 'status-pill neutral';
        setText(pill, '待生成');
      } else if ((spd.tps || 0) >= 65) {
        pill.className = 'status-pill good';
        setText(pill, '极速响应');
      } else if ((spd.tps || 0) >= 28) {
        pill.className = 'status-pill good';
        setText(pill, '输出流畅');
      } else {
        pill.className = 'status-pill warn';
        setText(pill, spd.thinkingTokens > spd.responseTokens ? '深度思考轮次' : '平稳生成');
      }
    }

    setText('sp-tps', spd?.tps != null ? `${spd.tps} tok/s` : '--');
    const hasEffTpsGap = Boolean(spd?.effectiveTps > 0 && (!(spd.tps > 0) || Math.abs(spd.effectiveTps - spd.tps) / spd.tps >= 0.2));
    const streamTpsText = spd?.streamingTps != null
      ? (hasEffTpsGap ? `流式峰值 ${spd.streamingTps} · 整请求 ${spd.effectiveTps} tok/s` : `流式峰值 ${spd.streamingTps} tok/s`)
      : (hasEffTpsGap ? `整请求有效 ${spd.effectiveTps} tok/s` : '流式峰值 --');
    setText('sp-stream-tps', streamTpsText);
    setText('sp-dur', spd?.duration != null ? fmtSec(spd.duration) : '--');
    setText('sp-stream-sec', spd?.streamingSec != null ? `流传输 ${fmtSec(spd.streamingSec)}` : '流传输 --');
    setText('sp-ttft', spd?.ttft != null ? fmtSec(spd.ttft) : '--');
    setText('sp-out', spd?.outputTokens != null ? `${fmtTokens(spd.outputTokens)} tok` : '--');
    setText(
      'sp-think-sub',
      spd ? `思考 ${fmtTokens(spd.thinkingTokens || 0, 1)} / 正文 ${fmtTokens(spd.responseTokens || 0, 1)}` : '思考 -- / 正文 --'
    );

    if (!spd) {
      setText('sp-takeaway', '当前会话尚无已完成输出轮次，等待首次模型响应后展示速度与首字延迟。');
    } else if (spd.ttft !== null && spd.thinkingTokens > 0) {
      setText(
        'sp-takeaway',
        `首字前推理准备耗时 ${fmtSec(spd.ttft)}（含 ${fmtInt(spd.thinkingTokens)} 思考 Token），正文流式输出 ${fmtInt(spd.responseTokens)} Token，总耗时 ${fmtSec(spd.duration)}。`
      );
    } else {
      setText(
        'sp-takeaway',
        `最近一轮共生成 ${fmtInt(spd.outputTokens || 0)} Token，总耗时 ${fmtSec(spd.duration)}，综合吞吐 ${spd.tps ?? '--'} tok/s。`
      );
    }

    // Active Model Quota Bar
    const qBox = $('ctx-quota-box');
    const q = ctx.quota;
    if (qBox) {
      if (q) {
        qBox.classList.remove('hidden');
        const syncTime = fmtSyncClock(quotaStatus?.lastSuccessAt);
        const staleTag = quotaStatus?.stale
          ? `（缓存${syncTime ? ` · ${syncTime}` : ''}）`
          : (quotaStatus?.summaryStale ? '（摘要降级）' : '');
        setText('ctx-quota-title', `${q.label || '当前模型'} 配额余量${staleTag}`);

        const { p5, pBase, pW, r5, rBase, rW, rAny } = extractQuotaParts(q);

        let valText = '';
        let barPct = null;
        if (p5 !== null && pW !== null) {
          valText = `5h ${p5.toFixed(1)}% · 周 ${pW.toFixed(1)}%`;
          barPct = Math.min(p5, pW);
        } else if (pBase !== null && pW !== null) {
          valText = `基础 ${pBase.toFixed(1)}% · 周 ${pW.toFixed(1)}%`;
          barPct = Math.min(pBase, pW);
        } else if (p5 !== null) {
          valText = `5h ${p5.toFixed(1)}%${r5 ? ` · ${r5}重置` : ''}`;
          barPct = p5;
        } else if (pBase !== null) {
          const rstNote = r5 ? `5h ${r5}重置` : (rBase ? `${rBase}重置` : '');
          valText = `基础 ${pBase.toFixed(1)}%${rstNote ? ` · ${rstNote}` : ''}`;
          barPct = pBase;
        } else if (pW !== null) {
          valText = `周 ${pW.toFixed(1)}%${rW ? ` · ${rW}重置` : ''}`;
          barPct = pW;
        } else {
          valText = `余量未知${rAny ? ` · ${rAny}重置` : ''}`;
          barPct = null;
        }
        setText('ctx-quota-val', valText);

        const bar = $('ctx-quota-bar');
        if (bar) {
          if (barPct !== null) {
            bar.style.width = `${Math.min(100, Math.max(0, barPct))}%`;
            bar.style.background = barPct <= 15
              ? 'var(--danger)'
              : barPct <= 40
                ? 'var(--warn)'
                : 'var(--good)';
          } else {
            bar.style.width = '0%';
            bar.style.background = 'var(--cv-muted)';
          }
        }
      } else {
        qBox.classList.add('hidden');
      }
    }

    // Dual-Line Sparkline SVG (Total Context + Cache Read)
    const sparkWrap = $('spark-wrap');
    const sparkSvg = $('spark-svg');
    if (sparkWrap && sparkSvg) {
      if (sparkline.length >= 2) {
        sparkWrap.classList.remove('hidden');
        const maxTok = Math.max(...sparkline.map((s) => Math.max(Number(s.total || 0), Number(s.cache || 0))), 1);
        setText('spark-meta', `近 ${sparkline.length} 轮 · 峰值 ${fmtTokens(maxTok)}`);

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

  function renderTurnsTimelineCard(turns = [], totalTurnsCount = 0, promptTurns = [], latestPromptStartup = null) {
    const viewMode = state.turnsView === 'prompts' ? 'prompts' : 'steps';
    const effectiveTurnsCount = Number(totalTurnsCount || turns.length || 0);
    const coldBadge = $('turns-cold-badge');
    if (coldBadge) {
      const isLatestCold = latestPromptStartup?.state === 'cold' && effectiveTurnsCount > 1;
      coldBadge.classList.toggle('hidden', !isLatestCold);
      if (isLatestCold) {
        const pctStr = latestPromptStartup?.cacheHitPercent != null && Number.isFinite(Number(latestPromptStartup.cacheHitPercent))
          ? `${Math.round(Number(latestPromptStartup.cacheHitPercent))}%`
          : '0%';
        setText(coldBadge, `本 Prompt 首跳冷启动 ${pctStr}`);
        coldBadge.setAttribute(
          'title',
          formatZh(`最新 Prompt #P${latestPromptStartup.promptIndex || '?'} 首步缓存命中率仅 ${pctStr}（触发冷启动）`)
        );
      }
    }

    $('turns-filter-seg')?.classList.toggle('hidden', viewMode === 'prompts');
    $('prompt-filter-seg')?.classList.toggle('hidden', viewMode !== 'prompts');

    const listEl = $('turns-timeline');
    if (!listEl) return;

    if (viewMode === 'prompts') {
      const safePrompts = Array.isArray(promptTurns) ? promptTurns : [];
      setText('turns-count-chip', `${fmtInt(safePrompts.length)} 组 Prompt`);
      setText('turns-toolbar-desc', '按用户输入分组，诊断每轮冷 / 热启动缓存命中、调用次数与上下文增量');

      const filteredPrompts = state.promptTurnsFilter === 'cold'
        ? safePrompts.filter((p) => p?.startupState === 'cold')
        : safePrompts;

      if (!filteredPrompts.length) {
        const emptyMsg = safePrompts.length > 0
          ? '当前筛选条件下没有匹配的 Prompt 轮次'
          : '暂无按 Prompt 分组的轮次记录';
        listEl.innerHTML = `<div class="kv-row"><span class="muted">${escZh(emptyMsg)}</span></div>`;
        return;
      }

      listEl.innerHTML = filteredPrompts.map((p) => {
        const st = p.startupState;
        const pctNum = p.startupCacheHitPercent != null && Number.isFinite(Number(p.startupCacheHitPercent))
          ? Math.round(Number(p.startupCacheHitPercent))
          : null;
        const pctSuffix = pctNum !== null ? ` ${pctNum}%` : '';
        let startupPillHtml = `<span class="startup-pill neutral">${escZh('首轮')}</span>`;
        if (st === 'hot') {
          startupPillHtml = `<span class="startup-pill hot" title="首步缓存高度命中">${escZh(`热启动${pctSuffix}`)}</span>`;
        } else if (st === 'warm') {
          startupPillHtml = `<span class="startup-pill warm" title="首步部分命中缓存">${escZh(`部分缓存${pctSuffix}`)}</span>`;
        } else if (st === 'cold') {
          startupPillHtml = `<span class="startup-pill cold" title="首步缓存未命中或偏低（冷启动）">${escZh(`冷启动${pctSuffix}`)}</span>`;
        }

        const delta = Number(p.deltaTokens || 0);
        const sign = delta >= 0 ? '+' : '-';
        const deltaCls = delta < -1000 ? 'compact' : delta >= 8000 ? 'spike' : '';
        const deltaStr = `${sign}${fmtTokens(Math.abs(delta), 1)}`;
        const timeStr = fmtLocalTime(p.createdAt);
        const previewText = p.promptPreview ? String(p.promptPreview) : '（无用户输入摘要）';
        const fullText = p.promptFull ? String(p.promptFull) : previewText;

        const modelChip = p.model ? `<span class="turn-chip">${esc(p.model)}</span>` : '';
        const speedParts = [];
        if (p.ttft != null) speedParts.push(`首字 ${p.ttft}s`);
        if (p.avgTps != null) speedParts.push(`均速 ${p.avgTps} tok/s`);
        const speedChip = speedParts.length
          ? `<span class="turn-chip speed">${escZh(speedParts.join(' · '))}</span>`
          : '';
        const costChip = p.costUSD > 0
          ? `<span class="turn-chip cost" title="本轮 Prompt 累计 API 等值参考">${esc(fmtUSD(p.costUSD))}</span>`
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
          `<span class="turn-chip">${escZh(`${fmtInt(p.callsCount || 0)} 次调用`)}</span>` +
          `</span>` +
          `<span class="turn-ctx-group">` +
          `<span class="turn-ctx-num">${esc(`${fmtInt(p.endTokens || 0)} tok`)}</span>` +
          `<span class="delta-tag ${deltaCls}" title="较上一组 Prompt 结束窗口变化">${esc(deltaStr)}</span>` +
          `</span>` +
          `</div>` +
          `<div class="prompt-preview-line" title="${esc(fullText)}">${esc(previewText)}</div>` +
          `<div class="turn-meta-row">` +
          (timeStr ? `<span>${esc(timeStr)}</span><span>·</span>` : '') +
          `<span>${escZh(`输出 ${fmtTokens(p.outputTokens || 0, 1)}`)}</span>` +
          modelChip +
          speedChip +
          costChip +
          toolsHtml +
          `</div>` +
          `</div>`
        );
      }).join('');
      return;
    }

    setText('turns-count-chip', `${fmtInt(totalTurnsCount || turns.length)} 轮`);
    setText('turns-toolbar-desc', '倒序展示最近 40 轮上下文涨跌（Δ）、缓存率、单轮耗时与调用工具');

    let filtered = turns;
    if (state.turnsFilter === 'spike') {
      filtered = turns.filter((t) => Math.abs(t.deltaTokens || 0) >= 5000);
    } else if (state.turnsFilter === 'tools') {
      filtered = turns.filter((t) => Array.isArray(t.tools) && t.tools.length > 0);
    }

    if (!filtered.length) {
      const emptyMsg = turns.length > 0
        ? '当前筛选条件下没有匹配的轮次'
        : '暂无已完成轮次记录';
      listEl.innerHTML = `<div class="kv-row"><span class="muted">${escZh(emptyMsg)}</span></div>`;
      return;
    }

    listEl.innerHTML = filtered.map((t) => {
      const delta = Number(t.deltaTokens || 0);
      const sign = delta >= 0 ? '+' : '-';
      const deltaCls = delta < -1000 ? 'compact' : delta >= 8000 ? 'spike' : '';
      const deltaStr = `${sign}${fmtTokens(Math.abs(delta), 1)}`;
      const timeStr = fmtLocalTime(t.createdAt);
      const stepLabel = t.stepIndex != null ? ` · Step ${t.stepIndex}` : '';
      const thinkPct = t.thinkingTokens > 0 && t.outputTokens > 0
        ? ` · ${Math.round((t.thinkingTokens / t.outputTokens) * 100)}%`
        : '';
      const thinkSub = t.thinkingTokens > 0 ? `（思 ${fmtTokens(t.thinkingTokens, 1)}${thinkPct}）` : '';

      const costChip = t.isPriced && t.costUSD > 0
        ? `<span class="turn-chip cost" title="单轮 API 等值参考">${esc(fmtUSD(t.costUSD))}</span>`
        : '';
      const ttftSub = t.ttft != null ? ` · 首字 ${t.ttft}s` : (t.duration != null ? ` · ${t.duration}s` : '');
      const hasTurnEffGap = Boolean(t.effectiveTps > 0 && (!(t.tps > 0) || Math.abs(t.effectiveTps - t.tps) / t.tps >= 0.2));
      const effSub = hasTurnEffGap ? ` · 整请求 ${t.effectiveTps}` : '';
      const speedChip = t.tps != null
        ? `<span class="turn-chip speed">${esc(`${t.tps} tok/s${ttftSub}${effSub}`)}</span>`
        : (hasTurnEffGap ? `<span class="turn-chip speed">${esc(`整请求 ${t.effectiveTps} tok/s${ttftSub}`)}</span>` : '');
      const modelChip = t.model && t.model !== '未记录模型'
        ? `<span class="turn-chip">${esc(t.model)}</span>`
        : '';
      const toolsHtml = (t.tools || []).map((toolName) =>
        `<span class="turn-chip tool">${esc(toolName)}</span>`
      ).join('');

      return (
        `<div class="turn-item">` +
        `<div class="turn-top">` +
        `<span class="turn-idx">${escZh(`第 #${t.turnIndex} 轮${stepLabel}`)}</span>` +
        `<span class="turn-ctx-group">` +
        `<span class="turn-ctx-num">${esc(`${fmtInt(t.totalTokens)} tok`)}</span>` +
        `<span class="delta-tag ${deltaCls}" title="较上一轮上下文窗口变化">${esc(deltaStr)}</span>` +
        `</span>` +
        `</div>` +
        `<div class="turn-meta-row">` +
        (timeStr ? `<span>${esc(timeStr)}</span><span>·</span>` : '') +
        `<span>${escZh(`缓存 ${t.cacheHitPercent ?? 0}%`)}</span>` +
        `<span>·</span>` +
        `<span>${escZh(`入 ${fmtTokens(t.inputTokens, 1)} / 出 ${fmtTokens(t.outputTokens, 1)}${thinkSub}`)}</span>` +
        modelChip +
        costChip +
        speedChip +
        toolsHtml +
        `</div>` +
        `</div>`
      );
    }).join('');
  }

  function renderHeavyItemsCard(heavyItems = []) {
    const card = $('heavy-card');
    const list = $('heavy-items-list');
    if (!card || !list) return;

    const items = Array.isArray(heavyItems) ? heavyItems.filter(Boolean).slice(0, 10) : [];
    if (!items.length) {
      card.classList.add('hidden');
      setText('heavy-count-chip', '0 项');
      list.innerHTML = '';
      return;
    }

    card.classList.remove('hidden');
    const sumTok = items.reduce((acc, it) => acc + Number(it.estTokens || 0), 0);
    setText('heavy-count-chip', `${items.length} 项 · 约 ${fmtTokens(sumTok, 1)}`);

    const kindMap = {
      tool: { text: '工具', cls: 'tool' },
      user: { text: '用户', cls: 'user' },
      assistant: { text: '回复', cls: 'assistant' },
      thinking: { text: '思考', cls: 'thinking' },
      checkpoint: { text: '摘要', cls: 'checkpoint' }
    };
    const maxTok = Math.max(...items.map((it) => Number(it.estTokens || 0)), 1);

    list.innerHTML = items.map((it, idx) => {
      const rank = it.rank ?? (idx + 1);
      const km = kindMap[it.kind] || { text: it.kind || '其他', cls: 'other' };
      const estTok = Number(it.estTokens || 0);
      const sharePct = it.sharePercent != null && Number.isFinite(Number(it.sharePercent))
        ? Number(it.sharePercent)
        : null;
      const barW = Math.max(2, Math.min(100, (estTok / maxTok) * 100)).toFixed(1);
      const stepNote = it.stepIndex != null ? `Step ${it.stepIndex}` : '';
      const charsNote = it.chars > 0 ? `${fmtInt(it.chars)} 字符` : '';
      const metaTip = [stepNote, charsNote].filter(Boolean).join(' · ');
      const shareStr = sharePct !== null ? ` (${sharePct.toFixed(1)}%)` : '';
      const preview = it.preview ? String(it.preview).trim() : '';

      return (
        `<div class="heavy-item" title="${escZh(metaTip)}">` +
        `<div class="heavy-item-top">` +
        `<span class="heavy-left">` +
        `<span class="heavy-rank num">#${esc(rank)}</span>` +
        `<span class="heavy-kind-tag ${km.cls}">${escZh(km.text)}</span>` +
        `<span class="heavy-label" title="${esc(it.label || '')}">${esc(it.label || '未命名步骤')}</span>` +
        `</span>` +
        `<span class="heavy-val num-strong">${escZh(`~${fmtTokens(estTok, 1)} tok${shareStr}`)}</span>` +
        `</div>` +
        `<div class="heavy-bar-track"><div class="heavy-bar-fill ${km.cls}" style="width:${barW}%"></div></div>` +
        (preview ? `<div class="heavy-preview" title="${esc(preview)}">${esc(preview)}</div>` : '') +
        `</div>`
      );
    }).join('');
  }

  function renderServerBreakdownCard(bd) {
    const card = $('breakdown-card');
    const list = $('breakdown-groups');
    if (!card || !list) return;

    if (!bd?.groups?.length) {
      card.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');
    const nameMap = {
      'System Prompt': 'System Prompt（系统提示词与规则）',
      'Skills': 'Skills 技能指令',
      'Tools': 'Tools（MCP 与内置工具定义）',
      'Chat Messages': 'Chat Messages（对话消息、思考与工具结果）'
    };
    const total = Math.max(1, bd.totalTokens || bd.groups.reduce((a, g) => a + (g.tokens || 0), 0));
    const calibNote = bd.calibrated
      ? `<div class="bd-calib-note">${escZh(`按实测输入比例校准（原始估算 ${fmtInt(bd.reportedTotalTokens || total)} → 实测 ${fmtInt(total)} tok）`)}</div>`
      : '';

    list.innerHTML = calibNote + bd.groups.map((g) => {
      const pct = (((g.tokens || 0) / total) * 100).toFixed(1);
      const isSkills = g.key === 'skills' || g.name === 'Skills';
      const rawChildren = g.children || g.topChildren || [];
      const children = rawChildren.slice(0, 18).map((c) =>
        `<span class="bd-chip">${esc(c.name)} · ${fmtInt(c.tokens)}</span>`
      ).join('');
      const totalChildCount = g.childrenCount || rawChildren.length;
      const moreCount = Math.max(0, totalChildCount - 18);
      const moreChip = moreCount > 0 ? `<span class="bd-chip muted">+${moreCount} 项</span>` : '';
      return (
        `<div class="bd-group${isSkills ? ' is-skills' : ''}">` +
        `<div class="bd-head"><span>${escZh(nameMap[g.name] || g.label || g.name)}</span>` +
        `<span class="num">${escZh(`${fmtInt(g.tokens)} tok (${pct}%)`)}</span></div>` +
        (children ? `<div class="bd-children">${children}${moreChip}</div>` : '') +
        `</div>`
      );
    }).join('');
  }

  function renderTechnicalAuditCard(snap) {
    const ctx = snap.context || {};
    const audit = snap.audit || {};

    const reqRows = [
      ['会话标题', snap.conversationTitle || '--'],
      ['会话 ID', snap.conversationId || '--'],
      ['当前模型', ctx.model || '--'],
      ['输入 Token（未命中缓存）', fmtInt(ctx.inputTokens)],
      ['缓存读取 Token（优惠计费）', fmtInt(ctx.cacheTokens)],
      ['输出总 Token', fmtInt(ctx.outputTokens)],
      ['其中：推理思考 / 可见回复', `${fmtInt(ctx.thinkingTokens)} / ${fmtInt(ctx.responseTokens)}`],
      ['服务端报告总计 / 下轮预估', `${fmtInt(ctx.actual)} / ${fmtInt(ctx.estimate)}`],
      ['归档步数 / 模型请求轮数', `${fmtInt(audit.totalSteps)} 步 / ${fmtInt(audit.turnsCount)} 轮`],
      ['累计工具调用次数', `${fmtInt(audit.toolCallsCount)} 次`]
    ];
    if (snap.sessionDiagnostics && (snap.sessionDiagnostics.eventsCount > 0 || snap.sessionDiagnostics.routingCount > 0)) {
      const sd = snap.sessionDiagnostics;
      reqRows.push([
        '本会话取证记录',
        `异常 ${fmtInt(sd.eventsCount || 0)} 条 · 灰度路由 ${fmtInt(sd.routingCount || 0)} 次（${sd.sqliteUsed ? 'SQLite' : 'Transcript'}）`
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
      return `${tokRange}（${fmtBytes(m.bytes)}）`;
    };

    const localRows = [
      ['用户输入消息（共 ' + (audit.userMessages || 0) + ' 条）', fmtRange(g.user)],
      ['助手回复正文（共 ' + (audit.assistantMessages || 0) + ' 条）', fmtRange(g.assistant)],
      ['模型思考链归档', fmtRange(g.thinking)],
      ['工具调用入参与返回日志', fmtRange(g.tools)],
      ['检查点压缩摘要', fmtRange(g.summaries)],
      ['系统提示词基准', fmtRange(g.system)],
      ['工具 Schema 定义基准', fmtRange(g.definitions)],
      ['多媒体与文件附件（×引用次数）', fmtRange(audit.attachmentTotal)],
      ['全会话归档内容本地合计', fmtRange(audit.localTotal)]
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
        attEl.innerHTML = `<div class="kv-row"><span class="muted">${escZh('当前会话未检测到图片或文档附件引用')}</span></div>`;
      } else {
        attEl.innerHTML = atts.map((a) => {
          const refTag = (a.references || 1) > 1 ? ` ×${a.references}` : '';
          const dimTag = a.dimensions ? ` · ${a.dimensions}` : '';
          const sizeTag = a.bytes ? ` · ${fmtBytes(a.bytes)}` : '';
          const tokStr = a.status === 'parsed'
            ? (a.low === a.high ? `约 ${fmtInt(a.low)} tok` : `${fmtInt(a.low)}~${fmtInt(a.high)} tok`)
            : `未知（${a.note || '未按 0 计'}）`;
          return (
            `<div class="att-item">` +
            `<div><div class="att-name">${esc(a.name)}${esc(refTag)}</div>` +
            `<div class="att-meta">${escZh(`${a.kind || '文件'}${dimTag}${sizeTag}`)}</div></div>` +
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

    const models = Array.isArray(ctx?.sessionModels)
      ? ctx.sessionModels.filter(Boolean)
      : deriveSessionModelsFallback(ctx, turns);

    if (!models.length) {
      wrap.classList.add('hidden');
      setText('ctx-session-models-count', '0 个模型');
      list.innerHTML = '';
      return;
    }

    wrap.classList.remove('hidden');
    setText('ctx-session-models-count', `${fmtInt(models.length)} 个模型`);
    setText(
      'ctx-session-models-hint',
      models.length === 1
        ? `共 ${fmtInt(models[0].turnsCount || 0)} 轮 · 单模型均值`
        : '按消耗排序 · 模型级平均缓存'
    );

    list.innerHTML = models.map((m) => {
      const pct = typeof m.cacheHitPercent === 'number' && Number.isFinite(m.cacheHitPercent)
        ? m.cacheHitPercent
        : null;
      const rateCls = pct === null ? '' : (pct >= 70 ? 'good-text' : pct >= 30 ? 'accent-text' : 'warn-text');
      const barCol = pct === null ? 'var(--cv-muted)' : (pct >= 70 ? 'var(--good)' : pct >= 30 ? 'var(--cv-accent)' : 'var(--warn)');
      const barW = pct !== null ? Math.min(100, Math.max(2, pct)) : 0;
      const promptTot = Number(m.inputTokens || 0) + Number(m.cacheTokens || 0);
      const curTag = m.isCurrent ? `<span class="session-model-cur">${escZh('当前')}</span>` : '';
      const variantsNote = Array.isArray(m.variants) && m.variants.length
        ? `（含档位：${m.variants.join(' / ')}）`
        : '';
      const tipParts = [
        `${m.displayName || '未记录模型'}${variantsNote}`,
        `${fmtInt(m.turnsCount || 0)} 轮`,
        pct !== null ? `平均缓存命中 ${pct.toFixed(1)}%` : '无缓存数据',
        `缓存 ${fmtTokens(m.cacheTokens || 0, 1)} / 新增输入 ${fmtTokens(m.inputTokens || 0, 1)} / 输出 ${fmtTokens(m.outputTokens || 0, 1)}`,
        m.avgTps != null ? `均速 ${m.avgTps} tok/s` : '',
        m.costUSD > 0 ? `折算 ${fmtUSD(m.costUSD)}` : '',
        m.cacheSavingsUSD > 0 ? `缓存省 ${fmtUSD(m.cacheSavingsUSD)}` : ''
      ].filter(Boolean);

      return (
        `<div class="session-model-row${m.isCurrent ? ' is-current' : ''}" title="${escZh(tipParts.join(' · '))}">` +
        `<div class="session-model-top">` +
        `<span class="session-model-left">` +
        `<span class="session-model-name">${esc(m.displayName || '未记录模型')}</span>` +
        curTag +
        `<span class="turn-chip">${escZh(`${fmtInt(m.turnsCount || 0)} 轮`)}</span>` +
        `</span>` +
        `<span class="session-model-right">` +
        `<span class="session-model-tok num">${escZh(`命中 ${fmtTokens(m.cacheTokens || 0, 1)} / ${fmtTokens(promptTot, 1)}`)}</span>` +
        `<span class="session-model-rate ${rateCls}">${esc(pct !== null ? `${pct.toFixed(1)}%` : '--')}</span>` +
        `</span>` +
        `</div>` +
        `<div class="thin-track xs"><div class="thin-fill" style="width:${barW.toFixed(1)}%;background:${barCol}"></div></div>` +
        `</div>`
      );
    }).join('');
  }

  function renderAgentTreeCard(agentTree) {
    const card = $('agent-tree-card');
    const list = $('agent-tree-list');
    if (!card || !list) return;

    if (!agentTree) {
      card.classList.add('hidden');
      setText('agent-tree-chip', '0 个子代理');
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
        titleEl.setAttribute('title', formatZh(`Swarm 协作任务：${swarmTitle}`));
      } else {
        titleEl.classList.add('hidden');
        setText(titleEl, '');
      }
    }

    const chipEl = $('agent-tree-chip');
    setText('agent-tree-chip', `含 ${fmtInt(childrenCount)} 个子代理 · 总计 ${fmtTokens(totTokens, 1)} · ${fmtUSD(totCost)}`);
    if (chipEl) {
      const tipParts = [
        agentTree.isSwarm && agentTree.swarmTitle ? `Swarm：${agentTree.swarmTitle}` : '',
        `活跃 ${fmtInt(activeCount)} / 共 ${fmtInt(childrenCount)} 个子代理`,
        `整树 ${fmtInt(totTurns)} 轮`
      ].filter(Boolean);
      chipEl.setAttribute('title', formatZh(tipParts.join(' · ')));
    }

    setText('agent-tree-total-tok', fmtTokens(totTokens));
    setText(
      'agent-tree-total-sub',
      `${fmtInt(totTurns)} 轮 · 入 ${fmtTokens(totals.inputTokens || 0, 1)} / 缓 ${fmtTokens(totals.cacheTokens || 0, 1)}`
    );
    setText('agent-tree-total-cost', fmtUSD(totCost));
    setText('agent-tree-total-cny', `约 ${fmtCNY(totCost)}`);
    setText('agent-tree-cache-saved', fmtUSD(totSaved));
    setText('agent-tree-cache-sub', totSaved > 0 ? `约 ${fmtCNY(totSaved)}` : `缓存 ${fmtTokens(totals.cacheTokens || 0, 1)}`);

    if (!children.length) {
      list.innerHTML = `<div class="kv-row"><span class="muted">${escZh('当前暂无子代理执行明细')}</span></div>`;
      return;
    }

    const stateMap = {
      working: { text: '运行中', cls: 'good' },
      running: { text: '运行中', cls: 'good' },
      active: { text: '运行中', cls: 'good' },
      waiting: { text: '待命', cls: 'neutral' },
      idle: { text: '待命', cls: 'neutral' },
      done: { text: '已完成', cls: 'good' },
      completed: { text: '已完成', cls: 'good' },
      stopped: { text: '已停止', cls: 'neutral' },
      killed: { text: '已结束', cls: 'neutral' },
      error: { text: '异常', cls: 'danger' },
      failed: { text: '失败', cls: 'danger' }
    };

    list.innerHTML = children.map((c) => {
      const name = c.name || (c.id ? String(c.id).slice(0, 8) : '未命名子代理');
      const roleChip = c.role ? `<span class="turn-chip">${escZh(c.role)}</span>` : '';
      const rawState = String(c.state || '').toLowerCase();
      const stInfo = stateMap[rawState] || { text: c.state || '未知', cls: 'neutral' };
      const modelChip = c.model ? `<span class="turn-chip">${esc(c.model)}</span>` : '';
      const savedHtml = Number(c.cacheSavingsUSD || 0) > 0
        ? `<span class="good-text">${escZh(`省 ${fmtUSD(c.cacheSavingsUSD)}`)}</span>`
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
        `<span>${escZh(`${fmtInt(c.turnsCount || 0)} 轮`)}</span>` +
        modelChip +
        savedHtml +
        `</div>` +
        `</div>`
      );
    }).join('');
  }

  function renderCompactionsCard(compactions = []) {
    const card = $('compactions-card');
    const list = $('compactions-list');
    if (!card || !list) return;

    const items = Array.isArray(compactions) ? compactions.filter(Boolean) : [];
    if (!items.length) {
      card.classList.add('hidden');
      setText('compactions-count-chip', '0 次压缩');
      list.innerHTML = '';
      return;
    }

    card.classList.remove('hidden');
    const totalSaved = items.reduce((acc, c) => acc + Number(c.savedTokens || 0), 0);
    setText('compactions-count-chip', `${fmtInt(items.length)} 次压缩`);
    $('compactions-count-chip')?.setAttribute(
      'title',
      formatZh(`累计释放约 ${fmtTokens(totalSaved, 1)} Token 上下文窗口`)
    );

    list.innerHTML = items.map((c, idx) => {
      const cIdx = c.index ?? (items.length - idx);
      const beforeTok = Number(c.beforeTokens || 0);
      const afterTok = Number(c.afterTokens || 0);
      const savedTok = Number(c.savedTokens ?? Math.max(0, beforeTok - afterTok));
      const savedPct = c.savedPercent != null && Number.isFinite(Number(c.savedPercent))
        ? Number(c.savedPercent)
        : (beforeTok > 0 ? (savedTok / beforeTok) * 100 : 0);
      const timeStr = fmtLocalTime(c.createdAt);
      const stepStr = c.stepIndex != null ? `Step ${c.stepIndex}` : '';
      const preview = c.summaryPreview ? String(c.summaryPreview).trim() : '（点击展开查看压缩摘要原文）';
      const full = c.summaryFull ? String(c.summaryFull) : preview;

      return (
        `<div class="compaction-item">` +
        `<div class="compaction-top">` +
        `<span class="turn-top-left">` +
        `<span class="turn-idx">${esc(`#C${cIdx}`)}</span>` +
        `<span class="num">${esc(`${fmtTokens(beforeTok, 1)} → ${fmtTokens(afterTok, 1)}`)}</span>` +
        `</span>` +
        `<span class="delta-tag compact" title="${escZh(`本次释放 ${fmtInt(savedTok)} Token`)}">${esc(`-${fmtTokens(savedTok, 1)} (-${savedPct.toFixed(0)}%)`)}</span>` +
        `</div>` +
        `<div class="compaction-meta">` +
        (timeStr ? `<span>${esc(timeStr)}</span>` : '') +
        (timeStr && stepStr ? `<span>·</span>` : '') +
        (stepStr ? `<span>${esc(stepStr)}</span>` : '') +
        `</div>` +
        `<details class="compaction-details">` +
        `<summary class="compaction-summary-toggle"><span class="compaction-preview-text">${esc(preview)}</span></summary>` +
        `<pre class="compaction-summary">${esc(full)}</pre>` +
        `</details>` +
        `</div>`
      );
    }).join('');
  }

  // -------------------------------------------------------------------------
  // TAB 2: Token History & Interactive Multi-View Charts
  // -------------------------------------------------------------------------

  function renderHistoryPanel(hist) {
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
    const cliExtra = srcKey === 'cli' && !hist.sources?.cli?.dirExists ? '（尚未生成 CLI 归档）' : '';
    setText(
      'hist-source-meta',
      `${fmtInt(srcMeta.conversationsCount || 0)} 个会话 · ${fmtInt(srcMeta.transcriptsCount || 0)} 份日志${cliExtra}`
    );

    // 4 KPI Cards
    setText('kpi-total', fmtTokens(s.grandTotalTokens));
    setText('kpi-total-sub', `活跃 ${s.activeDaysCount} 天 · ${fmtInt(s.totalSteps)} 次请求`);
    setText('kpi-total-cost', `折算 ${fmtUSD(cAll.totalCostUSD)}（${fmtCNY(cAll.totalCostUSD)}）`);

    setText('kpi-today', fmtTokens(s.todayTokens));
    setText('kpi-today-sub', `今日 ${fmtInt(todayRec.steps)} 次请求`);
    setText('kpi-today-cost', `折算 ${fmtUSD(todayUSD)}（${fmtCNY(todayUSD)}）`);

    const domDayOfMonth = Math.max(1, Number(hist.todayKey?.slice(8, 10) || 1));
    setText('kpi-month', fmtTokens(s.monthTokens));
    setText('kpi-month-sub', `日均 ${fmtTokens(s.monthTokens / domDayOfMonth, 1)} · 活跃 ${s.monthActiveDays} 天`);
    setText('kpi-month-cost', `折算 ${fmtUSD(cMonth.totalCostUSD)}（${fmtCNY(cMonth.totalCostUSD)}）`);

    // Year cost sum from dailyMap
    const yearPrefix = (hist.todayKey || '').slice(0, 4);
    let yearUSD = 0;
    for (const [d, rec] of Object.entries(dailyMap)) {
      if (d.startsWith(yearPrefix)) {
        yearUSD += rec.costUSD > 0 ? rec.costUSD : rec.refCostUSD;
      }
    }
    setText('kpi-year', fmtTokens(s.yearTokens));
    setText('kpi-year-sub', `${yearPrefix} 年活跃 ${s.yearActiveDays} 天`);
    setText('kpi-year-cost', `折算 ${fmtUSD(yearUSD)}（${fmtCNY(yearUSD)}）`);

    setText('first-use-pill', `首次记录：${hist.firstUseDate || hist.todayKey}`);

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
    if (!rec || !rec.total) {
      box.innerHTML =
        `<div class="inspector-main">` +
        `<span><strong>${escZh(title)}</strong></span>` +
        `<span class="muted">${escZh('当日 / 区间无 Token 消耗记录')}</span>` +
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
          mCachePct !== null ? `缓存命中 ${mCachePct.toFixed(1)}%` : '',
          m.steps ? `${fmtInt(m.steps)} 次` : '',
          m.costUSD > 0 ? `约 ${fmtUSD(m.costUSD)}` : ''
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
      `<span><strong>${escZh(title)}</strong> · ${escZh(`总计 ${fmtTokens(rec.total)} (${fmtInt(rec.steps || 0)} 次)`)}</span>` +
      `<span class="muted num">${escZh(`输入 ${fmtTokens(rec.input, 1)} / 缓存 ${fmtTokens(rec.cache, 1)} / 输出 ${fmtTokens(rec.output, 1)} · 约 ${fmtUSD(usd)} (${fmtCNY(usd)})`)}</span>` +
      `</div>` +
      modelsRowHtml;
  }

  function updateSummaryRibbon(stats, planStatus, monthsSpan = 1) {
    setText('sum-tok', fmtTokens(stats.totalTokens));
    setText('sum-cost', `${fmtUSD(stats.costUSD)}（${fmtCNY(stats.costUSD)}）`);
    setText('sum-daily', fmtTokens(stats.calendarDays > 0 ? stats.totalTokens / stats.calendarDays : 0, 1));
    setText('sum-active', stats.activeDays > 0 ? fmtTokens(stats.totalTokens / stats.activeDays, 1) : '0');

    const monthlyUSD = planStatus?.monthlyUSD;
    if (monthlyUSD === 0) {
      setText('sum-ratio', `0 实付 · 省 ${fmtUSD(stats.costUSD)}`);
    } else if (monthlyUSD > 0) {
      const denom = monthlyUSD * Math.max(1, monthsSpan);
      const ratio = stats.costUSD / denom;
      setText('sum-ratio', `月费 ${ratio.toFixed(2)}x 等值`);
    } else {
      setText('sum-ratio', '--');
    }
  }

  function renderDailyHeatmap(dailyMap, hist) {
    const stage = $('chart-stage');
    if (!stage) return;

    const { today, startSun, displayEnd } = computeHeatmapDateWindow(hist.todayKey, state.heatPageOffset);

    const firstDate = parseLocalDate(hist.firstUseDate || hist.todayKey);
    if ($('btn-heat-prev')) $('btn-heat-prev').disabled = startSun <= firstDate;
    if ($('btn-heat-next')) $('btn-heat-next').disabled = state.heatPageOffset <= 0;
    setText('heat-range-label', `${toYmd(startSun)} 至 ${toYmd(displayEnd)}`);

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
            weekMonthLbl = `${m + 1}月`;
            lastMonth = m;
          }
        }
        days.push({ key, isFuture, rec, tot });
        cursor.setDate(cursor.getDate() + 1);
      }
      weeks.push(days);
      monthLabels.push(weekMonthLbl);
    }

    const thresholds = computeQuantileThresholds(windowValues);

    const monthsHtml = monthLabels.map((m) => `<span class="heat-m-lbl">${escZh(m)}</span>`).join('');
    const colsHtml = weeks.map((days) => {
      const cells = days.map((cell) => {
        const lvl = cell.isFuture ? 0 : levelForValue(cell.tot, thresholds);
        const cls = `heat-cell${cell.isFuture ? ' future' : ''}${state.selectedBucketKey === cell.key ? ' selected' : ''}`;
        const tip = cell.isFuture ? cell.key : `${cell.key}：${fmtTokens(cell.tot)}`;
        return `<div class="${cls}" data-lvl="${lvl}" data-day="${cell.key}" title="${escZh(tip)}"></div>`;
      }).join('');
      return `<div class="heat-week">${cells}</div>`;
    }).join('');

    stage.innerHTML =
      `<div class="heatmap-wrap">` +
      `<div class="heat-months-row">${monthsHtml}</div>` +
      `<div class="heat-cols">${colsHtml}</div>` +
      `</div>`;

    // Scroll right to show latest week by default
    if (state.heatPageOffset === 0) {
      requestAnimationFrame(() => { stage.scrollLeft = stage.scrollWidth; });
    }

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

    const inspectKey = state.selectedBucketKey && dailyMap[state.selectedBucketKey]
      ? state.selectedBucketKey
      : hist.todayKey;
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

    renderBarBuckets(stage, buckets, dailyMap, hist, 6);
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
        key: `${ym} 自然月`,
        shortLabel: `${d.getMonth() + 1}月`,
        agg
      });
    }

    renderBarBuckets(stage, buckets, dailyMap, hist, 12);
  }

  function renderBarBuckets(stage, buckets, dailyMap, hist, monthsSpan, opts = {}) {
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
      const showLbl = labelStep === 1 || (idx % labelStep === labelMod) || idx === buckets.length - 1;
      return (
        `<div class="bar-col${idx === defaultIdx ? ' selected' : ''}" data-bidx="${idx}" title="${escZh(`${b.key}：${fmtTokens(b.agg.total)}`)}">` +
        `<div class="bar-pillar" style="height:${hPct.toFixed(1)}%"></div>` +
        `<span class="bar-lbl">${showLbl ? escZh(b.shortLabel) : ''}</span>` +
        `</div>`
      );
    }).join('')}</div>`;

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
      months.push({ m, key: `${year} 年 ${m} 月`, agg });
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
        `<span class="xs muted">${escZh(`${item.m} 月`)}</span>` +
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
    updateSummaryRibbon(
      { totalTokens: yearTok, costUSD: yearCost, calendarDays: 365, activeDays: yearActive },
      hist.planStatus,
      Math.max(1, curMonthIdx + 1)
    );
  }

  function renderCumulativeCurve(dailyMap, hist) {
    const stage = $('chart-stage');
    if (!stage) return;
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
      stage.innerHTML = `<div class="muted xs">${escZh('暂无累计曲线数据')}</div>`;
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
      `<circle id="cum-dot" cx="${last.x}" cy="${last.y}" r="3.5" fill="var(--cv-accent)"/>` +
      `</svg>`;

    const svgEl = $('cum-svg-el');
    const dotEl = $('cum-dot');
    const box = $('day-inspector');
    const showPoint = (pt) => {
      if (!pt || !box) return;
      if (dotEl) {
        dotEl.setAttribute('cx', pt.x);
        dotEl.setAttribute('cy', pt.y);
      }
      const dayTok = pt.dayRec?.total ? `当日 +${fmtTokens(pt.dayRec.total)}` : '当日无新增';
      box.innerHTML =
        `<div class="inspector-main">` +
        `<span><strong>${escZh(`截至 ${pt.key}`)}</strong> · ${escZh(`累计 ${fmtTokens(pt.cumTokens)}`)}</span>` +
        `<span class="muted num">${escZh(`${dayTok} · 累计折算 ${fmtUSD(pt.cumCost)} (${fmtCNY(pt.cumCost)})`)}</span>` +
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
    const dayLabel = dayKey === 'yesterday' ? '昨日' : '今日';
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

    stage.innerHTML = `<div class="bar-chart bar-chart-hourly">${buckets.map((b, idx) => {
      const hPct = b.agg.total > 0 ? Math.max(4, (b.agg.total / maxVal) * 100) : 2;
      const showLbl = idx % 3 === 0 || idx === 23;
      return (
        `<div class="bar-col${idx === defaultIdx ? ' selected' : ''}" data-hidx="${idx}" title="${escZh(`${b.key}：${fmtTokens(b.agg.total)}`)}">` +
        `<div class="bar-pillar" style="height:${hPct.toFixed(1)}%"></div>` +
        `<span class="bar-lbl">${showLbl ? esc(b.shortLabel) : ''}</span>` +
        `</div>`
      );
    }).join('')}</div>`;

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
            shortLabel: multiYear ? `${String(item.dt.getFullYear()).slice(2)}/${mNum}` : `${mNum}月`,
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
          key: `${mo.ym} 自然月`,
          shortLabel: mo.shortLabel,
          agg: mo.agg
        });
      }
    }

    const granLabelMap = { day: '按天', week: '按周', month: '按月' };
    setText(
      'custom-range-meta',
      `共 ${fmtInt(daysList.length)} 天 · 活跃 ${fmtInt(activeDays)} 天 · ${granLabelMap[effectiveGran] || ''} ${fmtInt(buckets.length)} 栏`
    );

    const sumBox = $('custom-range-summary');
    if (sumBox) {
      const rangePrompt = rangeAgg.input + rangeAgg.cache;
      const rangeCachePct = rangePrompt > 0 ? Number(((rangeAgg.cache / rangePrompt) * 100).toFixed(1)) : null;
      const rangeCost = rangeAgg.costUSD > 0 ? rangeAgg.costUSD : rangeAgg.refCostUSD;
      const pillCls = rangeCachePct === null ? 'neutral' : (rangeCachePct >= 70 ? 'good' : rangeCachePct >= 30 ? 'accent' : 'warn');
      const cachePillHtml = rangeCachePct !== null
        ? `<span class="diag-summary-pill ${pillCls}">${escZh(`区间平均缓存 ${rangeCachePct.toFixed(1)}%`)}</span>`
        : `<span class="diag-summary-pill neutral">${escZh('暂无缓存数据')}</span>`;
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
            mCache !== null ? `缓存命中 ${mCache.toFixed(1)}%` : '',
            m.steps ? `${fmtInt(m.steps)} 次` : '',
            m.costUSD > 0 ? `约 ${fmtUSD(m.costUSD)}` : ''
          ].filter(Boolean);
          return (
            `<span class="inspector-model-chip" title="${escZh(tipParts.join(' · '))}">` +
            `<span class="inspector-model-name">${escZh(m.name)}</span>` +
            `<span class="num muted">${escZh(`${fmtTokens(tok, 1)} (${share}%)`)}${mCache !== null ? ` · 缓 ${mCache.toFixed(0)}%` : ''}</span>` +
            `</span>`
          );
        }).join('') + `</div>`;
      }
      sumBox.innerHTML =
        `<div class="custom-sum-head">` +
        `<span><strong>${escZh(`${startYmd} 至 ${endYmd}`)}</strong> · ${escZh(`总计 ${fmtTokens(rangeAgg.total)} (${fmtInt(rangeAgg.steps)} 次请求)`)}</span>` +
        cachePillHtml +
        `</div>` +
        `<div class="custom-sum-meta num">` +
        `<span>${escZh(`输入 ${fmtTokens(rangeAgg.input, 1)} / 缓存 ${fmtTokens(rangeAgg.cache, 1)} / 输出 ${fmtTokens(rangeAgg.output, 1)}`)}</span>` +
        `<span>·</span>` +
        `<span>${escZh(`约 ${fmtUSD(rangeCost)} (${fmtCNY(rangeCost)})`)}</span>` +
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

  function renderDiagnosticsCard(diag) {
    const strip = $('diag-summary-strip');
    const list = $('diagnostics-list');
    if (!strip || !list) return;

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

    setText('diag-source-chip', diag?.sqliteEnabled ? 'SQLite 只读增强' : 'Transcript 模式');
    setText('diag-count-chip', totalAll > 0 ? `共 ${fmtInt(totalAll)} 条` : '运行平稳 · 0 异常');

    const q429 = Number(evSum.quota429 || 0);
    const safetyCnt = Number(evSum.safetyFilter || 0);
    const safetyWaste = Number(evSum.safetyWastedUSD || 0);
    const retryCnt = Number(evSum.upstreamRetry || 0);
    const overflowCnt = Number(evSum.contextOverflow || 0);

    const pills = [
      {
        cls: q429 > 0 ? 'warn' : 'neutral',
        text: `429 限流 ${fmtInt(q429)}`,
        tip: '上游或配额池触发 429 限流次数'
      },
      {
        cls: safetyCnt > 0 ? 'danger' : 'neutral',
        text: `安全过滤 ${fmtInt(safetyCnt)} · 浪费 ${fmtUSD(safetyWaste)}`,
        tip: `安全过滤中断次数及预计浪费折算成本（约 ${fmtCNY(safetyWaste)}）`
      },
      {
        cls: retryCnt > 0 || overflowCnt > 0 ? 'warn' : 'neutral',
        text: `上游重试 ${fmtInt(retryCnt)}`,
        tip: overflowCnt > 0 ? `上游重试 ${fmtInt(retryCnt)} 次 · 上下文溢出 ${fmtInt(overflowCnt)} 次` : '上游超时或服务波动自动重试次数'
      },
      {
        cls: totalRouting > 0 ? 'accent' : 'neutral',
        text: `灰度路由 ${fmtInt(totalRouting)}`,
        tip: rtSum.uniqueModels > 0 ? `涉及 ${fmtInt(rtSum.uniqueModels)} 个模型路由变化` : '请求模型与实际响应模型不一致的路由记录'
      }
    ];
    strip.innerHTML = pills.map((p) =>
      `<span class="diag-summary-pill ${p.cls}" title="${escZh(p.tip)}">${escZh(p.text)}</span>`
    ).join('');

    const activeTab = state.diagTab === 'routing' ? 'routing' : 'events';
    document.querySelectorAll('#diag-tab-seg .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.dtab === activeTab);
    });

    if (activeTab === 'routing') {
      const routing = Array.isArray(diag?.recentRouting) ? diag.recentRouting.filter(Boolean) : [];
      setText(
        'diag-toolbar-meta',
        rtSum.uniqueModels > 0
          ? `共 ${fmtInt(totalRouting || routing.length)} 次 · 涉及 ${fmtInt(rtSum.uniqueModels)} 个模型`
          : `共 ${fmtInt(totalRouting || routing.length)} 次路由变化`
      );
      if (!routing.length) {
        list.innerHTML = `<div class="kv-row"><span class="muted">${escZh('暂未检测到服务端灰度路由或模型回退记录')}</span></div>`;
        return;
      }
      list.innerHTML = routing.map((r) => {
        const title = r.convTitle || (r.convId ? String(r.convId).slice(0, 8) : '未知会话');
        const stepPart = r.stepIndex != null ? `Step ${r.stepIndex}` : '';
        const timePart = r.date || '--';
        const reasonPart = r.reason ? `<div class="diag-detail">${escZh(r.reason)}</div>` : '';
        return (
          `<div class="diag-item">` +
          `<div class="diag-item-top">` +
          `<span class="diag-item-left">` +
          `<span class="status-pill neutral">${escZh('灰度路由')}</span>` +
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
      }).join('');
      return;
    }

    const events = Array.isArray(diag?.recentEvents) ? diag.recentEvents.filter(Boolean) : [];
    setText(
      'diag-toolbar-meta',
      overflowCnt > 0
        ? `共 ${fmtInt(totalEvents || events.length)} 条异常 · 溢出 ${fmtInt(overflowCnt)}`
        : `共 ${fmtInt(totalEvents || events.length)} 条异常事件`
    );
    if (!events.length) {
      list.innerHTML = `<div class="kv-row"><span class="muted">${escZh('暂未检测到 429 限流、安全过滤或上游重试异常')}</span></div>`;
      return;
    }

    const kindMap = {
      quota_429: { text: '429 限流', cls: 'warn' },
      rate_limit: { text: '429 限流', cls: 'warn' },
      '429': { text: '429 限流', cls: 'warn' },
      safety_filter: { text: '安全过滤', cls: 'danger' },
      safety: { text: '安全过滤', cls: 'danger' },
      upstream_retry: { text: '上游重试', cls: 'warn' },
      retry: { text: '上游重试', cls: 'warn' },
      context_overflow: { text: '上下文溢出', cls: 'danger' },
      overflow: { text: '上下文溢出', cls: 'danger' }
    };

    list.innerHTML = events.map((ev) => {
      const km = kindMap[String(ev.kind || '').toLowerCase()] || { text: ev.kind || '异常事件', cls: 'neutral' };
      const title = ev.convTitle || (ev.convId ? String(ev.convId).slice(0, 8) : '未知会话');
      const timeStr = fmtDiagTime(ev.createdAt, ev.date);
      const stepPart = ev.stepIndex != null ? `Step ${ev.stepIndex}` : '';
      const wastedHtml = Number(ev.wastedUSD || 0) > 0
        ? `<span class="turn-chip cost">${escZh(`浪费 ${fmtUSD(ev.wastedUSD)}`)}</span>`
        : '';
      const retriesHtml = Number(ev.retries || 0) > 0
        ? `<span class="diag-meta-badge warn">${escZh(`重试 ${Number(ev.retries)} 次`)}</span>`
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
    }).join('');
  }

  // -------------------------------------------------------------------------
  // TAB 3: Subscription Plan & API Cost Breakdown
  // -------------------------------------------------------------------------

  function populatePlanPresetsIfNeeded(presets) {
    if (state.presetsPopulated || !presets) return;
    const regSel = $('f-region-preset');
    const acqSel = $('f-acquisition');
    const curSel = $('f-currency');
    if (!regSel || !acqSel || !curSel) return;

    regSel.innerHTML = (presets.regions || []).map((r) =>
      `<option value="${esc(r.id)}">${escZh(`${r.name} · ${r.symbol}${r.monthlyPrice}/月`)}</option>`
    ).join('');

    acqSel.innerHTML = (presets.acquisitions || []).map((a) =>
      `<option value="${esc(a.id)}">${escZh(a.name)}</option>`
    ).join('');

    curSel.innerHTML = (presets.currencies || []).map((c) =>
      `<option value="${esc(c.code)}">${esc(`${c.code} (${c.symbol.trim()})`)}</option>`
    ).join('');

    state.presetsPopulated = true;
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

    // Badge
    const badge = $('plan-tier-badge');
    if (badge) {
      badge.className = `status-pill ${plan.status === 'identified' ? 'good' : 'neutral'}`;
      setText(badge, plan.isCustomized ? '已自定义实付' : (plan.status === 'identified' ? '档位已识别' : '待补充'));
    }

    setText('plan-headline', plan.tierName || '未识别订阅');
    setText(
      'plan-subline',
      plan.isCustomized
        ? `${plan.subscriptionRegionName || '默认美区'} · ${plan.acquisitionLabel || '常规订阅'}`
        : (plan.status === 'identified'
            ? '默认公开参考价 · 家庭组共享 / 拼车点右上角设置'
            : '未连接语言服务识别档位 · 可点右上角手动设置')
    );

    if (plan.monthlyNormalized === 0) {
      setText('plan-price-main', `${plan.symbol || '$'}0 / 月`);
      setText('plan-price-cny', '免额外订阅费（¥0.00）');
    } else if (plan.monthlyNormalized !== null && plan.monthlyNormalized !== undefined) {
      setText('plan-price-main', `${plan.symbol || '$'}${plan.monthlyNormalized} / 月`);
      setText(
        'plan-price-cny',
        plan.isCustomized
          ? `实付折合人民币约 ¥${(plan.monthlyCNY ?? 0).toFixed(2)} / 月`
          : `公开参考约 ¥${(plan.monthlyCNY ?? 0).toFixed(2)} / 月`
      );
    } else {
      setText('plan-price-main', '待指定金额');
      setText('plan-price-cny', plan.priceRangeNote || '--');
    }

    const planRows = [
      ['当前账号（脱敏）', plan.maskedEmail || '本机已登录会话'],
      [
        plan.isCustomized ? '计价地区与周期' : '默认参考基准',
        plan.isCustomized
          ? `${plan.subscriptionRegionName || '--'} · ${plan.billingCycle || '月付'}`
          : `${plan.subscriptionRegionName || '美国 (US)'} 标准价（客户端 API 不返回家庭组与账单实付）`
      ],
      [
        '权益获取渠道',
        plan.isCustomized ? (plan.acquisitionLabel || '--') : '未指定（支持设为家庭组共享 / AA 拼车 / 赠送）'
      ]
    ];
    if (plan.accountCountry && plan.accountCountry !== '自动 / 未设置') {
      planRows.push(['账号归属地备注', plan.accountCountry]);
    }
    if (plan.validUntil) planRows.push(['权益到期日', plan.validUntil]);
    if (plan.note) planRows.push(['本地备注', plan.note]);

    const quotaStatus = hist.quotaStatus || null;
    if (quotaStatus?.stale) {
      const tStr = fmtSyncClock(quotaStatus.lastSuccessAt);
      planRows.push([
        '配额同步状态',
        (quotaStatus.errorCode === 'ECONNREFUSED' || quotaStatus.errorCode === 'ECONNRESET')
          ? `原宿主连接已断开，展示上次缓存${tStr ? `（${tStr} · 重启独立窗口可重新绑定）` : ''}`
          : `语言服务暂不可达，展示上次缓存${tStr ? `（${tStr}）` : ''}`
      ]);
    } else if (quotaStatus?.summaryStale) {
      planRows.push(['配额同步状态', '多窗口配额摘要暂不可用，仅展示基础池']);
    } else if (quotaStatus?.state === 'error') {
      planRows.push(['配额同步状态', quotaStatus.reason || '语言服务请求失败，暂未获取到配额池']);
    } else if (quotaStatus?.state === 'unavailable') {
      planRows.push(['配额同步状态', quotaStatus.reason || '未连接宿主语言服务（当前为离线模式）']);
    }

    const planKv = $('plan-kv');
    if (planKv) {
      planKv.innerHTML = planRows.map(([k, v]) =>
        `<div class="kv-row"><span class="kv-k">${escZh(k)}</span><span class="kv-v">${escZh(v)}</span></div>`
      ).join('');
    }

    // Live Model Quota Pools (5h burst window + Weekly tier/family shared pool)
    const qWrap = $('quota-pools-wrap');
    const qList = $('quota-pools-list');
    const qSyncPill = $('quota-sync-pill');
    if (qSyncPill) {
      if (quotaStatus?.stale) {
        const tStr = fmtSyncClock(quotaStatus.lastSuccessAt);
        qSyncPill.className = 'status-pill warn';
        setText(qSyncPill, `缓存快照${tStr ? ` · ${tStr}` : ''}`);
      } else if (quotaStatus?.summaryStale) {
        qSyncPill.className = 'status-pill warn';
        setText(qSyncPill, '摘要降级');
      } else if (quotaStatus?.state === 'error') {
        qSyncPill.className = 'status-pill danger';
        setText(qSyncPill, '连接失败');
      } else if (quotaStatus?.state === 'unavailable') {
        qSyncPill.className = 'status-pill neutral';
        setText(qSyncPill, '未连接宿主');
      } else {
        qSyncPill.className = 'status-pill warn hidden';
        setText(qSyncPill, '');
      }
    }

    if (qWrap && qList) {
      if (quotas.length > 0) {
        const barColor = (p) => (p <= 15 ? 'var(--danger)' : p <= 40 ? 'var(--warn)' : 'var(--good)');
        const renderQuotaWinBlock = (winTitle, pctVal, resetZh, defaultResetText) => {
          if (isKnownPct(pctVal)) {
            const rStr = resetZh ? `${resetZh} 重置` : defaultResetText;
            const w = Math.min(100, Math.max(0, pctVal));
            return (
              `<div class="quota-win-block">` +
              `<div class="quota-inline-sub"><span>${escZh(winTitle)}</span><span class="num-strong">${escZh(`${pctVal.toFixed(1)}% · ${rStr}`)}</span></div>` +
              `<div class="thin-track"><div class="thin-fill" style="width:${w}%;background:${barColor(pctVal)}"></div></div>` +
              `</div>`
            );
          }
          const unknownLabel = resetZh ? `余量未知 · ${resetZh} 重置` : '余量未知';
          return (
            `<div class="quota-win-block">` +
            `<div class="quota-inline-sub"><span>${escZh(winTitle)}</span><span class="muted num">${escZh(unknownLabel)}</span></div>` +
            `<div class="thin-track"><div class="thin-fill" style="width:0%;background:var(--cv-muted)"></div></div>` +
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
            : `${families.slice(0, 3).join(' / ')} 等 ${families.length} 组`;
          const label = pool.displayTitle || familySummary;
          const variantCount = pool.modelsCount || modelLabels.length;
          const hoverDetail = modelLabels.length
            ? `${familySummary}（包含档位：${modelLabels.join('、')}）`
            : familySummary;

          const { pBase, rBase } = extractQuotaParts(pool);
          if (pool.fiveHour || pool.weekly) {
            const winBlocks = [];
            if (pBase !== null) {
              winBlocks.push(renderQuotaWinBlock('基础配额窗口', pBase, rBase || pool.resetTimeZh, '自动周期重置'));
            }
            if (pool.fiveHour) {
              winBlocks.push(renderQuotaWinBlock('5 小时滚动限额', pool.fiveHour.remainingPercent, pool.fiveHour.resetTimeZh, '5h 滚动重置'));
            }
            if (pool.weekly) {
              winBlocks.push(renderQuotaWinBlock('Week 周度总额度（档位共享池）', pool.weekly.remainingPercent, pool.weekly.resetTimeZh, '按周重置'));
            }
            return (
              `<div class="quota-inline" title="${escZh(hoverDetail)}">` +
              `<div class="quota-inline-head">` +
              `<span class="quota-name">${escZh(label)}</span>` +
              `<span class="quota-tag">${escZh(`共 ${variantCount} 档`)}</span>` +
              `</div>` +
              winBlocks.join('') +
              `</div>`
            );
          }

          const hasPct = isKnownPct(pool.remainingPercent);
          const pctVal = hasPct ? pool.remainingPercent : null;
          const subLeft = variantCount > families.length
            ? `共享配额池 · 含 ${variantCount} 个模型档位`
            : `共享配额池 · ${variantCount || families.length} 个模型`;
          const resetStr = pool.resetTimeZh
            ? `${pool.resetTimeZh} 重置`
            : (hasPct ? '自动周期重置' : '服务端未返回余量百分比');
          const fillStyle = hasPct
            ? `width:${Math.min(100, Math.max(0, pctVal))}%;background:${barColor(pctVal)}`
            : 'width:0%;background:var(--cv-muted)';
          return (
            `<div class="quota-inline" title="${escZh(hoverDetail)}">` +
            `<div class="quota-inline-head">` +
            `<span class="quota-name">${escZh(label)}</span>` +
            `<span class="${hasPct ? 'num-strong' : 'muted num'} quota-val">${escZh(hasPct ? `${pctVal.toFixed(1)}%` : '余量未知')}</span>` +
            `</div>` +
            `<div class="thin-track"><div class="thin-fill" style="${fillStyle}"></div></div>` +
            `<div class="quota-inline-sub">` +
            `<span>${escZh(subLeft)}</span>` +
            `<span class="num">${escZh(resetStr)}</span>` +
            `</div>` +
            `</div>`
          );
        }).join('');
      } else if (quotaStatus?.state === 'error') {
        qWrap.classList.remove('hidden');
        qList.innerHTML = `<div class="kv-row"><span class="muted">${escZh(quotaStatus.reason || '宿主语言服务暂不可达，尚未获取到模型配额池数据')}</span></div>`;
      } else if (quotaStatus?.state === 'unavailable') {
        qWrap.classList.remove('hidden');
        qList.innerHTML = `<div class="kv-row"><span class="muted">${escZh('未连接宿主语言服务，暂无法获取实时模型额度；若从桌面端右侧栏打开看板并点击 📌，可同步实时配额与套餐')}</span></div>`;
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
    let outTok = ref.outputTokens;

    if (state.costMode === 'hybrid') {
      totalUSD = hyb.totalCostUSD;
      inUSD = hyb.inputCostUSD;
      cacheUSD = hyb.cacheCostUSD;
      outUSD = hyb.outputCostUSD;
      cacheSavedUSD = Number(hyb?.cacheSavingsUSD ?? 0);
    } else if (state.costMode === 'identified') {
      totalUSD = ident.pricedCostUSD;
      inUSD = ident.pricedInputCostUSD;
      cacheUSD = ident.pricedCacheCostUSD;
      outUSD = ident.pricedOutputCostUSD;
      inTok = ident.byCategory.inputTokens;
      cacheTok = ident.byCategory.cacheTokens;
      outTok = ident.byCategory.outputTokens;
      cacheSavedUSD = Number(ident?.pricedCacheSavingsUSD ?? ident?.cacheSavingsUSD ?? 0);
    } else {
      totalUSD = ref.totalCostUSD;
      inUSD = ref.inputCostUSD;
      cacheUSD = ref.cacheCostUSD;
      outUSD = ref.outputCostUSD;
      cacheSavedUSD = Number(ref?.cacheSavingsUSD ?? 0);
    }

    setText('cost-big-usd', fmtUSD(totalUSD));
    setText('cost-big-cny', `折合人民币约 ${fmtCNY(totalUSD)}`);

    const covPill = $('cost-cov-pill');
    if (covPill) {
      const cov = ident.tokenCoveragePercent ?? 100;
      covPill.className = `status-pill ${cov >= 85 ? 'good' : cov >= 45 ? 'warn' : 'neutral'}`;
      setText(
        covPill,
        state.costMode === 'reference' ? 'Flash 统一基准' : `已精确识别 ${cov.toFixed(1)}% Token`
      );
    }
    setText(
      'cost-scope-label',
      state.costScope === 'period'
        ? `${hist.currentPeriod?.label || '本期自然月'} · ${fmtInt(ident.totalRequestsCount)} 次请求`
        : `自 ${hist.firstUseDate || '--'} 累计 · ${fmtInt(ident.totalRequestsCount)} 次请求`
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
        ? '本月 API 等值消耗 vs 月度订阅实付'
        : `全量 API 等值消耗 vs 累计订阅实付（按 ${activeMonthsCount} 个活跃月折算）`
    );

    const maxBar = Math.max(totalUSD, subUSD || 0, 0.01);
    if ($('bar-api-val')) $('bar-api-val').style.width = `${Math.min(100, (totalUSD / maxBar) * 100).toFixed(1)}%`;
    setText('lbl-api-val', fmtUSD(totalUSD));

    if (subUSD !== null) {
      if ($('bar-sub-val')) $('bar-sub-val').style.width = `${Math.min(100, (subUSD / maxBar) * 100).toFixed(1)}%`;
      setText('lbl-sub-val', fmtUSD(subUSD));
      const diff = totalUSD - subUSD;
      if (subUSD === 0) {
        setText('compare-diff', `免额外付费 · 已白嫖等值 ${fmtUSD(totalUSD)}`);
      } else if (diff >= 0) {
        setText('compare-diff', `已超出订阅费 +${fmtUSD(diff)}（${(totalUSD / subUSD).toFixed(2)}x 回本）`);
      } else {
        setText('compare-diff', `距回本还差 ${fmtUSD(Math.abs(diff))}（已用 ${(totalUSD / subUSD * 100).toFixed(0)}%）`);
      }
    } else {
      if ($('bar-sub-val')) $('bar-sub-val').style.width = '0%';
      setText('lbl-sub-val', '未设实付');
      setText('compare-diff', '设置订阅实付后可对比性价比');
    }

    // 3 Category Tiles
    setText('cat-in-cost', fmtUSD(inUSD));
    setText('cat-in-tok', `${fmtTokens(inTok)} tok`);
    setText('cat-cache-cost', fmtUSD(cacheUSD));
    setText('cat-cache-tok', `${fmtTokens(cacheTok)} tok`);
    const catCacheSavedEl = $('cat-cache-saved');
    if (catCacheSavedEl) {
      if (Number.isFinite(cacheSavedUSD) && cacheSavedUSD > 0) {
        catCacheSavedEl.classList.remove('hidden');
        setText(catCacheSavedEl, `缓存已省 ${fmtUSD(cacheSavedUSD)}`);
        catCacheSavedEl.setAttribute(
          'title',
          formatZh(`较原价输入预计节省 ${fmtUSD(cacheSavedUSD)}（约 ${fmtCNY(cacheSavedUSD)}）`)
        );
      } else {
        catCacheSavedEl.classList.add('hidden');
        setText(catCacheSavedEl, '');
      }
    }
    setText('cat-out-cost', fmtUSD(outUSD));
    setText('cat-out-tok', `${fmtTokens(outTok)} tok`);

    // Model Leaderboard
    const board = $('model-leaderboard');
    if (board) {
      const models = ident.byModel || [];
      if (!models.length) {
        board.innerHTML = `<div class="kv-row"><span class="muted">${escZh('当前统计范围内暂无模型请求记录')}</span></div>`;
      } else {
        const maxModelTok = Math.max(...models.map((m) => m.tokens || 0), 1);
        board.innerHTML = models.map((m) => {
          const wPct = Math.max(2, ((m.tokens || 0) / maxModelTok) * 100).toFixed(1);
          const costLabel = m.unpriced
            ? (m.missingModel ? '未记模型（混合模式下按基准折算）' : '未收录单价（混合模式下按基准折算）')
            : `${fmtUSD(m.costUSD)}（${fmtCNY(m.costUSD)}）`;
          return (
            `<div class="model-row">` +
            `<div class="model-row-top">` +
            `<span class="model-name">${escZh(m.displayName)}</span>` +
            `<span class="num-strong">${escZh(costLabel)}</span>` +
            `</div>` +
            `<div class="thin-track"><div class="thin-fill accent" style="width:${wPct}%"></div></div>` +
            `<div class="model-row-sub">` +
            `<span>${escZh(`${fmtInt(m.requests)} 次请求 · 总计 ${fmtTokens(m.tokens)}`)}</span>` +
            `<span class="num">${escZh(`入 ${fmtTokens(m.inputTokens, 1)} / 缓 ${fmtTokens(m.cacheTokens, 1)} / 出 ${fmtTokens(m.outputTokens, 1)}`)}</span>` +
            `</div>` +
            `</div>`
          );
        }).join('');
      }
    }

    // Project / Workspace Leaderboard (Top 10)
    const projWrap = $('project-leaderboard-wrap');
    const projBoard = $('project-leaderboard');
    if (projWrap && projBoard) {
      const projects = Array.isArray(srcAnalytics.byProject)
        ? srcAnalytics.byProject.filter(Boolean).slice(0, 10)
        : [];
      if (!projects.length) {
        projWrap.classList.add('hidden');
        projBoard.innerHTML = '';
      } else {
        projWrap.classList.remove('hidden');
        const maxProjTok = Math.max(...projects.map((p) => Number(p.tokens || 0)), 1);
        projBoard.innerHTML = projects.map((p) => {
          const tok = Number(p.tokens || 0);
          const costUSD = Number(p.costUSD || 0);
          const savedUSD = Number(p.cacheSavingsUSD || 0);
          const wPct = Math.max(2, (tok / maxProjTok) * 100).toFixed(1);
          const tip = `输入 ${fmtTokens(p.inputTokens || 0, 1)} / 缓存 ${fmtTokens(p.cacheTokens || 0, 1)} / 输出 ${fmtTokens(p.outputTokens || 0, 1)}${savedUSD > 0 ? ` · 缓存已省 ${fmtUSD(savedUSD)}` : ''}`;
          const rightSub = savedUSD > 0
            ? `<span class="num good-text">${escZh(`缓存已省 ${fmtUSD(savedUSD)}`)}</span>`
            : `<span class="num">${escZh(`入 ${fmtTokens(p.inputTokens || 0, 1)} / 缓 ${fmtTokens(p.cacheTokens || 0, 1)} / 出 ${fmtTokens(p.outputTokens || 0, 1)}`)}</span>`;
          return (
            `<div class="model-row" title="${escZh(tip)}">` +
            `<div class="model-row-top">` +
            `<span class="model-name">${esc(p.name || '未归类工作区')}</span>` +
            `<span class="num-strong">${escZh(`${fmtUSD(costUSD)}（${fmtCNY(costUSD)}）`)}</span>` +
            `</div>` +
            `<div class="thin-track"><div class="thin-fill accent" style="width:${wPct}%"></div></div>` +
            `<div class="model-row-sub">` +
            `<span>${escZh(`${fmtInt(p.conversations || 0)} 会话 · ${fmtInt(p.requests || 0)} 次请求 · 总计 ${fmtTokens(tok)}`)}</span>` +
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
  }

  function wireEvents() {
    // Primary tabs & capsule shortcuts
    document.querySelectorAll('.main-tab').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    document.querySelectorAll('[data-goto-tab]').forEach((pill) => {
      pill.addEventListener('click', () => switchTab(pill.dataset.gotoTab));
    });

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

    // Conversation selector & follow-current button
    $('conv-select')?.addEventListener('change', (e) => {
      state.selectedConvId = e.target.value || '';
      state.contextEtag = '';
      state.contextEtagConv = state.selectedConvId || state.hostConvId || '';
      state.contextInFlight = false;
      state.contextInFlightConv = '';
      $('btn-follow-current')?.classList.toggle('hidden', !state.selectedConvId);
      apiFetch('/api/entrypoints', {
        method: 'POST',
        body: { pinnedConvId: state.selectedConvId }
      }).catch(() => {});
      loadContext(true).catch(() => {});
    });

    $('btn-follow-current')?.addEventListener('click', () => {
      state.selectedConvId = '';
      if ($('conv-select')) $('conv-select').value = '';
      $('btn-follow-current')?.classList.add('hidden');
      state.contextEtag = '';
      state.contextEtagConv = state.hostConvId || '';
      state.contextInFlight = false;
      state.contextInFlightConv = '';
      apiFetch('/api/entrypoints', {
        method: 'POST',
        body: { pinnedConvId: '' }
      }).catch(() => {});
      loadContext(true).catch(() => {});
      showToast('已切回自动跟随当前对话');
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
          state.contextData.context?.latestPromptStartup || null
        );
      }
    };
    document.querySelectorAll('#turns-view-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.turnsView = btn.dataset.tview === 'prompts' ? 'prompts' : 'steps';
        document.querySelectorAll('#turns-view-seg .seg-btn').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
        rerenderTurns();
      });
    });
    document.querySelectorAll('#turns-filter-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.turnsFilter = btn.dataset.tfilter || 'all';
        document.querySelectorAll('#turns-filter-seg .seg-btn').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
        rerenderTurns();
      });
    });
    document.querySelectorAll('#prompt-filter-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.promptTurnsFilter = btn.dataset.pfilter === 'cold' ? 'cold' : 'all';
        document.querySelectorAll('#prompt-filter-seg .seg-btn').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
        rerenderTurns();
      });
    });

    // Refresh & Rescan
    const triggerForceRefresh = async (ev) => {
      if (ev?.shiftKey) {
        if (window.__CV_FLOAT_MODE__ && !window.__CV_BROWSER_FALLBACK__) {
          await apiFetch('/api/reload-float-bundle', { method: 'POST' }).catch(() => {});
          return;
        }
        window.location.reload();
        return;
      }
      if (!window.__CV_FLOAT_MODE__ || window.__CV_BROWSER_FALLBACK__) {
        const cssLink = document.querySelector('link[href^="/styles.css"]');
        if (cssLink) cssLink.href = `/styles.css?v=${Date.now()}`;
      }
      applyAppearanceToDom();
      const icon = $('ic-refresh');
      icon?.classList.add('spin');
      try {
        await Promise.all([loadContext(true), loadHistory(true), refreshFloatStatus()]);
        showToast('已同步最新会话上下文与全量统计');
      } catch (err) {
        showToast(`刷新失败：${err.message}`);
      } finally {
        setTimeout(() => icon?.classList.remove('spin'), 350);
      }
    };
    $('btn-refresh')?.addEventListener('click', triggerForceRefresh);
    $('btn-rescan-files')?.addEventListener('click', triggerForceRefresh);

    // Detached Right-Side Floating Window (`📌`)
    $('btn-float')?.addEventListener('click', async (ev) => {
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
        showToast(next ? '已重新钉在屏幕最前' : '已取消置顶（现为普通窗口，点击左上角红叉可关闭）');
        return;
      }

      try {
        const res = await apiFetch('/api/float-window', {
          method: 'POST',
          body: { action: 'toggle' }
        });
        if (!res.ok) {
          showToast(res.error || '独立看板操作失败');
          return;
        }
        state.floatRunning = Boolean(res.running);
        state.floatPinned = Boolean(res.pinned);
        syncFloatButtonUi();
        showToast(res.message || (res.running ? '已在屏幕右侧打开独立看板' : '已关闭右侧独立看板'));
      } catch (err) {
        showToast(`操作独立看板失败：${err.message}`);
      }
    });

    // CLI Launcher
    $('btn-cli')?.addEventListener('click', async () => {
      try {
        const res = await apiFetch('/api/launch-cli', {
          method: 'POST',
          body: {
            workspaceUri: state.workspaceUri || '',
            workspacePath: state.contextData?.workspacePath || ''
          }
        });
        showToast(res.ok ? res.message : (res.error || '唤起终端失败'));
      } catch (err) {
        showToast(`唤起终端失败：${err.message}`);
      }
    });

    // Palette drawer & quick theme cycle
    const drawer = $('palette-drawer');
    $('btn-palette')?.addEventListener('click', () => {
      if (!drawer) return;
      const willOpen = drawer.classList.contains('hidden');
      drawer.classList.toggle('hidden', !willOpen);
      $('btn-palette')?.setAttribute('aria-expanded', String(willOpen));
    });
    $('btn-close-palette')?.addEventListener('click', () => {
      if (state.recordingShortcut || state.recordingAuxShortcut) stopAllShortcutRecording();
      drawer?.classList.add('hidden');
      $('btn-palette')?.setAttribute('aria-expanded', 'false');
    });

    // Persistent Top Menu Bar (`◈` / `⚡` / `⏳`) & Right Floating Window (`📌`) switches
    document.querySelectorAll('#menubar-entry-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const wantOn = btn.dataset.menubarEntry === 'on';
        try {
          const res = await apiFetch('/api/entrypoints', {
            method: 'POST',
            body: { menubarEnabled: wantOn }
          });
          if (!res.ok) {
            showToast(res.error || '切换顶部菜单栏常驻图标失败');
            return;
          }
          state.menubarEnabled = Boolean(res.menubarEnabled);
          if (res.menubarMode) state.menubarMode = res.menubarMode;
          syncFloatButtonUi();
          showToast(res.message || (state.menubarEnabled ? '已开启顶部菜单栏常驻图标' : '已关闭顶部菜单栏常驻图标'));
        } catch (err) {
          showToast(`切换失败：${err.message}`);
        }
      });
    });

    document.querySelectorAll('#menubar-mode-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const nextMode = btn.dataset.menubarMode || 'context';
        try {
          const res = await apiFetch('/api/entrypoints', {
            method: 'POST',
            body: { menubarMode: nextMode }
          });
          if (!res.ok) {
            showToast(res.error || '切换菜单栏显示内容失败');
            return;
          }
          state.menubarMode = res.menubarMode || nextMode;
          if (typeof res.menubarEnabled === 'boolean') {
            state.menubarEnabled = res.menubarEnabled;
          }
          syncFloatButtonUi();
          showToast(res.message || '已更新顶部菜单栏显示内容');
        } catch (err) {
          showToast(`切换失败：${err.message}`);
        }
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
      applyShortcutPatch({ enabled: !Boolean(state.shortcut?.enabled) });
    });

    $('btn-reset-shortcut')?.addEventListener('click', () => {
      if (state.recordingShortcut || state.recordingAuxShortcut) stopAllShortcutRecording();
      applyShortcutPatch({ reset: true });
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
      applyAuxShortcutPatch({ enabled: !Boolean(state.auxShortcut?.enabled) });
    });

    $('btn-reset-aux-shortcut')?.addEventListener('click', () => {
      if (state.recordingShortcut || state.recordingAuxShortcut) stopAllShortcutRecording();
      applyAuxShortcutPatch({ reset: true });
    });

    document.querySelectorAll('#shortcut-scope-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (state.recordingShortcut || state.recordingAuxShortcut) stopAllShortcutRecording();
        const nextScope = btn.dataset.shortcutScope || 'app';
        applyShortcutPatch({ scope: nextScope });
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

    window.addEventListener('blur', () => {
      if (state.recordingShortcut || state.recordingAuxShortcut) stopAllShortcutRecording();
    });

    window.addEventListener('keydown', (ev) => {
      if (state.recordingShortcut || state.recordingAuxShortcut) {
        const isAux = Boolean(state.recordingAuxShortcut);
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.key === 'Escape' && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
          stopAllShortcutRecording();
          showToast('已取消快捷键录制');
          return;
        }
        const parsed = buildAcceleratorFromKeyEvent(ev);
        if (parsed.modifierOnly) {
          const kbdEl = $(isAux ? 'aux-shortcut-kbd-label' : 'shortcut-kbd-label');
          if (kbdEl) setText(kbdEl, parsed.preview || '按下组合键…');
          return;
        }
        if (!parsed.ok) {
          showToast(parsed.error || '组合键无效，请包含 ⌘ / ⌥ / ⌃ 修饰键（Esc 取消）');
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

      if (ev.repeat) return;
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
            showToast(res?.error || '快捷键切换看板失败');
            return;
          }
          state.floatRunning = Boolean(res.running);
          state.floatPinned = Boolean(res.pinned);
          syncFloatButtonUi();
          showToast(res.message || (res.running ? '已通过快捷键打开右侧看板' : '已通过快捷键收回右侧看板'));
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
            showToast('已发送切换 Antigravity 右侧辅助栏「上下文看板」指令');
          }).catch(() => {});
        }
      }
    }, true);

    $('btn-theme')?.addEventListener('click', () => {
      const order = ['auto', 'light', 'dark'];
      const next = order[(order.indexOf(state.ui.themeMode) + 1) % order.length];
      state.ui.themeMode = next;
      applyAppearanceToDom();
      persistUiPreferences();
      const labels = { auto: '跟随宿主主题', light: '浅色主题', dark: '深色主题' };
      showToast(`已切换为${labels[next]}`);
    });

    document.querySelectorAll('#theme-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.ui.themeMode = btn.dataset.themeMode;
        applyAppearanceToDom();
        persistUiPreferences();
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
      state.ui = { themeMode: 'auto', preset: 'violet', customLevels: null, customAccent: '' };
      applyAppearanceToDom();
      persistUiPreferences();
      if (state.contextData) {
        renderContextPanel(state.contextData);
        renderTopCapsules();
      }
      showToast('已恢复默认外观与色阶');
    });

    // Legend box click -> open palette & trigger corresponding color input
    document.querySelectorAll('#heat-legend .leg-box').forEach((box) => {
      box.addEventListener('click', () => {
        const slot = box.dataset.legSlot;
        drawer?.classList.remove('hidden');
        $(`col-lvl${slot}`)?.click();
      });
    });

    // History source & chart mode switches
    document.querySelectorAll('#source-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.sourceFilter = btn.dataset.source;
        document.querySelectorAll('#source-seg .seg-btn').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
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
        document.querySelectorAll('#chart-mode-seg .seg-btn').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
        if (state.historyData) renderHistoryPanel(state.historyData);
      });
    });

    document.querySelectorAll('#hourly-day-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.hourlyDay = btn.dataset.hday === 'yesterday' ? 'yesterday' : 'today';
        document.querySelectorAll('#hourly-day-seg .seg-btn').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
        if (state.historyData) renderHistoryPanel(state.historyData);
      });
    });

    document.querySelectorAll('#diag-tab-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.diagTab = btn.dataset.dtab === 'routing' ? 'routing' : 'events';
        document.querySelectorAll('#diag-tab-seg .seg-btn').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
        if (state.historyData) renderDiagnosticsCard(state.historyData.diagnostics || null);
      });
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

    // Cost scope & mode switches
    document.querySelectorAll('#cost-scope-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.costScope = btn.dataset.scope;
        document.querySelectorAll('#cost-scope-seg .seg-btn').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
        if (state.historyData) renderCostPanel(state.historyData);
      });
    });

    document.querySelectorAll('#cost-mode-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.costMode = btn.dataset.cmode;
        document.querySelectorAll('#cost-mode-seg .seg-btn').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
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

    planForm?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
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
        showToast('已保存订阅与实付设置');
      } catch (err) {
        showToast(`保存失败：${err.message}`);
      }
    });

    $('btn-clear-plan')?.addEventListener('click', async () => {
      try {
        const saved = await apiFetch('/api/settings', { method: 'POST', body: { clearPlan: true } });
        state.settingsData = saved;
        planForm?.classList.add('hidden');
        await loadHistory(true);
        showToast('已恢复自动订阅识别');
      } catch (err) {
        showToast(`重置失败：${err.message}`);
      }
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
    const mac = state.shortcut?.nativeGlobalSupported !== false;
    if (mac) {
      let s = '';
      if (ev.ctrlKey) s += '⌃';
      if (ev.altKey) s += '⌥';
      if (ev.shiftKey) s += '⇧';
      if (ev.metaKey) s += '⌘';
      return s ? `${s}…` : '按下组合键…';
    }
    const parts = [];
    if (ev.ctrlKey) parts.push('Ctrl');
    if (ev.altKey) parts.push('Alt');
    if (ev.shiftKey) parts.push('Shift');
    if (ev.metaKey) parts.push('Win');
    return parts.length ? `${parts.join('+')}+…` : '按下组合键…';
  }

  function buildAcceleratorFromKeyEvent(ev) {
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
      return { ok: false, error: '不支持该按键，请使用字母 A-Z、数字 0-9、F1-F12 或常用符号键' };
    }
    const isFnKey = /^F([1-9]|1[0-2])$/.test(canonKey);
    if (!ev.ctrlKey && !ev.altKey && !ev.metaKey && !isFnKey) {
      return { ok: false, error: '快捷键需包含 ⌘ / ⌥ / ⌃ 修饰键之一（或使用 F1-F12），按 Esc 取消' };
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
    const fallbackMsg = isAux ? '已更新 AGY 侧栏看板快捷键' : '已更新独立悬浮窗快捷键';
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
        showToast(res?.error || '设置快捷键失败');
        return;
      }
      showToast(res.message || fallbackMsg);
    } catch (err) {
      syncFloatButtonUi();
      showToast(`设置快捷键失败：${err.message}`);
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
          ? '按下组合键…'
          : (sc?.display || sc?.defaultDisplay || defaultFallback)
      );
    }
    if (recHint) {
      setText(
        recHint,
        recording
          ? 'Esc 取消'
          : (enabled ? '点击修改' : '已停用')
      );
    }
    if (toggleScBtn) {
      setText(toggleScBtn, enabled ? '已开启' : '已停用');
    }
    if (resetScBtn) {
      resetScBtn.disabled = Boolean(sc?.isDefault);
    }
  }

  function syncFloatButtonUi() {
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
            ? '关闭当前小窗'
            : (state.floatPinned ? '当前在小窗中 · 点击取消置顶' : '当前在小窗中 · 点击恢复置顶')
        );
      } else {
        setText(drawerFloatBtn, state.floatRunning ? '运行中 · 点击收回小窗' : '弹出独立置顶小窗');
      }
    }

    const btn = $('btn-float');
    if (!btn) return;
    const scEnabled = sc.enabled !== false;
    const scHint = scEnabled && sc.display ? `；快捷键 ${sc.display}` : '';
    if (window.__CV_FLOAT_MODE__) {
      const pinned = Boolean(state.floatPinned) && !window.__CV_BROWSER_FALLBACK__;
      btn.classList.toggle('pin-active', pinned);
      const tip = window.__CV_BROWSER_FALLBACK__
        ? formatZh(`关闭右侧独立看板小窗${scHint ? `（${sc.display}）` : ''}`)
        : pinned
          ? formatZh(`当前：已钉在屏幕最前（点击取消置顶；Shift+点击${scHint ? `或按 ${sc.display} ` : ''}收回小窗）`)
          : formatZh(`当前：已取消置顶（点击重新钉在最前；Shift+点击${scHint ? `或按 ${sc.display} ` : ''}收回小窗）`);
      btn.title = tip;
      btn.setAttribute('aria-label', tip);
    } else {
      const active = Boolean(state.floatRunning);
      btn.classList.toggle('pin-active', active);
      const tip = active
        ? formatZh(`右侧独立置顶看板显示中（点击或按 ${scEnabled && sc.display ? sc.display : '📌'} 收回小窗）`)
        : formatZh(`钉在屏幕右侧独立置顶小窗（不受右侧栏切换影响${scHint}）`);
      btn.title = tip;
      btn.setAttribute('aria-label', tip);
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

  async function boot() {
    normalizeStaticDomTypography();
    applyAppearanceToDom();
    syncFloatButtonUi();
    wireEvents();
    initWorkspaceTracking();
    startAuxPaneBridgeCoordinator();

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
