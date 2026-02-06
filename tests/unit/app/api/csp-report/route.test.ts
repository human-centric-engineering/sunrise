/**
 * Unit Tests: POST /api/csp-report Route
 *
 * Tests the CSP violation report endpoint in isolation with mocked dependencies.
 *
 * Test Coverage:
 * - Successful CSP violation report processing (valid body, logs violation, returns 204)
 * - Rate limiting (returns 429 when limit exceeded)
 * - Schema validation:
 *   - Rejects oversized string fields (e.g. 'document-uri' > 2048 chars)
 *   - Rejects non-integer status-code
 *   - Rejects status-code out of range
 *   - Accepts minimal valid report
 *   - Accepts report with all fields
 * - Missing 'csp-report' key returns 204 silently
 * - Malformed JSON body returns 204 silently (catch block)
 * - Empty body returns 204
 * - OPTIONS endpoint returns CORS headers
 *
 * @see app/api/csp-report/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST, OPTIONS } from '@/app/api/csp-report/route';
import type { NextRequest } from 'next/server';
import type { RateLimitResult } from '@/lib/security/rate-limit';

/**
 * Mock dependencies
 */

// Mock route logger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

vi.mock('@/lib/api/context', async () => {
  return {
    getRouteLogger: vi.fn(async () => mockLogger),
  };
});

// Mock rate limiting
vi.mock('@/lib/security/rate-limit', () => ({
  cspReportLimiter: {
    check: vi.fn(),
    reset: vi.fn(),
    peek: vi.fn(),
  },
  createRateLimitResponse: vi.fn(),
}));

// Mock IP utility
vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(),
}));

