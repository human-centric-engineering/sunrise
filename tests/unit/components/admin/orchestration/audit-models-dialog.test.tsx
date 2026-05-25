/**
 * AuditModelsDialog Component Tests
 *
 * Test Coverage:
 * - Renders all models as checkboxes (NONE selected by default — opt-in via row click or "Select all")
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
import { queryByTestId, render, screen, waitFor } from '@testing-library/react';
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
  useSearchParams: () => ({ get: () => null }),
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

/**
 * Build a Response whose body is a one-frame SSE stream carrying a
 * single `workflow_started` event. The dialog reads frames until it
 * sees this one, captures the executionId, and aborts.
 */
function sseExecuteResponse(executionId: string): Response {
  const frame =
    `event: workflow_started\n` +
    `data: ${JSON.stringify({ type: 'workflow_started', executionId, workflowId: 'wf-fixture' })}\n\n`;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frame));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AuditModelsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The dialog uses raw `fetch` for the workflow execute call (the
    // endpoint is SSE, not JSON, so `apiClient.post` can't parse it).
    // Default stub returns a one-frame SSE response with a fixed id;
    // individual tests override with `fetchMock.mockResolvedValueOnce`
    // when they need a different id or an error.
    fetchMock = vi.fn().mockResolvedValue(sseExecuteResponse('exec-456'));
    vi.stubGlobal('fetch', fetchMock);
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

    it('all model checkboxes are UNchecked by default (opt-in)', () => {
      // Initial state: nothing selected. Operators tick individual rows or
      // click "Select all" to opt in. Auditing every model by default is
      // expensive (one LLM call per model) and rarely what the operator
      // intends — the cost surface stays predictable.
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      const modelCheckboxes = screen.getAllByRole('checkbox', { name: /select .* for audit/i });
      for (const checkbox of modelCheckboxes) {
        expect(checkbox).not.toBeChecked();
      }
    });

    it('shows correct "0 of M selected" count on initial render', () => {
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      expect(screen.getByText(/0 of 2 selected/)).toBeInTheDocument();
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
      // Initial state: unchecked (opt-in).
      expect(checkbox).not.toBeChecked();

      row.focus();
      await user.keyboard('{Enter}');

      expect(checkbox).toBeChecked();
    });

    it('toggles model selection when Space is pressed on a row', async () => {
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} models={[MODEL_OPENAI]} />);

      const checkbox = screen.getByRole('checkbox', { name: /select gpt-5 for audit/i });
      const row = checkbox.closest('[role="button"]') as HTMLElement;
      expect(checkbox).not.toBeChecked();

      row.focus();
      await user.keyboard(' ');

      expect(checkbox).toBeChecked();
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
    it('shows "Select all" on initial render (nothing selected by default)', () => {
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      // Initial state: empty selection → button reads "Select all"
      expect(screen.getByRole('button', { name: /^select all$/i })).toBeInTheDocument();
    });

    it('clicking "Select all" checks every visible model checkbox', async () => {
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      await user.click(screen.getByRole('button', { name: /^select all$/i }));

      const modelCheckboxes = screen.getAllByRole('checkbox', { name: /select .* for audit/i });
      for (const checkbox of modelCheckboxes) {
        expect(checkbox).toBeChecked();
      }
    });

    it('button flips to "Deselect all" once all filtered models are selected', async () => {
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      await user.click(screen.getByRole('button', { name: /^select all$/i }));

      expect(screen.getByRole('button', { name: /deselect all/i })).toBeInTheDocument();
    });

    it('clicking "Deselect all" unchecks every visible model checkbox', async () => {
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      // Select first, then deselect — exercises the round-trip.
      await user.click(screen.getByRole('button', { name: /^select all$/i }));
      await user.click(screen.getByRole('button', { name: /deselect all/i }));

      const modelCheckboxes = screen.getAllByRole('checkbox', { name: /select .* for audit/i });
      for (const checkbox of modelCheckboxes) {
        expect(checkbox).not.toBeChecked();
      }
    });

    it('"Select all" only affects the currently filtered models', async () => {
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

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
    it('clicking the row div checks an unchecked model', async () => {
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      // Click the row div (role="button") — this fires toggleModel exactly once.
      // Clicking the <input> checkbox directly would also bubble up to the row onClick,
      // causing a double-toggle that leaves selection unchanged.
      const checkbox = screen.getByRole('checkbox', { name: /select gpt-5 for audit/i });
      const row = checkbox.closest('[role="button"]') as HTMLElement;
      // Initial state: unchecked (opt-in).
      expect(checkbox).not.toBeChecked();

      await user.click(row);

      expect(checkbox).toBeChecked();
    });

    it('clicking the row div twice unchecks a previously-checked model', async () => {
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      const checkbox = screen.getByRole('checkbox', { name: /select gpt-5 for audit/i });
      const row = checkbox.closest('[role="button"]') as HTMLElement;

      // Click once to check, click again to uncheck.
      await user.click(row);
      expect(checkbox).toBeChecked();
      await user.click(row);

      expect(checkbox).not.toBeChecked();
    });

    it('updates the selection count when a model row is clicked', async () => {
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      // Initial state: 0 of 2 selected
      expect(
        screen.getByText((_, el) => el?.textContent === '0 of 2 selected')
      ).toBeInTheDocument();

      // Click the row div to select GPT-5
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
    it('submit button shows count of selected models', async () => {
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      // Initial state: 0 selected → button reads "Audit 0 models"
      expect(screen.getByRole('button', { name: /audit 0 models/i })).toBeInTheDocument();

      // After selecting all, count flips to 2.
      await user.click(screen.getByRole('button', { name: /^select all$/i }));
      expect(screen.getByRole('button', { name: /audit 2 models/i })).toBeInTheDocument();
    });

    it('submit button uses singular "model" when 1 model is selected', async () => {
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      // Select only Claude-4 by ticking its row.
      const claudeCheckbox = screen.getByRole('checkbox', { name: /select claude-4 for audit/i });
      const claudeRow = claudeCheckbox.closest('[role="button"]') as HTMLElement;
      await user.click(claudeRow);

      expect(screen.getByRole('button', { name: /audit 1 model$/i })).toBeInTheDocument();
    });

    it('submit button is disabled on initial render (0 models selected)', () => {
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);
      const auditBtn = screen.getByRole('button', { name: /audit 0 models/i });
      expect(auditBtn).toBeDisabled();
    });

    it('submit button is enabled after at least one model is selected', async () => {
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      await user.click(screen.getByRole('button', { name: /^select all$/i }));
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

      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      await user.click(screen.getByRole('button', { name: /^select all$/i }));
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

    it('POSTs to the workflow execute endpoint (SSE) once the workflow is resolved', async () => {
      // The endpoint returns SSE — not JSON — so the dialog reads the
      // stream just long enough to capture the workflow_started event's
      // executionId, then aborts. We verify `fetch` was called with the
      // right URL + body.
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue([
        { id: 'wf-123', slug: 'tpl-provider-model-audit' },
      ]);

      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      await user.click(screen.getByRole('button', { name: /^select all$/i }));
      await user.click(screen.getByRole('button', { name: /audit 2 models/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/v1/admin/orchestration/workflows/wf-123/execute');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string) as {
        inputData: { modelIds: string[] };
      };
      expect(body.inputData.modelIds).toEqual(
        expect.arrayContaining([MODEL_OPENAI.id, MODEL_ANTHROPIC.id])
      );
    });

    it('defaults __runSupervisor=false in the submitted inputData (opt-in)', async () => {
      // The audit dialog is the most common trigger; defaulting to OFF
      // keeps the cost surface predictable. Operators who want the
      // honest verdict opt in by ticking the box.
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue([
        { id: 'wf-123', slug: 'tpl-provider-model-audit' },
      ]);
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);
      await user.click(screen.getByRole('button', { name: /^select all$/i }));
      await user.click(screen.getByRole('button', { name: /audit 2 models/i }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as {
        inputData: { __runSupervisor: boolean };
      };
      expect(body.inputData.__runSupervisor).toBe(false);
    });

    it('defaults __generateReport=false in the submitted inputData (opt-in)', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue([
        { id: 'wf-123', slug: 'tpl-provider-model-audit' },
      ]);
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);
      await user.click(screen.getByRole('button', { name: /^select all$/i }));
      await user.click(screen.getByRole('button', { name: /audit 2 models/i }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as {
        inputData: { __generateReport: boolean };
      };
      expect(body.inputData.__generateReport).toBe(false);
    });

    it('checking "Include detailed report in notification email" sets __generateReport=true on submit', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue([
        { id: 'wf-123', slug: 'tpl-provider-model-audit' },
      ]);
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);
      const reportCheckbox = screen.getByRole('checkbox', {
        name: /include detailed report in notification email/i,
      });
      // Starts unchecked (opt-in)
      expect(reportCheckbox).not.toBeChecked();
      await user.click(reportCheckbox);
      expect(reportCheckbox).toBeChecked();
      await user.click(screen.getByRole('button', { name: /^select all$/i }));
      await user.click(screen.getByRole('button', { name: /audit 2 models/i }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as {
        inputData: { __generateReport: boolean };
      };
      expect(body.inputData.__generateReport).toBe(true);
    });

    it('checking "Run neutral supervisor review" sets __runSupervisor=true on submit', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue([
        { id: 'wf-123', slug: 'tpl-provider-model-audit' },
      ]);
      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      // Tick the supervisor checkbox before submitting (opt-in default).
      const supervisorCheckbox = screen.getByRole('checkbox', {
        name: /run neutral supervisor review/i,
      });
      expect(supervisorCheckbox).not.toBeChecked();
      await user.click(supervisorCheckbox);
      expect(supervisorCheckbox).toBeChecked();

      await user.click(screen.getByRole('button', { name: /^select all$/i }));
      await user.click(screen.getByRole('button', { name: /audit 2 models/i }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as {
        inputData: { __runSupervisor: boolean };
      };
      expect(body.inputData.__runSupervisor).toBe(true);
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

      const onOpenChange = vi.fn();
      const user = userEvent.setup();
      render(
        <AuditModelsDialog
          open={true}
          onOpenChange={onOpenChange}
          models={[MODEL_OPENAI, MODEL_ANTHROPIC]}
        />
      );

      await user.click(screen.getByRole('button', { name: /^select all$/i }));
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
      fetchMock.mockResolvedValueOnce(sseExecuteResponse('exec-bg'));

      const onOpenChange = vi.fn();
      const user = userEvent.setup();
      render(
        <AuditModelsDialog
          open={true}
          onOpenChange={onOpenChange}
          models={[MODEL_OPENAI, MODEL_ANTHROPIC]}
        />
      );

      await user.click(screen.getByRole('button', { name: /^select all$/i }));
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

    it('resets the post-submit state on dismiss so a reopened dialog shows the fresh picker form', async () => {
      // Regression: after submitting an audit, dismissing the dialog left
      // `submittedExecution` set in component state, so the next time
      // the parent set open=true the dialog body showed the stale
      // inline-progress panel for the previous run (looking like the
      // new audit had already started/failed) instead of the model
      // picker. `handleDismiss` now clears the post-submit state.
      //
      // The parent (provider-models-matrix) keeps this dialog mounted
      // and toggles `open`, so the component instance — and its
      // useState — survive between opens. Driving the dismiss path on a
      // mounted-and-open instance asserts the same state-clearing the
      // reopen scenario depends on.
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue([
        { id: 'wf-123', slug: 'tpl-provider-model-audit', name: 'Provider Model Audit' },
      ]);
      fetchMock.mockResolvedValueOnce(sseExecuteResponse('exec-stale'));

      const onOpenChange = vi.fn();
      const user = userEvent.setup();
      render(
        <AuditModelsDialog
          open={true}
          onOpenChange={onOpenChange}
          models={[MODEL_OPENAI, MODEL_ANTHROPIC]}
        />
      );

      // Initiate an audit so the dialog swaps into the inline-progress view.
      // findByRole instead of getByRole — Radix renders into a portal and
      // under load the portal may not be mounted on the first sync tick.
      await user.click(await screen.findByRole('button', { name: /^select all$/i }));
      await user.click(await screen.findByRole('button', { name: /audit 2 models/i }));
      await waitFor(() => screen.getByTestId('execution-progress-inline'));

      // Dismiss via the running-state "Run in background" footer button —
      // mirrors what a real operator would do once they've kicked off
      // the audit and are returning to the matrix.
      await user.click(screen.getByTestId('audit-run-in-background'));
      expect(onOpenChange).toHaveBeenCalledWith(false);

      // The dialog is still rendered (the spy doesn't actually update
      // the `open` prop), but the post-submit state is cleared: the
      // inline-progress panel is gone and the picker form is back.
      await waitFor(() => {
        expect(queryByTestId(document.body, 'execution-progress-inline')).toBeNull();
      });
      // Picker form is back: the provider filter, select/deselect-all
      // toggle, and the initiating submit button are all rendered again.
      // The running-state footer buttons are gone.
      expect(screen.getByRole('combobox')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^(select|deselect) all$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /audit \d+ models?/i })).toBeInTheDocument();
      expect(queryByTestId(document.body, 'audit-run-in-background')).toBeNull();
      expect(queryByTestId(document.body, 'audit-view-full-details')).toBeNull();
    });

    it('"View full details" navigates AND preserves the in-flight localStorage entry', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue([
        { id: 'wf-123', slug: 'tpl-provider-model-audit', name: 'Provider Model Audit' },
      ]);
      fetchMock.mockResolvedValueOnce(sseExecuteResponse('exec-vfd'));

      const onOpenChange = vi.fn();
      const user = userEvent.setup();
      render(
        <AuditModelsDialog
          open={true}
          onOpenChange={onOpenChange}
          models={[MODEL_OPENAI, MODEL_ANTHROPIC]}
        />
      );

      await user.click(screen.getByRole('button', { name: /^select all$/i }));
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

      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      await user.click(await screen.findByRole('button', { name: /^select all$/i }));
      await user.click(await screen.findByRole('button', { name: /audit 2 models/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string) as {
        inputData: {
          models: Array<{ id: string; name: string; modelId: string; providerSlug: string }>;
        };
      };
      expect(body.inputData.models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: MODEL_OPENAI.id,
            name: MODEL_OPENAI.name,
            modelId: MODEL_OPENAI.modelId,
            providerSlug: MODEL_OPENAI.providerSlug,
          }),
        ])
      );
    });

    it('only submits the selected models (not all models)', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue([
        { id: 'wf-123', slug: 'tpl-provider-model-audit' },
      ]);

      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      // Initial state is empty; select only the OpenAI model via row click
      // (avoids the double-toggle that would fire if we clicked the input).
      const gptCheckbox = await screen.findByRole('checkbox', {
        name: /select gpt-5 for audit/i,
      });
      const gptRow = gptCheckbox.closest('[role="button"]') as HTMLElement;
      await user.click(gptRow);
      await user.click(await screen.findByRole('button', { name: /audit 1 model$/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string) as {
        inputData: { modelIds: string[] };
      };
      expect(body.inputData.modelIds).toEqual([MODEL_OPENAI.id]);
      expect(body.inputData.modelIds).not.toContain(MODEL_ANTHROPIC.id);
    });
  });

  // ── Error states ───────────────────────────────────────────────────────────

  describe('error states', () => {
    it('shows specific "workflow not found" message when GET returns empty array', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue([]); // no workflows found

      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      await user.click(screen.getByRole('button', { name: /^select all$/i }));
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

      await user.click(screen.getByRole('button', { name: /^select all$/i }));
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

      await user.click(screen.getByRole('button', { name: /^select all$/i }));
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

      await user.click(screen.getByRole('button', { name: /^select all$/i }));
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

      await user.click(screen.getByRole('button', { name: /^select all$/i }));
      await user.click(screen.getByRole('button', { name: /audit 2 models/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });

      expect(mockPush).not.toHaveBeenCalled(); // test-review:accept no_arg_called — guard: redirect must not fire on missing workflow
    });

    it('does not redirect when the execute SSE request fails', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue([
        { id: 'wf-123', slug: 'tpl-provider-model-audit' },
      ]);
      fetchMock.mockRejectedValueOnce(new Error('Execute failed'));

      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      await user.click(await screen.findByRole('button', { name: /^select all$/i }));
      await user.click(await screen.findByRole('button', { name: /audit 2 models/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });

      expect(mockPush).not.toHaveBeenCalled(); // test-review:accept no_arg_called — guard: redirect must not fire on execute failure
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

      await user.click(screen.getByRole('button', { name: /^select all$/i }));
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

      await user.click(screen.getByRole('button', { name: /^select all$/i }));
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

      await user.click(screen.getByRole('button', { name: /^select all$/i }));
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

  // ── Cost estimate ──────────────────────────────────────────────────────────

  describe('cost estimate', () => {
    /**
     * Route apiClient.get by URL so the workflow lookup and the
     * cost-estimate call can return different shapes. Without this the
     * mock would feed the workflow array into setEstimate and render
     * "$0.00" — fine for tests that don't look at the estimate but
     * confusing here.
     */
    async function mockApiByUrl(estimate: unknown): Promise<void> {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockImplementation((path: string): Promise<unknown> => {
        if (path.includes('/cost-estimate')) {
          return Promise.resolve(estimate);
        }
        return Promise.resolve([{ id: 'wf-123', slug: 'tpl-provider-model-audit' }]);
      });
    }

    it('hides the estimate row when nothing is selected', async () => {
      // Dialog opens with no selection; the row should not be in the DOM.
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);
      expect(screen.queryByTestId('audit-cost-estimate')).not.toBeInTheDocument();
    });

    it('renders the estimate row after selecting models', async () => {
      await mockApiByUrl({
        midUsd: 0.42,
        lowUsd: 0.3,
        highUsd: 0.6,
        basedOn: 'empirical',
        sampleSize: 7,
        modelUsed: 'claude-sonnet-4-6',
        judgeModelUsed: null,
        modelMix: [
          {
            modelId: 'claude-sonnet-4-6',
            role: 'work',
            inputTokens: 12_000,
            outputTokens: 4_000,
            costUsd: 0.42,
            pricingKnown: true,
          },
        ],
        workflowHasSupervisor: false,
        llmStepCount: 5,
        notes: 'Calibrated from 7 past runs.',
      });

      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      await user.click(screen.getByRole('button', { name: /^select all$/i }));

      // The estimate row mounts immediately as "Estimating cost…" then
      // swaps to the priced version after the debounced fetch resolves.
      // Wait for the priced text, not the loading text.
      await screen.findByText(/Estimated cost:/i, undefined, { timeout: 1500 });

      const row = screen.getByTestId('audit-cost-estimate');
      expect(row).toHaveTextContent('$0.42');
      expect(row).toHaveTextContent('$0.30');
      expect(row).toHaveTextContent('$0.60');
    });

    it('passes the selected model count and supervisor toggle to the estimate endpoint', async () => {
      await mockApiByUrl({
        midUsd: 0.5,
        lowUsd: 0.4,
        highUsd: 0.7,
        basedOn: 'heuristic',
        sampleSize: 0,
        modelUsed: 'claude-sonnet-4-6',
        judgeModelUsed: 'claude-sonnet-4-6',
        modelMix: [
          {
            modelId: 'claude-sonnet-4-6',
            role: 'work',
            inputTokens: 24_000,
            outputTokens: 6_000,
            costUsd: 0.4,
            pricingKnown: true,
          },
          {
            modelId: 'claude-sonnet-4-6',
            role: 'supervisor',
            inputTokens: 18_000,
            outputTokens: 2_500,
            costUsd: 0.1,
            pricingKnown: true,
          },
        ],
        workflowHasSupervisor: true,
        llmStepCount: 5,
        notes: 'Rough heuristic.',
      });
      const { apiClient } = await import('@/lib/api/client');

      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      await user.click(screen.getByRole('button', { name: /^select all$/i }));
      // Tick the supervisor box so the call includes supervisor=true.
      await user.click(screen.getByRole('checkbox', { name: /run neutral supervisor review/i }));

      await waitFor(
        () => {
          const supervisorCall = vi
            .mocked(apiClient.get)
            .mock.calls.find(
              ([path, opts]) =>
                typeof path === 'string' &&
                path.includes('/cost-estimate') &&
                (opts as { params?: Record<string, unknown> } | undefined)?.params?.supervisor ===
                  true
            );
          expect(supervisorCall).toBeDefined();
        },
        { timeout: 1500 }
      );

      const [, opts] =
        vi
          .mocked(apiClient.get)
          .mock.calls.find(
            ([path]) => typeof path === 'string' && path.includes('/cost-estimate')
          ) ?? [];
      const params = (opts as { params?: { itemCount?: number; supervisor?: boolean } } | undefined)
        ?.params;
      expect(params?.itemCount).toBe(2);
    });

    it('falls back silently when the estimate endpoint errors', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockImplementation((path: string) => {
        if (path.includes('/cost-estimate')) {
          return Promise.reject(new Error('boom'));
        }
        return Promise.resolve([{ id: 'wf-123', slug: 'tpl-provider-model-audit' }]);
      });

      const user = userEvent.setup();
      render(<AuditModelsDialog {...DEFAULT_PROPS} />);

      await user.click(screen.getByRole('button', { name: /^select all$/i }));

      // The estimate row should not be visible — the dialog stays usable
      // even with a broken estimate endpoint.
      await waitFor(
        () => {
          expect(screen.queryByTestId('audit-cost-estimate')).not.toBeInTheDocument();
        },
        { timeout: 1500 }
      );
    });
  });
});
