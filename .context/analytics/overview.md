# Analytics System

> Phase 4.5: Pluggable Analytics Integration

## Overview

Sunrise includes a pluggable analytics system that supports multiple analytics providers through a unified interface. The system follows the same pattern as the storage system, with provider auto-detection and graceful degradation.

### Supported Providers

| Provider      | Type            | Best For                                         |
| ------------- | --------------- | ------------------------------------------------ |
| **Console**   | Development     | Local development, debugging                     |
| **GA4**       | Lightweight     | Simple page/event tracking                       |
| **PostHog**   | Full-featured   | Product analytics, feature flags, session replay |
| **Plausible** | Privacy-focused | GDPR-compliant, no cookies, self-hostable        |

## Architecture

```
lib/analytics/
├── index.ts                    # Public API exports
├── types.ts                    # TypeScript interfaces
├── config.ts                   # Environment and provider detection
├── client.ts                   # Singleton client (provider selection)
├── analytics-provider.tsx      # React context (consent integration)
├── hooks.ts                    # React hooks (useAnalytics, usePageTracking)
├── server.ts                   # Server-side tracking (bypasses ad blockers)
└── providers/
    ├── types.ts                # Provider interface
    ├── console.ts              # Development/debug provider
    ├── ga4.ts                  # Google Analytics 4
    ├── posthog.ts              # PostHog (full-featured)
    └── plausible.ts            # Plausible (privacy-focused)

components/analytics/
├── index.ts                    # Component exports
└── analytics-scripts.tsx       # Script loader (consent-aware)
```

## Quick Start

### 1. Configure Provider

Set environment variables in `.env.local`:

```bash
# Option 1: Explicit provider selection
NEXT_PUBLIC_ANALYTICS_PROVIDER=posthog

# Option 2: Auto-detect from credentials (PostHog > GA4 > Plausible)
# Just set provider-specific variables and the system will auto-detect
```

### 2. Provider-Specific Configuration

**Google Analytics 4:**

```bash
NEXT_PUBLIC_GA4_MEASUREMENT_ID=G-XXXXXXXXXX
GA4_API_SECRET=your-api-secret  # For server-side tracking
```

**PostHog:**

```bash
NEXT_PUBLIC_POSTHOG_KEY=phc_...
NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com  # or self-hosted
POSTHOG_API_KEY=your-api-key  # For server-side tracking
```

**Plausible:**

```bash
NEXT_PUBLIC_PLAUSIBLE_DOMAIN=yourdomain.com
NEXT_PUBLIC_PLAUSIBLE_HOST=https://plausible.io  # or self-hosted
```

### 3. Track Events

```typescript
'use client';
import { useAnalytics } from '@/lib/analytics';

function SignupButton() {
  const { track } = useAnalytics();

  return (
    <button onClick={() => track('signup_clicked', { location: 'hero' })}>
      Sign Up
    </button>
  );
}
```

### 4. Auto Page Tracking

```typescript
// In a layout component
'use client';
import { usePageTracking } from '@/lib/analytics';

function DashboardLayout({ children }: { children: React.ReactNode }) {
  usePageTracking(); // Tracks on route changes
  return <>{children}</>;
}
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

## User Identification

Identify users after login to associate events with user profiles:

```typescript
import { useAnalytics } from '@/lib/analytics';

function LoginHandler() {
  const { identify, reset } = useAnalytics();

  const handleLogin = async (user: User) => {
    await identify(user.id, {
      email: user.email,
      name: user.name,
      plan: user.plan,
      createdAt: user.createdAt,
    });
  };

  const handleLogout = async () => {
    await reset(); // Clear user identity
  };
}
```

**Note:** Plausible does not support user identification (privacy-first design). The `identify()` call is a no-op for Plausible.

## Server-Side Tracking

Server-side tracking bypasses ad blockers and is reliable for critical events:

```typescript
import { serverTrack } from '@/lib/analytics/server';

