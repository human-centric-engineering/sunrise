/**
 * Analytics Event Constants
 *
 * Centralized event name definitions for type-safe analytics tracking.
 * Uses snake_case with past tense (e.g., user_logged_in, profile_updated).
 *
 * Phase 4.5: Analytics Integration
 *
 * @see .context/analytics/overview.md for event catalog and best practices
 */

/**
 * All analytics event names
 *
 * Organized by domain for easy navigation and auditing.
 *
 * @example
 * ```tsx
 * import { EVENTS } from '@/lib/analytics/events';
 * track(EVENTS.USER_LOGGED_IN, { method: 'email' });
 * ```
 */
export const EVENTS = {
  // ─────────────────────────────────────────────────────────────
  // Authentication Events
  // ─────────────────────────────────────────────────────────────

  /** User completed signup (email or OAuth) */
  USER_SIGNED_UP: 'user_signed_up',

  /** User successfully logged in */
  USER_LOGGED_IN: 'user_logged_in',

  /** User logged out */
  USER_LOGGED_OUT: 'user_logged_out',

  // ─────────────────────────────────────────────────────────────
  // Settings Events
  // ─────────────────────────────────────────────────────────────

  /** User changed settings tab */
  SETTINGS_TAB_CHANGED: 'settings_tab_changed',

  /** User updated their profile */
  PROFILE_UPDATED: 'profile_updated',

  /** User changed their password */
  PASSWORD_CHANGED: 'password_changed',

  /** User updated notification/marketing preferences */
  PREFERENCES_UPDATED: 'preferences_updated',

  /** User uploaded a new avatar */
  AVATAR_UPLOADED: 'avatar_uploaded',

  /** User deleted their account */
  ACCOUNT_DELETED: 'account_deleted',

  // ─────────────────────────────────────────────────────────────
  // Form Events
  // ─────────────────────────────────────────────────────────────
  // Form events use the generic trackFormSubmitted() helper which
  // automatically generates event names: {formName}_form_submitted
  // See lib/analytics/events/forms.ts for usage
} as const;

/**
 * Event name type union
 *
 * Useful for type-safe event tracking functions.
 */
export type EventName = (typeof EVENTS)[keyof typeof EVENTS];
