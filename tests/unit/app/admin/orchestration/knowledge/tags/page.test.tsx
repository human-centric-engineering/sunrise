/**
 * Unit Tests: KnowledgeTagsPage (app/admin/orchestration/knowledge/tags/page.tsx)
 *
 * Branch coverage targets for `getTags`:
 *  - res.ok false → empty list + EMPTY_META
 *  - body.success false → empty list + EMPTY_META
 *  - serverFetch throws → empty list + logger.error
 *  - happy path → tags + parsed meta forwarded to KnowledgeTagsTable
 *  - parsePaginationMeta returns null → EMPTY_META fallback
 *
 * Plus the static shell: heading + two breadcrumb links.
 * No auth-redirect test — the admin layout owns that guard.
 *
 * @see app/admin/orchestration/knowledge/tags/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

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

vi.mock('@/components/admin/orchestration/knowledge/knowledge-tags-table', () => ({
  KnowledgeTagsTable: (props: { initialTags: unknown[]; initialMeta: { total: number } }) => (
    <div
      data-testid="knowledge-tags-table"
      data-tags-count={String(props.initialTags.length)}
      data-meta-total={String(props.initialMeta.total)}
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

import KnowledgeTagsPage from '@/app/admin/orchestration/knowledge/tags/page';
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { parsePaginationMeta } from '@/lib/validations/common';
import { API } from '@/lib/api/endpoints';

const okResponse = (): Response => ({ ok: true }) as Response;
const notOkResponse = (): Response => ({ ok: false }) as Response;
const fullMeta = { page: 1, limit: 50, total: 4, totalPages: 1 };

describe('KnowledgeTagsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders an empty table with the EMPTY_META fallback when res.ok is false', async () => {
    vi.mocked(serverFetch).mockResolvedValue(notOkResponse());

    render(await KnowledgeTagsPage());

    const table = screen.getByTestId('knowledge-tags-table');
    expect(table).toHaveAttribute('data-tags-count', '0');
    expect(table).toHaveAttribute('data-meta-total', '0');
    // We never reach parseApiResponse on a !ok response.
    expect(parseApiResponse).not.toHaveBeenCalled();
  });

  it('renders an empty table when the API returns success=false', async () => {
    vi.mocked(serverFetch).mockResolvedValue(okResponse());
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'boom' },
    } as never);

    render(await KnowledgeTagsPage());

    const table = screen.getByTestId('knowledge-tags-table');
    expect(table).toHaveAttribute('data-tags-count', '0');
    expect(table).toHaveAttribute('data-meta-total', '0');
  });

  it('logs and falls back to empty when serverFetch throws', async () => {
    const err = new Error('network down');
    vi.mocked(serverFetch).mockRejectedValue(err);

    render(await KnowledgeTagsPage());

    expect(logger.error).toHaveBeenCalledWith('knowledge tags page: initial fetch failed', err);
    const table = screen.getByTestId('knowledge-tags-table');
    expect(table).toHaveAttribute('data-tags-count', '0');
  });

  it('forwards tags + parsed meta to KnowledgeTagsTable on the happy path', async () => {
    const mockTags = [
      { id: 't-1', slug: 'internal', name: 'Internal' },
      { id: 't-2', slug: 'public', name: 'Public' },
    ];
    vi.mocked(serverFetch).mockResolvedValue(okResponse());
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: mockTags,
      meta: fullMeta,
    } as never);
    vi.mocked(parsePaginationMeta).mockReturnValue(fullMeta);

    render(await KnowledgeTagsPage());

    const table = screen.getByTestId('knowledge-tags-table');
    expect(table).toHaveAttribute('data-tags-count', '2');
    expect(table).toHaveAttribute('data-meta-total', '4');
  });

  it('falls back to EMPTY_META when parsePaginationMeta returns null', async () => {
    vi.mocked(serverFetch).mockResolvedValue(okResponse());
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: [],
      meta: null,
    } as never);
    vi.mocked(parsePaginationMeta).mockReturnValue(null);

    render(await KnowledgeTagsPage());

    const table = screen.getByTestId('knowledge-tags-table');
    expect(table).toHaveAttribute('data-meta-total', '0');
  });

  it('hits the KNOWLEDGE_TAGS endpoint with page=1 and limit=50', async () => {
    vi.mocked(serverFetch).mockResolvedValue(notOkResponse());

    await KnowledgeTagsPage();

    expect(serverFetch).toHaveBeenCalledWith(
      `${API.ADMIN.ORCHESTRATION.KNOWLEDGE_TAGS}?page=1&limit=50`
    );
  });

  it('renders the "Knowledge tags" heading', async () => {
    vi.mocked(serverFetch).mockResolvedValue(notOkResponse());

    render(await KnowledgeTagsPage());

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Knowledge tags');
  });

  it('renders the breadcrumb links back to AI Orchestration and Knowledge', async () => {
    vi.mocked(serverFetch).mockResolvedValue(notOkResponse());

    render(await KnowledgeTagsPage());

    expect(screen.getByRole('link', { name: 'AI Orchestration' })).toHaveAttribute(
      'href',
      '/admin/orchestration'
    );
    expect(screen.getByRole('link', { name: 'Knowledge' })).toHaveAttribute(
      'href',
      '/admin/orchestration/knowledge'
    );
  });
});
