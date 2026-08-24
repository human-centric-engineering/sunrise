/**
 * Unit Tests: the reserved fork tiers stay empty upstream
 *
 * CLAUDE.md and CUSTOMIZATION.md both promise that "Sunrise core never creates
 * files or tables under either tier", which is what lets a fork's files there
 * merge cleanly on `git merge vX.Y.Z`. Until now that promise was prose with
 * nothing enforcing it — and the cost of breaking it is not a conflict a
 * maintainer resolves, it is a platform file landing on top of fork code that
 * two forks are already shipping (`components/app/**` in ConQuest and Reclaim
 * Your Week, discovered while fixing #561).
 *
 * Two kinds of reservation, and the distinction is the point:
 *
 *   - **Empty reservations** — Sunrise ships nothing at all. A fork creates
 *     whatever structure suits it. Asserted here.
 *   - **Scaffold tiers** (`lib/app/**`) — Sunrise ships files that export
 *     `null` or an empty function, once, and then does not change them. Those
 *     legitimately have content, so they are deliberately NOT asserted empty.
 *
 * ## The fork axis (#660)
 *
 * The carve-out above is along the *tier* axis. There is a second axis this file
 * originally missed: **who is running it**. Upstream, "these directories are
 * empty" is the promise being kept. In a fork the same directories are the space
 * the fork was *told* to fill, so the assertion is unsatisfiable and the failure
 * message blames core for files core never created. Four of the five known forks
 * hit it on `git merge v0.10.0` — including on the two `/framework` rows, which a
 * framework-layer fork occupies exactly as a leaf fork occupies `/app`.
 *
 * A fork therefore declares what it occupies in `lib/app/reserved-tiers.ts`, and
 * this file subtracts it. Upstream declares nothing, so every row below still
 * runs against Sunrise itself — which is the only place the promise means
 * anything. The alternative, which four forks were already living with, is each
 * fork maintaining its own edited copy of this file and re-resolving it on every
 * upgrade.
 *
 * FORK NOTE — this file reads `lib/app/reserved-tiers.ts` for real, on purpose.
 * That declaration is how the test learns which tiers are yours rather than
 * core's. Fill it with the tiers you actually occupy and the TIER rows adjust
 * themselves; if one still fails afterwards, the tier it names is one you have
 * not declared. The reverse fails too: declaring a tier you have left empty is
 * reported, so the declaration cannot rot into silence.
 *
 * The declaration covers the tier rows and NOTHING ELSE in this file. In
 * particular `prisma/schema/app.prisma declares no models` is not tier-aware,
 * and CUSTOMIZATION.md tells you to put your own models in exactly that file —
 * so a fork with app models must pin that row the ordinary way (§4). Two edits,
 * then, not none: the declaration, and the `lib/app/reserved-tiers.ts` row in
 * tests/unit/lib/app/defaults.test.ts, which fails the moment you declare
 * anything.
 *
 * @see CUSTOMIZATION.md "The app/platform model" · lib/app/reserved-tiers.ts
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { occupiedTiers } from '@/lib/app/reserved-tiers';

const REPO_ROOT = process.cwd();

/**
 * Reserved directories that must EXIST in git — a reservation a fork cannot
 * find is not a reservation. Both were invented independently by forks before
 * Sunrise named them, which is the whole argument for shipping the directory
 * rather than only writing it down.
 */
const MATERIALISED_RESERVATIONS = ['components/app', 'components/framework'] as const;

/**
 * Reserved namespaces Sunrise does not currently ship a placeholder for. Still
 * asserted empty — the promise is "core creates nothing here" either way — but
 * NOT asserted to exist, because they never have.
 *
 * The distinction matters: without it these rows pass vacuously (a missing
 * directory trivially contains no platform files), so the test would report
 * success on a reservation nobody can act on.
 */
const UNMATERIALISED_RESERVATIONS = [
  'lib/framework',
  '.context/framework',
  '.context/app',
] as const;

const ALL_EMPTY_RESERVATIONS = [
  ...MATERIALISED_RESERVATIONS,
  ...UNMATERIALISED_RESERVATIONS,
] as const;

/**
 * Tiers THIS checkout occupies, declared by the fork in `lib/app/reserved-tiers.ts`.
 *
 * Upstream this is `[]` and `EMPTY_RESERVATIONS` below is the full five, so the
 * assertion is byte-identical to what it was before the seam existed — Sunrise
 * still checks itself on every row.
 *
 * In a fork the rows it occupies are the ones it was *told* to fill, so
 * asserting them empty can only ever fail; see the seam's docblock for why the
 * test cannot infer this and what a fork gives up by declaring.
 */
const EMPTY_RESERVATIONS = ALL_EMPTY_RESERVATIONS.filter((dir) => !occupiedTiers.includes(dir));

const PLACEHOLDER_NAMES = new Set(['.gitkeep', '.gitignore', 'README.md']);

/** Every file under `dir`, repo-relative, recursively. */
function filesUnder(dir: string): string[] {
  const abs = join(REPO_ROOT, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(REPO_ROOT, rel))) {
      const childRel = join(rel, entry);
      if (statSync(join(REPO_ROOT, childRel)).isDirectory()) walk(childRel);
      else out.push(childRel);
    }
  };
  walk(dir);
  return out;
}

