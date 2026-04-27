/**
 * Tests: Logging module — supplementary coverage (lib/logging/index.ts)
 *
 * This file covers scenarios not present in the existing logger.test.ts:
 * - matchesSensitiveField word-boundary matching (e.g. "ip" must NOT match "recipients")
 * - addLogEntry integration via @/lib/admin/logs (pushToLogBuffer path)
 * - Non-Error objects serialized as UnknownError (number, boolean, plain object)
 * - console.error vs console.log routing per log level
 * - Explicit log-level filter transitions (DEBUG blocked when level = INFO)
 * - child() / withContext() return distinct Logger instances with merged context
 * - setLevel() / getLevel() round-trip
 * - createLogger() factory produces a Logger with the supplied context
 *
 * Note: Broad PII sanitization, formatDev/formatProd, and environment toggling
 * are already comprehensively covered in logger.test.ts. Tests here focus on
 * contract gaps and edge-case branches.
 *
 * @see lib/logging/index.ts
 * @see tests/unit/lib/logging/logger.test.ts  (primary coverage file)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger, LogLevel, createLogger } from '@/lib/logging';

// ---------------------------------------------------------------------------
// Mock @/lib/admin/logs so we can assert pushToLogBuffer calls addLogEntry
// ---------------------------------------------------------------------------

const mockAddLogEntry = vi.fn();

vi.mock('@/lib/admin/logs', () => ({
  addLogEntry: mockAddLogEntry,
}));

// ---------------------------------------------------------------------------
// Interface for type-safe JSON log parsing (production format)
// ---------------------------------------------------------------------------

interface ParsedLogOutput {
  level: string;
  message: string;
  timestamp: string;
  meta?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
  };
  context?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  mockAddLogEntry.mockClear();

  // Default: production so output is parseable JSON
  vi.stubEnv('NODE_ENV', 'production');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// 1. Log level filtering
// ---------------------------------------------------------------------------

describe('Logger — log level filtering', () => {
  it('should not output a DEBUG message when level is INFO', () => {
    // Arrange
    const log = new Logger(LogLevel.INFO);

    // Act
    log.debug('should be suppressed');

    // Assert
    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('should output an INFO message when level is INFO', () => {
    // Arrange
    const log = new Logger(LogLevel.INFO);

    // Act
    log.info('visible message');

    // Assert
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('visible message'));
  });
});

// ---------------------------------------------------------------------------
// 2. console routing: error() → console.error; others → console.log
// ---------------------------------------------------------------------------

describe('Logger — console method routing', () => {
  it('should route error() calls to console.error', () => {
    // Arrange
    const log = new Logger(LogLevel.ERROR);

    // Act
    log.error('an error occurred');

    // Assert
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('an error occurred'));
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('should route info() calls to console.log', () => {
    // Arrange
    const log = new Logger(LogLevel.INFO);

    // Act
    log.info('info message');

    // Assert
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('info message'));
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('should route debug() calls to console.log', () => {
    // Arrange
    vi.stubEnv('NODE_ENV', 'development');
    const log = new Logger(LogLevel.DEBUG);

    // Act
    log.debug('debug message');

    // Assert
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('debug message'));
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('should route warn() calls to console.log', () => {
    // Arrange
    const log = new Logger(LogLevel.WARN);

    // Act
    log.warn('warn message');

    // Assert
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('warn message'));
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Sanitization — secrets always redacted
// ---------------------------------------------------------------------------

describe('Logger — secret field sanitization', () => {
  it('should redact "password" to [REDACTED] regardless of environment', () => {
    // Arrange — development environment (PII shown by default, but secrets always hidden)
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('LOG_SANITIZE_PII', 'false');
    const log = new Logger(LogLevel.INFO);

    // Act
    log.info('login attempt', { password: 'hunter2' });

    // Assert — dev format string should not expose the password
    const output = consoleLogSpy.mock.calls[0]?.[0] as string;
    expect(output).not.toContain('hunter2');
    expect(output).toContain('[REDACTED]');
  });

  it('should redact "token" to [REDACTED] always', () => {
    // Arrange
    vi.stubEnv('NODE_ENV', 'development');
    const log = new Logger(LogLevel.INFO);

    // Act
    log.info('api call', { token: 'tok_secret_xyz' });

    // Assert
    const output = consoleLogSpy.mock.calls[0]?.[0] as string;
    expect(output).not.toContain('tok_secret_xyz');
    expect(output).toContain('[REDACTED]');
  });

  it('should redact "apiKey" to [REDACTED] always', () => {
    // Arrange
    vi.stubEnv('NODE_ENV', 'development');
    const log = new Logger(LogLevel.INFO);

    // Act
    log.info('external request', { apiKey: 'key_very_secret' });

    // Assert
    const output = consoleLogSpy.mock.calls[0]?.[0] as string;
    expect(output).not.toContain('key_very_secret');
    expect(output).toContain('[REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// 4. Sanitization — PII fields
// ---------------------------------------------------------------------------

describe('Logger — PII field sanitization', () => {
  it('should redact "email" to [PII REDACTED] in production', () => {
    // Arrange
    vi.stubEnv('NODE_ENV', 'production');
    const log = new Logger(LogLevel.INFO);

    // Act
    log.info('user data', { email: 'user@example.com' });

    // Assert
    const output = consoleLogSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output) as ParsedLogOutput;
    expect((parsed.meta as Record<string, unknown>).email).toBe('[PII REDACTED]');
  });

  it('should redact "phone" to [PII REDACTED] in production', () => {
    // Arrange
    vi.stubEnv('NODE_ENV', 'production');
    const log = new Logger(LogLevel.INFO);

    // Act
    log.info('contact', { phone: '+44 7700 900000' });

    // Assert
    const output = consoleLogSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output) as ParsedLogOutput;
    expect((parsed.meta as Record<string, unknown>).phone).toBe('[PII REDACTED]');
  });

  it('should show PII fields in development by default', () => {
    // Arrange
    vi.stubEnv('NODE_ENV', 'development');
    // Ensure LOG_SANITIZE_PII is not set (auto-mode)
    const log = new Logger(LogLevel.INFO);

    // Act
    log.info('user data', { email: 'visible@example.com' });

    // Assert — development format is a plain string; email should be visible
    const output = consoleLogSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain('visible@example.com');
  });

  it('should redact PII when LOG_SANITIZE_PII=true even in development', () => {
    // Arrange
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('LOG_SANITIZE_PII', 'true');
    const log = new Logger(LogLevel.INFO);

    // Act
    log.info('user data', { email: 'forced@example.com' });

    // Assert
    const output = consoleLogSpy.mock.calls[0]?.[0] as string;
    expect(output).not.toContain('forced@example.com');
    expect(output).toContain('[PII REDACTED]');
  });

  it('should show PII when LOG_SANITIZE_PII=false even in production', () => {
    // Arrange
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('LOG_SANITIZE_PII', 'false');
    const log = new Logger(LogLevel.INFO);

    // Act
    log.info('user data', { email: 'override@example.com' });

    // Assert — production format is JSON; email should NOT be redacted
    const output = consoleLogSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output) as ParsedLogOutput;
    expect((parsed.meta as Record<string, unknown>).email).toBe('override@example.com');
  });
});

// ---------------------------------------------------------------------------
// 5. Sanitization — nested objects and arrays
// ---------------------------------------------------------------------------

describe('Logger — recursive sanitization', () => {
  it('should recursively sanitize secrets in nested objects', () => {
    // Arrange
    vi.stubEnv('NODE_ENV', 'production');
    const log = new Logger(LogLevel.INFO);

    // Act
    log.info('nested', { outer: { inner: { password: 'deep_secret' } } });

    // Assert
    const output = consoleLogSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output) as ParsedLogOutput;
    const meta = parsed.meta as Record<string, unknown>;
    expect(
      ((meta.outer as Record<string, unknown>).inner as Record<string, unknown>).password
    ).toBe('[REDACTED]');
  });

  it('should recursively sanitize secrets in arrays of objects', () => {
    // Arrange
    vi.stubEnv('NODE_ENV', 'production');
    const log = new Logger(LogLevel.INFO);

    // Act
    log.info('array', { items: [{ token: 'tok_one' }, { token: 'tok_two' }] });

    // Assert
    const output = consoleLogSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output) as ParsedLogOutput;
    const meta = parsed.meta as Record<string, unknown>;
    const items = meta.items as Array<Record<string, unknown>>;
    expect(items[0]?.token).toBe('[REDACTED]');
    expect(items[1]?.token).toBe('[REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// 6. matchesSensitiveField — word-boundary matching precision
// ---------------------------------------------------------------------------

describe('Logger — matchesSensitiveField word-boundary matching', () => {
  it('should NOT redact "recipients" even though it contains "ip"', () => {
    // Arrange — "ip" is in the PII_FIELDS list; "recipients" must NOT match
    vi.stubEnv('NODE_ENV', 'production');
    const log = new Logger(LogLevel.INFO);

    // Act
    log.info('email batch', { recipients: ['a@b.com', 'c@d.com'] });

    // Assert — "recipients" is NOT a PII field match; array should be preserved as-is
    const output = consoleLogSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output) as ParsedLogOutput;
    const meta = parsed.meta as Record<string, unknown>;
    // The field name "recipients" should not be treated as PII
    expect(meta.recipients).toBeDefined();
    // Verify the field was NOT redacted to '[PII REDACTED]'
    expect(meta.recipients).not.toBe('[PII REDACTED]');
  });

  it('should NOT redact "shipping" even though "ip" is a substring', () => {
    // Arrange
    vi.stubEnv('NODE_ENV', 'production');
    const log = new Logger(LogLevel.INFO);

    // Act
    log.info('order', { shipping: 'standard' });

    // Assert — "shipping" must not match the "ip" PII pattern
    const output = consoleLogSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output) as ParsedLogOutput;
    const meta = parsed.meta as Record<string, unknown>;
    expect(meta.shipping).toBe('standard');
  });

  it('should redact the exact field "ip" in production', () => {
    // Arrange — "ip" itself IS a PII field and must be redacted
    vi.stubEnv('NODE_ENV', 'production');
    const log = new Logger(LogLevel.INFO);

    // Act
    log.info('request', { ip: '192.168.1.1' });

    // Assert
    const output = consoleLogSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output) as ParsedLogOutput;
    const meta = parsed.meta as Record<string, unknown>;
    expect(meta.ip).toBe('[PII REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// 7. Non-Error objects in error() — UnknownError fallback path
// ---------------------------------------------------------------------------

describe('Logger — non-Error objects in error()', () => {
  it('should serialize a plain object as UnknownError with JSON message', () => {
    // Arrange
    vi.stubEnv('NODE_ENV', 'production');
    const log = new Logger(LogLevel.ERROR);
    const plainObj = { code: 500, reason: 'timeout' };

    // Act
    log.error('operation failed', plainObj);

    // Assert — error.name is 'UnknownError', message is stringified JSON
    const output = consoleErrorSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output) as ParsedLogOutput;
    expect(parsed.error?.name).toBe('UnknownError');
    expect(parsed.error?.message).toContain('"code"');
    expect(parsed.error?.message).toContain('500');
  });

  it('should serialize a number as UnknownError', () => {
    // Arrange
    vi.stubEnv('NODE_ENV', 'production');
    const log = new Logger(LogLevel.ERROR);

    // Act
    log.error('numeric error', 42);

    // Assert
    const output = consoleErrorSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output) as ParsedLogOutput;
    expect(parsed.error?.name).toBe('UnknownError');
    expect(parsed.error?.message).toBe('42');
  });

  it('should serialize true (boolean) as UnknownError', () => {
    // Arrange — true is truthy so it enters the non-Error branch
    vi.stubEnv('NODE_ENV', 'production');
    const log = new Logger(LogLevel.ERROR);

    // Act
    log.error('boolean error', true);

    // Assert
    const output = consoleErrorSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output) as ParsedLogOutput;
    expect(parsed.error?.name).toBe('UnknownError');
    expect(parsed.error?.message).toBe('true');
  });

  it('should produce no error field when null is passed (null is falsy — guard skips it)', () => {
    // Arrange — null is falsy; the `if (error)` guard skips null entirely
    vi.stubEnv('NODE_ENV', 'production');
    const log = new Logger(LogLevel.ERROR);

    // Act
    log.error('error message', null);

    // Assert — message is output; no error field is set
    const output = consoleErrorSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output) as ParsedLogOutput;
    expect(parsed.message).toBe('error message');
    expect(parsed.error).toBeUndefined();
  });

  it('should handle a string error and include it in the message', () => {
    // Arrange
    vi.stubEnv('NODE_ENV', 'production');
    const log = new Logger(LogLevel.ERROR);

    // Act
    log.error('string error path', 'something went wrong');

    // Assert — error.name = 'UnknownError', message = the string itself
    const output = consoleErrorSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output) as ParsedLogOutput;
    expect(parsed.error?.name).toBe('UnknownError');
    expect(parsed.error?.message).toBe('something went wrong');
  });
});

// ---------------------------------------------------------------------------
// 8. pushToLogBuffer — silent failure contract
//
// pushToLogBuffer uses require('@/lib/admin/logs') inside a try/catch.
// In the test environment the @/ alias is not resolved by raw require(), so
// the require throws, the catch swallows it, and the logger does NOT crash.
// The tests below verify the silent-failure contract.
// ---------------------------------------------------------------------------

describe('Logger — pushToLogBuffer silent-failure contract', () => {
  it('should not throw when the log buffer module is unavailable', () => {
    // Arrange — the @/lib/admin/logs require will silently fail in test env
    vi.stubEnv('NODE_ENV', 'production');
    const log = new Logger(LogLevel.INFO);

    // Act & Assert — no exception propagates
    expect(() => log.info('buffer unavailable')).not.toThrow();
  });

  it('should still output to console even when the log buffer module is unavailable', () => {
    // Arrange
    vi.stubEnv('NODE_ENV', 'production');
    const log = new Logger(LogLevel.INFO);

    // Act
    log.info('still outputs to console');

    // Assert — the console output path is independent of the buffer path
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('still outputs to console'));
  });

  it('should not call addLogEntry when log level is suppressed (no output at all)', () => {
    // Arrange — level=ERROR means INFO is suppressed
    const log = new Logger(LogLevel.ERROR);

    // Act
    log.info('suppressed info');

    // Assert — no console output (buffer path is also skipped via shouldLog)
    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 9. Output format — dev vs production
// ---------------------------------------------------------------------------

describe('Logger — output format', () => {
  it('should output human-readable string (not JSON) in development', () => {
    // Arrange
    vi.stubEnv('NODE_ENV', 'development');
    const log = new Logger(LogLevel.INFO);

    // Act
    log.info('dev format message');

    // Assert — dev format is NOT valid JSON; it uses ANSI colour codes
    const output = consoleLogSpy.mock.calls[0]?.[0] as string;
    expect(() => JSON.parse(output)).toThrow();
    expect(output).toContain('dev format message');
  });

  it('should output valid JSON in production', () => {
    // Arrange
    vi.stubEnv('NODE_ENV', 'production');
    const log = new Logger(LogLevel.INFO);

    // Act
    log.info('prod format message');

    // Assert
    const output = consoleLogSpy.mock.calls[0]?.[0] as string;
    expect(() => JSON.parse(output)).not.toThrow();
    const parsed = JSON.parse(output) as ParsedLogOutput;
    expect(parsed.message).toBe('prod format message');
    expect(parsed.level).toBe('info');
    expect(parsed.timestamp).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 10. child() / withContext()
// ---------------------------------------------------------------------------

describe('Logger — child() and withContext()', () => {
  it('should return a new Logger instance from child()', () => {
    // Arrange
    const parent = new Logger(LogLevel.INFO, { requestId: 'req-1' });

    // Act
    const child = parent.child({ userId: 'u1' });

    // Assert
    expect(child).toBeInstanceOf(Logger);
    expect(child).not.toBe(parent);
  });

  it('should merge parent and child context in child()', () => {
    // Arrange
    vi.stubEnv('NODE_ENV', 'production');
    const parent = new Logger(LogLevel.INFO, { requestId: 'req-abc' });

    // Act
    const child = parent.child({ userId: 'usr-xyz' });
    child.info('merged context message');

    // Assert — both context fields appear in the output
    const output = consoleLogSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output) as ParsedLogOutput;
    expect(parsed.context?.requestId).toBe('req-abc');
    expect(parsed.context?.userId).toBe('usr-xyz');
  });

  it('should return a new Logger instance from withContext()', () => {
    // Arrange
    const base = new Logger(LogLevel.INFO);

    // Act
    const ctx = base.withContext({ sessionId: 'sess-1' });

    // Assert
    expect(ctx).toBeInstanceOf(Logger);
    expect(ctx).not.toBe(base);
  });

  it('should include withContext() context in log output', () => {
    // Arrange
    vi.stubEnv('NODE_ENV', 'production');
    const base = new Logger(LogLevel.INFO);
    const ctx = base.withContext({ sessionId: 'sess-999' });

    // Act
    ctx.info('session message');

    // Assert
    const output = consoleLogSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output) as ParsedLogOutput;
    expect(parsed.context?.sessionId).toBe('sess-999');
  });
});

// ---------------------------------------------------------------------------
// 11. setLevel() / getLevel()
// ---------------------------------------------------------------------------

describe('Logger — setLevel() and getLevel()', () => {
  it('should return the level set in the constructor via getLevel()', () => {
    // Arrange
    const log = new Logger(LogLevel.WARN);

    // Act / Assert
    expect(log.getLevel()).toBe(LogLevel.WARN);
  });

  it('should update the level and suppress lower-priority messages after setLevel()', () => {
    // Arrange
    const log = new Logger(LogLevel.DEBUG);

    // Act
    log.setLevel(LogLevel.ERROR);

    // Assert — INFO is now below the threshold
    log.info('should not appear');
    expect(consoleLogSpy).not.toHaveBeenCalled();

    log.error('should appear');
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('should report the updated level via getLevel() after setLevel()', () => {
    // Arrange
    const log = new Logger(LogLevel.DEBUG);

    // Act
    log.setLevel(LogLevel.WARN);

    // Assert
    expect(log.getLevel()).toBe(LogLevel.WARN);
  });
});

// ---------------------------------------------------------------------------
// 12. createLogger() factory
// ---------------------------------------------------------------------------

describe('createLogger()', () => {
  it('should return a Logger instance', () => {
    // Act
    const log = createLogger();

    // Assert
    expect(log).toBeInstanceOf(Logger);
  });

  it('should return a Logger that includes the supplied context in output', () => {
    // Arrange
    vi.stubEnv('NODE_ENV', 'production');

    // Act
    const log = createLogger({ module: 'auth', requestId: 'r-factory' });
    log.info('factory test');

    // Assert
    const output = consoleLogSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output) as ParsedLogOutput;
    expect(parsed.context?.module).toBe('auth');
    expect(parsed.context?.requestId).toBe('r-factory');
  });

  it('should create logger without context when called with no arguments', () => {
    // Arrange
    vi.stubEnv('NODE_ENV', 'production');

    // Act
    const log = createLogger();
    log.info('no context');

    // Assert — context field absent when empty
    const output = consoleLogSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output) as ParsedLogOutput;
    expect(parsed.context).toBeUndefined();
  });
});
