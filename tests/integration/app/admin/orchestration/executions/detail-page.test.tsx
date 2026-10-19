// @vitest-environment happy-dom

/**
 * Integration Test: Admin Orchestration — Execution Detail Page
 *
 * Tests the server component at
 * `app/admin/orchestration/executions/[id]/page.tsx`.
 *
 * Test coverage:
 * - Happy path: renders truncated execution ID as heading, breadcrumb
 * - notFound() called on a 404, and only on a 404: a 500 or a success:false
 *   envelope throws to the error boundary instead of reading as a missing
 *   execution (#518)
 *
 * @see app/admin/orchestration/executions/[id]/page.tsx
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

const mockNotFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});

vi.mock('next/navigation', () => ({
  notFound: mockNotFound,
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/'),

  useSearchParams: () => ({ get: () => null }),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

// ExecutionDetailView is a client component; stub it out
vi.mock('@/components/admin/orchestration/execution-detail-view', () => ({
  ExecutionDetailView: () => <div data-testid="execution-detail-view" />,
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// Use a real CUID-length id so the truncation slice renders correctly
const EXEC_ID = 'cmjbv4i3x00003wsloputgwu9';
const WORKFLOW_ID = 'cmjbv4i3x00003wsloputgwu2';

const MOCK_EXECUTION = {
  id: EXEC_ID,
  workflowId: WORKFLOW_ID,
  status: 'completed',
  totalTokensUsed: 1500,
  totalCostUsd: 0.075,
  budgetLimitUsd: null,
  currentStep: null,
  inputData: { prompt: 'hello' },
  outputData: { result: 'world' },
  errorMessage: null,
  startedAt: '2025-01-01T10:00:00.000Z',
  completedAt: '2025-01-01T10:01:30.000Z',
  createdAt: '2025-01-01T10:00:00.000Z',
  workflow: { id: WORKFLOW_ID, name: 'Test Workflow' },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ExecutionDetailPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders execution heading with truncated ID', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess({ execution: MOCK_EXECUTION, trace: [] }));

    const { default: ExecutionDetailPage } =
      await import('@/app/admin/orchestration/executions/[id]/page');

    render(await ExecutionDetailPage({ params: Promise.resolve({ id: EXEC_ID }) }));

    // Page renders "Execution {id.slice(0,8)}…"
    const truncated = EXEC_ID.slice(0, 8);
    expect(
      screen.getByRole('heading', { name: new RegExp(`Execution ${truncated}`) })
    ).toBeInTheDocument();
  });

  it('shows "AI Orchestration" breadcrumb link', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess({ execution: MOCK_EXECUTION, trace: [] }));

    const { default: ExecutionDetailPage } =
      await import('@/app/admin/orchestration/executions/[id]/page');

    render(await ExecutionDetailPage({ params: Promise.resolve({ id: EXEC_ID }) }));

    const breadcrumbLink = screen.getByRole('link', { name: /AI Orchestration/i });
    expect(breadcrumbLink).toBeInTheDocument();
    expect(breadcrumbLink).toHaveAttribute('href', '/admin/orchestration');
  });

  it('renders the ExecutionDetailView', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess({ execution: MOCK_EXECUTION, trace: [] }));

    const { default: ExecutionDetailPage } =
      await import('@/app/admin/orchestration/executions/[id]/page');

    render(await ExecutionDetailPage({ params: Promise.resolve({ id: EXEC_ID }) }));

    expect(screen.getByTestId('execution-detail-view')).toBeInTheDocument();
  });

  it('calls notFound() when the execution does not exist', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(404, 'NOT_FOUND'));

    const { default: ExecutionDetailPage } =
      await import('@/app/admin/orchestration/executions/[id]/page');

    await expect(ExecutionDetailPage({ params: Promise.resolve({ id: EXEC_ID }) })).rejects.toThrow(
      'NEXT_NOT_FOUND'
    );

    expect(mockNotFound).toHaveBeenCalledOnce();
  });

  it('throws to the error boundary, not notFound(), when the load fails', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    const { ServerLoadError } = await import('@/lib/api/server-load');
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    const { default: ExecutionDetailPage } =
      await import('@/app/admin/orchestration/executions/[id]/page');

    await expect(
      ExecutionDetailPage({ params: Promise.resolve({ id: EXEC_ID }) })
    ).rejects.toBeInstanceOf(ServerLoadError);
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it('throws, not notFound(), when the API answers success:false', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    const { ServerLoadError } = await import('@/lib/api/server-load');
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(200));

    const { default: ExecutionDetailPage } =
      await import('@/app/admin/orchestration/executions/[id]/page');

    await expect(
      ExecutionDetailPage({ params: Promise.resolve({ id: EXEC_ID }) })
    ).rejects.toBeInstanceOf(ServerLoadError);
    expect(mockNotFound).not.toHaveBeenCalled();
  });
});
