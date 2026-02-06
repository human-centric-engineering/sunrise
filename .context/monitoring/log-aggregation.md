# Log Aggregation

Guide for integrating Sunrise's structured logging with external log aggregation services.

## Overview

Sunrise's structured logging system outputs JSON in production, making it compatible with major log aggregation platforms:

```json
{
  "timestamp": "2025-01-16T10:00:00.000Z",
  "level": "info",
  "message": "User logged in",
  "context": { "requestId": "abc123" },
  "meta": { "userId": "user_456" }
}
```

## Request Context Utilities

Utilities in `lib/logging/context.ts` for request tracing and context propagation.

### Quick Reference

| Function              | Purpose                                    | Async |
| --------------------- | ------------------------------------------ | ----- |
| `generateRequestId()` | Creates unique 16-char request ID          | No    |
| `getRequestId()`      | Gets ID from headers or generates new one  | Yes   |
| `getRequestContext()` | Gets request ID, method, URL, user agent   | Yes   |
| `getUserContext()`    | Gets userId, sessionId, email from session | Yes   |
| `getFullContext()`    | Combines request + user context            | Yes   |
| `getEndpointPath()`   | Extracts pathname without query params     | No    |
| `getClientIp()`       | Gets client IP from proxy headers          | Yes   |

### Request ID Generation

```typescript
import { generateRequestId, getRequestId } from '@/lib/logging/context';

// Generate a new request ID (synchronous)
const newId = generateRequestId();
// Returns: 'v1StGXR8_Z5jdHi6' (16-char nanoid)

// Get request ID from headers, or generate if missing (async)
const requestId = await getRequestId();
// Checks 'x-request-id' header first, generates new ID if not found
```

### Request Context

```typescript
import { getRequestContext, getFullContext } from '@/lib/logging/context';

export async function POST(request: NextRequest) {
  // Get request metadata only
  const context = await getRequestContext(request);
  // Returns: { requestId, method, url, userAgent }

  // Get combined request + user context
  const fullContext = await getFullContext(request);
  // Returns: { requestId, method, url, userAgent, userId, sessionId, email }

  const logger = createLogger(fullContext);
  logger.info('User action logged');
}
```

### User Context

```typescript
import { getUserContext } from '@/lib/logging/context';

// Get authenticated user context from better-auth session
const userContext = await getUserContext();
// Returns: { userId, sessionId, email } or {} if not authenticated

// Fails silently - won't throw if auth unavailable
```

### Endpoint Path Extraction

```typescript
import { getEndpointPath } from '@/lib/logging/context';

// Extract clean pathname without query parameters
const path = getEndpointPath(request);
// Input:  '/api/v1/users?page=1&limit=10'
// Output: '/api/v1/users'
```

### Client IP Detection

```typescript
import { getClientIp } from '@/lib/logging/context';

const ip = await getClientIp();
// Checks headers in order: x-forwarded-for, x-real-ip, cf-connecting-ip,
// x-client-ip, x-cluster-client-ip
// Returns first IP from comma-separated list (for x-forwarded-for)

logger.warn('Rate limit exceeded', { ip, endpoint: '/api/auth/login' });
```

## Advanced Logger Usage

The `Logger` class in `lib/logging/index.ts` provides advanced features for context propagation and dynamic configuration.

### Child Loggers and Context Propagation

Use `child()` or `withContext()` to create loggers with additional context that's automatically included in all log entries:

```typescript
import { logger, createLogger } from '@/lib/logging';

// Method 1: Using withContext() on existing logger
const requestLogger = logger.withContext({ requestId: 'abc123' });
requestLogger.info('Processing started');
// Logs: { ..., context: { requestId: 'abc123' }, message: 'Processing started' }

// Method 2: Using child() (alias for withContext)
const userLogger = requestLogger.child({ userId: 'user_456' });
userLogger.info('User action');
// Logs: { ..., context: { requestId: 'abc123', userId: 'user_456' }, ... }

// Method 3: createLogger() factory with initial context
const apiLogger = createLogger({ module: 'api', version: 'v1' });
apiLogger.info('API initialized');
```

### Context Chaining Pattern

