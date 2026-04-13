/**
 * KnowledgeView Component Tests
 *
 * @see components/admin/orchestration/knowledge/knowledge-view.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { KnowledgeView } from '@/components/admin/orchestration/knowledge/knowledge-view';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockRefresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: mockRefresh,
  })),
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_DOCUMENTS = [
  {
    id: 'doc-1',
    name: 'Agentic Patterns',
    fileName: 'patterns.md',
    fileHash: 'abc',
    chunkCount: 42,
    status: 'ready',
    errorMessage: null,
    uploadedBy: 'user-1',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  },
  {
    id: 'doc-2',
    name: 'Pending Doc',
    fileName: 'pending.txt',
    fileHash: 'def',
    chunkCount: 0,
    status: 'processing',
    errorMessage: null,
    uploadedBy: 'user-1',
    createdAt: new Date('2025-01-02'),
    updatedAt: new Date('2025-01-02'),
  },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('KnowledgeView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
  });

  it('renders document table with names', () => {
    render(<KnowledgeView documents={MOCK_DOCUMENTS} />);

    expect(screen.getByText('Agentic Patterns')).toBeInTheDocument();
    expect(screen.getByText('Pending Doc')).toBeInTheDocument();
  });

  it('shows correct status badges', () => {
    render(<KnowledgeView documents={MOCK_DOCUMENTS} />);

    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('Processing')).toBeInTheDocument();
  });

  it('shows chunk counts', () => {
    render(<KnowledgeView documents={MOCK_DOCUMENTS} />);

    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('renders empty state when no documents', () => {
    render(<KnowledgeView documents={[]} />);

    expect(screen.getByText(/no documents yet/i)).toBeInTheDocument();
  });

  it('seed button calls seed endpoint', async () => {
    const user = userEvent.setup();
    render(<KnowledgeView documents={MOCK_DOCUMENTS} />);

    await user.click(screen.getByRole('button', { name: /seed patterns/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/knowledge/seed'),
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  it('rechunk button calls rechunk endpoint', async () => {
    const user = userEvent.setup();
    render(<KnowledgeView documents={MOCK_DOCUMENTS} />);

    const rechunkButtons = screen.getAllByRole('button', { name: /rechunk/i });
    await user.click(rechunkButtons[0]);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/knowledge/documents/doc-1/rechunk'),
        expect.objectContaining({ method: 'POST' })
      );
    });
  });
});
