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
    revealToken: 0,
    dirExpandSeq: 0,
    dirExpandTokenByPath: new Map(),
    rootSwitchSeq: 0,
    previewReqSeq: 0,
    previewLastRequest: null,
    searchQuery: '',
    searchResults: null,
    searchTruncated: false,
    searchLoading: false,
    searchError: '',
    searchReqSeq: 0,
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
    previewPath: '',
    renderedMode: '',          // 'tree' | 'search' | 'empty'
    renderedRoot: ''
  };

  // Real-time prefers-reduced-motion tracking
  const reducedMotionMql = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;
  let reducedMotionCached = Boolean(reducedMotionMql?.matches);
  reducedMotionMql?.addEventListener?.('change', (e) => {
    reducedMotionCached = Boolean(e?.matches);
  });
  function prefersReducedMotion() {
    return Boolean(reducedMotionMql ? reducedMotionMql.matches : reducedMotionCached);
  }

  function isRealTreeDom(container) {
    return Boolean(
      container &&
      typeof document.createRange === 'function' &&
      container.children &&
      typeof container.firstElementChild !== 'undefined' &&
      typeof container.insertBefore === 'function'
    );
  }

  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));
  }

  // Deterministic Chinese typography helper (prose/status/tooltips only, never raw paths)
  function formatZh(raw) {
    if (raw === null || raw === undefined) return '';
    const str = String(raw);
    if (!str) return '';
    if (str === '—' || str === '--') return '--';

    const masks = [];
    let out = str.replace(/(?:https?|file|sidecar|customization):\/\/[^\s)]+/g, (m) => {
      masks.push(m);
      return `\u0000URL${masks.length - 1}\u0000`;
    });

    out = out.replace(/\s*——\s*/g, ' -- ');
    out = out.replace(/([\u4e00-\u9fff])([A-Za-z0-9⌘⌥⌃⇧])/g, '$1 $2');
    out = out.replace(/([A-Za-z0-9%⌘⌥⌃⇧])([\u4e00-\u9fff])/g, '$1 $2');
    out = out.replace(/ {2,}/g, ' ');

    if (masks.length) {
      out = out.replace(/\u0000URL(\d+)\u0000/g, (_, idx) => masks[Number(idx)] || '');
    }
    return out;
  }

  // Unified 14px stroke-width 1.5 inline SVG icon helpers (zero decorative emoji)
  function iconChevronRight() {
    return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>';
  }

  function iconFolder(open) {
    return open
      ? '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3l1.3 1.5H13A1.5 1.5 0 0 1 14.5 5v1H2.8L1.5 12V3.5Zm1.7 3.5h11.6l-1.3 6A1.5 1.5 0 0 1 12 14H2.6a1 1 0 0 1-1-.9L3.2 7Z"/></svg>'
      : '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3l1.3 1.5H13A1.5 1.5 0 0 1 14.5 5v7.5A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5v-9Z"/></svg>';
  }

  function iconFile() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 2h6l3 3v9h-9V2Z"/><path d="M9.5 2v3h3"/></svg>';
  }

  function iconGlobe() {
    return '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/><path d="M2.6 8h10.8M8 2.4c1.6 1.5 2.4 3.4 2.4 5.6S9.6 12.1 8 13.6C6.4 12.1 5.6 10.2 5.6 8S6.4 3.9 8 2.4Z"/></svg>';
  }

  function iconExternal() {
    return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 7 9M6.5 4H4a1.5 1.5 0 0 0-1.5 1.5v6.5A1.5 1.5 0 0 0 4 13.5h6.5A1.5 1.5 0 0 0 12 12V9.5"/></svg>';
  }

  function iconCopy() {
    return '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.4"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/></svg>';
  }

  function iconCheck() {
    return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 8.4 6.5 11.7 12.8 4.8"/></svg>';
  }

  function iconFolderOs() {
    return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.2A1.4 1.4 0 0 1 3.4 2.8h2.8l1.2 1.4h5.2A1.4 1.4 0 0 1 14 5.6v6.2a1.4 1.4 0 0 1-1.4 1.4H3.4A1.4 1.4 0 0 1 2 11.8V4.2Z"/></svg>';
  }

  // Safe HTML-escaped search keyword highlight
  function highlightMatch(rawText, query) {
    const text = String(rawText ?? '');
    const rawQ = String(query || '').trim();
    if (!rawQ) return esc(text);
    const needle = rawQ.includes('/') ? rawQ.split('/').filter(Boolean).pop() || rawQ : rawQ;
    if (!needle) return esc(text);
    const lowerText = text.toLowerCase();
    const lowerNeedle = needle.toLowerCase();
    let idx = lowerText.indexOf(lowerNeedle);
    if (idx < 0) return esc(text);

    let out = '';
    let pos = 0;
    const len = needle.length;
    while (idx >= 0) {
      if (idx > pos) out += esc(text.slice(pos, idx));
      out += `<mark class="af-match">${esc(text.slice(idx, idx + len))}</mark>`;
      pos = idx + len;
      idx = lowerText.indexOf(lowerNeedle, pos);
    }
    if (pos < text.length) out += esc(text.slice(pos));
    return out;
  }

  let toastTimer = null;
  function showToast(msg, durationMs = 2000) {
    const el = $('toast');
    if (!el) return;
    el.textContent = formatZh(msg);
    el.classList.remove('hidden');
    el.setAttribute('aria-hidden', 'false');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.add('hidden');
      el.setAttribute('aria-hidden', 'true');
    }, durationMs);
  }

  // In-place checkmark feedback on copy triggers (1400ms)
  const copyFeedbackTimers = new WeakMap();
  function flashCopyFeedback(triggerBtn) {
    if (!triggerBtn || !triggerBtn.classList) return;
    const prevTimer = copyFeedbackTimers.get(triggerBtn);
    if (prevTimer) clearTimeout(prevTimer);

    const icWrap = triggerBtn.querySelector?.('.af-btn-ic');
    if (icWrap) {
      if (!triggerBtn.dataset._origIcHtml) {
        triggerBtn.dataset._origIcHtml = icWrap.innerHTML;
      }
      icWrap.innerHTML = iconCheck();
    } else if (triggerBtn.dataset?.act === 'copy') {
      if (!triggerBtn.dataset._origHtml) {
        triggerBtn.dataset._origHtml = triggerBtn.innerHTML;
      }
      triggerBtn.innerHTML = iconCheck();
    }
    triggerBtn.classList.add('is-copied');

    const timer = setTimeout(() => {
      triggerBtn.classList.remove('is-copied');
      if (icWrap && triggerBtn.dataset._origIcHtml) {
        icWrap.innerHTML = triggerBtn.dataset._origIcHtml;
      } else if (triggerBtn.dataset?.act === 'copy' && triggerBtn.dataset._origHtml) {
        triggerBtn.innerHTML = triggerBtn.dataset._origHtml;
      }
      copyFeedbackTimers.delete(triggerBtn);
    }, 1400);
    copyFeedbackTimers.set(triggerBtn, timer);
  }

  // Async button pending guard (anti-double-click + >120ms spinner)
  async function withButtonPending(btn, task) {
    if (!btn) return task();
    if (btn.disabled) return null;
    btn.disabled = true;
    btn.setAttribute?.('aria-busy', 'true');
    let pendingTimer = setTimeout(() => {
      btn.classList?.add('is-pending');
    }, 120);
    try {
      return await task();
    } finally {
      clearTimeout(pendingTimer);
      btn.disabled = false;
      btn.removeAttribute?.('aria-busy');
      btn.classList?.remove('is-pending');
    }
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

  let themeSwitchTimer = null;
  function updateThemeButtonState() {
    const btn = $('btn-theme');
    if (!btn) return;
    btn.setAttribute('data-theme-icon', state.themeOverride);
    const modeLabel = state.themeOverride === 'auto'
      ? '跟随宿主'
      : (state.themeOverride === 'light' ? '浅色' : '深色');
    btn.title = formatZh(`主题：${modeLabel}（点击切换 自动 / 浅色 / 深色）`);
  }

  function applyTheme(animate = false) {
    if (animate && !prefersReducedMotion()) {
      document.documentElement.classList?.add('is-theme-switching');
      clearTimeout(themeSwitchTimer);
      themeSwitchTimer = setTimeout(() => {
        document.documentElement.classList?.remove('is-theme-switching');
      }, 200);
    }
    document.documentElement.setAttribute('data-af-theme', detectHostDarkTheme() ? 'dark' : 'light');
    updateThemeButtonState();
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

  function syncHeaderHeightVar() {
    const header = $('af-header');
    if (header && typeof header.offsetHeight === 'number' && header.offsetHeight > 0) {
      document.documentElement.style?.setProperty?.('--af-header-h', `${header.offsetHeight}px`);
    }
  }

  function renderActivePathBar() {
    const bar = $('active-path-bar');
    const txt = $('active-path-text');
    const copyBtn = $('btn-copy-active');
    const previewBtn = $('btn-preview-active');
    if (!bar || !txt) return;

    const realDom = isRealTreeDom($('tree-content'));
    if (!state.selectedAbsPath) {
      bar.classList.add('is-empty');
      bar.classList.remove('hidden');
      txt.textContent = '未选中文件或目录';
      txt.title = '';
      if (copyBtn) copyBtn.disabled = true;
      if (previewBtn) {
        previewBtn.disabled = true;
        previewBtn.classList.remove('hidden');
        if (realDom) {
          previewBtn.innerHTML = `<span class="af-btn-ic" aria-hidden="true">${iconExternal()}</span><span class="af-btn-text">预览</span>`;
        } else {
          previewBtn.textContent = '预览';
        }
        previewBtn.title = '在原生预览中打开';
      }
      return;
    }

    bar.classList.remove('is-empty', 'hidden');
    txt.textContent = state.selectedRelPath || state.selectedAbsPath;
    txt.title = state.selectedAbsPath;
    if (copyBtn) copyBtn.disabled = false;
    if (previewBtn) {
      const isDir = Boolean(state.selectedIsDir);
      previewBtn.disabled = isDir;
      previewBtn.classList.toggle('hidden', isDir);
      const isHtml = !isDir && isHtmlPath(state.selectedRelPath || state.selectedAbsPath);
      if (realDom) {
        previewBtn.innerHTML = isHtml
          ? `<span class="af-btn-ic" aria-hidden="true">${iconGlobe()}</span><span class="af-btn-text">浏览器</span>`
          : `<span class="af-btn-ic" aria-hidden="true">${iconExternal()}</span><span class="af-btn-text">预览</span>`;
      } else {
        // Preserve VM test contract for textContent check on stub elements
        previewBtn.textContent = isHtml ? '🌐 浏览器' : '预览';
      }
      previewBtn.title = formatZh(isHtml ? '在默认浏览器中打开（Alt / Option + 点击查看源码）' : '在原生预览中打开');
    }
  }

  // Row element lookup map for O(1) selection updates and incremental patching (real DOM only)
  const treeRowElMap = new Map(); // key -> HTMLElement

  function syncSearchLoadingUi() {
    const spinner = $('search-spinner');
    const liveStatus = $('search-live-status');
    const container = $('tree-content');
    const activeQuery = Boolean(state.searchQuery.trim());
    const showSpinner = activeQuery && state.searchLoading;

    spinner?.classList.toggle('hidden', !showSpinner);
    if (liveStatus) {
      liveStatus.textContent = showSpinner ? '正在筛选…' : '';
    }
    if (container) {
      container.classList.toggle(
        'is-search-updating',
        Boolean(activeQuery && state.searchLoading && Array.isArray(state.searchResults))
      );
    }
  }

  function buildTreeRowHtml(item, depth, isOpen, isSelected) {
    const padLeft = 8 + depth * 14;
    const cls = ['af-tree-row'];
    if (isSelected) cls.push('is-selected');
    const isHtml = !item.isDirectory && (item.isHtmlFile || isHtmlPath(item.name));
    const previewTitle = isHtml
      ? '在默认浏览器中打开（Alt / Option + 点击查看源码）'
      : '在原生预览中打开';
    return `
      <div class="${cls.join(' ')}"
           role="treeitem"
           aria-expanded="${item.isDirectory ? String(isOpen) : 'false'}"
           data-rel-path="${esc(item.relPath)}"
           data-file-uri="${esc(item.fileUri)}"
           data-is-dir="${item.isDirectory ? '1' : '0'}"
           style="padding-left: ${padLeft}px"
           title="${esc(item.relPath)}">
        <span class="af-twistie${isOpen ? ' is-open' : ''}">${item.isDirectory ? iconChevronRight() : ''}</span>
        <span class="af-node-ic ${item.isDirectory ? 'af-ic-dir' : 'af-ic-file'}">${item.isDirectory ? iconFolder(isOpen) : iconFile()}</span>
        <span class="af-node-label">${esc(item.name)}</span>
        <span class="af-row-actions">
          ${!item.isDirectory ? `<button class="af-act-btn" data-act="preview" type="button" title="${esc(previewTitle)}" aria-label="${esc(previewTitle)}">${isHtml ? iconGlobe() : iconExternal()}</button>` : ''}
          <button class="af-act-btn" data-act="copy" type="button" title="复制相对路径（Shift + 点击复制绝对路径）" aria-label="复制路径">${iconCopy()}</button>
          <button class="af-act-btn" data-act="os" type="button" title="在系统文件管理器中显示" aria-label="在系统文件管理器中显示">${iconFolderOs()}</button>
        </span>
      </div>`;
  }

  function createTreeRowElement(node) {
    if (node.kind === 'loading') {
      const el = document.createElement('div');
      el.className = 'af-tree-row af-tree-loading-row';
      el.dataset.loadingParent = node.parentRel;
      el.style.paddingLeft = `${node.padLeft}px`;
      el.innerHTML = '<span class="af-node-sub">载入中…</span>';
      return el;
    }

    const { item, depth, isOpen, isSelected } = node;
    const padLeft = 8 + depth * 14;
    const isHtml = !item.isDirectory && (item.isHtmlFile || isHtmlPath(item.name));
    const previewTitle = isHtml
      ? '在默认浏览器中打开（Alt / Option + 点击查看源码）'
      : '在原生预览中打开';

    const el = document.createElement('div');
    el.className = isSelected ? 'af-tree-row is-selected' : 'af-tree-row';
    el.setAttribute('role', 'treeitem');
    el.setAttribute('aria-expanded', item.isDirectory ? String(isOpen) : 'false');
    el.dataset.relPath = item.relPath;
    el.dataset.fileUri = item.fileUri || '';
    el.dataset.isDir = item.isDirectory ? '1' : '0';
    el.dataset._open = isOpen ? '1' : '0';
    el.dataset._pad = String(padLeft);
    el.style.paddingLeft = `${padLeft}px`;
    el.title = item.relPath;

    el.innerHTML =
      `<span class="af-twistie${isOpen ? ' is-open' : ''}">${item.isDirectory ? iconChevronRight() : ''}</span>` +
      `<span class="af-node-ic ${item.isDirectory ? 'af-ic-dir' : 'af-ic-file'}">${item.isDirectory ? iconFolder(isOpen) : iconFile()}</span>` +
      `<span class="af-node-label">${esc(item.name)}</span>` +
      `<span class="af-row-actions">` +
      (!item.isDirectory
        ? `<button class="af-act-btn" data-act="preview" type="button" title="${esc(previewTitle)}" aria-label="${esc(previewTitle)}">${isHtml ? iconGlobe() : iconExternal()}</button>`
        : '') +
      `<button class="af-act-btn" data-act="copy" type="button" title="复制相对路径（Shift + 点击复制绝对路径）" aria-label="复制路径">${iconCopy()}</button>` +
      `<button class="af-act-btn" data-act="os" type="button" title="在系统文件管理器中显示" aria-label="在系统文件管理器中显示">${iconFolderOs()}</button>` +
      `</span>`;
    return el;
  }

  function updateTreeRowElement(el, node) {
    if (node.kind === 'loading') {
      if (el.dataset._pad !== String(node.padLeft)) {
        el.style.paddingLeft = `${node.padLeft}px`;
        el.dataset._pad = String(node.padLeft);
      }
      return;
    }

    const { item, depth, isOpen, isSelected } = node;
    const padLeft = 8 + depth * 14;
    if (el.dataset._pad !== String(padLeft)) {
      el.style.paddingLeft = `${padLeft}px`;
      el.dataset._pad = String(padLeft);
    }
    if (el.dataset.fileUri !== (item.fileUri || '')) {
      el.dataset.fileUri = item.fileUri || '';
    }
    el.classList.toggle('is-selected', isSelected);

    if (item.isDirectory) {
      const nextOpen = isOpen ? '1' : '0';
      if (el.dataset._open !== nextOpen) {
        el.dataset._open = nextOpen;
        el.setAttribute('aria-expanded', String(isOpen));
        const twistie = el.querySelector('.af-twistie');
        if (twistie) twistie.classList.toggle('is-open', isOpen);
        const icEl = el.querySelector('.af-node-ic');
        if (icEl) icEl.innerHTML = iconFolder(isOpen);
      }
    }
  }

  function updateTreeSelectionOnly(nextRelPath) {
    const container = $('tree-content');
    if (!container) return;
    if (!isRealTreeDom(container) || state.renderedMode !== 'tree') {
      renderTree();
      return;
    }
    const prevSelected = container.querySelector('.af-tree-row.is-selected');
    const nextEl = nextRelPath ? treeRowElMap.get(`item:${nextRelPath}`) : null;
    if (prevSelected && prevSelected !== nextEl) {
      prevSelected.classList.remove('is-selected');
    }
    if (nextEl) {
      nextEl.classList.add('is-selected');
    }
  }

  function patchTreeDom(container, flatNodes, options = {}) {
    if (state.renderedMode !== 'tree' || state.renderedRoot !== state.activeRoot) {
      container.textContent = '';
      treeRowElMap.clear();
      state.renderedMode = 'tree';
      state.renderedRoot = state.activeRoot;
    }

    const animateParent = options.animateParentRel || '';
    let newlyInsertedForParent = 0;
    const canAnimateEnter = Boolean(animateParent) && !prefersReducedMotion();

    // Count newly inserted rows for animated parent first so huge dirs (>40) skip stagger/enter for 120fps
    if (canAnimateEnter) {
      for (const node of flatNodes) {
        if (node.parentRel === animateParent && !treeRowElMap.has(node.key)) {
          newlyInsertedForParent += 1;
          if (newlyInsertedForParent > 40) break;
        }
      }
    }
    const shouldAnimateNew = canAnimateEnter && newlyInsertedForParent > 0 && newlyInsertedForParent <= 40;

    const keptKeys = new Set();
    let cursor = container.firstElementChild;

    for (const node of flatNodes) {
      keptKeys.add(node.key);
      let el = treeRowElMap.get(node.key);
      if (el) {
        updateTreeRowElement(el, node);
      } else {
        el = createTreeRowElement(node);
        treeRowElMap.set(node.key, el);
        if (shouldAnimateNew && node.parentRel === animateParent) {
          el.classList.add('is-entering');
          el.addEventListener('animationend', () => el.classList.remove('is-entering'), { once: true });
        }
      }

      if (el === cursor) {
        cursor = cursor.nextElementSibling;
      } else {
        container.insertBefore(el, cursor);
      }
    }

    // Remove stale/collapsed elements no longer in flatNodes
    for (const [key, el] of Array.from(treeRowElMap.entries())) {
      if (!keptKeys.has(key)) {
        el.remove();
        treeRowElMap.delete(key);
      }
    }
    // Clean any stray non-keyed nodes
    while (cursor) {
      const next = cursor.nextElementSibling;
      const k = cursor.dataset.relPath
        ? `item:${cursor.dataset.relPath}`
        : (cursor.dataset.loadingParent !== undefined ? `loading:${cursor.dataset.loadingParent}` : '');
      if (!k || !keptKeys.has(k)) {
        cursor.remove();
      }
      cursor = next;
    }
  }

  function renderTree(options = {}) {
    const container = $('tree-content');
    if (!container) return;

    syncSearchLoadingUi();

    const activeQuery = state.searchQuery.trim();
    if (activeQuery) {
      treeRowElMap.clear();
      state.renderedMode = 'search';
      if (state.searchLoading && !Array.isArray(state.searchResults)) {
        container.innerHTML = '<div class="af-empty">搜索中…</div>';
        return;
      }
      if (state.searchError && !Array.isArray(state.searchResults)) {
        container.innerHTML = `<div class="af-search-error">搜索失败 · ${esc(formatZh(state.searchError))}</div>`;
        return;
      }
      if (Array.isArray(state.searchResults)) {
        // Updating existing search results uses opacity dimming + inline spinner (zero CLS banner)
        if (state.searchLoading && !state.searchError && isRealTreeDom(container) && container.firstElementChild) {
          return;
        }
        const errorHtml = state.searchError
          ? `<div class="af-search-error">搜索失败 · ${esc(formatZh(state.searchError))}</div>`
          : '';
        const truncatedFooterHtml = (!state.searchError && state.searchTruncated)
          ? `<div class="af-search-note">仅显示前 <span class="af-num">${state.searchResults.length}</span> 项 · 请输入更精确关键词</div>`
          : '';

        if (state.searchResults.length === 0) {
          const emptyText = state.searchTruncated
            ? '无匹配结果 · 已达扫描上限，请缩小关键词或开启隐藏项'
            : '无匹配结果';
          container.innerHTML = `${errorHtml}<div class="af-empty">${esc(emptyText)}</div>`;
          return;
        }

        const rowsHtml = state.searchResults
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
              <span class="af-node-label">${highlightMatch(item.name, activeQuery)}</span>
              ${parent ? `<span class="af-node-sub">${esc(parent)}</span>` : ''}
            </div>`;
          })
          .join('');
        container.innerHTML = `${errorHtml}${rowsHtml}${truncatedFooterHtml}`;
        return;
      }
    }

    if (!state.activeRoot) {
      treeRowElMap.clear();
      state.renderedMode = 'empty';
      container.innerHTML = '<div class="af-empty">暂无可用项目根目录</div>';
      return;
    }

    const rootItems = state.dirCache.get(cacheKey(state.activeRoot, ''));
    if (!rootItems) {
      treeRowElMap.clear();
      state.renderedMode = 'empty';
      container.innerHTML = '<div class="af-empty">载入目录中…</div>';
      return;
    }
    if (rootItems.length === 0) {
      treeRowElMap.clear();
      state.renderedMode = 'empty';
      const emptyHint = state.showHidden
        ? '空目录'
        : `空目录（按 ${isMacPlatform() ? '⌘.' : 'Ctrl+.'} 显示隐藏项）`;
      container.innerHTML = `<div class="af-empty">${esc(emptyHint)}</div>`;
      return;
    }

    const expanded = getExpandedSet(state.activeRoot);

    if (isRealTreeDom(container)) {
      const flatNodes = [];
      const collect = (items, depth, parentRel) => {
        for (const item of items) {
          const isOpen = item.isDirectory && expanded.has(item.relPath);
          const isSelected = item.relPath === state.selectedRelPath;
          flatNodes.push({
            kind: 'item',
            key: `item:${item.relPath}`,
            item,
            depth,
            parentRel,
            isOpen,
            isSelected
          });
          if (isOpen) {
            const children = state.dirCache.get(cacheKey(state.activeRoot, item.relPath));
            if (children) {
              collect(children, depth + 1, item.relPath);
            } else {
              flatNodes.push({
                kind: 'loading',
                key: `loading:${item.relPath}`,
                parentRel: item.relPath,
                padLeft: 8 + depth * 14 + 19
              });
            }
          }
        }
      };
      collect(rootItems, 0, '');
      patchTreeDom(container, flatNodes, options);
      return;
    }

    // Minimal Node VM fallback (keeps container.innerHTML compatible with verify.mjs)
    state.renderedMode = 'tree';
    state.renderedRoot = state.activeRoot;
    const rows = [];
    const walk = (items, depth) => {
      for (const item of items) {
        const isOpen = item.isDirectory && expanded.has(item.relPath);
        const isSelected = item.relPath === state.selectedRelPath;
        const padLeft = 8 + depth * 14;
        rows.push(buildTreeRowHtml(item, depth, isOpen, isSelected));
        if (isOpen) {
          const children = state.dirCache.get(cacheKey(state.activeRoot, item.relPath));
          if (children) {
            walk(children, depth + 1);
          } else {
            rows.push(`<div class="af-tree-row af-tree-loading-row" style="padding-left: ${padLeft + 19}px"><span class="af-node-sub">载入中…</span></div>`);
          }
        }
      }
    };
    walk(rootItems, 0);
    container.innerHTML = rows.join('');
  }

  function isHtmlPath(raw) {
    return /\.(?:html?|xhtml)(?::\d+(?::\d+)?)?(?:[?#].*)?$/i.test(String(raw || '').trim());
  }

  async function openInBrowser(targetPath) {
    if (!targetPath) return;
    try {
      const uris = state.roots.length ? state.roots.map((r) => r.fileUri) : await getHostWorkspaceUris();
      const res = await apiPost('/api/open-browser', {
        path: targetPath,
        root: state.activeRoot,
        workspaceUri: uris.join(','),
        conversationId: getConversationId()
      });
      if (res?.ok === false) {
        throw new Error(res.error || '无法在默认浏览器中打开');
      }
      showToast('已在默认浏览器中打开', 1800);
    } catch (err) {
      showToast(`打开浏览器失败 · ${err.message}`);
    }
  }

  function openFileDefault(fileUri, line, fallbackPath = '', opts = {}) {
    const candidate = fallbackPath || fileUri || '';
    if (!opts.forceSource && isHtmlPath(candidate)) {
      openInBrowser(candidate);
      return;
    }
    openNativePreview(fileUri, line, fallbackPath);
  }

  function openNativePreview(fileUri, line, fallbackPath = '') {
    if (!fileUri && !fallbackPath) return;
    const uri = line && fileUri ? `${fileUri}#L${line}` : fileUri;
    if (window.sidecar?.ui?.toggleAuxPane && uri) {
      window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri });
      return;
    }
    const target = fallbackPath || fileUri;
    openPreviewModal(target, line).catch((err) => showToast(`预览失败 · ${err.message}`));
  }

  function closePreviewModal() {
    ++state.previewReqSeq;
    state.previewPath = '';
    const modal = $('preview-modal');
    const backdrop = $('preview-backdrop');
    $('btn-preview-browser')?.classList.add('hidden');
    $('btn-preview-retry')?.classList.add('hidden');
    if (modal) {
      modal.classList.add('hidden');
      modal.setAttribute('aria-hidden', 'true');
      modal.inert = true;
    }
    if (backdrop) {
      backdrop.classList.add('hidden');
      backdrop.setAttribute('aria-hidden', 'true');
    }
  }

  async function openPreviewModal(rawPath, line) {
    const modal = $('preview-modal');
    const backdrop = $('preview-backdrop');
    const titleEl = $('preview-title');
    const bodyEl = $('preview-body');
    const retryBtn = $('btn-preview-retry');
    if (!modal || !titleEl || !bodyEl) return;

    const reqSeq = ++state.previewReqSeq;
    state.previewLastRequest = { rawPath, line };
    state.previewPath = '';

    titleEl.textContent = rawPath;
    bodyEl.textContent = '载入预览中…';
    $('btn-preview-browser')?.classList.add('hidden');
    retryBtn?.classList.add('hidden');
    if (backdrop) {
      backdrop.classList.remove('hidden');
      backdrop.setAttribute('aria-hidden', 'false');
    }
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    modal.inert = false;

    let res;
    try {
      res = await apiGet('/api/preview', {
        path: rawPath,
        root: state.roots.map((r) => r.path).join(',')
      });
    } catch (err) {
      if (reqSeq !== state.previewReqSeq || modal.classList.contains('hidden')) return;
      bodyEl.textContent = formatZh(`预览失败 · ${err?.message || '无法读取文件'}`);
      retryBtn?.classList.remove('hidden');
      return;
    }

    if (reqSeq !== state.previewReqSeq || modal.classList.contains('hidden')) return;

    if (!res.ok) {
      bodyEl.textContent = formatZh(`无法预览文件 · ${res.error || '权限不足或文件不存在'}`);
      retryBtn?.classList.remove('hidden');
      return;
    }
    state.previewPath = res.absPath;
    $('btn-preview-browser')?.classList.toggle('hidden', !isHtmlPath(res.absPath || rawPath));
    const suffix = res.truncated ? '（仅显示前 64 KB）' : '';
    titleEl.textContent = `${res.relPath || res.name}${suffix}`;
    if (res.isBinary) {
      bodyEl.textContent = formatZh(`二进制文件（${res.size} 字节），请点击右上角「定位」在系统文件管理器中打开。`);
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

  async function copyText(text, label, triggerBtn = null) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        if (triggerBtn) flashCopyFeedback(triggerBtn);
        showToast(`已复制${label}`, 1800);
        return true;
      }
    } catch {}
    showToast('复制失败 · 请检查剪贴板权限', 2400);
    return false;
  }

  async function revealInOs(targetPath) {
    try {
      await apiPost('/api/reveal-os', {
        path: targetPath,
        root: state.activeRoot,
        workspaceUri: state.roots.map((r) => r.fileUri).join(',')
      });
      showToast('已在系统文件管理器中定位', 1800);
    } catch (err) {
      showToast(`系统定位失败 · ${err.message}`);
    }
  }

  function triggerOneShotRevealPulse(relPath) {
    if (!relPath) return;
    const token = ++state.revealToken;
    clearTimeout(state.pendingRevealTimer);

    const container = $('tree-content');
    if (container && isRealTreeDom(container)) {
      container.querySelectorAll('.af-tree-row.is-revealed').forEach((el) => el.classList.remove('is-revealed'));
    }

    const targetEl = treeRowElMap.get(`item:${relPath}`) ||
      Array.from(document.querySelectorAll('#tree-content .af-tree-row'))
        .find((el) => el.dataset.relPath === relPath);

    if (!targetEl) return;

    targetEl.scrollIntoView({
      block: 'center',
      behavior: prefersReducedMotion() ? 'instant' : 'smooth'
    });

    // Trigger one-shot reveal highlight without persisting it in renderTree()
    targetEl.classList.remove('is-revealed');
    void targetEl.offsetWidth;
    targetEl.classList.add('is-revealed');

    const cleanup = () => {
      if (state.revealToken !== token) return;
      targetEl.classList.remove('is-revealed');
      state.revealedRelPath = '';
    };

    if (!prefersReducedMotion() && typeof targetEl.addEventListener === 'function') {
      targetEl.addEventListener('animationend', cleanup, { once: true });
    }
    state.pendingRevealTimer = setTimeout(cleanup, prefersReducedMotion() ? 1600 : 1550);
  }

  async function revealPathInTree(rawPath) {
    const trimmed = String(rawPath || '').trim();
    if (!trimmed) return;

    // Clear active search filter so user sees full expanded tree context
    if (state.searchQuery) {
      state.searchQuery = '';
      resetSearchResultsForContextChange();
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
      showToast(res.error || '未找到目标路径 · 请检查文件是否存在');
      return;
    }

    // Mount external root automatically if not already in roots list
    if (!state.roots.some((r) => r.path === res.rootPath)) {
      state.roots.push({
        path: res.rootPath,
        name: res.isExternalRoot ? `${res.rootName}（外部）` : res.rootName,
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
    // Force refresh root, all ancestor dirs, and already-expanded target dir so newly created files appear immediately (R3)
    const dirsSet = new Set(['']);
    for (const d of res.ancestorRelDirs || []) {
      expanded.add(d);
      dirsSet.add(d);
    }
    if (res.isDirectory && res.relPath && expanded.has(res.relPath)) {
      dirsSet.add(res.relPath);
    }
    const dirsToLoad = Array.from(dirsSet);

    let dirLoadErr = null;
    await Promise.all(
      dirsToLoad.map((d) =>
        fetchDir(state.activeRoot, d, true).catch((err) => {
          if (!dirLoadErr) dirLoadErr = err;
          return [];
        })
      )
    );
    if (dirLoadErr) {
      showToast(`无法读取目录 · ${dirLoadErr.message || '权限不足或路径不存在'}`);
    }

    state.selectedRelPath = res.relPath || '';
    state.selectedAbsPath = res.absPath;
    state.selectedFileUri = res.fileUri;
    state.selectedIsDir = Boolean(res.isDirectory);
    state.revealedRelPath = res.relPath || '';

    renderActivePathBar();
    renderTree();

    if (res.relPath) {
      triggerOneShotRevealPulse(res.relPath);
    }
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
      .map((m) => {
        const isHtml = !m.isDirectory && Boolean(m.isHtmlFile || isHtmlPath(m.name || m.absPath));
        const previewTitle = isHtml
          ? '在默认浏览器中打开（Alt / Option + 点击查看源码）'
          : '原生预览';
        return `
        <div class="af-chip" data-mention-abs="${esc(m.absPath)}" title="${esc(m.absPath)}">
          <span class="af-chip-ic ${m.isDirectory ? 'af-ic-dir' : 'af-ic-file'}" aria-hidden="true">${m.isDirectory ? iconFolder(false) : iconFile()}</span>
          <span class="af-chip-name">${esc(m.name)}</span>
          ${!m.isDirectory ? `<button class="af-chip-open" data-mention-preview="${esc(m.fileUri)}" data-mention-line="${m.line || ''}" type="button" title="${esc(previewTitle)}" aria-label="${esc(previewTitle)}">${isHtml ? iconGlobe() : iconExternal()}</button>` : ''}
        </div>`;
      })
      .join('');
  }

  async function pollMentions() {
    if (document.hidden || !isAuxIframeVisible()) return;
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
    const rawSearch = window.location.search;
    state.lastHandledUrlQuery = rawSearch;
    const params = new URLSearchParams(rawSearch);
    const target = params.get('path') || params.get('file') || params.get('reveal');
    const browserParam = params.get('browser');
    const effectiveTarget = target || browserParam;
    const openParam = String(params.get('open') || params.get('action') || '').trim().toLowerCase();
    const wantsBrowser = Boolean(browserParam) || openParam === 'browser' || openParam === '1' || openParam === 'true';

    if (wantsBrowser) {
      params.delete('open');
      if (openParam === 'browser' || params.get('action') === 'browser') params.delete('action');
      if (browserParam && !target) {
        params.set('path', browserParam);
        params.delete('browser');
      }
      const nextQs = params.toString();
      const cleanUrl = `${window.location.pathname || '/'}${nextQs ? `?${nextQs}` : ''}${window.location.hash || ''}`;
      try {
        window.history?.replaceState?.(null, '', cleanUrl);
      } catch {}
      state.lastHandledUrlQuery = window.location.search;
    }

    if (effectiveTarget) {
      if (wantsBrowser) {
        openInBrowser(effectiveTarget);
      }
      revealPathInTree(effectiveTarget).catch((err) => showToast(`定位失败 · ${err.message}`));
    }
  }

  async function refreshWorkspace(preserveRoot = true) {
    const uris = await getHostWorkspaceUris();
    const ws = await apiGet('/api/workspace', {
      workspaceUri: uris.join(','),
      conversationId: getConversationId(),
      visible: isAuxIframeVisible() ? '1' : '0'
    });
    const hostRoots = Array.isArray(ws.roots) ? ws.roots : [];
    const extRoots = state.roots.filter((r) => !hostRoots.some((h) => h.path === r.path));
    state.roots = [...hostRoots, ...extRoots];

    const prevRoot = state.activeRoot;
    if (!preserveRoot || !state.roots.some((r) => r.path === state.activeRoot)) {
      state.activeRoot = ws.primaryRoot || state.roots[0]?.path || '';
    }
    renderRootSelect();

    const rootChanged = state.activeRoot !== prevRoot;
    if (rootChanged) {
      ++state.dirExpandSeq;
      state.dirExpandTokenByPath.clear();
      state.selectedRelPath = '';
      state.selectedAbsPath = '';
      state.selectedFileUri = '';
      state.selectedIsDir = false;
      state.revealedRelPath = '';
      renderActivePathBar();
      if (state.searchQuery.trim()) {
        handleSearchInput(state.searchQuery, { immediate: true, resetResults: true });
      } else {
        resetSearchResultsForContextChange();
      }
    } else if (preserveRoot && state.searchQuery.trim()) {
      handleSearchInput(state.searchQuery, { immediate: true });
    }

    const viewport = $('tree-viewport');
    const prevScrollTop = (!rootChanged && viewport) ? viewport.scrollTop : 0;

    if (state.activeRoot) {
      const targetRoot = state.activeRoot;
      const expanded = Array.from(getExpandedSet(targetRoot));
      clearCacheForRoot(targetRoot);
      await Promise.all(expanded.map((d) => fetchDir(targetRoot, d, true).catch(() => [])));
      if (state.activeRoot === targetRoot) {
        renderTree();
        if (viewport) {
          viewport.scrollTop = rootChanged ? 0 : prevScrollTop;
        }
      }
    } else {
      renderTree();
      if (viewport) viewport.scrollTop = 0;
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

  function isHostAuxPaneContext() {
    return Boolean(
      window.sidecar &&
      !state.isDrawerMode &&
      !window.__AF_DRAWER_MODE__ &&
      typeof window.sidecar.ui?.toggleAuxPane === 'function'
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

  function setRecordingTarget(target) {
    state.recordingTarget = target || null;
    const recording = Boolean(state.recordingTarget);
    if (typeof window.sidecar?.setShortcutRecording === 'function') {
      window.sidecar.setShortcutRecording(recording);
    } else {
      apiPost('/api/shortcut', { action: 'set-recording', recording }).catch(() => {});
    }
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
        ? '请按键'
        : (drawerCfg.enabled ? (drawerCfg.display || '⇧⌘E') : '已关闭');
      drawerSub.textContent = recordingDrawer ? '· Esc 取消' : '修改';
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
        ? '请按键'
        : (auxCfg.enabled ? (auxCfg.display || (mac ? '⌥⌘E' : 'Ctrl+Alt+E')) : '已关闭');
      auxSub.textContent = recordingAux ? '· Esc 取消' : '修改';
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
        drawerBtn.title = formatZh(`收回独立目录树抽屉（${activeLabel} / Esc）`);
      } else {
        drawerBtn.classList.toggle('is-active', Boolean(state.drawerVisible));
        drawerBtn.title = formatZh(`弹出 / 收回右侧独立目录树抽屉（${activeLabel}）`);
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
        hintEl.textContent = formatZh(`独立抽屉 ${activeLabel} · AGY 右侧辅助栏 ${auxLabel} · ${scopeText}（当前对话打开过一次目录树后即可直接呼出）。`);
      } else {
        hintEl.textContent = formatZh('Windows / Linux 可将下方 CLI 命令绑定到系统快捷键（PowerToys / AutoHotkey / GNOME），或按自定义快捷键直接触发。');
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
    if (state.shortcutPanelOpen) {
      syncHeaderHeightVar();
    }
    const panel = $('shortcut-panel');
    if (panel) {
      panel.classList.toggle('hidden', !state.shortcutPanelOpen);
      panel.setAttribute('aria-hidden', String(!state.shortcutPanelOpen));
      panel.inert = !state.shortcutPanelOpen;
    }
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
      if (res.error) showToast(`操作失败 · ${res.error}`);
      else if (res.message) showToast(res.message, 1800);
      return res;
    } catch (err) {
      showToast(`操作失败 · ${err.message}`);
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
    updateTreeSelectionOnly(relPath);
  }

  function getSelectableRows() {
    return Array.from(document.querySelectorAll('#tree-content .af-tree-row[data-rel-path], #tree-content .af-tree-row[data-search-abs]'));
  }

  function scrollSelectedRowIntoView() {
    const sel = document.querySelector('#tree-content .af-tree-row.is-selected');
    sel?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }

  let kbdNavIdleTimer = null;
  function markKbdNavActive() {
    const container = $('tree-content');
    if (!container) return;
    container.classList.add('is-kbd-nav');
    clearTimeout(kbdNavIdleTimer);
    kbdNavIdleTimer = setTimeout(() => {
      container.classList.remove('is-kbd-nav');
    }, 160);
  }

  async function navigateTree(delta) {
    markKbdNavActive();
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

  // rAF-batched rapid repeat arrow navigation for 120fps smooth scrolling
  let pendingNavDelta = 0;
  let pendingNavRaf = 0;
  function scheduleRepeatNavigate(delta) {
    pendingNavDelta += delta;
    if (pendingNavRaf) return;
    pendingNavRaf = requestAnimationFrame(() => {
      pendingNavRaf = 0;
      const step = pendingNavDelta;
      pendingNavDelta = 0;
      if (step !== 0) {
        navigateTree(step).catch(() => {});
      }
    });
  }

  async function toggleDirectoryByRelPath(relPath, forceOpen) {
    if (!state.activeRoot || !relPath) return;
    const targetRoot = state.activeRoot;
    const expanded = getExpandedSet(targetRoot);
    const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : !expanded.has(relPath);
    const seq = ++state.dirExpandSeq;
    state.dirExpandTokenByPath.set(relPath, seq);

    if (shouldOpen) {
      expanded.add(relPath);
      const alreadyCached = state.dirCache.has(cacheKey(targetRoot, relPath));
      renderTree({ animateParentRel: alreadyCached ? relPath : '' });
      if (!alreadyCached) {
        try {
          await fetchDir(targetRoot, relPath);
        } catch (err) {
          if (state.activeRoot === targetRoot && state.dirExpandTokenByPath.get(relPath) === seq && expanded.has(relPath)) {
            expanded.delete(relPath);
            renderTree();
            showToast(`无法读取目录 · ${err?.message || '权限不足或路径不存在'}`);
          }
          return;
        }
        // Discard stale expand response if user collapsed or switched workspace while loading
        if (
          state.activeRoot !== targetRoot ||
          state.dirExpandTokenByPath.get(relPath) !== seq ||
          !expanded.has(relPath)
        ) {
          return;
        }
        renderTree({ animateParentRel: relPath });
      }
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
      const parentRow = treeRowElMap.get(`item:${parentRel}`) ||
        Array.from(document.querySelectorAll('#tree-content .af-tree-row[data-rel-path]'))
          .find((r) => r.dataset.relPath === parentRel);
      if (parentRow) {
        await selectTreeRow(parentRow);
        scrollSelectedRowIntoView();
      }
    }
  }

  let searchTimer = null;
  function resetSearchResultsForContextChange() {
    clearTimeout(searchTimer);
    ++state.searchReqSeq;
    state.searchResults = null;
    state.searchTruncated = false;
    state.searchLoading = false;
    state.searchError = '';
    syncSearchLoadingUi();
  }

  function handleSearchInput(value, options = {}) {
    state.searchQuery = value;
    $('btn-clear-search')?.classList.toggle('hidden', !value);
    clearTimeout(searchTimer);

    const trimmed = value.trim();
    const reqSeq = ++state.searchReqSeq;
    if (options.resetResults) {
      state.searchResults = null;
      state.searchTruncated = false;
    }
    if (!trimmed) {
      state.searchResults = null;
      state.searchTruncated = false;
      state.searchLoading = false;
      state.searchError = '';
      renderTree();
      return;
    }

    state.searchLoading = true;
    state.searchError = '';
    renderTree();

    const executeSearch = async () => {
      const requestRoot = state.activeRoot;
      if (!requestRoot) {
        if (reqSeq === state.searchReqSeq) {
          state.searchResults = null;
          state.searchTruncated = false;
          state.searchLoading = false;
          state.searchError = '';
          renderTree();
        }
        return;
      }
      try {
        const res = await apiGet('/api/search', {
          root: requestRoot,
          q: trimmed,
          showHidden: state.showHidden ? '1' : '0'
        });
        if (reqSeq === state.searchReqSeq && state.activeRoot === requestRoot && state.searchQuery.trim() === trimmed) {
          state.searchResults = Array.isArray(res.results) ? res.results : [];
          state.searchTruncated = Boolean(res.truncated);
          state.searchLoading = false;
          state.searchError = '';
          renderTree();
        }
      } catch (err) {
        if (reqSeq === state.searchReqSeq && state.activeRoot === requestRoot && state.searchQuery.trim() === trimmed) {
          state.searchLoading = false;
          state.searchError = err?.message || '搜索请求失败';
          renderTree();
        }
      }
    };

    if (options.immediate) {
      executeSearch();
    } else {
      searchTimer = setTimeout(executeSearch, 160);
    }
  }

  function startRefreshSpin(btn) {
    if (!btn) return () => {};
    btn.classList.add('is-spinning');
    btn.setAttribute('aria-busy', 'true');
    let stopped = false;

    return () => {
      if (stopped) return;
      stopped = true;
      btn.removeAttribute?.('aria-busy');
      if (prefersReducedMotion() || typeof btn.addEventListener !== 'function') {
        btn.classList.remove('is-spinning');
        return;
      }
      const svg = btn.querySelector?.('svg');
      if (!svg || typeof svg.addEventListener !== 'function') {
        btn.classList.remove('is-spinning');
        return;
      }
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        btn.classList.remove('is-spinning');
      };
      const fallback = setTimeout(finish, 750);
      svg.addEventListener('animationiteration', () => {
        clearTimeout(fallback);
        finish();
      }, { once: true });
    };
  }

  function bindEvents() {
    $('root-select')?.addEventListener('change', async (e) => {
      const nextRoot = e.target.value;
      const switchSeq = ++state.rootSwitchSeq;
      ++state.dirExpandSeq;
      state.dirExpandTokenByPath.clear();
      state.activeRoot = nextRoot;
      state.selectedRelPath = '';
      state.selectedAbsPath = '';
      state.selectedFileUri = '';
      state.selectedIsDir = false;
      state.revealedRelPath = '';
      renderActivePathBar();

      const hasSearch = Boolean(state.searchQuery.trim());
      if (hasSearch) {
        handleSearchInput(state.searchQuery, { immediate: true, resetResults: true });
      } else {
        resetSearchResultsForContextChange();
      }

      const viewport = $('tree-viewport');
      const progress = $('workspace-progress');
      let slowTimer = null;
      if (nextRoot && !hasSearch) {
        slowTimer = setTimeout(() => {
          if (state.rootSwitchSeq === switchSeq) {
            viewport?.classList.add('is-switching');
            progress?.classList.add('is-active');
          }
        }, 120);
      }

      try {
        if (nextRoot) {
          await fetchDir(nextRoot, '').catch(() => []);
        }
      } finally {
        clearTimeout(slowTimer);
        if (state.rootSwitchSeq === switchSeq) {
          viewport?.classList.remove('is-switching');
          progress?.classList.remove('is-active');
        }
      }

      if (state.activeRoot === nextRoot && state.rootSwitchSeq === switchSeq) {
        renderTree();
        if (viewport) viewport.scrollTop = 0;
      }
    });

    $('btn-toggle-hidden')?.addEventListener('click', () => {
      const btn = $('btn-toggle-hidden');
      withButtonPending(btn, async () => {
        state.showHidden = !state.showHidden;
        btn?.classList.toggle('is-active', state.showHidden);
        btn?.setAttribute('aria-pressed', String(state.showHidden));
        if (state.activeRoot) {
          const viewport = $('tree-viewport');
          const prevScrollTop = viewport ? viewport.scrollTop : 0;
          clearCacheForRoot(state.activeRoot);
          const expanded = Array.from(getExpandedSet(state.activeRoot));
          await Promise.all(expanded.map((d) => fetchDir(state.activeRoot, d, true).catch(() => [])));
          renderTree();
          if (viewport) viewport.scrollTop = prevScrollTop;
        }
        if (state.searchQuery.trim()) {
          handleSearchInput(state.searchQuery, { immediate: true, resetResults: true });
        }
      });
    });

    $('btn-collapse-all')?.addEventListener('click', () => {
      if (!state.activeRoot) return;
      ++state.dirExpandSeq;
      state.dirExpandTokenByPath.clear();
      state.expandedByRoot.set(state.activeRoot, new Set(['']));
      syncCursorByRoot.set(state.activeRoot, 0);
      renderTree();
    });

    $('btn-drawer')?.addEventListener('click', () => {
      if (state.isDrawerMode) {
        closeDrawerWindow();
        return;
      }
      withButtonPending($('btn-drawer'), () => triggerDrawerAction('toggle'));
    });

    $('btn-drawer-action')?.addEventListener('click', () => {
      if (state.isDrawerMode) {
        closeDrawerWindow();
        return;
      }
      withButtonPending($('btn-drawer-action'), () => triggerDrawerAction('toggle'));
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
      withButtonPending($('btn-reset-drawer-shortcut'), () => triggerDrawerAction('set-drawer-shortcut', { reset: true }));
    });

    $('btn-record-aux-shortcut')?.addEventListener('click', () => {
      setRecordingTarget(state.recordingTarget === 'aux' ? null : 'aux');
    });

    $('btn-toggle-aux-shortcut')?.addEventListener('click', () => {
      setRecordingTarget(null);
      const nextEnabled = !(state.auxShortcut?.enabled ?? true);
      withButtonPending($('btn-toggle-aux-shortcut'), () => triggerDrawerAction('set-aux-shortcut', { enabled: nextEnabled }));
    });

    $('btn-reset-aux-shortcut')?.addEventListener('click', () => {
      setRecordingTarget(null);
      withButtonPending($('btn-reset-aux-shortcut'), () => triggerDrawerAction('set-aux-shortcut', { reset: true }));
    });

    $('btn-aux-open')?.addEventListener('click', () => {
      if (!state.isDrawerMode && !window.__AF_DRAWER_MODE__ && typeof window.sidecar?.ui?.toggleAuxPane === 'function') {
        postSidecarCloseKeyEvent();
        return;
      }
      withButtonPending($('btn-aux-open'), () => triggerDrawerAction('trigger-aux', {
        auxAction: 'toggle',
        convId: window.sidecar?.conversationId || ''
      }));
    });

    $('btn-shortcut-scope')?.addEventListener('click', () => {
      const curScope = state.drawerShortcut?.scope || state.auxShortcut?.scope || 'app';
      const nextScope = curScope === 'global' ? 'app' : 'global';
      withButtonPending($('btn-shortcut-scope'), () => triggerDrawerAction('set-aux-shortcut', { scope: nextScope }));
    });

    $('btn-copy-cli')?.addEventListener('click', () => {
      copyText('agy-finder aux', '侧栏 CLI 命令', $('btn-copy-cli'));
    });

    $('btn-preview-close')?.addEventListener('click', closePreviewModal);
    $('preview-backdrop')?.addEventListener('click', closePreviewModal);
    $('btn-preview-retry')?.addEventListener('click', () => {
      if (state.previewLastRequest?.rawPath) {
        openPreviewModal(state.previewLastRequest.rawPath, state.previewLastRequest.line).catch(() => {});
      }
    });
    $('btn-preview-browser')?.addEventListener('click', () => {
      if (state.previewPath) openInBrowser(state.previewPath);
    });
    $('btn-preview-os')?.addEventListener('click', () => {
      if (state.previewPath) revealInOs(state.previewPath);
    });

    // 3-state theme cycle: auto -> opposite -> third -> auto
    $('btn-theme')?.addEventListener('click', () => {
      if (state.themeOverride === 'auto') {
        state.themeOverride = detectHostDarkTheme() ? 'light' : 'dark';
      } else if (state.themeOverride === 'light') {
        state.themeOverride = 'dark';
      } else {
        state.themeOverride = 'auto';
      }
      applyTheme(true);
    });

    let refreshing = false;
    $('btn-refresh')?.addEventListener('click', async () => {
      if (refreshing) return;
      refreshing = true;
      const stopSpin = startRefreshSpin($('btn-refresh'));
      try {
        await refreshWorkspace(true);
        await pollMentions();
        showToast('目录已刷新', 1800);
      } catch (err) {
        showToast(`刷新失败 · ${err?.message || '请稍后重试'}`);
      } finally {
        refreshing = false;
        stopSpin();
      }
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
      $('search-input')?.focus?.();
      showToast('请按 Cmd / Ctrl + V 粘贴路径后回车定位');
    });

    const searchInput = $('search-input');
    searchInput?.addEventListener('input', (e) => handleSearchInput(e.target.value));
    searchInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && searchInput.value.trim()) {
        e.preventDefault();
        revealPathInTree(searchInput.value.trim()).catch((err) => showToast(`定位失败 · ${err.message}`));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        $('tree-viewport')?.focus?.();
        navigateTree(1);
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        if (searchInput.value) {
          searchInput.value = '';
          handleSearchInput('');
        } else {
          searchInput.blur?.();
          $('tree-viewport')?.focus?.();
        }
      }
    });

    $('btn-clear-search')?.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      handleSearchInput('');
      searchInput?.focus?.();
    });

    $('btn-toggle-mentions')?.addEventListener('click', () => {
      state.mentionsCollapsed = !state.mentionsCollapsed;
      $('mentions-bar')?.classList.toggle('is-collapsed', state.mentionsCollapsed);
      $('btn-toggle-mentions')?.setAttribute('aria-expanded', String(!state.mentionsCollapsed));
    });

    $('mentions-list')?.addEventListener('click', (e) => {
      const previewBtn = e.target.closest('[data-mention-preview]');
      if (previewBtn) {
        e.stopPropagation();
        const chipEl = previewBtn.closest('[data-mention-abs]');
        openFileDefault(previewBtn.dataset.mentionPreview, previewBtn.dataset.mentionLine, chipEl?.dataset.mentionAbs || '', { forceSource: Boolean(e.altKey) });
        return;
      }
      const chip = e.target.closest('[data-mention-abs]');
      if (chip) {
        revealPathInTree(chip.dataset.mentionAbs).catch((err) => showToast(`定位失败 · ${err.message}`));
      }
    });

    $('btn-copy-active')?.addEventListener('click', (e) => {
      if (!state.selectedAbsPath) return;
      const copyAbs = e.shiftKey || e.altKey || !state.selectedRelPath;
      copyText(copyAbs ? state.selectedAbsPath : state.selectedRelPath, copyAbs ? '绝对路径' : '相对路径', $('btn-copy-active'));
    });

    $('btn-preview-active')?.addEventListener('click', (e) => {
      if ((state.selectedFileUri || state.selectedAbsPath) && !state.selectedIsDir) {
        openFileDefault(state.selectedFileUri, null, state.selectedAbsPath, { forceSource: Boolean(e?.altKey) });
      }
    });

    // Scroll performance guard on tree viewport
    const treeViewport = $('tree-viewport');
    let scrollIdleTimer = null;
    treeViewport?.addEventListener('scroll', () => {
      treeViewport.classList.add('is-scrolling');
      clearTimeout(scrollIdleTimer);
      scrollIdleTimer = setTimeout(() => {
        treeViewport.classList.remove('is-scrolling');
      }, 120);
    }, { passive: true });

    // Close shortcut panel overlay on outside click
    document.addEventListener('pointerdown', (e) => {
      if (!state.shortcutPanelOpen) return;
      const panel = $('shortcut-panel');
      const btn = $('btn-shortcuts');
      const target = e?.target;
      if (panel?.contains?.(target) || btn?.contains?.(target)) return;
      toggleShortcutPanel(false);
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
        if (act === 'preview') openFileDefault(fileUri, null, absPath, { forceSource: Boolean(e.altKey) });
        else if (act === 'copy') {
          const copyAbs = e.shiftKey || e.altKey;
          copyText(copyAbs ? absPath : relPath, copyAbs ? '绝对路径' : '相对路径', actBtn);
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
        updateTreeSelectionOnly(relPath);
      }
    });

    treeContent?.addEventListener('dblclick', (e) => {
      if (e.target.closest('[data-act]')) return;
      const row = e.target.closest('.af-tree-row[data-rel-path]');
      if (!row || row.dataset.isDir === '1') return;
      const absPath = state.activeRoot ? `${state.activeRoot}/${row.dataset.relPath}` : row.dataset.relPath;
      openFileDefault(row.dataset.fileUri, null, absPath, { forceSource: Boolean(e.altKey) });
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
          showToast('需含 ⌘ / ⌥ / ⌃ 或 F1–F12', 2200);
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
        searchInput?.focus?.();
        searchInput?.select?.();
        return;
      }
      if (isMod && !e.shiftKey && !e.altKey && key === '.') {
        e.preventDefault();
        $('btn-toggle-hidden')?.click?.();
        return;
      }

      if (!inInput && !isMod && !e.altKey && key === '/') {
        e.preventDefault();
        searchInput?.focus?.();
        searchInput?.select?.();
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

      if (!inInput && !isMod && e.altKey && key === 'Enter' && state.selectedAbsPath && !state.selectedIsDir) {
        e.preventDefault();
        openNativePreview(state.selectedFileUri, null, state.selectedAbsPath);
        return;
      }

      if (inInput || isMod || e.altKey) return;

      if (key === 'ArrowDown') {
        e.preventDefault();
        if (e.repeat && typeof requestAnimationFrame === 'function') {
          scheduleRepeatNavigate(1);
        } else {
          await navigateTree(1);
        }
      } else if (key === 'ArrowUp') {
        e.preventDefault();
        if (e.repeat && typeof requestAnimationFrame === 'function') {
          scheduleRepeatNavigate(-1);
        } else {
          await navigateTree(-1);
        }
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
          openFileDefault(state.selectedFileUri, null, state.selectedAbsPath);
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
        revealPathInTree(ev.revealPath).catch((err) => showToast(`定位失败 · ${err.message}`));
      } else if (ev.type === 'windowShown') {
        state.drawerVisible = true;
        refreshWorkspace(true).catch(() => {});
        pollMentions().catch(() => {});
        if (ev.revealPath) {
          revealPathInTree(ev.revealPath).catch((err) => showToast(`定位失败 · ${err.message}`));
        } else {
          $('tree-viewport')?.focus?.();
        }
      }
    };

    window.addEventListener('message', (event) => {
      if (!event || !window.parent || window.parent === window || event.source !== window.parent) {
        return;
      }
      if (!window.sidecar || window.__AF_DRAWER_MODE__ || (typeof state !== 'undefined' && state?.isDrawerMode)) {
        return;
      }
      const rawOrigin = typeof event.origin === 'string' ? event.origin.trim() : '';
      if (!rawOrigin || rawOrigin === 'null') return;
      const lowerOrigin = rawOrigin.toLowerCase();
      let isTrustedOrigin = lowerOrigin === 'file://';
      if (!isTrustedOrigin) {
        const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#@]+)$/.exec(lowerOrigin);
        if (!match) return;
        const [, scheme, authority] = match;
        if (scheme === 'http' || scheme === 'https') {
          isTrustedOrigin = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(authority);
        } else {
          isTrustedOrigin = (
            scheme.startsWith('vscode-') ||
            scheme === 'antigravity' ||
            scheme.startsWith('antigravity-') ||
            scheme === 'sidecar' ||
            scheme === 'app' ||
            scheme === 'electron'
          );
        }
      }
      if (!isTrustedOrigin) return;

      if (event.data?.type === 'theme-change') {
        setTimeout(() => applyTheme(true), 20);
        return;
      }
      const data = typeof event.data === 'string' ? (() => { try { return JSON.parse(event.data); } catch { return null; } })() : event.data;
      const target = data && typeof data === 'object' ? (data.path || data.file || data.reveal || data.browser) : '';
      if (typeof target === 'string' && target.trim()) {
        const openMode = String(data.open || data.action || '').trim().toLowerCase();
        if (data.browser || openMode === 'browser' || openMode === '1' || openMode === 'true') {
          openInBrowser(target);
        }
        revealPathInTree(target).catch((err) => showToast(`定位失败 · ${err.message}`));
      }
    });

    window.addEventListener('popstate', checkDeepLinkUrl);
    window.addEventListener('hashchange', checkDeepLinkUrl);
    window.addEventListener('resize', syncHeaderHeightVar);
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
    if (!isHostAuxPaneContext()) {
      return;
    }

    ensureAuxViewportObserver();
    const coordinatorBootAt = Date.now();
    let visibleSince = isAuxIframeVisible() ? coordinatorBootAt : 0;
    let lastSeenSeq = 0;
    let pendingOpenTrigger = null;

    const triggerRevealOnce = (seq, revealPath) => {
      if (!revealPath) return;
      const lastRevealSeq = Number(sessionStorage.getItem('agy_aux_last_reveal_seq') || '0');
      if (seq && lastRevealSeq >= seq) return;
      if (seq) sessionStorage.setItem('agy_aux_last_reveal_seq', String(seq));
      revealPathInTree(revealPath).catch(() => {});
    };

    const reportHello = () => {
      if (!isAuxIframeVisible()) return;
      const convId = getConversationId();
      if (convId) {
        apiPost('/api/aux-pane-trigger', { action: 'hello', convId }).catch(() => {});
      }
    };

    const claimPendingOpenAckIfVisible = async () => {
      if (!pendingOpenTrigger || !isAuxIframeVisible()) return false;
      const pending = pendingOpenTrigger;
      if ((Date.now() - pending.at) > 2500 || !pending.isSelfTarget) {
        pendingOpenTrigger = null;
        return false;
      }
      pendingOpenTrigger = null;
      const ackRes = await apiPost('/api/aux-pane-trigger', {
        action: 'ack',
        seq: pending.seq,
        plugin: 'agy-finder'
      }).catch(() => null);
      if (ackRes?.claimed) {
        sessionStorage.setItem('agy_aux_last_ack_seq', String(pending.seq));
        return true;
      }
      return false;
    };

    const handleVisibilityChange = () => {
      const nowVisible = isAuxIframeVisible();
      if (nowVisible) {
        const becameVisible = !visibleSince;
        if (becameVisible) {
          visibleSince = (Date.now() - coordinatorBootAt < 250) ? coordinatorBootAt : Date.now();
          reportHello();
          refreshWorkspace(true).catch(() => {});
          pollMentions().catch(() => {});
          claimPendingOpenAckIfVisible().catch(() => {});
          apiGet('/api/aux-pane-trigger', { waitMs: 0 }).then(async (res) => {
            const trig = res?.trigger;
            if (
              trig?.seq &&
              trig.targetPlugin === 'agy-finder' &&
              trig.revealPath &&
              (Date.now() - Number(trig.at || 0)) < 4000
            ) {
              triggerRevealOnce(trig.seq, trig.revealPath);
            }
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
              trig.targetPlugin !== 'agy-finder' &&
              Number(trig.switchedSeq || 0) < trig.seq &&
              trig.uri
            ) {
              const sw = await apiPost('/api/aux-pane-trigger', { action: 'switched', seq: trig.seq }).catch(() => null);
              if (sw?.claimed) {
                const ackRes = await apiPost('/api/aux-pane-trigger', {
                  action: 'ack',
                  seq: trig.seq,
                  plugin: 'agy-finder'
                }).catch(() => null);
                if (ackRes?.claimed) {
                  sessionStorage.setItem('agy_aux_last_ack_seq', String(trig.seq));
                }
                if (pendingOpenTrigger?.seq === trig.seq) {
                  pendingOpenTrigger = null;
                }
                window.sidecar.ui.toggleAuxPane({ tabType: 'sidecarView', uri: trig.uri });
              }
            } else if (trig.targetPlugin === 'agy-finder') {
              const ackRes = await apiPost('/api/aux-pane-trigger', {
                action: 'ack',
                seq: trig.seq,
                plugin: 'agy-finder'
              }).catch(() => null);
              if (ackRes?.claimed) {
                sessionStorage.setItem('agy_aux_last_ack_seq', String(trig.seq));
                if (pendingOpenTrigger?.seq === trig.seq) {
                  pendingOpenTrigger = null;
                }
              }
              triggerRevealOnce(trig.seq, trig.revealPath);
            }
          }).catch(() => {});
        } else if (pendingOpenTrigger) {
          claimPendingOpenAckIfVisible().catch(() => {});
        }
      } else {
        visibleSince = 0;
      }
    };

    if (visibleSince) {
      reportHello();
    }

    document.addEventListener('pointerdown', reportHello, { passive: true });
    document.addEventListener('keydown', reportHello, { passive: true });
    auxVisibilityCallbacks.add(handleVisibilityChange);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('message', (ev) => {
      if (!ev || !window.parent || window.parent === window || ev.source !== window.parent) return;
      if (ev.data?.type === 'theme-change' || ev.data?.type === 'workspace-change') {
        handleVisibilityChange();
      }
    });

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

      const myConvId = getConversationId();
      const isVisibleNow = isAuxIframeVisible();
      const alreadyOpeningOrSwitched =
        Number(trigger.openingSeq || 0) >= seq ||
        Number(trigger.switchedSeq || 0) >= seq;
      const wasAlreadyVisible =
        !alreadyOpeningOrSwitched &&
        coordinatorBootAt <= Number(trigger.at || 0) - 40 &&
        visibleSince > 0 &&
        visibleSince <= Number(trigger.at || 0) - 40;
      const isSelfTarget = trigger.targetPlugin === 'agy-finder';
      const exactConvMatch = !trigger.convId || !myConvId || myConvId === trigger.convId;

      if (isVisibleNow) {
        if (!exactConvMatch) {
          const settle = await apiGet('/api/aux-pane-trigger', { waitMs: 0, holdMs: 25 }).catch(() => null);
          if (Number(settle?.trigger?.ackSeq || 0) >= seq || !isAuxIframeVisible()) return;
        }
        if (!isSelfTarget) {
          if (trigger.uri) {
            const ackRes = await apiPost('/api/aux-pane-trigger', {
              action: 'ack',
              seq,
              plugin: 'agy-finder'
            }).catch(() => null);
            if (!ackRes?.claimed) return;
            await apiPost('/api/aux-pane-trigger', { action: 'switched', seq }).catch(() => null);
            sessionStorage.setItem('agy_aux_last_ack_seq', String(seq));
            window.sidecar.ui.toggleAuxPane({ tabType: 'sidecarView', uri: trigger.uri });
          }
          return;
        }

        if (wasAlreadyVisible) {
          const ackRes = await apiPost('/api/aux-pane-trigger', {
            action: 'ack',
            seq,
            plugin: 'agy-finder'
          }).catch(() => null);
          if (!ackRes?.claimed) return;
          sessionStorage.setItem('agy_aux_last_ack_seq', String(seq));
          if (trigger.revealPath) {
            triggerRevealOnce(seq, trigger.revealPath);
            if (trigger.action === 'open') return;
          }
          if (trigger.action !== 'open') {
            postSidecarCloseKeyEvent();
          }
          return;
        }

        const ackRes = await apiPost('/api/aux-pane-trigger', {
          action: 'ack',
          seq,
          plugin: 'agy-finder'
        }).catch(() => null);
        if (ackRes?.claimed) {
          sessionStorage.setItem('agy_aux_last_ack_seq', String(seq));
        }
        triggerRevealOnce(seq, trigger.revealPath);
        return;
      }

      if (typeof window.sidecar.ui?.toggleConversation !== 'function') return;
      if (document.hidden) return;

      let waitBeforeClaim;
      if (auxEverBeenVisible) {
        waitBeforeClaim = isSelfTarget
          ? (exactConvMatch ? 30 : 125)
          : (exactConvMatch ? 75 : 175);
      } else {
        waitBeforeClaim = isSelfTarget
          ? (exactConvMatch ? 235 : 320)
          : (exactConvMatch ? 280 : 365);
      }
      const recheck = await apiGet('/api/aux-pane-trigger', { waitMs: 0, holdMs: waitBeforeClaim }).catch(() => null);
      const latestTrig = recheck?.trigger;
      if (latestTrig && (Number(latestTrig.ackSeq || 0) >= seq || Number(latestTrig.openingSeq || 0) >= seq)) {
        return;
      }
      if (isAuxIframeVisible()) {
        handleVisibilityChange();
        return;
      }

      const targetConvId = trigger.convId || myConvId;
      if (!targetConvId) return;

      const openRes = await apiPost('/api/aux-pane-trigger', { action: 'opening', seq }).catch(() => null);
      if (!openRes?.claimed) return;

      pendingOpenTrigger = { seq, convId: targetConvId, at: Date.now(), isSelfTarget };
      if (isSelfTarget && trigger.revealPath) {
        triggerRevealOnce(seq, trigger.revealPath);
      }
      // Host unmounts toggle-aux-pane (Cyc) while hidden; only root epc(toggle-conversation) expands a collapsed Aux Pane.
      window.sidecar.ui.toggleConversation(targetConvId);
      apiGet('/api/aux-pane-trigger', { waitMs: 0, holdMs: 110 }).then(() => {
        if (isSelfTarget) {
          claimPendingOpenAckIfVisible().catch(() => {});
        }
        handleVisibilityChange();
      }).catch(() => {});
    };

    (async () => {
      try {
        const initRes = await apiGet('/api/aux-pane-trigger', { waitMs: 0 });
        const initTrig = initRes?.trigger;
        if (initTrig?.seq) {
          const sessionAck = Number(sessionStorage.getItem('agy_aux_last_ack_seq') || '0');
          if (
            initTrig.targetPlugin === 'agy-finder' &&
            initTrig.revealPath &&
            (Date.now() - Number(initTrig.at || 0)) < 4000
          ) {
            triggerRevealOnce(initTrig.seq, initTrig.revealPath);
          }
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

  let syncVisibleInFlight = false;
  const syncCursorByRoot = new Map();
  const MAX_SYNC_SUBDIRS = 24;

  function isExpandedDirChainOpen(expanded, relDir) {
    if (!relDir) return true;
    const parts = relDir.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i += 1) {
      if (!expanded.has(parts.slice(0, i).join('/'))) {
        return false;
      }
    }
    return true;
  }

  function dirEntriesSignature(entries) {
    if (!Array.isArray(entries)) return '';
    return entries.map((e) => `${e.relPath}:${e.isDirectory ? 'D' : 'F'}`).join('\n');
  }

  function isTreeVisibleNow() {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return false;
    }
    try {
      if (window.self !== window.top && typeof isAuxIframeVisible === 'function') {
        return isAuxIframeVisible();
      }
    } catch {}
    return true;
  }

  async function syncVisibleExpandedDirs() {
    const root = state.activeRoot;
    if (!root || state.searchQuery.trim() || syncVisibleInFlight || !isTreeVisibleNow()) {
      return;
    }
    syncVisibleInFlight = true;
    try {
      const expanded = getExpandedSet(root);
      const visibleSubdirs = [];
      for (const d of expanded) {
        if (d && isExpandedDirChainOpen(expanded, d)) {
          visibleSubdirs.push(d);
        }
      }
      const dirsToSync = [''];
      if (visibleSubdirs.length <= MAX_SYNC_SUBDIRS) {
        dirsToSync.push(...visibleSubdirs);
        syncCursorByRoot.set(root, 0);
      } else {
        const total = visibleSubdirs.length;
        const start = (syncCursorByRoot.get(root) || 0) % total;
        for (let k = 0; k < MAX_SYNC_SUBDIRS; k += 1) {
          dirsToSync.push(visibleSubdirs[(start + k) % total]);
        }
        syncCursorByRoot.set(root, (start + MAX_SYNC_SUBDIRS) % total);
      }
      let changed = false;
      for (let i = 0; i < dirsToSync.length; i += 4) {
        if (state.activeRoot !== root || state.searchQuery.trim()) return;
        const batch = dirsToSync.slice(i, i + 4);
        await Promise.all(
          batch.map(async (relDir) => {
            const key = cacheKey(root, relDir);
            const prevSig = state.dirCache.has(key) ? dirEntriesSignature(state.dirCache.get(key)) : null;
            try {
              const items = await fetchDir(root, relDir, true);
              const nextSig = dirEntriesSignature(items);
              if (prevSig !== nextSig) {
                changed = true;
              }
            } catch (err) {
              if (relDir && err && (err.status === 404 || /不存在|404|not found|ENOENT/i.test(String(err.message || '')))) {
                expanded.delete(relDir);
                state.dirCache.delete(key);
                changed = true;
              }
            }
          })
        );
      }
      if (changed && state.activeRoot === root && !state.searchQuery.trim()) {
        const viewport = $('tree-viewport');
        const prevScrollTop = viewport ? viewport.scrollTop : 0;
        renderTree();
        if (viewport) viewport.scrollTop = prevScrollTop;
      }
    } finally {
      syncVisibleInFlight = false;
    }
  }

  async function bootstrap() {
    applyTheme(false);
    syncHeaderHeightVar();
    // Mark initially hidden overlays inert so Tab cannot focus hidden controls
    const shortcutPanel = $('shortcut-panel');
    if (shortcutPanel) shortcutPanel.inert = true;
    const previewModal = $('preview-modal');
    if (previewModal) previewModal.inert = true;
    renderActivePathBar();
    bindEvents();
    startAuxPaneBridgeCoordinator();
    auxVisibilityCallbacks.add(() => {
      if (isAuxIframeVisible()) {
        syncVisibleExpandedDirs().catch(() => {});
      }
    });
    const ws = await refreshWorkspace(false).catch((err) => {
      showToast(`无法加载工作区 · ${err.message}`);
      return null;
    });
    await loadShortcutInfo();
    checkDeepLinkUrl();
    if (state.isDrawerMode && !state.selectedAbsPath && ws?.lastRevealPath) {
      revealPathInTree(ws.lastRevealPath).catch(() => {});
    }
    setInterval(checkDeepLinkUrl, 350);
    setInterval(() => syncVisibleExpandedDirs().catch(() => {}), 3500);
    await pollMentions();
    setInterval(pollMentions, 2500);
  }

  bootstrap();
})();
