// @vitest-environment happy-dom

/**
 * Unit Tests: EditWorkflowPage (app/admin/orchestration/workflows/[id]/page.tsx)
 *
 * Branch coverage targets:
 * - getWorkflow: a 404 → notFound(); any other failure (5xx, success:false,
 *   no response) throws ServerLoadError and does NOT call notFound() (#518)
 * - each option list (capabilities, agents, templates) is secondary: a failed
 *   load renders a `role="alert"` notice naming it above the builder, which
 *   still renders with that list empty
 * - workflow found → builder rendered in edit mode, WorkflowSchedulesTab rendered
 * - No auth-redirect test: per gotcha #21, auth guard lives in the admin layout.
 *
 * @see app/admin/orchestration/workflows/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  unstable_rethrow: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  useSearchParams: () => ({ get: () => null }),
  // LoadFailedNotice's "Try again" calls router.refresh().
  useRouter: () => ({ refresh: vi.fn() }),
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
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { logger } from '@/lib/logging';
import { notFound } from 'next/navigation';
import { API } from '@/lib/api/endpoints';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

type Endpoint = 'workflow' | 'capabilities' | 'agents' | 'templates';

/**
 * Answer each endpoint the page reads with a fresh Response per call. The
 * workflow defaults to `createMockWorkflow()`, every list to empty. An
 * override may throw to simulate no response.
 */
function routeFetch(overrides: Partial<Record<Endpoint, () => Response>> = {}) {
  const answers: Record<Endpoint, () => Response> = {
    workflow: () => apiSuccess(createMockWorkflow()),
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

describe('EditWorkflowPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── notFound only on a 404 (#518) ─────────────────────────────────────────

  describe('loading the workflow', () => {
    it('calls notFound when the workflow does not exist', async () => {
      routeFetch({ workflow: () => apiFailure(404, 'NOT_FOUND') });

      await expect(
        EditWorkflowPage({ params: Promise.resolve({ id: 'wf-missing' }) })
      ).rejects.toThrow('NEXT_NOT_FOUND');
      expect(notFound).toHaveBeenCalledOnce();
    });

    it('throws to the error boundary, not notFound(), when the API answers 500', async () => {
      routeFetch({ workflow: () => apiFailure(500) });

      await expect(
        EditWorkflowPage({ params: Promise.resolve({ id: 'wf-123' }) })
      ).rejects.toBeInstanceOf(ServerLoadError);
      expect(notFound).not.toHaveBeenCalled();
    });

    it('throws, not notFound(), when the API answers success:false', async () => {
      routeFetch({ workflow: () => apiFailure(200) });

      await expect(
        EditWorkflowPage({ params: Promise.resolve({ id: 'wf-123' }) })
      ).rejects.toBeInstanceOf(ServerLoadError);
      expect(notFound).not.toHaveBeenCalled();
    });

    it('logs and throws, not notFound(), when the workflow fetch rejects', async () => {
      const fetchErr = new Error('Network failure');
      routeFetch({
        workflow: () => {
          throw fetchErr;
        },
      });

      await expect(
        EditWorkflowPage({ params: Promise.resolve({ id: 'wf-123' }) })
      ).rejects.toBeInstanceOf(ServerLoadError);
      expect(notFound).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(expect.any(String), fetchErr, {
        path: API.ADMIN.ORCHESTRATION.workflowById('wf-123'),
      });
    });
  });

  // ── Happy path rendering ───────────────────────────────────────────────────

  describe('happy path rendering', () => {
    it('renders WorkflowBuilder in edit mode, with no notice, when workflow is found', async () => {
      routeFetch({ workflow: () => apiSuccess(createMockWorkflow('wf-123', 'My Workflow')) });

      render(await EditWorkflowPage({ params: Promise.resolve({ id: 'wf-123' }) }));

      const builder = screen.getByTestId('workflow-builder');
      expect(builder).toHaveAttribute('data-mode', 'edit');
      expect(builder).toHaveAttribute('data-workflow-id', 'wf-123');
      expect(builder).toHaveAttribute('data-workflow-name', 'My Workflow');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('renders WorkflowSchedulesTab with the workflow id', async () => {
      routeFetch({ workflow: () => apiSuccess(createMockWorkflow('wf-456')) });

      render(await EditWorkflowPage({ params: Promise.resolve({ id: 'wf-456' }) }));

      expect(screen.getByTestId('schedules-tab')).toHaveAttribute('data-workflow-id', 'wf-456');
    });
  });

  // ── Option lists are secondary ────────────────────────────────────────────

  describe('option lists', () => {
    it('shows a notice naming capabilities, and still renders the builder, when they fail', async () => {
      routeFetch({ capabilities: () => apiFailure(500) });

      render(await EditWorkflowPage({ params: Promise.resolve({ id: 'wf-123' }) }));

      expect(screen.getAllByRole('alert')).toHaveLength(1);
      expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load capabilities/i);
      expect(screen.getByTestId('workflow-builder')).toHaveAttribute(
        'data-capabilities-count',
        '0'
      );
    });

    it('logs and shows a notice naming agents when the agents fetch rejects', async () => {
      const agentsErr = new Error('Agents failed');
      routeFetch({
        agents: () => {
          throw agentsErr;
        },
      });

      render(await EditWorkflowPage({ params: Promise.resolve({ id: 'wf-123' }) }));

      expect(logger.error).toHaveBeenCalledWith(expect.any(String), agentsErr, expect.any(Object));
      expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load agents/i);
      expect(screen.getByTestId('workflow-builder')).toHaveAttribute('data-agents-count', '0');
    });

    it('logs and shows a notice naming templates when the response fails templateCatalogueSchema', async () => {
      routeFetch({ templates: () => apiSuccess([{ not: 'a-template' }]) });

      render(await EditWorkflowPage({ params: Promise.resolve({ id: 'wf-123' }) }));

      expect(logger.warn).toHaveBeenCalledWith(
        'edit workflow page: templates response did not parse',
        expect.objectContaining({ issues: expect.any(Array) })
      );
      expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load workflow templates/i);
      expect(screen.getByTestId('workflow-builder')).toHaveAttribute('data-templates-count', '0');
    });
  });

  // ── serverFetch endpoint verification ─────────────────────────────────────

  describe('serverFetch endpoint calls', () => {
    it('reads the workflow by the route id, and the templates catalogue', async () => {
      routeFetch();

      await EditWorkflowPage({ params: Promise.resolve({ id: 'wf-abc' }) });

      const urls = vi.mocked(serverFetch).mock.calls.map(([url]) => url);
      expect(urls).toContain(API.ADMIN.ORCHESTRATION.workflowById('wf-abc'));
      expect(urls).toContain(API.ADMIN.ORCHESTRATION.WORKFLOW_TEMPLATES);
      expect(urls.some((url) => url.includes('isTemplate=true'))).toBe(false);
    });
  });
});
