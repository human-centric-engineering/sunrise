import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PostHogProvider, createPostHogProvider } from '@/lib/analytics/providers/posthog';

// Mock PostHog instance
interface MockPostHogInstance {
  init: ReturnType<typeof vi.fn>;
  capture: ReturnType<typeof vi.fn>;
  identify: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  isFeatureEnabled: ReturnType<typeof vi.fn>;
  getFeatureFlag: ReturnType<typeof vi.fn>;
  onFeatureFlags: ReturnType<typeof vi.fn>;
}

describe('lib/analytics/providers/posthog', () => {
  // Mock PostHog instance
  let mockPostHog: MockPostHogInstance;
  let originalPostHog: unknown;

  beforeEach(() => {
    vi.clearAllMocks();

    // Save original posthog
    originalPostHog = (global as typeof globalThis & { window?: Window }).window?.posthog;

    // Create mock PostHog instance
    mockPostHog = {
      init: vi.fn(),
      capture: vi.fn(),
      identify: vi.fn(),
      reset: vi.fn(),
      isFeatureEnabled: vi.fn(),
      getFeatureFlag: vi.fn(),
      onFeatureFlags: vi.fn(),
    };

    // Setup mock on window
    if (typeof window !== 'undefined') {
      // Type assertion needed to override the PostHog instance type in tests

      (window as any).posthog = mockPostHog;
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore original posthog
    if (typeof window !== 'undefined' && originalPostHog !== undefined) {
      // Type assertion needed to restore the PostHog instance in tests

      (window as any).posthog = originalPostHog;
    }
  });

  describe('PostHogProvider', () => {
    describe('constructor', () => {
      it('should initialize with API key', () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });

        expect(provider.name).toBe('PostHog');
        expect(provider.type).toBe('posthog');
        expect(provider.getApiKey()).toBe('phc_test123');
      });

      it('should use default host when not provided', () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });

        expect(provider.getHost()).toBe('https://us.i.posthog.com');
      });

      it('should use custom host when provided', () => {
        const provider = new PostHogProvider({
          apiKey: 'phc_test123',
          host: 'https://eu.i.posthog.com',
        });

        expect(provider.getHost()).toBe('https://eu.i.posthog.com');
      });

      it('should disable session recording by default (privacy-first)', () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });

        const features = provider.getFeatures();
        expect(features.supportsSessionReplay).toBe(false);
      });

      it('should enable session recording when configured', () => {
        const provider = new PostHogProvider({
          apiKey: 'phc_test123',
          enableSessionRecording: true,
        });

        const features = provider.getFeatures();
        expect(features.supportsSessionReplay).toBe(true);
      });
    });

    describe('init', () => {
      it('should initialize PostHog with correct config', async () => {
        const provider = new PostHogProvider({
          apiKey: 'phc_test123',
          host: 'https://app.posthog.com',
        });

        await provider.init();

        expect(provider.isReady()).toBe(true);
        expect(mockPostHog.init).toHaveBeenCalledWith('phc_test123', {
          api_host: 'https://app.posthog.com',
          capture_pageview: false,
          capture_pageleave: true,
          disable_session_recording: true,
          loaded: expect.any(Function),
        });
      });

      it('should disable session recording by default', async () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });

        await provider.init();

        expect(mockPostHog.init).toHaveBeenCalledWith(
          'phc_test123',
          expect.objectContaining({
            disable_session_recording: true,
          })
        );
      });

      it('should enable session recording when configured', async () => {
        const provider = new PostHogProvider({
          apiKey: 'phc_test123',
          enableSessionRecording: true,
        });

        await provider.init();

        expect(mockPostHog.init).toHaveBeenCalledWith(
          'phc_test123',
          expect.objectContaining({
            disable_session_recording: false,
          })
        );
      });

      it('should disable automatic page views by default', async () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });

        await provider.init();

        expect(mockPostHog.init).toHaveBeenCalledWith(
          'phc_test123',
          expect.objectContaining({
            capture_pageview: false,
          })
        );
      });

      it('should enable automatic page views when configured', async () => {
        const provider = new PostHogProvider({
          apiKey: 'phc_test123',
          disableAutoPageViews: false,
        });

        await provider.init();

        expect(mockPostHog.init).toHaveBeenCalledWith(
          'phc_test123',
          expect.objectContaining({
            capture_pageview: true,
          })
        );
      });

      it('should be idempotent - calling init twice should not reinitialize', async () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });

        await provider.init();
        mockPostHog.init.mockClear();
        await provider.init();

        expect(mockPostHog.init).not.toHaveBeenCalled();
      });

      it('should set ready flag to true', async () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });

        expect(provider.isReady()).toBe(false);
        await provider.init();
        expect(provider.isReady()).toBe(true);
      });
    });

    describe('identify', () => {
      it('should return error if not initialized', async () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });

        const result = await provider.identify('user-123');

        expect(result).toEqual({ success: false, error: 'PostHog not initialized' });
        expect(mockPostHog.identify).not.toHaveBeenCalled();
      });

      it('should identify user with userId only', async () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });
        await provider.init();

        const result = await provider.identify('user-123');

        expect(result).toEqual({ success: true });
        expect(mockPostHog.identify).toHaveBeenCalledWith('user-123', {});
      });

      it('should identify user with traits', async () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });
        await provider.init();

        const traits = {
          email: 'user@example.com',
          name: 'John Doe',
          firstName: 'John',
          lastName: 'Doe',
          createdAt: '2024-01-01',
          plan: 'pro',
          company: 'Acme Inc',
        };

        const result = await provider.identify('user-123', traits);

        expect(result).toEqual({ success: true });
        expect(mockPostHog.identify).toHaveBeenCalledWith('user-123', {
          email: 'user@example.com',
          name: 'John Doe',
          first_name: 'John',
          last_name: 'Doe',
          created_at: '2024-01-01',
          plan: 'pro',
          company: 'Acme Inc',
        });
      });

      it('should map trait names to PostHog person properties', async () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });
        await provider.init();

        const traits = {
          firstName: 'John',
          lastName: 'Doe',
          createdAt: new Date('2024-01-01'),
        };

        await provider.identify('user-123', traits);

        expect(mockPostHog.identify).toHaveBeenCalledWith(
          'user-123',
          expect.objectContaining({
            first_name: 'John',
            last_name: 'Doe',
            created_at: expect.any(Date),
          })
        );
      });

      it('should include custom traits', async () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });
        await provider.init();

        const traits = {
          email: 'user@example.com',
          customField: 'customValue',
          anotherField: 123,
        };

        await provider.identify('user-123', traits);

        expect(mockPostHog.identify).toHaveBeenCalledWith(
          'user-123',
          expect.objectContaining({
            email: 'user@example.com',
            customField: 'customValue',
            anotherField: 123,
          })
        );
      });

      it('should only set defined trait properties', async () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });
        await provider.init();

        const traits = {
          email: 'user@example.com',
          // Other fields not provided
        };

        await provider.identify('user-123', traits);

        expect(mockPostHog.identify).toHaveBeenCalledWith('user-123', {
          email: 'user@example.com',
        });
      });
    });

    describe('track', () => {
      it('should return error if not initialized', async () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });

        const result = await provider.track('button_clicked');

        expect(result).toEqual({ success: false, error: 'PostHog not initialized' });
        expect(mockPostHog.capture).not.toHaveBeenCalled();
      });

      it('should track event without properties', async () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });
        await provider.init();

        const result = await provider.track('button_clicked');

        expect(result).toEqual({ success: true });
        expect(mockPostHog.capture).toHaveBeenCalledWith('button_clicked', {});
      });

      it('should track event with properties', async () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });
        await provider.init();

        const properties = {
          buttonId: 'signup',
          category: 'engagement',
          value: 5,
        };

        const result = await provider.track('button_clicked', properties);

        expect(result).toEqual({ success: true });
        expect(mockPostHog.capture).toHaveBeenCalledWith('button_clicked', {
          buttonId: 'signup',
          category: 'engagement',
          value: 5,
        });
      });

      it('should map revenue to $value and $currency', async () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });
        await provider.init();

        const properties = {
          revenue: 99.99,
          currency: 'EUR',
        };

        const result = await provider.track('purchase', properties);

        expect(result).toEqual({ success: true });
        expect(mockPostHog.capture).toHaveBeenCalledWith('purchase', {
          revenue: 99.99,
          currency: 'EUR',
          $value: 99.99,
          $currency: 'EUR',
        });
      });

      it('should default currency to USD when revenue provided without currency', async () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });
        await provider.init();

        const properties = {
          revenue: 49.99,
        };

        const result = await provider.track('purchase', properties);

        expect(result).toEqual({ success: true });
        expect(mockPostHog.capture).toHaveBeenCalledWith('purchase', {
          revenue: 49.99,
          $value: 49.99,
          $currency: 'USD',
        });
      });
    });

    describe('page', () => {
      it('should return error if not initialized', async () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });

        const result = await provider.page();

        expect(result).toEqual({ success: false, error: 'PostHog not initialized' });
        expect(mockPostHog.capture).not.toHaveBeenCalled();
      });

      it('should track pageview with default values', async () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });
        await provider.init();

        const result = await provider.page();

        expect(result).toEqual({ success: true });
        expect(mockPostHog.capture).toHaveBeenCalledWith('$pageview', expect.any(Object));
      });

      it('should track pageview with custom name', async () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });
        await provider.init();

        const result = await provider.page('Dashboard');

        expect(result).toEqual({ success: true });
        expect(mockPostHog.capture).toHaveBeenCalledWith(
          '$pageview',
          expect.objectContaining({
            $title: 'Dashboard',
          })
        );
      });

      it('should track pageview with custom properties', async () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });
        await provider.init();

        const properties = {
          title: 'Dashboard',
          path: '/dashboard',
          url: 'https://example.com/dashboard',
          referrer: 'https://google.com',
        };

        const result = await provider.page('Dashboard', properties);

        expect(result).toEqual({ success: true });
        expect(mockPostHog.capture).toHaveBeenCalledWith(
          '$pageview',
          expect.objectContaining({
            $title: 'Dashboard',
            $pathname: '/dashboard',
            $current_url: 'https://example.com/dashboard',
            $referrer: 'https://google.com',
            title: 'Dashboard',
            path: '/dashboard',
            url: 'https://example.com/dashboard',
            referrer: 'https://google.com',
          })
        );
      });

      it('should use $pageview as event name', async () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });
        await provider.init();

        await provider.page('Test Page');

        expect(mockPostHog.capture).toHaveBeenCalledWith('$pageview', expect.any(Object));
      });
    });

    describe('reset', () => {
      it('should return error if not initialized', async () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });

        const result = await provider.reset();

        expect(result).toEqual({ success: false, error: 'PostHog not initialized' });
        expect(mockPostHog.reset).not.toHaveBeenCalled();
      });

      it('should reset PostHog identity', async () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });
        await provider.init();
        await provider.identify('user-123');

        const result = await provider.reset();

        expect(result).toEqual({ success: true });
        expect(mockPostHog.reset).toHaveBeenCalled();
      });

      it('should handle reset when no user is identified', async () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });
        await provider.init();

        const result = await provider.reset();

        expect(result).toEqual({ success: true });
        expect(mockPostHog.reset).toHaveBeenCalled();
      });
    });

    describe('isReady', () => {
      it('should return false before initialization', () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });

        expect(provider.isReady()).toBe(false);
      });

      it('should return true after initialization', async () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });

        await provider.init();

        expect(provider.isReady()).toBe(true);
      });
    });

    describe('getFeatures', () => {
      it('should return correct feature flags with session recording disabled', () => {
        const provider = new PostHogProvider({ apiKey: 'phc_test123' });

        const features = provider.getFeatures();

        expect(features).toEqual({
          supportsIdentify: true,
          supportsServerSide: true,
          supportsFeatureFlags: true,
          supportsSessionReplay: false,
          supportsCookieless: true,
        });
      });

      it('should return correct feature flags with session recording enabled', () => {
        const provider = new PostHogProvider({
          apiKey: 'phc_test123',
          enableSessionRecording: true,
        });

        const features = provider.getFeatures();

        expect(features).toEqual({
          supportsIdentify: true,
          supportsServerSide: true,
          supportsFeatureFlags: true,
          supportsSessionReplay: true,
          supportsCookieless: true,
        });
      });
    });

    describe('feature flags', () => {
      describe('isFeatureEnabled', () => {
        it('should return false if not initialized', () => {
          const provider = new PostHogProvider({ apiKey: 'phc_test123' });

          const result = provider.isFeatureEnabled('new-feature');

          expect(result).toBe(false);
          expect(mockPostHog.isFeatureEnabled).not.toHaveBeenCalled();
        });

        it('should check feature flag when initialized', async () => {
          const provider = new PostHogProvider({ apiKey: 'phc_test123' });
          await provider.init();
          mockPostHog.isFeatureEnabled.mockReturnValue(true);

          const result = provider.isFeatureEnabled('new-feature');

          expect(result).toBe(true);
          expect(mockPostHog.isFeatureEnabled).toHaveBeenCalledWith('new-feature');
        });

        it('should return false when flag is disabled', async () => {
          const provider = new PostHogProvider({ apiKey: 'phc_test123' });
          await provider.init();
          mockPostHog.isFeatureEnabled.mockReturnValue(false);

          const result = provider.isFeatureEnabled('new-feature');

          expect(result).toBe(false);
        });
      });

      describe('getFeatureFlag', () => {
        it('should return undefined if not initialized', () => {
          const provider = new PostHogProvider({ apiKey: 'phc_test123' });

          const result = provider.getFeatureFlag('variant-test');

          expect(result).toBeUndefined();
          expect(mockPostHog.getFeatureFlag).not.toHaveBeenCalled();
        });

        it('should get feature flag value when initialized', async () => {
          const provider = new PostHogProvider({ apiKey: 'phc_test123' });
          await provider.init();
          mockPostHog.getFeatureFlag.mockReturnValue('variant-a');

          const result = provider.getFeatureFlag('variant-test');

          expect(result).toBe('variant-a');
          expect(mockPostHog.getFeatureFlag).toHaveBeenCalledWith('variant-test');
        });

        it('should return boolean flag value', async () => {
          const provider = new PostHogProvider({ apiKey: 'phc_test123' });
          await provider.init();
          mockPostHog.getFeatureFlag.mockReturnValue(true);

          const result = provider.getFeatureFlag('boolean-flag');

          expect(result).toBe(true);
        });

        it('should return undefined when flag does not exist', async () => {
          const provider = new PostHogProvider({ apiKey: 'phc_test123' });
          await provider.init();
          mockPostHog.getFeatureFlag.mockReturnValue(undefined);

          const result = provider.getFeatureFlag('non-existent-flag');

          expect(result).toBeUndefined();
        });
      });

      describe('onFeatureFlags', () => {
        it('should not call callback if not initialized', () => {
          const provider = new PostHogProvider({ apiKey: 'phc_test123' });
          const callback = vi.fn();

          provider.onFeatureFlags(callback);

          expect(mockPostHog.onFeatureFlags).not.toHaveBeenCalled();
        });

        it('should subscribe to feature flag updates', async () => {
          const provider = new PostHogProvider({ apiKey: 'phc_test123' });
          await provider.init();
          const callback = vi.fn();

          provider.onFeatureFlags(callback);

          expect(mockPostHog.onFeatureFlags).toHaveBeenCalledWith(callback);
        });
      });
    });

    describe('getApiKey', () => {
      it('should return the API key', () => {
        const provider = new PostHogProvider({ apiKey: 'phc_secret123' });

        expect(provider.getApiKey()).toBe('phc_secret123');
      });
    });

    describe('getHost', () => {
      it('should return the host URL', () => {
        const provider = new PostHogProvider({
          apiKey: 'phc_test123',
          host: 'https://eu.i.posthog.com',
        });

        expect(provider.getHost()).toBe('https://eu.i.posthog.com');
      });
    });
  });

  describe('createPostHogProvider', () => {
    it('should create provider instance', () => {
      const provider = createPostHogProvider({ apiKey: 'phc_test123' });

      expect(provider).toBeInstanceOf(PostHogProvider);
      expect(provider.name).toBe('PostHog');
      expect(provider.type).toBe('posthog');
    });

    it('should create provider with custom config', () => {
      const provider = createPostHogProvider({
        apiKey: 'phc_test123',
        host: 'https://eu.i.posthog.com',
        enableSessionRecording: true,
        debug: true,
      });

      expect(provider).toBeInstanceOf(PostHogProvider);
      expect(provider.getApiKey()).toBe('phc_test123');
      expect(provider.getHost()).toBe('https://eu.i.posthog.com');
    });
  });
});
