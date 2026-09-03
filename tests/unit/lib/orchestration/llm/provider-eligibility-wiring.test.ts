/**
 * The fork's rule reaches a consumer that never imports the agent resolver.
 *
 * This is the regression test for the defect that forced the seam's wiring to
 * move. Registration used to be a module-load side effect of
 * `agent-resolver.ts`, which made it depend on **who imported what**:
 * `prefetch-helpers.ts` calls `resolveEligibleProviders` and does not import
 * the resolver, and neither do the two agent pages that call it. So in a
 * process where no chat turn had yet loaded the resolver, the agent form ran
 * the filter with nothing registered, silently got everything back, and
 * previewed a provider the fork's policy forbids.
 *
 * The existing parity test could not catch it: it imports BOTH modules into one
 * file, so the resolver's side effect ran and made the wiring look reachable.
 * Import graph is the whole subject here, which is why this lives in its own
 * file and imports `prefetch-helpers` and nothing else from that side.
 *
 * @see lib/orchestration/llm/provider-eligibility.ts — `ensureWired`
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The fork's scaffold, standing in for one that actually registers something.
// Sunrise ships it empty, so without this there is no rule to observe.
vi.mock('@/lib/app/providers', () => ({
  registerAppProviderEligibility: () => {
    registerProviderEligibility((candidates, ctx) =>
      ctx.source === 'primary' ? candidates.filter((slug) => slug !== 'openai') : candidates
    );
  },
}));

vi.mock('@/lib/db/client', () => ({
  prisma: { aiProviderConfig: { findMany: vi.fn() } },
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  isApiKeyEnvVarSet: vi.fn(() => true),
}));

vi.mock('@/lib/orchestration/llm/settings-resolver', () => ({
  getDefaultModelForTaskOrNull: vi.fn(async () => 'some-model'),
}));

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { prisma } from '@/lib/db/client';
import {
  registerProviderEligibility,
  resetProviderEligibility,
} from '@/lib/orchestration/llm/provider-eligibility';
// DELIBERATELY the only consumer imported. Importing `agent-resolver` here
// would recreate the very side effect this test exists to prove unnecessary,
// and the test would pass against the broken arrangement too.
import { getEffectiveAgentDefaults } from '@/lib/orchestration/prefetch-helpers';

describe('provider eligibility auto-wire', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProviderEligibility();
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      { id: 'p1', slug: 'openai', isLocal: false, apiKeyEnvVar: 'K1' },
      { id: 'p2', slug: 'anthropic', isLocal: false, apiKeyEnvVar: 'K2' },
    ] as never);
  });

  afterEach(() => {
    resetProviderEligibility();
  });

  it("applies the fork's rule in a graph that never loads the agent resolver", async () => {
    // `openai` sorts first and is reachable, so an unwired seam previews it.
    // Only the rule can move this to `anthropic`.
    const result = await getEffectiveAgentDefaults({ provider: '', model: '' });

    expect(result.provider).toBe('anthropic');
  });

  it('wires exactly once across repeated calls', async () => {
    // The latch. Re-running the scaffold would hit the
    // already-registered guard and throw on the second resolution.
    await getEffectiveAgentDefaults({ provider: '', model: '' });
    await getEffectiveAgentDefaults({ provider: '', model: '' });

    const result = await getEffectiveAgentDefaults({ provider: '', model: '' });

    expect(result.provider).toBe('anthropic');
  });

  it('re-runs the scaffold after a reset, so an edited rule is picked up', async () => {
    // A latch without this would make `resetProviderEligibility()` a one-way
    // door: cleared rule, spent latch, and every later call silently unfiltered
    // — which is the same class of failure as the bug this file guards.
    await getEffectiveAgentDefaults({ provider: '', model: '' });

    resetProviderEligibility();
    const result = await getEffectiveAgentDefaults({ provider: '', model: '' });

    expect(result.provider).toBe('anthropic');
  });
});
