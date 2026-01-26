/**
 * Analytics Event Property Types
 *
 * Type definitions for event properties to ensure type-safe tracking.
 *
 * Phase 4.5: Analytics Integration
 *
 * @see .context/analytics/overview.md for event catalog and schemas
 */

// ─────────────────────────────────────────────────────────────
// Authentication Event Properties
// ─────────────────────────────────────────────────────────────

/**
 * Authentication method type
 */
export type AuthMethod = 'email' | 'oauth';

/**
 * Properties for authentication events (login/signup)
 *
 * @example Email authentication
 * ```ts
 * { method: 'email' }
 * ```
 *
 * @example OAuth authentication
 * ```ts
 * { method: 'oauth', provider: 'google' }
 * ```
 */
export interface AuthEventProps {
  /** Authentication method type */
  method: AuthMethod;
  /** OAuth provider ID (when method is 'oauth') - e.g., 'google', 'facebook', 'linkedin' */
  provider?: string;
  /** Index signature for EventProperties compatibility */
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────
// Settings Event Properties
// ─────────────────────────────────────────────────────────────

/**
 * Available settings tabs
 */
export type SettingsTab = 'profile' | 'security' | 'notifications' | 'account';

/**
 * Properties for settings tab change event
 *
 * @example
 * ```ts
 * { tab: 'security', previous_tab: 'profile' }
 * ```
 */
export interface SettingsTabEventProps {
  /** The tab the user navigated to */
  tab: SettingsTab;
  /** The tab the user navigated from (undefined on initial load) */
  previous_tab?: SettingsTab;
  /** Index signature for EventProperties compatibility */
  [key: string]: unknown;
}

/**
 * Properties for profile update event
 *
 * @example
 * ```ts
 * { fields_changed: ['name', 'bio'] }
 * ```
 */
export interface ProfileUpdatedEventProps {
  /** List of field names that were changed */
  fields_changed: string[];
  /** Index signature for EventProperties compatibility */
  [key: string]: unknown;
}

/**
 * Properties for preferences update event
 *
 * @example
 * ```ts
 * { marketing: true, product_updates: false }
 * ```
 */
export interface PreferencesUpdatedEventProps {
  /** User opted in/out of marketing emails */
  marketing: boolean;
  /** User opted in/out of product update emails */
  product_updates: boolean;
  /** Index signature for EventProperties compatibility */
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────
// User Traits for Identification
// ─────────────────────────────────────────────────────────────

/**
 * Common user traits for identify calls
 *
 * @example
 * ```ts
 * identify(user.id, { email: 'user@example.com', name: 'John Doe' })
 * ```
 */
export interface IdentifyTraits {
  /** User's email address */
  email?: string;
  /** User's display name */
  name?: string;
  /** Account creation date */
  createdAt?: Date | string;
  /** Index signature for UserTraits compatibility */
  [key: string]: unknown;
}
