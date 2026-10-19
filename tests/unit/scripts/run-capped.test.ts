/**
 * Tests for `scripts/run-capped.mjs` — the wrapper that gives `npm run lint` an
 * explicit V8 old-space cap instead of Node's machine-derived default.
 *
 * The behaviour that matters is NOT "does it set a cap". It is **when it
 * declines to**: a command-line `--max-old-space-size` beats one in
 * `NODE_OPTIONS`, so a wrapper that set the flag unconditionally would replace
 * whatever a fork had measured and set as `CI_NODE_HEAP_MB` with Sunrise's own
 * number, in every CI job, silently. That is the regression this file exists to
 * catch, and `preserves an existing cap` is the test that catches it.
 *
 * The clamp is the other load-bearing rule: a cap above physical memory turns a
 * clean V8 abort into an OS OOM kill, which is far harder to diagnose — so the
 * requested value is clamped down to a fraction of RAM and floored at Node's
 * own default, making the wrapper a no-op on a machine too small for it rather
 * than a downgrade.
 *
 * One test spawns a real child, because every unit assertion here is about a
 * *string* and the whole point is that Node acts on it. `applies the cap to a
 * real child process` is the only proof that `NODE_OPTIONS` reaches V8.
 *
 * Not covered here, and deliberately so: the default `clearSignal`/`raise`
 * implementations (real `process.removeAllListeners` and `process.kill`, which
 * under a test runner kill the runner) and the run-as-a-script guard at the
 * bottom of the file. Both were verified by running the wrapper for real —
 * `node scripts/run-capped.mjs eslint --version`. The `onSignal` default *is*
 * covered, by a test that removes exactly the listeners it added.
 *
 * @see scripts/run-capped.mjs
 */

import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

import {
  BINS,
  DEFAULT_HEAP_MB,
  MEMORY_FRACTION,
  buildEnv,
  hasHeapCap,
  main,
  parseRequestedMb,
  resolveBin,
  resolveHeapMb,
  unaidedLimitMb,
} from '@/scripts/run-capped.mjs';

const GB = 1024 ** 3;

/** A stand-in child that never runs anything. */
function fakeChild(): EventEmitter & { kill: ReturnType<typeof vi.fn> } {
  return Object.assign(new EventEmitter(), { kill: vi.fn() });
}

describe('hasHeapCap', () => {
  it.each([
    ['--max-old-space-size=6144', true],
    ['--max-old-space-size 6144', true],
    ['--max_old_space_size=6144', true],
    ['--trace-warnings --max-old-space-size=6144', true],
    ['--max-old-space-size=6144 --trace-warnings', true],
    ['--trace-warnings', false],
    ['', false],
    [undefined, false],
  ])('%s -> %s', (value, expected) => {
    expect(hasHeapCap(value)).toBe(expected);
  });

  it('does not match a longer flag that merely starts the same way', () => {
    expect(hasHeapCap('--max-old-space-size-percentage=50')).toBe(false);
  });
});

describe('parseRequestedMb', () => {
  it('accepts a positive integer', () => {
    expect(parseRequestedMb('8192')).toBe(8192);
  });

  it.each(['', undefined, 'lots', '-1', '0', '1.5'])(
    'ignores %s rather than failing the lint run',
    (value) => {
      expect(parseRequestedMb(value)).toBeUndefined();
    }
  );
});

