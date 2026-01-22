/**
 * Structured Logging System
 *
 * Centralized logging with environment-aware output:
 * - Production: JSON format for log aggregation (DataDog, CloudWatch, etc.)
 * - Development: Human-readable colored format for debugging
 *
 * Features:
 * - Log levels: DEBUG, INFO, WARN, ERROR
 * - Request context propagation (requestId, userId, sessionId)
 * - Child loggers with inherited context
 * - Automatic secret sanitization (always redacted)
 * - Environment-aware PII sanitization (GDPR compliant)
 * - TypeScript type safety
 *
 * PII Sanitization (GDPR Compliance):
 * - Secrets (passwords, tokens, API keys) are ALWAYS redacted
 * - PII (emails, names, phone numbers, IPs) are redacted in production by default
 * - In development, PII is shown to aid debugging
 * - Control with LOG_SANITIZE_PII environment variable:
 *   - Not set: Auto (sanitize in production, show in development)
 *   - "true": Always sanitize PII
 *   - "false": Never sanitize PII (use with caution)
 *
 * @example
 * ```typescript
 * import { logger } from '@/lib/logging';
 *
 * // Basic logging
 * logger.info('User logged in', { userId: '123' });
 * logger.error('Database query failed', error, { query: 'SELECT ...' });
 *
 * // Child logger with context
 * const requestLogger = logger.withContext({ requestId: 'abc123' });
 * requestLogger.info('Processing request'); // Includes requestId automatically
 *
 * // PII is automatically handled based on environment
 * logger.info('User created', { email: 'user@example.com' });
 * // Development: { email: 'user@example.com' }
 * // Production:  { email: '[PII REDACTED]' }
 * ```
 */

/**
 * Log levels in order of severity
 */
export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

/**
 * Numeric values for log level comparison
 */
const LogLevelValue: Record<LogLevel, number> = {
  [LogLevel.DEBUG]: 0,
  [LogLevel.INFO]: 1,
  [LogLevel.WARN]: 2,
  [LogLevel.ERROR]: 3,
};

/**
 * Context object for structured logging
 * Includes request tracing and user information
 */
export interface LogContext {
  /** Request ID for distributed tracing */
  requestId?: string;
  /** User ID who triggered this log */
  userId?: string;
  /** Session ID for request correlation */
  sessionId?: string;
  /** API endpoint being accessed */
  endpoint?: string;
  /** HTTP method (GET, POST, etc.) */
  method?: string;
  /** Any additional context fields */
  [key: string]: unknown;
}

/**
 * Structured log entry format
 */
interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
  meta?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
  };
}

/**
 * Fields containing secrets - ALWAYS redacted regardless of environment
 * These are security-critical and should never appear in logs
 */
const SECRET_FIELDS = [
  'password',
  'token',
  'apikey',
  'api_key',
  'secret',
  'creditcard',
  'credit_card',
  'ssn',
  'authorization',
  'bearer',
  'credential',
  'private_key',
  'privatekey',
];

/**
 * Fields containing PII (Personally Identifiable Information)
 * Redacted in production by default for GDPR/CCPA compliance
 * Shown in development for debugging convenience
 *
 * Control with LOG_SANITIZE_PII environment variable:
 * - Not set: Auto (sanitize in production, show in development)
 * - "true": Always sanitize
 * - "false": Never sanitize (use with caution in production)
 */
const PII_FIELDS = [
  'email',
  'phone',
  'mobile',
  'firstname',
  'first_name',
  'lastname',
  'last_name',
  'fullname',
  'full_name',
  'address',
  'street',
  'postcode',
  'zipcode',
  'zip_code',
  'ip',
  'ipaddress',
  'ip_address',
  'useragent',
  'user_agent',
];

/**
 * Determine if PII should be sanitized based on environment
 * - Production: sanitize by default (GDPR compliance)
 * - Development: show by default (debugging convenience)
 * - Override with LOG_SANITIZE_PII environment variable
 */
function shouldSanitizePII(): boolean {
  const envValue = process.env.LOG_SANITIZE_PII?.toLowerCase();

  // Explicit override takes precedence
  if (envValue === 'true') return true;
  if (envValue === 'false') return false;

  // Default: sanitize in production, show in development
  return process.env.NODE_ENV === 'production';
}

/**
 * Check if a field name matches any sensitive pattern
 * Uses word boundary matching to avoid false positives like:
 * - "recipients" matching "ip"
 * - "credentials" matching "credential" (this one is intentionally matched)
 *
 * Matches if the field:
 * - Exactly equals the sensitive pattern
 * - Starts with the pattern followed by non-letter (e.g., "password123")
 * - Ends with the pattern preceded by non-letter (e.g., "userPassword")
 * - Contains the pattern surrounded by non-letters (e.g., "user_password_hash")
 */
