/**
 * Tests: lib/auth/pending-signup.ts — the carrier between the three hooks.
 *
 * Uses better-auth's real request state rather than a mock of it, because
 * the property that matters is the library's: one store per request,
 * readable by every hook that request runs, invisible to any other. A mock
 * would assert whatever the mock did.
 */
import { describe, it, expect, vi } from 'vitest';
import { runWithRequestState } from '@better-auth/core/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { ORG_OWNER_ROLE, DEFAULT_ORG_ROLE } from '@/lib/tenancy/roles';

const mockLogger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

import { getPendingSignup, setPendingSignup } from '@/lib/auth/pending-signup';

const membership = { orgId: INSTALL_ORG_ID, role: ORG_OWNER_ROLE } as const;

describe('pending signup', () => {
  it('reads null outside a better-auth request rather than throwing', async () => {
    // A unit test calling a hook directly, or a seed: no request state.
    await expect(getPendingSignup()).resolves.toBeNull();
  });

  it('is a logged no-op when set outside a request', async () => {
    await setPendingSignup({ membership });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('outside a better-auth request')
    );
    await expect(getPendingSignup()).resolves.toBeNull();
  });

  it('carries the membership from a setter to a reader on the same request', async () => {
    const seen = await runWithRequestState(new WeakMap(), async () => {
      await setPendingSignup({ membership });
      return getPendingSignup();
    });
    expect(seen).toEqual({ membership });
  });

  it('is null on a request that never set it, even after another request did', async () => {
    await runWithRequestState(new WeakMap(), () => setPendingSignup({ membership }));
    const other = await runWithRequestState(new WeakMap(), () => getPendingSignup());
    expect(other).toBeNull();
  });

  it('two concurrent requests do not see each other', async () => {
    const a = { orgId: INSTALL_ORG_ID, role: ORG_OWNER_ROLE } as const;
    const b = { orgId: 'cmorg000000000000000other', role: DEFAULT_ORG_ROLE } as const;
    const [seenA, seenB] = await Promise.all([
      runWithRequestState(new WeakMap(), async () => {
        await setPendingSignup({ membership: a });
        await new Promise((resolve) => setTimeout(resolve, 5));
        return getPendingSignup();
      }),
      runWithRequestState(new WeakMap(), async () => {
        await setPendingSignup({ membership: b });
        return getPendingSignup();
      }),
    ]);
    expect(seenA?.membership).toEqual(a);
    expect(seenB?.membership).toEqual(b);
  });
});
