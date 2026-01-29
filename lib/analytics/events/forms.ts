'use client';

/**
 * Form Analytics Helpers
 *
 * Generic form tracking hook for any form submission.
 * Uses a consistent naming convention: `{formName}_form_submitted`
 *
 * Phase 4.5: Analytics Integration
 *
 * @example
 * ```tsx
 * import { useFormAnalytics } from '@/lib/analytics/events';
 *
 * function ContactForm() {
 *   const { trackFormSubmitted } = useFormAnalytics();
 *
 *   const onSubmit = async (data: FormData) => {
 *     await submitForm(data);
 *     // Tracks: contact_form_submitted
 *     await trackFormSubmitted('contact');
 *   };
 * }
 *
 * function FeedbackForm() {
 *   const { trackFormSubmitted } = useFormAnalytics();
 *
 *   const onSubmit = async (data: FormData) => {
 *     await submitForm(data);
 *     // Tracks: feedback_form_submitted { source: 'footer', rating: 5 }
 *     await trackFormSubmitted('feedback', { source: 'footer', rating: 5 });
 *   };
 * }
 * ```
 */

import { useCallback } from 'react';
import { useAnalytics } from '../hooks';
import type { TrackResult } from '../types';
import type { FormSubmittedEventProps } from './types';

/**
 * Hook for form analytics events
 *
 * Provides a generic `trackFormSubmitted()` helper that works with any form.
 * No need to modify the analytics library to track new forms.
 *
 * @example Track contact form
 * ```tsx
 * const { trackFormSubmitted } = useFormAnalytics();
 * await trackFormSubmitted('contact');
 * // → tracks: contact_form_submitted
 * ```
 *
 * @example Track with properties
 * ```tsx
 * const { trackFormSubmitted } = useFormAnalytics();
 * await trackFormSubmitted('feedback', { source: 'footer', rating: 5 });
 * // → tracks: feedback_form_submitted { source: 'footer', rating: 5 }
 * ```
 */
export function useFormAnalytics() {
  const { track } = useAnalytics();

  /**
   * Track any form submission with consistent naming
   *
   * Automatically formats the event name as `{formName}_form_submitted`.
   *
   * @param formName - Short identifier for the form (e.g., 'contact', 'feedback', 'support')
   * @param properties - Optional additional properties to track
   *
   * @example
   * ```tsx
   * // Basic
   * await trackFormSubmitted('contact');
   * // → tracks: contact_form_submitted
   *
   * // With properties
   * await trackFormSubmitted('feedback', { source: 'footer' });
   * // → tracks: feedback_form_submitted { source: 'footer' }
   *
   * // Form names are normalized (lowercase, spaces/hyphens → underscores)
   * await trackFormSubmitted('Bug Report');
   * // → tracks: bug_report_form_submitted
   * ```
   */
  const trackFormSubmitted = useCallback(
    (formName: string, properties?: FormSubmittedEventProps): Promise<TrackResult> => {
      // Normalize form name: lowercase, replace spaces/hyphens with underscores
      const normalizedName = formName.toLowerCase().replace(/[\s-]+/g, '_');
      const eventName = `${normalizedName}_form_submitted`;
      return track(eventName, properties);
    },
    [track]
  );

  return {
    trackFormSubmitted,
  };
}
