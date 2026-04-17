/**
 * WorkflowDefinitionHistoryPanel Component Tests
 *
 * Test Coverage:
 * - Collapsed by default (no API call yet)
 * - First expand fires one GET request
 * - Second expand does NOT fire another GET (data cached)
 * - Empty history shows "no previous versions" message
 * - History entries rendered with changedBy and preview
 * - Diff dialog opens on Diff click
 * - Revert AlertDialog opens on Revert click
 * - Revert POSTs with correct versionIndex
 * - onReverted callback called after successful revert
 *
 * @see components/admin/orchestration/workflow-definition-history-panel.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { WorkflowDefinitionHistoryPanel } from '@/components/admin/orchestration/workflow-definition-history-panel';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    constructor(
      message: string,
      public code?: string,
      public status?: number,
      public details?: Record<string, unknown>
    ) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const WORKFLOW_ID = 'wf-abc-001';

function makeHistoryResponse(
  entries: Array<{
    definition: Record<string, unknown>;
    changedAt: string;
    changedBy: string;
    versionIndex: number;
  }> = []
) {
  return {
    workflowId: WORKFLOW_ID,
    slug: 'test-workflow',
    current: { steps: [{ id: 'step-1' }], entryStepId: 'step-1' },
    history: entries,
  };
}

const TWO_VERSIONS = makeHistoryResponse([
  {
    definition: { steps: [{ id: 'step-old' }, { id: 'step-2' }], entryStepId: 'step-old' },
    changedAt: '2025-03-01T10:00:00Z',
    changedBy: 'admin@example.com',
    versionIndex: 1,
  },
  {
    definition: { steps: [{ id: 'step-original' }], entryStepId: 'step-original' },
    changedAt: '2025-01-01T10:00:00Z',
    changedBy: 'alice@example.com',
    versionIndex: 0,
  },
]);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WorkflowDefinitionHistoryPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Collapsed by default ───────────────────────────────────────────────────

  it('is collapsed by default and shows toggle button', () => {
    render(<WorkflowDefinitionHistoryPanel workflowId={WORKFLOW_ID} />);

    expect(screen.getByRole('button', { name: /definition history/i })).toBeInTheDocument();
    expect(screen.queryByText(/loading history/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no previous versions/i)).not.toBeInTheDocument();
  });

  it('does NOT call GET before first expand', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(makeHistoryResponse([]));

    render(<WorkflowDefinitionHistoryPanel workflowId={WORKFLOW_ID} />);

    expect(apiClient.get).not.toHaveBeenCalled();
  });

  // ── First expand ───────────────────────────────────────────────────────────

  it('fires one GET on first expand', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(makeHistoryResponse([]));

    const user = userEvent.setup();
    render(<WorkflowDefinitionHistoryPanel workflowId={WORKFLOW_ID} />);

    await user.click(screen.getByRole('button', { name: /definition history/i }));

    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledOnce();
      expect(apiClient.get).toHaveBeenCalledWith(expect.stringContaining('/definition-history'));
    });
  });

  it('shows empty state when no history entries', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(makeHistoryResponse([]));

    const user = userEvent.setup();
    render(<WorkflowDefinitionHistoryPanel workflowId={WORKFLOW_ID} />);

    await user.click(screen.getByRole('button', { name: /definition history/i }));

    await waitFor(() => {
      expect(screen.getByText(/no previous versions yet/i)).toBeInTheDocument();
    });
  });

  it('second expand does NOT fire another GET (uses cached data)', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(makeHistoryResponse([]));

    const user = userEvent.setup();
    render(<WorkflowDefinitionHistoryPanel workflowId={WORKFLOW_ID} />);

    // Expand
    await user.click(screen.getByRole('button', { name: /definition history/i }));
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledOnce());

    // Collapse then expand again
    await user.click(screen.getByRole('button', { name: /definition history/i }));
    await user.click(screen.getByRole('button', { name: /definition history/i }));

    expect(apiClient.get).toHaveBeenCalledOnce();
  });

  // ── History entries ────────────────────────────────────────────────────────

  it('renders history entries with changedBy names', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(TWO_VERSIONS);

    const user = userEvent.setup();
    render(<WorkflowDefinitionHistoryPanel workflowId={WORKFLOW_ID} />);

    await user.click(screen.getByRole('button', { name: /definition history/i }));

    await waitFor(() => {
      expect(screen.getByText('admin@example.com')).toBeInTheDocument();
      expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    });
  });

  it('shows version count in toggle after loading', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(TWO_VERSIONS);

    const user = userEvent.setup();
    render(<WorkflowDefinitionHistoryPanel workflowId={WORKFLOW_ID} />);

    await user.click(screen.getByRole('button', { name: /definition history/i }));

    await waitFor(() => {
      expect(screen.getByText(/2 versions/i)).toBeInTheDocument();
    });
  });

  it('renders Diff and Revert buttons for each entry', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(TWO_VERSIONS);

    const user = userEvent.setup();
    render(<WorkflowDefinitionHistoryPanel workflowId={WORKFLOW_ID} />);

    await user.click(screen.getByRole('button', { name: /definition history/i }));

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /diff/i })).toHaveLength(2);
      expect(screen.getAllByRole('button', { name: /revert/i })).toHaveLength(2);
    });
  });

  // ── Error state ────────────────────────────────────────────────────────────

  it('shows error message when fetch fails', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockRejectedValue(
      new APIClientError('History not found', 'NOT_FOUND', 404)
    );

    const user = userEvent.setup();
    render(<WorkflowDefinitionHistoryPanel workflowId={WORKFLOW_ID} />);

    await user.click(screen.getByRole('button', { name: /definition history/i }));

    await waitFor(() => {
      expect(screen.getByText('History not found')).toBeInTheDocument();
    });
  });

  // ── Diff dialog ────────────────────────────────────────────────────────────

  it('opens diff dialog on Diff click', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(TWO_VERSIONS);

    const user = userEvent.setup();
    render(<WorkflowDefinitionHistoryPanel workflowId={WORKFLOW_ID} />);

    await user.click(screen.getByRole('button', { name: /definition history/i }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /diff/i })).toHaveLength(2));

    await user.click(screen.getAllByRole('button', { name: /diff/i })[0]);

    await waitFor(() => {
      expect(screen.getByText('Compare definitions')).toBeInTheDocument();
    });
  });

  // ── Revert flow ────────────────────────────────────────────────────────────

  it('opens revert AlertDialog on Revert click', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(TWO_VERSIONS);

    const user = userEvent.setup();
    render(<WorkflowDefinitionHistoryPanel workflowId={WORKFLOW_ID} />);

    await user.click(screen.getByRole('button', { name: /definition history/i }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /revert/i })).toHaveLength(2));

    await user.click(screen.getAllByRole('button', { name: /revert/i })[0]);

    await waitFor(() => {
      expect(screen.getByText(/revert to this definition/i)).toBeInTheDocument();
    });
  });

  it('POSTs with correct versionIndex on revert confirm', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(TWO_VERSIONS);
    vi.mocked(apiClient.post).mockResolvedValue({ success: true });

    const user = userEvent.setup();
    render(<WorkflowDefinitionHistoryPanel workflowId={WORKFLOW_ID} />);

    await user.click(screen.getByRole('button', { name: /definition history/i }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /revert/i })).toHaveLength(2));

    // First entry has versionIndex = 1
    await user.click(screen.getAllByRole('button', { name: /revert/i })[0]);

    await waitFor(() => expect(screen.getByText(/revert to this definition/i)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /^revert$/i }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith(
        expect.stringContaining('/definition-revert'),
        expect.objectContaining({ body: { versionIndex: 1 } })
      );
    });
  });

  it('calls onReverted callback after successful revert', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(TWO_VERSIONS);
    vi.mocked(apiClient.post).mockResolvedValue({ success: true });

    const onReverted = vi.fn();
    const user = userEvent.setup();
    render(<WorkflowDefinitionHistoryPanel workflowId={WORKFLOW_ID} onReverted={onReverted} />);

    await user.click(screen.getByRole('button', { name: /definition history/i }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /revert/i })).toHaveLength(2));

    await user.click(screen.getAllByRole('button', { name: /revert/i })[0]);
    await waitFor(() => expect(screen.getByText(/revert to this definition/i)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /^revert$/i }));

    await waitFor(() => {
      expect(onReverted).toHaveBeenCalledOnce();
    });
  });
});
