import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/components/admin/orchestration/mcp/mcp-tools-list', () => ({
  McpToolsList: ({
    initialTools,
    capabilities,
  }: {
    initialTools: unknown[];
    capabilities: unknown[];
  }) => (
    <div
      data-testid="mcp-tools-list"
      data-tools={initialTools.length}
      data-capabilities={capabilities.length}
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

import React from 'react';
import McpToolsPage, { metadata } from '@/app/admin/orchestration/mcp/tools/page';
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { API } from '@/lib/api/endpoints';

const mockTools = [
  {
    id: 'tool-1',
    capabilityId: 'cap-1',
    isEnabled: true,
    customName: null,
    customDescription: null,
    rateLimitPerKey: null,
    capability: { id: 'cap-1', name: 'Search', slug: 'search', description: '', category: 'data' },
  },
  {
    id: 'tool-2',
    capabilityId: 'cap-2',
    isEnabled: false,
    customName: 'Custom Name',
    customDescription: null,
    rateLimitPerKey: 10,
    capability: { id: 'cap-2', name: 'Email', slug: 'email', description: '', category: 'comms' },
  },
];

const mockCapabilities = [
  { id: 'cap-1', name: 'Search', slug: 'search', description: '', category: 'data' },
  { id: 'cap-2', name: 'Email', slug: 'email', description: '', category: 'comms' },
  { id: 'cap-3', name: 'Webhook', slug: 'webhook', description: '', category: 'integration' },
];

/** Build a URL-dispatching serverFetch mock. */
function makeServerFetchMock({
  toolsOk = true,
  capabilitiesOk = true,
  toolsThrows = false,
  capabilitiesThrows = false,
}: {
  toolsOk?: boolean;
  capabilitiesOk?: boolean;
  toolsThrows?: boolean;
  capabilitiesThrows?: boolean;
} = {}) {
  return vi.mocked(serverFetch).mockImplementation(async (url: string) => {
    if (url.includes(API.ADMIN.ORCHESTRATION.MCP_TOOLS)) {
      if (toolsThrows) throw new Error('tools network failure');
      return { ok: toolsOk, _src: 'tools' } as unknown as Response;
    }
    if (url.includes(API.ADMIN.ORCHESTRATION.CAPABILITIES)) {
      if (capabilitiesThrows) throw new Error('capabilities network failure');
      return { ok: capabilitiesOk, _src: 'capabilities' } as unknown as Response;
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
}

/** Build a URL-dispatching parseApiResponse mock keyed off `_src` marker. */
function makeParseApiResponseMock({
  toolsSuccess = true,
  capabilitiesSuccess = true,
}: {
  toolsSuccess?: boolean;
  capabilitiesSuccess?: boolean;
} = {}) {
  return vi.mocked(parseApiResponse).mockImplementation(async (res: Response) => {
    const src = (res as unknown as { _src: string })._src;
    if (src === 'tools') {
      return toolsSuccess
        ? { success: true, data: mockTools }
        : { success: false, error: { code: 'ERR', message: 'fail' } };
    }
    if (src === 'capabilities') {
      return capabilitiesSuccess
        ? { success: true, data: mockCapabilities }
        : { success: false, error: { code: 'ERR', message: 'fail' } };
    }
    throw new Error(`parseApiResponse: unknown _src on response`);
  });
}

describe('McpToolsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 1. Metadata
  it('has correct title and description metadata', () => {
    expect(metadata.title).toBe('MCP Tools · AI Orchestration');
    expect(metadata.description).toBe('Manage which capabilities are exposed to MCP clients.');
  });

  // 2. Renders heading and description paragraph
  it('renders "Exposed Tools" heading and description paragraph', async () => {
    makeServerFetchMock();
    makeParseApiResponseMock();

    render(await McpToolsPage());

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Exposed Tools');
    expect(screen.getByText(/Pick which of your orchestration capabilities/i)).toBeInTheDocument();
  });

  // 3. Renders breadcrumbs
  it('renders breadcrumb links to /admin/orchestration and /admin/orchestration/mcp', async () => {
    makeServerFetchMock();
    makeParseApiResponseMock();

    render(await McpToolsPage());

    const orchestrationLink = screen.getByRole('link', { name: /AI Orchestration/i });
    expect(orchestrationLink).toHaveAttribute('href', '/admin/orchestration');

    const mcpLink = screen.getByRole('link', { name: /MCP Server/i });
    expect(mcpLink).toHaveAttribute('href', '/admin/orchestration/mcp');
  });

  // 4. Happy path: tools passed to McpToolsList
  it('passes fetched tools array to McpToolsList initialTools prop', async () => {
    makeServerFetchMock();
    makeParseApiResponseMock();

    render(await McpToolsPage());

    const list = screen.getByTestId('mcp-tools-list');
    expect(list).toHaveAttribute('data-tools', String(mockTools.length));
  });

  // 5. Happy path: capabilities passed to McpToolsList
  it('passes fetched capabilities array to McpToolsList capabilities prop', async () => {
    makeServerFetchMock();
    makeParseApiResponseMock();

    render(await McpToolsPage());

    const list = screen.getByTestId('mcp-tools-list');
    expect(list).toHaveAttribute('data-capabilities', String(mockCapabilities.length));
  });

  // 6. Tools fetch res.ok === false: initialTools=[]
  it('passes initialTools=[] when tools fetch returns res.ok false, capabilities still work', async () => {
    makeServerFetchMock({ toolsOk: false });
    // parseApiResponse only called for capabilities (tools short-circuits on !res.ok)
    vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: mockCapabilities });

    render(await McpToolsPage());

    const list = screen.getByTestId('mcp-tools-list');
    expect(list).toHaveAttribute('data-tools', '0');
    expect(list).toHaveAttribute('data-capabilities', String(mockCapabilities.length));
  });

  // 7. Capabilities fetch res.ok === false: capabilities=[]
  it('passes capabilities=[] when capabilities fetch returns res.ok false, tools still work', async () => {
    makeServerFetchMock({ capabilitiesOk: false });
    // parseApiResponse only called for tools (capabilities short-circuits on !res.ok)
    vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: mockTools });

    render(await McpToolsPage());

    const list = screen.getByTestId('mcp-tools-list');
    expect(list).toHaveAttribute('data-tools', String(mockTools.length));
    expect(list).toHaveAttribute('data-capabilities', '0');
  });

  // 8. Tools parseApiResponse returns success: false: initialTools=[]
  it('passes initialTools=[] when tools parseApiResponse returns success: false', async () => {
    makeServerFetchMock();
    makeParseApiResponseMock({ toolsSuccess: false });

    render(await McpToolsPage());

    const list = screen.getByTestId('mcp-tools-list');
    expect(list).toHaveAttribute('data-tools', '0');
  });

  // 9. Capabilities parseApiResponse returns success: false: capabilities=[]
  it('passes capabilities=[] when capabilities parseApiResponse returns success: false', async () => {
    makeServerFetchMock();
    makeParseApiResponseMock({ capabilitiesSuccess: false });

    render(await McpToolsPage());

    const list = screen.getByTestId('mcp-tools-list');
    expect(list).toHaveAttribute('data-capabilities', '0');
  });

  // 10. Tools fetch throws: initialTools=[] AND correct logger.error message
  it('passes initialTools=[] and calls logger.error with tools message when tools fetch throws', async () => {
    const toolsError = new Error('tools network failure');

    vi.mocked(serverFetch).mockImplementation(async (url: string) => {
      if (url.includes(API.ADMIN.ORCHESTRATION.MCP_TOOLS)) throw toolsError;
      return { ok: true, _src: 'capabilities' } as unknown as Response;
    });
    vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: mockCapabilities });

    render(await McpToolsPage());

    const list = screen.getByTestId('mcp-tools-list');
    expect(list).toHaveAttribute('data-tools', '0');
    expect(logger.error).toHaveBeenCalledWith('MCP tools page: fetch failed', toolsError);
  });

  // 11. Capabilities fetch throws: capabilities=[] AND correct logger.error message
  it('passes capabilities=[] and calls logger.error with capabilities message when capabilities fetch throws', async () => {
    const capabilitiesError = new Error('capabilities network failure');

    vi.mocked(serverFetch).mockImplementation(async (url: string) => {
      if (url.includes(API.ADMIN.ORCHESTRATION.CAPABILITIES)) throw capabilitiesError;
      return { ok: true, _src: 'tools' } as unknown as Response;
    });
    vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: mockTools });

    render(await McpToolsPage());

    const list = screen.getByTestId('mcp-tools-list');
    expect(list).toHaveAttribute('data-capabilities', '0');
    expect(logger.error).toHaveBeenCalledWith(
      'MCP tools page: capabilities fetch failed',
      capabilitiesError
    );
  });

  // 12. Both fetches called — serverFetch invoked with both URLs
  it('calls serverFetch with both MCP_TOOLS and CAPABILITIES URLs', async () => {
    makeServerFetchMock();
    makeParseApiResponseMock();

    await McpToolsPage();

    const calls = vi.mocked(serverFetch).mock.calls.map(([url]) => url);
    expect(calls.some((url) => url.includes(API.ADMIN.ORCHESTRATION.MCP_TOOLS))).toBe(true);
    expect(calls.some((url) => url.includes(API.ADMIN.ORCHESTRATION.CAPABILITIES))).toBe(true);
  });

  // 13. McpInfoModal rendered with title="MCP Tools"
  it('renders McpInfoModal with title="MCP Tools"', async () => {
    makeServerFetchMock();
    makeParseApiResponseMock();

    render(await McpToolsPage());

    const modal = screen.getByTestId('mcp-info-modal');
    expect(modal).toHaveAttribute('data-title', 'MCP Tools');
  });
});
