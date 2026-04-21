import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
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
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
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
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: [],
      meta: { total: 0 },
    } as never);

    // Act
    render(await McpAuditPage());

    // Assert
    expect(screen.getByRole('heading', { name: 'Audit Log' })).toBeInTheDocument();
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });

  // Test 3: Breadcrumb link to /admin/orchestration
  it('renders breadcrumb link to /admin/orchestration with text "AI Orchestration"', async () => {
    // Arrange
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: [],
      meta: { total: 0 },
    } as never);

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
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: [],
      meta: { total: 0 },
    } as never);

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
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: [],
      meta: { total: 0 },
    } as never);

    // Act
    render(await McpAuditPage());

    // Assert
    expect(serverFetch).toHaveBeenCalledWith(
      expect.stringContaining(API.ADMIN.ORCHESTRATION.MCP_AUDIT)
    );
    expect(serverFetch).toHaveBeenCalledWith(expect.stringContaining('?page=1&limit=50'));
  });

  // Test 6: Passes items array to McpAuditLog
  it('passes items from successful API response to McpAuditLog initialEntries', async () => {
    // Arrange
    const mockItems = [
      { id: '1', method: 'tools/list' },
      { id: '2', method: 'tools/call' },
    ];
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: mockItems,
      meta: { total: 2 },
    } as never);

    // Act
    render(await McpAuditPage());

    // Assert
    const auditLog = screen.getByTestId('mcp-audit-log');
    expect(auditLog).toHaveAttribute('data-count', '2');
  });

  // Test 7: Subtitle does NOT include "total entries" when total === 0
  it('does not include "total entries" text in subtitle when total is 0', async () => {
    // Arrange
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: [],
      meta: { total: 0 },
    } as never);

    // Act
    render(await McpAuditPage());

    // Assert
    expect(screen.queryByText(/total entries/)).not.toBeInTheDocument();
  });

  // Test 8: Subtitle includes "42 total entries." when meta.total === 42
  it('includes " 42 total entries." in subtitle when meta.total is 42', async () => {
    // Arrange
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: [],
      meta: { total: 42 },
    } as never);

    // Act
    render(await McpAuditPage());

    // Assert
    expect(screen.getByText(/42 total entries\./)).toBeInTheDocument();
  });

  // Test 9: When res.ok === false, renders McpAuditLog with empty array
  it('renders McpAuditLog with empty initialEntries when res.ok is false', async () => {
    // Arrange
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);

    // Act
    render(await McpAuditPage());

    // Assert
    const auditLog = screen.getByTestId('mcp-audit-log');
    expect(auditLog).toHaveAttribute('data-count', '0');
    expect(parseApiResponse).not.toHaveBeenCalled();
  });

  // Test 10: When parseApiResponse returns { success: false }, renders empty array
  it('renders McpAuditLog with empty initialEntries when parseApiResponse returns success: false', async () => {
    // Arrange
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { code: 'FETCH_ERROR', message: 'Something went wrong' },
    } as never);

    // Act
    render(await McpAuditPage());

    // Assert
    const auditLog = screen.getByTestId('mcp-audit-log');
    expect(auditLog).toHaveAttribute('data-count', '0');
    expect(screen.queryByText(/total entries/)).not.toBeInTheDocument();
  });

  // Test 11: When serverFetch throws, renders empty array and calls logger.error
  it('renders McpAuditLog with empty initialEntries and calls logger.error when serverFetch throws', async () => {
    // Arrange
    const fetchError = new Error('Network failure');
    vi.mocked(serverFetch).mockRejectedValue(fetchError);

    // Act
    render(await McpAuditPage());

    // Assert
    const auditLog = screen.getByTestId('mcp-audit-log');
    expect(auditLog).toHaveAttribute('data-count', '0');
    expect(logger.error).toHaveBeenCalledWith('MCP audit page: fetch failed', fetchError);
  });

  // Test 12 (bonus): meta.total as non-number string defaults to 0
  it('defaults total to 0 when meta.total is a non-numeric string', async () => {
    // Arrange
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: [],
      meta: { total: 'five' },
    } as never);

    // Act
    render(await McpAuditPage());

    // Assert
    expect(screen.queryByText(/total entries/)).not.toBeInTheDocument();
  });
});
