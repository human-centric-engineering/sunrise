import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ANALYTICS_PROVIDER_ENV,
  GA4_ENV,
  POSTHOG_ENV,
  PLAUSIBLE_ENV,
  DEFAULT_POSTHOG_HOST,
  DEFAULT_PLAUSIBLE_HOST,
  isBrowser,
  isDevelopment,
  getExplicitProvider,
  isGA4Configured,
  getGA4Config,
  isPostHogConfigured,
  getPostHogConfig,
  isPlausibleConfigured,
  getPlausibleConfig,
  detectProvider,
  isAnalyticsEnabled,
} from '@/lib/analytics/config';

describe('lib/analytics/config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('constants', () => {
    it('should export correct environment variable names', () => {
      expect(ANALYTICS_PROVIDER_ENV).toBe('NEXT_PUBLIC_ANALYTICS_PROVIDER');
      expect(GA4_ENV.MEASUREMENT_ID).toBe('NEXT_PUBLIC_GA4_MEASUREMENT_ID');
      expect(GA4_ENV.API_SECRET).toBe('GA4_API_SECRET');
      expect(POSTHOG_ENV.KEY).toBe('NEXT_PUBLIC_POSTHOG_KEY');
      expect(POSTHOG_ENV.HOST).toBe('NEXT_PUBLIC_POSTHOG_HOST');
      expect(PLAUSIBLE_ENV.DOMAIN).toBe('NEXT_PUBLIC_PLAUSIBLE_DOMAIN');
      expect(PLAUSIBLE_ENV.HOST).toBe('NEXT_PUBLIC_PLAUSIBLE_HOST');
    });

    it('should export correct default hosts', () => {
      expect(DEFAULT_POSTHOG_HOST).toBe('https://us.i.posthog.com');
      expect(DEFAULT_PLAUSIBLE_HOST).toBe('https://plausible.io');
    });
  });

  describe('isBrowser', () => {
    it('should return true when window is defined', () => {
      // In vitest environment, window is defined
      expect(isBrowser()).toBe(true);
    });
  });

  describe('isDevelopment', () => {
    it('should return true when NODE_ENV is development', () => {
      vi.stubEnv('NODE_ENV', 'development');

      expect(isDevelopment()).toBe(true);
    });

    it('should return false when NODE_ENV is production', () => {
      vi.stubEnv('NODE_ENV', 'production');

      expect(isDevelopment()).toBe(false);
    });

    it('should return false when NODE_ENV is test', () => {
      vi.stubEnv('NODE_ENV', 'test');

      expect(isDevelopment()).toBe(false);
    });
  });

  describe('getExplicitProvider', () => {
    it('should return ga4 when explicitly set', () => {
      vi.stubEnv('NEXT_PUBLIC_ANALYTICS_PROVIDER', 'ga4');

      expect(getExplicitProvider()).toBe('ga4');
    });

    it('should return posthog when explicitly set', () => {
      vi.stubEnv('NEXT_PUBLIC_ANALYTICS_PROVIDER', 'posthog');

      expect(getExplicitProvider()).toBe('posthog');
    });

    it('should return plausible when explicitly set', () => {
      vi.stubEnv('NEXT_PUBLIC_ANALYTICS_PROVIDER', 'plausible');

      expect(getExplicitProvider()).toBe('plausible');
    });

    it('should return console when explicitly set', () => {
      vi.stubEnv('NEXT_PUBLIC_ANALYTICS_PROVIDER', 'console');

      expect(getExplicitProvider()).toBe('console');
    });

    it('should return undefined when not set', () => {
      // When env var is empty string, it's treated as falsy and returns undefined
      // but vi.stubEnv with empty string actually sets it to empty string
      vi.unstubAllEnvs(); // Don't stub - let it be truly undefined

      expect(getExplicitProvider()).toBeUndefined();
    });

    it('should return undefined and warn for unknown provider', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.stubEnv('NEXT_PUBLIC_ANALYTICS_PROVIDER', 'unknown');

      const result = getExplicitProvider();

      expect(result).toBeUndefined();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[analytics] Unknown provider: unknown. Using auto-detection.'
      );

      consoleWarnSpy.mockRestore();
    });
  });

  describe('GA4 configuration', () => {
    describe('isGA4Configured', () => {
      it('should return true when GA4 measurement ID is set', () => {
        vi.stubEnv('NEXT_PUBLIC_GA4_MEASUREMENT_ID', 'G-XXXXXXXXXX');

        expect(isGA4Configured()).toBe(true);
      });

      it('should return false when GA4 measurement ID is not set', () => {
        vi.stubEnv('NEXT_PUBLIC_GA4_MEASUREMENT_ID', '');

        expect(isGA4Configured()).toBe(false);
      });
    });

    describe('getGA4Config', () => {
      it('should return config with measurement ID only', () => {
        vi.stubEnv('NEXT_PUBLIC_GA4_MEASUREMENT_ID', 'G-XXXXXXXXXX');
        // API_SECRET not stubbed - will be undefined

        const config = getGA4Config();

        // Empty string is treated as defined, so we check for the value returned
        expect(config).toBeTruthy();
        expect(config?.measurementId).toBe('G-XXXXXXXXXX');
        // API secret can be undefined or empty string depending on environment
        expect(config?.apiSecret === undefined || config?.apiSecret === '').toBe(true);
      });

      it('should return config with measurement ID and API secret', () => {
        vi.stubEnv('NEXT_PUBLIC_GA4_MEASUREMENT_ID', 'G-XXXXXXXXXX');
        vi.stubEnv('GA4_API_SECRET', 'secret-key');

        const config = getGA4Config();

        expect(config).toEqual({
          measurementId: 'G-XXXXXXXXXX',
          apiSecret: 'secret-key',
        });
      });

      it('should return null when measurement ID is not set', () => {
        vi.stubEnv('NEXT_PUBLIC_GA4_MEASUREMENT_ID', '');

        expect(getGA4Config()).toBeNull();
      });
    });
  });

  describe('PostHog configuration', () => {
    describe('isPostHogConfigured', () => {
      it('should return true when PostHog key is set', () => {
        vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_xxxxxxxxxx');

        expect(isPostHogConfigured()).toBe(true);
      });

      it('should return false when PostHog key is not set', () => {
        vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');

        expect(isPostHogConfigured()).toBe(false);
      });
    });

    describe('getPostHogConfig', () => {
      it('should return config with default host', () => {
        vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_xxxxxxxxxx');
        vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', '');

        const config = getPostHogConfig();

        expect(config).toEqual({
          apiKey: 'phc_xxxxxxxxxx',
          host: DEFAULT_POSTHOG_HOST,
        });
      });

      it('should return config with custom host', () => {
        vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_xxxxxxxxxx');
        vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', 'https://custom.posthog.com');

        const config = getPostHogConfig();

        expect(config).toEqual({
          apiKey: 'phc_xxxxxxxxxx',
          host: 'https://custom.posthog.com',
        });
      });

      it('should return null when API key is not set', () => {
        vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');

        expect(getPostHogConfig()).toBeNull();
      });
    });
  });

  describe('Plausible configuration', () => {
    describe('isPlausibleConfigured', () => {
      it('should return true when Plausible domain is set', () => {
        vi.stubEnv('NEXT_PUBLIC_PLAUSIBLE_DOMAIN', 'example.com');

        expect(isPlausibleConfigured()).toBe(true);
      });

      it('should return false when Plausible domain is not set', () => {
        vi.stubEnv('NEXT_PUBLIC_PLAUSIBLE_DOMAIN', '');

        expect(isPlausibleConfigured()).toBe(false);
      });
    });

    describe('getPlausibleConfig', () => {
      it('should return config with default host', () => {
        vi.stubEnv('NEXT_PUBLIC_PLAUSIBLE_DOMAIN', 'example.com');
        vi.stubEnv('NEXT_PUBLIC_PLAUSIBLE_HOST', '');

        const config = getPlausibleConfig();

        expect(config).toEqual({
          domain: 'example.com',
          host: DEFAULT_PLAUSIBLE_HOST,
        });
      });

      it('should return config with custom host', () => {
        vi.stubEnv('NEXT_PUBLIC_PLAUSIBLE_DOMAIN', 'example.com');
        vi.stubEnv('NEXT_PUBLIC_PLAUSIBLE_HOST', 'https://custom.plausible.com');

        const config = getPlausibleConfig();

        expect(config).toEqual({
          domain: 'example.com',
          host: 'https://custom.plausible.com',
        });
      });

      it('should return null when domain is not set', () => {
        vi.stubEnv('NEXT_PUBLIC_PLAUSIBLE_DOMAIN', '');

        expect(getPlausibleConfig()).toBeNull();
      });
    });
  });

  describe('detectProvider', () => {
    it('should return explicit provider when set', () => {
      vi.stubEnv('NEXT_PUBLIC_ANALYTICS_PROVIDER', 'ga4');
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_xxxxxxxxxx'); // PostHog configured but not used

      expect(detectProvider()).toBe('ga4');
    });

    it('should auto-detect PostHog when configured (highest priority)', () => {
      vi.stubEnv('NEXT_PUBLIC_ANALYTICS_PROVIDER', '');
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_xxxxxxxxxx');
      vi.stubEnv('NEXT_PUBLIC_GA4_MEASUREMENT_ID', 'G-XXXXXXXXXX'); // GA4 also configured

      expect(detectProvider()).toBe('posthog');
    });

    it('should auto-detect GA4 when PostHog is not configured', () => {
      vi.stubEnv('NEXT_PUBLIC_ANALYTICS_PROVIDER', '');
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
      vi.stubEnv('NEXT_PUBLIC_GA4_MEASUREMENT_ID', 'G-XXXXXXXXXX');
      vi.stubEnv('NEXT_PUBLIC_PLAUSIBLE_DOMAIN', 'example.com'); // Plausible also configured

      expect(detectProvider()).toBe('ga4');
    });

    it('should auto-detect Plausible when PostHog and GA4 are not configured', () => {
      vi.stubEnv('NEXT_PUBLIC_ANALYTICS_PROVIDER', '');
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
      vi.stubEnv('NEXT_PUBLIC_GA4_MEASUREMENT_ID', '');
      vi.stubEnv('NEXT_PUBLIC_PLAUSIBLE_DOMAIN', 'example.com');

      expect(detectProvider()).toBe('plausible');
    });

    it('should fallback to console in development when no provider is configured', () => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('NEXT_PUBLIC_ANALYTICS_PROVIDER', '');
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
      vi.stubEnv('NEXT_PUBLIC_GA4_MEASUREMENT_ID', '');
      vi.stubEnv('NEXT_PUBLIC_PLAUSIBLE_DOMAIN', '');

      expect(detectProvider()).toBe('console');
    });

    it('should return null in production when no provider is configured', () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('NEXT_PUBLIC_ANALYTICS_PROVIDER', '');
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
      vi.stubEnv('NEXT_PUBLIC_GA4_MEASUREMENT_ID', '');
      vi.stubEnv('NEXT_PUBLIC_PLAUSIBLE_DOMAIN', '');

      expect(detectProvider()).toBeNull();
    });

    it('should prefer explicit provider over auto-detection', () => {
      vi.stubEnv('NEXT_PUBLIC_ANALYTICS_PROVIDER', 'plausible');
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_xxxxxxxxxx'); // PostHog configured
      vi.stubEnv('NEXT_PUBLIC_GA4_MEASUREMENT_ID', 'G-XXXXXXXXXX'); // GA4 configured
      vi.stubEnv('NEXT_PUBLIC_PLAUSIBLE_DOMAIN', 'example.com'); // Plausible configured

      expect(detectProvider()).toBe('plausible');
    });

    it('should handle console as explicit provider', () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('NEXT_PUBLIC_ANALYTICS_PROVIDER', 'console');

      expect(detectProvider()).toBe('console');
    });
  });

  describe('isAnalyticsEnabled', () => {
    it('should return true when a provider is detected', () => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('NEXT_PUBLIC_ANALYTICS_PROVIDER', '');

      expect(isAnalyticsEnabled()).toBe(true);
    });

    it('should return false when no provider is detected', () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('NEXT_PUBLIC_ANALYTICS_PROVIDER', '');
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
      vi.stubEnv('NEXT_PUBLIC_GA4_MEASUREMENT_ID', '');
      vi.stubEnv('NEXT_PUBLIC_PLAUSIBLE_DOMAIN', '');

      expect(isAnalyticsEnabled()).toBe(false);
    });
  });

  describe('provider detection priority', () => {
    it('should prioritize: explicit > PostHog > GA4 > Plausible > console (dev)', () => {
      // Test 1: Explicit provider wins
      vi.stubEnv('NEXT_PUBLIC_ANALYTICS_PROVIDER', 'ga4');
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_xxxxxxxxxx');
      expect(detectProvider()).toBe('ga4');

      // Test 2: PostHog wins when no explicit provider
      vi.stubEnv('NEXT_PUBLIC_ANALYTICS_PROVIDER', '');
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_xxxxxxxxxx');
      vi.stubEnv('NEXT_PUBLIC_GA4_MEASUREMENT_ID', 'G-XXXXXXXXXX');
      vi.stubEnv('NEXT_PUBLIC_PLAUSIBLE_DOMAIN', 'example.com');
      expect(detectProvider()).toBe('posthog');

      // Test 3: GA4 wins when PostHog not configured
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
      vi.stubEnv('NEXT_PUBLIC_GA4_MEASUREMENT_ID', 'G-XXXXXXXXXX');
      vi.stubEnv('NEXT_PUBLIC_PLAUSIBLE_DOMAIN', 'example.com');
      expect(detectProvider()).toBe('ga4');

      // Test 4: Plausible wins when PostHog and GA4 not configured
      vi.stubEnv('NEXT_PUBLIC_GA4_MEASUREMENT_ID', '');
      vi.stubEnv('NEXT_PUBLIC_PLAUSIBLE_DOMAIN', 'example.com');
      expect(detectProvider()).toBe('plausible');

      // Test 5: Console in development when nothing configured
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('NEXT_PUBLIC_PLAUSIBLE_DOMAIN', '');
      expect(detectProvider()).toBe('console');
    });
  });
});
