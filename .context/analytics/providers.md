# Analytics Providers

> Provider comparison, configuration, consent, and identification

## Supported Providers

| Provider      | Type            | Best For                                         |
| ------------- | --------------- | ------------------------------------------------ |
| **Console**   | Development     | Local development, debugging                     |
| **GA4**       | Lightweight     | Simple page/event tracking                       |
| **PostHog**   | Full-featured   | Product analytics, feature flags, session replay |
| **Plausible** | Privacy-focused | GDPR-compliant, no cookies, self-hostable        |

## Provider Comparison

| Feature              | Console | GA4 | PostHog | Plausible |
| -------------------- | ------- | --- | ------- | --------- |
| Page views           | ✅      | ✅  | ✅      | ✅        |
| Custom events        | ✅      | ✅  | ✅      | ✅        |
| User identification  | ✅      | ✅  | ✅      | ❌        |
| Server-side tracking | ✅      | ✅  | ✅      | ✅        |
| Feature flags        | ❌      | ❌  | ✅      | ❌        |
| Session replay       | ❌      | ❌  | ✅      | ❌        |
| Cookieless option    | N/A     | ❌  | ✅      | ✅        |
| Self-hostable        | N/A     | ❌  | ✅      | ✅        |
| GDPR-friendly        | N/A     | ⚠️  | ✅      | ✅        |

## Configuration

### Provider Selection

Set environment variables in `.env.local`:

```bash
# Option 1: Explicit provider selection
NEXT_PUBLIC_ANALYTICS_PROVIDER=posthog

# Option 2: Auto-detect from credentials (PostHog > GA4 > Plausible)
# Just set provider-specific variables and the system will auto-detect
```

### Google Analytics 4

```bash
NEXT_PUBLIC_GA4_MEASUREMENT_ID=G-XXXXXXXXXX
GA4_API_SECRET=your-api-secret  # For server-side tracking
```

### PostHog

```bash
NEXT_PUBLIC_POSTHOG_KEY=phc_...
NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com  # or self-hosted
POSTHOG_API_KEY=your-api-key  # For server-side tracking
```

### Plausible

```bash
NEXT_PUBLIC_PLAUSIBLE_DOMAIN=yourdomain.com
NEXT_PUBLIC_PLAUSIBLE_HOST=https://plausible.io  # or self-hosted
```

## Provider Selection Logic

1. **Explicit Selection:** `NEXT_PUBLIC_ANALYTICS_PROVIDER` environment variable
2. **Auto-Detection:** Based on available credentials
   - PostHog first (most full-featured)
   - GA4 second (most common)
   - Plausible third (privacy-focused)
3. **Development Fallback:** Console provider in development mode

## Privacy Defaults

The analytics system follows privacy-first principles:

1. **Consent Required**: No tracking until user accepts cookies
2. **Session Recording Disabled**: PostHog session recording is opt-in (disabled by default)
3. **Minimal Data**: Only track what's needed for product improvement

To enable PostHog session recording:

```typescript
// lib/analytics/providers/posthog.ts
new PostHogProvider({ enableSessionRecording: true });
```

## Consent Integration

The analytics system integrates with Sunrise's cookie consent system. Analytics only track when the user has consented to optional cookies.

```typescript
// Analytics context automatically checks consent
const { track, isEnabled, isReady } = useAnalytics();

// isEnabled: User has given consent
// isReady: Consent given AND provider initialized

// Tracking calls are no-ops when consent is not given
track('event', { props }); // Safe to call anytime
```

### Conditional Analytics

```typescript
import { useAnalyticsEnabled, useAnalyticsReady } from '@/lib/analytics';

function AnalyticsStatus() {
  const isEnabled = useAnalyticsEnabled(); // Consent given
  const isReady = useAnalyticsReady(); // Consent + initialized

  return (
    <div>
      <p>Consent: {isEnabled ? 'Yes' : 'No'}</p>
      <p>Ready: {isReady ? 'Yes' : 'No'}</p>
    </div>
  );
}
```

## User Identification

Identify users after login to associate events with user profiles:

```typescript
import { useAnalytics } from '@/lib/analytics';

function LoginHandler() {
  const { identify, reset } = useAnalytics();

  const handleLogin = async (user: User) => {
    // The traits object is optional - only pass what you need
    await identify(user.id, {
      plan: user.plan,
      createdAt: user.createdAt,
    });
  };

  const handleLogout = async () => {
    await reset(); // Clear user identity
  };
}
```

**Privacy Note:** The traits object (second parameter) is **optional** and should align with your privacy policy and GDPR requirements. Passing PII such as `email` or `name` to third-party analytics providers may require explicit user consent and should be documented in your privacy policy. Consider whether you truly need this data for analytics purposes—often a user ID alone is sufficient for tracking user journeys.

**Note:** Plausible does not support user identification (privacy-first design). The `identify()` call is a no-op for Plausible.

## Server-Side Tracking

Server-side tracking bypasses ad blockers and is reliable for critical business events. Add `serverTrack()` calls to API routes you already control—don't create wrapper endpoints around external libraries.

```typescript
// In any API route you control
import { serverTrack } from '@/lib/analytics/server';
import { EVENTS } from '@/lib/analytics/events';

export async function POST(request: Request) {
  // ... authentication and business logic ...

  await serverTrack({
    event: EVENTS.ACCOUNT_DELETED, // or any string: 'subscription_created'
    userId: user.id,
    properties: {
      plan: 'pro',
      value: 99.99,
      currency: 'USD',
    },
  });

  return Response.json({ success: true });
}
```

**Real example:** See `app/api/v1/users/me/route.ts` DELETE handler for account deletion tracking.

**The pattern:** Add tracking to existing routes after the business logic succeeds. Use `EVENTS` constants for predefined events, or strings for custom events.

**In development** (console provider), you'll see logs in your terminal:

```
[DEBUG] Server track (console) {"event":"account_deleted","userId":"clxx..."}
```

**In production** with a real provider configured, it makes the actual API call.

**Requirements:**

- GA4: `GA4_API_SECRET` environment variable
- PostHog: `POSTHOG_API_KEY` environment variable
- Plausible: Works with standard configuration

## PostHog Feature Flags

When using PostHog, you can access feature flags:

```typescript
import { getAnalyticsClient } from '@/lib/analytics';
import type { PostHogProvider } from '@/lib/analytics/providers/posthog';

function FeatureFlaggedComponent() {
  const client = getAnalyticsClient();

  // Type guard for PostHog
  if (client?.type === 'posthog') {
    const posthog = client as PostHogProvider;

    if (posthog.isFeatureEnabled('new-checkout')) {
      return <NewCheckout />;
    }
  }

  return <OldCheckout />;
}
```

## Security Considerations

1. **Consent Required:** No tracking without user consent
2. **Server-Side Keys:** API secrets stored server-side only
3. **PII Handling:** Follow provider-specific guidelines
4. **Data Retention:** Configure in provider dashboards

## Related

- [Overview](./overview.md) - Architecture and quick start
- [Extending](./extending.md) - Adding new providers
- [Troubleshooting](./troubleshooting.md) - Common issues
