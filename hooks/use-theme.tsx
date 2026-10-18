'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

import {
  PREFERS_DARK_QUERY,
  THEME_STORAGE_KEY,
  readStoredTheme,
  resolveTheme,
  type Theme,
} from '@/lib/theme';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function devicePrefersDark(): boolean {
  return window.matchMedia(PREFERS_DARK_QUERY).matches;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // The visitor's explicit pick, and the device's setting, kept apart: only the
  // pick is ever stored, so a visitor who never picks keeps following the
  // device (#756). See `lib/theme.ts`.
  const [stored, setStored] = useState<Theme | null>(() =>
    typeof window === 'undefined' ? null : readStoredTheme()
  );
  const [prefersDark, setPrefersDark] = useState<boolean>(() =>
    typeof window === 'undefined' ? false : devicePrefersDark()
  );
  const theme = resolveTheme(stored, prefersDark);

  useEffect(() => {
    const query = window.matchMedia(PREFERS_DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) => {
      // Re-read storage too: a pick made in another tab outranks the device.
      setStored(readStoredTheme());
      setPrefersDark(event.matches);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage blocked: the pick still applies for this page view.
    }
    setStored(next);
  }, []);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
