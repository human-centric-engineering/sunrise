/**
 * AuditModelsDialog Component Tests
 *
 * Test Coverage:
 * - Renders all models as checkboxes (all selected by default)
 * - Provider filter dropdown filters the visible model list
 * - "Select all" / "Deselect all" toggle for the current filtered view
 * - Individual model checkbox toggles selection
 * - Submit button label shows count; button is disabled when 0 models are selected
 * - Submit flow: GET workflow by slug → POST execute → router.push to execution page
 * - Error state: workflow not found shows specific message
 * - Error state: API failure (thrown Error) surfaces error text
 * - Submitting state disables Cancel and Submit buttons
 *
 * @see components/admin/orchestration/audit-models-dialog.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AuditModelsDialog } from '@/components/admin/orchestration/audit-models-dialog';
import type { ModelRow } from '@/components/admin/orchestration/provider-models-matrix';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
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
      public statusCode = 500,
      public code = 'INTERNAL_ERROR'
    ) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

vi.mock('@/types/orchestration', () => ({
  TIER_ROLE_META: {
    thinking: { label: 'Thinking', description: 'High-reasoning' },
    worker: { label: 'Worker', description: 'General tasks' },
    embedding: { label: 'Embedding', description: 'Vector embeddings' },
  },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeModel(overrides: Partial<ModelRow> = {}): ModelRow {
  return {
    id: 'model-1',
    name: 'GPT-5',
    slug: 'openai-gpt-5',
    modelId: 'gpt-5',
    providerSlug: 'openai',
    description: 'Flagship model',
    capabilities: ['chat'],
    tierRole: 'thinking',
    reasoningDepth: 'very_high',
    latency: 'medium',
    costEfficiency: 'none',
    contextLength: 'very_high',
    toolUse: 'strong',
    bestRole: 'Planner',
    isDefault: true,
    isActive: true,
    configured: true,
    configuredActive: true,
    dimensions: null,
    schemaCompatible: null,
    metadata: null,
    ...overrides,
  };
}

const MODEL_OPENAI = makeModel({ id: 'model-openai', name: 'GPT-5', providerSlug: 'openai' });
const MODEL_ANTHROPIC = makeModel({
  id: 'model-anthropic',
  name: 'Claude-4',
  providerSlug: 'anthropic',
  tierRole: 'worker',
});

const DEFAULT_PROPS = {
  open: true,
  onOpenChange: vi.fn(),
  models: [MODEL_OPENAI, MODEL_ANTHROPIC],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AuditModelsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Rendering ──────────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders all models as checkboxes', () => {
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      expect(screen.getByRole('checkbox', { name: /select gpt-5 for audit/i })).toBeInTheDocument();
      expect(
        screen.getByRole('checkbox', { name: /select claude-4 for audit/i })
      ).toBeInTheDocument();
    });

    it('all model checkboxes are checked by default', () => {
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      const checkboxes = screen.getAllByRole('checkbox');
      for (const checkbox of checkboxes) {
        expect(checkbox).toBeChecked();
      }
    });

    it('shows correct "N of M selected" count on initial render', () => {
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      expect(screen.getByText(/2 of 2 selected/)).toBeInTheDocument();
    });

    it('shows the model name and provider/modelId in each row', () => {
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      expect(screen.getByText('GPT-5')).toBeInTheDocument();
      expect(screen.getByText(/openai \/ gpt-5/)).toBeInTheDocument();
      expect(screen.getByText('Claude-4')).toBeInTheDocument();
      expect(screen.getByText(/anthropic \/ gpt-5/)).toBeInTheDocument();
    });

    it('shows the "Embedding" badge for embedding-capable models', () => {
      const embeddingModel = makeModel({
        id: 'embed-1',
        name: 'Text Embedder',
        capabilities: ['embedding'],
      });
      render(<AuditModelsDialog {...DEFAULT_PROPS} models={[embeddingModel]} />);

      expect(screen.getByText('Embedding')).toBeInTheDocument();
    });

    it('does not show the "Embedding" badge for chat-only models', () => {
      render(<AuditModelsDialog {...DEFAULT_PROPS} models={[MODEL_OPENAI]} />);

      expect(screen.queryByText('Embedding')).not.toBeInTheDocument();
    });
  });

  // ── Audit age formatting ───────────────────────────────────────────────────

  describe('audit age formatting', () => {
    it('shows "Never audited" when metadata.lastAudit is null', () => {
      render(<AuditModelsDialog {...DEFAULT_PROPS} models={[makeModel({ metadata: null })]} />);
      expect(screen.getByText('Never audited')).toBeInTheDocument();
    });

    it('shows "Audited today" for a timestamp from today', () => {
      const now = new Date().toISOString();
      render(
        <AuditModelsDialog
          {...DEFAULT_PROPS}
          models={[makeModel({ metadata: { lastAudit: { timestamp: now } } })]}
        />
      );
      expect(screen.getByText('Audited today')).toBeInTheDocument();
    });

    it('shows "Audited yesterday" for a timestamp from 1 day ago', () => {
      const yesterday = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString();
      render(
        <AuditModelsDialog
          {...DEFAULT_PROPS}
          models={[makeModel({ metadata: { lastAudit: { timestamp: yesterday } } })]}
        />
      );
      expect(screen.getByText('Audited yesterday')).toBeInTheDocument();
    });

    it('shows "Audited Xd ago" for timestamps within the last month', () => {
      const fiveDaysAgo = new Date(Date.now() - 1000 * 60 * 60 * 24 * 5).toISOString();
      render(
        <AuditModelsDialog
          {...DEFAULT_PROPS}
          models={[makeModel({ metadata: { lastAudit: { timestamp: fiveDaysAgo } } })]}
        />
      );
      expect(screen.getByText('Audited 5d ago')).toBeInTheDocument();
    });

    it('shows "Audited Xmo ago" for timestamps older than 30 days', () => {
      const sixtyDaysAgo = new Date(Date.now() - 1000 * 60 * 60 * 24 * 60).toISOString();
      render(
        <AuditModelsDialog
          {...DEFAULT_PROPS}
          models={[makeModel({ metadata: { lastAudit: { timestamp: sixtyDaysAgo } } })]}
        />
      );
      expect(screen.getByText('Audited 2mo ago')).toBeInTheDocument();
    });
  });

  // ── Keyboard interaction ──────────────────────────────────────────────────

  describe('keyboard interaction', () => {
    it('toggles model selection when Enter is pressed on a row', async () => {
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} models={[MODEL_OPENAI]} />);

      const checkbox = screen.getByRole('checkbox', { name: /select gpt-5 for audit/i });
      const row = checkbox.closest('[role="button"]') as HTMLElement;
      expect(checkbox).toBeChecked();

      row.focus();
      await user.keyboard('{Enter}');

      expect(checkbox).not.toBeChecked();
    });

    it('toggles model selection when Space is pressed on a row', async () => {
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} models={[MODEL_OPENAI]} />);

      const checkbox = screen.getByRole('checkbox', { name: /select gpt-5 for audit/i });
      const row = checkbox.closest('[role="button"]') as HTMLElement;
      expect(checkbox).toBeChecked();

      row.focus();
      await user.keyboard(' ');

      expect(checkbox).not.toBeChecked();
    });
  });

  // ── Provider filter ────────────────────────────────────────────────────────

  describe('provider filter', () => {
    it('filters visible models when a provider is selected', async () => {
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      // Open the provider Select trigger (first combobox)
      const trigger = screen.getByRole('combobox');
      await user.click(trigger);

      const option = await screen.findByRole('option', { name: /anthropic/i });
      await user.click(option);

      // Only the Anthropic model row should be visible
      expect(screen.getByText('Claude-4')).toBeInTheDocument();
      expect(screen.queryByText('GPT-5')).not.toBeInTheDocument();
    });

    it('restores all models when "All providers" is selected again', async () => {
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      // Filter to anthropic first
      const trigger = screen.getByRole('combobox');
      await user.click(trigger);
      await user.click(await screen.findByRole('option', { name: /anthropic/i }));

      // Then go back to "all"
      await user.click(trigger);
      await user.click(await screen.findByRole('option', { name: /all providers/i }));

      expect(screen.getByText('GPT-5')).toBeInTheDocument();
      expect(screen.getByText('Claude-4')).toBeInTheDocument();
    });
  });

  // ── Select all / Deselect all ──────────────────────────────────────────────

  describe('select all / deselect all toggle', () => {
    it('shows "Deselect all" when all filtered models are selected', () => {
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      // All models are selected by default → button should say "Deselect all"
      expect(screen.getByRole('button', { name: /deselect all/i })).toBeInTheDocument();
    });

    it('clicking "Deselect all" unchecks all visible checkboxes', async () => {
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      await user.click(screen.getByRole('button', { name: /deselect all/i }));

      const checkboxes = screen.getAllByRole('checkbox');
      for (const checkbox of checkboxes) {
        expect(checkbox).not.toBeChecked();
      }
    });

    it('shows "Select all" after deselecting all models', async () => {
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      await user.click(screen.getByRole('button', { name: /deselect all/i }));

      expect(screen.getByRole('button', { name: /^select all$/i })).toBeInTheDocument();
    });

    it('clicking "Select all" re-checks all visible checkboxes', async () => {
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      // First deselect, then re-select
      await user.click(screen.getByRole('button', { name: /deselect all/i }));
      await user.click(screen.getByRole('button', { name: /^select all$/i }));

      const checkboxes = screen.getAllByRole('checkbox');
      for (const checkbox of checkboxes) {
        expect(checkbox).toBeChecked();
      }
    });

    it('"Select all" only affects the currently filtered models', async () => {
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      // Deselect everything first
      await user.click(screen.getByRole('button', { name: /deselect all/i }));

      // Filter to openai only
      const trigger = screen.getByRole('combobox');
      await user.click(trigger);
      await user.click(await screen.findByRole('option', { name: /openai/i }));

      // Select all within the filtered view
      await user.click(screen.getByRole('button', { name: /^select all$/i }));

      // GPT-5 (openai) should now be checked
      expect(screen.getByRole('checkbox', { name: /select gpt-5 for audit/i })).toBeChecked();

      // Claude-4 is not shown (filtered out) — its selection state should remain unset.
      // Switching back to "all providers" verifies
      await user.click(trigger);
      await user.click(await screen.findByRole('option', { name: /all providers/i }));

      // GPT-5 checked, Claude-4 not checked
      expect(screen.getByRole('checkbox', { name: /select gpt-5 for audit/i })).toBeChecked();
      expect(
        screen.getByRole('checkbox', { name: /select claude-4 for audit/i })
      ).not.toBeChecked();
    });
  });

  // ── Individual model toggle ────────────────────────────────────────────────

  describe('individual model toggle', () => {
    it('clicking the row div unchecks a checked model', async () => {
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      // Click the row div (role="button") — this fires toggleModel exactly once.
      // Clicking the <input> checkbox directly would also bubble up to the row onClick,
      // causing a double-toggle that leaves selection unchanged.
      const checkbox = screen.getByRole('checkbox', { name: /select gpt-5 for audit/i });
      const row = checkbox.closest('[role="button"]') as HTMLElement;
      expect(checkbox).toBeChecked();

      await user.click(row);

      expect(checkbox).not.toBeChecked();
    });

    it('clicking the row div re-checks an unchecked model', async () => {
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      const checkbox = screen.getByRole('checkbox', { name: /select gpt-5 for audit/i });
      const row = checkbox.closest('[role="button"]') as HTMLElement;

      // Click twice: uncheck then re-check
      await user.click(row);
      await user.click(row);

      expect(checkbox).toBeChecked();
    });

    it('updates the selection count when a model row is clicked', async () => {
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      // Initial state: 2 of 2 selected
      expect(
        screen.getByText((_, el) => el?.textContent === '2 of 2 selected')
      ).toBeInTheDocument();

      // Click the row div to deselect GPT-5
      const checkbox = screen.getByRole('checkbox', { name: /select gpt-5 for audit/i });
      const row = checkbox.closest('[role="button"]') as HTMLElement;
      await user.click(row);

      expect(
        screen.getByText((_, el) => el?.textContent === '1 of 2 selected')
      ).toBeInTheDocument();
    });
  });

  // ── Submit button state ────────────────────────────────────────────────────

  describe('submit button state', () => {
    it('submit button shows count of selected models', () => {
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      expect(screen.getByRole('button', { name: /audit 2 models/i })).toBeInTheDocument();
    });

    it('submit button uses singular "model" when 1 model is selected', async () => {
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      // Deselect Claude-4 via row click (row div fires toggleModel exactly once)
      const claudeCheckbox = screen.getByRole('checkbox', { name: /select claude-4 for audit/i });
      const claudeRow = claudeCheckbox.closest('[role="button"]') as HTMLElement;
      await user.click(claudeRow);

      expect(screen.getByRole('button', { name: /audit 1 model$/i })).toBeInTheDocument();
    });

    it('submit button is disabled when 0 models are selected', async () => {
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      await user.click(screen.getByRole('button', { name: /deselect all/i }));

      const auditBtn = screen.getByRole('button', { name: /audit 0 models/i });
      expect(auditBtn).toBeDisabled();
    });

    it('submit button is enabled when at least one model is selected', () => {
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      const auditBtn = screen.getByRole('button', { name: /audit 2 models/i });
      expect(auditBtn).not.toBeDisabled();
    });
  });

  // ── Submit flow ────────────────────────────────────────────────────────────

  describe('submit flow', () => {
    it('calls apiClient.get with WORKFLOWS endpoint and audit slug param', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue([
        { id: 'wf-123', slug: 'tpl-provider-model-audit' },
      ]);
      vi.mocked(apiClient.post).mockResolvedValue({ id: 'exec-456' });

      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      await user.click(screen.getByRole('button', { name: /audit 2 models/i }));

      await waitFor(() => {
        expect(apiClient.get).toHaveBeenCalledWith(
          '/api/v1/admin/orchestration/workflows',
          expect.objectContaining({
            params: expect.objectContaining({ slug: 'tpl-provider-model-audit' }),
          })
        );
      });
    });

    it('calls apiClient.post with the workflow execute endpoint after finding workflow', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue([
        { id: 'wf-123', slug: 'tpl-provider-model-audit' },
      ]);
      vi.mocked(apiClient.post).mockResolvedValue({ id: 'exec-456' });

      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      await user.click(screen.getByRole('button', { name: /audit 2 models/i }));

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          '/api/v1/admin/orchestration/workflows/wf-123/execute',
          expect.objectContaining({
            body: expect.objectContaining({
              inputData: expect.objectContaining({
                modelIds: expect.arrayContaining([MODEL_OPENAI.id, MODEL_ANTHROPIC.id]),
              }),
            }),
          })
        );
      });
    });

    it('swaps the dialog body to live progress and does NOT auto-navigate after submit', async () => {
      // New behaviour: after a successful audit start, the dialog stays
      // open and the form is replaced by ExecutionProgressInline. The
      // operator decides whether to background the run or open the
      // detail page — neither happens automatically.
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue([
        { id: 'wf-123', slug: 'tpl-provider-model-audit', name: 'Provider Model Audit' },
      ]);
      vi.mocked(apiClient.post).mockResolvedValue({ id: 'exec-456' });

      const onOpenChange = vi.fn();
      const user = userEvent.setup();
      render(
        <AuditModelsDialog
          open={true}
          onOpenChange={onOpenChange}
          models={[MODEL_OPENAI, MODEL_ANTHROPIC]}
        />
      );

      await user.click(screen.getByRole('button', { name: /audit 2 models/i }));

      await waitFor(() => {
        // Live-progress panel mounted (its test-id is the load-bearing handle).
        expect(screen.getByTestId('execution-progress-inline')).toBeInTheDocument();
      });
      // Dialog NOT closed.
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
      // No auto-navigation.
      expect(mockPush).not.toHaveBeenCalled();
      // Footer has the new running-state buttons.
      expect(screen.getByTestId('audit-run-in-background')).toBeInTheDocument();
      expect(screen.getByTestId('audit-view-full-details')).toBeInTheDocument();
    });

    it('"Run in background" closes the dialog and writes the execution to localStorage', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue([
        { id: 'wf-123', slug: 'tpl-provider-model-audit', name: 'Provider Model Audit' },
      ]);
      vi.mocked(apiClient.post).mockResolvedValue({ id: 'exec-bg' });

      const onOpenChange = vi.fn();
      const user = userEvent.setup();
      render(
        <AuditModelsDialog
          open={true}
          onOpenChange={onOpenChange}
          models={[MODEL_OPENAI, MODEL_ANTHROPIC]}
        />
      );

      await user.click(screen.getByRole('button', { name: /audit 2 models/i }));
      await waitFor(() => screen.getByTestId('audit-run-in-background'));
      await user.click(screen.getByTestId('audit-run-in-background'));

      // Dialog closed; navigation skipped; localStorage holds the handoff
      // so the peek banner can pick it up.
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(mockPush).not.toHaveBeenCalled();
      const stored = window.localStorage.getItem('sunrise.orchestration.in-flight-execution.v1');
      expect(stored).not.toBeNull();
      const parsed = JSON.parse(stored as string) as {
        executionId: string;
        label: string;
      };
      expect(parsed.executionId).toBe('exec-bg');
      expect(parsed.label).toBe('Provider Model Audit');
    });

    it('"View full details" navigates AND preserves the in-flight localStorage entry', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue([
        { id: 'wf-123', slug: 'tpl-provider-model-audit', name: 'Provider Model Audit' },
      ]);
      vi.mocked(apiClient.post).mockResolvedValue({ id: 'exec-vfd' });

      const onOpenChange = vi.fn();
      const user = userEvent.setup();
      render(
        <AuditModelsDialog
          open={true}
          onOpenChange={onOpenChange}
          models={[MODEL_OPENAI, MODEL_ANTHROPIC]}
        />
      );

      await user.click(screen.getByRole('button', { name: /audit 2 models/i }));
      await waitFor(() => screen.getByTestId('audit-view-full-details'));
      await user.click(screen.getByTestId('audit-view-full-details'));

      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(mockPush).toHaveBeenCalledWith('/admin/orchestration/executions/exec-vfd');
      // Banner should still pick the run up after the navigation.
      const stored = window.localStorage.getItem('sunrise.orchestration.in-flight-execution.v1');
      expect(stored).not.toBeNull();
    });

    it('POST body includes full model detail objects for selected models', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue([
        { id: 'wf-xyz', slug: 'tpl-provider-model-audit' },
      ]);
      vi.mocked(apiClient.post).mockResolvedValue({ id: 'exec-789' });

      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      await user.click(screen.getByRole('button', { name: /audit 2 models/i }));

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            body: expect.objectContaining({
              inputData: expect.objectContaining({
                models: expect.arrayContaining([
                  expect.objectContaining({
                    id: MODEL_OPENAI.id,
                    name: MODEL_OPENAI.name,
                    modelId: MODEL_OPENAI.modelId,
                    providerSlug: MODEL_OPENAI.providerSlug,
                  }),
                ]),
              }),
            }),
          })
        );
      });
    });

    it('only submits the selected models (not all models)', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue([
        { id: 'wf-123', slug: 'tpl-provider-model-audit' },
      ]);
      vi.mocked(apiClient.post).mockResolvedValue({ id: 'exec-456' });

      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      // Deselect the Anthropic model via row click (avoids double-toggle from checkbox input bubble)
      const claudeCheckbox = screen.getByRole('checkbox', { name: /select claude-4 for audit/i });
      const claudeRow = claudeCheckbox.closest('[role="button"]') as HTMLElement;
      await user.click(claudeRow);
      await user.click(screen.getByRole('button', { name: /audit 1 model$/i }));

      await waitFor(() => {
        const postCall = vi.mocked(apiClient.post).mock.calls[0];
        const body = (postCall[1] as { body: { inputData: { modelIds: string[] } } }).body;
        expect(body.inputData.modelIds).toEqual([MODEL_OPENAI.id]);
        expect(body.inputData.modelIds).not.toContain(MODEL_ANTHROPIC.id);
      });
    });
  });

  // ── Error states ───────────────────────────────────────────────────────────

  describe('error states', () => {
    it('shows specific "workflow not found" message when GET returns empty array', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue([]); // no workflows found

      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      await user.click(screen.getByRole('button', { name: /audit 2 models/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(screen.getByText(/audit workflow template not found/i)).toBeInTheDocument();
        expect(screen.getByText(/run db:seed/i)).toBeInTheDocument();
      });
    });

    it('shows specific error message when GET returns non-array', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(null); // non-array falsy response

      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      await user.click(screen.getByRole('button', { name: /audit 2 models/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(screen.getByText(/audit workflow template not found/i)).toBeInTheDocument();
      });
    });

    it('shows generic error message on API failure (thrown Error)', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockRejectedValue(new Error('Network failure'));

      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      await user.click(screen.getByRole('button', { name: /audit 2 models/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(screen.getByText(/network failure/i)).toBeInTheDocument();
      });
    });

    it('shows fallback error message when non-Error is thrown', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockRejectedValue('unexpected failure');

      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      await user.click(screen.getByRole('button', { name: /audit 2 models/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(screen.getByText(/failed to start audit/i)).toBeInTheDocument();
      });
    });

    it('does not redirect when workflow is not found', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue([]);

      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      await user.click(screen.getByRole('button', { name: /audit 2 models/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });

      expect(mockPush).not.toHaveBeenCalled(); // test-review:accept no_arg_called — guard: redirect must not fire on missing workflow
    });

    it('does not redirect when API POST throws', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue([
        { id: 'wf-123', slug: 'tpl-provider-model-audit' },
      ]);
      vi.mocked(apiClient.post).mockRejectedValue(new Error('Execute failed'));

      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      await user.click(screen.getByRole('button', { name: /audit 2 models/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });

      expect(mockPush).not.toHaveBeenCalled(); // test-review:accept no_arg_called — guard: redirect must not fire on POST failure
    });
  });

  // ── Submitting state ───────────────────────────────────────────────────────

  describe('submitting state', () => {
    it('submit button shows "Starting audit..." while submitting', async () => {
      const { apiClient } = await import('@/lib/api/client');
      // Never resolve so we remain in the submitting state
      vi.mocked(apiClient.get).mockImplementation(() => new Promise(() => undefined));

      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      await user.click(screen.getByRole('button', { name: /audit 2 models/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /starting audit/i })).toBeInTheDocument();
      });
    });

    it('Cancel button is disabled while submitting', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockImplementation(() => new Promise(() => undefined));

      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      await user.click(screen.getByRole('button', { name: /audit 2 models/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
      });
    });

    it('submit button is disabled while submitting', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockImplementation(() => new Promise(() => undefined));

      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      await user.click(screen.getByRole('button', { name: /audit 2 models/i }));

      await waitFor(() => {
        const btn = screen.getByRole('button', { name: /starting audit/i });
        expect(btn).toBeDisabled();
      });
    });
  });

  // ── Cancel button ──────────────────────────────────────────────────────────

  describe('cancel button', () => {
    it('calls onOpenChange(false) when Cancel is clicked', async () => {
      const onOpenChange = vi.fn();
      const user = userEvent.setup();
      render(<AuditModelsDialog open={true} onOpenChange={onOpenChange} models={[MODEL_OPENAI]} />);

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
