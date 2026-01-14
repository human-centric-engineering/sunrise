---
name: page-builder
version: 1.0.0
description: |
  Expert page builder for Sunrise. Creates new pages following route group patterns
  with proper layouts, metadata, error boundaries, and authentication handling.
  Use when creating new pages or route groups.

triggers:
  - 'create a new page'
  - 'add page for'
  - 'build the settings page'
  - 'create protected page'
  - 'add public page'
  - 'create new route group'

contexts:
  - 'app/**/page.tsx'
  - 'app/**/layout.tsx'
  - 'app/**/error.tsx'
  - '.context/architecture/overview.md'

mcp_integrations:
  next_devtools: true
  context7:
    libraries:
      - { nextjs: '/vercel/next.js' }

parameters:
  route_groups:
    - '(auth)' # Authentication pages (login, signup, reset)
    - '(protected)' # Authenticated routes (dashboard, settings)
    - '(public)' # Public pages (landing, about, pricing)
---

# Page Builder Skill - Overview

## Mission

You are a page builder for the Sunrise project. Your role is to create new pages following the established **Next.js 16 App Router** patterns including route groups, layouts, metadata, and authentication handling.

**CRITICAL:** Pages in Sunrise are organized into route groups. Always determine the correct group before creating a page.

## Route Group Architecture

### Existing Route Groups

| Group         | Purpose                       | Layout                  | Auth Required |
| ------------- | ----------------------------- | ----------------------- | ------------- |
| `(auth)`      | Login, signup, password reset | Centered card, minimal  | No            |
| `(protected)` | Dashboard, settings, profile  | Header + main container | Yes           |
| `(public)`    | Landing, about, pricing       | Marketing layout        | No            |

### Decision Tree

```
Need a new page?
│
├─ Is it an authentication flow? (login, signup, verify)
│  └─ YES → app/(auth)/[name]/page.tsx
│
├─ Does it require user to be logged in?
│  └─ YES → app/(protected)/[name]/page.tsx
│
├─ Is it a public marketing page?
│  └─ YES → app/(public)/[name]/page.tsx
│
└─ Needs completely different layout?
   └─ YES → Create new route group: app/([name])/layout.tsx
```

## 4-Step Workflow

### Step 1: Analyze Requirements

**Questions to answer:**

1. What is the page purpose?
2. Which route group does it belong to?
3. Does it need authentication?
4. Does it need a new layout or the existing one?
5. Will it contain forms that use `useSearchParams()`?
6. What metadata (title, description) should it have?

### Step 2: Create Page File

**File location:** `app/([group])/[name]/page.tsx`

**Server Component (default):**

```typescript
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Page Title',
  description: 'Page description for SEO',
};

export default function PageName() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Page Title</h1>
      {/* Page content */}
    </div>
  );
}
```

**Protected Page (with auth check):**

```typescript
import type { Metadata } from 'next';
import { getServerSession } from '@/lib/auth/utils';
import { clearInvalidSession } from '@/lib/auth/clear-session';

export const metadata: Metadata = {
  title: 'Page Title - Sunrise',
  description: 'Page description',
};

export default async function PageName() {
  const session = await getServerSession();

  if (!session) {
    clearInvalidSession('/page-path');
  }

  const { user } = session;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Welcome, {user.name}</h1>
      {/* Page content */}
    </div>
  );
}
```

**Page with Form (needs Suspense):**

```typescript
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { YourForm } from '@/components/forms/your-form';

export const metadata: Metadata = {
  title: 'Page Title',
  description: 'Page description',
};

export default function PageName() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Form Title</CardTitle>
      </CardHeader>
      <CardContent>
        <Suspense fallback={<div>Loading...</div>}>
          <YourForm />
        </Suspense>
      </CardContent>
    </Card>
  );
}
```

### Step 3: Create Layout (if needed)

**Only create if page needs different layout from existing route group.**

**Layout Template:**

```typescript
import type { Metadata, ReactNode } from 'next';

export const metadata: Metadata = {
  title: {
    template: '%s - Sunrise',
    default: 'Section Name - Sunrise',
  },
  description: 'Section description',
};

export default function SectionLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <div className="min-h-screen">
      {/* Layout structure */}
      <main>{children}</main>
    </div>
  );
}
```

### Step 4: Add Error Boundary (if new route group)

**File:** `app/([group])/error.tsx`

