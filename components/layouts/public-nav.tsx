'use client';

/**
 * Public Navigation Component
 *
 * Navigation links for public pages.
 * Highlights the current page.
 *
 * Phase 3.5: Landing Page & Marketing
 */

import { usePathname } from 'next/navigation';
import { HeaderNav, type HeaderNavItem } from '@/components/layouts/header-nav';
import { publicNavItems } from '@/lib/app/public-nav';
import { DEFAULT_PUBLIC_NAV } from '@/lib/public-nav/types';

// Fork override (a non-null array) replaces the platform default wholesale.
const navItems = publicNavItems ?? DEFAULT_PUBLIC_NAV;

export function PublicNav() {
  const pathname = usePathname();

  const items: HeaderNavItem[] = navItems.map((item) => ({
    href: item.href,
    label: item.label,
    icon: item.icon,
    // Exact items (and the root `/`, which every path is a prefix of) match
    // only on equality; everything else prefix-matches so `/about/team`
    // highlights "About". A fork sets `exact` to keep a parent link like
    // `/docs` from highlighting on `/docs/intro`.
    isActive:
      item.exact || item.href === '/'
        ? pathname === item.href
        : pathname === item.href || pathname.startsWith(`${item.href}/`),
  }));

  return <HeaderNav items={items} />;
}
