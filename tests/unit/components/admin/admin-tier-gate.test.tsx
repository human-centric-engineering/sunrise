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

// The fork's page scaffold. The gate must never run it: it judges by the list
// the layout handed down (t-817), so the browser builds no list of its own.
const fork = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('@/lib/app/admin-tier', () => ({
  initAppOrgTierAdminPages: fork.init,
}));

import { AdminTierGate } from '@/components/admin/admin-tier-gate';
import { AUTH_LANDING_ROUTE } from '@/lib/auth-landing/route';

const PAGES = ['/admin/orchestration/agents/[id]'];
const page = <div data-testid="page">page</div>;

beforeEach(() => {
  nav.replace.mockClear();
  fork.init.mockClear();
});

describe('AdminTierGate', () => {
  it('renders an org-tier page for an org viewer, and does not navigate', () => {
    nav.pathname = '/admin/orchestration/agents/agent-1';
    render(
      <AdminTierGate viewerTier="org" orgTierPages={PAGES}>
        {page}
      </AdminTierGate>
    );

    expect(screen.getByTestId('page')).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });

  it('renders nothing for an org viewer on a platform page, and sends them to the landing route', () => {
    nav.pathname = '/admin/users';
    render(
      <AdminTierGate viewerTier="org" orgTierPages={PAGES}>
        {page}
      </AdminTierGate>
    );

    expect(screen.queryByTestId('page')).not.toBeInTheDocument();
    expect(nav.replace).toHaveBeenCalledWith(AUTH_LANDING_ROUTE);
  });

  it('passes a platform viewer through on any page', () => {
    nav.pathname = '/admin/users';
    render(
      <AdminTierGate viewerTier="platform" orgTierPages={PAGES}>
        {page}
      </AdminTierGate>
    );

    expect(screen.getByTestId('page')).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });
});

describe('AdminTierGate on a page the fork lists in lib/app/admin-tier.ts (t-817)', () => {
  // The layout reads the whole list on the server, the fork's pages included,
  // and hands it here; that half is proved in tests/unit/app/admin/layout.test.tsx.
  const FORK_PAGE = '/admin/reports';

  beforeEach(() => {
    nav.pathname = FORK_PAGE;
  });

  it('renders it for an org viewer when the list it is handed has it, without running the fork’s init', () => {
    render(
      <AdminTierGate viewerTier="org" orgTierPages={[...PAGES, FORK_PAGE]}>
        {page}
      </AdminTierGate>
    );

    expect(screen.getByTestId('page')).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    expect(fork.init).not.toHaveBeenCalled(); // test-review:accept no_arg_called — the browser must build no list of its own;
  });

  it('sends an org viewer away when the list it is handed does not have it — the layout’s list, not one built here', () => {
    render(
      <AdminTierGate viewerTier="org" orgTierPages={PAGES}>
        {page}
      </AdminTierGate>
    );

    expect(screen.queryByTestId('page')).not.toBeInTheDocument();
    expect(nav.replace).toHaveBeenCalledWith(AUTH_LANDING_ROUTE);
    expect(fork.init).not.toHaveBeenCalled(); // test-review:accept no_arg_called — the browser must build no list of its own;
  });
});
