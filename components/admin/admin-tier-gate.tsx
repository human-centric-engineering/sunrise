'use client';

/**
 * Admin tier gate — the page-level tier check on in-app navigation (§111 t-810)
 *
 * The admin layout decides, on a full load, whether this viewer may open the
 * page: a platform admin any page, an org admin only one listed in
 * `ORG_TIER_ADMIN_PAGES`. Next.js does not re-render a layout on in-app
 * navigation, so without this an org admin following a link from an org-tier
 * page to a platform page would get that page's shell, with every API call
 * on it refused.
 *
 * So this re-derives the answer from the pathname on every navigation, the
 * way `<SurfaceSync>` re-derives the surface, and sends a viewer who may not
 * open the page to the landing route — rendering nothing meanwhile, not the
 * page. It is the reader's refusal, not the security boundary: the API routes
 * the page calls each ask the policy themselves.
 *
 * A platform viewer passes straight through, so the console of every platform
 * admin is what it was before this existed.
 */

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';

import { adminPageTier, viewerReaches, type AdminViewerTier } from '@/lib/auth/admin-tier';
import { AUTH_LANDING_ROUTE } from '@/lib/auth-landing/route';

export interface AdminTierGateProps {
  /** Who the layout worked out this viewer is to the console. */
  viewerTier: AdminViewerTier;
  children: React.ReactNode;
}

export function AdminTierGate({ viewerTier, children }: AdminTierGateProps) {
  const pathname = usePathname();
  const router = useRouter();
  const allowed = viewerReaches(viewerTier, adminPageTier(pathname));

  useEffect(() => {
    if (!allowed) router.replace(AUTH_LANDING_ROUTE);
  }, [allowed, router]);

  return allowed ? <>{children}</> : null;
}
