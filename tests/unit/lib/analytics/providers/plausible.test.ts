import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PlausibleProvider, createPlausibleProvider } from '@/lib/analytics/providers/plausible';

// Mock Plausible function
interface MockPlausibleFunction {
  (event: string, options?: PlausibleEventOptions): void;
  q?: unknown[][];
}

interface PlausibleEventOptions {
  callback?: () => void;
  props?: Record<string, string | number | boolean>;
  revenue?: {
    currency: string;
    amount: number;
  };
  u?: string;
}

declare global {
  interface Window {
    plausible: MockPlausibleFunction;
  }
}

describe('lib/analytics/providers/plausible', () => {
  // Mock Plausible function
  let mockPlausible: ReturnType<typeof vi.fn>;
  let originalPlausible: MockPlausibleFunction | undefined;

  beforeEach(() => {
    vi.clearAllMocks();

    // Save original plausible
    originalPlausible = (global as typeof globalThis & { window?: typeof window }).window
      ?.plausible;

    // Create mock Plausible function
    mockPlausible = vi.fn((_event: string, options?: PlausibleEventOptions) => {
      // Simulate callback being called
      if (options?.callback) {
        options.callback();
      }
    });

    // Setup mock on window
    if (typeof window !== 'undefined') {
      window.plausible = mockPlausible as MockPlausibleFunction;
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore original plausible
    if (typeof window !== 'undefined' && originalPlausible !== undefined) {
      window.plausible = originalPlausible;
    }
  });

  describe('PlausibleProvider', () => {
    describe('constructor', () => {
      it('should initialize with domain', () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });

        expect(provider.name).toBe('Plausible');
        expect(provider.type).toBe('plausible');
        expect(provider.getDomain()).toBe('example.com');
      });

      it('should use default host when not provided', () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });

        expect(provider.getHost()).toBe('https://plausible.io');
      });

      it('should use custom host when provided', () => {
        const provider = new PlausibleProvider({
          domain: 'example.com',
          host: 'https://analytics.example.com',
        });

        expect(provider.getHost()).toBe('https://analytics.example.com');
      });

      it('should disable hash mode by default', () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });

        expect(provider.isHashMode()).toBe(false);
      });

      it('should enable hash mode when configured', () => {
        const provider = new PlausibleProvider({ domain: 'example.com', hashMode: true });

        expect(provider.isHashMode()).toBe(true);
      });
    });

    describe('init', () => {
      it('should initialize successfully', async () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });

        await provider.init();

        expect(provider.isReady()).toBe(true);
      });

      it('should be idempotent - calling init twice should not reinitialize', async () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });

        await provider.init();
        const firstReady = provider.isReady();
        await provider.init();

        expect(firstReady).toBe(true);
        expect(provider.isReady()).toBe(true);
      });

      it('should set ready flag to true', async () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });

        expect(provider.isReady()).toBe(false);
        await provider.init();
        expect(provider.isReady()).toBe(true);
      });
    });

    describe('identify', () => {
      it('should be a no-op (privacy-first)', async () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });
        await provider.init();

        const result = await provider.identify('user-123');

        expect(result).toEqual({
          success: true,
          data: { note: 'Plausible does not support user identification' },
        });
        expect(mockPlausible).not.toHaveBeenCalled();
      });

      it('should return success even with traits (no-op)', async () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });
        await provider.init();

        const traits = {
          email: 'user@example.com',
          name: 'John Doe',
          plan: 'pro',
        };

        const result = await provider.identify('user-123', traits);

        expect(result).toEqual({
          success: true,
          data: { note: 'Plausible does not support user identification' },
        });
        expect(mockPlausible).not.toHaveBeenCalled();
      });
    });

    describe('track', () => {
      it('should return error if not initialized', async () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });

        const result = await provider.track('button_clicked');

        expect(result).toEqual({ success: false, error: 'Plausible not initialized' });
        expect(mockPlausible).not.toHaveBeenCalled();
      });

      it('should track event without properties', async () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });
        await provider.init();

        const result = await provider.track('button_clicked');

        expect(result).toEqual({ success: true });
        expect(mockPlausible).toHaveBeenCalledWith('button_clicked', {
          callback: expect.any(Function),
        });
      });

      it('should track event with properties', async () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });
        await provider.init();

        const properties = {
          buttonId: 'signup',
          category: 'engagement',
          value: 5,
        };

        const result = await provider.track('button_clicked', properties);

        expect(result).toEqual({ success: true });
        expect(mockPlausible).toHaveBeenCalledWith('button_clicked', {
          props: {
            buttonId: 'signup',
            category: 'engagement',
            value: 5,
          },
          callback: expect.any(Function),
        });
      });

      it('should only include string, number, and boolean properties', async () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });
        await provider.init();

        const properties = {
          stringProp: 'test',
          numberProp: 123,
          booleanProp: true,
          objectProp: { nested: 'value' }, // Should be filtered out
          arrayProp: [1, 2, 3], // Should be filtered out
          nullProp: null, // Should be filtered out
          undefinedProp: undefined, // Should be filtered out
        };

        const result = await provider.track('test_event', properties);

        expect(result).toEqual({ success: true });
        expect(mockPlausible).toHaveBeenCalledWith('test_event', {
          props: {
            stringProp: 'test',
            numberProp: 123,
            booleanProp: true,
          },
          callback: expect.any(Function),
        });
      });

      it('should handle revenue tracking', async () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });
        await provider.init();

        const properties = {
          revenue: 99.99,
          currency: 'EUR',
        };

        const result = await provider.track('purchase', properties);

        expect(result).toEqual({ success: true });
        expect(mockPlausible).toHaveBeenCalledWith('purchase', {
          props: {
            revenue: 99.99,
            currency: 'EUR',
          },
          revenue: {
            currency: 'EUR',
            amount: 99.99,
          },
          callback: expect.any(Function),
        });
      });

      it('should default currency to USD when revenue provided without currency', async () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });
        await provider.init();

        const properties = {
          revenue: 49.99,
        };

        const result = await provider.track('purchase', properties);

        expect(result).toEqual({ success: true });
        expect(mockPlausible).toHaveBeenCalledWith('purchase', {
          props: {
            revenue: 49.99,
          },
          revenue: {
            currency: 'USD',
            amount: 49.99,
          },
          callback: expect.any(Function),
        });
      });

      it('should resolve promise with success', async () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });
        await provider.init();

        const result = await provider.track('test_event');

        expect(result).toEqual({ success: true });
      });
    });

    describe('page', () => {
      it('should return error if not initialized', async () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });

        const result = await provider.page();

        expect(result).toEqual({ success: false, error: 'Plausible not initialized' });
        expect(mockPlausible).not.toHaveBeenCalled();
      });

      it('should track pageview with default values', async () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });
        await provider.init();

        const result = await provider.page();

        expect(result).toEqual({ success: true });
        expect(mockPlausible).toHaveBeenCalledWith('pageview', {
          callback: expect.any(Function),
        });
      });

      it('should track pageview with custom name (requires properties object)', async () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });
        await provider.init();

        // Note: page_name is only added when properties object is provided
        const result = await provider.page('Dashboard');

        expect(result).toEqual({ success: true });
        expect(mockPlausible).toHaveBeenCalledWith('pageview', {
          callback: expect.any(Function),
        });
      });

      it('should track pageview with custom URL', async () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });
        await provider.init();

        const properties = {
          url: 'https://example.com/dashboard',
        };

        const result = await provider.page('Dashboard', properties);

        expect(result).toEqual({ success: true });
        expect(mockPlausible).toHaveBeenCalledWith('pageview', {
          u: 'https://example.com/dashboard',
          props: {
            page_name: 'Dashboard',
          },
          callback: expect.any(Function),
        });
      });

      it('should track pageview with path (construct URL)', async () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });
        await provider.init();

        const properties = {
          path: '/dashboard',
        };

        const result = await provider.page('Dashboard', properties);

        expect(result).toEqual({ success: true });
        expect(mockPlausible).toHaveBeenCalledWith(
          'pageview',
          expect.objectContaining({
            props: {
              page_name: 'Dashboard',
            },
          })
        );
      });

      it('should track pageview with title property', async () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });
        await provider.init();

        const properties = {
          title: 'My Dashboard',
        };

        const result = await provider.page('Dashboard', properties);

        expect(result).toEqual({ success: true });
        expect(mockPlausible).toHaveBeenCalledWith('pageview', {
          props: {
            page_name: 'Dashboard',
            title: 'My Dashboard',
          },
          callback: expect.any(Function),
        });
      });

      it('should filter out reserved property names', async () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });
        await provider.init();

        const properties = {
          title: 'Dashboard',
          url: 'https://example.com/dashboard',
          path: '/dashboard',
          referrer: 'https://google.com',
          search: '?q=test',
          customProp: 'custom value',
        };

        const result = await provider.page('Dashboard', properties);

        expect(result).toEqual({ success: true });
        expect(mockPlausible).toHaveBeenCalledWith('pageview', {
          u: 'https://example.com/dashboard',
          props: {
            page_name: 'Dashboard',
            title: 'Dashboard',
            customProp: 'custom value',
          },
          callback: expect.any(Function),
        });
      });

      it('should only include string, number, and boolean properties', async () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });
        await provider.init();

        const properties = {
          stringProp: 'test',
          numberProp: 123,
          booleanProp: true,
          objectProp: { nested: 'value' }, // Should be filtered out
          arrayProp: [1, 2, 3], // Should be filtered out
        };

        const result = await provider.page('Test Page', properties);

        expect(result).toEqual({ success: true });
        expect(mockPlausible).toHaveBeenCalledWith('pageview', {
          props: {
            page_name: 'Test Page',
            stringProp: 'test',
            numberProp: 123,
            booleanProp: true,
          },
          callback: expect.any(Function),
        });
      });

      it('should resolve promise with success', async () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });
        await provider.init();

        const result = await provider.page();

        expect(result).toEqual({ success: true });
      });
    });

    describe('reset', () => {
      it('should be a no-op (privacy-first)', async () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });
        await provider.init();
        await provider.identify('user-123');

        const result = await provider.reset();

        expect(result).toEqual({ success: true });
        expect(mockPlausible).not.toHaveBeenCalled();
      });

      it('should return success even when no user identified', async () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });
        await provider.init();

        const result = await provider.reset();

        expect(result).toEqual({ success: true });
        expect(mockPlausible).not.toHaveBeenCalled();
      });
    });

    describe('isReady', () => {
      it('should return false before initialization', () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });

        expect(provider.isReady()).toBe(false);
      });

      it('should return true after initialization', async () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });

        await provider.init();

        expect(provider.isReady()).toBe(true);
      });
    });

    describe('getFeatures', () => {
      it('should return correct feature flags', () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });

        const features = provider.getFeatures();

        expect(features).toEqual({
          supportsIdentify: false, // Privacy-focused
          supportsServerSide: true,
          supportsFeatureFlags: false,
          supportsSessionReplay: false,
          supportsCookieless: true,
        });
      });
    });

    describe('getDomain', () => {
      it('should return the domain', () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });

        expect(provider.getDomain()).toBe('example.com');
      });
    });

    describe('getHost', () => {
      it('should return the host URL', () => {
        const provider = new PlausibleProvider({
          domain: 'example.com',
          host: 'https://analytics.example.com',
        });

        expect(provider.getHost()).toBe('https://analytics.example.com');
      });
    });

    describe('isHashMode', () => {
      it('should return false when hash mode is disabled', () => {
        const provider = new PlausibleProvider({ domain: 'example.com' });

        expect(provider.isHashMode()).toBe(false);
      });

      it('should return true when hash mode is enabled', () => {
        const provider = new PlausibleProvider({ domain: 'example.com', hashMode: true });

        expect(provider.isHashMode()).toBe(true);
      });
    });

    describe('self-hosted configuration', () => {
      it('should work with self-hosted instance', async () => {
        const provider = new PlausibleProvider({
          domain: 'example.com',
          host: 'https://analytics.mycompany.com',
        });

        await provider.init();

        expect(provider.getDomain()).toBe('example.com');
        expect(provider.getHost()).toBe('https://analytics.mycompany.com');
        expect(provider.isReady()).toBe(true);
      });
    });
  });

  describe('createPlausibleProvider', () => {
    it('should create provider instance', () => {
      const provider = createPlausibleProvider({ domain: 'example.com' });

      expect(provider).toBeInstanceOf(PlausibleProvider);
      expect(provider.name).toBe('Plausible');
      expect(provider.type).toBe('plausible');
    });

    it('should create provider with custom config', () => {
      const provider = createPlausibleProvider({
        domain: 'example.com',
        host: 'https://analytics.example.com',
        hashMode: true,
        debug: true,
      });

      expect(provider).toBeInstanceOf(PlausibleProvider);
      expect(provider.getDomain()).toBe('example.com');
      expect(provider.getHost()).toBe('https://analytics.example.com');
      expect(provider.isHashMode()).toBe(true);
    });
  });
});
