# System Stats Dashboard

## Overview

The stats dashboard (`/admin/overview`) provides administrators with a real-time overview of user metrics and system health. It combines statistics cards with the status page component to present a comprehensive view of the application state.

## Statistics Display

The `StatsCards` component displays four key metrics:

| Card            | Metric                | Description                |
| --------------- | --------------------- | -------------------------- |
| Total Users     | `users.total`         | All registered users       |
| Verified Users  | `users.verified`      | Users with verified emails |
| New Users (24h) | `users.recentSignups` | Signups in last 24 hours   |
| Admin Users     | `users.byRole.ADMIN`  | Users with admin role      |

## System Information

The `SystemInfo` card (`components/admin/system-info.tsx`) renders the version
pair an operator needs when triaging: the fork's app version beside the Sunrise
platform release it's built on, plus Node version and environment.

| Row                | Field                   | Source                                   |
| ------------------ | ----------------------- | ---------------------------------------- |
| `{BRAND.name} app` | `system.appVersion`     | `lib/app-version.ts` (fork-owned)        |
| `Sunrise platform` | `system.sunriseVersion` | `lib/sunrise-version.ts` (Sunrise-owned) |
| `Node`             | `system.nodeVersion`    | `process.version`                        |
| `Environment`      | `system.environment`    | `NODE_ENV`                               |

**This route is the operator-facing surface for the Sunrise version.** It used to be on the unauthenticated
`/api/health` payload, where any anonymous caller could read which upstream
release — and therefore which published issues — a deployment was running, while
the operator who needed it had no way to see it from the product. #531 inverted
that. See [`VERSIONING.md`](../../VERSIONING.md) and
[`.context/api/utility-endpoints.md`](../api/utility-endpoints.md).

Two other routes also return `SUNRISE_VERSION`, and both are authenticated —
`GET`/`PATCH /api/v1/admin/orchestration/mcp/settings` as `serverVersion` (admin
session), and the `POST /api/v1/mcp` `initialize` handshake as
`serverInfo.version` (bearer API key; 401 without one). The property that
matters when adding another is that **no unauthenticated surface carries it**,
not that this one is unique.

Two details that are easy to get wrong when adapting this card:

- **The platform row is labelled "Sunrise platform", not "Sunrise".** Upstream,
  `BRAND.name` _is_ `"Sunrise"` and `APP_VERSION` equals `SUNRISE_VERSION`, so a
  bare label renders the same word over the same number twice. Only a rebranded
  fork would notice.
- **A `null` stats payload renders an explicit "unavailable" message**, not an
  empty card. The overview page's `getStats()` returns `null` on any fetch
  failure, and a broken stats API must not look like a healthy deployment on the
  page an operator opens _because_ something is wrong.

It is a server component: the overview page already awaits the stats it needs, so
the card adds no client bundle, no second fetch and no hydration.

## Component

### StatsCards

**Location**: `components/admin/stats-cards.tsx`

**Props**:

```typescript
interface StatsCardsProps {
  stats: SystemStats | null;
  isLoading?: boolean;
}
```

Features:

- **Loading skeletons**: Animated placeholders while data loads
- **Responsive grid**: 1 column on mobile, 2 on tablet, 4 on desktop
- **Calculated percentages**: Shows verification rate and role breakdown

```typescript
// Verification percentage calculation
const verificationRate = Math.round((stats.users.verified / (stats.users.total || 1)) * 100);
```

### StatCard (Internal)

Individual card component:

```typescript
interface StatCardProps {
  title: string;
  value: number | string;
  description: string;
  icon: React.ReactNode;
}
```

## System Status Integration

The overview page also includes the `StatusPage` component for real-time service monitoring:

```typescript
<StatusPage
  title="System Status"
  description="Real-time status of all services"
  pollingInterval={30000}  // 30 second refresh
  showMemory={true}
/>
```

## Data Types

### SystemStats

```typescript
interface SystemStats {
  users: {
    total: number; // Total user count
    verified: number; // Verified email count
    recentSignups: number; // Last 24 hours
    byRole: {
      USER: number;
      ADMIN: number;
    };
  };
  system: {
    nodeVersion: string; // e.g., "v24.9.0"
    appVersion: string; // The fork's app version, from package.json
    sunriseVersion: string; // The Sunrise platform release (lib/sunrise-version.ts)
    environment: string; // "development" | "production"
    uptime: number; // Seconds since start
    databaseStatus: 'connected' | 'disconnected' | 'error';
  };
}
```

## API Endpoint

### GET /api/v1/admin/stats

Returns system statistics for the admin dashboard.

**Authentication**: Required (Admin role only)

**Response**:

```json
{
  "success": true,
  "data": {
    "users": {
      "total": 150,
      "verified": 120,
      "recentSignups": 5,
      "byRole": {
        "USER": 145,
        "ADMIN": 5
      }
    },
    "system": {
      "nodeVersion": "v24.9.0",
      "appVersion": "1.0.0",
      "sunriseVersion": "0.9.0",
      "environment": "production",
      "uptime": 86400,
      "databaseStatus": "connected"
    }
  }
}
```

### Implementation Details

Statistics are gathered efficiently using parallel database queries:

```typescript
const [totalUsers, verifiedUsers, recentSignups, usersByRole, dbHealth] = await Promise.all([
  prisma.user.count(),
  prisma.user.count({ where: { emailVerified: true } }),
  prisma.user.count({ where: { createdAt: { gte: twentyFourHoursAgo } } }),
  prisma.user.groupBy({ by: ['role'], _count: { role: true } }),
  getDatabaseHealth(),
]);
```

**Performance**: All queries execute in parallel, minimizing response time.

**Uptime Tracking**: Uses module-level constant to track process start time:

```typescript
const PROCESS_START_TIME = Date.now();
// ...
uptime: Math.floor((Date.now() - PROCESS_START_TIME) / 1000);
```

## Page Layout

```mermaid
graph TD
    A[Admin Overview Page] --> B[Stats Cards Section]
    A --> C[System Status Section]
    B --> D[Total Users Card]
    B --> E[Verified Users Card]
    B --> F[New Users Card]
    B --> G[Admin Users Card]
    C --> H[StatusPage Component]
    H --> I[Service Health Checks]
    H --> J[Memory Usage]
```

## Server-Side Data Fetching

The page uses the `serverFetch` utility for authenticated server-side requests:

```typescript
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { API } from '@/lib/api/endpoints';

async function getStats(): Promise<SystemStats | null> {
  try {
    const res = await serverFetch(API.ADMIN.STATS);
    if (!res.ok) return null;
    const data = await parseApiResponse<SystemStats>(res);
    return data.success ? data.data : null;
  } catch {
    return null;
  }
}
```

**Note**: `serverFetch` handles cookie forwarding internally, so you don't need to manually extract and forward cookies from the cookie store.

## Error Handling

Graceful degradation when stats unavailable:

- Returns `null` on fetch failure
- `StatsCards` renders loading skeletons when `stats` is `null`
- No error thrown to user - dashboard remains functional

## Related Documentation

- [Overview](./overview.md) - Admin dashboard architecture
- [Health Checks](../monitoring/health-checks.md) - StatusPage component
- [Monitoring Overview](../monitoring/overview.md) - System monitoring
- [API Endpoints](../api/endpoints.md) - Full API reference
