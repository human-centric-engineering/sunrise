/**
 * Tests for the router-mock check's CLI.
 *
 * The rules are covered in `router-mocks.test.ts`; this covers the WIRING:
 * which files are walked, which one gets the factory exemption, and what the
 * operator is told when the walk finds nothing at all.
 *
 * That last case is the one worth having a test for. The rules can be perfect
 * and the check still useless if it reports a clean bill over zero files, which
 * is what happens when it runs from anywhere but the repo root. Its sibling
 * checks each learned that separately.
 *
 * `fs` is mocked throughout, so no real file is read and the fixtures cannot
 * drift with the suite.
 *
 * @see scripts/ci/check-router-mocks.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockReaddirSync = vi.fn();
const mockReadFileSync = vi.fn();

vi.mock('fs', () => ({
  readdirSync: mockReaddirSync,
  readFileSync: mockReadFileSync,
  default: { readdirSync: mockReaddirSync, readFileSync: mockReadFileSync },
}));

/** A complete six-member literal, as a string so this file stays clean itself. */
const COMPLETE_LITERAL = [
  'const router = {',
  '  push: vi.fn(), replace: vi.fn(), refresh: vi.fn(),',
  '  back: vi.fn(), forward: vi.fn(), prefetch: vi.fn(),',
  '};',
].join('\n');

const ROUTER_CAST = 'const mocked = useRouter as unknown as ReturnType<typeof vi.fn>;';

const CLEAN = 'vi.mocked(useRouter).mockReturnValue(createMockRouter({ refresh }));';

/**
 * Answers the walk and the reads. Keys are paths relative to `tests/`, matching
 * what `readdirSync(..., { recursive: true })` returns; `null` makes that file's
 * read throw.
 */
