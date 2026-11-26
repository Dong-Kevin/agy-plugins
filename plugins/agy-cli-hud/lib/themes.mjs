/**
 * Unified restrained terminal themes for agy-cli-hud.
 * Inspired by stormzhang/token-tracker: 6 curated palettes (Catppuccin family, Nord, Dracula),
 * each defined by 9 harmonious base hex colors with TrueColor (24-bit) and xterm-256 fallback.
 * Zero external dependencies.
 */

export const DEFAULT_THEME = 'mocha';

export const THEMES = Object.freeze({
  mocha: Object.freeze({
    isLight: false,
    note: 'Catppuccin Mocha · 深色柔和（推荐）',
    base: Object.freeze({
      overlay0: '#6c7086',
      green:    '#a6e3a1',
      yellow:   '#f9e2af',
      peach:    '#fab387',
      red:      '#f38ba8',
      blue:     '#89b4fa',
      sapphire: '#74c7ec',
      mauve:    '#cba6f7',
      pink:     '#f5c2e7'
    })
  }),
  latte: Object.freeze({
    isLight: true,
    note: 'Catppuccin Latte · 浅色终端',
    base: Object.freeze({
      overlay0: '#9ca0b0',
      green:    '#40a02b',
      yellow:   '#df8e1d',
      peach:    '#fe640b',
      red:      '#d20f39',
      blue:     '#1e66f5',
      sapphire: '#209fb5',
      mauve:    '#8839ef',
      pink:     '#ea76cb'
    })
  }),
  frappe: Object.freeze({
    isLight: false,
    note: 'Catppuccin Frappé · 低对比深色',
    base: Object.freeze({
      overlay0: '#737994',
      green:    '#a6d189',
      yellow:   '#e5c890',
      peach:    '#ef9f76',
      red:      '#e78284',
      blue:     '#8caaee',
      sapphire: '#85c1dc',
      mauve:    '#ca9ee6',
      pink:     '#f4b8e4'
    })
  }),
  macchiato: Object.freeze({
    isLight: false,
    note: 'Catppuccin Macchiato · 均衡深色',
    base: Object.freeze({
      overlay0: '#6e738d',
      green:    '#a6da95',
      yellow:   '#eed49f',
      peach:    '#f5a97f',
      red:      '#ed8796',
      blue:     '#8aadf4',
      sapphire: '#7dc4e4',
      mauve:    '#c6a0f6',
      pink:     '#f5bde6'
    })
  }),
  nord: Object.freeze({
    isLight: false,
    note: 'Nord · 极简冷灰北极色调',
    base: Object.freeze({
      overlay0: '#4c566a',
      green:    '#a3be8c',
      yellow:   '#ebcb8b',
      peach:    '#d08770',
      red:      '#bf616a',
      blue:     '#5e81ac',
      sapphire: '#88c0d0',
      mauve:    '#b48ead',
      pink:     '#b48ead'
    })
  }),
  dracula: Object.freeze({
    isLight: false,
    note: 'Dracula · 清晰经典暗色',
    base: Object.freeze({
      overlay0: '#6272a4',
      green:    '#50fa7b',
      yellow:   '#f1fa8c',
      peach:    '#ffb86c',
      red:      '#ff5555',
      blue:     '#bd93f9',
      sapphire: '#8be9fd',
      mauve:    '#bd93f9',
      pink:     '#ff79c6'
    })
  })
});

export const THEME_NAMES = Object.freeze(Object.keys(THEMES));

// Semantic slot mapping: keeps each statusline row cohesive (2-3 calm hues, zero rainbow noise)
export const STATUSLINE_SLOTS = Object.freeze({
  muted:     'overlay0',
  label:     'pink',
  barOk:     'green',
  barWarn:   'yellow',
  barDanger: 'red',
  tokens:    'peach',
  total:     'sapphire',
  quota:     'blue',
  colab:     'mauve'
});

const SWATCH_ORDER = ['green', 'yellow', 'peach', 'red', 'blue', 'sapphire', 'mauve', 'pink'];
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

export function isValidTheme(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(THEMES, name.trim().toLowerCase());
}

export function normalizeThemeName(name, fallback = DEFAULT_THEME) {
  if (typeof name === 'string') {
    const k = name.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(THEMES, k)) return k;
  }
  return fallback;
}

export function getThemeSpec(name) {
  return THEMES[normalizeThemeName(name)];
}

export function hexToRgb(hex) {
  const clean = String(hex || '').replace(/^#/, '');
  return [
    parseInt(clean.slice(0, 2), 16) || 0,
    parseInt(clean.slice(2, 4), 16) || 0,
    parseInt(clean.slice(4, 6), 16) || 0
  ];
}

export function hexToAnsi256(hex) {
  const [r, g, b] = hexToRgb(hex);
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return 232 + Math.floor(((r - 8) * 24) / 247);
  }
  const nearest = (v) => {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < CUBE_LEVELS.length; i += 1) {
      const dist = Math.abs(CUBE_LEVELS[i] - v);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    return bestIdx;
  };
  return 16 + 36 * nearest(r) + 6 * nearest(g) + nearest(b);
}

export function hexToAnsiFg(hex, depth = 'truecolor') {
  if (depth === 'none' || !hex) return '';
  if (depth === 'truecolor') {
    const [r, g, b] = hexToRgb(hex);
    return `\x1b[38;2;${r};${g};${b}m`;
  }
  return `\x1b[38;5;${hexToAnsi256(hex)}m`;
}

export function detectColorDepth(useColor = true, explicitDepth = null) {
  if (!useColor) return 'none';
  if (explicitDepth === 'truecolor' || explicitDepth === '256' || explicitDepth === 'none') {
    return explicitDepth;
  }
  const termProgram = String(process.env.TERM_PROGRAM || '');
  if (termProgram === 'Apple_Terminal') return '256';
  const colorTerm = String(process.env.COLORTERM || '');
  if (
    /(truecolor|24bit)/i.test(colorTerm) ||
    /(ghostty|iterm|wezterm|kitty|alacritty|warp|vscode|hyper|rio|tabby)/i.test(termProgram) ||
    Boolean(process.env.WT_SESSION) ||
    Boolean(process.env.CLI_AGENTS_SURFACE_ID)
  ) {
    return 'truecolor';
  }
  return '256';
}

export function resolveThemeName({ explicitTheme = null, summaryTheme = null, env = process.env } = {}) {
  if (isValidTheme(explicitTheme)) return normalizeThemeName(explicitTheme);
  if (isValidTheme(env?.AGY_HUD_THEME)) return normalizeThemeName(env.AGY_HUD_THEME);
  if (isValidTheme(summaryTheme)) return normalizeThemeName(summaryTheme);
  return DEFAULT_THEME;
}

export function resolveStatuslineColors(themeName, depth = 'truecolor') {
  if (depth === 'none') {
    const empty = { reset: '' };
    for (const key of Object.keys(STATUSLINE_SLOTS)) empty[key] = '';
    return empty;
  }
  const base = getThemeSpec(themeName).base;
  const out = { reset: '\x1b[0m' };
  for (const [slot, baseKey] of Object.entries(STATUSLINE_SLOTS)) {
    out[slot] = hexToAnsiFg(base[baseKey], depth);
  }
  return out;
}

export function formatThemeSwatches(themeName, depth = 'truecolor') {
  const base = getThemeSpec(themeName).base;
  if (depth === 'none') return SWATCH_ORDER.map((k) => k.slice(0, 2)).join(' ');
  return SWATCH_ORDER.map((k) => `${hexToAnsiFg(base[k], depth)}██\x1b[0m`).join(' ');
}
