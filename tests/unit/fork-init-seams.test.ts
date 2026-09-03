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
  [
    'initApp',
    'The app BOOT hook (lib/app/bootstrap.ts), not a registry seam. Called once from ' +
      "instrumentation.ts's register(), and it is the only async one. It registers " +
      'nothing itself, so there is no registry to snapshot or roll back.',
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
    //
    // `async` is in the pattern because leaving it out did not narrow the check,
    // it BLINDED it: `bootstrap.ts`'s `export async function initApp()` was
    // invisible, so a future async seam would have been silently uncovered by
    // the check whose whole job is to notice a new seam.
    for (const m of src.matchAll(/^export (?:async )?function (initApp\w*)\s*\(/gm)) {
      names.add(m[1]);
    }
  }
  return [...names].sort();
}

/**
 * `registerApp*` functions exported by the fork-owned scaffolds, at column 0.
 *
 * A SECOND family, and it was unguarded until this was added. `initApp*` seams
 * run through `createAppInitGate`; these are called directly by the one core
 * module that needs them (`registerAppDriftProbes` by the drift registry,
 * `registerAppRateLimits` by the middleware, `registerAppProviderEligibility`
 * by the agent resolver). Different mechanism, identical failure: a scaffold
 * nothing imports is dead wiring, and every fork's registrations silently never
 * run.
 *
 * Only the dead-wiring half is asserted for these — there is no shared gate to
 * check them against, by design, because each has exactly one consumer that
 * must call it before its own first use.
 */
function declaredRegistrars(): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(APP_DIR)) {
    if (!file.endsWith('.ts')) continue;
    const src = readFileSync(join(APP_DIR, file), 'utf8');
    for (const m of src.matchAll(/^export (?:async )?function (registerApp\w*)\s*\(/gm)) {
      names.add(m[1]);
    }
  }
  return [...names].sort();
}

const SEAMS = declaredSeams();
const REGISTRARS = declaredRegistrars();
const FILES = [
  ...sourceFiles(join(process.cwd(), 'lib')),
  ...sourceFiles(join(process.cwd(), 'components')),
  ...sourceFiles(join(process.cwd(), 'app')),
  // Root-level, and the only consumer of the boot seam. Omitting it made
  // `initApp` look like dead wiring rather than an exempt one.
  join(process.cwd(), 'instrumentation.ts'),
].filter((f) => !f.startsWith(APP_DIR));

/** Everything `FILES` covers, plus `scripts/` — see the registrar check below. */
const REGISTRAR_FILES = [...FILES, ...sourceFiles(join(process.cwd(), 'scripts'))].filter(
  (f) => !f.startsWith(APP_DIR)
);

describe('fork init seams', () => {
  it('finds the seams at all', () => {
    // The #634 lesson: an enumerating check whose scanner matches nothing goes
    // green while looking healthy. An EXACT count, not a floor — a floor set one
    // below the real number lets exactly one seam drop out of the scan
    // undetected, which is the case that matters. Update it deliberately when
    // adding a seam.
    expect(SEAMS.length).toBe(13);
    // Same exact-count discipline for the registrar family, and for the same
    // reason: a floor one below the real number lets exactly one scaffold drop
    // out of the scan undetected.
    expect(REGISTRARS.length).toBe(3);
    expect(FILES.length).toBeGreaterThan(500);
  });

  it.each(REGISTRARS)('%s is imported by the core module that runs it', (registrar) => {
    // Import-detection, matching the seam check above — a registrar is called,
    // not passed as a reference, but the import is the thing that cannot be
    // faked by a comment or a JSDoc example. It is not a nicety here: the drift
    // registrar is NAMED in a `lib/db/drift-probes.ts` docblock while its only
    // real consumer is a CLI script, so a mention-matching scanner would have
    // reported it healthy no matter what happened to the wiring.
    //
    // Wider file set than the seam check above, deliberately. An `initApp*`
    // seam runs in the app runtime; a registrar's single consumer may be a
    // CLI entry point — `registerAppDriftProbes` is invoked by
    // `scripts/db/check-drift.ts`, which `FILES` excludes. Scoping this to
    // FILES reported that live seam as dead wiring on the first run.
    const consumers = REGISTRAR_FILES.filter((f) =>
      new RegExp(`\\{[^}]*\\b${registrar}\\b[^}]*\\}\\s*=?\\s*(?:from|await import)`, 's').test(
        readFileSync(f, 'utf8')
      )
    );

    expect(
      consumers,
      `${registrar} has no consumer — the scaffold is dead wiring, and every ` +
        `fork's registrations in it would silently never run`
    ).not.toHaveLength(0);
  });

  it.each(SEAMS)('%s is consumed through the shared gate', (seam) => {
    // Detected by IMPORT, not by call site. The gate takes the seam as a
    // reference (`init: initAppJobs`) rather than calling it, so a call-shaped
    // scanner finds nothing — it did, on the first run of this test, and
    // reported all eleven seams as dead wiring rather than going quietly green.
    const consumers = FILES.filter((f) => {
      const src = readFileSync(f, 'utf8');
      // `import { X } from …` and `const { X } = await import(…)` — the boot
      // seam uses the second form.
      return new RegExp(`\\{[^}]*\\b${seam}\\b[^}]*\\}\\s*=?\\s*(?:from|await import)`, 's').test(
        src
      );
    });

    expect(consumers, `${seam} has no consumer — the seam is dead wiring`).not.toHaveLength(0);

    const reason = EXEMPT.get(seam);
    for (const consumer of consumers) {
      const src = readFileSync(consumer, 'utf8');
      // Tied to THIS seam, not merely to the module. Matching any import from
      // `@/lib/fork-init` passed a file that imports only `describeThrown` while
      // hand-rolling its own latch — and `capabilities/registry.ts` imports
      // exactly that alongside the gate, so the loose version was one edit away
      // from waving through the seam it was written to watch.
      const usesGate =
        /import\s*\{[^}]*\bcreateAppInitGate\b[^}]*\}\s*from\s*'@\/lib\/fork-init'/s.test(src) &&
        new RegExp(`init:\\s*${seam}\\b`).test(src);
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
    const documented = new Set([...doc.matchAll(/`(initApp\w*)(?:\(\))?`/g)].map((m) => m[1]));

    const missing = SEAMS.filter((s) => !documented.has(s));
    expect(missing, 'seams that exist in code but not in the roster').toEqual([]);

    const stale = [...documented].filter((s) => !SEAMS.includes(s));
    expect(stale, 'seams named in the roster that no longer exist').toEqual([]);
  });
});
