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
 * - Authenticated non-admin → redirect('/dashboard')
 * - Authenticated admin → renders children
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/app/admin/layout.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import AdminLayout from '@/app/admin/layout';
import { createMockSession } from '@/tests/types/mocks';

vi.mock('next/navigation', () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
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

describe('AdminLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('redirects authenticated non-admin users to /dashboard', async () => {
    // Arrange
    vi.mocked(getServerSession).mockResolvedValue(createMockSession({ user: { role: 'USER' } }));

    // Act + Assert
    await expect(AdminLayout({ children: <div>protected</div> })).rejects.toThrow(
      'NEXT_REDIRECT:/dashboard'
    );
    expect(redirect).toHaveBeenCalledWith('/dashboard');
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
