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

// ─── apiClient mock ──────────────────────────────────────────────────────────
// `handleApprove` calls apiClient.post — stub it so we don't need a real fetch
// for the approve request (the main stream is a separate `fetch` call).
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
    expect(call[1]).toMatchObject({ body: { approvalPayload: { approved: true } } });
  });

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

  it('aborts the in-flight stream when the panel unmounts', async () => {
    // A stream that never closes — we remain mid-read at unmount.
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
      // Give the effect a tick to kick off the stream.
      await waitFor(() => {
        expect(fetch).toHaveBeenCalled();
      });
      unmount();
      expect(abortSpy).toHaveBeenCalled();
    } finally {
      globalThis.AbortController = OriginalController;
    }
  });
});
