/* Reader preferences, themes and typography. Persisted locally and syncable. */

const STORAGE_KEY = 'moread.settings.v1';

export const FONT_CHOICES = [
  {
    id: 'serif',
    name: '宋体',
    sample: '读',
    stack: '"Noto Serif SC", "Source Han Serif SC", "Songti SC", SimSun, STSong, Georgia, serif',
  },
  {
    id: 'kai',
    name: '楷体',
    sample: '读',
    stack: '"Kaiti SC", KaiTi, STKaiti, "LXGW WenKai", "AR PL UKai CN", serif',
  },
  {
    id: 'sans',
    name: '黑体',
    sample: '读',
    stack: '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Source Han Sans SC", "Segoe UI", sans-serif',
  },
  {
    id: 'round',
    name: '圆体',
    sample: '读',
    stack: '"Yuanti SC", "YouYuan", "Quicksand", "PingFang SC", "Microsoft YaHei", sans-serif',
  },
  {
    id: 'system',
    name: '系统',
    sample: '读',
    stack: 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  },
];

export const THEMES = [
  {
    id: 'paper',
    name: '米黄',
    bg: '#f4eddf',
    text: '#332d25',
    accent: '#9a5a34',
    isDark: false,
  },
  {
    id: 'snow',
    name: '纸白',
    bg: '#fbfaf6',
    text: '#2d2c29',
    accent: '#8a5a3b',
    isDark: false,
  },
  {
    id: 'sage',
    name: '护眼',
    bg: '#dfe7d5',
    text: '#2e3a2c',
    accent: '#5e7a4c',
    isDark: false,
  },
  {
    id: 'mist',
    name: '雾蓝',
    bg: '#e7edf0',
    text: '#29343b',
    accent: '#4e6f80',
    isDark: false,
  },
  {
    id: 'dusk',
    name: '暮色',
    bg: '#262b29',
    text: '#c9cec5',
    accent: '#c99a62',
    isDark: true,
  },
  {
    id: 'night',
    name: '夜间',
    bg: '#16181b',
    text: '#bfc2c0',
    accent: '#c7a06b',
    isDark: true,
  },
  {
    id: 'black',
    name: '纯黑',
    bg: '#000000',
    text: '#b4b6b5',
    accent: '#bf9a68',
    isDark: true,
  },
  {
    id: 'custom',
    name: '自定义',
    bg: '#f2ede2',
    text: '#2f2a22',
    accent: '#9a5a34',
    isDark: false,
  },
];

export const DEFAULT_SETTINGS = Object.freeze({
  themeId: 'paper',
  customBg: '#f2ede2',
  customText: '#2f2a22',
  fontFamily: 'serif',
  fontSize: 19,
  lineHeight: 1.9,
  letterSpacing: 0,
  pagePad: 44,
  maxWidth: 760,
  paragraphSpacing: 0.8,
  textIndent: true,
  justify: true,
  mode: 'paged',
  pageAnimation: true,
  updatedAt: 0,
});

const RANGES = {
  fontSize: [14, 34],
  lineHeight: [1.3, 2.6],
  letterSpacing: [-0.5, 3],
  pagePad: [16, 96],
  maxWidth: [560, 1100],
  paragraphSpacing: [0, 2],
};

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function isHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

export function colorIsDark(hex) {
  if (!isHexColor(hex)) return false;
  const value = hex.slice(1);
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance < 0.46;
}

export function sanitizeSettings(input = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...(input || {}) };
  const themeId = THEMES.some((theme) => theme.id === merged.themeId) ? merged.themeId : 'paper';
  const fontFamily = FONT_CHOICES.some((font) => font.id === merged.fontFamily) ? merged.fontFamily : 'serif';
  const out = {
    ...merged,
    themeId,
    fontFamily,
    customBg: isHexColor(merged.customBg) ? merged.customBg : DEFAULT_SETTINGS.customBg,
    customText: isHexColor(merged.customText) ? merged.customText : DEFAULT_SETTINGS.customText,
    mode: merged.mode === 'scroll' ? 'scroll' : 'paged',
    textIndent: Boolean(merged.textIndent),
    justify: Boolean(merged.justify),
    pageAnimation: merged.pageAnimation !== false,
    updatedAt: Math.max(0, Number(merged.updatedAt) || 0),
  };
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    out[key] = clampNumber(merged[key], min, max, DEFAULT_SETTINGS[key]);
  }
  return out;
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function persistSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage might be unavailable; reading still works */
  }
}

export function updateSettings(settings, patch, { touch = true, notify = true } = {}) {
  const next = sanitizeSettings({
    ...settings,
    ...patch,
    updatedAt: touch ? Date.now() : settings.updatedAt,
  });
  persistSettings(next);
  if (notify) {
    try {
      window.dispatchEvent(new CustomEvent('moread:settings', { detail: next }));
    } catch {
      /* non-browser context */
    }
  }
  return next;
}

export function setSyncedSettings(settings) {
  const next = sanitizeSettings(settings);
  persistSettings(next);
  try {
    window.dispatchEvent(new CustomEvent('moread:settings', { detail: next }));
  } catch {
    /* ignore */
  }
  return next;
}

export function resolveTheme(settings) {
  const entry = THEMES.find((theme) => theme.id === settings.themeId) || THEMES[0];
  if (entry.id !== 'custom') return { ...entry };
  const bg = isHexColor(settings.customBg) ? settings.customBg : DEFAULT_SETTINGS.customBg;
  const text = isHexColor(settings.customText) ? settings.customText : DEFAULT_SETTINGS.customText;
  const isDark = colorIsDark(bg);
  return {
    id: 'custom',
    name: '自定义',
    bg,
    text,
    accent: isDark ? '#c7a06b' : '#9a5a34',
    isDark,
  };
}

export function fontStack(settings) {
  const choice = FONT_CHOICES.find((font) => font.id === settings.fontFamily) || FONT_CHOICES[0];
  return choice.stack;
}

export function readerStyleVars(settings) {
  const theme = resolveTheme(settings);
  return {
    '--reader-bg': theme.bg,
    '--reader-text': theme.text,
    '--reader-accent': theme.accent,
    '--reader-font': fontStack(settings),
    '--reader-font-size': `${settings.fontSize}px`,
    '--reader-line-height': String(settings.lineHeight),
    '--reader-letter-spacing': `${settings.letterSpacing}px`,
    '--reader-pad': `${settings.pagePad}px`,
    '--reader-max-width': `${settings.maxWidth}px`,
    '--reader-para-space': `${settings.paragraphSpacing}em`,
    '--reader-indent': settings.textIndent ? '2em' : '0em',
    '--reader-align': settings.justify ? 'justify' : 'start',
    '--reader-selection': theme.isDark
      ? 'color-mix(in srgb, var(--reader-accent) 38%, transparent)'
      : 'color-mix(in srgb, var(--reader-accent) 24%, transparent)',
  };
}

export function applyReaderSettings(element, settings) {
  const vars = readerStyleVars(settings);
  for (const [key, value] of Object.entries(vars)) element.style.setProperty(key, value);
  const theme = resolveTheme(settings);
  element.dataset.theme = theme.id;
  element.dataset.mode = settings.mode;
  element.dataset.indent = settings.textIndent ? 'on' : 'off';
  element.style.colorScheme = theme.isDark ? 'dark' : 'light';
  return theme;
}

export function estimateReadingMinutes(chars) {
  return Math.max(1, Math.round((Number(chars) || 0) / 420));
}

export function resetSettings() {
  const defaults = { ...DEFAULT_SETTINGS, updatedAt: Date.now() };
  persistSettings(defaults);
  return defaults;
}
