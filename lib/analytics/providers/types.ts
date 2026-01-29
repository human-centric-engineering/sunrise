/**
 * Analytics Provider Interface
 *
 * Defines the contract that all analytics providers must implement.
 * Follows the Segment-like API pattern for cross-provider compatibility.
 *
 * Phase 4.5: Analytics Integration
 *
 * @see .context/analytics/overview.md for architecture documentation
 */

import type {
  AnalyticsProviderType,
  UserTraits,
  EventProperties,
  PageProperties,
  TrackResult,
  ProviderFeatures,
} from '../types';

/**
 * Analytics Provider Interface
 *
 * All analytics providers (GA4, PostHog, Plausible, Console) must implement
 * this interface to ensure consistent behavior across different backends.
 *
 * @example
 * ```typescript
 * const provider: AnalyticsProvider = new GA4Provider();
 * await provider.init();
 * await provider.track('signup_completed', { plan: 'pro' });
 * ```
 */
export interface AnalyticsProvider {
  /** Human-readable provider name for logging and debugging */
  readonly name: string;

  /** Provider type identifier */
  readonly type: AnalyticsProviderType;

  /**
   * Initialize the analytics provider
   *
   * Called once when the provider is first used.
   * For client-side providers, this may load external scripts.
   *
   * @returns Promise that resolves when initialization is complete
   */
  init(): Promise<void>;

  /**
   * Identify a user with traits
   *
   * Associates a user ID with the current session and optionally
   * sets user traits (email, name, plan, etc.).
   *
   * Note: Some providers (like Plausible) don't support user identification
   * due to their privacy-focused design. These providers will return success
   * but not actually identify the user.
   *
   * @param userId - Unique user identifier
   * @param traits - Optional user traits to associate
   * @returns Result indicating success or failure
   */
  identify(userId: string, traits?: UserTraits): Promise<TrackResult>;

  /**
   * Track a custom event
   *
   * Records an event with optional properties for analytics.
   *
   * @param event - Event name (e.g., 'button_clicked', 'form_submitted')
   * @param properties - Optional event properties
   * @returns Result indicating success or failure
   */
  track(event: string, properties?: EventProperties): Promise<TrackResult>;

  /**
   * Track a page view
   *
   * Records when a user views a page. For SPAs, this should be called
   * on route changes.
   *
   * @param name - Optional page name (defaults to document.title)
   * @param properties - Optional page properties (path, referrer, etc.)
   * @returns Result indicating success or failure
   */
  page(name?: string, properties?: PageProperties): Promise<TrackResult>;

  /**
   * Reset user identity
   *
   * Called when a user logs out. Clears any user-specific data
   * and generates a new anonymous ID.
   *
   * @returns Result indicating success or failure
   */
  reset(): Promise<TrackResult>;

  /**
   * Check if the provider is ready to receive events
   *
   * Returns true after init() has completed successfully.
   * Events sent before the provider is ready may be queued or dropped.
   *
   * @returns True if the provider is initialized and ready
   */
  isReady(): boolean;

  /**
   * Get provider-specific feature support
   *
   * Returns information about which features this provider supports.
   * Useful for conditional feature usage.
   *
   * @returns Feature support flags
   */
  getFeatures(): ProviderFeatures;
}

/**
 * Base configuration for all providers
 */
export interface BaseProviderConfig {
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * GA4 Provider Configuration
 */
export interface GA4ProviderConfig extends BaseProviderConfig {
  /** GA4 Measurement ID (G-XXXXXXXXXX) */
  measurementId: string;
  /** API secret for server-side Measurement Protocol */
  apiSecret?: string;
}

/**
 * PostHog Provider Configuration
 */
export interface PostHogProviderConfig extends BaseProviderConfig {
  /** PostHog project API key */
  apiKey: string;
  /** PostHog host (defaults to https://app.posthog.com) */
  host?: string;
  /** Enable session recording */
  enableSessionRecording?: boolean;
  /** Disable automatic page view tracking */
  disableAutoPageViews?: boolean;
}

/**
 * Plausible Provider Configuration
 */
export interface PlausibleProviderConfig extends BaseProviderConfig {
  /** Domain registered in Plausible */
  domain: string;
  /** Plausible host (defaults to https://plausible.io) */
  host?: string;
  /** Enable hash-based routing support */
  hashMode?: boolean;
}

/**
 * Console Provider Configuration
 */
export interface ConsoleProviderConfig extends BaseProviderConfig {
  /** Prefix for console output */
  prefix?: string;
}
