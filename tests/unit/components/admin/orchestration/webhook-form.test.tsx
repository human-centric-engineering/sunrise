/**
 * WebhookForm Tests
 *
 * Test Coverage:
 * - Renders all form fields (URL, secret, description, events, active toggle)
 * - Validates URL required
 * - Validates secret min length
 * - Generate secret button populates the field
 * - Events checkboxes render all 11 event types
 * - Events min validation (at least one event required)
 * - Create happy path (post + navigate)
 * - Edit mode pre-populated fields
 * - Edit mode submit without new secret (source bug candidate — see todo)
 * - API error (APIClientError) surfaces inline error banner
 * - API error (generic Error) surfaces fallback message
 * - Toggle isActive flips the switch
 * - toggleEvent removes a checked event
 *
 * @see components/admin/orchestration/webhook-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { WebhookForm } from '@/components/admin/orchestration/webhook-form';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Hoist a stable pushMock so assertions can observe router.push calls.
const pushMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

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
      public code = 'INTERNAL_ERROR',
      public status = 500
    ) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WebhookForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pushMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Existing tests (keep — do not modify) ───────────────────────────────────

  it('renders all form fields', () => {
    render(<WebhookForm mode="create" />);

    expect(screen.getByRole('textbox', { name: /endpoint url/i })).toBeInTheDocument();
    expect(document.getElementById('secret')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /description/i })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /active/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create webhook/i })).toBeInTheDocument();
  });

  it('renders all 11 event type checkboxes', () => {
    render(<WebhookForm mode="create" />);

    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.length).toBe(11);
  });

  it('validates URL is required on submit', async () => {
    const user = userEvent.setup();
    render(<WebhookForm mode="create" />);

    await user.click(screen.getByRole('button', { name: /create webhook/i }));

    await waitFor(() => {
      expect(screen.getByText(/must be a valid url/i)).toBeInTheDocument();
    });
  });

  it('validates secret minimum length', async () => {
    const user = userEvent.setup();
    render(<WebhookForm mode="create" />);

    // Fill URL and a short secret
    await user.type(
      screen.getByRole('textbox', { name: /endpoint url/i }),
      'https://example.com/hook'
    );
    await user.type(document.getElementById('secret')!, 'short');

    // Select an event
    await user.click(screen.getAllByRole('checkbox')[0]);

    await user.click(screen.getByRole('button', { name: /create webhook/i }));

    await waitFor(() => {
      expect(screen.getByText(/at least 16 characters/i)).toBeInTheDocument();
    });
  });

  it('shows HTTPS-only hint below URL field', () => {
    render(<WebhookForm mode="create" />);

    expect(screen.getByText(/only https urls are accepted/i)).toBeInTheDocument();
  });

  it('generate button populates secret field', async () => {
    const user = userEvent.setup();
    render(<WebhookForm mode="create" />);

    await user.click(screen.getByTitle(/generate a random secret/i));

    const secretInput = document.getElementById('secret')! as HTMLInputElement;
    await waitFor(() => {
      expect(secretInput.value).toMatch(/^whsec_/);
      expect(secretInput.value.length).toBeGreaterThanOrEqual(38);
    });
  });

  // ── New tests ────────────────────────────────────────────────────────────────

  it('shows events validation error when no event is selected on submit', async () => {
    // Arrange
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(<WebhookForm mode="create" />);

    // Act — fill URL + valid secret but leave events unchecked
    await user.type(
      screen.getByRole('textbox', { name: /endpoint url/i }),
      'https://example.com/hook'
    );
    await user.click(screen.getByTitle(/generate a random secret/i));
    await user.click(screen.getByRole('button', { name: /create webhook/i }));

    // Assert — inline validation error appears and the API is NOT called
    await waitFor(() => {
      expect(screen.getByText(/select at least one event/i)).toBeInTheDocument();
    });
    expect(apiClient.post).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });

  it('create happy path: calls apiClient.post and navigates on success', async () => {
    // Arrange
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(<WebhookForm mode="create" />);

    // Fill URL
    await user.type(
      screen.getByRole('textbox', { name: /endpoint url/i }),
      'https://example.com/hook'
    );
    // Generate secret (ensures min-16 requirement is satisfied)
    await user.click(screen.getByTitle(/generate a random secret/i));
    // Select first event checkbox
    await user.click(screen.getAllByRole('checkbox')[0]);

    // Act
    await user.click(screen.getByRole('button', { name: /create webhook/i }));

    // Assert — the POST was made with the webhook URL in the body
    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith(
        '/api/v1/admin/orchestration/webhooks',
        expect.objectContaining({
          body: expect.objectContaining({
            url: 'https://example.com/hook',
            isActive: true,
          }),
        })
      );
    });
    // Assert — navigated to list page
    expect(pushMock).toHaveBeenCalledWith('/admin/orchestration/webhooks');
  });

  it('edit mode: pre-populates fields from existing webhook', () => {
    // Arrange
    const webhook = {
      id: 'wh-1',
      url: 'https://x.com',
      events: ['budget_exceeded'],
      isActive: false,
      description: 'note',
    };

    // Act
    render(<WebhookForm mode="edit" webhook={webhook} />);

    // Assert — URL pre-filled
    const urlInput = screen.getByRole('textbox', { name: /endpoint url/i });
    expect((urlInput as HTMLInputElement).value).toBe('https://x.com');

    // Assert — description pre-filled
    const descInput = screen.getByRole('textbox', { name: /description/i });
    expect((descInput as HTMLInputElement).value).toBe('note');

    // Assert — isActive switch is off
    const toggle = screen.getByRole('switch', { name: /active/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    // Assert — budget_exceeded checkbox is checked
    const checkboxes = screen.getAllByRole('checkbox');
    const budgetCheckbox = checkboxes.find((cb) => {
      const label = cb.closest('label');
      return label?.textContent?.includes('Budget Exceeded');
    });
    expect(budgetCheckbox).toBeDefined();
    expect(budgetCheckbox).toBeChecked();

    // Assert — button label is "Save changes" in edit mode
    expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
  });

  it('edit mode: submits without a new secret and omits the secret key from PATCH body', async () => {
    // Arrange
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockResolvedValue({ success: true });
    const webhook = {
      id: 'wh-1',
      url: 'https://x.com',
      events: ['budget_exceeded'],
      isActive: true,
      description: 'note',
    };
    const user = userEvent.setup();
    render(<WebhookForm mode="edit" webhook={webhook} />);

    // Act — submit without typing a new secret
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    // Assert — PATCH was called with the correct URL and a body that omits `secret`
    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith(
        '/api/v1/admin/orchestration/webhooks/wh-1',
        expect.objectContaining({
          body: expect.not.objectContaining({ secret: expect.anything() }),
        })
      );
    });
    // Assert — body carries through the other fields unchanged
    const patchBody = vi.mocked(apiClient.patch).mock.calls[0]?.[1]?.body as Record<
      string,
      unknown
    >;
    expect(patchBody).toMatchObject({ url: 'https://x.com', isActive: true });
    expect(pushMock).toHaveBeenCalledWith('/admin/orchestration/webhooks');
  });

  it('edit mode: includes new secret in PATCH body when the user changes it', async () => {
    // Arrange
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockResolvedValue({ success: true });
    const webhook = {
      id: 'wh-2',
      url: 'https://y.com',
      events: ['workflow_failed'],
      isActive: true,
      description: null,
    };
    const user = userEvent.setup();
    render(<WebhookForm mode="edit" webhook={webhook} />);

    // Act — type a new secret (≥16 chars to pass edit-mode validation)
    const secretInput = document.getElementById('secret')!;
    await user.type(secretInput, 'new-secret-value-abc123');

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    // Assert — PATCH was called with the correct URL and the new secret in the body
    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith(
        '/api/v1/admin/orchestration/webhooks/wh-2',
        expect.objectContaining({
          body: expect.objectContaining({
            secret: 'new-secret-value-abc123',
            url: 'https://y.com',
          }),
        })
      );
    });
    expect(pushMock).toHaveBeenCalledWith('/admin/orchestration/webhooks');
  });

  it('edit mode: surfaces APIClientError message in error banner when PATCH fails', async () => {
    // Arrange
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Webhook endpoint rejected the request', 'WEBHOOK_REJECTED', 422)
    );
    const webhook = {
      id: 'wh-3',
      url: 'https://z.com',
      events: ['budget_exceeded'],
      isActive: true,
      description: null,
    };
    const user = userEvent.setup();
    render(<WebhookForm mode="edit" webhook={webhook} />);

    // Act — submit (no new secret, so it goes through immediately)
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    // Assert — inline error banner shows the API error message
    await waitFor(() => {
      expect(screen.getByText('Webhook endpoint rejected the request')).toBeInTheDocument();
    });
    // Assert — no navigation occurred after an error
    expect(pushMock).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });

  it('surfaces APIClientError message in error banner on submit failure', async () => {
    // Arrange
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Webhook URL unreachable', 'BAD_URL', 400)
    );
    const user = userEvent.setup();
    render(<WebhookForm mode="create" />);

    await user.type(
      screen.getByRole('textbox', { name: /endpoint url/i }),
      'https://example.com/hook'
    );
    await user.click(screen.getByTitle(/generate a random secret/i));
    await user.click(screen.getAllByRole('checkbox')[0]);

    // Act
    await user.click(screen.getByRole('button', { name: /create webhook/i }));

    // Assert — error banner renders with the API error message
    await waitFor(() => {
      expect(screen.getByText('Webhook URL unreachable')).toBeInTheDocument();
    });
    // Assert — no navigation occurred
    expect(pushMock).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });

  it('surfaces fallback message for non-APIClientError on submit failure', async () => {
    // Arrange
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(new Error('network'));
    const user = userEvent.setup();
    render(<WebhookForm mode="create" />);

    await user.type(
      screen.getByRole('textbox', { name: /endpoint url/i }),
      'https://example.com/hook'
    );
    await user.click(screen.getByTitle(/generate a random secret/i));
    await user.click(screen.getAllByRole('checkbox')[0]);

    // Act
    await user.click(screen.getByRole('button', { name: /create webhook/i }));

    // Assert — fallback message shown
    await waitFor(() => {
      expect(
        screen.getByText(/could not save webhook\. try again in a moment\./i)
      ).toBeInTheDocument();
    });
  });

  it('toggles isActive switch from on to off', async () => {
    // Arrange
    const user = userEvent.setup();
    render(<WebhookForm mode="create" />);

    const toggle = screen.getByRole('switch', { name: /active/i });
    // Default is active (true)
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    // Act
    await user.click(toggle);

    // Assert — switch flipped to inactive
    await waitFor(() => {
      expect(toggle).toHaveAttribute('aria-checked', 'false');
    });
  });

  it('toggleEvent unchecks a previously checked event', async () => {
    // Arrange — start in edit mode with one event pre-checked
    const webhook = {
      id: 'wh-1',
      url: 'https://x.com',
      events: ['budget_exceeded'],
      isActive: true,
      description: null,
    };
    const user = userEvent.setup();
    render(<WebhookForm mode="edit" webhook={webhook} />);

    // Find the budget_exceeded checkbox (it should be checked)
    const checkboxes = screen.getAllByRole('checkbox');
    const budgetCheckbox = checkboxes.find((cb) => {
      const label = cb.closest('label');
      return label?.textContent?.includes('Budget Exceeded');
    });
    expect(budgetCheckbox).toBeDefined();
    expect(budgetCheckbox).toBeChecked();

    // Act — click to uncheck
    await user.click(budgetCheckbox!);

    // Assert — checkbox is now unchecked
    await waitFor(() => {
      expect(budgetCheckbox).not.toBeChecked();
    });
  });
});
