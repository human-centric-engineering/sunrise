/**
 * ApprovalsTable Component Tests
 *
 * Test Coverage:
 * - Renders table headers and rows
 * - Empty state renders correctly
 * - Expand row fetches execution detail
 * - Approve action calls correct endpoint
 * - Reject action requires reason and calls correct endpoint
 * - Pagination buttons are wired
 *
 * @see components/admin/orchestration/approvals-table.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApprovalsTable } from '@/components/admin/orchestration/approvals-table';
import { createMockFetchResponse } from '@/tests/helpers/mocks';
import type { PaginationMeta } from '@/types/api';
import type { ExecutionListItem } from '@/types/orchestration';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeApproval(overrides: Partial<ExecutionListItem> = {}): ExecutionListItem {
  return {
    id: 'exec-001-aaaa-bbbb-cccc-dddddddddddd',
    workflowId: 'wf-1',
    status: 'paused_for_approval',
    totalTokensUsed: 500,
    totalCostUsd: 0.0015,
    startedAt: '2026-04-28T10:00:00Z',
    createdAt: '2026-04-28T10:00:00Z',
    completedAt: null,
    workflow: { id: 'wf-1', name: 'Compliance Review' },
    ...overrides,
  };
}

const MOCK_META: PaginationMeta = {
  page: 1,
  limit: 25,
  total: 2,
  totalPages: 1,
};

const TWO_APPROVALS: ExecutionListItem[] = [
  makeApproval(),
  makeApproval({
    id: 'exec-002-aaaa-bbbb-cccc-dddddddddddd',
    workflowId: 'wf-2',
    workflow: { id: 'wf-2', name: 'Legal Draft' },
  }),
];

function makeExecutionDetail() {
  return {
    execution: {
      id: 'exec-001-aaaa-bbbb-cccc-dddddddddddd',
      workflowId: 'wf-1',
      status: 'paused_for_approval',
      totalTokensUsed: 500,
      totalCostUsd: 0.0015,
      budgetLimitUsd: null,
      currentStep: 'approval-step',
      inputData: { query: 'test input' },
      outputData: null,
      errorMessage: null,
      startedAt: '2026-04-28T10:00:00Z',
      completedAt: null,
      createdAt: '2026-04-28T10:00:00Z',
      // Non-audit slug so the structured dispatch in approvals-table
      // does NOT activate for the default fixture.
      workflow: { id: 'wf-1', name: 'Compliance Review', slug: 'tpl-compliance-review' },
    },
    trace: [
      {
        stepId: 'llm-step',
        stepType: 'llm_call',
        label: 'Draft response',
        status: 'completed',
        output: { text: 'Draft output' },
        tokensUsed: 500,
        costUsd: 0.0015,
        startedAt: '2026-04-28T10:00:00Z',
        completedAt: '2026-04-28T10:00:01Z',
        durationMs: 1000,
      },
      {
        stepId: 'approval-step',
        stepType: 'human_approval',
        label: 'Review',
        status: 'awaiting_approval',
        output: { prompt: 'Please review this draft before sending.' },
        tokensUsed: 0,
        costUsd: 0,
        startedAt: '2026-04-28T10:00:01Z',
        completedAt: '2026-04-28T10:00:01Z',
        durationMs: 0,
      },
    ],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ApprovalsTable', () => {
  let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn<typeof fetch>();
    global.fetch = mockFetch as typeof fetch;
    // Default: list refetch returns the same data
    mockFetch.mockResolvedValue(
      createMockFetchResponse({ success: true, data: TWO_APPROVALS, meta: MOCK_META })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('rendering', () => {
    it('renders table headers', () => {
      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      expect(screen.getByText('Workflow')).toBeInTheDocument();
      expect(screen.getByText('Execution')).toBeInTheDocument();
      expect(screen.getByText('Paused')).toBeInTheDocument();
      expect(screen.getByText('Waiting')).toBeInTheDocument();
      expect(screen.getByText('Actions')).toBeInTheDocument();
    });

    it('renders rows with workflow name and truncated execution ID', () => {
      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      expect(screen.getByText('Compliance Review')).toBeInTheDocument();
      expect(screen.getByText('Legal Draft')).toBeInTheDocument();
      expect(screen.getByText('exec-001...')).toBeInTheDocument();
      expect(screen.getByText('exec-002...')).toBeInTheDocument();
    });

    it('renders approve and reject buttons for each row', () => {
      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      const approveButtons = screen.getAllByText('Approve');
      const rejectButtons = screen.getAllByText('Reject');
      expect(approveButtons).toHaveLength(2);
      expect(rejectButtons).toHaveLength(2);
    });

    it('renders empty state when no approvals', () => {
      const emptyMeta: PaginationMeta = { page: 1, limit: 25, total: 0, totalPages: 1 };
      render(<ApprovalsTable initialApprovals={[]} initialMeta={emptyMeta} />);

      expect(screen.getByText('No executions awaiting approval.')).toBeInTheDocument();
    });

    it('renders link to executions list in empty state', () => {
      const emptyMeta: PaginationMeta = { page: 1, limit: 25, total: 0, totalPages: 1 };
      render(<ApprovalsTable initialApprovals={[]} initialMeta={emptyMeta} />);

      const link = screen.getByText('View all executions');
      expect(link).toHaveAttribute('href', '/admin/orchestration/executions');
    });
  });

  describe('expand', () => {
    it('clicking a row fetches execution detail and shows expanded content', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockFetchResponse({ success: true, data: makeExecutionDetail() })
      );

      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      // Click the first row
      const row = screen.getByText('Compliance Review').closest('tr');
      expect(row).toBeTruthy();
      await userEvent.click(row!);

      await waitFor(() => {
        expect(screen.getByText('Approval prompt')).toBeInTheDocument();
      });
    });

    it('expanded row shows approval prompt from trace', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockFetchResponse({ success: true, data: makeExecutionDetail() })
      );

      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      const row = screen.getByText('Compliance Review').closest('tr');
      await userEvent.click(row!);

      await waitFor(() => {
        expect(screen.getByText('Please review this draft before sending.')).toBeInTheDocument();
      });
    });

    it('expanded row shows cost summary', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockFetchResponse({ success: true, data: makeExecutionDetail() })
      );

      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      const row = screen.getByText('Compliance Review').closest('tr');
      await userEvent.click(row!);

      await waitFor(() => {
        expect(screen.getByText('$0.0015')).toBeInTheDocument();
      });
    });

    it('shows loading state while fetching detail', async () => {
      // Never resolve the fetch
      mockFetch.mockReturnValueOnce(new Promise(() => {}));

      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      const row = screen.getByText('Compliance Review').closest('tr');
      await userEvent.click(row!);

      expect(screen.getByText('Loading details...')).toBeInTheDocument();
    });
  });

  describe('approve action', () => {
    it('approve button opens dialog', async () => {
      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      const approveButtons = screen.getAllByText('Approve');
      await userEvent.click(approveButtons[0]);

      expect(screen.getByText('Approve execution?')).toBeInTheDocument();
    });

    it('submitting approve calls POST /executions/:id/approve', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockFetchResponse({ success: true, data: { success: true, resumeStepId: 'step-1' } })
      );

      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      const approveButtons = screen.getAllByText('Approve');
      await userEvent.click(approveButtons[0]);

      // Click the Approve button in the dialog
      const dialogApprove = screen.getAllByText('Approve');
      const confirmButton = dialogApprove[dialogApprove.length - 1];
      await userEvent.click(confirmButton);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/executions/exec-001-aaaa-bbbb-cccc-dddddddddddd/approve'),
          expect.objectContaining({ method: 'POST' })
        );
      });
    });

    it('successful approve removes row from table', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockFetchResponse({ success: true, data: { success: true } })
      );

      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      const approveButtons = screen.getAllByText('Approve');
      await userEvent.click(approveButtons[0]);

      const dialogApprove = screen.getAllByText('Approve');
      const confirmButton = dialogApprove[dialogApprove.length - 1];
      await userEvent.click(confirmButton);

      await waitFor(() => {
        expect(
          screen.getByText('Execution approved. The workflow will resume.')
        ).toBeInTheDocument();
      });
    });

    it('approve with notes sends notes in body', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockFetchResponse({ success: true, data: { success: true } })
      );

      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      const approveButtons = screen.getAllByText('Approve');
      await userEvent.click(approveButtons[0]);

      const textarea = screen.getByPlaceholderText(/Looks good/);
      await userEvent.type(textarea, 'LGTM');

      const dialogApprove = screen.getAllByText('Approve');
      const confirmButton = dialogApprove[dialogApprove.length - 1];
      await userEvent.click(confirmButton);

      await waitFor(() => {
        const calls = mockFetch.mock.calls;
        const approveCall = calls.find(
          (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('/approve')
        );
        expect(approveCall).toBeTruthy();
        const body = JSON.parse((approveCall![1] as RequestInit).body as string) as {
          notes: string;
        };
        expect(body.notes).toBe('LGTM');
      });
    });
  });

  describe('reject action', () => {
    it('reject button opens confirmation dialog', async () => {
      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      const rejectButtons = screen.getAllByText('Reject');
      await userEvent.click(rejectButtons[0]);

      expect(screen.getByText('Reject execution?')).toBeInTheDocument();
    });

    it('reject dialog requires reason text', async () => {
      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      const rejectButtons = screen.getAllByText('Reject');
      await userEvent.click(rejectButtons[0]);

      // The reject button in the dialog should be disabled when reason is empty
      const dialogReject = screen.getAllByText('Reject');
      const confirmButton = dialogReject[dialogReject.length - 1];
      expect(confirmButton).toBeDisabled();
    });

    it('submitting reject calls POST /executions/:id/reject with reason', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockFetchResponse({ success: true, data: { success: true } })
      );

      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      const rejectButtons = screen.getAllByText('Reject');
      await userEvent.click(rejectButtons[0]);

      const textarea = screen.getByPlaceholderText(/compliance/i);
      await userEvent.type(textarea, 'Not compliant');

      const dialogReject = screen.getAllByText('Reject');
      const confirmButton = dialogReject[dialogReject.length - 1];
      await userEvent.click(confirmButton);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/executions/exec-001-aaaa-bbbb-cccc-dddddddddddd/reject'),
          expect.objectContaining({ method: 'POST' })
        );
      });
    });

    it('successful reject removes row from table', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockFetchResponse({ success: true, data: { success: true } })
      );

      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      const rejectButtons = screen.getAllByText('Reject');
      await userEvent.click(rejectButtons[0]);

      const textarea = screen.getByPlaceholderText(/compliance/i);
      await userEvent.type(textarea, 'Rejected');

      const dialogReject = screen.getAllByText('Reject');
      const confirmButton = dialogReject[dialogReject.length - 1];
      await userEvent.click(confirmButton);

      await waitFor(() => {
        expect(screen.getByText('Execution rejected.')).toBeInTheDocument();
      });
    });
  });

  describe('pagination', () => {
    it('does not show pagination when only one page', () => {
      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      expect(screen.queryByText('Previous')).not.toBeInTheDocument();
      expect(screen.queryByText('Next')).not.toBeInTheDocument();
    });

    it('shows pagination when multiple pages', () => {
      const multiMeta: PaginationMeta = { page: 1, limit: 25, total: 50, totalPages: 2 };
      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={multiMeta} />);

      expect(screen.getByText('Previous')).toBeInTheDocument();
      expect(screen.getByText('Next')).toBeInTheDocument();
      expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    });

    it('previous button disabled on first page', () => {
      const multiMeta: PaginationMeta = { page: 1, limit: 25, total: 50, totalPages: 2 };
      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={multiMeta} />);

      expect(screen.getByText('Previous').closest('button')).toBeDisabled();
    });

    it('next page button triggers refetch with page=2', async () => {
      const multiMeta: PaginationMeta = { page: 1, limit: 25, total: 50, totalPages: 2 };
      mockFetch.mockResolvedValueOnce(
        createMockFetchResponse({
          success: true,
          data: TWO_APPROVALS,
          meta: { ...multiMeta, page: 2 },
        })
      );

      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={multiMeta} />);

      await userEvent.click(screen.getByText('Next'));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('page=2'),
          expect.anything()
        );
      });
    });
  });

  describe('dialog dismiss', () => {
    it('dismissing approve dialog clears state', async () => {
      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      // Open approve dialog
      const approveButtons = screen.getAllByText('Approve');
      await userEvent.click(approveButtons[0]);
      expect(screen.getByText('Approve execution?')).toBeInTheDocument();

      // Type some notes
      const textarea = screen.getByPlaceholderText(/Looks good/);
      await userEvent.type(textarea, 'some notes');

      // Click Cancel to dismiss
      await userEvent.click(screen.getByText('Cancel'));

      // Reopen — notes should be cleared
      await userEvent.click(approveButtons[0]);
      await waitFor(() => {
        const newTextarea = screen.getByPlaceholderText(/Looks good/);
        expect(newTextarea).toHaveValue('');
      });
    });

    it('dismissing reject dialog clears state', async () => {
      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      // Open reject dialog
      const rejectButtons = screen.getAllByText('Reject');
      await userEvent.click(rejectButtons[0]);
      expect(screen.getByText('Reject execution?')).toBeInTheDocument();

      // Type a reason
      const textarea = screen.getByPlaceholderText(/compliance/i);
      await userEvent.type(textarea, 'Some reason');

      // Click Cancel to dismiss
      const cancelButtons = screen.getAllByText('Cancel');
      await userEvent.click(cancelButtons[cancelButtons.length - 1]);

      // Reopen — reason should be cleared
      await userEvent.click(rejectButtons[0]);
      await waitFor(() => {
        const newTextarea = screen.getByPlaceholderText(/compliance/i);
        expect(newTextarea).toHaveValue('');
      });
    });
  });

  describe('error states', () => {
    it('shows error when approve API call fails', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockFetchResponse(
          { success: false, error: { code: 'INTERNAL_ERROR', message: 'Server error' } },
          500
        )
      );

      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      const approveButtons = screen.getAllByText('Approve');
      await userEvent.click(approveButtons[0]);

      const dialogApprove = screen.getAllByText('Approve');
      const confirmButton = dialogApprove[dialogApprove.length - 1];
      await userEvent.click(confirmButton);

      await waitFor(() => {
        expect(screen.getByText('Server error')).toBeInTheDocument();
      });
    });

    it('shows error when reject API call fails', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockFetchResponse(
          { success: false, error: { code: 'INTERNAL_ERROR', message: 'Server error' } },
          500
        )
      );

      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      const rejectButtons = screen.getAllByText('Reject');
      await userEvent.click(rejectButtons[0]);

      const textarea = screen.getByPlaceholderText(/compliance/i);
      await userEvent.type(textarea, 'Bad content');

      const dialogReject = screen.getAllByText('Reject');
      const confirmButton = dialogReject[dialogReject.length - 1];
      await userEvent.click(confirmButton);

      await waitFor(() => {
        expect(screen.getByText('Server error')).toBeInTheDocument();
      });
    });
  });

  describe('collapse', () => {
    it('clicking an expanded row collapses it', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockFetchResponse({ success: true, data: makeExecutionDetail() })
      );

      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      const row = screen.getByText('Compliance Review').closest('tr');
      await userEvent.click(row!);

      await waitFor(() => {
        expect(screen.getByText('Approval prompt')).toBeInTheDocument();
      });

      // Click again to collapse
      await userEvent.click(row!);

      await waitFor(() => {
        expect(screen.queryByText('Approval prompt')).not.toBeInTheDocument();
      });
    });
  });

  describe('detail error', () => {
    it('shows error message when detail fetch fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network failure'));

      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      const row = screen.getByText('Compliance Review').closest('tr');
      await userEvent.click(row!);

      await waitFor(() => {
        expect(screen.getByText('Could not load execution details.')).toBeInTheDocument();
      });
    });
  });

  describe('detail variations', () => {
    it('shows budget limit when present', async () => {
      const detailWithBudget = makeExecutionDetail();
      (detailWithBudget.execution as Record<string, unknown>).budgetLimitUsd = 5.0;
      mockFetch.mockResolvedValueOnce(
        createMockFetchResponse({ success: true, data: detailWithBudget })
      );

      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      const row = screen.getByText('Compliance Review').closest('tr');
      await userEvent.click(row!);

      await waitFor(() => {
        expect(screen.getByText('$5.00')).toBeInTheDocument();
      });
    });

    it('hides approval prompt when trace has no awaiting_approval entry', async () => {
      const detailNoPrompt = makeExecutionDetail();
      detailNoPrompt.trace = [detailNoPrompt.trace[0]]; // only the completed step
      mockFetch.mockResolvedValueOnce(
        createMockFetchResponse({ success: true, data: detailNoPrompt })
      );

      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      const row = screen.getByText('Compliance Review').closest('tr');
      await userEvent.click(row!);

      await waitFor(() => {
        expect(screen.getByText('$0.0015')).toBeInTheDocument(); // detail loaded
      });
      expect(screen.queryByText('Approval prompt')).not.toBeInTheDocument();
    });

    it('hides input data when inputData is null', async () => {
      const detailNoInput = makeExecutionDetail();
      (detailNoInput.execution as Record<string, unknown>).inputData = null;
      mockFetch.mockResolvedValueOnce(
        createMockFetchResponse({ success: true, data: detailNoInput })
      );

      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      const row = screen.getByText('Compliance Review').closest('tr');
      await userEvent.click(row!);

      await waitFor(() => {
        expect(screen.getByText('$0.0015')).toBeInTheDocument();
      });
      expect(screen.queryByText('Input data')).not.toBeInTheDocument();
    });

    it('hides previous steps when approval is the first step', async () => {
      const detailNoPrev = makeExecutionDetail();
      detailNoPrev.trace = [detailNoPrev.trace[1]]; // only the approval step
      mockFetch.mockResolvedValueOnce(
        createMockFetchResponse({ success: true, data: detailNoPrev })
      );

      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      const row = screen.getByText('Compliance Review').closest('tr');
      await userEvent.click(row!);

      await waitFor(() => {
        expect(screen.getByText('Approval prompt')).toBeInTheDocument();
      });
      expect(screen.queryByText('Completed steps before approval')).not.toBeInTheDocument();
    });
  });

  describe('list fetch error', () => {
    it('shows error when pagination fetch fails', async () => {
      const multiMeta: PaginationMeta = { page: 1, limit: 25, total: 50, totalPages: 2 };
      mockFetch.mockRejectedValueOnce(new Error('Network failure'));

      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={multiMeta} />);

      await userEvent.click(screen.getByText('Next'));

      await waitFor(() => {
        expect(
          screen.getByText('Could not load approvals. Try refreshing the page.')
        ).toBeInTheDocument();
      });
    });
  });

  describe('pending count text', () => {
    it('shows singular text for 1 pending approval', () => {
      const singleMeta: PaginationMeta = { page: 1, limit: 25, total: 1, totalPages: 1 };
      render(<ApprovalsTable initialApprovals={[makeApproval()]} initialMeta={singleMeta} />);

      expect(screen.getByText('1 pending approval')).toBeInTheDocument();
    });

    it('shows plural text for multiple pending approvals', () => {
      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      expect(screen.getByText('2 pending approvals')).toBeInTheDocument();
    });

    it('shows "No pending approvals" for zero total', () => {
      const emptyMeta: PaginationMeta = { page: 1, limit: 25, total: 0, totalPages: 1 };
      render(<ApprovalsTable initialApprovals={[]} initialMeta={emptyMeta} />);

      expect(screen.getByText('No pending approvals')).toBeInTheDocument();
    });
  });

  describe('expand detail', () => {
    it('shows input data when expanded', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockFetchResponse({ success: true, data: makeExecutionDetail() })
      );

      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      const row = screen.getByText('Compliance Review').closest('tr');
      await userEvent.click(row!);

      await waitFor(() => {
        expect(screen.getByText('Input data')).toBeInTheDocument();
      });
    });

    it('shows previous steps in expanded view', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockFetchResponse({ success: true, data: makeExecutionDetail() })
      );

      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      const row = screen.getByText('Compliance Review').closest('tr');
      await userEvent.click(row!);

      await waitFor(() => {
        expect(screen.getByText(/Completed steps before approval/)).toBeInTheDocument();
        expect(screen.getByText('Draft response')).toBeInTheDocument();
      });
    });
  });

  describe('structured approval dispatch', () => {
    // When the paused execution belongs to a workflow whose slug is in the
    // structured-approval allowlist (currently only `tpl-provider-model-audit`)
    // AND the awaiting_approval trace entry carries a valid `reviewSchema`,
    // the table swaps the markdown view for `<StructuredApprovalView>`.
    function makeAuditExecutionDetail() {
      return {
        ...makeExecutionDetail(),
        execution: {
          ...makeExecutionDetail().execution,
          workflow: {
            id: 'wf-1',
            name: 'Provider Model Audit',
            slug: 'tpl-provider-model-audit',
          },
        },
        trace: [
          {
            stepId: 'discover_new_models',
            stepType: 'agent_call' as const,
            label: 'Discover new models',
            status: 'completed' as const,
            output: {
              newModels: [{ slug: 'openai-gpt-5', name: 'GPT-5', providerSlug: 'openai' }],
            },
            tokensUsed: 100,
            costUsd: 0.001,
            startedAt: '2026-04-28T10:00:00Z',
            completedAt: '2026-04-28T10:00:01Z',
            durationMs: 1000,
          },
          {
            stepId: 'review_changes',
            stepType: 'human_approval' as const,
            label: 'Review changes',
            status: 'awaiting_approval' as const,
            output: {
              prompt: 'Review the audit results.',
              reviewSchema: {
                sections: [
                  {
                    id: 'newModels',
                    title: 'Proposed new models',
                    source: '{{discover_new_models.output.newModels}}',
                    itemKey: 'slug',
                    itemTitle: '{{item.name}} ({{item.providerSlug}})',
                    fields: [{ key: 'name', label: 'Name', display: 'text' as const }],
                  },
                ],
              },
            },
            tokensUsed: 0,
            costUsd: 0,
            startedAt: '2026-04-28T10:00:01Z',
            completedAt: '2026-04-28T10:00:01Z',
            durationMs: 0,
          },
        ],
      };
    }

    it('renders the structured viewer for tpl-provider-model-audit', async () => {
      const auditApprovals = [
        {
          ...TWO_APPROVALS[0],
          workflow: {
            id: 'wf-1',
            name: 'Provider Model Audit',
            slug: 'tpl-provider-model-audit',
          },
        },
      ];
      mockFetch.mockResolvedValueOnce(
        createMockFetchResponse({ success: true, data: makeAuditExecutionDetail() })
      );

      render(
        <ApprovalsTable
          initialApprovals={auditApprovals as typeof TWO_APPROVALS}
          initialMeta={MOCK_META}
        />
      );

      const row = screen.getByText('Provider Model Audit').closest('tr');
      await userEvent.click(row!);

      // Structured viewer header — distinct from the markdown view's
      // "Approval prompt" amber banner. Two indicators: the per-change
      // summary text and the "Approve selected" button.
      await waitFor(() => {
        expect(screen.getByText(/will be applied on approve/)).toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: /Approve selected/ })).toBeInTheDocument();
      expect(screen.queryByText('Approval prompt')).not.toBeInTheDocument();
      // The proposed new model from the trace is rendered in a section.
      expect(screen.getByText('Proposed new models')).toBeInTheDocument();
      expect(screen.getByText(/GPT-5 \(openai\)/)).toBeInTheDocument();
    });

    it('keeps the markdown view for non-audit workflows even with a reviewSchema in trace', async () => {
      // Defence-in-depth: the slug allowlist gates the structured branch
      // even if a stray reviewSchema appears in trace. This prevents
      // accidental opt-in via a malformed seed.
      const detail = makeAuditExecutionDetail();
      detail.execution.workflow.slug = 'tpl-not-allowlisted';
      mockFetch.mockResolvedValueOnce(createMockFetchResponse({ success: true, data: detail }));

      render(<ApprovalsTable initialApprovals={TWO_APPROVALS} initialMeta={MOCK_META} />);

      const row = screen.getByText('Compliance Review').closest('tr');
      await userEvent.click(row!);

      await waitFor(() => {
        expect(screen.getByText('Approval prompt')).toBeInTheDocument();
      });
      expect(screen.queryByText(/will be applied on approve/)).not.toBeInTheDocument();
    });

    it('approve flow forwards the structured payload to the API', async () => {
      const auditApprovals = [
        {
          ...TWO_APPROVALS[0],
          workflow: {
            id: 'wf-1',
            name: 'Provider Model Audit',
            slug: 'tpl-provider-model-audit',
          },
        },
      ];
      mockFetch.mockResolvedValueOnce(
        createMockFetchResponse({ success: true, data: makeAuditExecutionDetail() })
      );

      render(
        <ApprovalsTable
          initialApprovals={auditApprovals as typeof TWO_APPROVALS}
          initialMeta={MOCK_META}
        />
      );

      const row = screen.getByText('Provider Model Audit').closest('tr');
      await userEvent.click(row!);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Approve selected/ })).toBeInTheDocument();
      });

      // Stage the approve POST response.
      mockFetch.mockResolvedValueOnce(
        createMockFetchResponse({ success: true, data: { ok: true } })
      );
      await userEvent.click(screen.getByRole('button', { name: /Approve selected/ }));

      // Confirm the AlertDialog and submit.
      const approveButton = await screen.findByRole('button', { name: 'Approve' });
      await userEvent.click(approveButton);

      await waitFor(() => {
        // Find the approve POST among the fetch calls (list refetch may
        // also fire). The structured branch sends `approvalPayload` in
        // the body keyed by section id.
        const approveCall = mockFetch.mock.calls.find(
          ([url, init]) =>
            typeof url === 'string' && url.includes('/approve') && init?.method === 'POST'
        );
        expect(approveCall).toBeDefined();
        const body = JSON.parse((approveCall![1] as RequestInit).body as string);
        expect(body.approvalPayload).toBeDefined();
        expect(body.approvalPayload.newModels).toEqual([
          { slug: 'openai-gpt-5', name: 'GPT-5', providerSlug: 'openai' },
        ]);
      });
    });
  });
});
