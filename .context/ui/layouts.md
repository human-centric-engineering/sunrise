# Layout Components

## Overview

Sunrise uses a composable layout system built around the `AppHeader` component, with specialized navigation components for different route contexts. This architecture provides consistent branding and user actions while allowing navigation to vary by route group.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        AppHeader                            │
│  ┌──────────┐    ┌────────────────┐    ┌────────────────┐   │
│  │   Logo   │    │   Navigation   │    │ HeaderActions  │   │
│  │  (Link)  │    │  (pluggable)   │    │ (Theme+User)   │   │
│  └──────────┘    └────────────────┘    └────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                           │
           ┌───────────────┼───────────────┐
           │               │               │
      PublicNav      ProtectedNav      (none)
     (public pages)  (dashboard)     (auth pages)
```

## Component Reference

| Component         | File                                      | Purpose                          |
| ----------------- | ----------------------------------------- | -------------------------------- |
| `AppHeader`       | `components/layouts/app-header.tsx`       | Shared header with pluggable nav |
| `HeaderActions`   | `components/layouts/header-actions.tsx`   | Theme toggle and user button     |
| `PublicNav`       | `components/layouts/public-nav.tsx`       | Navigation for public pages      |
| `ProtectedNav`    | `components/layouts/protected-nav.tsx`    | Navigation for protected pages   |
| `PublicFooter`    | `components/layouts/public-footer.tsx`    | Footer for public pages          |
| `ProtectedFooter` | `components/layouts/protected-footer.tsx` | Footer for protected pages       |

## AppHeader

Shared header component that provides consistent branding and user actions across layouts. Navigation is pluggable via the `navigation` prop.

**File:** `components/layouts/app-header.tsx`

**Server Component:** Yes (default)

### Props

| Prop         | Type              | Default     | Description                     |
| ------------ | ----------------- | ----------- | ------------------------------- |
| `logoHref`   | `string`          | `"/"`       | URL for logo click              |
| `logoText`   | `string`          | `"Sunrise"` | Text displayed as logo          |
| `navigation` | `React.ReactNode` | `undefined` | Navigation component to display |

### Usage

```tsx
import { AppHeader } from '@/components/layouts/app-header';
import { PublicNav } from '@/components/layouts/public-nav';

// With navigation
<AppHeader logoHref="/" navigation={<PublicNav />} />

// Without navigation (auth pages)
<AppHeader logoHref="/" />

// Custom logo destination
<AppHeader logoHref="/dashboard" navigation={<ProtectedNav />} />
```

### Structure

The header uses a flex layout with:

- **Left section:** Logo link + optional navigation (gap-8 between them)
- **Right section:** HeaderActions (theme toggle + user button)

```tsx
<header className="border-b">
  <div className="container mx-auto flex items-center justify-between px-4 py-4">
    <div className="flex items-center gap-8">
      <Link href={logoHref}>{logoText}</Link>
      {navigation}
    </div>
    <HeaderActions />
  </div>
</header>
```

## HeaderActions

Container for header action buttons. Always renders theme toggle and user button.

**File:** `components/layouts/header-actions.tsx`

**Client Component:** Yes (`'use client'`)

### Props

None. This component has no configurable props.

### Usage

```tsx
import { HeaderActions } from '@/components/layouts/header-actions';

