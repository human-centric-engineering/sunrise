import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/components/admin/orchestration/mcp/mcp-dashboard', () => ({
  McpDashboard: ({
    initialSettings,
    stats,
  }: {
    initialSettings: unknown;
    stats: { tools: number; resources: number; keys: number };
  }) => (
    <div
      data-testid="mcp-dashboard"
      data-has-settings={initialSettings === null ? 'false' : 'true'}
      data-settings={initialSettings ? JSON.stringify(initialSettings) : ''}
      data-tools={stats.tools}
      data-resources={stats.resources}
      data-keys={stats.keys}
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
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { API } from '@/lib/api/endpoints';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const mockSettings = {
  isEnabled: true,
  serverName: 'sunrise-mcp',
  serverVersion: '1.0.0',
  maxSessionsPerKey: 5,
  globalRateLimit: 100,
  auditRetentionDays: 30,
};

// ---------------------------------------------------------------------------
// URL dispatch helpers
// ---------------------------------------------------------------------------

type FakeResponse = { ok: boolean; _src: string };

function makeOkResponse(src: string): FakeResponse {
  return { ok: true, _src: src };
}

function makeNotOkResponse(src: string): FakeResponse {
  return { ok: false, _src: src };
}

/** Default serverFetch mock: all endpoints succeed */
function setupDefaultServerFetch(
  overrides: Partial<Record<'settings' | 'tools' | 'resources' | 'keys', FakeResponse>> = {}
) {
  vi.mocked(serverFetch).mockImplementation(async (url: string) => {
    if (url.includes(API.ADMIN.ORCHESTRATION.MCP_SETTINGS))
      return (overrides.settings ?? makeOkResponse('settings')) as unknown as Response;
    if (url.includes(API.ADMIN.ORCHESTRATION.MCP_TOOLS))
      return (overrides.tools ?? makeOkResponse('tools')) as unknown as Response;
    if (url.includes(API.ADMIN.ORCHESTRATION.MCP_RESOURCES))
      return (overrides.resources ?? makeOkResponse('resources')) as unknown as Response;
    if (url.includes(API.ADMIN.ORCHESTRATION.MCP_KEYS))
      return (overrides.keys ?? makeOkResponse('keys')) as unknown as Response;
    throw new Error(`Unexpected URL: ${url}`);
  });
}

/** Default parseApiResponse mock: returns appropriate data per _src tag */
function setupDefaultParseApiResponse(
  statTotals: { tools?: number; resources?: number; keys?: number } = {},
  settingsOverride?: unknown
) {
  vi.mocked(parseApiResponse).mockImplementation(async (res: Response) => {
    const src = (res as unknown as { _src?: string })._src;
    switch (src) {
      case 'settings':
        return (settingsOverride ?? { success: true, data: mockSettings }) as never;
      case 'tools':
        return {
          success: true,
          data: [],
          meta: { total: statTotals.tools ?? 3 },
        } as never;
      case 'resources':
        return {
          success: true,
          data: [],
          meta: { total: statTotals.resources ?? 5 },
        } as never;
      case 'keys':
        return {
          success: true,
          data: [],
          meta: { total: statTotals.keys ?? 2 },
        } as never;
      default:
        throw new Error(`Unknown _src: ${src}`);
    }
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
    setupDefaultServerFetch();
    setupDefaultParseApiResponse();

    render(await McpDashboardPage());

    expect(screen.getByRole('heading', { name: /MCP Server/i })).toBeInTheDocument();
    const breadcrumbLink = screen.getByRole('link', { name: 'AI Orchestration' });
    expect(breadcrumbLink).toHaveAttribute('href', '/admin/orchestration');
    expect(screen.getByText('MCP Server', { selector: 'span' })).toBeInTheDocument();
  });

  // 3. Settings happy path
  it('passes initialSettings to McpDashboard when settings fetch succeeds', async () => {
    setupDefaultServerFetch();
    setupDefaultParseApiResponse();

    render(await McpDashboardPage());

    const dashboard = screen.getByTestId('mcp-dashboard');
    expect(dashboard).toHaveAttribute('data-has-settings', 'true');
    expect(JSON.parse(dashboard.getAttribute('data-settings') ?? '{}')).toEqual(mockSettings);
  });

  // 4. Settings non-ok response
  it('passes initialSettings=null when settings fetch returns ok=false', async () => {
    setupDefaultServerFetch({ settings: makeNotOkResponse('settings') });
    setupDefaultParseApiResponse();

    render(await McpDashboardPage());

    expect(screen.getByTestId('mcp-dashboard')).toHaveAttribute('data-has-settings', 'false');
  });

  // 5. Settings body.success=false
  it('passes initialSettings=null when parseApiResponse returns success=false for settings', async () => {
    setupDefaultServerFetch();
    setupDefaultParseApiResponse(
      {},
      { success: false, error: { code: 'NOT_FOUND', message: 'Not found' } }
    );

    render(await McpDashboardPage());

    expect(screen.getByTestId('mcp-dashboard')).toHaveAttribute('data-has-settings', 'false');
  });

  // 6. Settings throws → initialSettings=null AND logger.error called
  it('passes initialSettings=null and calls logger.error when settings serverFetch throws', async () => {
    vi.mocked(serverFetch).mockImplementation(async (url: string) => {
      if (url.includes(API.ADMIN.ORCHESTRATION.MCP_SETTINGS)) throw new Error('network failure');
      if (url.includes(API.ADMIN.ORCHESTRATION.MCP_TOOLS))
        return makeOkResponse('tools') as unknown as Response;
      if (url.includes(API.ADMIN.ORCHESTRATION.MCP_RESOURCES))
        return makeOkResponse('resources') as unknown as Response;
      if (url.includes(API.ADMIN.ORCHESTRATION.MCP_KEYS))
        return makeOkResponse('keys') as unknown as Response;
      throw new Error(`Unexpected URL: ${url}`);
    });
    setupDefaultParseApiResponse();

    render(await McpDashboardPage());

    expect(screen.getByTestId('mcp-dashboard')).toHaveAttribute('data-has-settings', 'false');
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.stringContaining('MCP dashboard: settings fetch failed'),
      expect.any(Error)
    );
  });

  // 7. Stats happy path
  it('passes correct stats to McpDashboard when all stat fetches succeed', async () => {
    setupDefaultServerFetch();
    setupDefaultParseApiResponse({ tools: 7, resources: 12, keys: 4 });

    render(await McpDashboardPage());

    const dashboard = screen.getByTestId('mcp-dashboard');
    expect(dashboard).toHaveAttribute('data-tools', '7');
    expect(dashboard).toHaveAttribute('data-resources', '12');
    expect(dashboard).toHaveAttribute('data-keys', '4');
  });

  // 8. Stats partial failure: tools endpoint returns ok=false
  it('sets stats.tools=0 when MCP_TOOLS returns ok=false, other stats correct', async () => {
    setupDefaultServerFetch({ tools: makeNotOkResponse('tools') });
    setupDefaultParseApiResponse({ tools: 9, resources: 5, keys: 2 });

    render(await McpDashboardPage());

    const dashboard = screen.getByTestId('mcp-dashboard');
    expect(dashboard).toHaveAttribute('data-tools', '0');
    expect(dashboard).toHaveAttribute('data-resources', '5');
    expect(dashboard).toHaveAttribute('data-keys', '2');
  });

  // 9. Stats non-number meta.total
  it('sets stats.tools=0 when MCP_TOOLS meta.total is non-number, other stats correct', async () => {
    setupDefaultServerFetch();
    vi.mocked(parseApiResponse).mockImplementation(async (res: Response) => {
      const src = (res as unknown as { _src?: string })._src;
      switch (src) {
        case 'settings':
          return { success: true, data: mockSettings } as never;
        case 'tools':
          return { success: true, data: [], meta: { total: 'five' } } as never;
        case 'resources':
          return { success: true, data: [], meta: { total: 5 } } as never;
        case 'keys':
          return { success: true, data: [], meta: { total: 2 } } as never;
        default:
          throw new Error(`Unknown _src: ${src}`);
      }
    });

    render(await McpDashboardPage());

    const dashboard = screen.getByTestId('mcp-dashboard');
    expect(dashboard).toHaveAttribute('data-tools', '0');
    expect(dashboard).toHaveAttribute('data-resources', '5');
    expect(dashboard).toHaveAttribute('data-keys', '2');
  });

  // 10. Stats all fetches reject → outer catch → zeros; no logger.error (settings succeeds)
  it('returns stats={tools:0,resources:0,keys:0} and does NOT call logger.error when all stat fetches throw', async () => {
    vi.mocked(serverFetch).mockImplementation(async (url: string) => {
      if (url.includes(API.ADMIN.ORCHESTRATION.MCP_SETTINGS))
        return makeOkResponse('settings') as unknown as Response;
      // All stat endpoints throw
      throw new Error('stat fetch network failure');
    });
    setupDefaultParseApiResponse();

    render(await McpDashboardPage());

    const dashboard = screen.getByTestId('mcp-dashboard');
    expect(dashboard).toHaveAttribute('data-tools', '0');
    expect(dashboard).toHaveAttribute('data-resources', '0');
    expect(dashboard).toHaveAttribute('data-keys', '0');
    // getStats outer catch does NOT log; settings succeeded so no logger.error either
    expect(vi.mocked(logger.error)).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });

  // 11. Full failure: settings throws AND all stat fetches throw
  it('renders without throwing when both settings and all stat fetches fail', async () => {
    vi.mocked(serverFetch).mockRejectedValue(new Error('total network failure'));

    render(await McpDashboardPage());

    const dashboard = screen.getByTestId('mcp-dashboard');
    expect(dashboard).toHaveAttribute('data-has-settings', 'false');
    expect(dashboard).toHaveAttribute('data-tools', '0');
    expect(dashboard).toHaveAttribute('data-resources', '0');
    expect(dashboard).toHaveAttribute('data-keys', '0');
    // Settings threw → logger.error called once for settings
    expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.stringContaining('MCP dashboard: settings fetch failed'),
      expect.any(Error)
    );
  });
});
