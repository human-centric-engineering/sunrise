/**
 * Integration Test: Admin Orchestration — Execution Detail Page
 *
 * Tests the server component at
 * `app/admin/orchestration/executions/[id]/page.tsx`.
 *
 * Test coverage:
 * - Happy path: renders truncated execution ID as heading, breadcrumb
 * - notFound() called when execution fetch returns non-ok
 *
 * @see app/admin/orchestration/executions/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
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
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ExecutionDetailPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders execution heading with truncated ID', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValueOnce({
      success: true,
      data: { execution: MOCK_EXECUTION, trace: [] },
    });

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
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValueOnce({
      success: true,
      data: { execution: MOCK_EXECUTION, trace: [] },
    });

    const { default: ExecutionDetailPage } =
      await import('@/app/admin/orchestration/executions/[id]/page');

    render(await ExecutionDetailPage({ params: Promise.resolve({ id: EXEC_ID }) }));

    const breadcrumbLink = screen.getByRole('link', { name: /AI Orchestration/i });
    expect(breadcrumbLink).toBeInTheDocument();
    expect(breadcrumbLink).toHaveAttribute('href', '/admin/orchestration');
  });

  it('renders the ExecutionDetailView', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValueOnce({
      success: true,
      data: { execution: MOCK_EXECUTION, trace: [] },
    });

    const { default: ExecutionDetailPage } =
      await import('@/app/admin/orchestration/executions/[id]/page');

    render(await ExecutionDetailPage({ params: Promise.resolve({ id: EXEC_ID }) }));

    expect(screen.getByTestId('execution-detail-view')).toBeInTheDocument();
  });

  it('calls notFound() when execution fetch returns non-ok', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: false, status: 404 } as Response);

    const { default: ExecutionDetailPage } =
      await import('@/app/admin/orchestration/executions/[id]/page');

    await expect(ExecutionDetailPage({ params: Promise.resolve({ id: EXEC_ID }) })).rejects.toThrow(
      'NEXT_NOT_FOUND'
    );

    expect(mockNotFound).toHaveBeenCalledOnce();
  });

  it('calls notFound() when parseApiResponse returns success: false', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValueOnce({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });

    const { default: ExecutionDetailPage } =
      await import('@/app/admin/orchestration/executions/[id]/page');

    await expect(ExecutionDetailPage({ params: Promise.resolve({ id: EXEC_ID }) })).rejects.toThrow(
      'NEXT_NOT_FOUND'
    );

    expect(mockNotFound).toHaveBeenCalledOnce();
  });
});
