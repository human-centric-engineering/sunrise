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

vi.mock('@/components/admin/orchestration/mcp/mcp-keys-list', () => ({
  McpKeysList: ({ initialKeys }: { initialKeys: unknown[] }) => (
    <div data-testid="mcp-keys-list" data-count={initialKeys.length} />
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

import McpKeysPage, { metadata } from '@/app/admin/orchestration/mcp/keys/page';
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { API } from '@/lib/api/endpoints';

type ApiKeyRow = {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
};

function makeKey(i: number): ApiKeyRow {
  return { id: `key-${i}`, name: `Key ${i}`, keyPrefix: `sk_${i}`, createdAt: '2024-01-01' };
}

describe('McpKeysPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 1. Metadata
  it('has correct title and description metadata', () => {
    expect(metadata.title).toBe('MCP API Keys · AI Orchestration');
    expect(metadata.description).toBe('Manage API keys for MCP client authentication.');
  });

  // 2. serverFetch called with correct URL
  it('calls serverFetch with MCP_KEYS endpoint and pagination query params', async () => {
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: [] } as never);

    render(await McpKeysPage());

    expect(serverFetch).toHaveBeenCalledWith(
      expect.stringContaining(API.ADMIN.ORCHESTRATION.MCP_KEYS)
    );
    expect(serverFetch).toHaveBeenCalledWith(expect.stringContaining('?page=1&limit=50'));
  });

  // 3. Happy path — passes fetched data to McpKeysList
  it('passes fetched keys to McpKeysList on happy path', async () => {
    const mockKeys: ApiKeyRow[] = [makeKey(1), makeKey(2)];

    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: mockKeys } as never);

    render(await McpKeysPage());

    const list = screen.getByTestId('mcp-keys-list');
    expect(list).toHaveAttribute('data-count', '2');
  });

  // 4. res.ok === false — passes empty array
  it('passes empty array to McpKeysList when response is not ok', async () => {
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);

    render(await McpKeysPage());

    const list = screen.getByTestId('mcp-keys-list');
    expect(list).toHaveAttribute('data-count', '0');
    expect(parseApiResponse).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });

  // 5. body.success === false — passes empty array
  it('passes empty array to McpKeysList when body.success is false', async () => {
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'fail' },
    } as never);

    render(await McpKeysPage());

    const list = screen.getByTestId('mcp-keys-list');
    expect(list).toHaveAttribute('data-count', '0');
  });

  // 6. serverFetch throws — empty array + logger.error called
  it('passes empty array and logs error when serverFetch throws', async () => {
    const fetchError = new Error('Network failure');
    vi.mocked(serverFetch).mockRejectedValue(fetchError);

    render(await McpKeysPage());

    const list = screen.getByTestId('mcp-keys-list');
    expect(list).toHaveAttribute('data-count', '0');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('MCP keys page'), fetchError);
  });

  // 7. Breadcrumb: AI Orchestration
  it('renders breadcrumb link "AI Orchestration" with correct href', async () => {
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: [] } as never);

    render(await McpKeysPage());

    const link = screen.getByRole('link', { name: /AI Orchestration/i });
    expect(link).toHaveAttribute('href', '/admin/orchestration');
  });

  // 8. Breadcrumb: MCP Server
  it('renders breadcrumb link "MCP Server" with correct href', async () => {
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: [] } as never);

    render(await McpKeysPage());

    const link = screen.getByRole('link', { name: /MCP Server/i });
    expect(link).toHaveAttribute('href', '/admin/orchestration/mcp');
  });

  // 9. h1 contains "API Keys"
  it('renders h1 heading containing "API Keys"', async () => {
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: [] } as never);

    render(await McpKeysPage());

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('API Keys');
  });

  // 10. McpInfoModal rendered with correct title prop
  it('renders McpInfoModal with title="MCP API Keys"', async () => {
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: [] } as never);

    render(await McpKeysPage());

    const modal = screen.getByTestId('mcp-info-modal');
    expect(modal).toHaveAttribute('data-title', 'MCP API Keys');
  });

  // 11. Subtitle paragraph rendered
  it('renders subtitle paragraph about MCP client API keys', async () => {
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: [] } as never);

    render(await McpKeysPage());

    expect(screen.getByText(/Each MCP client needs an API key/i)).toBeInTheDocument();
  });

  // 12. Large dataset (50 items) passes through in full
  it('passes full 50-item array to McpKeysList when response contains max page size', async () => {
    const largeKeys = Array.from({ length: 50 }, (_, i) => makeKey(i + 1));

    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: largeKeys } as never);

    render(await McpKeysPage());

    const list = screen.getByTestId('mcp-keys-list');
    expect(list).toHaveAttribute('data-count', '50');
  });
});
