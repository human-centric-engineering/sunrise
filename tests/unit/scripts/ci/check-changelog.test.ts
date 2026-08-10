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
  let originalExitCode: typeof process.exitCode;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  /**
   * The script sets `process.exitCode` rather than calling `process.exit()`, so
   * every case has to restore it — otherwise a test asserting a failure would
   * hand vitest's own process a non-zero code and fail the whole run.
   */
  function exitCode(): typeof process.exitCode {
    return process.exitCode;
  }

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
    originalExitCode = process.exitCode;
    process.exitCode = 0;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockReadFileSync.mockReturnValue(VALID);
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
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
      expect(exitCode()).toBe(0);
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
      expect(exitCode()).toBe(0);
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

        expect(exitCode()).toBe(1);
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

      expect(exitCode()).toBe(0);
      expect(logSpy).toHaveBeenCalledWith('CHANGELOG.md OK (structure).');
      expect(stderr()).toBe('');
    });

    it('fails if a ref was requested explicitly, and says what git said', async () => {
      // CI passes a ref it has already fetched, so a failure to read it there
      // means the wiring is broken, not that the check is inapplicable. The
      // git message is forwarded because "no such ref", "git not installed"
      // and "output exceeded maxBuffer" are otherwise one indistinguishable
      // "fetch the base revision" — advice that is right for one of the three.
      mockExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error('Command failed'), {
          stderr: "fatal: invalid object name 'origin/main'.\n",
        });
      });

      await run(['--base', 'origin/main']);

      expect(exitCode()).toBe(1);
      expect(stderr()).toContain('Could not read CHANGELOG.md at "origin/main"');
      expect(stderr()).toContain("git: fatal: invalid object name 'origin/main'.");
    });

    it('still prints the structural findings it already has', async () => {
      // A base-fetch problem and a broken CHANGELOG can arrive together.
      // Discarding the actionable half costs the contributor a whole round
      // trip to learn something the script had already computed.
      mockReadFileSync.mockReturnValue(VALID.replace('## [0.2.0]', '## [0.3.0]'));
      mockExecFileSync.mockImplementation(() => {
        throw new Error('fatal: bad revision');
      });

      await run(['--base', 'origin/main']);

      expect(exitCode()).toBe(1);
      expect(stderr()).toContain('CHANGELOG.md has 1 structural problem:');
      expect(stderr()).toContain('SUNRISE_VERSION');
      expect(stderr()).toContain('Could not read CHANGELOG.md at "origin/main"');
    });
  });

  describe('when a parse is truncated by an unclosed fence', () => {
    it('says the append-only comparison was skipped rather than reporting a pass', async () => {
      // The base is damaged, not this contributor's branch — so it is not a
      // violation and does not fail the PR. But the rule did not run, and
      // "CHANGELOG.md OK (structure + history vs …)" would be a claim the
      // script cannot make.
      mockExecFileSync.mockImplementation((_cmd: string, gitArgs: string[]) =>
        gitArgs[0] === 'merge-base' ? 'abc123\n' : `## [Unreleased]\n\n\`\`\`\n\n${VALID}`
      );

      await run();

      expect(exitCode()).toBe(0);
      expect(stderr()).toContain('skipped the append-only comparison');
      expect(logSpy).toHaveBeenCalledWith(
        'CHANGELOG.md OK (structure (history vs abc123 skipped)).'
      );
    });

    it('fails on the fence, without claiming a history comparison, when HEAD is truncated', async () => {
      // The comparison is skipped because it could only produce nonsense, so
      // the summary must not say "structure + history vs …". The run still
      // fails — on the fence, which is the actual defect.
      mockReadFileSync.mockReturnValue(`## [Unreleased]\n\n\`\`\`\n\n${VALID}`);
      mockExecFileSync.mockImplementation((_cmd: string, gitArgs: string[]) =>
        gitArgs[0] === 'merge-base' ? 'abc123\n' : VALID
      );

      await run();

      expect(exitCode()).toBe(1);
      expect(stderr()).toContain('Unclosed code fence');
      expect(stderr()).not.toContain('was deleted');
      expect(logSpy).not.toHaveBeenCalled();
    });
  });

  describe('when running under GitHub Actions', () => {
    it('raises the skipped comparison as a warning annotation', async () => {
      // A plain stderr line sits unread inside a green step. `::warning::` is
      // what actually surfaces it, which the module doc says callers must do.
      vi.stubEnv('GITHUB_ACTIONS', 'true');
      mockExecFileSync.mockImplementation((_cmd: string, gitArgs: string[]) =>
        gitArgs[0] === 'merge-base' ? 'abc123\n' : `## [Unreleased]\n\n\`\`\`\n\n${VALID}`
      );

      await run();

      expect(stderr()).toContain('::warning::skipped the append-only comparison');
      vi.unstubAllEnvs();
    });
  });

  describe('when something throws a non-Error', () => {
    it('still reports the git failure readably', async () => {
      mockExecFileSync.mockImplementation(() => {
        // Simulating a non-Error throw is the whole point here: the handler
        // must not assume `.message` exists.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'git: command not found';
      });

      await run(['--base', 'origin/main']);

      expect(exitCode()).toBe(1);
      expect(stderr()).toContain('git: git: command not found');
    });

    it('still reports the read failure readably', async () => {
      mockReadFileSync.mockImplementation(() => {
        // Simulating a non-Error throw is the whole point here: the handler
        // must not assume `.message` exists.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'permission denied';
      });

      await run();

      expect(exitCode()).toBe(1);
      expect(stderr()).toContain('permission denied');
    });
  });

  describe('when CHANGELOG.md cannot be read', () => {
    it('reports it instead of throwing a stack trace', async () => {
      // This is the first link in `npm run validate`, so an unhandled throw
      // aborts the whole chain before type-check even starts.
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory, open 'CHANGELOG.md'");
      });

      await expect(run()).resolves.toBeUndefined();

      expect(exitCode()).toBe(1);
      expect(stderr()).toContain('Could not read');
      expect(stderr()).toContain('ENOENT');
    });
  });

  describe('reporting', () => {
    it('exits 0 and says what it checked when the file is clean', async () => {
      mockExecFileSync.mockReturnValue(VALID);

      await run(['--base', 'main']);

      expect(exitCode()).toBe(0);
      expect(logSpy).toHaveBeenCalledWith('CHANGELOG.md OK (structure + history vs main).');
    });

    it('exits 1 on a static violation, with the line number', async () => {
      mockReadFileSync.mockReturnValue(VALID.replace('## [0.2.0]', '## [0.3.0]'));
      mockExecFileSync.mockImplementation(() => {
        throw new Error('no git');
      });

      await run();

      expect(exitCode()).toBe(1);
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

      expect(exitCode()).toBe(1);
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
