/**
 * Tests: lib/tenancy/context.ts — the tenant context primitive (§106)
 *
 * The six AsyncLocalStorage behaviours `signup-mode.test.ts` pins for its
 * store, pinned again here because this store is what the data layer will
 * scope queries by: a leak is a cross-tenant read, not a wrong log line.
 * Plus the one thing this module adds — `requireTenantContext` answering
 * the install org at `single` and throwing at `multi` — under a node
 * environment with the env mocked (`.context/testing/environments.md`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'single' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const mockFindMany = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/client', () => ({ prisma: { org: { findMany: mockFindMany } } }));

const mockLogger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

import {
  forEachOrg,
  getTenantContext,
  isMultiTenant,
  requireTenantContext,
  runAsOrg,
  runAsSystem,
} from '@/lib/tenancy/context';

const ORG_A = 'cmorg00000000000000000orga';
const ORG_B = 'cmorg00000000000000000orgb';

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'single';
  mockFindMany.mockResolvedValue([]);
});

describe('the store', () => {
  it('reports no context by default', () => {
    expect(getTenantContext()).toBeNull();
  });

  it('marks the context inside the callback, with the source and role it was given', async () => {
    const seen = await runAsOrg(ORG_A, async () => getTenantContext(), {
      source: 'session',
      role: 'ADMIN',
    });
    expect(seen).toEqual({ orgId: ORG_A, source: 'session', role: 'ADMIN' });
  });

  it('defaults the source to job for a caller that names none', async () => {
    const seen = await runAsOrg(ORG_A, async () => getTenantContext());
    expect(seen).toMatchObject({ orgId: ORG_A, source: 'job' });
  });

  it('survives an await boundary inside the callback', async () => {
    const seen = await runAsOrg(ORG_A, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return getTenantContext()?.orgId;
    });
    expect(seen).toBe(ORG_A);
  });

  it('does not leak after the callback resolves', async () => {
    await runAsOrg(ORG_A, async () => undefined);
    expect(getTenantContext()).toBeNull();
  });

  it('does not leak when the callback throws', async () => {
    await expect(
      runAsOrg(ORG_A, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(getTenantContext()).toBeNull();
  });

  it('does not leak into concurrent unwrapped work, and two scopes do not see each other', async () => {
    const [a, b, outside] = await Promise.all([
      runAsOrg(ORG_A, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return getTenantContext()?.orgId;
      }),
      runAsOrg(ORG_B, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return getTenantContext()?.orgId;
      }),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return getTenantContext();
      })(),
    ]);
    expect(a).toBe(ORG_A);
    expect(b).toBe(ORG_B);
    expect(outside).toBeNull();
  });

  it('returns the callback result to the caller', async () => {
    expect(await runAsOrg(ORG_A, async () => 42)).toBe(42);
  });
});

describe('requireTenantContext', () => {
  it('returns the entered context when there is one, in either mode', async () => {
    for (const mode of ['single', 'multi'] as const) {
      mockEnv.TENANCY_MODE = mode;
      const seen = await runAsOrg(ORG_A, async () => requireTenantContext(), { source: 'api-key' });
      expect(seen).toMatchObject({ orgId: ORG_A, source: 'api-key' });
    }
  });

  it('answers the install org, marked implicit, at single when nothing entered a context', () => {
    expect(isMultiTenant()).toBe(false);
    expect(requireTenantContext()).toEqual({ orgId: INSTALL_ORG_ID, source: 'implicit' });
  });

  it('throws at multi when nothing entered a context — a wide query is never the fallback', () => {
    mockEnv.TENANCY_MODE = 'multi';
    expect(isMultiTenant()).toBe(true);
    expect(() => requireTenantContext()).toThrow(/No tenant context/);
  });
});

describe('runAsSystem', () => {
  it('enters a null-org system scope and logs the reason', async () => {
    const seen = await runAsSystem('nightly global sweep', async () => getTenantContext());
    expect(seen).toEqual({ orgId: null, source: 'system' });
    expect(mockLogger.info).toHaveBeenCalledWith('Entering system tenant scope', {
      reason: 'nightly global sweep',
    });
  });

  it('is what requireTenantContext returns inside it, even at multi', async () => {
    mockEnv.TENANCY_MODE = 'multi';
    const seen = await runAsSystem('reason', async () => requireTenantContext());
    expect(seen.source).toBe('system');
  });
});

describe('forEachOrg', () => {
  it('runs the callback once per ACTIVE org, each inside its own job scope, in order', async () => {
    mockFindMany.mockResolvedValue([{ id: ORG_A }, { id: ORG_B }]);
    const seen: Array<[string, string | null | undefined]> = [];

    await forEachOrg(async (orgId) => {
      seen.push([orgId, getTenantContext()?.orgId]);
    });

    expect(seen).toEqual([
      [ORG_A, ORG_A],
      [ORG_B, ORG_B],
    ]);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'ACTIVE' } })
    );
    expect(getTenantContext()).toBeNull();
  });

  it('is sequential: the second org starts after the first finishes', async () => {
    mockFindMany.mockResolvedValue([{ id: ORG_A }, { id: ORG_B }]);
    const order: string[] = [];
    await forEachOrg(async (orgId) => {
      order.push(`start ${orgId}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
      order.push(`end ${orgId}`);
    });
    expect(order).toEqual([`start ${ORG_A}`, `end ${ORG_A}`, `start ${ORG_B}`, `end ${ORG_B}`]);
  });

  it('does nothing, and enters nothing, with no active orgs', async () => {
    const fn = vi.fn();
    await forEachOrg(fn);
    expect(fn).not.toHaveBeenCalled();
  });
});
