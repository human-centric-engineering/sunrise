/**
 * PostHog Analytics Provider
 *
 * Full-featured analytics provider implementation for PostHog.
 * Supports events, user identification, feature flags, and session replay.
 *
 * Phase 4.5: Analytics Integration
 *
 * @see https://posthog.com/docs
 * @see .context/analytics/overview.md for architecture documentation
 */

import type {
  UserTraits,
  EventProperties,
  PageProperties,
  TrackResult,
  ProviderFeatures,
} from '@/lib/analytics/types';
import type { AnalyticsProvider, PostHogProviderConfig } from '@/lib/analytics/providers/types';
import {
  analyticsPageProperties,
  analyticsPath,
  analyticsUrl,
  currentPagePath,
  currentPageUrl,
  currentReferrer,
} from '@/lib/analytics/page-location';
import { logger } from '@/lib/logging';

// PostHog type definitions
interface PostHogInstance {
  init(apiKey: string, options?: PostHogOptions): void;
  capture(event: string, properties?: Record<string, unknown>): void;
  identify(distinctId: string, properties?: Record<string, unknown>): void;
  reset(): void;
  isFeatureEnabled(key: string): boolean;
  getFeatureFlag(key: string): string | boolean | undefined;
  onFeatureFlags(callback: (flags: string[]) => void): void;
}

interface PostHogOptions {
  api_host?: string;
  capture_pageview?: boolean;
  capture_pageleave?: boolean;
  disable_session_recording?: boolean;
  before_send?: (event: PostHogCaptureResult | null) => PostHogCaptureResult | null;
  loaded?: (posthog: PostHogInstance) => void;
  bootstrap?: {
    distinctID?: string;
    featureFlags?: Record<string, string | boolean>;
  };
}

/** The event `before_send` receives (only the parts read here). */
interface PostHogCaptureResult {
  event: string;
  properties?: Record<string, unknown>;
  $set?: Record<string, unknown>;
  $set_once?: Record<string, unknown>;
  [key: string]: unknown;
}

/** PostHog's own address-bearing property names: `$current_url`, `$initial_referrer`, `$pathname`… */
const POSTHOG_URL_KEY = /(?:url|referrer)$/i;
const POSTHOG_PATH_KEY = /pathname$/i;

/** An `href="…"` in autocapture's `$elements_chain` (quotes inside are `\\"`-escaped). */
const CHAIN_HREF = /href="((?:[^"\\]|\\.)*)"/g;

/** Whether a PostHog property value is an address rather than a sentinel such as `$direct`. */
function isAddress(value: string): boolean {
  return /^https?:\/\//i.test(value) || value.startsWith('/');
}

/** A link target as autocapture records it: reduced, or dropped if not http(s). */
function reduceHref(href: string): string {
  return analyticsUrl(href) ?? '';
}

function reduceElements(elements: unknown): unknown {
  if (!Array.isArray(elements)) return elements;
  return elements.map((element: unknown) => {
    if (typeof element !== 'object' || element === null) return element;
    const out: Record<string, unknown> = { ...element };
    if (typeof out.attr__href === 'string') out.attr__href = reduceHref(out.attr__href);
    return out;
  });
}

function reduceLocationProperties(
  properties: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!properties) return properties;
  const out: Record<string, unknown> = { ...properties };
  for (const [key, value] of Object.entries(properties)) {
    if (!key.startsWith('$')) continue;
    // Autocapture records each clicked element, and a link's target, which
    // on a share page carries the same token as the page itself.
    if (key === '$elements') out[key] = reduceElements(value);
    else if (typeof value !== 'string') continue;
    else if (key === '$elements_chain')
      out[key] = value.replace(CHAIN_HREF, (_match, href: string) => `href="${reduceHref(href)}"`);
    // `$direct` and other sentinels are not addresses: only a URL or a path
    // is reduced.
    else if (POSTHOG_URL_KEY.test(key)) out[key] = isAddress(value) ? analyticsUrl(value) : value;
    else if (POSTHOG_PATH_KEY.test(key)) out[key] = analyticsPath(value);
  }
  return out;
}

