'use client';

/**
 * Public Navigation Component
 *
 * Navigation links for public pages.
 * Highlights the current page.
 *
 * Phase 3.5: Landing Page & Marketing
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { publicNavItems } from '@/lib/app/public-nav';
import { DEFAULT_PUBLIC_NAV } from '@/lib/public-nav/types';

// Fork override (a non-null array) replaces the platform default wholesale.
const navItems = publicNavItems ?? DEFAULT_PUBLIC_NAV;

export function PublicNav() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1">
      {navItems.map((item) => {
        // Exact items (and the root `/`, which every path is a prefix of) match
        // only on equality; everything else prefix-matches so `/about/team`
        // highlights "About". A fork sets `exact` to keep a parent link like
        // `/docs` from highlighting on `/docs/intro`.
        const isActive =
          item.exact || item.href === '/'
            ? pathname === item.href
            : pathname === item.href || pathname.startsWith(`${item.href}/`);
        const Icon = item.icon;

        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            )}
            aria-current={isActive ? 'page' : undefined}
          >
            {Icon && <Icon className="h-4 w-4" />}
            <span className="hidden sm:inline">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
