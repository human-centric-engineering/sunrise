// @vitest-environment happy-dom

/**
 * Unit Tests: CapabilitiesListPage (app/admin/orchestration/capabilities/page.tsx)
 *
 * Branch coverage targets:
 * - a failed load (5xx, success:false, no response) throws to the error
 *   boundary instead of rendering an empty table (#518)
 * - happy path → data + meta forwarded to CapabilitiesTable
 * - an empty list is rendered as an empty list, with EMPTY_META when meta is missing
 * - availableCategories derivation: mixed categories → deduplicated + sorted set
 * - availableCategories derivation: null/undefined categories filtered out
 * - No auth-redirect test: per gotcha #21, auth guard lives in the admin layout.
 *
 * @see app/admin/orchestration/capabilities/page.tsx
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

// Stub CapabilitiesTable — inspect the props passed to it
vi.mock('@/components/admin/orchestration/capabilities-table', () => ({
  CapabilitiesTable: (props: {
    initialCapabilities: unknown[];
    initialMeta: unknown;
    availableCategories: string[];
  }) => (
    <div
      data-testid="capabilities-table"
      data-capabilities-count={String(props.initialCapabilities.length)}
      data-categories={JSON.stringify(props.availableCategories)}
      data-meta={JSON.stringify(props.initialMeta)}
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

import CapabilitiesListPage from '@/app/admin/orchestration/capabilities/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { logger } from '@/lib/logging';
import { API } from '@/lib/api/endpoints';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const mockMeta = { page: 1, limit: 25, total: 5, totalPages: 1 };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CapabilitiesListPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── A failed load is a failure, not an empty table (#518) ───────────────

  it('throws to the error boundary when the capabilities API answers 500', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    await expect(CapabilitiesListPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalled();
  });

  it('throws when the capabilities API answers success:false', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(200));

    await expect(CapabilitiesListPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('throws and logs when serverFetch rejects', async () => {
    const fetchErr = new Error('Network failure');
    vi.mocked(serverFetch).mockRejectedValue(fetchErr);

    await expect(CapabilitiesListPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), fetchErr, expect.any(Object));
  });

  // ── getCapabilities: happy path ───────────────────────────────────────────

  it('forwards capabilities data and meta to CapabilitiesTable when fetch succeeds', async () => {
    const mockCapabilities = [
      { id: 'cap-1', name: 'Search', category: 'retrieval', _agents: [] },
      { id: 'cap-2', name: 'Send email', category: 'notifications', _agents: [] },
    ];
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(mockCapabilities, mockMeta));

    render(await CapabilitiesListPage());

    const table = screen.getByTestId('capabilities-table');
    expect(table).toHaveAttribute('data-capabilities-count', '2');
    expect(JSON.parse(table.getAttribute('data-meta') ?? 'null')).toEqual(mockMeta);
  });

  // ── An empty list with no meta → EMPTY_META fallback ─────────────────────

  it('renders an empty list as an empty list, with EMPTY_META when meta is missing', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    render(await CapabilitiesListPage());

    const table = screen.getByTestId('capabilities-table');
    expect(table).toHaveAttribute('data-capabilities-count', '0');
    expect(JSON.parse(table.getAttribute('data-meta') ?? 'null')).toEqual({
      page: 1,
      limit: 25,
      total: 0,
      totalPages: 1,
    });
    const categories = JSON.parse(table.getAttribute('data-categories') ?? '["x"]') as string[];
    expect(categories).toEqual([]);
  });

  // ── availableCategories derivation ───────────────────────────────────────

  it('derives deduplicated and sorted categories from capability data', async () => {
    // Arrange — 5 items, 2 with same category ("retrieval"), 1 null category
    const mockCapabilities = [
      { id: 'cap-1', name: 'Search', category: 'retrieval', _agents: [] },
      { id: 'cap-2', name: 'Lookup', category: 'retrieval', _agents: [] },
      { id: 'cap-3', name: 'Send email', category: 'notifications', _agents: [] },
      { id: 'cap-4', name: 'No category', category: null, _agents: [] },
      { id: 'cap-5', name: 'API call', category: 'api', _agents: [] },
    ];
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(mockCapabilities, mockMeta));

    render(await CapabilitiesListPage());

    // Assert: deduplicated ("retrieval" once), null filtered, alphabetically sorted
    const table = screen.getByTestId('capabilities-table');
    const categories = JSON.parse(table.getAttribute('data-categories') ?? '[]') as string[];
    expect(categories).toEqual(['api', 'notifications', 'retrieval']);
  });

  it('passes empty categories array when all capabilities have null category', async () => {
    const mockCapabilities = [
      { id: 'cap-1', name: 'Search', category: null, _agents: [] },
      { id: 'cap-2', name: 'Lookup', category: null, _agents: [] },
    ];
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(mockCapabilities, mockMeta));

    render(await CapabilitiesListPage());

    // Assert: null categories filtered → empty array
    const table = screen.getByTestId('capabilities-table');
    const categories = JSON.parse(table.getAttribute('data-categories') ?? '["x"]') as string[];
    expect(categories).toEqual([]);
  });

  // ── serverFetch endpoint verification ─────────────────────────────────────

  it('calls the capabilities endpoint with page=1 and limit=25', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    await CapabilitiesListPage();

    expect(vi.mocked(serverFetch).mock.calls[0][0]).toBe(
      `${API.ADMIN.ORCHESTRATION.CAPABILITIES}?page=1&limit=25`
    );
  });

  // ── Heading and breadcrumb ────────────────────────────────────────────────

  it('renders the Capabilities heading', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    render(await CapabilitiesListPage());

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Capabilities');
  });

  it('renders a breadcrumb link to /admin/orchestration', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    render(await CapabilitiesListPage());

    const link = screen.getByRole('link', { name: 'AI Orchestration' });
    expect(link).toHaveAttribute('href', '/admin/orchestration');
  });
});
