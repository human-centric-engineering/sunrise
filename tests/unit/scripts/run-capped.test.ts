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
 * @see scripts/run-capped.mjs
 */

import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { describe, it, expect, vi } from 'vitest';

import {
  BINS,
  DEFAULT_HEAP_MB,
  MEMORY_FRACTION,
  buildEnv,
  hasHeapCap,
  main,
  parseRequestedMb,
  resolveHeapMb,
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

    await main(['tsc', '--noEmit'], { error, exit, spawnFn });

    expect(spawnFn).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls[0][0]).toContain('Unknown command "tsc"');
  });

  it('names the allowed commands so the message is actionable', async () => {
    const error = vi.fn();
    await main([], { error, exit: vi.fn(), spawnFn: vi.fn() });
    expect(error.mock.calls[0][0]).toContain(BINS.join(', '));
  });

  it('passes the remaining argv through to the bin untouched', async () => {
    const spawnFn = vi.fn().mockReturnValue(fakeChild());

    await main(['eslint', '.', '--cache', '--cache-location', '.next/cache/eslint/'], {
      spawnFn,
      env: {},
      resolveCommand: (name: string) => `/bin/${name}`,
      exit: vi.fn(),
    });

    expect(spawnFn).toHaveBeenCalledWith(
      '/bin/eslint',
      ['.', '--cache', '--cache-location', '.next/cache/eslint/'],
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
    });

    expect(spawnFn.mock.calls[0][2].env.NODE_OPTIONS).toBe('--max-old-space-size=5120');
  });

  it('reads NODE_HEAP_MB as the requested cap', async () => {
    const spawnFn = vi.fn().mockReturnValue(fakeChild());

    await main(['eslint', '.'], {
      spawnFn,
      env: { NODE_HEAP_MB: '9999' },
      resolveCommand: () => '/bin/eslint',
      exit: vi.fn(),
    });

    // Clamped by this machine's real memory, so assert it moved off the
    // default rather than pinning a number the test host decides.
    const opts = spawnFn.mock.calls[0][2].env.NODE_OPTIONS as string;
    expect(Number(/--max-old-space-size=(\d+)/.exec(opts)![1])).toBeGreaterThanOrEqual(
      DEFAULT_HEAP_MB
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
    });
    child.emit('exit', 134, null);

    expect(exit).toHaveBeenCalledWith(134);
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
    });
    child.emit('error', new Error('ENOENT'));

    expect(error.mock.calls[0][0]).toContain('Failed to start "eslint"');
    expect(exit).toHaveBeenCalledWith(1);
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
