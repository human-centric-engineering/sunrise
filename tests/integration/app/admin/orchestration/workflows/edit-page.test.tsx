/**
 * Integration Test: Admin Orchestration — Edit Workflow Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/workflows/[id]/page.tsx`.
 *
 * Test Coverage:
 * - Happy path: serverFetch returns a valid workflow → builder is rendered,
 *   notFound is NOT called
 * - Failure path: serverFetch returns ok=false → notFound is called
 *
 * @see app/admin/orchestration/workflows/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
  })),
  useNodesState: vi.fn((initial: unknown[]) => [initial, vi.fn(), vi.fn()]),
  useEdgesState: vi.fn((initial: unknown[]) => [initial, vi.fn(), vi.fn()]),
  addEdge: vi.fn((edge: unknown, edges: unknown[]) => [...edges, edge]),
}));

// ─── Other mocks ──────────────────────────────────────────────────────────────

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
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

// Override next/navigation to expose notFound as a tracked mock
const notFoundMock = vi.fn(() => {
  // In the real Next.js runtime notFound() throws; we simulate by throwing
  // so page rendering short-circuits the same way.
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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TWO_STEP_WORKFLOW = {
  id: 'wf-1',
  name: 'My Workflow',
  slug: 'my-workflow',
  description: 'Test',
  workflowDefinition: {
    entryStepId: 'step-1',
    errorStrategy: 'fail',
    steps: [
      {
        id: 'step-1',
        name: 'Step 1',
        type: 'llm_call',
        config: {},
        nextSteps: [{ targetStepId: 'step-2' }],
      },
      { id: 'step-2', name: 'Step 2', type: 'chain', config: {}, nextSteps: [] },
    ],
  },
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the WorkflowBuilder and does NOT call notFound on happy path', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: TWO_STEP_WORKFLOW,
    });

    const { default: EditWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/[id]/page');

    render(await EditWorkflowPage({ params: Promise.resolve({ id: 'wf-1' }) }));

    // The builder toolbar should be rendered
    expect(screen.getByTestId('builder-toolbar')).toBeInTheDocument();
    // notFound should NOT have been called
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it('calls notFound when serverFetch returns ok=false', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);

    const { default: EditWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/[id]/page');

    // notFound throws internally so the page render throws NEXT_NOT_FOUND
    let caught: Error | undefined;
    try {
      await EditWorkflowPage({ params: Promise.resolve({ id: 'wf-missing' }) });
    } catch (err) {
      caught = err as Error;
    }

    expect(notFoundMock).toHaveBeenCalledTimes(1);
    expect(caught?.message).toBe('NEXT_NOT_FOUND');
  });

  it('calls notFound when parseApiResponse returns success=false', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });

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
});
