import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/components/admin/orchestration/mcp/mcp-settings-form', () => ({
  McpSettingsForm: ({ initialSettings }: { initialSettings: unknown }) => (
    <div
      data-testid="mcp-settings-form"
      data-has-settings={initialSettings === null ? 'false' : 'true'}
      data-settings={initialSettings ? JSON.stringify(initialSettings) : ''}
    />
  ),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import React from 'react';
import McpSettingsPage, { metadata } from '@/app/admin/orchestration/mcp/settings/page';
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { API } from '@/lib/api/endpoints';

const mockSettings = {
  isEnabled: true,
  serverName: 'sunrise-mcp',
  serverVersion: '1.0.0',
  maxSessionsPerKey: 5,
  globalRateLimit: 60,
  auditRetentionDays: 30,
};

describe('McpSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 1. Metadata
  it('has correct title and description metadata', () => {
    expect(metadata.title).toBe('MCP Settings · AI Orchestration');
    expect(metadata.description).toBe('Configure MCP server rate limits, sessions, and retention.');
  });

  // 2. serverFetch called with correct endpoint
  it('calls serverFetch with the MCP settings endpoint', async () => {
    vi.mocked(serverFetch).mockResolvedValue({
      ok: true,
    } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: mockSettings,
    });

    await McpSettingsPage();

    expect(serverFetch).toHaveBeenCalledWith(API.ADMIN.ORCHESTRATION.MCP_SETTINGS);
  });

  // 3. Happy path: passes settings object to McpSettingsForm
  it('passes fetched settings to McpSettingsForm when res.ok and body.success', async () => {
    vi.mocked(serverFetch).mockResolvedValue({
      ok: true,
    } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: mockSettings,
    });

    render(await McpSettingsPage());

    const form = screen.getByTestId('mcp-settings-form');
    expect(form).toHaveAttribute('data-has-settings', 'true');
    expect(form).toHaveAttribute('data-settings', JSON.stringify(mockSettings));
  });

  // 4. res.ok === false: passes null to McpSettingsForm
  it('passes null to McpSettingsForm when res.ok is false', async () => {
    vi.mocked(serverFetch).mockResolvedValue({
      ok: false,
    } as Response);

    render(await McpSettingsPage());

    const form = screen.getByTestId('mcp-settings-form');
    expect(form).toHaveAttribute('data-has-settings', 'false');
  });

  // 5. body.success === false: passes null
  it('passes null to McpSettingsForm when body.success is false', async () => {
    vi.mocked(serverFetch).mockResolvedValue({
      ok: true,
    } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
    });

    render(await McpSettingsPage());

    const form = screen.getByTestId('mcp-settings-form');
    expect(form).toHaveAttribute('data-has-settings', 'false');
  });

  // 6. serverFetch throws: passes null AND logger.error called
  it('passes null and calls logger.error when serverFetch throws', async () => {
    const fetchError = new Error('Network failure');
    vi.mocked(serverFetch).mockRejectedValue(fetchError);

    render(await McpSettingsPage());

    const form = screen.getByTestId('mcp-settings-form');
    expect(form).toHaveAttribute('data-has-settings', 'false');
    expect(logger.error).toHaveBeenCalledWith('MCP settings page: fetch failed', fetchError);
  });

  // 7. Renders breadcrumb link to /admin/orchestration
  it('renders breadcrumb link to /admin/orchestration', async () => {
    vi.mocked(serverFetch).mockResolvedValue({
      ok: false,
    } as Response);

    render(await McpSettingsPage());

    const link = screen.getByRole('link', { name: /AI Orchestration/i });
    expect(link).toHaveAttribute('href', '/admin/orchestration');
  });

  // 8. Renders breadcrumb link to /admin/orchestration/mcp
  it('renders breadcrumb link to /admin/orchestration/mcp', async () => {
    vi.mocked(serverFetch).mockResolvedValue({
      ok: false,
    } as Response);

    render(await McpSettingsPage());

    const link = screen.getByRole('link', { name: /MCP Server/i });
    expect(link).toHaveAttribute('href', '/admin/orchestration/mcp');
  });

  // 9. Renders <h1> "MCP Settings"
  it('renders h1 heading "MCP Settings"', async () => {
    vi.mocked(serverFetch).mockResolvedValue({
      ok: false,
    } as Response);

    render(await McpSettingsPage());

    expect(screen.getByRole('heading', { level: 1, name: 'MCP Settings' })).toBeInTheDocument();
  });

  // 10. Renders subtitle paragraph
  it('renders the subtitle paragraph', async () => {
    vi.mocked(serverFetch).mockResolvedValue({
      ok: false,
    } as Response);

    render(await McpSettingsPage());

    expect(
      screen.getByText('Configure rate limits, session limits, and audit log retention.')
    ).toBeInTheDocument();
  });
});
