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

- Create `instrumentation-client.ts` (the browser SDK's init on Next.js 16,
  which builds with Turbopack), `sentry.server.config.ts` and
  `sentry.edge.config.ts`, loaded from `instrumentation.ts`
- Older wizard runs also wrote `sentry.client.config.ts`; `@sentry/nextjs` 11
  loads it only on a webpack build, so on Next 16 the client's `Sentry.init` is
  the one in `instrumentation-client.ts`
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

## Sentry 11: Set What It Collects

`@sentry/nextjs` 11 (Sunrise 0.14.0) **collects request and response bodies,
headers, cookies, query parameters, database query parameters, local variables
in stack frames and gen-AI prompts and outputs by default**. Sunrise's agents
carry user chat content and personal data through every one of those, so a
fork that turns Sentry on without setting this sends that data to Sentry. Set
`dataCollection` in every `Sentry.init` the wizard writes
(`instrumentation-client.ts`, `sentry.server.config.ts`,
`sentry.edge.config.ts`), and widen it only for what you have decided to send:

```typescript
import * as Sentry from '@sentry/nextjs';
import { scrubSentryEvent, scrubSentrySpan } from '@/lib/errors/sentry';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  // Page URLs: drop query strings and fragments, collapse id- and
  // credential-shaped path segments (see "Page URLs" below). `beforeSend` is
  // needed in instrumentation-client.ts and sentry.edge.config.ts; the Node
  // server config can leave it out.
  beforeSend: scrubSentryEvent,
  beforeSendSpan: scrubSentrySpan,
  // Collect nothing about the request, the user or the data by default.
  // (Session Replay is separate; see below.)
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    graphQL: { document: false, variables: false },
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    queues: false,
    stackFrameVariables: false,
  },
});
```

`setErrorTrackingUser()` still attaches the user you pass it; `userInfo: false`
stops only the SDK filling in `user.*` from request data on its own.

### Page URLs

A page URL can carry a credential or personal data: a token or an email in the
query string or the fragment, or a token as a path segment (a share page such
as `/s/<token>`). `urlQueryParams: false` covers only query strings the SDK
collected itself. `lib/errors/sentry.ts` covers the rest:

- **Error events, by default.** Sunrise registers `scrubSentryEvent` on
  Sentry's global scope the first time it uses Sentry: on the client from
  `ErrorHandlingProvider` (`initErrorTracking()`), on the Node server from
  `instrumentation.ts`. It reduces an event's `request.url`, transaction
  name, message and exception values, stack frames' file URLs (an inline
  script's frame is the page URL) and every string in `extra` (nested objects
  included) to origin plus path, and scrubs the trace context and the
  breadcrumbs the event carries (a fetch or xhr `url`, a navigation's `from` /
  `to`, a console breadcrumb's message and arguments), its `logentry` and any
  request headers. The registration runs late in two places, so **also set
  `beforeSend: scrubSentryEvent`** there: in `instrumentation-client.ts`,
  because `ErrorHandlingProvider` registers only after hydration and an error
  raised while the page loads would otherwise go out unscrubbed; and in
  `sentry.edge.config.ts`, because the edge runtime does not run
  `instrumentation.ts`'s Node branch. Scrubbing twice changes nothing.
  `beforeBreadcrumb` is not needed.
- **Spans: add `beforeSendSpan: scrubSentrySpan`** to each `Sentry.init`.
  Under v11's default `traceLifecycle: 'stream'`, spans go out one by one and
  never pass through an event processor. It scrubs every URL and path in each
  span's name and attribute values, and in its links' attributes (`url.full`,
  `http.url`, `next.span_name`, a captured `referer` header…), and drops
  `url.fragment`, `url.query` and the raw path-parameter values
  (`url.path.parameter.*`, `url.path.params.*`, `params.*`).

Each id- or credential-shaped path segment becomes `[param]`
(`collapseDynamicSegments()` in `lib/logging/redact-path.ts`, which lists what
it cannot catch). The tail of a path from `/_next/static/` on, and in a file
path (a server stack frame) from `/node_modules/` on, is kept as built so source
maps and issue grouping still work; segments before it are still collapsed. A
copied Error keeps its `cause` / `errors` chain, scrubbed the same way; a
built-in class (`TypeError`, `AggregateError`…) keeps its class, and any other
(a `DOMException`, your own subclass) becomes a plain `Error` with the same
name, because its getters cannot run on a copy. Any other object becomes a
plain object of its own properties, scrubbed. The global client error handler
(`lib/errors/handler.ts`) already sends the page as the collapsed pathname,
under `extra.path`, and scrubs the URLs in its context and in the error it
reports. Request headers are scrubbed like the rest; tags are not. Keep
`httpHeaders` off anyway, as above.

**If you set `traceLifecycle: 'static'`**, `scrubSentrySpan` is never called
(it takes the streamed span shape). The global event processor still scrubs
each transaction and its child spans. Standalone spans (INP and other web
vitals sent outside a transaction) pass through neither and are **not**
scrubbed under `'static'`; stay on `'stream'` if you send them.

**Session Replay is not governed by `dataCollection`.** The wizard adds
`replayIntegration()` to the client init, and a replay records what the admin
saw, chat content included. Either leave it out, or mask everything and record
only sessions that errored:

```typescript
Sentry.init({
  // …dsn and dataCollection as above
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1.0,
  integrations: [Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true })],
});
```

Two other v11 changes a setup written for v10 hits:

- **`withSentryConfig` moved** to `@sentry/nextjs/config`:
  `import { withSentryConfig } from '@sentry/nextjs/config';`
- **Node 20.19+** is required; Sunrise runs on Node 24.

The calls `lib/errors/sentry.ts` makes (`withScope`, `captureException`,
`captureMessage`, `setUser`) are unchanged. See Sentry's
[v10 → v11 migration guide](https://docs.sentry.io/platforms/javascript/migration/v10-to-v11/)
for the rest.

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
     replaysSessionSampleRate: 0.01, // 1% of sessions, masked as in "Sentry 11" above
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
