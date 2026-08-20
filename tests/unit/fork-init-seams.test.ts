/**
 * Every fork init seam runs through the shared gate.
 *
 * `.context/architecture/fork-init-seams.md` carries a roster of the eleven
 * `lib/app/*` seams and states one guarantee for all of them: a throwing
 * `initApp*()` leaves the registry as it was. A roster written in prose is
 * exactly how #633 happened — the issue named four of the seven that were
 * broken, because the list was read rather than derived. So this derives it.
 *
 * It fails when a new seam hand-rolls the latch/try/catch instead of calling
 * `createAppInitGate`, and it fails when the documented roster and the code
 * disagree in either direction.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const APP_DIR = join(process.cwd(), 'lib', 'app');
const DOC = join(process.cwd(), '.context', 'architecture', 'fork-init-seams.md');

/**
 * Seams that legitimately do NOT use the gate. A pinned list with a stated
 * reason, not a path prefix — so a NEW hand-rolled seam fails rather than being
 * absorbed by a pattern someone widened once.
 */
const EXEMPT = new Map<string, string>([
  [
    'initAppNav',
    'Called at module scope from components/admin/admin-sidebar.tsx in the CLIENT ' +
      'realm (module registries do not cross Next bundle boundaries). A throw fails ' +
      "the module's evaluation, so nothing reads the partial registry — loud, and a " +
      'different shape from the lazy server-side family.',
  ],
]);

/** Source files that could consume a seam. Excludes tests and the scaffolds. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/** `initApp*` functions exported by the fork-owned scaffolds, at column 0. */
function declaredSeams(): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(APP_DIR)) {
    if (!file.endsWith('.ts')) continue;
    const src = readFileSync(join(APP_DIR, file), 'utf8');
    // Column-anchored: `lib/app/*` scaffolds carry the same signature inside a
    // JSDoc example block, indented. Matching those would double-count.
    for (const m of src.matchAll(/^export function (initApp\w*)\s*\(/gm)) {
      names.add(m[1]);
    }
  }
  return [...names].sort();
}

const SEAMS = declaredSeams();
const FILES = [
  ...sourceFiles(join(process.cwd(), 'lib')),
  ...sourceFiles(join(process.cwd(), 'components')),
  ...sourceFiles(join(process.cwd(), 'app')),
].filter((f) => !f.startsWith(APP_DIR));

describe('fork init seams', () => {
  it('finds the seams at all', () => {
    // The #634 lesson: an enumerating check whose scanner matches nothing goes
    // green while looking healthy. Pin a floor so a broken regex fails loudly.
    expect(SEAMS.length).toBeGreaterThanOrEqual(11);
    expect(FILES.length).toBeGreaterThan(500);
  });

  it.each(SEAMS)('%s is consumed through the shared gate', (seam) => {
    // Detected by IMPORT, not by call site. The gate takes the seam as a
    // reference (`init: initAppJobs`) rather than calling it, so a call-shaped
    // scanner finds nothing — it did, on the first run of this test, and
    // reported all eleven seams as dead wiring rather than going quietly green.
    const consumers = FILES.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return new RegExp(`import\\s*\\{[^}]*\\b${seam}\\b[^}]*\\}\\s*from`, 's').test(src);
    });

    expect(consumers, `${seam} has no consumer — the seam is dead wiring`).not.toHaveLength(0);

    const reason = EXEMPT.get(seam);
    for (const consumer of consumers) {
      const src = readFileSync(consumer, 'utf8');
      const usesGate = src.includes("from '@/lib/fork-init'");
      if (reason) {
        expect(
          usesGate,
          `${seam} is on the EXEMPT list but ${consumer} now uses the gate — ` +
            `delete its exemption rather than leaving a stale reason`
        ).toBe(false);
      } else {
        expect(
          usesGate,
          `${consumer} runs ${seam} without createAppInitGate. Hand-rolling the ` +
            `latch/try/catch is what #633 fixed — see .context/architecture/fork-init-seams.md`
        ).toBe(true);
      }
    }
  });

  it('the documented roster matches the code, in both directions', () => {
    const doc = readFileSync(DOC, 'utf8');
    const documented = new Set([...doc.matchAll(/`(initApp\w+)(?:\(\))?`/g)].map((m) => m[1]));

    const missing = SEAMS.filter((s) => !documented.has(s));
    expect(missing, 'seams that exist in code but not in the roster').toEqual([]);

    const stale = [...documented].filter((s) => !SEAMS.includes(s));
    expect(stale, 'seams named in the roster that no longer exist').toEqual([]);
  });
});
