/**
 * Integration Test: Admin Orchestration — Execution Detail Page
 *
 * Tests the server component at
 * `app/admin/orchestration/executions/[id]/page.tsx`.
 *
 * Test coverage:
 * - Happy path: renders truncated execution ID as heading, breadcrumb
 * - notFound() called when execution fetch returns null
 *
 * @see app/admin/orchestration/executions/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/auth/utils', () => ({
  getServerSession: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowExecution: {
      findUnique: vi.fn(),
    },
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
const USER_ID = 'test-user-id';

const MOCK_EXECUTION_ROW = {
  id: EXEC_ID,
  workflowId: WORKFLOW_ID,
  userId: USER_ID,
  status: 'completed',
  totalTokensUsed: 1500,
  totalCostUsd: 0.075,
  budgetLimitUsd: null,
  currentStep: null,
  inputData: { prompt: 'hello' },
  outputData: { result: 'world' },
  errorMessage: null,
  executionTrace: [], // executionTraceSchema parses this as an array
  startedAt: new Date('2025-01-01T10:00:00.000Z'),
  completedAt: new Date('2025-01-01T10:01:30.000Z'),
  createdAt: new Date('2025-01-01T10:00:00.000Z'),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ExecutionDetailPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders execution heading with truncated ID', async () => {
    const { getServerSession } = await import('@/lib/auth/utils');
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: USER_ID, role: 'ADMIN' },
    } as any);
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(MOCK_EXECUTION_ROW as any);

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
    const { getServerSession } = await import('@/lib/auth/utils');
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: USER_ID, role: 'ADMIN' },
    } as any);
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(MOCK_EXECUTION_ROW as any);

    const { default: ExecutionDetailPage } =
      await import('@/app/admin/orchestration/executions/[id]/page');

    render(await ExecutionDetailPage({ params: Promise.resolve({ id: EXEC_ID }) }));

    const breadcrumbLink = screen.getByRole('link', { name: /AI Orchestration/i });
    expect(breadcrumbLink).toBeInTheDocument();
    expect(breadcrumbLink).toHaveAttribute('href', '/admin/orchestration');
  });

  it('renders the ExecutionDetailView', async () => {
    const { getServerSession } = await import('@/lib/auth/utils');
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: USER_ID, role: 'ADMIN' },
    } as any);
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(MOCK_EXECUTION_ROW as any);

    const { default: ExecutionDetailPage } =
      await import('@/app/admin/orchestration/executions/[id]/page');

    render(await ExecutionDetailPage({ params: Promise.resolve({ id: EXEC_ID }) }));

    expect(screen.getByTestId('execution-detail-view')).toBeInTheDocument();
  });

  it('calls notFound() when execution fetch returns null', async () => {
    const { getServerSession } = await import('@/lib/auth/utils');
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: USER_ID, role: 'ADMIN' },
    } as any);
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(null);

    const { default: ExecutionDetailPage } =
      await import('@/app/admin/orchestration/executions/[id]/page');

    await expect(ExecutionDetailPage({ params: Promise.resolve({ id: EXEC_ID }) })).rejects.toThrow(
      'NEXT_NOT_FOUND'
    );

    expect(mockNotFound).toHaveBeenCalledOnce();
  });

  it('calls notFound() when session is missing (userId is undefined)', async () => {
    // No session → userId undefined → data stays null → notFound()
    const { getServerSession } = await import('@/lib/auth/utils');
    vi.mocked(getServerSession).mockResolvedValue(null);

    const { default: ExecutionDetailPage } =
      await import('@/app/admin/orchestration/executions/[id]/page');

    await expect(ExecutionDetailPage({ params: Promise.resolve({ id: EXEC_ID }) })).rejects.toThrow(
      'NEXT_NOT_FOUND'
    );

    expect(mockNotFound).toHaveBeenCalledOnce();
  });
});
