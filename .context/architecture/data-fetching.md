# Data Fetching in Server Components

## The Rule

- **Server components** must query Prisma or call shared helper functions directly.
- **Client components** use API routes via `fetch()` for search, pagination, and mutations.
- **`serverFetch()`** is only for calling _external_ APIs from server components.

## Why

Self-referential HTTP calls (`serverFetch()` hitting `localhost:3000/api/...`) create a new async context disconnected from the original browser request. During concurrent SSR (e.g. rapid navigation between pages), `cookies()` and `headers()` from `next/headers` can read from the wrong or stale request context. This causes intermittent auth failures (401) and pages rendering with empty data.

## Pattern

**Before (broken under concurrent navigation):**

```ts
// Server component calling its own API route
async function getAgents() {
  const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.AGENTS}?page=1&limit=25`);
  const body = await parseApiResponse<AiAgent[]>(res);
  return body.success ? body.data : [];
}
```

**After (direct query, no HTTP round-trip):**

```ts
// Server component querying Prisma directly
import { prisma } from '@/lib/db/client';

const [agents, total] = await Promise.all([
  prisma.aiAgent.findMany({ orderBy: { createdAt: 'desc' }, take: 25 }),
  prisma.aiAgent.count(),
]);
```

## When `serverFetch()` Is Appropriate

- Calling external third-party APIs from server components where you need cookie/auth forwarding
- It should never be used to call routes hosted by this same application
