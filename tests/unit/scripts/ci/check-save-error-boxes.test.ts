/**
 * Tests for the save-error box check's CLI (§124 t-950).
 *
 * The rules are covered in `save-error-boxes.test.ts`; this covers the
 * WIRING: which files are walked, what fails the run, and what the operator
 * is told when the walk finds nothing at all (run from the wrong directory,
 * a clean bill over zero files is the failure this kind of check exists to
 * prevent). Each case builds its own tree in a temp directory; the real tree
 * is checked by `npm run check:save-errors` in `validate`.
 *
 * @see scripts/ci/check-save-error-boxes.ts
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listComponentSources, main } from '@/scripts/ci/check-save-error-boxes';
import { BOX_EXEMPTIONS } from '@/scripts/ci/save-error-boxes';

const HAND_DRAWN = `
import { useState } from 'react';
export function Form() {
  const [error, setError] = useState<string | null>(null);
  async function save() {
    try { await apiClient.patch('/x'); } catch { setError('Could not save'); }
  }
  return <div>{error && <p className="text-destructive">{error}</p>}</div>;
}`;

const SHARED = `
export function Form() {
  const save = useSaveFailure({ fallback: 'Could not save' });
  return <SaveError failure={save.failure} />;
}`;

describe('scripts/ci/check-save-error-boxes', () => {
  let root: string;
  let errors: string[];
  let logs: string[];

  function write(files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
  }

  /** Every shipped exemption, matched by a box in the temp tree, so none reads as stale. */
  function writeExemptedBoxes() {
    const byPath = new Map<string, string[]>();
    for (const key of Object.keys(BOX_EXEMPTIONS)) {
      const [path, state] = key.split('#');
      byPath.set(path, [...(byPath.get(path) ?? []), state]);
    }
    for (const [path, states] of byPath) {
      const setter = (state: string) => `set${state[0].toUpperCase()}${state.slice(1)}`;
      write({
        [path]: [
          "import { useState } from 'react';",
          'export function Run() {',
          ...states.map((st) => `  const [${st}, ${setter(st)}] = useState<string | null>(null);`),
          '  async function run() {',
          `    try { await apiClient.post('/run'); } catch { ${states.map((st) => `${setter(st)}('Failed');`).join(' ')} }`,
          '  }',
          `  return <div>${states.map((st) => `<p className="text-destructive">{${st}}</p>`).join('')}</div>;`,
          '}',
        ].join('\n'),
      });
    }
    return byPath.size;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'save-error-boxes-'));
    errors = [];
    logs = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.join(' '));
    });
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('fails, and says where it looked, when it finds no files', () => {
    expect(main(root)).toBe(1);
    expect(errors.join('\n')).toContain('Found no .tsx files');
    expect(logs).toEqual([]);
  });

  it('walks .tsx under components/ and app/ only', () => {
    write({
      'components/a/b.tsx': SHARED,
      'app/(auth)/page.tsx': SHARED,
      'components/a/helper.ts': SHARED,
      'lib/c.tsx': SHARED,
    });

    expect(listComponentSources(root)).toEqual(['app/(auth)/page.tsx', 'components/a/b.tsx']);
  });

  it('fails on a planted hand-drawn box and names it', () => {
    writeExemptedBoxes();
    write({ 'components/forms/new-form.tsx': HAND_DRAWN });

    expect(main(root)).toBe(1);
    expect(errors.join('\n')).toContain(
      'components/forms/new-form.tsx:8  renders `error` in a red box of its own'
    );
  });

  it('passes a tree that uses the shared component, naming how much it scanned', () => {
    const exemptFiles = writeExemptedBoxes();
    write({ 'components/forms/new-form.tsx': SHARED });

    expect(main(root)).toBe(0);
    const count = exemptFiles + 1;
    expect(logs).toEqual([`Save-error boxes OK (${count} files under components/, app/ scanned).`]);
  });

  it('skips a directory whose name ends in .tsx rather than reporting it unreadable', () => {
    const exemptFiles = writeExemptedBoxes();
    mkdirSync(join(root, 'components/odd.tsx'), { recursive: true });
    write({ 'components/odd.tsx/form.tsx': SHARED });

    expect(main(root)).toBe(0);
    // The directory is listed but not counted as a file it read; its child is.
    expect(logs).toEqual([
      `Save-error boxes OK (${exemptFiles + 2} files under components/, app/ scanned).`,
    ]);
    expect(errors).toEqual([]);
  });

  it('fails, naming the file, when one it found cannot be read', () => {
    writeExemptedBoxes();
    write({ 'components/forms/locked.tsx': HAND_DRAWN });
    chmodSync(join(root, 'components/forms/locked.tsx'), 0o000);

    try {
      // "I could not look" must not read as "there is nothing there".
      expect(main(root)).toBe(1);
      expect(errors.join('\n')).toContain('Could not read:\n  components/forms/locked.tsx');
      expect(errors.join('\n')).not.toContain('Hand-drawn save-error boxes found');
    } finally {
      chmodSync(join(root, 'components/forms/locked.tsx'), 0o644);
    }
  });

  it('fails on an exemption that no longer matches a box', () => {
    write({ 'components/forms/new-form.tsx': SHARED });

    expect(main(root)).toBe(1);
    expect(errors.join('\n')).toContain('Exemptions that no longer match a box');
  });
});