function tree(files: Record<string, string | null>) {
  mockReaddirSync.mockImplementation(() => Object.keys(files));
  mockReadFileSync.mockImplementation((path: string) => {
    const key = String(path).replace(/^.*?tests\//, '');
    const content = files[key];
    if (content === undefined || content === null) throw new Error(`ENOENT: ${String(path)}`);
    return content;
  });
}

describe('scripts/ci/check-router-mocks', () => {
  let originalExitCode: typeof process.exitCode;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  function out(): string {
    return [...errorSpy.mock.calls, ...logSpy.mock.calls]
      .map((call: unknown[]) => String(call[0]))
      .join('\n');
  }

  async function run(): Promise<void> {
    vi.resetModules();
    // Importing no longer runs the scan (the entry point is guarded on
    // `process.argv[1]`), so call `main()` and set the exit code as the CLI does.
    const { main } = await import('@/scripts/ci/check-router-mocks');
    process.exitCode = main();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    originalExitCode = process.exitCode;
    process.exitCode = 0;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  describe('a clean suite', () => {
    it('exits 0 and names how many files it scanned', async () => {
      tree({ 'unit/a.test.tsx': CLEAN, 'setup.ts': CLEAN });
      await run();
      expect(process.exitCode).toBe(0);
      // The count is the point: a bare "OK" cannot be told apart from an OK
      // over three files.
      expect(out()).toContain('Router mocks OK (2 files under tests/ scanned).');
    });
  });

  describe('violations', () => {
    it('exits 1 and prints every finding with its path and line', async () => {
      tree({ 'unit/a.test.tsx': COMPLETE_LITERAL, 'unit/b.test.ts': ROUTER_CAST });
      await run();
      expect(process.exitCode).toBe(1);
      expect(out()).toContain('Hand-rolled router mocks found (2):');
      expect(out()).toMatch(/tests\/unit\/a\.test\.tsx:1:16 {2}\[literal]/);
      expect(out()).toMatch(/tests\/unit\/b\.test\.ts:1:16 {2}\[cast]/);
    });

    it('prints every violation in a file, not just the first', async () => {
      tree({ 'unit/a.test.tsx': `${ROUTER_CAST}\n${COMPLETE_LITERAL}` });
      await run();
      expect(out()).toContain('found (2)');
    });

    it('tells the operator what to write instead', async () => {
      tree({ 'unit/a.test.tsx': COMPLETE_LITERAL });
      await run();
      expect(out()).toContain('createMockRouter()');
      expect(out()).toContain(
        'vi.mocked(useRouter).mockReturnValue(createMockRouter({ refresh }))'
      );
      expect(out()).toContain('.context/testing/mocking.md');
    });
  });

  describe('which files are walked', () => {
    it('reads .ts and .tsx, including setup.ts and helpers', async () => {
      // Deliberately not narrowed to `*.test.ts`: an earlier version was, and
      // could not see `tests/setup.ts`, the single highest-risk file, since
      // its router is the suite-wide default.
      tree({ 'setup.ts': COMPLETE_LITERAL, 'helpers/thing.ts': ROUTER_CAST });
      await run();
      expect(out()).toContain('tests/setup.ts:');
      expect(out()).toContain('tests/helpers/thing.ts:');
    });

    it('skips .d.ts declaration files', async () => {
      // Paired with a real file so the skip shows up as a count rather than as
      // the empty-walk failure, which is a different outcome entirely.
      tree({ 'types/global.d.ts': COMPLETE_LITERAL, 'unit/a.test.ts': CLEAN });
      await run();
      expect(process.exitCode).toBe(0);
      expect(out()).toContain('(1 files');
    });

    it('skips non-TypeScript files', async () => {
      tree({ 'fixtures/data.json': COMPLETE_LITERAL, 'README.md': '', 'unit/a.test.ts': CLEAN });
      await run();
      expect(process.exitCode).toBe(0);
      expect(out()).toContain('(1 files');
    });
  });

  describe('the factory exemption', () => {
    it('lets tests/types/mocks.ts write a complete literal', async () => {
      tree({ 'types/mocks.ts': COMPLETE_LITERAL });
      await run();
      expect(process.exitCode).toBe(0);
    });

    it('still applies the cast rule there', async () => {
      // Deliberate. A real cast added by a fork extending the factory is
      // exactly what needs catching, and the JSDoc mentioning one is a comment.
      tree({ 'types/mocks.ts': ROUTER_CAST });
      await run();
      expect(process.exitCode).toBe(1);
      expect(out()).toContain('tests/types/mocks.ts:');
    });

    it('does not exempt any other file', async () => {
      tree({ 'types/other.ts': COMPLETE_LITERAL });
      await run();
      expect(process.exitCode).toBe(1);
    });
  });

  describe('when it could not look', () => {
    it('fails when the walk finds no files', async () => {
      tree({});
      await run();
      expect(process.exitCode).toBe(1);
      expect(out()).toContain('Found no .ts/.tsx files under tests/');
      expect(out()).toContain('Is this the repo root?');
    });

    it('fails when tests/ cannot be read at all', async () => {
      mockReaddirSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      await run();
      expect(process.exitCode).toBe(1);
      expect(out()).toContain('Found no .ts/.tsx files under tests/');
    });

    it('reports an unreadable file rather than passing over it', async () => {
      // "I could not look" and "there is nothing there" are different answers,
      // and only one of them is a pass.
      tree({ 'unit/a.test.tsx': null, 'unit/b.test.ts': CLEAN });
      await run();
      expect(process.exitCode).toBe(1);
      expect(out()).toContain('Could not read:');
      expect(out()).toContain('tests/unit/a.test.tsx');
    });

    it('skips a directory whose name looks like a source file', async () => {
      // The recursive listing returns directories too, so `fixtures.ts/` is
      // in it; reading one fails with EISDIR, which is not an unreadable file.
      mockReaddirSync.mockImplementation(() => ['unit/fixtures.ts', 'unit/b.test.ts']);
      mockReadFileSync.mockImplementation((path: string) => {
        if (String(path).endsWith('fixtures.ts')) {
          throw Object.assign(new Error('EISDIR: illegal operation on a directory'), {
            code: 'EISDIR',
          });
        }
        return CLEAN;
      });
      await run();
      expect(process.exitCode).toBe(0);
      expect(out()).not.toContain('Could not read:');
    });
  });
});
