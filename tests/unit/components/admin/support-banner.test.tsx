// @vitest-environment happy-dom

/**
 * Tests: SupportBanner — the support session's banner (§121 t-824)
 *
 * The active state names the org, the level and the time left; the ended
 * state says why the console stopped working. Both end the session the same
 * way: a switch back to the install org, then a full load so the layout
 * re-checks who is viewing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { SupportBanner, formatTimeLeft } from '@/components/admin/support-banner';
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

const active = (msLeft: number, level: 'ADMIN' | 'READ_ONLY' = 'ADMIN') =>
  ({
    state: 'active',
    orgId: 'org-1',
    orgName: 'Customer Ltd',
    level,
    expiresAt: new Date(Date.now() + msLeft).toISOString(),
    viaResolver: false,
  }) as const;

describe('formatTimeLeft', () => {
  it.each([
    [30_000, 'less than a minute left'],
    [12 * 60_000, '12m left'],
    [3 * 3_600_000, '3h left'],
    [3 * 3_600_000 + 20 * 60_000 + 5_000, '3h 20m left'],
  ])('%i ms is "%s"', (ms, text) => {
    expect(formatTimeLeft(ms)).toBe(text);
  });
});

describe('SupportBanner', () => {
  it('names the org, the level and the time left while active', () => {
    render(<SupportBanner view={active(90 * 60_000 + 30_000, 'READ_ONLY')} />);

    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('Support session in Customer Ltd');
    expect(banner).toHaveTextContent('Read-only access');
    expect(banner).toHaveTextContent('1h 30m left');
  });

  it('reads as ended once the expiry has passed, before any reload', () => {
    render(<SupportBanner view={active(-1_000)} />);

    expect(screen.getByRole('status')).toHaveTextContent(
      'Your support session in Customer Ltd has ended'
    );
  });

  it('shows the ended state the layout hands it', () => {
    render(<SupportBanner view={{ state: 'ended', orgId: 'org-1', orgName: 'Customer Ltd' }} />);

    expect(screen.getByRole('status')).toHaveTextContent('has ended');
  });

  it('entered through a resolver address, says to leave it instead of offering a switch that cannot work', () => {
    render(<SupportBanner view={{ ...active(3_600_000), viaResolver: true }} />);

    expect(screen.getByRole('status')).toHaveTextContent(
      'Leave this organisation’s address to end the session.'
    );
    expect(screen.queryByRole('button', { name: 'End support session' })).not.toBeInTheDocument();
  });

  it('ends the session by switching to the install org, then reloading the console', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({});
    render(<SupportBanner view={active(3_600_000)} />);

    await userEvent.click(screen.getByRole('button', { name: 'End support session' }));

    expect(apiClient.post).toHaveBeenCalledWith('/api/v1/orgs/switch', {
      body: { orgId: INSTALL_ORG_ID },
    });
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/admin'));
  });

  it('says so, and stays put, when the switch fails', async () => {
    vi.mocked(apiClient.post).mockRejectedValue(new APIClientError('Access denied'));
    render(<SupportBanner view={{ state: 'ended', orgId: 'org-1', orgName: 'Customer Ltd' }} />);

    await userEvent.click(screen.getByRole('button', { name: 'End support session' }));

    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'End support session' })).toBeEnabled();
  });
});
