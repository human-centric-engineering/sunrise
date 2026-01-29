import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GA4Provider, createGA4Provider } from '@/lib/analytics/providers/ga4';

// Mock window.gtag and window.dataLayer
declare global {
  interface Window {
    dataLayer: unknown[];
    gtag: (...args: unknown[]) => void;
  }
}

describe('lib/analytics/providers/ga4', () => {
  // Mock gtag function
  const mockGtag = vi.fn();
  let originalGtag: typeof window.gtag | undefined;
  let originalDataLayer: unknown[] | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    // Save original values
    originalGtag = (global as typeof globalThis & { window?: typeof window }).window?.gtag;
    originalDataLayer = (global as typeof globalThis & { window?: typeof window }).window
      ?.dataLayer;

    // Setup mock gtag and dataLayer
    if (typeof window !== 'undefined') {
      window.gtag = mockGtag;
      window.dataLayer = [];
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore original values
    if (typeof window !== 'undefined') {
      if (originalGtag !== undefined) {
        window.gtag = originalGtag;
      }
      if (originalDataLayer !== undefined) {
        window.dataLayer = originalDataLayer;
      }
    }
  });

  describe('GA4Provider', () => {
    describe('constructor', () => {
      it('should initialize with measurement ID', () => {
        const provider = new GA4Provider({ measurementId: 'G-XXXXXXXXXX' });

        expect(provider.name).toBe('Google Analytics 4');
        expect(provider.type).toBe('ga4');
        expect(provider.getMeasurementId()).toBe('G-XXXXXXXXXX');
      });

      it('should use default debug setting (false)', () => {
        const provider = new GA4Provider({ measurementId: 'G-XXXXXXXXXX' });

        expect(provider.name).toBe('Google Analytics 4');
      });

      it('should accept custom debug setting', () => {
        const provider = new GA4Provider({ measurementId: 'G-XXXXXXXXXX', debug: true });

        expect(provider.name).toBe('Google Analytics 4');
      });
    });

    describe('init', () => {
      it('should initialize GA4 and configure gtag', async () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });

        await provider.init();

        expect(provider.isReady()).toBe(true);
        expect(mockGtag).toHaveBeenCalledWith('js', expect.any(Date));
        expect(mockGtag).toHaveBeenCalledWith('config', 'G-TEST123', {
          send_page_view: false,
          debug_mode: false,
        });
      });

      it('should enable debug mode when configured', async () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123', debug: true });

        await provider.init();

        expect(mockGtag).toHaveBeenCalledWith('config', 'G-TEST123', {
          send_page_view: false,
          debug_mode: true,
        });
      });

      it('should be idempotent - calling init twice should not reinitialize', async () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });

        await provider.init();
        mockGtag.mockClear();
        await provider.init();

        expect(mockGtag).not.toHaveBeenCalled();
      });

      it('should set ready flag to true', async () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });

        expect(provider.isReady()).toBe(false);
        await provider.init();
        expect(provider.isReady()).toBe(true);
      });

      it('should disable automatic page view tracking', async () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });

        await provider.init();

        expect(mockGtag).toHaveBeenCalledWith(
          'config',
          'G-TEST123',
          expect.objectContaining({ send_page_view: false })
        );
      });
    });

    describe('identify', () => {
      it('should return error if not initialized', async () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });

        const result = await provider.identify('user-123');

        expect(result).toEqual({ success: false, error: 'GA4 not initialized' });
        expect(mockGtag).not.toHaveBeenCalled();
      });

      it('should set user ID via gtag config', async () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });
        await provider.init();
        mockGtag.mockClear();

        const result = await provider.identify('user-123');

        expect(result).toEqual({ success: true });
        expect(mockGtag).toHaveBeenCalledWith('config', 'G-TEST123', {
          user_id: 'user-123',
        });
      });

      it('should set user properties when traits provided', async () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });
        await provider.init();
        mockGtag.mockClear();

        const traits = {
          email: 'user@example.com',
          name: 'John Doe',
          plan: 'pro',
          company: 'Acme Inc',
        };

        const result = await provider.identify('user-123', traits);

        expect(result).toEqual({ success: true });
        expect(mockGtag).toHaveBeenCalledWith('config', 'G-TEST123', {
          user_id: 'user-123',
        });
        expect(mockGtag).toHaveBeenCalledWith('set', 'user_properties', {
          email: 'user@example.com',
          name: 'John Doe',
          plan: 'pro',
          company: 'Acme Inc',
        });
      });

      it('should only set defined trait properties', async () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });
        await provider.init();
        mockGtag.mockClear();

        const traits = {
          email: 'user@example.com',
          // name, plan, company not provided
        };

        await provider.identify('user-123', traits);

        expect(mockGtag).toHaveBeenCalledWith('set', 'user_properties', {
          email: 'user@example.com',
        });
      });
    });

    describe('track', () => {
      it('should return error if not initialized', async () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });

        const result = await provider.track('button_clicked');

        expect(result).toEqual({ success: false, error: 'GA4 not initialized' });
        expect(mockGtag).not.toHaveBeenCalled();
      });

      it('should track event without properties', async () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });
        await provider.init();
        mockGtag.mockClear();

        const result = await provider.track('button_clicked');

        expect(result).toEqual({ success: true });
        expect(mockGtag).toHaveBeenCalledWith('event', 'button_clicked', {});
      });

      it('should track event with properties', async () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });
        await provider.init();
        mockGtag.mockClear();

        const properties = {
          buttonId: 'signup',
          category: 'engagement',
          label: 'header',
          value: 5,
        };

        const result = await provider.track('button_clicked', properties);

        expect(result).toEqual({ success: true });
        expect(mockGtag).toHaveBeenCalledWith('event', 'button_clicked', {
          buttonId: 'signup',
          category: 'engagement',
          label: 'header',
          value: 5,
          event_category: 'engagement',
          event_label: 'header',
        });
      });

      it('should map category to event_category', async () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });
        await provider.init();
        mockGtag.mockClear();

        await provider.track('test_event', { category: 'test_category' });

        expect(mockGtag).toHaveBeenCalledWith(
          'event',
          'test_event',
          expect.objectContaining({
            event_category: 'test_category',
          })
        );
      });

      it('should map label to event_label', async () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });
        await provider.init();
        mockGtag.mockClear();

        await provider.track('test_event', { label: 'test_label' });

        expect(mockGtag).toHaveBeenCalledWith(
          'event',
          'test_event',
          expect.objectContaining({
            event_label: 'test_label',
          })
        );
      });

      it('should map revenue to value and currency', async () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });
        await provider.init();
        mockGtag.mockClear();

        await provider.track('purchase', { revenue: 99.99, currency: 'EUR' });

        expect(mockGtag).toHaveBeenCalledWith('event', 'purchase', {
          revenue: 99.99,
          currency: 'EUR',
          value: 99.99,
        });
      });

      it('should default currency to USD when revenue provided without currency', async () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });
        await provider.init();
        mockGtag.mockClear();

        await provider.track('purchase', { revenue: 49.99 });

        expect(mockGtag).toHaveBeenCalledWith('event', 'purchase', {
          revenue: 49.99,
          value: 49.99,
          currency: 'USD',
        });
      });

      it('should preserve value property if provided', async () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });
        await provider.init();
        mockGtag.mockClear();

        await provider.track('test_event', { value: 10 });

        expect(mockGtag).toHaveBeenCalledWith(
          'event',
          'test_event',
          expect.objectContaining({
            value: 10,
          })
        );
      });
    });

    describe('page', () => {
      it('should return error if not initialized', async () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });

        const result = await provider.page();

        expect(result).toEqual({ success: false, error: 'GA4 not initialized' });
        expect(mockGtag).not.toHaveBeenCalled();
      });

      it('should track page view with default values', async () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });
        await provider.init();
        mockGtag.mockClear();

        const result = await provider.page();

        expect(result).toEqual({ success: true });
        expect(mockGtag).toHaveBeenCalledWith('event', 'page_view', expect.any(Object));
      });

      it('should track page view with custom name', async () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });
        await provider.init();
        mockGtag.mockClear();

        const result = await provider.page('Dashboard');

        expect(result).toEqual({ success: true });
        expect(mockGtag).toHaveBeenCalledWith(
          'event',
          'page_view',
          expect.objectContaining({
            page_title: 'Dashboard',
          })
        );
      });

      it('should track page view with custom properties', async () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });
        await provider.init();
        mockGtag.mockClear();

        const properties = {
          title: 'Dashboard',
          path: '/dashboard',
          url: 'https://example.com/dashboard',
          referrer: 'https://google.com',
        };

        const result = await provider.page('Dashboard', properties);

        expect(result).toEqual({ success: true });
        expect(mockGtag).toHaveBeenCalledWith(
          'event',
          'page_view',
          expect.objectContaining({
            page_title: 'Dashboard',
            page_path: '/dashboard',
            page_location: 'https://example.com/dashboard',
            page_referrer: 'https://google.com',
            title: 'Dashboard',
            path: '/dashboard',
            url: 'https://example.com/dashboard',
            referrer: 'https://google.com',
          })
        );
      });

      it('should use page_view event name', async () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });
        await provider.init();
        mockGtag.mockClear();

        await provider.page('Test Page');

        expect(mockGtag).toHaveBeenCalledWith('event', 'page_view', expect.any(Object));
      });
    });

    describe('reset', () => {
      it('should return error if not initialized', async () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });

        const result = await provider.reset();

        expect(result).toEqual({ success: false, error: 'GA4 not initialized' });
        expect(mockGtag).not.toHaveBeenCalled();
      });

      it('should clear user ID', async () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });
        await provider.init();
        await provider.identify('user-123');
        mockGtag.mockClear();

        const result = await provider.reset();

        expect(result).toEqual({ success: true });
        expect(mockGtag).toHaveBeenCalledWith('config', 'G-TEST123', {
          user_id: null,
        });
      });

      it('should clear user properties', async () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });
        await provider.init();
        await provider.identify('user-123', {
          email: 'user@example.com',
          name: 'John Doe',
          plan: 'pro',
          company: 'Acme',
        });
        mockGtag.mockClear();

        const result = await provider.reset();

        expect(result).toEqual({ success: true });
        expect(mockGtag).toHaveBeenCalledWith('set', 'user_properties', {
          email: null,
          name: null,
          plan: null,
          company: null,
        });
      });

      it('should handle reset when no user is identified', async () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });
        await provider.init();
        mockGtag.mockClear();

        const result = await provider.reset();

        expect(result).toEqual({ success: true });
        expect(mockGtag).toHaveBeenCalledWith('config', 'G-TEST123', {
          user_id: null,
        });
        expect(mockGtag).toHaveBeenCalledWith('set', 'user_properties', {
          email: null,
          name: null,
          plan: null,
          company: null,
        });
      });
    });

    describe('isReady', () => {
      it('should return false before initialization', () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });

        expect(provider.isReady()).toBe(false);
      });

      it('should return true after initialization', async () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });

        await provider.init();

        expect(provider.isReady()).toBe(true);
      });
    });

    describe('getFeatures', () => {
      it('should return correct feature flags', () => {
        const provider = new GA4Provider({ measurementId: 'G-TEST123' });

        const features = provider.getFeatures();

        expect(features).toEqual({
          supportsIdentify: true,
          supportsServerSide: true,
          supportsFeatureFlags: false,
          supportsSessionReplay: false,
          supportsCookieless: false,
        });
      });
    });

    describe('getMeasurementId', () => {
      it('should return the measurement ID', () => {
        const provider = new GA4Provider({ measurementId: 'G-ABC123' });

        expect(provider.getMeasurementId()).toBe('G-ABC123');
      });
    });

    describe('regional endpoints', () => {
      it('should work with EU endpoint measurement ID', async () => {
        const provider = new GA4Provider({ measurementId: 'G-EU123' });
        await provider.init();

        expect(provider.getMeasurementId()).toBe('G-EU123');
        expect(mockGtag).toHaveBeenCalledWith('config', 'G-EU123', expect.any(Object));
      });

      it('should work with custom measurement ID format', async () => {
        const provider = new GA4Provider({ measurementId: 'G-CUSTOM-ID' });
        await provider.init();

        expect(provider.getMeasurementId()).toBe('G-CUSTOM-ID');
      });
    });
  });

  describe('createGA4Provider', () => {
    it('should create provider instance', () => {
      const provider = createGA4Provider({ measurementId: 'G-TEST123' });

      expect(provider).toBeInstanceOf(GA4Provider);
      expect(provider.name).toBe('Google Analytics 4');
      expect(provider.type).toBe('ga4');
    });

    it('should create provider with debug enabled', () => {
      const provider = createGA4Provider({ measurementId: 'G-TEST123', debug: true });

      expect(provider).toBeInstanceOf(GA4Provider);
      expect(provider.getMeasurementId()).toBe('G-TEST123');
    });
  });
});