```typescript
export async function POST(request: NextRequest) {
  const context = await getFullContext(request);
  const log = createLogger(context);

  log.info('Request received');

  // Pass logger to nested functions for consistent tracing
  const result = await processOrder(orderId, log);

  log.info('Request completed', { result });
}

async function processOrder(orderId: string, log: Logger) {
  const orderLog = log.child({ orderId });
  orderLog.info('Processing order');
  // All logs include requestId, userId, AND orderId
}
```

### Dynamic Log Level Control

```typescript
import { logger, LogLevel } from '@/lib/logging';

// Get current log level
const currentLevel = logger.getLevel();
// Returns: LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, or LogLevel.ERROR

// Set log level dynamically (useful for debugging in production)
logger.setLevel(LogLevel.DEBUG);
logger.debug('Now visible'); // Would be hidden with default INFO level

// Reset to production level
logger.setLevel(LogLevel.INFO);
```

### Log Level Configuration

| Environment       | Default Level | Override                        |
| ----------------- | ------------- | ------------------------------- |
| Development       | `debug`       | `LOG_LEVEL=info` (less verbose) |
| Production        | `info`        | `LOG_LEVEL=debug` (more detail) |
| Invalid LOG_LEVEL | Uses default  | Silently ignored                |

```bash
# Environment variable options
LOG_LEVEL=debug  # All logs
LOG_LEVEL=info   # Info, warn, error only
LOG_LEVEL=warn   # Warn and error only
LOG_LEVEL=error  # Errors only
```

### createLogger() Factory

```typescript
import { createLogger } from '@/lib/logging';

// Create module-scoped loggers
const dbLogger = createLogger({ module: 'database' });
const authLogger = createLogger({ module: 'auth' });
const emailLogger = createLogger({ module: 'email' });

// Use throughout the module
dbLogger.info('Query executed', { query: 'SELECT ...', duration: 45 });
```

## PII Sanitization

The logging system automatically sanitizes sensitive data to prevent credential leaks and ensure GDPR/CCPA compliance.

### Sanitization Categories

**Secret Fields (ALWAYS redacted):**

Fields matching these patterns are replaced with `[REDACTED]` in all environments:

- `password`, `token`, `apikey`, `api_key`, `secret`
- `creditcard`, `credit_card`, `ssn`
- `authorization`, `bearer`, `credential`
- `private_key`, `privatekey`

**PII Fields (environment-dependent):**

Fields matching these patterns are replaced with `[PII REDACTED]` based on configuration:

- `email`, `phone`, `mobile`
- `firstname`, `first_name`, `lastname`, `last_name`, `fullname`, `full_name`
- `address`, `street`, `postcode`, `zipcode`, `zip_code`
- `ip`, `ipaddress`, `ip_address`, `useragent`, `user_agent`

### Environment Behavior

| Environment | Secrets         | PII                   |
| ----------- | --------------- | --------------------- |
| Production  | Always redacted | Redacted by default   |
| Development | Always redacted | Shown (for debugging) |

### LOG_SANITIZE_PII Variable

Override default PII behavior with the `LOG_SANITIZE_PII` environment variable:

```bash
# Not set (default): Auto-detect based on NODE_ENV
# Production: sanitize PII
# Development: show PII

LOG_SANITIZE_PII=true   # Always sanitize PII (both environments)
LOG_SANITIZE_PII=false  # Never sanitize PII (use with caution!)
```

### Sanitization Examples

```typescript
logger.info('User registered', {
  email: 'user@example.com',
  password: 'secret123',
  userId: 'usr_abc',
});

// Development output (PII shown, secrets always hidden):
// { email: 'user@example.com', password: '[REDACTED]', userId: 'usr_abc' }

// Production output (both hidden):
// { email: '[PII REDACTED]', password: '[REDACTED]', userId: 'usr_abc' }
```

### Pattern Matching

Field names are matched using word boundaries to avoid false positives:

```typescript
// Matches (will be sanitized)
'password'; // exact match
'userPassword'; // camelCase boundary
'user_password'; // underscore boundary
'PASSWORD'; // case-insensitive

// Does NOT match (safe)
'recipients'; // 'ip' is part of word, not a boundary
'shipping'; // 'ip' embedded in word
```

