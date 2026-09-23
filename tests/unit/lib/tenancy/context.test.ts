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

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

import {
  forEachOrg,
  getTenantContext,
  isMultiTenant,
  requireTenantContext,
  requireOrgId,
  runAsCredentialLookup,
  runAsOrg,
  runAsSystem,
  runDetached,
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

  it('keeps the context for a lazy promise a non-async callback returns unawaited', async () => {
    // A PrismaPromise is lazy: the data layer reads the context when the
    // promise is awaited, not when it is created. This thenable is that
    // shape — it reads the store when something awaits it. The seam awaits
    // inside the scope, so `() => prisma.x.findMany()` keeps its org.
    const lazy = () =>
      ({
        then(resolve: (value: string | null | undefined) => void) {
          resolve(getTenantContext()?.orgId);
        },
      }) as unknown as Promise<string | null | undefined>;
    expect(await runAsOrg(ORG_A, lazy)).toBe(ORG_A);
    expect(await runAsSystem('lazy', lazy)).toBeNull();
    // The shape it guards against: awaited outside the scope, the same
    // thenable reads nothing.
    expect(await lazy()).toBeUndefined();
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

describe('requireOrgId — a lookup that has to name the org', () => {
  it('is the entered org, in either mode', async () => {
    for (const mode of ['single', 'multi'] as const) {
      mockEnv.TENANCY_MODE = mode;
      expect(await runAsOrg(ORG_A, async () => requireOrgId())).toBe(ORG_A);
    }
  });

  it('is the install org at single when nothing entered a context, and a throw at multi', () => {
    expect(requireOrgId()).toBe(INSTALL_ORG_ID);
    mockEnv.TENANCY_MODE = 'multi';
    expect(() => requireOrgId()).toThrow(/No tenant context/);
  });

  it('refuses the system scope — a global scope cannot name one org’s row by slug', async () => {
    for (const mode of ['single', 'multi'] as const) {
      mockEnv.TENANCY_MODE = mode;
      await expect(runAsSystem('reason', async () => requireOrgId())).rejects.toThrow(
        /system scope, which has no org to name/
      );
    }
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

describe('runAsCredentialLookup — the one read that learns the org', () => {
  it('is the same null-org system scope, logged at debug rather than info', async () => {
    mockEnv.TENANCY_MODE = 'multi';
    const seen = await runAsCredentialLookup('api-key', async () => getTenantContext());
    expect(seen).toEqual({ orgId: null, source: 'system' });
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Entering system tenant scope for a credential lookup',
      { credential: 'api-key' }
    );
    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(getTenantContext()).toBeNull();
  });

  it('is what requireTenantContext answers inside it, and refuses requireOrgId', async () => {
    mockEnv.TENANCY_MODE = 'multi';
    expect((await runAsCredentialLookup('x', async () => requireTenantContext())).orgId).toBeNull();
    await expect(runAsCredentialLookup('x', async () => requireOrgId())).rejects.toThrow(
      /system scope/
    );
  });
});

describe('runDetached — arming something that outlives the request', () => {
  /**
   * Arm a timer and resolve with the org its callback saw when it fired.
   * `arm` is what differs between the two tests below: the primitive, or
   * nothing.
   */
  function orgSeenByTimer(arm: (schedule: () => void) => void): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      arm(() => resolve(getTenantContext()?.orgId ?? null));
    });
  }

  it('runs the callback with no context, from inside an org scope', async () => {
    const seen = await runAsOrg(ORG_A, async () => runDetached(() => getTenantContext()));
    expect(seen).toBeNull();
  });

  it('leaves the surrounding scope intact once it returns', async () => {
    const after = await runAsOrg(ORG_A, async () => {
      runDetached(() => getTenantContext());
      return getTenantContext()?.orgId;
    });
    expect(after).toBe(ORG_A);
  });

  it('returns the callback’s value — the timer handle, for its callers', async () => {
    const handle = await runAsOrg(ORG_A, async () => runDetached(() => 'timer'));
    expect(handle).toBe('timer');
  });

  it('is what a timer armed inside a request needs: the callback fires with no org', async () => {
    // The whole point of the primitive. An AsyncLocalStorage store is captured
    // when setTimeout/setInterval is CALLED, so a timer armed in here is
    // detached for every tick it ever fires — the callback body needs no
    // change. It was McpSessionManager's eviction timer in miniature; that
    // timer went with the stateful MCP transport (§39 t-718), so these two tests
    // are now the only thing holding the rule up.
    const seen = await runAsOrg(ORG_A, async () =>
      orgSeenByTimer((schedule) => runDetached(() => setTimeout(schedule, 1)))
    );
    expect(seen).toBeNull();
  });

  it('and without it the same timer keeps the arming request’s org — the defect', async () => {
    // The negative control, in the tree rather than in a commit message: this
    // is the propagation §108 t-715 exists to interrupt. If this assertion ever
    // flips to null, AsyncLocalStorage stopped propagating into timers and
    // runDetached is dead weight rather than load-bearing.
    const seen = await runAsOrg(ORG_A, async () =>
      orgSeenByTimer((schedule) => setTimeout(schedule, 1))
    );
    expect(seen).toBe(ORG_A);
  });

  it('detaches async work started inside it, not just the synchronous frame', async () => {
    const seen = await runAsOrg(ORG_A, async () =>
      runDetached(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return getTenantContext();
      })
    );
    expect(seen).toBeNull();
  });

  it('makes a detached caller that needs an org fail loud at multi, not read wide', async () => {
    // Detaching is not the audited bypass: nothing inside it may name an org,
    // and asking refuses rather than answering from whichever org armed it.
    mockEnv.TENANCY_MODE = 'multi';
    await expect(
      runAsOrg(ORG_A, async () => runDetached(() => requireTenantContext()))
    ).rejects.toThrow(/No tenant context/);
  });

  it('is a no-op outside any scope', () => {
    expect(runDetached(() => getTenantContext())).toBeNull();
    expect(getTenantContext()).toBeNull();
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