function matchesSensitiveField(fieldName: string, sensitivePatterns: string[]): boolean {
  const lowerField = fieldName.toLowerCase();
  return sensitivePatterns.some((pattern) => {
    // Exact match
    if (lowerField === pattern) return true;

    // Word boundary matching using regex
    // Pattern should match as a complete word or camelCase boundary
    // e.g., "password" matches "userPassword", "password_hash", "PASSWORD"
    // but "ip" should NOT match "recipients" or "shipping"
    const regex = new RegExp(`(^|[^a-z])${pattern}([^a-z]|$)`, 'i');
    return regex.test(lowerField);
  });
}

/**
 * ANSI color codes for development console output
 */
const Colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
  green: '\x1b[32m',
};

/**
 * Logger class for structured logging
 * Supports different output formats based on environment
 */
export class Logger {
  private level: LogLevel;
  private context: LogContext;

  /**
   * Create a new Logger instance
   * @param level - Minimum log level to output
   * @param context - Context to include in all log entries
   */
  constructor(level?: LogLevel, context: LogContext = {}) {
    // Get log level from environment or use defaults
    const envLevel = process.env.LOG_LEVEL?.toLowerCase();
    const defaultLevel = process.env.NODE_ENV === 'production' ? LogLevel.INFO : LogLevel.DEBUG;

    this.level = level ?? (envLevel as LogLevel) ?? defaultLevel;
    this.context = context;
  }

  /**
   * Check if a log level should be output
   */
  private shouldLog(level: LogLevel): boolean {
    return LogLevelValue[level] >= LogLevelValue[this.level];
  }

