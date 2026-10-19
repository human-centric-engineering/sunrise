// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// Who is viewing (§111 t-812). Every case before the last describe is the
// platform's view, as it was before the page asked; the org viewer's half is
// the last describe's.
const viewer = vi.hoisted(() => ({ tier: 'platform' }));
vi.mock('@/lib/auth/admin-page-viewer', () => ({
  adminPageViewerTier: vi.fn(() => Promise.resolve(viewer.tier)),
}));

vi.mock('@/components/admin/orchestration/mcp/mcp-dashboard', () => ({
  McpDashboard: ({
    initialSettings,
    stats,
    viewerTier,
  }: {
    initialSettings: unknown;
    stats: {
      tools: number | null;
      resources: number | null;
      prompts: number | null;
      keys: number | null;
    };
    viewerTier?: string;
  }) => (
    <div
      data-testid="mcp-dashboard"
      data-viewer-tier={viewerTier ?? ''}
      data-has-settings={initialSettings === null ? 'false' : 'true'}
      data-settings={initialSettings ? JSON.stringify(initialSettings) : ''}
      data-tools={stats.tools === null ? 'failed' : stats.tools}
      data-resources={stats.resources === null ? 'failed' : stats.resources}
      data-prompts={stats.prompts === null ? 'failed' : stats.prompts}
      data-keys={stats.keys === null ? 'failed' : stats.keys}
    />
  ),
}));

