/**
 * Integration Test: Admin Orchestration — New Workflow Page
 *
 * Tests the page at `app/admin/orchestration/workflows/new/page.tsx`.
 *
 * Test Coverage:
 * - Renders the palette and canvas
 * - Toolbar Save button reads "Create workflow" and is disabled
 *
 * @see app/admin/orchestration/workflows/new/page.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
  })),
  useNodesState: vi.fn((initial: unknown[]) => [initial, vi.fn(), vi.fn()]),
  useEdgesState: vi.fn((initial: unknown[]) => [initial, vi.fn(), vi.fn()]),
  addEdge: vi.fn((edge: unknown, edges: unknown[]) => [...edges, edge]),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('NewWorkflowPage', () => {
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

  it('toolbar Save button reads "Create workflow" and is disabled', async () => {
    const { default: NewWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/new/page');

    render(<NewWorkflowPage />);

    const saveBtn = screen.getByRole('button', { name: /create workflow/i });
    expect(saveBtn).toBeInTheDocument();
    expect(saveBtn).toBeDisabled();
  });

  it('renders the builder toolbar', async () => {
    const { default: NewWorkflowPage } =
      await import('@/app/admin/orchestration/workflows/new/page');

    render(<NewWorkflowPage />);

    expect(screen.getByTestId('builder-toolbar')).toBeInTheDocument();
  });
});
