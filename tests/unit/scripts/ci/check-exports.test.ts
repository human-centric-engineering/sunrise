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
        { file: 'lib/orchestration/llm/index.ts', symbols: ['P'] },
        { file: 'lib/security/index.ts', symbols: ['escapeHtml'] },
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
        { file: 'lib/x/index.ts', symbols: ['inherited', 'own'] },
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
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('rejects an empty --base rather than silently falling back', () => {
      expect(main(['--base', ''])).toBe(1);
      expect(out()).toContain('needs a revision');
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
