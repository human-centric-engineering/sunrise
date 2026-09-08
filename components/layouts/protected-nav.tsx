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
 * component keeps owning the rendering — `next/link`, active state, admin
 * filtering, a11y — so a fork's own items inherit all of it.
 *
 * Phase 3.2: User Management
 * Phase 4.4: Admin Dashboard link
 *
 * @see lib/app/protected-nav.ts · lib/protected-nav/types.ts
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useSession } from '@/lib/auth/client';
import { protectedNavItems } from '@/lib/app/protected-nav';
import { DEFAULT_PROTECTED_NAV } from '@/lib/protected-nav/types';
import { isPlatformAdmin } from '@/lib/auth/roles';

// Fork override (a non-null array) replaces the platform default wholesale.
const navItems = protectedNavItems ?? DEFAULT_PROTECTED_NAV;

export function ProtectedNav() {
  const pathname = usePathname();
  const { data: session } = useSession();

  const isAdmin = isPlatformAdmin(session?.user);

  return (
    <nav className="flex items-center gap-1">
      {navItems
        .filter((item) => !item.adminOnly || isAdmin)
        .map((item) => {
          // Exact items match only on equality; everything else prefix-matches
          // so `/settings/billing` still highlights "Settings". A fork sets
          // `exact` to keep a parent link like `/projects` from highlighting on
          // `/projects/123`.
          const isActive = item.exact
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