/**
 * PostHog `before_send`: reduce every address PostHog attached to an event
 * (the page, the referrer, autocapture's link targets) and to the person
 * properties it sets with it (t-780). Exported for tests.
 */
export function reducePostHogLocation(
  event: PostHogCaptureResult | null
): PostHogCaptureResult | null {
  if (!event) return event;
  return {
    ...event,
    properties: reduceLocationProperties(event.properties),
    ...(event.$set && { $set: reduceLocationProperties(event.$set) }),
    ...(event.$set_once && { $set_once: reduceLocationProperties(event.$set_once) }),
  };
}

// Extend Window interface for PostHog
declare global {
  interface Window {
    posthog: PostHogInstance;
  }
}

/**
 * PostHog Analytics Provider
 *
 * Implements the AnalyticsProvider interface using PostHog.
 * Provides full-featured analytics including feature flags and session replay.
 *
 * @example
 * ```typescript
 * const provider = createPostHogProvider({
 *   apiKey: 'phc_...',
 *   host: 'https://app.posthog.com'
 * });
 * await provider.init();
 *
 * // Track an event
 * await provider.track('purchase', { value: 99.99 });
 *
 * // Check a feature flag
 * const features = provider.getFeatures();
 * if (features.supportsFeatureFlags) {
 *   const isEnabled = provider.isFeatureEnabled('new-checkout');
 * }
 * ```
 */
export class PostHogProvider implements AnalyticsProvider {
  readonly name = 'PostHog';
  readonly type = 'posthog' as const;

  private ready = false;
  private apiKey: string;
  private host: string;
  private debug: boolean;
  private enableSessionRecording: boolean;
  private disableAutoPageViews: boolean;
  private userId: string | null = null;

  constructor(config: PostHogProviderConfig) {
    this.apiKey = config.apiKey;
    this.host = config.host ?? 'https://us.i.posthog.com';
    this.debug = config.debug ?? false;
    this.enableSessionRecording = config.enableSessionRecording ?? false; // Privacy-first: opt-in
    this.disableAutoPageViews = config.disableAutoPageViews ?? true; // We track manually
  }

  async init(): Promise<void> {
    if (this.ready) return;

    // Wait for PostHog to be available (loaded by AnalyticsScripts)
    await this.waitForPostHog();

    // Initialize PostHog
    window.posthog.init(this.apiKey, {
      api_host: this.host,
      capture_pageview: !this.disableAutoPageViews,
      capture_pageleave: true,
      disable_session_recording: !this.enableSessionRecording,
      // Every event PostHog builds by itself (autocapture, page leave, the
      // `$initial_*` person properties) reads the page's address; reduce it
      // before anything is sent (t-780).
      before_send: reducePostHogLocation,
      loaded: () => {
        this.log('init', 'PostHog loaded and initialized');
      },
    });

    this.ready = true;
    this.log('init', 'PostHog provider initialized');
  }

  identify(userId: string, traits?: UserTraits): Promise<TrackResult> {
    if (!this.ready) {
      return Promise.resolve({ success: false, error: 'PostHog not initialized' });
    }

    this.userId = userId;

    // Map traits to PostHog person properties
    const personProperties: Record<string, unknown> = {};

    if (traits) {
      if (traits.email) personProperties.email = traits.email;
      if (traits.name) personProperties.name = traits.name;
      if (traits.firstName) personProperties.first_name = traits.firstName;
      if (traits.lastName) personProperties.last_name = traits.lastName;
      if (traits.createdAt) personProperties.created_at = traits.createdAt;
      if (traits.plan) personProperties.plan = traits.plan;
      if (traits.company) personProperties.company = traits.company;

      // Include any custom traits
      Object.entries(traits).forEach(([key, value]) => {
        if (
          !['email', 'name', 'firstName', 'lastName', 'createdAt', 'plan', 'company'].includes(key)
        ) {
          personProperties[key] = value;
        }
      });
    }

    window.posthog.identify(userId, personProperties);

    this.log('identify', userId, personProperties);
    return Promise.resolve({ success: true });
  }