### Anti-Patterns

**Don't:** Rely on sanitization for highly sensitive data

```typescript
// Bad: Logging raw credit card data
logger.info('Payment received', { cardNumber: '4111111111111111' });
```

**Do:** Mask sensitive data before logging

```typescript
// Good: Only log last 4 digits
logger.info('Payment received', { cardLast4: card.number.slice(-4) });
```

**Don't:** Log authentication tokens in URLs

```typescript
// Bad: Token in URL
logger.info('Webhook received', { url: `/webhook?token=${secret}` });
```

**Do:** Redact tokens from URLs before logging

```typescript
// Good: Redact sensitive query params
const safeUrl = url.replace(/token=[^&]+/, 'token=[REDACTED]');
logger.info('Webhook received', { url: safeUrl });
```

## DataDog

### Docker Integration

Add DataDog agent to your Docker Compose:

```yaml
# docker-compose.prod.yml
services:
  web:
    # ... existing config
    labels:
      com.datadoghq.ad.logs: '[{"source": "nodejs", "service": "sunrise"}]'

  datadog-agent:
    image: datadog/agent:latest
    environment:
      - DD_API_KEY=${DD_API_KEY}
      - DD_SITE=datadoghq.com
      - DD_LOGS_ENABLED=true
      - DD_LOGS_CONFIG_CONTAINER_COLLECT_ALL=true
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - /var/lib/docker/containers:/var/lib/docker/containers:ro
```

### Environment Variables

```bash
DD_API_KEY=your-api-key
DD_SITE=datadoghq.com  # or datadoghq.eu for EU
```

### Parsing Configuration

Create a pipeline in DataDog to parse Sunrise logs:

```yaml
# datadog-pipeline.yml
processors:
  - type: json-parser
    name: Parse JSON logs
    enabled: true
    source: message
  - type: date-remapper
    name: Define timestamp
    enabled: true
    sources:
      - timestamp
  - type: status-remapper
    name: Define log level
    enabled: true
    sources:
      - level
  - type: attribute-remapper
    name: Map request ID
    enabled: true
    sources:
      - context.requestId
    target: trace_id
    target_type: tag
```

### APM Integration

Add DataDog APM for tracing:

```bash
npm install dd-trace
```

```typescript
// instrumentation.ts (root)
import tracer from 'dd-trace';

tracer.init({
  service: 'sunrise',
  env: process.env.NODE_ENV,
});

export default tracer;
```

## AWS CloudWatch

### Container Logging (ECS/Fargate)

Configure the task definition:

```json
{
  "containerDefinitions": [
    {
      "name": "sunrise",
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/sunrise",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "ecs",
          "awslogs-create-group": "true"
        }
      }
    }
  ]
}
```

### EC2 with CloudWatch Agent

Install and configure CloudWatch agent:

```json
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/sunrise/*.log",
            "log_group_name": "sunrise",
            "log_stream_name": "{instance_id}",
            "timestamp_format": "%Y-%m-%dT%H:%M:%S.%fZ"
          }
        ]
      }
    }
  }
}
```

### CloudWatch Insights Queries

```sql
-- Errors in last hour
fields @timestamp, @message
| filter level = 'error'
| sort @timestamp desc
| limit 100

-- Slow operations
fields @timestamp, meta.operation, meta.duration
| filter meta.duration > 1000
| sort meta.duration desc
| limit 50

-- Requests by endpoint
fields context.endpoint
| stats count() by context.endpoint
| sort count() desc
```

### CloudWatch Alarms

```yaml
# cloudformation.yml
Resources:
  ErrorAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmName: sunrise-errors
      MetricName: ErrorCount
      Namespace: Sunrise
      Statistic: Sum
      Period: 300
      EvaluationPeriods: 1
      Threshold: 10
      ComparisonOperator: GreaterThanThreshold
      AlarmActions:
        - !Ref AlertTopic
```

## Grafana Loki

### Docker Integration

