/**
 * Parity: the route layer and the data layer agree on what narrowed means
 * (§115 t-801).
 *
 * The route layer's answer is the policy's two read faces, which
 * `checkAuthorizationParity` already holds together: `canRead` on a subject,
 * and whether `subjectScope`'s filter selects it. The data layer's answer is
 * `whereConfines` (a list filtered to that subject) and `rowReadable` (a row
 * that subject owns), on a reader built from the same filter by `readerFor`.
 * For every principal, every policy and every subject, all four must say the
 * same thing. If they drift, a list the route would allow is refused below it,
 * or a row the route would refuse is let through.
 */
import { describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  checkAuthorizationParity,
  DEFAULT_AUTHORIZATION_POLICY,
  readSubject,
  SAFE_MODE_POLICY,
  type AuthorizationParityCase,
  type AuthorizationPolicy,
} from '@/lib/auth/authorization';
import { readOwnerSchema, readerFor, rowReadable, whereConfines } from '@/lib/db/owner-extension';
import { enforcedModels } from '@/lib/db/owner-classification';
import type { UnattributedReads } from '@/lib/auth/orphan-reads';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const NO_UNATTRIBUTED: UnattributedReads = {
  conversation: false,
  dataset: false,
  execution: false,
  experiment: false,
  webhookDelivery: false,
  webhookSubscription: false,
};

// The schema is all the analysis reads; the adapter is never connected.
const base = new PrismaClient({
  adapter: {
    provider: 'postgres',
    adapterName: 'unused',
    connect: () => Promise.reject(new Error('not connected')),
  },
});
const schema = readOwnerSchema(base, enforcedModels());

const ME = 'cmuser0000000000000000me01';
const OTHER = 'cmuser0000000000000000ot01';
const ORG = 'cmorg00000000000000000orga';

const CASES: AuthorizationParityCase[] = [
  {
    label: 'a platform admin (session)',
    viewer: { userId: ME, role: 'ADMIN', credential: 'session' },
    subjects: [ME, OTHER],
  },
  {
    label: 'an org OWNER',
    viewer: { userId: ME, role: 'USER', credential: 'session', orgId: ORG, orgRole: 'OWNER' },
    subjects: [ME, OTHER],
  },
  {
    label: 'an org MEMBER',
    viewer: { userId: ME, role: 'USER', credential: 'session', orgId: ORG, orgRole: 'MEMBER' },
    subjects: [ME, OTHER],
  },
  {
    label: 'an admin-scoped API key',
    viewer: { userId: ME, role: 'USER', credential: 'api-key', scopes: ['admin'] },
    subjects: [ME, OTHER],
  },
  {
    label: 'a chat-scoped API key',
    viewer: { userId: ME, role: 'ADMIN', credential: 'api-key', scopes: ['chat'] },
    subjects: [ME, OTHER],
  },
];

/** A fork's policy that narrows everyone to one named delegate, to prove the filter's id, not the viewer's, is what counts. */
const DELEGATE_POLICY: AuthorizationPolicy = {
  canAdminister: () => Promise.resolve(false),
  canRead: (_viewer, target) =>
    Promise.resolve(target.kind !== 'subject' || target.userId === OTHER),
  subjectScope: () => Promise.resolve({ userId: OTHER }),
};

const POLICIES: Array<[string, AuthorizationPolicy]> = [
  ['the default policy', DEFAULT_AUTHORIZATION_POLICY],
  ['safe mode', SAFE_MODE_POLICY],
  ['a delegating fork policy', DELEGATE_POLICY],
];

describe('route-layer and data-layer parity on AiUserMemory', () => {
  for (const [policyName, policy] of POLICIES) {
    it(`agree for every principal under ${policyName}`, async () => {
      // The policy's own two faces agree first — otherwise there is no single
      // route-layer answer to compare with.
      expect(await checkAuthorizationParity(policy, CASES)).toEqual([]);

      let narrowedSomeone = false;
      for (const testCase of CASES) {
        const filter = await policy.subjectScope(testCase.viewer, {});
        const reader = readerFor({
          kind: 'subject',
          principal: testCase.viewer,
          filter,
          unattributedReads: NO_UNATTRIBUTED,
          readsShared: false,
        });
        if (reader !== null) narrowedSomeone = true;
        for (const subject of testCase.subjects) {
          const routeSays = await policy.canRead(testCase.viewer, readSubject(subject), {});
          // No reader means the layer does not narrow this caller at all.
          const listSays =
            reader === null || whereConfines(schema, 'AiUserMemory', { userId: subject }, reader);
          const rowSays = reader === null || rowReadable(schema, 'AiUserMemory', subject, reader);
          expect(
            { listSays, rowSays },
            `${policyName} / ${testCase.label ?? testCase.viewer.userId} / subject ${subject}`
          ).toEqual({ listSays: routeSays, rowSays: routeSays });
        }
      }
      // The comparison is only evidence if some caller was actually narrowed.
      expect(narrowedSomeone).toBe(true);
    });
  }
});
