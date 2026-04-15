/**
 * Integration Test: Admin Orchestration — Knowledge Base Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/knowledge/page.tsx`.
 *
 * @see app/admin/orchestration/knowledge/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiKnowledgeDocument: {
      findMany: vi.fn(),
    },
  },
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
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_DOCUMENTS = [
  {
    id: 'doc-1',
    name: 'Agentic Design Patterns',
    fileName: 'patterns.md',
    fileHash: 'abc123',
    status: 'ready',
    errorMessage: null,
    uploadedBy: 'user-1',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    _count: { chunks: 42 },
  },
  {
    id: 'doc-2',
    name: 'Custom Knowledge',
    fileName: 'custom.txt',
    fileHash: 'def456',
    status: 'processing',
    errorMessage: null,
    uploadedBy: 'user-1',
    createdAt: new Date('2025-01-02'),
    updatedAt: new Date('2025-01-02'),
    _count: { chunks: 0 },
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
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue(MOCK_DOCUMENTS as any);

    const { default: KnowledgeBasePage } = await import('@/app/admin/orchestration/knowledge/page');

    render(await KnowledgeBasePage());

    expect(screen.getByRole('heading', { name: /^knowledge base$/i })).toBeInTheDocument();
  });

  it('renders document names and status badges', async () => {
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue(MOCK_DOCUMENTS as any);

    const { default: KnowledgeBasePage } = await import('@/app/admin/orchestration/knowledge/page');

    render(await KnowledgeBasePage());

    expect(screen.getByText('Agentic Design Patterns')).toBeInTheDocument();
    expect(screen.getByText('Custom Knowledge')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('Processing')).toBeInTheDocument();
  });

  it('renders empty state when prisma returns empty array', async () => {
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([]);

    const { default: KnowledgeBasePage } = await import('@/app/admin/orchestration/knowledge/page');

    render(await KnowledgeBasePage());

    expect(screen.getByRole('heading', { name: /^knowledge base$/i })).toBeInTheDocument();
    expect(screen.getByText(/no documents yet/i)).toBeInTheDocument();
  });

  it('does not throw when prisma rejects', async () => {
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockRejectedValue(new Error('Database error'));

    const { default: KnowledgeBasePage } = await import('@/app/admin/orchestration/knowledge/page');

    let thrown = false;
    try {
      render(await KnowledgeBasePage());
    } catch {
      thrown = true;
    }

    expect(thrown).toBe(false);
    expect(screen.getByRole('heading', { name: /^knowledge base$/i })).toBeInTheDocument();
  });
});
