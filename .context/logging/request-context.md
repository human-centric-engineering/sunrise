# Request Context Tracing

**Related**: [Logging Overview](./overview.md) | [Best Practices](./best-practices.md) | [API Endpoints](../api/endpoints.md)

Request context utilities enable distributed tracing across your application. All API routes use request context tracing to correlate logs across requests.

## Quick Reference

| Need             | Use                                                    |
| ---------------- | ------------------------------------------------------ |
| API route logger | `getRouteLogger(request)` from `@/lib/api/context`     |
| Get request ID   | `getRequestId()` from `@/lib/logging/context`          |
| Get user context | `getUserContext()` from `@/lib/logging/context`        |
| Full context     | `getFullContext(request)` from `@/lib/logging/context` |

## Standard Pattern: getRouteLogger()

The recommended way to add context tracing to API routes:

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

## Available Context Utilities

| Function                   | Description                                      | Async | Location                 |
| -------------------------- | ------------------------------------------------ | ----- | ------------------------ |
| `getRouteLogger(request)`  | **Standard** - Get scoped logger for API routes  | Yes   | `lib/api/context.ts`     |
| `getRequestId()`           | Get or generate request ID from headers          | Yes   | `lib/logging/context.ts` |
| `getUserContext()`         | Extract userId, sessionId, email from session    | Yes   | `lib/logging/context.ts` |
| `getFullContext(request)`  | Combined request + user context                  | Yes   | `lib/logging/context.ts` |
| `getEndpointPath(request)` | Extract clean endpoint path without query params | No    | `lib/logging/context.ts` |
| `generateRequestId()`      | Generate new unique request ID (16-char nanoid)  | No    | `lib/logging/context.ts` |
| `getClientIp()`            | Get client IP from proxy headers                 | Yes   | `lib/logging/context.ts` |

**Note:** For rate limiting and security, use `getClientIP()` from `lib/security/ip.ts` instead — it validates IP format and provides a fallback value. The logging `getClientIp()` is for tracing purposes only.

## Request ID Propagation

### How It Works

1. `proxy.ts` generates unique request ID for each request
2. Stored in `x-request-id` response header
3. Client includes it in subsequent requests
4. Logs across client and server share same request ID

### Example Flow

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

## User Context

Add user context to logs:

```typescript
import { getUserContext } from '@/lib/logging/context';

export async function POST(request: NextRequest) {
  const userContext = await getUserContext();
  const userLogger = logger.withContext(userContext);

  // All logs include userId, sessionId, email (if authenticated)
  userLogger.info('User action', { action: 'create-post' });
}
```

## Combined Context

Full context (request + user):

```typescript
import { getFullContext } from '@/lib/logging/context';

export async function POST(request: NextRequest) {
  const context = await getFullContext(request);
  const contextLogger = logger.withContext(context);

  // Includes: requestId, userId, sessionId, email, method, url, userAgent
  contextLogger.info('Processing request');
}
```

## Using Request Context in Practice

Request context tracing enables powerful debugging and monitoring capabilities.

### Debugging with Request IDs

When a user reports an issue, ask for their request ID (shown in error messages or browser dev tools under `x-request-id` response header).

**Find all logs for a specific request:**

```bash
# Development: grep server output
grep "abc123def456" logs/app.log

# Production (DataDog):
requestId:"abc123def456"

# Production (CloudWatch Logs Insights):
fields @timestamp, @message
| filter context.requestId = "abc123def456"
| sort @timestamp asc
```

This shows the complete request lifecycle:

```
19:23:45 INFO  Creating user                    {requestId: "abc123...", endpoint: "/api/v1/users"}
19:23:45 DEBUG Validating input                 {requestId: "abc123..."}
19:23:46 INFO  Sending welcome email            {requestId: "abc123..."}
19:23:47 ERROR Email provider timeout           {requestId: "abc123...", provider: "resend"}
19:23:47 INFO  User created (email pending)     {requestId: "abc123...", userId: "user_789"}
```

### Tracing User Activity

Track all actions by a specific user across multiple requests:

```bash
# Find all requests from a user
# DataDog:
userId:"user_789"

# CloudWatch:
fields @timestamp, context.requestId, @message
| filter context.userId = "user_789"
| sort @timestamp desc
| limit 100
```

**Common investigation patterns:**

| Question                         | Query                                           |
| -------------------------------- | ----------------------------------------------- |
| What did user X do today?        | `userId:"user_789" @timestamp:[today TO now]`   |
| Which users hit this error?      | `level:error message:"Payment failed"`          |
| What requests came from this IP? | `context.ip:"192.168.1.100"`                    |
| Show slow requests (>2s)         | `duration_ms:>2000`                             |
| Find failed auth attempts        | `message:"Login failed" endpoint:"/api/auth/*"` |

### Admin Logs Viewer

The admin dashboard at `/admin/logs` shows recent application logs with full context:

- **Filter by level**: Show only errors, warnings, or info
- **Search**: Find logs containing specific text
- **Request correlation**: Click a requestId to see all related logs
- **User context**: See userId/sessionId for authenticated requests

**Note**: The admin logs viewer uses an in-memory buffer (last 1000 entries). For production with multiple instances, use a log aggregation service.

### Correlating Frontend and Backend

The `x-request-id` header enables end-to-end tracing:

```typescript
// Frontend: Include request ID in error reports
try {
  const response = await fetch('/api/v1/orders', { method: 'POST', body });
  const requestId = response.headers.get('x-request-id');

  if (!response.ok) {
    // Include requestId in error tracking (Sentry, etc.)
    captureError(new Error('Order failed'), { requestId });
  }
} catch (error) {
  // Network errors won't have requestId
  captureError(error);
}
```

```typescript
// Frontend: Show requestId in error messages for support
if (!response.ok) {
  const requestId = response.headers.get('x-request-id');
  showError(`Something went wrong. Reference: ${requestId}`);
}
```

### Production Alerting Examples

Set up alerts based on context-aware log queries:

```yaml
# Alert: High error rate for specific endpoint
- name: Payment API Errors
  query: level:error AND endpoint:"/api/v1/payments/*"
  threshold: '> 10 in 5 minutes'
  notify: payments-team

# Alert: Specific user experiencing issues
- name: VIP User Errors
  query: level:error AND userId:"vip_customer_123"
  threshold: '> 3 in 1 hour'
  notify: customer-success

# Alert: Unusual activity pattern
- name: Suspicious Auth Activity
  query: message:"Login failed" AND context.ip:*
  group_by: context.ip
  threshold: '> 20 per IP in 10 minutes'
  notify: security-team
```

## Log Aggregation Services

### Supported Services

- **DataDog** - Full-featured APM and logging
- **AWS CloudWatch** - AWS-native logging
- **Grafana Loki** - Open-source, Prometheus-compatible
- **Splunk** - Enterprise log management
- **Elasticsearch + Kibana** - Self-hosted, powerful search

### Why Use Log Aggregation

- Centralized search across all servers
- Real-time alerting on error patterns
- Performance monitoring and dashboards
- Correlation with metrics and traces
- Long-term log retention and analysis

### Querying Logs

Example queries (DataDog syntax):

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

Example alert rules:

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

## Related Documentation

- [Logging Overview](./overview.md) - Fundamentals and log levels
- [Best Practices](./best-practices.md) - Patterns and performance
- [API Endpoints](../api/endpoints.md) - API logging patterns

## See Also

- `lib/logging/context.ts` - Context utilities (getFullContext, getRequestId, etc.)
- `lib/api/context.ts` - Route logger helper (getRouteLogger)
- `proxy.ts` - Request ID generation
