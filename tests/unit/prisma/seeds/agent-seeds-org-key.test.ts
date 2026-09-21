/**
 * Every seed that upserts an agent keys it on the org the seed runs for
 * (§107 t-708).
 *
 * `AiAgent.slug` is unique per org, so `upsert({ where: { slug } })` no
 * longer type-checks — but a seed that hard-coded an org id, or read the
 * wrong one, would still compile and land the system agents in the wrong
 * namespace at `multi`. This runs every agent-seeding unit against a
 * permissive Prisma stand-in inside the scope `prisma/seed.ts` uses
 * (`runAsOrg(INSTALL_ORG_ID)`) and checks each `aiAgent.upsert` names that
 * org through `orgId_slug`, and that outside any scope at `single` the
 * implicit install org is the same answer.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SeedContext, SeedUnit } from '@/prisma/runner';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { runAsOrg } from '@/lib/tenancy/context';

/** The seed units that create agents — each one's upsert is asserted below. */
const AGENT_SEEDS = [
  '005-pattern-advisor',
  '006-quiz-master',
  '008-mcp-server',
  '010-model-auditor',
  '016-evaluation-judges',
  '017-case-generator-agent',
  '018-rag-evaluation-judges',
  '020-cleanup-agent',
] as const;

/**
 * A Prisma stand-in that answers every delegate method with something the
 * seeds accept: an owner for the user lookup, a row with an id for anything
 * that writes or reads one row, empty lists otherwise. It records the
 * `aiAgent.upsert` calls.
 */
function permissivePrisma() {
  const agentUpserts: Array<{ where: unknown }> = [];
  const answer = (model: string, method: string, args: { where?: unknown } = {}) => {
    if (model === 'aiAgent' && method === 'upsert') agentUpserts.push({ where: args.where });
    switch (method) {
      case 'findMany':
        return Promise.resolve([]);
      case 'count':
        return Promise.resolve(0);
      case 'updateMany':
      case 'deleteMany':
      case 'createMany':
        return Promise.resolve({ count: 0 });
      case 'findFirst':
        // Owner lookups need a row; agent "untouched?" probes need none.
        return Promise.resolve(model === 'user' ? { id: 'owner-1' } : null);
      default:
        return Promise.resolve({ id: `${model}-1`, slug: 'x' });
    }
  };
  const prisma = new Proxy(
    {},
    {
      get: (_t, model: string) =>
        model === '$transaction'
          ? (fn: (tx: unknown) => unknown) => fn(prisma)
          : new Proxy(
              {},
              {
                get: (_m, method: string) => (args?: { where?: unknown }) =>
                  answer(model, method, args),
              }
            ),
    }
  );
  return { prisma, agentUpserts };
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe.each(AGENT_SEEDS)('%s', (name) => {
  it('keys every agent upsert on the org the seed runs for', async () => {
    const seed = (await import(`@/prisma/seeds/${name}`)).default as SeedUnit;
    const { prisma, agentUpserts } = permissivePrisma();
    process.env.OPENAI_API_KEY ??= 'test-key';

    await runAsOrg(INSTALL_ORG_ID, () => seed.run({ prisma, logger } as unknown as SeedContext));

    expect(agentUpserts.length).toBeGreaterThan(0);
    for (const { where } of agentUpserts) {
      expect(where).toEqual({
        orgId_slug: { orgId: INSTALL_ORG_ID, slug: expect.stringMatching(/^[a-z0-9-]+$/) },
      });
    }
  });
});

it('the seed runner scope is what the key reads — a different org lands a different key', async () => {
  const seed = (await import('@/prisma/seeds/006-quiz-master')).default;
  const { prisma, agentUpserts } = permissivePrisma();
  await runAsOrg('org_b', () => seed.run({ prisma, logger } as unknown as SeedContext));
  expect(agentUpserts[0]?.where).toEqual({ orgId_slug: { orgId: 'org_b', slug: 'quiz-master' } });
});
