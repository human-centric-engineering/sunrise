# Health Checks

The health check endpoint provides a standardized way to monitor application health, suitable for load balancers, container orchestration, and monitoring systems.

## Endpoint

```
GET /api/health
```

## Response Format

### Success (200 OK)

```json
{
  "status": "ok",
  "version": "0.0.0",
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

### With Memory (HEALTH_INCLUDE_MEMORY=true)

```json
{
  "status": "ok",
  "version": "0.0.0",
  "uptime": 3600,
  "timestamp": "2025-01-16T10:00:00.000Z",
  "services": {
    "database": {
      "status": "operational",
      "connected": true,
      "latency": 5
    }
  },
  "memory": {
    "heapUsed": 52428800,
    "heapTotal": 104857600,
    "rss": 157286400,
    "percentage": 50
  }
}
```

### Error (503 Service Unavailable)

```json
{
  "status": "error",
  "version": "0.0.0",
  "uptime": 3600,
  "timestamp": "2025-01-16T10:00:00.000Z",
  "services": {
    "database": {
      "status": "outage",
      "connected": false
    }
  },
  "error": "Database connection timeout"
}
```

## Response Fields

| Field               | Type   | Description                                                                         |
| ------------------- | ------ | ----------------------------------------------------------------------------------- |
| `status`            | string | Overall status: `ok` or `error`                                                     |
| `version`           | string | Application version from `package.json` (in a fork, this is the fork's app version) |
| `uptime`            | number | Process uptime in seconds                                                           |
| `timestamp`         | string | ISO 8601 timestamp of the health check                                              |
| `services`          | object | Status of individual services                                                       |
| `services.database` | object | Database health information                                                         |
| `memory`            | object | Memory usage (optional, env-controlled)                                             |
| `error`             | string | Error message (only present on exceptions)                                          |

### What is deliberately NOT here

**The Sunrise platform version.** This endpoint is unauthenticated, so every
field it returns is returned to anyone who asks, and `SUNRISE_VERSION` names the
exact upstream release — and therefore the exact published issues to try — for
every Sunrise-derived deployment rather than just this one. It moved to
`GET /api/v1/admin/stats` (`system.sunriseVersion`, behind `withAdminAuth`) and
is rendered on `/admin/overview`; see
[`.context/admin/stats.md`](../admin/stats.md) and
[`VERSIONING.md`](../../VERSIONING.md) (#531).

`version` — the fork's own app version — stays. It's the fork's number to
disclose, it means nothing outside that fork, and container health checks and
deploy-verification scripts read it.

Adding a field to this table is a disclosure decision. `tests/integration/api/health.test.ts`
asserts the **exact** top-level key set rather than a list of `toHaveProperty`
calls, so a new field fails the suite until someone has decided an anonymous
caller may have it.

## Service Status Values

| Status        | Description                       | HTTP Status |
| ------------- | --------------------------------- | ----------- |
| `operational` | Service is working normally       | 200         |
| `degraded`    | Service is slow (latency > 500ms) | 200         |
| `outage`      | Service is unavailable            | 503         |

**Degraded threshold:** Database response time exceeding 500ms triggers degraded status. See `determineServiceStatus()` in `app/api/health/route.ts`.

## Configuration

### Environment Variables

```bash
# Include memory stats in response (default: false)
# Security note: Disable in production if memory info is sensitive
HEALTH_INCLUDE_MEMORY=false
```

### Why Memory is Disabled by Default

Memory information can reveal:

- Application resource usage patterns
- Potential timing for resource exhaustion attacks
- Infrastructure sizing information

Enable only for internal monitoring or when behind authentication.

## Usage Examples

### curl

```bash
# Basic health check
curl http://localhost:3000/api/health

# With jq formatting
curl -s http://localhost:3000/api/health | jq

# Check status code only
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/health
```

### Docker Health Check

The project's `Dockerfile` uses Node's built-in HTTP module (no curl dependency):

```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"
```

Alternative with curl (requires curl in image):

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1
```

### Docker Compose

```yaml
services:
  web:
    healthcheck:
      test: ['CMD', 'curl', '-f', 'http://localhost:3000/api/health']
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

### Kubernetes Probes

```yaml
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: app
      livenessProbe:
        httpGet:
          path: /api/health
          port: 3000
        initialDelaySeconds: 10
        periodSeconds: 30
        timeoutSeconds: 5
        failureThreshold: 3
      readinessProbe:
        httpGet:
          path: /api/health
          port: 3000
        initialDelaySeconds: 5
        periodSeconds: 10
        timeoutSeconds: 5
        failureThreshold: 3
