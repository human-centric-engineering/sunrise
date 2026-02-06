# Structured Logging Overview

**Related**: [Request Context](./request-context.md) | [Best Practices](./best-practices.md) | [Error Handling](../errors/overview.md)

Sunrise uses structured logging via `@/lib/logging` for all production code. Never use `console.log` directly.

## Quick Reference

| Need              | Use                                                |
| ----------------- | -------------------------------------------------- |
| Basic logging     | `logger.info('message', { metadata })`             |
| Error logging     | `logger.error('message', error, { metadata })`     |
| API route logging | `getRouteLogger(request)` from `@/lib/api/context` |
| Add context       | `logger.withContext({ key: value })`               |
| Debug only        | `logger.debug('message')` (disabled in production) |

## When to Log

### Always Log

**Errors and Exceptions**:

```typescript
try {
  await database.query();
} catch (error) {
  logger.error('Database query failed', error, {
    query: 'SELECT * FROM users',
    table: 'users',
  });
  throw error;
}
```

**Authentication Events**:

```typescript
// Successful login
logger.info('User logged in', { userId: user.id, method: 'email' });

// Failed login
logger.warn('Login failed', { email, reason: 'invalid_password' });

// Logout
logger.info('User logged out', { userId: user.id });
```

**Security Events**:

```typescript
// Suspicious activity
logger.warn('Multiple failed login attempts', {
  email,
  attempts: 5,
  ip: clientIp,
  timeWindow: '5 minutes',
});

// Permission denied
logger.warn('Unauthorized access attempt', {
  userId: user.id,
  resource: 'admin_panel',
  action: 'access',
});
```

**Important State Changes**:

```typescript
// Resource creation
logger.info('User created', {
  userId: newUser.id,
  email: newUser.email,
  role: newUser.role,
});

// Resource deletion
logger.info('User deleted', {
  userId: deletedUser.id,
  deletedBy: currentUser.id,
});

// Status changes
logger.info('Order status changed', {
  orderId: order.id,
  oldStatus: 'pending',
  newStatus: 'completed',
});
```

**External API Calls**:

```typescript
// Before call
logger.info('Calling payment API', {
  provider: 'stripe',
  amount: 99.99,
  currency: 'USD',
});

// After call (success)
logger.info('Payment API succeeded', {
  provider: 'stripe',
  chargeId: 'ch_123',
  duration_ms: 234,
});

// After call (failure)
logger.error('Payment API failed', error, {
  provider: 'stripe',
  duration_ms: 234,
  statusCode: 500,
});
```

**Performance Issues**:

```typescript
const start = Date.now();
await slowOperation();
const duration = Date.now() - start;

if (duration > 1000) {
  logger.warn('Slow operation detected', {
    operation: 'database_query',
    duration_ms: duration,
    threshold_ms: 1000,
  });
}
```

### Consider Logging

**User Actions** (in moderation):

```typescript
// High-value actions
logger.info('User purchased subscription', {
  userId: user.id,
  plan: 'premium',
  amount: 29.99,
});

// Don't log every click
// logger.info('User clicked button', { button: 'next' });
```

**Configuration Changes**:

```typescript
logger.info('Settings updated', {
  userId: user.id,
  changed: ['theme', 'notifications'],
  oldTheme: 'light',
  newTheme: 'dark',
});
```

**Rate Limiting**:

```typescript
logger.warn('Rate limit approached', {
  userId: user.id,
  endpoint: '/api/v1/users',
  requests: 95,
  limit: 100,
  windowSeconds: 60,
});
```

## What NOT to Log

### Never Log (PII and Secrets)

**Passwords** (even hashed):

```typescript
// BAD
logger.info('User created', {
  email: user.email,
  password: hashedPassword, // Never!
});

// GOOD
logger.info('User created', {
  email: user.email,
});
```

**Authentication Tokens**:

```typescript
// BAD
logger.info('Request received', {
  token: request.headers.get('authorization'), // Never!
});

// GOOD
logger.info('Request received', {
  authenticated: !!request.headers.get('authorization'),
});
```

**API Keys and Secrets**:

```typescript
// BAD
logger.info('Calling external API', {
  apiKey: process.env.STRIPE_SECRET_KEY, // Never!
});

// GOOD
logger.info('Calling external API', {
  provider: 'stripe',
  keyPresent: !!process.env.STRIPE_SECRET_KEY,
});
```

**Credit Card Numbers**:

```typescript
// BAD
logger.info('Payment processed', {
  cardNumber: '4111111111111111', // Never!
});

// GOOD
logger.info('Payment processed', {
  cardLast4: '1111',
  cardBrand: 'visa',
});
```

**Full Request/Response Bodies** (may contain secrets):

```typescript
// BAD
logger.info('API request', {
  body: JSON.stringify(request.body), // May contain secrets!
});

// GOOD
logger.info('API request', {
  bodyFields: Object.keys(request.body),
  bodySize: JSON.stringify(request.body).length,
});
```

## Automatic Sanitization

The logger has two-tier sanitization for security and privacy compliance.

### Tier 1: Secrets (ALWAYS Redacted)

Security-critical data that should never appear in logs:

```typescript
logger.info('Auth attempt', {
  password: 'secret123', // Always '[REDACTED]'
  token: 'abc123', // Always '[REDACTED]'
  apiKey: 'key_xyz', // Always '[REDACTED]'
});
```

