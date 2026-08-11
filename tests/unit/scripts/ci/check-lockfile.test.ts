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
    mockReadFileSync.mockImplementation((path: string) =>
      String(path).endsWith('package.json') ? MANIFEST : LOCK
    );
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
    expect(out()).toContain('unchanged');
  });

  it('exits 1 and explains when platform metadata was lost', async () => {
    mockExecFileSync.mockImplementation((_c: string, a: string[]) =>
      a[0] === 'merge-base' ? 'abc123\n' : LOCK
    );
    mockReadFileSync.mockImplementation((path: string) =>
      String(path).endsWith('package.json') ? MANIFEST : LOCK_NO_LIBC
    );

    await run();

    expect(process.exitCode).toBe(1);
    expect(out()).toContain('node_modules/native lost libc');
    expect(out()).toContain('recomputed on macOS');
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
      mockReadFileSync.mockImplementation((path: string) =>
        String(path).endsWith('package.json') ? MANIFEST : JSON.stringify(head)
      );
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
      mockReadFileSync.mockImplementation((path: string) =>
        String(path).endsWith('package.json')
          ? '{"dependencies":{"native":"^1"},"overrides":{"hono":"^5"}}'
          : LOCK
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
        if (String(path).endsWith('package.json')) throw new Error('ENOENT');
        return LOCK_NO_LIBC;
      });

      await run();
      expect(out()).toContain('treating every downgrade as transitive');
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
