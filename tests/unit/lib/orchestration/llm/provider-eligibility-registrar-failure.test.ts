/**
 * A fork registrar that throws: the eligibility seam denies everything, or,
 * under `onFailure: 'throw'`, says it could not ask (t-819).
 *
 * Its own file because the scaffold mock is per-file, and `ensureWired`
 * latches the registrar's rejection for the module's life.
 *
 * @see lib/orchestration/llm/provider-eligibility.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/app/llm-providers', () => ({
  registerAppProviderEligibility: () => {
    throw new Error('scaffold broke');
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { logger } from '@/lib/logging';
import {
  resetProviderEligibility,
  resolveEligibleProviders,
  type ProviderEligibilityContext,
} from '@/lib/orchestration/llm/provider-eligibility';

const CTX: ProviderEligibilityContext = { task: 'chat', source: 'explicit', primarySlug: null };

describe('a registrar that throws', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProviderEligibility();
  });

  it('denies every candidate by default, and logs why', async () => {
    await expect(resolveEligibleProviders(['a', 'b'], CTX)).resolves.toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      'provider eligibility scaffold failed to register; denying every candidate',
      expect.objectContaining({ error: 'scaffold broke' })
    );
  });

  it("throws under onFailure: 'throw', with the registrar's error as the cause", async () => {
    await expect(
      resolveEligibleProviders(['a', 'b'], CTX, { onFailure: 'throw' })
    ).rejects.toMatchObject({
      name: 'ProviderSeamUnavailableError',
      cause: expect.objectContaining({ message: 'scaffold broke' }),
    });
    expect(logger.error).not.toHaveBeenCalled();
  });
});
