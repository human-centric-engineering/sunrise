import { redirect } from 'next/navigation';

import { adminPageViewerTier } from '@/lib/auth/admin-page-viewer';

/**
 * Admin Index Page (Phase 4.4)
 *
 * Redirects to the console's landing page: the overview for a platform admin,
 * and for an org admin the orchestration dashboard (§111 t-812). The overview
 * is install-wide — every user and the process itself — so it is the
 * platform's, and its routes refuse an org admin.
 */
export default async function AdminIndexPage() {
  const viewerTier = await adminPageViewerTier();
  redirect(viewerTier === 'platform' ? '/admin/overview' : '/admin/orchestration');
}
