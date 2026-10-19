'use client';

/**
 * HeaderNav Component
 *
 * Shared renderer for the header navs (`PublicNav`, `ProtectedNav`). Each nav
 * resolves its own items — seam override, `exact`, admin filtering, active
 * state — and hands them here, so both get the same small-screen behaviour.
 *
 * From `md` up the items render as inline links; below it they fold into a
 * dropdown menu. Labels are always rendered, never hidden by breakpoint: an
 * icon is decoration (`aria-hidden`), so a hidden label leaves a link with no
 * accessible name, and an item without an icon would render as an empty box.
 *
 * The menu lives inside the nav rather than in a second `AppHeader` slot, so a
 * caller that passes `navigation` keeps its nav on every screen size (#862).
 */

import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { Menu } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface HeaderNavItem {
  href: string;
  label: string;
  icon?: LucideIcon;
  isActive: boolean;
}

interface HeaderNavProps {
  items: HeaderNavItem[];
}

export function HeaderNav({ items }: HeaderNavProps) {
  // No links, no nav: a menu button that opens an empty menu is a control with
  // nothing behind it (e.g. a fork whose items are all admin-only).
  if (items.length === 0) return null;

  return (
    <nav className="flex items-center">
      <div className="hidden items-center gap-1 md:flex">
        {items.map((item) => {
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                item.isActive
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
              )}
              aria-current={item.isActive ? 'page' : undefined}
            >
              {Icon && <Icon className="h-4 w-4" />}
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>
      <div className="md:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-9 w-9">
              <Menu className="h-5 w-5" />
              <span className="sr-only">Open navigation menu</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            {items.map((item) => {
              const Icon = item.icon;

              return (
                <DropdownMenuItem key={item.href} asChild>
                  <Link
                    href={item.href}
                    className={cn('cursor-pointer', item.isActive && 'bg-accent')}
                    aria-current={item.isActive ? 'page' : undefined}
                  >
                    {Icon && <Icon className="mr-2 h-4 w-4" />}
                    {item.label}
                  </Link>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </nav>
  );
}
