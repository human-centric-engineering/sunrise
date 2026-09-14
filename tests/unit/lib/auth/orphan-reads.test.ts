/**
 * Tests: lib/auth/orphan-reads.ts — asking "may this caller see rows nobody owns?"
 *
 * Two properties, and the second is the defect this file was added for.
 *
 *  1. **The answer comes from the policy.** Not from a hard-coded rule, not from
 *     the caller's role read here. A registered policy changes it, per kind —
 *     which is the whole capability the four sweeps behind this depend on.
 *  2. **Asking does not raise an alarm.** The `'unattributed'` arm serves two
 *     questions, and the default policy's diagnostic is written for the other
 *     one: "a resolver named a row and could not attribute it — give it an
 *     `ownerId`". Asking the capability question used to trip it, so every
 *     install logged one line per kind naming a resolver that does not exist.
 *     Precomputing makes that worse, not better: the guards now ask on every
 *     request.
 *
 * The contrast test is the load-bearing one — the diagnostic must still fire for
 * a real misconfiguration, or this "fix" is just a deleted warning.
 *
 * @see lib/auth/orphan-reads.ts · lib/auth/authorization.ts
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@/lib/logging';
import {
  DEFAULT_AUTHORIZATION_POLICY,
  registerAuthorizationPolicy,
  readTargetFor,
  __resetAuthorizationPolicyForTests,
  __resetOwnerlessWarningsForTests,
  type AuthorizationPrincipal,
  type ReadTarget,
} from '@/lib/auth/authorization';
import {
  UNATTRIBUTED_READ_KINDS,
  mayReadUnattributed,
  resolveUnattributedReads,
} from '@/lib/auth/orphan-reads';
import { datasetVisibilityWhere } from '@/lib/orchestration/access/dataset-access';
import { experimentVisibilityWhere } from '@/lib/orchestration/access/experiment-access';
import { executionVisibilityWhere } from '@/lib/orchestration/access/execution-access';
import { conversationVisibilityWhere } from '@/lib/orchestration/access/conversation-access';
import type { AuthenticatedSession } from '@/lib/auth/guards';

const ADMIN: AuthorizationPrincipal = { userId: 'admin-1', role: 'ADMIN', credential: 'session' };
const MEMBER: AuthorizationPrincipal = { userId: 'user-1', role: 'USER', credential: 'session' };

beforeEach(() => {
  vi.clearAllMocks();
  __resetOwnerlessWarningsForTests();
});

afterEach(() => {
  __resetAuthorizationPolicyForTests();
});

describe('the roster of kinds', () => {
  it('reaches each model helper under its own key, so one answer cannot serve two', async () => {
    // This replaces three assertions that pinned `DATASET_RESOURCE_KIND` (twice)
    // and `EXPERIMENT_RESOURCE_KIND` to their literals. Those constants existed
    // because a helper passed a `string` to `mayReadUnattributed`, and an
    // annotation alone could not stop one drifting to the other's value —
    // `'dataset'` and `'experiment'` are both members of the union, so the
    // mis-assignment type-checked and the whole suite stayed green.
    //
    // t-687 deleted the last of them: all four helpers read
    // `session.unattributedReads.<kind>`, so there is no string left to spell
    // wrong. Pinning the constants would now be pinning nothing, and asserting
    // that the record's keys equal the roster would be worse — the seed literal
    // is typed `Record<UnattributedReadKind, boolean>`, so a missing or extra
    // key fails to compile and such a test could never go red.
    //
    // The property that CAN still break is the one the constants were really
    // protecting: each helper must read the key for its own model. A policy
    // that answers for exactly one kind is what exposes it — swap `.experiment`
    // for `.dataset` in either helper and two of these four lines flip.
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canRead: (viewer, target, scope) =>
        target.kind === 'unattributed'
          ? Promise.resolve(target.resource.kind === 'dataset')
          : DEFAULT_AUTHORIZATION_POLICY.canRead(viewer, target, scope),
    });

    const session = {
      user: { id: ADMIN.userId, role: 'ADMIN' },
      principal: ADMIN,
      unattributedReads: await resolveUnattributedReads(ADMIN),
    } as unknown as AuthenticatedSession;

    expect(datasetVisibilityWhere(session)).toEqual({
      OR: [{ userId: ADMIN.userId }, { userId: null }],
    });
    expect(experimentVisibilityWhere(session)).toEqual({ createdBy: ADMIN.userId });
    expect(executionVisibilityWhere(session)).toEqual({ userId: ADMIN.userId });
    expect(conversationVisibilityWhere(session, { excludeShared: true })).toEqual({
      OR: [{ userId: ADMIN.userId }],
    });
  });

  it('names each model once, so a second spelling cannot split the answer', () => {
    // Not a snapshot of the list for its own sake: a duplicate — or a synonym
    // like 'workflow-execution' beside 'execution' — would mean a fork's policy
    // answers for one spelling while a reader asks with the other, and nothing
    // goes red. Pinning the exact set is also what makes adding a kind a
    // deliberate edit rather than a drive-by.
    expect([...UNATTRIBUTED_READ_KINDS]).toEqual([
      'conversation',
      'dataset',
      'execution',
      'experiment',
    ]);
    expect(new Set(UNATTRIBUTED_READ_KINDS).size).toBe(UNATTRIBUTED_READ_KINDS.length);
  });
});

describe('the answer comes from the policy', () => {
  it('lets platform staff read ownerless rows and nobody else, by default', async () => {
    await expect(resolveUnattributedReads(ADMIN)).resolves.toEqual({
      conversation: true,
      dataset: true,
      execution: true,
      experiment: true,
    });
    await expect(resolveUnattributedReads(MEMBER)).resolves.toEqual({
      conversation: false,
      dataset: false,
      execution: false,
      experiment: false,
    });
  });

  it('lets a fork answer differently per kind', async () => {
    // The capability the four sweeps exist to deliver, and today it is
    // impossible: `conversation-access.ts` and `execution-access.ts` hard-code
    // "every admin sees every ownerless row" and never ask. A per-kind answer is
    // what a customer tier needs — a tenant's admin may audit their own
    // abandoned datasets without reading another tenant's inbound messages.
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canRead: (viewer, target) =>
        target.kind === 'unattributed'
          ? Promise.resolve(target.resource.kind === 'dataset')
          : DEFAULT_AUTHORIZATION_POLICY.canRead(viewer, target, {}),
    });

    await expect(resolveUnattributedReads(ADMIN)).resolves.toEqual({
      conversation: false,
      dataset: true,
      execution: false,
      experiment: false,
    });
  });

  it('hides ownerless rows when the policy throws, rather than exposing them', async () => {
    // `canRead` falls back to safe mode, whose `'unattributed'` arm is `false`.
    // The direction matters: a policy that cannot answer must not be read as a
    // yes, and this is the one question whose wrong answer publishes rows that
    // were nobody's.
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canRead: () => {
        throw new Error('the fork policy blew up');
      },
    });

    await expect(resolveUnattributedReads(ADMIN)).resolves.toEqual({
      conversation: false,
      dataset: false,
      execution: false,
      experiment: false,
    });
  });

  it('asks the policy once per kind, not once per reader', async () => {
    const asked: ReadTarget[] = [];
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canRead: (viewer, target) => {
        asked.push(target);
        return DEFAULT_AUTHORIZATION_POLICY.canRead(viewer, target, {});
      },
    });

    await resolveUnattributedReads(ADMIN);

    expect(asked).toEqual(
      UNATTRIBUTED_READ_KINDS.map((kind) => ({
        kind: 'unattributed',
        asking: 'any-row-of-this-kind',
        resource: { kind },
      }))
    );
  });
});

describe('asking is not an alarm', () => {
  it('logs nothing when a caller asks whether ownerless rows of a kind are readable', async () => {
    // The false alarm: since experiments and datasets started asking, every
    // install logged `"a route named a resource with no ownerId"` naming
    // `experiment` and `dataset`, and told the operator to give an `ownerId` to
    // a resolver that does not exist. Nothing here is misconfigured — no row was
    // resolved, so no `ownerId` was omitted.
    await resolveUnattributedReads(ADMIN);
    await resolveUnattributedReads(MEMBER);
    await mayReadUnattributed(MEMBER, 'some-fork-model');

    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  it('still warns when a resolver names a row it could not attribute', async () => {
    // The control, and the reason this is a fix rather than a deleted warning.
    // Same arm, same kind, same principal — only the question differs. Narrowing
    // the warning to resources carrying an `id` was tried in t-678 and reverted
    // precisely because it would silence this: a resolver returning a kind with
    // no id is the misconfiguration the diagnostic exists for.
    await mayReadUnattributed(MEMBER, 'report');
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();

    await DEFAULT_AUTHORIZATION_POLICY.canRead(MEMBER, readTargetFor({ kind: 'report' }), {});

    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('no ownerId'),
      expect.objectContaining({ kind: 'report' })
    );
  });
});
