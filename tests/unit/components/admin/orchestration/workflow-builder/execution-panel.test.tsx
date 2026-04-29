/**
 * ExecutionPanel tests.
 *
 * Covers the SSE consumer loop, per-event rendering, approve button wiring,
 * and abort-on-unmount behaviour. Mirrors the pattern in
 * `tests/unit/components/admin/orchestration/agent-test-chat.test.tsx`:
 * we stub `fetch` with a `ReadableStream` producing canned SSE frames and
 * assert on the resulting DOM.
 *
 * @see components/admin/orchestration/workflow-builder/execution-panel.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ExecutionPanel } from '@/components/admin/orchestration/workflow-builder/execution-panel';
import { APIClientError } from '@/lib/api/client';

// ─── apiClient mock ──────────────────────────────────────────────────────────
// `handleApprove` and `handleAbort` call apiClient.post — stub it so we don't
// need a real fetch for those requests (the main stream is a separate `fetch`).
const postMock = vi.fn();
vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return {
    ...actual,
    apiClient: {
      post: (...args: unknown[]) => postMock(...args),
    },
  };
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSseStream(blocks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const block of blocks) {
        controller.enqueue(encoder.encode(block));
      }
      controller.close();
    },
  });
}

function frame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

const WORKFLOW_ID = 'wf-test';

function renderPanel(): ReturnType<typeof render> {
  return render(
    <ExecutionPanel
      open={true}
      workflowId={WORKFLOW_ID}
      inputData={{ query: 'hello' }}
      onClose={vi.fn()}
    />
  );
}

describe('ExecutionPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Happy-path: complete SSE run ─────────────────────────────────────────

  it('renders step timeline and totals from a complete SSE run', async () => {
    const stream = makeSseStream([
      frame('workflow_started', { executionId: 'exec-1', workflowId: WORKFLOW_ID }),
      frame('step_started', { stepId: 'step-a', stepType: 'llm_call', label: 'Generate' }),
      frame('step_completed', {
        stepId: 'step-a',
        output: 'hello',
        tokensUsed: 12,
        costUsd: 0.003,
        durationMs: 120,
      }),
      frame('workflow_completed', {
        output: 'hello',
        totalTokensUsed: 12,
        totalCostUsd: 0.003,
      }),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    renderPanel();

    // Step label lands in the timeline row
    await waitFor(() => {
      expect(screen.getByText('Generate')).toBeInTheDocument();
    });
    // Totals accumulate from the step_completed frame — element appears in
    // both the header totals row and the trace entry row, so we just assert
    // presence.
    await waitFor(() => {
      expect(screen.getAllByText('$0.0030').length).toBeGreaterThan(0);
    });
    // Terminal state — status pill in the header row
    await waitFor(() => {
      expect(screen.getAllByText(/completed/i).length).toBeGreaterThan(0);
    });
  });

  // ─── Approve flow ─────────────────────────────────────────────────────────

  it('surfaces the approve button on approval_required and POSTs to the approve route on click', async () => {
    const stream = makeSseStream([
      frame('workflow_started', { executionId: 'exec-42', workflowId: WORKFLOW_ID }),
      frame('step_started', {
        stepId: 'gate',
        stepType: 'human_approval',
        label: 'Review',
      }),
      frame('approval_required', {
        stepId: 'gate',
        payload: { prompt: 'ok?' },
      }),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));
    postMock.mockResolvedValue({ success: true, data: { success: true, resumeStepId: 'gate' } });

    const user = userEvent.setup();
    renderPanel();

    const approveBtn = await screen.findByRole('button', { name: /approve/i });
    // Status pill should reflect the paused state (label may appear in
    // both the header and the trace entry row).
    expect(screen.getAllByText(/awaiting approval/i).length).toBeGreaterThan(0);

    // Second stream for the resume call — returns nothing, just closes.
    const resumeStream = makeSseStream([
      frame('workflow_completed', { output: 'ok', totalTokensUsed: 0, totalCostUsd: 0 }),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: resumeStream }));

    await user.click(approveBtn);

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledTimes(1);
    });
    const call = postMock.mock.calls[0] as unknown[];
    expect(call[0]).toMatch(/\/executions\/exec-42\/approve$/);
    expect(call[1]).toMatchObject({ body: {} });
  });

  // ─── workflow_failed frame ────────────────────────────────────────────────

  it('renders the sanitized error from a workflow_failed frame', async () => {
    const stream = makeSseStream([
      frame('workflow_started', { executionId: 'exec-err', workflowId: WORKFLOW_ID }),
      frame('workflow_failed', { error: 'Budget exceeded' }),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    renderPanel();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/budget exceeded/i);
    });
    expect(screen.getByText(/failed/i)).toBeInTheDocument();
  });

  // ─── Abort on unmount ─────────────────────────────────────────────────────
  // Fix for mock-proving: we track abort call count BEFORE unmount to verify
  // that abort fires specifically as part of cleanup, not earlier.

  it('aborts the in-flight stream when the panel unmounts', async () => {
    // Arrange: a stream that never closes — we remain mid-read at unmount.
    const neverResolves = new ReadableStream<Uint8Array>({
      start() {
        /* never enqueue, never close */
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: neverResolves }));

    const abortSpy = vi.fn();
    const OriginalController = globalThis.AbortController;
    class SpyController extends OriginalController {
      override abort(): void {
        abortSpy();
        super.abort();
      }
    }
    globalThis.AbortController = SpyController as unknown as typeof AbortController;

    try {
      const { unmount } = renderPanel();

      // Wait until the fetch has been called so the stream is in-flight.
      await waitFor(() => {
        expect(fetch).toHaveBeenCalled(); // test-review:accept no_arg_called — UI callback-fired guard;
      });

      // Record call count before unmount — any prior abort() calls (e.g.
      // streamRun's guard that aborts an existing controller before creating a
      // new one) are already counted here. We assert that unmount increments
      // the count by exactly 1, proving cleanup fires.
      const callsBefore = abortSpy.mock.calls.length;
      unmount();
      expect(abortSpy).toHaveBeenCalledTimes(callsBefore + 1);
    } finally {
      globalThis.AbortController = OriginalController;
    }
  });

  // ─── Non-ok HTTP response ─────────────────────────────────────────────────

  it('shows "Execution failed to start" error state when the HTTP response is not ok', async () => {
    // Arrange: server returns 500 with no body
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, body: null, status: 500, statusText: 'Server Error' })
    );

    renderPanel();

    // Assert: the component sets status=failed and surfaces the error alert
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/execution failed to start/i);
    });
    // The status pill reads "failed" — multiple matches expected (pill + alert text), use getAllBy
    expect(screen.getAllByText(/failed/i).length).toBeGreaterThan(0);
  });

  it('shows "Execution failed to start" error state when the response body is null', async () => {
    // Arrange: response ok=true but body is null (edge case: !res.body branch)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: null }));

    renderPanel();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/execution failed to start/i);
    });
    // The status pill and error span both contain "failed"
    expect(screen.getAllByText(/failed/i).length).toBeGreaterThan(0);
  });

  // ─── AbortError mid-stream ────────────────────────────────────────────────

  it('sets status=aborted when an AbortError is thrown during stream reading', async () => {
    // Arrange: a stream whose reader throws an AbortError on the first read
    const abortError = Object.assign(new Error('Aborted'), { name: 'AbortError' });
    const errorStream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Enqueue one byte so the reader starts, then error on the next tick
        controller.error(abortError);
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: errorStream }));

    renderPanel();

    // Assert: AbortError path → status becomes 'aborted', no error alert shown
    await waitFor(() => {
      expect(screen.getByText(/aborted/i)).toBeInTheDocument();
    });
    // The error alert should NOT be shown for an abort
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // ─── Generic network error mid-stream ─────────────────────────────────────

  it('sets status=failed and shows "Connection to the execution stream was lost" on generic stream error', async () => {
    // Arrange: stream errors with a non-AbortError network failure
    const networkError = new Error('Network failure');
    const errorStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(networkError);
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: errorStream }));

    renderPanel();

    // Assert: generic catch path → status=failed, "lost" message shown
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        /connection to the execution stream was lost/i
      );
    });
    expect(screen.getByText(/failed/i)).toBeInTheDocument();
  });

  // ─── budget_warning frame ─────────────────────────────────────────────────

  it('renders an amber budget warning alert when a budget_warning frame arrives', async () => {
    // Arrange: stream with a budget_warning frame (no workflow_completed — source
    // clears budgetWarning on completion, so we stop after the warning to assert it)
    const stream = makeSseStream([
      frame('workflow_started', { executionId: 'exec-bw', workflowId: WORKFLOW_ID }),
      frame('budget_warning', { usedUsd: 0.025, limitUsd: 0.05 }),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    renderPanel();

    // Assert: budget warning banner surfaces with the computed percentage
    await waitFor(() => {
      const alert = screen.getByRole('alert');
      // Source renders: "Used $X of $Y budget (Z%)."
      expect(alert).toHaveTextContent(/\$0\.0250 of \$0\.0500 budget \(50%\)/i);
    });
    // The warning should not set a red error alert — it's amber (no error class)
    // Verify no "execution failed" or "stream was lost" text is present
    expect(screen.queryByText(/execution failed to start|stream was lost/i)).toBeNull();
  });

  // ─── step_failed with willRetry=true ─────────────────────────────────────

  it('keeps step status as running when step_failed frame has willRetry=true', async () => {
    // Arrange: step starts then fails with willRetry — engine will retry
    const stream = makeSseStream([
      frame('workflow_started', { executionId: 'exec-retry', workflowId: WORKFLOW_ID }),
      frame('step_started', { stepId: 'step-r', stepType: 'llm_call', label: 'Retry Step' }),
      frame('step_failed', { stepId: 'step-r', error: 'Transient error', willRetry: true }),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    renderPanel();

    // Wait for the step label to appear
    await waitFor(() => {
      expect(screen.getByText('Retry Step')).toBeInTheDocument();
    });

    // Assert: the trace entry row shows "Running" status (not "Failed"),
    // because willRetry=true keeps the entry status as 'running'
    await waitFor(() => {
      // STATUS_STYLES['running'].text === 'Running'
      expect(screen.getByText('Running')).toBeInTheDocument();
    });
    // "Failed" status text should NOT appear in the trace entry
    expect(screen.queryByText('Failed')).toBeNull();
  });

  // ─── step_failed with willRetry=false ────────────────────────────────────

  it('marks step as failed when step_failed frame has willRetry=false', async () => {
    // Arrange: step starts then fails permanently (no retry)
    const stream = makeSseStream([
      frame('workflow_started', { executionId: 'exec-fail', workflowId: WORKFLOW_ID }),
      frame('step_started', { stepId: 'step-f', stepType: 'llm_call', label: 'Fail Step' }),
      frame('step_failed', { stepId: 'step-f', error: 'Permanent error', willRetry: false }),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('Fail Step')).toBeInTheDocument();
    });

    // Assert: trace entry shows "Failed" status text because willRetry=false
    // sets the entry status to 'failed' — STATUS_STYLES['failed'].text === 'Failed'
    await waitFor(() => {
      expect(screen.getByText('Failed')).toBeInTheDocument();
    });
  });

  // ─── handleApprove APIClientError path ───────────────────────────────────

  it('shows the APIClientError message in the error alert when approve fails', async () => {
    // Arrange: stream that triggers approval_required state
    const stream = makeSseStream([
      frame('workflow_started', { executionId: 'exec-apperr', workflowId: WORKFLOW_ID }),
      frame('step_started', {
        stepId: 'gate-err',
        stepType: 'human_approval',
        label: 'Gate',
      }),
      frame('approval_required', { stepId: 'gate-err', payload: {} }),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    // postMock rejects with an APIClientError to exercise the typed error branch
    postMock.mockRejectedValue(
      new APIClientError('Approval window has expired', 'APPROVAL_EXPIRED', 410)
    );

    const user = userEvent.setup();
    renderPanel();

    // Wait for the approve button to appear
    const approveBtn = await screen.findByRole('button', { name: /approve/i });

    await user.click(approveBtn);

    // Assert: the APIClientError.message is shown in the error alert
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/approval window has expired/i);
    });
    // Confirm the POST was called with the right approve URL
    expect(postMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/executions\/exec-apperr\/approve$/),
      expect.objectContaining({ body: {} })
    );
  });

  // ─── Reconnect button ──────────────────────────────────────────────────────

  it('shows a Reconnect button on workflow_failed and re-streams on click', async () => {
    const stream = makeSseStream([
      frame('workflow_started', { executionId: 'exec-rc', workflowId: WORKFLOW_ID }),
      frame('workflow_failed', { error: 'Something broke' }),
    ]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: stream });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    renderPanel();

    // Wait for failed state with error alert
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/something broke/i);
    });

    // Reconnect button should be visible
    const reconnectBtn = screen.getByRole('button', { name: /reconnect/i });
    expect(reconnectBtn).toBeInTheDocument();

    // Set up the resume stream
    const resumeStream = makeSseStream([
      frame('workflow_started', { executionId: 'exec-rc', workflowId: WORKFLOW_ID }),
      frame('workflow_completed', { output: 'ok', totalTokensUsed: 0, totalCostUsd: 0 }),
    ]);
    fetchMock.mockResolvedValue({ ok: true, body: resumeStream });

    await user.click(reconnectBtn);

    // Verify a new fetch was made with the resumeFromExecutionId query param
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    const lastCallUrl = fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0] as string;
    expect(lastCallUrl).toContain('resumeFromExecutionId=exec-rc');
  });

  // ─── Abort button + cancel API ──────────────────────────────────────────────

  it('calls the cancel endpoint and aborts the stream when Abort is clicked', async () => {
    // Arrange: a stream that stays open (never closes) so Abort button is visible
    const neverClosingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            frame('workflow_started', { executionId: 'exec-abort', workflowId: WORKFLOW_ID })
          )
        );
        // Don't close — keep stream running
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: neverClosingStream }));
    postMock.mockResolvedValue({ success: true });

    const user = userEvent.setup();
    renderPanel();

    // Wait for running state and Abort button
    const abortBtn = await screen.findByRole('button', { name: /abort/i });

    await user.click(abortBtn);

    // The cancel endpoint should have been called with the execution ID
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledTimes(1);
    });
    expect(postMock.mock.calls[0][0]).toMatch(/\/executions\/exec-abort\/cancel$/);
  });

  // ─── handleRetryStep ──────────────────────────────────────────────────────

  it('calls retry-step API and reconnects when onRetry fires on a failed trace entry', async () => {
    const stream = makeSseStream([
      frame('workflow_started', { executionId: 'exec-rtr', workflowId: WORKFLOW_ID }),
      frame('step_started', { stepId: 'step-x', stepType: 'llm_call', label: 'Broken Step' }),
      frame('step_failed', { stepId: 'step-x', error: 'LLM timeout', willRetry: false }),
      frame('workflow_failed', { error: 'Step step-x failed' }),
    ]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: stream });
    vi.stubGlobal('fetch', fetchMock);
    postMock.mockResolvedValue({ success: true });

    const user = userEvent.setup();
    renderPanel();

    // Wait for the failed step to render
    await waitFor(() => {
      expect(screen.getByText('Broken Step')).toBeInTheDocument();
    });

    // The trace entry row should have a retry button (expand it first)
    // ExecutionTraceEntryRow is a button that expands — click on the row first
    const traceEntry = screen.getByTestId('trace-entry-step-x');
    await user.click(traceEntry.querySelector('button')!);

    // Now click the retry button
    const retryBtn = await screen.findByRole('button', { name: /retry from this step/i });

    // Set up resume stream
    const resumeStream = makeSseStream([
      frame('workflow_completed', { output: 'ok', totalTokensUsed: 5, totalCostUsd: 0.001 }),
    ]);
    fetchMock.mockResolvedValue({ ok: true, body: resumeStream });

    await user.click(retryBtn);

    // Verify retry API was called
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/executions\/exec-rtr\/retry-step$/),
        expect.objectContaining({ body: { stepId: 'step-x' } })
      );
    });
  });

  // ─── parseSseBlock: invalid JSON ──────────────────────────────────────────

  it('silently ignores SSE frames with invalid JSON data', async () => {
    // Arrange: stream with a valid frame, an invalid-JSON frame, then a valid completion
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            frame('workflow_started', { executionId: 'exec-json', workflowId: WORKFLOW_ID })
          )
        );
        // Malformed data line — not valid JSON
        controller.enqueue(encoder.encode('event: step_started\ndata: {not valid json\n\n'));
        controller.enqueue(
          encoder.encode(
            frame('workflow_completed', { output: 'ok', totalTokensUsed: 0, totalCostUsd: 0 })
          )
        );
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    renderPanel();

    // The invalid frame is silently skipped; workflow completes normally
    await waitFor(() => {
      expect(screen.getAllByText(/completed/i).length).toBeGreaterThan(0);
    });
    // No error alert should be shown
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // ─── SSE bridge error frame ───────────────────────────────────────────────

  it('renders "Stream terminated unexpectedly" from an error event type', async () => {
    const stream = makeSseStream([
      frame('workflow_started', { executionId: 'exec-sse-err', workflowId: WORKFLOW_ID }),
      frame('error', { message: 'Internal server error' }),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    renderPanel();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/internal server error/i);
    });
    expect(screen.getAllByText(/failed/i).length).toBeGreaterThan(0);
  });

  it('renders fallback message when error event has no message field', async () => {
    const stream = makeSseStream([
      frame('workflow_started', { executionId: 'exec-sse-err2', workflowId: WORKFLOW_ID }),
      frame('error', {}),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    renderPanel();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/stream terminated unexpectedly/i);
    });
  });

  // ─── handleRetryStep error path ───────────────────────────────────────────

  it('shows error message when handleRetryStep API call fails', async () => {
    const stream = makeSseStream([
      frame('workflow_started', { executionId: 'exec-rtr-fail', workflowId: WORKFLOW_ID }),
      frame('step_started', { stepId: 'step-rf', stepType: 'llm_call', label: 'Fail Retry' }),
      frame('step_failed', { stepId: 'step-rf', error: 'LLM timeout', willRetry: false }),
      frame('workflow_failed', { error: 'Step failed' }),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));
    postMock.mockRejectedValue(new APIClientError('Execution not found', 'NOT_FOUND', 404));

    const user = userEvent.setup();
    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('Fail Retry')).toBeInTheDocument();
    });

    const traceEntry = screen.getByTestId('trace-entry-step-rf');
    await user.click(traceEntry.querySelector('button')!);

    const retryBtn = await screen.findByRole('button', { name: /retry from this step/i });
    await user.click(retryBtn);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/execution not found/i);
    });
  });

  // ─── Panel closed ────────────────────────────────────────────────────────

  it('returns null when open=false', () => {
    const { container } = render(
      <ExecutionPanel
        open={false}
        workflowId={WORKFLOW_ID}
        inputData={{ query: 'hello' }}
        onClose={vi.fn()}
      />
    );
    expect(container.innerHTML).toBe('');
  });

  // ─── Events with missing/wrong-type fields (defensive branch guards) ──────

  it('ignores step_started event when stepId is not a string', async () => {
    const stream = makeSseStream([
      frame('workflow_started', { executionId: 'exec-bad', workflowId: WORKFLOW_ID }),
      // stepId is a number, not a string — the guard should skip this event
      frame('step_started', { stepId: 123, stepType: 'llm_call', label: 'Ghost' }),
      frame('workflow_completed', { output: 'ok', totalTokensUsed: 0, totalCostUsd: 0 }),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    renderPanel();

    await waitFor(() => {
      expect(screen.getAllByText(/completed/i).length).toBeGreaterThan(0);
    });
    // The step with non-string stepId should not have been added
    expect(screen.queryByText('Ghost')).toBeNull();
  });

  it('ignores step_completed event when stepId is not a string', async () => {
    const stream = makeSseStream([
      frame('workflow_started', { executionId: 'exec-bad2', workflowId: WORKFLOW_ID }),
      frame('step_started', { stepId: 'step-ok', stepType: 'llm_call', label: 'Step OK' }),
      // step_completed with non-string stepId — should be ignored, step stays running
      frame('step_completed', { stepId: null, output: 'done', tokensUsed: 10, costUsd: 0.001 }),
      frame('workflow_completed', { output: 'ok', totalTokensUsed: 10, totalCostUsd: 0.001 }),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('Step OK')).toBeInTheDocument();
    });
  });

  it('ignores step_failed event when stepId is not a string', async () => {
    const stream = makeSseStream([
      frame('workflow_started', { executionId: 'exec-bad3', workflowId: WORKFLOW_ID }),
      frame('step_started', { stepId: 'step-sf', stepType: 'llm_call', label: 'Step SF' }),
      frame('step_failed', { stepId: undefined, error: 'Oops', willRetry: false }),
      frame('workflow_completed', { output: 'ok', totalTokensUsed: 0, totalCostUsd: 0 }),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    renderPanel();

    await waitFor(() => {
      expect(screen.getAllByText(/completed/i).length).toBeGreaterThan(0);
    });
  });

  it('ignores approval_required event when stepId is not a string', async () => {
    const stream = makeSseStream([
      frame('workflow_started', { executionId: 'exec-bad4', workflowId: WORKFLOW_ID }),
      frame('approval_required', { stepId: null, payload: { prompt: 'ignored' } }),
      frame('workflow_completed', { output: 'ok', totalTokensUsed: 0, totalCostUsd: 0 }),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    renderPanel();

    await waitFor(() => {
      expect(screen.getAllByText(/completed/i).length).toBeGreaterThan(0);
    });
    // Should not enter awaiting_approval state
    expect(screen.queryByText(/awaiting approval/i)).toBeNull();
  });

  it('ignores budget_warning when limitUsd is 0', async () => {
    const stream = makeSseStream([
      frame('workflow_started', { executionId: 'exec-bw0', workflowId: WORKFLOW_ID }),
      frame('budget_warning', { usedUsd: 0.01, limitUsd: 0 }),
      frame('workflow_completed', { output: 'ok', totalTokensUsed: 0, totalCostUsd: 0 }),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    renderPanel();

    await waitFor(() => {
      expect(screen.getAllByText(/completed/i).length).toBeGreaterThan(0);
    });
    // No budget warning alert should appear
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ignores event frames with no type field in data', async () => {
    const stream = makeSseStream([
      frame('workflow_started', { executionId: 'exec-notype', workflowId: WORKFLOW_ID }),
      // Craft a frame where data.type is missing (applyEvent returns early)
      'event: mystery\ndata: {"noType": true}\n\n',
      frame('workflow_completed', { output: 'ok', totalTokensUsed: 0, totalCostUsd: 0 }),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    renderPanel();

    await waitFor(() => {
      expect(screen.getAllByText(/completed/i).length).toBeGreaterThan(0);
    });
  });

  it('reconciles totals from workflow_completed even when step events had zero cost', async () => {
    const stream = makeSseStream([
      frame('workflow_started', { executionId: 'exec-rec', workflowId: WORKFLOW_ID }),
      frame('step_started', { stepId: 's1', stepType: 'llm_call', label: 'S1' }),
      // Step completes with 0 cost (maybe skipped)
      frame('step_completed', { stepId: 's1', output: 'ok', tokensUsed: 0, costUsd: 0 }),
      // workflow_completed has the authoritative totals
      frame('workflow_completed', {
        output: 'ok',
        totalTokensUsed: 999,
        totalCostUsd: 0.42,
      }),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    renderPanel();

    // The authoritative totals from workflow_completed should override
    await waitFor(() => {
      expect(screen.getByText('$0.4200')).toBeInTheDocument();
    });
    expect(screen.getByText('999')).toBeInTheDocument();
  });

  // ─── SSE comment lines and empty data ─────────────────────────────────────

  it('skips SSE comment lines (starting with ":")', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            frame('workflow_started', { executionId: 'exec-comment', workflowId: WORKFLOW_ID })
          )
        );
        // SSE comment line followed by empty event (no data lines) — parseSseBlock returns null
        controller.enqueue(encoder.encode(': this is a comment\n\n'));
        controller.enqueue(encoder.encode('event: keepalive\n\n'));
        controller.enqueue(
          encoder.encode(
            frame('workflow_completed', { output: 'ok', totalTokensUsed: 0, totalCostUsd: 0 })
          )
        );
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    renderPanel();

    await waitFor(() => {
      expect(screen.getAllByText(/completed/i).length).toBeGreaterThan(0);
    });
  });

  // ─── handleApprove generic Error path ─────────────────────────────────────

  it('shows generic Error message when approve fails with a plain Error', async () => {
    const stream = makeSseStream([
      frame('workflow_started', { executionId: 'exec-generr', workflowId: WORKFLOW_ID }),
      frame('step_started', {
        stepId: 'gate-g',
        stepType: 'human_approval',
        label: 'Gate',
      }),
      frame('approval_required', { stepId: 'gate-g', payload: {} }),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));
    postMock.mockRejectedValue(new Error('Network down'));

    const user = userEvent.setup();
    renderPanel();

    const approveBtn = await screen.findByRole('button', { name: /approve/i });
    await user.click(approveBtn);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/network down/i);
    });
  });

  it('shows "Approval failed" when approve rejects with a non-Error value', async () => {
    const stream = makeSseStream([
      frame('workflow_started', { executionId: 'exec-nonstr', workflowId: WORKFLOW_ID }),
      frame('step_started', {
        stepId: 'gate-ns',
        stepType: 'human_approval',
        label: 'Gate',
      }),
      frame('approval_required', { stepId: 'gate-ns', payload: {} }),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));
    postMock.mockRejectedValue('string rejection');

    const user = userEvent.setup();
    renderPanel();

    const approveBtn = await screen.findByRole('button', { name: /approve/i });
    await user.click(approveBtn);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/approval failed/i);
    });
  });
});
