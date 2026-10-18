/**
 * Light / dark theme resolution, shared by the root layout's no-flash script
 * and `ThemeProvider` so the two cannot disagree.
 *
 * A stored value is a visitor's explicit pick and wins. With nothing stored the
 * device's `prefers-color-scheme` decides, and keeps deciding when the device
 * switches. Only an explicit pick (`setTheme`) is ever written (#756) — saving
 * the resolved device value would freeze it as though the visitor had chosen it.
 *
 * A plain module, not `'use client'`: the layout is a server component and
 * needs the script string itself, not a client reference to it.
 */

export type Theme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'theme';

export const PREFERS_DARK_QUERY = '(prefers-color-scheme: dark)';

/** The visitor's explicit pick, or `null` when they have not made one. */
export function readStoredTheme(): Theme | null {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    // Storage blocked (private mode, sandboxed frame): no pick to honour.
    return null;
  }
}

export function resolveTheme(stored: Theme | null, prefersDark: boolean): Theme {
  return stored ?? (prefersDark ? 'dark' : 'light');
}

/**
 * Runs before first paint so the page never flashes the wrong theme. It reads
 * storage and never writes it. Keep it in step with `resolveTheme` —
 * `tests/unit/lib/theme.test.tsx` runs both over the same inputs.
 */
export const NO_FLASH_THEME_SCRIPT = `
(function() {
  try {
    var stored = localStorage.getItem('${THEME_STORAGE_KEY}');
    var theme = stored === 'light' || stored === 'dark'
      ? stored
      : window.matchMedia('${PREFERS_DARK_QUERY}').matches ? 'dark' : 'light';
    document.documentElement.classList.add(theme);
  } catch (e) {}
})();
`;
