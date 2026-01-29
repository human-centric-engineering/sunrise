import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { EVENTS } from '@/lib/analytics/events/constants';

// Mock the useAnalytics hook
const mockTrack = vi.fn().mockResolvedValue({ success: true });

vi.mock('@/lib/analytics/hooks', () => ({
  useAnalytics: vi.fn(() => ({
    track: mockTrack,
    identify: vi.fn().mockResolvedValue({ success: true }),
    reset: vi.fn().mockResolvedValue({ success: true }),
    page: vi.fn().mockResolvedValue({ success: true }),
    isReady: true,
    isEnabled: true,
    providerName: 'Console',
  })),
}));

describe('lib/analytics/events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('EVENTS constants', () => {
    it('should define all authentication events', () => {
      expect(EVENTS.USER_SIGNED_UP).toBe('user_signed_up');
      expect(EVENTS.USER_LOGGED_IN).toBe('user_logged_in');
      expect(EVENTS.USER_LOGGED_OUT).toBe('user_logged_out');
    });

    it('should define all settings events', () => {
      expect(EVENTS.SETTINGS_TAB_CHANGED).toBe('settings_tab_changed');
      expect(EVENTS.PROFILE_UPDATED).toBe('profile_updated');
      expect(EVENTS.PASSWORD_CHANGED).toBe('password_changed');
      expect(EVENTS.PREFERENCES_UPDATED).toBe('preferences_updated');
      expect(EVENTS.AVATAR_UPLOADED).toBe('avatar_uploaded');
      expect(EVENTS.ACCOUNT_DELETED).toBe('account_deleted');
    });

    it('should use snake_case for all event names', () => {
      const eventNames = Object.values(EVENTS);
      eventNames.forEach((name) => {
        // Check for snake_case format
        expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/);
      });
    });

    it('should use past tense or action completed for event names', () => {
      // Verify events indicate completed actions (past tense patterns)
      // Note: Form events use generic trackFormSubmitted() which generates names dynamically
      const expectedPastTensePatterns = [
        'signed_up',
        'logged_in',
        'logged_out', // Auth
        'changed',
        'updated',
        'uploaded',
        'deleted', // Settings
      ];
      const eventNames = Object.values(EVENTS);

      eventNames.forEach((name) => {
        const hasPastTense = expectedPastTensePatterns.some((pattern) => name.includes(pattern));
        expect(hasPastTense).toBe(true);
      });
    });
  });

  describe('useFormAnalytics', () => {
    it('should track form submission with correct event name format', async () => {
      const { useFormAnalytics } = await import('@/lib/analytics/events/forms');
      const { result } = renderHook(() => useFormAnalytics());

      await result.current.trackFormSubmitted('contact');

      expect(mockTrack).toHaveBeenCalledWith('contact_form_submitted', undefined);
    });

    it('should track form submission with properties', async () => {
      const { useFormAnalytics } = await import('@/lib/analytics/events/forms');
      const { result } = renderHook(() => useFormAnalytics());

      await result.current.trackFormSubmitted('feedback', { source: 'footer', rating: 5 });

      expect(mockTrack).toHaveBeenCalledWith('feedback_form_submitted', {
        source: 'footer',
        rating: 5,
      });
    });

    it('should normalize form name to lowercase', async () => {
      const { useFormAnalytics } = await import('@/lib/analytics/events/forms');
      const { result } = renderHook(() => useFormAnalytics());

      await result.current.trackFormSubmitted('Support');

      expect(mockTrack).toHaveBeenCalledWith('support_form_submitted', undefined);
    });

    it('should convert spaces to underscores in form name', async () => {
      const { useFormAnalytics } = await import('@/lib/analytics/events/forms');
      const { result } = renderHook(() => useFormAnalytics());

      await result.current.trackFormSubmitted('bug report');

      expect(mockTrack).toHaveBeenCalledWith('bug_report_form_submitted', undefined);
    });

    it('should convert hyphens to underscores in form name', async () => {
      const { useFormAnalytics } = await import('@/lib/analytics/events/forms');
      const { result } = renderHook(() => useFormAnalytics());

      await result.current.trackFormSubmitted('password-reset');

      expect(mockTrack).toHaveBeenCalledWith('password_reset_form_submitted', undefined);
    });

    it('should handle mixed case, spaces, and hyphens', async () => {
      const { useFormAnalytics } = await import('@/lib/analytics/events/forms');
      const { result } = renderHook(() => useFormAnalytics());

      await result.current.trackFormSubmitted('User Sign-Up');

      expect(mockTrack).toHaveBeenCalledWith('user_sign_up_form_submitted', undefined);
    });
  });

  describe('hook stability', () => {
    it('should return stable callbacks across renders', async () => {
      const { useFormAnalytics } = await import('@/lib/analytics/events/forms');
      const { result, rerender } = renderHook(() => useFormAnalytics());

      const firstTrackFormSubmitted = result.current.trackFormSubmitted;

      rerender();

      expect(result.current.trackFormSubmitted).toBe(firstTrackFormSubmitted);
    });
  });
});
