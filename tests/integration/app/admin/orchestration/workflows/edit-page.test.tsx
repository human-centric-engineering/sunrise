/**
 * Integration Test: Admin Orchestration — Edit Workflow Page (5.1b)
 *
 * Tests the server-component page at
 * `app/admin/orchestration/workflows/[id]/page.tsx`.
 *
 * Test Coverage (5.1a carry-over):
 * - Happy path: serverFetch returns a valid workflow → builder is rendered,
 *   notFound is NOT called
 * - Failure path: serverFetch returns ok=false → notFound is called
 *
 * Test Coverage (5.1b additions):
 * - Clicking Save calls apiClient.patch directly (no dialog in edit mode)
 * - The PATCH body's workflowDefinition.steps contains the original steps
 *
 * @see app/admin/orchestration/workflows/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';

// ─── @xyflow/react mock (must precede component imports) ──────────────────────

vi.mock('@xyflow/react', () => ({
  ReactFlow: () => <div data-testid="rf-canvas" />,
  ReactFlowProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  useReactFlow: vi.fn(() => ({
    screenToFlowPosition: vi.fn(({ x, y }: { x: number; y: number }) => ({ x, y })),
    setCenter: vi.fn(),
    getNode: vi.fn(),
  })),
  useNodesState: vi.fn((initial: unknown[]) => [initial, vi.fn(), vi.fn()]),
  useEdgesState: vi.fn((initial: unknown[]) => [initial, vi.fn(), vi.fn()]),
  addEdge: vi.fn((edge: unknown, edges: unknown[]) => [...edges, edge]),
}));

vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
  ThemeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// ─── Other mocks ──────────────────────────────────────────────────────────────

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    post: vi.fn(),
    patch: vi.fn(),
    get: vi.fn().mockResolvedValue({ schedules: [] }),
    delete: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    code?: string;
    constructor(message: string, code?: string) {
      super(message);
      this.name = 'APIClientError';
      this.code = code;
    }
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    withContext: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));

const notFoundMock = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
  notFound: notFoundMock,
  usePathname: vi.fn(() => '/'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  useParams: vi.fn(() => ({})),
  redirect: vi.fn(),
}));

import { apiClient } from '@/lib/api/client';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TWO_STEP_DEFINITION = {
  entryStepId: 'step-1',
  errorStrategy: 'fail' as const,
  steps: [
    {
      id: 'step-1',
      name: 'Step 1',
      type: 'llm_call',
      config: { prompt: 'original prompt' },
      nextSteps: [{ targetStepId: 'step-2' }],
    },
    { id: 'step-2', name: 'Step 2', type: 'chain', config: {}, nextSteps: [] },
  ],
};

const TWO_STEP_WORKFLOW = {
  id: 'wf-1',
  name: 'My Workflow',
  slug: 'my-workflow',
  description: 'Test',
  draftDefinition: null,
  publishedVersionId: 'wfv-1',
  publishedVersion: { id: 'wfv-1', version: 1, snapshot: TWO_STEP_DEFINITION },
  patternsUsed: [1, 2],
  isActive: true,
  isTemplate: false,
  metadata: null,
  createdBy: 'user-1',
  createdAt: new Date('2025-01-01').toISOString(),
  updatedAt: new Date('2025-01-01').toISOString(),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EditWorkflowPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.get).mockResolvedValue({ schedules: [] } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the WorkflowBuilder and does NOT call notFound on happy path', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: TWO_STEP_WORKFLOW }) // workflow
      .mockResolvedValueOnce({ success: true, data: [] }) // capabilities
      .mockResolvedValueOnce({ success: true, data: [] }); // templates

    const { default: EditWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/[id]/page');

    render(await EditWorkflowPage({ params: Promise.resolve({ id: 'wf-1' }) }));

    expect(screen.getByTestId('builder-toolbar')).toBeInTheDocument();
    expect(notFoundMock).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });

  it('calls notFound when serverFetch returns ok=false for the workflow', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch)
      .mockResolvedValueOnce({ ok: false } as Response) // workflow → not found
      .mockResolvedValueOnce({ ok: true } as Response) // capabilities
      .mockResolvedValueOnce({ ok: true } as Response); // templates
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: [] }) // capabilities
      .mockResolvedValueOnce({ success: true, data: [] }); // templates

    const { default: EditWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/[id]/page');

    let caught: Error | undefined;
    try {
      await EditWorkflowPage({ params: Promise.resolve({ id: 'wf-missing' }) });
    } catch (err) {
      caught = err as Error;
    }

    expect(notFoundMock).toHaveBeenCalledTimes(1);
    expect(caught?.message).toBe('NEXT_NOT_FOUND');
  });

  it('calls notFound when parseApiResponse returns success=false for the workflow', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } }) // workflow
      .mockResolvedValueOnce({ success: true, data: [] }) // capabilities
      .mockResolvedValueOnce({ success: true, data: [] }); // templates

    const { default: EditWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/[id]/page');

    let caught: Error | undefined;
    try {
      await EditWorkflowPage({ params: Promise.resolve({ id: 'wf-gone' }) });
    } catch (err) {
      caught = err as Error;
    }

    expect(notFoundMock).toHaveBeenCalledTimes(1);
    expect(caught?.message).toBe('NEXT_NOT_FOUND');
  });

  it('5.1b: clicking Save calls apiClient.patch directly (no dialog in edit mode)', async () => {
    const user = userEvent.setup();
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: TWO_STEP_WORKFLOW }) // workflow
      .mockResolvedValueOnce({ success: true, data: [] }) // capabilities
      .mockResolvedValueOnce({ success: true, data: [] }); // templates
    vi.mocked(apiClient.patch).mockResolvedValue(TWO_STEP_WORKFLOW);

    const { default: EditWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/[id]/page');

    render(await EditWorkflowPage({ params: Promise.resolve({ id: 'wf-1' }) }));

    await user.click(screen.getByRole('button', { name: /save draft/i }));

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledTimes(1);
    });

    // Verify no dialog appeared
    expect(screen.queryByText(/workflow details/i)).not.toBeInTheDocument();
  });

  it('5.1b: PATCH body draftDefinition contains the serialised steps', async () => {
    const user = userEvent.setup();
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: TWO_STEP_WORKFLOW }) // workflow
      .mockResolvedValueOnce({ success: true, data: [] }) // capabilities
      .mockResolvedValueOnce({ success: true, data: [] }); // templates
    vi.mocked(apiClient.patch).mockResolvedValue(TWO_STEP_WORKFLOW);

    const { default: EditWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/[id]/page');

    render(await EditWorkflowPage({ params: Promise.resolve({ id: 'wf-1' }) }));

    await user.click(screen.getByRole('button', { name: /save draft/i }));

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledTimes(1);
    });

    const [, options] = vi.mocked(apiClient.patch).mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    // PATCH writes to the draft, leaving the published version untouched.
    const def = body.draftDefinition as { steps: Array<{ id: string; type: string }> };
    expect(Array.isArray(def.steps)).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
    expect(def.steps).toHaveLength(2);
  });

  it('hydrates getAgents() and getTemplates() when those endpoints return data', async () => {
    // Exercises two inline transform functions that the other tests don't
    // cover: (1) the agent-row mapper inside `getAgents` and (2) the
    // templateItemSchema's `.transform()` that flattens publishedVersion.snapshot
    // back to a top-level workflowDefinition. Both fire only when the
    // upstream lists are non-empty.
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: TWO_STEP_WORKFLOW }) // workflow
      .mockResolvedValueOnce({
        success: true,
        data: [
          { slug: 'cap-1', name: 'Cap One', description: 'One' },
          { slug: 'cap-2', name: 'Cap Two', description: null },
        ],
      }) // capabilities
      .mockResolvedValueOnce({
        success: true,
        data: [
          { slug: 'agent-1', name: 'Agent One', description: 'A1' },
          { slug: 'agent-2', name: 'Agent Two', description: null },
        ],
      }) // agents (exercises the inline `body.data.map` transform on line ~89)
      .mockResolvedValueOnce({
        success: true,
        data: [
          // Exercises the `templateItemSchema.transform` callback that
          // flattens publishedVersion.snapshot to workflowDefinition.
          {
            slug: 'tpl-1',
            name: 'Template One',
            description: 'first',
            publishedVersion: { snapshot: TWO_STEP_DEFINITION },
            patternsUsed: [],
            isTemplate: true,
            metadata: null,
          },
        ],
      }); // templates

    const { default: EditWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/[id]/page');

    render(await EditWorkflowPage({ params: Promise.resolve({ id: 'wf-1' }) }));

    // The page renders without throwing — the inline transforms ran successfully.
    expect(screen.getByTestId('builder-toolbar')).toBeInTheDocument();
  });
});
