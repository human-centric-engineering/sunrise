/**
 * WebhookForm Tests
 *
 * Test Coverage:
 * - Renders all form fields (URL, secret, description, events, active toggle)
 * - Validates URL required
 * - Validates secret min length
 * - Generate secret button populates the field
 * - Events checkboxes render all 12 event types (incl. execution_crashed)
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
    expect(screen.getByRole('button', { name: /create subscription/i })).toBeInTheDocument();
  });

  it('renders all 12 event type checkboxes', () => {
    render(<WebhookForm mode="create" />);

    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.length).toBe(12);
  });

  it('includes execution_crashed in the event list (engine-crash subscriptions)', () => {
    render(<WebhookForm mode="create" />);
    expect(screen.getByText(/execution crashed/i)).toBeInTheDocument();
  });

  it('validates URL is required on submit', async () => {
    const user = userEvent.setup();
    render(<WebhookForm mode="create" />);

    await user.click(screen.getByRole('button', { name: /create subscription/i }));

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

    await user.click(screen.getByRole('button', { name: /create subscription/i }));

    await waitFor(() => {
      expect(screen.getByText(/at least 16 characters/i)).toBeInTheDocument();
    });
  });

  it('shows URL safety hint below URL field', () => {
    render(<WebhookForm mode="create" />);

    expect(
      screen.getByText(/private ips, localhost, and cloud metadata endpoints are blocked/i)
    ).toBeInTheDocument();
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

  // ── Retry policy ─────────────────────────────────────────────────────────────

  it('renders retry policy fields with sensible defaults in create mode', () => {
    render(<WebhookForm mode="create" />);

    const maxAttempts = document.getElementById('maxAttempts') as HTMLInputElement;
    const backoff = document.getElementById('retryBackoffSeconds') as HTMLInputElement;
    // test-review:accept tobe_literal — default values are part of the form contract
    expect(maxAttempts.value).toBe('3');
    expect(backoff.value).toBe('10, 60, 300');
  });

  it('pre-fills retry policy fields from an existing webhook in edit mode', () => {
    const webhook = {
      id: 'wh-policy',
      url: 'https://x.com',
      events: ['budget_exceeded'],
      isActive: true,
      description: null,
      maxAttempts: 5,
      retryBackoffMs: [15_000, 60_000, 120_000, 600_000],
    };
    render(<WebhookForm mode="edit" webhook={webhook} />);

    const maxAttempts = document.getElementById('maxAttempts') as HTMLInputElement;
    const backoff = document.getElementById('retryBackoffSeconds') as HTMLInputElement;
    expect(maxAttempts.value).toBe('5');
    // Stored as ms — displayed as seconds.
    expect(backoff.value).toBe('15, 60, 120, 600');
  });

  it('submits retry policy as an ms array even though the field is entered in seconds', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(<WebhookForm mode="create" />);

    await user.type(
      screen.getByRole('textbox', { name: /endpoint url/i }),
      'https://example.com/hook'
    );
    await user.click(screen.getByTitle(/generate a random secret/i));
    await user.click(screen.getAllByRole('checkbox')[0]);

    // Change attempts to 4 and backoff to "5, 15, 45"
    const maxAttempts = document.getElementById('maxAttempts') as HTMLInputElement;
    await user.clear(maxAttempts);
    await user.type(maxAttempts, '4');
    const backoff = document.getElementById('retryBackoffSeconds') as HTMLInputElement;
    await user.clear(backoff);
    await user.type(backoff, '5, 15, 45');

    await user.click(screen.getByRole('button', { name: /create subscription/i }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith(
        '/api/v1/admin/orchestration/webhooks',
        expect.objectContaining({
          body: expect.objectContaining({
            maxAttempts: 4,
            retryBackoffMs: [5_000, 15_000, 45_000],
          }),
        })
      );
    });
  });

  it('blocks submission when backoff has fewer entries than maxAttempts - 1', async () => {
    const { apiClient } = await import('@/lib/api/client');
    const user = userEvent.setup();
    render(<WebhookForm mode="create" />);

    await user.type(
      screen.getByRole('textbox', { name: /endpoint url/i }),
      'https://example.com/hook'
    );
    await user.click(screen.getByTitle(/generate a random secret/i));
    await user.click(screen.getAllByRole('checkbox')[0]);

    const maxAttempts = document.getElementById('maxAttempts') as HTMLInputElement;
    await user.clear(maxAttempts);
    await user.type(maxAttempts, '5'); // needs 4 backoff entries
    const backoff = document.getElementById('retryBackoffSeconds') as HTMLInputElement;
    await user.clear(backoff);
    await user.type(backoff, '10, 60'); // only 2 entries

    await user.click(screen.getByRole('button', { name: /create subscription/i }));

    await waitFor(() => {
      expect(screen.getByText(/at least \(maxAttempts - 1\) backoff/i)).toBeInTheDocument();
    });
    expect(apiClient.post).not.toHaveBeenCalled();
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
    await user.click(screen.getByRole('button', { name: /create subscription/i }));

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
    await user.click(screen.getByRole('button', { name: /create subscription/i }));

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
    expect(pushMock).toHaveBeenCalledWith('/admin/orchestration/event-subscriptions');
  });

  it('edit mode: pre-populates fields from existing webhook', () => {
    // Arrange
    const webhook = {
      id: 'wh-1',
      url: 'https://x.com',
      events: ['budget_exceeded'],
      isActive: false,
      description: 'note',
      maxAttempts: 3,
      retryBackoffMs: [10000, 60000],
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
      maxAttempts: 3,
      retryBackoffMs: [10000, 60000],
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
    expect(pushMock).toHaveBeenCalledWith('/admin/orchestration/event-subscriptions');
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
      maxAttempts: 3,
      retryBackoffMs: [10000, 60000],
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
    expect(pushMock).toHaveBeenCalledWith('/admin/orchestration/event-subscriptions');
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
      maxAttempts: 3,
      retryBackoffMs: [10000, 60000],
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
    await user.click(screen.getByRole('button', { name: /create subscription/i }));

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
    await user.click(screen.getByRole('button', { name: /create subscription/i }));

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
      maxAttempts: 3,
      retryBackoffMs: [10000, 60000],
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

  // ── Secret affordances: reveal / copy / capture cue ─────────────────────────

  // ── Event picklist: unwired events are disabled ────────────────────────────

  it('disables event checkboxes whose dispatch path is not wired yet', () => {
    render(<WebhookForm mode="create" />);

    const checkboxes = screen.getAllByRole('checkbox');
    // Map each checkbox to its visible label text.
    const states = checkboxes.map((cb) => ({
      label: cb.closest('label')?.textContent ?? '',
      disabled: (cb as HTMLInputElement).disabled,
    }));

    // Wired events — must be enabled. Source of truth:
    // WIRED_WEBHOOK_EVENT_TYPES in lib/validations/orchestration.ts.
    const wired = [
      'Budget Exceeded',
      'Workflow Failed',
      'Approval Required',
      'Circuit Breaker Opened',
      'Agent Updated',
      'Execution Crashed',
    ];
    for (const label of wired) {
      const entry = states.find((s) => s.label.startsWith(label));
      expect(entry, `${label} should be in the picklist`).toBeDefined();
      expect(entry!.disabled, `${label} should be enabled`).toBe(false);
    }

    // Unwired events — present but disabled.
    const unwired = [
      'Conversation Started',
      'Conversation Completed',
      'Message Created',
      'Budget Threshold Reached',
      'Execution Completed',
      'Execution Failed',
    ];
    for (const label of unwired) {
      const entry = states.find((s) => s.label.startsWith(label));
      expect(entry, `${label} should be in the picklist`).toBeDefined();
      expect(entry!.disabled, `${label} should be disabled`).toBe(true);
    }
  });

  it('clicking a disabled event checkbox does not select it', async () => {
    const user = userEvent.setup();
    render(<WebhookForm mode="create" />);

    const checkboxes = screen.getAllByRole('checkbox');
    const messageCreated = checkboxes.find((cb) => {
      const label = cb.closest('label');
      return label?.textContent?.includes('Message Created');
    });
    expect(messageCreated).toBeDefined();
    expect((messageCreated as HTMLInputElement).disabled).toBe(true);

    // Browsers ignore clicks on disabled inputs; assert state stays unchecked.
    await user.click(messageCreated!);
    expect((messageCreated as HTMLInputElement).checked).toBe(false);
  });

  // ── Secret affordances: reveal / copy / capture cue ─────────────────────────

  it('reveal/copy buttons are disabled when the secret field is empty', () => {
    render(<WebhookForm mode="create" />);

    const reveal = screen.getByRole('button', { name: /reveal secret/i });
    const copy = screen.getByRole('button', { name: /copy secret to clipboard/i });
    expect(reveal).toBeDisabled();
    expect(copy).toBeDisabled();
  });

  it('does not show the "copy this secret now" cue when no secret has been entered', () => {
    render(<WebhookForm mode="create" />);
    expect(screen.queryByText(/copy this secret now/i)).not.toBeInTheDocument();
  });

  it('reveals the secret when the eye toggle is clicked', async () => {
    const user = userEvent.setup();
    render(<WebhookForm mode="create" />);

    // Generate a secret so the toggle is enabled.
    await user.click(screen.getByTitle(/generate a random secret/i));

    const secret = document.getElementById('secret') as HTMLInputElement;
    // The generate action auto-reveals so the user can capture immediately.
    // test-review:accept tobe_literal — input type is part of the reveal contract
    expect(secret.type).toBe('text');

    // Click hide.
    await user.click(screen.getByRole('button', { name: /hide secret/i }));
    expect(secret.type).toBe('password');

    // Click reveal again.
    await user.click(screen.getByRole('button', { name: /reveal secret/i }));
    expect(secret.type).toBe('text');
  });

  it('shows the capture cue as soon as the secret field has a value', async () => {
    const user = userEvent.setup();
    render(<WebhookForm mode="create" />);

    // No cue yet.
    expect(screen.queryByText(/copy this secret now/i)).not.toBeInTheDocument();

    // Generate.
    await user.click(screen.getByTitle(/generate a random secret/i));

    await waitFor(() => {
      expect(screen.getByText(/copy this secret now/i)).toBeInTheDocument();
    });
  });

  it('copies the current secret to the clipboard and flashes a confirmation', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    render(<WebhookForm mode="create" />);
    await user.click(screen.getByTitle(/generate a random secret/i));

    const secret = (document.getElementById('secret') as HTMLInputElement).value;
    expect(secret.length).toBeGreaterThan(16);

    await user.click(screen.getByRole('button', { name: /copy secret to clipboard/i }));

    expect(writeText).toHaveBeenCalledWith(secret);
  });

  it('surfaces a clipboard error when navigator.clipboard rejects', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('insecure context')) },
      configurable: true,
    });

    render(<WebhookForm mode="create" />);
    await user.click(screen.getByTitle(/generate a random secret/i));
    await user.click(screen.getByRole('button', { name: /copy secret to clipboard/i }));

    await waitFor(() => {
      expect(screen.getByText(/could not copy to clipboard/i)).toBeInTheDocument();
    });
  });
});
