# Analytics System

> Phase 4.5: Pluggable Analytics Integration

## Overview

Sunrise includes a pluggable analytics system that supports multiple analytics providers through a unified interface. The system follows the same pattern as the storage system, with provider auto-detection and graceful degradation.

### Documentation

| Document                                | When to Use                                  |
| --------------------------------------- | -------------------------------------------- |
| [Events](./events.md)                   | Adding/tracking events, checking what exists |
| [Providers](./providers.md)             | Setting up or switching providers            |
| [Extending](./extending.md)             | Adding new events, hooks, or providers       |
| [Troubleshooting](./troubleshooting.md) | Debugging analytics issues                   |

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
├── index.ts                    # Public API exports (useAnalytics, EVENTS)
├── types.ts                    # Core TypeScript interfaces
├── config.ts                   # Environment and provider detection
├── client.ts                   # Singleton client (provider selection)
├── analytics-provider.tsx      # React context (consent integration)
├── hooks.ts                    # React hooks (useAnalytics, usePageTracking)
├── server.ts                   # Server-side tracking
├── events/
│   ├── index.ts                # Event exports
│   ├── constants.ts            # EVENTS object (all event names)
│   ├── types.ts                # Event property interfaces
│   └── forms.ts                # useFormAnalytics hook
└── providers/
    ├── types.ts                # Provider interface
    ├── console.ts              # Development provider
    ├── ga4.ts                  # Google Analytics 4
    ├── posthog.ts              # PostHog
    └── plausible.ts            # Plausible

components/analytics/
├── index.ts                    # Component exports
├── analytics-scripts.tsx       # Script loader (consent-aware)
├── page-tracker.tsx            # Auto page tracking
└── user-identifier.tsx         # Auto user identification
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

See [Providers](./providers.md) for provider-specific configuration.

### 2. Track Events

```typescript
'use client';
import { useAnalytics, EVENTS } from '@/lib/analytics';

function LoginForm() {
  const { track, identify } = useAnalytics();

  const onSuccess = async (user: User) => {
    await identify(user.id);
    await track(EVENTS.USER_LOGGED_IN, { method: 'email' });
  };
}
```

See [Events](./events.md) for the full event catalog.

### 3. Auto Page Tracking

```typescript
// In a layout component
'use client';
import { usePageTracking } from '@/lib/analytics';

function DashboardLayout({ children }: { children: React.ReactNode }) {
  usePageTracking(); // Tracks on route changes
  return <>{children}</>;
}
```

## Analytics Components

### UserIdentifier

Automatically identifies authenticated users to the analytics system and tracks the initial page view. Place this in the root layout alongside `AnalyticsProvider`.

**Purpose:**

- Identifies users on page load (including after OAuth or page refresh)
- Ensures the initial page view includes the correct user ID
- Handles pending OAuth login tracking (from `sessionStorage`)

```tsx
// In root layout (app/layout.tsx)
<AnalyticsProvider>
  <Suspense fallback={null}>
    <UserIdentifier />
    <PageTracker skipInitial />
  </Suspense>
  {children}
</AnalyticsProvider>
```

**How it works:**

1. Waits for analytics to be ready and session to finish loading
2. If user is logged in, identifies them via `identify(user.id)`
3. Checks for pending OAuth login in `sessionStorage` and tracks the login event
4. Tracks the initial page view with correct user context
5. Resets identification tracking when user logs out

### PageTracker

A client component that tracks page views on route changes. Use with `skipInitial={true}` when `UserIdentifier` handles the initial page view.

**Props:**

- `properties?: Record<string, string | number | boolean>` - Additional properties for every page view
- `skipInitial?: boolean` - Skip the initial page load (use when `UserIdentifier` handles it)

```tsx
// In root layout
<PageTracker skipInitial properties={{ section: 'dashboard' }} />
```

**Why separate components?**

- `UserIdentifier` handles the initial page load with proper ordering: identify user first, then track page
- `PageTracker` handles subsequent client-side navigation via `usePathname()`
- The root layout never remounts during navigation, so `PageTracker` reliably catches all route changes

## Files Reference

| File                                         | Purpose                  |
| -------------------------------------------- | ------------------------ |
| `lib/analytics/types.ts`                     | TypeScript interfaces    |
| `lib/analytics/config.ts`                    | Environment detection    |
| `lib/analytics/client.ts`                    | Singleton client         |
| `lib/analytics/analytics-provider.tsx`       | React context            |
| `lib/analytics/hooks.ts`                     | React hooks              |
| `lib/analytics/server.ts`                    | Server-side tracking     |
| `lib/analytics/events/constants.ts`          | Event name constants     |
| `lib/analytics/events/types.ts`              | Event property types     |
| `lib/analytics/events/forms.ts`              | Form tracking hook       |
| `lib/analytics/providers/*.ts`               | Provider implementations |
| `components/analytics/analytics-scripts.tsx` | Script loading           |
