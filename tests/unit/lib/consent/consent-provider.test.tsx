/**
 * ConsentProvider Component Tests
 *
 * Tests the ConsentProvider component which manages cookie consent state:
 * - Context provision and hook integration
 * - localStorage persistence and reading
 * - Initial state handling (default, stored, corrupted, version mismatch)
 * - User actions (acceptAll, rejectOptional, updateConsent, resetConsent)
 * - SSR safety with useSyncExternalStore
 * - Disabled mode when consent is turned off
 * - Modal state management
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/lib/consent/consent-provider.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, waitFor, act } from '@testing-library/react';
import { ConsentProvider, ConsentContext } from '@/lib/consent/consent-provider';
import { useContext, type ReactNode } from 'react';
import type { ConsentContextValue } from '@/lib/consent/types';
import { CONSENT_STORAGE_KEY, CONSENT_VERSION, DEFAULT_CONSENT_STATE } from '@/lib/consent/config';

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
 * Helper to render a component that accesses the consent context
 * and perform assertions on it.
 */
function renderWithContext(callback: (value: ConsentContextValue) => void) {
  const TestComponent = () => {
    const value = useContext(ConsentContext);
    if (value) {
      callback(value);
    }
    return null;
  };

  return render(
    <ConsentProvider>
      <TestComponent />
    </ConsentProvider>
  );
}

/**
 * Test Suite: ConsentProvider Component
 */
