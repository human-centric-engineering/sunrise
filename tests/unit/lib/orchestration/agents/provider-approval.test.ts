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
  importedAgentProviderWarnings,
  strandedAgentProviders,
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
        { provider: 'openai', fallbackProviders: ['openai', 'voyage'] },
        // Held: the primary. The fallback `voyage` is new.
        { provider: 'openai', fallbackProviders: [] }
      )
    );
    expect(found).toEqual({ provider: [], fallbackProviders: ['voyage'] });
  });

  it('counts a held primary as held: keeping it as a fallback, or swapping the two, introduces nothing', async () => {
    const current = { provider: 'openai', fallbackProviders: ['voyage'] };
    expect(
      await inOrg(() =>
        findUnapprovedAgentProviders({ provider: 'voyage', fallbackProviders: ['openai'] }, current)
      )
    ).toEqual({ provider: [], fallbackProviders: [] });
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

describe('a request with no organisation in scope (multi)', () => {
  it('is refused with a message that says so, not one blaming an org', async () => {
    const error = await assertAgentProvidersApproved({ provider: 'anthropic' }).catch(
      (err: unknown) => err
    );
    expect(error).toMatchObject({
      status: 400,
      message: expect.stringContaining('No organisation is in scope for this request'),
    });
  });
});

describe('the provider-row cache', () => {
  it('does not keep a miss: a slug with no row is looked up again', async () => {
    await inOrg(() => unapprovedProviders(['nonexistent']));
    await inOrg(() => unapprovedProviders(['nonexistent']));
    expect(prisma.aiProviderConfig.findMany).toHaveBeenCalledTimes(2);
  });

  it('keeps a hit', async () => {
    await inOrg(() => unapprovedProviders(['openai']));
    await inOrg(() => unapprovedProviders(['openai']));
    expect(prisma.aiProviderConfig.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('importedAgentProviderWarnings', () => {
  it('warns per agent, naming every non-approved provider it names', async () => {
    const { bySlug, unchecked } = await inOrg(() =>
      importedAgentProviderWarnings([
        { slug: 'support', provider: 'openai', fallbackProviders: ['anthropic', 'voyage'] },
        { slug: 'fine', provider: 'anthropic' },
      ])
    );

    expect(unchecked).toBeNull();
    expect([...bySlug.entries()]).toEqual([
      [
        'support',
        'Agent \'support\': imported, but this organisation is not approved to use "openai", "voyage" — its calls are refused until a platform admin grants them',
      ],
    ]);
  });

  it('reads the policy once for the whole import', async () => {
    await inOrg(() =>
      importedAgentProviderWarnings([
        { slug: 'a', provider: 'openai' },
        { slug: 'b', provider: 'voyage' },
      ])
    );
    expect(prisma.org.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.aiProviderConfig.findMany).toHaveBeenCalledTimes(1);
  });

  it('reports an unreadable policy as one warning, without failing the import', async () => {
    vi.mocked(prisma.org.findUnique).mockRejectedValue(new Error('connection reset'));

    const { bySlug, unchecked } = await inOrg(() =>
      importedAgentProviderWarnings([{ slug: 'a', provider: 'openai' }])
    );

    expect(bySlug.size).toBe(0);
    expect(unchecked).toContain('could not be read');
  });
});

describe('strandedAgentProviders', () => {
  it('names, per agent, every provider it holds that the org is not approved for', async () => {
    const stranded = await inOrg(() =>
      strandedAgentProviders([
        { id: 'a1', provider: 'openai', fallbackProviders: ['anthropic', 'voyage'] },
        { id: 'a2', provider: 'anthropic', fallbackProviders: ['voyage'] },
        { id: 'a3', provider: 'anthropic', fallbackProviders: [] },
        // Inherits its provider: nothing pinned, so nothing stranded.
        { id: 'a4', provider: '', fallbackProviders: null },
      ])
    );

    expect(stranded).toEqual(
      new Map([
        ['a1', ['openai', 'voyage']],
        ['a2', ['voyage']],
        ['a3', []],
        ['a4', []],
      ])
    );
  });

  it('reads the policy once for the whole page', async () => {
    await inOrg(() =>
      strandedAgentProviders([
        { id: 'a1', provider: 'openai' },
        { id: 'a2', provider: 'voyage' },
      ])
    );
    expect(prisma.org.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.aiProviderConfig.findMany).toHaveBeenCalledTimes(1);
  });

  it('strands nothing at single', async () => {
    mockMode.value = 'single';
    expect(await inOrg(() => strandedAgentProviders([{ id: 'a1', provider: 'openai' }]))).toEqual(
      new Map([['a1', []]])
    );
  });

  it('answers null, not "all clear", when the policy cannot be read', async () => {
    vi.mocked(prisma.org.findUnique).mockRejectedValue(new Error('connection reset'));
    expect(
      await inOrg(() => strandedAgentProviders([{ id: 'a1', provider: 'openai' }]))
    ).toBeNull();
  });
});
