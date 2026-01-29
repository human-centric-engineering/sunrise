/**
 * Analytics System
 *
 * Pluggable analytics system with support for multiple providers:
 * - GA4 (Google Analytics 4)
 * - PostHog (full-featured analytics with feature flags)
 * - Plausible (privacy-focused analytics)
 * - Console (development/debugging)
 *
 * Phase 4.5: Analytics Integration
 *
 * @see .context/analytics/overview.md for architecture documentation
 *
 * @example Basic usage
 * ```tsx
 * // In your layout
 * import { AnalyticsProvider, usePageTracking } from '@/lib/analytics';
 *
 * export function Layout({ children }) {
 *   return (
 *     <AnalyticsProvider>
 *       <PageTracker />
 *       {children}
 *     </AnalyticsProvider>
 *   );
 * }
 *
 * function PageTracker() {
 *   usePageTracking();
 *   return null;
 * }
 * ```
 *
 * @example Tracking events
 * ```tsx
 * import { useAnalytics } from '@/lib/analytics';
 *
 * function SignupButton() {
 *   const { track } = useAnalytics();
 *
 *   return (
 *     <button onClick={() => track('signup_clicked', { location: 'hero' })}>
 *       Sign Up
 *     </button>
 *   );
 * }
 * ```
 *
 * @example User identification
 * ```tsx
 * import { useAnalytics } from '@/lib/analytics';
 *
 * function LoginHandler() {
 *   const { identify } = useAnalytics();
 *
 *   const handleLogin = async (user: User) => {
 *     await identify(user.id, {
 *       email: user.email,
 *       name: user.name,
 *       plan: user.plan,
 *     });
 *   };
 * }
 * ```
 */

// Types
export type {
  AnalyticsProviderType,
  UserTraits,
  EventProperties,
  PageProperties,
  TrackResult,
  ProviderFeatures,
  AnalyticsContextValue,
  ServerTrackOptions,
  ServerTrackContext,
} from './types';

// Provider interface
export type { AnalyticsProvider as AnalyticsProviderInterface } from './providers/types';

// React context and hooks (client-side only)
export { AnalyticsProvider, AnalyticsContext } from './analytics-provider';
export {
  useAnalytics,
  useAnalyticsReady,
  useAnalyticsEnabled,
  usePageTracking,
  useTrackEvent,
} from './hooks';

// Client utilities
export {
  getAnalyticsClient,
  initAnalytics,
  isAnalyticsEnabled,
  getAnalyticsProviderName,
} from './client';

// Config utilities
export {
  detectProvider,
  isGA4Configured,
  isPostHogConfigured,
  isPlausibleConfigured,
} from './config';

// Event constants and types (for direct track() + EVENTS pattern)
export { EVENTS } from './events/constants';
export type { EventName } from './events/constants';
export type {
  AuthMethod,
  AuthEventProps,
  SettingsTab,
  SettingsTabEventProps,
  ProfileUpdatedEventProps,
  PreferencesUpdatedEventProps,
  FormSubmittedEventProps,
} from './events/types';

// Form analytics helper (generic form tracking)
export { useFormAnalytics } from './events/forms';
