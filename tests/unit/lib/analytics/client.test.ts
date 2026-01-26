import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock all dependencies
vi.mock('@/lib/analytics/config', () => ({
  detectProvider: vi.fn(),
  getGA4Config: vi.fn(),
  getPostHogConfig: vi.fn(),
  getPlausibleConfig: vi.fn(),
  isBrowser: vi.fn(() => true),
  isDevelopment: vi.fn(() => false),
}));

vi.mock('@/lib/analytics/providers/console', () => ({
  createConsoleProvider: vi.fn(() => ({
    name: 'Console',
    type: 'console',
    init: vi.fn(),
    identify: vi.fn(),
    track: vi.fn(),
    page: vi.fn(),
    reset: vi.fn(),
    isReady: vi.fn(() => true),
    getFeatures: vi.fn(),
  })),
}));

vi.mock('@/lib/analytics/providers/ga4', () => ({
  createGA4Provider: vi.fn(() => ({
    name: 'Google Analytics 4',
    type: 'ga4',
    init: vi.fn(),
    identify: vi.fn(),
    track: vi.fn(),
    page: vi.fn(),
    reset: vi.fn(),
    isReady: vi.fn(() => true),
    getFeatures: vi.fn(),
  })),
}));

vi.mock('@/lib/analytics/providers/posthog', () => ({
  createPostHogProvider: vi.fn(() => ({
    name: 'PostHog',
    type: 'posthog',
    init: vi.fn(),
    identify: vi.fn(),
    track: vi.fn(),
    page: vi.fn(),
    reset: vi.fn(),
    isReady: vi.fn(() => true),
    getFeatures: vi.fn(),
  })),
}));

vi.mock('@/lib/analytics/providers/plausible', () => ({
  createPlausibleProvider: vi.fn(() => ({
    name: 'Plausible',
    type: 'plausible',
    init: vi.fn(),
    identify: vi.fn(),
    track: vi.fn(),
    page: vi.fn(),
    reset: vi.fn(),
    isReady: vi.fn(() => true),
    getFeatures: vi.fn(),
  })),
}));

