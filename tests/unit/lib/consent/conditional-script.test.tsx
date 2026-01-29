/**
 * ConditionalScript Component Tests
 *
 * Tests the ConditionalScript component and useShouldLoadOptionalScripts hook:
 * - Conditional rendering based on consent
 * - React node children support
 * - Function children support (execution pattern)
 * - onConsentChange callback
 * - Integration with consent context
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/lib/consent/conditional-script.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, screen, act } from '@testing-library/react';
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
 * Test Suite: ConditionalScript Component
 */
describe('lib/consent/conditional-script', () => {
  // Mock localStorage
  let mockLocalStorage: Record<string, string> = {};

  // Dynamic module references (reset each test via vi.resetModules)
  let ConditionalScript: typeof import('@/lib/consent/conditional-script').ConditionalScript;
  let useShouldLoadOptionalScripts: typeof import('@/lib/consent/conditional-script').useShouldLoadOptionalScripts;
  let ConsentProvider: typeof import('@/lib/consent/consent-provider').ConsentProvider;
  let useConsent: typeof import('@/lib/consent/use-consent').useConsent;

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
    const scriptModule = await import('@/lib/consent/conditional-script');
    ConditionalScript = scriptModule.ConditionalScript;
    useShouldLoadOptionalScripts = scriptModule.useShouldLoadOptionalScripts;

    const providerModule = await import('@/lib/consent/consent-provider');
    ConsentProvider = providerModule.ConsentProvider;

    const hooksModule = await import('@/lib/consent/use-consent');
    useConsent = hooksModule.useConsent;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('ConditionalScript - rendering behavior', () => {
    it('should render nothing when optional consent is not given', () => {
      const { container } = render(
        <ConsentProvider>
          <ConditionalScript>
            <div data-testid="test-content">Test Content</div>
          </ConditionalScript>
        </ConsentProvider>
      );

      expect(screen.queryByTestId('test-content')).not.toBeInTheDocument();
      expect(container.firstChild).toBeNull();
    });

    it('should render children when optional consent is given', () => {
      mockLocalStorage[CONSENT_STORAGE_KEY] = JSON.stringify({
        essential: true,
        optional: true,
        timestamp: Date.now(),
        version: CONSENT_VERSION,
      });

      render(
        <ConsentProvider>
          <ConditionalScript>
            <div data-testid="test-content">Test Content</div>
          </ConditionalScript>
        </ConsentProvider>
      );

      expect(screen.getByTestId('test-content')).toBeInTheDocument();
    });

    it('should render multiple React node children', () => {
      mockLocalStorage[CONSENT_STORAGE_KEY] = JSON.stringify({
        essential: true,
        optional: true,
        timestamp: Date.now(),
        version: CONSENT_VERSION,
      });

      render(
        <ConsentProvider>
          <ConditionalScript>
            <div data-testid="child-1">Child 1</div>
            <div data-testid="child-2">Child 2</div>
          </ConditionalScript>
        </ConsentProvider>
      );

      expect(screen.getByTestId('child-1')).toBeInTheDocument();
      expect(screen.getByTestId('child-2')).toBeInTheDocument();
    });

    it('should render null for function children (executed via useEffect)', () => {
      mockLocalStorage[CONSENT_STORAGE_KEY] = JSON.stringify({
        essential: true,
        optional: true,
        timestamp: Date.now(),
        version: CONSENT_VERSION,
      });

      const mockFn = vi.fn();

      const { container } = render(
        <ConsentProvider>
          <ConditionalScript>{mockFn}</ConditionalScript>
        </ConsentProvider>
      );

      // Function children don't render DOM - they're executed in useEffect
      expect(container.firstChild).toBeNull();
    });
  });

  describe('ConditionalScript - function children', () => {
    it('should call function children when consent is given', async () => {
      mockLocalStorage[CONSENT_STORAGE_KEY] = JSON.stringify({
        essential: true,
        optional: true,
        timestamp: Date.now(),
        version: CONSENT_VERSION,
      });

      const mockFn = vi.fn();

      render(
        <ConsentProvider>
          <ConditionalScript>{mockFn}</ConditionalScript>
        </ConsentProvider>
      );

      await waitFor(() => {
        expect(mockFn).toHaveBeenCalledTimes(1);
      });
    });

    it('should not call function children when consent is not given', () => {
      const mockFn = vi.fn();

      render(
        <ConsentProvider>
          <ConditionalScript>{mockFn}</ConditionalScript>
        </ConsentProvider>
      );

      expect(mockFn).not.toHaveBeenCalled();
    });

    it('should call function children on re-render with consent', async () => {
      mockLocalStorage[CONSENT_STORAGE_KEY] = JSON.stringify({
        essential: true,
        optional: true,
        timestamp: Date.now(),
        version: CONSENT_VERSION,
      });

      const mockFn = vi.fn();

      const { rerender } = render(
        <ConsentProvider>
          <ConditionalScript>{mockFn}</ConditionalScript>
        </ConsentProvider>
      );

      await waitFor(() => {
        expect(mockFn).toHaveBeenCalledTimes(1);
      });

      rerender(
        <ConsentProvider>
          <ConditionalScript>{mockFn}</ConditionalScript>
        </ConsentProvider>
      );

      await waitFor(() => {
        expect(mockFn).toHaveBeenCalled();
      });
    });
  });

  describe('ConditionalScript - consent state changes', () => {
    it('should show children when consent is accepted via action', async () => {
      const TestComponent = () => {
        const { acceptAll } = useConsent();
        return (
          <>
            <button onClick={acceptAll}>Accept</button>
            <ConditionalScript>
              <div data-testid="test-content">Test Content</div>
            </ConditionalScript>
          </>
        );
      };

      const { getByText } = render(
        <ConsentProvider>
          <TestComponent />
        </ConsentProvider>
      );

      // Initial state - content not visible
      expect(screen.queryByTestId('test-content')).not.toBeInTheDocument();

      // Accept consent
      act(() => {
        getByText('Accept').click();
      });

      // Content should now be visible
      await waitFor(() => {
        expect(screen.getByTestId('test-content')).toBeInTheDocument();
      });
    });

    it('should hide children when consent is revoked via action', async () => {
      mockLocalStorage[CONSENT_STORAGE_KEY] = JSON.stringify({
        essential: true,
        optional: true,
        timestamp: Date.now(),
        version: CONSENT_VERSION,
      });

      const TestComponent = () => {
        const { rejectOptional } = useConsent();
        return (
          <>
            <button onClick={rejectOptional}>Reject</button>
            <ConditionalScript>
              <div data-testid="test-content">Test Content</div>
            </ConditionalScript>
          </>
        );
      };

      const { getByText } = render(
        <ConsentProvider>
          <TestComponent />
        </ConsentProvider>
      );

      // Initial state - content visible
      expect(screen.getByTestId('test-content')).toBeInTheDocument();

      // Revoke consent
      act(() => {
        getByText('Reject').click();
      });

      // Content should be hidden
      await waitFor(() => {
        expect(screen.queryByTestId('test-content')).not.toBeInTheDocument();
      });
    });
  });

  describe('ConditionalScript - onConsentChange callback', () => {
    it('should fire onConsentChange when consent state changes', async () => {
      const onConsentChange = vi.fn();

      const TestComponent = () => {
        const { acceptAll } = useConsent();
        return (
          <>
            <button onClick={acceptAll}>Accept</button>
            <ConditionalScript onConsentChange={onConsentChange}>
              <div>Test Content</div>
            </ConditionalScript>
          </>
        );
      };

      const { getByText } = render(
        <ConsentProvider>
          <TestComponent />
        </ConsentProvider>
      );

      // Initial call with false
      expect(onConsentChange).toHaveBeenCalledWith(false);

      // Accept consent
      act(() => {
        getByText('Accept').click();
      });

      // Callback called with true
      await waitFor(() => {
        expect(onConsentChange).toHaveBeenCalledWith(true);
      });
    });

    it('should receive true when consent is pre-given', async () => {
      mockLocalStorage[CONSENT_STORAGE_KEY] = JSON.stringify({
        essential: true,
        optional: true,
        timestamp: Date.now(),
        version: CONSENT_VERSION,
      });

      const onConsentChange = vi.fn();

      render(
        <ConsentProvider>
          <ConditionalScript onConsentChange={onConsentChange}>
            <div>Test Content</div>
          </ConditionalScript>
        </ConsentProvider>
      );

      await waitFor(() => {
        expect(onConsentChange).toHaveBeenCalledWith(true);
      });
    });

    it('should receive false when consent is not given', () => {
      const onConsentChange = vi.fn();

      render(
        <ConsentProvider>
          <ConditionalScript onConsentChange={onConsentChange}>
            <div>Test Content</div>
          </ConditionalScript>
        </ConsentProvider>
      );

      expect(onConsentChange).toHaveBeenCalledWith(false);
    });

    it('should be called on mount with current consent state', () => {
      const onConsentChange = vi.fn();

      render(
        <ConsentProvider>
          <ConditionalScript onConsentChange={onConsentChange}>
            <div>Test Content</div>
          </ConditionalScript>
        </ConsentProvider>
      );

      expect(onConsentChange).toHaveBeenCalled();
    });

    it('should be called when consent changes from false to true', async () => {
      const onConsentChange = vi.fn();

      const TestComponent = () => {
        const { acceptAll } = useConsent();
        return (
          <>
            <button onClick={acceptAll}>Accept</button>
            <ConditionalScript onConsentChange={onConsentChange}>
              <div>Test Content</div>
            </ConditionalScript>
          </>
        );
      };

      const { getByText } = render(
        <ConsentProvider>
          <TestComponent />
        </ConsentProvider>
      );

      onConsentChange.mockClear();

      act(() => {
        getByText('Accept').click();
      });

      await waitFor(() => {
        expect(onConsentChange).toHaveBeenCalledWith(true);
      });
    });

    it('should be called when consent changes from true to false', async () => {
      mockLocalStorage[CONSENT_STORAGE_KEY] = JSON.stringify({
        essential: true,
        optional: true,
        timestamp: Date.now(),
        version: CONSENT_VERSION,
      });

      const onConsentChange = vi.fn();

      const TestComponent = () => {
        const { rejectOptional } = useConsent();
        return (
          <>
            <button onClick={rejectOptional}>Reject</button>
            <ConditionalScript onConsentChange={onConsentChange}>
              <div>Test Content</div>
            </ConditionalScript>
          </>
        );
      };

      const { getByText } = render(
        <ConsentProvider>
          <TestComponent />
        </ConsentProvider>
      );

      onConsentChange.mockClear();

      act(() => {
        getByText('Reject').click();
      });

      await waitFor(() => {
        expect(onConsentChange).toHaveBeenCalledWith(false);
      });
    });
  });

  describe('ConditionalScript - consent disabled mode', () => {
    it('should render children when consent system is disabled', () => {
      mockIsConsentEnabled.mockReturnValue(false);

      render(
        <ConsentProvider>
          <ConditionalScript>
            <div data-testid="test-content">Test Content</div>
          </ConditionalScript>
        </ConsentProvider>
      );

      expect(screen.getByTestId('test-content')).toBeInTheDocument();
    });

    it('should call function children when consent system is disabled', async () => {
      mockIsConsentEnabled.mockReturnValue(false);
      const mockFn = vi.fn();

      render(
        <ConsentProvider>
          <ConditionalScript>{mockFn}</ConditionalScript>
        </ConsentProvider>
      );

      await waitFor(() => {
        expect(mockFn).toHaveBeenCalledTimes(1);
      });
    });

    it('should call onConsentChange with true when consent system is disabled', () => {
      mockIsConsentEnabled.mockReturnValue(false);
      const onConsentChange = vi.fn();

      render(
        <ConsentProvider>
          <ConditionalScript onConsentChange={onConsentChange}>
            <div>Test Content</div>
          </ConditionalScript>
        </ConsentProvider>
      );

      expect(onConsentChange).toHaveBeenCalledWith(true);
    });
  });

  describe('useShouldLoadOptionalScripts()', () => {
    it('should return false when no optional consent', () => {
      const TestComponent = () => {
        const shouldLoad = useShouldLoadOptionalScripts();
        return <div data-testid="result">{String(shouldLoad)}</div>;
      };

      render(
        <ConsentProvider>
          <TestComponent />
        </ConsentProvider>
      );

      expect(screen.getByTestId('result')).toHaveTextContent('false');
    });

    it('should return true when optional consent is given', () => {
      mockLocalStorage[CONSENT_STORAGE_KEY] = JSON.stringify({
        essential: true,
        optional: true,
        timestamp: Date.now(),
        version: CONSENT_VERSION,
      });

      const TestComponent = () => {
        const shouldLoad = useShouldLoadOptionalScripts();
        return <div data-testid="result">{String(shouldLoad)}</div>;
      };

      render(
        <ConsentProvider>
          <TestComponent />
        </ConsentProvider>
      );

      expect(screen.getByTestId('result')).toHaveTextContent('true');
    });

    it('should return true when consent system is disabled', () => {
      mockIsConsentEnabled.mockReturnValue(false);

      const TestComponent = () => {
        const shouldLoad = useShouldLoadOptionalScripts();
        return <div data-testid="result">{String(shouldLoad)}</div>;
      };

      render(
        <ConsentProvider>
          <TestComponent />
        </ConsentProvider>
      );

      expect(screen.getByTestId('result')).toHaveTextContent('true');
    });

    it('should update reactively when consent changes', async () => {
      const TestComponent = () => {
        const { acceptAll } = useConsent();
        const shouldLoad = useShouldLoadOptionalScripts();
        return (
          <>
            <button onClick={acceptAll}>Accept</button>
            <div data-testid="result">{String(shouldLoad)}</div>
          </>
        );
      };

      const { getByText } = render(
        <ConsentProvider>
          <TestComponent />
        </ConsentProvider>
      );

      expect(screen.getByTestId('result')).toHaveTextContent('false');

      act(() => {
        getByText('Accept').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('result')).toHaveTextContent('true');
      });
    });

    it('should be equivalent to useHasOptionalConsent', () => {
      mockLocalStorage[CONSENT_STORAGE_KEY] = JSON.stringify({
        essential: true,
        optional: true,
        timestamp: Date.now(),
        version: CONSENT_VERSION,
      });

      const TestComponent = () => {
        const shouldLoad = useShouldLoadOptionalScripts();
        const { consent, hasConsented } = useConsent();
        const hasOptional = hasConsented && consent.optional;

        return (
          <>
            <div data-testid="should-load">{String(shouldLoad)}</div>
            <div data-testid="has-optional">{String(hasOptional)}</div>
          </>
        );
      };

      render(
        <ConsentProvider>
          <TestComponent />
        </ConsentProvider>
      );

      const shouldLoadText = screen.getByTestId('should-load').textContent;
      const hasOptionalText = screen.getByTestId('has-optional').textContent;
      expect(shouldLoadText).toBe(hasOptionalText);
    });
  });

  describe('edge cases', () => {
    it('should handle null children gracefully', () => {
      mockLocalStorage[CONSENT_STORAGE_KEY] = JSON.stringify({
        essential: true,
        optional: true,
        timestamp: Date.now(),
        version: CONSENT_VERSION,
      });

      expect(() => {
        render(
          <ConsentProvider>
            <ConditionalScript>{null}</ConditionalScript>
          </ConsentProvider>
        );
      }).not.toThrow();
    });

    it('should handle undefined children gracefully', () => {
      mockLocalStorage[CONSENT_STORAGE_KEY] = JSON.stringify({
        essential: true,
        optional: true,
        timestamp: Date.now(),
        version: CONSENT_VERSION,
      });

      expect(() => {
        render(
          <ConsentProvider>
            <ConditionalScript>{undefined}</ConditionalScript>
          </ConsentProvider>
        );
      }).not.toThrow();
    });

    it('should handle mixed children (strings, numbers, elements)', () => {
      mockLocalStorage[CONSENT_STORAGE_KEY] = JSON.stringify({
        essential: true,
        optional: true,
        timestamp: Date.now(),
        version: CONSENT_VERSION,
      });

      render(
        <ConsentProvider>
          <ConditionalScript>
            <div>Element</div>
            Some text
            {42}
          </ConditionalScript>
        </ConsentProvider>
      );

      expect(screen.getByText('Element')).toBeInTheDocument();
      expect(screen.getByText(/Some text/)).toBeInTheDocument();
      expect(screen.getByText(/42/)).toBeInTheDocument();
    });
  });
});
