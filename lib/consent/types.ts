/**
 * Cookie Consent Types
 *
 * TypeScript interfaces for the cookie consent system.
 *
 * Phase 3.5: Landing Page & Marketing
 */

/**
 * Consent state stored in localStorage
 */
export interface ConsentState {
  /** Essential cookies - always true, not toggleable */
  essential: true;
  /** Optional cookies (analytics, marketing) - user's choice */
  optional: boolean;
  /** Timestamp when consent was given (Date.now()) */
  timestamp: number | null;
  /** Version number for future migrations */
  version: number;
}

/**
 * Context value provided by ConsentProvider
 */
export interface ConsentContextValue {
  /** Current consent state */
  consent: ConsentState;
  /** Whether the user has made a consent choice */
  hasConsented: boolean;
  /** Whether the consent UI has been initialized (hydrated) */
  isInitialized: boolean;
  /** Accept all cookies (essential + optional) */
  acceptAll: () => void;
  /** Reject optional cookies (essential only) */
  rejectOptional: () => void;
  /** Update optional consent */
  updateConsent: (optional: boolean) => void;
  /** Reset consent for testing/debugging */
  resetConsent: () => void;
  /** Open the preferences modal */
  openPreferences: () => void;
  /** Close the preferences modal */
  closePreferences: () => void;
  /** Whether the preferences modal is open */
  isPreferencesOpen: boolean;
}

/**
 * Cookie category definition for display
 */
export interface CookieCategory {
  /** Category ID */
  id: 'essential' | 'optional';
  /** Display name */
  name: string;
  /** Description shown to users */
  description: string;
  /** Whether this category can be toggled */
  required: boolean;
}
