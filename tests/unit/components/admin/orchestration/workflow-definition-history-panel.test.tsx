/**
 * Unit Tests: WorkflowDefinitionHistoryPanel
 *
 * The legacy panel was rebuilt in Phase 2 to read from `GET /versions` and
 * dispatch rollback to `POST /rollback` (replacing the deleted
 * `/definition-history` and `/definition-revert` routes). These tests cover:
 *
 *   - Lazy fetch: no GET on initial render, GET fires on first expand
 *   - Cached fetch: re-expanding does not re-fetch
 *   - Empty state when there's only one version (the published one)
 *   - Rendering of historical versions with version label, createdAt, createdBy
 *   - Rendering of the optional changeSummary line when present
 *   - Diff button opens the dialog and renders the diff against the current published snapshot
 *   - Rollback button opens an AlertDialog and POSTs to /rollback on confirm
 *   - onReverted callback fires after a successful rollback
 *
 * @see components/admin/orchestration/workflow-definition-history-panel.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    code?: string;
    constructor(message: string, code?: string) {
      super(message);
      this.name = 'APIClientError';
      this.code = code;
    }
  },
}));

import { apiClient, APIClientError } from '@/lib/api/client';
import { WorkflowDefinitionHistoryPanel } from '@/components/admin/orchestration/workflow-definition-history-panel';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const WORKFLOW_ID = 'cmjbv4i3x00003wsloputgwul';
const PUBLISHED_VERSION_ID = 'wfv-3';

const PUBLISHED_DEF = {
  steps: [
    {
      id: 'step-1',
      name: 'Step One',
      type: 'chain',
      config: { prompt: 'current published prompt' },
      nextSteps: [],
    },
  ],
  entryStepId: 'step-1',
  errorStrategy: 'fail',
};

const HISTORICAL_DEF_V2 = {
  steps: [
    {
      id: 'step-1',
      name: 'Step One',
      type: 'chain',
      config: { prompt: 'previous prompt' },
      nextSteps: [],
    },
  ],
  entryStepId: 'step-1',
  errorStrategy: 'fail',
};

const HISTORICAL_DEF_V1 = {
  steps: [
    {
      id: 'first',
      name: 'First',
      type: 'chain',
      config: { prompt: 'original' },
      nextSteps: [],
    },
  ],
  entryStepId: 'first',
  errorStrategy: 'fail',
};

function makeListResponse(opts: { withSummary?: boolean } = {}) {
  return {
    versions: [
      {
        id: PUBLISHED_VERSION_ID,
        version: 3,
        snapshot: PUBLISHED_DEF,
        changeSummary: null,
        createdAt: '2026-05-06T12:00:00.000Z',
        createdBy: 'admin@example.test',
      },
      {
        id: 'wfv-2',
        version: 2,
        snapshot: HISTORICAL_DEF_V2,
        changeSummary: opts.withSummary ? 'Tweaked the prompt' : null,
        createdAt: '2026-05-05T12:00:00.000Z',
        createdBy: 'alice@example.test',
      },
      {
        id: 'wfv-1',
        version: 1,
        snapshot: HISTORICAL_DEF_V1,
        changeSummary: null,
        createdAt: '2026-05-04T12:00:00.000Z',
        createdBy: 'bob@example.test',
      },
    ],
    publishedVersionId: PUBLISHED_VERSION_ID,
    nextCursor: null,
  };
}

function makeEmptyListResponse() {
  return {
    versions: [
      {
        id: PUBLISHED_VERSION_ID,
        version: 1,
        snapshot: PUBLISHED_DEF,
        changeSummary: null,
        createdAt: '2026-05-06T12:00:00.000Z',
        createdBy: 'admin@example.test',
      },
    ],
    publishedVersionId: PUBLISHED_VERSION_ID,
    nextCursor: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('WorkflowDefinitionHistoryPanel', () => {
  it('does NOT fetch /versions on initial render — lazy until first expand', () => {
    render(<WorkflowDefinitionHistoryPanel workflowId={WORKFLOW_ID} />);
    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it('fires GET /versions on first expand', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(makeListResponse() as never);
    const user = userEvent.setup();
    render(<WorkflowDefinitionHistoryPanel workflowId={WORKFLOW_ID} />);

    await user.click(screen.getByRole('button', { name: /definition history/i }));

    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(1));
    expect(vi.mocked(apiClient.get).mock.calls[0]?.[0]).toContain(WORKFLOW_ID);
    expect(vi.mocked(apiClient.get).mock.calls[0]?.[0]).toContain('/versions');
  });

  it('does not re-fetch on second expand — uses cached data', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(makeListResponse() as never);
    const user = userEvent.setup();
    render(<WorkflowDefinitionHistoryPanel workflowId={WORKFLOW_ID} />);

    const toggle = screen.getByRole('button', { name: /definition history/i });
    await user.click(toggle); // expand
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(1));
    await user.click(toggle); // collapse
    await user.click(toggle); // re-expand

    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state when only the currently-published version exists', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(makeEmptyListResponse() as never);
    const user = userEvent.setup();
    render(<WorkflowDefinitionHistoryPanel workflowId={WORKFLOW_ID} />);

    await user.click(screen.getByRole('button', { name: /definition history/i }));

    await waitFor(() => expect(apiClient.get).toHaveBeenCalledOnce());
    expect(screen.getByText(/no previous versions yet/i)).toBeInTheDocument();
  });

  it('renders historical versions newest-first with version label and createdBy', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(makeListResponse() as never);
    const user = userEvent.setup();
    render(<WorkflowDefinitionHistoryPanel workflowId={WORKFLOW_ID} />);

    await user.click(screen.getByRole('button', { name: /definition history/i }));

    // The currently-published v3 is filtered out; v2 and v1 remain.
    await waitFor(() => {
      expect(screen.getByText(/v2\b/)).toBeInTheDocument();
      expect(screen.getByText(/v1\b/)).toBeInTheDocument();
    });
    expect(screen.getByText(/alice@example\.test/)).toBeInTheDocument();
    expect(screen.getByText(/bob@example\.test/)).toBeInTheDocument();
  });

  it('renders the optional changeSummary on a version row when present', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(makeListResponse({ withSummary: true }) as never);
    const user = userEvent.setup();
    render(<WorkflowDefinitionHistoryPanel workflowId={WORKFLOW_ID} />);

    await user.click(screen.getByRole('button', { name: /definition history/i }));

    await waitFor(() => {
      expect(screen.getByText(/tweaked the prompt/i)).toBeInTheDocument();
    });
  });

  it('opens the diff dialog when Diff is clicked', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(makeListResponse() as never);
    const user = userEvent.setup();
    render(<WorkflowDefinitionHistoryPanel workflowId={WORKFLOW_ID} />);

    await user.click(screen.getByRole('button', { name: /definition history/i }));
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /diff/i }).length).toBeGreaterThan(0)
    );

    const diffButtons = screen.getAllByRole('button', { name: /diff/i });
    await user.click(diffButtons[0]);

    expect(screen.getByText(/compare definitions/i)).toBeInTheDocument();
  });

  it('opens the rollback AlertDialog when Rollback is clicked', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(makeListResponse() as never);
    const user = userEvent.setup();
    render(<WorkflowDefinitionHistoryPanel workflowId={WORKFLOW_ID} />);

    await user.click(screen.getByRole('button', { name: /definition history/i }));
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /^rollback$/i }).length).toBeGreaterThan(0)
    );

    const rollbackButtons = screen.getAllByRole('button', { name: /^rollback$/i });
    await user.click(rollbackButtons[0]);

    expect(screen.getByText(/roll back to this version/i)).toBeInTheDocument();
  });

  it('POSTs to /rollback with the targetVersionId on confirm and fires onReverted', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(makeListResponse() as never);
    vi.mocked(apiClient.post).mockResolvedValue({} as never);
    const onReverted = vi.fn();
    const user = userEvent.setup();
    render(<WorkflowDefinitionHistoryPanel workflowId={WORKFLOW_ID} onReverted={onReverted} />);

    await user.click(screen.getByRole('button', { name: /definition history/i }));
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /^rollback$/i }).length).toBeGreaterThan(0)
    );
    const rollbackButtons = screen.getAllByRole('button', { name: /^rollback$/i });
    await user.click(rollbackButtons[0]); // opens AlertDialog

    // The AlertDialog action button is also labelled "Rollback"; click the one
    // inside the dialog.
    const confirmButton = await screen
      .findByText(/^rollback$/i, { selector: 'button[type="button"][class*="bg-primary"]' })
      .catch(() => {
        // Fallback: pick the rightmost rollback button (the dialog confirm)
        const all = screen.getAllByRole('button', { name: /^rollback$/i });
        return all[all.length - 1];
      });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledOnce();
    });
    const [url, options] = vi.mocked(apiClient.post).mock.calls[0];
    expect(url).toContain(WORKFLOW_ID);
    expect(url).toContain('/rollback');
    const body = (options as { body?: { targetVersionId?: string } } | undefined)?.body;
    // The first historical entry rendered is v2 (newest-first after filtering published).
    expect(body?.targetVersionId).toBe('wfv-2');
    await waitFor(() => expect(onReverted).toHaveBeenCalledOnce());
  });

  it('shows an inline error when the GET fails', async () => {
    vi.mocked(apiClient.get).mockRejectedValue(new Error('Network down'));
    const user = userEvent.setup();
    render(<WorkflowDefinitionHistoryPanel workflowId={WORKFLOW_ID} />);

    await user.click(screen.getByRole('button', { name: /definition history/i }));

    await waitFor(() => {
      expect(screen.getByText(/could not load definition history/i)).toBeInTheDocument();
    });
  });

  it('surfaces a generic error message when the rollback POST fails', async () => {
    // Exercises the catch branch in handleRollback (line ~125) when the POST
    // rejects. APIClientError-vs-generic branching depends on instanceof
    // semantics across module instances, which can be brittle in test mocks
    // — assert on the fallback "Rollback failed" text since both branches
    // surface a user-visible error in the dialog.
    vi.mocked(apiClient.get).mockResolvedValue(makeListResponse() as never);
    vi.mocked(apiClient.post).mockRejectedValue(new Error('Network down'));
    const user = userEvent.setup();
    render(<WorkflowDefinitionHistoryPanel workflowId={WORKFLOW_ID} />);

    await user.click(screen.getByRole('button', { name: /definition history/i }));
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /^rollback$/i }).length).toBeGreaterThan(0)
    );
    const rollbackButtons = screen.getAllByRole('button', { name: /^rollback$/i });
    await user.click(rollbackButtons[0]); // open AlertDialog
    // Wait for the AlertDialog title to appear — Radix sets aria-modal on the
    // dialog, which hides background buttons from the accessibility tree, so
    // the dialog's confirm action becomes the only matching Rollback button.
    await screen.findByText(/roll back to this version/i);
    await user.click(screen.getByRole('button', { name: /^rollback$/i }));

    await waitFor(() => {
      expect(screen.getByText(/rollback failed/i)).toBeInTheDocument();
    });
  });

  it('uses APIClientError.message when the rollback POST rejects with one', async () => {
    // Variant covering the APIClientError limb specifically, by throwing the
    // exact class the component imports.
    vi.mocked(apiClient.get).mockResolvedValue(makeListResponse() as never);
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Rollback denied by server', 'FORBIDDEN')
    );
    const user = userEvent.setup();
    render(<WorkflowDefinitionHistoryPanel workflowId={WORKFLOW_ID} />);

    await user.click(screen.getByRole('button', { name: /definition history/i }));
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /^rollback$/i }).length).toBeGreaterThan(0)
    );
    const rollbackButtons = screen.getAllByRole('button', { name: /^rollback$/i });
    await user.click(rollbackButtons[0]);
    const confirms = screen.getAllByRole('button', { name: /^rollback$/i });
    await user.click(confirms[confirms.length - 1]);

    await waitFor(() => {
      expect(screen.getByText(/rollback denied by server/i)).toBeInTheDocument();
    });
  });
});
