// @vitest-environment happy-dom

/**
 * AdminTierGate — the tier check on in-app navigation (§111 t-810)
 *
 * The admin layout decides on a full load; this decides on every navigation
 * after it, because Next.js does not re-render a layout then. An org viewer
 * landing on a page that is not org-tier gets nothing rendered and a replace
 * to the landing route; a platform viewer passes through everywhere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const nav = vi.hoisted(() => ({ pathname: '/admin/overview', replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ replace: nav.replace }),
}));

const roster = vi.hoisted(() => ({ pages: ['/admin/orchestration/agents/[id]'] }));
vi.mock('@/lib/auth/admin-tier', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/admin-tier')>();
  return {
    ...actual,
    adminPageTier: (pathname: string | null | undefined) =>
      actual.adminPageTier(pathname, roster.pages),
  };
});

import { AdminTierGate } from '@/components/admin/admin-tier-gate';
import { AUTH_LANDING_ROUTE } from '@/lib/auth-landing/route';

const page = <div data-testid="page">page</div>;

beforeEach(() => {
  nav.replace.mockClear();
});

describe('AdminTierGate', () => {
  it('renders an org-tier page for an org viewer, and does not navigate', () => {
    nav.pathname = '/admin/orchestration/agents/agent-1';
    render(<AdminTierGate viewerTier="org">{page}</AdminTierGate>);

    expect(screen.getByTestId('page')).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });

  it('renders nothing for an org viewer on a platform page, and sends them to the landing route', () => {
    nav.pathname = '/admin/users';
    render(<AdminTierGate viewerTier="org">{page}</AdminTierGate>);

    expect(screen.queryByTestId('page')).not.toBeInTheDocument();
    expect(nav.replace).toHaveBeenCalledWith(AUTH_LANDING_ROUTE);
  });

  it('passes a platform viewer through on any page', () => {
    nav.pathname = '/admin/users';
    render(<AdminTierGate viewerTier="platform">{page}</AdminTierGate>);

    expect(screen.getByTestId('page')).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });
});
