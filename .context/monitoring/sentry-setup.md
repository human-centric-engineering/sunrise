# Sentry Integration

Sunrise includes a Sentry abstraction layer that works in no-op mode by default and activates when Sentry is configured.

## Current State

- **Package installed**: `@sentry/nextjs@^10.32.1`
- **Abstraction layer**: `lib/errors/sentry.ts`
- **Default mode**: No-op (errors logged only)
- **Activation**: Set `NEXT_PUBLIC_SENTRY_DSN` environment variable

## Quick Start

### 1. Get Sentry DSN

1. Create account at [sentry.io](https://sentry.io)
2. Create new project (choose Next.js)
3. Copy the DSN from project settings

### 2. Set Environment Variable

```bash
# .env.local
NEXT_PUBLIC_SENTRY_DSN="https://[key]@[org].ingest.sentry.io/[project]"

# Optional: For source map uploads
SENTRY_AUTH_TOKEN="your-auth-token"
```

### 3. Create Sentry Config Files

**sentry.client.config.ts** (root directory):

```typescript
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 1.0,
  debug: false,
  replaysOnErrorSampleRate: 1.0,
  replaysSessionSampleRate: 0.1,
  integrations: [
    Sentry.replayIntegration({
      maskAllText: true,
      blockAllMedia: true,
    }),
  ],
});
```

**sentry.server.config.ts** (root directory):

```typescript
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 1.0,
  debug: false,
});
```

**sentry.edge.config.ts** (optional, for edge runtime):

```typescript
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 1.0,
});
```

### 4. Update next.config.js

```javascript
const { withSentryConfig } = require('@sentry/nextjs');

const nextConfig = {
  // ... existing config
};

module.exports = withSentryConfig(
  nextConfig,
  {
    silent: true,
    org: 'your-org',
    project: 'your-project',
  },
  {
    widenClientFileUpload: true,
    transpileClientSDK: true,
    tunnelRoute: '/monitoring',
    hideSourceMaps: true,
    disableLogger: true,
  }
);
```

### 5. Update .gitignore

```
# Sentry
.sentryclirc
sentry.properties
```

### 6. Restart Development Server

```bash
npm run dev
```

## Using the Abstraction Layer

The abstraction layer in `lib/errors/sentry.ts` provides a unified API that works with or without Sentry configured.

### Track Errors

```typescript
import { trackError, ErrorSeverity } from '@/lib/errors/sentry';

try {
  await riskyOperation();
} catch (error) {
  trackError(error, {
    tags: { feature: 'checkout', step: 'payment' },
    extra: { orderId: '123', amount: 99.99 },
    level: ErrorSeverity.Error,
  });
}
```

### Track Messages

```typescript
import { trackMessage, ErrorSeverity } from '@/lib/errors/sentry';

trackMessage('User completed onboarding', ErrorSeverity.Info, {
  tags: { flow: 'onboarding' },
  extra: { userId: '123', duration: '5m' },
});
```

### Set User Context

```typescript
import { setErrorTrackingUser, clearErrorTrackingUser } from '@/lib/errors/sentry';

// After login
setErrorTrackingUser({
  id: user.id,
  email: user.email,
  name: user.name,
});

// After logout
clearErrorTrackingUser();
```

### Error Severity Levels

```typescript
enum ErrorSeverity {
  Fatal = 'fatal', // Application crash
  Error = 'error', // Recoverable error
  Warning = 'warning', // Unexpected but handled
  Info = 'info', // Important event
  Debug = 'debug', // Development info
}
```

## Integration with Monitoring

### Performance Alerts

The performance monitoring system automatically alerts Sentry for critical slowdowns:

```typescript
import { measureAsync } from '@/lib/monitoring';

// If this takes > 5000ms (default critical threshold),
// Sentry receives an alert automatically
const { result } = await measureAsync('slow-operation', async () => {
  return await slowExternalApi();
});
```

### Custom Performance Tracking

```typescript
import { trackMessage, ErrorSeverity } from '@/lib/errors/sentry';

// Manual performance alert
if (operationDuration > 10000) {
  trackMessage(`Slow operation: checkout took ${operationDuration}ms`, ErrorSeverity.Warning, {
    tags: { type: 'performance' },
    extra: { duration: operationDuration, orderId },
  });
}
```

## Environment Configuration

### Development

```bash
# Usually leave Sentry disabled in development
# NEXT_PUBLIC_SENTRY_DSN=
```

### Staging

```bash
NEXT_PUBLIC_SENTRY_DSN="https://[key]@[org].ingest.sentry.io/[staging-project]"
```

### Production

```bash
NEXT_PUBLIC_SENTRY_DSN="https://[key]@[org].ingest.sentry.io/[prod-project]"
SENTRY_AUTH_TOKEN="your-auth-token"  # For source maps
```

## Best Practices

### 1. Use Meaningful Error Context

```typescript
// Good
trackError(error, {
  tags: {
    feature: 'payment',
    provider: 'stripe',
    action: 'create-intent',
  },
  extra: {
    customerId: customer.id,
    amount: order.total,
    currency: 'USD',
  },
});

// Bad
trackError(error); // No context
```

### 2. Set User Context Early

```typescript
// In auth callback or session check
if (session?.user) {
  setErrorTrackingUser({
    id: session.user.id,
    email: session.user.email,
  });
}
```

### 3. Use Appropriate Severity Levels

- **Fatal**: Application crashed, needs immediate attention
- **Error**: Something failed, user may be impacted
- **Warning**: Something unexpected but handled
- **Info**: Important event for tracking (not errors)

### 4. Don't Expose Sensitive Data

The abstraction layer logs errors locally, but be careful not to include:

- Passwords or tokens in error messages
- Full credit card numbers
- Personal identification numbers

## Troubleshooting

### Errors Not Appearing in Sentry

1. **Check DSN is set**:

   ```bash
   echo $NEXT_PUBLIC_SENTRY_DSN
   ```

2. **Check config files exist**:

   ```bash
   ls -la sentry.*.config.ts
   ```

3. **Check for errors in console**:
   ```bash
   npm run dev 2>&1 | grep -i sentry
   ```

### Source Maps Not Working

1. **Verify auth token**:

   ```bash
   echo $SENTRY_AUTH_TOKEN
   ```

2. **Check build output**:

   ```bash
   npm run build 2>&1 | grep -i sentry
   ```

3. **Verify org/project in next.config.js**

### High Volume Warnings

If you're getting too many events:

1. **Adjust sample rates**:

   ```typescript
   Sentry.init({
     tracesSampleRate: 0.1, // 10% of transactions
     replaysSessionSampleRate: 0.01, // 1% of sessions
   });
   ```

2. **Filter known issues**:
   ```typescript
   Sentry.init({
     ignoreErrors: ['ResizeObserver loop limit exceeded', 'Network request failed'],
   });
   ```

## Related

- [Error Handling](../errors/overview.md) - Error handling architecture
- [Performance Monitoring](./performance.md) - Performance alerts to Sentry
- [Log Aggregation](./log-aggregation.md) - Alternative error tracking options
