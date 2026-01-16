# Sentry Integration

Sunrise includes a Sentry abstraction layer that works in no-op mode by default and activates when Sentry is configured.

## Current State

- **Package installed**: `@sentry/nextjs`
- **Abstraction layer**: `lib/errors/sentry.ts`
- **Default mode**: No-op (errors logged only)
- **Activation**: Run the Sentry wizard and set `NEXT_PUBLIC_SENTRY_DSN`

## Quick Start (Recommended)

The easiest way to set up Sentry is using the official Sentry wizard. It automatically creates all necessary config files, updates your Next.js config, and sets up error boundaries.

### 1. Create a Sentry Project

1. Create account at [sentry.io](https://sentry.io)
2. Create a new project and select **Next.js** as the platform
3. Follow the setup instructions, which will guide you to run the wizard

### 2. Run the Sentry Wizard

```bash
npx @sentry/wizard@latest -i nextjs
```

The wizard will:

- Create `sentry.client.config.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`
- Create `instrumentation.ts` and `instrumentation-client.ts` for Next.js 16+
- Update `next.config.js` with the Sentry wrapper
- Create example pages to test the integration
- Configure the tunnel route to bypass ad blockers

### 3. Verify Installation

After the wizard completes:

1. Start your dev server: `npm run dev`
2. Visit the example page created by the wizard (usually `/sentry-example-page`)
3. Click the test buttons to trigger client and server errors
4. Check your Sentry dashboard - errors should appear within seconds

### 4. Clean Up (Optional)

After verifying Sentry works, you can delete the example pages:

```bash
rm -rf app/sentry-example-page app/api/sentry-example-api
```

## Manual Setup (Alternative)

If you prefer manual configuration or the wizard doesn't work for your setup:

### 1. Set Environment Variable

```bash
# .env.local
NEXT_PUBLIC_SENTRY_DSN="https://[key]@[org].ingest.sentry.io/[project]"

# Optional: For source map uploads
SENTRY_AUTH_TOKEN="your-auth-token"
```

### 2. Create Config Files

See the [Sentry Next.js documentation](https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/) for manual configuration steps.

### 3. Restart Development Server

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
