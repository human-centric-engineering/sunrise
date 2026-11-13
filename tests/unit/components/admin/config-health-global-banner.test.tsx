// @vitest-environment happy-dom

/**
 * ConfigHealthGlobalBanner — client fetcher tests.
 *
 * @see components/admin/config-health-global-banner.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

vi.mock('@/lib/api/client', () => ({ apiClient: { get: vi.fn() } }));
vi.mock('@/lib/logging', () => ({ logger: { error: vi.fn() } }));

import { apiClient } from '@/lib/api/client';
import { logger } from '@/lib/logging';
import { ConfigHealthGlobalBanner } from '@/components/admin/config-health-global-banner';
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
    summary: { critical: present ? 0 : 1, warning: 0, info: 0, ok: present ? 1 : 0 },
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

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

  it('fails silent (renders nothing, logs) when the fetch rejects', async () => {
    (apiClient.get as Mock).mockRejectedValue(new Error('boom'));
    const { container } = render(<ConfigHealthGlobalBanner />);
    await waitFor(() => expect(logger.error).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
