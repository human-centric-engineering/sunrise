// @vitest-environment happy-dom

/**
 * AdminTierGate — the tier check on in-app navigation (§111 t-810)
 *
 * The admin layout decides on a full load; this decides on every navigation
 * after it, because Next.js does not re-render a layout then. An org viewer
 * landing on a page that is not org-tier gets nothing rendered and a replace
 * to the landing route; a platform viewer passes through everywhere.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const nav = vi.hoisted(() => ({ pathname: '/admin/overview', replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ replace: nav.replace }),
}));

const roster = vi.hoisted(() => ({
  pages: ['/admin/orchestration/agents/[id]'] as string[] | null,
}));
vi.mock('@/lib/auth/admin-tier', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/admin-tier')>();
  return {
    ...actual,
    // `null` reads the real roster, core's and the fork's below (t-817).
    adminPageTier: (pathname: string | null | undefined) =>
      roster.pages === null
        ? actual.adminPageTier(pathname)
        : actual.adminPageTier(pathname, roster.pages),
  };
});

// The fork's page scaffold, standing in for a filled lib/app/admin-tier.ts.
const fork = vi.hoisted(() => ({ init: (): void => {} }));
vi.mock('@/lib/app/admin-tier', () => ({
  initAppOrgTierAdminPages: () => fork.init(),
}));

import { AdminTierGate } from '@/components/admin/admin-tier-gate';
import {
  registerOrgTierAdminPage,
  __resetAppOrgTierAdminPagesForTests,
} from '@/lib/auth/admin-tier';
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

describe('AdminTierGate on a page the fork lists in lib/app/admin-tier.ts (t-817)', () => {
  // The client realm's half of the proof: the gate's own read runs the fork's
  // init, so a page the fork lists opens on in-app navigation too, with
  // nothing on the server side having run anything in this realm.
  const FORK_PAGE = '/admin/reports';
  let shipped: string[] | null;

  beforeEach(() => {
    shipped = roster.pages;
    roster.pages = null; // the real roster: core's, then the fork's
    __resetAppOrgTierAdminPagesForTests();
    nav.pathname = FORK_PAGE;
  });

  afterEach(() => {
    roster.pages = shipped;
    fork.init = () => {};
    __resetAppOrgTierAdminPagesForTests();
  });

  it('renders it for an org viewer', () => {
    fork.init = () => registerOrgTierAdminPage(FORK_PAGE);
    render(<AdminTierGate viewerTier="org">{page}</AdminTierGate>);

    expect(screen.getByTestId('page')).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });

  it('sends an org viewer away with nothing registered, as it ships', () => {
    render(<AdminTierGate viewerTier="org">{page}</AdminTierGate>);

    expect(screen.queryByTestId('page')).not.toBeInTheDocument();
    expect(nav.replace).toHaveBeenCalledWith(AUTH_LANDING_ROUTE);
  });

  it('sends an org viewer away when the fork’s init throws after listing it', () => {
    fork.init = () => {
      registerOrgTierAdminPage(FORK_PAGE);
      throw new Error('fork init failed');
    };
    render(<AdminTierGate viewerTier="org">{page}</AdminTierGate>);

    expect(screen.queryByTestId('page')).not.toBeInTheDocument();
    expect(nav.replace).toHaveBeenCalledWith(AUTH_LANDING_ROUTE);
  });
});
