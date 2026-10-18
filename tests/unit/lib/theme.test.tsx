// @vitest-environment happy-dom

/**
 * Theme resolution: the root layout's no-flash script and `ThemeProvider` (#756)
 *
 * The script, the hook's initialiser and its first-mount effect all used to
 * save the device's light / dark setting as though the visitor had picked it,
 * so a device that later switched (an evening schedule, say) was never
 * followed again. Now only `setTheme` writes, and with nothing stored the
 * provider follows `prefers-color-scheme` changes.
 *
 * @see lib/theme.ts
 * @see hooks/use-theme.tsx
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { renderToString } from 'react-dom/server';

import { ThemeProvider, useTheme } from '@/hooks/use-theme';
import {
  NO_FLASH_THEME_SCRIPT,
  PREFERS_DARK_QUERY,
  THEME_STORAGE_KEY,
  readStoredTheme,
  resolveTheme,
} from '@/lib/theme';

/** A controllable `prefers-color-scheme: dark` query. */
function fakeDevice(dark: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    matches: dark,
    media: PREFERS_DARK_QUERY,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.delete(listener),
  };
  vi.spyOn(window, 'matchMedia').mockImplementation(
    () => query as unknown as MediaQueryList // a test double, not external data
  );
  return {
    switchTo(nextDark: boolean) {
      query.matches = nextDark;
      for (const listener of listeners) {
        listener({ matches: nextDark } as MediaQueryListEvent);
      }
    },
  };
}

function runNoFlashScript(): string | null {
  document.documentElement.classList.remove('light', 'dark');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- running the shipped script text is the point
  new Function(NO_FLASH_THEME_SCRIPT)();
  const root = document.documentElement.classList;
  return root.contains('dark') ? 'dark' : root.contains('light') ? 'light' : null;
}

function renderTheme() {
  return renderHook(() => useTheme(), { wrapper: ThemeProvider });
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('light', 'dark');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a visitor with nothing stored', () => {
  it('follows the device when it switches, and stores nothing', () => {
    const device = fakeDevice(false);
    const { result } = renderTheme();
    expect(result.current.theme).toBe('light');

    act(() => device.switchTo(true));

    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('is not stored by the no-flash script', () => {
    fakeDevice(true);
    expect(runNoFlashScript()).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });
});

describe('a visitor who picks a theme', () => {
  it('stores the pick, and stops following the device', () => {
    const device = fakeDevice(false);
    const { result } = renderTheme();

    act(() => result.current.setTheme('light'));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    act(() => device.switchTo(true));
    expect(result.current.theme).toBe('light');
  });

  it('keeps a value stored before this change', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    const device = fakeDevice(false);
    const { result } = renderTheme();

    act(() => device.switchTo(false));
    expect(result.current.theme).toBe('dark');
  });
});

describe('the no-flash script and the hook', () => {
  const STORED = [null, 'light', 'dark', 'not-a-theme'] as const;

  for (const stored of STORED) {
    for (const prefersDark of [false, true]) {
      it(`resolve the same theme (stored: ${String(stored)}, device dark: ${prefersDark})`, () => {
        if (stored !== null) localStorage.setItem(THEME_STORAGE_KEY, stored);
        fakeDevice(prefersDark);
        const expected = resolveTheme(readStoredTheme(), prefersDark);

        expect(runNoFlashScript()).toBe(expected);
        expect(renderTheme().result.current.theme).toBe(expected);
        // Neither one writes: whatever was there is what is there.
        expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(stored);
      });
    }
  }
});

describe('when storage is blocked', () => {
  /** Private mode / sandboxed frame: touching `localStorage` at all throws. */
  function blockStorage() {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
  }

  it('still applies a pick for this page view', () => {
    fakeDevice(false);
    blockStorage();
    const { result } = renderTheme();

    act(() => result.current.setTheme('dark'));

    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('treats an unreadable store as no pick, and follows the device', () => {
    // A stored pick that would win if it could be read.
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    fakeDevice(true);
    blockStorage();

    expect(readStoredTheme()).toBeNull();
    expect(renderTheme().result.current.theme).toBe('dark');
  });
});

describe('on the server', () => {
  it('renders light without touching window', () => {
    function Probe() {
      return <span>{useTheme().theme}</span>;
    }
    vi.stubGlobal('window', undefined);
    try {
      expect(
        renderToString(
          <ThemeProvider>
            <Probe />
          </ThemeProvider>
        )
      ).toContain('light');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('useTheme', () => {
  it('throws outside a ThemeProvider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useTheme())).toThrow(
      'useTheme must be used within a ThemeProvider'
    );
  });
});
