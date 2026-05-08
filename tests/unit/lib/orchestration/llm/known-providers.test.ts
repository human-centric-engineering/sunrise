/**
 * Known Providers Catalogue Tests
 *
 * Test Coverage:
 * - Catalogue invariants (unique slugs, providerType domain, env-var
 *   array shape per `isLocal`).
 * - `detectApiKeyEnvVar` — empty env, set env, empty-string env, and
 *   the "first matching alternative wins" rule for vendors with
 *   multiple env-var names.
 *
 * @see lib/orchestration/llm/known-providers.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  KNOWN_PROVIDERS,
  detectApiKeyEnvVar,
  type KnownProvider,
} from '@/lib/orchestration/llm/known-providers';

// Capture the env vars the catalogue cares about so each test can
// reset them deterministically. We only touch the ones we know about
// to avoid leaking unrelated state across the suite.
const ALL_ENV_VARS = Array.from(new Set(KNOWN_PROVIDERS.flatMap((p) => p.apiKeyEnvVars)));
const SAVED_ENV: Record<string, string | undefined> = {};

function clearAllProviderEnv(): void {
  for (const v of ALL_ENV_VARS) {
    delete process.env[v];
  }
}

describe('KNOWN_PROVIDERS catalogue', () => {
  it('has at least one provider', () => {
    expect(KNOWN_PROVIDERS.length).toBeGreaterThan(0);
  });

  it('uses unique slugs across the catalogue', () => {
    const slugs = KNOWN_PROVIDERS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('keeps apiKeyEnvVars empty for `isLocal` providers', () => {
    const locals = KNOWN_PROVIDERS.filter((p) => p.isLocal);
    expect(locals.length).toBeGreaterThan(0); // ollama is in the catalogue
    for (const p of locals) {
      expect(p.apiKeyEnvVars).toEqual([]);
    }
  });

  it('keeps apiKeyEnvVars non-empty for cloud providers', () => {
    for (const p of KNOWN_PROVIDERS.filter((p) => !p.isLocal)) {
      expect(p.apiKeyEnvVars.length).toBeGreaterThan(0);
    }
  });

  it('only uses providerType values that the runtime understands', () => {
    const allowed = new Set<KnownProvider['providerType']>([
      'anthropic',
      'openai-compatible',
      'voyage',
    ]);
    for (const p of KNOWN_PROVIDERS) {
      expect(allowed.has(p.providerType)).toBe(true);
    }
  });

  it('pairs the anthropic providerType with a hardcoded SDK URL (defaultBaseUrl null)', () => {
    const anthropic = KNOWN_PROVIDERS.find((p) => p.providerType === 'anthropic');
    expect(anthropic).toBeDefined();
    expect(anthropic?.defaultBaseUrl).toBeNull();
  });

  it('gives every cloud provider a defaultBaseUrl when providerType is openai-compatible or voyage', () => {
    for (const p of KNOWN_PROVIDERS) {
      if (p.isLocal) continue;
      if (p.providerType === 'openai-compatible' || p.providerType === 'voyage') {
        expect(p.defaultBaseUrl).toMatch(/^https?:\/\//);
      }
    }
  });
});

describe('detectApiKeyEnvVar', () => {
  beforeEach(() => {
    // Snapshot only the env vars we may mutate, then clear.
    for (const v of ALL_ENV_VARS) SAVED_ENV[v] = process.env[v];
    clearAllProviderEnv();
  });

  afterEach(() => {
    // Restore to pre-test state — leaving global env mutated would
    // bleed across the worker.
    clearAllProviderEnv();
    for (const v of ALL_ENV_VARS) {
      if (SAVED_ENV[v] !== undefined) process.env[v] = SAVED_ENV[v]!;
    }
  });

  it('returns null when none of the provider env vars are set', () => {
    const anthropic = KNOWN_PROVIDERS.find((p) => p.slug === 'anthropic');
    expect(anthropic).toBeDefined();

    expect(detectApiKeyEnvVar(anthropic!)).toBeNull();
  });

  it('returns the matching env-var name when the key is present', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const anthropic = KNOWN_PROVIDERS.find((p) => p.slug === 'anthropic')!;

    expect(detectApiKeyEnvVar(anthropic)).toBe('ANTHROPIC_API_KEY');
  });

  it('treats an empty-string env var as not set', () => {
    process.env.ANTHROPIC_API_KEY = '';
    const anthropic = KNOWN_PROVIDERS.find((p) => p.slug === 'anthropic')!;

    expect(detectApiKeyEnvVar(anthropic)).toBeNull();
  });

  it('returns null for local providers — apiKeyEnvVars is empty', () => {
    const ollama = KNOWN_PROVIDERS.find((p) => p.isLocal);
    expect(ollama).toBeDefined();

    expect(detectApiKeyEnvVar(ollama!)).toBeNull();
  });

  it('returns the first env-var listed when only the second alternative is set', () => {
    // Google's catalogue order is [GOOGLE_AI_API_KEY, GOOGLE_API_KEY, GEMINI_API_KEY].
    // Setting only GOOGLE_API_KEY should return GOOGLE_API_KEY (first in order
    // that has a value), proving the function walks the array.
    process.env.GOOGLE_API_KEY = 'gk-test';
    const google = KNOWN_PROVIDERS.find((p) => p.slug === 'google')!;

    expect(detectApiKeyEnvVar(google)).toBe('GOOGLE_API_KEY');
  });

  it('prefers the earlier alternative when multiple env vars are set', () => {
    // Both set — `GOOGLE_AI_API_KEY` is first in `apiKeyEnvVars` so it wins.
    process.env.GOOGLE_AI_API_KEY = 'gk-1';
    process.env.GEMINI_API_KEY = 'gk-2';
    const google = KNOWN_PROVIDERS.find((p) => p.slug === 'google')!;

    expect(detectApiKeyEnvVar(google)).toBe('GOOGLE_AI_API_KEY');
  });
});
