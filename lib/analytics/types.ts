/**
 * Analytics System Types
 *
 * TypeScript interfaces for the pluggable analytics system.
 * Follows Segment-like API patterns for cross-provider compatibility.
 *
 * NOTE: The `[key: string]: unknown` index signatures on `UserTraits`,
 * `EventProperties`, and `PageProperties` are intentional. Analytics
 * providers pass these objects to third-party SDKs that accept arbitrary
 * key-value pairs. Removing the index signatures would prevent passing
 * domain-specific event types (e.g., `AuthEventProps`) to `track()`.
 *
 * Phase 4.5: Analytics Integration
 *
 * @see .context/analytics/overview.md for architecture documentation
 */

/**
 * Supported analytics provider types
 */
export type AnalyticsProviderType = 'ga4' | 'posthog' | 'plausible' | 'console';

/**
 * Common user traits for identification
 */
export interface UserTraits {
  /** User's email address */
  email?: string;
  /** Display name */
  name?: string;
  /** First name */
  firstName?: string;
  /** Last name */
  lastName?: string;
  /** Account creation date */
  createdAt?: Date | string;
  /** User's role in the application */
  role?: string;
  /** User's subscription plan */
  plan?: string;
  /** Organization/company name */
  company?: string;
  /** Custom traits */
  [key: string]: unknown;
}

/**
 * Event properties for tracking
 */
export interface EventProperties {
  /** Event category for grouping */
  category?: string;
  /** Event label for additional context */
  label?: string;
  /** Numeric value associated with the event */
  value?: number;
  /** Revenue amount (for purchase events) */
  revenue?: number;
  /** Currency code (ISO 4217) */
  currency?: string;
  /** Custom properties */
  [key: string]: unknown;
}

/**
 * Page properties for page view tracking
 */
export interface PageProperties {
  /** Page title */
  title?: string;
  /** Page URL path */
  path?: string;
  /** Full URL including query params */
  url?: string;
  /** Referring URL */
  referrer?: string;
  /** Search/query string */
  search?: string;
  /** Custom properties */
  [key: string]: unknown;
}

/**
 * Result from tracking operations
 */
export interface TrackResult {
  /** Whether the tracking call was successful */
  success: boolean;
  /** Error message if tracking failed */
  error?: string;
  /** Provider-specific response data */
  data?: unknown;
}

/**
 * Provider-specific feature flags
 */
export interface ProviderFeatures {
  /** Provider supports user identification */
  supportsIdentify: boolean;
  /** Provider supports server-side tracking */
  supportsServerSide: boolean;
  /** Provider supports feature flags */
  supportsFeatureFlags: boolean;
  /** Provider supports session replay */
  supportsSessionReplay: boolean;
  /** Provider supports cookieless tracking */
  supportsCookieless: boolean;
}

/**
 * Analytics context value provided by AnalyticsProvider
 */
export interface AnalyticsContextValue {
  /** Identify a user */
  identify: (userId: string, traits?: UserTraits) => Promise<TrackResult>;
  /** Track a custom event */
  track: (event: string, properties?: EventProperties) => Promise<TrackResult>;
  /** Track a page view */
  page: (name?: string, properties?: PageProperties) => Promise<TrackResult>;
  /** Reset user identity (on logout) */
  reset: () => Promise<TrackResult>;
  /** Check if analytics is ready and consent is given */
  isReady: boolean;
  /** Check if analytics is enabled */
  isEnabled: boolean;
  /** Get provider name */
  providerName: string | null;
}

/**
 * Server-side tracking options
 */
export interface ServerTrackOptions {
  /** Event name */
  event: string;
  /** User ID (required for server-side tracking) */
  userId?: string;
  /** Anonymous ID (if no user ID) */
  anonymousId?: string;
  /** Event properties */
  properties?: EventProperties;
  /** Request context (IP, user agent, etc.) */
  context?: ServerTrackContext;
}

/**
 * Server-side tracking context
 */
export interface ServerTrackContext {
  /** Client IP address */
  ip?: string;
  /** User agent string */
  userAgent?: string;
  /** Page URL */
  page?: {
    url?: string;
    path?: string;
    referrer?: string;
  };
}
