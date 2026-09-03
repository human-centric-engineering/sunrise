/**
 * Unit Tests: lib/orchestration/llm/agent-resolver
 *
 * Test Coverage:
 * - resolveAgentProviderAndModel: explicit provider + model pass through unchanged
 * - resolveAgentProviderAndModel: empty agent.provider + model fall back to first
 *   active provider with key set + system default-chat model
 * - resolveAgentProviderAndModel: throws NoProviderConfiguredError when no
 *   active provider has a reachable key
 * - resolveAgentProviderAndModel: only one of provider/model empty — fills the
 *   missing side and keeps the explicit side
 * - resolveAgentProviderAndModel: agent's explicit fallbackProviders win even
 *   when the primary provider is filled by the resolver
 * - resolveAgentProviderAndModel: empty fallbackProviders + empty primary →
 *   resolver attaches up to 3 system fallbacks, excluding the chosen primary
 *
 * @see lib/orchestration/llm/agent-resolver.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiProviderConfig: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  isApiKeyEnvVarSet: vi.fn((envVar: string | null) => {
    if (!envVar) return false;
    return envVar === 'PRESENT_KEY' || envVar === 'OTHER_PRESENT_KEY';
  }),
}));

vi.mock('@/lib/orchestration/llm/settings-resolver', () => ({
  getDefaultModelForTask: vi.fn(async (task: string) => {
    return task === 'chat' ? 'system-chat-model' : `system-${task}-model`;
  }),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { prisma } from '@/lib/db/client';
import {
  resolveAgentProviderAndModel,
  NoProviderConfiguredError,
  NoEligibleProviderError,
  type ResolvableAgent,
} from '@/lib/orchestration/llm/agent-resolver';
import {
  registerProviderEligibility,
  resetProviderEligibility,
} from '@/lib/orchestration/llm/provider-eligibility';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

interface FakeProviderRow {
  slug: string;
  apiKeyEnvVar: string | null;
  isLocal: boolean;
  isActive: boolean;
  createdAt: Date;
}

function makeProviderRow(overrides: Partial<FakeProviderRow> = {}): FakeProviderRow {
  return {
    slug: 'anthropic',
    apiKeyEnvVar: 'PRESENT_KEY',
    isLocal: false,
    isActive: true,
    createdAt: new Date('2026-04-15T00:00:00Z'),
    ...overrides,
  };
}

function makeAgent(overrides: Partial<ResolvableAgent> = {}): ResolvableAgent {
  return {
    provider: '',
    model: '',
    fallbackProviders: [],
    ...overrides,
  };
}

function setProviders(rows: FakeProviderRow[]): void {
  vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue(rows as never);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('resolveAgentProviderAndModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // FORK NOTE: `agent-resolver` auto-wires `lib/app/providers.ts` at module
    // load, so a fork that fills that seam would otherwise have its live rule
    // applied to these core assertions and see them fail in a file it never
    // touched — the #480/#525/#530 coupling class. Clearing per test keeps
    // this file about the resolver rather than about the fork's policy.
    resetProviderEligibility();
  });

  describe('explicit values pass through', () => {
    it('returns agent.provider + agent.model unchanged when both are set', async () => {
      const agent = makeAgent({
        provider: 'openai',
        model: 'gpt-4o-mini',
        fallbackProviders: ['anthropic'],
      });

      const result = await resolveAgentProviderAndModel(agent, 'chat');

      expect(result).toEqual({
        providerSlug: 'openai',
        model: 'gpt-4o-mini',
        fallbacks: ['anthropic'],
      });
      expect(prisma.aiProviderConfig.findMany).not.toHaveBeenCalled();
    });
  });

  describe('empty primary binding', () => {
    it('falls back to the first active provider whose env key is set', async () => {
      setProviders([
        makeProviderRow({ slug: 'openai', apiKeyEnvVar: 'MISSING_KEY' }),
        makeProviderRow({
          slug: 'anthropic',
          apiKeyEnvVar: 'PRESENT_KEY',
          createdAt: new Date('2026-04-16T00:00:00Z'),
        }),
      ]);

      const result = await resolveAgentProviderAndModel(makeAgent(), 'chat');

      expect(result.providerSlug).toBe('anthropic');
      expect(result.model).toBe('system-chat-model');
    });

    it('treats isLocal providers as reachable without an env key', async () => {
      setProviders([makeProviderRow({ slug: 'ollama-local', apiKeyEnvVar: null, isLocal: true })]);

      const result = await resolveAgentProviderAndModel(makeAgent(), 'chat');

      expect(result.providerSlug).toBe('ollama-local');
      expect(result.model).toBe('system-chat-model');
    });

    it('throws NoProviderConfiguredError when no provider has a reachable key', async () => {
      setProviders([
        makeProviderRow({ slug: 'openai', apiKeyEnvVar: 'MISSING_KEY' }),
        makeProviderRow({ slug: 'anthropic', apiKeyEnvVar: 'ALSO_MISSING' }),
      ]);

      await expect(resolveAgentProviderAndModel(makeAgent(), 'chat')).rejects.toBeInstanceOf(
        NoProviderConfiguredError
      );
    });

    it('skips inactive providers even if their key is set', async () => {
      // findMany is filtered by isActive: true, so an inactive row never
      // reaches the resolver. Verify the where clause includes isActive.
      setProviders([]);

      await expect(resolveAgentProviderAndModel(makeAgent(), 'chat')).rejects.toBeInstanceOf(
        NoProviderConfiguredError
      );

      expect(prisma.aiProviderConfig.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isActive: true } })
      );
    });
  });

  describe('partial bindings', () => {
    it('keeps explicit provider and fills empty model from system defaults', async () => {
      setProviders([makeProviderRow()]);

      const result = await resolveAgentProviderAndModel(
        makeAgent({ provider: 'openai', model: '' }),
        'chat'
      );

      expect(result.providerSlug).toBe('openai');
      expect(result.model).toBe('system-chat-model');
    });

    it('keeps explicit model and fills empty provider from active candidates', async () => {
      setProviders([makeProviderRow({ slug: 'anthropic' })]);

      const result = await resolveAgentProviderAndModel(
        makeAgent({ provider: '', model: 'claude-opus-4-6' }),
        'chat'
      );

      expect(result.providerSlug).toBe('anthropic');
      expect(result.model).toBe('claude-opus-4-6');
    });
  });

  describe('fallback list behaviour', () => {
    it('uses the agent fallbackProviders when explicitly set', async () => {
      setProviders([makeProviderRow({ slug: 'anthropic' })]);

      const result = await resolveAgentProviderAndModel(
        makeAgent({ fallbackProviders: ['custom-fallback'] }),
        'chat'
      );

      expect(result.fallbacks).toEqual(['custom-fallback']);
    });

    it('attaches up to 3 system fallbacks when the agent fallback list is empty', async () => {
      const rows = [
        makeProviderRow({ slug: 'anthropic', apiKeyEnvVar: 'PRESENT_KEY' }),
        makeProviderRow({
          slug: 'openai',
          apiKeyEnvVar: 'OTHER_PRESENT_KEY',
          createdAt: new Date('2026-04-16T00:00:00Z'),
        }),
        makeProviderRow({
          slug: 'ollama-local',
          apiKeyEnvVar: null,
          isLocal: true,
          createdAt: new Date('2026-04-17T00:00:00Z'),
        }),
      ];
      setProviders(rows);

      const result = await resolveAgentProviderAndModel(makeAgent(), 'chat');

      expect(result.providerSlug).toBe('anthropic');
      expect(result.fallbacks).toEqual(['openai', 'ollama-local']);
    });
  });
});

// ─── Provider eligibility seam ────────────────────────────────────────────────

describe('resolveAgentProviderAndModel — provider eligibility seam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProviderEligibility();
  });

  afterEach(() => {
    resetProviderEligibility();
  });

  const threeProviders = [
    makeProviderRow({ slug: 'anthropic', createdAt: new Date('2026-04-15T00:00:00Z') }),
    makeProviderRow({
      slug: 'openai',
      apiKeyEnvVar: 'OTHER_PRESENT_KEY',
      createdAt: new Date('2026-04-16T00:00:00Z'),
    }),
    makeProviderRow({
      slug: 'ollama',
      apiKeyEnvVar: null,
      isLocal: true,
      createdAt: new Date('2026-04-17T00:00:00Z'),
    }),
  ];

  it("default (nothing registered) returns exactly today's candidate set", async () => {
    // The whole "inert at single" claim in one assertion. If this drifts, every
    // single-tenant install has silently changed provider routing.
    setProviders(threeProviders);

    const result = await resolveAgentProviderAndModel(makeAgent(), 'chat');

    expect(result.providerSlug).toBe('anthropic');
    expect(result.fallbacks).toEqual(['openai', 'ollama']);
  });

  it('a restrictive set excludes a provider from the SYSTEM fallback fill', async () => {
    setProviders(threeProviders);
    registerProviderEligibility((candidates) => candidates.filter((s) => s !== 'openai'));

    const result = await resolveAgentProviderAndModel(makeAgent(), 'chat');

    // Fails against the pre-change resolver, which returned both.
    expect(result.fallbacks).toEqual(['ollama']);
    expect(result.fallbacks).not.toContain('openai');
    // The primary is untouched — this seam filters fallbacks only.
    expect(result.providerSlug).toBe('anthropic');
  });

  it('a restrictive set excludes a provider from an EXPLICIT fallback list', async () => {
    // The path that matters most, and the one the resolver's shape hides: an
    // agent with BOTH provider and model set returns from an early exit that
    // never reaches the candidates block. Filtering only the system fill would
    // leave every fully-configured agent — the majority — unconstrained.
    setProviders(threeProviders);
    registerProviderEligibility((candidates) => candidates.filter((s) => s !== 'openai'));

    const result = await resolveAgentProviderAndModel(
      makeAgent({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        fallbackProviders: ['openai', 'ollama'],
      }),
      'chat'
    );

    expect(result.fallbacks).toEqual(['ollama']);
    expect(result.providerSlug).toBe('anthropic');
    expect(result.model).toBe('claude-sonnet-4-6');
  });

  it('filters an explicit list on the candidates path too, not just the early exit', async () => {
    // Same agent-supplied list, reached by the other route (model empty, so the
    // resolver falls through). Both routes must apply the rule or the seam's
    // coverage depends on which fields an operator happened to fill in.
    setProviders(threeProviders);
    registerProviderEligibility((candidates) => candidates.filter((s) => s !== 'openai'));

    const result = await resolveAgentProviderAndModel(
      makeAgent({ provider: 'anthropic', model: '', fallbackProviders: ['openai', 'ollama'] }),
      'chat'
    );

    expect(result.fallbacks).toEqual(['ollama']);
  });

  it('tells the rule which kind of list it is filtering', async () => {
    // `source` is the field a fork needs to be stricter about the system fill
    // than about a list an operator wrote down. If it were always the same
    // value the distinction would be undeliverable.
    setProviders(threeProviders);
    const seen: string[] = [];
    registerProviderEligibility((candidates, ctx) => {
      seen.push(ctx.source);
      return candidates;
    });

    await resolveAgentProviderAndModel(makeAgent(), 'chat');
    await resolveAgentProviderAndModel(
      makeAgent({ provider: 'anthropic', model: 'm', fallbackProviders: ['openai'] }),
      'chat'
    );

    // 'primary' first: the auto-pick is filtered before the fallbacks it then
    // excludes itself from. The second agent names its provider explicitly, so
    // no 'primary' call is made for it — that choice is not ours to override.
    expect(seen).toEqual(['primary', 'system', 'explicit']);
  });

  it('an agent with an explicit provider survives a throwing rule, minus fallbacks', async () => {
    // The graceful half. Its provider is a recorded choice, not ours to
    // override, so a broken policy costs it only the safety net.
    setProviders(threeProviders);
    registerProviderEligibility(() => {
      throw new Error('policy lookup failed');
    });

    const result = await resolveAgentProviderAndModel(
      makeAgent({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        fallbackProviders: ['openai'],
      }),
      'chat'
    );

    expect(result.providerSlug).toBe('anthropic');
    expect(result.fallbacks).toEqual([]);
  });

  it('an auto-picking agent FAILS when the rule throws, rather than picking anyway', async () => {
    // The harsh half, and deliberate. With no provider on the agent there is no
    // safe default to fall back to — every option is one the policy did not
    // approve. A restriction that cannot be evaluated must not be read as
    // permission, so this errors instead of routing somewhere unapproved.
    //
    // Worth seeing plainly: a fork whose policy lookup is broken takes an
    // outage for its provider-less agents. That is the cost of fail-closed, and
    // the error names the cause and the fix rather than surfacing as a generic
    // provider failure.
    setProviders(threeProviders);
    registerProviderEligibility(() => {
      throw new Error('policy lookup failed');
    });

    await expect(resolveAgentProviderAndModel(makeAgent(), 'chat')).rejects.toThrow(
      NoEligibleProviderError
    );
  });

  it('constrains the provider Sunrise picks when the agent names none', async () => {
    // Point 1: nobody's intent is overridden here — Sunrise is choosing on the
    // caller's behalf, so choosing outside their policy would be our error.
    setProviders(threeProviders);
    registerProviderEligibility((candidates) => candidates.filter((s) => s !== 'anthropic'));

    const result = await resolveAgentProviderAndModel(makeAgent(), 'chat');

    // 'anthropic' is first by createdAt and would have been picked before.
    expect(result.providerSlug).toBe('openai');
    expect(result.fallbacks).not.toContain('anthropic');
  });

  it('does NOT override a provider the operator named explicitly', async () => {
    // The deliberate boundary. Rerouting a recorded choice would make an agent
    // answer from a provider its own configuration does not name. Enforcement
    // for this case belongs at write time — see provider-eligibility.ts.
    setProviders(threeProviders);
    registerProviderEligibility((candidates) => candidates.filter((s) => s !== 'anthropic'));

    const result = await resolveAgentProviderAndModel(
      makeAgent({ provider: 'anthropic', model: 'claude-sonnet-4-6' }),
      'chat'
    );

    expect(result.providerSlug).toBe('anthropic');
  });

  it('errors distinctly when providers exist but none is permitted', async () => {
    // NOT NoProviderConfiguredError: everything is set up. Reporting "no
    // provider is configured" would send an operator to the setup wizard to
    // re-add providers that are already there.
    setProviders(threeProviders);
    registerProviderEligibility(() => []);

    await expect(resolveAgentProviderAndModel(makeAgent(), 'chat')).rejects.toThrow(
      /permitted for this request/
    );
  });

  it('caps the system fill AFTER filtering, so eligible providers keep their slots', async () => {
    // The ordering bug this was written for: with the cap applied first,
    // ineligible providers occupy slots and the list silently shrinks below
    // what the policy actually permits.
    //
    // Five providers, primary is p1, so the fallback candidates are p2..p5 and
    // the cap is 3. A rule permitting only p4 and p5:
    //   cap-then-filter → propose [p2,p3,p4], filter → ['p4']       (one lost)
    //   filter-then-cap → filter [p4,p5], cap → ['p4','p5']         (correct)
    // Every other test here uses exactly three providers, so the cap is never
    // reached and none of them can tell these apart.
    setProviders([
      makeProviderRow({ slug: 'p1', createdAt: new Date('2026-04-15T00:00:00Z') }),
      makeProviderRow({ slug: 'p2', createdAt: new Date('2026-04-16T00:00:00Z') }),
      makeProviderRow({ slug: 'p3', createdAt: new Date('2026-04-17T00:00:00Z') }),
      makeProviderRow({ slug: 'p4', createdAt: new Date('2026-04-18T00:00:00Z') }),
      makeProviderRow({ slug: 'p5', createdAt: new Date('2026-04-19T00:00:00Z') }),
    ]);
    registerProviderEligibility((candidates, ctx) =>
      ctx.source === 'primary' ? candidates : candidates.filter((s) => s === 'p4' || s === 'p5')
    );

    const result = await resolveAgentProviderAndModel(makeAgent(), 'chat');

    expect(result.providerSlug).toBe('p1');
    expect(result.fallbacks).toEqual(['p4', 'p5']);
  });

  it('still caps the system fill at three when everything is eligible', async () => {
    // The other side of the same line — filtering first must not remove the cap.
    setProviders([
      makeProviderRow({ slug: 'p1', createdAt: new Date('2026-04-15T00:00:00Z') }),
      makeProviderRow({ slug: 'p2', createdAt: new Date('2026-04-16T00:00:00Z') }),
      makeProviderRow({ slug: 'p3', createdAt: new Date('2026-04-17T00:00:00Z') }),
      makeProviderRow({ slug: 'p4', createdAt: new Date('2026-04-18T00:00:00Z') }),
      makeProviderRow({ slug: 'p5', createdAt: new Date('2026-04-19T00:00:00Z') }),
    ]);

    const result = await resolveAgentProviderAndModel(makeAgent(), 'chat');

    expect(result.fallbacks).toEqual(['p2', 'p3', 'p4']);
  });

  it('does not truncate an explicit fallback list', async () => {
    // The cap has only ever applied to the automatic fill. An operator's own
    // list is theirs, however long.
    setProviders(threeProviders);
    const explicit = ['a', 'b', 'c', 'd', 'e'];
    registerProviderEligibility((candidates) => candidates);

    const result = await resolveAgentProviderAndModel(
      makeAgent({ provider: 'anthropic', model: 'm', fallbackProviders: explicit }),
      'chat'
    );

    expect(result.fallbacks).toEqual(explicit);
  });

  it('does not invoke the rule for an empty candidate list', async () => {
    // A fully-configured agent with no fallback list hits this on every turn,
    // and a fork's rule may be a policy lookup. There is nothing to decide.
    setProviders(threeProviders);
    const calls: string[] = [];
    registerProviderEligibility((candidates, ctx) => {
      calls.push(ctx.source);
      return candidates;
    });

    await resolveAgentProviderAndModel(
      makeAgent({ provider: 'anthropic', model: 'm', fallbackProviders: [] }),
      'chat'
    );

    expect(calls).toEqual([]);
  });

  it('cannot widen the candidate set or reorder it', async () => {
    // A rule returns a subset; anything else is ignored. Order is load-bearing
    // because fallbacks are tried in sequence, so it comes from the resolver.
    //
    // The returned list is deliberately a STRICT subset in the WRONG order with
    // a provider that was never a candidate. An earlier version returned every
    // candidate plus a bogus one, and its expected value was therefore
    // identical to the unfiltered list — so it passed against the pre-change
    // resolver too, and would have kept passing if the intersect were deleted.
    setProviders(threeProviders);
    // Scoped to the fallback fill so this isolates widening from the primary
    // constraint, which has its own tests above.
    registerProviderEligibility((candidates, ctx) =>
      ctx.source === 'primary' ? candidates : ['gemini-not-configured', 'ollama']
    );

    const result = await resolveAgentProviderAndModel(makeAgent(), 'chat');

    // 'openai' filtered out (not returned by the rule), 'gemini' ignored (never
    // a candidate), and what remains is in the resolver's order, not the rule's.
    expect(result.providerSlug).toBe('anthropic');
    expect(result.fallbacks).toEqual(['ollama']);
  });
});
