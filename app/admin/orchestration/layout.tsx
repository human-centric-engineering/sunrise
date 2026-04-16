import type { ReactNode } from 'react';

/**
 * Admin Orchestration layout (Phase 4 Session 4.1)
 *
 * Minimal wrapper. The parent `app/admin/layout.tsx` already enforces the
 * ADMIN role guard and renders the sidebar + chrome, so this layout just
 * passes children through. It exists so future sessions can add an
 * orchestration-specific header, breadcrumbs, or Suspense boundary without
 * touching the outer admin layout.
 */
export default function OrchestrationLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