// Used internally by AppHeader
<HeaderActions />;
```

### Contains

- `ThemeToggle` - Dark/light mode switcher
- `UserButton` - Sign in/out button with user menu

## PublicNav

Navigation component for public pages. Shows links to Home, About, and Contact with active state highlighting.

**File:** `components/layouts/public-nav.tsx`

**Client Component:** Yes (`'use client'` - uses `usePathname`)

### Props

None. Navigation items are hardcoded.

### Navigation Items

| Link       | Icon | Matching Logic                      |
| ---------- | ---- | ----------------------------------- |
| `/`        | Home | Exact match only (`exact: true`)    |
| `/about`   | Info | Matches `/about` and `/about/*`     |
| `/contact` | Mail | Matches `/contact` and `/contact/*` |

### Features

- **Active state highlighting:** Uses `bg-accent text-accent-foreground` for current page
- **Responsive:** Labels hidden on small screens, icons always visible
- **Accessibility:** Sets `aria-current="page"` on active links

### Usage

```tsx
import { AppHeader } from '@/components/layouts/app-header';
import { PublicNav } from '@/components/layouts/public-nav';

<AppHeader logoHref="/" navigation={<PublicNav />} />;
```

## ProtectedNav

Navigation component for protected (authenticated) pages. Shows links to Dashboard, Profile, Settings, and conditionally Admin.

**File:** `components/layouts/protected-nav.tsx`

**Client Component:** Yes (`'use client'` - uses `usePathname` and `useSession`)

### Props

None. Navigation items are hardcoded.

### Navigation Items

| Link         | Icon            | Visibility |
| ------------ | --------------- | ---------- |
| `/dashboard` | LayoutDashboard | All users  |
| `/profile`   | User            | All users  |
| `/settings`  | Settings        | All users  |
| `/admin`     | Shield          | Admin only |

### Features

- **Role-based visibility:** Admin link only shown to users with `role === 'ADMIN'`
- **Active state highlighting:** Uses `bg-accent text-accent-foreground` for current page
- **Prefix matching:** Active state for nested routes (e.g., `/settings/security`)
- **Responsive:** Labels hidden on small screens, icons always visible
- **Accessibility:** Sets `aria-current="page"` on active links

### Usage

```tsx
import { AppHeader } from '@/components/layouts/app-header';
import { ProtectedNav } from '@/components/layouts/protected-nav';

<AppHeader logoHref="/dashboard" navigation={<ProtectedNav />} />;
```

## Route Group Layout Patterns

Sunrise uses Next.js route groups to organize pages with different layout needs. Each route group has its own layout file that composes the appropriate header, navigation, and footer.

### Route Group Overview

| Route Group   | Path               | Layout           | Navigation   |
| ------------- | ------------------ | ---------------- | ------------ |
| `(public)`    | `app/(public)/`    | Header + Footer  | PublicNav    |
| `(protected)` | `app/(protected)/` | Header + Footer  | ProtectedNav |
| `(auth)`      | `app/(auth)/`      | Minimal centered | None         |
| `admin/`      | `app/admin/`       | Sidebar + Header | AdminSidebar |

### Public Layout

For marketing and informational pages (landing, about, contact).

**File:** `app/(public)/layout.tsx`

```tsx
import { AppHeader } from '@/components/layouts/app-header';
import { PublicNav } from '@/components/layouts/public-nav';
import { PublicFooter } from '@/components/layouts/public-footer';
import { MaintenanceWrapper } from '@/components/maintenance-wrapper';

export default function PublicLayout({ children }) {
  return (
    <MaintenanceWrapper>
      <div className="flex min-h-screen flex-col bg-background">
        <AppHeader logoHref="/" navigation={<PublicNav />} />
        <main className="flex-1">{children}</main>
        <PublicFooter />
      </div>
    </MaintenanceWrapper>
  );
}
```

**Features:**

- Full-width main content (no container padding)
- MaintenanceWrapper blocks access during maintenance mode
- Logo links to home (`/`)

### Protected Layout

For authenticated user pages (dashboard, profile, settings).

**File:** `app/(protected)/layout.tsx`

```tsx
import { AppHeader } from '@/components/layouts/app-header';
import { ProtectedNav } from '@/components/layouts/protected-nav';
import { ProtectedFooter } from '@/components/layouts/protected-footer';
import { MaintenanceWrapperWithAdminNotice } from '@/components/maintenance-wrapper';

export default function ProtectedLayout({ children }) {
  return (
    <MaintenanceWrapperWithAdminNotice>
      <div className="flex min-h-screen flex-col bg-background">
        <AppHeader logoHref="/dashboard" navigation={<ProtectedNav />} />
        <main className="container mx-auto flex-1 px-4 py-8">{children}</main>
        <ProtectedFooter />
      </div>
    </MaintenanceWrapperWithAdminNotice>
  );
}
```

**Features:**

- Contained main content with padding
- MaintenanceWrapperWithAdminNotice shows banner to admins during maintenance
- Logo links to dashboard (`/dashboard`)
- Authentication enforced by middleware (redirects to `/login`)

### Auth Layout

For authentication pages (login, signup, forgot password).

**File:** `app/(auth)/layout.tsx`

```tsx
import { ThemeToggle } from '@/components/theme-toggle';

export default function AuthLayout({ children }) {
  return (
    <div className="min-h-screen bg-background">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-md">{children}</div>
      </div>
    </div>
  );
}
```

**Features:**

- Minimal layout with no header/footer
- Centered content area (max-width 448px)
- Theme toggle in top-right corner
- Clean, distraction-free authentication experience

### Admin Layout

For admin dashboard pages (users, settings, feature flags).

**File:** `app/admin/layout.tsx`

```tsx
import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/auth/utils';
import { AdminSidebar } from '@/components/admin/admin-sidebar';
import { AdminHeader } from '@/components/admin/admin-header';

export default async function AdminLayout({ children }) {
  const session = await getServerSession();

  if (!session) redirect('/login');
  if (session.user.role !== 'ADMIN') redirect('/dashboard');

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <AdminSidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <AdminHeader />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
```

**Features:**

- Server-side role check (requires ADMIN)
- Fixed sidebar navigation
- Separate AdminHeader (not AppHeader)
- Full-height layout with scroll in main area
- Not a route group (creates `/admin/*` URLs)

## Adding a New Layout

When adding a new route group with a different layout:

1. **Create the route group folder:** `app/(group-name)/`
2. **Create the layout:** `app/(group-name)/layout.tsx`
3. **Choose or create navigation:** Reuse existing nav or create new in `components/layouts/`
4. **Compose with AppHeader:** Pass navigation as prop

```tsx
// app/(custom)/layout.tsx
import { AppHeader } from '@/components/layouts/app-header';
import { CustomNav } from '@/components/layouts/custom-nav';

export default function CustomLayout({ children }) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader logoHref="/custom-home" navigation={<CustomNav />} />
      <main className="flex-1">{children}</main>
    </div>
  );
}
```

## Related Documentation

- [Architecture Overview](../architecture/overview.md) - Route groups and app structure
- [Authentication Integration](../auth/integration.md) - Protecting routes
- [Marketing Components](./marketing.md) - Components for public pages
