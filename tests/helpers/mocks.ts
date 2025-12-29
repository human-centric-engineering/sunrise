/**
 * General Mock Utilities
 *
 * Common mocks and factories for testing.
 */

import { vi, beforeEach, afterEach } from 'vitest';

/**
 * Mock logger
 *
 * Prevents log spam in test output while allowing verification of log calls
 */
export const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  withContext: vi.fn(() => mockLogger),
};

/**
 * Mock console
 *
 * Silences console output during tests
 */
export function mockConsole() {
  const originalConsole = { ...console };

  beforeEach(() => {
    global.console = {
      ...console,
      log: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    } as Console;
  });

  afterEach(() => {
    global.console = originalConsole;
  });
}

/**
 * Create mock date
 *
 * Returns a consistent date for testing time-sensitive logic
 */
export function createMockDate(dateString?: string) {
  return new Date(dateString || '2024-01-01T00:00:00.000Z');
}

/**
 * Mock environment variables
 *
 * Temporarily sets environment variables for testing
 */
export function mockEnv(env: Record<string, string>) {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    Object.entries(env).forEach(([key, value]) => {
      process.env[key] = value;
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });
}

/**
 * Wait for async operations
 *
 * Helper for testing async code that needs to settle
 */
export async function waitFor(ms: number = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create mock FormData
 *
 * Useful for testing form submissions
 */
export function createMockFormData(data: Record<string, string | Blob>) {
  const formData = new FormData();

  Object.entries(data).forEach(([key, value]) => {
    formData.append(key, value);
  });

  return formData;
}

/**
 * Mock fetch response
 *
 * Creates a mock Response object for testing fetch calls
 */
export function createMockFetchResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => Promise.resolve(data),
    text: async () => Promise.resolve(JSON.stringify(data)),
    headers: new Headers({
      'Content-Type': 'application/json',
    }),
  } as Response;
}

/**
 * Mock fetch function
 *
 * Use this to mock global fetch calls in tests
 */
export function mockFetch(response: unknown, status = 200) {
  return vi.fn(async () => Promise.resolve(createMockFetchResponse(response, status)));
}
