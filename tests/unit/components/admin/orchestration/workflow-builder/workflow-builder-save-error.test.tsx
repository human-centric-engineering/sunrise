// @vitest-environment happy-dom

/**
 * WorkflowBuilder — failed discard (§124)
 *
 * A discard-draft the server refused for any reason but staleness was only
 * logged. It now shows in the save box under the toolbar, and takes focus.
 *
 * @see components/admin/orchestration/workflow-builder/workflow-builder.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';

vi.mock('@xyflow/react', () => ({
  ReactFlow: () => <div data-testid="rf-canvas" />,
  ReactFlowProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  useReactFlow: vi.fn(() => ({
    screenToFlowPosition: vi.fn((p: unknown) => p),
    setCenter: vi.fn(),
    getNode: vi.fn(),
  })),
  useNodesState: vi.fn((initial: unknown[]) => [initial, vi.fn(), vi.fn()]),
  useEdgesState: vi.fn((initial: unknown[]) => [initial, vi.fn(), vi.fn()]),
  addEdge: vi.fn((edge: unknown, edges: unknown[]) => [...edges, edge]),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/components/admin/orchestration/workflow-definition-history-panel', () => ({
  WorkflowDefinitionHistoryPanel: () => null,
}));
vi.mock('@/components/admin/orchestration/workflow-builder/workflow-canvas', () => ({
  WorkflowCanvas: () => <div data-testid="workflow-canvas" />,
}));
vi.mock('@/components/admin/orchestration/workflow-builder/use-workflow-cost-estimate', () => ({
  useWorkflowCostEstimate: vi.fn(() => ({ estimate: null, loading: false, error: null })),
}));

// The real APIClientError, so the builder reads the error as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

import { WorkflowBuilder } from '@/components/admin/orchestration/workflow-builder/workflow-builder';
import type { AiWorkflowWithVersion, WorkflowDefinition } from '@/types/orchestration';

const DEFINITION: WorkflowDefinition = {
  entryStepId: 'step-1',
  errorStrategy: 'fail',
  steps: [{ id: 'step-1', name: 'First Step', type: 'chain', config: {}, nextSteps: [] }],
};

const WORKFLOW = {
  id: 'wf-1',
  name: 'Test Workflow',
  slug: 'test-workflow',
  description: null,
  draftDefinition: DEFINITION,
  publishedVersionId: 'wfv-1',
  publishedVersion: {
    id: 'wfv-1',
    orgId: null,
    workflowId: 'wf-1',
    version: 1,
    snapshot: DEFINITION,
    changeSummary: null,
    createdBy: 'user-1',
    createdAt: new Date('2025-01-01'),
  },
  definitionVersion: '"v-loaded"',
  patternsUsed: [],
  isActive: true,
  isTemplate: false,
  isSystem: false,
  templateSource: null,
  metadata: null,
  createdBy: 'user-1',
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
} as unknown as AiWorkflowWithVersion;

describe('WorkflowBuilder — failed discard', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true)
    );
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => {}));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a refused discard under the toolbar, and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Workflow has no published version to fall back to', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<WorkflowBuilder mode="edit" workflow={WORKFLOW} />);

    await user.click(screen.getByRole('button', { name: /discard draft/i }));

    const alert = await screen.findByRole('alert');
    // The box serves save, save as template and discard, so it names the action.
    expect(alert).toHaveTextContent(
      "Couldn't discard the draft: Workflow has no published version to fall back to"
    );
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('words a discard the server said nothing about as the hook does: the action, then "Try again."', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(new TypeError('Failed to fetch'));
    const user = userEvent.setup();
    render(<WorkflowBuilder mode="edit" workflow={WORKFLOW} />);

    await user.click(screen.getByRole('button', { name: /discard draft/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /^Couldn't discard the draft\. Try again\.$/
    );
  });
});
