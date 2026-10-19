// @vitest-environment happy-dom

/**
 * Unit Tests: KnowledgeTagsPage (app/admin/orchestration/knowledge/tags/page.tsx)
 *
 * Branch coverage targets for `getTags`:
 *  - error status, error envelope or network error → ServerLoadError to the
 *    error boundary, never an empty table (#518)
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

import { apiFailure, apiSuccess } from '@/tests/helpers/api';

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
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { logger } from '@/lib/logging';
import { parsePaginationMeta } from '@/lib/validations/common';
import { API } from '@/lib/api/endpoints';

const fullMeta = { page: 1, limit: 50, total: 4, totalPages: 1 };

describe('KnowledgeTagsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws to the error boundary, not an empty table, when the load fails', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    await expect(KnowledgeTagsPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalledWith(
      'Server data load failed',
      undefined,
      expect.objectContaining({ status: 500, code: 'INTERNAL_ERROR' })
    );
  });

  it('throws to the error boundary when the API answers with an error envelope', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      new Response(
        JSON.stringify({ success: false, error: { code: 'INTERNAL_ERROR', message: 'boom' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await expect(KnowledgeTagsPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('throws to the error boundary and logs when serverFetch throws', async () => {
    const err = new Error('network down');
    vi.mocked(serverFetch).mockRejectedValue(err);

    await expect(KnowledgeTagsPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalledWith(
      'Server data load failed: no response',
      err,
      expect.objectContaining({ path: `${API.ADMIN.ORCHESTRATION.KNOWLEDGE_TAGS}?page=1&limit=50` })
    );
  });

  it('forwards tags + parsed meta to KnowledgeTagsTable on the happy path', async () => {
    const mockTags = [
      { id: 't-1', slug: 'internal', name: 'Internal' },
      { id: 't-2', slug: 'public', name: 'Public' },
    ];
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(mockTags, fullMeta));
    vi.mocked(parsePaginationMeta).mockReturnValue(fullMeta);

    render(await KnowledgeTagsPage());

    const table = screen.getByTestId('knowledge-tags-table');
    expect(table).toHaveAttribute('data-tags-count', '2');
    expect(table).toHaveAttribute('data-meta-total', '4');
  });

  it('falls back to EMPTY_META when parsePaginationMeta returns null', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));
    vi.mocked(parsePaginationMeta).mockReturnValue(null);

    render(await KnowledgeTagsPage());

    const table = screen.getByTestId('knowledge-tags-table');
    expect(table).toHaveAttribute('data-meta-total', '0');
  });

  it('hits the KNOWLEDGE_TAGS endpoint with page=1 and limit=50', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    await KnowledgeTagsPage();

    expect(vi.mocked(serverFetch).mock.calls[0][0]).toBe(
      `${API.ADMIN.ORCHESTRATION.KNOWLEDGE_TAGS}?page=1&limit=50`
    );
  });

  it('renders the "Knowledge tags" heading', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    render(await KnowledgeTagsPage());

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Knowledge tags');
  });

  it('renders the breadcrumb links back to AI Orchestration and Knowledge', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

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
