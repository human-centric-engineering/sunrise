/**
 * Analytics Event Helpers
 *
 * Centralized event tracking helpers for type-safe analytics.
 *
 * This module provides:
 * - Event name constants (EVENTS)
 * - Type definitions for event properties
 * - Domain-specific hooks (useAuthAnalytics, useSettingsAnalytics, useFormAnalytics)
 *
 * Phase 4.5: Analytics Integration
 *
 * @see .context/analytics/overview.md for event catalog and best practices
 *
 * @example Authentication tracking (GDPR-compliant)
 * ```tsx
 * import { useAuthAnalytics } from '@/lib/analytics/events';
 *
 * function LoginForm() {
 *   const { trackLogin, identifyUser } = useAuthAnalytics();
 *
 *   const onSuccess = async (user: User) => {
 *     // Only send user ID by default (no PII)
 *     await identifyUser(user.id);
 *     await trackLogin({ method: 'email' });
 *   };
 * }
 * ```
 *
 * @example Settings tracking
 * ```tsx
 * import { useSettingsAnalytics } from '@/lib/analytics/events';
 *
 * function SettingsTabs() {
 *   const { trackTabChanged } = useSettingsAnalytics();
 *
 *   const handleTabChange = (newTab: SettingsTab) => {
 *     trackTabChanged({ tab: newTab, previous_tab: currentTab });
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
 *
 * function FeedbackForm() {
 *   const { trackFormSubmitted } = useFormAnalytics();
 *
 *   const onSubmit = async () => {
 *     await submitFeedback(data);
 *     // Tracks: feedback_form_submitted { source: 'footer' }
 *     await trackFormSubmitted('feedback', { source: 'footer' });
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

// Hooks
export { useAuthAnalytics } from './auth';
export { useSettingsAnalytics } from './settings';
export { useFormAnalytics } from './forms';
