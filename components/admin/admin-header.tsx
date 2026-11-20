'use client';

/**
 * Admin Header Component (Phase 4.4)
 *
 * Header for admin pages with breadcrumb navigation and user info.
 *
 * Breadcrumb labels: a page names a record-id segment with `<BreadcrumbLabel>`
 * (`components/admin/breadcrumb-context.tsx`); a fork names its own segments
 * in `lib/app/admin-breadcrumbs.ts`. See that file for the resolution order.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Building2, ChevronRight, Home } from 'lucide-react';
import { HeaderActions } from '@/components/layouts/header-actions';
import { useBreadcrumbLabels } from '@/components/admin/breadcrumb-context';
import { appSegmentLabels } from '@/lib/app/admin-breadcrumbs';
import { authLandingLabel, AUTH_LANDING_ROUTE } from '@/lib/auth-landing/route';
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

/**
 * The segments of the org-settings pages and the console root, named from the
 * catalogue (§138 t-1074), by their key in `admin.nav` / `admin.shell`. Staff
 * and orchestration segments keep the English below (owner ruling, §138
 * planning).
 */
const catalogueSegments: Readonly<
  Record<string, 'members' | 'orgOptions' | 'providerKeys' | 'supportAccess' | 'waitlist'>
> = {
  members: 'members',
  'org-options': 'orgOptions',
  'provider-keys': 'providerKeys',
  'support-access': 'supportAccess',
  waitlist: 'waitlist',
};

// Sunrise's names for its own segments. A fork names its segments (or renames
// these) in `lib/app/admin-breadcrumbs.ts`; anything unnamed is title-cased.
const segmentLabels: Record<string, string> = {
  admin: 'Admin',
  overview: 'Overview',
  users: 'Users',
  logs: 'Logs',
  features: 'Feature Flags',
  members: 'Members',
  // Named as the sidebar names them, where title-casing would get them wrong.
  orgs: 'Organisations',
  'provider-keys': 'AI keys',
  orchestration: 'AI Orchestration',
  mcp: 'MCP Server',
  dlq: 'Dead Letter Queue',
};

/**
 * The map's own entry for a segment. Own keys only: the segment comes from the
 * URL, and `/admin/constructor` must not read `Object.prototype.constructor`.
 */
function ownLabel(map: Readonly<Record<string, string>>, segment: string): string | undefined {
  return Object.hasOwn(map, segment) ? map[segment] : undefined;
}

/**
 * `some-new-section` → `Some New Section`. The last resort for an unnamed
 * segment. A segment with a digit in it is left as typed: it is almost always
 * a record id (a cuid always has one), and `Cmwf0pagx…` reads worse than the
 * id itself. A page names its id with `<BreadcrumbLabel>` instead.
 */
function humanizeSegment(segment: string): string {
  if (/\d/.test(segment)) return segment;
  return segment
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function AdminHeader({ title, description, orgName, orgTierPages }: AdminHeaderProps) {
  const t = useTranslations('admin.shell');
  const tNav = useTranslations('admin.nav');
  const tLayout = useTranslations('layout.nav');
  const pathname = usePathname();
  // Pages register readable names for their dynamic id segments here.
  const labelOverrides = useBreadcrumbLabels();

  /** Core's name for a segment the catalogue names, in the viewer's language. */
  const catalogueLabel = (segment: string): string | undefined => {
    if (segment === 'admin') return t('admin');
    return Object.hasOwn(catalogueSegments, segment) ? tNav(catalogueSegments[segment]) : undefined;
  };

  /** A known name for the segment: registered by the page, the fork's, or core's. */
  const knownLabel = (segment: string): string | undefined =>
    ownLabel(labelOverrides, segment) ??
    ownLabel(appSegmentLabels, segment) ??
    catalogueLabel(segment) ??
    ownLabel(segmentLabels, segment);

  // Generate breadcrumbs from pathname
  const segments = pathname.split('/').filter(Boolean);
  const breadcrumbs = segments.map((segment, index) => {
    const href = '/' + segments.slice(0, index + 1).join('/');
    const label = knownLabel(segment) ?? humanizeSegment(segment);
    const isLast = index === segments.length - 1;

    return { href, label, isLast };
  });

  const actingOrgName = adminPageTier(pathname, orgTierPages) === 'org' ? orgName : undefined;

  // Use the last segment as the title if not provided. Only a known label: a
  // title-cased record id is worse than a generic heading.
  const lastSegment = segments[segments.length - 1] ?? '';
  const pageTitle = title || knownLabel(lastSegment) || t('admin');

  return (
    <header className="bg-background border-b">
      <div className="flex items-center justify-between px-6 py-4">
        <div className="space-y-1">
          {/* Breadcrumbs */}
          <nav className="text-muted-foreground flex items-center gap-1 text-sm">
            <Link
              href={AUTH_LANDING_ROUTE}
              className="hover:text-foreground transition-colors"
              aria-label={authLandingLabel(tLayout('dashboard'))}
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

        {/* Right cluster: an empty slot a page can portal into by its id
            (`#admin-header-slot`, e.g. a section's brand mark or actions), the
            org being acted in at `multi`, then the shared user actions. */}
        <div className="flex items-center gap-3">
          <div id="admin-header-slot" className="flex items-center" />
          {actingOrgName && (
            <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
              <Building2 className="h-4 w-4" aria-hidden="true" />
              <span>
                {t.rich('actingIn', {
                  org: actingOrgName,
                  strong: (chunks) => <span className="text-foreground font-medium">{chunks}</span>,
                })}
              </span>
            </p>
          )}
          <HeaderActions />
        </div>
      </div>
    </header>
  );
}
