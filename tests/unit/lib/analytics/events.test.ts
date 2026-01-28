import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { EVENTS } from '@/lib/analytics/events/constants';
import type {
  AuthEventProps,
  SettingsTabEventProps,
  ProfileUpdatedEventProps,
  PreferencesUpdatedEventProps,
} from '@/lib/analytics/events/types';

// Mock the useAnalytics hook
const mockTrack = vi.fn().mockResolvedValue({ success: true });
const mockIdentify = vi.fn().mockResolvedValue({ success: true });
const mockReset = vi.fn().mockResolvedValue({ success: true });

vi.mock('@/lib/analytics/hooks', () => ({
  useAnalytics: vi.fn(() => ({
    track: mockTrack,
    identify: mockIdentify,
    reset: mockReset,
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

  describe('useAuthAnalytics', () => {
    it('should track signup with email method', async () => {
      const { useAuthAnalytics } = await import('@/lib/analytics/events/auth');
      const { result } = renderHook(() => useAuthAnalytics());

      const props: AuthEventProps = { method: 'email' };
      await result.current.trackSignup(props);

      expect(mockTrack).toHaveBeenCalledWith(EVENTS.USER_SIGNED_UP, props);
    });

    it('should track signup with OAuth method and provider', async () => {
      const { useAuthAnalytics } = await import('@/lib/analytics/events/auth');
      const { result } = renderHook(() => useAuthAnalytics());

      const props: AuthEventProps = { method: 'oauth', provider: 'google' };
      await result.current.trackSignup(props);

      expect(mockTrack).toHaveBeenCalledWith(EVENTS.USER_SIGNED_UP, props);
    });

    it('should track login with email method', async () => {
      const { useAuthAnalytics } = await import('@/lib/analytics/events/auth');
      const { result } = renderHook(() => useAuthAnalytics());

      const props: AuthEventProps = { method: 'email' };
      await result.current.trackLogin(props);

      expect(mockTrack).toHaveBeenCalledWith(EVENTS.USER_LOGGED_IN, props);
    });

    it('should track login with OAuth method and provider', async () => {
      const { useAuthAnalytics } = await import('@/lib/analytics/events/auth');
      const { result } = renderHook(() => useAuthAnalytics());

      const props: AuthEventProps = { method: 'oauth', provider: 'facebook' };
      await result.current.trackLogin(props);

      expect(mockTrack).toHaveBeenCalledWith(EVENTS.USER_LOGGED_IN, props);
    });

    it('should track logout', async () => {
      const { useAuthAnalytics } = await import('@/lib/analytics/events/auth');
      const { result } = renderHook(() => useAuthAnalytics());

      await result.current.trackLogout();

      expect(mockTrack).toHaveBeenCalledWith(EVENTS.USER_LOGGED_OUT);
    });

    it('should identify user with traits', async () => {
      const { useAuthAnalytics } = await import('@/lib/analytics/events/auth');
      const { result } = renderHook(() => useAuthAnalytics());

      const userId = 'user-123';
      const traits = { email: 'test@example.com', name: 'Test User' };
      await result.current.identifyUser(userId, traits);

      expect(mockIdentify).toHaveBeenCalledWith(userId, traits);
    });

    it('should reset user on logout', async () => {
      const { useAuthAnalytics } = await import('@/lib/analytics/events/auth');
      const { result } = renderHook(() => useAuthAnalytics());

      await result.current.resetUser();

      expect(mockReset).toHaveBeenCalled();
    });
  });

  describe('useSettingsAnalytics', () => {
    it('should track tab change', async () => {
      const { useSettingsAnalytics } = await import('@/lib/analytics/events/settings');
      const { result } = renderHook(() => useSettingsAnalytics());

      const props: SettingsTabEventProps = { tab: 'security', previous_tab: 'profile' };
      await result.current.trackTabChanged(props);

      expect(mockTrack).toHaveBeenCalledWith(EVENTS.SETTINGS_TAB_CHANGED, props);
    });

    it('should track tab change without previous tab', async () => {
      const { useSettingsAnalytics } = await import('@/lib/analytics/events/settings');
      const { result } = renderHook(() => useSettingsAnalytics());

      const props: SettingsTabEventProps = { tab: 'notifications' };
      await result.current.trackTabChanged(props);

      expect(mockTrack).toHaveBeenCalledWith(EVENTS.SETTINGS_TAB_CHANGED, props);
    });

    it('should track profile update with changed fields', async () => {
      const { useSettingsAnalytics } = await import('@/lib/analytics/events/settings');
      const { result } = renderHook(() => useSettingsAnalytics());

      const props: ProfileUpdatedEventProps = { fields_changed: ['name', 'bio'] };
      await result.current.trackProfileUpdated(props);

      expect(mockTrack).toHaveBeenCalledWith(EVENTS.PROFILE_UPDATED, props);
    });

    it('should track password change', async () => {
      const { useSettingsAnalytics } = await import('@/lib/analytics/events/settings');
      const { result } = renderHook(() => useSettingsAnalytics());

      await result.current.trackPasswordChanged();

      expect(mockTrack).toHaveBeenCalledWith(EVENTS.PASSWORD_CHANGED);
    });

    it('should track preferences update', async () => {
      const { useSettingsAnalytics } = await import('@/lib/analytics/events/settings');
      const { result } = renderHook(() => useSettingsAnalytics());

      const props: PreferencesUpdatedEventProps = { marketing: true, product_updates: false };
      await result.current.trackPreferencesUpdated(props);

      expect(mockTrack).toHaveBeenCalledWith(EVENTS.PREFERENCES_UPDATED, props);
    });

    it('should track avatar upload', async () => {
      const { useSettingsAnalytics } = await import('@/lib/analytics/events/settings');
      const { result } = renderHook(() => useSettingsAnalytics());

      await result.current.trackAvatarUploaded();

      expect(mockTrack).toHaveBeenCalledWith(EVENTS.AVATAR_UPLOADED);
    });

    it('should track account deletion', async () => {
      const { useSettingsAnalytics } = await import('@/lib/analytics/events/settings');
      const { result } = renderHook(() => useSettingsAnalytics());

      await result.current.trackAccountDeleted();

      expect(mockTrack).toHaveBeenCalledWith(EVENTS.ACCOUNT_DELETED);
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
      const { useAuthAnalytics } = await import('@/lib/analytics/events/auth');
      const { result, rerender } = renderHook(() => useAuthAnalytics());

      const firstTrackLogin = result.current.trackLogin;
      const firstIdentifyUser = result.current.identifyUser;

      rerender();

      expect(result.current.trackLogin).toBe(firstTrackLogin);
      expect(result.current.identifyUser).toBe(firstIdentifyUser);
    });
  });
});
