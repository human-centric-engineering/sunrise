/**
 * Tests: MCP Sessions admin page
 *
 * The reason this file exists is the stateless notice (#609). Under
 * `MCP_SESSION_MODE=stateless` — the default — `getActiveSessions()` can never
 * return a row, so this page renders an empty table while clients are actively
 * connected. Without a notice that reads as "nobody is connected", which is a
 * different and wrong conclusion.
 *
 * `@/lib/env` is mocked because the page reads `MCP_SESSION_MODE` directly (it
 * is a server component, so it can) and under `happy-dom` the real module
 * validates only the client schema — every server variable would be `undefined`
 * and the notice would never render in either case.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const mockEnv = vi.hoisted(() => ({
  MCP_SESSION_MODE: 'stateless',
}));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/components/admin/orchestration/mcp/mcp-sessions-list', () => ({
  McpSessionsList: ({ initialSessions }: { initialSessions: unknown[] }) => (
    <div data-testid="mcp-sessions-list" data-count={initialSessions.length} />
  ),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import React from 'react';
import McpSessionsPage from '@/app/admin/orchestration/mcp/sessions/page';
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';

beforeEach(() => {
  vi.clearAllMocks();
  // Reset globally: `clearAllMocks` does not touch a plain object, so a block
  // that switched modes would silently govern every block after it.
  mockEnv.MCP_SESSION_MODE = 'stateless';
  vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
  vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: [] } as never);
});

describe('McpSessionsPage', () => {
  it('explains the empty list when the deployment tracks no sessions', async () => {
    render(await McpSessionsPage());

    expect(screen.getByText(/does not track sessions/i)).toBeInTheDocument();
    expect(screen.getByText(/MCP_SESSION_MODE=stateless/)).toBeInTheDocument();
    // The other half of the misleading pair: the settings field that does nothing.
    expect(screen.getByText(/Max sessions per key has no effect/i)).toBeInTheDocument();
  });

  it('says nothing when sessions ARE tracked', async () => {
    // The counterpart, or the assertion above would pass against a page that
    // always shows the notice.
    mockEnv.MCP_SESSION_MODE = 'stateful';

    render(await McpSessionsPage());

    expect(screen.queryByText(/does not track sessions/i)).not.toBeInTheDocument();
  });

  it('still renders the list either way', async () => {
    // The notice supplements the table, it does not replace it — a stateful
    // deploy that happens to have zero sessions must still get the real empty
    // state rather than the stateless explanation.
    render(await McpSessionsPage());
    expect(screen.getByTestId('mcp-sessions-list')).toBeInTheDocument();

    mockEnv.MCP_SESSION_MODE = 'stateful';
    render(await McpSessionsPage());
    expect(screen.getAllByTestId('mcp-sessions-list').length).toBeGreaterThan(0);
  });
});
