/**
 * Tests for `components/admin/orchestration/webhook-test-button.tsx`
 *
 * Key behaviours:
 * - Idle: shows "Send test event" button
 * - While testing: shows spinner and disables button
 * - Success result: green panel with status code and duration
 * - Failure result from API: red panel with error message
 * - Failure result with statusCode (no error): "Failed with status X"
 * - Thrown error during request: generic "Request failed" fallback
 *
 * @see components/admin/orchestration/webhook-test-button.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WebhookTestButton } from '@/components/admin/orchestration/webhook-test-button';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPost = vi.fn();

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

vi.mock('@/lib/api/endpoints', () => ({
  API: {
    ADMIN: {
      ORCHESTRATION: {
        webhookTest: (id: string) => `/api/v1/admin/orchestration/webhooks/${id}/test`,
      },
    },
  },
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WebhookTestButton', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('renders "Send test event" button in idle state', () => {
    render(<WebhookTestButton webhookId="wh-1" />);

    expect(screen.getByRole('button', { name: /send test event/i })).toBeInTheDocument();
    expect(screen.queryByText(/ping delivered/i)).not.toBeInTheDocument();
  });

  it('calls the webhook test endpoint with the correct webhookId', async () => {
    const user = userEvent.setup();
    mockPost.mockResolvedValue({ success: true, statusCode: 200, durationMs: 42, error: null });

    render(<WebhookTestButton webhookId="wh-99" />);
    await user.click(screen.getByRole('button', { name: /send test event/i }));

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith('/api/v1/admin/orchestration/webhooks/wh-99/test');
    });
  });

  it('shows success panel with status code and duration', async () => {
    const user = userEvent.setup();
    mockPost.mockResolvedValue({ success: true, statusCode: 200, durationMs: 123, error: null });

    render(<WebhookTestButton webhookId="wh-1" />);
    await user.click(screen.getByRole('button', { name: /send test event/i }));

    await waitFor(() => {
      expect(screen.getByText(/ping delivered.*200.*123ms/i)).toBeInTheDocument();
    });
  });

  it('shows failure panel with error message when success is false', async () => {
    const user = userEvent.setup();
    mockPost.mockResolvedValue({
      success: false,
      statusCode: 503,
      durationMs: 50,
      error: 'Connection refused',
    });

    render(<WebhookTestButton webhookId="wh-1" />);
    await user.click(screen.getByRole('button', { name: /send test event/i }));

    await waitFor(() => {
      expect(screen.getByText('Connection refused')).toBeInTheDocument();
    });
  });

  it('shows "Failed with status X" when error is null but success is false', async () => {
    const user = userEvent.setup();
    mockPost.mockResolvedValue({ success: false, statusCode: 404, durationMs: 10, error: null });

    render(<WebhookTestButton webhookId="wh-1" />);
    await user.click(screen.getByRole('button', { name: /send test event/i }));

    await waitFor(() => {
      expect(screen.getByText(/failed with status 404/i)).toBeInTheDocument();
    });
  });

  it('shows "Request failed" fallback when apiClient throws', async () => {
    const user = userEvent.setup();
    mockPost.mockRejectedValue(new Error('Network error'));

    render(<WebhookTestButton webhookId="wh-1" />);
    await user.click(screen.getByRole('button', { name: /send test event/i }));

    await waitFor(() => {
      expect(screen.getByText('Request failed')).toBeInTheDocument();
    });
  });

  it('disables button while testing', async () => {
    const user = userEvent.setup();
    let resolve: (v: unknown) => void;
    mockPost.mockReturnValue(new Promise((r) => (resolve = r)));

    render(<WebhookTestButton webhookId="wh-1" />);
    await user.click(screen.getByRole('button', { name: /send test event/i }));

    expect(screen.getByRole('button')).toBeDisabled();
    resolve!({ success: true, statusCode: 200, durationMs: 10, error: null });
  });
});
