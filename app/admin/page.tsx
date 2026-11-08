import { redirect } from 'next/navigation';

import { requestAdminReach } from '@/lib/auth/admin-page-viewer';
import { PLATFORM_ADMIN_LANDING, orgAdminLanding } from '@/lib/auth/admin-landing';

/**
 * Admin Index Page (Phase 4.4)
 *
 * Redirects to the console's landing page: the overview for a platform admin,
 * and for an org admin the orchestration dashboard (§111 t-812), or the page
 * the fork names in `lib/app/admin-landing.ts` (t-928). The overview is
 * install-wide — every user and the process itself — so it is the platform's,
 * and its routes refuse an org admin. Someone who holds a fork's named tiers
 * and is not an org admin goes to the landing their first tier names (t-999);
 * the layout lets them in here only when there is one.
 */
export default async function AdminIndexPage() {
  const reach = await requestAdminReach();
  if (reach === 'platform') redirect(PLATFORM_ADMIN_LANDING);
  if (!reach.tiers.includes('org') && reach.landing !== null) redirect(reach.landing);
  redirect(orgAdminLanding());
}
