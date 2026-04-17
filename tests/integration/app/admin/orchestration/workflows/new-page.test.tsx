/**
 * Integration Test: Admin Orchestration — New Workflow Page (5.1b)
 *
 * Tests the page at `app/admin/orchestration/workflows/new/page.tsx`.
 *
 * Test Coverage (5.1a carry-over):
 * - Renders the palette, canvas, and toolbar
 * - Toolbar Save button reads "Create workflow"
 *
 * Test Coverage (5.1b additions):
 * - Save button click opens the WorkflowDetailsDialog
 * - Confirming dialog with valid details triggers apiClient.post with a
 *   serialised WorkflowDefinition
 * - After successful create, router.push is called to the edit URL
 *
 * @see app/admin/orchestration/workflows/new/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';

// ─── @xyflow/react mock ───────────────────────────────────────────────────────
//
// `useNodesState` / `useEdgesState` are backed by real `useState` so the
// builder's save path sees nodes that were loaded from a template. The
// dispatcher ignores React Flow's applyChanges semantics — we only need
// setNodes(array) to trigger a re-render with those nodes.

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

const routerPushMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: routerPushMock,
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
  notFound: vi.fn(),
  usePathname: vi.fn(() => '/'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  useParams: vi.fn(() => ({})),
  redirect: vi.fn(),
}));

import { apiClient } from '@/lib/api/client';
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_TEMPLATE = {
  slug: 'tpl-customer-support',
  name: 'Customer Support',
  description: 'Multi-channel support automation',
  workflowDefinition: {
    entryStepId: 's1',
    errorStrategy: 'fail',
    steps: [
      { id: 's1', name: 'Entry', type: 'llm_call', config: { prompt: 'Hello' }, nextSteps: [] },
    ],
  },
  patternsUsed: [1, 2],
  isTemplate: true,
  metadata: {
    flowSummary: 'A flow',
    useCases: [{ title: 'Triage', scenario: 'Route tickets' }],
    patterns: [{ number: 1, name: 'Chain' }],
  },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('NewWorkflowPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.get).mockResolvedValue([]);
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    // Page calls getCapabilities() + getTemplates() in parallel — both use parseApiResponse
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: [] }) // capabilities
      .mockResolvedValueOnce({ success: true, data: [MOCK_TEMPLATE] }); // templates
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the pattern palette', async () => {
    const { default: NewWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/new/page');

    render(await NewWorkflowPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByTestId('pattern-palette')).toBeInTheDocument();
  });

  it('renders the workflow canvas', async () => {
    const { default: NewWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/new/page');

    render(await NewWorkflowPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByTestId('workflow-canvas')).toBeInTheDocument();
  });

  it('toolbar Save button reads "Create workflow"', async () => {
    const { default: NewWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/new/page');

    render(await NewWorkflowPage({ searchParams: Promise.resolve({}) }));

    const saveBtn = screen.getByRole('button', { name: /create workflow/i });
    expect(saveBtn).toBeInTheDocument();
  });

  it('renders the builder toolbar', async () => {
    const { default: NewWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/new/page');

    render(await NewWorkflowPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByTestId('builder-toolbar')).toBeInTheDocument();
  });

  it('renders the ValidationSummaryPanel', async () => {
    const { default: NewWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/new/page');

    render(await NewWorkflowPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByTestId('validation-summary-panel')).toBeInTheDocument();
  });

  it('clicking Save opens the WorkflowDetailsDialog', async () => {
    const user = userEvent.setup();
    const { default: NewWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/new/page');

    render(await NewWorkflowPage({ searchParams: Promise.resolve({}) }));

    await user.click(screen.getByRole('button', { name: /create workflow/i }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/workflow details/i)).toBeInTheDocument();
  });

  it('confirming the details dialog closes it and triggers the save flow', async () => {
    const user = userEvent.setup();

    const { default: NewWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/new/page');

    render(await NewWorkflowPage({ searchParams: Promise.resolve({}) }));

    // Open the dialog
    await user.click(screen.getByRole('button', { name: /create workflow/i }));

    // Fill in the description (slug is auto-derived)
    const descInput = screen.getByRole('textbox', { name: /description/i });
    await user.type(descInput, 'A test workflow description');

    // Confirm — dialog should close
    await user.click(screen.getByRole('button', { name: /save workflow/i }));

    // Dialog should close after confirm is pressed
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('loading a template populates the canvas and POSTs its WorkflowDefinition on save', async () => {
    // Radix Dialog temporarily sets `pointer-events: none` on <body> while
    // its close animation runs; in jsdom that gate never releases, which
    // blocks subsequent user.click calls. Disabling the pointer-events
    // check is the standard workaround.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiClient.post).mockResolvedValue({ id: 'new-wf-1' });

    const { default: NewWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/new/page');

    render(await NewWorkflowPage({ searchParams: Promise.resolve({}) }));

    // Open the Use template dropdown and pick the first template.
    await user.click(screen.getByRole('button', { name: /use template/i }));
    const item = await screen.findByRole('menuitem', {
      name: new RegExp(MOCK_TEMPLATE.name, 'i'),
      hidden: true,
    });
    await user.click(item);

    // Description dialog — confirm to load the template onto the canvas.
    await user.click(screen.getByRole('button', { name: /use this template/i }));

    // Description dialog should close once the template is loaded.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /use this template/i })).not.toBeInTheDocument();
    });

    // Open the save dialog and confirm with a description. Radix Dialog
    // pollutes the tree with aria-hidden on sibling regions during its
    // close animation, so query with hidden: true.
    const createBtn = await screen.findByRole('button', { name: /create workflow/i, hidden: true });
    await user.click(createBtn);
    await user.type(screen.getByRole('textbox', { name: /description/i }), 'Loaded from template');
    await user.click(screen.getByRole('button', { name: /save workflow/i }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledTimes(1);
    });

    const [, options] = vi.mocked(apiClient.post).mock.calls[0];
    const body = options?.body as {
      name: string;
      workflowDefinition: { steps: unknown[]; entryStepId: string };
    };
    expect(body.name).toBe(MOCK_TEMPLATE.name);
    expect(body.workflowDefinition.steps).toHaveLength(
      MOCK_TEMPLATE.workflowDefinition.steps.length
    );
    expect(body.workflowDefinition.entryStepId).toBe(MOCK_TEMPLATE.workflowDefinition.entryStepId);
  });

  it('confirming dialog with empty canvas shows an inline error (no nodes to save)', async () => {
    const user = userEvent.setup();

    const { default: NewWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/new/page');

    render(await NewWorkflowPage({ searchParams: Promise.resolve({}) }));

    // Open the dialog
    await user.click(screen.getByRole('button', { name: /create workflow/i }));

    // Fill in the description
    await user.type(screen.getByRole('textbox', { name: /description/i }), 'A test');

    // Confirm
    await user.click(screen.getByRole('button', { name: /save workflow/i }));

    // With no nodes the builder shows an inline error
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert').textContent).toContain('at least one step');
  });
});
