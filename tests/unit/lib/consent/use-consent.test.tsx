/**
 * useConsent Hooks Tests
 *
 * Tests the custom hooks for accessing consent context:
 * - useConsent() - Full context access
 * - useHasOptionalConsent() - Boolean check for optional consent
 * - useShouldShowConsentBanner() - Banner visibility logic
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/lib/consent/use-consent.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { CONSENT_STORAGE_KEY, CONSENT_VERSION } from '@/lib/consent/config';

// Mock isConsentEnabled from config
const mockIsConsentEnabled = vi.fn();
vi.mock('@/lib/consent/config', async () => {
  const actual = await vi.importActual('@/lib/consent/config');
  return {
    ...actual,
    isConsentEnabled: () => mockIsConsentEnabled(),
  };
});

/**
 * Test Suite: useConsent Hooks
 */
describe('lib/consent/use-consent', () => {
  // Mock localStorage
  let mockLocalStorage: Record<string, string> = {};

  // Dynamic module references (reset each test via vi.resetModules)
  let useConsent: typeof import('@/lib/consent/use-consent').useConsent;
  let useHasOptionalConsent: typeof import('@/lib/consent/use-consent').useHasOptionalConsent;
  let useShouldShowConsentBanner: typeof import('@/lib/consent/use-consent').useShouldShowConsentBanner;
  let ConsentProvider: typeof import('@/lib/consent/consent-provider').ConsentProvider;

  function createWrapper() {
    return function Wrapper({ children }: { children: ReactNode }) {
      return <ConsentProvider>{children}</ConsentProvider>;
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules(); // Reset module-level cachedSnapshot in consent-provider
    mockLocalStorage = {};
    mockIsConsentEnabled.mockReturnValue(true);

    // Mock localStorage
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => mockLocalStorage[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        mockLocalStorage[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete mockLocalStorage[key];
      }),
      clear: vi.fn(() => {
        mockLocalStorage = {};
      }),
    });

    // Dynamically import fresh modules (cachedSnapshot is reset)
    const consentHooks = await import('@/lib/consent/use-consent');
    useConsent = consentHooks.useConsent;
    useHasOptionalConsent = consentHooks.useHasOptionalConsent;
    useShouldShowConsentBanner = consentHooks.useShouldShowConsentBanner;

    const providerModule = await import('@/lib/consent/consent-provider');
    ConsentProvider = providerModule.ConsentProvider;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('useConsent()', () => {
    it('should return context values when used inside ConsentProvider', () => {
      const { result } = renderHook(() => useConsent(), {
        wrapper: createWrapper(),
      });

      expect(result.current).toBeDefined();
      expect(result.current).not.toBe(undefined);
    });

    it('should have all expected properties', () => {
      const { result } = renderHook(() => useConsent(), {
        wrapper: createWrapper(),
      });

      expect(result.current).toHaveProperty('consent');
      expect(result.current).toHaveProperty('hasConsented');
      expect(result.current).toHaveProperty('isInitialized');
      expect(result.current).toHaveProperty('acceptAll');
      expect(result.current).toHaveProperty('rejectOptional');
      expect(result.current).toHaveProperty('updateConsent');
      expect(result.current).toHaveProperty('resetConsent');
      expect(result.current).toHaveProperty('openPreferences');
      expect(result.current).toHaveProperty('closePreferences');
      expect(result.current).toHaveProperty('isPreferencesOpen');
    });

    it('should provide functions for all action methods', () => {
      const { result } = renderHook(() => useConsent(), {
        wrapper: createWrapper(),
      });

      expect(typeof result.current.acceptAll).toBe('function');
      expect(typeof result.current.rejectOptional).toBe('function');
      expect(typeof result.current.updateConsent).toBe('function');
      expect(typeof result.current.resetConsent).toBe('function');
      expect(typeof result.current.openPreferences).toBe('function');
      expect(typeof result.current.closePreferences).toBe('function');
    });

    it('should throw error when used outside ConsentProvider', () => {
      expect(() => {
        renderHook(() => useConsent());
      }).toThrow('useConsent must be used within a ConsentProvider');
    });

    it('should provide default consent state when no stored consent', () => {
      const { result } = renderHook(() => useConsent(), {
        wrapper: createWrapper(),
      });

      expect(result.current.consent.essential).toBe(true);
      expect(result.current.consent.optional).toBe(false);
      expect(result.current.consent.timestamp).toBeNull();
      expect(result.current.consent.version).toBe(CONSENT_VERSION);
    });

    it('should provide consent state from localStorage on mount', () => {
      // Pre-seed consent in localStorage BEFORE module import reads it
      mockLocalStorage[CONSENT_STORAGE_KEY] = JSON.stringify({
        essential: true,
        optional: true,
        timestamp: Date.now(),
        version: CONSENT_VERSION,
      });

      const { result } = renderHook(() => useConsent(), {
        wrapper: createWrapper(),
      });

      expect(result.current.consent.essential).toBe(true);
      expect(result.current.consent.optional).toBe(true);
      expect(result.current.hasConsented).toBe(true);
    });
  });

  describe('useHasOptionalConsent()', () => {
    it('should return false when user has not consented', () => {
      const { result } = renderHook(() => useHasOptionalConsent(), {
        wrapper: createWrapper(),
      });

      expect(result.current).toBe(false);
    });

    it('should return true when user has consented and optional is true', () => {
      mockLocalStorage[CONSENT_STORAGE_KEY] = JSON.stringify({
        essential: true,
        optional: true,
        timestamp: Date.now(),
        version: CONSENT_VERSION,
      });

      const { result } = renderHook(() => useHasOptionalConsent(), {
        wrapper: createWrapper(),
      });

      expect(result.current).toBe(true);
    });

    it('should return false when user consented but optional is false', () => {
      mockLocalStorage[CONSENT_STORAGE_KEY] = JSON.stringify({
        essential: true,
        optional: false,
        timestamp: Date.now(),
        version: CONSENT_VERSION,
      });

      const { result } = renderHook(() => useHasOptionalConsent(), {
        wrapper: createWrapper(),
      });

      expect(result.current).toBe(false);
    });

    it('should return true when consent is disabled', () => {
      mockIsConsentEnabled.mockReturnValue(false);

      const { result } = renderHook(() => useHasOptionalConsent(), {
        wrapper: createWrapper(),
      });

      expect(result.current).toBe(true);
    });

    it('should return false when user has not made a choice', () => {
      const { result } = renderHook(() => useHasOptionalConsent(), {
        wrapper: createWrapper(),
      });

      expect(result.current).toBe(false);
    });

    it('should update when acceptAll is called', () => {
      const { result } = renderHook(
        () => ({
          hasOptional: useHasOptionalConsent(),
          context: useConsent(),
        }),
        { wrapper: createWrapper() }
      );

      // Initially false
      expect(result.current.hasOptional).toBe(false);

      // Accept all
      act(() => {
        result.current.context.acceptAll();
      });

      // Now true
      expect(result.current.hasOptional).toBe(true);
    });
  });

  describe('useShouldShowConsentBanner()', () => {
    it('should return a boolean', () => {
      const { result } = renderHook(() => useShouldShowConsentBanner(), {
        wrapper: createWrapper(),
      });

      expect(typeof result.current).toBe('boolean');
    });

    it('should return false when user has already consented', () => {
      mockLocalStorage[CONSENT_STORAGE_KEY] = JSON.stringify({
        essential: true,
        optional: true,
        timestamp: Date.now(),
        version: CONSENT_VERSION,
      });

      const { result } = renderHook(() => useShouldShowConsentBanner(), {
        wrapper: createWrapper(),
      });

      expect(result.current).toBe(false);
    });

    it('should return false when consent system is disabled', () => {
      mockIsConsentEnabled.mockReturnValue(false);

      const { result } = renderHook(() => useShouldShowConsentBanner(), {
        wrapper: createWrapper(),
      });

      expect(result.current).toBe(false);
    });

    it('should be based on isInitialized and hasConsented flags', () => {
      const { result } = renderHook(
        () => ({
          shouldShow: useShouldShowConsentBanner(),
          context: useConsent(),
        }),
        { wrapper: createWrapper() }
      );

      const expectedValue =
        result.current.context.isInitialized && !result.current.context.hasConsented;
      expect(result.current.shouldShow).toBe(expectedValue);
    });

    it('should return false after user consents via rejectOptional', () => {
      mockLocalStorage[CONSENT_STORAGE_KEY] = JSON.stringify({
        essential: true,
        optional: false,
        timestamp: Date.now(),
        version: CONSENT_VERSION,
      });

      const { result } = renderHook(
        () => ({
          shouldShow: useShouldShowConsentBanner(),
          context: useConsent(),
        }),
        { wrapper: createWrapper() }
      );

      expect(result.current.context.hasConsented).toBe(true);
      expect(result.current.shouldShow).toBe(false);
    });

    it('should hide after acceptAll is called', () => {
      const { result } = renderHook(
        () => ({
          shouldShow: useShouldShowConsentBanner(),
          context: useConsent(),
        }),
        { wrapper: createWrapper() }
      );

      // Initially showing (no consent, but initialized)
      const initialExpected =
        result.current.context.isInitialized && !result.current.context.hasConsented;
      expect(result.current.shouldShow).toBe(initialExpected);

      // Accept all
      act(() => {
        result.current.context.acceptAll();
      });

      // Now hidden
      expect(result.current.shouldShow).toBe(false);
    });
  });

  describe('hook integration with ConsentProvider', () => {
    it('should all hooks read from the same consent context', () => {
      const { result } = renderHook(
        () => ({
          consent: useConsent(),
          hasOptional: useHasOptionalConsent(),
          shouldShowBanner: useShouldShowConsentBanner(),
        }),
        { wrapper: createWrapper() }
      );

      // hasOptionalConsent should match consent.optional && hasConsented
      const expectedOptional =
        result.current.consent.hasConsented && result.current.consent.consent.optional;
      expect(result.current.hasOptional).toBe(expectedOptional);

      // shouldShowBanner should match isInitialized && !hasConsented
      const expectedBanner =
        result.current.consent.isInitialized && !result.current.consent.hasConsented;
      expect(result.current.shouldShowBanner).toBe(expectedBanner);
    });

    it('should all hooks reflect consent state from localStorage', () => {
      mockLocalStorage[CONSENT_STORAGE_KEY] = JSON.stringify({
        essential: true,
        optional: true,
        timestamp: Date.now(),
        version: CONSENT_VERSION,
      });

      const { result } = renderHook(
        () => ({
          consent: useConsent(),
          hasOptional: useHasOptionalConsent(),
          shouldShowBanner: useShouldShowConsentBanner(),
        }),
        { wrapper: createWrapper() }
      );

      expect(result.current.consent.hasConsented).toBe(true);
      expect(result.current.consent.consent.optional).toBe(true);
      expect(result.current.hasOptional).toBe(true);
      expect(result.current.shouldShowBanner).toBe(false);
    });

    it('should all hooks update reactively after acceptAll', () => {
      const { result } = renderHook(
        () => ({
          consent: useConsent(),
          hasOptional: useHasOptionalConsent(),
          shouldShowBanner: useShouldShowConsentBanner(),
        }),
        { wrapper: createWrapper() }
      );

      // Before
      expect(result.current.hasOptional).toBe(false);

      // Accept
      act(() => {
        result.current.consent.acceptAll();
      });

      // After
      expect(result.current.consent.hasConsented).toBe(true);
      expect(result.current.consent.consent.optional).toBe(true);
      expect(result.current.hasOptional).toBe(true);
      expect(result.current.shouldShowBanner).toBe(false);
    });
  });

  describe('error handling', () => {
    it('useConsent should provide clear error message outside provider', () => {
      let errorMessage = '';
      try {
        renderHook(() => useConsent());
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      expect(errorMessage).toContain('useConsent must be used within a ConsentProvider');
    });

    it('useHasOptionalConsent should throw error when used outside provider', () => {
      expect(() => {
        renderHook(() => useHasOptionalConsent());
      }).toThrow('useConsent must be used within a ConsentProvider');
    });

    it('useShouldShowConsentBanner should throw error when used outside provider', () => {
      expect(() => {
        renderHook(() => useShouldShowConsentBanner());
      }).toThrow('useConsent must be used within a ConsentProvider');
    });
  });

  describe('disabled mode behavior', () => {
    it('useHasOptionalConsent should return true when consent is disabled', () => {
      mockIsConsentEnabled.mockReturnValue(false);

      const { result } = renderHook(() => useHasOptionalConsent(), {
        wrapper: createWrapper(),
      });

      expect(result.current).toBe(true);
    });

    it('useShouldShowConsentBanner should return false when consent is disabled', () => {
      mockIsConsentEnabled.mockReturnValue(false);

      const { result } = renderHook(() => useShouldShowConsentBanner(), {
        wrapper: createWrapper(),
      });

      expect(result.current).toBe(false);
    });

    it('all hooks should indicate consent granted when system is disabled', () => {
      mockIsConsentEnabled.mockReturnValue(false);

      const { result } = renderHook(
        () => ({
          consent: useConsent(),
          hasOptional: useHasOptionalConsent(),
          shouldShowBanner: useShouldShowConsentBanner(),
        }),
        { wrapper: createWrapper() }
      );

      expect(result.current.consent.hasConsented).toBe(true);
      expect(result.current.consent.consent.optional).toBe(true);
      expect(result.current.hasOptional).toBe(true);
      expect(result.current.shouldShowBanner).toBe(false);
    });
  });
});
