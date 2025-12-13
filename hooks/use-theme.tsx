'use client'

import { createContext, useContext, useEffect, useMemo, useState } from 'react'

type Theme = 'dark' | 'light' | 'system'

interface ThemeContextValue {
  theme: Theme
  setTheme: (theme: Theme) => void
  resolvedTheme: 'dark' | 'light'
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Initialize theme from localStorage on first render
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('theme') as Theme | null
      return stored || 'system'
    }
    return 'system'
  })

  // Track if component is mounted (for SSR compatibility)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Required for SSR hydration matching
    setMounted(true)
  }, [])

  // Derive resolvedTheme from theme instead of storing in state
  const resolvedTheme = useMemo<'dark' | 'light'>(() => {
    if (!mounted) return 'light'

    if (theme === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
    }
    return theme
  }, [theme, mounted])

  useEffect(() => {
    const root = window.document.documentElement

    // Remove existing theme classes
    root.classList.remove('light', 'dark')

    // Add current theme class
    root.classList.add(resolvedTheme)

    // Save to localStorage
    localStorage.setItem('theme', theme)
  }, [theme, resolvedTheme])

  return (
    <ThemeContext.Provider value={{ theme, setTheme, resolvedTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}
