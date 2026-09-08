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
 * - A registered app authorization policy decides instead — the third
 *   chokepoint. The three tests above run on Sunrise's default policy and are
 *   unchanged by the seam landing, which is the behaviour-neutrality evidence
 *   for the admin tree; the two below prove the seam is not decoration.
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/app/admin/layout.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import AdminLayout from '@/app/admin/layout';
import { createMockSession } from '@/tests/types/mocks';
import { AUTH_LANDING_ROUTE } from '@/lib/auth-landing/route';

vi.mock('next/navigation', () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
  useSearchParams: () => ({ get: () => null }),
}));

vi.mock('@/lib/auth/utils', () => ({
  getServerSession: vi.fn(),
}));

vi.mock('@/components/admin/admin-sidebar', () => ({
  AdminSidebar: () => <div data-testid="admin-sidebar" />,
}));

vi.mock('@/components/admin/admin-header', () => ({
  AdminHeader: () => <div data-testid="admin-header" />,
}));

import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/auth/utils';
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
