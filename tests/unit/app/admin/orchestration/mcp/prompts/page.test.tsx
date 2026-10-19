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

vi.mock('@/components/admin/orchestration/mcp/mcp-prompts-list', () => ({
  McpPromptsList: ({ initialPrompts }: { initialPrompts: unknown[] }) => (
    <div data-testid="mcp-prompts-list" data-count={initialPrompts.length} />
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

import McpPromptsPage, { metadata } from '@/app/admin/orchestration/mcp/prompts/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';
import { logger } from '@/lib/logging';
import { API } from '@/lib/api/endpoints';

/**
 * Fixture matching the `promptRowSchema` so the page's defensive parse
 * succeeds. The page filters out rows that don't parse, which is the
 * behaviour we want to exercise separately below.
 */
const validPromptRow = {
  id: 'p-1',
  name: 'analyze-pattern',
  description: 'Analyze a pattern',
  template: 'analyze {{pattern_number}}',
  argumentsSpec: [{ name: 'pattern_number', description: 'pattern number', required: true }],
  isEnabled: true,
  createdAt: '2025-01-01T00:00:00Z',
};

describe('McpPromptsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exports correct metadata title and description', () => {
    expect(metadata.title).toBe('MCP Prompts · AI Orchestration');
    expect(metadata.description).toMatch(/slash command/i);
  });

  it('calls serverFetch with MCP_PROMPTS URL and pagination params', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    render(await McpPromptsPage());

    expect(serverFetch).toHaveBeenCalledOnce();
    const [calledUrl] = vi.mocked(serverFetch).mock.calls[0];
    expect(String(calledUrl)).toContain(API.ADMIN.ORCHESTRATION.MCP_PROMPTS);
    expect(String(calledUrl)).toContain('?page=1&limit=100');
  });

  it('passes parsed prompts to McpPromptsList on success', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      apiSuccess([validPromptRow, { ...validPromptRow, id: 'p-2' }])
    );

    render(await McpPromptsPage());

    expect(screen.getByTestId('mcp-prompts-list')).toHaveAttribute('data-count', '2');
  });

  it('filters out malformed rows that fail schema parse', async () => {
    // Mix a valid row with a row missing required fields. The page
    // coerces each row through promptRowSchema and silently drops failures
    // so a single bad row never breaks the whole list.
    vi.mocked(serverFetch).mockResolvedValue(
      apiSuccess([
        validPromptRow,
        { id: 'broken' }, // missing name, description, template, etc.
      ])
    );

    render(await McpPromptsPage());

    expect(screen.getByTestId('mcp-prompts-list')).toHaveAttribute('data-count', '1');
  });

  // A genuinely empty list is still an empty list
  it('passes an empty array to the list when there are no prompts', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    render(await McpPromptsPage());

    expect(screen.getByTestId('mcp-prompts-list')).toHaveAttribute('data-count', '0');
  });

  // A failed load is a failure, not an empty list (#518)
  it('throws to the error boundary when the prompts API answers 500', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    await expect(McpPromptsPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('throws when the prompts API answers success:false', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(200));

    await expect(McpPromptsPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('logs and throws when serverFetch rejects', async () => {
    const fetchError = new Error('Network failure');
    vi.mocked(serverFetch).mockRejectedValue(fetchError);

    await expect(McpPromptsPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), fetchError, expect.any(Object));
  });

  it('renders the Prompts heading', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    render(await McpPromptsPage());

    expect(screen.getByRole('heading', { name: /Prompts/i })).toBeInTheDocument();
  });

  it('renders breadcrumb links with correct hrefs', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    render(await McpPromptsPage());

    expect(screen.getByRole('link', { name: /AI Orchestration/i })).toHaveAttribute(
      'href',
      '/admin/orchestration'
    );
    expect(screen.getByRole('link', { name: /MCP Server/i })).toHaveAttribute(
      'href',
      '/admin/orchestration/mcp'
    );
  });

  it('renders McpInfoModal with title "MCP Prompts"', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    render(await McpPromptsPage());

    expect(screen.getByTestId('mcp-info-modal')).toHaveAttribute('data-title', 'MCP Prompts');
  });
});
