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
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
  vi.restoreAllMocks();
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
    expect(urls.some((u: string) => u.includes('/orchestration/executions/exec-1'))).toBe(true);
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