```typescript
'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Home, RefreshCw } from 'lucide-react';
import { logger } from '@/lib/logging';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logger.error('Page error', error, { digest: error.digest });
  }, [error]);

  return (
    <div className="flex min-h-[400px] flex-col items-center justify-center space-y-4">
      <AlertTriangle className="h-12 w-12 text-destructive" />
      <h2 className="text-xl font-semibold">Something went wrong</h2>
      {process.env.NODE_ENV === 'development' && (
        <p className="text-muted-foreground max-w-md text-center text-sm">
          {error.message}
        </p>
      )}
      <div className="flex gap-2">
        <Button onClick={reset} variant="outline">
          <RefreshCw className="mr-2 h-4 w-4" />
          Try again
        </Button>
        <Button asChild>
          <a href="/">
            <Home className="mr-2 h-4 w-4" />
            Go home
          </a>
        </Button>
      </div>
    </div>
  );
}
```

## Page Type Templates

### Protected Page (Dashboard Style)

```typescript
// app/(protected)/settings/page.tsx
import type { Metadata } from 'next';
import { getServerSession } from '@/lib/auth/utils';
import { clearInvalidSession } from '@/lib/auth/clear-session';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';

export const metadata: Metadata = {
  title: 'Settings - Sunrise',
  description: 'Manage your account settings',
};

export default async function SettingsPage() {
  const session = await getServerSession();

  if (!session) {
    clearInvalidSession('/settings');
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground">Manage your account preferences</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Account Settings</CardTitle>
          <CardDescription>Update your account information</CardDescription>
        </CardHeader>
        <CardContent>
          {/* Settings form or content */}
        </CardContent>
      </Card>
    </div>
  );
}
```

### Auth Page (Login/Signup Style)

```typescript
// app/(auth)/forgot-password/page.tsx
import type { Metadata } from 'next';
import { Suspense } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { ForgotPasswordForm } from '@/components/forms/forgot-password-form';

export const metadata: Metadata = {
  title: 'Forgot Password',
  description: 'Reset your password',
};

export default function ForgotPasswordPage() {
  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl">Forgot Password</CardTitle>
        <CardDescription>
          Enter your email and we&apos;ll send you a reset link
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Suspense fallback={<div>Loading...</div>}>
          <ForgotPasswordForm />
        </Suspense>
        <p className="text-muted-foreground text-center text-sm">
          Remember your password?{' '}
          <Link href="/login" className="text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
```

### Public Page (Marketing Style)

```typescript
// app/(public)/pricing/page.tsx
import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Check } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Pricing - Sunrise',
  description: 'Choose the plan that works for you',
};

export default function PricingPage() {
  return (
    <div className="container mx-auto px-4 py-16">
      <div className="mb-12 text-center">
        <h1 className="text-4xl font-bold">Simple, Transparent Pricing</h1>
        <p className="text-muted-foreground mt-4 text-xl">
          Choose the plan that works for you
        </p>
      </div>

      <div className="grid gap-8 md:grid-cols-3">
        {/* Pricing cards */}
      </div>
    </div>
  );
}
```

## Common Imports Reference

```typescript
// Metadata
import type { Metadata } from 'next';

// Navigation
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

// React
import { Suspense } from 'react';

// Authentication
import { getServerSession } from '@/lib/auth/utils';
import { clearInvalidSession } from '@/lib/auth/clear-session';

// UI Components
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';

// Icons
import { AlertTriangle, Home, RefreshCw, Check, ArrowRight } from 'lucide-react';

// Logging
import { logger } from '@/lib/logging';
```

## Verification Checklist

- [ ] Page created in correct route group
- [ ] Metadata export with title and description
- [ ] Server component (async) for protected pages
- [ ] Suspense boundary for forms using `useSearchParams()`
- [ ] Auth check with `getServerSession()` for protected pages
- [ ] Error boundary for new route groups
- [ ] Consistent spacing (`space-y-6`, `gap-4`)
- [ ] Mobile-responsive layout
- [ ] Links to related pages where appropriate

## Usage Examples

**Protected settings page:**

```
User: "Create a settings page for user preferences"
Assistant: [Creates app/(protected)/settings/page.tsx with auth check]
```

**Public about page:**

```
User: "Add an about page to the marketing section"
Assistant: [Creates app/(public)/about/page.tsx with marketing layout]
```

**New admin section:**

```
User: "Create an admin dashboard with different layout"
Assistant: [Creates app/(admin)/layout.tsx, error.tsx, and dashboard/page.tsx]
```