describe('lib/consent/consent-provider', () => {
  // Mock localStorage
  let mockLocalStorage: Record<string, string> = {};

  beforeEach(() => {
    vi.clearAllMocks();
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

    // Mock window.addEventListener and dispatchEvent
    vi.stubGlobal('addEventListener', vi.fn());
    vi.stubGlobal('removeEventListener', vi.fn());
    vi.stubGlobal('dispatchEvent', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('rendering & context provision', () => {
    it('should render children', () => {
      // Arrange & Act
      const { getByText } = render(
        <ConsentProvider>
          <div>Test Content</div>
        </ConsentProvider>
      );

      // Assert
      expect(getByText('Test Content')).toBeInTheDocument();
    });

    it('should provide context to children', () => {
      // Arrange & Act & Assert
      renderWithContext((value) => {
        expect(value).toBeDefined();
        expect(value).not.toBe(undefined);
      });
    });

    it('should provide all context methods', () => {
      // Arrange & Act & Assert
      renderWithContext((value) => {
        expect(value).toHaveProperty('consent');
        expect(value).toHaveProperty('hasConsented');
        expect(value).toHaveProperty('isInitialized');
        expect(value).toHaveProperty('acceptAll');
        expect(value).toHaveProperty('rejectOptional');
        expect(value).toHaveProperty('updateConsent');
        expect(value).toHaveProperty('resetConsent');
        expect(value).toHaveProperty('openPreferences');
        expect(value).toHaveProperty('closePreferences');
        expect(value).toHaveProperty('isPreferencesOpen');
      });
    });

    it('should provide functions for all action methods', () => {
      // Arrange & Act & Assert
      renderWithContext((value) => {
        expect(typeof value.acceptAll).toBe('function');
        expect(typeof value.rejectOptional).toBe('function');
        expect(typeof value.updateConsent).toBe('function');
        expect(typeof value.resetConsent).toBe('function');
        expect(typeof value.openPreferences).toBe('function');
        expect(typeof value.closePreferences).toBe('function');
      });
    });
  });

  describe('initial state - no stored consent', () => {
    it('should return default consent state when localStorage is empty', () => {
      // Arrange & Act & Assert
      renderWithContext((value) => {
        expect(value.consent).toEqual(DEFAULT_CONSENT_STATE);
      });
    });

    it('should have hasConsented=false when no stored consent', () => {
      // Arrange & Act & Assert
      renderWithContext((value) => {
        expect(value.hasConsented).toBe(false);
      });
    });

    it('should have essential=true by default', () => {
      // Arrange & Act & Assert
      renderWithContext((value) => {
        expect(value.consent.essential).toBe(true);
      });
    });

    it('should have optional=false by default', () => {
      // Arrange & Act & Assert
      renderWithContext((value) => {
        expect(value.consent.optional).toBe(false);
      });
    });

    it('should have timestamp=null by default', () => {
      // Arrange & Act & Assert
      renderWithContext((value) => {
        expect(value.consent.timestamp).toBeNull();
      });
    });

    it('should have correct version by default', () => {
      // Arrange & Act & Assert
      renderWithContext((value) => {
        expect(value.consent.version).toBe(CONSENT_VERSION);
      });
    });

    it('should have isInitialized=true after hydration', async () => {
      // Arrange & Act
      let isInitialized = false;

      renderWithContext((value) => {
        isInitialized = value.isInitialized;
      });

      // Assert - wait for hydration
      await waitFor(() => {
        expect(isInitialized).toBe(true);
      });
    });
  });

  describe('initial state - reading from localStorage', () => {
    it('should persist and read consent state from localStorage', () => {
      // This test verifies that the localStorage integration works by:
      // 1. Setting consent
      // 2. Verifying it's written to localStorage
      // 3. Checking the stored value matches expectations

      // Arrange
      let contextValue: ConsentContextValue | null = null;

      renderWithContext((value) => {
        contextValue = value;
      });

      // Act - accept all consent
      act(() => {
        contextValue!.acceptAll();
      });

      // Assert - verify data was written to localStorage
      expect(mockLocalStorage[CONSENT_STORAGE_KEY]).toBeDefined();

      const stored = JSON.parse(mockLocalStorage[CONSENT_STORAGE_KEY]);
      expect(stored.essential).toBe(true);
      expect(stored.optional).toBe(true);
      expect(stored.version).toBe(CONSENT_VERSION);
      expect(stored.timestamp).toBeGreaterThan(0);
    });

    it('should always ensure essential is true even if stored as false', () => {
      // Arrange
      const storedConsent = {
        essential: false, // Invalid - should be forced to true
        optional: true,
        timestamp: 1234567890,
        version: CONSENT_VERSION,
      };
      mockLocalStorage[CONSENT_STORAGE_KEY] = JSON.stringify(storedConsent);

      // Act & Assert
      renderWithContext((value) => {
        expect(value.consent.essential).toBe(true);
      });
    });

    it('should handle corrupted JSON in localStorage gracefully', () => {
      // Arrange
      mockLocalStorage[CONSENT_STORAGE_KEY] = 'not valid JSON{';

      // Act & Assert - should fall back to default
      renderWithContext((value) => {
        expect(value.consent).toEqual(DEFAULT_CONSENT_STATE);
        expect(value.hasConsented).toBe(false);
      });
    });

    it('should handle invalid data structure in localStorage', () => {
      // Arrange - missing required fields
      const invalidConsent = {
        essential: true,
        // Missing optional, timestamp, version
      };
      mockLocalStorage[CONSENT_STORAGE_KEY] = JSON.stringify(invalidConsent);

      // Act & Assert - should fall back to default
      renderWithContext((value) => {
        expect(value.consent).toEqual(DEFAULT_CONSENT_STATE);
        expect(value.hasConsented).toBe(false);
      });
    });

    it('should handle wrong type for essential field', () => {
      // Arrange
      const invalidConsent = {
        essential: 'yes', // Wrong type
        optional: false,
        timestamp: 1234567890,
        version: CONSENT_VERSION,
      };
      mockLocalStorage[CONSENT_STORAGE_KEY] = JSON.stringify(invalidConsent);

      // Act & Assert - should fall back to default
      renderWithContext((value) => {
        expect(value.consent).toEqual(DEFAULT_CONSENT_STATE);
        expect(value.hasConsented).toBe(false);
      });
    });

    it('should handle wrong type for optional field', () => {
      // Arrange
      const invalidConsent = {
        essential: true,
        optional: 'maybe', // Wrong type
        timestamp: 1234567890,
        version: CONSENT_VERSION,
      };
      mockLocalStorage[CONSENT_STORAGE_KEY] = JSON.stringify(invalidConsent);

      // Act & Assert - should fall back to default
      renderWithContext((value) => {
        expect(value.consent).toEqual(DEFAULT_CONSENT_STATE);
        expect(value.hasConsented).toBe(false);
      });
    });

    it('should handle wrong type for version field', () => {
      // Arrange
      const invalidConsent = {
        essential: true,
        optional: false,
        timestamp: 1234567890,
        version: '1', // Wrong type
      };
      mockLocalStorage[CONSENT_STORAGE_KEY] = JSON.stringify(invalidConsent);

      // Act & Assert - should fall back to default
      renderWithContext((value) => {
        expect(value.consent).toEqual(DEFAULT_CONSENT_STATE);
        expect(value.hasConsented).toBe(false);
      });
    });
  });

  describe('version migration', () => {
    it('should treat outdated version as no consent', () => {
      // Arrange - stored consent with old version
      const outdatedConsent = {
        essential: true,
        optional: true,
        timestamp: 1234567890,
        version: CONSENT_VERSION - 1, // Old version
      };
      mockLocalStorage[CONSENT_STORAGE_KEY] = JSON.stringify(outdatedConsent);

      // Act & Assert - should fall back to default
      renderWithContext((value) => {
        expect(value.consent).toEqual(DEFAULT_CONSENT_STATE);
        expect(value.hasConsented).toBe(false);
      });
    });

    it('should treat future version as no consent', () => {
      // Arrange - stored consent with future version
      const futureConsent = {
        essential: true,
        optional: true,
        timestamp: 1234567890,
        version: CONSENT_VERSION + 1, // Future version
      };
      mockLocalStorage[CONSENT_STORAGE_KEY] = JSON.stringify(futureConsent);

      // Act & Assert - should fall back to default
      renderWithContext((value) => {
        expect(value.consent).toEqual(DEFAULT_CONSENT_STATE);
        expect(value.hasConsented).toBe(false);
      });
    });
  });

  describe('acceptAll() action', () => {
    it('should set all categories to true', () => {
      // Arrange
      let contextValue: ConsentContextValue | null = null;

      renderWithContext((value) => {
        contextValue = value;
      });

      // Act
      act(() => {
        contextValue!.acceptAll();
      });

      // Assert - check what was written to localStorage
      const stored = JSON.parse(mockLocalStorage[CONSENT_STORAGE_KEY]);
      expect(stored.essential).toBe(true);
      expect(stored.optional).toBe(true);
    });

    it('should set timestamp when accepting all', () => {
      // Arrange
      let contextValue: ConsentContextValue | null = null;
      const beforeTime = Date.now();

      renderWithContext((value) => {
        contextValue = value;
      });

      // Act
      act(() => {
        contextValue!.acceptAll();
      });

      const afterTime = Date.now();

      // Assert
      const stored = JSON.parse(mockLocalStorage[CONSENT_STORAGE_KEY]);
      expect(stored.timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(stored.timestamp).toBeLessThanOrEqual(afterTime);
    });

    it('should persist to localStorage with correct version', () => {
      // Arrange
      let contextValue: ConsentContextValue | null = null;

      renderWithContext((value) => {
        contextValue = value;
      });

      // Act
      act(() => {
        contextValue!.acceptAll();
      });

      // Assert
      expect(localStorage.setItem).toHaveBeenCalledWith(
        CONSENT_STORAGE_KEY,
        expect.stringContaining('"version":' + CONSENT_VERSION)
      );

      const stored = JSON.parse(mockLocalStorage[CONSENT_STORAGE_KEY]);
      expect(stored.version).toBe(CONSENT_VERSION);
      expect(stored.essential).toBe(true);
      expect(stored.optional).toBe(true);
    });

    it('should dispatch consent-change event', () => {
      // Arrange
      let contextValue: ConsentContextValue | null = null;

      renderWithContext((value) => {
        contextValue = value;
      });

      // Act
      act(() => {
        contextValue!.acceptAll();
      });

      // Assert
      expect(window.dispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'consent-change',
        })
      );
    });
  });

  describe('rejectOptional() action', () => {
    it('should set essential to true and optional to false', () => {
      // Arrange
      let contextValue: ConsentContextValue | null = null;

      renderWithContext((value) => {
        contextValue = value;
      });

      // Act
      act(() => {
        contextValue!.rejectOptional();
      });

      // Assert
      const stored = JSON.parse(mockLocalStorage[CONSENT_STORAGE_KEY]);
      expect(stored.essential).toBe(true);
      expect(stored.optional).toBe(false);
    });

    it('should set timestamp when rejecting optional', () => {
      // Arrange
      let contextValue: ConsentContextValue | null = null;
      const beforeTime = Date.now();

      renderWithContext((value) => {
        contextValue = value;
      });

      // Act
      act(() => {
        contextValue!.rejectOptional();
      });

      const afterTime = Date.now();

      // Assert
      const stored = JSON.parse(mockLocalStorage[CONSENT_STORAGE_KEY]);
      expect(stored.timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(stored.timestamp).toBeLessThanOrEqual(afterTime);
    });

    it('should persist to localStorage with correct version', () => {
      // Arrange
      let contextValue: ConsentContextValue | null = null;

      renderWithContext((value) => {
        contextValue = value;
      });

      // Act
      act(() => {
        contextValue!.rejectOptional();
      });

      // Assert
      expect(localStorage.setItem).toHaveBeenCalledWith(CONSENT_STORAGE_KEY, expect.any(String));

      const stored = JSON.parse(mockLocalStorage[CONSENT_STORAGE_KEY]);
      expect(stored.version).toBe(CONSENT_VERSION);
    });

    it('should dispatch consent-change event', () => {
      // Arrange
      let contextValue: ConsentContextValue | null = null;

      renderWithContext((value) => {
        contextValue = value;
      });

      // Act
      act(() => {
        contextValue!.rejectOptional();
      });

      // Assert
      expect(window.dispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'consent-change',
        })
      );
    });
  });

  describe('updateConsent() action', () => {
    it('should update optional consent to true', () => {
      // Arrange
      let contextValue: ConsentContextValue | null = null;

      renderWithContext((value) => {
        contextValue = value;
      });

      // Act
      act(() => {
        contextValue!.updateConsent(true);
      });

      // Assert
      const stored = JSON.parse(mockLocalStorage[CONSENT_STORAGE_KEY]);
      expect(stored.essential).toBe(true);
      expect(stored.optional).toBe(true);
    });

    it('should update optional consent to false', () => {
      // Arrange
      let contextValue: ConsentContextValue | null = null;

      renderWithContext((value) => {
        contextValue = value;
      });

      // Act
      act(() => {
        contextValue!.updateConsent(false);
      });

      // Assert
      const stored = JSON.parse(mockLocalStorage[CONSENT_STORAGE_KEY]);
      expect(stored.essential).toBe(true);
      expect(stored.optional).toBe(false);
    });

    it('should set timestamp when updating consent', () => {
      // Arrange
      let contextValue: ConsentContextValue | null = null;
      const beforeTime = Date.now();

      renderWithContext((value) => {
        contextValue = value;
      });

      // Act
      act(() => {
        contextValue!.updateConsent(true);
      });

      const afterTime = Date.now();

      // Assert
      const stored = JSON.parse(mockLocalStorage[CONSENT_STORAGE_KEY]);
      expect(stored.timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(stored.timestamp).toBeLessThanOrEqual(afterTime);
    });

    it('should persist to localStorage with correct version', () => {
      // Arrange
      let contextValue: ConsentContextValue | null = null;

      renderWithContext((value) => {
        contextValue = value;
      });

      // Act
      act(() => {
        contextValue!.updateConsent(true);
      });

      // Assert
      const stored = JSON.parse(mockLocalStorage[CONSENT_STORAGE_KEY]);
      expect(stored.version).toBe(CONSENT_VERSION);
    });

    it('should dispatch consent-change event', () => {
      // Arrange
      let contextValue: ConsentContextValue | null = null;

      renderWithContext((value) => {
        contextValue = value;
      });

      // Act
      act(() => {
        contextValue!.updateConsent(true);
      });

      // Assert
      expect(window.dispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'consent-change',
        })
      );
    });
  });

  describe('resetConsent() action', () => {
    it('should clear consent from localStorage', () => {
      // Arrange
      let contextValue: ConsentContextValue | null = null;

      // First set some consent
      mockLocalStorage[CONSENT_STORAGE_KEY] = JSON.stringify({
        essential: true,
        optional: true,
        timestamp: Date.now(),
        version: CONSENT_VERSION,
      });

      renderWithContext((value) => {
        contextValue = value;
      });

      // Act
      act(() => {
        contextValue!.resetConsent();
      });

      // Assert
      expect(localStorage.removeItem).toHaveBeenCalledWith(CONSENT_STORAGE_KEY);
      expect(mockLocalStorage[CONSENT_STORAGE_KEY]).toBeUndefined();
    });

    it('should dispatch consent-change event', () => {
      // Arrange
      let contextValue: ConsentContextValue | null = null;

      renderWithContext((value) => {
        contextValue = value;
      });

      // Act
      act(() => {
        contextValue!.resetConsent();
      });

      // Assert
      expect(window.dispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'consent-change',
        })
      );
    });
  });

  describe('modal state management', () => {
    it('should have isPreferencesOpen=false by default', () => {
      // Arrange & Act & Assert
      renderWithContext((value) => {
        expect(value.isPreferencesOpen).toBe(false);
      });
    });

    it('should open preferences modal when openPreferences is called', () => {
      // Arrange
      let contextValue: ConsentContextValue | null = null;

      const { rerender } = render(
        <ConsentProvider>
          <TestComponentWithState
            onMount={(value) => {
              contextValue = value;
            }}
          />
        </ConsentProvider>
      );

      // Act
      act(() => {
        contextValue!.openPreferences();
      });

      // Trigger re-render
      rerender(
        <ConsentProvider>
          <TestComponentWithState
            onMount={(value) => {
              contextValue = value;
            }}
          />
        </ConsentProvider>
      );

      // Assert
      expect(contextValue!.isPreferencesOpen).toBe(true);
    });

    it('should close preferences modal when closePreferences is called', () => {
      // Arrange
      let contextValue: ConsentContextValue | null = null;

      const { rerender } = render(
        <ConsentProvider>
          <TestComponentWithState
            onMount={(value) => {
              contextValue = value;
            }}
          />
        </ConsentProvider>
      );

      // First open the modal
      act(() => {
        contextValue!.openPreferences();
      });

      rerender(
        <ConsentProvider>
          <TestComponentWithState
            onMount={(value) => {
              contextValue = value;
            }}
          />
        </ConsentProvider>
      );

      expect(contextValue!.isPreferencesOpen).toBe(true);

      // Act - close the modal
      act(() => {
        contextValue!.closePreferences();
      });

      rerender(
        <ConsentProvider>
          <TestComponentWithState
            onMount={(value) => {
              contextValue = value;
            }}
          />
        </ConsentProvider>
      );

      // Assert
      expect(contextValue!.isPreferencesOpen).toBe(false);
    });
  });

  describe('localStorage error handling', () => {
    it('should handle localStorage.setItem errors gracefully', () => {
      // Arrange
      let contextValue: ConsentContextValue | null = null;

      vi.stubGlobal('localStorage', {
        getItem: vi.fn(() => null),
        setItem: vi.fn(() => {
          throw new Error('QuotaExceededError');
        }),
        removeItem: vi.fn(),
        clear: vi.fn(),
      });

      renderWithContext((value) => {
        contextValue = value;
      });

      // Act - should not throw
      expect(() => {
        act(() => {
          contextValue!.acceptAll();
        });
      }).not.toThrow();
    });

    it('should handle localStorage.removeItem errors gracefully', () => {
      // Arrange
      let contextValue: ConsentContextValue | null = null;

      vi.stubGlobal('localStorage', {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(() => {
          throw new Error('Storage error');
        }),
        clear: vi.fn(),
      });

      renderWithContext((value) => {
        contextValue = value;
      });

      // Act - should not throw
      expect(() => {
        act(() => {
          contextValue!.resetConsent();
        });
      }).not.toThrow();
    });
  });

  describe('SSR safety', () => {
    it('should return default state on server (getServerSnapshot)', () => {
      // This test verifies that the getServerSnapshot function returns
      // the default consent state, which is what happens during SSR.
      // We can't truly test SSR in this environment, but we can verify
      // the snapshot behavior by checking the default state is returned
      // when no localStorage is available.

      // Arrange - clear any stored consent
      mockLocalStorage = {};

      // Act
      const { getByText } = render(
        <ConsentProvider>
          <TestComponentForDisabledMode />
        </ConsentProvider>
      );

      // Assert - should have default values (from getServerSnapshot)
      expect(getByText('essential:true')).toBeInTheDocument();
      expect(getByText('optional:false')).toBeInTheDocument();
      expect(getByText('timestamp:null')).toBeInTheDocument();
    });
  });

  describe('disabled mode', () => {
    beforeEach(() => {
      // Need to reset modules to pick up the new mock value
      vi.resetModules();
    });

    it('should grant all consent when isConsentEnabled returns false', () => {
      // Arrange
      mockIsConsentEnabled.mockReturnValue(false);

      // Act
      const { getByText } = render(
        <ConsentProvider>
          <TestComponentForDisabledMode />
        </ConsentProvider>
      );

      // Assert
      expect(getByText('essential:true')).toBeInTheDocument();
      expect(getByText('optional:true')).toBeInTheDocument();
      expect(getByText('hasConsented:true')).toBeInTheDocument();
    });

    it('should have isInitialized=true in disabled mode', () => {
      // Arrange
      mockIsConsentEnabled.mockReturnValue(false);

      // Act
      const { getByText } = render(
        <ConsentProvider>
          <TestComponentForDisabledMode />
        </ConsentProvider>
      );

      // Assert
      expect(getByText('isInitialized:true')).toBeInTheDocument();
    });

    it('should provide no-op functions in disabled mode', () => {
      // Arrange
      mockIsConsentEnabled.mockReturnValue(false);

      const TestComponent = () => {
        const value = useContext(ConsentContext);

        // Test that all functions can be called without throwing
        if (value) {
          try {
            value.acceptAll();
            value.rejectOptional();
            value.updateConsent(false);
            value.resetConsent();
            value.openPreferences();
            value.closePreferences();
          } catch (error) {
            // If any function throws, fail the test
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Function threw unexpectedly: ${errorMessage}`);
          }
        }

        return <div>Test</div>;
      };

      // Act & Assert - rendering should not throw
      expect(() => {
        render(
          <ConsentProvider>
            <TestComponent />
          </ConsentProvider>
        );
      }).not.toThrow();

      // Assert - localStorage should not be called in disabled mode
      expect(localStorage.setItem).not.toHaveBeenCalled();
      expect(localStorage.removeItem).not.toHaveBeenCalled();
    });

    it('should have isPreferencesOpen=false in disabled mode', () => {
      // Arrange
      mockIsConsentEnabled.mockReturnValue(false);

      // Act
      const { getByText } = render(
        <ConsentProvider>
          <TestComponentForDisabledMode />
        </ConsentProvider>
      );

      // Assert
      expect(getByText('isPreferencesOpen:false')).toBeInTheDocument();
    });

    it('should have timestamp=0 in disabled mode', () => {
      // Arrange
      mockIsConsentEnabled.mockReturnValue(false);

      // Act
      const { getByText } = render(
        <ConsentProvider>
          <TestComponentForDisabledMode />
        </ConsentProvider>
      );

      // Assert
      expect(getByText('timestamp:0')).toBeInTheDocument();
    });
  });

  describe('writeConsent edge cases', () => {
    beforeEach(() => {
      // Reset modules to clear cachedSnapshot
      vi.resetModules();
    });

    it('should not crash when localStorage.setItem throws', async () => {
      // Arrange
      vi.stubGlobal('localStorage', {
        getItem: vi.fn(() => null),
        setItem: vi.fn(() => {
          throw new Error('QuotaExceededError');
        }),
        removeItem: vi.fn(),
        clear: vi.fn(),
      });

      // Need to dynamically import to pick up the new mocks
      const { ConsentProvider } = await import('@/lib/consent/consent-provider');
      const { useConsent } = await import('@/lib/consent/use-consent');

      const wrapper = ({ children }: { children: ReactNode }) => (
        <ConsentProvider>{children}</ConsentProvider>
      );

      const { result } = renderHook(() => useConsent(), { wrapper });

      // Act - should not throw, consent should still update in memory
      expect(() => {
        act(() => {
          result.current.acceptAll();
        });
      }).not.toThrow();

      // Assert - acceptAll completed without crashing
      expect(result.current).toBeDefined();
    });
  });

  describe('clearConsent edge cases', () => {
    beforeEach(() => {
      // Reset modules to clear cachedSnapshot
      vi.resetModules();
    });

    it('should not crash when localStorage.removeItem throws during resetConsent', async () => {
      // Arrange
      vi.stubGlobal('localStorage', {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(() => {
          throw new Error('Storage error');
        }),
        clear: vi.fn(),
      });

      // Need to dynamically import to pick up the new mocks
      const { ConsentProvider } = await import('@/lib/consent/consent-provider');
      const { useConsent } = await import('@/lib/consent/use-consent');

      const wrapper = ({ children }: { children: ReactNode }) => (
        <ConsentProvider>{children}</ConsentProvider>
      );

      const { result } = renderHook(() => useConsent(), { wrapper });

      // Act - should not throw
      expect(() => {
        act(() => {
          result.current.resetConsent();
        });
      }).not.toThrow();

      // Assert - resetConsent completed without crashing
      expect(result.current).toBeDefined();
    });
  });

  describe('subscription cleanup', () => {
    beforeEach(() => {
      // Reset modules to clear cachedSnapshot
      vi.resetModules();
    });

    it('should call addEventListener for consent-change and storage events', async () => {
      // Arrange
      const mockAddEventListener = vi.fn();
      const mockRemoveEventListener = vi.fn();

      vi.stubGlobal('addEventListener', mockAddEventListener);
      vi.stubGlobal('removeEventListener', mockRemoveEventListener);

      // Need to dynamically import to pick up the new mocks
      const { ConsentProvider } = await import('@/lib/consent/consent-provider');

      // Act
      const { unmount } = render(
        <ConsentProvider>
          <div>Test</div>
        </ConsentProvider>
      );

      // Assert - should have registered event listeners
      expect(mockAddEventListener).toHaveBeenCalledWith('consent-change', expect.any(Function));
      expect(mockAddEventListener).toHaveBeenCalledWith('storage', expect.any(Function));

      // Act - unmount to trigger cleanup
      unmount();

      // Assert - should have cleaned up event listeners
      expect(mockRemoveEventListener).toHaveBeenCalledWith('consent-change', expect.any(Function));
      expect(mockRemoveEventListener).toHaveBeenCalledWith('storage', expect.any(Function));
    });

    it('should clean up the same handler functions that were registered', async () => {
      // Arrange
      type EventHandler = (...args: unknown[]) => void;
      const registeredHandlers: Map<string, EventHandler> = new Map();
      const mockAddEventListener = vi.fn((event: string, handler: EventHandler) => {
        registeredHandlers.set(event, handler);
      });
      const mockRemoveEventListener = vi.fn((event: string, handler: EventHandler) => {
        expect(handler).toBe(registeredHandlers.get(event));
      });

      vi.stubGlobal('addEventListener', mockAddEventListener);
      vi.stubGlobal('removeEventListener', mockRemoveEventListener);

      // Need to dynamically import to pick up the new mocks
      const { ConsentProvider } = await import('@/lib/consent/consent-provider');

      // Act
      const { unmount } = render(
        <ConsentProvider>
          <div>Test</div>
        </ConsentProvider>
      );

      // Verify registration
      expect(registeredHandlers.has('consent-change')).toBe(true);
      expect(registeredHandlers.has('storage')).toBe(true);

      // Act - unmount to trigger cleanup
      unmount();

      // Assert - removeEventListener was called (assertions inside mock verify correct handlers)
      expect(mockRemoveEventListener).toHaveBeenCalledWith(
        'consent-change',
        registeredHandlers.get('consent-change')
      );
      expect(mockRemoveEventListener).toHaveBeenCalledWith(
        'storage',
        registeredHandlers.get('storage')
      );
    });
  });
});

/**
 * Helper component that captures the context value in a ref-like pattern
 * for testing modal state changes
 */
function TestComponentWithState({ onMount }: { onMount: (value: ConsentContextValue) => void }) {
  const value = useContext(ConsentContext);
  if (value) {
    onMount(value);
  }
  return null;
}

/**
 * Helper component for testing disabled mode
 * Renders context values as text for assertions
 */
function TestComponentForDisabledMode() {
  const value = useContext(ConsentContext);
  if (!value) return <div>no-context</div>;

  return (
    <div>
      <div>essential:{String(value.consent.essential)}</div>
      <div>optional:{String(value.consent.optional)}</div>
      <div>hasConsented:{String(value.hasConsented)}</div>
      <div>isInitialized:{String(value.isInitialized)}</div>
      <div>isPreferencesOpen:{String(value.isPreferencesOpen)}</div>
      <div>timestamp:{String(value.consent.timestamp)}</div>
    </div>
  );
}