  track(event: string, properties?: EventProperties): Promise<TrackResult> {
    if (!this.ready) {
      return Promise.resolve({ success: false, error: 'PostHog not initialized' });
    }

    const eventProperties: Record<string, unknown> = {
      ...properties,
    };

    // Map common properties
    if (properties?.revenue !== undefined) {
      eventProperties.$value = properties.revenue;
      eventProperties.$currency = properties.currency ?? 'USD';
    }

    window.posthog.capture(event, eventProperties);

    this.log('track', event, eventProperties);
    return Promise.resolve({ success: true });
  }

  page(name?: string, properties?: PageProperties): Promise<TrackResult> {
    if (!this.ready) {
      return Promise.resolve({ success: false, error: 'PostHog not initialized' });
    }

    const pageName = name ?? (typeof document !== 'undefined' ? document.title : undefined);
    // Address, path and referrer reduced (t-780): see `page-location.ts`.
    const page = analyticsPageProperties(properties);

    const pageProperties: Record<string, unknown> = {
      $current_url: page?.url ?? currentPageUrl(),
      $pathname: page?.path ?? currentPagePath(),
      $referrer: page?.referrer ?? currentReferrer(),
      $title: pageName,
      ...page,
    };

    window.posthog.capture('$pageview', pageProperties);

    this.log('page', pageName, pageProperties);
    return Promise.resolve({ success: true });
  }

  reset(): Promise<TrackResult> {
    if (!this.ready) {
      return Promise.resolve({ success: false, error: 'PostHog not initialized' });
    }

    const previousUserId = this.userId;
    this.userId = null;

    window.posthog.reset();

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
      supportsFeatureFlags: true,
      supportsSessionReplay: this.enableSessionRecording,
      supportsCookieless: true,
    };
  }

  /**
   * Check if a feature flag is enabled
   *
   * @param flagKey - Feature flag key
   * @returns True if the flag is enabled
   */
  isFeatureEnabled(flagKey: string): boolean {
    if (!this.ready || typeof window === 'undefined' || !window.posthog) {
      return false;
    }
    return window.posthog.isFeatureEnabled(flagKey);
  }

  /**
   * Get a feature flag value
   *
   * @param flagKey - Feature flag key
   * @returns Flag value (boolean, string, or undefined)
   */
  getFeatureFlag(flagKey: string): string | boolean | undefined {
    if (!this.ready || typeof window === 'undefined' || !window.posthog) {
      return undefined;
    }
    return window.posthog.getFeatureFlag(flagKey);
  }

  /**
   * Subscribe to feature flag updates
   *
   * @param callback - Function called when flags are loaded/updated
   */
  onFeatureFlags(callback: (flags: string[]) => void): void {
    if (!this.ready || typeof window === 'undefined' || !window.posthog) {
      return;
    }
    window.posthog.onFeatureFlags(callback);
  }

  /**
   * Get API key for script loading
   */
  getApiKey(): string {
    return this.apiKey;
  }

  /**
   * Get host URL for script loading
   */
  getHost(): string {
    return this.host;
  }

  /**
   * Wait for PostHog to be available
   */
  private async waitForPostHog(timeout = 5000): Promise<void> {
    const start = Date.now();

    while (typeof window === 'undefined' || typeof window.posthog === 'undefined') {
      if (Date.now() - start > timeout) {
        throw new Error('Timeout waiting for PostHog to load');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Log a message for debugging
   */
  private log(method: string, ...args: unknown[]): void {
    if (!this.debug) return;

    logger.debug(`[PostHog] ${method}`, { args });
  }
}

/**
 * Create a PostHog analytics provider
 *
 * @param config - Provider configuration
 * @returns Configured PostHog provider
 */
export function createPostHogProvider(config: PostHogProviderConfig): PostHogProvider {
  return new PostHogProvider(config);
}
