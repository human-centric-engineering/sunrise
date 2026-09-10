/**
 * Tests: a policy that misses a `ReadTarget` arm does not compile
 *
 * This is the whole argument for the union, so it gets a check that can fail
 * rather than a paragraph claiming it.
 *
 * The mechanism is `@ts-expect-error`, which is falsifiable in the direction
 * that matters: if someone widens `ReadTarget` back to a nullable string, adds a
 * `default:` arm to the contract, or otherwise makes the incomplete policy below
 * compile, then the suppression has nothing to suppress and **`tsc` fails on
 * this file**. So this guard cannot rot into a comment — it breaks `npm run
 * type-check`, which `/pre-pr` and CI both run, the moment its premise stops
 * being true.
 *
 * Why it is worth a file. `canRead` took `subject: string | null` for two
 * rounds, and every state that was not a user id arrived as `null`: a route with
 * no resolver, a resolver that returned nothing, and a row with no owner. The
 * first should permit and the other two should not, so the natural line —
 * `subject === null || subject === viewer.userId` — permits all three and reads
 * like a check. That mistake was made three times inside one branch: twice by
 * the author while a reviewer was pointing at the class, and once in the
 * documentation example a fork would copy. The docblock warning was not holding
 * it, which is why the type does now.
 *
 * @see lib/auth/authorization.ts — `ReadTarget`, `readTargetFor`, `readSubject`
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AUTHORIZATION_POLICY,
  readTargetFor,
  readSubject,
  readUnattributedKind,
  type AuthorizationPolicy,
} from '@/lib/auth/authorization';

describe('a policy must answer every read state', () => {
  it('does not compile when an arm is missing', () => {
    const incomplete: AuthorizationPolicy = {
      ...DEFAULT_AUTHORIZATION_POLICY,
      // @ts-expect-error -- MISSING the 'unattributed' arm. A switch that does
      // not cover it falls through and returns `undefined`, which does not
      // satisfy `Promise<boolean>`, so this assignment is rejected. That is the
      // fork-facing guarantee: the shape that used to permit every caller on an
      // ownerless row is now a build failure in their repo, not a runtime
      // surprise in ours. If this line ever stops erroring, the guarantee is
      // gone and tsc will say so here.
      canRead: async (viewer, target) => {
        switch (target.kind) {
          case 'nothing':
            return true;
          case 'subject':
            return target.userId === viewer.userId;
        }
      },
    };

    // The runtime half: with the arm missing, the ownerless row is `undefined`
    // rather than a decision — which the guards read as a denial. Fail-closed by
    // accident is still worse than not compiling, and this is what the compile
    // error is buying.
    expect(incomplete).toBeDefined();
  });

  it('compiles when every arm is answered', async () => {
    // The contrast, so the test above is about exhaustiveness rather than about
    // something incidental in the fixture. No `@ts-expect-error` here — if this
    // one stopped compiling the file would simply fail to build.
    const complete: AuthorizationPolicy = {
      ...DEFAULT_AUTHORIZATION_POLICY,
      canRead: (viewer, target) => {
        switch (target.kind) {
          case 'nothing':
            return Promise.resolve(true);
          case 'unattributed':
            return Promise.resolve(false);
          case 'subject':
            return Promise.resolve(target.userId === viewer.userId);
        }
      },
    };

    const viewer = { userId: 'u1', credential: 'session' as const };
    await expect(complete.canRead(viewer, { kind: 'nothing' }, {})).resolves.toBe(true);
    await expect(
      complete.canRead(viewer, readTargetFor({ kind: 'report', orgId: 'o1' }), {})
    ).resolves.toBe(false);
    await expect(complete.canRead(viewer, readSubject('u1'), {})).resolves.toBe(true);
    await expect(complete.canRead(viewer, readSubject('u2'), {})).resolves.toBe(false);
  });
});

describe('readTargetFor is the one mapping from a resource to a question', () => {
  it('names each of the three states rather than flattening them', () => {
    // Duplicating this mapping at each call site is how the two guards drifted
    // apart in the first place — `withAdminAuth` passing a whole resource while
    // `withAuth` passed one field of it.
    expect(readTargetFor(null)).toEqual({ kind: 'nothing' });

    const ownerless = { kind: 'report', id: 'r1', orgId: 'org-7' };
    // `asking` names WHICH ownerless question this is. A resolver produced this
    // one, so it is `'this-row'` — the arm the default policy's "give the
    // resolver an ownerId" diagnostic is written for. The capability question
    // (`readUnattributedKind`) reaches the same arm and must not be diagnosed.
    expect(readTargetFor(ownerless)).toEqual({
      kind: 'unattributed',
      asking: 'this-row',
      resource: ownerless,
    });
    expect(readUnattributedKind('report')).toEqual({
      kind: 'unattributed',
      asking: 'any-row-of-this-kind',
      resource: { kind: 'report' },
    });

    const owned = { kind: 'thing', id: 't1', ownerId: 'u9' };
    expect(readTargetFor(owned)).toEqual({ kind: 'subject', userId: 'u9', resource: owned });
  });

  it('treats an explicitly undefined ownerId as unattributed, not as a subject', () => {
    // `exactOptionalPropertyTypes` is off in this repo, so `{ ownerId: undefined }`
    // is a value a resolver can produce — `ownerId: row.createdBy ?? undefined` is
    // the idiom this file's own docblock recommends for a nullable FK. It must
    // land in the same arm as an absent key.
    expect(readTargetFor({ kind: 'thing', ownerId: undefined })).toMatchObject({
      kind: 'unattributed',
    });
  });
});
