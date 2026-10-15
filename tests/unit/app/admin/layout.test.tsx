// @vitest-environment happy-dom

/**
 * Admin Layout Auth Boundary Tests
 *
 * `app/admin/layout.tsx` is the single auth gate for every route under
 * `app/admin/**`. Testing it once here covers the auth boundary for all
 * admin RSC pages — see `.context/testing/decisions.md` ("Admin RSC pages")
 * for why the pages themselves are not unit-tested.
 *
 * Branches covered:
 * - No session → redirect('/login')
 * - Authenticated non-admin → redirect(AUTH_LANDING_ROUTE)
 * - Authenticated admin → renders children
 * - Shared settings read-only outside the install org at `multi` (§107
 *   t-753) — the layout reads it once and every page below asks its provider
 * - A registered app authorization policy decides instead — the third
 *   chokepoint. The three tests above run on Sunrise's default policy and are
 *   unchanged by the seam landing, which is the behaviour-neutrality evidence
 *   for the admin tree; the two below prove the seam is not decoration.
 * - Admin tiers (§111 t-810): an org OWNER/ADMIN at `multi` opens a page
 *   listed as org-tier and no other, with the page taken from the proxy's
 *   pathname header. The roster ships empty, so these run on a fixture roster
 *   — and one case runs on the empty one, which is what ships.
 *
 * @see app/admin/layout.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import AdminLayout from '@/app/admin/layout';
import { createMockSession } from '@/tests/types/mocks';
import { AUTH_LANDING_ROUTE } from '@/lib/auth-landing/route';
import { useSharedSettingsReadOnly } from '@/components/admin/shared-settings-access';
import { env } from '@/lib/env';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const nav = vi.hoisted(() => ({ pathname: '/admin/overview', replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
  useSearchParams: () => ({ get: () => null }),
  usePathname: () => nav.pathname,
  useRouter: () => ({ replace: nav.replace }),
}));

// The org-tier page roster ships empty; a test names the pages it marks.
const roster = vi.hoisted(() => ({ pages: [] as string[] }));
vi.mock('@/lib/auth/admin-tier', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/admin-tier')>();
  return {
    ...actual,
    adminPageTier: (pathname: string | null | undefined) =>
      actual.adminPageTier(pathname, roster.pages),
  };
});

vi.mock('@/lib/auth/utils', () => ({
  getServerSession: vi.fn(),
}));

// The memberships the layout reads: the entered org's (role, org status) and
// the install org's before offering a switch. One row shape serves both.
const membership = vi.hoisted(() => ({
  row: { orgId: 'install', role: 'OWNER', org: { status: 'ACTIVE' } },
}));
vi.mock('@/lib/db/client', () => ({
  prisma: {
    orgMembership: { findUnique: vi.fn(() => Promise.resolve(membership.row)) },
    // The org the header names at `multi` (t-813): the entered org's row.
    org: {
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve({ id: where.id, name: `Org ${where.id}` })
      ),
    },
  },
}));

vi.mock('@/components/admin/admin-sidebar', () => ({
  AdminSidebar: ({ viewerTier, multiTenant }: { viewerTier: string; multiTenant?: boolean }) => (
    <div
      data-testid="admin-sidebar"
      data-viewer-tier={viewerTier}
      data-multi-tenant={String(!!multiTenant)}
    />
  ),
}));

vi.mock('@/components/admin/admin-header', () => ({
  AdminHeader: ({ orgName }: { orgName?: string }) => (
    <div data-testid="admin-header" data-org-name={orgName ?? ''} />
  ),
}));

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getServerSession } from '@/lib/auth/utils';
import { ADMIN_PATHNAME_HEADER } from '@/lib/auth/admin-tier';
import {
  DEFAULT_AUTHORIZATION_POLICY,
  registerAuthorizationPolicy,
  __resetAuthorizationPolicyForTests,
} from '@/lib/auth/authorization';

describe('AdminLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetAuthorizationPolicyForTests();
  });

  it('redirects unauthenticated visitors to /login', async () => {
    // Arrange
    vi.mocked(getServerSession).mockResolvedValue(null);

    // Act + Assert — redirect() throws in our mock to halt the RSC
    await expect(AdminLayout({ children: <div>protected</div> })).rejects.toThrow(
      'NEXT_REDIRECT:/login'
    );
    expect(redirect).toHaveBeenCalledWith('/login');
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it('redirects authenticated non-admin users to the auth landing route', async () => {
    // Arrange
    vi.mocked(getServerSession).mockResolvedValue(createMockSession({ user: { role: 'USER' } }));

    // Act + Assert
    await expect(AdminLayout({ children: <div>protected</div> })).rejects.toThrow(
      `NEXT_REDIRECT:${AUTH_LANDING_ROUTE}`
    );
    expect(redirect).toHaveBeenCalledWith(AUTH_LANDING_ROUTE);
    expect(redirect).not.toHaveBeenCalledWith('/login');
  });

  it('renders children for authenticated admin users', async () => {
    // Arrange
    vi.mocked(getServerSession).mockResolvedValue(createMockSession({ user: { role: 'ADMIN' } }));

    // Act
    const tree = await AdminLayout({
      children: <div data-testid="admin-content">protected</div>,
    });
    render(tree);

    // Assert — no redirect occurred; admin chrome and children are rendered
    expect(redirect).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    expect(screen.getByTestId('admin-sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('admin-header')).toBeInTheDocument();
    expect(screen.getByTestId('admin-content')).toBeInTheDocument();
  });
});

describe('AdminLayout defers to a registered authorization policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetAuthorizationPolicyForTests();
  });

  afterEach(() => {
    __resetAuthorizationPolicyForTests();
  });

  it('lets a non-admin into the admin tree when the policy admits them', async () => {
    // The #366 case, at the shell rather than at the API: a fork's org-admin
    // tier reaches the admin console without an edit to this file or to the 262
    // routes underneath it. Under the default policy this same session is the
    // redirect asserted above.
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canAdminister: (viewer) => Promise.resolve(viewer.userId === 'org-admin'),
    });
    vi.mocked(getServerSession).mockResolvedValue(
      createMockSession({ user: { id: 'org-admin', role: 'USER' } })
    );

    render(await AdminLayout({ children: <div data-testid="admin-content">protected</div> }));

    expect(redirect).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    expect(screen.getByTestId('admin-content')).toBeInTheDocument();
  });

  it('turns a platform admin away when the policy refuses them', async () => {
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canAdminister: () => Promise.resolve(false),
    });
    vi.mocked(getServerSession).mockResolvedValue(createMockSession({ user: { role: 'ADMIN' } }));

    await expect(AdminLayout({ children: <div>protected</div> })).rejects.toThrow(
      `NEXT_REDIRECT:${AUTH_LANDING_ROUTE}`
    );
  });
});

describe('AdminLayout tells every page whether shared settings are read-only (§107 t-753)', () => {
  function Probe() {
    return <p data-testid="probe">{useSharedSettingsReadOnly() ? 'read-only' : 'editable'}</p>;
  }

  async function renderedFor(mode: 'single' | 'multi', activeOrgId: string): Promise<string> {
    const previous = env.TENANCY_MODE;
    env.TENANCY_MODE = mode;
    try {
      const admin = createMockSession({ user: { role: 'ADMIN' } });
      vi.mocked(getServerSession).mockResolvedValue({
        ...admin,
        session: { ...admin.session, activeOrgId },
      });
      const { unmount } = render(await AdminLayout({ children: <Probe /> }));
      const text = screen.getByTestId('probe').textContent ?? '';
      unmount();
      return text;
    } finally {
      env.TENANCY_MODE = previous;
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    __resetAuthorizationPolicyForTests();
  });

  it('is read-only in a customer org at multi', async () => {
    expect(await renderedFor('multi', 'cmorg00000000000customer')).toBe('read-only');
  });

  it('is editable in the install org at multi, and in any org at single', async () => {
    expect(await renderedFor('multi', INSTALL_ORG_ID)).toBe('editable');
    expect(await renderedFor('single', 'cmorg00000000000customer')).toBe('editable');
  });
});

describe('AdminLayout admits an org admin to org-tier pages only (§111 t-810)', () => {
  const CUSTOMER = 'cmorg00000000000customer';
  const ORG_PAGE = '/admin/orchestration/agents';
  let previousMode: typeof env.TENANCY_MODE;

  /** Load `path` fresh: the proxy's header, and the router's pathname, agree. */
  function onPage(path: string | null) {
    nav.pathname = path ?? '/admin';
    vi.mocked(headers).mockResolvedValue(
      new Headers(path ? { [ADMIN_PATHNAME_HEADER]: path } : {})
    );
  }

  /** A platform USER acting in the customer org, with `role` there. */
  function actingAs(role: string, activeOrgId = CUSTOMER) {
    membership.row = { orgId: activeOrgId, role, org: { status: 'ACTIVE' } };
    const user = createMockSession({ user: { role: 'USER' } });
    vi.mocked(getServerSession).mockResolvedValue({
      ...user,
      session: { ...user.session, activeOrgId },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    __resetAuthorizationPolicyForTests();
    previousMode = env.TENANCY_MODE;
    env.TENANCY_MODE = 'multi';
    roster.pages = [ORG_PAGE];
  });

  afterEach(() => {
    env.TENANCY_MODE = previousMode;
    roster.pages = [];
    membership.row = { orgId: 'install', role: 'OWNER', org: { status: 'ACTIVE' } };
    vi.mocked(headers).mockReset();
  });

  it.each(['OWNER', 'ADMIN'])(
    'opens an org-tier page to an org %s, as an org viewer',
    async (role) => {
      actingAs(role);
      onPage(ORG_PAGE);

      render(await AdminLayout({ children: <div data-testid="admin-content">agents</div> }));

      expect(redirect).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
      expect(screen.getByTestId('admin-content')).toBeInTheDocument();
      expect(screen.getByTestId('admin-sidebar')).toHaveAttribute('data-viewer-tier', 'org');
      // t-813: the header names the org being acted in, and the sidebar is told the mode.
      expect(screen.getByTestId('admin-header')).toHaveAttribute(
        'data-org-name',
        `Org ${CUSTOMER}`
      );
      expect(screen.getByTestId('admin-sidebar')).toHaveAttribute('data-multi-tenant', 'true');
    }
  );

  it.each([
    ['a page not on the roster', '/admin/users'],
    ['a page below an org-tier page, which a pattern does not cover', `${ORG_PAGE}/new`],
    ['no pathname header at all', null],
  ])('refuses the same org OWNER %s', async (_label, path) => {
    actingAs('OWNER');
    onPage(path);

    await expect(AdminLayout({ children: <div>platform</div> })).rejects.toThrow(
      `NEXT_REDIRECT:${AUTH_LANDING_ROUTE}`
    );
  });

  it('refuses every page with the roster as it ships: empty', async () => {
    roster.pages = [];
    actingAs('OWNER');
    onPage(ORG_PAGE);

    await expect(AdminLayout({ children: <div>agents</div> })).rejects.toThrow(
      `NEXT_REDIRECT:${AUTH_LANDING_ROUTE}`
    );
  });

  it('refuses a MEMBER of the org on an org-tier page', async () => {
    actingAs('MEMBER');
    onPage(ORG_PAGE);

    await expect(AdminLayout({ children: <div>agents</div> })).rejects.toThrow(
      `NEXT_REDIRECT:${AUTH_LANDING_ROUTE}`
    );
  });

  it('refuses an org OWNER at single, where nothing isolates the org’s rows', async () => {
    env.TENANCY_MODE = 'single';
    actingAs('OWNER');
    onPage(ORG_PAGE);

    await expect(AdminLayout({ children: <div>agents</div> })).rejects.toThrow(
      `NEXT_REDIRECT:${AUTH_LANDING_ROUTE}`
    );
  });

  it('gives a platform admin every page as a platform viewer, roster or not', async () => {
    const admin = createMockSession({ user: { role: 'ADMIN' } });
    vi.mocked(getServerSession).mockResolvedValue({
      ...admin,
      session: { ...admin.session, activeOrgId: INSTALL_ORG_ID },
    });
    onPage('/admin/users');

    render(await AdminLayout({ children: <div data-testid="admin-content">users</div> }));

    expect(screen.getByTestId('admin-content')).toBeInTheDocument();
    expect(screen.getByTestId('admin-sidebar')).toHaveAttribute('data-viewer-tier', 'platform');
  });

  it('names no org and hides the multi-only nav at single (t-813)', async () => {
    env.TENANCY_MODE = 'single';
    const admin = createMockSession({ user: { role: 'ADMIN' } });
    vi.mocked(getServerSession).mockResolvedValue({
      ...admin,
      session: { ...admin.session, activeOrgId: INSTALL_ORG_ID },
    });
    onPage('/admin/users');

    render(await AdminLayout({ children: <div>users</div> }));

    expect(screen.getByTestId('admin-header')).toHaveAttribute('data-org-name', '');
    expect(screen.getByTestId('admin-sidebar')).toHaveAttribute('data-multi-tenant', 'false');
  });
});
