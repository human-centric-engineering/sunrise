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
  Bot,
  Wrench,
  Server,
  GitBranch,
  BookOpen,
  DollarSign,
  GraduationCap,
  ClipboardCheck,
  Plug,
  BarChart3,
  Webhook,
  Settings,
  Hammer,
  Activity,
  ClipboardList,
  ShieldCheck,
  PlayCircle,
  MessagesSquare,
  UserCog,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { API } from '@/lib/api/endpoints';
import { executionCountsResponseSchema } from '@/lib/validations/orchestration';
import { useCallback, useEffect, useMemo, useState } from 'react';

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
  exact?: boolean;
  badge?: number;
}

interface NavSubgroup {
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  items: NavItem[];
}

interface NavSection {
  title: string;
  items?: NavItem[];
  subgroups?: NavSubgroup[];
}

const navSections: NavSection[] = [
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
    title: 'AI Orchestration',
    subgroups: [
      {
        label: '',
        items: [
          {
            href: '/admin/orchestration',
            label: 'Dashboard',
            icon: Bot,
            description: 'Overview and setup',
            exact: true,
          },
        ],
      },
      {
        label: 'Build',
        icon: Hammer,
        items: [
          {
            href: '/admin/orchestration/agents',
            label: 'Agents',
            icon: Users,
            description: 'Manage AI agents',
          },
          {
            href: '/admin/orchestration/agent-profiles',
            label: 'Agent Profiles',
            icon: UserCog,
            description: 'Shared persona / voice / guardrails',
          },
          {
            href: '/admin/orchestration/capabilities',
            label: 'Capabilities',
            icon: Wrench,
            description: 'Tool definitions',
          },
          {
            href: '/admin/orchestration/providers',
            label: 'Providers',
            icon: Server,
            description: 'LLM providers',
          },
          {
            href: '/admin/orchestration/workflows',
            label: 'Workflows',
            icon: GitBranch,
            description: 'Multi-step flows',
          },
          {
            href: '/admin/orchestration/mcp',
            label: 'MCP Server',
            icon: Plug,
            description: 'External tool access',
          },
        ],
      },
      {
        label: 'Operate',
        icon: Activity,
        items: [
          {
            href: '/admin/orchestration/knowledge',
            label: 'Knowledge Base',
            icon: BookOpen,
            description: 'Docs and patterns',
          },
          {
            href: '/admin/orchestration/executions',
            label: 'Executions',
            icon: PlayCircle,
            description: 'Live engine state and runtime history',
          },
          {
            href: '/admin/orchestration/conversations',
            label: 'Conversations',
            icon: MessagesSquare,
            description: 'Chat history + audit',
          },
          {
            href: '/admin/orchestration/approvals',
            label: 'Approval Queue',
            icon: ShieldCheck,
            description: 'Pending approvals',
          },
          {
            href: '/admin/orchestration/triggers',
            label: 'Inbound Triggers',
            icon: Webhook,
            description: 'Webhook URLs that fire workflows',
          },
          {
            href: '/admin/orchestration/event-subscriptions',
            label: 'Event Subscriptions',
            icon: Webhook,
            description: 'Outbound webhook notifications',
          },
          {
            href: '/admin/orchestration/evaluations',
            label: 'Testing',
            icon: ClipboardCheck,
            description: 'Evaluations & experiments',
          },
          {
            href: '/admin/orchestration/analytics',
            label: 'Analytics',
            icon: BarChart3,
            description: 'Usage and insights',
          },
          {
            href: '/admin/orchestration/costs',
            label: 'Costs & Budget',
            icon: DollarSign,
            description: 'Spend and alerts',
          },
          {
            href: '/admin/orchestration/audit-log',
            label: 'Audit Log',
            icon: ClipboardList,
            description: 'Admin action history',
          },
        ],
      },
      {
        label: '',
        items: [
          {
            href: '/admin/orchestration/learn',
            label: 'Learning',
            icon: GraduationCap,
            description: 'Pattern explorer',
          },
          {
            href: '/admin/orchestration/settings',
            label: 'Settings',
            icon: Settings,
            description: 'Global defaults',
          },
        ],
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

function isItemActive(item: NavItem, pathname: string): boolean {
  return item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function NavItemList({
  items,
  pathname,
  collapsed,
  nested,
}: {
  items: NavItem[];
  pathname: string;
  collapsed: boolean;
  nested?: boolean;
}) {
  return (
    <ul
      className={cn('space-y-0.5', nested && !collapsed && 'border-border/40 ml-3 border-l pl-1')}
    >
      {items.map((item) => {
        const active = isItemActive(item, pathname);
        const Icon = item.icon;

        return (
          <li key={item.href}>
            <Link
              href={item.href}
              className={cn(
                'flex items-center rounded-md transition-colors',
                nested ? 'gap-2.5 px-2 py-1.5 text-[13px]' : 'gap-3 px-2 py-2 text-sm font-medium',
                active
                  ? nested
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                collapsed && 'justify-center'
              )}
              title={collapsed ? item.label : undefined}
              aria-current={active ? 'page' : undefined}
            >
              <Icon className={cn('shrink-0', nested ? 'h-4 w-4' : 'h-5 w-5')} />
              {!collapsed && <span className="flex-1">{item.label}</span>}
              {!collapsed && item.badge != null && item.badge > 0 && (
                <span className="ml-auto rounded-full bg-orange-500 px-1.5 py-0.5 text-[10px] leading-none font-medium text-white">
                  {item.badge}
                </span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function CollapsibleSubgroup({
  group,
  pathname,
  collapsed: sidebarCollapsed,
}: {
  group: NavSubgroup;
  pathname: string;
  collapsed: boolean;
}) {
  const hasActiveChild = useMemo(
    () => group.items.some((item) => isItemActive(item, pathname)),
    [group.items, pathname]
  );

  const hasBadge = useMemo(
    () => group.items.some((item) => item.badge != null && item.badge > 0),
    [group.items]
  );

  const [manualOpen, setManualOpen] = useState(hasActiveChild);

  // Open if user toggled it open, has an active child, or has a badge
  const open = manualOpen || hasBadge;

  const toggle = useCallback(() => setManualOpen((prev) => !prev), []);

  const GroupIcon = group.icon;

  // When sidebar is collapsed, show group icon as a toggle
  if (sidebarCollapsed) {
    return (
      <div className="mt-1">
        {GroupIcon && (
          <button
            type="button"
            onClick={toggle}
            className={cn(
              'mx-auto flex h-9 w-9 items-center justify-center rounded-md transition-colors',
              hasActiveChild
                ? 'text-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            )}
            title={group.label}
          >
            <GroupIcon className="h-5 w-5" />
          </button>
        )}
        {open && <NavItemList items={group.items} pathname={pathname} collapsed nested />}
      </div>
    );
  }

  return (
    <li className="mt-1">
      <button
        type="button"
        onClick={toggle}
        className={cn(
          'flex w-full items-center gap-3 rounded-md px-2 py-2 text-sm font-medium transition-colors',
          hasActiveChild
            ? 'text-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
        )}
      >
        {GroupIcon && <GroupIcon className="h-5 w-5 shrink-0" />}
        <span className="flex-1 text-left">{group.label}</span>
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 opacity-40 transition-transform duration-200',
            open && 'rotate-90'
          )}
        />
      </button>
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-200',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        )}
      >
        <div className="overflow-hidden">
          <div className="mt-0.5">
            <NavItemList items={group.items} pathname={pathname} collapsed={false} nested />
          </div>
        </div>
      </div>
    </li>
  );
}

interface AdminSidebarProps {
  className?: string;
}

const EXECUTION_BADGE_POLL_MS = 15_000;

/**
 * Polls the counts aggregate endpoint once per tick and returns the raw
 * per-status map. Callers sum the keys they care about — keeps the hook
 * generic and lets the badge mapping live at the call site.
 *
 * Note: `pathname` is intentionally NOT a dep. The interval and the
 * visibilitychange listener already cover refresh; refetching on every
 * admin nav click amplified the request burst that motivated this hook.
 */
function useExecutionCounts(statuses: readonly string[]): Record<string, number> | undefined {
  const [counts, setCounts] = useState<Record<string, number> | undefined>();
  const key = statuses.join(',');

  useEffect(() => {
    let cancelled = false;
    let controller: AbortController | null = null;

    const fetchCounts = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      try {
        const res = await fetch(`${API.ADMIN.ORCHESTRATION.EXECUTION_COUNTS}?statuses=${key}`, {
          credentials: 'same-origin',
          signal,
        });
        if (!res.ok) return;
        const envelope: unknown = await res.json();
        const data =
          envelope && typeof envelope === 'object' ? (envelope as { data?: unknown }).data : null;
        const parsed = executionCountsResponseSchema.safeParse(data);
        if (!parsed.success) return;
        if (!cancelled && !signal.aborted) setCounts(parsed.data.counts);
      } catch {
        // ignored — aborts and transient failures should not blank the badge
      }
    };

    void fetchCounts();
    const intervalId = setInterval(() => void fetchCounts(), EXECUTION_BADGE_POLL_MS);

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void fetchCounts();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      controller?.abort();
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [key]);

  return counts;
}

function sumCounts(
  counts: Record<string, number> | undefined,
  statuses: readonly string[]
): number | undefined {
  if (!counts) return undefined;
  return statuses.reduce((acc, status) => acc + (counts[status] ?? 0), 0);
}

const APPROVAL_STATUSES = ['paused_for_approval'] as const;
const IN_PROGRESS_STATUSES = ['pending', 'running'] as const;
const BADGE_STATUSES = [...APPROVAL_STATUSES, ...IN_PROGRESS_STATUSES] as const;

function injectBadges(
  sections: NavSection[],
  badges: Record<string, number | undefined>
): NavSection[] {
  return sections.map((section) => {
    if (!section.subgroups) return section;
    return {
      ...section,
      subgroups: section.subgroups.map((group) => ({
        ...group,
        items: group.items.map((item) => {
          const badge = badges[item.href];
          return badge != null ? { ...item, badge } : item;
        }),
      })),
    };
  });
}

export function AdminSidebar({ className }: AdminSidebarProps) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const counts = useExecutionCounts(BADGE_STATUSES);
  const approvalCount = sumCounts(counts, APPROVAL_STATUSES);
  const inProgressCount = sumCounts(counts, IN_PROGRESS_STATUSES);
  const sections = useMemo(
    () =>
      injectBadges(navSections, {
        '/admin/orchestration/approvals': approvalCount,
        '/admin/orchestration/executions': inProgressCount,
      }),
    [approvalCount, inProgressCount]
  );

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
          {sections.map((section) => (
            <div key={section.title}>
              {!collapsed && (
                <h3 className="text-muted-foreground mb-2 px-2 text-xs font-semibold tracking-wider uppercase">
                  {section.title}
                </h3>
              )}
              {section.items && (
                <NavItemList items={section.items} pathname={pathname} collapsed={collapsed} />
              )}
              {section.subgroups && (
                <ul className="space-y-0.5">
                  {section.subgroups.map((group) =>
                    group.label ? (
                      <CollapsibleSubgroup
                        key={group.label}
                        group={group}
                        pathname={pathname}
                        collapsed={collapsed}
                      />
                    ) : (
                      group.items.map((item) => {
                        const active = isItemActive(item, pathname);
                        const Icon = item.icon;
                        return (
                          <li key={item.href}>
                            <Link
                              href={item.href}
                              className={cn(
                                'flex items-center gap-3 rounded-md px-2 py-2 text-sm font-medium transition-colors',
                                active
                                  ? 'bg-primary text-primary-foreground'
                                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                                collapsed && 'justify-center'
                              )}
                              title={collapsed ? item.label : undefined}
                              aria-current={active ? 'page' : undefined}
                            >
                              <Icon className="h-5 w-5 shrink-0" />
                              {!collapsed && <span>{item.label}</span>}
                            </Link>
                          </li>
                        );
                      })
                    )
                  )}
                </ul>
              )}
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
