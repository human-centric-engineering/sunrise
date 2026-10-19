// @vitest-environment happy-dom

/**
 * Integration Test: Admin Orchestration — Edit Workflow Page (5.1b)
 *
 * Tests the server-component page at
 * `app/admin/orchestration/workflows/[id]/page.tsx`.
 *
 * Test Coverage (5.1a carry-over):
 * - Happy path: serverFetch returns a valid workflow → builder is rendered,
 *   notFound is NOT called
 * - A 404 for the workflow → notFound; any other failure throws
 *   ServerLoadError and notFound is NOT called (#518)
 * - A failed option list → a `role="alert"` notice; the builder still renders
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

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
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
import { API } from '@/lib/api/endpoints';
import { serverFetch } from '@/lib/api/server-fetch';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';

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

type Endpoint = 'workflow' | 'capabilities' | 'agents' | 'templates';

/**
 * Answer each endpoint the page reads with a fresh Response per call. The
 * workflow defaults to TWO_STEP_WORKFLOW, every list to empty.
 */
function routeFetch(overrides: Partial<Record<Endpoint, () => Response>> = {}) {
  const answers: Record<Endpoint, () => Response> = {
    workflow: () => apiSuccess(TWO_STEP_WORKFLOW),
    capabilities: () => apiSuccess([]),
    agents: () => apiSuccess([]),
    templates: () => apiSuccess([]),
    ...overrides,
  };
  vi.mocked(serverFetch).mockImplementation(async (url: string) => {
    if (url.startsWith(API.ADMIN.ORCHESTRATION.CAPABILITIES)) return answers.capabilities();
    if (url.startsWith(API.ADMIN.ORCHESTRATION.AGENTS)) return answers.agents();
    if (url.startsWith(API.ADMIN.ORCHESTRATION.WORKFLOW_TEMPLATES)) return answers.templates();
    if (url.startsWith(API.ADMIN.ORCHESTRATION.WORKFLOWS)) return answers.workflow();
    throw new Error(`Unexpected URL: ${url}`);
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EditWorkflowPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.get).mockResolvedValue({ schedules: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the WorkflowBuilder and does NOT call notFound on happy path', async () => {
    routeFetch();

    const { default: EditWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/[id]/page');

    render(await EditWorkflowPage({ params: Promise.resolve({ id: 'wf-1' }) }));

    expect(screen.getByTestId('builder-toolbar')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(notFoundMock).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });

  it('calls notFound when the workflow does not exist', async () => {
    routeFetch({ workflow: () => apiFailure(404, 'NOT_FOUND') });

    const { default: EditWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/[id]/page');

    await expect(
      EditWorkflowPage({ params: Promise.resolve({ id: 'wf-missing' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundMock).toHaveBeenCalledTimes(1);
  });

  it('throws to the error boundary, not notFound(), when the workflow load fails', async () => {
    const { ServerLoadError } = await import('@/lib/api/server-load');
    routeFetch({ workflow: () => apiFailure(500) });

    const { default: EditWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/[id]/page');

    await expect(
      EditWorkflowPage({ params: Promise.resolve({ id: 'wf-1' }) })
    ).rejects.toBeInstanceOf(ServerLoadError);
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it('still renders the builder, under a notice, when the capabilities fail to load', async () => {
    routeFetch({ capabilities: () => apiFailure(500) });

    const { default: EditWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/[id]/page');

    render(await EditWorkflowPage({ params: Promise.resolve({ id: 'wf-1' }) }));

    expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load capabilities/i);
    expect(screen.getByTestId('builder-toolbar')).toBeInTheDocument();
  });

  it('5.1b: clicking Save calls apiClient.patch directly (no dialog in edit mode)', async () => {
    const user = userEvent.setup();
    routeFetch();
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
    routeFetch();
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
    // templateCatalogueSchema's `.transform()` that maps a catalogue entry to
    // the builder's template shape. Both fire only when the
    // upstream lists are non-empty.
    routeFetch({
      capabilities: () =>
        apiSuccess([
          { slug: 'cap-1', name: 'Cap One', description: 'One' },
          { slug: 'cap-2', name: 'Cap Two', description: null },
        ]),
      agents: () =>
        apiSuccess([
          { slug: 'agent-1', name: 'Agent One', description: 'A1' },
          { slug: 'agent-2', name: 'Agent Two', description: null },
        ]),
      templates: () =>
        apiSuccess([
          // Exercises the `templateCatalogueSchema.transform` callback.
          {
            source: 'custom',
            slug: 'tpl-1',
            name: 'Template One',
            description: 'first',
            workflowDefinition: TWO_STEP_DEFINITION,
            patternsUsed: [],
            metadata: null,
          },
        ]),
    });

    const { default: EditWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/[id]/page');

    render(await EditWorkflowPage({ params: Promise.resolve({ id: 'wf-1' }) }));

    // The catalogue entry reached the builder: it is listed in the Use
    // template menu (disabled, since templates load only on a new workflow).
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /use template/i }));
    const item = await screen.findByRole('menuitem', { name: /template one/i, hidden: true });
    expect(item).toHaveAttribute('aria-disabled', 'true');
  });
});
