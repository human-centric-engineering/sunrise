/**
 * Analytics Client
 *
 * Singleton client that manages the analytics provider based on configuration.
 * Follows the same pattern as the storage client (graceful degradation).
 *
 * Provider selection priority:
 * 1. NEXT_PUBLIC_ANALYTICS_PROVIDER env var (explicit selection)
 * 2. Auto-detection based on available credentials
 * 3. Console provider fallback in development
 *
 * Phase 4.5: Analytics Integration
 *
 * @see .context/analytics/overview.md for architecture documentation
 */

import type { AnalyticsProvider } from './providers/types';
import type { AnalyticsProviderType } from './types';
import {
  detectProvider,
  getGA4Config,
  getPostHogConfig,
  getPlausibleConfig,
  isBrowser,
  isDevelopment,
} from './config';
import { createConsoleProvider } from './providers/console';
import { createGA4Provider } from './providers/ga4';
import { createPostHogProvider } from './providers/posthog';
import { createPlausibleProvider } from './providers/plausible';

let analyticsClient: AnalyticsProvider | null = null;
let initPromise: Promise<void> | null = null;
let initWarningLogged = false;

/**
 * Get the configured analytics provider (singleton pattern)
 *
 * Returns null if no analytics is configured and not in development mode.
 * In development, falls back to console logging provider.
 *
 * @returns AnalyticsProvider instance or null
 *
 * @example
 * ```typescript
 * const analytics = getAnalyticsClient();
 * if (analytics) {
 *   await analytics.track('signup_completed', { plan: 'pro' });
 * }
 * ```
 */
export function getAnalyticsClient(): AnalyticsProvider | null {
  // Return cached instance if available
  if (analyticsClient) {
    return analyticsClient;
  }

  const detectedProvider = detectProvider();

  if (!detectedProvider) {
    if (!initWarningLogged) {
      initWarningLogged = true;
      if (isBrowser()) {
        // eslint-disable-next-line no-console
        console.debug('[Analytics] No analytics provider configured - tracking disabled');
      }
    }
    return null;
  }

  analyticsClient = createProvider(detectedProvider);

  if (analyticsClient && isBrowser()) {
    // eslint-disable-next-line no-console
    console.debug(`[Analytics] Provider initialized: ${analyticsClient.name}`);
  }

  return analyticsClient;
}

/**
 * Initialize the analytics provider
 *
 * Should be called early in the application lifecycle (e.g., in AnalyticsProvider).
 * Safe to call multiple times - subsequent calls will return the same promise.
 *
 * @returns Promise that resolves when initialization is complete
 */
export async function initAnalytics(): Promise<void> {
  // Return existing init promise if already initializing
  if (initPromise) {
    return initPromise;
  }

  const client = getAnalyticsClient();

  if (!client) {
    return;
  }

  initPromise = client.init();
  await initPromise;
}

/**
 * Create analytics provider based on type
 */
function createProvider(type: AnalyticsProviderType): AnalyticsProvider | null {
  switch (type) {
    case 'console':
      return createConsoleProvider({
        debug: isDevelopment(),
      });

    case 'ga4': {
      const config = getGA4Config();
      if (!config) {
        console.error('[Analytics] GA4 provider requested but not configured', {
          missingVars: ['NEXT_PUBLIC_GA4_MEASUREMENT_ID'],
        });
        return null;
      }
      return createGA4Provider({
        ...config,
        debug: isDevelopment(),
      });
    }

    case 'posthog': {
      const config = getPostHogConfig();
      if (!config) {
        console.error('[Analytics] PostHog provider requested but not configured', {
          missingVars: ['NEXT_PUBLIC_POSTHOG_KEY'],
        });
        return null;
      }
      return createPostHogProvider({
        ...config,
        debug: isDevelopment(),
      });
    }

    case 'plausible': {
      const config = getPlausibleConfig();
      if (!config) {
        console.error('[Analytics] Plausible provider requested but not configured', {
          missingVars: ['NEXT_PUBLIC_PLAUSIBLE_DOMAIN'],
        });
        return null;
      }
      return createPlausibleProvider({
        ...config,
        debug: isDevelopment(),
      });
    }

    default: {
      // Type-safe exhaustive check
      const _exhaustiveCheck: never = type;

      console.error('[Analytics] Unknown provider type:', _exhaustiveCheck);
      return null;
    }
  }
}

/**
 * Check if analytics is enabled and configured
 *
 * Use this to conditionally show/hide analytics-related features.
 *
 * @example
 * ```typescript
 * if (isAnalyticsEnabled()) {
 *   // Track event
 * }
 * ```
 */
export function isAnalyticsEnabled(): boolean {
  return getAnalyticsClient() !== null;
}

/**
 * Get the name of the current analytics provider
 *
 * @returns Provider name or null if not configured
 */
export function getAnalyticsProviderName(): string | null {
  const client = getAnalyticsClient();
  return client?.name ?? null;
}

/**
 * Reset the analytics client (useful for testing)
 *
 * @internal
 */
export function resetAnalyticsClient(): void {
  analyticsClient = null;
  initPromise = null;
  initWarningLogged = false;
}
