/**
 * Tests for the lockfile check CLI.
 *
 * The rules are covered in `lockfile-diff.test.ts`; this covers the wiring —
 * base resolution, what exits non-zero, and what degrades quietly.
 *
 * @see scripts/ci/check-lockfile.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockReadFileSync = vi.fn();
const mockExecFileSync = vi.fn();

vi.mock('node:fs', () => ({
  readFileSync: mockReadFileSync,
  default: { readFileSync: mockReadFileSync },
}));
vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
  default: { execFileSync: mockExecFileSync },
}));

const LOCK = JSON.stringify({
  packages: {
    '': { version: '0.8.1' },
    'node_modules/native': { version: '1.0.0', os: ['linux'], libc: ['glibc'] },
  },
});
const LOCK_NO_LIBC = JSON.stringify({
  packages: {
    '': { version: '0.8.1' },
    'node_modules/native': { version: '1.0.0', os: ['linux'] },
  },
});
const MANIFEST = JSON.stringify({ dependencies: { native: '^1' } });

/**
 * Builds a `readFileSync` implementation answering all THREE files the CLI
 * reads: the lockfile, the manifest, and `.lockfile-decisions`.
 *
 * Every test routes through this rather than writing its own suffix check.
 * When the decisions file was added, each hand-rolled implementation silently
 * handed it the lockfile JSON, which parses as an unreadable decision and
 * turned five gating tests into "could not be read".
 */
function reads({
  lock = LOCK,
  manifest = MANIFEST,
  decisions = '',
}: {
  lock?: string;
  manifest?: string;
  decisions?: string;
} = {}) {
  return (path: string): string => {
    const target = String(path);
    if (target.endsWith('.lockfile-decisions')) return decisions;
    return target.endsWith('package.json') ? manifest : lock;
  };
}

