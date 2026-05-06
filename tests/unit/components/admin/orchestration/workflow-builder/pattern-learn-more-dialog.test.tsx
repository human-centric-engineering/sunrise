/**
 * Unit Tests: PatternLearnMoreDialog
 *
 * Test Coverage:
 * - Dialog is not visible when open=false
 * - Dialog renders with the title "Pattern #N" before data loads
 * - Loading spinner is shown while fetch is in progress
 * - Error message is shown when apiClient.get rejects
 * - Pattern name and content render when fetch resolves successfully
 * - "No content available" message renders when chunks array is empty
 * - Closing via the Close button calls onOpenChange(false)
 * - Fetch is not triggered when open=false
 *
 * @see components/admin/orchestration/workflow-builder/pattern-learn-more-dialog.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
  },
}));

vi.mock('@/lib/api/endpoints', () => ({
  API: {
    ADMIN: {
      ORCHESTRATION: {
        knowledgePatternByNumber: (num: number) =>
          `/api/v1/admin/orchestration/knowledge/pattern/${num}`,
      },
    },
  },
}));

vi.mock('@/components/admin/orchestration/learn/pattern-content', () => ({
  PatternContent: ({ content }: { content: string }) => (
    <div data-testid="pattern-content">{content}</div>
  ),
}));

vi.mock('@/components/admin/orchestration/learn/pattern-detail-sections', () => ({
  PatternDetailSections: ({
    chunks,
  }: {
    chunks: { id: string; section: string | null; content: string }[];
  }) => (
    <div data-testid="pattern-detail-sections">
      {chunks.map((c) => (
        <div key={c.id}>{c.section}</div>
      ))}
    </div>
  ),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { apiClient } from '@/lib/api/client';
import { PatternLearnMoreDialog } from '@/components/admin/orchestration/workflow-builder/pattern-learn-more-dialog';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeChunk(
  overrides: Partial<{
    id: string;
    section: string | null;
    content: string;
  }> = {}
) {
  return {
    id: 'chunk-1',
    section: 'overview',
    content: 'Pattern 1 — Chain of Thought\n\nThis is the overview content.',
    documentId: 'doc-1',
    chunkIndex: 0,
    tokens: 100,
    embedding: null,
    createdAt: new Date(),
    metadata: null,
    ...overrides,
  };
}

const MOCK_DETAIL = {
  patternName: 'Chain of Thought',
  chunks: [makeChunk()],
  totalTokens: 100,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderDialog(
  overrides: Partial<{
    open: boolean;
    patternNumber: number | null;
    onOpenChange: (open: boolean) => void;
  }> = {}
) {
  const props = {
    open: true,
    patternNumber: 1,
    onOpenChange: vi.fn(),
    ...overrides,
  };
  return render(<PatternLearnMoreDialog {...props} />);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PatternLearnMoreDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('closed state', () => {
    it('does not render the dialog content when open=false', () => {
      vi.mocked(apiClient.get).mockResolvedValue(MOCK_DETAIL);
      renderDialog({ open: false });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('does not call apiClient.get when open=false', () => {
      renderDialog({ open: false, patternNumber: 1 });
      expect(apiClient.get).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });
  });

  describe('initial render', () => {
    it('renders the dialog when open=true', async () => {
      vi.mocked(apiClient.get).mockResolvedValue(MOCK_DETAIL);
      renderDialog();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('shows "Pattern #N" as title before data loads', async () => {
      // Never resolves during this test
      vi.mocked(apiClient.get).mockReturnValue(new Promise(() => {}));
      renderDialog({ patternNumber: 7 });
      expect(screen.getByText('Pattern #7')).toBeInTheDocument();
    });

    it('shows the reference description line', async () => {
      vi.mocked(apiClient.get).mockReturnValue(new Promise(() => {}));
      renderDialog();
      expect(
        screen.getByText(/design pattern reference from the knowledge base/i)
      ).toBeInTheDocument();
    });
  });

  describe('loading state', () => {
    it('shows a loading spinner while fetch is in progress', async () => {
      // Never resolves
      vi.mocked(apiClient.get).mockReturnValue(new Promise(() => {}));
      renderDialog();
      // Loader2 renders as an SVG with animate-spin class
      const spinner = document.querySelector('.animate-spin');
      expect(spinner).toBeInTheDocument();
    });
  });

  describe('error state', () => {
    it('shows the error message when apiClient.get rejects', async () => {
      vi.mocked(apiClient.get).mockRejectedValue(new Error('Network timeout'));
      renderDialog();
      await waitFor(() => {
        expect(screen.getByText('Network timeout')).toBeInTheDocument();
      });
    });

    it('shows a fallback message when the error is not an Error instance', async () => {
      vi.mocked(apiClient.get).mockRejectedValue('string error');
      renderDialog();
      await waitFor(() => {
        expect(screen.getByText('Failed to load pattern')).toBeInTheDocument();
      });
    });

    it('does not show a spinner after an error', async () => {
      vi.mocked(apiClient.get).mockRejectedValue(new Error('Oops'));
      renderDialog();
      await waitFor(() => {
        expect(screen.getByText('Oops')).toBeInTheDocument();
      });
      expect(document.querySelector('.animate-spin')).not.toBeInTheDocument();
    });
  });

  describe('success state', () => {
    it('shows the pattern name as the dialog title after loading', async () => {
      vi.mocked(apiClient.get).mockResolvedValue(MOCK_DETAIL);
      renderDialog({ patternNumber: 1 });
      await waitFor(() => {
        expect(screen.getByText('Chain of Thought')).toBeInTheDocument();
      });
    });

    it('renders hero chunk content via PatternContent', async () => {
      // Hero sections are "tldr" and "summary" — overview is now a labelled
      // subtitle in the dialog description, not a PatternContent card.
      const detailWithHero = {
        ...MOCK_DETAIL,
        chunks: [
          makeChunk({
            id: 'chunk-summary',
            section: 'summary',
            content: 'Summary content for the pattern.',
          }),
        ],
      };
      vi.mocked(apiClient.get).mockResolvedValue(detailWithHero);
      renderDialog();
      await waitFor(() => {
        expect(screen.getByTestId('pattern-content')).toBeInTheDocument();
      });
    });

    it('renders parsed overview parallels as a labelled description', async () => {
      // Bold line in the overview chunk is parsed into `parallels` and shown
      // alongside a "Software-engineering parallels:" label.
      const detailWithOverview = {
        ...MOCK_DETAIL,
        chunks: [
          makeChunk({
            id: 'chunk-overview',
            section: 'overview',
            content: 'Chain of Thought\n\n**Like a structured proof.**',
          }),
        ],
      };
      vi.mocked(apiClient.get).mockResolvedValue(detailWithOverview);
      renderDialog();
      await waitFor(() => {
        expect(screen.getByText(/software-engineering parallels/i)).toBeInTheDocument();
      });
      expect(screen.getByText(/like a structured proof/i)).toBeInTheDocument();
    });

    it('renders the parsed overview example as an italic caption', async () => {
      // Italic line in the overview chunk is parsed into `example` and shown
      // as a separate italic paragraph below the description.
      const detailWithExample = {
        ...MOCK_DETAIL,
        chunks: [
          makeChunk({
            id: 'chunk-overview',
            section: 'overview',
            content:
              'Chain of Thought\n\n**Like a structured proof.**\n\n*See: a developer thinking aloud while debugging.*',
          }),
        ],
      };
      vi.mocked(apiClient.get).mockResolvedValue(detailWithExample);
      renderDialog();
      await waitFor(() => {
        expect(
          screen.getByText(/see: a developer thinking aloud while debugging/i)
        ).toBeInTheDocument();
      });
    });

    it('shows "No content available" message when chunks is empty', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({
        ...MOCK_DETAIL,
        chunks: [],
      });
      renderDialog();
      await waitFor(() => {
        expect(screen.getByText(/no content available for this pattern/i)).toBeInTheDocument();
      });
    });

    it('does not show loading spinner after successful fetch', async () => {
      vi.mocked(apiClient.get).mockResolvedValue(MOCK_DETAIL);
      renderDialog();
      await waitFor(() => {
        expect(screen.queryByText('Chain of Thought')).toBeInTheDocument();
      });
      expect(document.querySelector('.animate-spin')).not.toBeInTheDocument();
    });
  });

  describe('close button', () => {
    it('calls onOpenChange(false) when the footer Close button is clicked', async () => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      vi.mocked(apiClient.get).mockResolvedValue(MOCK_DETAIL);
      renderDialog({ onOpenChange });

      // Wait for the dialog to be fully mounted
      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: /close/i }).length).toBeGreaterThan(0);
      });

      // There are two "close"-named buttons (X icon button + footer outline button).
      // The footer button is the last one rendered in DOM order.
      const closeButtons = screen.getAllByRole('button', { name: /close/i });
      await user.click(closeButtons[closeButtons.length - 1]);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  describe('fetch is triggered correctly', () => {
    it('calls apiClient.get with the correct endpoint for patternNumber', async () => {
      vi.mocked(apiClient.get).mockResolvedValue(MOCK_DETAIL);
      renderDialog({ patternNumber: 5 });

      await waitFor(() => {
        expect(apiClient.get).toHaveBeenCalledWith(
          '/api/v1/admin/orchestration/knowledge/pattern/5'
        );
      });
    });
  });
});
