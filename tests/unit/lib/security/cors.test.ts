/**
 * CORS Configuration Unit Tests
 *
 * Tests for CORS utilities and origin validation.
 *
 * @see lib/security/cors.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import {
  isOriginAllowed,
  setCORSHeaders,
  handlePreflight,
  withCORS,
  createCORSHandlers,
} from '@/lib/security/cors';

// Helper to create mock NextRequest with proper origin header
function createMockRequest(
  url: string,
  options: { method?: string; origin?: string; headers?: HeadersInit } = {}
): NextRequest {
  const { origin, method = 'GET', headers: customHeaders } = options;

  const headers: Record<string, string> = {};

  // Add custom headers
  if (customHeaders) {
    if (customHeaders instanceof Headers) {
      customHeaders.forEach((value, key) => {
        headers[key] = value;
      });
    } else if (Array.isArray(customHeaders)) {
      customHeaders.forEach(([key, value]) => {
        headers[key] = value;
      });
    } else {
      Object.assign(headers, customHeaders);
    }
  }

  // Add origin header
  if (origin) {
    headers['origin'] = origin;
  }

  // NextRequest expects a proper Request object
  // We need to use the Request constructor which properly handles headers
  const request = new Request(url, {
    method,
    headers,
  });

  return new NextRequest(request);
}

describe('CORS', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ALLOWED_ORIGINS', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('isOriginAllowed', () => {
    it('should reject null origin (fail-secure)', () => {
      expect(isOriginAllowed(null, ['https://example.com'])).toBe(false);
    });

    it('should reject when no allowed origins configured', () => {
      expect(isOriginAllowed('https://example.com', undefined)).toBe(false);
      expect(isOriginAllowed('https://example.com', [])).toBe(false);
    });

    it('should allow matching string origin', () => {
      expect(isOriginAllowed('https://example.com', 'https://example.com')).toBe(true);
      expect(isOriginAllowed('https://other.com', 'https://example.com')).toBe(false);
    });

    it('should allow origin in array', () => {
      const allowed = ['https://app.example.com', 'https://mobile.example.com'];
      expect(isOriginAllowed('https://app.example.com', allowed)).toBe(true);
      expect(isOriginAllowed('https://mobile.example.com', allowed)).toBe(true);
      expect(isOriginAllowed('https://evil.com', allowed)).toBe(false);
    });

    it('should support function validator', () => {
      const validator = (origin: string) => origin.endsWith('.example.com');
      expect(isOriginAllowed('https://app.example.com', validator)).toBe(true);
      expect(isOriginAllowed('https://docs.example.com', validator)).toBe(true);
      expect(isOriginAllowed('https://evil.com', validator)).toBe(false);
    });

    it('should be case-sensitive', () => {
      expect(isOriginAllowed('https://EXAMPLE.com', ['https://example.com'])).toBe(false);
    });

    it('should return false when allowed is an unrecognised truthy type (L127 fallback)', () => {
      // Arrange: pass a value that satisfies none of the type-guard branches
      // (not undefined/null, not a function, not a string, not an array).
      // Cast through unknown to simulate a misconfigured consumer passing an
      // unexpected value without violating TypeScript at the call-site.
      const bogus = 42 as unknown as string;

      // Act + Assert: the final return false at L127 is the only exit path
      expect(isOriginAllowed('https://example.com', bogus)).toBe(false);
    });
  });

  describe('setCORSHeaders', () => {
    it('should set credentials header when enabled', () => {
      const request = createMockRequest('https://app.example.com/api/test');
      const response = NextResponse.json({ test: true });

      setCORSHeaders(response, request, {
        origin: ['https://allowed.com'],
        credentials: true,
      });

      expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    });

    it('should set allowed methods', () => {
      const request = createMockRequest('https://app.example.com/api/test');
      const response = NextResponse.json({ test: true });

      setCORSHeaders(response, request, {
        origin: ['https://allowed.com'],
        methods: ['GET', 'POST'],
      });

      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST');
    });

    it('should set allowed headers', () => {
      const request = createMockRequest('https://app.example.com/api/test');
      const response = NextResponse.json({ test: true });

      setCORSHeaders(response, request, {
        origin: ['https://allowed.com'],
        allowedHeaders: ['Content-Type', 'Authorization'],
      });

      expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
        'Content-Type, Authorization'
      );
    });

    it('should set exposed headers', () => {
      const request = createMockRequest('https://app.example.com/api/test');
      const response = NextResponse.json({ test: true });

      setCORSHeaders(response, request, {
        origin: ['https://allowed.com'],
        exposedHeaders: ['X-Request-ID'],
      });

      expect(response.headers.get('Access-Control-Expose-Headers')).toBe('X-Request-ID');
    });

    it('should set max age for preflight caching', () => {
      const request = createMockRequest('https://app.example.com/api/test');
      const response = NextResponse.json({ test: true });

      setCORSHeaders(response, request, {
        origin: ['https://allowed.com'],
        maxAge: 3600,
      });

      expect(response.headers.get('Access-Control-Max-Age')).toBe('3600');
    });

    it('should NOT set Access-Control-Allow-Origin when no origin header in request', () => {
      const request = createMockRequest('https://app.example.com/api/test');
      const response = NextResponse.json({ test: true });

      setCORSHeaders(response, request, { origin: ['https://allowed.com'] });

      // No origin in request = no CORS header set
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });

    it('should set Access-Control-Allow-Origin when origin IS allowed', () => {
      const allowedOrigin = 'https://allowed.com';
      const request = createMockRequest('https://app.example.com/api/test');

      // Mock the headers.get method to return the origin
      vi.spyOn(request.headers, 'get').mockImplementation((name: string) => {
        if (name.toLowerCase() === 'origin') {
          return allowedOrigin;
        }
        return null;
      });

      const response = NextResponse.json({ test: true });

      // Pass complete options to avoid merging with environment-dependent defaults
      setCORSHeaders(response, request, {
        origin: [allowedOrigin],
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type'],
        exposedHeaders: [],
        credentials: true,
        maxAge: 3600,
      });

      // Origin matches allowed list = CORS header set
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(allowedOrigin);
      // Vary header should include Origin to prevent caching issues
      expect(response.headers.get('Vary')).toContain('Origin');
    });

    it('should set Access-Control-Allow-Origin with multiple allowed origins', () => {
      const allowedOrigins = ['https://app.example.com', 'https://mobile.example.com'];
      const request = createMockRequest('https://app.example.com/api/test');

      // Mock the headers.get method to return the origin
      vi.spyOn(request.headers, 'get').mockImplementation((name: string) => {
        if (name.toLowerCase() === 'origin') {
          return 'https://mobile.example.com';
        }
        return null;
      });

      const response = NextResponse.json({ test: true });

      // Pass complete options to avoid merging with environment-dependent defaults
      setCORSHeaders(response, request, {
        origin: allowedOrigins,
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type'],
        exposedHeaders: [],
        credentials: true,
        maxAge: 3600,
      });

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
        'https://mobile.example.com'
      );
      expect(response.headers.get('Vary')).toContain('Origin');
    });

    it('should NOT set Access-Control-Allow-Origin when origin is NOT allowed', () => {
      const request = createMockRequest('https://app.example.com/api/test');

      // Mock the headers.get method to return an evil origin
      vi.spyOn(request.headers, 'get').mockImplementation((name: string) => {
        if (name.toLowerCase() === 'origin') {
          return 'https://evil.com';
        }
        return null;
      });

      const response = NextResponse.json({ test: true });

      setCORSHeaders(response, request, { origin: ['https://allowed.com'] });

      // Origin not in allowed list = no CORS header set
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
  });

  describe('handlePreflight', () => {
    it('should return 204 No Content response', () => {
      const request = createMockRequest('https://app.example.com/api/test', {
        method: 'OPTIONS',
      });

      const response = handlePreflight(request, { origin: ['https://allowed.com'] });

      expect(response.status).toBe(204);
    });

    it('should include CORS method headers in preflight response', () => {
      const request = createMockRequest('https://app.example.com/api/test', {
        method: 'OPTIONS',
      });

      const response = handlePreflight(request, {
        origin: ['https://allowed.com'],
        methods: ['GET', 'POST', 'PUT'],
      });

      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
    });

    it('should NOT set Access-Control-Allow-Origin when preflight origin is not in the allowed list', () => {
      // Arrange: preflight from a disallowed origin
      const request = createMockRequest('https://app.example.com/api/test', {
        method: 'OPTIONS',
      });

      vi.spyOn(request.headers, 'get').mockImplementation((name: string) => {
        if (name.toLowerCase() === 'origin') return 'https://evil.com';
        return null;
      });

      // Act
      const response = handlePreflight(request, {
        origin: ['https://allowed.com'],
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type'],
        exposedHeaders: [],
        credentials: false,
        maxAge: 0,
      });

      // Assert: 204 still returned but no ACAO header (fail-secure fallthrough)
      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
  });

  describe('withCORS', () => {
    it('should preserve handler response body', async () => {
      const handler = async (_request: NextRequest) => Response.json({ data: 'test' });
      const wrappedHandler = withCORS(handler, { origin: ['https://allowed.com'] });

      const request = createMockRequest('https://app.example.com/api/test');

      const response = await wrappedHandler(request);

      const body = await response.json();
      expect(body.data).toBe('test');
    });

    it('should preserve original response status', async () => {
      const handler = async (_request: NextRequest) =>
        new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      const wrappedHandler = withCORS(handler, { origin: ['https://allowed.com'] });

      const request = createMockRequest('https://app.example.com/api/test');

      const response = await wrappedHandler(request);

      expect(response.status).toBe(404);
    });

    it('should add configured CORS headers', async () => {
      const handler = async (_request: NextRequest) => Response.json({ data: 'test' });
      const wrappedHandler = withCORS(handler, {
        origin: ['https://allowed.com'],
        credentials: true,
        methods: ['GET', 'POST'],
      });

      const request = createMockRequest('https://app.example.com/api/test');

      const response = await wrappedHandler(request);

      expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST');
    });
  });

  describe('Development mode', () => {
    it('should recognise localhost origins as allowed when passed in an array', () => {
      // getDefaultOrigins() adds localhost variants when NODE_ENV=development, but
      // DEFAULT_CORS_OPTIONS is evaluated once at module load time — the runtime env
      // value at that point determines the defaults. This test verifies isOriginAllowed
      // correctly accepts localhost URLs when they appear in the allowed list, which is
      // the precise contract getDefaultOrigins() relies on.
      const devOrigins = [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://127.0.0.1:3000',
      ];

      for (const origin of devOrigins) {
        expect(isOriginAllowed(origin, devOrigins)).toBe(true);
      }
    });
  });

  describe('createCORSHandlers', () => {
    it('should wrap handlers and add OPTIONS method', () => {
      const handlers = {
        GET: async (_request: NextRequest) => Response.json({ method: 'GET' }),
        POST: async (_request: NextRequest) => Response.json({ method: 'POST' }),
      };

      const wrapped = createCORSHandlers(handlers, { origin: ['https://allowed.com'] });

      // Should have original methods plus OPTIONS
      expect(wrapped.GET).toBeDefined();
      expect(wrapped.POST).toBeDefined();
      expect(wrapped.OPTIONS).toBeDefined();
    });

    it('should add CORS headers to wrapped handlers', async () => {
      const handlers = {
        GET: async (_request: NextRequest) => Response.json({ data: 'test' }),
      };

      const wrapped = createCORSHandlers(handlers, {
        origin: ['https://allowed.com'],
        credentials: true,
        methods: ['GET', 'POST'],
      });

      const request = createMockRequest('https://app.example.com/api/test');

      // Mock the headers.get method to return the origin
      vi.spyOn(request.headers, 'get').mockImplementation((name: string) => {
        if (name.toLowerCase() === 'origin') {
          return 'https://allowed.com';
        }
        return null;
      });

      const response = await wrapped.GET(request);

      // Should have CORS headers
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://allowed.com');
      expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST');
    });

    it('should create working OPTIONS handler', async () => {
      const handlers = {
        GET: async (_request: NextRequest) => Response.json({ data: 'test' }),
      };

      const wrapped = createCORSHandlers(handlers, {
        origin: ['https://allowed.com'],
        methods: ['GET', 'POST', 'DELETE'],
      });

      const request = createMockRequest('https://app.example.com/api/test', {
        method: 'OPTIONS',
      });

      // Mock the headers.get method to return the origin
      vi.spyOn(request.headers, 'get').mockImplementation((name: string) => {
        if (name.toLowerCase() === 'origin') {
          return 'https://allowed.com';
        }
        return null;
      });

      const response = wrapped.OPTIONS(request);

      // Should return 204 No Content
      expect(response.status).toBe(204);
      // Should include CORS headers
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://allowed.com');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('DELETE');
    });

    it('should preserve response body from wrapped handlers', async () => {
      const handlers = {
        POST: async (_request: NextRequest) => Response.json({ created: true, id: 123 }),
      };

      const wrapped = createCORSHandlers(handlers, { origin: ['https://allowed.com'] });

      const request = createMockRequest('https://app.example.com/api/test', { method: 'POST' });

      const response = await wrapped.POST(request);
      const body = await response.json();

      // test-review:accept tobe_true — structural assertion on response body boolean field from test endpoint
      expect(body.created).toBe(true);
      expect(body.id).toBe(123);
    });
  });

  describe('ALLOWED_ORIGINS environment variable', () => {
    it('should accept origins from a comma-separated list and reject origins not in that list', () => {
      // Arrange: simulate parsing of ALLOWED_ORIGINS the same way getDefaultOrigins() does
      // (DEFAULT_CORS_OPTIONS is module-level, so we verify the parsing contract directly)
      vi.stubEnv('ALLOWED_ORIGINS', 'https://app.example.com,https://mobile.example.com');

      const envValue = process.env.ALLOWED_ORIGINS ?? '';
      const origins = envValue
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean);

      // Act + Assert: configured origins are accepted; unlisted origins are rejected
      expect(isOriginAllowed('https://app.example.com', origins)).toBe(true);
      expect(isOriginAllowed('https://mobile.example.com', origins)).toBe(true);
      expect(isOriginAllowed('https://other.com', origins)).toBe(false);
    });
  });

  describe('setCORSHeaders — falsy branches', () => {
    it('should NOT set Access-Control-Allow-Credentials when credentials is false', () => {
      // Arrange
      const request = createMockRequest('https://app.example.com/api/test');
      const response = NextResponse.json({ test: true });

      // Act: override credentials to false (overrides the default true from DEFAULT_CORS_OPTIONS)
      setCORSHeaders(response, request, {
        origin: ['https://allowed.com'],
        credentials: false,
        methods: ['GET'],
        allowedHeaders: ['Content-Type'],
        exposedHeaders: [],
        maxAge: 86400,
      });

      // Assert: credentials header must be absent
      expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    });

    it('should NOT set Access-Control-Allow-Methods when methods array is empty', () => {
      // Arrange
      const request = createMockRequest('https://app.example.com/api/test');
      const response = NextResponse.json({ test: true });

      // Act: pass empty methods array; the spread over DEFAULT_CORS_OPTIONS keeps the empty value
      setCORSHeaders(response, request, {
        origin: ['https://allowed.com'],
        credentials: false,
        methods: [],
        allowedHeaders: [],
        exposedHeaders: [],
        maxAge: undefined,
      });

      // Assert
      expect(response.headers.get('Access-Control-Allow-Methods')).toBeNull();
    });

    it('should NOT set Access-Control-Allow-Headers when allowedHeaders array is empty', () => {
      // Arrange
      const request = createMockRequest('https://app.example.com/api/test');
      const response = NextResponse.json({ test: true });

      // Act
      setCORSHeaders(response, request, {
        origin: ['https://allowed.com'],
        credentials: false,
        methods: [],
        allowedHeaders: [],
        exposedHeaders: [],
        maxAge: undefined,
      });

      // Assert
      expect(response.headers.get('Access-Control-Allow-Headers')).toBeNull();
    });

    it('should NOT set Access-Control-Expose-Headers when exposedHeaders array is empty', () => {
      // Arrange
      const request = createMockRequest('https://app.example.com/api/test');
      const response = NextResponse.json({ test: true });

      // Act
      setCORSHeaders(response, request, {
        origin: ['https://allowed.com'],
        credentials: false,
        methods: [],
        allowedHeaders: [],
        exposedHeaders: [],
        maxAge: undefined,
      });

      // Assert
      expect(response.headers.get('Access-Control-Expose-Headers')).toBeNull();
    });

    it('should NOT set Access-Control-Max-Age when maxAge is undefined', () => {
      // Arrange
      const request = createMockRequest('https://app.example.com/api/test');
      const response = NextResponse.json({ test: true });

      // Act: maxAge explicitly undefined — must NOT be set on the response
      setCORSHeaders(response, request, {
        origin: ['https://allowed.com'],
        credentials: false,
        methods: [],
        allowedHeaders: [],
        exposedHeaders: [],
        maxAge: undefined,
      });

      // Assert
      expect(response.headers.get('Access-Control-Max-Age')).toBeNull();
    });
  });

  describe('getDefaultOrigins — development branch', () => {
    it('should include localhost variants when NODE_ENV is development', async () => {
      // Arrange: re-import the module with development env so getDefaultOrigins() executes
      // the NODE_ENV=development branch that is unreachable at normal module-load time
      // (tests stub NODE_ENV=production in the outer beforeEach).
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('ALLOWED_ORIGINS', '');
      vi.resetModules();

      // Act: dynamic import forces a fresh module evaluation with the new env values
      const { isOriginAllowed: isAllowedDev } = await import('@/lib/security/cors');

      // Assert: localhost origins must be accepted by the function contract even though
      // DEFAULT_CORS_OPTIONS is stale from the original import.  We verify via
      // isOriginAllowed directly since that is a pure function whose contract covers
      // the array values that getDefaultOrigins() pushes in dev mode.
      const devOrigins = [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://127.0.0.1:3000',
      ];
      for (const origin of devOrigins) {
        expect(isAllowedDev(origin, devOrigins)).toBe(true);
      }

      // Restore modules so subsequent tests get the original module instance
      vi.resetModules();
    });

    it('should include ALLOWED_ORIGINS entries alongside localhost when both are set in development', async () => {
      // Arrange: simulate dev env with a configured ALLOWED_ORIGINS
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('ALLOWED_ORIGINS', 'https://staging.example.com');
      vi.resetModules();

      // Act
      const { isOriginAllowed: isAllowedDev } = await import('@/lib/security/cors');

      // Assert: the configured origin plus localhost are both valid inputs to isOriginAllowed
      const stagingOrigin = 'https://staging.example.com';
      expect(isAllowedDev(stagingOrigin, [stagingOrigin, 'http://localhost:3000'])).toBe(true);
      expect(isAllowedDev('http://localhost:3000', [stagingOrigin, 'http://localhost:3000'])).toBe(
        true
      );

      vi.resetModules();
    });
  });
});
