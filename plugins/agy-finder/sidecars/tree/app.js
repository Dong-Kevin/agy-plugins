(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const csrfToken = document.querySelector('meta[name="af-csrf-token"]')?.getAttribute('content') || '';

  const state = {
    isDrawerMode: Boolean(
      window.sidecar?.isDrawerWindow ||
      window.__AF_DRAWER_MODE__ ||
      new URLSearchParams(window.location.search).get('mode') === 'drawer'
    ),
    roots: [],
    activeRoot: '',
    showHidden: false,
    expandedByRoot: new Map(), // rootPath -> Set<relDir>
    dirCache: new Map(),       // `${rootPath}::${relDir}::${showHidden}` -> items[]
    selectedRelPath: '',
    selectedAbsPath: '',
    selectedFileUri: '',
    selectedIsDir: false,
    revealedRelPath: '',
    searchQuery: '',
    searchResults: null,
    mentions: [],
    mentionsEtag: '',
    mentionsCollapsed: false,
    themeOverride: 'auto',     // 'auto' | 'light' | 'dark'
    lastHandledUrlQuery: null,
    pendingRevealTimer: null,
    shortcutInfo: null,
    hotkeyPreset: window.__AF_HOTKEY_PRESET__ || 'cmd+shift+e',
    drawerShortcut: window.__AF_DRAWER_SHORTCUT__ || null,
    auxShortcut: window.__AF_AUX_SHORTCUT__ || null,
    recordingTarget: null,
    drawerVisible: false,
    drawerPinned: Boolean(window.__AF_DRAWER_PINNED__ ?? true),
    shortcutPanelOpen: false,
    previewPath: ''
  };

  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));
  }

  let toastTimer = null;
  function showToast(msg) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2400);
  }

  function detectHostDarkTheme() {
    if (state.themeOverride === 'dark') return true;
    if (state.themeOverride === 'light') return false;
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #ffffff)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) {
      return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
    }
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 0.5;
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-af-theme', detectHostDarkTheme() ? 'dark' : 'light');
  }

  async function apiFetch(path, options = {}) {
    const method = options.method || 'GET';
    const headers = { ...(options.headers || {}) };
    if (method !== 'GET' && csrfToken) {
      headers['X-AF-Token'] = csrfToken;
    }
    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, { ...options, method, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function apiGet(path, params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const url = qs.toString() ? `${path}?${qs.toString()}` : path;
    return apiFetch(url, { method: 'GET' });
  }

  function apiPost(path, body = {}) {
    return apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
  }

  function getExpandedSet(rootPath) {
    let set = state.expandedByRoot.get(rootPath);
    if (!set) {
      set = new Set(['']);
      state.expandedByRoot.set(rootPath, set);
    }
    return set;
  }

  function cacheKey(rootPath, relDir) {
    return `${rootPath}::${relDir}::${state.showHidden ? '1' : '0'}`;
  }

  function clearCacheForRoot(rootPath) {
    for (const key of Array.from(state.dirCache.keys())) {
      if (key.startsWith(`${rootPath}::`)) {
        state.dirCache.delete(key);
      }
    }
  }

  async function fetchDir(rootPath, relDir, force = false) {
    const key = cacheKey(rootPath, relDir);
    if (!force && state.dirCache.has(key)) {
      return state.dirCache.get(key);
    }
    const res = await apiGet('/api/tree', {
      root: rootPath,
      dir: relDir,
      showHidden: state.showHidden ? '1' : '0'
    });
    const items = Array.isArray(res.items) ? res.items : [];
    state.dirCache.set(key, items);
    return items;
  }

  async function getHostWorkspaceUris() {
    if (!window.sidecar?.getWorkspaceUris) return [];
    try {
      const uris = await Promise.race([
        window.sidecar.getWorkspaceUris(),
        new Promise((resolve) => setTimeout(() => resolve([]), 400))
      ]);
      return Array.isArray(uris) ? uris.filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  function getConversationId() {
    const p = new URLSearchParams(window.location.search);
    return window.sidecar?.conversationId || p.get('conversationId') || '';
  }

  function renderRootSelect() {
    const sel = $('root-select');
    if (!sel) return;
    sel.innerHTML = state.roots
      .map((r) => `<option value="${esc(r.path)}"${r.path === state.activeRoot ? ' selected' : ''}>${esc(r.name)}</option>`)
      .join('');
  }

  function renderActivePathBar() {
    const bar = $('active-path-bar');
    const txt = $('active-path-text');
    const previewBtn = $('btn-preview-active');
    if (!bar || !txt) return;
    if (!state.selectedAbsPath) {
      bar.classList.add('hidden');
      return;
    }
    bar.classList.remove('hidden');
    txt.textContent = state.selectedRelPath || state.selectedAbsPath;
    txt.title = state.selectedAbsPath;
    if (previewBtn) {
      previewBtn.classList.toggle('hidden', state.selectedIsDir);
    }
  }

  function renderTree() {
    const container = $('tree-content');
    if (!container) return;

    if (state.searchQuery.trim() && Array.isArray(state.searchResults)) {
      if (state.searchResults.length === 0) {
        container.innerHTML = '<div class="af-empty">没有匹配的文件或目录</div>';
        return;
      }
      container.innerHTML = state.searchResults
        .map((item) => {
          const ic = item.isDirectory ? iconFolder(false) : iconFile();
          const parent = item.relPath.includes('/') ? item.relPath.slice(0, item.relPath.lastIndexOf('/')) : '';
          return `
            <div class="af-tree-row${item.relPath === state.selectedRelPath ? ' is-selected' : ''}"
                 data-search-abs="${esc(item.absPath)}"
                 data-file-uri="${esc(item.fileUri)}"
                 data-is-dir="${item.isDirectory ? '1' : '0'}"
                 style="padding-left: 10px"
                 title="${esc(item.absPath)}">
              <span class="af-node-ic ${item.isDirectory ? 'af-ic-dir' : 'af-ic-file'}">${ic}</span>
              <span class="af-node-label">${esc(item.name)}</span>
              ${parent ? `<span class="af-node-sub">${esc(parent)}</span>` : ''}
            </div>`;
        })
        .join('');
      return;
    }

    if (!state.activeRoot) {
      container.innerHTML = '<div class="af-empty">暂无可用项目根目录</div>';
      return;
    }

    const rootItems = state.dirCache.get(cacheKey(state.activeRoot, ''));
    if (!rootItems) {
      container.innerHTML = '<div class="af-empty">加载目录中…</div>';
      return;
    }
    if (rootItems.length === 0) {
      container.innerHTML = '<div class="af-empty">目录为空</div>';
      return;
    }

    const expanded = getExpandedSet(state.activeRoot);
    const rows = [];

    const walk = (items, depth) => {
      for (const item of items) {
        const isOpen = item.isDirectory && expanded.has(item.relPath);
        const isSelected = item.relPath === state.selectedRelPath;
        const isRevealed = item.relPath === state.revealedRelPath;
        const padLeft = 8 + depth * 14;
        const cls = ['af-tree-row'];
        if (isSelected) cls.push('is-selected');
        if (isRevealed) cls.push('is-revealed');

        rows.push(`
          <div class="${cls.join(' ')}"
               role="treeitem"
               aria-expanded="${item.isDirectory ? String(isOpen) : 'false'}"
               data-rel-path="${esc(item.relPath)}"
               data-file-uri="${esc(item.fileUri)}"
               data-is-dir="${item.isDirectory ? '1' : '0'}"
               style="padding-left: ${padLeft}px"
               title="${esc(item.relPath)}">
            <span class="af-twistie${isOpen ? ' is-open' : ''}">${item.isDirectory ? '▸' : ''}</span>
            <span class="af-node-ic ${item.isDirectory ? 'af-ic-dir' : 'af-ic-file'}">${item.isDirectory ? iconFolder(isOpen) : iconFile()}</span>
            <span class="af-node-label">${esc(item.name)}</span>
            <span class="af-row-actions">
              ${!item.isDirectory ? '<button class="af-act-btn" data-act="preview" type="button" title="在原生预览中打开">↗</button>' : ''}
              <button class="af-act-btn" data-act="copy" type="button" title="复制相对路径（Shift+点击复制绝对路径）">📋</button>
              <button class="af-act-btn" data-act="os" type="button" title="在系统文件管理器中显示">🖥</button>
            </span>
          </div>`);

        if (isOpen) {
          const children = state.dirCache.get(cacheKey(state.activeRoot, item.relPath));
          if (children) {
            walk(children, depth + 1);
          } else {
            rows.push(`<div class="af-tree-row" style="padding-left: ${padLeft + 19}px"><span class="af-node-sub">加载中…</span></div>`);
          }
        }
      }
    };

    walk(rootItems, 0);
    container.innerHTML = rows.join('');
  }

  function iconFolder(open) {
    return open
      ? '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3l1.3 1.5H13A1.5 1.5 0 0 1 14.5 5v1H2.8L1.5 12V3.5Zm1.7 3.5h11.6l-1.3 6A1.5 1.5 0 0 1 12 14H2.6a1 1 0 0 1-1-.9L3.2 7Z"/></svg>'
      : '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3l1.3 1.5H13A1.5 1.5 0 0 1 14.5 5v7.5A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5v-9Z"/></svg>';
  }

  function iconFile() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3.5 2h6l3 3v9h-9V2Z"/><path d="M9.5 2v3h3"/></svg>';
  }

  function openNativePreview(fileUri, line, fallbackPath = '') {
    if (!fileUri && !fallbackPath) return;
    const uri = line && fileUri ? `${fileUri}#L${line}` : fileUri;
    if (window.sidecar?.ui?.toggleAuxPane && uri) {
      window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri });
      return;
    }
    const target = fallbackPath || fileUri;
    openPreviewModal(target, line).catch((err) => showToast(err.message));
  }

  function closePreviewModal() {
    state.previewPath = '';
    $('preview-modal')?.classList.add('hidden');
  }

  async function openPreviewModal(rawPath, line) {
    const modal = $('preview-modal');
    const titleEl = $('preview-title');
    const bodyEl = $('preview-body');
    if (!modal || !titleEl || !bodyEl) return;

    titleEl.textContent = rawPath;
    bodyEl.textContent = '加载中…';
    modal.classList.remove('hidden');

    const res = await apiGet('/api/preview', {
      path: rawPath,
      root: state.roots.map((r) => r.path).join(',')
    });
    if (!res.ok) {
      bodyEl.textContent = res.error || '无法预览该文件';
      return;
    }
    state.previewPath = res.absPath;
    const suffix = res.truncated ? '（仅显示前 64 KB）' : '';
    titleEl.textContent = `${res.relPath || res.name}${suffix}`;
    if (res.isBinary) {
      bodyEl.textContent = `二进制文件（${res.size} 字节），请点击右上角「🖥 定位」在系统文件管理器中打开。`;
      return;
    }
    const text = res.content || '（空文件）';
    bodyEl.textContent = text;
    if (line && line > 1) {
      const totalLines = Math.max(1, text.split('\n').length);
      const ratio = Math.min(1, Math.max(0, (line - 3) / totalLines));
      bodyEl.scrollTop = Math.floor(bodyEl.scrollHeight * ratio);
    } else {
      bodyEl.scrollTop = 0;
    }
  }

  async function copyText(text, label) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        showToast(`已复制${label}：${text}`);
        return;
      }
    } catch {}
    showToast(text);
  }

  async function revealInOs(targetPath) {
    try {
      await apiPost('/api/reveal-os', {
        path: targetPath,
        root: state.activeRoot,
        workspaceUri: state.roots.map((r) => r.fileUri).join(',')
      });
      showToast('已在系统文件管理器中定位');
    } catch (err) {
      showToast(`系统定位失败：${err.message}`);
    }
  }

  async function revealPathInTree(rawPath) {
    const trimmed = String(rawPath || '').trim();
    if (!trimmed) return;

    // Clear active search filter so user sees full expanded tree context
    if (state.searchQuery) {
      state.searchQuery = '';
      state.searchResults = null;
      const input = $('search-input');
      if (input) input.value = '';
      $('btn-clear-search')?.classList.add('hidden');
    }

    const uris = await getHostWorkspaceUris();
    const res = await apiGet('/api/resolve', {
      path: trimmed,
      workspaceUri: uris.join(','),
      root: state.roots.map((r) => r.path).join(','),
      conversationId: getConversationId(),
      recordReveal: '1'
    });

    if (!res.ok || !res.exists) {
      showToast(res.error || `未找到路径：${trimmed}`);
      return;
    }

    // Mount external root automatically if not already in roots list
    if (!state.roots.some((r) => r.path === res.rootPath)) {
      state.roots.push({
        path: res.rootPath,
        name: res.isExternalRoot ? `${res.rootName} (外部)` : res.rootName,
        fileUri: res.fileUri
      });
    }
    state.activeRoot = res.rootPath;
    renderRootSelect();

    // Auto-enable hidden files if target or any ancestor is hidden/ignored
    if (res.requiresHidden && !state.showHidden) {
      state.showHidden = true;
      const btn = $('btn-toggle-hidden');
      btn?.classList.add('is-active');
      btn?.setAttribute('aria-pressed', 'true');
      clearCacheForRoot(state.activeRoot);
    }

    const expanded = getExpandedSet(state.activeRoot);
    expanded.add('');
    const dirsToLoad = [''];
    for (const d of res.ancestorRelDirs || []) {
      expanded.add(d);
      if (!state.dirCache.has(cacheKey(state.activeRoot, d))) {
        dirsToLoad.push(d);
      }
    }

    await Promise.all(dirsToLoad.map((d) => fetchDir(state.activeRoot, d).catch(() => [])));

    state.selectedRelPath = res.relPath || '';
    state.selectedAbsPath = res.absPath;
    state.selectedFileUri = res.fileUri;
    state.selectedIsDir = Boolean(res.isDirectory);
    state.revealedRelPath = res.relPath || '';

    renderActivePathBar();
    renderTree();

    if (res.relPath) {
      const targetEl = Array.from(document.querySelectorAll('#tree-content .af-tree-row'))
        .find((el) => el.dataset.relPath === res.relPath);
      if (targetEl) {
        targetEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }

    clearTimeout(state.pendingRevealTimer);
    state.pendingRevealTimer = setTimeout(() => {
      state.revealedRelPath = '';
      document.querySelectorAll('.af-tree-row.is-revealed').forEach((el) => el.classList.remove('is-revealed'));
    }, 2200);
  }

  function renderMentions() {
    const bar = $('mentions-bar');
    const countEl = $('mentions-count');
    const listEl = $('mentions-list');
    if (!bar || !countEl || !listEl) return;

    if (!state.mentions || state.mentions.length === 0) {
      bar.classList.add('hidden');
      return;
    }

    bar.classList.remove('hidden');
    countEl.textContent = String(state.mentions.length);
    listEl.innerHTML = state.mentions
      .map((m) => `
        <div class="af-chip" data-mention-abs="${esc(m.absPath)}" title="${esc(m.absPath)}">
          <span class="af-chip-name">${m.isDirectory ? '📁' : '📄'} ${esc(m.name)}</span>
          ${!m.isDirectory ? `<button class="af-chip-open" data-mention-preview="${esc(m.fileUri)}" data-mention-line="${m.line || ''}" type="button" title="原生预览">↗</button>` : ''}
        </div>`)
      .join('');
  }

  async function pollMentions() {
    if (document.hidden) return;
    const convId = getConversationId();
    if (!convId) return;
    try {
      const res = await apiGet('/api/mentions', {
        conversationId: convId,
        workspaceUri: state.roots.map((r) => r.path).join(','),
        etag: state.mentionsEtag
      });
      if (res.etag) state.mentionsEtag = res.etag;
      if (!res.unchanged) {
        state.mentions = Array.isArray(res.items) ? res.items : [];
        renderMentions();
      }
    } catch {}
  }

  function checkDeepLinkUrl() {
    if (window.location.search === state.lastHandledUrlQuery) return;
    state.lastHandledUrlQuery = window.location.search;
    const params = new URLSearchParams(window.location.search);
    const target = params.get('path') || params.get('file') || params.get('reveal');
    if (target) {
      revealPathInTree(target).catch((err) => showToast(err.message));
    }
  }

  async function refreshWorkspace(preserveRoot = true) {
    const uris = await getHostWorkspaceUris();
    const ws = await apiGet('/api/workspace', {
      workspaceUri: uris.join(','),
      conversationId: getConversationId()
    });
    const hostRoots = Array.isArray(ws.roots) ? ws.roots : [];
    const extRoots = state.roots.filter((r) => !hostRoots.some((h) => h.path === r.path));
    state.roots = [...hostRoots, ...extRoots];

    if (!preserveRoot || !state.roots.some((r) => r.path === state.activeRoot)) {
      state.activeRoot = ws.primaryRoot || state.roots[0]?.path || '';
    }
    renderRootSelect();

    if (state.activeRoot) {
      const expanded = Array.from(getExpandedSet(state.activeRoot));
      clearCacheForRoot(state.activeRoot);
      await Promise.all(expanded.map((d) => fetchDir(state.activeRoot, d, true).catch(() => [])));
      renderTree();
    }
    return ws;
  }

  function isMacPlatform() {
    const plat = state.shortcutInfo?.platform || navigator.platform || '';
    return /mac|darwin/i.test(plat);
  }

  function extractKeyTokenFromKeyboardEvent(e) {
    const code = String(e.code || '');
    if (/^Key([A-Z])$/.test(code)) return code.slice(3);
    if (/^Digit([0-9])$/.test(code)) return code.slice(5);
    if (/^F([1-9]|1[0-2])$/.test(code)) return code;
    if (
      ['Space', 'Backquote', 'Minus', 'Equal', 'BracketLeft', 'BracketRight',
        'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash'].includes(code)
    ) {
      return code;
    }
    const key = String(e.key || '');
    if (/^[a-zA-Z0-9]$/.test(key)) return key.toUpperCase();
    if (/^F([1-9]|1[0-2])$/i.test(key)) return key.toUpperCase();
    return '';
  }

  function buildAcceleratorFromKeyboardEvent(e) {
    const keyToken = extractKeyTokenFromKeyboardEvent(e);
    if (!keyToken) return '';
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Meta');
    const hasPrimary = e.ctrlKey || e.altKey || e.metaKey;
    const isFn = /^F([1-9]|1[0-2])$/.test(keyToken);
    if (!hasPrimary && !isFn) return '';
    return [...mods, keyToken].join('+');
  }

  function shortcutMatchesKeyboardEvent(e, cfg) {
    if (!cfg || !cfg.enabled || !cfg.accelerator) return false;
    const parts = String(cfg.accelerator).split('+').filter(Boolean);
    if (!parts.length) return false;
    const keyPart = parts[parts.length - 1];
    const modSet = new Set(parts.slice(0, -1));
    if (Boolean(e.ctrlKey) !== modSet.has('Ctrl')) return false;
    if (Boolean(e.altKey) !== modSet.has('Alt')) return false;
    if (Boolean(e.shiftKey) !== modSet.has('Shift')) return false;
    if (Boolean(e.metaKey) !== modSet.has('Meta')) return false;
    return extractKeyTokenFromKeyboardEvent(e) === keyPart;
  }

  function getPresetLabel(presetId) {
    if (presetId === 'custom' && state.drawerShortcut?.display) {
      return state.drawerShortcut.display;
    }
    const presets = state.shortcutInfo?.presets || [];
    const found = presets.find((p) => p.id === presetId);
    if (!found) return state.drawerShortcut?.display || presetId;
    return isMacPlatform() ? found.macLabel : found.winLabel;
  }

  function matchesHotkeyEvent(e, presetId) {
    if (state.drawerShortcut) {
      return shortcutMatchesKeyboardEvent(e, state.drawerShortcut);
    }
    if (!presetId || presetId === 'off') return false;
    const key = String(e.key || '').toLowerCase();
    if (presetId === 'cmd+shift+e') return e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey && key === 'e';
    if (presetId === 'cmd+alt+e') return e.metaKey && e.altKey && !e.shiftKey && !e.ctrlKey && key === 'e';
    if (presetId === 'ctrl+shift+e') return e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && key === 'e';
    if (presetId === 'cmd+shift+y') return e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey && key === 'y';
    return false;
  }

  function setRecordingTarget(target) {
    state.recordingTarget = target || null;
    window.sidecar?.setShortcutRecording?.(Boolean(state.recordingTarget));
    renderShortcutPanel();
  }

  function renderShortcutPanel() {
    const info = state.shortcutInfo;
    const selectEl = $('hotkey-preset-select');
    const hintEl = $('shortcut-hint');
    const cliRow = $('shortcut-cli-row');
    const hostEl = $('host-shortcut-summary');
    const drawerBtn = $('btn-drawer');
    const drawerActionBtn = $('btn-drawer-action');
    const mac = isMacPlatform();

    const drawerCfg = state.drawerShortcut || {
      enabled: state.hotkeyPreset !== 'off',
      display: getPresetLabel(state.hotkeyPreset),
      scope: 'app'
    };
    const auxCfg = state.auxShortcut || {
      enabled: true,
      display: mac ? '⌥⌘E' : 'Ctrl+Alt+E',
      scope: drawerCfg.scope || 'app'
    };
    const scope = drawerCfg.scope || auxCfg.scope || 'app';

    if (selectEl && Array.isArray(info?.presets)) {
      const options = info.presets.map((p) => {
        const label = mac ? p.macLabel : p.winLabel;
        return `<option value="${esc(p.id)}"${p.id === state.hotkeyPreset ? ' selected' : ''}>${esc(label)} · ${esc(p.desc)}</option>`;
      });
      if (state.hotkeyPreset === 'custom') {
        options.push(`<option value="custom" selected>${esc(drawerCfg.display || '自定义')} · 自定义组合</option>`);
      }
      selectEl.innerHTML = options.join('');
    }

    const drawerRecBtn = $('btn-record-drawer-shortcut');
    const drawerKbd = $('drawer-shortcut-kbd-label');
    const drawerSub = $('drawer-shortcut-record-hint');
    if (drawerRecBtn && drawerKbd && drawerSub) {
      const recordingDrawer = state.recordingTarget === 'drawer';
      drawerRecBtn.classList.toggle('is-recording', recordingDrawer);
      drawerRecBtn.classList.toggle('is-disabled', !drawerCfg.enabled && !recordingDrawer);
      drawerKbd.textContent = recordingDrawer
        ? '请按下组合键…'
        : (drawerCfg.enabled ? (drawerCfg.display || '⇧⌘E') : '已关闭');
      drawerSub.textContent = recordingDrawer ? 'Esc 取消' : '点击修改';
    }

    const auxRecBtn = $('btn-record-aux-shortcut');
    const auxKbd = $('aux-shortcut-kbd-label');
    const auxSub = $('aux-shortcut-record-hint');
    const auxToggleBtn = $('btn-toggle-aux-shortcut');
    if (auxRecBtn && auxKbd && auxSub) {
      const recordingAux = state.recordingTarget === 'aux';
      auxRecBtn.classList.toggle('is-recording', recordingAux);
      auxRecBtn.classList.toggle('is-disabled', !auxCfg.enabled && !recordingAux);
      auxKbd.textContent = recordingAux
        ? '请按下组合键…'
        : (auxCfg.enabled ? (auxCfg.display || (mac ? '⌥⌘E' : 'Ctrl+Alt+E')) : '已关闭');
      auxSub.textContent = recordingAux ? 'Esc 取消' : '点击修改';
    }
    if (auxToggleBtn) {
      auxToggleBtn.textContent = auxCfg.enabled ? '已开启' : '已关闭';
      auxToggleBtn.classList.toggle('is-active', Boolean(auxCfg.enabled));
    }

    const auxOpenBtn = $('btn-aux-open');
    if (auxOpenBtn) {
      auxOpenBtn.textContent = (!state.isDrawerMode && !window.__AF_DRAWER_MODE__ && typeof window.sidecar?.ui?.toggleAuxPane === 'function')
        ? '收起侧栏'
        : '切换侧栏';
    }

    const scopeRow = $('shortcut-scope-row');
    const scopeBtn = $('btn-shortcut-scope');
    if (scopeRow) scopeRow.classList.toggle('hidden', !mac);
    if (scopeBtn) {
      scopeBtn.textContent = scope === 'global' ? '系统全局' : '仅 AGY 内';
      scopeBtn.classList.toggle('is-active', scope === 'global');
    }

    const activeLabel = drawerCfg.enabled ? (drawerCfg.display || getPresetLabel(state.hotkeyPreset)) : '已关闭';
    const auxLabel = auxCfg.enabled ? (auxCfg.display || (mac ? '⌥⌘E' : 'Ctrl+Alt+E')) : '已关闭';
    if (drawerBtn) {
      if (state.isDrawerMode) {
        drawerBtn.classList.toggle('is-active', state.drawerVisible !== false);
        drawerBtn.title = `收回独立目录树抽屉 (${activeLabel} / Esc)`;
      } else {
        drawerBtn.classList.toggle('is-active', Boolean(state.drawerVisible));
        drawerBtn.title = `弹出 / 收回右侧独立目录树抽屉 (${activeLabel})`;
      }
    }
    if (drawerActionBtn) {
      if (state.isDrawerMode) {
        drawerActionBtn.textContent = '收回抽屉';
      } else {
        drawerActionBtn.textContent = state.drawerVisible ? '收回抽屉' : '打开抽屉';
      }
    }

    if (hintEl) {
      if (mac) {
        const scopeText = scope === 'global'
          ? '系统全局生效（任意应用中都可唤起）'
          : '仅 Antigravity 为前台应用时激活（零辅助功能权限、不与 VS Code 冲突）';
        hintEl.textContent = `独立抽屉 ${activeLabel} · AGY 右侧辅助栏 ${auxLabel} · ${scopeText}。`;
      } else {
        hintEl.textContent = 'Windows / Linux 可将下方 CLI 命令绑定到系统快捷键（PowerToys / AutoHotkey / GNOME），或按自定义快捷键直接触发。';
      }
    }

    if (cliRow) {
      cliRow.classList.toggle('hidden', mac);
    }

    if (hostEl) {
      const toggleKey = info?.hostShortcuts?.toggleSidePanel || (mac ? '⌘⇧B' : 'Ctrl+Shift+B');
      hostEl.innerHTML = `<kbd class="af-kbd">${esc(auxLabel)}</kbd> 直达目录树 · <kbd class="af-kbd">${esc(toggleKey)}</kbd> 显隐辅助栏`;
    }
  }

  async function loadShortcutInfo() {
    try {
      const res = await apiGet('/api/shortcut');
      state.shortcutInfo = res;
      state.drawerShortcut = res.drawerShortcut || res.shortcut || res.settings?.drawerShortcut || state.drawerShortcut;
      state.auxShortcut = res.auxShortcut || res.settings?.auxShortcut || state.auxShortcut;
      state.hotkeyPreset = res.drawer?.hotkeyPreset || res.settings?.hotkeyPreset || state.hotkeyPreset;
      state.drawerVisible = Boolean(res.drawer?.windowVisible);
      if (typeof res.drawer?.pinned === 'boolean') {
        state.drawerPinned = res.drawer.pinned;
      }
      renderShortcutPanel();
    } catch {}
  }

  function toggleShortcutPanel(force) {
    state.shortcutPanelOpen = typeof force === 'boolean' ? force : !state.shortcutPanelOpen;
    if (!state.shortcutPanelOpen && state.recordingTarget) {
      setRecordingTarget(null);
    }
    $('shortcut-panel')?.classList.toggle('hidden', !state.shortcutPanelOpen);
    const btn = $('btn-shortcuts');
    btn?.classList.toggle('is-active', state.shortcutPanelOpen);
    btn?.setAttribute('aria-expanded', String(state.shortcutPanelOpen));
  }

  function closeDrawerWindow() {
    if (window.sidecar?.closeDrawerWindow) {
      window.sidecar.closeDrawerWindow();
      return;
    }
    apiPost('/api/shortcut', { action: 'close' }).catch(() => {});
  }

  async function triggerDrawerAction(action, extra = {}) {
    try {
      const res = await apiPost('/api/shortcut', {
        action,
        revealPath: extra.revealPath || state.selectedAbsPath || '',
        ...extra
      });
      if (typeof res.windowVisible === 'boolean') state.drawerVisible = res.windowVisible;
      if (typeof res.hotkeyPreset === 'string') state.hotkeyPreset = res.hotkeyPreset;
      if (res.drawerShortcut) state.drawerShortcut = res.drawerShortcut;
      if (res.auxShortcut) state.auxShortcut = res.auxShortcut;
      renderShortcutPanel();
      if (res.error) showToast(res.error);
      else if (res.message) showToast(res.message);
      return res;
    } catch (err) {
      showToast(`操作失败：${err.message}`);
      return null;
    }
  }

  async function selectTreeRow(row) {
    if (!row) return;
    if (row.dataset.searchAbs) {
      await revealPathInTree(row.dataset.searchAbs);
      return;
    }
    const relPath = row.dataset.relPath;
    if (!relPath) return;
    const fileUri = row.dataset.fileUri;
    const isDir = row.dataset.isDir === '1';
    const absPath = state.activeRoot ? `${state.activeRoot}/${relPath}` : relPath;

    state.selectedRelPath = relPath;
    state.selectedAbsPath = absPath;
    state.selectedFileUri = fileUri;
    state.selectedIsDir = isDir;
    renderActivePathBar();
    renderTree();
  }

  function getSelectableRows() {
    return Array.from(document.querySelectorAll('#tree-content .af-tree-row[data-rel-path], #tree-content .af-tree-row[data-search-abs]'));
  }

  function scrollSelectedRowIntoView() {
    const sel = document.querySelector('#tree-content .af-tree-row.is-selected');
    sel?.scrollIntoView({ block: 'nearest' });
  }

  async function navigateTree(delta) {
    const rows = getSelectableRows();
    if (rows.length === 0) return;
    let idx = rows.findIndex((r) => r.classList.contains('is-selected'));
    if (idx < 0) {
      idx = delta >= 0 ? 0 : rows.length - 1;
    } else {
      idx = Math.max(0, Math.min(rows.length - 1, idx + delta));
    }
    const target = rows[idx];
    if (!target) return;
    if (target.dataset.searchAbs) {
      rows.forEach((r) => r.classList.toggle('is-selected', r === target));
      state.selectedAbsPath = target.dataset.searchAbs;
      state.selectedFileUri = target.dataset.fileUri || '';
      state.selectedIsDir = target.dataset.isDir === '1';
      state.selectedRelPath = '';
      renderActivePathBar();
      scrollSelectedRowIntoView();
      return;
    }
    await selectTreeRow(target);
    scrollSelectedRowIntoView();
  }

  async function toggleDirectoryByRelPath(relPath, forceOpen) {
    if (!state.activeRoot || !relPath) return;
    const expanded = getExpandedSet(state.activeRoot);
    const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : !expanded.has(relPath);
    if (shouldOpen) {
      expanded.add(relPath);
      renderTree();
      await fetchDir(state.activeRoot, relPath).catch(() => []);
      renderTree();
    } else {
      expanded.delete(relPath);
      renderTree();
    }
    scrollSelectedRowIntoView();
  }

  async function handleArrowRight() {
    if (!state.selectedRelPath || state.searchQuery.trim()) return;
    if (!state.selectedIsDir) return;
    const expanded = getExpandedSet(state.activeRoot);
    if (!expanded.has(state.selectedRelPath)) {
      await toggleDirectoryByRelPath(state.selectedRelPath, true);
    } else {
      await navigateTree(1);
    }
  }

  async function handleArrowLeft() {
    if (!state.selectedRelPath || state.searchQuery.trim()) return;
    const expanded = getExpandedSet(state.activeRoot);
    if (state.selectedIsDir && expanded.has(state.selectedRelPath)) {
      await toggleDirectoryByRelPath(state.selectedRelPath, false);
      return;
    }
    const lastSlash = state.selectedRelPath.lastIndexOf('/');
    if (lastSlash > 0) {
      const parentRel = state.selectedRelPath.slice(0, lastSlash);
      const parentRow = Array.from(document.querySelectorAll('#tree-content .af-tree-row[data-rel-path]'))
        .find((r) => r.dataset.relPath === parentRel);
      if (parentRow) {
        await selectTreeRow(parentRow);
        scrollSelectedRowIntoView();
      }
    }
  }

  let searchTimer = null;
  function handleSearchInput(value) {
    state.searchQuery = value;
    $('btn-clear-search')?.classList.toggle('hidden', !value);
    clearTimeout(searchTimer);

    const trimmed = value.trim();
    if (!trimmed) {
      state.searchResults = null;
      renderTree();
      return;
    }

    searchTimer = setTimeout(async () => {
      if (!state.activeRoot) return;
      try {
        const res = await apiGet('/api/search', {
          root: state.activeRoot,
          q: trimmed,
          showHidden: state.showHidden ? '1' : '0'
        });
        if (state.searchQuery.trim() === trimmed) {
          state.searchResults = Array.isArray(res.results) ? res.results : [];
          renderTree();
        }
      } catch {}
    }, 160);
  }

  function bindEvents() {
    $('root-select')?.addEventListener('change', async (e) => {
      state.activeRoot = e.target.value;
      state.selectedRelPath = '';
      state.selectedAbsPath = '';
      renderActivePathBar();
      await fetchDir(state.activeRoot, '');
      renderTree();
    });

    $('btn-toggle-hidden')?.addEventListener('click', async () => {
      state.showHidden = !state.showHidden;
      const btn = $('btn-toggle-hidden');
      btn?.classList.toggle('is-active', state.showHidden);
      btn?.setAttribute('aria-pressed', String(state.showHidden));
      if (state.activeRoot) {
        clearCacheForRoot(state.activeRoot);
        const expanded = Array.from(getExpandedSet(state.activeRoot));
        await Promise.all(expanded.map((d) => fetchDir(state.activeRoot, d, true).catch(() => [])));
        renderTree();
      }
      if (state.searchQuery.trim()) {
        handleSearchInput(state.searchQuery);
      }
    });

    $('btn-collapse-all')?.addEventListener('click', () => {
      if (!state.activeRoot) return;
      state.expandedByRoot.set(state.activeRoot, new Set(['']));
      renderTree();
    });

    $('btn-drawer')?.addEventListener('click', () => {
      if (state.isDrawerMode) {
        closeDrawerWindow();
        return;
      }
      triggerDrawerAction('toggle');
    });

    $('btn-drawer-action')?.addEventListener('click', () => {
      if (state.isDrawerMode) {
        closeDrawerWindow();
        return;
      }
      triggerDrawerAction('toggle');
    });

    $('btn-shortcuts')?.addEventListener('click', () => {
      toggleShortcutPanel();
    });

    $('hotkey-preset-select')?.addEventListener('change', (e) => {
      if (e.target.value === 'custom') return;
      triggerDrawerAction('set-hotkey', { hotkeyPreset: e.target.value });
    });

    $('btn-record-drawer-shortcut')?.addEventListener('click', () => {
      setRecordingTarget(state.recordingTarget === 'drawer' ? null : 'drawer');
    });

    $('btn-reset-drawer-shortcut')?.addEventListener('click', () => {
      setRecordingTarget(null);
      triggerDrawerAction('set-drawer-shortcut', { reset: true });
    });

    $('btn-record-aux-shortcut')?.addEventListener('click', () => {
      setRecordingTarget(state.recordingTarget === 'aux' ? null : 'aux');
    });

    $('btn-toggle-aux-shortcut')?.addEventListener('click', () => {
      setRecordingTarget(null);
      const nextEnabled = !(state.auxShortcut?.enabled ?? true);
      triggerDrawerAction('set-aux-shortcut', { enabled: nextEnabled });
    });

    $('btn-reset-aux-shortcut')?.addEventListener('click', () => {
      setRecordingTarget(null);
      triggerDrawerAction('set-aux-shortcut', { reset: true });
    });

    $('btn-aux-open')?.addEventListener('click', () => {
      if (!state.isDrawerMode && !window.__AF_DRAWER_MODE__ && typeof window.sidecar?.ui?.toggleAuxPane === 'function') {
        postSidecarCloseKeyEvent();
        return;
      }
      triggerDrawerAction('trigger-aux', {
        auxAction: 'toggle',
        convId: window.sidecar?.conversationId || ''
      });
    });

    $('btn-shortcut-scope')?.addEventListener('click', () => {
      const curScope = state.drawerShortcut?.scope || state.auxShortcut?.scope || 'app';
      const nextScope = curScope === 'global' ? 'app' : 'global';
      triggerDrawerAction('set-aux-shortcut', { scope: nextScope });
    });

    $('btn-copy-cli')?.addEventListener('click', () => {
      copyText('agy-finder aux', '侧栏 CLI 命令');
    });

    $('btn-preview-close')?.addEventListener('click', closePreviewModal);
    $('btn-preview-os')?.addEventListener('click', () => {
      if (state.previewPath) revealInOs(state.previewPath);
    });

    $('btn-theme')?.addEventListener('click', () => {
      const next = detectHostDarkTheme() ? 'light' : 'dark';
      state.themeOverride = next;
      applyTheme();
    });

    $('btn-refresh')?.addEventListener('click', async () => {
      await refreshWorkspace(true);
      await pollMentions();
      showToast('已刷新');
    });

    $('btn-paste-reveal')?.addEventListener('click', async () => {
      try {
        if (navigator.clipboard?.readText) {
          const text = (await navigator.clipboard.readText()).trim();
          if (text) {
            await revealPathInTree(text);
            return;
          }
        }
      } catch {}
      $('search-input')?.focus();
      showToast('请按 Cmd/Ctrl+V 粘贴路径后回车定位');
    });

    const searchInput = $('search-input');
    searchInput?.addEventListener('input', (e) => handleSearchInput(e.target.value));
    searchInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && searchInput.value.trim()) {
        e.preventDefault();
        revealPathInTree(searchInput.value.trim()).catch((err) => showToast(err.message));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        $('tree-viewport')?.focus();
        navigateTree(1);
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        if (searchInput.value) {
          searchInput.value = '';
          handleSearchInput('');
        } else {
          searchInput.blur();
          $('tree-viewport')?.focus();
        }
      }
    });

    $('btn-clear-search')?.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      handleSearchInput('');
    });

    $('btn-toggle-mentions')?.addEventListener('click', () => {
      state.mentionsCollapsed = !state.mentionsCollapsed;
      $('mentions-bar')?.classList.toggle('is-collapsed', state.mentionsCollapsed);
      const chev = $('mentions-chevron');
      if (chev) chev.textContent = state.mentionsCollapsed ? '▸' : '▾';
      $('btn-toggle-mentions')?.setAttribute('aria-expanded', String(!state.mentionsCollapsed));
    });

    $('mentions-list')?.addEventListener('click', (e) => {
      const previewBtn = e.target.closest('[data-mention-preview]');
      if (previewBtn) {
        e.stopPropagation();
        const chipEl = previewBtn.closest('[data-mention-abs]');
        openNativePreview(previewBtn.dataset.mentionPreview, previewBtn.dataset.mentionLine, chipEl?.dataset.mentionAbs || '');
        return;
      }
      const chip = e.target.closest('[data-mention-abs]');
      if (chip) {
        revealPathInTree(chip.dataset.mentionAbs).catch((err) => showToast(err.message));
      }
    });

    $('btn-copy-active')?.addEventListener('click', (e) => {
      if (!state.selectedAbsPath) return;
      const copyAbs = e.shiftKey || e.altKey || !state.selectedRelPath;
      copyText(copyAbs ? state.selectedAbsPath : state.selectedRelPath, copyAbs ? '绝对路径' : '相对路径');
    });

    $('btn-preview-active')?.addEventListener('click', () => {
      if ((state.selectedFileUri || state.selectedAbsPath) && !state.selectedIsDir) {
        openNativePreview(state.selectedFileUri, null, state.selectedAbsPath);
      }
    });

    const treeContent = $('tree-content');
    treeContent?.addEventListener('click', async (e) => {
      const searchRow = e.target.closest('[data-search-abs]');
      if (searchRow) {
        await revealPathInTree(searchRow.dataset.searchAbs);
        return;
      }

      const row = e.target.closest('.af-tree-row[data-rel-path]');
      if (!row) return;
      const relPath = row.dataset.relPath;
      const fileUri = row.dataset.fileUri;
      const isDir = row.dataset.isDir === '1';
      const absPath = state.activeRoot ? `${state.activeRoot}/${relPath}` : relPath;

      const actBtn = e.target.closest('[data-act]');
      if (actBtn) {
        e.stopPropagation();
        const act = actBtn.dataset.act;
        if (act === 'preview') openNativePreview(fileUri, null, absPath);
        else if (act === 'copy') {
          const copyAbs = e.shiftKey || e.altKey;
          copyText(copyAbs ? absPath : relPath, copyAbs ? '绝对路径' : '相对路径');
        } else if (act === 'os') {
          revealInOs(relPath);
        }
        return;
      }

      state.selectedRelPath = relPath;
      state.selectedAbsPath = absPath;
      state.selectedFileUri = fileUri;
      state.selectedIsDir = isDir;
      renderActivePathBar();

      if (isDir) {
        await toggleDirectoryByRelPath(relPath);
      } else {
        renderTree();
      }
    });

    treeContent?.addEventListener('dblclick', (e) => {
      const row = e.target.closest('.af-tree-row[data-rel-path]');
      if (!row || row.dataset.isDir === '1') return;
      const absPath = state.activeRoot ? `${state.activeRoot}/${row.dataset.relPath}` : row.dataset.relPath;
      openNativePreview(row.dataset.fileUri, null, absPath);
    });

    document.addEventListener('keydown', async (e) => {
      if (e.isComposing) return;

      if (state.recordingTarget) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') {
          setRecordingTarget(null);
          return;
        }
        if (['Meta', 'Control', 'Alt', 'Shift', 'CapsLock'].includes(e.key)) {
          return;
        }
        const accel = buildAcceleratorFromKeyboardEvent(e);
        if (!accel) {
          showToast('请按下包含 ⌘ / ⌥ / ⌃ 的组合键（或 F1-F12）');
          return;
        }
        const target = state.recordingTarget;
        setRecordingTarget(null);
        await triggerDrawerAction(target === 'aux' ? 'set-aux-shortcut' : 'set-drawer-shortcut', {
          accelerator: accel,
          enabled: true
        });
        return;
      }

      if (state.isDrawerMode && matchesHotkeyEvent(e, state.hotkeyPreset)) {
        e.preventDefault();
        closeDrawerWindow();
        return;
      }

      if (!state.isDrawerMode && shortcutMatchesKeyboardEvent(e, state.auxShortcut) && typeof window.sidecar?.ui?.toggleAuxPane === 'function') {
        e.preventDefault();
        postSidecarCloseKeyEvent();
        return;
      }

      const isMod = e.metaKey || e.ctrlKey;
      const key = String(e.key || '');
      const lower = key.toLowerCase();
      const activeTag = document.activeElement?.tagName || '';
      const inInput = activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT';

      if (isMod && !e.shiftKey && !e.altKey && lower === 'f') {
        e.preventDefault();
        searchInput?.focus();
        searchInput?.select();
        return;
      }
      if (isMod && !e.shiftKey && !e.altKey && key === '.') {
        e.preventDefault();
        $('btn-toggle-hidden')?.click();
        return;
      }

      if (!inInput && !isMod && !e.altKey && key === '/') {
        e.preventDefault();
        searchInput?.focus();
        searchInput?.select();
        return;
      }
      if (!inInput && !isMod && !e.altKey && key === '?') {
        e.preventDefault();
        toggleShortcutPanel();
        return;
      }

      if (key === 'Escape') {
        if (!$('preview-modal')?.classList.contains('hidden')) {
          e.preventDefault();
          closePreviewModal();
          return;
        }
        if (state.shortcutPanelOpen) {
          e.preventDefault();
          toggleShortcutPanel(false);
          return;
        }
        if (state.searchQuery) {
          e.preventDefault();
          if (searchInput) searchInput.value = '';
          handleSearchInput('');
          return;
        }
        if (state.isDrawerMode) {
          e.preventDefault();
          closeDrawerWindow();
          return;
        }
      }

      if (inInput || isMod || e.altKey) return;

      if (key === 'ArrowDown') {
        e.preventDefault();
        await navigateTree(1);
      } else if (key === 'ArrowUp') {
        e.preventDefault();
        await navigateTree(-1);
      } else if (key === 'ArrowRight') {
        e.preventDefault();
        await handleArrowRight();
      } else if (key === 'ArrowLeft') {
        e.preventDefault();
        await handleArrowLeft();
      } else if (key === 'Enter' && state.selectedAbsPath) {
        e.preventDefault();
        if (state.searchQuery.trim()) {
          await revealPathInTree(state.selectedAbsPath);
        } else if (state.selectedIsDir && state.selectedRelPath) {
          await toggleDirectoryByRelPath(state.selectedRelPath);
        } else if (state.selectedFileUri || state.selectedAbsPath) {
          openNativePreview(state.selectedFileUri, null, state.selectedAbsPath);
        }
      }
    });

    window.__afOnHostEvent = (ev) => {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'pinChanged') {
        state.drawerPinned = Boolean(ev.pinned);
      } else if (ev.type === 'hotkeyChanged' && typeof ev.hotkeyPreset === 'string') {
        state.hotkeyPreset = ev.hotkeyPreset;
        loadShortcutInfo().catch(() => renderShortcutPanel());
      } else if (ev.type === 'drawerShortcutChanged') {
        state.drawerShortcut = {
          ...(state.drawerShortcut || {}),
          enabled: Boolean(ev.enabled),
          accelerator: ev.accelerator ?? state.drawerShortcut?.accelerator,
          display: ev.display ?? state.drawerShortcut?.display,
          scope: ev.scope ?? state.drawerShortcut?.scope
        };
        if (ev.scope && state.auxShortcut) {
          state.auxShortcut = { ...state.auxShortcut, scope: ev.scope };
        }
        renderShortcutPanel();
      } else if (ev.type === 'auxShortcutChanged') {
        state.auxShortcut = {
          ...(state.auxShortcut || {}),
          enabled: Boolean(ev.enabled),
          accelerator: ev.accelerator ?? state.auxShortcut?.accelerator,
          display: ev.display ?? state.auxShortcut?.display,
          scope: ev.scope ?? state.auxShortcut?.scope
        };
        if (ev.scope && state.drawerShortcut) {
          state.drawerShortcut = { ...state.drawerShortcut, scope: ev.scope };
        }
        renderShortcutPanel();
      } else if (ev.type === 'revealPath' && ev.revealPath) {
        revealPathInTree(ev.revealPath).catch((err) => showToast(err.message));
      } else if (ev.type === 'windowShown') {
        state.drawerVisible = true;
        refreshWorkspace(true).catch(() => {});
        pollMentions().catch(() => {});
        if (ev.revealPath) {
          revealPathInTree(ev.revealPath).catch((err) => showToast(err.message));
        } else {
          $('tree-viewport')?.focus();
        }
      }
    };

    window.addEventListener('message', (event) => {
      if (event.data?.type === 'theme-change') {
        setTimeout(applyTheme, 20);
        return;
      }
      const data = typeof event.data === 'string' ? (() => { try { return JSON.parse(event.data); } catch { return null; } })() : event.data;
      const target = data && typeof data === 'object' ? (data.path || data.file || data.reveal) : '';
      if (typeof target === 'string' && target.trim()) {
        revealPathInTree(target).catch((err) => showToast(err.message));
      }
    });

    window.addEventListener('popstate', checkDeepLinkUrl);
    window.addEventListener('hashchange', checkDeepLinkUrl);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) pollMentions();
    });

    window.sidecar?.onWorkspaceChange?.(() => {
      refreshWorkspace(false).catch(() => {});
    });
  }

  function postSidecarCloseKeyEvent() {
    const isMac = isMacPlatform();
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
    if (
      !window.sidecar ||
      state.isDrawerMode ||
      window.__AF_DRAWER_MODE__ ||
      typeof window.sidecar.ui?.toggleAuxPane !== 'function'
    ) {
      return;
    }

    let visibleSince = (window.innerWidth > 40 && window.innerHeight > 40) ? Date.now() : 0;
    let lastSeenSeq = 0;

    const reportHello = () => {
      const convId = getConversationId();
      if (convId) {
        apiPost('/api/aux-pane-trigger', { action: 'hello', convId }).catch(() => {});
      }
    };

    const handleVisibilityChange = () => {
      const nowVisible = window.innerWidth > 40 && window.innerHeight > 40;
      if (nowVisible) {
        const becameVisible = !visibleSince;
        if (becameVisible) {
          visibleSince = Date.now();
          reportHello();
          apiGet('/api/aux-pane-trigger', { waitMs: 0 }).then(async (res) => {
            const trig = res?.trigger;
            if (
              trig?.seq &&
              (Date.now() - Number(trig.at || 0)) < 2500 &&
              trig.targetPlugin &&
              trig.targetPlugin !== 'agy-finder' &&
              Number(trig.switchedSeq || 0) < trig.seq &&
              trig.uri
            ) {
              const sw = await apiPost('/api/aux-pane-trigger', { action: 'switched', seq: trig.seq }).catch(() => null);
              if (sw?.claimed !== false) {
                window.sidecar.ui.toggleAuxPane({ tabType: 'sidecarView', uri: trig.uri });
              }
            } else if (
              trig?.seq &&
              trig.targetPlugin === 'agy-finder' &&
              trig.revealPath &&
              (Date.now() - Number(trig.at || 0)) < 2500
            ) {
              revealPathInTree(trig.revealPath).catch(() => {});
            }
          }).catch(() => {});
        }
      } else {
        visibleSince = 0;
      }
    };

    reportHello();

    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(handleVisibilityChange);
      ro.observe(document.documentElement);
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

      const isVisibleNow = window.innerWidth > 40 && window.innerHeight > 40;
      const wasAlreadyVisible = visibleSince > 0 && visibleSince <= Number(trigger.at || 0) - 40;

      if (trigger.targetPlugin !== 'agy-finder') {
        if (isVisibleNow && trigger.uri) {
          const ackRes = await apiPost('/api/aux-pane-trigger', {
            action: 'ack',
            seq,
            plugin: 'agy-finder'
          }).catch(() => null);
          if (ackRes?.claimed === false) return;
          await apiPost('/api/aux-pane-trigger', { action: 'switched', seq }).catch(() => null);
          sessionStorage.setItem('agy_aux_last_ack_seq', String(seq));
          window.sidecar.ui.toggleAuxPane({ tabType: 'sidecarView', uri: trigger.uri });
        }
        return;
      }

      if (isVisibleNow && wasAlreadyVisible) {
        const ackRes = await apiPost('/api/aux-pane-trigger', {
          action: 'ack',
          seq,
          plugin: 'agy-finder'
        }).catch(() => null);
        if (ackRes?.claimed === false) return;
        sessionStorage.setItem('agy_aux_last_ack_seq', String(seq));
        if (trigger.revealPath) {
          revealPathInTree(trigger.revealPath).catch(() => {});
          if (trigger.action === 'open') return;
        }
        if (trigger.action !== 'open') {
          postSidecarCloseKeyEvent();
        }
        return;
      }

      if (!isVisibleNow) {
        const myConvId = getConversationId();
        const targetConvId = trigger.convId || myConvId;
        const waitBeforeClaim = (!trigger.convId || !myConvId || myConvId === trigger.convId) ? 110 : 200;
        await new Promise((r) => setTimeout(r, waitBeforeClaim));

        const recheck = await apiGet('/api/aux-pane-trigger', { waitMs: 0 }).catch(() => null);
        const latestTrig = recheck?.trigger;
        if (latestTrig && Number(latestTrig.ackSeq || 0) >= seq) return;
        if (window.innerWidth > 40 && window.innerHeight > 40) return;

        if (!targetConvId || typeof window.sidecar.ui?.toggleConversation !== 'function') return;

        const ackRes = await apiPost('/api/aux-pane-trigger', {
          action: 'ack',
          seq,
          plugin: 'agy-finder'
        }).catch(() => null);
        if (!ackRes?.claimed) return;

        sessionStorage.setItem('agy_aux_last_ack_seq', String(seq));
        if (trigger.revealPath) {
          revealPathInTree(trigger.revealPath).catch(() => {});
        }
        window.sidecar.ui.toggleConversation(targetConvId);
      }
    };

    (async () => {
      try {
        const initRes = await apiGet('/api/aux-pane-trigger', { waitMs: 0 });
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
          const res = await apiGet('/api/aux-pane-trigger', { since: lastSeenSeq, waitMs: 8500 });
          if (res?.trigger) {
            await handleTrigger(res.trigger);
          }
        } catch {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    })();
  }

  async function bootstrap() {
    applyTheme();
    bindEvents();
    const ws = await refreshWorkspace(false).catch((err) => {
      showToast(err.message);
      return null;
    });
    await loadShortcutInfo();
    checkDeepLinkUrl();
    if (state.isDrawerMode && !state.selectedAbsPath && ws?.lastRevealPath) {
      revealPathInTree(ws.lastRevealPath).catch(() => {});
    }
    startAuxPaneBridgeCoordinator();
    setInterval(checkDeepLinkUrl, 350);
    await pollMentions();
    setInterval(pollMentions, 2500);
  }

  bootstrap();
})();
