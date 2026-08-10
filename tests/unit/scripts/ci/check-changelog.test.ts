/**
 * Tests for the CHANGELOG check CLI.
 *
 * The rules themselves are covered in `changelog-structure.test.ts`; this file
 * covers the wiring around them — which base revision is compared, what exits
 * non-zero, and what degrades quietly.
 *
 * The script runs `main()` at import time, so each case sets up its mocks,
 * resets the module registry, and then imports it. Same pattern as
 * `tests/unit/scripts/rechunk-doc.test.ts`.
 *
 * @see scripts/ci/check-changelog.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockReadFileSync = vi.fn();
const mockExecFileSync = vi.fn();

// Node builtins need a `default` alongside the named export — something in the
// module graph imports them namespace-style, and a mock without one throws
// before any test body runs.
vi.mock('node:fs', () => ({
  readFileSync: mockReadFileSync,
  default: { readFileSync: mockReadFileSync },
}));
vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
  default: { execFileSync: mockExecFileSync },
}));
vi.mock('@/lib/sunrise-version', () => ({ SUNRISE_VERSION: '0.2.0' }));

const VALID = `## [Unreleased]

## [0.2.0] — 2026-06-25

### Added

- A thing.

## [0.1.0] — 2026-06-24
`;

/** `VALID` with the oldest release heading removed — the #550 failure. */
const HEADING_DELETED = VALID.replace('## [0.1.0] — 2026-06-24\n', '');

describe('scripts/ci/check-changelog', () => {
  let originalArgv: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  /** Every message the script wrote to stderr, joined for substring matching. */
  function stderr(): string {
    return errorSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
  }

  async function run(args: string[] = []): Promise<void> {
    process.argv = ['node', 'check-changelog.ts', ...args];
    vi.resetModules();
    await import('@/scripts/ci/check-changelog');
  }

  beforeEach(() => {
    vi.clearAllMocks();
    originalArgv = [...process.argv];
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      // Deliberately does not throw: the script's control flow after a
      // process.exit() is unreachable in production, and letting it continue
      // here would assert on states that cannot occur.
    }) as never);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockReadFileSync.mockReturnValue(VALID);
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  describe('base revision resolution', () => {
    it('compares against the merge base with origin/main when no flag is given', async () => {
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'merge-base') return 'abc123\n';
        return VALID;
      });

      await run();

      // Asserting the git invocation, not just the outcome: `origin/main` on
      // its own would flag a release the branch has not merged yet as a
      // deletion, so the merge base is the behaviour under test.
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        ['merge-base', 'origin/main', 'HEAD'],
        expect.anything()
      );
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        ['show', 'abc123:CHANGELOG.md'],
        expect.anything()
      );
      expect(exitSpy).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('history vs abc123'));
    });

    it('uses an explicit --base ref verbatim', async () => {
      mockExecFileSync.mockReturnValue(VALID);

      await run(['--base', 'origin/main']);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        ['show', 'origin/main:CHANGELOG.md'],
        expect.anything()
      );
      expect(mockExecFileSync).not.toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['merge-base']),
        expect.anything()
      );
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('accepts the --base=<ref> form', async () => {
      mockExecFileSync.mockReturnValue(VALID);

      await run(['--base=HEAD^']);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        ['show', 'HEAD^:CHANGELOG.md'],
        expect.anything()
      );
    });

    it('does not treat a longer flag starting with --base as the flag', async () => {
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) =>
        args[0] === 'merge-base' ? 'abc123\n' : VALID
      );

      await run(['--baseline', 'main']);

      // Falls through to auto-detection rather than reading `main:CHANGELOG.md`
      // — and, since no ref was *requested*, an unreadable base would skip
      // rather than fail, which is the wrong behaviour to reach by accident.
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        ['merge-base', 'origin/main', 'HEAD'],
        expect.anything()
      );
    });
  });

  describe('when --base is present but has no value', () => {
    it.each([['--base', ''], ['--base='], ['--base']])(
      'fails loudly rather than skipping (%j)',
      async (...args) => {
        // A wrapper interpolating an unset variable produces exactly this. The
        // flag's contract is "compare, and fail if you cannot"; degrading to a
        // quiet skip that still exits 0 is the one outcome a check against
        // silent damage must never produce.
        mockExecFileSync.mockImplementation((_cmd: string, gitArgs: string[]) =>
          gitArgs[0] === 'merge-base' ? 'abc123\n' : VALID
        );

        await run(args);

        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(stderr()).toContain('`--base` needs a revision — got an empty value');
        // Specifically: it must not fall through to the merge-base fallback.
        expect(mockExecFileSync).not.toHaveBeenCalled();
      }
    );
  });

  describe('when the base revision is unreadable', () => {
    it('skips the history rule quietly if no ref was requested', async () => {
      // `npm run validate` has to work in a fresh clone with no remote, on a
      // detached HEAD, and in a fork whose upstream is named something else.
      mockExecFileSync.mockImplementation(() => {
        throw new Error('fatal: not a git repository');
      });

      await run();

      expect(exitSpy).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith('CHANGELOG.md OK (structure).');
      expect(stderr()).toBe('');
    });

    it('fails if a ref was requested explicitly', async () => {
      // CI passes a ref it has already fetched, so a failure to read it there
      // means the wiring is broken, not that the check is inapplicable.
      mockExecFileSync.mockImplementation(() => {
        throw new Error('fatal: bad revision');
      });

      await run(['--base', 'origin/main']);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderr()).toContain('Could not read CHANGELOG.md at "origin/main"');
    });
  });

  describe('reporting', () => {
    it('exits 0 and says what it checked when the file is clean', async () => {
      mockExecFileSync.mockReturnValue(VALID);

      await run(['--base', 'main']);

      expect(exitSpy).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith('CHANGELOG.md OK (structure + history vs main).');
    });

    it('exits 1 on a static violation, with the line number', async () => {
      mockReadFileSync.mockReturnValue(VALID.replace('## [0.2.0]', '## [0.3.0]'));
      mockExecFileSync.mockImplementation(() => {
        throw new Error('no git');
      });

      await run();

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderr()).toContain('CHANGELOG.md has 1 structural problem:');
      expect(stderr()).toContain('CHANGELOG.md:3');
      expect(stderr()).toContain('SUNRISE_VERSION');
      expect(stderr()).toContain('CONTRIBUTING.md "Cutting a release"');
    });

    it('exits 1 when the base revision had a heading this one does not', async () => {
      mockReadFileSync.mockReturnValue(HEADING_DELETED);
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) =>
        args[0] === 'merge-base' ? 'abc123\n' : VALID
      );

      await run();

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderr()).toContain('`## [0.1.0] — 2026-06-24` was deleted');
    });

    it('pluralizes the count and omits the line number for file-level findings', async () => {
      mockReadFileSync.mockReturnValue('## [0.3.0] — 2026-06-25\n');
      mockExecFileSync.mockImplementation(() => {
        throw new Error('no git');
      });

      await run();

      expect(stderr()).toContain('CHANGELOG.md has 2 structural problems:');
      // The missing-Unreleased finding is about the file, not a line, so it
      // prints bare rather than as `CHANGELOG.md:0`.
      expect(stderr()).toContain('  CHANGELOG.md  No `## [Unreleased]` heading');
      expect(stderr()).not.toContain('CHANGELOG.md:0');
    });
  });
});
