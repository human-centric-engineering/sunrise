'use client';

/**
 * Analytics Context Provider
 *
 * React context provider for analytics that integrates with the consent system.
 * Only tracks when the user has consented to optional cookies.
 *
 * Phase 4.5: Analytics Integration
 *
 * @see .context/analytics/overview.md for architecture documentation
 */

import { createContext, useCallback, useEffect, useMemo, useRef } from 'react';
import type {
  AnalyticsContextValue,
  UserTraits,
  EventProperties,
  PageProperties,
  TrackResult,
} from './types';
import {
  getAnalyticsClient,
  initAnalytics,
  getAnalyticsProviderName,
  resetAnalyticsClient,
} from './client';
import { useHasOptionalConsent } from '@/lib/consent';

/**
 * Default no-op result for when analytics is disabled
 */
const NOOP_RESULT: TrackResult = { success: false, error: 'Analytics not available' };

/**
 * Analytics context (undefined when accessed outside provider)
 */
export const AnalyticsContext = createContext<AnalyticsContextValue | undefined>(undefined);

interface AnalyticsProviderProps {
  children: React.ReactNode;
}

/**
 * AnalyticsProvider component
 *
 * Wraps the application to provide analytics context that respects user consent.
 * Must be placed inside ConsentProvider in the component tree.
 *
 * @example
 * ```tsx
 * <ConsentProvider>
 *   <AnalyticsProvider>
 *     <App />
 *   </AnalyticsProvider>
 * </ConsentProvider>
 * ```
 */
export function AnalyticsProvider({ children }: AnalyticsProviderProps) {
  const hasConsent = useHasOptionalConsent();
  const initializingRef = useRef(false);
  const previousConsentRef = useRef(hasConsent);

  // Initialize analytics when consent is given
  useEffect(() => {
    if (hasConsent && !initializingRef.current) {
      const client = getAnalyticsClient();
      if (client && !client.isReady()) {
        initializingRef.current = true;
        initAnalytics()
          .catch((error: unknown) => {
            console.error('[Analytics] Failed to initialize:', error);
          })
          .finally(() => {
            initializingRef.current = false;
          });
      }
    }
  }, [hasConsent]);

  // Reset when consent is revoked
  useEffect(() => {
    // Check if consent was revoked (previously true, now false)
    if (previousConsentRef.current && !hasConsent) {
      const client = getAnalyticsClient();
      if (client?.isReady()) {
        client.reset().catch(() => {
          // Silently ignore reset errors
        });
      }
      // Reset the analytics client singleton so it can be re-initialized later
      resetAnalyticsClient();
    }
    previousConsentRef.current = hasConsent;
  }, [hasConsent]);

  const identify = useCallback(
    async (userId: string, traits?: UserTraits): Promise<TrackResult> => {
      if (!hasConsent) {
        return NOOP_RESULT;
      }

      const client = getAnalyticsClient();
      if (!client?.isReady()) {
        return { success: false, error: 'Analytics not ready' };
      }

      try {
        return await client.identify(userId, traits);
      } catch (error) {
        console.error('[Analytics] identify error:', error);
        return { success: false, error: String(error) };
      }
    },
    [hasConsent]
  );

  const track = useCallback(
    async (event: string, properties?: EventProperties): Promise<TrackResult> => {
      if (!hasConsent) {
        return NOOP_RESULT;
      }

      const client = getAnalyticsClient();
      if (!client?.isReady()) {
        return { success: false, error: 'Analytics not ready' };
      }

      try {
        return await client.track(event, properties);
      } catch (error) {
        console.error('[Analytics] track error:', error);
        return { success: false, error: String(error) };
      }
    },
    [hasConsent]
  );

  const page = useCallback(
    async (name?: string, properties?: PageProperties): Promise<TrackResult> => {
      if (!hasConsent) {
        return NOOP_RESULT;
      }

      const client = getAnalyticsClient();
      if (!client?.isReady()) {
        return { success: false, error: 'Analytics not ready' };
      }

      try {
        return await client.page(name, properties);
      } catch (error) {
        console.error('[Analytics] page error:', error);
        return { success: false, error: String(error) };
      }
    },
    [hasConsent]
  );

  const reset = useCallback(async (): Promise<TrackResult> => {
    const client = getAnalyticsClient();
    if (!client?.isReady()) {
      return { success: false, error: 'Analytics not ready' };
    }

    try {
      return await client.reset();
    } catch (error) {
      console.error('[Analytics] reset error:', error);
      return { success: false, error: String(error) };
    }
  }, []);

  // Derive isReady from consent and client state
  const client = getAnalyticsClient();
  const isReady = hasConsent && (client?.isReady() ?? false);

  const value = useMemo<AnalyticsContextValue>(
    () => ({
      identify,
      track,
      page,
      reset,
      isReady,
      isEnabled: hasConsent,
      providerName: getAnalyticsProviderName(),
    }),
    [identify, track, page, reset, hasConsent, isReady]
  );

  return <AnalyticsContext.Provider value={value}>{children}</AnalyticsContext.Provider>;
}
