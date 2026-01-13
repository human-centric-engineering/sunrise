/**
 * API Test Helpers
 *
 * Utilities for testing API routes and making mock requests.
 */

import { NextRequest } from 'next/server';
import { expect } from 'vitest';

/**
 * Create a mock NextRequest object
 *
 * Useful for testing API route handlers
 *
 * @example
 * ```ts
 * const request = createMockRequest({
 *   method: 'POST',
 *   url: 'http://localhost:3000/api/v1/users',
 *   body: { name: 'John Doe' }
 * });
 * const response = await POST(request);
 * ```
 */
export function createMockRequest(options: {
  method?: string;
  url?: string;
  body?: unknown;
  headers?: Record<string, string>;
  searchParams?: Record<string, string>;
}) {
  const {
    method = 'GET',
    url = 'http://localhost:3000',
    body,
    headers = {},
    searchParams = {},
  } = options;

  // Build URL with search params
  const urlObj = new URL(url);
  Object.entries(searchParams).forEach(([key, value]) => {
    urlObj.searchParams.set(key, value);
  });

  // Create request init object
  const requestInit: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  } = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  };

  // Add body for non-GET requests
  if (body && method !== 'GET') {
    requestInit.body = JSON.stringify(body);
  }

  return new NextRequest(urlObj.toString(), requestInit as any);
}

/**
 * Create mock request with authentication
 *
 * Adds a mock session cookie to the request
 */
export function createAuthenticatedRequest(options: Parameters<typeof createMockRequest>[0]) {
  return createMockRequest({
    ...options,
    headers: {
      ...options.headers,
      Cookie: 'session=mock_session_token',
    },
  });
}

/**
 * Parse JSON response
 *
 * Helper to extract JSON from a Response object
 */
export async function parseJsonResponse(response: Response): Promise<unknown> {
  return (await response.json()) as unknown;
}

/**
 * Assert API success response
 *
 * Checks that response matches the standardized success format
 */
export function assertSuccessResponse(response: unknown, expectedData?: unknown) {
  expect(response).toHaveProperty('success', true);
  expect(response).toHaveProperty('data');

  if (expectedData && typeof response === 'object' && response !== null && 'data' in response) {
    expect(response.data).toMatchObject(expectedData);
  }
}

/**
 * Assert API error response
 *
 * Checks that response matches the standardized error format
 */
export function assertErrorResponse(
  response: unknown,
  expectedCode?: string,
  expectedMessage?: string
) {
  expect(response).toHaveProperty('success', false);
  expect(response).toHaveProperty('error');

  if (typeof response === 'object' && response !== null && 'error' in response) {
    const error = response.error;
    expect(error).toHaveProperty('code');
    expect(error).toHaveProperty('message');

    if (expectedCode && typeof error === 'object' && error !== null && 'code' in error) {
      expect(error.code).toBe(expectedCode);
    }

    if (expectedMessage && typeof error === 'object' && error !== null && 'message' in error) {
      expect(error.message).toContain(expectedMessage);
    }
  }
}

/**
 * Create mock search params
 *
 * Creates URLSearchParams object for testing query parameter parsing
 */
export function createMockSearchParams(params: Record<string, string>) {
  return new URLSearchParams(params);
}
