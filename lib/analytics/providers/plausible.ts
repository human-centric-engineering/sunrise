/**
 * Plausible Analytics Provider
 *
 * Privacy-focused analytics provider implementation for Plausible.
 * Does NOT support user identification by design (privacy-first).
 *
 * Phase 4.5: Analytics Integration
 *
 * @see https://plausible.io/docs
 * @see .context/analytics/overview.md for architecture documentation
 */

import type {
  UserTraits,
  EventProperties,
  PageProperties,
  TrackResult,
  ProviderFeatures,
} from '../types';
import type { AnalyticsProvider, PlausibleProviderConfig } from './types';

// Plausible type definitions
interface PlausibleFunction {
  (event: string, options?: PlausibleEventOptions): void;
  q?: unknown[][];
}

interface PlausibleEventOptions {
  callback?: () => void;
  props?: Record<string, string | number | boolean>;
  revenue?: {
    currency: string;
    amount: number;
  };
  u?: string; // Custom URL
}

// Extend Window interface for Plausible
declare global {
  interface Window {
    plausible: PlausibleFunction;
  }
}

/**
 * Plausible Analytics Provider
 *
 * Implements the AnalyticsProvider interface using Plausible.
 * Privacy-focused - does NOT track users individually.
 *
 * Key limitations (by design):
 * - No user identification (identify() is a no-op)
 * - No session replay
 * - No feature flags
 *
 * @example
 * ```typescript
 * const provider = createPlausibleProvider({
 *   domain: 'yourdomain.com',
 *   host: 'https://plausible.io' // or self-hosted
 * });
 * await provider.init();
 * await provider.track('signup', { plan: 'pro' });
 * ```
 */
export class PlausibleProvider implements AnalyticsProvider {
  readonly name = 'Plausible';
  readonly type = 'plausible' as const;

  private ready = false;
  private domain: string;
  private host: string;
  private debug: boolean;
  private hashMode: boolean;

  constructor(config: PlausibleProviderConfig) {
    this.domain = config.domain;
    this.host = config.host ?? 'https://plausible.io';
    this.debug = config.debug ?? false;
    this.hashMode = config.hashMode ?? false;
  }

  async init(): Promise<void> {
    if (this.ready) return;

    // Wait for Plausible to be available (loaded by AnalyticsScripts)
    await this.waitForPlausible();

    this.ready = true;
    this.log('init', 'Plausible provider initialized');
  }

  /**
   * Identify a user (NO-OP for Plausible)
   *
   * Plausible is privacy-focused and does not support user identification.
   * This method returns success but does nothing.
   */
  identify(_userId: string, _traits?: UserTraits): Promise<TrackResult> {
    // Plausible does NOT support user identification (privacy-first)
    this.log('identify', 'No-op - Plausible does not support user identification');
    return Promise.resolve({
      success: true,
      data: { note: 'Plausible does not support user identification' },
    });
  }

  async track(event: string, properties?: EventProperties): Promise<TrackResult> {
    if (!this.ready) {
      return { success: false, error: 'Plausible not initialized' };
    }

    const options: PlausibleEventOptions = {};

    // Convert properties to Plausible props (strings, numbers, booleans only)
    if (properties) {
      const props: Record<string, string | number | boolean> = {};

      Object.entries(properties).forEach(([key, value]) => {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          props[key] = value;
        }
      });

      if (Object.keys(props).length > 0) {
        options.props = props;
      }

      // Handle revenue tracking
      if (properties.revenue !== undefined) {
        options.revenue = {
          currency: (properties.currency as string) ?? 'USD',
          amount: properties.revenue,
        };
      }
    }

    return new Promise((resolve) => {
      options.callback = () => {
        resolve({ success: true });
      };

      this.plausible(event, options);
      this.log('track', event, options);

      // Resolve after a short timeout in case callback doesn't fire
      setTimeout(() => resolve({ success: true }), 500);
    });
  }

  async page(name?: string, properties?: PageProperties): Promise<TrackResult> {
    if (!this.ready) {
      return { success: false, error: 'Plausible not initialized' };
    }

    // Plausible automatically tracks page views, but we can track custom ones
    const options: PlausibleEventOptions = {};

    // Set custom URL if provided
    if (properties?.url) {
      options.u = properties.url;
    } else if (properties?.path && typeof window !== 'undefined') {
      options.u = window.location.origin + properties.path;
    }

    // Add any custom props
    if (properties) {
      const props: Record<string, string | number | boolean> = {};

      if (name) props.page_name = name;
      if (properties.title) props.title = properties.title;

      Object.entries(properties).forEach(([key, value]) => {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          if (!['url', 'path', 'referrer', 'search', 'title'].includes(key)) {
            props[key] = value;
          }
        }
      });

      if (Object.keys(props).length > 0) {
        options.props = props;
      }
    }

    return new Promise((resolve) => {
      options.callback = () => {
        resolve({ success: true });
      };

      this.plausible('pageview', options);
      this.log('page', name ?? 'pageview', options);

      // Resolve after a short timeout in case callback doesn't fire
      setTimeout(() => resolve({ success: true }), 500);
    });
  }

  /**
   * Reset user identity (NO-OP for Plausible)
   *
   * Plausible doesn't track users individually, so there's nothing to reset.
   */
  reset(): Promise<TrackResult> {
    // Plausible doesn't track users, so nothing to reset
    this.log('reset', 'No-op - Plausible does not track individual users');
    return Promise.resolve({ success: true });
  }

  isReady(): boolean {
    return this.ready;
  }

  getFeatures(): ProviderFeatures {
    return {
      supportsIdentify: false, // Privacy-focused
      supportsServerSide: true,
      supportsFeatureFlags: false,
      supportsSessionReplay: false,
      supportsCookieless: true, // Default mode
    };
  }

  /**
   * Get domain for script loading
   */
  getDomain(): string {
    return this.domain;
  }

  /**
   * Get host URL for script loading
   */
  getHost(): string {
    return this.host;
  }

  /**
   * Get whether hash mode is enabled
   */
  isHashMode(): boolean {
    return this.hashMode;
  }

  /**
   * Call Plausible function
   */
  private plausible(event: string, options?: PlausibleEventOptions): void {
    if (typeof window !== 'undefined' && window.plausible) {
      window.plausible(event, options);
    }
  }

  /**
   * Wait for Plausible to be available
   */
  private async waitForPlausible(timeout = 5000): Promise<void> {
    const start = Date.now();

    while (typeof window === 'undefined' || typeof window.plausible === 'undefined') {
      if (Date.now() - start > timeout) {
        throw new Error('Timeout waiting for Plausible to load');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Log a message for debugging
   */
  private log(method: string, ...args: unknown[]): void {
    if (!this.debug) return;

    // eslint-disable-next-line no-console
    console.log(`[Plausible] ${method}:`, ...args);
  }
}

/**
 * Create a Plausible analytics provider
 *
 * @param config - Provider configuration
 * @returns Configured Plausible provider
 */
export function createPlausibleProvider(config: PlausibleProviderConfig): PlausibleProvider {
  return new PlausibleProvider(config);
}
