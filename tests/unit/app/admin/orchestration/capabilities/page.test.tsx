/**
 * Unit Tests: CapabilitiesListPage (app/admin/orchestration/capabilities/page.tsx)
 *
 * Branch coverage targets:
 * - getCapabilities: res.ok false → { capabilities: [], meta: EMPTY_META }
 * - getCapabilities: body.success false → { capabilities: [], meta: EMPTY_META }
 * - getCapabilities: serverFetch throws → empty + logger.error
 * - getCapabilities: happy path → data + meta forwarded to CapabilitiesTable
 * - parsePaginationMeta returns null → EMPTY_META fallback
 * - availableCategories derivation: mixed categories → deduplicated + sorted set
 * - availableCategories derivation: null/undefined categories filtered out
 * - No auth-redirect test: per gotcha #21, auth guard lives in the admin layout.
 *
 * @see app/admin/orchestration/capabilities/page.tsx
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

const mockMeta = { page: 1, limit: 25, total: 5, totalPages: 1 };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CapabilitiesListPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── getCapabilities: res.ok false ────────────────────────────────────────

  it('passes empty capabilities list when res.ok is false', async () => {
    // Arrange
    vi.mocked(serverFetch).mockResolvedValue(notOkResponse());
    vi.mocked(parsePaginationMeta).mockReturnValue(mockMeta);

    // Act
    render(await CapabilitiesListPage());

    // Assert: table receives empty list
    const table = screen.getByTestId('capabilities-table');
    expect(table).toHaveAttribute('data-capabilities-count', '0');
  });

  // ── getCapabilities: body.success false ──────────────────────────────────

  it('passes empty capabilities list when body.success is false', async () => {
    // Arrange
    vi.mocked(serverFetch).mockResolvedValue(okResponse());
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'fail' },
    } as never);
    vi.mocked(parsePaginationMeta).mockReturnValue(mockMeta);

    // Act
    render(await CapabilitiesListPage());

    // Assert
    const table = screen.getByTestId('capabilities-table');
    expect(table).toHaveAttribute('data-capabilities-count', '0');
  });

  // ── getCapabilities: serverFetch throws ──────────────────────────────────

  it('logs error and passes empty capabilities when serverFetch throws', async () => {
    // Arrange
    const fetchErr = new Error('Network failure');
    vi.mocked(serverFetch).mockRejectedValue(fetchErr);
    vi.mocked(parsePaginationMeta).mockReturnValue(mockMeta);

    // Act
    render(await CapabilitiesListPage());

    // Assert: error logged + empty state
    expect(logger.error).toHaveBeenCalledWith(
      'capabilities list page: initial fetch failed',
      fetchErr
    );
    const table = screen.getByTestId('capabilities-table');
    expect(table).toHaveAttribute('data-capabilities-count', '0');
  });

  // ── getCapabilities: happy path ───────────────────────────────────────────

  it('forwards capabilities data to CapabilitiesTable when fetch succeeds', async () => {
    // Arrange
    const mockCapabilities = [
      { id: 'cap-1', name: 'Search', category: 'retrieval', _agents: [] },
      { id: 'cap-2', name: 'Send email', category: 'notifications', _agents: [] },
    ];
    vi.mocked(serverFetch).mockResolvedValue(okResponse());
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: mockCapabilities,
      meta: mockMeta,
    } as never);
    vi.mocked(parsePaginationMeta).mockReturnValue(mockMeta);

    // Act
    render(await CapabilitiesListPage());

    // Assert: 2 capabilities forwarded to table
    const table = screen.getByTestId('capabilities-table');
    expect(table).toHaveAttribute('data-capabilities-count', '2');
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
    render(await CapabilitiesListPage());

    // Assert: page renders with 0 capabilities
    const table = screen.getByTestId('capabilities-table');
    expect(table).toHaveAttribute('data-capabilities-count', '0');
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
    vi.mocked(serverFetch).mockResolvedValue(okResponse());
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: mockCapabilities,
      meta: mockMeta,
    } as never);
    vi.mocked(parsePaginationMeta).mockReturnValue(mockMeta);

    // Act
    render(await CapabilitiesListPage());

    // Assert: deduplicated ("retrieval" once), null filtered, alphabetically sorted
    const table = screen.getByTestId('capabilities-table');
    const categories = JSON.parse(table.getAttribute('data-categories') ?? '[]') as string[];
    expect(categories).toEqual(['api', 'notifications', 'retrieval']);
  });

  it('passes empty categories array when all capabilities have null category', async () => {
    // Arrange
    const mockCapabilities = [
      { id: 'cap-1', name: 'Search', category: null, _agents: [] },
      { id: 'cap-2', name: 'Lookup', category: null, _agents: [] },
    ];
    vi.mocked(serverFetch).mockResolvedValue(okResponse());
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: mockCapabilities,
      meta: mockMeta,
    } as never);
    vi.mocked(parsePaginationMeta).mockReturnValue(mockMeta);

    // Act
    render(await CapabilitiesListPage());

    // Assert: null categories filtered → empty array
    const table = screen.getByTestId('capabilities-table');
    const categories = JSON.parse(table.getAttribute('data-categories') ?? '["x"]') as string[];
    expect(categories).toEqual([]);
  });

  it('passes empty categories array when no capabilities are loaded', async () => {
    // Arrange — fetch fails → capabilities = []
    vi.mocked(serverFetch).mockResolvedValue(notOkResponse());

    // Act
    render(await CapabilitiesListPage());

    // Assert: no capabilities → no categories
    const table = screen.getByTestId('capabilities-table');
    const categories = JSON.parse(table.getAttribute('data-categories') ?? '["x"]') as string[];
    expect(categories).toEqual([]);
  });

  // ── serverFetch endpoint verification ─────────────────────────────────────

  it('calls the capabilities endpoint with page=1 and limit=25', async () => {
    // Arrange
    vi.mocked(serverFetch).mockResolvedValue(notOkResponse());

    // Act
    await CapabilitiesListPage();

    // Assert: the correct endpoint was used
    expect(serverFetch).toHaveBeenCalledWith(
      `${API.ADMIN.ORCHESTRATION.CAPABILITIES}?page=1&limit=25`
    );
  });

  // ── Heading and breadcrumb ────────────────────────────────────────────────

  it('renders the Capabilities heading', async () => {
    vi.mocked(serverFetch).mockResolvedValue(notOkResponse());

    render(await CapabilitiesListPage());

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Capabilities');
  });

  it('renders a breadcrumb link to /admin/orchestration', async () => {
    vi.mocked(serverFetch).mockResolvedValue(notOkResponse());

    render(await CapabilitiesListPage());

    const link = screen.getByRole('link', { name: 'AI Orchestration' });
    expect(link).toHaveAttribute('href', '/admin/orchestration');
  });
});