describe('resolveHeapMb', () => {
  it('uses the default when the machine can afford it', () => {
    expect(resolveHeapMb({ totalMemBytes: 16 * GB, defaultLimitMb: 4288 })).toBe(DEFAULT_HEAP_MB);
  });

  it('clamps to a fraction of physical memory on a smaller machine', () => {
    // 4GB * 0.75 = 3072, well below the 6144 default.
    expect(resolveHeapMb({ totalMemBytes: 4 * GB, defaultLimitMb: 2048 })).toBe(
      Math.floor((4 * GB * MEMORY_FRACTION) / 1024 ** 2)
    );
  });

  it('never returns less than the heap Node would have chosen unaided', () => {
    // A tiny explicit ask must not downgrade a machine that already gets more.
    expect(resolveHeapMb({ requestedMb: 512, totalMemBytes: 16 * GB, defaultLimitMb: 4288 })).toBe(
      4288
    );
  });

  it('honours an explicit request above the default', () => {
    expect(resolveHeapMb({ requestedMb: 8192, totalMemBytes: 32 * GB, defaultLimitMb: 4288 })).toBe(
      8192
    );
  });

  it('hands out exactly what was asked for when there is no floor (#711)', () => {
    // Under an inherited 6144 cap V8 reports 6336, and flooring at that handed
    // the child 6336. Read through `unaidedLimitMb`, the floor drops out.
    const defaultLimitMb = unaidedLimitMb({
      nodeOptions: '--max-old-space-size=6144',
      heapLimitBytes: 6336 * 1024 ** 2,
    });
    expect(resolveHeapMb({ requestedMb: 6144, totalMemBytes: 16 * GB, defaultLimitMb })).toBe(6144);
  });

  it('never returns more than the machine can back, whatever the floor (#711)', () => {
    // The clamp is the rule the function exists to enforce, so it holds as a
    // property: a floor or an ask above 75% of RAM still comes back at 75%.
    for (const totalGb of [2, 4, 8, 16]) {
      const affordable = Math.floor((totalGb * GB * MEMORY_FRACTION) / 1024 ** 2);
      for (const defaultLimitMb of [0, 1024, 4288, 6336, 12288]) {
        for (const requestedMb of [512, 6144, 9999]) {
          const resolved = resolveHeapMb({
            requestedMb,
            totalMemBytes: totalGb * GB,
            defaultLimitMb,
          });
          expect(resolved).toBeLessThanOrEqual(affordable);
        }
      }
    }
  });
});

describe('unaidedLimitMb', () => {
  const limit = 6336 * 1024 ** 2;

  it("reports V8's limit when nothing capped this process", () => {
    expect(unaidedLimitMb({ nodeOptions: '--trace-warnings', heapLimitBytes: limit })).toBe(6336);
  });

  it('reports no floor when NODE_OPTIONS carries a cap (#711)', () => {
    // The limit V8 reports is then the parent's cap, not Node's default.
    expect(
      unaidedLimitMb({
        nodeOptions: '--max-old-space-size=6144',
        heapLimitBytes: limit,
      })
    ).toBe(0);
  });

  it('keeps a command-line cap as the floor, since the child does not inherit it', () => {
    // `node --max-old-space-size=12288 scripts/run-capped.mjs ...`: NODE_OPTIONS
    // is clean, so the wrapper appends a cap. Dropping the floor here cut the
    // child back to 6144, half of what the caller asked for.
    const defaultLimitMb = unaidedLimitMb({
      nodeOptions: '',
      heapLimitBytes: 12480 * 1024 ** 2,
    });
    expect(resolveHeapMb({ requestedMb: 6144, totalMemBytes: 32 * GB, defaultLimitMb })).toBe(
      12480
    );
  });
});

describe('buildEnv', () => {
  it('appends a cap when NODE_OPTIONS is unset', () => {
    expect(buildEnv({}, 6144).NODE_OPTIONS).toBe('--max-old-space-size=6144');
  });

  it('appends to unrelated NODE_OPTIONS without dropping them', () => {
    expect(buildEnv({ NODE_OPTIONS: '--trace-warnings' }, 6144).NODE_OPTIONS).toBe(
      '--trace-warnings --max-old-space-size=6144'
    );
  });

  it('preserves an existing cap — CI_NODE_HEAP_MB must stay authoritative', () => {
    // The regression guard. A CLI flag would beat this value; appending a
    // second one would too. Neither may happen.
    expect(buildEnv({ NODE_OPTIONS: '--max-old-space-size=5120' }, 6144).NODE_OPTIONS).toBe(
      '--max-old-space-size=5120'
    );
  });

  it('leaves the caller env object untouched', () => {
    const env = { NODE_OPTIONS: '--trace-warnings' };
    buildEnv(env, 6144);
    expect(env.NODE_OPTIONS).toBe('--trace-warnings');
  });
});

