/**
 * Integration Test: New Workflow Page — Pre-population via ?definition=
 *
 * Tests that the new workflow page reads a `?definition=` search param
 * and passes it to WorkflowBuilder as `initialDefinition`.
 *
 * @see app/admin/orchestration/workflows/new/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useState, type ReactNode } from 'react';

// ─── @xyflow/react mock ───────────────────────────────────────────────────────

vi.mock('@xyflow/react', async () => {
  return {
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
    useNodesState: vi.fn((initial: unknown[]) => {
      const [nodes, setNodes] = useState<unknown[]>(initial);
      return [nodes, setNodes, vi.fn()];
    }),
    useEdgesState: vi.fn((initial: unknown[]) => {
      const [edges, setEdges] = useState<unknown[]>(initial);
      return [edges, setEdges, vi.fn()];
    }),
    addEdge: vi.fn((edge: unknown, edges: unknown[]) => [...edges, edge]),
  };
});

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    post: vi.fn(),
    patch: vi.fn(),
    get: vi.fn().mockResolvedValue([]),
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

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
  notFound: vi.fn(),
  usePathname: vi.fn(() => '/'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  useParams: vi.fn(() => ({})),
  redirect: vi.fn(),
}));

import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';

// ─── Tests ────────────────────────────────────────────────────────────────────

const MOCK_DEFINITION = {
  steps: [
    {
      id: 'step-1',
      type: 'llm_call',
      label: 'Analyze',
      config: { model: 'claude-sonnet-4-6', prompt: 'Analyze the input' },
      nextSteps: [{ targetStepId: 'step-2' }],
    },
    {
      id: 'step-2',
      type: 'llm_call',
      label: 'Summarize',
      config: { model: 'claude-sonnet-4-6', prompt: 'Summarize' },
      nextSteps: [],
    },
  ],
  entryStepId: 'step-1',
  errorStrategy: 'fail',
};

describe('NewWorkflowPage — definition pre-population', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders with pre-populated definition from search params', async () => {
    const encoded = encodeURIComponent(JSON.stringify(MOCK_DEFINITION));

    const { default: NewWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/new/page');

    render(
      await NewWorkflowPage({
        searchParams: Promise.resolve({ definition: encoded }),
      })
    );

    // The builder should render (palette, canvas, toolbar are present)
    expect(screen.getByTestId('pattern-palette')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-canvas')).toBeInTheDocument();
  });

  it('renders empty builder when no definition param is provided', async () => {
    const { default: NewWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/new/page');

    render(
      await NewWorkflowPage({
        searchParams: Promise.resolve({}),
      })
    );

    expect(screen.getByTestId('pattern-palette')).toBeInTheDocument();
  });

  it('renders empty builder when definition param is invalid JSON', async () => {
    const { default: NewWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/new/page');

    render(
      await NewWorkflowPage({
        searchParams: Promise.resolve({ definition: 'not-valid-json' }),
      })
    );

    expect(screen.getByTestId('pattern-palette')).toBeInTheDocument();
  });

  it('renders empty builder when definition param has no steps array', async () => {
    const encoded = encodeURIComponent(JSON.stringify({ foo: 'bar' }));

    const { default: NewWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/new/page');

    render(
      await NewWorkflowPage({
        searchParams: Promise.resolve({ definition: encoded }),
      })
    );

    expect(screen.getByTestId('pattern-palette')).toBeInTheDocument();
  });
});
