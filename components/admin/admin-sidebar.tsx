'use client';

/**
 * Admin Sidebar Component (Phase 4.4)
 *
 * Sidebar navigation for the admin dashboard.
 * Highlights the current page and provides quick access to all admin sections.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  Users,
  FileText,
  ToggleRight,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useState } from 'react';

const navSections = [
  {
    title: 'Overview',
    items: [
      {
        href: '/admin/overview',
        label: 'Dashboard',
        icon: LayoutDashboard,
        description: 'System status and stats',
      },
    ],
  },
  {
    title: 'Management',
    items: [
      {
        href: '/admin/users',
        label: 'Users',
        icon: Users,
        description: 'Manage user accounts',
      },
      {
        href: '/admin/features',
        label: 'Feature Flags',
        icon: ToggleRight,
        description: 'Toggle features',
      },
    ],
  },
  {
    title: 'System',
    items: [
      {
        href: '/admin/logs',
        label: 'Logs',
        icon: FileText,
        description: 'View application logs',
      },
    ],
  },
];

interface AdminSidebarProps {
  className?: string;
}

export function AdminSidebar({ className }: AdminSidebarProps) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={cn(
        'bg-muted/30 border-r transition-all duration-300',
        collapsed ? 'w-16' : 'w-64',
        className
      )}
    >
      <div className="flex h-full flex-col">
        {/* Header */}
        <div className="flex h-16 items-center justify-between border-b px-4">
          {!collapsed && (
            <Link href="/admin" className="text-lg font-semibold">
              Admin
            </Link>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCollapsed(!collapsed)}
            className={cn('h-8 w-8', collapsed && 'mx-auto')}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </Button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-6 overflow-y-auto p-4">
          {navSections.map((section) => (
            <div key={section.title}>
              {!collapsed && (
                <h3 className="text-muted-foreground mb-2 px-2 text-xs font-semibold tracking-wider uppercase">
                  {section.title}
                </h3>
              )}
              <ul className="space-y-1">
                {section.items.map((item) => {
                  const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
                  const Icon = item.icon;

                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className={cn(
                          'flex items-center gap-3 rounded-md px-2 py-2 text-sm font-medium transition-colors',
                          isActive
                            ? 'bg-primary text-primary-foreground'
                            : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                          collapsed && 'justify-center'
                        )}
                        title={collapsed ? item.label : undefined}
                        aria-current={isActive ? 'page' : undefined}
                      >
                        <Icon className="h-5 w-5 shrink-0" />
                        {!collapsed && <span>{item.label}</span>}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="border-t p-4">
          <Link
            href="/dashboard"
            className={cn(
              'text-muted-foreground hover:text-foreground flex items-center gap-2 text-sm transition-colors',
              collapsed && 'justify-center'
            )}
          >
            <ChevronLeft className="h-4 w-4" />
            {!collapsed && <span>Back to Dashboard</span>}
          </Link>
        </div>
      </div>
    </aside>
  );
}