describe('main', () => {
  it('refuses a command that is not on the allowlist', async () => {
    const error = vi.fn();
    const exit = vi.fn();
    const spawnFn = vi.fn();

    await main(['prettier', '--check', '.'], { error, exit, spawnFn });

    expect(spawnFn).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls[0][0]).toContain('Unknown command "prettier"');
  });

  it('names the allowed commands so the message is actionable', async () => {
    const error = vi.fn();
    await main([], { error, exit: vi.fn(), spawnFn: vi.fn() });
    expect(error.mock.calls[0][0]).toContain(BINS.join(', '));
  });

  it('passes the remaining argv through to the bin untouched', async () => {
    const spawnFn = vi.fn().mockReturnValue(fakeChild());

    await main(['eslint', '.', '--cache', '--cache-strategy', 'content'], {
      spawnFn,
      env: {},
      resolveCommand: (name: string) => `/bin/${name}`,
      exit: vi.fn(),
      onSignal: vi.fn(),
    });

    expect(spawnFn).toHaveBeenCalledWith(
      '/bin/eslint',
      ['.', '--cache', '--cache-strategy', 'content'],
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('caps the child when the environment does not', async () => {
    const spawnFn = vi.fn().mockReturnValue(fakeChild());

    await main(['eslint', '.'], {
      spawnFn,
      env: {},
      resolveCommand: () => '/bin/eslint',
      exit: vi.fn(),
      onSignal: vi.fn(),
    });

    expect(spawnFn.mock.calls[0][2].env.NODE_OPTIONS).toMatch(/--max-old-space-size=\d+/);
  });

  it('defers to a cap the environment already set', async () => {
    const spawnFn = vi.fn().mockReturnValue(fakeChild());

    await main(['eslint', '.'], {
      spawnFn,
      env: { NODE_OPTIONS: '--max-old-space-size=5120' },
      resolveCommand: () => '/bin/eslint',
      exit: vi.fn(),
      onSignal: vi.fn(),
    });

    expect(spawnFn.mock.calls[0][2].env.NODE_OPTIONS).toBe('--max-old-space-size=5120');
  });

  it('reads NODE_HEAP_MB as the requested cap', async () => {
    const spawnFn = vi.fn().mockReturnValue(fakeChild());
    const resolveHeap = vi.fn().mockReturnValue(7777);

    await main(['eslint', '.'], {
      spawnFn,
      env: { NODE_HEAP_MB: '9999' },
      resolveCommand: () => '/bin/eslint',
      exit: vi.fn(),
      onSignal: vi.fn(),
      resolveHeap,
    });

    // The resolver is injected because the real one clamps to this machine's
    // RAM: asserting the applied cap against DEFAULT_HEAP_MB failed on the
    // ~8GB private runner ci.md tells forks to size for (#700). What `main`
    // owns is passing the ask in and the answer on, so that is what is pinned.
    expect(resolveHeap).toHaveBeenCalledWith({ requestedMb: 9999 });
    expect(spawnFn.mock.calls[0][2].env.NODE_OPTIONS).toBe('--max-old-space-size=7777');
  });

  it('resolves with the real resolver when none is injected', async () => {
    const spawnFn = vi.fn().mockReturnValue(fakeChild());

    await main(['eslint', '.'], {
      spawnFn,
      env: {},
      resolveCommand: () => '/bin/eslint',
      exit: vi.fn(),
      onSignal: vi.fn(),
    });

    // Compared with the resolver's own answer on this machine, not a fixed
    // number, so it holds on any runner.
    expect(spawnFn.mock.calls[0][2].env.NODE_OPTIONS).toBe(
      `--max-old-space-size=${resolveHeapMb({ requestedMb: undefined })}`
    );
  });

  it('forwards the child exit code', async () => {
    const child = fakeChild();
    const exit = vi.fn();

    await main(['eslint', '.'], {
      spawnFn: vi.fn().mockReturnValue(child),
      env: {},
      resolveCommand: () => '/bin/eslint',
      exit,
      onSignal: vi.fn(),
    });
    child.emit('exit', 134, null);

    expect(exit).toHaveBeenCalledWith(134);
  });

  it('forwards SIGINT and SIGTERM to the child', async () => {
    const child = fakeChild();
    const handlers = new Map<string, () => void>();

    await main(['eslint', '.'], {
      spawnFn: vi.fn().mockReturnValue(child),
      env: {},
      resolveCommand: () => '/bin/eslint',
      exit: vi.fn(),
      onSignal: (signal: string, handler: () => void) => handlers.set(signal, handler),
    });

    expect([...handlers.keys()]).toEqual(['SIGINT', 'SIGTERM']);
    handlers.get('SIGINT')!();
    expect(child.kill).toHaveBeenCalledWith('SIGINT');
  });

  it('registers against the real process when nothing is injected', async () => {
    // Every other test here injects `onSignal`, so this is the only one that
    // exercises the default. It removes exactly the listeners it added rather
    // than calling removeAllListeners, which would strip vitest's own.
    const child = fakeChild();
    const signals = ['SIGINT', 'SIGTERM'] as const;
    const before = new Map(signals.map((s) => [s, process.listeners(s)]));

    await main(['eslint', '.'], {
      spawnFn: vi.fn().mockReturnValue(child),
      env: {},
      resolveCommand: () => '/bin/eslint',
      exit: vi.fn(),
    });

    const added = signals.flatMap((s) =>
      process
        .listeners(s)
        .filter((listener) => !before.get(s)!.includes(listener))
        .map((listener) => [s, listener] as const)
    );

    try {
      expect(added.map(([s]) => s)).toEqual(['SIGINT', 'SIGTERM']);
      added[0][1]('SIGINT');
      expect(child.kill).toHaveBeenCalledWith('SIGINT');
    } finally {
      for (const [signal, listener] of added) process.off(signal, listener);
    }
  });

  it('re-raises the child signal instead of exiting 0', async () => {
    // A lint killed by Ctrl-C must look killed to the shell. Getting this
    // wrong makes an interrupted `npm run validate` report success.
    const child = fakeChild();
    const exit = vi.fn();
    const clearSignal = vi.fn();
    const raise = vi.fn();

    await main(['eslint', '.'], {
      spawnFn: vi.fn().mockReturnValue(child),
      env: {},
      resolveCommand: () => '/bin/eslint',
      exit,
      onSignal: vi.fn(),
      clearSignal,
      raise,
    });
    child.emit('exit', null, 'SIGINT');

    // Order matters: the forwarding handler must come off first, or it catches
    // the re-raise and the wrapper never exits.
    expect(clearSignal).toHaveBeenCalledWith('SIGINT');
    expect(raise).toHaveBeenCalledWith('SIGINT');
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits 1 when the child reports neither a code nor a signal', async () => {
    const child = fakeChild();
    const exit = vi.fn();

    await main(['eslint', '.'], {
      spawnFn: vi.fn().mockReturnValue(child),
      env: {},
      resolveCommand: () => '/bin/eslint',
      exit,
      onSignal: vi.fn(),
    });
    child.emit('exit', null, null);

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('reports a spawn failure by name instead of a bare stack', async () => {
    const child = fakeChild();
    const error = vi.fn();
    const exit = vi.fn();

    await main(['eslint', '.'], {
      spawnFn: vi.fn().mockReturnValue(child),
      env: {},
      resolveCommand: () => '/bin/eslint',
      error,
      exit,
      onSignal: vi.fn(),
    });
    child.emit('error', new Error('ENOENT'));

    expect(error.mock.calls[0][0]).toContain('Failed to start "eslint"');
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('the bins package.json routes through the wrapper', () => {
  it.each([
    ['lint', 'eslint'],
    ['type-check', 'tsc'],
  ])('`npm run %s` launches %s through run-capped.mjs, and it is allowed', (script, bin) => {
    // A cold type-check outgrew Node's default heap on larger forks and took
    // `validate` down before lint ran (#693). Routing it here only helps if the
    // allowlist agrees, or the wrapper refuses it with exit 1.
    const { scripts } = z
      .object({ scripts: z.record(z.string(), z.string()) })
      .parse(JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')));
    expect(scripts[script]).toMatch(new RegExp(`^node scripts/run-capped\\.mjs ${bin}\\b`));
    expect(BINS).toContain(bin);
  });
});

describe('resolveBin', () => {
  it('resolves an installed dependency to node_modules/.bin', () => {
    // eslint is a devDependency of this repo, so the local shim exists.
    expect(resolveBin('eslint')).toMatch(/node_modules[/\\]\.bin[/\\]eslint/);
  });

  it('falls back to the bare name when nothing is installed locally', () => {
    // A global install is still runnable; inventing a node_modules path that
    // does not exist would fail with a confusing ENOENT instead.
    expect(resolveBin('definitely-not-installed-xyz')).toBe('definitely-not-installed-xyz');
  });
});

describe('the cap reaches V8', () => {
  it('applies the cap to a real child process', () => {
    // Everything above asserts on a string. This is the one check that Node
    // acts on it — without it the whole wrapper could be a no-op and the suite
    // would still be green.
    const probe = 'process.stdout.write(String(require("v8").getHeapStatistics().heap_size_limit))';

    const capped = spawnSync(process.execPath, ['-e', probe], {
      // buildEnv returns a plain string map by design; spawnSync wants the
      // repo's augmented ProcessEnv, which requires keys a probe has no use for.
      env: buildEnv({ PATH: process.env.PATH }, 2048) as NodeJS.ProcessEnv,
      encoding: 'utf8',
    });

    const limitMb = Number(capped.stdout) / 1024 ** 2;
    // V8 reports the cap plus the other spaces, so allow a small margin.
    expect(limitMb).toBeGreaterThan(2000);
    expect(limitMb).toBeLessThan(2300);
  });
});
