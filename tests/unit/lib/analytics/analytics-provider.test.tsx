/**
 * AnalyticsProvider Context Tests
 *
 * Tests the AnalyticsProvider component which provides analytics context
 * integrated with the consent system.
 *
 * Features tested:
 * - Context provides track, identify, page, reset, isReady, isEnabled
 * - No-op behavior when consent not given
 * - Initialization on consent grant
 * - Reset on consent revoke
 * - useAnalytics() hook returns correct values
 * - useAnalytics() throws when used outside provider
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/lib/analytics/analytics-provider.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { AnalyticsProvider, AnalyticsContext } from '@/lib/analytics/analytics-provider';
import { useContext } from 'react';
import type { AnalyticsProvider as AnalyticsProviderType } from '@/lib/analytics/providers/types';
import type { TrackResult, AnalyticsContextValue } from '@/lib/analytics/types';

// Mock dependencies
const mockGetAnalyticsClient = vi.fn();
const mockInitAnalytics = vi.fn();
const mockResetAnalyticsClient = vi.fn();
const mockGetAnalyticsProviderName = vi.fn();

vi.mock('@/lib/analytics/client', () => ({
  getAnalyticsClient: () => mockGetAnalyticsClient(),
  initAnalytics: () => mockInitAnalytics(),
  getAnalyticsProviderName: () => mockGetAnalyticsProviderName(),
  resetAnalyticsClient: () => mockResetAnalyticsClient(),
}));

const mockUseHasOptionalConsent = vi.fn();

vi.mock('@/lib/consent', () => ({
  useHasOptionalConsent: () => mockUseHasOptionalConsent(),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    error: vi.fn(),
  },
}));

/**
 * Helper to render a component that accesses the analytics context
 * and perform assertions on it.
 */
function renderWithContext(callback: (value: AnalyticsContextValue) => void) {
  const TestComponent = () => {
    const value = useContext(AnalyticsContext);
    if (value) {
      callback(value);
    }
    return null;
  };

  return render(
    <AnalyticsProvider>
      <TestComponent />
    </AnalyticsProvider>
  );
}

/**
 * Test Suite: AnalyticsProvider Context
 */
