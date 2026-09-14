/**
 * Tests for `lib/orchestration/access/execution-access.ts`.
 *
 * This module is the single point at which "can this admin see this
 * execution?" is decided for 15 routes and the live-engine dashboard. It has
 * to hold three lines at once:
 *
 *   - system-owned runs (`userId === null`) are visible to every admin on a
 *     default install, or scheduled and inbound runs vanish from the UI and
 *     their approval gates become unclearable (#502);
 *   - one admin's own runs stay invisible to another admin, which is the
 *     property the whole ownership check exists for — and which no policy may
 *     relax, because "nobody owns this" is a different question;
 *   - the first line is the **policy's** answer, not this module's, so a fork
 *     that denies unattributed reads narrows all 19 call sites at once (t-685).
 *
 * Every direction is asserted below, including the null-ish caller-id edge
 * that a naive `execution.userId === adminUserId` comparison gets wrong.
 *
 * The default-install cases are the ones that were here before the signature
 * took a session: their expectations are unchanged on purpose, because
 * "nothing a platform admin sees today moves" is the thing this task most had
 * to not break. Only the argument they are given changed.
 */

import { describe, it, expect } from 'vitest';

import {
  adminCanViewExecution,
  executionAccessBasis,
  executionVisibilityWhere,
} from '@/lib/orchestration/access/execution-access';
import type { AuthenticatedSession } from '@/lib/auth/guards';

const ADMIN_ID = 'admin-1';
const OTHER_ADMIN_ID = 'admin-2';

/**
 * Enough of an `AuthenticatedSession` for the three faces under test.
 *
 * `unattributedReads` is the record the guard resolved from the policy before
 * the handler ran; `execution` is the only key these helpers read. Setting it
 * directly is the unit-level contract — that the guard fills it from
 * `canRead` is pinned in `tests/unit/lib/auth/guards-authorization.test.ts`,
 * and that a fork's policy reaches these routes end to end is pinned in the
 * route tests.
 */
function sessionFor(userId: string, mayReadUnowned: boolean): AuthenticatedSession {
  return {
    user: { id: userId, role: 'ADMIN' },
    principal: { userId, role: 'ADMIN', credential: 'session' },
    unattributedReads: {
      conversation: mayReadUnowned,
      dataset: mayReadUnowned,
      execution: mayReadUnowned,
      experiment: mayReadUnowned,
    },
  } as unknown as AuthenticatedSession;
}

/** A platform admin on a default install: the policy permits ownerless reads. */
const admin = sessionFor(ADMIN_ID, true);
/** The same admin under a fork whose policy denies them. */
const narrowedAdmin = sessionFor(ADMIN_ID, false);

describe('executionAccessBasis', () => {
  it('reports owner for the caller’s own run', () => {
    expect(executionAccessBasis({ userId: ADMIN_ID }, admin)).toBe('owner');
  });

  it('reports system for an unowned run', () => {
    expect(executionAccessBasis({ userId: null }, admin)).toBe('system');
  });

  it('reports null for another admin’s run', () => {
    expect(executionAccessBasis({ userId: OTHER_ADMIN_ID }, admin)).toBeNull();
  });

  it('reports null for a missing row', () => {
    expect(executionAccessBasis(null, admin)).toBeNull();
    expect(executionAccessBasis(undefined, admin)).toBeNull();
  });

  it('reports system, not owner, when the caller id is empty', () => {
    // An empty or otherwise falsy caller id must never be read as owning
    // every unowned row: `'' === null` is false in JS, but a refactor that
    // compared loosely, or ordered the checks the other way, would grant
    // 'owner' here and silently skip the access audit that 'system' triggers.
    expect(executionAccessBasis({ userId: null }, sessionFor('', true))).toBe('system');
  });

  it('refuses an unowned run when the policy denies unattributed reads', () => {
    // The capability t-685 exists to deliver. This helper gates the DETAIL
    // routes, which fetch by id and then ask — so without this branch a
    // narrowing fork would get a filtered list whose rows still opened.
    expect(executionAccessBasis({ userId: null }, narrowedAdmin)).toBeNull();
  });

  it('still reports owner for the caller’s own run when the policy narrows', () => {
    // Denying ownerless reads must not cost the caller their own rows. The
    // two questions are independent and a fork answering one must not move
    // the other.
    expect(executionAccessBasis({ userId: ADMIN_ID }, narrowedAdmin)).toBe('owner');
  });

  it('never admits another admin’s run, whatever the policy says about unowned rows', () => {
    // No policy value may widen this: "belongs to nobody" and "belongs to
    // someone else" are different questions, and conflating them is the
    // divergence #741 closed.
    for (const session of [admin, narrowedAdmin]) {
      expect(executionAccessBasis({ userId: OTHER_ADMIN_ID }, session)).toBeNull();
    }
  });
});

