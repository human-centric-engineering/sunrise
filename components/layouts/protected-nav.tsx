'use client';

/**
 * Protected Navigation Component
 *
 * Navigation links for protected routes.
 * Highlights the current page.
 * Shows admin link only to admin users.
 *
 * The link list itself is a seam: a fork sets `protectedNavItems` in
 * `lib/app/protected-nav.ts` to replace `DEFAULT_PROTECTED_NAV` wholesale. This
 * component keeps owning the resolution — active state, admin filtering — and
 * `HeaderNav` the rendering (`next/link`, small-screen menu, a11y), so a fork's
 * own items inherit all of it.
 *
 * Phase 3.2: User Management
 * Phase 4.4: Admin Dashboard link
 *
 * @see lib/app/protected-nav.ts · lib/protected-nav/types.ts
 */

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { HeaderNav, type HeaderNavItem } from '@/components/layouts/header-nav';
import { useSession } from '@/lib/auth/client';
import { protectedNavItems } from '@/lib/app/protected-nav';
import { DEFAULT_PROTECTED_NAV } from '@/lib/protected-nav/types';
import { isPlatformAdmin } from '@/lib/auth/roles';
import { defaultNavLabelKey } from '@/components/layouts/default-nav-label';

// Fork override (a non-null array) replaces the platform default wholesale.
const navItems = protectedNavItems ?? DEFAULT_PROTECTED_NAV;
// Only the platform's own labels come from the catalogue; a fork's are its text.
const isDefaultNav = protectedNavItems == null;

export function ProtectedNav() {
  const pathname = usePathname();
  const t = useTranslations('layout.nav');
  const { data: session } = useSession();

  const isAdmin = isPlatformAdmin(session?.user);

  const labelFor = (href: string, label: string): string => {
    const key = isDefaultNav ? defaultNavLabelKey(href) : null;
    return key ? t(key) : label;
  };

  const items: HeaderNavItem[] = navItems
    .filter((item) => !item.adminOnly || isAdmin)
    .map((item) => ({
      href: item.href,
      label: labelFor(item.href, item.label),
      icon: item.icon,
      // Exact items match only on equality; everything else prefix-matches so
      // `/settings/billing` still highlights "Settings". A fork sets `exact` to
      // keep a parent link like `/projects` from highlighting on `/projects/123`.
      isActive: item.exact
        ? pathname === item.href
        : pathname === item.href || pathname.startsWith(`${item.href}/`),
    }));

  return <HeaderNav items={items} />;
}
