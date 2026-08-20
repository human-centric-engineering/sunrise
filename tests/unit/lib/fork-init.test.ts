/**
 * Tests for `lib/fork-init.ts` — the shared one-shot gate every `lib/app/*`
 * seam runs its fork init through.
 *
 * The gate exists because eleven registries hand-wrote the same four moving
 * parts and seven of them got the same one wrong (#633). So these tests are
 * written against the two failures that actually happened, not just the happy
 * path: a partial init must leave nothing behind, and the latch must be set
 * BEFORE the init runs — the one registry that latched afterwards re-ran a
 * throwing init on every dispatch, forever, under a comment saying it did not.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createAppInitGate, restoreMap, describeThrown } from '@/lib/fork-init';
import { logger } from '@/lib/logging';

/** A gate over one Map, shaped exactly like the ten production call sites. */
function gateOver(registry: Map<string, string>, init: () => void, onSuccess?: () => void) {
  return createAppInitGate({
    label: 'probe: initAppProbe',
    subject: 'app probes',
    init,
    snapshot: () => new Map(registry),
    restore: (before) => restoreMap(registry, before),
    onSuccess,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createAppInitGate', () => {
  it('runs the fork init exactly once across many reads', () => {
    const registry = new Map<string, string>();
    const init = vi.fn(() => registry.set('a', '1'));
    const gate = gateOver(registry, init);

    gate.ensure();
    gate.ensure();
    gate.ensure();

    expect(init).toHaveBeenCalledTimes(1);
    expect(registry.get('a')).toBe('1');
  });

  it('does NOT re-run an init that threw', () => {
    // The defect this replaces: `capabilities/registry.ts` set its latch AFTER
    // the call, so a throwing init re-ran on every chat turn and every workflow
    // step for the life of the process.
    const registry = new Map<string, string>();
    const init = vi.fn(() => {
      throw new Error('boom');
    });
    const gate = gateOver(registry, init);

    gate.ensure();
    gate.ensure();
    gate.ensure();

    expect(init).toHaveBeenCalledTimes(1);
  });

  it('rolls back every registration a throwing init made', () => {
    const registry = new Map<string, string>();
    const gate = gateOver(registry, () => {
      registry.set('first', 'registered');
      registry.set('second', 'registered');
      throw new Error('boom on the third');
    });

    expect(gate.ensure()).toBe(false);
    expect([...registry.keys()]).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      'probe: initAppProbe threw — app probes rolled back and disabled',
      { error: 'boom on the third' }
    );
  });

  it('rolls back TO the pre-init contents, not to empty', () => {
    // Several registries hold core entries before the fork's init runs (the
    // capability dispatcher's built-ins, a framework tier's declarations). A
    // rollback that cleared would take those out with it.
    const registry = new Map<string, string>([['core', 'built-in']]);
    const gate = gateOver(registry, () => {
      registry.set('app', 'fork');
      registry.set('core', 'fork-overrode-it');
      throw new Error('boom');
    });

    gate.ensure();

    expect([...registry.entries()]).toEqual([['core', 'built-in']]);
  });

  it('reports success and failure through the return value', () => {
    const ok = gateOver(new Map(), () => {});
    const bad = gateOver(new Map(), () => {
      throw new Error('boom');
    });

    expect(ok.ensure()).toBe(true);
    expect(ok.ensure()).toBe(true);
    expect(bad.ensure()).toBe(false);
    // Latched — the remembered verdict, not a fresh run.
    expect(bad.ensure()).toBe(false);
  });

  it('does not recurse when the fork init reads the registry it is filling', () => {
    // A fork init that calls a public reader re-enters `ensure()`. Latching
    // before running is what makes that terminate rather than blow the stack.
    const registry = new Map<string, string>();
    let reentrantResult: boolean | undefined;
    const gate: { ensure: () => boolean; reset: () => void } = gateOver(registry, () => {
      reentrantResult = gate.ensure();
      registry.set('a', '1');
    });

    expect(gate.ensure()).toBe(true);
    // Mid-flight, the init has not completed, so the gate cannot claim it has.
    expect(reentrantResult).toBe(false);
    expect(registry.get('a')).toBe('1');
  });

  it('passes the PRE-init snapshot to onSuccess', () => {
    // The graders registry diffs before/after to warn that a fork replaced a
    // built-in slug. It needs the contents as they were, after a successful run.
    const registry = new Map<string, string>([['exact_match', 'built-in']]);
    const onSuccess = vi.fn();
    const gate = gateOver(
      registry,
      () => registry.set('exact_match', 'fork'),
      () => onSuccess(new Map(registry))
    );

    gate.ensure();

    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('does not call onSuccess when the init throws', () => {
    const onSuccess = vi.fn();
    const gate = gateOver(
      new Map(),
      () => {
        throw new Error('boom');
      },
      onSuccess
    );

    gate.ensure();

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('re-arms the one-shot on reset()', () => {
    const init = vi.fn();
    const gate = gateOver(new Map(), init);

    gate.ensure();
    gate.reset();
    gate.ensure();

    expect(init).toHaveBeenCalledTimes(2);
  });

  it('re-arms a FAILED gate on reset(), so one test cannot poison the next', () => {
    const registry = new Map<string, string>();
    let shouldThrow = true;
    const gate = gateOver(registry, () => {
      if (shouldThrow) throw new Error('boom');
      registry.set('a', '1');
    });

    expect(gate.ensure()).toBe(false);
    gate.reset();
    shouldThrow = false;

    expect(gate.ensure()).toBe(true);
    expect(registry.get('a')).toBe('1');
  });

  it('never lets a throw escape, even one that cannot be stringified', () => {
    // `String(Object.create(null))` throws. Before the shared helper only ONE of
    // the eleven registries guarded this, so in the other ten the log call
    // itself would throw — escaping the catch AFTER the rollback had run, and
    // surfacing as an unexplained failure of the thing the catch protects.
    const gate = gateOver(new Map(), () => {
      throw Object.create(null);
    });

    expect(() => gate.ensure()).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      'probe: initAppProbe threw — app probes rolled back and disabled',
      { error: 'a value that cannot be converted to a string' }
    );
  });

  it('does not let a throwing onSuccess escape — ensure() says it never throws', () => {
    // `ensure()` sits at the top of every public read on eleven registries, and
    // several of those are documented as always-safe-to-call. A callback that
    // throws would break that contract AFTER the latch was set — the same shape
    // of "the code does not do what its own docblock says" that this module
    // exists to fix, so the claim is enforced rather than asserted.
    const registry = new Map<string, string>();
    const gate = gateOver(
      registry,
      () => registry.set('a', '1'),
      () => {
        throw new Error('the override diff blew up');
      }
    );

    expect(() => gate.ensure()).not.toThrow();
    // The init SUCCEEDED; only the after-the-fact callback failed, so the
    // registrations stand and the verdict is still true.
    expect(gate.ensure()).toBe(true);
    expect(registry.get('a')).toBe('1');
    expect(logger.error).toHaveBeenCalledWith(
      'probe: initAppProbe — onSuccess threw; the init itself succeeded',
      { error: 'the override diff blew up' }
    );
  });

  it('does not let a throwing onFailure escape either', () => {
    const registry = new Map<string, string>([['core', 'built-in']]);
    const gate = createAppInitGate({
      label: 'probe: initAppProbe',
      subject: 'app probes',
      init: () => {
        registry.set('app', 'fork');
        throw new Error('fork boom');
      },
      snapshot: () => new Map(registry),
      restore: (before) => restoreMap(registry, before),
      onFailure: () => {
        throw new Error('the failure handler blew up');
      },
    });

    expect(() => gate.ensure()).not.toThrow();
    expect(gate.ensure()).toBe(false);
    // The rollback ran before the callback, so it is unaffected by it.
    expect([...registry.entries()]).toEqual([['core', 'built-in']]);
    expect(logger.error).toHaveBeenCalledWith('probe: initAppProbe — onFailure threw', {
      error: 'the failure handler blew up',
    });
  });
});

describe('restoreMap', () => {
  it('mutates in place rather than reassigning', () => {
    // Every reader closes over the registry `const`, so a rollback that swapped
    // the reference would leave them all reading the old map.
    const registry = new Map<string, string>([['a', '1']]);
    const alias = registry;
    registry.set('b', '2');

    restoreMap(registry, new Map([['a', '1']]));

    expect(alias).toBe(registry);
    expect([...alias.entries()]).toEqual([['a', '1']]);
  });

  it('drops additions, restores deletions, and undoes overwrites', () => {
    const registry = new Map<string, string>([
      ['kept', 'original'],
      ['overwritten', 'original'],
      ['deleted', 'original'],
    ]);
    const before = new Map(registry);

    registry.set('added', 'new');
    registry.set('overwritten', 'changed');
    registry.delete('deleted');

    restoreMap(registry, before);

    expect([...registry.entries()].sort()).toEqual([
      ['deleted', 'original'],
      ['kept', 'original'],
      ['overwritten', 'original'],
    ]);
  });
});

describe('describeThrown', () => {
  it('uses the message of an Error', () => {
    expect(describeThrown(new Error('the reason'))).toBe('the reason');
  });

  it('stringifies a non-Error throw', () => {
    expect(describeThrown('missing STRIPE_SECRET_KEY')).toBe('missing STRIPE_SECRET_KEY');
    expect(describeThrown(42)).toBe('42');
    expect(describeThrown(undefined)).toBe('undefined');
  });

  it('survives a value that cannot be converted to a string', () => {
    expect(describeThrown(Object.create(null))).toBe(
      'a value that cannot be converted to a string'
    );
  });
});
