/**
 * Parity: the agent form's preview resolves the same binding the runtime will.
 *
 * `getEffectiveAgentDefaults` (`prefetch-helpers.ts`) exists so the agent form
 * can render the provider/model an agent will ACTUALLY use, rather than the
 * empty strings stored on the row. It duplicates the resolution logic in
 * `resolveAgentProviderAndModel` — different code, same question — because it
 * must never throw and the runtime resolver must.
 *
 * Two implementations of one rule drift. When they do, the failure is quiet and
 * nasty: the form shows an operator one provider while their agent answers from
 * another, and nothing errors.
 *
 * ## Why this file exists now, which is not the reason it was asked for
 *
 * The t-656 task predicted the provider-eligibility seam would desync these
 * two and asked for a parity assertion on that basis. It does not: the seam
 * filters FALLBACKS, and `getEffectiveAgentDefaults` does not compute fallbacks
 * at all — it returns `{ provider, model, inheritedProvider, inheritedModel }`
 * and has no fallback logic anywhere in the file. Nothing this seam touches can
 * make the mirror disagree.
 *
 * The duplication is real regardless, it was untested, and the next step in the
 * programme is exactly what would break it: a per-org rule that constrains the
 * PRIMARY provider would have to be applied here too, or the form silently
 * previews a provider the org is not allowed to use. That is what this guards.
 *
 * @see lib/orchestration/llm/agent-resolver.ts — the runtime resolver
 * @see lib/orchestration/prefetch-helpers.ts — the form's mirror
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks (must satisfy BOTH modules under test) ────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: { aiProviderConfig: { findMany: vi.fn() } },
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  isApiKeyEnvVarSet: vi.fn((envVar: string | null) => envVar === 'PRESENT_KEY'),
}));

// The runtime resolver reads `getDefaultModelForTask`; the mirror reads the
// `OrNull` variant. Same underlying setting, so both answer the same here —
// which is precisely the parity being asserted.
vi.mock('@/lib/orchestration/llm/settings-resolver', () => ({
  getDefaultModelForTask: vi.fn(async () => 'system-chat-model'),
  getDefaultModelForTaskOrNull: vi.fn(async () => 'system-chat-model'),
}));

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { prisma } from '@/lib/db/client';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getEffectiveAgentDefaults } from '@/lib/orchestration/prefetch-helpers';

/**
 * The UNREACHABLE provider is deliberately FIRST.
 *
 * Order is load-bearing, and the first draft of this file got it wrong: with
 * the reachable provider first, `rows[0]` and "first reachable row" are the
 * same answer, so deleting the reachability filter from the mirror changed
 * nothing and every assertion here stayed green. Measured, not theorised — the
 * drift was injected and the suite passed.
 *
 * With the unreachable row first the two answers diverge, and a mirror that
 * forgets to check reachability previews `openai` while the runtime uses
 * `anthropic`.
 */
const ROWS = [
  {
    id: 'p1',
    slug: 'openai',
    apiKeyEnvVar: 'MISSING_KEY',
    isLocal: false,
    isActive: true,
    createdAt: new Date('2026-04-15T00:00:00Z'),
  },
  {
    id: 'p2',
    slug: 'anthropic',
    apiKeyEnvVar: 'PRESENT_KEY',
    isLocal: false,
    isActive: true,
    createdAt: new Date('2026-04-16T00:00:00Z'),
  },
];

/** Resolve the same agent through both paths. */
async function bothWays(agent: { provider: string; model: string }) {
  vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue(ROWS as never);
  const runtime = await resolveAgentProviderAndModel({ ...agent, fallbackProviders: [] }, 'chat');
  const preview = await getEffectiveAgentDefaults(agent);
  return { runtime, preview };
}

describe('agent binding parity: runtime resolver vs the form’s preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('agrees when the agent sets both fields explicitly', async () => {
    const { runtime, preview } = await bothWays({
      provider: 'openai',
      model: 'gpt-4o-mini',
    });

    expect(preview.provider).toBe(runtime.providerSlug);
    expect(preview.model).toBe(runtime.model);
    expect(preview.inheritedProvider).toBe(false);
    expect(preview.inheritedModel).toBe(false);
  });

  it('agrees on the provider chosen when the agent leaves it empty', async () => {
    // Both must skip `openai` — active, but its env key is not set. A mirror
    // that forgot the reachability filter would preview a provider the runtime
    // will never pick, which is the exact drift this file exists for.
    const { runtime, preview } = await bothWays({ provider: '', model: 'gpt-4o-mini' });

    expect(preview.provider).toBe(runtime.providerSlug);
    expect(preview.provider).toBe('anthropic');
    expect(preview.inheritedProvider).toBe(true);
  });

  it('agrees on the model chosen when the agent leaves it empty', async () => {
    const { runtime, preview } = await bothWays({ provider: 'openai', model: '' });

    expect(preview.model).toBe(runtime.model);
    expect(preview.model).toBe('system-chat-model');
    expect(preview.inheritedModel).toBe(true);
  });

  it('agrees when the agent leaves both empty', async () => {
    const { runtime, preview } = await bothWays({ provider: '', model: '' });

    expect(preview.provider).toBe(runtime.providerSlug);
    expect(preview.model).toBe(runtime.model);
  });

  it('the mirror computes no fallbacks, so the eligibility seam cannot desync it', async () => {
    // Pins the reason this file does NOT assert fallback parity. If
    // `getEffectiveAgentDefaults` ever grows a fallback field, this fails and
    // whoever added it has to decide whether the seam applies there too —
    // which is the question the task originally assumed was already live.
    const { preview } = await bothWays({ provider: '', model: '' });

    expect(preview).not.toHaveProperty('fallbacks');
    expect(preview).not.toHaveProperty('fallbackProviders');
    expect(Object.keys(preview).sort()).toEqual([
      'inheritedModel',
      'inheritedProvider',
      'model',
      'provider',
    ]);
  });
});
