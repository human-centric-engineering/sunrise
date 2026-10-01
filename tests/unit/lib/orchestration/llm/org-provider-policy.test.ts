/**
 * Core's built-in provider policy at `multi` (§120 t-742).
 *
 * Driven through the call-time gate — the provider manager's Proxy, which
 * every vendor call core makes passes through — and through
 * `resolveEligibleProviders`, which every selection site uses. The org's
 * policy is its `settings.providers` slice, served here by a mocked
 * `prisma.org.findUnique` keyed by org id.
 *
 * @see lib/orchestration/llm/org-provider-policy.ts
 * @see lib/orchestration/llm/provider-eligibility.ts — where it is applied
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
    aiProviderConfig: { findFirst: vi.fn(), findMany: vi.fn() },
    org: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import {
  clearCache,
  getProvider,
  getProviderWithFallbacks,
  registerProviderInstance,
} from '@/lib/orchestration/llm/provider-manager';
import {
  ProviderCallRefusedError,
  registerProviderEligibility,
  resetProviderEligibility,
  resolveEligibleProviders,
  type ProviderEligibilityContext,
} from '@/lib/orchestration/llm/provider-eligibility';
import { forgetOrgProviderPolicy } from '@/lib/orchestration/llm/org-provider-policy';
import type { LlmProvider } from '@/lib/orchestration/llm/provider';
import { getBreaker, resetAllBreakers } from '@/lib/orchestration/llm/circuit-breaker';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { runAsOrg } from '@/lib/tenancy/context';

const NEW_ORG = 'cmorg000000000000000newor';
const GRANTED_ORG = 'cmorg00000000000000grant';
const EU_ORG = 'cmorg00000000000000000eu';

/** Each org's `settings` column. An org absent here does not exist. */
const settingsByOrg: Record<string, unknown> = {
  [INSTALL_ORG_ID]: null,
  [NEW_ORG]: null,
  // Grants name provider ROW ids, never slugs.
  [GRANTED_ORG]: { providers: { approved: ['id-x'] } },
  [EU_ORG]: { providers: { approved: ['id-x', 'id-y', 'id-z'], jurisdictions: ['EU'] } },
};

/** Each slug's provider row: its id and recorded jurisdiction. `z` has none. */
const ROWS: Record<string, { id: string; jurisdiction: string | null }> = {
  x: { id: 'id-x', jurisdiction: 'EU' },
  y: { id: 'id-y', jurisdiction: 'US' },
  z: { id: 'id-z', jurisdiction: null },
};
let rowBySlug: Record<string, { id: string; jurisdiction: string | null }>;

const SLUGS = ['x', 'y', 'z'] as const;

function fakeProvider(name: string) {
  const chat = vi
    .fn()
    .mockResolvedValue({ content: 'ok', usage: { inputTokens: 1, outputTokens: 1 } });
  const provider: LlmProvider = {
    name,
    isLocal: false,
    chat,
    chatStream: () =>
      (async function* () {
        yield* [];
      })(),
    embed: vi.fn().mockResolvedValue([0.1]),
    listModels: vi.fn().mockResolvedValue([]),
    testConnection: vi.fn().mockResolvedValue({ ok: true, models: [] }),
  };
  return { provider, chat };
}

let chats: Record<(typeof SLUGS)[number], ReturnType<typeof vi.fn>>;

/** Sunrise picked the provider (an agent with a blank `provider`). */
const AUTO: ProviderEligibilityContext = { task: 'chat', source: 'primary', primarySlug: null };
/** An operator named it (an explicit `agent.provider`). */
const NAMED: ProviderEligibilityContext = { task: 'chat', source: 'explicit', primarySlug: null };

