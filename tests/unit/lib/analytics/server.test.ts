/**
 * Unit Tests: lib/analytics/server.ts - serverTrack
 *
 * Tests the server-side analytics tracking function in isolation with all
 * external dependencies mocked. Covers all four providers (console, GA4,
 * PostHog, Plausible), error handling, missing configuration, and request
 * context extraction from Next.js headers.
 *
 * Test Coverage:
 * - Console provider: logs via logger.debug and returns success
 * - GA4 provider: constructs correct Measurement Protocol payload and URL
 * - PostHog provider: constructs correct capture endpoint payload
 * - Plausible provider: constructs correct events API payload
 * - Error handling: returns error result when fetch throws or returns non-OK
 * - Missing config: returns descriptive error when provider secrets are absent
 * - Context extraction: reads IP, user-agent, and referer from headers
 * - Null provider: returns success (same path as console)
 * - Provided context: skips header extraction when context is supplied
 *
 * @see lib/analytics/server.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock analytics config module
vi.mock('@/lib/analytics/config', () => ({
  detectProvider: vi.fn(),
  getGA4Config: vi.fn(),
  getPostHogConfig: vi.fn(),
  getPlausibleConfig: vi.fn(),
  GA4_ENV: {
    MEASUREMENT_ID: 'NEXT_PUBLIC_GA4_MEASUREMENT_ID',
    API_SECRET: 'GA4_API_SECRET',
  },
}));

// Mock Next.js headers
vi.mock('next/headers', () => ({
  headers: vi.fn(),
}));

// Mock logger
vi.mock('@/lib/logging', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Import mocked modules for assertions
import {
  detectProvider,
  getGA4Config,
  getPostHogConfig,
  getPlausibleConfig,
} from '@/lib/analytics/config';
import { headers } from 'next/headers';
import { logger } from '@/lib/logging';
import { serverTrack } from '@/lib/analytics/server';

describe('lib/analytics/server - serverTrack', () => {
  // Store the original global fetch
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();

    // Capture original fetch so we can restore it
    originalFetch = globalThis.fetch;

    // Default: headers returns an empty Map
    vi.mocked(headers).mockResolvedValue(new Map() as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();

    // Restore original fetch
    globalThis.fetch = originalFetch;
  });

  // ---------------------------------------------------------------------------
  // Console provider (and null provider)
  // ---------------------------------------------------------------------------

  describe('console provider', () => {
    it('should log event via logger.debug and return success when provider is console', async () => {
      vi.mocked(detectProvider).mockReturnValue('console');

      const result = await serverTrack({
        event: 'test_event',
        userId: 'user-123',
        properties: { plan: 'pro' },
      });

      expect(result).toEqual({ success: true });
      expect(logger.debug).toHaveBeenCalledWith('Server track (console)', {
        event: 'test_event',
        userId: 'user-123',
        properties: { plan: 'pro' },
      });
    });

    it('should return success when provider is null (no provider configured)', async () => {
      vi.mocked(detectProvider).mockReturnValue(null);

      const result = await serverTrack({
        event: 'orphan_event',
      });

      // Null follows the same code path as console
      expect(result).toEqual({ success: true });
      expect(logger.debug).toHaveBeenCalledWith('Server track (console)', {
        event: 'orphan_event',
        userId: undefined,
        properties: undefined,
      });
    });

    it('should include all options fields in the debug log', async () => {
      vi.mocked(detectProvider).mockReturnValue('console');

      await serverTrack({
        event: 'detailed_event',
        userId: 'u-456',
        anonymousId: 'anon-789',
        properties: { category: 'signup', value: 42 },
        context: { ip: '1.2.3.4' },
      });

      expect(logger.debug).toHaveBeenCalledWith('Server track (console)', {
        event: 'detailed_event',
        userId: 'u-456',
        properties: { category: 'signup', value: 42 },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // GA4 provider
  // ---------------------------------------------------------------------------

  describe('GA4 provider', () => {
    const mockFetch = vi.fn();

    beforeEach(() => {
      vi.mocked(detectProvider).mockReturnValue('ga4');
      vi.mocked(getGA4Config).mockReturnValue({
        measurementId: 'G-TEST123',
        apiSecret: 'secret-abc',
      });
      vi.stubEnv('GA4_API_SECRET', 'secret-abc');

      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      globalThis.fetch = mockFetch as any;
    });

    it('should send correct payload to GA4 Measurement Protocol', async () => {
      const result = await serverTrack({
        event: 'purchase',
        userId: 'user-ga4',
        properties: { value: 99.99, currency: 'USD' },
        context: { userAgent: 'TestAgent/1.0' },
      });

      expect(result).toEqual({ success: true });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, options] = mockFetch.mock.calls[0];

      // Verify URL includes measurement ID and API secret
      expect(url).toBe(
        'https://www.google-analytics.com/mp/collect?measurement_id=G-TEST123&api_secret=secret-abc'
      );

      // Verify method
      expect(options.method).toBe('POST');

      // Verify headers include Content-Type and User-Agent
      expect(options.headers['Content-Type']).toBe('application/json');
      expect(options.headers['User-Agent']).toBe('TestAgent/1.0');

      // Verify body structure
      const body = JSON.parse(options.body);
      expect(body.client_id).toBe('user-ga4');
      expect(body.user_id).toBe('user-ga4');
      expect(body.events).toHaveLength(1);
      expect(body.events[0].name).toBe('purchase');
      expect(body.events[0].params.value).toBe(99.99);
      expect(body.events[0].params.currency).toBe('USD');
      expect(body.events[0].params.engagement_time_msec).toBe(100);
    });

    it('should use anonymousId as client_id when userId is absent', async () => {
      await serverTrack({
        event: 'anonymous_event',
        anonymousId: 'anon-ga4-id',
        context: { ip: '10.0.0.1' },
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.client_id).toBe('anon-ga4-id');
      expect(body.user_id).toBeUndefined();
    });

    it('should generate an anonymous ID when neither userId nor anonymousId is provided', async () => {
      await serverTrack({
        event: 'no_id_event',
        context: {},
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.client_id).toMatch(/^anon_\d+_[a-z0-9]+$/);
      expect(body.user_id).toBeUndefined();
    });

    it('should omit User-Agent header when userAgent is not in context', async () => {
      await serverTrack({
        event: 'no_ua_event',
        userId: 'user-no-ua',
        context: { ip: '10.0.0.1' },
      });

      const options = mockFetch.mock.calls[0][1];
      expect(options.headers['User-Agent']).toBeUndefined();
    });

    it('should return error when GA4 API responds with non-OK status', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 400 });

      const result = await serverTrack({
        event: 'bad_request',
        userId: 'user-bad',
        context: {},
      });

      expect(result).toEqual({ success: false, error: 'GA4 API error: 400' });
    });

    it('should return error when GA4 config is null (measurement ID missing)', async () => {
      vi.mocked(getGA4Config).mockReturnValue(null);

      const result = await serverTrack({
        event: 'no_config_event',
        context: {},
      });

      expect(result).toEqual({
        success: false,
        error: 'GA4 server-side tracking requires GA4_API_SECRET to be configured',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return error when GA4_API_SECRET env var is missing', async () => {
      // Config exists but the API secret env var is not set
      vi.mocked(getGA4Config).mockReturnValue({
        measurementId: 'G-TEST123',
      });
      vi.unstubAllEnvs(); // Ensure GA4_API_SECRET is not in env

      const result = await serverTrack({
        event: 'no_secret_event',
        context: {},
      });

      expect(result).toEqual({
        success: false,
        error: 'GA4 server-side tracking requires GA4_API_SECRET to be configured',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // PostHog provider
  // ---------------------------------------------------------------------------

  describe('PostHog provider', () => {
    const mockFetch = vi.fn();

    beforeEach(() => {
      vi.mocked(detectProvider).mockReturnValue('posthog');
      vi.mocked(getPostHogConfig).mockReturnValue({
        apiKey: 'phc_test_key',
        host: 'https://us.i.posthog.com',
      });

      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      globalThis.fetch = mockFetch as any;
    });

    it('should send correct payload to PostHog capture endpoint', async () => {
      const result = await serverTrack({
        event: 'signup_completed',
        userId: 'user-ph',
        properties: { plan: 'enterprise', referrer: 'google' },
        context: {
          ip: '192.168.1.1',
          userAgent: 'PostHogTestAgent/2.0',
          page: {
            url: 'https://example.com/signup',
            referrer: 'https://google.com',
          },
        },
      });

      expect(result).toEqual({ success: true });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, options] = mockFetch.mock.calls[0];

      // Verify endpoint
      expect(url).toBe('https://us.i.posthog.com/capture/');

      // Verify method and content-type
      expect(options.method).toBe('POST');
      expect(options.headers['Content-Type']).toBe('application/json');

      // Verify body structure
      const body = JSON.parse(options.body);
      expect(body.api_key).toBe('phc_test_key');
      expect(body.event).toBe('signup_completed');
      expect(body.distinct_id).toBe('user-ph');
      expect(body.properties.plan).toBe('enterprise');
      expect(body.properties.referrer).toBe('google');
      expect(body.properties.$lib).toBe('sunrise-server');
      expect(body.properties.$lib_version).toBe('1.0.0');
      expect(body.properties.$ip).toBe('192.168.1.1');
      expect(body.properties.$user_agent).toBe('PostHogTestAgent/2.0');
      expect(body.properties.$current_url).toBe('https://example.com/signup');
      expect(body.properties.$referrer).toBe('https://google.com');
    });

    it('should use anonymousId as distinct_id when userId is absent', async () => {
      await serverTrack({
        event: 'anon_ph_event',
        anonymousId: 'anon-ph-456',
        context: {},
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.distinct_id).toBe('anon-ph-456');
    });

    it('should generate an anonymous distinct_id when no ID is provided', async () => {
      await serverTrack({
        event: 'no_id_ph_event',
        context: {},
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.distinct_id).toMatch(/^anon_\d+_[a-z0-9]+$/);
    });

    it('should omit context properties when they are not provided', async () => {
      await serverTrack({
        event: 'minimal_ph_event',
        userId: 'user-minimal',
        context: {},
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.properties.$ip).toBeUndefined();
      expect(body.properties.$user_agent).toBeUndefined();
      expect(body.properties.$current_url).toBeUndefined();
      expect(body.properties.$referrer).toBeUndefined();
    });

    it('should return error when PostHog API responds with non-OK status', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      });

      const result = await serverTrack({
        event: 'unauthorized_ph',
        userId: 'user-401',
        context: {},
      });

      expect(result).toEqual({ success: false, error: 'PostHog API error: 401' });
    });

    it('should return error when PostHog config is null', async () => {
      vi.mocked(getPostHogConfig).mockReturnValue(null);

      const result = await serverTrack({
        event: 'no_ph_config',
        context: {},
      });

      expect(result).toEqual({
        success: false,
        error: 'PostHog server-side tracking requires NEXT_PUBLIC_POSTHOG_KEY to be configured',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Plausible provider
  // ---------------------------------------------------------------------------

  describe('Plausible provider', () => {
    const mockFetch = vi.fn();

    beforeEach(() => {
      vi.mocked(detectProvider).mockReturnValue('plausible');
      vi.mocked(getPlausibleConfig).mockReturnValue({
        domain: 'sunrise.example.com',
        host: 'https://plausible.io',
      });

      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      globalThis.fetch = mockFetch as any;
    });

    it('should send correct payload to Plausible events API', async () => {
      const result = await serverTrack({
        event: 'page_view',
        userId: 'user-pl',
        properties: { plan: 'pro', active: true },
        context: {
          ip: '10.10.10.10',
          userAgent: 'PlausibleTestAgent/1.0',
          page: {
            url: 'https://sunrise.example.com/dashboard',
          },
        },
      });

      expect(result).toEqual({ success: true });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, options] = mockFetch.mock.calls[0];

      // Verify endpoint
      expect(url).toBe('https://plausible.io/api/event');

      // Verify method
      expect(options.method).toBe('POST');

      // Verify headers
      expect(options.headers['Content-Type']).toBe('application/json');
      expect(options.headers['User-Agent']).toBe('PlausibleTestAgent/1.0');
      expect(options.headers['X-Forwarded-For']).toBe('10.10.10.10');

      // Verify body structure
      const body = JSON.parse(options.body);
      expect(body.name).toBe('page_view');
      expect(body.url).toBe('https://sunrise.example.com/dashboard');
      expect(body.domain).toBe('sunrise.example.com');

      // Props should be JSON-stringified and only include string/number/boolean
      const props = JSON.parse(body.props);
      expect(props.plan).toBe('pro');
      expect(props.active).toBe(true);
    });

    it('should fall back to domain URL when no page URL is in context', async () => {
      await serverTrack({
        event: 'no_url_event',
        context: {},
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.url).toBe('https://sunrise.example.com/');
    });

    it('should omit User-Agent and X-Forwarded-For headers when not in context', async () => {
      await serverTrack({
        event: 'no_headers_event',
        context: {},
      });

      const options = mockFetch.mock.calls[0][1];
      expect(options.headers['User-Agent']).toBeUndefined();
      expect(options.headers['X-Forwarded-For']).toBeUndefined();
    });

    it('should filter out non-primitive property values from props', async () => {
      await serverTrack({
        event: 'complex_props',
        userId: 'user-complex',
        properties: {
          name: 'valid_string',
          count: 5,
          enabled: false,
          nested: { key: 'should_be_excluded' },
          arr: [1, 2, 3],
        },
        context: {},
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const props = JSON.parse(body.props);

      expect(props.name).toBe('valid_string');
      expect(props.count).toBe(5);
      expect(props.enabled).toBe(false);
      expect(props.nested).toBeUndefined();
      expect(props.arr).toBeUndefined();
    });

    it('should set props to undefined when no properties are provided', async () => {
      await serverTrack({
        event: 'no_props_event',
        context: {},
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.props).toBeUndefined();
    });

    it('should return error when Plausible API responds with non-OK status', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500 });

      const result = await serverTrack({
        event: 'server_error_pl',
        context: {},
      });

      expect(result).toEqual({ success: false, error: 'Plausible API error: 500' });
    });

    it('should return error when Plausible config is null', async () => {
      vi.mocked(getPlausibleConfig).mockReturnValue(null);

      const result = await serverTrack({
        event: 'no_pl_config',
        context: {},
      });

      expect(result).toEqual({ success: false, error: 'Plausible not configured' });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe('error handling', () => {
    const mockFetch = vi.fn();

    beforeEach(() => {
      globalThis.fetch = mockFetch as any;
    });

    it('should catch fetch network errors and return error result for GA4', async () => {
      vi.mocked(detectProvider).mockReturnValue('ga4');
      vi.mocked(getGA4Config).mockReturnValue({ measurementId: 'G-ERR', apiSecret: 'key' });
      vi.stubEnv('GA4_API_SECRET', 'key');
      mockFetch.mockRejectedValue(new Error('Network failure'));

      const result = await serverTrack({
        event: 'network_error_ga4',
        context: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network failure');
      expect(logger.error).toHaveBeenCalledWith('Server track failed', expect.any(Error), {
        event: 'network_error_ga4',
      });
    });

    it('should catch fetch network errors and return error result for PostHog', async () => {
      vi.mocked(detectProvider).mockReturnValue('posthog');
      vi.mocked(getPostHogConfig).mockReturnValue({
        apiKey: 'phc_err',
        host: 'https://us.i.posthog.com',
      });
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const result = await serverTrack({
        event: 'network_error_ph',
        context: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection refused');
      expect(logger.error).toHaveBeenCalledWith('Server track failed', expect.any(Error), {
        event: 'network_error_ph',
      });
    });

    it('should catch fetch network errors and return error result for Plausible', async () => {
      vi.mocked(detectProvider).mockReturnValue('plausible');
      vi.mocked(getPlausibleConfig).mockReturnValue({
        domain: 'err.example.com',
        host: 'https://plausible.io',
      });
      mockFetch.mockRejectedValue(new Error('DNS resolution failed'));

      const result = await serverTrack({
        event: 'network_error_pl',
        context: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('DNS resolution failed');
      expect(logger.error).toHaveBeenCalledWith('Server track failed', expect.any(Error), {
        event: 'network_error_pl',
      });
    });

    it('should catch errors thrown by getRequestContext (headers failure)', async () => {
      vi.mocked(detectProvider).mockReturnValue('ga4');
      vi.mocked(getGA4Config).mockReturnValue({ measurementId: 'G-HDR', apiSecret: 'key' });
      vi.stubEnv('GA4_API_SECRET', 'key');

      // Make headers() throw to simulate a server context issue
      vi.mocked(headers).mockRejectedValue(new Error('Headers not available'));

      // The getRequestContext catches its own error and returns {},
      // so this should still succeed if fetch works
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      const result = await serverTrack({
        event: 'headers_error_event',
        // No context provided, so it will try to read from headers
      });

      // getRequestContext catches the error internally and returns {}
      // so the overall call should still succeed
      expect(result).toEqual({ success: true });
    });
  });

  // ---------------------------------------------------------------------------
  // Context extraction from headers
  // ---------------------------------------------------------------------------

  describe('context extraction from headers', () => {
    const mockFetch = vi.fn();

    beforeEach(() => {
      vi.mocked(detectProvider).mockReturnValue('posthog');
      vi.mocked(getPostHogConfig).mockReturnValue({
        apiKey: 'phc_ctx',
        host: 'https://us.i.posthog.com',
      });

      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      globalThis.fetch = mockFetch as any;
    });

    it('should extract IP from x-forwarded-for header (first value in comma-separated list)', async () => {
      const mockHeaders = new Map([
        ['x-forwarded-for', '203.0.113.50, 70.41.3.18, 150.172.238.178'],
        ['user-agent', 'HeaderTestAgent/1.0'],
        ['referer', 'https://example.com/origin'],
      ]);
      vi.mocked(headers).mockResolvedValue(mockHeaders as any);

      await serverTrack({
        event: 'ctx_extraction',
        userId: 'user-ctx',
        // No context provided -- should extract from headers
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.properties.$ip).toBe('203.0.113.50');
      expect(body.properties.$user_agent).toBe('HeaderTestAgent/1.0');
      expect(body.properties.$current_url).toBe('https://example.com/origin');
      expect(body.properties.$referrer).toBe('https://example.com/origin');
    });

    it('should fall back to x-real-ip when x-forwarded-for is absent', async () => {
      const mockHeaders = new Map([
        ['x-real-ip', '198.51.100.22'],
        ['user-agent', 'RealIpAgent/1.0'],
      ]);
      vi.mocked(headers).mockResolvedValue(mockHeaders as any);

      await serverTrack({
        event: 'real_ip_fallback',
        userId: 'user-real-ip',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.properties.$ip).toBe('198.51.100.22');
    });

    it('should leave IP undefined when neither x-forwarded-for nor x-real-ip is present', async () => {
      const mockHeaders = new Map([['user-agent', 'NoIpAgent/1.0']]);
      vi.mocked(headers).mockResolvedValue(mockHeaders as any);

      await serverTrack({
        event: 'no_ip_event',
        userId: 'user-no-ip',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.properties.$ip).toBeUndefined();
    });

    it('should use provided context instead of extracting from headers', async () => {
      // headers mock should NOT be called when context is provided
      const mockHeadersFn = vi.mocked(headers);

      await serverTrack({
        event: 'provided_ctx',
        userId: 'user-provided',
        context: {
          ip: '1.1.1.1',
          userAgent: 'ProvidedAgent/1.0',
          page: { url: 'https://provided.example.com/page' },
        },
      });

      // headers() should not have been called since context was provided
      expect(mockHeadersFn).not.toHaveBeenCalled();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.properties.$ip).toBe('1.1.1.1');
      expect(body.properties.$user_agent).toBe('ProvidedAgent/1.0');
      expect(body.properties.$current_url).toBe('https://provided.example.com/page');
    });

    it('should return empty context when headers() throws an error', async () => {
      vi.mocked(headers).mockRejectedValue(new Error('No request scope'));

      await serverTrack({
        event: 'headers_threw',
        userId: 'user-threw',
      });

      // Should still succeed - context is just empty
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.properties.$ip).toBeUndefined();
      expect(body.properties.$user_agent).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // serverPageView() function
  // ---------------------------------------------------------------------------

  describe('serverPageView()', () => {
    const mockFetch = vi.fn();

    beforeEach(async () => {
      // Import serverPageView dynamically after setting up mocks
      vi.mocked(detectProvider).mockReturnValue('posthog');
      vi.mocked(getPostHogConfig).mockReturnValue({
        apiKey: 'phc_page_view',
        host: 'https://us.i.posthog.com',
      });

      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      globalThis.fetch = mockFetch as any;
    });

    it('should call serverTrack with event "pageview" and correct properties', async () => {
      // Arrange
      const { serverPageView } = await import('@/lib/analytics/server');

      // Act
      await serverPageView('Dashboard', 'https://example.com/dashboard');

      // Assert
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.event).toBe('pageview');
      expect(body.properties.page_name).toBe('Dashboard');
      expect(body.properties.url).toBe('https://example.com/dashboard');
    });

    it('should pass userId when provided', async () => {
      // Arrange
      const { serverPageView } = await import('@/lib/analytics/server');

      // Act
      await serverPageView('Settings', 'https://example.com/settings', 'user-123');

      // Assert
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.distinct_id).toBe('user-123');
      expect(body.properties.page_name).toBe('Settings');
      expect(body.properties.url).toBe('https://example.com/settings');
    });

    it('should pass context.page.url in the context', async () => {
      // Arrange
      const { serverPageView } = await import('@/lib/analytics/server');

      // Act
      await serverPageView('Profile', 'https://example.com/profile', 'user-456');

      // Assert
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      // PostHog context mapping: context.page.url → $current_url
      expect(body.properties.$current_url).toBe('https://example.com/profile');
    });

    it('should return TrackResult from serverTrack', async () => {
      // Arrange
      const { serverPageView } = await import('@/lib/analytics/server');

      // Act
      const result = await serverPageView('Home', 'https://example.com/');

      // Assert
      expect(result).toEqual({ success: true });
    });

    it('should generate anonymous ID when userId is not provided', async () => {
      // Arrange
      const { serverPageView } = await import('@/lib/analytics/server');

      // Act
      await serverPageView('Public Page', 'https://example.com/public');

      // Assert
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.distinct_id).toMatch(/^anon_\d+_[a-z0-9]+$/);
    });
  });
});