describe('lib/analytics/client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getAnalyticsClient', () => {
    it('should return null when no provider is detected', async () => {
      const { detectProvider } = await import('@/lib/analytics/config');
      const { getAnalyticsClient, resetAnalyticsClient } = await import('@/lib/analytics/client');

      vi.mocked(detectProvider).mockReturnValue(null);

      resetAnalyticsClient();
      const client = getAnalyticsClient();

      expect(client).toBeNull();
    });

    it('should return console provider when detected', async () => {
      const { detectProvider } = await import('@/lib/analytics/config');
      const { getAnalyticsClient, resetAnalyticsClient } = await import('@/lib/analytics/client');

      vi.mocked(detectProvider).mockReturnValue('console');

      resetAnalyticsClient();
      const client = getAnalyticsClient();

      expect(client).not.toBeNull();
      expect(client?.name).toBe('Console');
    });

    it('should return singleton instance on subsequent calls', async () => {
      const { detectProvider } = await import('@/lib/analytics/config');
      const { getAnalyticsClient, resetAnalyticsClient } = await import('@/lib/analytics/client');

      vi.mocked(detectProvider).mockReturnValue('console');

      resetAnalyticsClient();
      const client1 = getAnalyticsClient();
      const client2 = getAnalyticsClient();

      expect(client1).toBe(client2);
    });

    it('should log debug message when provider is initialized', async () => {
      const consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const { detectProvider, isBrowser } = await import('@/lib/analytics/config');
      const { getAnalyticsClient, resetAnalyticsClient } = await import('@/lib/analytics/client');

      vi.mocked(detectProvider).mockReturnValue('console');
      vi.mocked(isBrowser).mockReturnValue(true);

      resetAnalyticsClient();
      getAnalyticsClient();

      expect(consoleDebugSpy).toHaveBeenCalledWith('[Analytics] Provider initialized: Console');

      consoleDebugSpy.mockRestore();
    });

    it('should log debug message when no provider is configured (browser)', async () => {
      const consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const { detectProvider, isBrowser } = await import('@/lib/analytics/config');
      const { getAnalyticsClient, resetAnalyticsClient } = await import('@/lib/analytics/client');

      vi.mocked(detectProvider).mockReturnValue(null);
      vi.mocked(isBrowser).mockReturnValue(true);

      resetAnalyticsClient();
      getAnalyticsClient();

      expect(consoleDebugSpy).toHaveBeenCalledWith(
        '[Analytics] No analytics provider configured - tracking disabled'
      );

      consoleDebugSpy.mockRestore();
    });

    it('should only log warning once when no provider is configured', async () => {
      const consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const { detectProvider } = await import('@/lib/analytics/config');
      const { getAnalyticsClient, resetAnalyticsClient } = await import('@/lib/analytics/client');

      vi.mocked(detectProvider).mockReturnValue(null);

      resetAnalyticsClient();
      getAnalyticsClient();
      getAnalyticsClient(); // Second call

      expect(consoleDebugSpy).toHaveBeenCalledTimes(1);

      consoleDebugSpy.mockRestore();
    });
  });

  describe('initAnalytics', () => {
    it('should initialize the provider', async () => {
      const { detectProvider } = await import('@/lib/analytics/config');
      const { createConsoleProvider } = await import('@/lib/analytics/providers/console');
      const { initAnalytics, resetAnalyticsClient } = await import('@/lib/analytics/client');

      const mockInit = vi.fn().mockResolvedValue(undefined);
      const mockProvider = {
        name: 'Console',
        type: 'console' as const,
        init: mockInit,
        identify: vi.fn(),
        track: vi.fn(),
        page: vi.fn(),
        reset: vi.fn(),
        isReady: vi.fn(() => true),
        getFeatures: vi.fn(),
      } as any;

      vi.mocked(detectProvider).mockReturnValue('console');
      vi.mocked(createConsoleProvider).mockReturnValue(mockProvider);

      resetAnalyticsClient();
      await initAnalytics();

      expect(mockInit).toHaveBeenCalledOnce();
    });

    it('should return early when no provider is configured', async () => {
      const { detectProvider } = await import('@/lib/analytics/config');
      const { initAnalytics, resetAnalyticsClient } = await import('@/lib/analytics/client');

      vi.mocked(detectProvider).mockReturnValue(null);

      resetAnalyticsClient();
      await expect(initAnalytics()).resolves.toBeUndefined();
    });

    it('should be idempotent - subsequent calls return same promise', async () => {
      const { detectProvider } = await import('@/lib/analytics/config');
      const { createConsoleProvider } = await import('@/lib/analytics/providers/console');
      const { initAnalytics, resetAnalyticsClient } = await import('@/lib/analytics/client');

      const mockInit = vi.fn().mockResolvedValue(undefined);
      const mockProvider = {
        name: 'Console',
        type: 'console' as const,
        init: mockInit,
        identify: vi.fn(),
        track: vi.fn(),
        page: vi.fn(),
        reset: vi.fn(),
        isReady: vi.fn(() => true),
        getFeatures: vi.fn(),
      } as any;

      vi.mocked(detectProvider).mockReturnValue('console');
      vi.mocked(createConsoleProvider).mockReturnValue(mockProvider);

      resetAnalyticsClient();
      const promise1 = initAnalytics();
      const promise2 = initAnalytics();

      // Both calls should await to the same result (idempotent)
      await Promise.all([promise1, promise2]);

      // Init should only be called once despite two initAnalytics calls
      expect(mockInit).toHaveBeenCalledOnce();
    });
  });

  describe('createProvider', () => {
    it('should create console provider', async () => {
      const { detectProvider, isDevelopment } = await import('@/lib/analytics/config');
      const { createConsoleProvider } = await import('@/lib/analytics/providers/console');
      const { getAnalyticsClient, resetAnalyticsClient } = await import('@/lib/analytics/client');

      vi.mocked(detectProvider).mockReturnValue('console');
      vi.mocked(isDevelopment).mockReturnValue(true);

      resetAnalyticsClient();
      const client = getAnalyticsClient();

      expect(createConsoleProvider).toHaveBeenCalledWith({ debug: true });
      expect(client?.name).toBe('Console');
    });

    it('should create GA4 provider with config', async () => {
      const { detectProvider, getGA4Config } = await import('@/lib/analytics/config');
      const { createGA4Provider } = await import('@/lib/analytics/providers/ga4');
      const { getAnalyticsClient, resetAnalyticsClient } = await import('@/lib/analytics/client');

      const mockConfig = { measurementId: 'G-XXXXXXXXXX', apiSecret: 'secret' };

      vi.mocked(detectProvider).mockReturnValue('ga4');
      vi.mocked(getGA4Config).mockReturnValue(mockConfig);

      resetAnalyticsClient();
      const client = getAnalyticsClient();

      expect(createGA4Provider).toHaveBeenCalledWith(mockConfig);
      expect(client?.name).toBe('Google Analytics 4');
    });

    it('should return null when GA4 requested but not configured', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { detectProvider, getGA4Config } = await import('@/lib/analytics/config');
      const { getAnalyticsClient, resetAnalyticsClient } = await import('@/lib/analytics/client');

      vi.mocked(detectProvider).mockReturnValue('ga4');
      vi.mocked(getGA4Config).mockReturnValue(null);

      resetAnalyticsClient();
      const client = getAnalyticsClient();

      expect(client).toBeNull();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[Analytics] GA4 provider requested but not configured',
        expect.objectContaining({ missingVars: ['NEXT_PUBLIC_GA4_MEASUREMENT_ID'] })
      );

      consoleErrorSpy.mockRestore();
    });

    it('should create PostHog provider with config', async () => {
      const { detectProvider, getPostHogConfig } = await import('@/lib/analytics/config');
      const { createPostHogProvider } = await import('@/lib/analytics/providers/posthog');
      const { getAnalyticsClient, resetAnalyticsClient } = await import('@/lib/analytics/client');

      const mockConfig = { apiKey: 'phc_xxxxxxxxxx', host: 'https://us.i.posthog.com' };

      vi.mocked(detectProvider).mockReturnValue('posthog');
      vi.mocked(getPostHogConfig).mockReturnValue(mockConfig);

      resetAnalyticsClient();
      const client = getAnalyticsClient();

      expect(createPostHogProvider).toHaveBeenCalledWith(mockConfig);
      expect(client?.name).toBe('PostHog');
    });

    it('should return null when PostHog requested but not configured', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { detectProvider, getPostHogConfig } = await import('@/lib/analytics/config');
      const { getAnalyticsClient, resetAnalyticsClient } = await import('@/lib/analytics/client');

      vi.mocked(detectProvider).mockReturnValue('posthog');
      vi.mocked(getPostHogConfig).mockReturnValue(null);

      resetAnalyticsClient();
      const client = getAnalyticsClient();

      expect(client).toBeNull();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[Analytics] PostHog provider requested but not configured',
        expect.objectContaining({ missingVars: ['NEXT_PUBLIC_POSTHOG_KEY'] })
      );

      consoleErrorSpy.mockRestore();
    });

    it('should create Plausible provider with config', async () => {
      const { detectProvider, getPlausibleConfig } = await import('@/lib/analytics/config');
      const { createPlausibleProvider } = await import('@/lib/analytics/providers/plausible');
      const { getAnalyticsClient, resetAnalyticsClient } = await import('@/lib/analytics/client');

      const mockConfig = { domain: 'example.com', host: 'https://plausible.io' };

      vi.mocked(detectProvider).mockReturnValue('plausible');
      vi.mocked(getPlausibleConfig).mockReturnValue(mockConfig);

      resetAnalyticsClient();
      const client = getAnalyticsClient();

      expect(createPlausibleProvider).toHaveBeenCalledWith(mockConfig);
      expect(client?.name).toBe('Plausible');
    });

    it('should return null when Plausible requested but not configured', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { detectProvider, getPlausibleConfig } = await import('@/lib/analytics/config');
      const { getAnalyticsClient, resetAnalyticsClient } = await import('@/lib/analytics/client');

      vi.mocked(detectProvider).mockReturnValue('plausible');
      vi.mocked(getPlausibleConfig).mockReturnValue(null);

      resetAnalyticsClient();
      const client = getAnalyticsClient();

      expect(client).toBeNull();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[Analytics] Plausible provider requested but not configured',
        expect.objectContaining({ missingVars: ['NEXT_PUBLIC_PLAUSIBLE_DOMAIN'] })
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('isAnalyticsEnabled', () => {
    it('should return true when client is available', async () => {
      const { detectProvider } = await import('@/lib/analytics/config');
      const { isAnalyticsEnabled, resetAnalyticsClient } = await import('@/lib/analytics/client');

      vi.mocked(detectProvider).mockReturnValue('console');

      resetAnalyticsClient();
      const result = isAnalyticsEnabled();

      expect(result).toBe(true);
    });

    it('should return false when client is not available', async () => {
      const { detectProvider } = await import('@/lib/analytics/config');
      const { isAnalyticsEnabled, resetAnalyticsClient } = await import('@/lib/analytics/client');

      vi.mocked(detectProvider).mockReturnValue(null);

      resetAnalyticsClient();
      const result = isAnalyticsEnabled();

      expect(result).toBe(false);
    });
  });

  describe('getAnalyticsProviderName', () => {
    it('should return provider name when configured', async () => {
      const { detectProvider } = await import('@/lib/analytics/config');
      const { getAnalyticsProviderName, resetAnalyticsClient } =
        await import('@/lib/analytics/client');

      vi.mocked(detectProvider).mockReturnValue('console');

      resetAnalyticsClient();
      const name = getAnalyticsProviderName();

      expect(name).toBe('Console');
    });

    it('should return null when no provider configured', async () => {
      const { detectProvider } = await import('@/lib/analytics/config');
      const { getAnalyticsProviderName, resetAnalyticsClient } =
        await import('@/lib/analytics/client');

      vi.mocked(detectProvider).mockReturnValue(null);

      resetAnalyticsClient();
      const name = getAnalyticsProviderName();

      expect(name).toBeNull();
    });
  });

  describe('resetAnalyticsClient', () => {
    it('should reset client and allow reinitialization', async () => {
      const { detectProvider } = await import('@/lib/analytics/config');
      const { createConsoleProvider } = await import('@/lib/analytics/providers/console');
      const { getAnalyticsClient, resetAnalyticsClient } = await import('@/lib/analytics/client');

      vi.mocked(detectProvider).mockReturnValue('console');

      // Create different mock instances for each call
      const mockProvider1 = {
        name: 'Console',
        type: 'console' as const,
        init: vi.fn(),
        identify: vi.fn(),
        track: vi.fn(),
        page: vi.fn(),
        reset: vi.fn(),
        isReady: vi.fn(() => true),
        getFeatures: vi.fn(),
      } as any;

      const mockProvider2 = {
        name: 'Console',
        type: 'console' as const,
        init: vi.fn(),
        identify: vi.fn(),
        track: vi.fn(),
        page: vi.fn(),
        reset: vi.fn(),
        isReady: vi.fn(() => true),
        getFeatures: vi.fn(),
      } as any;

      // First call returns mockProvider1
      vi.mocked(createConsoleProvider).mockReturnValueOnce(mockProvider1);

      resetAnalyticsClient();
      const client1 = getAnalyticsClient();

      // Second call returns mockProvider2
      vi.mocked(createConsoleProvider).mockReturnValueOnce(mockProvider2);

      resetAnalyticsClient();
      const client2 = getAnalyticsClient();

      // Should be different instances after reset
      expect(client1).not.toBe(client2);
      expect(client2).not.toBeNull();
    });

    it('should reset init promise', async () => {
      const { detectProvider } = await import('@/lib/analytics/config');
      const { createConsoleProvider } = await import('@/lib/analytics/providers/console');
      const { initAnalytics, resetAnalyticsClient } = await import('@/lib/analytics/client');

      const mockInit = vi.fn().mockResolvedValue(undefined);
      const mockProvider = {
        name: 'Console',
        type: 'console' as const,
        init: mockInit,
        identify: vi.fn(),
        track: vi.fn(),
        page: vi.fn(),
        reset: vi.fn(),
        isReady: vi.fn(() => true),
        getFeatures: vi.fn(),
      } as any;

      vi.mocked(detectProvider).mockReturnValue('console');
      vi.mocked(createConsoleProvider).mockReturnValue(mockProvider);

      resetAnalyticsClient();
      await initAnalytics();

      resetAnalyticsClient();
      await initAnalytics();

      // Init should be called twice (once per reset cycle)
      expect(mockInit).toHaveBeenCalledTimes(2);
    });
  });

  describe('provider selection based on environment', () => {
    it('should pass debug=true to console provider in development', async () => {
      const { detectProvider, isDevelopment } = await import('@/lib/analytics/config');
      const { createConsoleProvider } = await import('@/lib/analytics/providers/console');
      const { getAnalyticsClient, resetAnalyticsClient } = await import('@/lib/analytics/client');

      vi.mocked(detectProvider).mockReturnValue('console');
      vi.mocked(isDevelopment).mockReturnValue(true);

      resetAnalyticsClient();
      getAnalyticsClient();

      expect(createConsoleProvider).toHaveBeenCalledWith({ debug: true });
    });

    it('should pass debug=false to console provider in production', async () => {
      const { detectProvider, isDevelopment } = await import('@/lib/analytics/config');
      const { createConsoleProvider } = await import('@/lib/analytics/providers/console');
      const { getAnalyticsClient, resetAnalyticsClient } = await import('@/lib/analytics/client');

      vi.mocked(detectProvider).mockReturnValue('console');
      vi.mocked(isDevelopment).mockReturnValue(false);

      resetAnalyticsClient();
      getAnalyticsClient();

      expect(createConsoleProvider).toHaveBeenCalledWith({ debug: false });
    });
  });
});
