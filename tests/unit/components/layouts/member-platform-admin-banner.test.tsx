// @vitest-environment happy-dom

/**
 * Tests: MemberPlatformAdminBanner (t-1032)
 *
 * A platform admin acting in a customer org as a member is told where they
 * are and as what, and switched back to the install org on request — then a
 * full load, so the admin layout re-checks who is viewing. Through a fork's
 * resolver address a switch cannot leave the org, so the banner says so
 * instead of offering one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { MemberPlatformAdminBanner } from '@/components/layouts/member-platform-admin-banner';
import { apiClient, APIClientError } from '@/lib/api/client';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const assign = vi.fn();
const originalLocation = window.location;

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, assign },
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
});

const view = (
  overrides: Partial<Parameters<typeof MemberPlatformAdminBanner>[0]['view']> = {}
) => ({
  orgName: 'Customer Ltd',
  orgRole: 'ADMIN',
  installOrgName: 'Vendor',
  viaResolver: false,
  ...overrides,
});

describe('MemberPlatformAdminBanner', () => {
  it('names the org, the role and where platform administration is', () => {
    render(<MemberPlatformAdminBanner view={view()} />);

    expect(screen.getByRole('status')).toHaveTextContent(
      'You are working in Customer Ltd as an admin, so you can do only what that role allows here. Platform administration is in Vendor.'
    );
    expect(screen.getByText('Customer Ltd').tagName).toBe('STRONG');
  });

  it.each([
    ['OWNER', 'as an owner'],
    ['MEMBER', 'as a member'],
  ])('words the %s role', (orgRole, words) => {
    render(<MemberPlatformAdminBanner view={view({ orgRole })} />);
    expect(screen.getByRole('status')).toHaveTextContent(words);
  });

  it('names a role an app added by its own name, not as a member', () => {
    render(<MemberPlatformAdminBanner view={view({ orgRole: 'BILLING' })} />);
    expect(screen.getByRole('status')).toHaveTextContent('as BILLING, so');
  });

  it('falls back to plain words when a name could not be read', () => {
    render(<MemberPlatformAdminBanner view={view({ orgName: null, installOrgName: null })} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'You are working in this organisation as an admin'
    );
    expect(screen.getByRole('button')).toHaveTextContent('Switch to the platform organisation');
  });

  it('switches to the install org, then loads the console afresh', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({});
    render(<MemberPlatformAdminBanner view={view()} />);

    await userEvent.click(screen.getByRole('button', { name: 'Switch to Vendor' }));

    expect(apiClient.post).toHaveBeenCalledWith('/api/v1/orgs/switch', {
      body: { orgId: INSTALL_ORG_ID },
    });
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/admin'));
  });

  it('shows the refusal and lets them try again when the switch fails', async () => {
    vi.mocked(apiClient.post).mockRejectedValue(new APIClientError('Not a member'));
    render(<MemberPlatformAdminBanner view={view()} />);

    await userEvent.click(screen.getByRole('button', { name: 'Switch to Vendor' }));

    expect(await screen.findByText('Not a member')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch to Vendor' })).toBeEnabled();
    expect(assign).not.toHaveBeenCalled(); // test-review:accept no_arg_called — a failed switch must not navigate;
  });

  it('offers no switch through a resolver address, and says how to leave it', () => {
    render(<MemberPlatformAdminBanner view={view({ viaResolver: true })} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(
      screen.getByText('To work as a platform admin, open Vendor at its own address.')
    ).toBeInTheDocument();
  });
});
