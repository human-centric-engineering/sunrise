// @vitest-environment happy-dom

/**
 * The status components: labels from the catalogue, and latency, uptime and
 * memory through the locale formatter (§138 t-1073). The health check is
 * mocked; its own behaviour has its own tests.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import en from '@/lib/i18n/messages/en.json';
import { StatusIndicator, getStatusConfig } from '@/components/status/status-indicator';
import { ServiceStatusCard } from '@/components/status/service-status-card';
import { StatusPage } from '@/components/status/status-page';
import type { UseHealthCheckReturn } from '@/components/status/use-health-check';
import type { HealthCheckResponse } from '@/lib/monitoring';

const health = vi.hoisted((): { current: UseHealthCheckReturn | null } => ({ current: null }));
vi.mock('@/components/status/use-health-check', () => ({
  useHealthCheck: () => health.current,
}));

const MB = 1000 * 1000;

function response(overrides: Partial<HealthCheckResponse> = {}): HealthCheckResponse {
  return {
    status: 'ok',
    version: '1.2.3',
    uptime: 2 * 86400 + 3 * 3600 + 4 * 60 + 5,
    timestamp: '2026-11-20T12:00:00Z',
    services: { database: { status: 'operational', connected: true, latency: 12 } },
    memory: { heapUsed: 12.5 * MB, heapTotal: 64 * MB, rss: 128 * MB, percentage: 19.53 },
    ...overrides,
  };
}

function hook(overrides: Partial<UseHealthCheckReturn> = {}): UseHealthCheckReturn {
  return {
    data: response(),
    isLoading: false,
    error: null,
    isPolling: true,
    lastUpdated: new Date('2026-11-20T12:00:00Z'),
    refresh: vi.fn().mockResolvedValue(undefined),
    startPolling: vi.fn(),
    stopPolling: vi.fn(),
    ...overrides,
  };
}

describe('StatusIndicator', () => {
  it.each(['operational', 'degraded', 'outage', 'unknown'] as const)(
    'names the %s status from the catalogue',
    (status) => {
      render(<StatusIndicator status={status} showLabel />);

      const label = en.status.indicator[status].label;
      expect(screen.getByRole('status', { name: `Status: ${label}` })).toBeInTheDocument();
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  );

  it('shows no visible label unless asked', () => {
    render(<StatusIndicator status="operational" />);

    expect(screen.queryByText(en.status.indicator.operational.label)).not.toBeInTheDocument();
  });

  it('pulses only an operational indicator asked to animate', () => {
    const { container, rerender } = render(<StatusIndicator status="operational" animate />);
    expect(container.querySelector('.animate-pulse')).not.toBeNull();

    rerender(<StatusIndicator status="outage" animate />);
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });

  it('exposes each status colour', () => {
    expect(getStatusConfig('outage').color).toBe('bg-red-500');
  });
});

describe('ServiceStatusCard', () => {
  it('shows the service, its status description and a latency in ms', () => {
    render(
      <ServiceStatusCard
        name="Database"
        description="Primary"
        health={{ status: 'operational', connected: true, latency: 250 }}
      />
    );

    expect(screen.getByText('Database')).toBeInTheDocument();
    expect(screen.getByText('Primary')).toBeInTheDocument();
    expect(screen.getByText(en.status.indicator.operational.description)).toBeInTheDocument();
    expect(screen.getByText('250ms')).toBeInTheDocument();
  });

  it('shows a latency over a second in seconds, and the error', () => {
    render(
      <ServiceStatusCard
        name="Database"
        health={{ status: 'degraded', connected: true, latency: 1234, error: 'slow query' }}
      />
    );

    expect(screen.getByText('1.23s')).toBeInTheDocument();
    expect(screen.getByText('slow query')).toBeInTheDocument();
  });

  it('hides the latency when asked to or when there is none', () => {
    const { rerender } = render(
      <ServiceStatusCard
        name="Database"
        health={{ status: 'operational', connected: true, latency: 5 }}
        showLatency={false}
      />
    );
    expect(screen.queryByText('5ms')).not.toBeInTheDocument();

    rerender(<ServiceStatusCard name="Database" health={{ status: 'outage', connected: false }} />);
    expect(screen.queryByText(/ms$/)).not.toBeInTheDocument();
  });
});

describe('StatusPage', () => {
  beforeEach(() => {
    health.current = hook();
  });

  it('shows the catalogue title, version, uptime and services', () => {
    render(<StatusPage />);

    expect(
      screen.getByRole('heading', { level: 1, name: en.status.page.title })
    ).toBeInTheDocument();
    expect(screen.getByText('1.2.3')).toBeInTheDocument();
    expect(screen.getByText('2d 3h 4m 5s')).toBeInTheDocument();
    expect(screen.getByText(en.status.page.databaseDescription)).toBeInTheDocument();
    expect(screen.getByText('Auto-refreshing every 30s')).toBeInTheDocument();
  });

  it('formats memory and its share with the locale formatter', () => {
    render(<StatusPage />);

    expect(screen.getByText('12.5 MB')).toBeInTheDocument();
    expect(screen.getByText('64 MB')).toBeInTheDocument();
    expect(screen.getByText('128 MB')).toBeInTheDocument();
    expect(screen.getByText('20%')).toBeInTheDocument();
  });

  it('shows a short uptime in seconds, and an exact hour without zero parts', () => {
    health.current = hook({ data: response({ uptime: 0 }) });
    const { unmount } = render(<StatusPage />);
    expect(screen.getByText('0s')).toBeInTheDocument();
    unmount();

    health.current = hook({ data: response({ uptime: 3600 }) });
    render(<StatusPage />);
    expect(screen.getByText('1h')).toBeInTheDocument();
  });

  it('leaves memory out when the response has none or the page is told to', () => {
    health.current = hook({ data: response({ memory: undefined }) });
    const { unmount } = render(<StatusPage />);
    expect(screen.queryByText(en.status.page.memoryUsage)).not.toBeInTheDocument();
    unmount();

    health.current = hook();
    render(<StatusPage showMemory={false} />);
    expect(screen.queryByText(en.status.page.memoryUsage)).not.toBeInTheDocument();
  });

  it('takes a custom title and description', () => {
    render(<StatusPage title="Our status" description="All of it" />);

    expect(screen.getByRole('heading', { level: 1, name: 'Our status' })).toBeInTheDocument();
    expect(screen.getByText('All of it')).toBeInTheDocument();
  });

  it('shows a failed fetch and "Never" before the first check', () => {
    health.current = hook({ data: null, lastUpdated: null, error: new Error('offline') });
    render(<StatusPage />);

    expect(screen.getByText('Failed to fetch status: offline')).toBeInTheDocument();
    expect(screen.getByText('Last updated: Never')).toBeInTheDocument();
  });

  it('shows a spinner, not content, while the first check loads', () => {
    health.current = hook({ data: null, isLoading: true });
    render(<StatusPage />);

    expect(screen.queryByText(en.status.page.overallStatus)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.status.page.refresh })).toBeDisabled();
  });

  it('refreshes on demand and resumes paused polling', async () => {
    const state = hook({ isPolling: false });
    health.current = state;
    render(<StatusPage />);

    await userEvent.click(screen.getByRole('button', { name: en.status.page.refresh }));
    await userEvent.click(screen.getByRole('button', { name: en.status.page.resume }));

    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(state.startPolling).toHaveBeenCalledTimes(1);
    expect(screen.getByText(en.status.page.autoRefreshPaused)).toBeInTheDocument();
  });

  it('shows an outage when the check reports an error', () => {
    health.current = hook({ data: response({ status: 'error' }) });
    render(<StatusPage />);

    expect(
      screen.getByRole('status', { name: `Status: ${en.status.indicator.outage.label}` })
    ).toBeInTheDocument();
  });
});
