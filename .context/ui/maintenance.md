# Maintenance Mode

## Overview

Sunrise includes a maintenance mode system that allows administrators to temporarily block access to the site during updates, deployments, or scheduled downtime. The system uses feature flags stored in the database and provides automatic admin bypass.

**Key features:**

- Database-driven toggle via `MAINTENANCE_MODE` feature flag
- Automatic bypass for authenticated admin users
- Customizable message and estimated downtime display
- Optional admin notice banner when bypassing maintenance
- Server component implementation (no client-side JavaScript required)

## Components

| Component                           | Purpose                                           | File                                 |
| ----------------------------------- | ------------------------------------------------- | ------------------------------------ |
| `MaintenanceWrapper`                | Blocks non-admin users when maintenance is active | `components/maintenance-wrapper.tsx` |
| `MaintenanceWrapperWithAdminNotice` | Same as above, but shows banner to admins         | `components/maintenance-wrapper.tsx` |
| `MaintenancePage`                   | Displays maintenance message to blocked users     | `components/maintenance-page.tsx`    |

## MaintenanceWrapper

Async server component that wraps layout content and conditionally shows the maintenance page based on the `MAINTENANCE_MODE` feature flag.

```tsx
import { MaintenanceWrapper } from '@/components/maintenance-wrapper';

export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <MaintenanceWrapper>
      <div className="flex min-h-screen flex-col">
        {/* Layout content */}
        {children}
      </div>
    </MaintenanceWrapper>
  );
}
```

**Props:**

| Prop       | Type              | Description                                    |
| ---------- | ----------------- | ---------------------------------------------- |
| `children` | `React.ReactNode` | Content to render when not in maintenance mode |

**Behavior:**

| Scenario                        | Result                              |
| ------------------------------- | ----------------------------------- |
| Maintenance disabled            | Renders children normally           |
| Maintenance enabled, non-admin  | Shows `MaintenancePage`             |
| Maintenance enabled, admin user | Renders children (admin bypass)     |
| Session check fails             | Shows `MaintenancePage` (fail-safe) |

## MaintenanceWrapperWithAdminNotice

Variant that shows admins a warning banner when they bypass maintenance mode. Use this in protected layouts where admins are likely to be working.

```tsx
import { MaintenanceWrapperWithAdminNotice } from '@/components/maintenance-wrapper';

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return (
    <MaintenanceWrapperWithAdminNotice>
      <div className="flex min-h-screen flex-col">
        {/* Layout content */}
        {children}
      </div>
    </MaintenanceWrapperWithAdminNotice>
  );
}
```

**Admin Banner:**

When an admin accesses the site during maintenance, a warning banner appears at the top of the page:

```
Maintenance mode is active. You can access the site because you are an admin.
```

The banner uses amber styling to be noticeable but not alarming.

## MaintenancePage

Displays a centered card with maintenance information. Used internally by the wrapper components but can also be rendered directly.

```tsx
import { MaintenancePage } from '@/components/maintenance-page';

<MaintenancePage
  message="We're upgrading our systems. Back soon!"
  estimatedDowntime="30 minutes"
  isAdmin={false}
/>;
```

**Props:**

| Prop                | Type             | Default                                                  | Description                         |
| ------------------- | ---------------- | -------------------------------------------------------- | ----------------------------------- |
| `message`           | `string`         | `"We are currently performing scheduled maintenance..."` | Custom message to display           |
| `estimatedDowntime` | `string \| null` | `undefined`                                              | Estimated time (e.g., "30 minutes") |
| `isAdmin`           | `boolean`        | `false`                                                  | Shows admin bypass link if `true`   |

**Visual elements:**

- Wrench icon in amber circle
- "Under Maintenance" title
- Custom or default message
- Optional estimated downtime with clock icon
- Optional admin bypass link (when `isAdmin={true}`)

## Configuration

### Enabling Maintenance Mode

Maintenance mode is controlled by the `MAINTENANCE_MODE` feature flag in the database. Toggle it via:

**Admin Dashboard:**

Navigate to Admin > Feature Flags and toggle `MAINTENANCE_MODE`.

**API:**

```bash
# Enable maintenance mode
curl -X PUT /api/v1/admin/feature-flags/MAINTENANCE_MODE \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'

# With custom message
curl -X PUT /api/v1/admin/feature-flags/MAINTENANCE_MODE \
  -H "Content-Type: application/json" \
  -d '{
    "enabled": true,
    "metadata": {
      "message": "Scheduled maintenance in progress.",
      "estimatedDowntime": "2 hours"
    }
  }'
```

**Programmatically:**

```typescript
import { toggleFlag } from '@/lib/feature-flags';

// Enable with metadata
await toggleFlag('MAINTENANCE_MODE', true, {
  message: 'Database migration in progress.',
  estimatedDowntime: '15 minutes',
});

// Disable
await toggleFlag('MAINTENANCE_MODE', false);
```

### Flag Metadata

The `MAINTENANCE_MODE` flag supports these metadata fields:

| Field               | Type     | Description                                  |
| ------------------- | -------- | -------------------------------------------- |
| `message`           | `string` | Custom message shown on maintenance page     |
| `estimatedDowntime` | `string` | Human-readable duration (e.g., "30 minutes") |

## Admin Bypass

Admins are automatically identified and allowed through maintenance mode:

1. The wrapper checks for an active session using `auth.api.getSession()`
2. If the user has `role === 'ADMIN'`, they bypass the maintenance page
3. The check runs server-side on every request (no caching)

**Security considerations:**

- Session check failures default to showing the maintenance page (fail-safe)
- Admin bypass relies on the `role` field in the user's session
- No client-side bypass is possible since the component is server-rendered

## Integration in Layouts

### Current Usage

The maintenance wrappers are integrated in the main route group layouts:

**Public Layout** (`app/(public)/layout.tsx`):

```tsx
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

**Protected Layout** (`app/(protected)/layout.tsx`):

```tsx
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

### Which Wrapper to Use

| Layout Type | Recommended Wrapper                 | Reason                                          |
| ----------- | ----------------------------------- | ----------------------------------------------- |
| Public      | `MaintenanceWrapper`                | No admin notice needed for public visitors      |
| Protected   | `MaintenanceWrapperWithAdminNotice` | Admins should see they're bypassing maintenance |
| Admin       | None (or custom)                    | Admin dashboard should always be accessible     |

### Routes That Skip Maintenance

The admin dashboard (`/admin/*`) typically should not use maintenance wrappers, allowing admins to:

- Toggle maintenance mode off
- Monitor system status
- Manage the application during maintenance

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                    Request Received                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Check MAINTENANCE_MODE Flag                     │
│              (prisma.featureFlag.findUnique)                 │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
       Flag Disabled                    Flag Enabled
              │                               │
              ▼                               ▼
       Render Children          ┌─────────────────────────┐
                                │   Check User Session     │
                                │   (auth.api.getSession)  │
                                └─────────────────────────┘
                                              │
                              ┌───────────────┴───────────────┐
                              │                               │
                              ▼                               ▼
                        User is Admin               User is Not Admin
                              │                               │
                              ▼                               ▼
                    Render Children              Render MaintenancePage
                    (+ optional banner)          (with flag metadata)
```

## Related Documentation

- [Feature Flags](../admin/feature-flags.md) - Flag management and API
- [Layouts](./layouts.md) - Layout patterns and structure
- [Authentication](../auth/integration.md) - Session handling and guards
