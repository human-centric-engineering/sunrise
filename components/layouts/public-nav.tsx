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
import { useTranslations } from 'next-intl';
import { HeaderNav, type HeaderNavItem } from '@/components/layouts/header-nav';
import { publicNavItems } from '@/lib/app/public-nav';
import { DEFAULT_PUBLIC_NAV } from '@/lib/public-nav/types';
import { defaultNavLabelKey } from '@/components/layouts/default-nav-label';

// Fork override (a non-null array) replaces the platform default wholesale.
const navItems = publicNavItems ?? DEFAULT_PUBLIC_NAV;
// Only the platform's own labels come from the catalogue; a fork's are its text.
const isDefaultNav = publicNavItems == null;

export function PublicNav() {
  const pathname = usePathname();
  const t = useTranslations('layout.nav');

  const labelFor = (href: string, label: string): string => {
    const key = isDefaultNav ? defaultNavLabelKey(href) : null;
    return key ? t(key) : label;
  };

  const items: HeaderNavItem[] = navItems.map((item) => ({
    href: item.href,
    label: labelFor(item.href, item.label),
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
