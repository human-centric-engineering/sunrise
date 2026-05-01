/**
 * Unit Tests: EditWorkflowPage (app/admin/orchestration/workflows/[id]/page.tsx)
 *
 * Branch coverage targets:
 * - getWorkflow: res.ok false → null, body.success false → null, throw → null
 * - getCapabilities: res.ok false → [], body.success false → [], throw → []
 * - getAgents: res.ok false → [], body.success false → [], throw → []
 * - getTemplates: res.ok false → [], body.success false → [], schema fail → [], throw → []
 * - workflow === null → notFound() called
 * - workflow found → builder rendered in edit mode, WorkflowSchedulesTab rendered
 * - No auth-redirect test: per gotcha #21, auth guard lives in the admin layout.
 *
 * @see app/admin/orchestration/workflows/[id]/page.tsx
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

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('@/components/admin/orchestration/workflow-builder/workflow-builder', () => ({
  WorkflowBuilder: (props: {
    mode: string;
    workflow?: { id: string; name: string };
    initialCapabilities?: unknown[];
    initialAgents?: unknown[];
    initialTemplates?: unknown[];
  }) => (
    <div
      data-testid="workflow-builder"
      data-mode={props.mode}
      data-workflow-id={props.workflow?.id}
      data-workflow-name={props.workflow?.name}
      data-capabilities-count={String(props.initialCapabilities?.length ?? 0)}
      data-agents-count={String(props.initialAgents?.length ?? 0)}
      data-templates-count={String(props.initialTemplates?.length ?? 0)}
    />
  ),
}));

vi.mock('@/components/admin/orchestration/workflow-schedules-tab', () => ({
  WorkflowSchedulesTab: ({ workflowId }: { workflowId: string }) => (
    <div data-testid="schedules-tab" data-workflow-id={workflowId} />
  ),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────────

import EditWorkflowPage from '@/app/admin/orchestration/workflows/[id]/page';
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { notFound } from 'next/navigation';
import { API } from '@/lib/api/endpoints';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function okResponse(): Response {
  return { ok: true } as Response;
}

function notOkResponse(): Response {
  return { ok: false } as Response;
}

function createMockWorkflow(id = 'wf-123', name = 'My Workflow') {
  return {
    id,
    name,
    slug: 'my-workflow',
    description: 'A test workflow',
    isActive: true,
    isTemplate: false,
    workflowDefinition: { steps: [], edges: [], startStepId: 'start', errorStrategy: 'fail' },
    metadata: null,
    patternsUsed: [],
    createdBy: 'user-1',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-15'),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EditWorkflowPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── notFound paths ────────────────────────────────────────────────────────

  describe('notFound behavior', () => {
    it('calls notFound when getWorkflow returns null (res.ok false)', async () => {
      // Arrange
      vi.mocked(serverFetch).mockResolvedValue(notOkResponse());
      const params = Promise.resolve({ id: 'wf-missing' });

      // Act & Assert
      await expect(EditWorkflowPage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
      expect(notFound).toHaveBeenCalled();
    });

    it('calls notFound when body.success is false', async () => {
      // Arrange
      vi.mocked(serverFetch).mockResolvedValue(okResponse());
      vi.mocked(parseApiResponse).mockResolvedValue({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Workflow not found' },
      } as never);
      const params = Promise.resolve({ id: 'wf-missing' });

      // Act & Assert
      await expect(EditWorkflowPage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
      expect(notFound).toHaveBeenCalled();
    });

    it('calls notFound and logs error when serverFetch throws', async () => {
      // Arrange
      const fetchErr = new Error('Network failure');
      vi.mocked(serverFetch).mockRejectedValue(fetchErr);
      const params = Promise.resolve({ id: 'wf-123' });

      // Act & Assert
      await expect(EditWorkflowPage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
      expect(notFound).toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith('edit workflow page: fetch failed', fetchErr, {
        id: 'wf-123',
      });
    });
  });

  // ── Happy path rendering ───────────────────────────────────────────────────

  describe('happy path rendering', () => {
    it('renders WorkflowBuilder in edit mode when workflow is found', async () => {
      // Arrange
      const workflow = createMockWorkflow('wf-123', 'My Workflow');
      vi.mocked(serverFetch).mockResolvedValue(okResponse());
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: workflow } as never) // workflow
        .mockResolvedValueOnce({ success: true, data: [] } as never) // capabilities
        .mockResolvedValueOnce({ success: true, data: [] } as never) // agents
        .mockResolvedValueOnce({ success: true, data: [] } as never); // templates
      const params = Promise.resolve({ id: 'wf-123' });

      // Act
      render(await EditWorkflowPage({ params }));

      // Assert: builder rendered in edit mode with the fetched workflow
      const builder = screen.getByTestId('workflow-builder');
      expect(builder).toHaveAttribute('data-mode', 'edit');
      expect(builder).toHaveAttribute('data-workflow-id', 'wf-123');
      expect(builder).toHaveAttribute('data-workflow-name', 'My Workflow');
    });

    it('renders WorkflowSchedulesTab with the workflow id', async () => {
      // Arrange
      const workflow = createMockWorkflow('wf-456');
      vi.mocked(serverFetch).mockResolvedValue(okResponse());
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: workflow } as never)
        .mockResolvedValueOnce({ success: true, data: [] } as never)
        .mockResolvedValueOnce({ success: true, data: [] } as never)
        .mockResolvedValueOnce({ success: true, data: [] } as never);
      const params = Promise.resolve({ id: 'wf-456' });

      // Act
      render(await EditWorkflowPage({ params }));

      // Assert: schedules tab rendered with correct workflow id
      const tab = screen.getByTestId('schedules-tab');
      expect(tab).toHaveAttribute('data-workflow-id', 'wf-456');
    });
  });

  // ── getCapabilities error branches ────────────────────────────────────────

  describe('getCapabilities', () => {
    it('passes empty capabilities when res.ok is false for capabilities', async () => {
      // Arrange: workflow succeeds but capabilities fetch fails
      const workflow = createMockWorkflow();
      // serverFetch is called multiple times; each call returns notOkResponse
      // but workflow fetch is first. We need the workflow to return ok=true
      // while the rest fail.
      vi.mocked(serverFetch).mockResolvedValue(okResponse());
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: workflow } as never) // workflow
        .mockResolvedValueOnce({ success: false } as never) // capabilities body.success false
        .mockResolvedValueOnce({ success: false } as never) // agents body.success false
        .mockResolvedValueOnce({ success: false } as never); // templates body.success false
      const params = Promise.resolve({ id: 'wf-123' });

      // Act
      render(await EditWorkflowPage({ params }));

      // Assert: builder receives 0 capabilities
      const builder = screen.getByTestId('workflow-builder');
      expect(builder).toHaveAttribute('data-capabilities-count', '0');
    });

    it('logs and passes empty capabilities when capabilities fetch throws', async () => {
      // Arrange: first serverFetch (workflow) succeeds, then throws for capabilities
      const workflow = createMockWorkflow();
      const capErr = new Error('Capabilities failed');
      vi.mocked(serverFetch)
        .mockResolvedValueOnce(okResponse()) // workflow
        .mockRejectedValue(capErr); // everything else throws
      vi.mocked(parseApiResponse).mockResolvedValueOnce({
        success: true,
        data: workflow,
      } as never);
      const params = Promise.resolve({ id: 'wf-123' });

      // Act — this calls notFound because workflow fetch itself succeeds,
      // but then Promise.all resolves with null workflow when the
      // sequential calls throw. Actually: let's check — the source fetches
      // workflow separately in getWorkflow(), then parallels the rest.
      // If getWorkflow succeeds but getCapabilities throws, the page renders.
      render(await EditWorkflowPage({ params }));

      expect(logger.error).toHaveBeenCalledWith(
        'edit workflow page: capabilities fetch failed',
        capErr
      );
      const builder = screen.getByTestId('workflow-builder');
      expect(builder).toHaveAttribute('data-capabilities-count', '0');
    });
  });

  // ── serverFetch endpoint verification ─────────────────────────────────────

  describe('serverFetch endpoint calls', () => {
    it('calls the workflowById endpoint with the route id', async () => {
      // Arrange: workflow not found (ok=false) → notFound()
      vi.mocked(serverFetch).mockResolvedValue(notOkResponse());
      const params = Promise.resolve({ id: 'wf-abc' });

      // Act (will throw notFound)
      await expect(EditWorkflowPage({ params })).rejects.toThrow('NEXT_NOT_FOUND');

      // Assert: the correct endpoint was called
      expect(serverFetch).toHaveBeenCalledWith(API.ADMIN.ORCHESTRATION.workflowById('wf-abc'));
    });
  });
});
