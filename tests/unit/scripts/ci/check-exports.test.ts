/**
 * Tests for the barrel-export check CLI.
 *
 * The rules are covered in `exports-diff.test.ts`; this covers the wiring, and
 * one property that matters more than it looks: the head side is read from the
 * **working tree**, so uncommitted exports are seen. A pre-PR gate that only
 * looked at `HEAD` would miss the export you just wrote.
 *
 * @see scripts/ci/check-exports.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockExecFileSync = vi.fn();
vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
  default: { execFileSync: mockExecFileSync },
}));

const { main, parseBaseRef, readBarrelsAt, readBarrelsFromDisk } =
  await import('@/scripts/ci/check-exports');

describe('scripts/ci/check-exports', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sunrise-exports-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('parseBaseRef', () => {
    it.each([
      [['--base', 'main'], { present: true, ref: 'main' }],
      [['--base=main'], { present: true, ref: 'main' }],
      [['--base'], { present: true, ref: '' }],
      [[], { present: false, ref: '' }],
      [['--baseline', 'main'], { present: false, ref: '' }],
    ])('parses %j', (argv, expected) => {
      expect(parseBaseRef(argv)).toEqual(expected);
    });
  });

  describe('readBarrelsFromDisk', () => {
    it('finds barrels at any depth and reads their symbols', () => {
      mkdirSync(join(dir, 'lib', 'security'), { recursive: true });
      mkdirSync(join(dir, 'lib', 'orchestration', 'llm'), { recursive: true });
      writeFileSync(join(dir, 'lib', 'security', 'index.ts'), `export const escapeHtml = 1;`);
      writeFileSync(
        join(dir, 'lib', 'orchestration', 'llm', 'index.ts'),
        `export type P = string;`
      );
      // Not a barrel — must not be collected.
      writeFileSync(join(dir, 'lib', 'security', 'sanitize.ts'), `export const hidden = 1;`);

      expect(readBarrelsFromDisk(dir)).toEqual([
        { file: 'lib/orchestration/llm/index.ts', symbols: ['P'], unresolvedStars: [] },
        { file: 'lib/security/index.ts', symbols: ['escapeHtml'], unresolvedStars: [] },
      ]);
    });

    it('follows `export *` to a sibling file on disk', () => {
      mkdirSync(join(dir, 'lib', 'x'), { recursive: true });
      writeFileSync(join(dir, 'lib', 'x', 'index.ts'), `export * from './inner';`);
      writeFileSync(join(dir, 'lib', 'x', 'inner.ts'), `export const deep = 1;`);

      expect(readBarrelsFromDisk(dir)[0].symbols).toEqual(['deep']);
    });

    it('follows `export *` to a nested index', () => {
      mkdirSync(join(dir, 'lib', 'x', 'sub'), { recursive: true });
      writeFileSync(join(dir, 'lib', 'x', 'index.ts'), `export * from './sub';`);
      writeFileSync(join(dir, 'lib', 'x', 'sub', 'index.ts'), `export const nested = 1;`);

      // `./sub` may be sub.ts or sub/index.ts; the resolver tries both.
      expect(readBarrelsFromDisk(dir).find((b) => b.file === 'lib/x/index.ts')?.symbols).toEqual([
        'nested',
      ]);
    });

    it('sees an uncommitted export, which is the point of a pre-PR gate', () => {
      // Written to disk and never committed — `git show HEAD:…` would not have
      // it, and this is exactly when you want the CHANGELOG question asked.
      mkdirSync(join(dir, 'lib', 'x'), { recursive: true });
      writeFileSync(join(dir, 'lib', 'x', 'index.ts'), `export const brandNew = 1;`);

      expect(readBarrelsFromDisk(dir)[0].symbols).toEqual(['brandNew']);
    });

    it("sees through the real repo's barrels, not just synthetic fixtures", () => {
      // The test that would have caught the shipped defect. Every fixture in
      // this file used `./inner` — a form ESLint forbids this codebase from
      // producing — so they all passed against a resolver that followed none
      // of the six `@/` stars actually in `lib/`.
      const barrels = readBarrelsFromDisk();
      const byFile = (file: string): string[] =>
        barrels.find((barrel) => barrel.file === file)?.symbols ?? [];

      // Behind `export * from '@/lib/orchestration/capabilities/types'` — and
      // a Daybreak fork seam, so exactly the surface this check exists for.
      expect(byFile('lib/orchestration/capabilities/index.ts')).toContain('CapabilityContext');
      // Behind `export * as costTracker from '…'`.
      expect(byFile('lib/orchestration/llm/index.ts')).toContain('costTracker');
      // And nothing was left unfollowed.
      expect(barrels.flatMap((barrel) => barrel.unresolvedStars)).toEqual([]);
    });

    it("resolves a nested star against ITS OWN directory, not the outer barrel's", () => {
      // The decoy is the point: `lib/x/deep.ts` also exists, so resolving
      // `./deep` from the outer barrel's directory returns a real file and a
      // confidently wrong answer with no unresolved-star warning — worse than
      // failing to resolve at all. Both single-level tests passed against that.
      mkdirSync(join(dir, 'lib', 'x', 'sub'), { recursive: true });
      writeFileSync(join(dir, 'lib', 'x', 'index.ts'), `export * from './sub/mod';`);
      writeFileSync(join(dir, 'lib', 'x', 'sub', 'mod.ts'), `export * from './deep';`);
      writeFileSync(join(dir, 'lib', 'x', 'sub', 'deep.ts'), `export const correct = 1;`);
      writeFileSync(join(dir, 'lib', 'x', 'deep.ts'), `export const decoy = 1;`);

      const barrel = readBarrelsFromDisk(dir).find((b) => b.file === 'lib/x/index.ts');

      expect(barrel?.symbols).toEqual(['correct']);
      expect(barrel?.unresolvedStars).toEqual([]);
    });

    it('does not follow a star out of the root', () => {
      // `posix.normalize` collapses `..` but does not stop it. Only symbol
      // names ever reach the output, so no file content leaks — but /pre-pr
      // asks for that output to be recorded in a PR summary, and identifier
      // names from a private sibling checkout are not ours to print.
      mkdirSync(join(dir, 'repo', 'lib', 'x'), { recursive: true });
      mkdirSync(join(dir, 'outside'), { recursive: true });
      writeFileSync(join(dir, 'outside', 'secret.ts'), `export const LEAKED = 1;`);
      writeFileSync(
        join(dir, 'repo', 'lib', 'x', 'index.ts'),
        `export * from '../../../outside/secret';\nexport const legit = 1;`
      );

      expect(readBarrelsFromDisk(join(dir, 'repo'))[0].symbols).toEqual(['legit']);
    });

    it('flags an unreadable barrel rather than calling it empty', () => {
      // "Exports nothing" and "could not be read" are different answers; the
      // second read as a wholesale removal with no warning.
      mkdirSync(join(dir, 'lib', 'x'), { recursive: true });
      // A directory where a file is expected: listed, but unreadable.
      mkdirSync(join(dir, 'lib', 'x', 'index.ts'));

      const barrel = readBarrelsFromDisk(dir).find((b) => b.file === 'lib/x/index.ts');

      expect(barrel?.symbols).toEqual([]);
      expect(barrel?.unresolvedStars).toEqual(['lib/x/index.ts']);
    });

    it('returns nothing when there is no lib directory', () => {
      expect(readBarrelsFromDisk(dir)).toEqual([]);
    });
  });

  describe('readBarrelsAt', () => {
    /** Serves a fake git tree: one barrel re-exporting a sibling. */
    function serveTree(): void {
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'ls-tree') return 'lib/x/index.ts\nlib/x/inner.ts\nlib/x/notes.md\n';
        if (args[0] === 'show' && args[1].endsWith('lib/x/index.ts')) {
          return `export * from './inner';\nexport const own = 1;`;
        }
        if (args[0] === 'show' && args[1].endsWith('lib/x/inner.ts')) {
          return `export const inherited = 2;`;
        }
        throw new Error('fatal: path does not exist');
      });
    }

    it('reads only barrels, and follows their stars within the revision', () => {
      serveTree();

      expect(readBarrelsAt('abc123')).toEqual([
        { file: 'lib/x/index.ts', symbols: ['inherited', 'own'], unresolvedStars: [] },
      ]);
    });

    it('returns null when the revision cannot be listed', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('fatal: not a tree object');
      });

      expect(readBarrelsAt('nope')).toBeNull();
    });
  });

  describe('main', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;
    const out = (): string =>
      [...logSpy.mock.calls, ...errorSpy.mock.calls]
        .map((call: unknown[]) => String(call[0]))
        .join('\n');

    beforeEach(() => {
      // Before the spies: this file shares one git mock across describes, and
      // an assertion that it was never called would otherwise see the previous
      // test's calls.
      vi.clearAllMocks();
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('fails rather than reporting a clean bill when it found no barrels at all', () => {
      // Run from a subdirectory, both sides come back empty and the old code
      // printed "No barrel exports changed … (0 barrels)" and exited 0.
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'merge-base') return 'abc123\n';
        if (args[0] === 'ls-tree') return '';
        throw new Error('unexpected');
      });
      const cwd = vi.spyOn(process, 'cwd').mockReturnValue(join(dir, 'empty'));

      expect(main([])).toBe(1);
      expect(out()).toContain('Found no barrels on either revision');
      cwd.mockRestore();
    });

    it('does not invent a change list for a barrel it could not read', () => {
      // Left in the diff with `symbols: []`, an unreadable barrel makes every
      // symbol on the other side look added or removed. Excluded instead; the
      // warning above already says we could not look.
      mkdirSync(join(dir, 'lib', 'gone'), { recursive: true });
      writeFileSync(join(dir, 'lib', 'gone', 'index.ts'), `export const kept = 1;`);
      const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);

      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'merge-base') return 'abc123\n';
        if (args[0] === 'ls-tree') return 'lib/gone/index.ts\n';
        // The base listing offers it; `show` cannot produce it.
        throw new Error('fatal: path does not exist');
      });

      expect(main([])).toBe(0);
      expect(out()).toContain('Could not follow every `export *`');
      // The tell: without the exclusion this prints `+ kept` under
      // "Public surface changed".
      expect(out()).not.toContain('+ kept');
      expect(out()).toContain('No barrel exports changed');
      cwd.mockRestore();
    });

    it('rejects an empty --base rather than silently falling back', () => {
      expect(main(['--base', ''])).toBe(1);
      expect(out()).toContain('needs a revision');
    });

    it('rejects a --base that would be read as a git option', () => {
      // A `--` separator cannot fix this: `git show <rev>:<path>` reads the
      // spec after `--` as a pathspec, not a revision, which silently breaks
      // the whole check. Validating the ref is the working guard.
      expect(main(['--base', '--output=/tmp/x'])).toBe(1);
      expect(out()).toContain('must be a revision, not an option');
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('skips when there is no base revision to compare against', () => {
      // A fresh clone with no remote must not fail the run.
      mockExecFileSync.mockImplementation(() => {
        throw new Error('fatal: not a git repository');
      });

      expect(main([])).toBe(0);
      expect(out()).toContain('no base revision available');
    });

    it('fails when an explicitly requested base is unreadable', () => {
      mockExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error('Command failed'), { stderr: 'fatal: bad revision\n' });
      });

      expect(main(['--base', 'nope'])).toBe(1);
      expect(out()).toContain('git: fatal: bad revision');
    });

    it('says when a star could not be followed, instead of reporting a clean comparison', () => {
      // The mechanism that makes an incomplete read loud. Without it, a
      // resolver that followed NONE of this repo's stars printed "no barrel
      // exports changed" and looked healthy — which is how that shipped.
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'merge-base') return 'abc123\n';
        if (args[0] === 'ls-tree') return 'lib/x/index.ts\n';
        // ONLY the barrel. An earlier version answered every `show`, so
        // `@/lib/nowhere` resolved, the parser recursed to the depth cap, and
        // the specifier was pushed by that path instead of the
        // resolver-returned-null branch this test names.
        if (args[0] === 'show' && String(args[1]).endsWith('lib/x/index.ts')) {
          return `export * from '@/lib/nowhere';`;
        }
        throw new Error('fatal: path does not exist');
      });

      main([]);

      expect(out()).toContain('Could not follow every `export *`');
      expect(out()).toContain('@/lib/nowhere');
    });

    it('reports what changed, and asks the CHANGELOG question, without gating', () => {
      // Base serves one barrel the working tree does not have, so every real
      // barrel reads as added and that one as removed.
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'merge-base') return 'abc123\n';
        if (args[0] === 'ls-tree') return 'lib/gone/index.ts\n';
        if (args[0] === 'show') return `export const vanished = 1;`;
        throw new Error('unexpected');
      });

      // Reports, never gates: adding an export is normal and correct.
      expect(main([])).toBe(0);
      expect(out()).toContain('Public surface changed');
      expect(out()).toContain('- vanished');
      expect(out()).toContain('CHANGELOG');
    });
  });
});
