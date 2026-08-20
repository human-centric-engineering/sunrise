/**
 * Tests for `lib/fork-init.ts` — the shared one-shot gate every `lib/app/*`
 * seam runs its fork init through.
 *
 * The gate exists because eleven registries each hand-wrote a latch, a
 * try/catch and a log line — four of them with a rollback, and one
 * (`capabilities`) with no catch at all and its latch set AFTER the call. Seven
 * of the eleven kept a throwing init's registrations (#633). So these tests are
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
import type { AppInitGate, AppInitState } from '@/lib/fork-init';
import { logger } from '@/lib/logging';

/**
 * A gate over one Map, shaped like nine of the eleven production call sites —
 * `mcp-resources` snapshots two maps and `subject-sources` three.
 */
function gateOver(
  registry: Map<string, string>,
  init: () => void,
  onSuccess?: (snapshot: ReadonlyMap<string, string>) => void
) {
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

    expect(gate.ensure()).toBe('failed');
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

    expect(ok.ensure()).toBe('ok');
    expect(ok.ensure()).toBe('ok');
    expect(bad.ensure()).toBe('failed');
    // Latched — the remembered verdict, not a fresh run.
    expect(bad.ensure()).toBe('failed');
  });

  it('reports a re-entrant read as RUNNING, not as a failure', () => {
    // A fork init that calls a public reader re-enters `ensure()`. Latching
    // before running is what makes that terminate rather than blow the stack —
    // but the verdict it gets back matters just as much as terminating.
    //
    // This was a boolean, and `false` meant both "threw" and "still running".
    // Both consumers that read it treated it as "threw": subject-sources marked
    // a SUCCESSFUL init permanently failed, refusing Art. 15 subject access for
    // the life of the process; the capability registry manufactured a throw,
    // blamed the fork's init for it, and rolled back the fork's whole toolset.
    const registry = new Map<string, string>();
    let reentrant: AppInitState | undefined;
    const init = vi.fn(() => {
      reentrant = gate.ensure();
      registry.set('a', '1');
    });
    const gate: AppInitGate = gateOver(registry, init);

    expect(gate.ensure()).toBe('ok');
    expect(reentrant).toBe('running');
    expect(registry.get('a')).toBe('1');
    // The re-entrant call must not have started a SECOND init. Asserting on the
    // registry cannot show this — `registry.set('a','1')` is idempotent, so a
    // double run leaves it identical. Count the calls.
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('passes the PRE-init snapshot to onSuccess', () => {
    // The graders registry diffs before/after to warn that a fork replaced a
    // built-in slug. It needs the contents as they were, after a successful run.
    const registry = new Map<string, string>([['exact_match', 'built-in']]);
    const onSuccess = vi.fn();
    const gate = gateOver(registry, () => registry.set('exact_match', 'fork'), onSuccess);

    gate.ensure();

    // Assert the argument the GATE passed, by content.
    //
    // The first version of this only counted calls, and its callback rebuilt the
    // value from the registry it was meant to be checking — so the gate could
    // pass a POST-init snapshot, or `undefined`, and it stayed green. That is
    // the entire property it is named for. Both sabotages now fail it.
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith(new Map([['exact_match', 'built-in']]));
    // and before/after are genuinely distinguishable, or the check above proves
    // nothing.
    expect(registry.get('exact_match')).toBe('fork');
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

    expect(gate.ensure()).toBe('failed');
    gate.reset();
    shouldThrow = false;

    expect(gate.ensure()).toBe('ok');
    expect(registry.get('a')).toBe('1');
  });

  it('never lets a throw escape, even one that cannot be stringified', () => {
    // `String(Object.create(null))` throws. Before the shared helper only ONE of
    // the eleven registries guarded this, so in the nine others that had a catch
    // the log call itself would throw and escape it — after the rollback, in the
    // three that had one — surfacing as an unexplained failure of the very thing
    // the catch protects.
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
    expect(gate.ensure()).toBe('ok');
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
    expect(gate.ensure()).toBe('failed');
    // The rollback ran before the callback, so it is unaffected by it.
    expect([...registry.entries()]).toEqual([['core', 'built-in']]);
    expect(logger.error).toHaveBeenCalledWith('probe: initAppProbe — onFailure threw', {
      error: 'the failure handler blew up',
    });
  });
  it('says so when a seam is async, because the guarantee does not survive it', async () => {
    // `init: () => void` does not stop `export async function initAppJobs()` at
    // the TYPE level — TypeScript lets any return type satisfy `void`, and
    // eslint rejects a cast here as unnecessary, which is the hazard
    // demonstrating itself. What does catch it is the lint rule disabled just
    // below, `no-misused-promises`. This runtime check is the backstop for a
    // fork that does not lint, or that turns that rule off. And it is a pattern core
    // set: `lib/app/bootstrap.ts` ships `export async function initApp()`, and
    // every fork's copy is async.
    const registry = new Map<string, string>();
    const gate = createAppInitGate({
      label: 'probe: initAppProbe',
      subject: 'app probes',
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the point
      init: () => Promise.resolve(),
      snapshot: () => new Map(registry),
      restore: (before) => restoreMap(registry, before),
    });

    // Still reported 'ok' — the sync part ran, and refusing would break a fork
    // whose async seam otherwise works. But it is no longer silent.
    expect(gate.ensure()).toBe('ok');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('must be synchronous'),
      expect.objectContaining({ hint: expect.stringContaining('after the first await') })
    );
  });

  it("routes an async seam's rejection to the log instead of the process", async () => {
    const registry = new Map<string, string>();
    const gate = createAppInitGate({
      label: 'probe: initAppProbe',
      subject: 'app probes',
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the point
      init: () => Promise.reject(new Error('late boom')),
      snapshot: () => new Map(registry),
      restore: (before) => restoreMap(registry, before),
    });

    gate.ensure();
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('rejected after returning — nothing was rolled back'),
      { error: 'late boom' }
    );
  });

  it('does not mistake a plain object with no `then` for a promise', () => {
    // The thenable check reads `.then` off whatever came back. A seam returning
    // a config object (or null, or a number) must not trip it.
    const gate = createAppInitGate({
      label: 'probe: initAppProbe',
      subject: 'app probes',
      init: () => ({ registered: 3 }),
      snapshot: () => new Map<string, string>(),
      restore: () => {},
    });

    expect(gate.ensure()).toBe('ok');
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('restoreMap', () => {
  it('mutates in place rather than reassigning', () => {
    // Every reader closes over the registry `const`, so a rollback that swapped
    // the reference would leave them all reading the old map.
    // The alias stands in for the eleven registries' readers, which all close
    // over the module-scoped `const`. A rollback that rebound the variable
    // instead of mutating would leave every one of them on the old map.
    const registry = new Map<string, string>([['a', '1']]);
    const alias: ReadonlyMap<string, string> = registry;
    registry.set('b', '2');
    expect(alias.has('b')).toBe(true);

    restoreMap(registry, new Map([['a', '1']]));

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
