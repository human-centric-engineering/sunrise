// @vitest-environment happy-dom

/**
 * Unit Tests: NewWorkflowPage
 *
 * Tests the admin "New Workflow" server component page at
 * `app/admin/orchestration/workflows/new/page.tsx`.
 *
 * Branch coverage targets:
 * - getCapabilities: res.ok false → [], body.success false → [], throw → []
 * - getAgents: res.ok false → [], body.success false → [], throw → []
 * - getTemplates: res.ok false → [], body.success false → [], schema fail → [] (logged), throw → []
 * - searchParams.definition: valid JSON → pre-populated builder; invalid JSON → empty builder
 * - searchParams.definition: valid JSON but bad schema → empty builder
 * - No auth-redirect test: per gotcha #21, auth guard lives in the admin layout, not this page.
 *
 * @see app/admin/orchestration/workflows/new/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// Stub WorkflowBuilder — server component renders it with specific props
vi.mock('@/components/admin/orchestration/workflow-builder/workflow-builder', () => ({
  WorkflowBuilder: (props: {
    mode: string;
    initialDefinition?: unknown;
    initialCapabilities?: unknown[];
    initialAgents?: unknown[];
    initialTemplates?: unknown[];
  }) => (
    <div
      data-testid="workflow-builder"
      data-mode={props.mode}
      data-has-definition={props.initialDefinition !== undefined ? 'true' : 'false'}
      data-capabilities-count={String(props.initialCapabilities?.length ?? 0)}
      data-agents-count={String(props.initialAgents?.length ?? 0)}
      data-templates-count={String(props.initialTemplates?.length ?? 0)}
    />
  ),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────────

import NewWorkflowPage from '@/app/admin/orchestration/workflows/new/page';
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { API } from '@/lib/api/endpoints';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function okResponse(): Response {
  return { ok: true } as Response;
}

function notOkResponse(): Response {
  return { ok: false } as Response;
}

/** Minimal valid WorkflowDefinition that satisfies the workflowDefinitionSchema. */
const VALID_DEFINITION = {
  steps: [
    {
      id: 'step-1',
      name: 'First step',
      type: 'llm_call' as const,
      config: {},
      nextSteps: [],
    },
  ],
  entryStepId: 'step-1',
  errorStrategy: 'fail' as const,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('NewWorkflowPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Mode ─────────────────────────────────────────────────────────────────

  it('renders WorkflowBuilder in create mode', async () => {
    // Arrange — all fetchers return empty on !ok
    vi.mocked(serverFetch).mockResolvedValue(notOkResponse());
    const searchParams = Promise.resolve({});

    // Act
    render(await NewWorkflowPage({ searchParams }));

    // Assert: builder always gets mode="create"
    const builder = screen.getByTestId('workflow-builder');
    expect(builder).toHaveAttribute('data-mode', 'create');
  });

  // ── getCapabilities branches ──────────────────────────────────────────────

  describe('getCapabilities', () => {
    it('passes empty capabilities when res.ok is false', async () => {
      // Arrange
      vi.mocked(serverFetch).mockResolvedValue(notOkResponse());
      const searchParams = Promise.resolve({});

      // Act
      render(await NewWorkflowPage({ searchParams }));

      // Assert: res.ok false path → []
      const builder = screen.getByTestId('workflow-builder');
      expect(builder).toHaveAttribute('data-capabilities-count', '0');
    });

    it('passes empty capabilities when body.success is false', async () => {
      // Arrange — only the first call (capabilities) returns a body.success:false
      vi.mocked(serverFetch).mockResolvedValue(okResponse());
      vi.mocked(parseApiResponse).mockResolvedValue({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'fail' },
      } as never);
      const searchParams = Promise.resolve({});

      // Act
      render(await NewWorkflowPage({ searchParams }));

      // Assert: body.success false path → []
      const builder = screen.getByTestId('workflow-builder');
      expect(builder).toHaveAttribute('data-capabilities-count', '0');
    });

    it('logs error and passes empty capabilities when serverFetch throws', async () => {
      // Arrange
      const fetchErr = new Error('Network failure');
      vi.mocked(serverFetch).mockRejectedValue(fetchErr);
      const searchParams = Promise.resolve({});

      // Act
      render(await NewWorkflowPage({ searchParams }));

      // Assert: throw path → [] + logged
      const builder = screen.getByTestId('workflow-builder');
      expect(builder).toHaveAttribute('data-capabilities-count', '0');
      expect(logger.error).toHaveBeenCalledWith(
        'new workflow page: capabilities fetch failed',
        fetchErr
      );
    });

    it('passes capabilities when fetch succeeds', async () => {
      // Arrange — capabilities fetch returns 2 items, agents and templates return ok=false
      const mockCapabilities = [
        { id: 'cap-1', name: 'Search' },
        { id: 'cap-2', name: 'Lookup' },
      ];
      vi.mocked(serverFetch).mockResolvedValue(okResponse());
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: mockCapabilities } as never)
        .mockResolvedValueOnce({ success: false } as never) // agents
        .mockResolvedValueOnce({ success: false } as never); // templates
      const searchParams = Promise.resolve({});

      // Act
      render(await NewWorkflowPage({ searchParams }));

      // Assert: 2 capabilities forwarded to builder
      const builder = screen.getByTestId('workflow-builder');
      expect(builder).toHaveAttribute('data-capabilities-count', '2');
    });
  });

  // ── getAgents branches ────────────────────────────────────────────────────

  describe('getAgents', () => {
    it('passes empty agents when res.ok is false', async () => {
      vi.mocked(serverFetch).mockResolvedValue(notOkResponse());
      const searchParams = Promise.resolve({});

      render(await NewWorkflowPage({ searchParams }));

      const builder = screen.getByTestId('workflow-builder');
      expect(builder).toHaveAttribute('data-agents-count', '0');
    });

    it('logs error and passes empty agents when serverFetch throws', async () => {
      const fetchErr = new Error('Agent fetch failed');
      vi.mocked(serverFetch).mockRejectedValue(fetchErr);
      const searchParams = Promise.resolve({});

      render(await NewWorkflowPage({ searchParams }));

      const builder = screen.getByTestId('workflow-builder');
      expect(builder).toHaveAttribute('data-agents-count', '0');
      expect(logger.error).toHaveBeenCalledWith('new workflow page: agents fetch failed', fetchErr);
    });

    it('passes agents when fetch succeeds', async () => {
      // Arrange — capabilities returns ok=false, agents returns 1 item
      const mockAgents = [{ slug: 'support-bot', name: 'Support Bot', description: null }];
      vi.mocked(serverFetch).mockResolvedValue(okResponse());
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: false } as never) // capabilities
        .mockResolvedValueOnce({ success: true, data: mockAgents } as never) // agents
        .mockResolvedValueOnce({ success: false } as never); // templates
      const searchParams = Promise.resolve({});

      render(await NewWorkflowPage({ searchParams }));

      const builder = screen.getByTestId('workflow-builder');
      expect(builder).toHaveAttribute('data-agents-count', '1');
    });
  });

  // ── getTemplates branches ─────────────────────────────────────────────────

  describe('getTemplates', () => {
    it('passes empty templates when res.ok is false', async () => {
      vi.mocked(serverFetch).mockResolvedValue(notOkResponse());
      const searchParams = Promise.resolve({});

      render(await NewWorkflowPage({ searchParams }));

      const builder = screen.getByTestId('workflow-builder');
      expect(builder).toHaveAttribute('data-templates-count', '0');
    });

    it('passes empty templates when body.success is false', async () => {
      vi.mocked(serverFetch).mockResolvedValue(okResponse());
      vi.mocked(parseApiResponse).mockResolvedValue({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'fail' },
      } as never);
      const searchParams = Promise.resolve({});

      render(await NewWorkflowPage({ searchParams }));

      const builder = screen.getByTestId('workflow-builder');
      expect(builder).toHaveAttribute('data-templates-count', '0');
    });

    it('logs error and passes empty templates when serverFetch throws', async () => {
      const fetchErr = new Error('Templates fetch failed');
      vi.mocked(serverFetch).mockRejectedValue(fetchErr);
      const searchParams = Promise.resolve({});

      render(await NewWorkflowPage({ searchParams }));

      expect(logger.error).toHaveBeenCalledWith(
        'new workflow page: templates fetch failed',
        fetchErr
      );
      const builder = screen.getByTestId('workflow-builder');
      expect(builder).toHaveAttribute('data-templates-count', '0');
    });

    it('logs and passes empty templates when the response fails templateCatalogueSchema', async () => {
      // Arrange: fetch succeeds; body.success=true but data items are missing required
      // catalogue entry fields (source, slug, name, etc.) — safeParse returns failure
      vi.mocked(serverFetch).mockResolvedValue(okResponse());
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: false } as never) // capabilities → []
        .mockResolvedValueOnce({ success: false } as never) // agents → []
        .mockResolvedValueOnce({
          success: true,
          data: [{ not: 'a-template' }], // fails templateCatalogueSchema
        } as never); // templates
      const searchParams = Promise.resolve({});

      // Act
      render(await NewWorkflowPage({ searchParams }));

      // Assert: the parse failure is logged, not swallowed, and [] reaches the builder
      expect(logger.warn).toHaveBeenCalledWith(
        'new workflow page: templates response did not parse',
        expect.objectContaining({ issues: expect.any(Array) })
      );
      const builder = screen.getByTestId('workflow-builder');
      expect(builder).toHaveAttribute('data-templates-count', '0');
    });

    it('forwards each catalogue entry to the builder as a template', async () => {
      vi.mocked(serverFetch).mockResolvedValue(okResponse());
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: false } as never) // capabilities → []
        .mockResolvedValueOnce({ success: false } as never) // agents → []
        .mockResolvedValueOnce({
          success: true,
          data: [
            {
              source: 'builtin',
              slug: 'tpl-a',
              name: 'A',
              description: 'a',
              workflowDefinition: { steps: [], entryStepId: 's1', errorStrategy: 'fail' },
              patternsUsed: [1],
              metadata: null,
            },
            {
              source: 'custom',
              slug: 'mine',
              name: 'Mine',
              description: 'm',
              workflowDefinition: null,
              patternsUsed: [],
              metadata: null,
            },
          ],
        } as never); // templates

      render(await NewWorkflowPage({ searchParams: Promise.resolve({}) }));

      expect(screen.getByTestId('workflow-builder')).toHaveAttribute('data-templates-count', '2');
    });
  });

  // ── searchParams.definition branch ───────────────────────────────────────

  describe('searchParams.definition', () => {
    it('does not pre-populate builder when definition param is absent', async () => {
      vi.mocked(serverFetch).mockResolvedValue(notOkResponse());
      const searchParams = Promise.resolve({});

      render(await NewWorkflowPage({ searchParams }));

      const builder = screen.getByTestId('workflow-builder');
      expect(builder).toHaveAttribute('data-has-definition', 'false');
    });

    it('pre-populates builder when definition param is a valid encoded WorkflowDefinition', async () => {
      vi.mocked(serverFetch).mockResolvedValue(notOkResponse());
      const encoded = encodeURIComponent(JSON.stringify(VALID_DEFINITION));
      const searchParams = Promise.resolve({ definition: encoded });

      render(await NewWorkflowPage({ searchParams }));

      const builder = screen.getByTestId('workflow-builder');
      expect(builder).toHaveAttribute('data-has-definition', 'true');
    });

    it('falls through to empty builder when definition param is malformed JSON', async () => {
      vi.mocked(serverFetch).mockResolvedValue(notOkResponse());
      const searchParams = Promise.resolve({ definition: '%7Bnot-valid-json%7D' });

      render(await NewWorkflowPage({ searchParams }));

      const builder = screen.getByTestId('workflow-builder');
      // JSON.parse fails → catch block → initialDefinition stays undefined
      expect(builder).toHaveAttribute('data-has-definition', 'false');
    });

    it('falls through to empty builder when definition param is valid JSON but fails schema', async () => {
      vi.mocked(serverFetch).mockResolvedValue(notOkResponse());
      // Valid JSON but missing required WorkflowDefinition fields
      const badDef = { unknown_field: true };
      const encoded = encodeURIComponent(JSON.stringify(badDef));
      const searchParams = Promise.resolve({ definition: encoded });

      render(await NewWorkflowPage({ searchParams }));

      const builder = screen.getByTestId('workflow-builder');
      // safeParse fails → initialDefinition stays undefined
      expect(builder).toHaveAttribute('data-has-definition', 'false');
    });
  });

  // ── serverFetch endpoint verification ────────────────────────────────────

  describe('serverFetch endpoint calls', () => {
    it('calls the capabilities endpoint with limit=100', async () => {
      vi.mocked(serverFetch).mockResolvedValue(notOkResponse());
      const searchParams = Promise.resolve({});

      await NewWorkflowPage({ searchParams });

      expect(serverFetch).toHaveBeenCalledWith(`${API.ADMIN.ORCHESTRATION.CAPABILITIES}?limit=100`);
    });

    it('calls the agents endpoint with limit=100 and isActive=true', async () => {
      vi.mocked(serverFetch).mockResolvedValue(notOkResponse());
      const searchParams = Promise.resolve({});

      await NewWorkflowPage({ searchParams });

      expect(serverFetch).toHaveBeenCalledWith(
        `${API.ADMIN.ORCHESTRATION.AGENTS}?limit=100&isActive=true`
      );
    });

    it('reads templates from the templates catalogue endpoint', async () => {
      vi.mocked(serverFetch).mockResolvedValue(notOkResponse());
      const searchParams = Promise.resolve({});

      await NewWorkflowPage({ searchParams });

      expect(serverFetch).toHaveBeenCalledWith(API.ADMIN.ORCHESTRATION.WORKFLOW_TEMPLATES);
      // Not the old template rows: the built-ins are no longer rows.
      expect(serverFetch).not.toHaveBeenCalledWith(expect.stringContaining('isTemplate=true'));
    });
  });
});
