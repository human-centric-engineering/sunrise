/**
 * Cookie Consent Configuration
 *
 * Centralized configuration for the cookie consent system.
 *
 * Phase 3.5: Landing Page & Marketing
 */

import type { CookieCategory, ConsentState } from './types';

/**
 * Current consent storage version
 * Increment this when making breaking changes to the consent structure
 */
export const CONSENT_VERSION = 1;

/**
 * localStorage key for consent data
 */
export const CONSENT_STORAGE_KEY = 'cookie-consent';

/**
 * Default consent state before user makes a choice
 */
export const DEFAULT_CONSENT_STATE: ConsentState = {
  essential: true,
  optional: false,
  timestamp: null,
  version: CONSENT_VERSION,
};

/**
 * Cookie category definitions with descriptions
 */
export const COOKIE_CATEGORIES: CookieCategory[] = [
  {
    id: 'essential',
    name: 'Essential',
    description:
      'These cookies are necessary for the website to function. They include authentication, security, and user preferences like theme settings.',
    required: true,
  },
  {
    id: 'optional',
    name: 'Analytics & Marketing',
    description:
      'These cookies help us understand how visitors interact with our website and allow us to show relevant advertisements. They may be set by third-party services.',
    required: false,
  },
];

/**
 * Delay before showing the consent banner (ms)
 * This prevents the banner from interrupting the initial page load
 */
export const BANNER_DELAY_MS = 500;

/**
 * Get the consent enabled setting from environment
 * Defaults to true if not explicitly disabled
 *
 * Note: This is read at build time for NEXT_PUBLIC vars,
 * but we default to true for client-side usage
 */
export function isConsentEnabled(): boolean {
  // In browser, check for the environment variable
  // Default to true if not set
  if (typeof window !== 'undefined') {
    return process.env.NEXT_PUBLIC_COOKIE_CONSENT_ENABLED !== 'false';
  }
  return true;
}
