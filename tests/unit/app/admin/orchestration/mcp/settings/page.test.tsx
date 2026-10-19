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
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';
import { logger } from '@/lib/logging';
import { API } from '@/lib/api/endpoints';

const mockSettings = {
  isEnabled: true,
  serverName: 'sunrise-mcp',
  serverVersion: '1.0.0',
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
    expect(metadata.description).toBe('Configure MCP server rate limits and audit retention.');
  });

  // 2. serverFetch called with correct endpoint
  it('calls serverFetch with the MCP settings endpoint', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(mockSettings));

    await McpSettingsPage();

    expect(vi.mocked(serverFetch).mock.calls[0][0]).toBe(API.ADMIN.ORCHESTRATION.MCP_SETTINGS);
  });

  // 3. Happy path: passes settings object to McpSettingsForm
  it('passes fetched settings to McpSettingsForm when res.ok and body.success', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(mockSettings));

    render(await McpSettingsPage());

    const form = screen.getByTestId('mcp-settings-form');
    expect(form).toHaveAttribute('data-has-settings', 'true');
    expect(form).toHaveAttribute('data-settings', JSON.stringify(mockSettings));
  });

  // ── A failed load must not pre-fill the form with defaults (#518) ───────
  // Saving a defaults-filled form would overwrite the real settings, so a
  // failed load throws to the error boundary and the form is never rendered.

  it('throws to the error boundary when the settings API answers 500', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    await expect(McpSettingsPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('throws when the settings API answers success:false', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(200));

    await expect(McpSettingsPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('logs and throws when serverFetch rejects', async () => {
    const fetchError = new Error('Network failure');
    vi.mocked(serverFetch).mockRejectedValue(fetchError);

    await expect(McpSettingsPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), fetchError, expect.any(Object));
  });

  it('logs and throws when the settings do not match the expected shape', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess({ isEnabled: 'yes' }));

    await expect(McpSettingsPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('did not parse'),
      expect.anything(),
      expect.any(Object)
    );
  });

  // 7. Renders breadcrumb link to /admin/orchestration
  it('renders breadcrumb link to /admin/orchestration', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(mockSettings));

    render(await McpSettingsPage());

    const link = screen.getByRole('link', { name: /AI Orchestration/i });
    expect(link).toHaveAttribute('href', '/admin/orchestration');
  });

  // 8. Renders breadcrumb link to /admin/orchestration/mcp
  it('renders breadcrumb link to /admin/orchestration/mcp', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(mockSettings));

    render(await McpSettingsPage());

    const link = screen.getByRole('link', { name: /MCP Server/i });
    expect(link).toHaveAttribute('href', '/admin/orchestration/mcp');
  });

  // 9. Renders <h1> "MCP Settings"
  it('renders h1 heading "MCP Settings"', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(mockSettings));

    render(await McpSettingsPage());

    expect(screen.getByRole('heading', { level: 1, name: 'MCP Settings' })).toBeInTheDocument();
  });

  // 10. Renders subtitle paragraph
  it('renders the subtitle paragraph', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(mockSettings));

    render(await McpSettingsPage());

    expect(screen.getByText('Configure rate limits and audit log retention.')).toBeInTheDocument();
  });
});
