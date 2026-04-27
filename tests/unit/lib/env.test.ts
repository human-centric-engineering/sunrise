/**
 * Tests: Environment variable validation (lib/env.ts)
 *
 * lib/env.ts executes Zod schema validation at module import time.
 * Each test must use vi.resetModules() + dynamic import() to re-trigger
 * validation with a controlled process.env per test case.
 *
 * Test Coverage:
 * - Server path happy path (all required vars valid)
 * - Server path validation failures (DATABASE_URL, BETTER_AUTH_URL, BETTER_AUTH_SECRET)
 * - REQUIRE_EMAIL_VERIFICATION boolean coercion transforms
 * - EMAIL_FROM email validation
 * - NODE_ENV default value
 * - Client (browser) path: only NEXT_PUBLIC_* validated
 * - Error message contains doc hint
 *
 * @see lib/env.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimum valid server-side env vars.
 * Individual tests override specific fields to trigger failures.
 */
const validServerEnv: Record<string, string | undefined> = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/mydb',
  BETTER_AUTH_URL: 'http://localhost:3000',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  NODE_ENV: 'test',
};

/**
 * Save and restore process.env around each test so mutations don't bleed across.
 */
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  vi.resetModules();
});

afterEach(() => {
  // Restore exactly the keys that were present before — wipe any additions
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
  vi.restoreAllMocks();
});

/**
 * Set process.env to exactly the provided map (clearing everything else first,
 * then re-applying saved essential keys like PATH that tests don't need to control).
 */
