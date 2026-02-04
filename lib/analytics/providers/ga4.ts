/**
 * Google Analytics 4 Provider
 *
 * Analytics provider implementation for Google Analytics 4.
 * Uses gtag.js for client-side tracking.
 *
 * Phase 4.5: Analytics Integration
 *
 * @see https://developers.google.com/analytics/devguides/collection/ga4
 * @see .context/analytics/overview.md for architecture documentation
 */

import type {
  UserTraits,
  EventProperties,
  PageProperties,
  TrackResult,
  ProviderFeatures,
} from '../types';
import type { AnalyticsProvider, GA4ProviderConfig } from './types';
import { logger } from '@/lib/logging';

// Extend Window interface for gtag
declare global {
  interface Window {
    dataLayer: unknown[];
    gtag: (...args: unknown[]) => void;
  }
}

/**
 * Google Analytics 4 Provider
 *
 * Implements the AnalyticsProvider interface using Google Analytics 4.
 * Requires the GA4 script to be loaded (handled by AnalyticsScripts component).
 *
 * @example
 * ```typescript
 * const provider = createGA4Provider({ measurementId: 'G-XXXXXXXXXX' });
 * await provider.init();
 * await provider.track('purchase', { value: 99.99, currency: 'USD' });
 * ```
 */
export class GA4Provider implements AnalyticsProvider {
  readonly name = 'Google Analytics 4';
  readonly type = 'ga4' as const;

  private ready = false;
  private measurementId: string;
  private debug: boolean;
  private userId: string | null = null;

  constructor(config: GA4ProviderConfig) {
    this.measurementId = config.measurementId;
    this.debug = config.debug ?? false;
  }

  async init(): Promise<void> {
    if (this.ready) return;

    // Wait for gtag to be available (loaded by AnalyticsScripts)
    await this.waitForGtag();

    // Configure GA4
    this.gtag('js', new Date());
    this.gtag('config', this.measurementId, {
      send_page_view: false, // We'll track page views manually
      debug_mode: this.debug,
    });

    this.ready = true;
    this.log('init', 'GA4 provider initialized');
  }

  identify(userId: string, traits?: UserTraits): Promise<TrackResult> {
    if (!this.ready) {
      return Promise.resolve({ success: false, error: 'GA4 not initialized' });
    }

    this.userId = userId;

    // Set user ID for GA4
    this.gtag('config', this.measurementId, {
      user_id: userId,
    });

    // Set user properties
    if (traits) {
      const userProperties: Record<string, unknown> = {};

      if (traits.email) userProperties.email = traits.email;
      if (traits.name) userProperties.name = traits.name;
      if (traits.plan) userProperties.plan = traits.plan;
      if (traits.company) userProperties.company = traits.company;

      this.gtag('set', 'user_properties', userProperties);
    }

    this.log('identify', userId, traits);
    return Promise.resolve({ success: true });
  }

  track(event: string, properties?: EventProperties): Promise<TrackResult> {
    if (!this.ready) {
      return Promise.resolve({ success: false, error: 'GA4 not initialized' });
    }

    // GA4 event parameters
    const params: Record<string, unknown> = {
      ...properties,
    };

    // Map common properties to GA4 parameters
    if (properties?.category) {
      params.event_category = properties.category;
    }
    if (properties?.label) {
      params.event_label = properties.label;
    }
    if (properties?.value !== undefined) {
      params.value = properties.value;
    }
    if (properties?.revenue !== undefined) {
      params.value = properties.revenue;
      params.currency = properties.currency ?? 'USD';
    }

    this.gtag('event', event, params);

    this.log('track', event, params);
    return Promise.resolve({ success: true });
  }

  page(name?: string, properties?: PageProperties): Promise<TrackResult> {
    if (!this.ready) {
      return Promise.resolve({ success: false, error: 'GA4 not initialized' });
    }

    const pageName = name ?? (typeof document !== 'undefined' ? document.title : undefined);

    const params: Record<string, unknown> = {
      page_title: pageName,
      page_location:
        properties?.url ?? (typeof window !== 'undefined' ? window.location.href : undefined),
      page_path:
        properties?.path ?? (typeof window !== 'undefined' ? window.location.pathname : undefined),
      page_referrer:
        properties?.referrer ?? (typeof document !== 'undefined' ? document.referrer : undefined),
      ...properties,
    };

    this.gtag('event', 'page_view', params);

    this.log('page', pageName, params);
    return Promise.resolve({ success: true });
  }

  reset(): Promise<TrackResult> {
    if (!this.ready) {
      return Promise.resolve({ success: false, error: 'GA4 not initialized' });
    }

    const previousUserId = this.userId;
    this.userId = null;

    // Clear user ID
    this.gtag('config', this.measurementId, {
      user_id: null,
    });

    // Clear user properties
    this.gtag('set', 'user_properties', {
      email: null,
      name: null,
      plan: null,
      company: null,
    });

    this.log('reset', `User ${previousUserId} logged out`);
    return Promise.resolve({ success: true });
  }

  isReady(): boolean {
    return this.ready;
  }

  getFeatures(): ProviderFeatures {
    return {
      supportsIdentify: true,
      supportsServerSide: true,
      supportsFeatureFlags: false,
      supportsSessionReplay: false,
      supportsCookieless: false,
    };
  }

  /**
   * Get the measurement ID for script loading
   */
  getMeasurementId(): string {
    return this.measurementId;
  }

  /**
   * Wait for gtag to be available
   */
  private async waitForGtag(timeout = 5000): Promise<void> {
    const start = Date.now();

    while (typeof window === 'undefined' || typeof window.gtag === 'undefined') {
      if (Date.now() - start > timeout) {
        throw new Error('Timeout waiting for gtag to load');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Call gtag function
   */
  private gtag(...args: unknown[]): void {
    if (typeof window !== 'undefined' && window.gtag) {
      window.gtag(...args);
    }
  }

  /**
   * Log a message for debugging
   */
  private log(method: string, ...args: unknown[]): void {
    if (!this.debug) return;

    logger.debug(`[GA4] ${method}`, { args });
  }
}

/**
 * Create a GA4 analytics provider
 *
 * @param config - Provider configuration
 * @returns Configured GA4 provider
 */
export function createGA4Provider(config: GA4ProviderConfig): GA4Provider {
  return new GA4Provider(config);
}
