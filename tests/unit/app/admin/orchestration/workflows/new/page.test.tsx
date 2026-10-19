// @vitest-environment happy-dom

/**
 * Unit Tests: NewWorkflowPage
 *
 * Tests the admin "New Workflow" server component page at
 * `app/admin/orchestration/workflows/new/page.tsx`.
 *
 * Branch coverage targets:
 * - each option list (capabilities, agents, templates) is secondary: a failed
 *   load (5xx, success:false, no response, unparseable templates) renders a
 *   `role="alert"` notice naming that list above the builder, which still
 *   renders with that list empty — never a silent empty picker (#518)
 * - searchParams.definition: valid JSON → pre-populated builder; invalid JSON → empty builder
 * - searchParams.definition: valid JSON but bad schema → empty builder
 * - No auth-redirect test: per gotcha #21, auth guard lives in the admin layout, not this page.
 *
 * @see app/admin/orchestration/workflows/new/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

// LoadFailedNotice's "Try again" calls router.refresh().
vi.mock('next/navigation', () => ({
  unstable_rethrow: vi.fn(),
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// Stub WorkflowBuilder — server component renders it with specific props
vi.mock('@/components/admin/orchestration/workflow-builder/workflow-builder', () => ({
  WorkflowBuilder: (props: {
    mode: string;
    initialDefinition?: unknown;
    initialCapabilities?: unknown[];
    initialAgents?: unknown[];
    initialTemplates?: unknown[];
  }) => (
    <div
      data-testid="workflow-builder"
      data-mode={props.mode}
      data-has-definition={props.initialDefinition !== undefined ? 'true' : 'false'}
      data-capabilities-count={String(props.initialCapabilities?.length ?? 0)}
      data-agents-count={String(props.initialAgents?.length ?? 0)}
      data-templates-count={String(props.initialTemplates?.length ?? 0)}
    />
  ),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────────

import NewWorkflowPage from '@/app/admin/orchestration/workflows/new/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { API } from '@/lib/api/endpoints';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';

// ─── Helpers ─────────────────────────────────────────────────────────────────

type Endpoint = 'capabilities' | 'agents' | 'templates';

/**
 * Answer each endpoint the page reads with a fresh Response per call; every
 * list is empty unless overridden. An override may throw to simulate no
 * response.
 */
function routeFetch(overrides: Partial<Record<Endpoint, () => Response>> = {}) {
  const answers: Record<Endpoint, () => Response> = {
    capabilities: () => apiSuccess([]),
    agents: () => apiSuccess([]),
    templates: () => apiSuccess([]),
    ...overrides,
  };
  vi.mocked(serverFetch).mockImplementation(async (url: string) => {
    if (url.startsWith(API.ADMIN.ORCHESTRATION.CAPABILITIES)) return answers.capabilities();
    if (url.startsWith(API.ADMIN.ORCHESTRATION.AGENTS)) return answers.agents();
    if (url.startsWith(API.ADMIN.ORCHESTRATION.WORKFLOW_TEMPLATES)) return answers.templates();
    throw new Error(`Unexpected URL: ${url}`);
  });
}

const TEMPLATE_ENTRIES = [
  {
    source: 'builtin',
    slug: 'tpl-a',
    name: 'A',
    description: 'a',
    workflowDefinition: { steps: [], entryStepId: 's1', errorStrategy: 'fail' },
    patternsUsed: [1],
    metadata: null,
  },
  {
    source: 'custom',
    slug: 'mine',
    name: 'Mine',
    description: 'm',
    workflowDefinition: null,
    patternsUsed: [],
    metadata: null,
  },
];

