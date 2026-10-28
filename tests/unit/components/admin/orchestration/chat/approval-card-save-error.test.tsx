// @vitest-environment happy-dom

/**
 * ApprovalCard — refused approve / reject (§124)
 *
 * The dialog used to close the moment the decision was sent, and a refusal
 * showed in the card behind it. It now stays open until the server accepts,
 * with a refusal inside it, directly above its buttons, focused.
 *
 * @see components/admin/orchestration/chat/approval-card.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApprovalCard } from '@/components/admin/orchestration/chat/approval-card';
import type { PendingApproval } from '@/types/orchestration';

const PENDING: PendingApproval = {
  executionId: 'exec-1',
  stepId: 'step-1',
  prompt: 'Refund £42.50?',
  expiresAt: '2030-01-01T00:00:00.000Z',
  approveToken: 'approve-token-1',
  rejectToken: 'reject-token-1',
};

function refuse(message: string) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ success: false, error: { code: 'CONFLICT', message } }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

describe('ApprovalCard — refused decision', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the approve dialog open with the refusal above its buttons, focused', async () => {
    refuse('This approval has already been decided');
    const onResolved = vi.fn();
    const user = userEvent.setup();
    render(<ApprovalCard pendingApproval={PENDING} onResolved={onResolved} />);

    await user.click(screen.getByRole('button', { name: /approve action/i }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = screen.getByRole('button', { name: 'Approve' });
    await user.click(confirm);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This approval has already been decided');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toContainElement(alert);
    expect(alert.nextElementSibling).toContainElement(confirm);
    await waitFor(() => expect(alert).toHaveFocus());
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('stays open through Escape while the decision is in flight, so a refusal is still seen', async () => {
    let answer: (r: Response) => void = () => undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise<Response>((resolve) => (answer = resolve))
    );
    const user = userEvent.setup();
    render(<ApprovalCard pendingApproval={PENDING} onResolved={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /approve action/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await user.keyboard('{Escape}');

    expect(dialog).toBeInTheDocument();
    // Nothing to press behind it while the decision is out.
    expect(screen.queryByRole('button', { name: /reject action/i })).not.toBeInTheDocument();

    answer(
      new Response(
        JSON.stringify({ success: false, error: { code: 'CONFLICT', message: 'Already decided' } }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      )
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Already decided');
    expect(dialog).toContainElement(screen.getByRole('alert'));
  });

  it('keeps the reject dialog open with the refusal inside it', async () => {
    refuse('Reject token expired');
    const user = userEvent.setup();
    render(<ApprovalCard pendingApproval={PENDING} onResolved={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /reject action/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(screen.getByPlaceholderText('Does not meet compliance'), 'Not today');
    await user.click(screen.getByRole('button', { name: 'Reject' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Reject token expired');
    expect(dialog).toContainElement(alert);
  });
});
