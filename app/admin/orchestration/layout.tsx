import type { ReactNode } from 'react';

/**
 * Admin Orchestration layout (Phase 4 Session 4.1)
 *
 * Minimal wrapper. The parent `app/admin/layout.tsx` already enforces the
 * ADMIN role guard and renders the sidebar + chrome, so this layout just
 * passes children through. It exists so future sessions can add an
 * orchestration-specific header, breadcrumbs, or Suspense boundary without
 * touching the outer admin layout.
 *
 * `force-dynamic` disables the Next.js Full Route Cache for all
 * orchestration pages. These pages fetch live data from the database
 * via `serverFetch()` — caching the rendered HTML causes stale empty
 * tables on client-side navigation.
 */
export const dynamic = 'force-dynamic';

export default function OrchestrationLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
