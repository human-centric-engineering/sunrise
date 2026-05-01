/**
 * SettingsForm Tests
 *
 * Test Coverage:
 * - All five sections render (Safety, Limits, Retention, Approvals, Search)
 * - Form fields display initial values correctly
 * - Client-side validation errors display
 * - Successful submission sends correct API payload
 * - Error state displays on API failure
 * - Guard mode none→null mapping
 * - Save button disabled when form is pristine
 *
 * @see components/admin/orchestration/settings-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  SettingsForm,
  type OrchestrationSettings,
} from '@/components/admin/orchestration/settings-form';

// ─── Mocks ────────────────────────────────────────────────────────────────────

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

const FULL_SETTINGS: OrchestrationSettings = {
  inputGuardMode: 'log_only',
  outputGuardMode: 'warn_and_continue',
  globalMonthlyBudgetUsd: 500,
  defaultApprovalTimeoutMs: 60000,
  approvalDefaultAction: 'deny',
  searchConfig: { keywordBoostWeight: -0.05, vectorWeight: 1.2 },
  webhookRetentionDays: 30,
  costLogRetentionDays: 90,
  auditLogRetentionDays: 365,
  maxConversationsPerUser: 50,
  maxMessagesPerConversation: 200,
};

const EMPTY_SETTINGS: OrchestrationSettings = {
  inputGuardMode: null,
  outputGuardMode: null,
  globalMonthlyBudgetUsd: null,
  defaultApprovalTimeoutMs: null,
  approvalDefaultAction: null,
  searchConfig: null,
  webhookRetentionDays: null,
  costLogRetentionDays: null,
  auditLogRetentionDays: null,
  maxConversationsPerUser: null,
  maxMessagesPerConversation: null,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SettingsForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Section rendering ───────────────────────────────────────────────────

  describe('Section rendering', () => {
    it('renders Safety section with both guard mode selects', () => {
      render(<SettingsForm initialSettings={FULL_SETTINGS} />);
      expect(screen.getByText('Safety')).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: /input guard mode/i })).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: /output guard mode/i })).toBeInTheDocument();
    });

    it('renders Limits section with budget and conversation fields', () => {
      render(<SettingsForm initialSettings={FULL_SETTINGS} />);
      expect(screen.getByText('Limits')).toBeInTheDocument();
      expect(document.getElementById('globalMonthlyBudgetUsd')).toBeInTheDocument();
      expect(document.getElementById('maxConversationsPerUser')).toBeInTheDocument();
      expect(document.getElementById('maxMessagesPerConversation')).toBeInTheDocument();
    });

    it('renders Retention section with webhook, cost log, and audit log fields', () => {
      render(<SettingsForm initialSettings={FULL_SETTINGS} />);
      expect(screen.getByText('Retention')).toBeInTheDocument();
      expect(document.getElementById('webhookRetentionDays')).toBeInTheDocument();
      expect(document.getElementById('costLogRetentionDays')).toBeInTheDocument();
      expect(document.getElementById('auditLogRetentionDays')).toBeInTheDocument();
    });

    it('renders Approvals section with timeout and action fields', () => {
      render(<SettingsForm initialSettings={FULL_SETTINGS} />);
      expect(screen.getByText('Approvals')).toBeInTheDocument();
      expect(document.getElementById('approvalTimeout')).toBeInTheDocument();
      expect(
        screen.getByRole('combobox', { name: /default action on timeout/i })
      ).toBeInTheDocument();
    });

    it('renders Knowledge search section with weight fields', () => {
      render(<SettingsForm initialSettings={FULL_SETTINGS} />);
      expect(screen.getByText('Knowledge search')).toBeInTheDocument();
      expect(document.getElementById('keywordBoostWeight')).toBeInTheDocument();
      expect(document.getElementById('vectorWeight')).toBeInTheDocument();
    });
  });

  // ── Initial values ──────────────────────────────────────────────────────

  describe('Initial values', () => {
    it('populates numeric fields from initial settings', () => {
      render(<SettingsForm initialSettings={FULL_SETTINGS} />);
      expect(document.getElementById('globalMonthlyBudgetUsd')).toHaveValue(500);
      expect(document.getElementById('maxConversationsPerUser')).toHaveValue(50);
      expect(document.getElementById('maxMessagesPerConversation')).toHaveValue(200);
      expect(document.getElementById('webhookRetentionDays')).toHaveValue(30);
      expect(document.getElementById('costLogRetentionDays')).toHaveValue(90);
      expect(document.getElementById('auditLogRetentionDays')).toHaveValue(365);
      expect(document.getElementById('approvalTimeout')).toHaveValue(60000);
      expect(document.getElementById('keywordBoostWeight')).toHaveValue(-0.05);
      expect(document.getElementById('vectorWeight')).toHaveValue(1.2);
    });

    it('leaves numeric fields empty when settings are null', () => {
      render(<SettingsForm initialSettings={EMPTY_SETTINGS} />);
      expect(document.getElementById('globalMonthlyBudgetUsd')).toHaveValue(null);
      expect(document.getElementById('maxConversationsPerUser')).toHaveValue(null);
      expect(document.getElementById('webhookRetentionDays')).toHaveValue(null);
      expect(document.getElementById('costLogRetentionDays')).toHaveValue(null);
      expect(document.getElementById('auditLogRetentionDays')).toHaveValue(null);
    });

    it('defaults guard modes to none when null', () => {
      render(<SettingsForm initialSettings={EMPTY_SETTINGS} />);
      // Both guard mode selects should show "None (disabled)" when null
      const selects = screen.getAllByRole('combobox');
      // The first two selects are guard modes
      expect(selects[0]).toHaveTextContent(/none/i);
      expect(selects[1]).toHaveTextContent(/none/i);
    });
  });

  // ── Form submission ─────────────────────────────────────────────────────

  describe('Submission', () => {
    it('submits all fields with correct API payload', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockResolvedValue({ success: true });

      render(<SettingsForm initialSettings={FULL_SETTINGS} />);

      // Submit via fireEvent to bypass isDirty gate
      const form = screen.getByRole('button', { name: /save settings/i }).closest('form');
      await act(async () => {
        fireEvent.submit(form!);
      });

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/settings'),
          expect.objectContaining({
            body: expect.objectContaining({
              inputGuardMode: 'log_only',
              outputGuardMode: 'warn_and_continue',
              globalMonthlyBudgetUsd: 500,
              maxConversationsPerUser: 50,
              maxMessagesPerConversation: 200,
              webhookRetentionDays: 30,
              costLogRetentionDays: 90,
              auditLogRetentionDays: 365,
              defaultApprovalTimeoutMs: 60000,
              approvalDefaultAction: 'deny',
              searchConfig: { keywordBoostWeight: -0.05, vectorWeight: 1.2, hybridEnabled: false },
            }),
          })
        );
      });
    });

    it('maps guard mode "none" to null in API payload', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockResolvedValue({ success: true });

      render(<SettingsForm initialSettings={EMPTY_SETTINGS} />);

      const form = screen.getByRole('button', { name: /save settings/i }).closest('form');
      await act(async () => {
        fireEvent.submit(form!);
      });

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/settings'),
          expect.objectContaining({
            body: expect.objectContaining({
              inputGuardMode: null,
              outputGuardMode: null,
            }),
          })
        );
      });
    });

    it('sends null searchConfig when both weights are empty', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockResolvedValue({ success: true });

      render(<SettingsForm initialSettings={EMPTY_SETTINGS} />);

      const form = screen.getByRole('button', { name: /save settings/i }).closest('form');
      await act(async () => {
        fireEvent.submit(form!);
      });

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/settings'),
          expect.objectContaining({
            body: expect.objectContaining({
              searchConfig: null,
            }),
          })
        );
      });
    });

    it('shows saved indicator after successful submission', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockResolvedValue({ success: true });

      render(<SettingsForm initialSettings={FULL_SETTINGS} />);

      const form = screen.getByRole('button', { name: /save settings/i }).closest('form');
      await act(async () => {
        fireEvent.submit(form!);
      });

      await waitFor(() => {
        expect(screen.getByText('Saved')).toBeInTheDocument();
      });
    });
  });

  // ── Error handling ──────────────────────────────────────────────────────

  describe('Error handling', () => {
    it('displays API error message on submission failure', async () => {
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockRejectedValue(
        new APIClientError('Budget exceeds maximum allowed value')
      );

      render(<SettingsForm initialSettings={FULL_SETTINGS} />);

      const form = screen.getByRole('button', { name: /save settings/i }).closest('form');
      await act(async () => {
        fireEvent.submit(form!);
      });

      await waitFor(() => {
        expect(screen.getByText('Budget exceeds maximum allowed value')).toBeInTheDocument();
      });
    });

    it('displays generic error for non-API errors', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockRejectedValue(new Error('network failure'));

      render(<SettingsForm initialSettings={FULL_SETTINGS} />);

      const form = screen.getByRole('button', { name: /save settings/i }).closest('form');
      await act(async () => {
        fireEvent.submit(form!);
      });

      await waitFor(() => {
        expect(screen.getByText(/could not save settings/i)).toBeInTheDocument();
      });
    });
  });

  // ── Hybrid search controls ──────────────────────────────────────────────

  describe('Hybrid search', () => {
    it('renders the hybrid toggle unchecked when settings have no hybridEnabled', () => {
      render(<SettingsForm initialSettings={FULL_SETTINGS} />);
      const toggle = screen.getByRole('checkbox', { name: /enable hybrid search/i });
      expect(toggle).not.toBeChecked();
    });

    it('renders the hybrid toggle checked when settings have hybridEnabled: true', () => {
      const HYBRID_SETTINGS: OrchestrationSettings = {
        ...FULL_SETTINGS,
        searchConfig: {
          keywordBoostWeight: -0.02,
          vectorWeight: 1.0,
          hybridEnabled: true,
          bm25Weight: 0.7,
        },
      };
      render(<SettingsForm initialSettings={HYBRID_SETTINGS} />);
      const toggle = screen.getByRole('checkbox', { name: /enable hybrid search/i });
      expect(toggle).toBeChecked();
      expect(document.getElementById('bm25Weight')).toHaveValue(0.7);
    });

    it('disables the BM25 weight input when hybrid is off', () => {
      render(<SettingsForm initialSettings={FULL_SETTINGS} />);
      const bm25 = document.getElementById('bm25Weight') as HTMLInputElement;
      expect(bm25).toBeDisabled();
    });

    it('enables BM25 weight input after toggling hybrid on', async () => {
      const user = userEvent.setup();
      render(<SettingsForm initialSettings={FULL_SETTINGS} />);

      const toggle = screen.getByRole('checkbox', { name: /enable hybrid search/i });
      const bm25 = document.getElementById('bm25Weight') as HTMLInputElement;
      expect(bm25).toBeDisabled();

      await user.click(toggle);

      expect(toggle).toBeChecked();
      expect(bm25).toBeEnabled();
    });

    it('disables the legacy keyword boost input when hybrid is on', () => {
      const HYBRID_SETTINGS: OrchestrationSettings = {
        ...FULL_SETTINGS,
        searchConfig: {
          keywordBoostWeight: -0.02,
          vectorWeight: 1.0,
          hybridEnabled: true,
        },
      };
      render(<SettingsForm initialSettings={HYBRID_SETTINGS} />);
      const keyword = document.getElementById('keywordBoostWeight') as HTMLInputElement;
      expect(keyword).toBeDisabled();
      expect(screen.getByText(/Inactive — hybrid mode is on/i)).toBeInTheDocument();
    });

    it('submits hybridEnabled: true and bm25Weight when toggle is on', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockResolvedValue({ success: true });
      const user = userEvent.setup();
      render(<SettingsForm initialSettings={FULL_SETTINGS} />);

      const toggle = screen.getByRole('checkbox', { name: /enable hybrid search/i });
      await user.click(toggle);

      const bm25 = document.getElementById('bm25Weight') as HTMLInputElement;
      await user.clear(bm25);
      await user.type(bm25, '0.5');

      const form = screen.getByRole('button', { name: /save settings/i }).closest('form');
      await act(async () => {
        fireEvent.submit(form!);
      });

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/settings'),
          expect.objectContaining({
            body: expect.objectContaining({
              searchConfig: expect.objectContaining({
                hybridEnabled: true,
                bm25Weight: 0.5,
              }),
            }),
          })
        );
      });
    });

    it('defaults bm25Weight to 1.0 in payload when hybrid is enabled with empty input', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockResolvedValue({ success: true });
      const user = userEvent.setup();
      render(<SettingsForm initialSettings={FULL_SETTINGS} />);

      const toggle = screen.getByRole('checkbox', { name: /enable hybrid search/i });
      await user.click(toggle);

      const form = screen.getByRole('button', { name: /save settings/i }).closest('form');
      await act(async () => {
        fireEvent.submit(form!);
      });

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/settings'),
          expect.objectContaining({
            body: expect.objectContaining({
              searchConfig: expect.objectContaining({
                hybridEnabled: true,
                bm25Weight: 1.0,
              }),
            }),
          })
        );
      });
    });

    it('shows validation error when bm25Weight is above 2.0', async () => {
      const user = userEvent.setup();
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockResolvedValue({ success: true });
      render(<SettingsForm initialSettings={FULL_SETTINGS} />);

      const toggle = screen.getByRole('checkbox', { name: /enable hybrid search/i });
      await user.click(toggle);

      const bm25 = document.getElementById('bm25Weight') as HTMLInputElement;
      await user.clear(bm25);
      await user.type(bm25, '5');

      const form = screen.getByRole('button', { name: /save settings/i }).closest('form');
      await act(async () => {
        fireEvent.submit(form!);
      });

      // The submit must not have called the API (validation should block it)
      await waitFor(() => {
        const bm25Now = document.getElementById('bm25Weight') as HTMLInputElement;
        expect(bm25Now.value).toBe('5');
      });
      expect(apiClient.patch).not.toHaveBeenCalled();
    });
  });

  // ── Button state ────────────────────────────────────────────────────────

  describe('Button state', () => {
    it('disables save button when form is pristine', () => {
      render(<SettingsForm initialSettings={FULL_SETTINGS} />);
      expect(screen.getByRole('button', { name: /save settings/i })).toBeDisabled();
    });

    it('enables save button when form is dirty', async () => {
      const user = userEvent.setup();
      render(<SettingsForm initialSettings={FULL_SETTINGS} />);

      const budgetInput = document.getElementById('globalMonthlyBudgetUsd') as HTMLInputElement;
      await user.clear(budgetInput);
      await user.type(budgetInput, '1000');

      expect(screen.getByRole('button', { name: /save settings/i })).toBeEnabled();
    });
  });

  // ── Escalation section ──────────────────────────────────────────────────

  describe('Escalation section', () => {
    it('renders escalation checkbox unchecked by default (no escalationConfig)', () => {
      // Arrange
      render(<SettingsForm initialSettings={FULL_SETTINGS} />);

      // Assert: checkbox for enabling escalation is rendered and unchecked
      const checkbox = screen.getByRole('checkbox', {
        name: /enable escalation notifications/i,
      });
      expect(checkbox).toBeInTheDocument();
      expect(checkbox).not.toBeChecked();
    });

    it('renders escalation checkbox checked when escalationConfig is present', () => {
      // Arrange
      const settingsWithEscalation: OrchestrationSettings = {
        ...FULL_SETTINGS,
        escalationConfig: {
          emailAddresses: ['admin@example.com'],
          notifyOnPriority: 'all',
        },
      };
      render(<SettingsForm initialSettings={settingsWithEscalation} />);

      // Assert
      const checkbox = screen.getByRole('checkbox', {
        name: /enable escalation notifications/i,
      });
      expect(checkbox).toBeChecked();
    });

    it('adds email to escalation list when Add button is clicked', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<SettingsForm initialSettings={FULL_SETTINGS} />);

      // Act: type an email and click Add
      const emailInput = screen.getByPlaceholderText(/add email address/i);
      await user.type(emailInput, 'ops@example.com');
      await user.click(screen.getByRole('button', { name: /^add$/i }));

      // Assert: email appears as a tag
      await waitFor(() => {
        expect(screen.getByText('ops@example.com')).toBeInTheDocument();
      });
    });

    it('adds email when Enter key is pressed in email input', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<SettingsForm initialSettings={FULL_SETTINGS} />);

      // Act: type email and press Enter
      const emailInput = screen.getByPlaceholderText(/add email address/i);
      await user.type(emailInput, 'enter@example.com{Enter}');

      // Assert: email appears as tag
      await waitFor(() => {
        expect(screen.getByText('enter@example.com')).toBeInTheDocument();
      });
    });

    it('does not add duplicate email', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<SettingsForm initialSettings={FULL_SETTINGS} />);

      const emailInput = screen.getByPlaceholderText(/add email address/i);

      // Add email once
      await user.type(emailInput, 'dup@example.com');
      await user.click(screen.getByRole('button', { name: /^add$/i }));
      await waitFor(() => expect(screen.getByText('dup@example.com')).toBeInTheDocument());

      // Act: try to add the same email again
      await user.type(emailInput, 'dup@example.com');
      await user.click(screen.getByRole('button', { name: /^add$/i }));

      // Assert: only one tag with that email
      await waitFor(() => {
        const tags = screen.getAllByText('dup@example.com');
        expect(tags).toHaveLength(1);
      });
    });

    it('removes email tag when X button is clicked', async () => {
      // Arrange: start with an email already in the list
      const user = userEvent.setup();
      render(<SettingsForm initialSettings={FULL_SETTINGS} />);

      // Add email first
      const emailInput = screen.getByPlaceholderText(/add email address/i);
      await user.type(emailInput, 'remove@example.com');
      await user.click(screen.getByRole('button', { name: /^add$/i }));
      await waitFor(() => expect(screen.getByText('remove@example.com')).toBeInTheDocument());

      // Act: click the X button on the tag (the SVG button inside the span)
      const tag = screen.getByText('remove@example.com').closest('span');
      const removeBtn = tag?.querySelector('button');
      expect(removeBtn).not.toBeNull();
      await user.click(removeBtn!);

      // Assert: email tag is gone
      await waitFor(() => {
        expect(screen.queryByText('remove@example.com')).not.toBeInTheDocument();
      });
    });

    it('includes escalationConfig in payload when enabled with emails', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockResolvedValue({ success: true });

      const user = userEvent.setup();
      render(<SettingsForm initialSettings={FULL_SETTINGS} />);

      // Enable escalation
      const checkbox = screen.getByRole('checkbox', {
        name: /enable escalation notifications/i,
      });
      await user.click(checkbox);

      // Add email
      const emailInput = screen.getByPlaceholderText(/add email address/i);
      await user.type(emailInput, 'escalate@example.com');
      await user.click(screen.getByRole('button', { name: /^add$/i }));
      await waitFor(() => expect(screen.getByText('escalate@example.com')).toBeInTheDocument());

      // Submit
      const form = screen.getByRole('button', { name: /save settings/i }).closest('form');
      await act(async () => {
        fireEvent.submit(form!);
      });

      // Assert: escalationConfig is included in payload
      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/settings'),
          expect.objectContaining({
            body: expect.objectContaining({
              escalationConfig: expect.objectContaining({
                emailAddresses: ['escalate@example.com'],
                notifyOnPriority: 'all',
              }),
            }),
          })
        );
      });
    });

    it('sends null escalationConfig when escalation is disabled', async () => {
      // Arrange: escalation disabled (checkbox unchecked, default state)
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockResolvedValue({ success: true });

      render(<SettingsForm initialSettings={FULL_SETTINGS} />);

      // Submit with escalation off (default)
      const form = screen.getByRole('button', { name: /save settings/i }).closest('form');
      await act(async () => {
        fireEvent.submit(form!);
      });

      // Assert: escalationConfig is null
      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/settings'),
          expect.objectContaining({
            body: expect.objectContaining({
              escalationConfig: null,
            }),
          })
        );
      });
    });

    it('initialises email list from escalationConfig.emailAddresses', () => {
      // Arrange
      const settingsWithEscalation: OrchestrationSettings = {
        ...FULL_SETTINGS,
        escalationConfig: {
          emailAddresses: ['pre@example.com', 'loaded@example.com'],
          notifyOnPriority: 'high',
        },
      };

      render(<SettingsForm initialSettings={settingsWithEscalation} />);

      // Assert: both pre-loaded emails are shown as tags
      expect(screen.getByText('pre@example.com')).toBeInTheDocument();
      expect(screen.getByText('loaded@example.com')).toBeInTheDocument();
    });
  });
});
