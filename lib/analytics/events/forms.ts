'use client';

/**
 * Form Analytics Helpers
 *
 * Hooks and functions for tracking form-related events.
 *
 * Phase 4.5: Analytics Integration
 *
 * @example
 * ```tsx
 * import { useFormAnalytics } from '@/lib/analytics/events';
 *
 * function ContactForm() {
 *   const { trackContactFormSubmitted } = useFormAnalytics();
 *
 *   const onSubmit = async (data: FormData) => {
 *     await submitForm(data);
 *     await trackContactFormSubmitted();
 *   };
 * }
 * ```
 */

import { useCallback } from 'react';
import { useAnalytics } from '../hooks';
import { EVENTS } from './constants';
import type { TrackResult } from '../types';

/**
 * Hook for form analytics events
 *
 * Provides type-safe helpers for tracking form submissions
 * including contact forms, invitations, and password resets.
 *
 * @example Track contact form submission
 * ```tsx
 * const { trackContactFormSubmitted } = useFormAnalytics();
 *
 * const handleSubmit = async () => {
 *   await submitContactForm(data);
 *   await trackContactFormSubmitted();
 * };
 * ```
 *
 * @example Track invite acceptance
 * ```tsx
 * const { trackInviteAccepted } = useFormAnalytics();
 *
 * const handleAccept = async () => {
 *   await acceptInvite(token);
 *   await trackInviteAccepted();
 * };
 * ```
 */
export function useFormAnalytics() {
  const { track } = useAnalytics();

  /**
   * Track contact form submission
   */
  const trackContactFormSubmitted = useCallback((): Promise<TrackResult> => {
    return track(EVENTS.CONTACT_FORM_SUBMITTED);
  }, [track]);

  /**
   * Track invitation acceptance
   */
  const trackInviteAccepted = useCallback((): Promise<TrackResult> => {
    return track(EVENTS.INVITE_ACCEPTED);
  }, [track]);

  /**
   * Track password reset request
   */
  const trackPasswordResetRequested = useCallback((): Promise<TrackResult> => {
    return track(EVENTS.PASSWORD_RESET_REQUESTED);
  }, [track]);

  return {
    trackContactFormSubmitted,
    trackInviteAccepted,
    trackPasswordResetRequested,
  };
}
