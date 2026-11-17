/**
 * Tests: the one rule for whether a provider row builds a local client.
 *
 * @see lib/orchestration/llm/provider-locality.ts
 */
import { describe, expect, it } from 'vitest';
import { buildsLocalClient } from '@/lib/orchestration/llm/provider-locality';

describe('buildsLocalClient', () => {
  it('is local when the row says so', () => {
    expect(buildsLocalClient({ isLocal: true, providerType: 'openai-compatible' })).toBe(true);
    expect(buildsLocalClient({ isLocal: false, providerType: 'openai-compatible' })).toBe(false);
  });

  it('never counts a Voyage row: its isLocal only lets its base URL be on loopback', () => {
    expect(buildsLocalClient({ isLocal: true, providerType: 'voyage' })).toBe(false);
  });
});
