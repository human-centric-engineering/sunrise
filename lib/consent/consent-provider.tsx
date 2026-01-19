'use client';

/**
 * Cookie Consent Provider
 *
 * React context provider for managing cookie consent state.
 * Handles localStorage persistence and SSR-safe initialization.
 *
 * Phase 3.5: Landing Page & Marketing
 */

import { createContext, useCallback, useState, useSyncExternalStore } from 'react';
import type { ConsentContextValue, ConsentState } from './types';
import {
  CONSENT_STORAGE_KEY,
  CONSENT_VERSION,
  DEFAULT_CONSENT_STATE,
  isConsentEnabled,
} from './config';

/**
 * Consent context (undefined when accessed outside provider)
 */
export const ConsentContext = createContext<ConsentContextValue | undefined>(undefined);

/**
 * Read consent state from localStorage
 * Returns null if no valid consent is stored
 */
function readStoredConsent(): ConsentState | null {
  if (typeof window === 'undefined') return null;

  try {
    const stored = localStorage.getItem(CONSENT_STORAGE_KEY);
    if (!stored) return null;

    const parsed = JSON.parse(stored) as ConsentState;

    // Validate the stored data structure
    if (
      typeof parsed.essential !== 'boolean' ||
      typeof parsed.optional !== 'boolean' ||
      typeof parsed.version !== 'number'
    ) {
      return null;
    }

    // Check version - if outdated, treat as no consent
    if (parsed.version !== CONSENT_VERSION) {
      return null;
    }

    // Ensure essential is always true
    return { ...parsed, essential: true };
  } catch {
    return null;
  }
}

/**
 * Write consent state to localStorage
 */
function writeConsent(state: ConsentState): void {
  if (typeof window === 'undefined') return;

  try {
    localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(state));
    // Dispatch a custom event to notify subscribers of consent change
    window.dispatchEvent(new CustomEvent('consent-change'));
  } catch {
    // localStorage might be unavailable (private browsing, storage full, etc.)
    // Silently fail - consent will be re-requested on next visit
  }
}

/**
 * Clear consent from localStorage
 */
function clearConsent(): void {
  if (typeof window === 'undefined') return;

  try {
    localStorage.removeItem(CONSENT_STORAGE_KEY);
    // Dispatch a custom event to notify subscribers of consent change
    window.dispatchEvent(new CustomEvent('consent-change'));
  } catch {
    // Silently fail
  }
}

/**
 * Subscribe to consent changes in localStorage
 */
function subscribeToConsent(callback: () => void): () => void {
  const handler = () => {
    // Update cached snapshot before notifying
    cachedSnapshot = readStoredConsent() ?? DEFAULT_CONSENT_STATE;
    callback();
  };
  window.addEventListener('consent-change', handler);
  window.addEventListener('storage', handler);
  return () => {
    window.removeEventListener('consent-change', handler);
    window.removeEventListener('storage', handler);
  };
}

/**
 * Cached snapshot to avoid infinite loops with useSyncExternalStore
 * The snapshot must return the same object reference if data hasn't changed
 */
let cachedSnapshot: ConsentState | null = null;

/**
 * Get the current consent snapshot from localStorage
 * Returns cached value to maintain referential equality
 */
function getConsentSnapshot(): ConsentState {
  if (cachedSnapshot === null) {
    cachedSnapshot = readStoredConsent() ?? DEFAULT_CONSENT_STATE;
  }
  return cachedSnapshot;
}

/**
 * Get server snapshot (for SSR)
 */
function getServerSnapshot(): ConsentState {
  return DEFAULT_CONSENT_STATE;
}

interface ConsentProviderProps {
  children: React.ReactNode;
}

/**
 * ConsentProvider component
 *
 * Wraps the application to provide cookie consent context.
 * Must be placed high in the component tree.
 *
 * @example
 * ```tsx
 * <ConsentProvider>
 *   <App />
 * </ConsentProvider>
 * ```
 */
export function ConsentProvider({ children }: ConsentProviderProps) {
  // Use useSyncExternalStore for SSR-safe localStorage synchronization
  const consent = useSyncExternalStore(subscribeToConsent, getConsentSnapshot, getServerSnapshot);

  // Track if we're hydrated (client-side)
  const isInitialized = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );

  // Preferences modal state (local UI state, not persisted)
  const [isPreferencesOpen, setIsPreferencesOpen] = useState(false);

  // Whether user has made a consent choice
  const hasConsented = consent.timestamp !== null;

  // Accept all cookies
  const acceptAll = useCallback(() => {
    const newState: ConsentState = {
      essential: true,
      optional: true,
      timestamp: Date.now(),
      version: CONSENT_VERSION,
    };
    writeConsent(newState);
  }, []);

  // Reject optional cookies (essential only)
  const rejectOptional = useCallback(() => {
    const newState: ConsentState = {
      essential: true,
      optional: false,
      timestamp: Date.now(),
      version: CONSENT_VERSION,
    };
    writeConsent(newState);
  }, []);

  // Update optional consent
  const updateConsent = useCallback((optional: boolean) => {
    const newState: ConsentState = {
      essential: true,
      optional,
      timestamp: Date.now(),
      version: CONSENT_VERSION,
    };
    writeConsent(newState);
  }, []);

  // Reset consent (for testing/debugging)
  const resetConsent = useCallback(() => {
    clearConsent();
  }, []);

  // Modal controls
  const openPreferences = useCallback(() => setIsPreferencesOpen(true), []);
  const closePreferences = useCallback(() => setIsPreferencesOpen(false), []);

  // If consent is disabled via environment variable, provide a minimal context
  // that indicates consent is given (to not block any functionality)
  if (!isConsentEnabled()) {
    const disabledValue: ConsentContextValue = {
      consent: { ...DEFAULT_CONSENT_STATE, optional: true, timestamp: 0 },
      hasConsented: true,
      isInitialized: true,
      acceptAll: () => {},
      rejectOptional: () => {},
      updateConsent: () => {},
      resetConsent: () => {},
      openPreferences: () => {},
      closePreferences: () => {},
      isPreferencesOpen: false,
    };

    return <ConsentContext.Provider value={disabledValue}>{children}</ConsentContext.Provider>;
  }

  const value: ConsentContextValue = {
    consent,
    hasConsented,
    isInitialized,
    acceptAll,
    rejectOptional,
    updateConsent,
    resetConsent,
    openPreferences,
    closePreferences,
    isPreferencesOpen,
  };

  return <ConsentContext.Provider value={value}>{children}</ConsentContext.Provider>;
}
