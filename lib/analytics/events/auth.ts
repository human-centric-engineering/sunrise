'use client';

/**
 * Authentication Analytics Helpers
 *
 * Hooks and functions for tracking authentication-related events.
 *
 * Phase 4.5: Analytics Integration
 *
 * @example
 * ```tsx
 * import { useAuthAnalytics } from '@/lib/analytics/events';
 *
 * function LoginForm() {
 *   const { trackLogin, identifyUser } = useAuthAnalytics();
 *
 *   const onSuccess = async (user: User) => {
 *     // GDPR: Only send user ID by default (no PII)
 *     await identifyUser(user.id);
 *     await trackLogin({ method: 'email' });
 *   };
 * }
 * ```
 */

import { useCallback } from 'react';
import { useAnalytics } from '../hooks';
import { EVENTS } from './constants';
import type { AuthEventProps, IdentifyTraits } from './types';
import type { TrackResult } from '../types';

/**
 * Hook for authentication analytics events
 *
 * Provides type-safe helpers for tracking login, signup, logout,
 * and user identification.
 *
 * @example Track email login (GDPR-compliant, no PII)
 * ```tsx
 * const { trackLogin, identifyUser } = useAuthAnalytics();
 *
 * const handleLogin = async (user: User) => {
 *   await identifyUser(user.id);
 *   await trackLogin({ method: 'email' });
 * };
 * ```
 *
 * @example Track login with optional traits (if your privacy policy allows)
 * ```tsx
 * await identifyUser(user.id, { email: user.email, name: user.name });
 * ```
 *
 * @example Track OAuth login
 * ```tsx
 * const { trackLogin } = useAuthAnalytics();
 *
 * // Works with any OAuth provider
 * await trackLogin({ method: 'oauth', provider: 'google' });
 * await trackLogin({ method: 'oauth', provider: 'facebook' });
 * ```
 *
 * @example Track logout
 * ```tsx
 * const { trackLogout, resetUser } = useAuthAnalytics();
 *
 * const handleLogout = async () => {
 *   await trackLogout();
 *   await resetUser();
 * };
 * ```
 */
export function useAuthAnalytics() {
  const { track, identify, reset } = useAnalytics();

  /**
   * Track user signup event
   *
   * @param props - Authentication properties (method, optional provider)
   */
  const trackSignup = useCallback(
    (props: AuthEventProps): Promise<TrackResult> => {
      return track(EVENTS.USER_SIGNED_UP, props);
    },
    [track]
  );

  /**
   * Track user login event
   *
   * @param props - Authentication properties (method, optional provider)
   */
  const trackLogin = useCallback(
    (props: AuthEventProps): Promise<TrackResult> => {
      return track(EVENTS.USER_LOGGED_IN, props);
    },
    [track]
  );

  /**
   * Track user logout event
   */
  const trackLogout = useCallback((): Promise<TrackResult> => {
    return track(EVENTS.USER_LOGGED_OUT);
  }, [track]);

  /**
   * Identify user after login/signup
   *
   * @param userId - Unique user identifier
   * @param traits - User traits (email, name, etc.)
   */
  const identifyUser = useCallback(
    (userId: string, traits?: IdentifyTraits): Promise<TrackResult> => {
      return identify(userId, traits);
    },
    [identify]
  );

  /**
   * Reset user identity (call on logout)
   */
  const resetUser = useCallback((): Promise<TrackResult> => {
    return reset();
  }, [reset]);

  return {
    trackSignup,
    trackLogin,
    trackLogout,
    identifyUser,
    resetUser,
  };
}