**Secret fields** (always redacted in all environments):

- `password`, `token`, `apikey`, `api_key`, `secret`
- `creditcard`, `credit_card`, `ssn`, `authorization`
- `bearer`, `credential`, `privatekey`, `private_key`

**Note:** Field matching is case-insensitive, so `apiKey`, `APIKEY`, and `apikey` all match.

### Tier 2: PII (Environment-Aware)

Personally Identifiable Information for GDPR/CCPA compliance:

```typescript
logger.info('User created', {
  email: 'user@example.com',  // '[PII REDACTED]' in production
  fullName: 'John Doe',       // '[PII REDACTED]' in production
  ipAddress: '192.168.1.1',   // '[PII REDACTED]' in production
});

// Development output:
{ "email": "user@example.com", "fullName": "John Doe", "ipAddress": "192.168.1.1" }

// Production output:
{ "email": "[PII REDACTED]", "fullName": "[PII REDACTED]", "ipAddress": "[PII REDACTED]" }
```

**PII fields** (redacted in production by default):

- `email`, `phone`, `mobile`
- `firstname`, `first_name`, `lastname`, `last_name`, `fullname`, `full_name`
- `address`, `street`, `postcode`, `zipcode`, `zip_code`
- `ip`, `ipaddress`, `ip_address`, `useragent`, `user_agent`

### LOG_SANITIZE_PII Configuration

| Value   | Behavior                                          |
| ------- | ------------------------------------------------- |
| Not set | Auto: sanitize in production, show in development |
| `true`  | Always sanitize PII (strictest GDPR compliance)   |
| `false` | Never sanitize PII (use with caution)             |

```bash
# .env.local
LOG_SANITIZE_PII=true  # Recommended for GDPR/CCPA compliance
```

**Best Practice for Traceability:**

Use `userId` instead of `email` for log correlation:

```typescript
// GOOD - Uses userId for tracing
logger.info('User action', { userId: user.id, action: 'purchase' });

// OK - Email included for context (will be redacted in production)
logger.info('User created', { userId: user.id, email: user.email });
```

## Log Levels

### DEBUG - Verbose Debugging Info

**When**: Development only, detailed execution flow
**Default**: Enabled in development, disabled in production

```typescript
logger.debug('Processing user input', {
  input: formData,
  validationRules: rules,
  step: 'validation',
});

logger.debug('Cache hit', {
  key: cacheKey,
  ttl: 3600,
  size: cachedData.length,
});
```

### INFO - General Application Flow

**When**: Important events, normal operations
**Default**: Always enabled

```typescript
logger.info('User logged in', { userId: user.id });
logger.info('Order created', { orderId: order.id, total: 99.99 });
logger.info('Email sent', { recipient: user.email, template: 'welcome' });
```

### WARN - Degraded States

**When**: Something unexpected but non-breaking
**Default**: Always enabled

```typescript
logger.warn('Database slow query', {
  query: 'SELECT * FROM users',
  duration_ms: 2500,
  threshold_ms: 1000,
});

logger.warn('External API timeout', {
  provider: 'stripe',
  timeout_ms: 5000,
  fallback: 'cache',
});

logger.warn('Deprecated API used', {
  endpoint: '/api/v1/users',
  userId: user.id,
  migrate_to: '/api/v2/users',
});
```

### ERROR - Breaking Errors

**When**: Feature broken, needs immediate attention
**Default**: Always enabled

```typescript
logger.error('Payment failed', error, {
  orderId: order.id,
  provider: 'stripe',
  errorCode: error.code,
});

logger.error('Database connection lost', error, {
  host: dbHost,
  retryAttempt: 3,
});
```

### Choosing the Right Level

```
DEBUG -> Can I ignore this in production?
  YES -> Use DEBUG
  NO  |
      v
INFO -> Is this an error or warning?
  NO  -> Use INFO
  YES |
      v
WARN -> Does this break functionality?
  NO  -> Use WARN
  YES |
      v
ERROR -> Use ERROR
```

## Logger Methods

### Creating Child Loggers

The logger supports creating child loggers with inherited context. Both `.child()` and `.withContext()` methods are available:

```typescript
// These are equivalent - withContext() is an alias for child()
const requestLogger = logger.child({ requestId: '123' });
const requestLogger = logger.withContext({ requestId: '123' });
```

**Documentation preference**: Use `.withContext()` for readability as it clearly conveys intent.

```typescript
// Preferred style
const log = logger.withContext({
  requestId,
  userId: user.id,
});

log.info('Processing request'); // Includes requestId and userId
log.error('Request failed', error); // Same context attached
```

Child loggers can be nested:

```typescript
const jobLogger = logger.withContext({ jobId: 'batch_123' });

for (const item of items) {
  const itemLogger = jobLogger.withContext({ itemId: item.id });
  itemLogger.info('Processing item'); // Has both jobId and itemId
}
```

## Related Documentation

- [Request Context](./request-context.md) - Request ID propagation and user context
- [Best Practices](./best-practices.md) - Patterns and performance
- [Error Handling Overview](../errors/overview.md) - Complete error handling architecture

## See Also

- `lib/logging/index.ts` - Logger implementation
- `lib/logging/context.ts` - Context utilities
- `.env.example` - LOG_LEVEL configuration
