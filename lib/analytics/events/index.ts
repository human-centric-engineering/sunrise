/**
 * Analytics Event Constants and Types
 *
 * Centralized event definitions for type-safe analytics tracking.
 *
 * This module provides:
 * - Event name constants (EVENTS)
 * - Type definitions for event properties
 * - Generic form tracking helper (useFormAnalytics)
 *
 * Phase 4.5: Analytics Integration
 *
 * @see .context/analytics/overview.md for event catalog and best practices
 *
 * @example Direct event tracking (recommended pattern)
 * ```tsx
 * import { useAnalytics, EVENTS } from '@/lib/analytics';
 *
 * function LoginForm() {
 *   const { track, identify } = useAnalytics();
 *
 *   const onSuccess = async (user: User) => {
 *     await identify(user.id);
 *     await track(EVENTS.USER_LOGGED_IN, { method: 'email' });
 *   };
 * }
 * ```
 *
 * @example Form tracking (generic - works with any form)
 * ```tsx
 * import { useFormAnalytics } from '@/lib/analytics/events';
 *
 * function ContactForm() {
 *   const { trackFormSubmitted } = useFormAnalytics();
 *
 *   const onSubmit = async () => {
 *     await sendMessage(data);
 *     // Tracks: contact_form_submitted
 *     await trackFormSubmitted('contact');
 *   };
 * }
 * ```
 */

// Constants
export { EVENTS, type EventName } from './constants';

// Types
export type {
  AuthMethod,
  AuthEventProps,
  SettingsTab,
  SettingsTabEventProps,
  ProfileUpdatedEventProps,
  PreferencesUpdatedEventProps,
  FormSubmittedEventProps,
  IdentifyTraits,
} from './types';

// Generic form tracking hook
export { useFormAnalytics } from './forms';