describe('reserved fork tiers', () => {
  it('the occupied-tier declaration is valid, and cannot silently empty the table', () => {
    // Validates the declaration itself. It has to be its own row because
    // `it.each([])` defines NO tests and still reports a pass, so everything
    // below can be skipped by a declaration without anything saying so.
    //
    // What stops a declaration going too far is NOT arithmetic — an earlier
    // version asserted that the kept and declared counts summed to five, which
    // the two checks above make tautological. It is the per-declared-tier row
    // further down: every tier you declare must really hold your files, so
    // declaring one you have not filled fails rather than silently disabling a
    // guard.
    const unknown = occupiedTiers.filter(
      (dir) => !(ALL_EMPTY_RESERVATIONS as readonly string[]).includes(dir)
    );
    expect(
      unknown,
      `lib/app/reserved-tiers.ts declares a tier that is not a reserved tier. ` +
        `A name that matches nothing exempts nothing, so this would read as a ` +
        `working declaration while the row it was meant to silence still failed. ` +
        `Valid values: ${ALL_EMPTY_RESERVATIONS.join(', ')}.`
    ).toEqual([]);

    expect(
      [...new Set(occupiedTiers)],
      'lib/app/reserved-tiers.ts lists the same tier more than once'
    ).toEqual([...occupiedTiers]);
  });

  it.each(occupiedTiers)('%s is declared occupied and really does hold fork files', (dir) => {
    // Vacuous upstream (nothing is declared), and deliberately so — this is a
    // fork-side property. A declaration for a tier the fork does not actually
    // fill removes a live guard in exchange for nothing, and would survive
    // forever because the row it silenced is the only thing that would complain.
    // Tying the declaration to the files makes it self-cleaning: delete the
    // files and this fails until the declaration goes too, restoring the guard.
    const own = filesUnder(dir).filter((f) => {
      const rel = f.slice(dir.length + 1);
      return rel.includes('/') || !PLACEHOLDER_NAMES.has(rel);
    });

    expect(
      own.length,
      `lib/app/reserved-tiers.ts declares "${dir}" as occupied, but it holds no ` +
        `files beyond the placeholder. Drop it from the declaration so the ` +
        `emptiness guard comes back.`
    ).toBeGreaterThan(0);
  });

  it.each(EMPTY_RESERVATIONS)('%s holds nothing but a placeholder', (dir) => {
    // Placeholders are exempt only at the reservation ROOT. Matching on
    // basename at any depth would let a platform-created
    // `components/app/whatever/README.md` through — the exemption is for the
    // one file that explains the reservation, not for any file that happens to
    // be named like one.
    const unexpected = filesUnder(dir).filter((f) => {
      const rel = f.slice(dir.length + 1);
      return rel.includes('/') || !PLACEHOLDER_NAMES.has(rel);
    });

    expect(
      unexpected,
      `Unexpected files under the reserved tier "${dir}".\n\n` +
        `IF THIS IS A FORK and these are yours: that is the arrangement working, not a ` +
        `defect. Add "${dir}" to \`occupiedTiers\` in lib/app/reserved-tiers.ts and this row ` +
        `stops checking it — then pin the new value in tests/unit/lib/app/defaults.test.ts, ` +
        `as for any seam. Do NOT move your files.\n\n` +
        `IF THIS IS SUNRISE CORE: core must not create files here. A fork already has its ` +
        `own files in this tier and an upgrade would land these on top of them. Platform ` +
        `code belongs in a named domain folder — see CUSTOMIZATION.md "The app/platform model".`
    ).toEqual([]);
  });

  it.each(MATERIALISED_RESERVATIONS)('%s exists in git so a fork can find it', (dir) => {
    // An unreserved-but-undocumented directory is how two forks ended up
    // inventing `components/app/` independently, and a third inventing
    // `components/hub/`. Writing the reservation down is not enough — the
    // directory has to be there when someone goes looking.
    expect(
      existsSync(join(REPO_ROOT, dir)),
      `"${dir}" is named as a reserved tier in CLAUDE.md and CUSTOMIZATION.md but ` +
        `does not exist, so nobody can find it. Ship a .gitkeep explaining the reservation.`
    ).toBe(true);
    expect(filesUnder(dir).length).toBeGreaterThan(0);
  });

  it('prisma/schema/app.prisma declares no models', () => {
    // The same promise, in the file the docs single out as "ships empty".
    const src = readFileSync(join(REPO_ROOT, 'prisma/schema/app.prisma'), 'utf8');
    const declarations = src
      .split('\n')
      .filter((line) => /^\s*(model|enum|type|view)\s+\w+/.test(line));

    expect(
      declarations,
      'prisma/schema/app.prisma is fork-reserved and ships empty; platform ' +
        'app-domain models belong in prisma/schema/platform.prisma.'
    ).toEqual([]);
  });

  it('the reservation is documented in both places a fork would look', () => {
    // Prose and enforcement drifting apart is the failure this whole file
    // exists to prevent, so assert they agree.
    const claude = readFileSync(join(REPO_ROOT, 'CLAUDE.md'), 'utf8');
    const customization = readFileSync(join(REPO_ROOT, 'CUSTOMIZATION.md'), 'utf8');

    for (const doc of [claude, customization]) {
      expect(doc).toContain('components/app');
      expect(doc).toContain('components/framework');
    }
  });
});
