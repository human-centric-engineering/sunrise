/**
 * Unit Tests: judge-model env resolver
 *
 * The module reads four env vars at module-load time and exposes them
 * via the `JUDGE_PROVIDER` / `JUDGE_MODEL` (and `EVALUATION_DEFAULT_*`)
 * exports. We verify the nullish-coalesce resolution order and the
 * empty-string-is-null behaviour of `env()`.
 *
 * Each scenario uses `vi.resetModules()` so the module re-reads
 * `process.env` after each `vi.stubEnv` call.
 *
 * @see lib/orchestration/evaluations/judge-model.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ENV_KEYS = [
  'EVALUATION_DEFAULT_PROVIDER',
  'EVALUATION_DEFAULT_MODEL',
  'EVALUATION_JUDGE_PROVIDER',
  'EVALUATION_JUDGE_MODEL',
] as const;

function clearEvalEnv(): void {
  for (const key of ENV_KEYS) {
    vi.stubEnv(key, '');
  }
}

beforeEach(() => {
  clearEvalEnv();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('judge-model env resolver', () => {
  it('returns null for every export when no env vars are set', async () => {
    const mod = await import('@/lib/orchestration/evaluations/judge-model');
    expect(mod.EVALUATION_DEFAULT_PROVIDER).toBeNull();
    expect(mod.EVALUATION_DEFAULT_MODEL).toBeNull();
    expect(mod.JUDGE_PROVIDER).toBeNull();
    expect(mod.JUDGE_MODEL).toBeNull();
  });

  it('treats an empty-string env var as null (not the literal empty string)', async () => {
    vi.stubEnv('EVALUATION_JUDGE_MODEL', '');
    const mod = await import('@/lib/orchestration/evaluations/judge-model');
    expect(mod.JUDGE_MODEL).toBeNull();
  });

  it('reads EVALUATION_DEFAULT_PROVIDER and EVALUATION_DEFAULT_MODEL when set', async () => {
    vi.stubEnv('EVALUATION_DEFAULT_PROVIDER', 'anthropic');
    vi.stubEnv('EVALUATION_DEFAULT_MODEL', 'claude-sonnet-4-6');
    const mod = await import('@/lib/orchestration/evaluations/judge-model');
    expect(mod.EVALUATION_DEFAULT_PROVIDER).toBe('anthropic');
    expect(mod.EVALUATION_DEFAULT_MODEL).toBe('claude-sonnet-4-6');
  });

  it('falls JUDGE_PROVIDER through to EVALUATION_DEFAULT_PROVIDER when judge-specific var is unset', async () => {
    vi.stubEnv('EVALUATION_DEFAULT_PROVIDER', 'openai');
    const mod = await import('@/lib/orchestration/evaluations/judge-model');
    expect(mod.JUDGE_PROVIDER).toBe('openai');
  });

  it('falls JUDGE_MODEL through to EVALUATION_DEFAULT_MODEL when judge-specific var is unset', async () => {
    vi.stubEnv('EVALUATION_DEFAULT_MODEL', 'gpt-4o');
    const mod = await import('@/lib/orchestration/evaluations/judge-model');
    expect(mod.JUDGE_MODEL).toBe('gpt-4o');
  });

  it('prefers EVALUATION_JUDGE_PROVIDER over EVALUATION_DEFAULT_PROVIDER', async () => {
    vi.stubEnv('EVALUATION_DEFAULT_PROVIDER', 'openai');
    vi.stubEnv('EVALUATION_JUDGE_PROVIDER', 'anthropic');
    const mod = await import('@/lib/orchestration/evaluations/judge-model');
    expect(mod.JUDGE_PROVIDER).toBe('anthropic');
  });

  it('prefers EVALUATION_JUDGE_MODEL over EVALUATION_DEFAULT_MODEL', async () => {
    vi.stubEnv('EVALUATION_DEFAULT_MODEL', 'gpt-4o');
    vi.stubEnv('EVALUATION_JUDGE_MODEL', 'claude-opus-4-6');
    const mod = await import('@/lib/orchestration/evaluations/judge-model');
    expect(mod.JUDGE_MODEL).toBe('claude-opus-4-6');
  });

  it('resolves JUDGE_PROVIDER and JUDGE_MODEL independently', async () => {
    // Cross-source resolution: judge-specific provider, default model.
    vi.stubEnv('EVALUATION_JUDGE_PROVIDER', 'anthropic');
    vi.stubEnv('EVALUATION_DEFAULT_MODEL', 'gpt-4o');
    const mod = await import('@/lib/orchestration/evaluations/judge-model');
    expect(mod.JUDGE_PROVIDER).toBe('anthropic');
    expect(mod.JUDGE_MODEL).toBe('gpt-4o');
  });
});