describe('scripts/ci/check-lockfile', () => {
  let originalExitCode: typeof process.exitCode;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  function out(): string {
    return [...errorSpy.mock.calls, ...logSpy.mock.calls]
      .map((call: unknown[]) => String(call[0]))
      .join('\n');
  }

  async function run(args: string[] = []): Promise<void> {
    process.argv = ['node', 'check-lockfile.ts', ...args];
    vi.resetModules();
    await import('@/scripts/ci/check-lockfile');
  }

  beforeEach(() => {
    vi.clearAllMocks();
    originalExitCode = process.exitCode;
    process.exitCode = 0;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockReadFileSync.mockImplementation(reads({ manifest: MANIFEST, lock: LOCK }));
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it('compares against the merge base when no flag is given', async () => {
    mockExecFileSync.mockImplementation((_c: string, a: string[]) =>
      a[0] === 'merge-base' ? 'abc123\n' : LOCK
    );

    await run();

    // The merge base, not origin/main: a release the branch has not merged is
    // not a change this PR made.
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['merge-base', 'origin/main', 'HEAD'],
      expect.anything()
    );
    expect(process.exitCode).toBe(0);
    expect(out()).toContain('no version or platform-metadata change');
  });

  it('exits 1 and explains when platform metadata was lost', async () => {
    mockExecFileSync.mockImplementation((_c: string, a: string[]) =>
      a[0] === 'merge-base' ? 'abc123\n' : LOCK
    );
    mockReadFileSync.mockImplementation(reads({ manifest: MANIFEST, lock: LOCK_NO_LIBC }));

    await run();

    expect(process.exitCode).toBe(1);
    expect(out()).toContain('node_modules/native lost libc');
    // The message used to blame macOS. It is the npm version — arborist below
    // 9.4.0 omits `libc` from the fields it serialises, on every platform —
    // and the version is the part a reader can act on.
    expect(out()).toContain('npm below 11.11.0');
    expect(out()).toContain('npm run fix:lockfile-libc');
  });

  it('reports restored metadata without failing', async () => {
    // The #571 repair: 101 packages gained `libc`, nothing else moved. Before
    // this the all-clear read "no version or platform-metadata change", which
    // described the only thing that PR did as nothing at all.
    mockExecFileSync.mockImplementation((_c: string, a: string[]) =>
      a[0] === 'merge-base' ? 'abc123\n' : LOCK_NO_LIBC
    );
    mockReadFileSync.mockImplementation(reads({ manifest: MANIFEST, lock: LOCK }));

    await run();

    expect(process.exitCode).toBe(0);
    expect(out()).toContain('1 package(s) gained libc — platform metadata restored.');
    expect(out()).not.toContain('no version or platform-metadata change');
  });

  it('groups gains by key set instead of pairing a count with a union', async () => {
    // 100 packages gaining `libc` and one gaining `cpu` printed "101
    // package(s) gained cpu, libc", which reads as all 101 gaining both. This
    // block exists because the old output made a true statement misleading.
    const base = JSON.stringify({
      packages: {
        '': { version: '0.8.1' },
        'node_modules/a': { version: '1.0.0', os: ['linux'] },
        'node_modules/b': { version: '1.0.0', os: ['linux'] },
        'node_modules/c': { version: '1.0.0', os: ['linux'], libc: ['musl'] },
      },
    });
    const head = JSON.stringify({
      packages: {
        '': { version: '0.8.1' },
        'node_modules/a': { version: '1.0.0', os: ['linux'], libc: ['musl'] },
        'node_modules/b': { version: '1.0.0', os: ['linux'], libc: ['glibc'] },
        'node_modules/c': { version: '1.0.0', os: ['linux'], libc: ['musl'], cpu: ['x64'] },
      },
    });
    mockExecFileSync.mockImplementation((_c: string, a: string[]) =>
      a[0] === 'merge-base' ? 'abc123\n' : base
    );
    mockReadFileSync.mockImplementation(reads({ manifest: MANIFEST, lock: head }));

    await run();

    expect(out()).toContain('2 package(s) gained libc — platform metadata restored.');
    expect(out()).toContain('1 package(s) gained cpu — platform metadata restored.');
    expect(out()).not.toContain('3 package(s) gained cpu, libc');
  });

  it('skips quietly with no base and no flag', async () => {
    // `npm run check:lockfile` must work in a fresh clone with no remote.
    mockExecFileSync.mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });

    await run();

    expect(process.exitCode).toBe(0);
    expect(out()).toContain('no base revision available');
  });

  it('fails loudly when an explicitly requested base is unreadable', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error('Command failed'), { stderr: 'fatal: bad revision\n' });
    });

    await run(['--base', 'nope']);

    expect(process.exitCode).toBe(1);
    expect(out()).toContain('git: fatal: bad revision');
  });

  it('rejects an empty --base rather than silently falling back', async () => {
    await run(['--base', '']);

    expect(process.exitCode).toBe(1);
    expect(out()).toContain('needs a revision');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('rejects a --base that would be read as a git option', async () => {
    await run(['--base', '--output=/tmp/x']);

    expect(process.exitCode).toBe(1);
    expect(out()).toContain('must be a revision, not an option');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('reports a malformed lockfile instead of throwing', async () => {
    mockExecFileSync.mockImplementation((_c: string, a: string[]) =>
      a[0] === 'merge-base' ? 'abc123\n' : '{ not json'
    );

    await run();

    expect(process.exitCode).toBe(1);
    expect(out()).toContain('Could not parse');
  });

  describe('reporting', () => {
    /** Base fixture; `head` overrides let each case shape one dimension. */
    function serve(head: unknown, base: unknown = JSON.parse(LOCK)): void {
      mockExecFileSync.mockImplementation((_c: string, a: string[]) =>
        a[0] === 'merge-base' ? 'abc123\n' : JSON.stringify(base)
      );
      mockReadFileSync.mockImplementation(reads({ lock: JSON.stringify(head) }));
    }

    it('names each added, removed and changed package', async () => {
      serve({
        packages: {
          '': { version: '0.9.0' },
          'node_modules/native': { version: '1.1.0', os: ['linux'], libc: ['glibc'] },
          'node_modules/brand-new': { version: '1.0.0' },
        },
      });

      await run();
      expect(out()).toContain('+ node_modules/brand-new');
      expect(out()).toContain('~ node_modules/native 1.0.0 → 1.1.0');
      // `packages[""]` is the project itself; it printed as a nameless
      // `~  0.8.0 → 0.8.1` line on every release PR.
      expect(out()).toContain('~ (this project) 0.8.1 → 0.9.0');
      expect(out()).not.toMatch(/~ {2}\d/);
    });

    it('counts transitive downgrades in the all-clear rather than hiding them', async () => {
      // Listed but not gated. Saying nothing would make the check look like it
      // had not noticed.
      serve(
        {
          packages: {
            '': { version: '0.8.1' },
            'node_modules/native': { version: '1.0.0', os: ['linux'], libc: ['glibc'] },
            'node_modules/other': { version: '0.9.0' },
          },
          // `other` is not in MANIFEST, so its downgrade is transitive.
        },
        {
          packages: {
            '': { version: '0.8.1' },
            'node_modules/native': { version: '1.0.0', os: ['linux'], libc: ['glibc'] },
            'node_modules/other': { version: '1.0.0' },
          },
        }
      );

      await run();
      expect(process.exitCode).toBe(0);
      expect(out()).toContain('← downgrade');
      expect(out()).toContain('1 transitive downgrade');
    });

    it('gates and explains a direct downgrade', async () => {
      serve({
        packages: {
          '': { version: '0.8.1' },
          'node_modules/native': { version: '0.5.0', os: ['linux'], libc: ['glibc'] },
        },
      });

      await run();
      expect(process.exitCode).toBe(1);
      expect(out()).toContain('DOWNGRADE (direct)');
      expect(out()).toContain('went BACKWARDS');
    });

    it('gates a change to overrides, read from package.json', async () => {
      // Not the lockfile: npm never writes the key there, which is why the
      // rule was previously unfireable — undefined against undefined forever.
      mockExecFileSync.mockImplementation((_c: string, a: string[]) => {
        if (a[0] === 'merge-base') return 'abc123\n';
        if (String(a[1]).endsWith(':package.json')) return '{"overrides":{"hono":"^4"}}';
        return LOCK;
      });
      mockReadFileSync.mockImplementation(
        reads({ manifest: '{"dependencies":{"native":"^1"},"overrides":{"hono":"^5"}}' })
      );

      await run();
      expect(process.exitCode).toBe(1);
      expect(out()).toContain('"overrides" changed');
    });

    it('skips the overrides comparison when a manifest is unreadable, rather than blaming it', async () => {
      // With the head manifest missing, head overrides were `undefined` against
      // the base's two real ones, so the run exited 1 saying `"overrides"
      // changed` — a true failure with an entirely invented cause.
      mockExecFileSync.mockImplementation((_c: string, a: string[]) => {
        if (a[0] === 'merge-base') return 'abc123\n';
        if (String(a[1]).endsWith(':package.json')) return '{"overrides":{"hono":"^4"}}';
        return LOCK;
      });
      mockReadFileSync.mockImplementation((path: string) => {
        if (String(path).endsWith('.lockfile-decisions')) return '';
        if (String(path).endsWith('package.json')) throw new Error('ENOENT');
        return LOCK;
      });

      await run();

      expect(process.exitCode).toBe(0);
      expect(out()).toContain('skipping the overrides comparison');
      expect(out()).not.toContain('"overrides" changed');
    });

    it('says so when package.json cannot be read, rather than quietly mis-classifying', async () => {
      // Without the manifest every downgrade reads as transitive, which
      // under-reports. Silence there would be the wrong kind of quiet.
      mockExecFileSync.mockImplementation((_c: string, a: string[]) =>
        a[0] === 'merge-base' ? 'abc123\n' : LOCK
      );
      mockReadFileSync.mockImplementation((path: string) => {
        if (String(path).endsWith('.lockfile-decisions')) return '';
        if (String(path).endsWith('package.json')) throw new Error('ENOENT');
        return LOCK_NO_LIBC;
      });

      await run();
      expect(out()).toContain('treating every downgrade as transitive');
    });

    // ── .lockfile-decisions wiring (#584) ──────────────────────────────────
    // The rules live in `lockfile-decisions.test.ts`. These cover the SEAM —
    // the place the gate is actually weakened. Without them a regression that
    // let an ACK silence lost `libc` would pass the whole suite, which is the
    // opposite of what a file about weakening a gate should be able to do.
    describe('acknowledged decisions', () => {
      const DOWNGRADED = JSON.stringify({
        packages: {
          '': { version: '0.8.1' },
          'node_modules/native': { version: '0.5.0', os: ['linux'], libc: ['glibc'] },
        },
      });
      const ACK = 'downgrade node_modules/native 1.0.0 -> 0.5.0  # deliberate pin (#1)';

      function serveDowngrade(): void {
        mockExecFileSync.mockImplementation((_c: string, a: string[]) =>
          a[0] === 'merge-base' ? 'abc123\n' : LOCK
        );
      }

      it('flips a gating downgrade to a pass when acknowledged exactly', async () => {
        serveDowngrade();
        mockReadFileSync.mockImplementation(reads({ lock: DOWNGRADED, decisions: ACK }));

        await run();

        expect(process.exitCode).toBe(0);
      });

      it('still PRINTS the acknowledged downgrade with its reason', async () => {
        serveDowngrade();
        mockReadFileSync.mockImplementation(reads({ lock: DOWNGRADED, decisions: ACK }));

        await run();

        expect(out()).toContain('Acknowledged in .lockfile-decisions');
        expect(out()).toContain('deliberate pin (#1)');
        expect(out()).toContain('DOWNGRADE (direct)');
      });

      it('still gates when the ACK names different versions', async () => {
        serveDowngrade();
        mockReadFileSync.mockImplementation(
          reads({
            lock: DOWNGRADED,
            decisions: 'downgrade node_modules/native 1.0.0 -> 0.9.0  # a different move (#1)',
          })
        );

        await run();

        expect(process.exitCode).toBe(1);
        expect(out()).toContain('went BACKWARDS');
      });

      it('does NOT let an ACK wave through lost platform metadata', async () => {
        // The invariant that must survive every refactor of this seam.
        mockExecFileSync.mockImplementation((_c: string, a: string[]) =>
          a[0] === 'merge-base' ? 'abc123\n' : LOCK
        );
        mockReadFileSync.mockImplementation(reads({ lock: LOCK_NO_LIBC, decisions: ACK }));

        await run();

        expect(process.exitCode).toBe(1);
        expect(out()).toContain('lost libc');
      });

      it('fails an unparseable decisions file even when nothing moved', async () => {
        // A decisions-only PR moves no packages, so an early return used to
        // mean the file was never read — the malformed line then surfaced on
        // the next dependency PR, looking like that author's problem.
        mockExecFileSync.mockImplementation((_c: string, a: string[]) =>
          a[0] === 'merge-base' ? 'abc123\n' : LOCK
        );
        mockReadFileSync.mockImplementation(
          reads({ decisions: 'downgrade node_modules/foo 1.0.0 => 2.0.0  # wrong arrow' })
        );

        await run();

        expect(process.exitCode).toBe(1);
        expect(out()).toContain('could not be read');
      });

      it('fails a decision with no reason', async () => {
        serveDowngrade();
        mockReadFileSync.mockImplementation(
          reads({ lock: DOWNGRADED, decisions: 'downgrade node_modules/native 1.0.0 -> 0.5.0' })
        );

        await run();

        expect(process.exitCode).toBe(1);
        expect(out()).toContain('no reason given');
      });

      it('does not claim anything was acknowledged when only stale entries exist', async () => {
        // The file is a permanent log, so every future dependency PR would
        // otherwise print an "Acknowledged" header asserting a wave-through
        // that did not happen. Uses an ordinary UPGRADE so the diff has
        // movement (an unchanged lockfile returns before any reporting).
        const upgraded = JSON.stringify({
          packages: {
            '': { version: '0.8.1' },
            'node_modules/native': { version: '1.1.0', os: ['linux'], libc: ['glibc'] },
          },
        });
        mockExecFileSync.mockImplementation((_c: string, a: string[]) =>
          a[0] === 'merge-base' ? 'abc123\n' : LOCK
        );
        mockReadFileSync.mockImplementation(
          reads({
            lock: upgraded,
            decisions: 'downgrade node_modules/other 9.0.0 -> 8.0.0  # historical (#1)',
          })
        );

        await run();

        expect(out()).not.toContain('Acknowledged in .lockfile-decisions');
        expect(out()).toContain('past decision(s) not relevant to this diff');
        expect(out()).toContain('historical (#1)');
      });

      it('marks BOTH copies used when a fork sync replays a decision line', async () => {
        // Duplicates are expected, not exotic: four forks inherit the whole log
        // and a sync can replay a line. Marking only the first left the copy
        // listed as "not relevant to this diff" while it was the decision
        // actually being applied.
        serveDowngrade();
        mockReadFileSync.mockImplementation(
          reads({ lock: DOWNGRADED, decisions: `${ACK}\n${ACK}` })
        );

        await run();

        expect(process.exitCode).toBe(0);
        expect(out()).not.toContain('not relevant to this diff');
      });

      it('behaves exactly as before when the file does not exist', async () => {
        serveDowngrade();
        mockReadFileSync.mockImplementation((path: string) => {
          if (String(path).endsWith('.lockfile-decisions')) throw new Error('ENOENT');
          return String(path).endsWith('package.json') ? MANIFEST : DOWNGRADED;
        });

        await run();

        expect(process.exitCode).toBe(1);
        expect(out()).toContain('went BACKWARDS');
      });
    });

    it('reports an unreadable lockfile instead of throwing', async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT: no such file');
      });

      await run();

      expect(process.exitCode).toBe(1);
      expect(out()).toContain('Could not read package-lock.json');
    });
  });
});
