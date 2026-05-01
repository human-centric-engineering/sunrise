/**
 * Unit Tests: AgentsListPage (app/admin/orchestration/agents/page.tsx)
 *
 * Branch coverage targets:
 * - getAgents: res.ok false → { agents: [], meta: EMPTY_META }
 * - getAgents: body.success false → { agents: [], meta: EMPTY_META }
 * - getAgents: serverFetch throws → { agents: [], meta: EMPTY_META } + logger.error
 * - getAgents: happy path → data + meta forwarded to AgentsTable
 * - parsePaginationMeta returns null → EMPTY_META fallback used
 * - No auth-redirect test: per gotcha #21, auth guard lives in the admin layout.
 *
 * @see app/admin/orchestration/agents/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/validations/common', () => ({
  parsePaginationMeta: vi.fn(),
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
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { parsePaginationMeta } from '@/lib/validations/common';
import { API } from '@/lib/api/endpoints';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function okResponse(): Response {
  return { ok: true } as Response;
}

function notOkResponse(): Response {
  return { ok: false } as Response;
}

const mockMeta = { page: 1, limit: 25, total: 3, totalPages: 1 };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentsListPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── getAgents: res.ok false ───────────────────────────────────────────────

  it('passes empty agents list when res.ok is false', async () => {
    // Arrange
    vi.mocked(serverFetch).mockResolvedValue(notOkResponse());
    vi.mocked(parsePaginationMeta).mockReturnValue(mockMeta);

    // Act
    render(await AgentsListPage());

    // Assert: table receives empty list
    const table = screen.getByTestId('agents-table');
    expect(table).toHaveAttribute('data-agents-count', '0');
  });

  // ── getAgents: body.success false ────────────────────────────────────────

  it('passes empty agents list when body.success is false', async () => {
    // Arrange
    vi.mocked(serverFetch).mockResolvedValue(okResponse());
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'fail' },
    } as never);
    vi.mocked(parsePaginationMeta).mockReturnValue(mockMeta);

    // Act
    render(await AgentsListPage());

    // Assert
    const table = screen.getByTestId('agents-table');
    expect(table).toHaveAttribute('data-agents-count', '0');
  });

  // ── getAgents: serverFetch throws ────────────────────────────────────────

  it('logs error and passes empty agents list when serverFetch throws', async () => {
    // Arrange
    const fetchErr = new Error('Network failure');
    vi.mocked(serverFetch).mockRejectedValue(fetchErr);
    vi.mocked(parsePaginationMeta).mockReturnValue(mockMeta);

    // Act
    render(await AgentsListPage());

    // Assert: error logged + empty state
    expect(logger.error).toHaveBeenCalledWith('agents list page: initial fetch failed', fetchErr);
    const table = screen.getByTestId('agents-table');
    expect(table).toHaveAttribute('data-agents-count', '0');
  });

  // ── getAgents: happy path ─────────────────────────────────────────────────

  it('forwards agents data to AgentsTable when fetch succeeds', async () => {
    // Arrange
    const mockAgents = [
      { id: 'ag-1', name: 'Support Bot', _count: { capabilities: 2, conversations: 10 } },
      { id: 'ag-2', name: 'Sales Bot', _count: { capabilities: 1, conversations: 5 } },
      { id: 'ag-3', name: 'Data Bot', _count: { capabilities: 3, conversations: 20 } },
    ];
    vi.mocked(serverFetch).mockResolvedValue(okResponse());
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: mockAgents,
      meta: mockMeta,
    } as never);
    vi.mocked(parsePaginationMeta).mockReturnValue(mockMeta);

    // Act
    render(await AgentsListPage());

    // Assert: 3 agents forwarded to table
    const table = screen.getByTestId('agents-table');
    expect(table).toHaveAttribute('data-agents-count', '3');
  });

  // ── parsePaginationMeta returns null → EMPTY_META fallback ───────────────

  it('falls back to EMPTY_META when parsePaginationMeta returns null', async () => {
    // Arrange
    vi.mocked(serverFetch).mockResolvedValue(okResponse());
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: [],
      meta: null,
    } as never);
    vi.mocked(parsePaginationMeta).mockReturnValue(null);

    // Act — page should render without crashing; EMPTY_META is the fallback
    render(await AgentsListPage());

    // Assert: page renders with 0 agents (empty list is valid)
    const table = screen.getByTestId('agents-table');
    expect(table).toHaveAttribute('data-agents-count', '0');
  });

  // ── serverFetch endpoint verification ─────────────────────────────────────

  it('calls the agents endpoint with page=1 and limit=25', async () => {
    // Arrange
    vi.mocked(serverFetch).mockResolvedValue(notOkResponse());

    // Act
    await AgentsListPage();

    // Assert: the correct endpoint was used
    expect(serverFetch).toHaveBeenCalledWith(`${API.ADMIN.ORCHESTRATION.AGENTS}?page=1&limit=25`);
  });

  // ── Heading and breadcrumb ────────────────────────────────────────────────

  it('renders the Agents heading', async () => {
    vi.mocked(serverFetch).mockResolvedValue(notOkResponse());

    render(await AgentsListPage());

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Agents');
  });

  it('renders a breadcrumb link to /admin/orchestration', async () => {
    vi.mocked(serverFetch).mockResolvedValue(notOkResponse());

    render(await AgentsListPage());

    const link = screen.getByRole('link', { name: 'AI Orchestration' });
    expect(link).toHaveAttribute('href', '/admin/orchestration');
  });
});
