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

// Create request-scoped logger
const requestLogger = logger.withContext({
  requestId: crypto.randomUUID(),
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
// Propagate request ID through the stack
const requestId = request.headers.get('x-request-id') || crypto.randomUUID();

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
