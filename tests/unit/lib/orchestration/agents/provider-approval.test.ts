/**
 * Write-time provider approval for agents (§120 t-743), against core's real
 * org provider policy: only Prisma and the tenancy mode are stubbed.
 *
 * @see lib/orchestration/agents/provider-approval.ts
 * @see lib/orchestration/llm/org-provider-policy.ts — `unapprovedProviders`
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockMode = vi.hoisted(() => ({ value: 'multi' }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, key) =>
        key === 'TENANCY_MODE' ? mockMode.value : (Reflect.get(target, key) as unknown),
    }),
  };
});

vi.mock('@/lib/db/client', () => ({
  prisma: {
    org: { findUnique: vi.fn() },
    aiProviderConfig: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from '@/lib/db/client';
import { ValidationError } from '@/lib/api/errors';
import {
  assertAgentProvidersApproved,
  findUnapprovedAgentProviders,
  unapprovedAgentProvidersWarning,
} from '@/lib/orchestration/agents/provider-approval';
import {
  forgetOrgProviderPolicy,
  forgetProviderRow,
  unapprovedProviders,
} from '@/lib/orchestration/llm/org-provider-policy';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { runAsOrg } from '@/lib/tenancy/context';

const ORG = 'cmorg00000000000000grant';

/** The org is approved for `anthropic` only; `openai` and `voyage` exist too. */
const ROWS = [
  { id: 'id-anthropic', slug: 'anthropic', name: 'Anthropic', jurisdiction: null },
  { id: 'id-openai', slug: 'openai', name: 'OpenAI', jurisdiction: null },
  { id: 'id-voyage', slug: 'voyage', name: 'Voyage', jurisdiction: null },
];

const inOrg = <T>(fn: () => Promise<T>) => runAsOrg(ORG, fn);

beforeEach(() => {
  vi.clearAllMocks();
  mockMode.value = 'multi';
  forgetOrgProviderPolicy();
  forgetProviderRow();
  vi.mocked(prisma.org.findUnique).mockResolvedValue({
    settings: { providers: { approved: ['id-anthropic'] } },
  } as never);
  vi.mocked(prisma.aiProviderConfig.findMany).mockImplementation((async (args: {
    where: { OR: [{ slug: { in: string[] } }, { name: { in: string[] } }] };
  }) => ROWS.filter((row) => args.where.OR[0].slug.in.includes(row.slug))) as never);
});

describe('unapprovedProviders', () => {
  it('names what the org may not use, in order, once each, ignoring a blank (inherited) provider', async () => {
    expect(
      await inOrg(() => unapprovedProviders(['voyage', '', 'anthropic', 'openai', 'voyage']))
    ).toEqual(['voyage', 'openai']);
  });

  it('refuses nothing at single, and reads no policy', async () => {
    mockMode.value = 'single';
    expect(await inOrg(() => unapprovedProviders(['openai', 'voyage']))).toEqual([]);
    expect(prisma.org.findUnique).not.toHaveBeenCalled();
  });

  it('refuses nothing for the install org', async () => {
    expect(await runAsOrg(INSTALL_ORG_ID, () => unapprovedProviders(['openai']))).toEqual([]);
  });

  it('throws when the policy cannot be read, rather than approving', async () => {
    vi.mocked(prisma.org.findUnique).mockRejectedValue(new Error('connection reset'));
    await expect(inOrg(() => unapprovedProviders(['openai']))).rejects.toThrow('connection reset');
  });
});

describe('findUnapprovedAgentProviders', () => {
  it('checks only what a write introduces', async () => {
    const found = await inOrg(() =>
      findUnapprovedAgentProviders(
        { provider: 'openai', fallbackProviders: ['voyage', 'openai'] },
        // Already held: the provider, and one fallback.
        { provider: 'openai', fallbackProviders: ['voyage'] }
      )
    );
    expect(found).toEqual({ provider: [], fallbackProviders: ['openai'] });
  });

  it('checks nothing for a field the write leaves out', async () => {
    expect(await inOrg(() => findUnapprovedAgentProviders({}))).toEqual({
      provider: [],
      fallbackProviders: [],
    });
  });
});

describe('assertAgentProvidersApproved', () => {
  it('passes an agent naming only approved providers', async () => {
    await expect(
      inOrg(() => assertAgentProvidersApproved({ provider: 'anthropic', fallbackProviders: [] }))
    ).resolves.toBeUndefined();
  });

  it('refuses with a 400 placing each refusal on its field, and naming every slug', async () => {
    const error = await inOrg(() =>
      assertAgentProvidersApproved({ provider: 'openai', fallbackProviders: ['voyage'] })
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({
      status: 400,
      message: expect.stringContaining('"openai", "voyage"'),
      details: {
        unapprovedProviders: ['openai', 'voyage'],
        errors: [
          { path: 'provider', message: expect.stringContaining('"openai"') },
          { path: 'fallbackProviders', message: expect.stringContaining('"voyage"') },
        ],
      },
    });
  });
});

describe('unapprovedAgentProvidersWarning', () => {
  it('names the agent and every non-approved provider it names', async () => {
    expect(
      await inOrg(() =>
        unapprovedAgentProvidersWarning('support', {
          provider: 'openai',
          fallbackProviders: ['anthropic', 'voyage'],
        })
      )
    ).toBe(
      'Agent \'support\': imported, but this organisation is not approved to use "openai", "voyage" — its calls are refused until a platform admin grants them'
    );
  });

  it('is null when everything is approved', async () => {
    expect(
      await inOrg(() => unapprovedAgentProvidersWarning('support', { provider: 'anthropic' }))
    ).toBeNull();
  });
});
