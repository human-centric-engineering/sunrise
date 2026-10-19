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

vi.mock('@/components/admin/orchestration/mcp/mcp-audit-log', () => ({
  McpAuditLog: ({ initialEntries }: { initialEntries: unknown[] }) => (
    <div data-testid="mcp-audit-log" data-count={initialEntries.length} />
  ),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

import React from 'react';
import McpAuditPage, { metadata } from '@/app/admin/orchestration/mcp/audit/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';
import { logger } from '@/lib/logging';
import { API } from '@/lib/api/endpoints';

describe('McpAuditPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Test 1: Metadata export
  it('has correct metadata title and description', () => {
    expect(metadata.title).toBe('MCP Audit Log · AI Orchestration');
    expect(metadata.description).toBe('View all MCP server operations.');
  });

  // Test 2: Renders heading and breadcrumb nav
  it('renders heading "Audit Log" and breadcrumb nav', async () => {
    // Arrange
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([], { total: 0 }));

    // Act
    render(await McpAuditPage());

    // Assert
    expect(screen.getByRole('heading', { name: 'Audit Log' })).toBeInTheDocument();
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });

  // Test 3: Breadcrumb link to /admin/orchestration
  it('renders breadcrumb link to /admin/orchestration with text "AI Orchestration"', async () => {
    // Arrange
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([], { total: 0 }));

    // Act
    render(await McpAuditPage());

    // Assert
    const link = screen.getByRole('link', { name: /AI Orchestration/ });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/admin/orchestration');
  });

  // Test 4: Breadcrumb link to /admin/orchestration/mcp
  it('renders breadcrumb link to /admin/orchestration/mcp with text "MCP Server"', async () => {
    // Arrange
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([], { total: 0 }));

    // Act
    render(await McpAuditPage());

    // Assert
    const link = screen.getByRole('link', { name: /MCP Server/ });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/admin/orchestration/mcp');
  });

  // Test 5: serverFetch called with correct URL
  it('calls serverFetch with MCP_AUDIT endpoint and pagination params', async () => {
    // Arrange
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([], { total: 0 }));

    // Act
    render(await McpAuditPage());

    // Assert
    expect(vi.mocked(serverFetch).mock.calls[0][0]).toBe(
      `${API.ADMIN.ORCHESTRATION.MCP_AUDIT}?page=1&limit=50`
    );
  });

  // Test 6: Passes items array to McpAuditLog
  it('passes items from successful API response to McpAuditLog initialEntries', async () => {
    // Arrange
    const mockItems = [
      { id: '1', method: 'tools/list' },
      { id: '2', method: 'tools/call' },
    ];
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(mockItems, { total: 2 }));

    // Act
    render(await McpAuditPage());

    // Assert
    const auditLog = screen.getByTestId('mcp-audit-log');
    expect(auditLog).toHaveAttribute('data-count', '2');
  });

  // Test 7: Subtitle does NOT include "total entries" when total === 0
  it('does not include "total entries" text in subtitle when total is 0', async () => {
    // Arrange
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([], { total: 0 }));

    // Act
    render(await McpAuditPage());

    // Assert
    expect(screen.queryByText(/total entries/)).not.toBeInTheDocument();
  });

  // Test 8: Subtitle includes "42 total entries." when meta.total === 42
  it('includes " 42 total entries." in subtitle when meta.total is 42', async () => {
    // Arrange
    vi.mocked(serverFetch).mockResolvedValue(
      apiSuccess([], { total: 42, page: 1, limit: 50, totalPages: 1 })
    );

    // Act
    render(await McpAuditPage());

    // Assert
    expect(screen.getByText(/42 total entries\./)).toBeInTheDocument();
  });

  // Tests 9–11: a failed load is a failure, not an empty log (#518)
  it('throws to the error boundary when the audit API answers 500', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    await expect(McpAuditPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('throws when the audit API answers success:false', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(200));

    await expect(McpAuditPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('logs and throws when serverFetch rejects', async () => {
    const fetchError = new Error('Network failure');
    vi.mocked(serverFetch).mockRejectedValue(fetchError);

    await expect(McpAuditPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), fetchError, expect.any(Object));
  });

  // Test 12 (bonus): meta.total as non-number string defaults to 0
  it('defaults total to 0 when meta.total is a non-numeric string', async () => {
    // Arrange
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([], { total: 'five' }));

    // Act
    render(await McpAuditPage());

    // Assert
    expect(screen.queryByText(/total entries/)).not.toBeInTheDocument();
  });
});