/** Minimal valid WorkflowDefinition that satisfies the workflowDefinitionSchema. */
const VALID_DEFINITION = {
  steps: [
    {
      id: 'step-1',
      name: 'First step',
      type: 'llm_call' as const,
      config: {},
      nextSteps: [],
    },
  ],
  entryStepId: 'step-1',
  errorStrategy: 'fail' as const,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('NewWorkflowPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Mode ─────────────────────────────────────────────────────────────────

  it('renders WorkflowBuilder in create mode', async () => {
    routeFetch();

    render(await NewWorkflowPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByTestId('workflow-builder')).toHaveAttribute('data-mode', 'create');
  });

  it('shows no load-failure notice when every list loads, even when they are empty', async () => {
    routeFetch();

    render(await NewWorkflowPage({ searchParams: Promise.resolve({}) }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // ── getCapabilities ───────────────────────────────────────────────────────

  describe('getCapabilities', () => {
    it('passes capabilities when fetch succeeds', async () => {
      routeFetch({
        capabilities: () =>
          apiSuccess([
            { id: 'cap-1', name: 'Search' },
            { id: 'cap-2', name: 'Lookup' },
          ]),
      });

      render(await NewWorkflowPage({ searchParams: Promise.resolve({}) }));

      expect(screen.getByTestId('workflow-builder')).toHaveAttribute(
        'data-capabilities-count',
        '2'
      );
    });

    it('shows a notice naming capabilities, and still renders the builder, when the API answers 500', async () => {
      routeFetch({ capabilities: () => apiFailure(500) });

      render(await NewWorkflowPage({ searchParams: Promise.resolve({}) }));

      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent(/couldn.t load capabilities/i);
      expect(screen.getAllByRole('alert')).toHaveLength(1);
      expect(screen.getByTestId('workflow-builder')).toHaveAttribute(
        'data-capabilities-count',
        '0'
      );
    });

    it('logs and shows the notice when the capabilities fetch rejects', async () => {
      const fetchErr = new Error('Network failure');
      routeFetch({
        capabilities: () => {
          throw fetchErr;
        },
      });

      render(await NewWorkflowPage({ searchParams: Promise.resolve({}) }));

      expect(logger.error).toHaveBeenCalledWith(expect.any(String), fetchErr, expect.any(Object));
      expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load capabilities/i);
    });
  });

  // ── getAgents ─────────────────────────────────────────────────────────────

  describe('getAgents', () => {
    it('passes agents when fetch succeeds', async () => {
      routeFetch({
        agents: () => apiSuccess([{ slug: 'support-bot', name: 'Support Bot', description: null }]),
      });

      render(await NewWorkflowPage({ searchParams: Promise.resolve({}) }));

      expect(screen.getByTestId('workflow-builder')).toHaveAttribute('data-agents-count', '1');
    });

    it('shows a notice naming agents when the API answers success:false', async () => {
      routeFetch({ agents: () => apiFailure(200) });

      render(await NewWorkflowPage({ searchParams: Promise.resolve({}) }));

      expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load agents/i);
      expect(screen.getByTestId('workflow-builder')).toHaveAttribute('data-agents-count', '0');
    });
  });

  // ── getTemplates ──────────────────────────────────────────────────────────

  describe('getTemplates', () => {
    it('forwards each catalogue entry to the builder as a template', async () => {
      routeFetch({ templates: () => apiSuccess(TEMPLATE_ENTRIES) });

      render(await NewWorkflowPage({ searchParams: Promise.resolve({}) }));

      expect(screen.getByTestId('workflow-builder')).toHaveAttribute('data-templates-count', '2');
    });

    it('shows a notice naming templates when the API answers 500', async () => {
      routeFetch({ templates: () => apiFailure(500) });

      render(await NewWorkflowPage({ searchParams: Promise.resolve({}) }));

      expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load workflow templates/i);
      expect(screen.getByTestId('workflow-builder')).toHaveAttribute('data-templates-count', '0');
    });

    it('logs and shows the notice when the response fails templateCatalogueSchema', async () => {
      routeFetch({ templates: () => apiSuccess([{ not: 'a-template' }]) });

      render(await NewWorkflowPage({ searchParams: Promise.resolve({}) }));

      expect(logger.warn).toHaveBeenCalledWith(
        'new workflow page: templates response did not parse',
        expect.objectContaining({ issues: expect.any(Array) })
      );
      expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load workflow templates/i);
      expect(screen.getByTestId('workflow-builder')).toHaveAttribute('data-templates-count', '0');
    });
  });

  it('shows one notice per failed list when everything fails', async () => {
    vi.mocked(serverFetch).mockRejectedValue(new Error('total network failure'));

    render(await NewWorkflowPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getAllByRole('alert')).toHaveLength(3);
    expect(screen.getByTestId('workflow-builder')).toBeInTheDocument();
  });

  // ── searchParams.definition branch ───────────────────────────────────────

  describe('searchParams.definition', () => {
    beforeEach(() => {
      routeFetch();
    });

    it('does not pre-populate builder when definition param is absent', async () => {
      render(await NewWorkflowPage({ searchParams: Promise.resolve({}) }));

      expect(screen.getByTestId('workflow-builder')).toHaveAttribute(
        'data-has-definition',
        'false'
      );
    });

    it('pre-populates builder when definition param is a valid encoded WorkflowDefinition', async () => {
      const encoded = encodeURIComponent(JSON.stringify(VALID_DEFINITION));

      render(await NewWorkflowPage({ searchParams: Promise.resolve({ definition: encoded }) }));

      expect(screen.getByTestId('workflow-builder')).toHaveAttribute('data-has-definition', 'true');
    });

    it('falls through to empty builder when definition param is malformed JSON', async () => {
      render(
        await NewWorkflowPage({
          searchParams: Promise.resolve({ definition: '%7Bnot-valid-json%7D' }),
        })
      );

      // JSON.parse fails → catch block → initialDefinition stays undefined
      expect(screen.getByTestId('workflow-builder')).toHaveAttribute(
        'data-has-definition',
        'false'
      );
    });

    it('falls through to empty builder when definition param is valid JSON but fails schema', async () => {
      const encoded = encodeURIComponent(JSON.stringify({ unknown_field: true }));

      render(await NewWorkflowPage({ searchParams: Promise.resolve({ definition: encoded }) }));

      // safeParse fails → initialDefinition stays undefined
      expect(screen.getByTestId('workflow-builder')).toHaveAttribute(
        'data-has-definition',
        'false'
      );
    });
  });

  // ── serverFetch endpoint verification ────────────────────────────────────

  describe('serverFetch endpoint calls', () => {
    it('reads capabilities, active agents and the templates catalogue', async () => {
      routeFetch();

      await NewWorkflowPage({ searchParams: Promise.resolve({}) });

      const urls = vi.mocked(serverFetch).mock.calls.map(([url]) => url);
      expect(urls).toEqual(
        expect.arrayContaining([
          `${API.ADMIN.ORCHESTRATION.CAPABILITIES}?limit=100`,
          `${API.ADMIN.ORCHESTRATION.AGENTS}?limit=100&isActive=true`,
          API.ADMIN.ORCHESTRATION.WORKFLOW_TEMPLATES,
        ])
      );
      // Not the old template rows: the built-ins are no longer rows.
      expect(urls.some((url) => url.includes('isTemplate=true'))).toBe(false);
    });
  });
});
