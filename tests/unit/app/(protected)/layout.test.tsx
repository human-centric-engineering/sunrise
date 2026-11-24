// @vitest-environment happy-dom

/**
 * Tests: the account area's shell shows a member platform admin the way back
 * (t-1032)
 *
 * A platform admin acting in a customer org as an org MEMBER is not admitted
 * to the admin console, so this shell is the one they land in, and it must
 * carry the banner that switches them back to the install org. A failed read
 * leaves the banner out rather than taking the page down.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/auth/admin-page-viewer', () => ({ requestMemberPlatformAdmin: vi.fn() }));
vi.mock('@/components/maintenance-wrapper', () => ({
  MaintenanceWrapperWithAdminNotice: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock('@/components/layouts/app-header', () => ({ AppHeader: () => <header /> }));
vi.mock('@/components/layouts/protected-nav', () => ({ ProtectedNav: () => null }));
vi.mock('@/components/layouts/protected-footer', () => ({ ProtectedFooter: () => null }));
vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import ProtectedLayout from '@/app/(protected)/layout';
import { requestMemberPlatformAdmin } from '@/lib/auth/admin-page-viewer';
import { logger } from '@/lib/logging';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ProtectedLayout', () => {
  it('shows a member platform admin where they are and the way back', async () => {
    vi.mocked(requestMemberPlatformAdmin).mockResolvedValue({
      orgName: 'Customer Ltd',
      orgRole: 'MEMBER',
      installOrgName: 'Vendor',
      viaResolver: false,
    });

    render(await ProtectedLayout({ children: <p>dashboard</p> }));

    expect(screen.getByRole('status')).toHaveTextContent(
      'You are working in Customer Ltd as a member'
    );
    expect(screen.getByRole('button', { name: 'Switch to Vendor' })).toBeInTheDocument();
    expect(screen.getByText('dashboard')).toBeInTheDocument();
  });

  it('shows nothing extra to everyone else', async () => {
    vi.mocked(requestMemberPlatformAdmin).mockResolvedValue(null);

    render(await ProtectedLayout({ children: <p>dashboard</p> }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('dashboard')).toBeInTheDocument();
  });

  it('leaves the banner out, and logs, when the read fails', async () => {
    vi.mocked(requestMemberPlatformAdmin).mockRejectedValue(new Error('db down'));

    render(await ProtectedLayout({ children: <p>dashboard</p> }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('dashboard')).toBeInTheDocument();
    expect(logger.error).toHaveBeenCalledWith(
      'protected layout: could not read the member platform admin view',
      expect.any(Error)
    );
  });
});
