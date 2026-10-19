// @vitest-environment happy-dom

/**
 * Integration Test: Admin Orchestration — Evaluations List Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/evaluations/page.tsx`.
 *
 * Test Coverage:
 * - Renders heading and description with valid serverFetch response
 * - Renders evaluation titles from pre-fetched data
 * - Real empty list renders the empty state
 * - A failed evaluations load throws to the error boundary (#518)
 * - A failed agents load shows a notice above the table, which still renders
 *
 * @see app/admin/orchestration/evaluations/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { apiFailure, apiSuccess } from '@/tests/helpers/api';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
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
  unstable_rethrow: vi.fn(),
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  usePathname: vi.fn(() => '/admin/orchestration/evaluations'),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeEvaluation(id: string, title: string) {
  return {
    id,
    title,
    status: 'draft',
    description: 'Test evaluation',
    agentId: 'agent-1',
    agent: { id: 'agent-1', name: 'Test Agent', slug: 'test-agent' },
    _count: { logs: 3 },
    createdAt: new Date('2025-01-01').toISOString(),
  };
}

const MOCK_EVALUATIONS = [
  makeEvaluation('eval-1', 'Tone Check'),
  makeEvaluation('eval-2', 'Safety Audit'),
];

const MOCK_META = {
  page: 1,
  limit: 25,
  total: 2,
  totalPages: 1,
};

const MOCK_AGENTS = [
  { id: 'agent-1', name: 'Test Agent' },
  { id: 'agent-2', name: 'Another Agent' },
];

/** Answer each endpoint the page calls; `agents` defaults to success. */
async function mockEndpoints(answers: {
  evaluations: () => Promise<Response>;
  agents?: () => Promise<Response>;
}): Promise<void> {
  const { serverFetch } = await import('@/lib/api/server-fetch');
  vi.mocked(serverFetch).mockImplementation((path: string) =>
    path.includes('/agents')
      ? (answers.agents ?? (() => Promise.resolve(apiSuccess(MOCK_AGENTS))))()
      : answers.evaluations()
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EvaluationsListPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders Evaluations heading and description', async () => {
    // Arrange
    await mockEndpoints({
      evaluations: () => Promise.resolve(apiSuccess(MOCK_EVALUATIONS, MOCK_META)),
    });

    // Import the page after mocks are set up
    const { default: EvaluationsListPage } =
      await import('@/app/admin/orchestration/evaluations/page');

    // Act: render server component (async)
    render(await EvaluationsListPage());

    // Assert: headings present
    expect(screen.getByRole('heading', { name: /^testing/i })).toBeInTheDocument();
    expect(
      screen.getByText(/evaluate agent quality and run a\/b experiments/i)
    ).toBeInTheDocument();
  });

  it('renders evaluation titles from pre-fetched data', async () => {
    // Arrange
    await mockEndpoints({
      evaluations: () => Promise.resolve(apiSuccess(MOCK_EVALUATIONS, MOCK_META)),
    });

    const { default: EvaluationsListPage } =
      await import('@/app/admin/orchestration/evaluations/page');

    // Act
    render(await EvaluationsListPage());

    // Assert: evaluation titles appear (via EvaluationsTable)
    await waitFor(() => {
      expect(screen.getByText('Tone Check')).toBeInTheDocument();
      expect(screen.getByText('Safety Audit')).toBeInTheDocument();
    });
  });

  it('renders the empty state when there are no evaluations', async () => {
    // Arrange
    await mockEndpoints({
      evaluations: () => Promise.resolve(apiSuccess([], { ...MOCK_META, total: 0 })),
    });

    const { default: EvaluationsListPage } =
      await import('@/app/admin/orchestration/evaluations/page');

    // Act
    render(await EvaluationsListPage());

    // Assert
    expect(screen.getByText(/no evaluations found/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('throws to the error boundary when the evaluations load fails', async () => {
    // Arrange
    const { ServerLoadError } = await import('@/lib/api/server-load');
    await mockEndpoints({ evaluations: () => Promise.resolve(apiFailure(500)) });

    const { default: EvaluationsListPage } =
      await import('@/app/admin/orchestration/evaluations/page');

    // Act + Assert: not an empty table
    await expect(EvaluationsListPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('throws to the error boundary when the evaluations fetch rejects', async () => {
    // Arrange
    const { ServerLoadError } = await import('@/lib/api/server-load');
    await mockEndpoints({ evaluations: () => Promise.reject(new Error('Network error')) });

    const { default: EvaluationsListPage } =
      await import('@/app/admin/orchestration/evaluations/page');

    // Act + Assert
    await expect(EvaluationsListPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('shows a notice when the agent filter options fail, and still renders the table', async () => {
    // Arrange
    await mockEndpoints({
      evaluations: () => Promise.resolve(apiSuccess(MOCK_EVALUATIONS, MOCK_META)),
      agents: () => Promise.resolve(apiFailure(500)),
    });

    const { default: EvaluationsListPage } =
      await import('@/app/admin/orchestration/evaluations/page');

    // Act
    render(await EvaluationsListPage());

    // Assert: the notice names what failed; the evaluations still show
    expect(screen.getByRole('alert')).toHaveTextContent(
      /couldn.t load agents for the agent filter/i
    );
    expect(screen.getByText('Tone Check')).toBeInTheDocument();
  });

  it('shows no notice when the agent filter options load', async () => {
    // Arrange
    await mockEndpoints({
      evaluations: () => Promise.resolve(apiSuccess(MOCK_EVALUATIONS, MOCK_META)),
    });

    const { default: EvaluationsListPage } =
      await import('@/app/admin/orchestration/evaluations/page');

    // Act
    render(await EvaluationsListPage());

    // Assert
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
