/**
 * Unit Test: Agents list endpoint — profile filter + natural-importance sort.
 *
 * Covers the two behaviours added by the agent-table-tidy-up branch:
 *   1. `profileId` query param: a CUID filters by that profile; 'none'
 *      filters to unassigned (`profileId IS NULL`); absence = no filter.
 *   2. orderBy is `[isSystem asc, lastActiveAt desc nulls last,
 *      createdAt desc]` regardless of other filters.
 *
 * @see app/api/v1/admin/orchestration/agents/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mockAdminUser } from '@/tests/helpers/auth';

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

const mockFindMany = vi.fn();
const mockCount = vi.fn();
const mockGroupBy = vi.fn();
const mockSettingsFindUnique = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      count: (...args: unknown[]) => mockCount(...args),
    },
    aiCostLog: {
      groupBy: (...args: unknown[]) => mockGroupBy(...args),
    },
    aiOrchestrationSettings: {
      findUnique: (...args: unknown[]) => mockSettingsFindUnique(...args),
    },
  },
}));

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  getMonthToDateGlobalSpend: vi.fn().mockResolvedValue(0),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

import { auth } from '@/lib/auth/config';
import { GET } from '@/app/api/v1/admin/orchestration/agents/route';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  mockFindMany.mockResolvedValue([]);
  mockCount.mockResolvedValue(0);
  mockGroupBy.mockResolvedValue([]);
  mockSettingsFindUnique.mockResolvedValue({ globalMonthlyBudgetUsd: null });
});

function makeRequest(query = ''): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/agents${query ? `?${query}` : ''}`
  );
}

describe('GET /api/v1/admin/orchestration/agents — profileId filter', () => {
  it('omits profileId from the where clause when not provided', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    expect(mockFindMany).toHaveBeenCalledTimes(1);
    const call = mockFindMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(call.where).not.toHaveProperty('profileId');
  });

  it('translates profileId=none to where.profileId === null', async () => {
    await GET(makeRequest('profileId=none'));

    const call = mockFindMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(call.where.profileId).toBeNull();
  });

  it('passes a CUID profileId through verbatim', async () => {
    // Real CUIDs from this codebase look like cmjbv4i3x00003wsloputgwul.
    const cuid = 'cmjbv4i3x00003wsloputgwul';
    await GET(makeRequest(`profileId=${cuid}`));

    const call = mockFindMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(call.where.profileId).toBe(cuid);
  });

  it('rejects malformed profileId values via Zod', async () => {
    const res = await GET(makeRequest('profileId=not-a-cuid-or-none'));
    expect(res.status).toBe(400);
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/admin/orchestration/agents — orderBy', () => {
  it('orders by [isSystem asc, lastActiveAt desc nulls last, createdAt desc]', async () => {
    await GET(makeRequest());

    const call = mockFindMany.mock.calls[0][0] as { orderBy: unknown[] };
    expect(call.orderBy).toEqual([
      { isSystem: 'asc' },
      { lastActiveAt: { sort: 'desc', nulls: 'last' } },
      { createdAt: 'desc' },
    ]);
  });

  it('keeps the same orderBy when other filters are applied', async () => {
    await GET(makeRequest('isActive=true&profileId=none&q=hello'));

    const call = mockFindMany.mock.calls[0][0] as { orderBy: unknown[] };
    expect(call.orderBy).toEqual([
      { isSystem: 'asc' },
      { lastActiveAt: { sort: 'desc', nulls: 'last' } },
      { createdAt: 'desc' },
    ]);
  });
});

describe('GET /api/v1/admin/orchestration/agents — profile join', () => {
  it('includes the agent profile in every row', async () => {
    await GET(makeRequest());

    const call = mockFindMany.mock.calls[0][0] as {
      include: { profile?: { select: Record<string, true> } };
    };
    expect(call.include.profile?.select).toEqual({
      id: true,
      name: true,
      slug: true,
      isSystem: true,
    });
  });
});