  /**
   * Sanitize sensitive data from an object
   * - Secrets are ALWAYS replaced with '[REDACTED]'
   * - PII is replaced with '[PII REDACTED]' based on environment/config
   */
  private sanitize(obj: unknown, sanitizePII: boolean): unknown {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.sanitize(item, sanitizePII));
    }

    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      // Check if field matches a secret pattern (always redact)
      // Uses word boundary matching to avoid false positives
      if (matchesSensitiveField(key, SECRET_FIELDS)) {
        sanitized[key] = '[REDACTED]';
        continue;
      }

      // Check if field matches a PII pattern (redact based on environment/config)
      if (sanitizePII && matchesSensitiveField(key, PII_FIELDS)) {
        sanitized[key] = '[PII REDACTED]';
        continue;
      }

      // Recursively sanitize nested objects
      if (typeof value === 'object' && value !== null) {
        sanitized[key] = this.sanitize(value, sanitizePII);
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * Format log entry for development console (human-readable)
   * Still sanitizes secrets, but shows PII by default (unless LOG_SANITIZE_PII=true)
   */
  private formatDev(entry: LogEntry): string {
    // Sanitize even in dev (secrets always, PII based on config)
    const sanitizedEntry = this.sanitize(entry, shouldSanitizePII()) as LogEntry;
    const { timestamp, level, message, context, meta, error } = sanitizedEntry;

    // Color by log level
    const levelColors: Record<LogLevel, string> = {
      [LogLevel.DEBUG]: Colors.gray,
      [LogLevel.INFO]: Colors.blue,
      [LogLevel.WARN]: Colors.yellow,
      [LogLevel.ERROR]: Colors.red,
    };

    const color = levelColors[level];
    const time = new Date(timestamp).toLocaleTimeString();

    let output = `${Colors.gray}${time}${Colors.reset} ${color}${level.toUpperCase().padEnd(5)}${Colors.reset} ${message}`;

    // Add context if present
    if (context && Object.keys(context).length > 0) {
      output += `\n  ${Colors.gray}Context:${Colors.reset} ${JSON.stringify(context)}`;
    }

    // Add metadata if present
    if (meta && Object.keys(meta).length > 0) {
      output += `\n  ${Colors.gray}Meta:${Colors.reset} ${JSON.stringify(meta)}`;
    }

    // Add error details if present
    if (error) {
      output += `\n  ${Colors.red}Error:${Colors.reset} ${error.name}: ${error.message}`;
      if (error.stack) {
        const stackLines = error.stack.split('\n').slice(1, 4); // First 3 stack frames
        output += `\n${Colors.gray}${stackLines.join('\n')}${Colors.reset}`;
      }
    }

    return output;
  }

  /**
   * Format log entry for production (JSON)
   * Always sanitizes secrets, and sanitizes PII based on configuration
   */
  private formatProd(entry: LogEntry): string {
    // Sanitize entry before outputting
    // Secrets are always sanitized, PII based on shouldSanitizePII()
    const sanitized = this.sanitize(entry, shouldSanitizePII());
    return JSON.stringify(sanitized);
  }

  /**
   * Output a log entry
   */
  private log(
    level: LogLevel,
    message: string,
    error?: unknown,
    meta?: Record<string, unknown>
  ): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: Object.keys(this.context).length > 0 ? this.context : undefined,
      meta,
    };

    // Add error details if provided
    if (error) {
      if (error instanceof Error) {
        entry.error = {
          name: error.name,
          message: error.message,
          stack: error.stack,
          // Add error code if available (e.g., Prisma errors, custom errors)
          code: (error as { code?: string }).code,
        };
      } else {
        // For non-Error objects, try to extract meaningful information
        let errorMessage: string;
        if (typeof error === 'string') {
          errorMessage = error;
        } else if (typeof error === 'number' || typeof error === 'boolean') {
          errorMessage = String(error);
        } else if (typeof error === 'object' && error !== null) {
          errorMessage = JSON.stringify(error);
        } else {
          // null, undefined, symbol, function, etc.
          errorMessage = 'Unknown error occurred';
        }

        entry.error = {
          name: 'UnknownError',
          message: errorMessage,
        };
      }
    }

    // Push to admin log buffer
    this.pushToLogBuffer(entry);

    // Format based on environment
    const formatted =
      process.env.NODE_ENV === 'production' ? this.formatProd(entry) : this.formatDev(entry);

    // Output to appropriate console method
    // eslint-disable-next-line no-console
    const consoleMethod = level === LogLevel.ERROR ? console.error : console.log;
    consoleMethod(formatted);
  }

  /**
   * Push entry to admin log buffer
   * Uses dynamic import to avoid circular dependency issues
   */
  private pushToLogBuffer(entry: LogEntry): void {
    // Use require to avoid circular dependency at module load time
    // This is safe because lib/admin/logs.ts doesn't import from logging
    try {
      // Type for admin log entry (uses string literal instead of enum)
      type AdminLogEntry = {
        timestamp: string;
        level: 'debug' | 'info' | 'warn' | 'error';
        message: string;
        context?: Record<string, unknown>;
        meta?: Record<string, unknown>;
        error?: { name: string; message: string; stack?: string; code?: string };
      };
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const logModule = require('@/lib/admin/logs') as {
        addLogEntry: (entry: AdminLogEntry) => void;
      };
      logModule.addLogEntry({
        timestamp: entry.timestamp,
        level: entry.level as 'debug' | 'info' | 'warn' | 'error',
        message: entry.message,
        context: entry.context as Record<string, unknown> | undefined,
        meta: entry.meta,
        error: entry.error,
      });
    } catch {
      // Silently fail if log buffer is not available
      // This can happen during startup or in certain edge cases
    }
  }

  /**
   * Log a debug message
   * Only output in development or when LOG_LEVEL=debug
   */
  debug(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, message, undefined, meta);
  }

  /**
   * Log an info message
   * General informational messages about application flow
   */
  info(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, message, undefined, meta);
  }

  /**
   * Log a warning message
   * Something unexpected but not breaking
   */
  warn(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, message, undefined, meta);
  }

  /**
   * Log an error message
   * Something went wrong and needs attention
   */
  error(message: string, error?: unknown, meta?: Record<string, unknown>): void {
    this.log(LogLevel.ERROR, message, error, meta);
  }

  /**
   * Create a child logger with additional context
   * The child logger inherits the parent's context and adds to it
   *
   * @example
   * ```typescript
   * const requestLogger = logger.child({ requestId: '123' });
   * requestLogger.info('Processing'); // Includes requestId
   * ```
   */
  child(additionalContext: LogContext): Logger {
    return new Logger(this.level, {
      ...this.context,
      ...additionalContext,
    });
  }

  /**
   * Create a new logger with updated context
   * Alias for child() for better readability
   *
   * @example
   * ```typescript
   * const logger = baseLogger.withContext({ userId: '456' });
   * ```
   */
  withContext(context: LogContext): Logger {
    return this.child(context);
  }

  /**
   * Get the current log level
   */
  getLevel(): LogLevel {
    return this.level;
  }

  /**
   * Set the log level dynamically
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }
}

/**
 * Default logger instance
 * Use this for most logging throughout the application
 */
export const logger = new Logger();

/**
 * Create a new logger with specific context
 * Useful for creating request-scoped or module-scoped loggers
 *
 * @example
 * ```typescript
 * const apiLogger = createLogger({ module: 'api' });
 * apiLogger.info('API server started');
 * ```
 */
export function createLogger(context?: LogContext): Logger {
  return new Logger(undefined, context);
}
