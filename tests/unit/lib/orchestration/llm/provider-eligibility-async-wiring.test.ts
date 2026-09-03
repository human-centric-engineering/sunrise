/**
 * An ASYNC fork registrar still applies to the very first resolve.
 *
 * Separate file from `provider-eligibility-wiring.test.ts` because the scaffold
 * mock is per-file and this needs the async shape specifically. That other file
 * mocks a registrar that registers SYNCHRONOUSLY, so it cannot see this defect
 * at all — its rule is in place before `ensureWired` returns no matter whether
 * the call is awaited.
 *
 * The defect it guards: `ensureWired` used to call the registrar without
 * awaiting it. A fork that loads policy first — which is what this seam's own
 * "cache whatever you look up" guidance steers them toward — resolves the wiring
 * promise at its first inner `await`, before `registerProviderEligibility` runs.
 * `resolveEligibleProviders` then saw no rule and returned the candidates
 * unfiltered, silently, on the first requests after every cold start.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/app/providers', () => ({
  // Deliberately async, and deliberately deferring registration past a
  // microtask — the shape a fork gets by loading its allowlist before
  // registering. `fork-init-seams.test.ts` matches `export async function
  // registerApp*`, so this is a supported scaffold shape, not an abuse.
  registerAppProviderEligibility: async () => {
    await Promise.resolve();
    await Promise.resolve();
    // Filters EVERY source, which is what the scaffold's guidance now tells a
    // fork to do. A rule answering only for 'primary' would leave `openai`
    // eligible as a fallback — correct behaviour, but it would make the
    // fallback assertion below test this mock rather than the wiring.
    registerProviderEligibility((candidates) => candidates.filter((slug) => slug !== 'openai'));
  },
}));

vi.mock('@/lib/db/client', () => ({
  prisma: { aiProviderConfig: { findMany: vi.fn() } },
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  isApiKeyEnvVarSet: vi.fn(() => true),
}));
vi.mock('@/lib/orchestration/llm/settings-resolver', () => ({
  getDefaultModelForTask: vi.fn(async () => 'some-model'),
}));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { prisma } from '@/lib/db/client';
import {
  registerProviderEligibility,
  resetProviderEligibility,
} from '@/lib/orchestration/llm/provider-eligibility';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';

describe('provider eligibility auto-wire — async registrar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProviderEligibility();
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      {
        id: 'p1',
        slug: 'openai',
        apiKeyEnvVar: 'K1',
        isLocal: false,
        isActive: true,
        createdAt: new Date('2026-04-15T00:00:00Z'),
      },
      {
        id: 'p2',
        slug: 'anthropic',
        apiKeyEnvVar: 'K2',
        isLocal: false,
        isActive: true,
        createdAt: new Date('2026-04-16T00:00:00Z'),
      },
    ] as never);
  });

  afterEach(() => {
    resetProviderEligibility();
  });

  it('applies on the FIRST resolve, not merely the second', async () => {
    // The whole defect lives in the first call. `openai` sorts first and is
    // reachable, so an unawaited registrar yields `openai` here and `anthropic`
    // on every call after — intermittent, and invisible in review.
    const first = await resolveAgentProviderAndModel(
      { provider: '', model: '', fallbackProviders: [] },
      'chat'
    );

    expect(first.providerSlug).toBe('anthropic');
  });

  it('is still applied on subsequent resolves', async () => {
    await resolveAgentProviderAndModel({ provider: '', model: '', fallbackProviders: [] }, 'chat');
    const second = await resolveAgentProviderAndModel(
      { provider: '', model: '', fallbackProviders: [] },
      'chat'
    );

    expect(second.providerSlug).toBe('anthropic');
  });

  it('keeps the forbidden provider out of the system fallback fill too', async () => {
    const result = await resolveAgentProviderAndModel(
      { provider: '', model: '', fallbackProviders: [] },
      'chat'
    );

    expect(result.fallbacks).not.toContain('openai');
  });
});
