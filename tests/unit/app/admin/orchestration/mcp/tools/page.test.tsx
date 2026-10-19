// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
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
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';
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

/**
 * Answer each endpoint the page reads with a fresh Response per call.
 * Pass a factory to fail one of them.
 */
function makeServerFetchMock({
  tools = () => apiSuccess(mockTools),
  capabilities = () => apiSuccess(mockCapabilities),
}: {
  tools?: () => Response;
  capabilities?: () => Response;
} = {}) {
  return vi.mocked(serverFetch).mockImplementation(async (url: string) => {
    if (url.includes(API.ADMIN.ORCHESTRATION.MCP_TOOLS)) return tools();
    if (url.includes(API.ADMIN.ORCHESTRATION.CAPABILITIES)) return capabilities();
    throw new Error(`Unexpected URL: ${url}`);
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

    render(await McpToolsPage());

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Exposed Tools');
    expect(screen.getByText(/Pick which of your orchestration capabilities/i)).toBeInTheDocument();
  });

  // 3. Renders breadcrumbs
  it('renders breadcrumb links to /admin/orchestration and /admin/orchestration/mcp', async () => {
    makeServerFetchMock();

    render(await McpToolsPage());

    const orchestrationLink = screen.getByRole('link', { name: /AI Orchestration/i });
    expect(orchestrationLink).toHaveAttribute('href', '/admin/orchestration');

    const mcpLink = screen.getByRole('link', { name: /MCP Server/i });
    expect(mcpLink).toHaveAttribute('href', '/admin/orchestration/mcp');
  });

  // 4. Happy path: tools passed to McpToolsList
  it('passes fetched tools array to McpToolsList initialTools prop', async () => {
    makeServerFetchMock();

    render(await McpToolsPage());

    const list = screen.getByTestId('mcp-tools-list');
    expect(list).toHaveAttribute('data-tools', String(mockTools.length));
  });

  // 5. Happy path: capabilities passed to McpToolsList
  it('passes fetched capabilities array to McpToolsList capabilities prop', async () => {
    makeServerFetchMock();

    render(await McpToolsPage());

    const list = screen.getByTestId('mcp-tools-list');
    expect(list).toHaveAttribute('data-capabilities', String(mockCapabilities.length));
  });

  // 6–11. Both lists are required: a failed load throws to the error
  // boundary rather than an empty table or an empty "add tool" picker (#518).
  it('throws to the error boundary when the tools API answers 500', async () => {
    makeServerFetchMock({ tools: () => apiFailure(500) });

    await expect(McpToolsPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('throws when the capabilities API answers 500, rather than offering no capabilities', async () => {
    makeServerFetchMock({ capabilities: () => apiFailure(500) });

    await expect(McpToolsPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('throws when the tools API answers success:false', async () => {
    makeServerFetchMock({ tools: () => apiFailure(200) });

    await expect(McpToolsPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('logs and throws when the tools fetch rejects', async () => {
    const toolsError = new Error('tools network failure');
    vi.mocked(serverFetch).mockImplementation(async (url: string) => {
      if (url.includes(API.ADMIN.ORCHESTRATION.MCP_TOOLS)) throw toolsError;
      return apiSuccess(mockCapabilities);
    });

    await expect(McpToolsPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), toolsError, expect.any(Object));
  });

  it('renders an empty tools list as an empty list', async () => {
    makeServerFetchMock({ tools: () => apiSuccess([]) });

    render(await McpToolsPage());

    const list = screen.getByTestId('mcp-tools-list');
    expect(list).toHaveAttribute('data-tools', '0');
    expect(list).toHaveAttribute('data-capabilities', String(mockCapabilities.length));
  });

  // 12. Both fetches called — serverFetch invoked with both URLs
  it('calls serverFetch with both MCP_TOOLS and CAPABILITIES URLs', async () => {
    makeServerFetchMock();

    await McpToolsPage();

    const calls = vi.mocked(serverFetch).mock.calls.map(([url]) => url);
    expect(calls.some((url) => url.includes(API.ADMIN.ORCHESTRATION.MCP_TOOLS))).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
    expect(calls.some((url) => url.includes(API.ADMIN.ORCHESTRATION.CAPABILITIES))).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
  });

  // 13. McpInfoModal rendered with title="MCP Tools"
  it('renders McpInfoModal with title="MCP Tools"', async () => {
    makeServerFetchMock();

    render(await McpToolsPage());

    const modal = screen.getByTestId('mcp-info-modal');
    expect(modal).toHaveAttribute('data-title', 'MCP Tools');
  });
});
