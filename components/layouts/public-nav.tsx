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
import { Home, Info, Mail } from 'lucide-react';

const navItems = [
  {
    href: '/',
    label: 'Home',
    icon: Home,
    exact: true,
  },
  {
    href: '/about',
    label: 'About',
    icon: Info,
  },
  {
    href: '/contact',
    label: 'Contact',
    icon: Mail,
  },
];

export function PublicNav() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1">
      {navItems.map((item) => {
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
            <Icon className="h-4 w-4" />
            <span className="hidden sm:inline">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