async function call(orgId: string, slug: string, context = NAMED): Promise<unknown> {
  const provider = await getProvider(slug, context);
  return runAsOrg(orgId, () => provider.chat([], { model: 'm' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMode.value = 'multi';
  clearCache();
  forgetOrgProviderPolicy();
  resetProviderEligibility();
  resetAllBreakers();
  rowBySlug = structuredClone(ROWS);
  vi.mocked(prisma.org.findUnique).mockImplementation((async (args: { where: { id: string } }) =>
    args.where.id in settingsByOrg ? { settings: settingsByOrg[args.where.id] } : null) as never);
  // Rows matched by slug or by name, as the policy asks; each row's name is
  // its slug upper-cased.
  vi.mocked(prisma.aiProviderConfig.findMany).mockImplementation((async (args: {
    where: { OR: [{ slug: { in: string[] } }, { name: { in: string[] } }] };
  }) => {
    const wanted = new Set(args.where.OR.flatMap((clause) => Object.values(clause)[0].in));
    return Object.entries(rowBySlug)
      .map(([slug, row]) => ({ slug, name: slug.toUpperCase(), ...row }))
      .filter((row) => wanted.has(row.slug) || wanted.has(row.name));
  }) as never);
  const built = SLUGS.map((slug) => [slug, fakeProvider(slug)] as const);
  for (const [slug, { provider }] of built) registerProviderInstance(slug, provider);
  chats = Object.fromEntries(built.map(([slug, { chat }]) => [slug, chat])) as typeof chats;
});

afterEach(() => {
  resetProviderEligibility();
});

describe('at multi', () => {
  it("refuses every provider for a new org's agent, auto-picked or named", async () => {
    for (const slug of SLUGS) {
      await expect(call(NEW_ORG, slug, NAMED)).rejects.toBeInstanceOf(ProviderCallRefusedError);
      await expect(call(NEW_ORG, slug, AUTO)).rejects.toBeInstanceOf(ProviderCallRefusedError);
    }
    expect(Object.values(chats).every((chat) => chat.mock.calls.length === 0)).toBe(true);
  });

  it("permits every provider for the install org's agent", async () => {
    for (const slug of SLUGS) await call(INSTALL_ORG_ID, slug);
    expect(SLUGS.map((slug) => chats[slug].mock.calls.length)).toEqual([1, 1, 1]);
    // Open by rule: its settings are never read.
    expect(prisma.org.findUnique).not.toHaveBeenCalled();
  });

  it('permits a granted provider and still refuses one that was not', async () => {
    await call(GRANTED_ORG, 'x');
    await expect(call(GRANTED_ORG, 'y')).rejects.toBeInstanceOf(ProviderCallRefusedError);

    expect(chats.x).toHaveBeenCalledTimes(1);
    expect(chats.y).not.toHaveBeenCalled();
  });

  it('refuses an ungranted provider as an automatic fallback, at selection and at the call', async () => {
    // Selection: the system fill is filtered to the org's set.
    const fill = await runAsOrg(GRANTED_ORG, () =>
      resolveEligibleProviders(['y', 'z'], { task: 'chat', source: 'system', primarySlug: 'x' })
    );
    expect(fill).toEqual([]);

    // The call: with the granted primary's breaker open, failover hands back
    // the fallback, and the gate refuses it rather than send the org's prompt.
    const breaker = getBreaker('x');
    for (let i = 0; i < 10; i++) breaker.recordFailure();
    const { provider, usedSlug } = await runAsOrg(GRANTED_ORG, () =>
      getProviderWithFallbacks('x', ['y'], {
        task: 'chat',
        primary: 'explicit',
        fallbacks: 'system',
      })
    );
    expect(usedSlug).toBe('y');
    await expect(
      runAsOrg(GRANTED_ORG, () => provider.chat([], { model: 'm' }))
    ).rejects.toBeInstanceOf(ProviderCallRefusedError);
    expect(chats.y).not.toHaveBeenCalled();
  });

  it('holds an org to its jurisdictions: another one, or none recorded, is refused', async () => {
    await call(EU_ORG, 'x');
    await expect(call(EU_ORG, 'y')).rejects.toBeInstanceOf(ProviderCallRefusedError);
    await expect(call(EU_ORG, 'z')).rejects.toBeInstanceOf(ProviderCallRefusedError);

    expect(chats.x).toHaveBeenCalledTimes(1);
    expect(chats.y).not.toHaveBeenCalled();
    expect(chats.z).not.toHaveBeenCalled();
  });

  it('matches a jurisdiction recorded in another case', async () => {
    rowBySlug.x = { id: 'id-x', jurisdiction: 'eu' };
    await call(EU_ORG, 'x');
    expect(chats.x).toHaveBeenCalledTimes(1);
  });

  it('keeps a grant when its provider is renamed: the grant names the row, not the slug', async () => {
    rowBySlug['x-renamed'] = rowBySlug.x;
    delete rowBySlug.x;
    registerProviderInstance('x-renamed', fakeProvider('x-renamed').provider);

    const provider = await getProvider('x-renamed', NAMED);
    await runAsOrg(GRANTED_ORG, () => provider.chat([], { model: 'm' }));
    // And the old slug, with no row behind it, permits nothing.
    await expect(call(GRANTED_ORG, 'x')).rejects.toBeInstanceOf(ProviderCallRefusedError);
  });

  it('does not hand a grant to a new provider created under a granted slug', async () => {
    // `x` deleted and re-created: same slug, a different row.
    rowBySlug.x = { id: 'id-x-new', jurisdiction: 'EU' };

    await expect(call(GRANTED_ORG, 'x')).rejects.toBeInstanceOf(ProviderCallRefusedError);
    expect(chats.x).not.toHaveBeenCalled();
  });

  it('judges a candidate given by provider name by the row it names', async () => {
    // A fallback list may hold a row's name; getProvider resolves it, so the
    // policy must too, rather than refuse a provider the org was granted.
    expect(
      await runAsOrg(GRANTED_ORG, () =>
        resolveEligibleProviders(['X', 'Y'], { task: 'chat', source: 'explicit', primarySlug: 'z' })
      )
    ).toEqual(['X']);
  });

  it('refuses everything for an org that does not exist', async () => {
    await expect(call('cmorg0000000000000missing', 'x')).rejects.toBeInstanceOf(
      ProviderCallRefusedError
    );
  });

  it('refuses everything when the policy cannot be read, and says why', async () => {
    vi.mocked(prisma.org.findUnique).mockRejectedValue(new Error('connection reset'));

    await expect(call(GRANTED_ORG, 'x')).rejects.toBeInstanceOf(ProviderCallRefusedError);
    expect(logger.error).toHaveBeenCalledWith(
      'org provider policy could not be read; denying every candidate',
      expect.objectContaining({ orgId: GRANTED_ORG, error: 'connection reset' })
    );
  });

  it('treats a malformed policy as approving nothing', async () => {
    vi.mocked(prisma.org.findUnique).mockResolvedValue({
      settings: { providers: { approved: 'x' } },
    } as never);

    await expect(call(GRANTED_ORG, 'x')).rejects.toBeInstanceOf(ProviderCallRefusedError);
  });
});

describe('a fork rule', () => {
  it('can narrow the org set', async () => {
    registerProviderEligibility((candidates) => candidates.filter((slug) => slug !== 'x'));
    await expect(call(GRANTED_ORG, 'x')).rejects.toBeInstanceOf(ProviderCallRefusedError);
  });

  it('cannot widen it: a rule that permits everything still leaves the org to its set', async () => {
    const asked: (readonly string[])[] = [];
    registerProviderEligibility((candidates) => {
      asked.push(candidates);
      return [...SLUGS];
    });

    await expect(call(GRANTED_ORG, 'y')).rejects.toBeInstanceOf(ProviderCallRefusedError);
    expect(await runAsOrg(GRANTED_ORG, () => resolveEligibleProviders([...SLUGS], AUTO))).toEqual([
      'x',
    ]);
    // It is handed only what core's rule permitted.
    expect(asked).toContainEqual(['x']);
    expect(asked.flat()).not.toContain('y');
  });
});

describe('at single', () => {
  it('permits every provider for every org and reads no policy', async () => {
    mockMode.value = 'single';
    for (const slug of SLUGS) {
      await call(NEW_ORG, slug);
      await call(GRANTED_ORG, slug);
    }
    expect(SLUGS.map((slug) => chats[slug].mock.calls.length)).toEqual([2, 2, 2]);
    expect(prisma.org.findUnique).not.toHaveBeenCalled();
    expect(prisma.aiProviderConfig.findMany).not.toHaveBeenCalled();
  });
});

describe('the cache', () => {
  it('reads an org policy once, and again after it is forgotten', async () => {
    await call(GRANTED_ORG, 'x');
    await call(GRANTED_ORG, 'x');
    expect(prisma.org.findUnique).toHaveBeenCalledTimes(1);

    forgetOrgProviderPolicy(GRANTED_ORG);
    await call(GRANTED_ORG, 'x');
    expect(prisma.org.findUnique).toHaveBeenCalledTimes(2);
  });

  it('applies a revoked grant once forgotten', async () => {
    await call(GRANTED_ORG, 'x');
    vi.mocked(prisma.org.findUnique).mockResolvedValue({
      settings: { providers: { approved: [] } },
    } as never);
    forgetOrgProviderPolicy(GRANTED_ORG);

    await expect(call(GRANTED_ORG, 'x')).rejects.toBeInstanceOf(ProviderCallRefusedError);
  });

  it('applies a changed jurisdiction once the provider manager clears the row', async () => {
    await call(EU_ORG, 'x');
    rowBySlug.x = { id: 'id-x', jurisdiction: 'US' };
    // Re-registered because clearCache drops the instance too.
    clearCache('x');
    registerProviderInstance('x', fakeProvider('x').provider);
    await expect(call(EU_ORG, 'x')).rejects.toBeInstanceOf(ProviderCallRefusedError);
  });

  it('shares one lookup between concurrent misses', async () => {
    await Promise.all([call(GRANTED_ORG, 'x'), call(GRANTED_ORG, 'x'), call(GRANTED_ORG, 'x')]);
    expect(prisma.org.findUnique).toHaveBeenCalledTimes(1);
  });

  it('does not let a read that started before a revocation cache the old grant', async () => {
    // A read in flight when the PUT lands: it answers from the old policy.
    let finishOldRead!: (row: unknown) => void;
    vi.mocked(prisma.org.findUnique).mockImplementationOnce(
      () => new Promise((resolve) => (finishOldRead = resolve)) as never
    );
    const inFlight = call(GRANTED_ORG, 'x');
    await vi.waitFor(() => expect(prisma.org.findUnique).toHaveBeenCalledTimes(1));

    // The revocation is written and this process told.
    vi.mocked(prisma.org.findUnique).mockResolvedValue({
      settings: { providers: { approved: [] } },
    } as never);
    forgetOrgProviderPolicy(GRANTED_ORG);
    finishOldRead({ settings: { providers: { approved: ['id-x'] } } });
    await inFlight;

    // The next call reads the revocation, not the old answer.
    await expect(call(GRANTED_ORG, 'x')).rejects.toBeInstanceOf(ProviderCallRefusedError);
  });

  it('does not cache a failed read', async () => {
    vi.mocked(prisma.org.findUnique).mockRejectedValueOnce(new Error('connection reset'));
    await expect(call(GRANTED_ORG, 'x')).rejects.toBeInstanceOf(ProviderCallRefusedError);

    await call(GRANTED_ORG, 'x');
    expect(chats.x).toHaveBeenCalledTimes(1);
  });

  it('reads the policy again after the TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await call(GRANTED_ORG, 'x');
      vi.setSystemTime(Date.now() + 61_000);
      await call(GRANTED_ORG, 'x');
      expect(prisma.org.findUnique).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
