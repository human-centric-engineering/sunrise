/**
 * ApprovalCard component tests
 *
 * Drives the state machine (idle → submitting → waiting → completed /
 * failed / expired) with a stubbed `fetch`. We don't assert on the
 * dialog primitives — those are covered by Radix's own tests and the
 * shadcn AlertDialog elsewhere — only on the submit + polling
 * behaviour and the synthesised follow-up message handed to
 * `onResolved`.
 *
 * Real timers throughout — using fake timers conflicts with
 * `userEvent`'s internal pointer/keyboard delays. The component's
 * polling backoff starts at 2 seconds; tests use `waitFor` with a
 * generous timeout so the first poll fires naturally.
 *
 * Note on deferred-promise tests: tests that leave promises pending at
 * teardown must (a) unmount explicitly so React no longer holds refs
 * to the component, and (b) resolve/reject the deferred promise so the
 * pending microtask queue drains. Without both, stale setTimeout
 * callbacks from polling fire during the next test's execution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApprovalCard } from '@/components/admin/orchestration/chat/approval-card';
import type { PendingApproval } from '@/types/orchestration';

function makePending(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    executionId: 'exec-1',
    stepId: 'step-1',
    prompt: 'Refund £42.50?',
    expiresAt: '2030-01-01T00:00:00.000Z',
    approveToken: 'approve-token-1',
    rejectToken: 'reject-token-1',
    ...overrides,
  };
}

function mockFetchSequence(responders: Array<(url: string, init?: RequestInit) => Response>): void {
  let i = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(((input: RequestInfo, init?: RequestInit) => {
    const responder = responders[Math.min(i, responders.length - 1)];
    i += 1;
    const url = typeof input === 'string' ? input : input.url;
    return Promise.resolve(responder(url, init));
  }) as typeof fetch);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  // Reset timers FIRST. If a fake-timer test fails before its own
  // `vi.useRealTimers()` line, fake timers leak into the next test and
  // `userEvent.click`'s internal delays hang because nothing advances.
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanup();
});

describe('ApprovalCard', () => {
  it('renders the prompt and Approve/Reject buttons in idle state', () => {
    render(<ApprovalCard pendingApproval={makePending()} onResolved={vi.fn()} />);
    expect(screen.getByText('Refund £42.50?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve action/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject action/i })).toBeInTheDocument();
  });

  it('approve flow: POSTs to /approve/chat, polls execution, calls onResolved with completed output', async () => {
    const onResolved = vi.fn();
    mockFetchSequence([
      // Submit POST
      () => new Response(JSON.stringify({ success: true }), { status: 200 }),
      // Polling GET — completed on first poll
      () =>
        new Response(
          JSON.stringify({
            data: {
              status: 'completed',
              executionTrace: [{ status: 'completed', output: { refundId: 'r-99' } }],
            },
          }),
          { status: 200 }
        ),
    ]);

    const user = userEvent.setup();
    render(<ApprovalCard pendingApproval={makePending()} onResolved={onResolved} />);

    await user.click(screen.getByRole('button', { name: /approve action/i }));
    const confirmBtn = await screen.findByRole('button', { name: 'Approve' });
    await user.click(confirmBtn);

    await waitFor(
      () => {
        expect(onResolved).toHaveBeenCalled();
      },
      { timeout: 6_000 }
    );

    const [action, followup] = onResolved.mock.calls[0];
    expect(action).toBe('approved');
    expect(followup).toContain('Workflow approved.');
    expect(followup).toContain('refundId');

    const calls = (fetch as unknown as ReturnType<typeof vi.spyOn>).mock.calls as unknown[][];
    const urls = calls.map((c: unknown[]) =>
      typeof c[0] === 'string' ? c[0] : (c[0] as Request).url
    );
    expect(urls.some((u: string) => u.includes('/approve/chat?token=approve-token-1'))).toBe(true);
    // Polls the public token-auth status endpoint (not the admin
    // executions endpoint, which has a wrapped response shape).
    expect(
      urls.some((u: string) =>
        u.includes('/orchestration/approvals/exec-1/status?token=approve-token-1')
      )
    ).toBe(true);
  }, 10_000);

  it('approve completion with no usable output emits "approved successfully" follow-up (not "Result: ")', async () => {
    const onResolved = vi.fn();
    mockFetchSequence([
      () => new Response(JSON.stringify({ success: true }), { status: 200 }),
      () =>
        new Response(
          JSON.stringify({
            data: {
              status: 'completed',
              executionTrace: [
                // Approval-only workflow: only the approval step, output is the approval payload.
                // Treating null output as "no usable result" — see safeStringify guard.
                { status: 'completed', output: null },
              ],
            },
          }),
          { status: 200 }
        ),
    ]);

    const user = userEvent.setup();
    render(<ApprovalCard pendingApproval={makePending()} onResolved={onResolved} />);

    await user.click(screen.getByRole('button', { name: /approve action/i }));
    const confirmBtn = await screen.findByRole('button', { name: 'Approve' });
    await user.click(confirmBtn);

    await waitFor(
      () => {
        expect(onResolved).toHaveBeenCalled();
      },
      { timeout: 6_000 }
    );

    const [, followup] = onResolved.mock.calls[0];
    expect(followup).toBe('Workflow approved successfully.');
    expect(followup).not.toContain('Result: ');
  }, 10_000);

  it('reject flow: POSTs to /reject/chat with reason, surfaces as rejected', async () => {
    const onResolved = vi.fn();
    mockFetchSequence([
      () => new Response(JSON.stringify({ success: true }), { status: 200 }),
      () =>
        new Response(
          JSON.stringify({
            data: { status: 'cancelled', errorMessage: 'Rejected: Does not meet compliance' },
          }),
          { status: 200 }
        ),
    ]);

    const user = userEvent.setup();
    render(<ApprovalCard pendingApproval={makePending()} onResolved={onResolved} />);

    await user.click(screen.getByRole('button', { name: /reject action/i }));
    const reasonField = await screen.findByPlaceholderText(/Does not meet compliance/i);
    await user.type(reasonField, 'Does not meet compliance');
    const confirmBtn = screen.getByRole('button', { name: 'Reject' });
    await user.click(confirmBtn);

    await waitFor(
      () => {
        expect(onResolved).toHaveBeenCalled();
      },
      { timeout: 6_000 }
    );

    const [action, followup] = onResolved.mock.calls[0];
    expect(action).toBe('rejected');
    expect(followup).toContain('Workflow rejected:');

    // Rendered terminal-state copy must reflect the reject path —
    // not "Approved — workflow completed." which used to leak through
    // the shared `completed` state.
    expect(screen.getByText(/Rejected — workflow cancelled/i)).toBeInTheDocument();
    expect(screen.queryByText(/Approved — workflow completed/i)).not.toBeInTheDocument();

    const calls = (fetch as unknown as ReturnType<typeof vi.spyOn>).mock.calls as unknown[][];
    const submitCall = calls.find((c: unknown[]) => {
      const u = typeof c[0] === 'string' ? c[0] : (c[0] as Request).url;
      return u.includes('/reject/chat');
    });
    expect(submitCall).toBeDefined();
    const submitUrl =
      typeof submitCall![0] === 'string' ? submitCall![0] : (submitCall![0] as Request).url;
    expect(submitUrl).toContain('token=reject-token-1');
    const body = JSON.parse((submitCall![1] as RequestInit).body as string);
    expect(body).toEqual({ reason: 'Does not meet compliance' });
  }, 10_000);

  it('surfaces a failure message when the submit POST returns non-2xx', async () => {
    const onResolved = vi.fn();
    mockFetchSequence([
      () => new Response(JSON.stringify({ error: { message: 'Token expired' } }), { status: 401 }),
    ]);

    const user = userEvent.setup();
    render(<ApprovalCard pendingApproval={makePending()} onResolved={onResolved} />);

    await user.click(screen.getByRole('button', { name: /approve action/i }));
    const confirmBtn = await screen.findByRole('button', { name: 'Approve' });
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(screen.getByText(/Failed: Token expired/)).toBeInTheDocument();
    });
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('renders Reject confirm as disabled when reason is empty', async () => {
    const user = userEvent.setup();
    render(<ApprovalCard pendingApproval={makePending()} onResolved={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /reject action/i }));
    const confirm = await screen.findByRole('button', { name: 'Reject' });
    expect(confirm).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Body shape and dialog interactions
// ---------------------------------------------------------------------------

describe('ApprovalCard — body shape and dialog interactions', () => {
  it('opens the Approve dialog and shows the notes textarea when Approve button is clicked', async () => {
    // Arrange
    const user = userEvent.setup();
    render(<ApprovalCard pendingApproval={makePending()} onResolved={vi.fn()} />);

    // Act
    await user.click(screen.getByRole('button', { name: /approve action/i }));

    // Assert: dialog is open with notes field visible
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Looks good/i)).toBeInTheDocument();
  });

  it('opens the Reject dialog and shows the reason textarea when Reject button is clicked', async () => {
    // Arrange
    const user = userEvent.setup();
    render(<ApprovalCard pendingApproval={makePending()} onResolved={vi.fn()} />);

    // Act
    await user.click(screen.getByRole('button', { name: /reject action/i }));

    // Assert: dialog is open with reason field visible
    expect(await screen.findByRole('button', { name: 'Reject' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Does not meet compliance/i)).toBeInTheDocument();
  });

  it('includes notes in the Approve POST body when the notes textarea is non-empty', async () => {
    // Arrange
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    const user = userEvent.setup();
    render(<ApprovalCard pendingApproval={makePending()} onResolved={vi.fn()} />);

    // Act: open dialog, fill notes, submit
    await user.click(screen.getByRole('button', { name: /approve action/i }));
    await user.type(await screen.findByPlaceholderText(/Looks good/i), 'Looks good');
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    // Assert: POST body contains notes key
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const submitCall = fetchSpy.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/approve/chat')
    );
    expect(submitCall).toBeDefined();
    const body = JSON.parse(submitCall![1]?.body as string);
    expect(body).toHaveProperty('notes', 'Looks good');
  }, 10_000);

  it('omits the notes key from the Approve POST body when notes textarea is left empty', async () => {
    // Arrange
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    const user = userEvent.setup();
    render(<ApprovalCard pendingApproval={makePending()} onResolved={vi.fn()} />);

    // Act: open dialog, leave notes empty, submit
    await user.click(screen.getByRole('button', { name: /approve action/i }));
    await screen.findByPlaceholderText(/Looks good/i); // wait for dialog
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    // Assert: POST body does NOT contain notes key
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const submitCall = fetchSpy.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/approve/chat')
    );
    expect(submitCall).toBeDefined();
    const body = JSON.parse(submitCall![1]?.body as string);
    expect(body).not.toHaveProperty('notes');
  }, 10_000);

  it('does not fire a fetch request when Reject is submitted with whitespace-only reason', async () => {
    // Arrange
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    render(<ApprovalCard pendingApproval={makePending()} onResolved={vi.fn()} />);

    // Act: open Reject dialog, type whitespace
    await user.click(screen.getByRole('button', { name: /reject action/i }));
    await user.type(await screen.findByPlaceholderText(/Does not meet compliance/i), '   ');

    // The Reject button remains disabled because the reason is whitespace-only
    const rejectBtn = screen.getByRole('button', { name: 'Reject' });
    expect(rejectBtn).toBeDisabled();

    // Assert: no fetch call has been made
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends the Approve POST with credentials: include', async () => {
    // Arrange
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    const user = userEvent.setup();
    render(<ApprovalCard pendingApproval={makePending()} onResolved={vi.fn()} />);

    // Act
    await user.click(screen.getByRole('button', { name: /approve action/i }));
    await screen.findByRole('button', { name: 'Approve' });
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    // Assert: the submit fetch was called with credentials: 'include'
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const submitCall = fetchSpy.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/approve/chat')
    );
    expect(submitCall).toBeDefined();
    expect(submitCall![1]?.credentials).toBe('include');
  }, 10_000);
});

// ---------------------------------------------------------------------------
// State machine transitions
// ---------------------------------------------------------------------------

describe('ApprovalCard — state machine transitions', () => {
  it('shows "Submitting approval…" spinner copy while the approve POST is in flight', async () => {
    // Arrange: deferred promise controls the POST response timing
    let resolvePost!: (r: Response) => void;
    const postPromise = new Promise<Response>((res) => {
      resolvePost = res;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => postPromise);
    const user = userEvent.setup();
    const { unmount } = render(
      <ApprovalCard pendingApproval={makePending()} onResolved={vi.fn()} />
    );

    // Act: open dialog and submit; POST stays in flight
    await user.click(screen.getByRole('button', { name: /approve action/i }));
    await screen.findByRole('button', { name: 'Approve' });
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    // Assert: submitting copy visible while POST is in flight
    await waitFor(() => {
      expect(screen.getByText('Submitting approval…')).toBeInTheDocument();
    });

    // Cleanup: unmount first, then resolve so the microtask drains cleanly
    unmount();
    await act(async () => {
      resolvePost(new Response(JSON.stringify({ success: true }), { status: 200 }));
      await Promise.resolve();
    });
  }, 10_000);

  it('shows "Submitting rejection…" spinner copy while the reject POST is in flight', async () => {
    // Arrange: deferred POST
    let resolvePost!: (r: Response) => void;
    const postPromise = new Promise<Response>((res) => {
      resolvePost = res;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => postPromise);
    const user = userEvent.setup();
    const { unmount } = render(
      <ApprovalCard pendingApproval={makePending()} onResolved={vi.fn()} />
    );

    // Act: open Reject dialog, fill reason, submit without resolving
    await user.click(screen.getByRole('button', { name: /reject action/i }));
    await user.type(await screen.findByPlaceholderText(/Does not meet compliance/i), 'Not valid');
    await user.click(screen.getByRole('button', { name: 'Reject' }));

    // Assert: rejection spinner copy visible while POST is in flight
    await waitFor(() => {
      expect(screen.getByText('Submitting rejection…')).toBeInTheDocument();
    });

    // Cleanup
    unmount();
    await act(async () => {
      resolvePost(new Response(JSON.stringify({ success: true }), { status: 200 }));
      await Promise.resolve();
    });
  }, 10_000);

  it('shows "Waiting for the workflow to finish…" after submit_ok while the first poll is pending', async () => {
    // Arrange: POST resolves immediately; poll hangs
    let resolvePoll!: (r: Response) => void;
    const pollPromise = new Promise<Response>((res) => {
      resolvePoll = res;
    });
    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
      }
      return pollPromise;
    });
    const user = userEvent.setup();
    const { unmount } = render(
      <ApprovalCard pendingApproval={makePending()} onResolved={vi.fn()} />
    );

    // Act
    await user.click(screen.getByRole('button', { name: /approve action/i }));
    await screen.findByRole('button', { name: 'Approve' });
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    // Assert: waiting copy appears after POST succeeds
    await waitFor(
      () => {
        expect(screen.getByText('Waiting for the workflow to finish…')).toBeInTheDocument();
      },
      { timeout: 6_000 }
    );

    // Cleanup: unmount first so no stale React state update from poll resolution
    unmount();
    await act(async () => {
      resolvePoll(
        new Response(JSON.stringify({ data: { status: 'completed', executionTrace: [] } }), {
          status: 200,
        })
      );
      await Promise.resolve();
    });
  }, 12_000);

  it('shows "Approved — workflow completed." after the poll returns completed on the approve path', async () => {
    // Arrange
    mockFetchSequence([
      () => new Response(JSON.stringify({ success: true }), { status: 200 }),
      () =>
        new Response(JSON.stringify({ data: { status: 'completed', executionTrace: [] } }), {
          status: 200,
        }),
    ]);
    const user = userEvent.setup();
    render(<ApprovalCard pendingApproval={makePending()} onResolved={vi.fn()} />);

    // Act
    await user.click(screen.getByRole('button', { name: /approve action/i }));
    await screen.findByRole('button', { name: 'Approve' });
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    // Assert: completed copy is the approve variant
    await waitFor(
      () => {
        expect(screen.getByText('Approved — workflow completed.')).toBeInTheDocument();
      },
      { timeout: 6_000 }
    );
  }, 10_000);

  it('calls onResolved and renders failed state when poll returns status failed on the approve path', async () => {
    // Arrange: status=failed on approve path dispatches poll_failed AND calls onResolved
    // per source lines 124-133: the approve path calls onResolved('approved', followup)
    // even for failed/cancelled executions, so the chat LLM can acknowledge the failure.
    const onResolved = vi.fn();
    mockFetchSequence([
      () => new Response(JSON.stringify({ success: true }), { status: 200 }),
      () =>
        new Response(
          JSON.stringify({
            data: { status: 'failed', errorMessage: 'Step timed out' },
          }),
          { status: 200 }
        ),
    ]);
    const user = userEvent.setup();
    render(<ApprovalCard pendingApproval={makePending()} onResolved={onResolved} />);

    // Act
    await user.click(screen.getByRole('button', { name: /approve action/i }));
    await screen.findByRole('button', { name: 'Approve' });
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    // Assert: onResolved called with failure followup and failed state UI rendered
    await waitFor(
      () => {
        expect(onResolved).toHaveBeenCalledWith('approved', 'Workflow failed: Step timed out');
      },
      { timeout: 6_000 }
    );
    // poll_failed → {kind: 'failed'} state — not 'completed'
    expect(screen.getByText(/Failed: Step timed out/i)).toBeInTheDocument();
    expect(screen.queryByText(/Approved — workflow completed/i)).not.toBeInTheDocument();
  }, 10_000);

  it('calls onResolved and renders failed state (not completed) when poll returns cancelled on the approve path', async () => {
    // Arrange: cancelled on approve path → poll_failed (not poll_completed)
    // Critical asymmetric branch: approve + cancelled → poll_failed (unlike reject + cancelled → poll_completed)
    const onResolved = vi.fn();
    mockFetchSequence([
      () => new Response(JSON.stringify({ success: true }), { status: 200 }),
      () =>
        new Response(
          JSON.stringify({
            data: { status: 'cancelled', errorMessage: 'Workflow cancelled externally' },
          }),
          { status: 200 }
        ),
    ]);
    const user = userEvent.setup();
    render(<ApprovalCard pendingApproval={makePending()} onResolved={onResolved} />);

    // Act
    await user.click(screen.getByRole('button', { name: /approve action/i }));
    await screen.findByRole('button', { name: 'Approve' });
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    // Assert: onResolved called with failure followup; component in failed state (not completed)
    await waitFor(
      () => {
        expect(onResolved).toHaveBeenCalledWith(
          'approved',
          'Workflow failed: Workflow cancelled externally'
        );
      },
      { timeout: 6_000 }
    );
    // poll_failed dispatched → {kind: 'failed'} — not {kind: 'completed'}
    expect(screen.getByText(/Failed: Workflow cancelled externally/i)).toBeInTheDocument();
    expect(screen.queryByText(/Approved — workflow completed/i)).not.toBeInTheDocument();
  }, 10_000);

  it('shows the budget-expired advisory after the poll budget (5min) is exceeded', async () => {
    // Arrange: use fake timers so we can advance past POLL_BUDGET_MS (5 minutes)
    // without waiting in real time. POST succeeds; polls return non-terminal
    // 'running' status so the budget check is the only thing that ends the loop.
    //
    // Pattern: fake timers + `fireEvent` (not userEvent). userEvent's internal
    // delays use setTimeout, which becomes fake under `vi.useFakeTimers()` and
    // hangs userEvent's internal Promise chain regardless of `advanceTimers`
    // config — see tests/unit/components/forms/profile-form.test.tsx (fake-timer
    // test at the bottom) for the established codebase pattern.
    vi.useFakeTimers();

    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ data: { status: 'running' } }), { status: 200 })
      );
    });

    render(<ApprovalCard pendingApproval={makePending()} onResolved={vi.fn()} />);

    // Open the approve dialog (synchronous fireEvent, fake-timer safe)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /approve action/i }));
    });

    // Confirm approval — handleApprove fires submit() asynchronously
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
      // Flush the POST microtask so submit_ok dispatches and startPolling kicks off
      await Promise.resolve();
    });

    // Advance past the 5-minute budget. advanceTimersByTimeAsync flushes
    // microtasks between each fired timer, so polling tick → fetch (running) →
    // setTimeout(next tick) chains until Date.now() - startedAt > POLL_BUDGET_MS
    // and dispatch({ type: 'poll_expired' }) fires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000 + 10_000);
    });

    // Assert: expired-state advisory is rendered. Synchronous getByText —
    // the poll_expired dispatch and the re-render already happened inside act().
    expect(screen.getByText(/This is taking longer than expected/i)).toBeInTheDocument();

    // afterEach calls vi.useRealTimers() unconditionally — no need to do it here
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Error and cleanup paths
// ---------------------------------------------------------------------------

describe('ApprovalCard — error and cleanup paths', () => {
  it('suppresses AbortError during submit and shows no failure message', async () => {
    // Arrange: POST rejects with AbortError — simulates the component's own abort of a
    // double-submit (submitAbortRef.current?.abort() at the top of submit()).
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
    );
    const user = userEvent.setup();
    const { unmount } = render(
      <ApprovalCard pendingApproval={makePending()} onResolved={vi.fn()} />
    );

    // Act
    await user.click(screen.getByRole('button', { name: /approve action/i }));
    await screen.findByRole('button', { name: 'Approve' });
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    // Let the rejected promise and its catch branch settle
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Assert: AbortError is silently suppressed — the component stays in submitting state
    // (returns early from catch without dispatching failure), so no Failed: text appears.
    expect(screen.queryByText(/Failed:/i)).not.toBeInTheDocument();

    unmount();
  }, 10_000);

  it('suppresses AbortError during polling and shows no failure message', async () => {
    // Arrange: POST succeeds; poll rejects with AbortError
    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
      }
      return Promise.reject(
        Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
      );
    });
    const user = userEvent.setup();
    const { unmount } = render(
      <ApprovalCard pendingApproval={makePending()} onResolved={vi.fn()} />
    );

    // Act
    await user.click(screen.getByRole('button', { name: /approve action/i }));
    await screen.findByRole('button', { name: 'Approve' });
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    // Wait for the poll fetch to be invoked (after POST resolves)
    await waitFor(() => expect(callCount).toBeGreaterThanOrEqual(2), { timeout: 6_000 });

    // Let the AbortError catch branch settle
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Assert: AbortError during poll is suppressed — no failure state rendered
    expect(screen.queryByText(/Failed:/i)).not.toBeInTheDocument();

    unmount();
  }, 10_000);

  it('aborts both submit and poll AbortController signals when the component unmounts', async () => {
    // Arrange: capture the AbortSignal passed to each fetch call.
    // POST hangs so submit is in flight; once resolved, poll also hangs.
    const capturedSignals: AbortSignal[] = [];
    let resolvePost!: (r: Response) => void;
    const postPromise = new Promise<Response>((res) => {
      resolvePost = res;
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.signal) capturedSignals.push(init.signal);
        if (capturedSignals.length === 1) {
          // First call = submit POST — hang until resolved
          return postPromise;
        }
        // Subsequent calls = polls — hang indefinitely
        return new Promise<Response>(() => {
          // Intentionally never resolves — aborted by unmount
        });
      }
    );

    const user = userEvent.setup();
    const { unmount } = render(
      <ApprovalCard pendingApproval={makePending()} onResolved={vi.fn()} />
    );

    // Act: trigger approve — POST goes in flight
    await user.click(screen.getByRole('button', { name: /approve action/i }));
    await screen.findByRole('button', { name: 'Approve' });
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    // Wait for the submit signal to be captured
    await waitFor(() => expect(capturedSignals.length).toBeGreaterThanOrEqual(1), {
      timeout: 3_000,
    });
    const submitSignal = capturedSignals[0];
    expect(submitSignal.aborted).toBe(false);

    // Resolve the POST so polling starts
    await act(async () => {
      resolvePost(new Response(JSON.stringify({ success: true }), { status: 200 }));
    });

    // Wait for the poll signal to be captured
    await waitFor(() => expect(capturedSignals.length).toBeGreaterThanOrEqual(2), {
      timeout: 6_000,
    });
    const pollSignal = capturedSignals[1];
    expect(pollSignal.aborted).toBe(false);

    // Act: unmount — the cleanup effect aborts both controllers
    unmount();

    // Assert: both signals are now aborted
    expect(submitSignal.aborted).toBe(true);
    expect(pollSignal.aborted).toBe(true);
  }, 15_000);

  it('falls back to "Request failed (N)" when the error response body cannot be parsed as JSON', async () => {
    // Arrange: 500 response whose json() rejects — exercises the .catch(() => ({})) branch
    const mockResponse = new Response('Internal Server Error', { status: 500 });
    // json() rejects with a parse error simulating a plain-text body
    vi.spyOn(mockResponse, 'json').mockRejectedValue(new SyntaxError('Unexpected token I'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

    const user = userEvent.setup();
    render(<ApprovalCard pendingApproval={makePending()} onResolved={vi.fn()} />);

    // Act
    await user.click(screen.getByRole('button', { name: /approve action/i }));
    await screen.findByRole('button', { name: 'Approve' });
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    // Assert: fallback message uses the status code — "Request failed (500)"
    await waitFor(
      () => {
        expect(screen.getByText('Failed: Request failed (500)')).toBeInTheDocument();
      },
      { timeout: 5_000 }
    );
  }, 10_000);

  it('applies exponential backoff between poll retries: 2000ms → 3000ms → 4500ms → 5000ms (capped)', async () => {
    // Arrange: fake timers to observe setTimeout call arguments.
    // POST succeeds; all polls fail transiently (non-AbortError hits the retry path).
    // Same fake-timer + fireEvent pattern as the budget-expired test above —
    // userEvent + fake timers don't mix cleanly.
    vi.useFakeTimers();

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
      }
      // Transient errors (not AbortError) increment attempt and schedule the next retry
      return Promise.reject(new Error('transient network error'));
    });

    render(<ApprovalCard pendingApproval={makePending()} onResolved={vi.fn()} />);

    // Open dialog
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /approve action/i }));
    });

    // Confirm — POST resolves, submit_ok dispatches, polling starts, first tick fires fetch
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
      await Promise.resolve();
    });

    // Each transient error increments `attempt` and schedules the next tick:
    //   attempt=1: delay = min(2000 * 1.5^0, 5000) = 2000
    //   attempt=2: delay = min(2000 * 1.5^1, 5000) = 3000
    //   attempt=3: delay = min(2000 * 1.5^2, 5000) = 4500
    //   attempt=4: delay = min(2000 * 1.5^3, 5000) = min(6750, 5000) = 5000
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_500);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    // Assert: setTimeout was called with the expected backoff delays.
    // Filter to the component's polling setTimeout calls (delay in 1000–6000ms range);
    // anything smaller is React/jsdom internal scheduling, anything larger is unrelated.
    const backoffDelays = setTimeoutSpy.mock.calls
      .map((args) => args[1] as number)
      .filter((delay) => typeof delay === 'number' && delay >= 1_000 && delay <= 6_000);

    expect(backoffDelays).toContain(2_000);
    expect(backoffDelays).toContain(3_000);
    expect(backoffDelays).toContain(4_500);
    // 4th retry is capped at POLL_MAX_MS (5000ms) — Math.min(2000 * 1.5^3, 5000)
    expect(backoffDelays).toContain(5_000);
  }, 30_000);
});
