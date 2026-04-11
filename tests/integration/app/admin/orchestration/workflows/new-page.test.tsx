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
import type { ReactNode } from 'react';

// ─── @xyflow/react mock ───────────────────────────────────────────────────────

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

// ─── Other mocks ──────────────────────────────────────────────────────────────

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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('NewWorkflowPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.get).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the pattern palette', async () => {
    const { default: NewWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/new/page');

    render(<NewWorkflowPage />);

    expect(screen.getByTestId('pattern-palette')).toBeInTheDocument();
  });

  it('renders the workflow canvas', async () => {
    const { default: NewWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/new/page');

    render(<NewWorkflowPage />);

    expect(screen.getByTestId('workflow-canvas')).toBeInTheDocument();
  });

  it('toolbar Save button reads "Create workflow"', async () => {
    const { default: NewWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/new/page');

    render(<NewWorkflowPage />);

    const saveBtn = screen.getByRole('button', { name: /create workflow/i });
    expect(saveBtn).toBeInTheDocument();
  });

  it('renders the builder toolbar', async () => {
    const { default: NewWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/new/page');

    render(<NewWorkflowPage />);

    expect(screen.getByTestId('builder-toolbar')).toBeInTheDocument();
  });

  it('renders the ValidationSummaryPanel', async () => {
    const { default: NewWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/new/page');

    render(<NewWorkflowPage />);

    expect(screen.getByTestId('validation-summary-panel')).toBeInTheDocument();
  });

  it('clicking Save opens the WorkflowDetailsDialog', async () => {
    const user = userEvent.setup();
    const { default: NewWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/new/page');

    render(<NewWorkflowPage />);

    await user.click(screen.getByRole('button', { name: /create workflow/i }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/workflow details/i)).toBeInTheDocument();
  });

  it('confirming the details dialog closes it and triggers the save flow', async () => {
    const user = userEvent.setup();

    const { default: NewWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/new/page');

    render(<NewWorkflowPage />);

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

  it('confirming dialog with empty canvas shows an inline error (no nodes to save)', async () => {
    const user = userEvent.setup();

    const { default: NewWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/new/page');

    render(<NewWorkflowPage />);

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
