# Monitoring & Observability

This domain covers production-ready monitoring and observability features for Sunrise.

## Overview

Sunrise includes a comprehensive monitoring stack:

| Feature                | Status | Location                           |
| ---------------------- | ------ | ---------------------------------- |
| Health check endpoint  | ✅     | `app/api/health/route.ts`          |
| Structured logging     | ✅     | `lib/logging/`                     |
| Performance monitoring | ✅     | `lib/monitoring/`                  |
| Sentry integration     | ✅     | `lib/errors/sentry.ts`             |
| Status page component  | ✅     | `components/status/`               |
| Docker health checks   | ✅     | `Dockerfile`, `docker-compose.yml` |

## Quick Start

### Check System Health

```bash
curl http://localhost:3000/api/health
```

Response:

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 3600,
  "timestamp": "2025-01-16T10:00:00.000Z",
  "services": {
    "database": {
      "status": "operational",
      "connected": true,
      "latency": 5
    }
  }
}
```

### Monitor Performance

```typescript
import { measureAsync, trackDatabaseQuery } from '@/lib/monitoring';

// Measure any async operation
const { result, metric } = await measureAsync('user-fetch', async () => {
  return await fetch('/api/users');
});

// Track database queries with automatic slow query logging
const users = await trackDatabaseQuery('findUsers', () => prisma.user.findMany());
```

### Display Status Page

```tsx
import { StatusPage } from '@/components/status';

// Full status page component
<StatusPage
  pollingInterval={30000}
  showMemory={true}
  onStatusChange={(status) => console.log('Status changed:', status)}
/>;
```

## Documentation

| Document                                | Description                        |
| --------------------------------------- | ---------------------------------- |
| [Performance](./performance.md)         | Performance monitoring utilities   |
| [Health Checks](./health-checks.md)     | Health endpoint configuration      |
| [Sentry Setup](./sentry-setup.md)       | Error tracking with Sentry         |
| [Log Aggregation](./log-aggregation.md) | DataDog, CloudWatch, Grafana setup |
| [Web Vitals](./web-vitals.md)           | Frontend performance monitoring    |

## Environment Variables

```bash
# Performance monitoring
PERF_SLOW_THRESHOLD_MS=1000      # Log warning for operations slower than this
PERF_CRITICAL_THRESHOLD_MS=5000  # Alert Sentry for operations slower than this

# Health check
HEALTH_INCLUDE_MEMORY=false      # Include memory stats in health response

# Logging
LOG_LEVEL=info                   # debug | info | warn | error
LOG_SANITIZE_PII=true            # Sanitize PII in logs (GDPR compliance)

# Sentry (optional)
NEXT_PUBLIC_SENTRY_DSN=          # Sentry DSN for error tracking
SENTRY_AUTH_TOKEN=               # For source map uploads
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Application                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐    │
│  │  Structured │  │  Performance │  │  Error Tracking │    │
│  │   Logging   │  │  Monitoring  │  │    (Sentry)     │    │
│  │             │  │              │  │                 │    │
│  │ - Log levels│  │ - measureAsync│ │ - trackError   │    │
│  │ - Context   │  │ - trackQuery │  │ - trackMessage │    │
│  │ - PII scrub │  │ - memoryUsage│  │ - user context │    │
│  └──────┬──────┘  └──────┬───────┘  └────────┬────────┘    │
│         │                │                    │             │
│         └────────────────┼────────────────────┘             │
│                          │                                  │
│                          ▼                                  │
│              ┌───────────────────────┐                      │
│              │   Health Check API    │                      │
│              │   /api/health         │                      │
│              │                       │                      │
│              │ - Database status     │                      │
│              │ - Memory usage        │                      │
│              │ - Version & uptime    │                      │
│              └───────────────────────┘                      │
│                          │                                  │
└──────────────────────────┼──────────────────────────────────┘
                           │
                           ▼
              ┌───────────────────────┐
              │   External Services   │
              ├───────────────────────┤
              │ - Sentry (errors)     │
              │ - DataDog (logs)      │
              │ - CloudWatch (logs)   │
              │ - Grafana (metrics)   │
              └───────────────────────┘
```

## Best Practices

### 1. Use Structured Logging

Always use the structured logger instead of `console`:

```typescript
import { logger } from '@/lib/logging';

// Good
logger.info('User created', { userId, email });

// Bad
console.log('User created', userId, email);
```

### 2. Track Important Operations

Wrap critical operations with performance monitoring:

```typescript
import { measureAsync } from '@/lib/monitoring';

const { result, metric } = await measureAsync(
  'payment-process',
  async () => {
    return await processPayment(order);
  },
  { metadata: { orderId: order.id } }
);
```

### 3. Monitor Health Proactively

Use the status page component or integrate with external monitoring:

```bash
# Docker health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1
```

### 4. Set Up Alerting

Configure alerts for:

- Health check failures (503 responses)
- Critical slowdowns (> 5s operations)
- High memory usage (> 90%)
- Error rate spikes

## Related Documentation

- [Error Handling](../errors/overview.md) - Error handling patterns
- [Logging Best Practices](../errors/logging.md) - Structured logging guide
- [Deployment](../deployment/overview.md) - Production deployment