vi.mock('@/components/admin/orchestration/mcp/mcp-info-modal', () => ({
  McpInfoModal: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div data-testid="mcp-info-modal" data-title={title}>
      {children}
    </div>
  ),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import McpDashboardPage, { metadata } from '@/app/admin/orchestration/mcp/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';
import { logger } from '@/lib/logging';
import { API } from '@/lib/api/endpoints';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const mockSettings = {
  isEnabled: true,
  serverName: 'sunrise-mcp',
  serverVersion: '1.0.0',
  globalRateLimit: 100,
  auditRetentionDays: 30,
};

// ---------------------------------------------------------------------------
// URL dispatch helper
// ---------------------------------------------------------------------------

type Endpoint = 'settings' | 'tools' | 'resources' | 'prompts' | 'keys';

/**
 * Answer each endpoint the page reads with a fresh Response per call: the
 * settings, and each list's total in `meta`. `overrides` replaces one
 * endpoint's answer (return a failure, or throw to simulate no response).
 */
function setupServerFetch(
  statTotals: { tools?: number; resources?: number; prompts?: number; keys?: number } = {},
  overrides: Partial<Record<Endpoint, () => Response>> = {}
) {
  const answers: Record<Endpoint, () => Response> = {
    settings: () => apiSuccess(mockSettings),
    tools: () => apiSuccess([], { total: statTotals.tools ?? 3 }),
    resources: () => apiSuccess([], { total: statTotals.resources ?? 5 }),
    prompts: () => apiSuccess([], { total: statTotals.prompts ?? 4 }),
    keys: () => apiSuccess([], { total: statTotals.keys ?? 2 }),
    ...overrides,
  };
  vi.mocked(serverFetch).mockImplementation(async (url: string) => {
    if (url.includes(API.ADMIN.ORCHESTRATION.MCP_SETTINGS)) return answers.settings();
    // Specific routes first (defensive against shared substrings).
    if (url.includes(API.ADMIN.ORCHESTRATION.MCP_PROMPTS)) return answers.prompts();
    if (url.includes(API.ADMIN.ORCHESTRATION.MCP_TOOLS)) return answers.tools();
    if (url.includes(API.ADMIN.ORCHESTRATION.MCP_RESOURCES)) return answers.resources();
    if (url.includes(API.ADMIN.ORCHESTRATION.MCP_KEYS)) return answers.keys();
    throw new Error(`Unexpected URL: ${url}`);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('McpDashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 1. Metadata
  it('has correct title and description metadata', () => {
    expect(metadata.title).toBe('MCP Server · AI Orchestration');
    expect(metadata.description).toMatch(/Model Context Protocol/i);
  });

  // 2. Heading and breadcrumb
  it('renders heading "MCP Server" and breadcrumb link to /admin/orchestration', async () => {
    setupServerFetch();

    render(await McpDashboardPage());

    expect(screen.getByRole('heading', { name: /MCP Server/i })).toBeInTheDocument();
    const breadcrumbLink = screen.getByRole('link', { name: 'AI Orchestration' });
    expect(breadcrumbLink).toHaveAttribute('href', '/admin/orchestration');
    expect(screen.getByText('MCP Server', { selector: 'span' })).toBeInTheDocument();
  });

  // 3. Settings happy path
  it('passes initialSettings to McpDashboard when settings fetch succeeds', async () => {
    setupServerFetch();

    render(await McpDashboardPage());

    const dashboard = screen.getByTestId('mcp-dashboard');
    expect(dashboard).toHaveAttribute('data-has-settings', 'true');
    expect(JSON.parse(dashboard.getAttribute('data-settings') ?? '{}')).toEqual(mockSettings);
  });

  // 4–6. A failed settings load throws: the dashboard would otherwise show
  // the server as "Disabled", a false signal (#518).
  it('throws to the error boundary when the settings API answers 500', async () => {
    setupServerFetch({}, { settings: () => apiFailure(500) });

    await expect(McpDashboardPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('throws when the settings API answers success:false', async () => {
    setupServerFetch({}, { settings: () => apiFailure(200) });

    await expect(McpDashboardPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('logs and throws when the settings fetch rejects', async () => {
    const fetchErr = new Error('network failure');
    setupServerFetch(
      {},
      {
        settings: () => {
          throw fetchErr;
        },
      }
    );

    await expect(McpDashboardPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.any(String),
      fetchErr,
      expect.any(Object)
    );
  });

  it('logs and throws when the settings do not match the expected shape', async () => {
    setupServerFetch({}, { settings: () => apiSuccess({ isEnabled: 'yes' }) });

    await expect(McpDashboardPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.stringContaining('did not parse'),
      expect.anything(),
      expect.any(Object)
    );
  });

  // 7. Stats happy path
  it('passes correct stats to McpDashboard when all stat fetches succeed', async () => {
    setupServerFetch({ tools: 7, resources: 12, keys: 4 });

    render(await McpDashboardPage());

    const dashboard = screen.getByTestId('mcp-dashboard');
    expect(dashboard).toHaveAttribute('data-tools', '7');
    expect(dashboard).toHaveAttribute('data-resources', '12');
    expect(dashboard).toHaveAttribute('data-keys', '4');
  });

  // 8. A failed count is null, never 0 (#518): the dashboard shows "—" and a
  // notice for it, and zero tools and keys would also show "Getting Started".
  // The page and the other counts still render.
  it('renders the page and hands a null tools count when that count fails, rather than 0', async () => {
    setupServerFetch({}, { tools: () => apiFailure(500) });

    render(await McpDashboardPage());

    expect(screen.getByRole('heading', { name: /MCP Server/i })).toBeInTheDocument();
    const dashboard = screen.getByTestId('mcp-dashboard');
    expect(dashboard).toHaveAttribute('data-tools', 'failed');
    expect(dashboard).toHaveAttribute('data-resources', '5');
    expect(dashboard).toHaveAttribute('data-prompts', '4');
    expect(dashboard).toHaveAttribute('data-keys', '2');
    expect(dashboard).toHaveAttribute('data-has-settings', 'true');
  });

  it('hands a null keys count, and logs, when the keys count fetch rejects', async () => {
    const fetchErr = new Error('keys network failure');
    setupServerFetch(
      {},
      {
        keys: () => {
          throw fetchErr;
        },
      }
    );

    render(await McpDashboardPage());

    const dashboard = screen.getByTestId('mcp-dashboard');
    expect(dashboard).toHaveAttribute('data-keys', 'failed');
    expect(dashboard).toHaveAttribute('data-tools', '3');
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.any(String),
      fetchErr,
      expect.objectContaining({ path: expect.stringContaining(API.ADMIN.ORCHESTRATION.MCP_KEYS) })
    );
  });

  // 9. Stats non-number meta.total
  it('sets stats.tools=0 when MCP_TOOLS meta.total is non-number, other stats correct', async () => {
    setupServerFetch({}, { tools: () => apiSuccess([], { total: 'five' }) });

    render(await McpDashboardPage());

    const dashboard = screen.getByTestId('mcp-dashboard');
    expect(dashboard).toHaveAttribute('data-tools', '0');
    expect(dashboard).toHaveAttribute('data-resources', '5');
    expect(dashboard).toHaveAttribute('data-prompts', '4');
    expect(dashboard).toHaveAttribute('data-keys', '2');
  });

  // 10. Genuine zeros are zeros
  it('passes zero counts through when the lists are genuinely empty', async () => {
    setupServerFetch({ tools: 0, resources: 0, prompts: 0, keys: 0 });

    render(await McpDashboardPage());

    const dashboard = screen.getByTestId('mcp-dashboard');
    expect(dashboard).toHaveAttribute('data-tools', '0');
    expect(dashboard).toHaveAttribute('data-keys', '0');
  });
});

describe('McpDashboardPage — an org admin’s keys (§111 t-812)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    viewer.tier = 'org';
    setupServerFetch({ tools: 3, resources: 5, prompts: 4, keys: 2 });
  });

  afterEach(() => {
    viewer.tier = 'platform';
  });

  it('fetches the keys count alone, and none of the server’s settings or exposed lists', async () => {
    render(await McpDashboardPage());

    const urls = vi.mocked(serverFetch).mock.calls.map(([url]) => String(url));
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(API.ADMIN.ORCHESTRATION.MCP_KEYS);
    const dashboard = screen.getByTestId('mcp-dashboard');
    expect(dashboard).toHaveAttribute('data-viewer-tier', 'org');
    expect(dashboard).toHaveAttribute('data-has-settings', 'false');
    expect(dashboard).toHaveAttribute('data-keys', '2');
    expect(dashboard).toHaveAttribute('data-tools', '0');
  });

  it('does not tell them they control what the server exposes', async () => {
    render(await McpDashboardPage());

    expect(screen.queryByText(/You control exactly what is exposed/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/The platform admin decides what the server exposes/)
    ).toBeInTheDocument();
  });

  it('hands a null keys count when theirs fails, rather than showing 0 keys', async () => {
    setupServerFetch({}, { keys: () => apiFailure(500) });

    render(await McpDashboardPage());

    expect(screen.getByTestId('mcp-dashboard')).toHaveAttribute('data-keys', 'failed');
  });

  it('control: the platform’s view fetches all five', async () => {
    viewer.tier = 'platform';

    render(await McpDashboardPage());

    expect(vi.mocked(serverFetch)).toHaveBeenCalledTimes(5);
    const dashboard = screen.getByTestId('mcp-dashboard');
    expect(dashboard).toHaveAttribute('data-viewer-tier', 'platform');
    expect(dashboard).toHaveAttribute('data-tools', '3');
    expect(screen.getByText(/You control exactly what is exposed/)).toBeInTheDocument();
  });
});