describe('adminCanViewExecution', () => {
  it('admits own and system-owned runs, refuses everything else', () => {
    expect(adminCanViewExecution({ userId: ADMIN_ID }, admin)).toBe(true);
    expect(adminCanViewExecution({ userId: null }, admin)).toBe(true);
    expect(adminCanViewExecution({ userId: OTHER_ADMIN_ID }, admin)).toBe(false);
    expect(adminCanViewExecution(null, admin)).toBe(false);
  });

  it('refuses a system-owned run when the policy denies unattributed reads', () => {
    expect(adminCanViewExecution({ userId: null }, narrowedAdmin)).toBe(false);
    expect(adminCanViewExecution({ userId: ADMIN_ID }, narrowedAdmin)).toBe(true);
  });
});

describe('executionVisibilityWhere', () => {
  it('produces exactly two arms: the caller, and unowned rows', () => {
    // The shape is asserted literally because route tests match against it,
    // and because a third arm here would be a cross-admin read across every
    // list, count, and dashboard query at once.
    expect(executionVisibilityWhere(admin)).toEqual({
      OR: [{ userId: ADMIN_ID }, { userId: null }],
    });
  });

  it('never emits a bare `userId: undefined` arm that would match all rows', () => {
    // Prisma drops `undefined` from a where clause, so an arm that resolved
    // to `{ userId: undefined }` would degrade to "no filter" — every admin
    // seeing every run. Pinning the arms as own-id-then-null rules it out.
    const where = executionVisibilityWhere(admin) as { OR: { userId: string | null }[] };
    for (const arm of where.OR) {
      expect(arm.userId === undefined).toBe(false);
    }
  });

  it('drops the unowned arm entirely when the policy denies unattributed reads', () => {
    // Not `{ OR: [{ userId }] }` — a single-armed OR would work, but the
    // narrowed fragment is what a caller composes filters against, and the
    // flat form is the one a reader can see is closed.
    expect(executionVisibilityWhere(narrowedAdmin)).toEqual({ userId: ADMIN_ID });
  });

  it('carries a usable id on the narrowed branch, not merely a key', () => {
    // `{}` is the widest value this type can express: produce one here and
    // every list and count goes global for exactly the fork that asked to be
    // narrowed. But counting keys is too weak to catch that, and the narrowed
    // branch is the one that fails OPEN — `{ userId: undefined }` has a key,
    // passes a non-empty check, and is then dropped by Prisma, leaving no
    // filter at all. So assert the value, not the shape.
    const narrowed = executionVisibilityWhere(narrowedAdmin) as { userId?: unknown };
    expect(narrowed.userId).toBe(ADMIN_ID);
    expect(typeof narrowed.userId).toBe('string');

    // The widened branch has its own arm-level guard above; here we only need
    // it to be non-empty, since an empty OR would be a different bug.
    expect(Object.keys(executionVisibilityWhere(admin))).not.toHaveLength(0);
  });
});
