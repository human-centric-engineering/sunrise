// @vitest-environment happy-dom

/**
 * ConfigHealthGlobalBanner — client fetcher tests.
 *
 * @see components/admin/config-health-global-banner.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

const nav = vi.hoisted(() => ({ pathname: '/admin/users' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));
vi.mock('@/lib/api/client', () => ({ apiClient: { get: vi.fn() } }));
vi.mock('@/lib/logging', () => ({ logger: { error: vi.fn() } }));

import { apiClient } from '@/lib/api/client';
import { logger } from '@/lib/logging';
import {
  ConfigHealthGlobalBanner,
  REPORT_MAX_AGE_MS,
  __resetConfigHealthBannerCacheForTests,
} from '@/components/admin/config-health-global-banner';
import type { ConfigHealthReport } from '@/lib/config-health/types';

type Mock = ReturnType<typeof vi.fn>;

function reportWith(present: boolean): ConfigHealthReport {
  return {
    environment: 'production',
    platform: 'vercel',
    checks: [
      {
        key: 'CRON_SECRET',
        label: 'Maintenance cron secret',
        severity: 'critical',
        description: 'x',
        remediation: 'y',
        present,
        applicable: true,
      },
    ],
    summary: { critical: present ? 0 : 1, warning: 0, info: 0, ok: present ? 1 : 0, failed: 0 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  nav.pathname = '/admin/users';
  __resetConfigHealthBannerCacheForTests();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ConfigHealthGlobalBanner', () => {
  it('renders the critical banner once the report loads with a missing critical setting', async () => {
    (apiClient.get as Mock).mockResolvedValue(reportWith(false));
    render(<ConfigHealthGlobalBanner />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Configuration required/i);
    expect(apiClient.get).toHaveBeenCalledWith('/api/v1/admin/config-health');
  });

  it('renders nothing when all critical settings are present', async () => {
    (apiClient.get as Mock).mockResolvedValue(reportWith(true));
    const { container } = render(<ConfigHealthGlobalBanner />);
    await waitFor(() => expect(apiClient.get).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('logs a non-Error rejection as its string form', async () => {
    (apiClient.get as Mock).mockRejectedValue('offline');
    render(<ConfigHealthGlobalBanner />);
    await waitFor(() =>
      expect(logger.error).toHaveBeenCalledWith('Failed to load config health', {
        error: 'offline',
      })
    );
  });

  it('ignores a report that arrives after it unmounted', async () => {
    let resolve: (r: ConfigHealthReport) => void = () => {};
    (apiClient.get as Mock).mockReturnValue(
      new Promise<ConfigHealthReport>((r) => {
        resolve = r;
      })
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = render(<ConfigHealthGlobalBanner />);
    unmount();

    resolve(reportWith(false));
    await Promise.resolve();

    // No state update on an unmounted component, so React reports nothing.
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('fails silent (renders nothing, logs) when the fetch rejects', async () => {
    (apiClient.get as Mock).mockRejectedValue(new Error('boom'));
    const { container } = render(<ConfigHealthGlobalBanner />);
    await waitFor(() => expect(logger.error).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('reuses a report under a minute old across navigations, so clicking around costs no loads', async () => {
    (apiClient.get as Mock).mockResolvedValue(reportWith(false));
    const { rerender } = render(<ConfigHealthGlobalBanner />);
    await screen.findByRole('alert');

    nav.pathname = '/admin/logs';
    rerender(<ConfigHealthGlobalBanner />);
    nav.pathname = '/admin/features';
    rerender(<ConfigHealthGlobalBanner />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('loads again on the first navigation after a minute, so a fix made in the admin clears it', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    (apiClient.get as Mock).mockResolvedValue(reportWith(false));
    const { rerender } = render(<ConfigHealthGlobalBanner />);
    await screen.findByRole('alert');

    now.mockReturnValue(1_000_000 + REPORT_MAX_AGE_MS);
    (apiClient.get as Mock).mockResolvedValue(reportWith(true));
    nav.pathname = '/admin/orchestration/providers';
    rerender(<ConfigHealthGlobalBanner />);

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('shares one load across navigations made before it settles', async () => {
    let resolve: (r: ConfigHealthReport) => void = () => {};
    (apiClient.get as Mock).mockReturnValue(
      new Promise<ConfigHealthReport>((r) => {
        resolve = r;
      })
    );
    const { rerender } = render(<ConfigHealthGlobalBanner />);
    nav.pathname = '/admin/logs';
    rerender(<ConfigHealthGlobalBanner />);
    nav.pathname = '/admin/features';
    rerender(<ConfigHealthGlobalBanner />);

    resolve(reportWith(false));
    await screen.findByRole('alert');
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('clears the strip when a reload fails, rather than keep an earlier answer', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    (apiClient.get as Mock).mockResolvedValue(reportWith(false));
    const { rerender } = render(<ConfigHealthGlobalBanner />);
    await screen.findByRole('alert');

    now.mockReturnValue(1_000_000 + REPORT_MAX_AGE_MS);
    (apiClient.get as Mock).mockRejectedValue(new Error('429'));
    nav.pathname = '/admin/users/u1';
    rerender(<ConfigHealthGlobalBanner />);

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(logger.error).toHaveBeenCalled();
  });

  it('shows nothing and loads nothing on the overview, which has the full card', () => {
    nav.pathname = '/admin/overview';
    const { container } = render(<ConfigHealthGlobalBanner />);
    expect(container).toBeEmptyDOMElement();
    expect(apiClient.get).not.toHaveBeenCalled();
  });
});
