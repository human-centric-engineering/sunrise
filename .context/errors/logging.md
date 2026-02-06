# Structured Logging - Best Practices

**Last Updated**: 2026-02-06
**Related**: [Error Handling Overview](./overview.md)

This document provides guidelines for effective structured logging in Sunrise.

## Table of Contents

- [When to Log](#when-to-log)
- [What NOT to Log](#what-not-to-log)
- [Log Levels](#log-levels)
- [Request Context](#request-context)
- [Structured Metadata](#structured-metadata)
- [Performance Considerations](#performance-considerations)
- [Log Aggregation](#log-aggregation)
- [Admin Log Buffer](#admin-log-buffer)
- [Logger Methods](#logger-methods)
- [Common Patterns](#common-patterns)

## When to Log

### ✅ Always Log

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
  // Slower than 1 second
  logger.warn('Slow operation detected', {
    operation: 'database_query',
    duration_ms: duration,
    threshold_ms: 1000,
  });
}
```

### ⚠️ Consider Logging

**User Actions** (in moderation):

```typescript
// High-value actions
logger.info('User purchased subscription', {
  userId: user.id,
  plan: 'premium',
  amount: 29.99,
});

// Don't log every click
// ❌ logger.info('User clicked button', { button: 'next' });
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

### ❌ Never Log (PII and Secrets)

**Passwords** (even hashed):

```typescript
// ❌ BAD
logger.info('User created', {
  email: user.email,
  password: hashedPassword, // Never!
});

// ✅ GOOD
logger.info('User created', {
  email: user.email,
});
```

**Authentication Tokens**:

```typescript
// ❌ BAD
logger.info('Request received', {
  token: request.headers.get('authorization'), // Never!
});

// ✅ GOOD
logger.info('Request received', {
  authenticated: !!request.headers.get('authorization'),
});
```

**API Keys and Secrets**:

```typescript
// ❌ BAD
logger.info('Calling external API', {
  apiKey: process.env.STRIPE_SECRET_KEY, // Never!
});

// ✅ GOOD
logger.info('Calling external API', {
  provider: 'stripe',
  keyPresent: !!process.env.STRIPE_SECRET_KEY,
});
```

**Credit Card Numbers**:

```typescript
// ❌ BAD
logger.info('Payment processed', {
  cardNumber: '4111111111111111', // Never!
});

// ✅ GOOD
logger.info('Payment processed', {
  cardLast4: '1111',
  cardBrand: 'visa',
});
```

**Social Security Numbers**:

```typescript
// ❌ BAD
logger.info('User profile updated', {
  ssn: '123-45-6789', // Never!
});

// ✅ GOOD
logger.info('User profile updated', {
  fields: ['name', 'address'], // Don't include SSN field
});
```

**Full Request/Response Bodies** (may contain secrets):

```typescript
// ❌ BAD
logger.info('API request', {
  body: JSON.stringify(request.body), // May contain secrets!
});

// ✅ GOOD
logger.info('API request', {
  bodyFields: Object.keys(request.body),
  bodySize: JSON.stringify(request.body).length,
});
```

### 🔒 Automatic Sanitization (GDPR Compliant)

The logger has two-tier sanitization for security and privacy compliance:

**Tier 1: Secrets (ALWAYS redacted)**
Security-critical data that should never appear in logs:

```typescript
logger.info('Auth attempt', {
  password: 'secret123', // ← Always '[REDACTED]'
  token: 'abc123', // ← Always '[REDACTED]'
  apiKey: 'key_xyz', // ← Always '[REDACTED]'
});
```

**Secret fields** (always redacted in all environments):

- `password`, `token`, `apiKey`, `api_key`, `secret`
- `creditCard`, `credit_card`, `ssn`, `authorization`
- `bearer`, `credential`, `privateKey`, `private_key`

**Tier 2: PII (environment-aware)**
Personally Identifiable Information for GDPR/CCPA compliance:

```typescript
logger.info('User created', {
  email: 'user@example.com',  // ← '[PII REDACTED]' in production
  fullName: 'John Doe',       // ← '[PII REDACTED]' in production
  ipAddress: '192.168.1.1',   // ← '[PII REDACTED]' in production
});

// Development output:
{ "email": "user@example.com", "fullName": "John Doe", "ipAddress": "192.168.1.1" }

// Production output:
{ "email": "[PII REDACTED]", "fullName": "[PII REDACTED]", "ipAddress": "[PII REDACTED]" }
```

**PII fields** (redacted in production by default):

- `email`, `phone`, `mobile`
- `firstName`, `first_name`, `lastName`, `last_name`, `fullName`, `full_name`
- `address`, `street`, `postcode`, `zipcode`, `zip_code`
- `ip`, `ipAddress`, `ip_address`, `userAgent`, `user_agent`

**Configuration via `LOG_SANITIZE_PII`:**

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
// ✅ GOOD - Uses userId for tracing
logger.info('User action', { userId: user.id, action: 'purchase' });

// ⚠️ OK - Email included for context (will be redacted in production)
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
DEBUG → Can I ignore this in production?
  YES → Use DEBUG
  NO  ↓

INFO → Is this an error or warning?
  NO  → Use INFO
  YES ↓

WARN → Does this break functionality?
  NO  → Use WARN
  YES ↓

ERROR → Use ERROR
```

## Request Context

Request context utilities enable distributed tracing across your application. **All API routes use request context tracing** to correlate logs across requests.

### Standard Pattern: getRouteLogger()

The recommended way to add context tracing to API routes is with `getRouteLogger()`:

```typescript
import { getRouteLogger } from '@/lib/api/context';

export async function POST(request: NextRequest) {
  const log = await getRouteLogger(request);

  log.info('Processing request');
  // All log entries automatically include:
  // - requestId (for distributed tracing)
  // - userId, sessionId (if authenticated)
  // - method, endpoint, userAgent

  try {
    const result = await doWork();
    log.info('Request completed', { resultId: result.id });
    return successResponse(result);
  } catch (error) {
    log.error('Request failed', error);
    return errorResponse('FAILED', 'Operation failed');
  }
}
```

### Available Context Utilities

| Function                   | Description                                      | Async | Location                 |
| -------------------------- | ------------------------------------------------ | ----- | ------------------------ |
| `getRouteLogger(request)`  | **Standard** — Get scoped logger for API routes  | Yes   | `lib/api/context.ts`     |
| `getRequestId()`           | Get or generate request ID from headers          | Yes   | `lib/logging/context.ts` |
| `getUserContext()`         | Extract userId, sessionId, email from session    | Yes   | `lib/logging/context.ts` |
| `getFullContext(request)`  | Combined request + user context                  | Yes   | `lib/logging/context.ts` |
| `getEndpointPath(request)` | Extract clean endpoint path without query params | No    | `lib/logging/context.ts` |
| `generateRequestId()`      | Generate new unique request ID (16-char nanoid)  | No    | `lib/logging/context.ts` |
| `getClientIp()`            | Get client IP from proxy headers                 | Yes   | `lib/logging/context.ts` |

### Request ID Propagation

**How it works**:

1. `proxy.ts` generates unique request ID for each request
2. Stored in `x-request-id` response header
3. Client includes it in subsequent requests
4. Logs across client and server share same request ID

**Example flow**:

```typescript
// 1. Client makes request
// Request ID generated: "abc123def456..."

// 2. Server logs with request ID
import { getRequestId } from '@/lib/logging/context';

export async function POST(request: NextRequest) {
  const requestId = await getRequestId();
  const requestLogger = logger.withContext({ requestId });

  requestLogger.info('Request received', {
    endpoint: '/api/v1/users',
    method: 'POST',
  });

  // All logs from this logger include requestId
  requestLogger.info('Validating input');
  requestLogger.info('Creating user');
  requestLogger.info('Request complete');
}
```

**Output**:

```json
{"timestamp":"...","level":"info","message":"Request received","context":{"requestId":"abc123..."},"meta":{"endpoint":"/api/v1/users","method":"POST"}}
{"timestamp":"...","level":"info","message":"Validating input","context":{"requestId":"abc123..."}}
{"timestamp":"...","level":"info","message":"Creating user","context":{"requestId":"abc123..."}}
{"timestamp":"...","level":"info","message":"Request complete","context":{"requestId":"abc123..."}}
```

### User Context

**Add user context to logs**:

```typescript
import { getUserContext } from '@/lib/logging/context';

export async function POST(request: NextRequest) {
  const userContext = await getUserContext();
  const userLogger = logger.withContext(userContext);

  // All logs include userId, sessionId, email (if authenticated)
  userLogger.info('User action', { action: 'create-post' });
}
```

### Combined Context

**Full context (request + user)**:

```typescript
import { getFullContext } from '@/lib/logging/context';

export async function POST(request: NextRequest) {
  const context = await getFullContext(request);
  const contextLogger = logger.withContext(context);

  // Includes: requestId, userId, sessionId, email, method, url, userAgent
  contextLogger.info('Processing request');
}
```

## Structured Metadata

### ✅ Good Structured Metadata

**Use objects, not concatenated strings**:

```typescript
// ❌ BAD - String concatenation
logger.info(`User ${userId} created order ${orderId} for $${amount}`);

// ✅ GOOD - Structured metadata
logger.info('Order created', {
  userId,
  orderId,
  amount,
  currency: 'USD',
});
```

**Use consistent field names**:

```typescript
// ✅ GOOD - Consistent naming
logger.info('User created', { userId: user.id });
logger.info('Order created', { userId: user.id, orderId: order.id });

// ❌ BAD - Inconsistent naming
logger.info('User created', { user_id: user.id });
logger.info('Order created', { userId: user.id, order_id: order.id });
```

**Include units in field names**:

```typescript
// ✅ GOOD - Units clear
logger.warn('Slow query', {
  duration_ms: 2500,
  threshold_ms: 1000,
  timeout_seconds: 30,
});

// ❌ BAD - Units unclear
logger.warn('Slow query', {
  duration: 2500, // Milliseconds? Seconds?
  threshold: 1000,
  timeout: 30,
});
```

### 📊 Queryable Metadata

**Structure metadata for log aggregation**:

```typescript
// ✅ GOOD - Easy to query in log aggregation
logger.info('Payment processed', {
  provider: 'stripe',
  amount: 99.99,
  currency: 'USD',
  paymentMethod: 'card',
  success: true,
});

// Query examples:
// - provider:"stripe" AND success:false
// - amount:>100 AND currency:"USD"
// - paymentMethod:"card"
```

**Use enums/constants for filterability**:

```typescript
// ✅ GOOD - Consistent values
const PaymentStatus = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

logger.info('Payment status changed', {
  status: PaymentStatus.COMPLETED,
});

// ❌ BAD - Inconsistent values
logger.info('Payment status changed', {
  status: 'Complete', // or 'completed' or 'COMPLETED'?
});
```

## Performance Considerations

### Log Sampling

**Don't log every request**:

```typescript
// ❌ BAD - Logs flood in high traffic
export async function GET(request: NextRequest) {
  logger.info('Request received'); // 1000 requests/sec = 1000 logs/sec
  // ...
}

// ✅ GOOD - Sample logs
let requestCount = 0;

export async function GET(request: NextRequest) {
  requestCount++;
  if (requestCount % 100 === 0) {
    // Log every 100th request
    logger.info('Request stats', {
      totalRequests: requestCount,
      sample: '1/100',
    });
  }
  // ...
}
```

### Lazy Evaluation

**Don't compute expensive metadata unless logging**:

```typescript
// ❌ BAD - Always computes expensive data
const stats = await computeExpensiveStats(); // Always runs
logger.debug('Stats computed', { stats });

// ✅ GOOD - Only compute if debug enabled
if (logger.getLevel() === LogLevel.DEBUG) {
  const stats = await computeExpensiveStats(); // Only runs in debug
  logger.debug('Stats computed', { stats });
}
```

### Avoid Logging in Tight Loops

```typescript
// ❌ BAD - Logs in loop
for (const item of items) {
  logger.debug('Processing item', { item }); // 1000 items = 1000 logs
  processItem(item);
}

// ✅ GOOD - Log summary
logger.debug('Processing items', { count: items.length });
items.forEach(processItem);
logger.debug('Items processed', { count: items.length });
```

## Log Aggregation

### Production Log Aggregation Setup

**Supported services**:

- **DataDog** - Full-featured APM and logging
- **AWS CloudWatch** - AWS-native logging
- **Grafana Loki** - Open-source, Prometheus-compatible
- **Splunk** - Enterprise log management
- **Elasticsearch + Kibana** - Self-hosted, powerful search

**Why use log aggregation**:

- ✅ Centralized search across all servers
- ✅ Real-time alerting on error patterns
- ✅ Performance monitoring and dashboards
- ✅ Correlation with metrics and traces
- ✅ Long-term log retention and analysis

### Querying Logs

**Example queries** (DataDog syntax):

```
# Find all errors from specific user
level:error AND userId:"user_123"

# Find slow database queries
duration_ms:>1000 AND query:*

# Find failed payment attempts
provider:stripe AND success:false

# Trace specific request
requestId:"abc123def456..."

# Find authentication failures
message:"Login failed" AND @timestamp:[now-1h TO now]
```

### Setting Up Alerts

**Example alert rules**:

```yaml
# Alert on high error rate
- name: High Error Rate
  condition: count(level:error) > 100 in 5 minutes
  severity: critical
  notify: oncall-team

# Alert on payment failures
- name: Payment Failures
  condition: count(provider:stripe AND success:false) > 10 in 1 hour
  severity: high
  notify: finance-team

# Alert on slow queries
- name: Slow Database Queries
  condition: avg(duration_ms) > 2000 in 10 minutes
  severity: warning
  notify: engineering-team
```

## Admin Log Buffer

The admin log buffer provides an in-memory ring buffer for storing recent log entries. This enables the admin dashboard to display application logs without requiring external log aggregation services.

**Location**: `lib/admin/logs.ts`

### How It Works

The logger automatically pushes entries to the admin log buffer via `lib/logging/index.ts` (lines 413-441). This happens transparently for all log calls.

**Key characteristics**:

- **Ring buffer**: When full, oldest entries are automatically removed
- **Max size**: 1000 entries
- **Persistence**: Survives hot reloads in development, resets on server restart
- **Non-blocking**: Failures to write to buffer are silently ignored

### Available Functions

| Function                 | Description                                                    |
| ------------------------ | -------------------------------------------------------------- |
| `addLogEntry(entry)`     | Add a log entry to the buffer (called automatically by logger) |
| `getLogEntries(options)` | Get entries with filtering (level, search) and pagination      |
| `clearLogBuffer()`       | Clear all entries from the buffer                              |
| `getBufferSize()`        | Get current number of entries in buffer                        |
| `getMaxBufferSize()`     | Get maximum buffer capacity (1000)                             |

### Example: Querying Logs

```typescript
import { getLogEntries } from '@/lib/admin/logs';

// Get recent errors
const { entries, total } = getLogEntries({
  level: 'error',
  page: 1,
  limit: 50,
});

// Search logs
const { entries: searchResults } = getLogEntries({
  search: 'database',
  level: 'warn',
});
```

**Note**: For production environments with multiple instances or long-term retention needs, use a dedicated log aggregation service (DataDog, CloudWatch, etc.) instead of relying on the in-memory buffer.

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

## Common Patterns

### Pattern 1: API Route Logging

```typescript
import { getRouteLogger } from '@/lib/api/context';

export async function POST(request: NextRequest) {
  const log = await getRouteLogger(request);

  log.info('Creating user');

  try {
    const data = await request.json();

    log.debug('Input validated', {
      fields: Object.keys(data),
    });

    const user = await createUser(data);

    log.info('User created', {
      userId: user.id,
    });

    return successResponse(user);
  } catch (error) {
    log.error('User creation failed', error);
    return handleAPIError(error);
  }
}
```

### Pattern 2: Database Operation Logging

```typescript
export async function createUser(data: CreateUserInput) {
  logger.debug('Creating user', {
    email: data.email,
    role: data.role,
  });

  const start = Date.now();

  try {
    const user = await prisma.user.create({ data });
    const duration = Date.now() - start;

    logger.info('User created in database', {
      userId: user.id,
      duration_ms: duration,
    });

    if (duration > 1000) {
      logger.warn('Slow database write', {
        operation: 'user.create',
        duration_ms: duration,
        threshold_ms: 1000,
      });
    }

    return user;
  } catch (error) {
    logger.error('Database write failed', error, {
      operation: 'user.create',
      duration_ms: Date.now() - start,
    });
    throw error;
  }
}
```

### Pattern 3: External API Logging

```typescript
export async function callStripeAPI(charge: ChargeInput) {
  logger.info('Calling Stripe API', {
    provider: 'stripe',
    amount: charge.amount,
    currency: charge.currency,
  });

  const start = Date.now();

  try {
    const result = await stripe.charges.create(charge);
    const duration = Date.now() - start;

    logger.info('Stripe API succeeded', {
      provider: 'stripe',
      chargeId: result.id,
      duration_ms: duration,
    });

    return result;
  } catch (error) {
    logger.error('Stripe API failed', error, {
      provider: 'stripe',
      duration_ms: Date.now() - start,
      statusCode: error.statusCode,
      errorType: error.type,
    });
    throw error;
  }
}
```

### Pattern 4: Child Logger for Context Inheritance

```typescript
// Parent logger with base context
const jobLogger = logger.withContext({
  jobType: 'email-batch',
  batchId: '123',
});

jobLogger.info('Starting batch job');

// Child logger inherits parent context
users.forEach((user) => {
  const userLogger = jobLogger.withContext({
    userId: user.id,
  });

  // All logs include: jobType, batchId, userId
  userLogger.info('Sending email');

  try {
    sendEmail(user);
    userLogger.info('Email sent');
  } catch (error) {
    userLogger.error('Email failed', error);
  }
});

jobLogger.info('Batch job complete');
```

## Related Documentation

- **[Error Handling Overview](./overview.md)** - Complete error handling architecture
- **[API Endpoints](./../api/endpoints.md)** - API logging patterns
- **[Environment Variables](./../environment/overview.md)** - LOG_LEVEL configuration

## See Also

- `lib/logging/index.ts` - Logger implementation
- `lib/logging/context.ts` - Context utilities (getFullContext, getRequestId, etc.)
- `lib/api/context.ts` - Route logger helper (getRouteLogger)
- `proxy.ts` - Request ID generation
- `.env.example` - LOG_LEVEL configuration
