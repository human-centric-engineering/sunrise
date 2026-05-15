import type { ReactNode } from 'react';

import { InFlightExecutionBanner } from '@/components/admin/orchestration/in-flight-execution-banner';

/**
 * Admin Orchestration layout (Phase 4 Session 4.1)
 *
 * Hosts the InFlightExecutionBanner so a backgrounded orchestration run
 * keeps a peek pill at the top of every page within
 * `/admin/orchestration/*` — the operator can navigate freely while a
 * long-running audit / workflow is in flight without losing visibility.
 *
 * The outer `app/admin/layout.tsx` already enforces ADMIN role and
 * renders sidebar / chrome; this layout just adds the orchestration-
 * specific banner above whatever the page renders.
 */
export default function OrchestrationLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <InFlightExecutionBanner />
      {children}
    </>
  );
}
