# Logging Best Practices

**Related**: [Logging Overview](./overview.md) | [Request Context](./request-context.md)

Patterns and performance considerations for effective structured logging.

## Quick Reference

| Anti-Pattern              | Better Approach                                  |
| ------------------------- | ------------------------------------------------ |
| String concatenation      | Structured metadata objects                      |
| Inconsistent field names  | Use consistent naming conventions                |
| Missing units             | Include units in field names (`_ms`, `_seconds`) |
| Logging in loops          | Log summaries before/after                       |
| Always computing metadata | Lazy evaluation for expensive data               |

## Structured Metadata

### Use Objects, Not Strings

```typescript
// BAD - String concatenation
logger.info(`User ${userId} created order ${orderId} for $${amount}`);

// GOOD - Structured metadata
logger.info('Order created', {
  userId,
  orderId,
  amount,
  currency: 'USD',
});
```

### Consistent Field Names

```typescript
// GOOD - Consistent naming
logger.info('User created', { userId: user.id });
logger.info('Order created', { userId: user.id, orderId: order.id });

// BAD - Inconsistent naming
logger.info('User created', { user_id: user.id });
logger.info('Order created', { userId: user.id, order_id: order.id });
```

### Include Units in Field Names

```typescript
// GOOD - Units clear
logger.warn('Slow query', {
  duration_ms: 2500,
  threshold_ms: 1000,
  timeout_seconds: 30,
});

// BAD - Units unclear
logger.warn('Slow query', {
  duration: 2500, // Milliseconds? Seconds?
  threshold: 1000,
  timeout: 30,
});
```

## Queryable Metadata

### Structure for Log Aggregation

```typescript
// GOOD - Easy to query in log aggregation
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

### Use Enums for Filterability

```typescript
// GOOD - Consistent values
const PaymentStatus = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

logger.info('Payment status changed', {
  status: PaymentStatus.COMPLETED,
});

// BAD - Inconsistent values
logger.info('Payment status changed', {
  status: 'Complete', // or 'completed' or 'COMPLETED'?
});
```

## Performance Considerations

### Log Sampling

Don't log every request in high-traffic scenarios:

```typescript
// BAD - Logs flood in high traffic
export async function GET(request: NextRequest) {
  logger.info('Request received'); // 1000 requests/sec = 1000 logs/sec
  // ...
}

// GOOD - Sample logs
let requestCount = 0;

export async function GET(request: NextRequest) {
  requestCount++;
  if (requestCount % 100 === 0) {
    logger.info('Request stats', {
      totalRequests: requestCount,
      sample: '1/100',
    });
  }
  // ...
}
```

### Lazy Evaluation

Don't compute expensive metadata unless logging:

```typescript
// BAD - Always computes expensive data
const stats = await computeExpensiveStats(); // Always runs
logger.debug('Stats computed', { stats });

// GOOD - Only compute if debug enabled
if (logger.getLevel() === LogLevel.DEBUG) {
  const stats = await computeExpensiveStats(); // Only runs in debug
  logger.debug('Stats computed', { stats });
}
```

### Avoid Logging in Tight Loops

```typescript
// BAD - Logs in loop
for (const item of items) {
  logger.debug('Processing item', { item }); // 1000 items = 1000 logs
  processItem(item);
}

// GOOD - Log summary
logger.debug('Processing items', { count: items.length });
items.forEach(processItem);
logger.debug('Items processed', { count: items.length });
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

## Admin Log Buffer

The admin log buffer provides an in-memory ring buffer for storing recent log entries. This enables the admin dashboard to display application logs without requiring external log aggregation services.

**Location**: `lib/admin/logs.ts`

### How It Works

The logger automatically pushes entries to the admin log buffer via `lib/logging/index.ts`. This happens transparently for all log calls.

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

## Related Documentation

- [Logging Overview](./overview.md) - Fundamentals and log levels
- [Request Context](./request-context.md) - Request ID propagation
- [Error Handling Overview](../errors/overview.md) - Complete error handling architecture

## See Also

- `lib/logging/index.ts` - Logger implementation
- `lib/admin/logs.ts` - Admin log buffer
- `lib/api/context.ts` - Route logger helper