function setEnv(vars: Record<string, string | undefined>) {
  // Clear the env vars our tests care about
  const keysToManage = [
    'DATABASE_URL',
    'BETTER_AUTH_URL',
    'BETTER_AUTH_SECRET',
    'NEXT_PUBLIC_APP_URL',
    'NODE_ENV',
    'REQUIRE_EMAIL_VERIFICATION',
    'EMAIL_FROM',
  ];
  for (const key of keysToManage) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/**
 * Import the env module fresh after env vars have been set.
 * Returns the exported `env` object if validation passes.
 */
async function importEnv() {
  vi.resetModules();
  const mod = await import('@/lib/env');
  return mod.env;
}

// ---------------------------------------------------------------------------
// Server path — happy path
// ---------------------------------------------------------------------------

describe('server path (typeof window === undefined)', () => {
  beforeEach(() => {
    // Ensure we're in server context (no window)
    vi.stubGlobal('window', undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should export typed env without throwing when all required vars are valid', async () => {
    // Arrange
    setEnv(validServerEnv);

    // Act
    const env = await importEnv();

    // Assert — shape is correct, no throw occurred
    expect(env.DATABASE_URL).toBe('postgresql://user:pass@localhost:5432/mydb');
    expect(env.BETTER_AUTH_URL).toBe('http://localhost:3000');
    expect(env.BETTER_AUTH_SECRET).toBe('a'.repeat(32));
    expect(env.NEXT_PUBLIC_APP_URL).toBe('http://localhost:3000');
  });

  it('should throw when DATABASE_URL has an invalid format', async () => {
    // Arrange — not a valid URL
    setEnv({ ...validServerEnv, DATABASE_URL: 'not-a-url' });

    // Act & Assert
    await expect(importEnv()).rejects.toThrow();
  });

  it('should throw when BETTER_AUTH_URL has an invalid format', async () => {
    // Arrange
    setEnv({ ...validServerEnv, BETTER_AUTH_URL: 'not-a-url' });

    // Act & Assert
    await expect(importEnv()).rejects.toThrow();
  });

  it('should throw when BETTER_AUTH_SECRET is shorter than 32 characters', async () => {
    // Arrange — 31 chars is under the minimum
    setEnv({ ...validServerEnv, BETTER_AUTH_SECRET: 'a'.repeat(31) });

    // Act & Assert
    await expect(importEnv()).rejects.toThrow();
  });

  it('should pass when BETTER_AUTH_SECRET is exactly 32 characters (boundary)', async () => {
    // Arrange — exactly 32 chars should satisfy the min(32) constraint
    setEnv({ ...validServerEnv, BETTER_AUTH_SECRET: 'a'.repeat(32) });

    // Act
    const env = await importEnv();

    // Assert — no throw, secret is preserved
    expect(env.BETTER_AUTH_SECRET).toHaveLength(32);
  });

  it('should throw when EMAIL_FROM is not a valid email address', async () => {
    // Arrange
    setEnv({ ...validServerEnv, EMAIL_FROM: 'not-an-email' });

    // Act & Assert
    await expect(importEnv()).rejects.toThrow();
  });

  it("should default NODE_ENV to 'development' when the variable is absent", async () => {
    // Arrange — omit NODE_ENV and use delete to ensure it's absent from process.env.
    // Note: Vitest sets NODE_ENV='test' as part of the test runner environment.
    // We must delete it from process.env to allow the Zod default to activate.
    const envWithoutNodeEnv = { ...validServerEnv };
    delete envWithoutNodeEnv.NODE_ENV;
    setEnv(envWithoutNodeEnv);
    // delete ensures undefined (not the string "undefined") is what Zod sees.
    // Cast via `as` to bypass the read-only TypeScript type — only valid in tests.
    delete (process.env as Record<string, string | undefined>).NODE_ENV;

    // Act
    const env = await importEnv();

    // Assert — Zod .default('development') kicks in when the key is truly absent
    expect(env.NODE_ENV).toBe('development');
  });

  it('should include a doc hint referencing .context/environment in the error message', async () => {
    // Arrange — trigger a validation failure
    setEnv({ ...validServerEnv, DATABASE_URL: 'bad-url' });

    // Act & Assert — error message should mention the doc path
    await expect(importEnv()).rejects.toThrow('.context/environment');
  });

  describe('REQUIRE_EMAIL_VERIFICATION transforms', () => {
    it("should coerce string 'true' to boolean true", async () => {
      // Arrange
      setEnv({ ...validServerEnv, REQUIRE_EMAIL_VERIFICATION: 'true' });

      // Act
      const env = await importEnv();

      // Assert
      expect(env.REQUIRE_EMAIL_VERIFICATION).toBe(true);
    });

    it("should coerce string 'false' to boolean false", async () => {
      // Arrange
      setEnv({ ...validServerEnv, REQUIRE_EMAIL_VERIFICATION: 'false' });

      // Act
      const env = await importEnv();

      // Assert
      expect(env.REQUIRE_EMAIL_VERIFICATION).toBe(false);
    });

    it('should return undefined when REQUIRE_EMAIL_VERIFICATION is absent', async () => {
      // Arrange — do not set the variable
      const envWithout = { ...validServerEnv };
      delete envWithout.REQUIRE_EMAIL_VERIFICATION;
      setEnv(envWithout);

      // Act
      const env = await importEnv();

      // Assert
      expect(env.REQUIRE_EMAIL_VERIFICATION).toBeUndefined();
    });

    it('should return undefined (no throw) for an unrecognised string value', async () => {
      // Arrange — a value that is neither 'true' nor 'false'
      setEnv({ ...validServerEnv, REQUIRE_EMAIL_VERIFICATION: 'yes' });

      // Act — should not throw; unrecognised strings are silently coerced to undefined
      const env = await importEnv();

      // Assert
      expect(env.REQUIRE_EMAIL_VERIFICATION).toBeUndefined();
    });
  });

  describe('console output on validation failure', () => {
    it('should call console.error when validation fails', async () => {
      // Arrange
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      setEnv({ ...validServerEnv, DATABASE_URL: 'bad-url' });

      // Act
      await importEnv().catch(() => {
        /* expected */
      });

      // Assert — error output was triggered
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('should call console.log in development mode when validation succeeds', async () => {
      // Arrange
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      setEnv({ ...validServerEnv, NODE_ENV: 'development' });

      // Act
      await importEnv();

      // Assert — success log is emitted
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Environment variables validated')
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Client path (browser)
// ---------------------------------------------------------------------------

describe('client path (typeof window !== undefined)', () => {
  beforeEach(() => {
    // Simulate browser environment
    vi.stubGlobal('window', {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should validate successfully with only NEXT_PUBLIC_APP_URL set (server vars absent)', async () => {
    // Arrange — server-only vars deliberately absent
    setEnv({ NEXT_PUBLIC_APP_URL: 'http://localhost:3000' });

    // Act
    const env = await importEnv();

    // Assert — exports env without throwing
    expect(env.NEXT_PUBLIC_APP_URL).toBe('http://localhost:3000');
  });

  it('should throw when NEXT_PUBLIC_APP_URL is absent', async () => {
    // Arrange — clear NEXT_PUBLIC_APP_URL
    setEnv({});

    // Act & Assert
    await expect(importEnv()).rejects.toThrow();
  });
});