```

### AWS ALB Target Group

```json
{
  "HealthCheckPath": "/api/health",
  "HealthCheckPort": "traffic-port",
  "HealthCheckProtocol": "HTTP",
  "HealthCheckIntervalSeconds": 30,
  "HealthCheckTimeoutSeconds": 5,
  "HealthyThresholdCount": 2,
  "UnhealthyThresholdCount": 3,
  "Matcher": {
    "HttpCode": "200"
  }
}
```

## Status Page Component

Display health status in your application:

```tsx
import { StatusPage } from '@/components/status';

// Full status page with auto-refresh
<StatusPage
  pollingInterval={30000}
  showMemory={true}
  onStatusChange={(status) => {
    if (status === 'error') {
      // Alert, notify, etc.
    }
  }}
/>;
```

Individual components:

```tsx
import { StatusIndicator, ServiceStatusCard, useHealthCheck } from '@/components/status';

// Status indicator
<StatusIndicator status="operational" showLabel />

// Service card
<ServiceStatusCard
  name="Database"
  health={{ status: 'operational', connected: true, latency: 5 }}
/>

// Custom hook
const { data, isLoading, error, refresh } = useHealthCheck({
  pollingInterval: 60000,
});
```

**Polling pauses when the tab is hidden.** `useHealthCheck` runs on
[`useAutoRefresh`](../ui/hooks.md), so a background tab stops polling and
resumes — with an immediate refresh — when it comes forward. `/api/health` runs
`SELECT 1` against the database, so a forgotten admin tab used to keep a
scale-to-zero Postgres awake on its own, independent of the maintenance tick
(#442).

Two consequences for callers:

- `isPolling` means "polling is enabled", not "a timer is armed right now" — it
  stays `true` across a visibility pause, which is what a Resume affordance
  should key off.
- `startPolling()` also refreshes immediately, so resuming feels instant instead
  of waiting out a full interval.

`autoStart: false` still performs one fetch on mount, so a consumer never renders
a permanent loading state.

### Formatting Utilities

The status components include internal formatting functions:

- **`formatUptime(seconds)`** - Converts uptime seconds to human-readable format (e.g., "2d 5h 30m 15s"). Located in `components/status/status-page.tsx`.
- **`formatLatency(latencyMs)`** - Formats latency with appropriate units (ms or seconds). Located in `components/status/service-status-card.tsx`.

These are local functions, not exported. For byte formatting, use the exported `formatBytes()` from `@/lib/monitoring`.

## Extending Health Checks

### Adding New Services

To add health checks for additional services:

1. **Update the types** in `lib/monitoring/types.ts`:

```typescript
export interface HealthCheckResponse {
  // ... existing fields
  services: {
    database: ServiceHealth;
    redis?: ServiceHealth; // Add new service
    elasticsearch?: ServiceHealth;
  };
}
```

2. **Update the health route** in `app/api/health/route.ts`:

```typescript
export async function GET() {
  const dbHealth = await getDatabaseHealth();
  const redisHealth = await getRedisHealth(); // New

  const response: HealthCheckResponse = {
    // ...
    services: {
      database: {/* ... */},
      redis: redisHealth, // New
    },
  };

  // Check all services for overall status
  const allOperational = dbHealth.connected && redisHealth.connected;
  response.status = allOperational ? 'ok' : 'error';

  return NextResponse.json(response, {
    status: allOperational ? 200 : 503,
  });
}
```

3. **Update the status page** in `components/status/status-page.tsx`:

```tsx
<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
  <ServiceStatusCard name="Database" health={data.services.database} />
  {data.services.redis && (
    <ServiceStatusCard
      name="Redis"
      description="Cache and session store"
      health={data.services.redis}
    />
  )}
</div>
```

## Troubleshooting

### Health Check Returns 503

1. **Check database connection**:

   ```bash
   docker-compose exec db psql -U postgres -d sunrise -c "SELECT 1"
   ```

2. **Check environment variables**:

   ```bash
   echo $DATABASE_URL
   ```

3. **View application logs**:
   ```bash
   docker-compose logs web
   ```

### High Latency Showing Degraded Status

The health check shows "degraded" when database latency exceeds 500ms:

1. **Check database performance**:

   ```sql
   -- PostgreSQL slow query log
   SELECT * FROM pg_stat_activity WHERE state != 'idle';
   ```

2. **Check connection pool**:
   - Ensure sufficient connections in Prisma
   - Check for connection leaks

3. **Check network**:
   - Verify database is in same region
   - Check for network issues

## Related

- [Performance Monitoring](./performance.md) - Detailed performance tracking
- [Log Aggregation](./log-aggregation.md) - Send health metrics to external services
- [Deployment](../deployment/overview.md) - Production health check configuration