// Import mocked modules
import { cspReportLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';

/**
 * Helper function to create a mock NextRequest
 */
function createMockRequest(body: unknown, headers?: Record<string, string>): NextRequest {
  const url = 'http://localhost:3000/api/csp-report';

  const requestHeaders = new Headers({
    'Content-Type': 'application/csp-report',
    'User-Agent': 'Mozilla/5.0 (Test Browser)',
    ...headers,
  });

  // Create a mock request with proper json() method
  const request = {
    url,
    headers: requestHeaders,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as NextRequest;

  return request;
}

/**
 * Helper function to create a mock NextRequest that throws when parsing JSON
 */
function createMockRequestWithMalformedBody(): NextRequest {
  const url = 'http://localhost:3000/api/csp-report';

  const requestHeaders = new Headers({
    'Content-Type': 'application/csp-report',
    'User-Agent': 'Mozilla/5.0 (Test Browser)',
  });

  // Create a mock request that throws when json() is called
  const request = {
    url,
    headers: requestHeaders,
    json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token in JSON')),
  } as unknown as NextRequest;

  return request;
}

/**
 * Helper function to create a valid CSP violation report
 */
function createValidCSPReport(overrides?: Record<string, unknown>) {
  return {
    'csp-report': {
      'document-uri': 'https://example.com/page',
      referrer: 'https://example.com',
      'violated-directive': 'script-src',
      'effective-directive': 'script-src',
      'original-policy': "default-src 'self'; script-src 'self'",
      'blocked-uri': 'https://evil.com/script.js',
      'status-code': 200,
      'source-file': 'https://example.com/app.js',
      'line-number': 42,
      'column-number': 15,
      ...overrides,
    },
  };
}

/**
 * Helper function to create a successful rate limit result
 */
function createRateLimitSuccess(): RateLimitResult {
  return {
    success: true,
    limit: 20,
    remaining: 19,
    reset: Math.floor(Date.now() / 1000) + 60,
  };
}

/**
 * Helper function to create a failed rate limit result
 */
function createRateLimitFailure(): RateLimitResult {
  return {
    success: false,
    limit: 20,
    remaining: 0,
    reset: Math.floor(Date.now() / 1000) + 60,
  };
}

/**
 * Test Suite: POST /api/csp-report
 */
describe('POST /api/csp-report', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mocks for successful case
    vi.mocked(getClientIP).mockReturnValue('127.0.0.1');
    vi.mocked(cspReportLimiter.check).mockReturnValue(createRateLimitSuccess());
  });

  describe('Successful CSP violation report processing', () => {
    it('should return 204 and log violation for valid report', async () => {
      // Arrange
      const cspReport = createValidCSPReport();
      const request = createMockRequest(cspReport);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).toHaveBeenCalledWith('CSP Violation', {
        type: 'csp-violation',
        documentUri: 'https://example.com/page',
        violatedDirective: 'script-src',
        effectiveDirective: 'script-src',
        blockedUri: 'https://evil.com/script.js',
        sourceFile: 'https://example.com/app.js',
        lineNumber: 42,
        columnNumber: 15,
        userAgent: 'Mozilla/5.0 (Test Browser)',
      });
    });

    it('should extract client IP and check rate limit', async () => {
      // Arrange
      const cspReport = createValidCSPReport();
      const request = createMockRequest(cspReport);

      // Act
      await POST(request);

      // Assert
      expect(getClientIP).toHaveBeenCalledWith(request);
      expect(cspReportLimiter.check).toHaveBeenCalledWith('127.0.0.1');
    });

    it('should return 204 with no response body', async () => {
      // Arrange
      const cspReport = createValidCSPReport();
      const request = createMockRequest(cspReport);

      // Act
      const response = await POST(request);
      const text = await response.text();

      // Assert
      expect(response.status).toBe(204);
      expect(text).toBe('');
    });

    it('should log violation with user agent from request headers', async () => {
      // Arrange
      const cspReport = createValidCSPReport();
      const request = createMockRequest(cspReport, {
        'User-Agent': 'Mozilla/5.0 (Custom User Agent)',
      });

      // Act
      await POST(request);

      // Assert
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'CSP Violation',
        expect.objectContaining({
          userAgent: 'Mozilla/5.0 (Custom User Agent)',
        })
      );
    });

    it('should accept minimal valid report with only required fields', async () => {
      // Arrange
      const minimalReport = {
        'csp-report': {
          'document-uri': 'https://example.com',
        },
      };
      const request = createMockRequest(minimalReport);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'CSP Violation',
        expect.objectContaining({
          documentUri: 'https://example.com',
        })
      );
    });

    it('should accept report with all optional fields populated', async () => {
      // Arrange
      const fullReport = createValidCSPReport();
      const request = createMockRequest(fullReport);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should handle report without user agent header', async () => {
      // Arrange
      const cspReport = createValidCSPReport();
      const request = createMockRequest(cspReport, {});
      // Remove User-Agent header
      request.headers.delete('User-Agent');

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'CSP Violation',
        expect.objectContaining({
          userAgent: null,
        })
      );
    });
  });

  describe('Rate limiting', () => {
    it('should return 429 when rate limit is exceeded', async () => {
      // Arrange
      const cspReport = createValidCSPReport();
      const request = createMockRequest(cspReport);

      const rateLimitResult = createRateLimitFailure();
      vi.mocked(cspReportLimiter.check).mockReturnValue(rateLimitResult);

      const mockRateLimitResponse = new Response(
        JSON.stringify({
          success: false,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many requests. Please try again later.',
          },
        }),
        { status: 429 }
      );
      vi.mocked(createRateLimitResponse).mockReturnValue(mockRateLimitResponse);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(429);
      expect(createRateLimitResponse).toHaveBeenCalledWith(rateLimitResult);
    });

    it('should not log violation when rate limit is exceeded', async () => {
      // Arrange
      const cspReport = createValidCSPReport();
      const request = createMockRequest(cspReport);

      vi.mocked(cspReportLimiter.check).mockReturnValue(createRateLimitFailure());
      vi.mocked(createRateLimitResponse).mockReturnValue(new Response(null, { status: 429 }));

      // Act
      await POST(request);

      // Assert
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should check rate limit before parsing request body', async () => {
      // Arrange
      const cspReport = createValidCSPReport();
      const request = createMockRequest(cspReport);

      vi.mocked(cspReportLimiter.check).mockReturnValue(createRateLimitFailure());
      vi.mocked(createRateLimitResponse).mockReturnValue(new Response(null, { status: 429 }));

      // Act
      await POST(request);

      // Assert
      expect(cspReportLimiter.check).toHaveBeenCalled();
      expect(request.json).not.toHaveBeenCalled();
    });

    it('should use client IP from getClientIP for rate limiting', async () => {
      // Arrange
      const cspReport = createValidCSPReport();
      const request = createMockRequest(cspReport);

      vi.mocked(getClientIP).mockReturnValue('192.168.1.100');

      // Act
      await POST(request);

      // Assert
      expect(cspReportLimiter.check).toHaveBeenCalledWith('192.168.1.100');
    });
  });

  describe('Schema validation - oversized string fields', () => {
    it('should reject document-uri exceeding 2048 characters', async () => {
      // Arrange
      const longUri = 'https://example.com/' + 'a'.repeat(2049);
      const report = createValidCSPReport({ 'document-uri': longUri });
      const request = createMockRequest(report);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should reject referrer exceeding 2048 characters', async () => {
      // Arrange
      const longReferrer = 'https://example.com/' + 'a'.repeat(2049);
      const report = createValidCSPReport({ referrer: longReferrer });
      const request = createMockRequest(report);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should reject violated-directive exceeding 500 characters', async () => {
      // Arrange
      const longDirective = 'script-src ' + 'a'.repeat(500);
      const report = createValidCSPReport({ 'violated-directive': longDirective });
      const request = createMockRequest(report);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should reject effective-directive exceeding 500 characters', async () => {
      // Arrange
      const longDirective = 'script-src ' + 'a'.repeat(500);
      const report = createValidCSPReport({ 'effective-directive': longDirective });
      const request = createMockRequest(report);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should reject original-policy exceeding 5000 characters', async () => {
      // Arrange
      const longPolicy = 'a'.repeat(5001);
      const report = createValidCSPReport({ 'original-policy': longPolicy });
      const request = createMockRequest(report);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should reject blocked-uri exceeding 2048 characters', async () => {
      // Arrange
      const longUri = 'https://evil.com/' + 'a'.repeat(2049);
      const report = createValidCSPReport({ 'blocked-uri': longUri });
      const request = createMockRequest(report);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should reject source-file exceeding 2048 characters', async () => {
      // Arrange
      const longSource = 'https://example.com/' + 'a'.repeat(2049);
      const report = createValidCSPReport({ 'source-file': longSource });
      const request = createMockRequest(report);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should accept document-uri at exactly 2048 characters', async () => {
      // Arrange
      const maxUri = 'https://example.com/' + 'a'.repeat(2028); // Total = 2048
      const report = createValidCSPReport({ 'document-uri': maxUri });
      const request = createMockRequest(report);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('Schema validation - status-code field', () => {
    it('should reject non-integer status-code', async () => {
      // Arrange
      const report = createValidCSPReport({ 'status-code': 200.5 });
      const request = createMockRequest(report);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should reject status-code below 0', async () => {
      // Arrange
      const report = createValidCSPReport({ 'status-code': -1 });
      const request = createMockRequest(report);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should reject status-code above 999', async () => {
      // Arrange
      const report = createValidCSPReport({ 'status-code': 1000 });
      const request = createMockRequest(report);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should accept status-code at minimum boundary (0)', async () => {
      // Arrange
      const report = createValidCSPReport({ 'status-code': 0 });
      const request = createMockRequest(report);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should accept status-code at maximum boundary (999)', async () => {
      // Arrange
      const report = createValidCSPReport({ 'status-code': 999 });
      const request = createMockRequest(report);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should accept valid HTTP status codes (200, 404, 500)', async () => {
      // Test multiple valid status codes
      const statusCodes = [200, 404, 500];

      for (const statusCode of statusCodes) {
        vi.clearAllMocks();
        vi.mocked(getClientIP).mockReturnValue('127.0.0.1');
        vi.mocked(cspReportLimiter.check).mockReturnValue(createRateLimitSuccess());

        const report = createValidCSPReport({ 'status-code': statusCode });
        const request = createMockRequest(report);

        const response = await POST(request);

        expect(response.status).toBe(204);
        expect(mockLogger.warn).toHaveBeenCalled();
      }
    });
  });

  describe('Schema validation - number fields', () => {
    it('should reject non-integer line-number', async () => {
      // Arrange
      const report = createValidCSPReport({ 'line-number': 42.5 });
      const request = createMockRequest(report);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should reject negative line-number', async () => {
      // Arrange
      const report = createValidCSPReport({ 'line-number': -1 });
      const request = createMockRequest(report);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should reject non-integer column-number', async () => {
      // Arrange
      const report = createValidCSPReport({ 'column-number': 15.7 });
      const request = createMockRequest(report);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should reject negative column-number', async () => {
      // Arrange
      const report = createValidCSPReport({ 'column-number': -5 });
      const request = createMockRequest(report);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should accept line-number and column-number at 0', async () => {
      // Arrange
      const report = createValidCSPReport({ 'line-number': 0, 'column-number': 0 });
      const request = createMockRequest(report);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('Missing csp-report key', () => {
    it('should return 204 silently when csp-report key is missing', async () => {
      // Arrange
      const invalidReport = { 'some-other-key': 'value' };
      const request = createMockRequest(invalidReport);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should return 204 silently when csp-report is null', async () => {
      // Arrange
      const invalidReport = { 'csp-report': null };
      const request = createMockRequest(invalidReport);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should return 204 silently when csp-report is undefined', async () => {
      // Arrange
      const invalidReport = { 'csp-report': undefined };
      const request = createMockRequest(invalidReport);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });
  });

  describe('Malformed JSON body', () => {
    it('should return 204 silently when JSON parsing fails', async () => {
      // Arrange
      const request = createMockRequestWithMalformedBody();

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should not throw error when JSON parsing fails', async () => {
      // Arrange
      const request = createMockRequestWithMalformedBody();

      // Act & Assert - should not throw
      await expect(POST(request)).resolves.toBeDefined();
    });
  });

  describe('Empty body', () => {
    it('should return 204 for empty object body', async () => {
      // Arrange
      const request = createMockRequest({});

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should return 204 for empty array body', async () => {
      // Arrange
      const request = createMockRequest([]);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should return 204 for null body', async () => {
      // Arrange
      const request = createMockRequest(null);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });
  });

  describe('Edge cases', () => {
    it('should handle report with extra unknown fields', async () => {
      // Arrange
      const reportWithExtra = {
        'csp-report': {
          ...createValidCSPReport()['csp-report'],
          'unknown-field': 'value',
          'another-field': 123,
        },
      };
      const request = createMockRequest(reportWithExtra);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should handle report with unicode characters in URIs', async () => {
      // Arrange
      const report = createValidCSPReport({
        'document-uri': 'https://example.com/页面',
        'blocked-uri': 'https://evil.com/скрипт.js',
      });
      const request = createMockRequest(report);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'CSP Violation',
        expect.objectContaining({
          documentUri: 'https://example.com/页面',
          blockedUri: 'https://evil.com/скрипт.js',
        })
      );
    });

    it('should handle report with empty strings for optional fields', async () => {
      // Arrange
      const report = createValidCSPReport({
        referrer: '',
        'violated-directive': '',
        'effective-directive': '',
      });
      const request = createMockRequest(report);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should handle concurrent requests from same IP', async () => {
      // Arrange
      const report1 = createValidCSPReport();
      const report2 = createValidCSPReport({ 'blocked-uri': 'https://evil2.com' });
      const request1 = createMockRequest(report1);
      const request2 = createMockRequest(report2);

      // Mock rate limiter to allow both
      vi.mocked(cspReportLimiter.check)
        .mockReturnValueOnce({ success: true, limit: 20, remaining: 18, reset: 1234 })
        .mockReturnValueOnce({ success: true, limit: 20, remaining: 17, reset: 1234 });

      // Act
      const [response1, response2] = await Promise.all([POST(request1), POST(request2)]);

      // Assert
      expect(response1.status).toBe(204);
      expect(response2.status).toBe(204);
      expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    });
  });

  describe('Security considerations', () => {
    it('should not expose validation errors in response', async () => {
      // Arrange
      const invalidReport = createValidCSPReport({ 'status-code': 'invalid' });
      const request = createMockRequest(invalidReport);

      // Act
      const response = await POST(request);
      const text = await response.text();

      // Assert
      expect(response.status).toBe(204);
      expect(text).toBe(''); // No error details exposed
    });

    it('should not expose parsing errors in response', async () => {
      // Arrange
      const request = createMockRequestWithMalformedBody();

      // Act
      const response = await POST(request);
      const text = await response.text();

      // Assert
      expect(response.status).toBe(204);
      expect(text).toBe(''); // No error details exposed
    });

    it('should silently reject malicious payloads', async () => {
      // Arrange
      const maliciousReport = {
        'csp-report': {
          'document-uri': '<script>alert("xss")</script>',
          'blocked-uri': 'javascript:alert(1)',
        },
      };
      const request = createMockRequest(maliciousReport);

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(204);
      // Should log the violation (sanitization happens at log aggregation layer)
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });
});

/**
 * Test Suite: OPTIONS /api/csp-report
 */
describe('OPTIONS /api/csp-report', () => {
  it('should return 204 status', async () => {
    // Act
    const response = OPTIONS();

    // Assert
    expect(response.status).toBe(204);
  });

  it('should return CORS headers for POST method', async () => {
    // Act
    const response = OPTIONS();

    // Assert
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST');
  });

  it('should allow Content-Type header', async () => {
    // Act
    const response = OPTIONS();

    // Assert
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
  });

  it('should allow all origins', async () => {
    // Act
    const response = OPTIONS();

    // Assert
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('should return empty body', async () => {
    // Act
    const response = OPTIONS();
    const text = await response.text();

    // Assert
    expect(text).toBe('');
  });

  it('should set all required CORS headers', async () => {
    // Act
    const response = OPTIONS();

    // Assert
    expect(response.headers.has('Access-Control-Allow-Methods')).toBe(true);
    expect(response.headers.has('Access-Control-Allow-Headers')).toBe(true);
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(true);
  });
});
