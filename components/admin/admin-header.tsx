'use client';

/**
 * Admin Header Component (Phase 4.4)
 *
 * Header for admin pages with breadcrumb navigation and user info.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Building2, ChevronRight, Home } from 'lucide-react';
import { HeaderActions } from '@/components/layouts/header-actions';
import { AUTH_LANDING_LABEL, AUTH_LANDING_ROUTE } from '@/lib/auth-landing/route';
import { adminPageTier } from '@/lib/auth/admin-tier';

interface AdminHeaderProps {
  title?: string;
  description?: string;
  /**
   * The org the admin is acting in, named at `multi` only (§111 t-813):
   * everything on an org-tier page is that org's. Shown on org-tier pages
   * only, because a platform page (Users, Organisations) is install-wide and
   * naming an org there would read as a filter it does not apply.
   */
  orgName?: string;
  /** Every org-tier page pattern, core's and the fork's, as the layout read them. */
  orgTierPages: readonly string[];
}

// Map route segments to display names
const segmentLabels: Record<string, string> = {
  admin: 'Admin',
  overview: 'Overview',
  users: 'Users',
  logs: 'Logs',
  features: 'Feature Flags',
  members: 'Members',
};

export function AdminHeader({ title, description, orgName, orgTierPages }: AdminHeaderProps) {
  const pathname = usePathname();

  // Generate breadcrumbs from pathname
  const segments = pathname.split('/').filter(Boolean);
  const breadcrumbs = segments.map((segment, index) => {
    const href = '/' + segments.slice(0, index + 1).join('/');
    const label = segmentLabels[segment] || segment;
    const isLast = index === segments.length - 1;

    return { href, label, isLast };
  });

  const actingOrgName = adminPageTier(pathname, orgTierPages) === 'org' ? orgName : undefined;

  // Use the last segment as the title if not provided
  const pageTitle = title || segmentLabels[segments[segments.length - 1]] || 'Admin';

  return (
    <header className="bg-background border-b">
      <div className="flex items-center justify-between px-6 py-4">
        <div className="space-y-1">
          {/* Breadcrumbs */}
          <nav className="text-muted-foreground flex items-center gap-1 text-sm">
            <Link
              href={AUTH_LANDING_ROUTE}
              className="hover:text-foreground transition-colors"
              aria-label={AUTH_LANDING_LABEL}
            >
              <Home className="h-4 w-4" />
            </Link>
            {breadcrumbs.map((crumb) => (
              <span key={crumb.href} className="flex items-center gap-1">
                <ChevronRight className="h-4 w-4" />
                {crumb.isLast ? (
                  <span className="text-foreground font-medium">{crumb.label}</span>
                ) : (
                  <Link href={crumb.href} className="hover:text-foreground transition-colors">
                    {crumb.label}
                  </Link>
                )}
              </span>
            ))}
          </nav>

          {/* Page title */}
          <h1 className="text-2xl font-bold tracking-tight">{pageTitle}</h1>
          {description && <p className="text-muted-foreground text-sm">{description}</p>}
        </div>

        {/* User actions, and at `multi` the org being acted in */}
        {actingOrgName ? (
          <div className="flex items-center gap-4">
            <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
              <Building2 className="h-4 w-4" aria-hidden="true" />
              <span>
                Acting in <span className="text-foreground font-medium">{actingOrgName}</span>
              </span>
            </p>
            <HeaderActions />
          </div>
        ) : (
          <HeaderActions />
        )}
      </div>
    </header>
  );
}