export async function POST(request: Request) {
  const user = await getUser();

  await serverTrack({
    event: 'subscription_created',
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

**Requirements:**

- GA4: `GA4_API_SECRET` environment variable
- PostHog: `POSTHOG_API_KEY` environment variable
- Plausible: Works with standard configuration

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

## Advanced Usage

### PostHog Feature Flags

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

### Custom Event Tracking Hook

```typescript
import { useTrackEvent } from '@/lib/analytics';

function ProductCard({ productId }: { productId: string }) {
  const trackClick = useTrackEvent('product_clicked');

  return (
    <div onClick={() => trackClick({ productId })}>
      {/* Product content */}
    </div>
  );
}
```

### Conditional Analytics

```typescript
import { useAnalyticsEnabled, useAnalyticsReady } from '@/lib/analytics';

function AnalyticsStatus() {
  const isEnabled = useAnalyticsEnabled(); // Consent given
  const isReady = useAnalyticsReady();     // Consent + initialized

  return (
    <div>
      <p>Consent: {isEnabled ? 'Yes' : 'No'}</p>
      <p>Ready: {isReady ? 'Yes' : 'No'}</p>
    </div>
  );
}
```

## Testing

### Unit Testing with Console Provider

In development, the console provider logs all analytics calls:

```typescript
// .env.local
NEXT_PUBLIC_ANALYTICS_PROVIDER = console;
```

Console output:

```
[Analytics] track [12:34:56.789] signup_clicked { location: 'hero' }
[Analytics] identify [12:34:57.123] user_123 { email: '...' }
[Analytics] page [12:34:58.456] Dashboard { path: '/dashboard' }
```

### Mocking in Tests

```typescript
import { vi } from 'vitest';
import * as analytics from '@/lib/analytics';

vi.mock('@/lib/analytics', () => ({
  useAnalytics: () => ({
    track: vi.fn().mockResolvedValue({ success: true }),
    identify: vi.fn().mockResolvedValue({ success: true }),
    page: vi.fn().mockResolvedValue({ success: true }),
    reset: vi.fn().mockResolvedValue({ success: true }),
    isReady: true,
    isEnabled: true,
    providerName: 'mock',
  }),
}));
```

## Provider Selection Logic

1. **Explicit Selection:** `NEXT_PUBLIC_ANALYTICS_PROVIDER` environment variable
2. **Auto-Detection:** Based on available credentials
   - PostHog first (most full-featured)
   - GA4 second (most common)
   - Plausible third (privacy-focused)
3. **Development Fallback:** Console provider in development mode

## Files Reference

| File                                         | Purpose                  |
| -------------------------------------------- | ------------------------ |
| `lib/analytics/types.ts`                     | TypeScript interfaces    |
| `lib/analytics/config.ts`                    | Environment detection    |
| `lib/analytics/client.ts`                    | Singleton client         |
| `lib/analytics/analytics-provider.tsx`       | React context            |
| `lib/analytics/hooks.ts`                     | React hooks              |
| `lib/analytics/server.ts`                    | Server-side tracking     |
| `lib/analytics/providers/*.ts`               | Provider implementations |
| `components/analytics/analytics-scripts.tsx` | Script loading           |

## Security Considerations

1. **Consent Required:** No tracking without user consent
2. **Server-Side Keys:** API secrets stored server-side only
3. **PII Handling:** Follow provider-specific guidelines
4. **Data Retention:** Configure in provider dashboards

## Common Issues

### Analytics Not Tracking

1. Check consent: User must accept optional cookies
2. Check provider: Verify environment variables are set
3. Check scripts: Ensure `AnalyticsScripts` is in layout
4. Check console: Look for initialization errors

### Ad Blocker Blocking Scripts

Use server-side tracking for critical events:

```typescript
// API route - bypasses ad blockers
await serverTrack({
  event: 'purchase_completed',
  userId: user.id,
  properties: { orderId, amount },
});
```

### PostHog Feature Flags Not Loading

Feature flags require initialization:

```typescript
const posthog = client as PostHogProvider;
posthog.onFeatureFlags((flags) => {
  console.log('Flags loaded:', flags);
});
```
