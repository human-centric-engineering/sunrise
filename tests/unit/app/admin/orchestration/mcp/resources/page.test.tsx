import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/components/admin/orchestration/mcp/mcp-resources-list', () => ({
  McpResourcesList: ({ initialResources }: { initialResources: unknown[] }) => (
    <div data-testid="mcp-resources-list" data-count={initialResources.length} />
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

import McpResourcesPage, { metadata } from '@/app/admin/orchestration/mcp/resources/page';
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { API } from '@/lib/api/endpoints';

const mockResources = [
  { id: '1', name: 'Resource A' },
  { id: '2', name: 'Resource B' },
];

function makeMockResponse(ok: boolean) {
  return { ok, status: ok ? 200 : 500 } as Response;
}

describe('McpResourcesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 1. Metadata
  it('exports correct metadata title and description', () => {
    expect(metadata.title).toBe('MCP Resources · AI Orchestration');
    expect(metadata.description).toBe('Manage data endpoints exposed to MCP clients.');
  });

  // 2. serverFetch called with correct URL
  it('calls serverFetch with MCP_RESOURCES URL and pagination params', async () => {
    vi.mocked(serverFetch).mockResolvedValue(makeMockResponse(true));
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: mockResources,
    });

    render(await McpResourcesPage());

    expect(serverFetch).toHaveBeenCalledOnce();
    const [calledUrl] = vi.mocked(serverFetch).mock.calls[0];
    expect(String(calledUrl)).toContain(API.ADMIN.ORCHESTRATION.MCP_RESOURCES);
    expect(String(calledUrl)).toContain('?page=1&limit=50');
  });

  // 3. Happy path: passes fetched resources to McpResourcesList
  it('passes fetched resources to McpResourcesList on success', async () => {
    vi.mocked(serverFetch).mockResolvedValue(makeMockResponse(true));
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: mockResources,
    });

    render(await McpResourcesPage());

    const list = screen.getByTestId('mcp-resources-list');
    expect(list).toHaveAttribute('data-count', String(mockResources.length));
  });

  // 4. res.ok === false: passes empty array
  it('passes empty array to McpResourcesList when res.ok is false', async () => {
    vi.mocked(serverFetch).mockResolvedValue(makeMockResponse(false));

    render(await McpResourcesPage());

    const list = screen.getByTestId('mcp-resources-list');
    expect(list).toHaveAttribute('data-count', '0');
  });

  // 5. body.success === false: passes empty array
  it('passes empty array to McpResourcesList when body.success is false', async () => {
    vi.mocked(serverFetch).mockResolvedValue(makeMockResponse(true));
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Something went wrong' },
    });

    render(await McpResourcesPage());

    const list = screen.getByTestId('mcp-resources-list');
    expect(list).toHaveAttribute('data-count', '0');
  });

  // 6. serverFetch throws: passes empty array and calls logger.error
  it('passes empty array and logs error when serverFetch throws', async () => {
    const fetchError = new Error('Network failure');
    vi.mocked(serverFetch).mockRejectedValue(fetchError);

    render(await McpResourcesPage());

    const list = screen.getByTestId('mcp-resources-list');
    expect(list).toHaveAttribute('data-count', '0');
    expect(logger.error).toHaveBeenCalledOnce();
    expect(vi.mocked(logger.error).mock.calls[0][0]).toContain('MCP resources page');
  });

  // 7. Renders heading "Resources"
  it('renders the Resources heading', async () => {
    vi.mocked(serverFetch).mockResolvedValue(makeMockResponse(true));
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: [],
    });

    render(await McpResourcesPage());

    expect(screen.getByRole('heading', { name: /Resources/i })).toBeInTheDocument();
  });

  // 8. Renders breadcrumb links with correct hrefs
  it('renders breadcrumb links with correct hrefs', async () => {
    vi.mocked(serverFetch).mockResolvedValue(makeMockResponse(true));
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: [],
    });

    render(await McpResourcesPage());

    const orchestrationLink = screen.getByRole('link', { name: /AI Orchestration/i });
    expect(orchestrationLink).toHaveAttribute('href', '/admin/orchestration');

    const mcpLink = screen.getByRole('link', { name: /MCP Server/i });
    expect(mcpLink).toHaveAttribute('href', '/admin/orchestration/mcp');
  });

  // 9. Renders McpInfoModal with title="MCP Resources"
  it('renders McpInfoModal with title "MCP Resources"', async () => {
    vi.mocked(serverFetch).mockResolvedValue(makeMockResponse(true));
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: [],
    });

    render(await McpResourcesPage());

    const modal = screen.getByTestId('mcp-info-modal');
    expect(modal).toHaveAttribute('data-title', 'MCP Resources');
  });
});
