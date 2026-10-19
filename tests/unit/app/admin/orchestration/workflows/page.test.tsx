// @vitest-environment happy-dom

/**
 * Unit Tests: WorkflowsListPage (app/admin/orchestration/workflows/page.tsx)
 *
 * Branch coverage targets:
 * - a failed load (5xx, success:false, no response) → the table's existing
 *   "Failed to load workflows" banner, never a silent empty list (#518)
 * - getWorkflows: happy path → data + meta forwarded to WorkflowsTable
 * - parsePaginationMeta returns null (no meta in response) → EMPTY_META used
 * - No auth-redirect test: per gotcha #21, auth guard lives in the admin layout.
 *
 * @see app/admin/orchestration/workflows/page.tsx
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

vi.mock('@/lib/validations/common', () => ({
  parsePaginationMeta: vi.fn(),
}));

// Stub WorkflowsTable — inspect the props passed to it
vi.mock('@/components/admin/orchestration/workflows-table', () => ({
  WorkflowsTable: (props: {
    initialWorkflows: unknown[];
    initialMeta: unknown;
    initialError: string | null;
  }) => (
    <div
      data-testid="workflows-table"
      data-workflows-count={String(props.initialWorkflows.length)}
      data-has-error={props.initialError !== null ? 'true' : 'false'}
      data-error-message={props.initialError ?? ''}
    />
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

import WorkflowsListPage from '@/app/admin/orchestration/workflows/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { parsePaginationMeta } from '@/lib/validations/common';
import { API } from '@/lib/api/endpoints';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const mockMeta = { page: 1, limit: 25, total: 2, totalPages: 1 };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WorkflowsListPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── getWorkflows: res.ok false ────────────────────────────────────────────

  it('passes empty workflows and error message when the API answers 500', async () => {
    // Arrange
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));
    vi.mocked(parsePaginationMeta).mockReturnValue(mockMeta);

    // Act
    render(await WorkflowsListPage());

    // Assert: table receives empty list and error flag
    const table = screen.getByTestId('workflows-table');
    expect(table).toHaveAttribute('data-workflows-count', '0');
    expect(table).toHaveAttribute('data-has-error', 'true');
    expect(table).toHaveAttribute('data-error-message', 'Failed to load workflows');
  });

  // ── getWorkflows: body.success false ─────────────────────────────────────

  it('passes empty workflows and error message when body.success is false', async () => {
    // Arrange
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(200));
    vi.mocked(parsePaginationMeta).mockReturnValue(mockMeta);

    // Act
    render(await WorkflowsListPage());

    // Assert
    const table = screen.getByTestId('workflows-table');
    expect(table).toHaveAttribute('data-workflows-count', '0');
    expect(table).toHaveAttribute('data-has-error', 'true');
    expect(table).toHaveAttribute('data-error-message', 'Failed to load workflows');
  });

  // ── getWorkflows: serverFetch throws ─────────────────────────────────────

  it('logs error and passes empty workflows when serverFetch throws', async () => {
    // Arrange
    const fetchErr = new Error('Network failure');
    vi.mocked(serverFetch).mockRejectedValue(fetchErr);
    vi.mocked(parsePaginationMeta).mockReturnValue(mockMeta);

    // Act
    render(await WorkflowsListPage());

    // Assert: error logged + empty state
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), fetchErr, expect.any(Object));
    const table = screen.getByTestId('workflows-table');
    expect(table).toHaveAttribute('data-workflows-count', '0');
    expect(table).toHaveAttribute('data-has-error', 'true');
  });

  // ── getWorkflows: happy path ──────────────────────────────────────────────

  it('forwards workflows data to WorkflowsTable when fetch succeeds', async () => {
    // Arrange
    const mockWorkflows = [
      { id: 'wf-1', name: 'Workflow A', _count: { executions: 3 } },
      { id: 'wf-2', name: 'Workflow B', _count: { executions: 7 } },
    ];
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(mockWorkflows, mockMeta));
    vi.mocked(parsePaginationMeta).mockReturnValue(mockMeta);

    // Act
    render(await WorkflowsListPage());

    // Assert: 2 workflows forwarded; no error
    const table = screen.getByTestId('workflows-table');
    expect(table).toHaveAttribute('data-workflows-count', '2');
    expect(table).toHaveAttribute('data-has-error', 'false');
  });

  // ── parsePaginationMeta returns null → EMPTY_META fallback ───────────────

  it('falls back to EMPTY_META when parsePaginationMeta returns null', async () => {
    // Arrange — meta in body is malformed → parsePaginationMeta returns null
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));
    vi.mocked(parsePaginationMeta).mockReturnValue(null);

    // Act — no assertion on meta shape via WorkflowsTable stub (not exposed);
    // assert the page renders without crashing (EMPTY_META used as fallback).
    render(await WorkflowsListPage());

    // Assert: page renders with 0 workflows and no error (empty list is valid)
    const table = screen.getByTestId('workflows-table');
    expect(table).toHaveAttribute('data-workflows-count', '0');
    expect(table).toHaveAttribute('data-has-error', 'false');
  });

  // ── serverFetch endpoint verification ─────────────────────────────────────

  it('calls the workflows endpoint with page=1 and limit=25', async () => {
    // Arrange
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    // Act
    await WorkflowsListPage();

    // Assert: the correct endpoint was used
    expect(vi.mocked(serverFetch).mock.calls[0][0]).toBe(
      `${API.ADMIN.ORCHESTRATION.WORKFLOWS}?page=1&limit=25`
    );
  });

  // ── Heading and breadcrumb ────────────────────────────────────────────────

  it('renders the Workflows heading', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    render(await WorkflowsListPage());

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Workflows');
  });

  it('renders a breadcrumb link to /admin/orchestration', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    render(await WorkflowsListPage());

    const link = screen.getByRole('link', { name: 'AI Orchestration' });
    expect(link).toHaveAttribute('href', '/admin/orchestration');
  });
});
