# Mocking Structured Logger

**When to use**: Unit tests that use the structured logger

**What to mock**: `logger.info()`, `logger.error()`, `logger.debug()`, `logger.warn()`

## Basic Logger Mocking

```typescript
import { vi } from 'vitest';

// Mock the logger module
vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    withContext: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));
```

## Verification Patterns

### Verify Logger Was Called

```typescript
import { logger } from '@/lib/logging';

it('should log info message', () => {
  functionUnderTest();

  expect(logger.info).toHaveBeenCalledWith('Operation completed', {
    userId: 'user-123',
    duration: 150,
  });
});
```

### Verify Error Logging

```typescript
it('should log error with context', async () => {
  const error = new Error('Test error');

  try {
    await functionThatThrows();
  } catch (e) {
    // Function should log error
  }

  expect(logger.error).toHaveBeenCalledWith(
    'Operation failed',
    error,
    expect.objectContaining({
      userId: 'user-123',
    })
  );
});
```

### Verify Log Count

```typescript
it('should log debug messages in development', () => {
  process.env.NODE_ENV = 'development';

  functionUnderTest();

  expect(logger.debug).toHaveBeenCalledTimes(3);
});
```

## Context Logger Mocking

```typescript
it('should use context logger with request ID', () => {
  const mockContextLogger = {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  };

  vi.mocked(logger.withContext).mockReturnValue(mockContextLogger);

  // Function creates context logger
  const requestId = 'req-123';
  functionWithContext(requestId);

  expect(logger.withContext).toHaveBeenCalledWith({ requestId: 'req-123' });
  expect(mockContextLogger.info).toHaveBeenCalledWith('Request processed');
});
```

## Testing Log Levels

```typescript
describe('Logger levels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should log at info level', () => {
    performOperation();

    expect(logger.info).toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('should log at error level for failures', async () => {
    await performFailingOperation();

    expect(logger.error).toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('should log warnings for deprecated features', () => {
    useDeprecatedFeature();

    expect(logger.warn).toHaveBeenCalledWith(
      'Using deprecated feature',
      expect.objectContaining({ feature: 'oldAPI' })
    );
  });
});
```

## Test Example: API Error Handler

```typescript
import { vi, describe, it, expect } from 'vitest';
import { handleAPIError } from '@/lib/api/errors';
import { logger } from '@/lib/logging';

vi.mock('@/lib/logging');

describe('handleAPIError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should log API errors with structured data', () => {
    const error = new Error('Database connection failed');

    handleAPIError(error);

    expect(logger.error).toHaveBeenCalledWith(
      'API error occurred',
      error,
      expect.objectContaining({
        errorType: 'Error',
        errorMessage: 'Database connection failed',
      })
    );
  });

  it('should include request context in logs', () => {
    const error = new Error('Validation failed');
    const context = {
      requestId: 'req-123',
      endpoint: '/api/v1/users',
      method: 'POST',
    };

    handleAPIError(error, context);

    expect(logger.error).toHaveBeenCalledWith(
      'API error occurred',
      error,
      expect.objectContaining({
        requestId: 'req-123',
        endpoint: '/api/v1/users',
        method: 'POST',
      })
    );
  });

  it('should not log sensitive data', () => {
    const error = new Error('Authentication failed');
    const context = {
      password: 'secret123', // Should be scrubbed
      userId: 'user-123',
    };

    handleAPIError(error, context);

    const logCall = vi.mocked(logger.error).mock.calls[0];
    const loggedContext = logCall[2];

    expect(loggedContext).not.toHaveProperty('password');
    expect(loggedContext).toHaveProperty('userId');
  });
});
```

## When NOT to Mock Logger

**Consider NOT mocking** when:

- Testing the logger itself
- Testing PII scrubbing logic
- Testing log formatting
- Verifying log output in integration tests

**Always mock** when:

- Unit testing business logic
- Testing error handling
- Verifying correct log calls
- Keeping tests fast

## Spy vs Mock

### Using Spy (allows real logging)

```typescript
import { logger } from '@/lib/logging';

it('should log and continue', () => {
  const infoSpy = vi.spyOn(logger, 'info');

  functionUnderTest();

  expect(infoSpy).toHaveBeenCalledWith('Operation completed');

  // Real logger also executed (logs appear in console)
});
```

### Using Mock (no real logging)

```typescript
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn() },
}));

it('should log without output', () => {
  functionUnderTest();

  // Logs don't appear in console
  expect(logger.info).toHaveBeenCalled();
});
```

## Tips

1. **Mock at module level**: Use `vi.mock('@/lib/logging')` at top
2. **Clear between tests**: Use `beforeEach(() => vi.clearAllMocks())`
3. **Verify structured data**: Use `expect.objectContaining({})`
4. **Check log levels**: Ensure correct level used (info vs error vs debug)
5. **Test context propagation**: Verify `withContext()` called correctly
6. **Don't over-verify**: Focus on important logs, not every debug call

## Related Files

- **Source**: `lib/logging/index.ts`
- **Usage**: Throughout codebase (API routes, error handlers, utilities)
- **Templates**: See `../templates/medium.md` for error handler tests
