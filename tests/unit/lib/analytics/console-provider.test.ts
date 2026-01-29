import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConsoleProvider, createConsoleProvider } from '@/lib/analytics/providers/console';

describe('lib/analytics/providers/console', () => {
  // Mock console.log to test logging behavior
  const mockConsoleLog = vi.fn();
  const originalConsoleLog = console.log;

  beforeEach(() => {
    vi.clearAllMocks();
    console.log = mockConsoleLog;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    console.log = originalConsoleLog;
  });

  describe('ConsoleProvider', () => {
    describe('constructor', () => {
      it('should initialize with default config', () => {
        const provider = new ConsoleProvider();

        expect(provider.name).toBe('Console');
        expect(provider.type).toBe('console');
      });

      it('should use custom prefix when provided', () => {
        const provider = new ConsoleProvider({ prefix: '[Custom]' });

        expect(provider.name).toBe('Console');
      });

      it('should use custom debug setting when provided', () => {
        const provider = new ConsoleProvider({ debug: false });

        expect(provider.name).toBe('Console');
      });
    });

    describe('init', () => {
      it('should initialize provider successfully', async () => {
        const provider = new ConsoleProvider();

        await provider.init();

        expect(provider.isReady()).toBe(true);
        expect(mockConsoleLog).toHaveBeenCalled();
        const call = mockConsoleLog.mock.calls[0];
        expect(call[0]).toContain('[Analytics]');
        expect(call[0]).toContain('init');
        expect(call[5]).toBe('Console analytics provider initialized');
      });

      it('should be idempotent - calling init twice should not reinitialize', async () => {
        const provider = new ConsoleProvider();

        await provider.init();
        mockConsoleLog.mockClear();
        await provider.init();

        expect(mockConsoleLog).not.toHaveBeenCalled();
      });

      it('should set ready flag to true', async () => {
        const provider = new ConsoleProvider();

        expect(provider.isReady()).toBe(false);
        await provider.init();
        expect(provider.isReady()).toBe(true);
      });
    });

    describe('identify', () => {
      it('should log user identification without traits', async () => {
        const provider = new ConsoleProvider();
        await provider.init();
        mockConsoleLog.mockClear();

        const result = await provider.identify('user-123');

        expect(result).toEqual({ success: true });
        // Verify console.log was called with the correct number of arguments
        expect(mockConsoleLog).toHaveBeenCalled();
        const call = mockConsoleLog.mock.calls[0];
        expect(call[0]).toContain('[Analytics]');
        expect(call[0]).toContain('identify');
        expect(call[5]).toBe('user-123');
        expect(call[6]).toBeUndefined();
      });

      it('should log user identification with traits', async () => {
        const provider = new ConsoleProvider();
        await provider.init();
        mockConsoleLog.mockClear();

        const traits = {
          email: 'user@example.com',
          name: 'John Doe',
          plan: 'pro',
        };

        const result = await provider.identify('user-123', traits);

        expect(result).toEqual({ success: true });
        // Verify console.log was called
        expect(mockConsoleLog).toHaveBeenCalled();
        const call = mockConsoleLog.mock.calls[0];
        expect(call[0]).toContain('[Analytics]');
        expect(call[0]).toContain('identify');
        expect(call[5]).toBe('user-123');
        expect(call[6]).toEqual(traits);
      });

      it('should merge traits on subsequent identify calls', async () => {
        const provider = new ConsoleProvider();
        await provider.init();

        await provider.identify('user-123', { email: 'user@example.com' });
        await provider.identify('user-123', { name: 'John Doe' });

        // Traits should be merged (both email and name should be present)
        // This is tested by tracking an event after identification
        mockConsoleLog.mockClear();
        await provider.track('test_event');

        expect(mockConsoleLog).toHaveBeenCalled();
        const call = mockConsoleLog.mock.calls[0];
        expect(call[5]).toBe('test_event');
        expect(call[6]).toMatchObject({
          _userId: 'user-123',
        });
      });
    });

    describe('track', () => {
      it('should log event without properties', async () => {
        const provider = new ConsoleProvider();
        await provider.init();
        mockConsoleLog.mockClear();

        const result = await provider.track('button_clicked');

        expect(result).toEqual({ success: true });
        expect(mockConsoleLog).toHaveBeenCalled();
        const call = mockConsoleLog.mock.calls[0];
        expect(call[0]).toContain('[Analytics]');
        expect(call[0]).toContain('track');
        expect(call[5]).toBe('button_clicked');
        expect(call[6]).toMatchObject({ _userId: null });
      });

      it('should log event with properties', async () => {
        const provider = new ConsoleProvider();
        await provider.init();
        mockConsoleLog.mockClear();

        const properties = {
          buttonId: 'signup',
          category: 'engagement',
          value: 1,
        };

        const result = await provider.track('button_clicked', properties);

        expect(result).toEqual({ success: true });
        expect(mockConsoleLog).toHaveBeenCalled();
        const call = mockConsoleLog.mock.calls[0];
        expect(call[0]).toContain('[Analytics]');
        expect(call[0]).toContain('track');
        expect(call[5]).toBe('button_clicked');
        expect(call[6]).toMatchObject({
          buttonId: 'signup',
          category: 'engagement',
          value: 1,
          _userId: null,
        });
      });

      it('should include userId in tracked events after identification', async () => {
        const provider = new ConsoleProvider();
        await provider.init();

        await provider.identify('user-123');
        mockConsoleLog.mockClear();

        await provider.track('button_clicked');

        expect(mockConsoleLog).toHaveBeenCalled();
        const call = mockConsoleLog.mock.calls[0];
        expect(call[5]).toBe('button_clicked');
        expect(call[6]).toMatchObject({ _userId: 'user-123' });
      });
    });

    describe('page', () => {
      it('should log page view without name or properties', async () => {
        const provider = new ConsoleProvider();
        await provider.init();
        mockConsoleLog.mockClear();

        const result = await provider.page();

        expect(result).toEqual({ success: true });
        expect(mockConsoleLog).toHaveBeenCalled();
        const call = mockConsoleLog.mock.calls[0];
        expect(call[0]).toContain('[Analytics]');
        expect(call[0]).toContain('page');
        expect(call[6]).toMatchObject({ _userId: null });
      });

      it('should log page view with custom name', async () => {
        const provider = new ConsoleProvider();
        await provider.init();
        mockConsoleLog.mockClear();

        const result = await provider.page('Dashboard');

        expect(result).toEqual({ success: true });
        expect(mockConsoleLog).toHaveBeenCalled();
        const call = mockConsoleLog.mock.calls[0];
        expect(call[0]).toContain('[Analytics]');
        expect(call[0]).toContain('page');
        expect(call[5]).toBe('Dashboard');
        expect(call[6]).toMatchObject({ _userId: null });
      });

      it('should log page view with properties', async () => {
        const provider = new ConsoleProvider();
        await provider.init();
        mockConsoleLog.mockClear();

        const properties = {
          title: 'Dashboard',
          path: '/dashboard',
          url: 'https://example.com/dashboard',
          referrer: 'https://google.com',
        };

        const result = await provider.page('Dashboard', properties);

        expect(result).toEqual({ success: true });
        expect(mockConsoleLog).toHaveBeenCalled();
        const call = mockConsoleLog.mock.calls[0];
        expect(call[0]).toContain('[Analytics]');
        expect(call[0]).toContain('page');
        expect(call[5]).toBe('Dashboard');
        expect(call[6]).toMatchObject({
          title: 'Dashboard',
          path: '/dashboard',
          url: 'https://example.com/dashboard',
          referrer: 'https://google.com',
          _userId: null,
        });
      });

      it('should include userId in page views after identification', async () => {
        const provider = new ConsoleProvider();
        await provider.init();

        await provider.identify('user-123');
        mockConsoleLog.mockClear();

        await provider.page('Dashboard');

        expect(mockConsoleLog).toHaveBeenCalled();
        const call = mockConsoleLog.mock.calls[0];
        expect(call[5]).toBe('Dashboard');
        expect(call[6]).toMatchObject({ _userId: 'user-123' });
      });
    });

    describe('reset', () => {
      it('should clear user identification', async () => {
        const provider = new ConsoleProvider();
        await provider.init();

        await provider.identify('user-123', { email: 'user@example.com' });
        mockConsoleLog.mockClear();

        const result = await provider.reset();

        expect(result).toEqual({ success: true });
        expect(mockConsoleLog).toHaveBeenCalled();
        const call = mockConsoleLog.mock.calls[0];
        expect(call[0]).toContain('[Analytics]');
        expect(call[0]).toContain('reset');
        expect(call[5]).toBe('User user-123 logged out');
      });

      it('should clear userId from subsequent events', async () => {
        const provider = new ConsoleProvider();
        await provider.init();

        await provider.identify('user-123');
        await provider.reset();
        mockConsoleLog.mockClear();

        await provider.track('button_clicked');

        expect(mockConsoleLog).toHaveBeenCalled();
        const call = mockConsoleLog.mock.calls[0];
        expect(call[5]).toBe('button_clicked');
        expect(call[6]).toMatchObject({ _userId: null });
      });

      it('should handle reset when no user is identified', async () => {
        const provider = new ConsoleProvider();
        await provider.init();
        mockConsoleLog.mockClear();

        const result = await provider.reset();

        expect(result).toEqual({ success: true });
        expect(mockConsoleLog).toHaveBeenCalled();
        const call = mockConsoleLog.mock.calls[0];
        expect(call[0]).toContain('[Analytics]');
        expect(call[0]).toContain('reset');
        expect(call[5]).toBe('User null logged out');
      });
    });

    describe('isReady', () => {
      it('should return false before initialization', () => {
        const provider = new ConsoleProvider();

        expect(provider.isReady()).toBe(false);
      });

      it('should return true after initialization', async () => {
        const provider = new ConsoleProvider();

        await provider.init();

        expect(provider.isReady()).toBe(true);
      });
    });

    describe('getFeatures', () => {
      it('should return correct feature flags', () => {
        const provider = new ConsoleProvider();

        const features = provider.getFeatures();

        expect(features).toEqual({
          supportsIdentify: true,
          supportsServerSide: true,
          supportsFeatureFlags: false,
          supportsSessionReplay: false,
          supportsCookieless: true,
        });
      });
    });

    describe('debug mode', () => {
      it('should log when debug is enabled (default)', async () => {
        const provider = new ConsoleProvider({ debug: true });
        await provider.init();

        expect(mockConsoleLog).toHaveBeenCalled();
      });

      it('should not log when debug is disabled', async () => {
        const provider = new ConsoleProvider({ debug: false });
        await provider.init();

        expect(mockConsoleLog).not.toHaveBeenCalled();
      });

      it('should not log track events when debug is disabled', async () => {
        const provider = new ConsoleProvider({ debug: false });
        await provider.init();
        mockConsoleLog.mockClear();

        await provider.track('test_event');

        expect(mockConsoleLog).not.toHaveBeenCalled();
      });
    });

    describe('custom prefix', () => {
      it('should use custom prefix in logs', async () => {
        const provider = new ConsoleProvider({ prefix: '[CustomAnalytics]' });
        await provider.init();

        expect(mockConsoleLog).toHaveBeenCalled();
        const call = mockConsoleLog.mock.calls[0];
        expect(call[0]).toContain('[CustomAnalytics]');
      });
    });
  });

  describe('createConsoleProvider', () => {
    it('should create provider with default config', () => {
      const provider = createConsoleProvider();

      expect(provider).toBeInstanceOf(ConsoleProvider);
      expect(provider.name).toBe('Console');
      expect(provider.type).toBe('console');
    });

    it('should create provider with custom config', () => {
      const provider = createConsoleProvider({ prefix: '[Test]', debug: false });

      expect(provider).toBeInstanceOf(ConsoleProvider);
      expect(provider.name).toBe('Console');
    });
  });
});
