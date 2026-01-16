# Performance Monitoring

Utilities for measuring operation performance, tracking database queries, and monitoring system resources.

## Quick Reference

```typescript
import {
  measureAsync,
  measureSync,
  trackDatabaseQuery,
  getMemoryUsage,
  formatBytes,
} from '@/lib/monitoring';
```

## Core Utilities

### measureAsync

Wrap async operations with automatic timing and alerting:

```typescript
const { result, metric } = await measureAsync('user-fetch', async () => {
  return await fetch('/api/users');
});

console.log(`Operation took ${metric.duration}ms`);
```

With options:

```typescript
const { result, metric } = await measureAsync(
  'payment-process',
  async () => {
    return await processPayment(order);
  },
  {
    slowThreshold: 2000, // Warn if > 2s
    criticalThreshold: 10000, // Alert if > 10s
    metadata: { orderId: order.id },
    logMetric: true, // Log to structured logger
  }
);
```

### measureSync

For synchronous operations:

```typescript
const { result, metric } = measureSync('compute-hash', () => {
  return computeExpensiveHash(data);
});
```

### trackDatabaseQuery

Specialized for database operations with automatic slow query detection:

```typescript
// Simple query
const users = await trackDatabaseQuery('findUsers', () =>
  prisma.user.findMany({ where: { active: true } })
);

// Complex query
const stats = await trackDatabaseQuery('getUserStats', async () => {
  const users = await prisma.user.count();
  const active = await prisma.user.count({ where: { active: true } });
  return { total: users, active };
});
```

Database queries are automatically prefixed with `db:` in logs:

```
[INFO] Performance: db:findUsers completed in 5ms
```

### getMemoryUsage

Get current process memory information:

```typescript
const memory = getMemoryUsage();

console.log(`Heap: ${memory.heapUsed} / ${memory.heapTotal}`);
console.log(`Usage: ${memory.percentage}%`);
console.log(`RSS: ${memory.rss}`);
```

Returns:

```typescript
interface MemoryUsage {
  heapUsed: number; // Heap memory used in bytes
  heapTotal: number; // Total heap memory in bytes
  rss: number; // Resident Set Size in bytes
  percentage: number; // Percentage of heap used (0-100)
}
```

### formatBytes

Format bytes to human-readable string:

```typescript
formatBytes(52428800); // "50.00 MB"
formatBytes(1073741824); // "1.00 GB"
formatBytes(0); // "0 Bytes"
```

## Configuration

### Environment Variables

```bash
# Threshold for logging slow operations (default: 1000ms)
PERF_SLOW_THRESHOLD_MS=1000

# Threshold for alerting critical slowdowns (default: 5000ms)
PERF_CRITICAL_THRESHOLD_MS=5000
```

### Behavior

| Duration             | Action                   |
| -------------------- | ------------------------ |
| < slowThreshold      | Debug log only           |
| >= slowThreshold     | Warning log              |
| >= criticalThreshold | Error log + Sentry alert |

## Types

### PerformanceMetric

```typescript
interface PerformanceMetric {
  name: string; // Operation identifier
  duration: number; // Duration in milliseconds
  startTime: Date; // When measurement started
  endTime: Date; // When measurement ended
  success: boolean; // Whether operation succeeded
  error?: Error; // Error if operation failed
  metadata?: Record<string>; // Additional context
}
```

### MeasureOptions

```typescript
interface MeasureOptions {
  slowThreshold?: number; // ms (default: 1000)
  criticalThreshold?: number; // ms (default: 5000)
  metadata?: Record<string>; // Additional context
  logMetric?: boolean; // Whether to log (default: true)
}
```

## Patterns

### API Route Monitoring

```typescript
export async function GET(request: NextRequest) {
  const { result: users, metric } = await measureAsync('api:users:list', async () => {
    return await trackDatabaseQuery('findAllUsers', () => prisma.user.findMany({ take: 100 }));
  });

  return Response.json({ data: users });
}
```

### External API Calls

```typescript
const { result: response, metric } = await measureAsync(
  'stripe:charge',
  async () => {
    return await stripe.paymentIntents.create({
      amount: 1000,
      currency: 'usd',
    });
  },
  {
    slowThreshold: 3000, // Stripe can be slow
    criticalThreshold: 15000,
    metadata: { customerId: customer.id },
  }
);
```

### Background Jobs

```typescript
async function processQueue() {
  const { result, metric } = await measureAsync('job:process-emails', async () => {
    const emails = await getQueuedEmails();
    for (const email of emails) {
      await sendEmail(email);
    }
    return emails.length;
  });

  logger.info('Email batch processed', {
    count: result,
    duration: metric.duration,
  });
}
```

## Integration with Sentry

When operations exceed the critical threshold, alerts are automatically sent to Sentry (if configured):

```typescript
// Automatically sent to Sentry when duration > criticalThreshold
trackMessage(`Critical slowdown detected: payment-process took 12000ms`, ErrorSeverity.Error, {
  tags: { type: 'performance', operation: 'payment-process' },
  extra: { duration: 12000, orderId: '123' },
});
```

## Best Practices

1. **Name operations meaningfully**: Use descriptive names like `api:users:create` or `db:orders:findByCustomer`

2. **Set appropriate thresholds**: Different operations have different acceptable latencies
   - Database queries: 100-500ms typical
   - External APIs: 1-5s typical
   - File operations: varies by size

3. **Include relevant metadata**: Add context that helps with debugging

   ```typescript
   measureAsync('order-process', fn, {
     metadata: { orderId, customerId, itemCount },
   });
   ```

4. **Don't over-measure**: Focus on critical paths and expensive operations, not every function call

5. **Use trackDatabaseQuery for all DB operations**: It provides specialized handling and logging for database queries

## Related

- [Health Checks](./health-checks.md) - Health endpoint includes memory info
- [Log Aggregation](./log-aggregation.md) - Performance logs in DataDog/CloudWatch
- [Sentry Setup](./sentry-setup.md) - Critical slowdown alerts