```yaml
# docker-compose.prod.yml
services:
  web:
    logging:
      driver: loki
      options:
        loki-url: 'http://loki:3100/loki/api/v1/push'
        labels: 'service=sunrise,env=production'

  loki:
    image: grafana/loki:latest
    ports:
      - '3100:3100'
    volumes:
      - loki-data:/loki

  grafana:
    image: grafana/grafana:latest
    ports:
      - '3001:3000'
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    volumes:
      - grafana-data:/var/lib/grafana
```

### Loki Configuration

```yaml
# loki-config.yml
auth_enabled: false

server:
  http_listen_port: 3100

ingester:
  lifecycler:
    ring:
      kvstore:
        store: inmemory
      replication_factor: 1

schema_config:
  configs:
    - from: 2020-10-24
      store: boltdb-shipper
      object_store: filesystem
      schema: v11
      index:
        prefix: index_
        period: 24h

storage_config:
  boltdb_shipper:
    active_index_directory: /loki/boltdb-shipper-active
    cache_location: /loki/boltdb-shipper-cache
  filesystem:
    directory: /loki/chunks
```

### LogQL Queries

```logql
# Errors by service
{service="sunrise"} |= "error"

# JSON parsing
{service="sunrise"} | json | level="error"

# Aggregation
sum(rate({service="sunrise"} | json | level="error" [5m])) by (context_endpoint)
```

## Elastic Stack (ELK)

### Filebeat Configuration

```yaml
# filebeat.yml
filebeat.inputs:
  - type: container
    paths:
      - /var/lib/docker/containers/*/*.log
    processors:
      - decode_json_fields:
          fields: ['message']
          target: 'sunrise'
          overwrite_keys: true

output.elasticsearch:
  hosts: ['elasticsearch:9200']
  index: 'sunrise-%{+yyyy.MM.dd}'

setup.kibana:
  host: 'kibana:5601'
```

### Elasticsearch Index Template

```json
{
  "index_patterns": ["sunrise-*"],
  "mappings": {
    "properties": {
      "timestamp": { "type": "date" },
      "level": { "type": "keyword" },
      "message": { "type": "text" },
      "context": {
        "properties": {
          "requestId": { "type": "keyword" },
          "userId": { "type": "keyword" },
          "endpoint": { "type": "keyword" }
        }
      },
      "meta": { "type": "object", "dynamic": true },
      "error": {
        "properties": {
          "name": { "type": "keyword" },
          "message": { "type": "text" },
          "stack": { "type": "text" }
        }
      }
    }
  }
}
```

## Log Forwarding Best Practices

### 1. Use Log Levels Effectively

```typescript
// Production: Set LOG_LEVEL=info to reduce noise
LOG_LEVEL = info; // Excludes debug logs
```

### 2. Add Request Context

```typescript
import { logger } from '@/lib/logging';
import { generateRequestId } from '@/lib/logging/context';

// Create request-scoped logger
const requestLogger = logger.withContext({
  requestId: generateRequestId(),
  userId: session?.user?.id,
  endpoint: request.url,
});

requestLogger.info('Processing request');
```

### 3. Structure for Querying

```typescript
// Good: Structured fields for filtering
logger.info('Payment processed', {
  paymentId: payment.id,
  amount: payment.amount,
  currency: payment.currency,
  customerId: customer.id,
});

// Bad: Unstructured message
logger.info(`Payment ${payment.id} of $${payment.amount} for customer ${customer.id}`);
```

### 4. Include Correlation IDs

```typescript
import { generateRequestId } from '@/lib/logging/context';

// Propagate request ID through the stack
const requestId = request.headers.get('x-request-id') || generateRequestId();

const log = logger.withContext({ requestId });

// All subsequent logs include requestId
log.info('Starting request');
await processOrder(orderId, log);
log.info('Request completed');
```

### 5. Avoid Logging Sensitive Data

Sunrise automatically sanitizes:

- Passwords, tokens, API keys (always)
- PII like emails, names, IPs (in production)

But avoid logging:

- Full credit card numbers
- Authentication tokens in URLs
- File contents that may contain secrets

## Related

- [Performance Monitoring](./performance.md) - Performance logs
- [Health Checks](./health-checks.md) - Health status logging
- [Sentry Setup](./sentry-setup.md) - Error tracking alternative
