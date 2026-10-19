// @vitest-environment happy-dom

/**
 * Integration Test: Admin Orchestration — Knowledge Base Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/knowledge/page.tsx`.
 *
 * A failed document load throws to the error boundary rather than reading as
 * an empty knowledge base (#518); a real empty list still shows the empty state.
 *
 * @see app/admin/orchestration/knowledge/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { apiFailure, apiSuccess } from '@/tests/helpers/api';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    withContext: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));

vi.mock('next/navigation', () => ({
  unstable_rethrow: vi.fn(),
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  usePathname: vi.fn(() => '/admin/orchestration/knowledge'),
}));

vi.mock('@/lib/analytics', () => ({
  useAnalytics: vi.fn(() => ({ track: vi.fn() })),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_DOCUMENTS = [
  {
    id: 'doc-1',
    name: 'Agentic Design Patterns',
    fileName: 'patterns.md',
    fileHash: 'abc123',
    chunkCount: 42,
    status: 'ready',
    scope: 'system',
    errorMessage: null,
    uploadedBy: 'user-1',
    createdAt: new Date('2025-01-01').toISOString(),
    updatedAt: new Date('2025-01-01').toISOString(),
  },
  {
    id: 'doc-2',
    name: 'Custom Knowledge',
    fileName: 'custom.txt',
    fileHash: 'def456',
    chunkCount: 0,
    status: 'processing',
    scope: 'app',
    errorMessage: null,
    uploadedBy: 'user-1',
    createdAt: new Date('2025-01-02').toISOString(),
    updatedAt: new Date('2025-01-02').toISOString(),
  },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('KnowledgeBasePage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders "Knowledge Base" heading', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(MOCK_DOCUMENTS));

    const { default: KnowledgeBasePage } = await import('@/app/admin/orchestration/knowledge/page');

    render(await KnowledgeBasePage());

    expect(screen.getByRole('heading', { name: /^knowledge base$/i })).toBeInTheDocument();
  });

  it('renders document names and status badges', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(MOCK_DOCUMENTS));

    const { default: KnowledgeBasePage } = await import('@/app/admin/orchestration/knowledge/page');

    render(await KnowledgeBasePage());

    expect(screen.getByText('Agentic Design Patterns')).toBeInTheDocument();
    expect(screen.getByText('Custom Knowledge')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('Processing')).toBeInTheDocument();
  });

  it('renders the empty state when there are no documents', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    const { default: KnowledgeBasePage } = await import('@/app/admin/orchestration/knowledge/page');

    render(await KnowledgeBasePage());

    expect(screen.getByRole('heading', { name: /^knowledge base$/i })).toBeInTheDocument();
    expect(screen.getByText(/no documents yet/i)).toBeInTheDocument();
  });

  it('throws to the error boundary when the document load fails', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    const { ServerLoadError } = await import('@/lib/api/server-load');
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    const { default: KnowledgeBasePage } = await import('@/app/admin/orchestration/knowledge/page');

    // Not "No documents yet"
    await expect(KnowledgeBasePage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('throws to the error boundary when fetch rejects', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    const { ServerLoadError } = await import('@/lib/api/server-load');
    vi.mocked(serverFetch).mockRejectedValue(new Error('Network error'));

    const { default: KnowledgeBasePage } = await import('@/app/admin/orchestration/knowledge/page');

    await expect(KnowledgeBasePage()).rejects.toBeInstanceOf(ServerLoadError);
  });
});
