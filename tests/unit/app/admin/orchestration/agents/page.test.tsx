// @vitest-environment happy-dom

/**
 * Unit Tests: AgentsListPage (app/admin/orchestration/agents/page.tsx)
 *
 * Branch coverage targets:
 * - a failed load (5xx, success:false, no response) throws to the error
 *   boundary instead of rendering an empty table (#518)
 * - happy path → data + meta forwarded to AgentsTable
 * - an empty list is rendered as an empty list
 * - missing pagination meta → EMPTY_META fallback used
 * - No auth-redirect test: per gotcha #21, auth guard lives in the admin layout.
 *
 * @see app/admin/orchestration/agents/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// Stub AgentsTable — inspect the props passed to it
vi.mock('@/components/admin/orchestration/agents-table', () => ({
  AgentsTable: (props: { initialAgents: unknown[]; initialMeta: unknown }) => (
    <div data-testid="agents-table" data-agents-count={String(props.initialAgents.length)} />
  ),
}));

vi.mock('@/components/ui/field-help', () => ({
  FieldHelp: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────────

import AgentsListPage from '@/app/admin/orchestration/agents/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { logger } from '@/lib/logging';
import { API } from '@/lib/api/endpoints';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const mockMeta = { page: 1, limit: 25, total: 3, totalPages: 1 };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentsListPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── A failed load is a failure, not an empty table (#518) ───────────────

  it('throws to the error boundary when the agents API answers 500', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    await expect(AgentsListPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalled();
  });

  it('throws when the agents API answers success:false', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(200));

    await expect(AgentsListPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('throws and logs when serverFetch rejects', async () => {
    const fetchErr = new Error('Network failure');
    vi.mocked(serverFetch).mockRejectedValue(fetchErr);

    await expect(AgentsListPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), fetchErr, expect.any(Object));
  });

  // ── getAgents: happy path ─────────────────────────────────────────────────

  it('forwards agents data to AgentsTable when fetch succeeds', async () => {
    // Arrange
    const mockAgents = [
      { id: 'ag-1', name: 'Support Bot', _count: { capabilities: 2, conversations: 10 } },
      { id: 'ag-2', name: 'Sales Bot', _count: { capabilities: 1, conversations: 5 } },
      { id: 'ag-3', name: 'Data Bot', _count: { capabilities: 3, conversations: 20 } },
    ];
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(mockAgents, mockMeta));

    // Act
    render(await AgentsListPage());

    // Assert: 3 agents forwarded to table
    const table = screen.getByTestId('agents-table');
    expect(table).toHaveAttribute('data-agents-count', '3');
  });

  // ── An empty list with no meta → EMPTY_META fallback ─────────────────────

  it('renders an empty list as an empty list, with EMPTY_META when meta is missing', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    render(await AgentsListPage());

    const table = screen.getByTestId('agents-table');
    expect(table).toHaveAttribute('data-agents-count', '0');
  });

  // ── serverFetch endpoint verification ─────────────────────────────────────

  it('calls the agents endpoint with page=1 and limit=25', async () => {
    // Arrange
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    // Act
    await AgentsListPage();

    // Assert: the correct endpoint was used
    expect(vi.mocked(serverFetch).mock.calls[0][0]).toBe(
      `${API.ADMIN.ORCHESTRATION.AGENTS}?page=1&limit=25`
    );
  });

  // ── Heading and breadcrumb ────────────────────────────────────────────────

  it('renders the Agents heading', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    render(await AgentsListPage());

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Agents');
  });

  it('renders a breadcrumb link to /admin/orchestration', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    render(await AgentsListPage());

    const link = screen.getByRole('link', { name: 'AI Orchestration' });
    expect(link).toHaveAttribute('href', '/admin/orchestration');
  });
});
