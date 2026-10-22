import { redirect } from 'next/navigation';

import { adminPageViewerTier } from '@/lib/auth/admin-page-viewer';
import { PLATFORM_ADMIN_LANDING, orgAdminLanding } from '@/lib/auth/admin-landing';

/**
 * Admin Index Page (Phase 4.4)
 *
 * Redirects to the console's landing page: the overview for a platform admin,
 * and for an org admin the orchestration dashboard (§111 t-812), or the page
 * the fork names in `lib/app/admin-landing.ts` (t-928). The overview is
 * install-wide — every user and the process itself — so it is the platform's,
 * and its routes refuse an org admin.
 */
export default async function AdminIndexPage() {
  const viewerTier = await adminPageViewerTier();
  redirect(viewerTier === 'platform' ? PLATFORM_ADMIN_LANDING : orgAdminLanding());
}
