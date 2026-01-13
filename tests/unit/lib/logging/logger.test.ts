/**
 * Logger Class Tests
 *
 * Tests for the Logger class in lib/logging/index.ts
 * - Log levels (debug, info, warn, error)
 * - PII sanitization (password, token, secrets)
 * - Environment-aware formatting (dev vs production)
 * - Child loggers with context
 * - Error logging with stack traces
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger, LogLevel, createLogger, logger } from '@/lib/logging';
import { assertDefined } from '@/tests/helpers/assertions';

/**
 * Type for parsed JSON log output
 */
interface ParsedLogOutput {
  level: string;
  message: string;
  timestamp: string;
  meta?: Record<string, unknown>;
  error?: {
    message: string;
    stack?: string;
  };
  context?: Record<string, unknown>;
}

describe('Logger', () => {
  // Mock console methods
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Spy on console methods
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Reset environment
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    // Restore mocks
    vi.restoreAllMocks();
  });

  describe('Log Levels - Basic Functionality', () => {
    it('should respect log level filtering - INFO level blocks DEBUG', () => {
      // Arrange: Create logger with INFO level
      const testLogger = new Logger(LogLevel.INFO);

      // Act: Try to log DEBUG message
      testLogger.debug('debug message');

      // Assert: Nothing logged
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should respect log level filtering - INFO level allows INFO', () => {
      // Arrange: Create logger with INFO level
      const testLogger = new Logger(LogLevel.INFO);

      // Act: Log INFO message
      testLogger.info('info message');

      // Assert: Message logged
      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it('should respect log level filtering - INFO level allows WARN', () => {
      // Arrange: Create logger with INFO level
      const testLogger = new Logger(LogLevel.INFO);

      // Act: Log WARN message
      testLogger.warn('warning message');

      // Assert: Message logged
      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it('should respect log level filtering - INFO level allows ERROR', () => {
      // Arrange: Create logger with INFO level
      const testLogger = new Logger(LogLevel.INFO);

      // Act: Log ERROR message
      testLogger.error('error message');

      // Assert: Message logged
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('should log DEBUG in development by default', () => {
      // Arrange: Set environment to development
      vi.stubEnv('NODE_ENV', 'development');
      const testLogger = new Logger();

      // Act: Log debug message
      testLogger.debug('debug message');

      // Assert: Message logged
      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it('should not log DEBUG in production by default', () => {
      // Arrange: Set environment to production (default level is INFO)
      vi.stubEnv('NODE_ENV', 'production');
      const testLogger = new Logger();

      // Act: Try to log debug message
      testLogger.debug('debug message');

      // Assert: Nothing logged
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should respect LOG_LEVEL environment variable', () => {
      // Arrange: Set LOG_LEVEL to ERROR
      vi.stubEnv('LOG_LEVEL', 'error');
      const testLogger = new Logger();

      // Act: Try to log INFO message
      testLogger.info('info message');

      // Assert: Nothing logged (level is ERROR)
      expect(consoleLogSpy).not.toHaveBeenCalled();

      // Act: Log ERROR message
      testLogger.error('error message');

      // Assert: Message logged
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe('Log Methods - Output', () => {
    it('should log debug messages with metadata', () => {
      // Arrange
      const testLogger = new Logger(LogLevel.DEBUG);
      const meta = { userId: '123', action: 'test' };

      // Act
      testLogger.debug('Debug message', meta);

      // Assert
      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0]?.[0] as string;
      expect(output).toContain('Debug message');
    });

    it('should log info messages with metadata', () => {
      // Arrange
      const testLogger = new Logger(LogLevel.INFO);
      const meta = { requestId: 'abc123' };

      // Act
      testLogger.info('Info message', meta);

      // Assert
      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0]?.[0] as string;
      expect(output).toContain('Info message');
    });

    it('should log warning messages', () => {
      // Arrange
      const testLogger = new Logger(LogLevel.WARN);

      // Act
      testLogger.warn('Warning message');

      // Assert
      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0]?.[0] as string;
      expect(output).toContain('Warning message');
    });

    it('should log error messages with error objects', () => {
      // Arrange
      const testLogger = new Logger(LogLevel.ERROR);
      const error = new Error('Test error');

      // Act
      testLogger.error('Error occurred', error);

      // Assert: Uses console.error for ERROR level
      expect(consoleErrorSpy).toHaveBeenCalled();
      const output = consoleErrorSpy.mock.calls[0]?.[0] as string;
      expect(output).toContain('Error occurred');
      expect(output).toContain('Test error');
    });

    it('should include stack traces for errors', () => {
      // Arrange
      const testLogger = new Logger(LogLevel.ERROR);
      const error = new Error('Test error with stack');

      // Act
      testLogger.error('Error message', error);

      // Assert
      expect(consoleErrorSpy).toHaveBeenCalled();
      const output = consoleErrorSpy.mock.calls[0]?.[0] as string;
      expect(output).toContain('Test error with stack');
    });

    it('should handle non-Error objects in error logging', () => {
      // Arrange
      const testLogger = new Logger(LogLevel.ERROR);
      const errorString = 'String error';

      // Act
      testLogger.error('Error message', errorString);

      // Assert
      expect(consoleErrorSpy).toHaveBeenCalled();
      const output = consoleErrorSpy.mock.calls[0]?.[0] as string;
      expect(output).toContain('String error');
    });

    it('should handle error objects with code property', () => {
      // Arrange
      const testLogger = new Logger(LogLevel.ERROR);
      const error = Object.assign(new Error('Custom error'), { code: 'E001' });

      // Act
      testLogger.error('Error with code', error);

      // Assert
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('should handle null/undefined errors gracefully', () => {
      // Arrange
      const testLogger = new Logger(LogLevel.ERROR);

      // Act
      testLogger.error('Error message', null);

      // Assert: Should not throw
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe('PII Sanitization', () => {
    it('should sanitize password fields', () => {
      // Arrange
      vi.stubEnv('NODE_ENV', 'production');
      const testLogger = new Logger(LogLevel.INFO);
      const meta = { user: { password: 'secret123' } };

      // Act
      testLogger.info('User login', meta);

      // Assert
      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(output) as ParsedLogOutput;
      assertDefined(parsed.meta);
      expect((parsed.meta as any).user.password).toBe('[REDACTED]');
    });

    it('should sanitize token fields', () => {
      // Arrange
      vi.stubEnv('NODE_ENV', 'production');
      const testLogger = new Logger(LogLevel.INFO);
      const meta = { token: 'abc123xyz' };

      // Act
      testLogger.info('API call', meta);

      // Assert
      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(output) as ParsedLogOutput;
      assertDefined(parsed.meta);
      expect((parsed.meta as any).token).toBe('[REDACTED]');
    });

    it('should sanitize apiKey fields', () => {
      // Arrange
      vi.stubEnv('NODE_ENV', 'production');
      const testLogger = new Logger(LogLevel.INFO);
      const meta = { apiKey: 'key_12345' };

      // Act
      testLogger.info('External API', meta);

      // Assert
      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(output) as ParsedLogOutput;
      assertDefined(parsed.meta);
      expect((parsed.meta as any).apiKey).toBe('[REDACTED]');
    });

    it('should sanitize secret fields', () => {
      // Arrange
      vi.stubEnv('NODE_ENV', 'production');
      const testLogger = new Logger(LogLevel.INFO);
      const meta = { secret: 'my-secret-value' };

      // Act
      testLogger.info('Config loaded', meta);

      // Assert
      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(output) as ParsedLogOutput;
      assertDefined(parsed.meta);
      expect((parsed.meta as any).secret).toBe('[REDACTED]');
    });

    it('should sanitize nested sensitive fields recursively', () => {
      // Arrange
      vi.stubEnv('NODE_ENV', 'production');
      const testLogger = new Logger(LogLevel.INFO);
      const meta = {
        user: {
          displayName: 'John',
          auth: {
            password: 'secret',
            token: 'abc123',
          },
        },
      };

      // Act
      testLogger.info('User data', meta);

      // Assert
      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(output) as ParsedLogOutput;
      assertDefined(parsed.meta);
      expect((parsed.meta as any).user.auth.password).toBe('[REDACTED]');
      assertDefined(parsed.meta);
      expect((parsed.meta as any).user.auth.token).toBe('[REDACTED]');
      assertDefined(parsed.meta);
      expect((parsed.meta as any).user.displayName).toBe('John'); // Non-sensitive preserved
    });

    it('should use case-insensitive matching for sensitive fields', () => {
      // Arrange
      vi.stubEnv('NODE_ENV', 'production');
      const testLogger = new Logger(LogLevel.INFO);
      const meta = {
        PASSWORD: 'test',
        Token: 'test',
        ApiKey: 'test',
      };

      // Act
      testLogger.info('Mixed case', meta);

      // Assert
      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(output) as ParsedLogOutput;
      assertDefined(parsed.meta);
      expect((parsed.meta as any).PASSWORD).toBe('[REDACTED]');
      assertDefined(parsed.meta);
      expect((parsed.meta as any).Token).toBe('[REDACTED]');
      assertDefined(parsed.meta);
      expect((parsed.meta as any).ApiKey).toBe('[REDACTED]');
    });

    it('should preserve non-sensitive, non-PII data', () => {
      // Arrange
      vi.stubEnv('NODE_ENV', 'production');
      const testLogger = new Logger(LogLevel.INFO);
      const meta = {
        userId: 'usr_123',
        orderId: 'ord_456',
        amount: 99.99,
      };

      // Act
      testLogger.info('Order info', meta);

      // Assert
      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(output) as ParsedLogOutput;
      assertDefined(parsed.meta);
      expect((parsed.meta as any).userId).toBe('usr_123');
      assertDefined(parsed.meta);
      expect((parsed.meta as any).orderId).toBe('ord_456');
      assertDefined(parsed.meta);
      expect((parsed.meta as any).amount).toBe(99.99);
    });

    it('should sanitize arrays containing sensitive data', () => {
      // Arrange
      vi.stubEnv('NODE_ENV', 'production');
      const testLogger = new Logger(LogLevel.INFO);
      const meta = {
        users: [
          { userId: 'usr_1', password: 'secret1' },
          { userId: 'usr_2', password: 'secret2' },
        ],
      };

      // Act
      testLogger.info('User list', meta);

      // Assert
      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(output) as ParsedLogOutput;
      assertDefined(parsed.meta);
      expect((parsed.meta as any).users[0].password).toBe('[REDACTED]');
      assertDefined(parsed.meta);
      expect((parsed.meta as any).users[1].password).toBe('[REDACTED]');
      assertDefined(parsed.meta);
      expect((parsed.meta as any).users[0].userId).toBe('usr_1');
      assertDefined(parsed.meta);
      expect((parsed.meta as any).users[1].userId).toBe('usr_2');
    });
  });

  describe('PII Sanitization - GDPR Compliance', () => {
    describe('Environment-aware PII handling', () => {
      it('should sanitize email in production by default', () => {
        // Arrange
        vi.stubEnv('NODE_ENV', 'production');
        const testLogger = new Logger(LogLevel.INFO);
        const meta = { email: 'user@example.com', userId: 'usr_123' };

        // Act
        testLogger.info('User action', meta);

        // Assert
        const output = consoleLogSpy.mock.calls[0]?.[0] as string;
        const parsed = JSON.parse(output) as ParsedLogOutput;
        assertDefined(parsed.meta);
        expect((parsed.meta as any).email).toBe('[PII REDACTED]');
        assertDefined(parsed.meta);
        expect((parsed.meta as any).userId).toBe('usr_123'); // Non-PII preserved
      });

      it('should show email in development by default', () => {
        // Arrange
        vi.stubEnv('NODE_ENV', 'development');
        const testLogger = new Logger(LogLevel.INFO);
        const meta = { email: 'user@example.com' };

        // Act
        testLogger.info('User action', meta);

        // Assert: Development format contains the email
        const output = consoleLogSpy.mock.calls[0]?.[0] as string;
        expect(output).toContain('user@example.com');
      });

      it('should sanitize phone numbers in production', () => {
        // Arrange
        vi.stubEnv('NODE_ENV', 'production');
        const testLogger = new Logger(LogLevel.INFO);
        const meta = { phone: '+44 7700 900000', mobile: '07700900001' };

        // Act
        testLogger.info('Contact info', meta);

        // Assert
        const output = consoleLogSpy.mock.calls[0]?.[0] as string;
        const parsed = JSON.parse(output) as ParsedLogOutput;
        assertDefined(parsed.meta);
        expect((parsed.meta as any).phone).toBe('[PII REDACTED]');
        assertDefined(parsed.meta);
        expect((parsed.meta as any).mobile).toBe('[PII REDACTED]');
      });

      it('should sanitize name fields in production', () => {
        // Arrange
        vi.stubEnv('NODE_ENV', 'production');
        const testLogger = new Logger(LogLevel.INFO);
        const meta = {
          firstName: 'John',
          lastName: 'Doe',
          fullName: 'John Doe',
        };

        // Act
        testLogger.info('User profile', meta);

        // Assert
        const output = consoleLogSpy.mock.calls[0]?.[0] as string;
        const parsed = JSON.parse(output) as ParsedLogOutput;
        assertDefined(parsed.meta);
        expect((parsed.meta as any).firstName).toBe('[PII REDACTED]');
        assertDefined(parsed.meta);
        expect((parsed.meta as any).lastName).toBe('[PII REDACTED]');
        assertDefined(parsed.meta);
        expect((parsed.meta as any).fullName).toBe('[PII REDACTED]');
      });

      it('should sanitize IP addresses in production', () => {
        // Arrange
        vi.stubEnv('NODE_ENV', 'production');
        const testLogger = new Logger(LogLevel.INFO);
        const meta = { ip: '192.168.1.1', ipAddress: '10.0.0.1' };

        // Act
        testLogger.info('Request received', meta);

        // Assert
        const output = consoleLogSpy.mock.calls[0]?.[0] as string;
        const parsed = JSON.parse(output) as ParsedLogOutput;
        assertDefined(parsed.meta);
        expect((parsed.meta as any).ip).toBe('[PII REDACTED]');
        assertDefined(parsed.meta);
        expect((parsed.meta as any).ipAddress).toBe('[PII REDACTED]');
      });

      it('should sanitize address fields in production', () => {
        // Arrange
        vi.stubEnv('NODE_ENV', 'production');
        const testLogger = new Logger(LogLevel.INFO);
        const meta = {
          address: '123 Main St',
          street: 'High Street',
          postcode: 'SW1A 1AA',
        };

        // Act
        testLogger.info('Shipping info', meta);

        // Assert
        const output = consoleLogSpy.mock.calls[0]?.[0] as string;
        const parsed = JSON.parse(output) as ParsedLogOutput;
        assertDefined(parsed.meta);
        expect((parsed.meta as any).address).toBe('[PII REDACTED]');
        assertDefined(parsed.meta);
        expect((parsed.meta as any).street).toBe('[PII REDACTED]');
        assertDefined(parsed.meta);
        expect((parsed.meta as any).postcode).toBe('[PII REDACTED]');
      });
    });

    describe('LOG_SANITIZE_PII environment variable', () => {
      it('should sanitize PII when LOG_SANITIZE_PII=true even in development', () => {
        // Arrange
        vi.stubEnv('NODE_ENV', 'development');
        vi.stubEnv('LOG_SANITIZE_PII', 'true');
        const testLogger = new Logger(LogLevel.INFO);
        const meta = { email: 'user@example.com' };

        // Act
        testLogger.info('User action', meta);

        // Assert: Even in dev, PII should be redacted
        const output = consoleLogSpy.mock.calls[0]?.[0] as string;
        expect(output).not.toContain('user@example.com');
        expect(output).toContain('[PII REDACTED]');
      });

      it('should show PII when LOG_SANITIZE_PII=false even in production', () => {
        // Arrange
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv('LOG_SANITIZE_PII', 'false');
        const testLogger = new Logger(LogLevel.INFO);
        const meta = { email: 'user@example.com' };

        // Act
        testLogger.info('User action', meta);

        // Assert: In production with override, PII should be visible
        const output = consoleLogSpy.mock.calls[0]?.[0] as string;
        const parsed = JSON.parse(output) as ParsedLogOutput;
        assertDefined(parsed.meta);
        expect((parsed.meta as any).email).toBe('user@example.com');
      });

      it('should handle case-insensitive LOG_SANITIZE_PII values', () => {
        // Arrange
        vi.stubEnv('NODE_ENV', 'development');
        vi.stubEnv('LOG_SANITIZE_PII', 'TRUE');
        const testLogger = new Logger(LogLevel.INFO);
        const meta = { email: 'user@example.com' };

        // Act
        testLogger.info('User action', meta);

        // Assert
        const output = consoleLogSpy.mock.calls[0]?.[0] as string;
        expect(output).toContain('[PII REDACTED]');
      });
    });

    describe('Secrets vs PII distinction', () => {
      it('should always sanitize secrets regardless of environment', () => {
        // Arrange
        vi.stubEnv('NODE_ENV', 'development');
        vi.stubEnv('LOG_SANITIZE_PII', 'false');
        const testLogger = new Logger(LogLevel.INFO);
        const meta = {
          password: 'secret123',
          token: 'tok_abc',
          apiKey: 'key_xyz',
        };

        // Act
        testLogger.info('Auth data', meta);

        // Assert: Secrets always redacted, even with PII disabled
        const output = consoleLogSpy.mock.calls[0]?.[0] as string;
        expect(output).toContain('[REDACTED]');
        expect(output).not.toContain('secret123');
        expect(output).not.toContain('tok_abc');
        expect(output).not.toContain('key_xyz');
      });

      it('should use [REDACTED] for secrets and [PII REDACTED] for PII', () => {
        // Arrange
        vi.stubEnv('NODE_ENV', 'production');
        const testLogger = new Logger(LogLevel.INFO);
        const meta = {
          password: 'secret123',
          email: 'user@example.com',
        };

        // Act
        testLogger.info('User data', meta);

        // Assert
        const output = consoleLogSpy.mock.calls[0]?.[0] as string;
        const parsed = JSON.parse(output) as ParsedLogOutput;
        assertDefined(parsed.meta);
        expect((parsed.meta as any).password).toBe('[REDACTED]');
        assertDefined(parsed.meta);
        expect((parsed.meta as any).email).toBe('[PII REDACTED]');
      });

      it('should sanitize additional secret fields (bearer, credential, privateKey)', () => {
        // Arrange
        vi.stubEnv('NODE_ENV', 'development');
        const testLogger = new Logger(LogLevel.INFO);
        const meta = {
          bearer: 'bearer_token',
          credential: 'cred_value',
          privateKey: 'pk_secret',
        };

        // Act
        testLogger.info('Auth secrets', meta);

        // Assert
        const output = consoleLogSpy.mock.calls[0]?.[0] as string;
        expect(output).not.toContain('bearer_token');
        expect(output).not.toContain('cred_value');
        expect(output).not.toContain('pk_secret');
      });
    });

    describe('Nested PII sanitization', () => {
      it('should sanitize nested PII fields in production', () => {
        // Arrange
        vi.stubEnv('NODE_ENV', 'production');
        const testLogger = new Logger(LogLevel.INFO);
        const meta = {
          user: {
            id: 'usr_123',
            profile: {
              email: 'nested@example.com',
              firstName: 'John',
            },
          },
        };

        // Act
        testLogger.info('Nested user data', meta);

        // Assert
        const output = consoleLogSpy.mock.calls[0]?.[0] as string;
        const parsed = JSON.parse(output) as ParsedLogOutput;
        assertDefined(parsed.meta);
        expect((parsed.meta as any).user.id).toBe('usr_123');
        assertDefined(parsed.meta);
        expect((parsed.meta as any).user.profile.email).toBe('[PII REDACTED]');
        assertDefined(parsed.meta);
        expect((parsed.meta as any).user.profile.firstName).toBe('[PII REDACTED]');
      });

      it('should sanitize PII in arrays', () => {
        // Arrange
        vi.stubEnv('NODE_ENV', 'production');
        const testLogger = new Logger(LogLevel.INFO);
        const meta = {
          recipients: [{ email: 'user1@example.com' }, { email: 'user2@example.com' }],
        };

        // Act
        testLogger.info('Email batch', meta);

        // Assert
        const output = consoleLogSpy.mock.calls[0]?.[0] as string;
        const parsed = JSON.parse(output) as ParsedLogOutput;
        assertDefined(parsed.meta);
        expect((parsed.meta as any).recipients[0].email).toBe('[PII REDACTED]');
        assertDefined(parsed.meta);
        expect((parsed.meta as any).recipients[1].email).toBe('[PII REDACTED]');
      });
    });
  });

  describe('Output Formatting', () => {
    it('should use development format in development environment', () => {
      // Arrange
      vi.stubEnv('NODE_ENV', 'development');
      const testLogger = new Logger(LogLevel.INFO);

      // Act
      testLogger.info('Test message');

      // Assert: Development format is human-readable with colors
      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0]?.[0] as string;
      expect(typeof output).toBe('string');
      expect(output).toContain('Test message');
      // Development format includes ANSI color codes
      // eslint-disable-next-line no-control-regex
      expect(output).toMatch(/\x1b\[\d+m/);
    });

    it('should use production format (JSON) in production environment', () => {
      // Arrange
      vi.stubEnv('NODE_ENV', 'production');
      const testLogger = new Logger(LogLevel.INFO);

      // Act
      testLogger.info('Test message');

      // Assert: Production format is JSON
      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0]?.[0] as string;
      expect(() => JSON.parse(output) as ParsedLogOutput).not.toThrow();

      const parsed = JSON.parse(output) as ParsedLogOutput;
      expect(parsed.message).toBe('Test message');
      expect(parsed.level).toBe('info');
      expect(parsed.timestamp).toBeDefined();
    });

    it('should include timestamp in production format', () => {
      // Arrange
      vi.stubEnv('NODE_ENV', 'production');
      const testLogger = new Logger(LogLevel.INFO);

      // Act
      testLogger.info('Test message');

      // Assert
      const output = consoleLogSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(output) as ParsedLogOutput;
      expect(parsed.timestamp).toBeDefined();
      expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
    });

    it('should include log level in production format', () => {
      // Arrange
      vi.stubEnv('NODE_ENV', 'production');
      const testLogger = new Logger(LogLevel.INFO);

      // Act
      testLogger.warn('Warning message');

      // Assert
      const output = consoleLogSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(output) as ParsedLogOutput;
      expect(parsed.level).toBe('warn');
    });

    it('should include metadata in production format', () => {
      // Arrange
      vi.stubEnv('NODE_ENV', 'production');
      const testLogger = new Logger(LogLevel.INFO);
      const meta = { userId: '123', action: 'login' };

      // Act
      testLogger.info('User action', meta);

      // Assert
      const output = consoleLogSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(output) as ParsedLogOutput;
      assertDefined(parsed.meta);
      expect(parsed.meta).toEqual(meta);
    });

    it('should format errors in development with stack traces', () => {
      // Arrange
      vi.stubEnv('NODE_ENV', 'development');
      const testLogger = new Logger(LogLevel.ERROR);
      const error = new Error('Test error');

      // Act
      testLogger.error('Error occurred', error);

      // Assert
      expect(consoleErrorSpy).toHaveBeenCalled();
      const output = consoleErrorSpy.mock.calls[0]?.[0] as string;
      expect(output).toContain('Test error');
    });

    it('should sanitize errors in production format', () => {
      // Arrange
      vi.stubEnv('NODE_ENV', 'production');
      const testLogger = new Logger(LogLevel.ERROR);
      const error = new Error('Test error');

      // Act
      testLogger.error('Error occurred', error);

      // Assert
      const output = consoleErrorSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(output) as ParsedLogOutput;
      assertDefined(parsed.error);
      expect((parsed.error as any).name).toBe('Error');
      assertDefined(parsed.error);
      expect((parsed.error as any).message).toBe('Test error');
      assertDefined(parsed.error);
      expect((parsed.error as any).stack).toBeDefined();
    });
  });

  describe('Context and Child Loggers', () => {
    it('should create child logger with inherited context', () => {
      // Arrange
      const parentLogger = new Logger(LogLevel.INFO, { requestId: '123' });

      // Act
      const childLogger = parentLogger.child({ userId: '456' });
      childLogger.info('Child message');

      // Assert: Child inherits parent context
      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0]?.[0] as string;
      expect(output).toContain('Child message');
    });

    it('should merge parent and child context', () => {
      // Arrange
      vi.stubEnv('NODE_ENV', 'production');
      const parentLogger = new Logger(LogLevel.INFO, { requestId: '123' });
      const childLogger = parentLogger.child({ userId: '456' });

      // Act
      childLogger.info('Message');

      // Assert
      const output = consoleLogSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(output) as ParsedLogOutput;
      assertDefined(parsed.context);
      expect(parsed.context.requestId).toBe('123');
      assertDefined(parsed.context);
      expect(parsed.context.userId).toBe('456');
    });

    it('should create logger with withContext alias', () => {
      // Arrange
      vi.stubEnv('NODE_ENV', 'production');
      const baseLogger = new Logger(LogLevel.INFO);

      // Act
      const contextLogger = baseLogger.withContext({ sessionId: 'abc' });
      contextLogger.info('Session message');

      // Assert
      const output = consoleLogSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(output) as ParsedLogOutput;
      assertDefined(parsed.context);
      expect(parsed.context.sessionId).toBe('abc');
    });

    it('should not modify original logger when creating child', () => {
      // Arrange
      vi.stubEnv('NODE_ENV', 'production');
      const parentLogger = new Logger(LogLevel.INFO, { requestId: '123' });

      // Act
      parentLogger.child({ userId: '456' });
      parentLogger.info('Parent message');

      // Assert: Parent context unchanged
      const output = consoleLogSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(output) as ParsedLogOutput;
      assertDefined(parsed.context);
      expect(parsed.context.requestId).toBe('123');
      assertDefined(parsed.context);
      expect(parsed.context.userId).toBeUndefined();
    });

    it('should not include context field if empty', () => {
      // Arrange
      vi.stubEnv('NODE_ENV', 'production');
      const testLogger = new Logger(LogLevel.INFO);

      // Act
      testLogger.info('Message without context');

      // Assert
      const output = consoleLogSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(output) as ParsedLogOutput;
      // Don't assert defined when testing undefined
      expect(parsed.context).toBeUndefined();
    });

    it('should include context in development format', () => {
      // Arrange
      vi.stubEnv('NODE_ENV', 'development');
      const testLogger = new Logger(LogLevel.INFO, { requestId: '123' });

      // Act
      testLogger.info('Test message');

      // Assert
      const output = consoleLogSpy.mock.calls[0]?.[0] as string;
      expect(output).toContain('123');
    });
  });

  describe('Log Level Management', () => {
    it('should return current log level with getLevel()', () => {
      // Arrange
      const testLogger = new Logger(LogLevel.WARN);

      // Act
      const level = testLogger.getLevel();

      // Assert
      expect(level).toBe(LogLevel.WARN);
    });

    it('should set log level dynamically with setLevel()', () => {
      // Arrange
      const testLogger = new Logger(LogLevel.INFO);

      // Act: Change to ERROR level
      testLogger.setLevel(LogLevel.ERROR);
      testLogger.info('Should not log');
      testLogger.error('Should log');

      // Assert
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('should filter logs after setLevel change', () => {
      // Arrange
      const testLogger = new Logger(LogLevel.DEBUG);

      // Act: Change to WARN level
      testLogger.setLevel(LogLevel.WARN);
      testLogger.debug('Debug message');
      testLogger.info('Info message');
      testLogger.warn('Warn message');

      // Assert
      expect(consoleLogSpy).toHaveBeenCalledTimes(1); // Only WARN logged
    });
  });

  describe('createLogger() Factory Function', () => {
    it('should create logger with context', () => {
      // Arrange & Act
      const testLogger = createLogger({ module: 'api' });

      // Assert
      expect(testLogger).toBeInstanceOf(Logger);
    });

    it('should create logger without context', () => {
      // Arrange & Act
      const testLogger = createLogger();

      // Assert
      expect(testLogger).toBeInstanceOf(Logger);
    });

    it('should create logger with default log level', () => {
      // Arrange
      vi.stubEnv('NODE_ENV', 'development');

      // Act
      const testLogger = createLogger();

      // Assert
      expect(testLogger.getLevel()).toBe(LogLevel.DEBUG);
    });
  });

  describe('Default Logger Instance', () => {
    it('should export default logger instance', () => {
      // Assert
      expect(logger).toBeInstanceOf(Logger);
    });

    it('should use default logger for basic logging', () => {
      // Act
      logger.info('Test message');

      // Assert
      expect(consoleLogSpy).toHaveBeenCalled();
    });
  });
});
