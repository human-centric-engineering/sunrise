// @vitest-environment happy-dom

import React from 'react';
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
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';
import { logger } from '@/lib/logging';
import { API } from '@/lib/api/endpoints';

const mockResources = [
  { id: '1', name: 'Resource A' },
  { id: '2', name: 'Resource B' },
];

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
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(mockResources));

    render(await McpResourcesPage());

    expect(serverFetch).toHaveBeenCalledOnce();
    const [calledUrl] = vi.mocked(serverFetch).mock.calls[0];
    expect(String(calledUrl)).toContain(API.ADMIN.ORCHESTRATION.MCP_RESOURCES);
    expect(String(calledUrl)).toContain('?page=1&limit=50');
  });

  // 3. Happy path: passes fetched resources to McpResourcesList
  it('passes fetched resources to McpResourcesList on success', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(mockResources));

    render(await McpResourcesPage());

    const list = screen.getByTestId('mcp-resources-list');
    expect(list).toHaveAttribute('data-count', String(mockResources.length));
  });

  // A genuinely empty list is still an empty list
  it('passes an empty array to the list when there are no resources', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    render(await McpResourcesPage());

    expect(screen.getByTestId('mcp-resources-list')).toHaveAttribute('data-count', '0');
  });

  // A failed load is a failure, not an empty list (#518)
  it('throws to the error boundary when the resources API answers 500', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    await expect(McpResourcesPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('throws when the resources API answers success:false', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(200));

    await expect(McpResourcesPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('logs and throws when serverFetch rejects', async () => {
    const fetchError = new Error('Network failure');
    vi.mocked(serverFetch).mockRejectedValue(fetchError);

    await expect(McpResourcesPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), fetchError, expect.any(Object));
  });

  // 7. Renders heading "Resources"
  it('renders the Resources heading', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    render(await McpResourcesPage());

    expect(screen.getByRole('heading', { name: /Resources/i })).toBeInTheDocument();
  });

  // 8. Renders breadcrumb links with correct hrefs
  it('renders breadcrumb links with correct hrefs', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    render(await McpResourcesPage());

    const orchestrationLink = screen.getByRole('link', { name: /AI Orchestration/i });
    expect(orchestrationLink).toHaveAttribute('href', '/admin/orchestration');

    const mcpLink = screen.getByRole('link', { name: /MCP Server/i });
    expect(mcpLink).toHaveAttribute('href', '/admin/orchestration/mcp');
  });

  // 9. Renders McpInfoModal with title="MCP Resources"
  it('renders McpInfoModal with title "MCP Resources"', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    render(await McpResourcesPage());

    const modal = screen.getByTestId('mcp-info-modal');
    expect(modal).toHaveAttribute('data-title', 'MCP Resources');
  });
});
