// @vitest-environment happy-dom

/**
 * Unit Tests: NewRunPage
 * (app/admin/orchestration/evaluations/runs/new/page.tsx)
 *
 * The form reads each empty option list as "none exist" ("No agents
 * available. Create an agent first.", "No published workflows…", "No
 * datasets available…", "No custom judges yet…"). So every one of the four
 * loads is main data: any failure throws ServerLoadError to the error
 * boundary rather than reaching the form (#518).
 *
 * @see app/admin/orchestration/evaluations/runs/new/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { apiFailure, apiSuccess } from '@/tests/helpers/api';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

interface FormProps {
  agents: unknown[];
  workflows: Array<{ id: string; steps: unknown[] }>;
  datasets: unknown[];
  heuristicGraders: unknown[];
  judgeAgents: unknown[];
}

vi.mock('@/components/admin/orchestration/evaluations-foundations/run-create-form', () => ({
  RunCreateForm: (props: FormProps) => (
    <div
      data-testid="run-create-form"
      data-agents={String(props.agents.length)}
      data-workflows={props.workflows.map((w) => `${w.id}:${w.steps.length}`).join(',')}
      data-datasets={String(props.datasets.length)}
      data-heuristics={String(props.heuristicGraders.length)}
      data-judges={String(props.judgeAgents.length)}
    />
  ),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import NewRunPage from '@/app/admin/orchestration/evaluations/runs/new/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

type Answer = () => Promise<Response>;
type Source = 'agents' | 'workflows' | 'datasets' | 'graders';

const ok =
  (data: unknown): Answer =>
  () =>
    Promise.resolve(apiSuccess(data));

const DEFAULTS: Record<Source, Answer> = {
  agents: ok([{ id: 'a1', name: 'Bot', slug: 'bot' }]),
  workflows: ok([
    {
      id: 'w1',
      name: 'Published',
      slug: 'published',
      isActive: true,
      publishedVersion: {
        id: 'v1',
        version: 1,
        snapshot: { steps: [{ id: 's1', name: 'Step one', type: 'llm_call' }] },
      },
    },
    // Draft-only: filtered out of the picker.
    { id: 'w2', name: 'Draft', slug: 'draft', isActive: true, publishedVersion: null },
  ]),
  datasets: ok([{ id: 'd1', name: 'Set', caseCount: 3 }]),
  graders: ok({
    heuristicGraders: [{ slug: 'exact_match' }],
    judgeAgents: [{ slug: 'judge' }, { slug: 'judge-2' }],
  }),
};

function sourceOf(url: string): Source {
  if (url.includes('/graders')) return 'graders';
  if (url.includes('/workflows')) return 'workflows';
  if (url.includes('/agents')) return 'agents';
  return 'datasets';
}

/** Route the page's four parallel loads by URL; override any one of them. */
function wireFetches(overrides: Partial<Record<Source, Answer>> = {}): void {
  const answers = { ...DEFAULTS, ...overrides };
  vi.mocked(serverFetch).mockImplementation((url: string) => answers[sourceOf(url)]());
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('NewRunPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hands every option list to the form', async () => {
    wireFetches();

    render(await NewRunPage());

    const form = screen.getByTestId('run-create-form');
    expect(form).toHaveAttribute('data-agents', '1');
    // Only the published workflow, with its one step extracted.
    expect(form).toHaveAttribute('data-workflows', 'w1:1');
    expect(form).toHaveAttribute('data-datasets', '1');
    expect(form).toHaveAttribute('data-heuristics', '1');
    expect(form).toHaveAttribute('data-judges', '2');
    expect(vi.mocked(serverFetch)).toHaveBeenCalledTimes(4);
  });

  it('hands real empty lists to the form', async () => {
    wireFetches({
      agents: ok([]),
      workflows: ok([]),
      datasets: ok([]),
      graders: ok({ heuristicGraders: [], judgeAgents: [] }),
    });

    render(await NewRunPage());

    const form = screen.getByTestId('run-create-form');
    expect(form).toHaveAttribute('data-agents', '0');
    expect(form).toHaveAttribute('data-datasets', '0');
  });

  it.each<Source>(['agents', 'workflows', 'datasets', 'graders'])(
    'throws to the error boundary when the %s load fails',
    async (source) => {
      wireFetches({ [source]: () => Promise.resolve(apiFailure(500)) });

      await expect(NewRunPage()).rejects.toBeInstanceOf(ServerLoadError);
    }
  );

  it('throws to the error boundary when a fetch rejects', async () => {
    wireFetches({ datasets: () => Promise.reject(new Error('Network down')) });

    await expect(NewRunPage()).rejects.toBeInstanceOf(ServerLoadError);
  });
});
