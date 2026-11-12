/**
 * Tests: the privacy scope (§127) — the store a turn or an execution enters,
 * what it tallies, and that it is one store per process.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@/lib/logging';
import {
  bindPrivacyScope,
  childPrivacyScope,
  createPrivacyScope,
  currentPrivacyScope,
  knownValuesOf,
  privacySummary,
  recordPrivacyCall,
  recordPrivacyRefusal,
  recordPrivacyUnresolved,
  runInPrivacyScope,
  withPrivacyScope,
  type PrivacyCallRecord,
} from '@/lib/orchestration/privacy/scope';

const chat = (counts: Record<string, number>, extra: Partial<PrivacyCallRecord> = {}) => ({
  kind: 'chat' as const,
  mode: 'detect' as const,
  counts,
  degraded: false,
  failedAdapters: [],
  ...extra,
});

describe('the store', () => {
  it('is empty outside a scope and holds the scope inside one, across awaits', async () => {
    expect(currentPrivacyScope()).toBeUndefined();
    const scope = createPrivacyScope({ scopeId: 's1' });
    const seen = await runInPrivacyScope(scope, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentPrivacyScope();
    });
    expect(seen).toBe(scope);
    expect(currentPrivacyScope()).toBeUndefined();
  });

  it('carries the scope into everything a generator does between yields, and nowhere else', async () => {
    const scope = createPrivacyScope({ scopeId: 'turn' });
    const seen: unknown[] = [];
    async function* inner() {
      seen.push(currentPrivacyScope());
      yield 1;
      await Promise.resolve();
      seen.push(currentPrivacyScope());
      yield 2;
    }
    const out: number[] = [];
    for await (const v of withPrivacyScope(scope, inner())) {
      // The consumer, between yields, is outside the scope.
      seen.push(currentPrivacyScope());
      out.push(v);
    }
    expect(out).toEqual([1, 2]);
    expect(seen).toEqual([scope, undefined, scope, undefined]);
  });

  it("runs the generator's own finally when the consumer stops early", async () => {
    const cleanedUp = vi.fn();
    async function* inner() {
      try {
        yield 1;
        yield 2;
      } finally {
        cleanedUp();
      }
    }
    for await (const v of withPrivacyScope(createPrivacyScope({ scopeId: 's' }), inner())) {
      expect(v).toBe(1);
      break;
    }
    expect(cleanedUp).toHaveBeenCalledOnce();
  });
});

describe('the tally', () => {
  it('adds counts by type, separates embeddings, and keeps the strictest mode', () => {
    const scope = createPrivacyScope({ scopeId: 's' });
    recordPrivacyCall(scope, chat({ PERSON: 2, EMAIL: 1 }));
    recordPrivacyCall(scope, chat({ PERSON: 1 }, { mode: 'off' }));
    recordPrivacyCall(scope, chat({ PERSON: 4 }, { kind: 'embedding' }));
    expect(privacySummary(scope)).toEqual({
      mode: 'detect',
      calls: 2,
      counts: { PERSON: 3, EMAIL: 1 },
      embeddingCalls: 1,
      embeddingCounts: { PERSON: 4 },
    });
  });

  it('records degraded and the failed adapters, sorted and once each', () => {
    const scope = createPrivacyScope({ scopeId: 's' });
    recordPrivacyCall(scope, chat({}, { degraded: true, failedAdapters: ['core.lists'] }));
    recordPrivacyCall(
      scope,
      chat({}, { degraded: true, failedAdapters: ['app.svc', 'core.lists'] })
    );
    expect(privacySummary(scope)).toMatchObject({
      degraded: true,
      failedAdapters: ['app.svc', 'core.lists'],
    });
  });

  it('has no summary when no call was scanned', () => {
    expect(privacySummary(createPrivacyScope({ scopeId: 's' }))).toBeUndefined();
  });

  it("rolls a child's calls up into its parent, and keeps a sibling's out", () => {
    const execution = createPrivacyScope({ scopeId: 'execution:e' });
    const a = childPrivacyScope(execution, 'execution:e:step:a');
    const b = childPrivacyScope(execution, 'execution:e:step:b');
    recordPrivacyCall(a, chat({ PERSON: 1 }));
    recordPrivacyCall(b, chat({ EMAIL: 2 }));
    expect(privacySummary(a)?.counts).toEqual({ PERSON: 1 });
    expect(privacySummary(b)?.counts).toEqual({ EMAIL: 2 });
    expect(privacySummary(execution)?.counts).toEqual({ PERSON: 1, EMAIL: 2 });
    expect(privacySummary(execution)?.calls).toBe(2);
  });

  it('is a copy: changing a summary changes nothing in the scope', () => {
    const scope = createPrivacyScope({ scopeId: 's' });
    recordPrivacyCall(scope, chat({ PERSON: 1 }));
    const summary = privacySummary(scope);
    if (summary) summary.counts.PERSON = 99;
    expect(privacySummary(scope)?.counts).toEqual({ PERSON: 1 });
  });
});

describe('refusals and unresolved placeholders', () => {
  it('records a refusal in the scope and every ancestor, raises the mode, and sorts and dedupes the summary', () => {
    const root = createPrivacyScope({ scopeId: 'root' });
    const mid = childPrivacyScope(root, 'mid');
    const leaf = childPrivacyScope(mid, 'leaf');
    recordPrivacyCall(root, chat({}, { mode: 'detect' }));

    recordPrivacyRefusal(leaf, 'block', 'stage_error');
    recordPrivacyRefusal(leaf, 'block', 'content_blocked');
    recordPrivacyRefusal(leaf, 'block', 'content_blocked');

    for (const s of [leaf, mid, root]) {
      expect(privacySummary(s)?.refused).toEqual(['content_blocked', 'stage_error']);
      expect(s.tally.mode).toBe('block');
    }
  });

  it('keeps a sibling out of a refusal, and gives a refusal-only scope a summary with no calls', () => {
    const root = createPrivacyScope({ scopeId: 'root' });
    const a = childPrivacyScope(root, 'a');
    const b = childPrivacyScope(root, 'b');

    recordPrivacyRefusal(a, 'pseudonymise', 'detector_failed');

    expect(privacySummary(b)).toBeUndefined();
    expect(privacySummary(a)).toMatchObject({
      mode: 'pseudonymise',
      calls: 0,
      embeddingCalls: 0,
      refused: ['detector_failed'],
    });
  });

  it('has no refused key when nothing was refused', () => {
    const scope = createPrivacyScope({ scopeId: 's' });
    recordPrivacyCall(scope, chat({ EMAIL: 1 }));
    expect(privacySummary(scope)).not.toHaveProperty('refused');
  });

  it('adds unresolved placeholders to every ancestor, ignoring zero and negatives', () => {
    const root = createPrivacyScope({ scopeId: 'root' });
    const leaf = childPrivacyScope(root, 'leaf');
    recordPrivacyCall(leaf, chat({}));

    recordPrivacyUnresolved(leaf, 2);
    recordPrivacyUnresolved(leaf, 1);
    recordPrivacyUnresolved(leaf, 0);
    recordPrivacyUnresolved(leaf, -5);

    expect(privacySummary(leaf)?.unresolved).toBe(3);
    expect(privacySummary(root)?.unresolved).toBe(3);
  });

  it('leaves unresolved out of the summary when there are none', () => {
    const scope = createPrivacyScope({ scopeId: 's' });
    recordPrivacyCall(scope, chat({}));
    recordPrivacyUnresolved(scope, 0);
    expect(privacySummary(scope)).not.toHaveProperty('unresolved');
  });
});

describe('binding and children', () => {
  it('fills in what the entering code learns later, and a child takes it', () => {
    const scope = createPrivacyScope({ scopeId: 'turn:x', userId: 'u1' });
    bindPrivacyScope(scope, { agentId: 'a1', scopeId: 'conversation:c1' });
    expect(scope).toMatchObject({ scopeId: 'conversation:c1', agentId: 'a1', userId: 'u1' });
    expect(childPrivacyScope(scope, 'child')).toMatchObject({
      scopeId: 'child',
      agentId: 'a1',
      userId: 'u1',
    });
  });
});

describe('known values', () => {
  it('loads once, only when asked, and shares the load with children', async () => {
    const load = vi.fn(async () => [{ type: 'PERSON', value: 'Ada Lovelace' }]);
    const scope = createPrivacyScope({
      scopeId: 's',
      knownValues: [{ type: 'EMAIL', value: 'ada@example.com' }],
      loadKnownValues: load,
    });
    expect(load).not.toHaveBeenCalled();
    const child = childPrivacyScope(scope, 'child');
    const [mine, theirs] = await Promise.all([knownValuesOf(scope), knownValuesOf(child)]);
    expect(mine).toEqual([
      { type: 'EMAIL', value: 'ada@example.com' },
      { type: 'PERSON', value: 'Ada Lovelace' },
    ]);
    expect(theirs).toEqual(mine);
    await knownValuesOf(scope);
    expect(load).toHaveBeenCalledOnce();
  });

  it('falls back to the static values when the loader rejects or throws', async () => {
    const statics = [{ type: 'EMAIL', value: 'a@example.com' }];
    const rejects = createPrivacyScope({
      scopeId: 'r',
      knownValues: statics,
      loadKnownValues: () => Promise.reject(new Error('db down')),
    });
    const throws = createPrivacyScope({
      scopeId: 't',
      knownValues: statics,
      loadKnownValues: () => {
        throw new Error('sync');
      },
    });
    await expect(knownValuesOf(rejects)).resolves.toEqual(statics);
    await expect(knownValuesOf(throws)).resolves.toEqual(statics);
    // Said, with the scope and the error's class only: tier B ran short.
    expect(logger.warn).toHaveBeenCalledWith('privacy-scope: known values could not be loaded', {
      scopeId: 'r',
      errorName: 'Error',
    });
  });

  it('freezes what it holds, so no detector can change what the next one reads', async () => {
    const scope = createPrivacyScope({
      scopeId: 's',
      knownValues: [{ type: 'PERSON', value: 'Ada' }],
      loadKnownValues: async () => [{ type: 'PERSON', value: 'Grace' }],
    });
    const values = await knownValuesOf(scope);
    expect(Object.isFrozen(scope.knownValues)).toBe(true);
    expect(values.every((v) => Object.isFrozen(v))).toBe(true);
  });
});

describe('one store per process (#1138)', () => {
  // Two evaluations of the module, with `vi.resetModules()` between them,
  // stand in for two module graphs: the route's and the instrumentation
  // graph's, whose code the capability dispatcher runs.
  const bag = globalThis as Record<string, unknown>;
  const before = bag.sunrisePrivacyScope;
  afterEach(() => {
    if (before === undefined) delete bag.sunrisePrivacyScope;
    else bag.sunrisePrivacyScope = before;
  });

  it('a scope entered through one evaluation is the scope the other reads', async () => {
    delete bag.sunrisePrivacyScope;
    vi.resetModules();
    const route = await import('@/lib/orchestration/privacy/scope');
    vi.resetModules();
    const instrumentation = await import('@/lib/orchestration/privacy/scope');
    expect(route.currentPrivacyScope).not.toBe(instrumentation.currentPrivacyScope);

    const scope = route.createPrivacyScope({ scopeId: 'conversation:c1', agentId: 'a1' });
    const seen = await route.runInPrivacyScope(scope, async () =>
      instrumentation.currentPrivacyScope()
    );
    expect(seen).toBe(scope);
  });
});