describe('lib/analytics/analytics-provider', () => {
  const mockTrack = vi.fn();
  const mockIdentify = vi.fn();
  const mockPage = vi.fn();
  const mockReset = vi.fn();
  const mockIsReady = vi.fn();

  const createMockClient = (ready = true): AnalyticsProviderType => ({
    name: 'test-provider',
    type: 'console',
    track: mockTrack,
    identify: mockIdentify,
    page: mockPage,
    reset: mockReset,
    isReady: mockIsReady.mockReturnValue(ready),
    init: vi.fn().mockResolvedValue(undefined),
    getFeatures: vi.fn().mockReturnValue({
      supportsIdentify: true,
      supportsServerSide: false,
      supportsFeatureFlags: false,
      supportsSessionReplay: false,
      supportsCookieless: false,
    }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseHasOptionalConsent.mockReturnValue(false);
    mockGetAnalyticsProviderName.mockReturnValue('test-provider');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('provider setup', () => {
    it('should render children', () => {
      // Arrange
      mockGetAnalyticsClient.mockReturnValue(null);
      mockUseHasOptionalConsent.mockReturnValue(false);

      // Act
      const { getByText } = render(
        <AnalyticsProvider>
          <div>Test Content</div>
        </AnalyticsProvider>
      );

      // Assert
      expect(getByText('Test Content')).toBeInTheDocument();
    });

    it('should provide context to children', () => {
      // Arrange
      mockGetAnalyticsClient.mockReturnValue(null);
      mockUseHasOptionalConsent.mockReturnValue(false);

      // Act & Assert
      renderWithContext((value) => {
        expect(value).toBeDefined();
        expect(value).not.toBe(undefined);
      });
    });
  });

  describe('context values without consent', () => {
    it('should provide all expected context properties', () => {
      // Arrange
      mockGetAnalyticsClient.mockReturnValue(null);
      mockUseHasOptionalConsent.mockReturnValue(false);

      // Act & Assert
      renderWithContext((value) => {
        expect(value).toHaveProperty('track');
        expect(value).toHaveProperty('identify');
        expect(value).toHaveProperty('page');
        expect(value).toHaveProperty('reset');
        expect(value).toHaveProperty('isReady');
        expect(value).toHaveProperty('isEnabled');
        expect(value).toHaveProperty('providerName');
      });
    });

    it('should have isEnabled=false when no consent', () => {
      // Arrange
      mockGetAnalyticsClient.mockReturnValue(null);
      mockUseHasOptionalConsent.mockReturnValue(false);

      // Act & Assert
      renderWithContext((value) => {
        expect(value.isEnabled).toBe(false);
      });
    });

    it('should have isReady=false when no consent', () => {
      // Arrange
      mockGetAnalyticsClient.mockReturnValue(null);
      mockUseHasOptionalConsent.mockReturnValue(false);

      // Act & Assert
      renderWithContext((value) => {
        expect(value.isReady).toBe(false);
      });
    });

    it('should return no-op result from track when no consent', async () => {
      // Arrange
      mockGetAnalyticsClient.mockReturnValue(null);
      mockUseHasOptionalConsent.mockReturnValue(false);

      let trackFn: ((event: string) => Promise<TrackResult>) | null = null;

      const TestComponent = () => {
        const value = useContext(AnalyticsContext);
        if (value) {
          // eslint-disable-next-line react-hooks/globals
          trackFn = value.track;
        }
        return null;
      };

      render(
        <AnalyticsProvider>
          <TestComponent />
        </AnalyticsProvider>
      );

      // Act
      const result = await trackFn!('test_event');

      // Assert
      expect(result).toEqual({ success: false, error: 'Analytics not available' });
      expect(mockTrack).not.toHaveBeenCalled();
    });

    it('should return no-op result from identify when no consent', async () => {
      // Arrange
      mockGetAnalyticsClient.mockReturnValue(null);
      mockUseHasOptionalConsent.mockReturnValue(false);

      let identifyFn: ((userId: string) => Promise<TrackResult>) | null = null;

      const TestComponent = () => {
        const value = useContext(AnalyticsContext);
        if (value) {
          // eslint-disable-next-line react-hooks/globals
          identifyFn = value.identify;
        }
        return null;
      };

      render(
        <AnalyticsProvider>
          <TestComponent />
        </AnalyticsProvider>
      );

      // Act
      const result = await identifyFn!('user-123');

      // Assert
      expect(result).toEqual({ success: false, error: 'Analytics not available' });
      expect(mockIdentify).not.toHaveBeenCalled();
    });

    it('should return no-op result from page when no consent', async () => {
      // Arrange
      mockGetAnalyticsClient.mockReturnValue(null);
      mockUseHasOptionalConsent.mockReturnValue(false);

      let pageFn: ((name?: string) => Promise<TrackResult>) | null = null;

      const TestComponent = () => {
        const value = useContext(AnalyticsContext);
        if (value) {
          // eslint-disable-next-line react-hooks/globals
          pageFn = value.page;
        }
        return null;
      };

      render(
        <AnalyticsProvider>
          <TestComponent />
        </AnalyticsProvider>
      );

      // Act
      const result = await pageFn!('Home');

      // Assert
      expect(result).toEqual({ success: false, error: 'Analytics not available' });
      expect(mockPage).not.toHaveBeenCalled();
    });
  });

  describe('initialization with consent', () => {
    it('should initialize analytics when consent is given', async () => {
      // Arrange
      const mockClient = createMockClient(false); // Not ready initially
      mockGetAnalyticsClient.mockReturnValue(mockClient);
      mockUseHasOptionalConsent.mockReturnValue(true);
      mockInitAnalytics.mockResolvedValue(undefined);

      // Act
      render(
        <AnalyticsProvider>
          <div>Test</div>
        </AnalyticsProvider>
      );

      // Assert
      await waitFor(() => {
        expect(mockInitAnalytics).toHaveBeenCalledTimes(1);
      });
    });

    it('should not initialize if client is already ready', () => {
      // Arrange
      const mockClient = createMockClient(true); // Already ready
      mockGetAnalyticsClient.mockReturnValue(mockClient);
      mockUseHasOptionalConsent.mockReturnValue(true);

      // Act
      render(
        <AnalyticsProvider>
          <div>Test</div>
        </AnalyticsProvider>
      );

      // Assert
      expect(mockInitAnalytics).not.toHaveBeenCalled();
    });

    it('should handle initialization errors gracefully', async () => {
      // Arrange
      const mockClient = createMockClient(false);
      mockGetAnalyticsClient.mockReturnValue(mockClient);
      mockUseHasOptionalConsent.mockReturnValue(true);
      const mockError = new Error('Init failed');
      mockInitAnalytics.mockRejectedValue(mockError);

      // Act & Assert - should not throw
      expect(() =>
        render(
          <AnalyticsProvider>
            <div>Test</div>
          </AnalyticsProvider>
        )
      ).not.toThrow();

      await waitFor(() => {
        expect(mockInitAnalytics).toHaveBeenCalled();
      });
    });
  });

  describe('context values with consent', () => {
    it('should have isEnabled=true when consent given', () => {
      // Arrange
      const mockClient = createMockClient(true);
      mockGetAnalyticsClient.mockReturnValue(mockClient);
      mockUseHasOptionalConsent.mockReturnValue(true);

      // Act & Assert
      renderWithContext((value) => {
        expect(value.isEnabled).toBe(true);
      });
    });

    it('should have isReady=true when client is ready', () => {
      // Arrange
      const mockClient = createMockClient(true);
      mockGetAnalyticsClient.mockReturnValue(mockClient);
      mockUseHasOptionalConsent.mockReturnValue(true);

      // Act & Assert
      renderWithContext((value) => {
        expect(value.isReady).toBe(true);
      });
    });

    it('should call client.track when tracking event', async () => {
      // Arrange
      const mockClient = createMockClient(true);
      const successResult: TrackResult = { success: true };
      mockTrack.mockResolvedValue(successResult);
      mockGetAnalyticsClient.mockReturnValue(mockClient);
      mockUseHasOptionalConsent.mockReturnValue(true);

      let trackFn: AnalyticsContextValue['track'] | null = null;

      const TestComponent = () => {
        const value = useContext(AnalyticsContext);
        if (value) {
          // eslint-disable-next-line react-hooks/globals
          trackFn = value.track;
        }
        return null;
      };

      render(
        <AnalyticsProvider>
          <TestComponent />
        </AnalyticsProvider>
      );

      // Act
      const result = await trackFn!('test_event', { foo: 'bar' });

      // Assert
      expect(mockTrack).toHaveBeenCalledWith('test_event', { foo: 'bar' });
      expect(result).toEqual(successResult);
    });

    it('should call client.identify when identifying user', async () => {
      // Arrange
      const mockClient = createMockClient(true);
      const successResult: TrackResult = { success: true };
      mockIdentify.mockResolvedValue(successResult);
      mockGetAnalyticsClient.mockReturnValue(mockClient);
      mockUseHasOptionalConsent.mockReturnValue(true);

      let identifyFn: AnalyticsContextValue['identify'] | null = null;

      const TestComponent = () => {
        const value = useContext(AnalyticsContext);
        if (value) {
          // eslint-disable-next-line react-hooks/globals
          identifyFn = value.identify;
        }
        return null;
      };

      render(
        <AnalyticsProvider>
          <TestComponent />
        </AnalyticsProvider>
      );

      // Act
      const result = await identifyFn!('user-123', { email: 'test@example.com' });

      // Assert
      expect(mockIdentify).toHaveBeenCalledWith('user-123', { email: 'test@example.com' });
      expect(result).toEqual(successResult);
    });

    it('should call client.page when tracking page', async () => {
      // Arrange
      const mockClient = createMockClient(true);
      const successResult: TrackResult = { success: true };
      mockPage.mockResolvedValue(successResult);
      mockGetAnalyticsClient.mockReturnValue(mockClient);
      mockUseHasOptionalConsent.mockReturnValue(true);

      let pageFn: AnalyticsContextValue['page'] | null = null;

      const TestComponent = () => {
        const value = useContext(AnalyticsContext);
        if (value) {
          // eslint-disable-next-line react-hooks/globals
          pageFn = value.page;
        }
        return null;
      };

      render(
        <AnalyticsProvider>
          <TestComponent />
        </AnalyticsProvider>
      );

      // Act
      const result = await pageFn!('Home', { path: '/' });

      // Assert
      expect(mockPage).toHaveBeenCalledWith('Home', { path: '/' });
      expect(result).toEqual(successResult);
    });

    it('should call client.reset when resetting', async () => {
      // Arrange
      const mockClient = createMockClient(true);
      const successResult: TrackResult = { success: true };
      mockReset.mockResolvedValue(successResult);
      mockGetAnalyticsClient.mockReturnValue(mockClient);
      mockUseHasOptionalConsent.mockReturnValue(true);

      let resetFn: AnalyticsContextValue['reset'] | null = null;

      const TestComponent = () => {
        const value = useContext(AnalyticsContext);
        if (value) {
          // eslint-disable-next-line react-hooks/globals
          resetFn = value.reset;
        }
        return null;
      };

      render(
        <AnalyticsProvider>
          <TestComponent />
        </AnalyticsProvider>
      );

      // Act
      const result = await resetFn!();

      // Assert
      expect(mockReset).toHaveBeenCalledTimes(1);
      expect(result).toEqual(successResult);
    });
  });

  describe('consent revocation', () => {
    it('should reset analytics when consent is revoked', async () => {
      // Arrange
      const mockClient = createMockClient(true);
      mockReset.mockResolvedValue({ success: true });
      mockGetAnalyticsClient.mockReturnValue(mockClient);

      // Start with consent
      mockUseHasOptionalConsent.mockReturnValue(true);

      const { rerender } = render(
        <AnalyticsProvider>
          <div>Test</div>
        </AnalyticsProvider>
      );

      // Act - Revoke consent
      mockUseHasOptionalConsent.mockReturnValue(false);
      rerender(
        <AnalyticsProvider>
          <div>Test</div>
        </AnalyticsProvider>
      );

      // Assert
      await waitFor(() => {
        expect(mockReset).toHaveBeenCalled();
        expect(mockResetAnalyticsClient).toHaveBeenCalled();
      });
    });

    it('should not reset if client is not ready', async () => {
      // Arrange
      const mockClient = createMockClient(false); // Not ready
      mockGetAnalyticsClient.mockReturnValue(mockClient);

      // Start with consent
      mockUseHasOptionalConsent.mockReturnValue(true);

      const { rerender } = render(
        <AnalyticsProvider>
          <div>Test</div>
        </AnalyticsProvider>
      );

      // Act - Revoke consent
      mockUseHasOptionalConsent.mockReturnValue(false);
      rerender(
        <AnalyticsProvider>
          <div>Test</div>
        </AnalyticsProvider>
      );

      // Assert
      expect(mockReset).not.toHaveBeenCalled();
      expect(mockResetAnalyticsClient).toHaveBeenCalled(); // Still resets the client singleton
    });

    it('should handle reset errors silently', async () => {
      // Arrange
      const mockClient = createMockClient(true);
      mockReset.mockRejectedValue(new Error('Reset failed'));
      mockGetAnalyticsClient.mockReturnValue(mockClient);

      // Start with consent
      mockUseHasOptionalConsent.mockReturnValue(true);

      const { rerender } = render(
        <AnalyticsProvider>
          <div>Test</div>
        </AnalyticsProvider>
      );

      // Act - Revoke consent
      mockUseHasOptionalConsent.mockReturnValue(false);

      // Assert - should not throw
      expect(() =>
        rerender(
          <AnalyticsProvider>
            <div>Test</div>
          </AnalyticsProvider>
        )
      ).not.toThrow();

      await waitFor(() => {
        expect(mockReset).toHaveBeenCalled();
      });
    });
  });

  describe('error handling', () => {
    it('should return error result if client is not ready', async () => {
      // Arrange
      const mockClient = createMockClient(false); // Not ready
      mockGetAnalyticsClient.mockReturnValue(mockClient);
      mockUseHasOptionalConsent.mockReturnValue(true);

      let trackFn: AnalyticsContextValue['track'] | null = null;
      let identifyFn: AnalyticsContextValue['identify'] | null = null;
      let pageFn: AnalyticsContextValue['page'] | null = null;
      let resetFn: AnalyticsContextValue['reset'] | null = null;

      const TestComponent = () => {
        const value = useContext(AnalyticsContext);
        if (value) {
          // eslint-disable-next-line react-hooks/globals
          trackFn = value.track;
          // eslint-disable-next-line react-hooks/globals
          identifyFn = value.identify;
          // eslint-disable-next-line react-hooks/globals
          pageFn = value.page;
          // eslint-disable-next-line react-hooks/globals
          resetFn = value.reset;
        }
        return null;
      };

      render(
        <AnalyticsProvider>
          <TestComponent />
        </AnalyticsProvider>
      );

      // Act
      const trackResult = await trackFn!('test_event');
      const identifyResult = await identifyFn!('user-123');
      const pageResult = await pageFn!('Home');
      const resetResult = await resetFn!();

      // Assert
      expect(trackResult).toEqual({ success: false, error: 'Analytics not ready' });
      expect(identifyResult).toEqual({ success: false, error: 'Analytics not ready' });
      expect(pageResult).toEqual({ success: false, error: 'Analytics not ready' });
      expect(resetResult).toEqual({ success: false, error: 'Analytics not ready' });
    });

    it('should catch and return error from track', async () => {
      // Arrange
      const mockClient = createMockClient(true);
      const mockError = new Error('Track failed');
      mockTrack.mockRejectedValue(mockError);
      mockGetAnalyticsClient.mockReturnValue(mockClient);
      mockUseHasOptionalConsent.mockReturnValue(true);

      let trackFn: AnalyticsContextValue['track'] | null = null;

      const TestComponent = () => {
        const value = useContext(AnalyticsContext);
        if (value) {
          // eslint-disable-next-line react-hooks/globals
          trackFn = value.track;
        }
        return null;
      };

      render(
        <AnalyticsProvider>
          <TestComponent />
        </AnalyticsProvider>
      );

      // Act
      const result = await trackFn!('test_event');

      // Assert
      expect(result).toEqual({ success: false, error: 'Error: Track failed' });
    });

    it('should catch and return error from identify', async () => {
      // Arrange
      const mockClient = createMockClient(true);
      const mockError = new Error('Identify failed');
      mockIdentify.mockRejectedValue(mockError);
      mockGetAnalyticsClient.mockReturnValue(mockClient);
      mockUseHasOptionalConsent.mockReturnValue(true);

      let identifyFn: AnalyticsContextValue['identify'] | null = null;

      const TestComponent = () => {
        const value = useContext(AnalyticsContext);
        if (value) {
          // eslint-disable-next-line react-hooks/globals
          identifyFn = value.identify;
        }
        return null;
      };

      render(
        <AnalyticsProvider>
          <TestComponent />
        </AnalyticsProvider>
      );

      // Act
      const result = await identifyFn!('user-123');

      // Assert
      expect(result).toEqual({ success: false, error: 'Error: Identify failed' });
    });

    it('should catch and return error from page', async () => {
      // Arrange
      const mockClient = createMockClient(true);
      const mockError = new Error('Page failed');
      mockPage.mockRejectedValue(mockError);
      mockGetAnalyticsClient.mockReturnValue(mockClient);
      mockUseHasOptionalConsent.mockReturnValue(true);

      let pageFn: AnalyticsContextValue['page'] | null = null;

      const TestComponent = () => {
        const value = useContext(AnalyticsContext);
        if (value) {
          // eslint-disable-next-line react-hooks/globals
          pageFn = value.page;
        }
        return null;
      };

      render(
        <AnalyticsProvider>
          <TestComponent />
        </AnalyticsProvider>
      );

      // Act
      const result = await pageFn!('Home');

      // Assert
      expect(result).toEqual({ success: false, error: 'Error: Page failed' });
    });

    it('should catch and return error from reset', async () => {
      // Arrange
      const mockClient = createMockClient(true);
      const mockError = new Error('Reset failed');
      mockReset.mockRejectedValue(mockError);
      mockGetAnalyticsClient.mockReturnValue(mockClient);
      mockUseHasOptionalConsent.mockReturnValue(true);

      let resetFn: AnalyticsContextValue['reset'] | null = null;

      const TestComponent = () => {
        const value = useContext(AnalyticsContext);
        if (value) {
          // eslint-disable-next-line react-hooks/globals
          resetFn = value.reset;
        }
        return null;
      };

      render(
        <AnalyticsProvider>
          <TestComponent />
        </AnalyticsProvider>
      );

      // Act
      const result = await resetFn!();

      // Assert
      expect(result).toEqual({ success: false, error: 'Error: Reset failed' });
    });
  });

  describe('provider name', () => {
    it('should return provider name from getAnalyticsProviderName', () => {
      // Arrange
      mockGetAnalyticsClient.mockReturnValue(null);
      mockUseHasOptionalConsent.mockReturnValue(false);
      mockGetAnalyticsProviderName.mockReturnValue('posthog');

      // Act & Assert
      renderWithContext((value) => {
        expect(value.providerName).toBe('posthog');
      });
    });

    it('should return null if no provider name', () => {
      // Arrange
      mockGetAnalyticsClient.mockReturnValue(null);
      mockUseHasOptionalConsent.mockReturnValue(false);
      mockGetAnalyticsProviderName.mockReturnValue(null);

      // Act & Assert
      renderWithContext((value) => {
        expect(value.providerName).toBe(null);
      });
    });
  });
});
