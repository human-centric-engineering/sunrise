# React Error Boundaries

**Last Updated**: 2026-02-06
**Related**: [Error Handling Overview](./overview.md)

This document covers React error boundaries for catching and handling component errors gracefully.

## Table of Contents

- [When to Use Error Boundaries](#when-to-use-error-boundaries)
- [Error Boundary Hierarchy](#error-boundary-hierarchy)
- [ErrorBoundary Component](#errorboundary-component)
- [ErrorCard Component](#errorcard-component)
- [Auto-Reset Patterns](#auto-reset-patterns)
- [Custom Fallback UI](#custom-fallback-ui)

## When to Use Error Boundaries

### Use Error Boundaries For

- Isolating component tree failures
- Providing graceful degradation
- Showing user-friendly error UI
- Enabling error recovery without page reload

### Where to Place Boundaries

| Placement                  | Example                                            |
| -------------------------- | -------------------------------------------------- |
| Route-level components     | `app/(protected)/error.tsx`                        |
| Complex feature components | `<ErrorBoundary><Dashboard /></ErrorBoundary>`     |
| Third-party integrations   | `<ErrorBoundary><StripePayment /></ErrorBoundary>` |

### Anti-Patterns

**Don't use error boundaries for**:

| Scenario              | Use Instead                                |
| --------------------- | ------------------------------------------ |
| Event handlers        | `try/catch` in the handler                 |
| Async code            | Global error handler (`handleClientError`) |
| Server-side rendering | Server error handling                      |

## Error Boundary Hierarchy

Next.js uses a hierarchy of error boundaries for different route groups:

```
app/global-error.tsx (Global - catches root layout errors)
    |
    +-- Renders own <html>/<body> tags (replaces root layout)
    +-- Final fallback for unhandled errors
    +-- Logs with ErrorSeverity.Fatal
    |
app/error.tsx (Root - uses ErrorCard component)
    |
    +-- app/admin/error.tsx
    |   +-- Catches: Admin panel errors
    |   +-- Special handling: "Dashboard" button to return to /dashboard
    |
    +-- app/(protected)/error.tsx
    |   +-- Catches: Dashboard, Settings, Profile errors
    |   +-- Special handling: Session expiration -> Redirect to login
    |
    +-- app/(public)/error.tsx
    |   +-- Catches: Landing, About, Contact errors
    |   +-- Special handling: Show "Go home" button
    |
    +-- app/(auth)/error.tsx (optional - not implemented)
        +-- Would catch: Login, Signup, Reset Password errors
        +-- Falls back to app/error.tsx if not present
```

### Nested Boundaries Catch First

```typescript
// Error in dashboard component:
<RootErrorBoundary>          // Will NOT catch (nested boundary catches first)
  <ProtectedErrorBoundary>   // Catches here!
    <DashboardPage />        // Error occurs here
  </ProtectedErrorBoundary>
</RootErrorBoundary>
```

## ErrorBoundary Component

**Location**: `components/error-boundary.tsx`

A reusable error boundary with customizable fallback UI, error callbacks, and auto-reset.

### Basic Usage

```typescript
import { ErrorBoundary } from '@/components/error-boundary';

<ErrorBoundary>
  <ComplexFeature />
</ErrorBoundary>
```

### Props

| Prop                | Type                                       | Description                               |
| ------------------- | ------------------------------------------ | ----------------------------------------- |
| `children`          | `ReactNode`                                | Child components to render                |
| `fallback`          | `ReactNode \| (error, reset) => ReactNode` | Fallback UI or render function            |
| `onError`           | `(error, errorInfo) => void`               | Callback for logging/tracking             |
| `resetKeys`         | `unknown[]`                                | Keys that trigger auto-reset when changed |
| `errorBoundaryName` | `string`                                   | Name for logging identification           |

### Custom Fallback

```typescript
<ErrorBoundary
  fallback={(error, reset) => (
    <div>
      <h2>Feature unavailable</h2>
      <p>{error.message}</p>
      <button onClick={reset}>Retry</button>
    </div>
  )}
>
  <ComplexFeature />
</ErrorBoundary>
```

### With Error Callback

```typescript
<ErrorBoundary
  onError={(error, errorInfo) => {
    analytics.track('component-error', {
      component: errorInfo.componentStack,
    });
  }}
>
  <ComplexFeature />
</ErrorBoundary>
```

### What Error Boundaries Catch

Error boundaries catch errors during:

- Rendering
- Lifecycle methods
- Constructors

Error boundaries do NOT catch errors in:

- Event handlers (use try/catch)
- Async code (use handleClientError)
- Server-side rendering
- Errors thrown in the error boundary itself

## ErrorCard Component

**Location**: `components/ui/error-card.tsx`

A reusable UI component for displaying errors consistently across error boundaries.

### Props

| Prop                 | Type                          | Default             | Description                |
| -------------------- | ----------------------------- | ------------------- | -------------------------- |
| `title`              | `string`                      | (required)          | Card title                 |
| `description`        | `string`                      | (required)          | Card description           |
| `icon`               | `ReactNode`                   | `<AlertTriangle />` | Icon next to title         |
| `iconClassName`      | `string`                      | `"text-red-500"`    | Icon color class           |
| `error`              | `Error & { digest?: string }` | -                   | Error for dev-only details |
| `actions`            | `ErrorCardAction[]`           | -                   | Action buttons             |
| `footer`             | `ReactNode`                   | -                   | Optional footer content    |
| `containerClassName` | `string`                      | `"min-h-[400px]"`   | Container min-height class |

### ErrorCardAction Interface

```typescript
interface ErrorCardAction {
  label: string;
  onClick: () => void;
  variant?: 'default' | 'outline';
  icon?: ReactNode;
}
```

### Basic Usage in Error Boundary

```typescript
// app/error.tsx
'use client';

import { ErrorCard } from '@/components/ui/error-card';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ErrorCard
      title="Something went wrong"
      description="An unexpected error occurred."
      error={error}
      actions={[{ label: 'Try again', onClick: reset }]}
    />
  );
}
```

### With Custom Actions and Footer

```typescript
import { Home } from 'lucide-react';
import { ErrorCard } from '@/components/ui/error-card';

<ErrorCard
  title="Something went wrong"
  description="An unexpected error occurred. This has been logged."
  error={error}
  containerClassName="min-h-screen"
  actions={[
    { label: 'Try again', onClick: reset },
    {
      label: 'Go home',
      onClick: () => (window.location.href = '/'),
      variant: 'outline',
      icon: <Home className="mr-2 h-4 w-4" />,
    },
  ]}
  footer={
    <p className="text-center text-sm text-gray-600">
      If this problem persists, please{' '}
      <a href="/contact" className="underline">contact support</a>.
    </p>
  }
/>
```

### Features

- Consistent styling using shadcn/ui Card components
- Dev-only error details (message and digest shown only in development)
- Flexible action buttons with optional icons
- Customizable container height for full-page or inline usage

## Auto-Reset Patterns

### Reset on Data Change

Use `resetKeys` to automatically reset when data changes:

```typescript
<ErrorBoundary resetKeys={[userId]}>
  <UserProfile userId={userId} />
</ErrorBoundary>
```

When `userId` changes, the error boundary automatically resets and re-renders children.

### Reset on Navigation

For route-level errors, Next.js automatically resets on navigation. For custom boundaries:

```typescript
import { usePathname } from 'next/navigation';

function FeatureWithBoundary() {
  const pathname = usePathname();

  return (
    <ErrorBoundary resetKeys={[pathname]}>
      <Feature />
    </ErrorBoundary>
  );
}
```

## Custom Fallback UI

### Dashboard with Isolated Error

```typescript
import { ErrorBoundary } from '@/components/error-boundary';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

function DashboardPage() {
  return (
    <div>
      <h1>Dashboard</h1>

      <ErrorBoundary
        fallback={(error, reset) => (
          <Card>
            <CardHeader>
              <CardTitle>Stats Unavailable</CardTitle>
              <CardDescription>
                Unable to load statistics. {error.message}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={reset}>Retry</Button>
            </CardContent>
          </Card>
        )}
      >
        <StatisticsWidget />
      </ErrorBoundary>

      {/* UserActivity still renders even if StatisticsWidget fails */}
      <UserActivity />
    </div>
  );
}
```

### Full-Page Error

```typescript
// app/(protected)/error.tsx
'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ErrorCard } from '@/components/ui/error-card';
import { logger } from '@/lib/logging';

export default function ProtectedError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

  useEffect(() => {
    logger.error('Protected route error', error);
  }, [error]);

  return (
    <ErrorCard
      title="Something went wrong"
      description="We encountered an error loading this page."
      error={error}
      containerClassName="min-h-screen"
      actions={[
        { label: 'Try again', onClick: reset },
        {
          label: 'Go to dashboard',
          onClick: () => router.push('/dashboard'),
          variant: 'outline',
        },
      ]}
    />
  );
}
```

## Related Documentation

- **[Error Handling Overview](./overview.md)** - Architecture and flow diagrams
- **[User-Friendly Messages](./user-messages.md)** - Error code to message mapping
- **[Error Classes](./error-classes.md)** - API error classes

## See Also

- `components/error-boundary.tsx` - ErrorBoundary implementation
- `components/ui/error-card.tsx` - ErrorCard implementation
- `app/global-error.tsx` - Global error boundary
- `app/error.tsx` - Root error boundary
- `app/admin/error.tsx` - Admin routes error boundary
