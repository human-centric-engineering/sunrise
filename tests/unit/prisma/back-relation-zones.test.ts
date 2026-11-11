/**
 * Guard: the fork zones at the end of `Org` and `User` (sunrise#859).
 *
 * Prisma relations are two-sided. A fork model with an `org` relation (which
 * every tenant-owned model must carry) or a `user` relation (which the erasure
 * rule asks for) needs a back-relation line on `Org` or `User`, both of which
 * are core models. Before the zones, each fork appended a block straight after
 * core's last line, and core appended its own new lines to that same spot, so
 * every tenancy release conflicted with every fork carrying a block.
 *
 * The zones fix that by placement. Each model ends with two fixed markers:
 *
 *     ...core's back-relations...
 *
 *     // ── Framework zone: ... ──     ← a framework fork (Daybreak) writes below
 *
 *     // ── App zone: ... ──           ← a leaf app writes below
 *
 * Core never edits below the first marker, so git always has an unchanged
 * line between core's edits and a fork's, and the merge is clean. A fork
 * filling its zone is therefore not a divergence (CUSTOMIZATION.md, "The
 * divergence ledger").
 *
 * What breaks the arrangement, and what this file fails on:
 *
 * - **A core line below a marker.** `prisma format` appends a missing
 *   back-relation at the END of the model, which is the app zone. A core
 *   change that lets the formatter place its line puts it where every leaf
 *   writes, and the conflicts are back.
 * - **A fork line above the framework marker, or in another tier's zone.**
 *   Expected once, on the sync that brings the zones in, for a fork that
 *   carried a block before them: move the block below your marker.
 * - **A marker edited, missing, duplicated or out of order.** The markers are
 *   the unchanged lines the merge relies on; rewording one is itself an edit
 *   every fork has to merge.
 *
 * A model's tier is read from the file that defines it, by the naming the
 * reserved tiers already use: `framework-*.prisma` is the framework tier,
 * `app.prisma` and `app-*.prisma` the app tier, every other file core. In
 * Sunrise no fork-tier model exists, so both zones are empty by construction.
 *
 * @see prisma/schema/tenancy.prisma · prisma/schema/auth.prisma
 * @see CUSTOMIZATION.md §5 "Relating your models to `Org` and `User`"
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA_DIR = join(process.cwd(), 'prisma/schema');

const FRAMEWORK_MARKER =
  '// ── Framework zone: back-relations to framework-*.prisma models. Sunrise never edits below here. ──';
const APP_MARKER =
  '// ── App zone: back-relations to app.prisma / app-*.prisma models. Sunrise never edits below here. ──';

type Tier = 'core' | 'framework' | 'app';

/** The zone a model's back-relation belongs in, from the file that defines it. */
function tierOfFile(file: string): Tier {
  if (/^framework-.+\.prisma$/.test(file)) return 'framework';
  if (/^app(-.+)?\.prisma$/.test(file)) return 'app';
  return 'core';
}

/** The body lines of `model <name> { … }` in `source`, or null when absent. */
function modelBody(source: string, name: string): string[] | null {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^model ${name}\\s*\\{`).test(l));
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && /^\}/.test(l));
  return lines.slice(start + 1, end);
}

/**
 * Every way `body` breaks the zone layout, as readable lines. `tierOf` maps a
 * model name to its tier; a field whose type is not a model (a scalar, an
 * enum) is not a back-relation and is ignored.
 */
function zoneViolations(body: string[], tierOf: Map<string, Tier>): string[] {
  const problems: string[] = [];
  const trimmed = body.map((l) => l.trim());
  const fw = trimmed.filter((l) => l === FRAMEWORK_MARKER).length;
  const app = trimmed.filter((l) => l === APP_MARKER).length;
  if (fw !== 1 || app !== 1) {
    problems.push(
      `expected each zone marker exactly once, found framework ×${fw} and app ×${app}. ` +
        `The markers must stay exactly as Sunrise ships them:\n  ${FRAMEWORK_MARKER}\n  ${APP_MARKER}`
    );
    return problems;
  }
  if (trimmed.indexOf(FRAMEWORK_MARKER) > trimmed.indexOf(APP_MARKER)) {
    problems.push('the framework zone marker must come before the app zone marker');
    return problems;
  }

  let zone: Tier = 'core';
  for (const line of trimmed) {
    if (line === FRAMEWORK_MARKER) zone = 'framework';
    else if (line === APP_MARKER) zone = 'app';
    const field = /^(\w+)\s+(\w+)(\[\])?\??(\s|$)/.exec(line);
    if (!field) continue;
    const [, name, type] = field;
    const tier = tierOf.get(type);
    if (tier === undefined || tier === zone) continue;
    problems.push(
      tier === 'core'
        ? `\`${name} ${type}\` relates a core model but sits in the ${zone} zone. Core's ` +
            `back-relations go in core's list above the framework marker; place it by hand, ` +
            `since \`prisma format\` appends missing ones at the end of the model.`
        : `\`${name} ${type}\` relates ${tier === 'app' ? 'an app' : 'a framework'}-tier model but sits ${
            zone === 'core' ? 'in core’s list' : `in the ${zone} zone`
          }. Move it below the ${tier} zone marker. A fork adopting the zones moves its ` +
            `whole block there once, and its divergence-ledger row for it can be retired.`
    );
  }
  return problems;
}

/** Every model in prisma/schema, with the tier of the file that defines it. */
function readModelTiers(): Map<string, Tier> {
  const tiers = new Map<string, Tier>();
  for (const file of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.prisma'))) {
    const source = readFileSync(join(SCHEMA_DIR, file), 'utf8');
    for (const m of source.matchAll(/^model (\w+)\s*\{/gm)) tiers.set(m[1], tierOfFile(file));
  }
  return tiers;
}

describe('fork back-relation zones on Org and User (sunrise#859)', () => {
  const tiers = readModelTiers();

  it.each([
    ['Org', 'tenancy.prisma'],
    ['User', 'auth.prisma'],
  ])('%s in %s keeps core, framework and app back-relations in their zones', (model, file) => {
    const body = modelBody(readFileSync(join(SCHEMA_DIR, file), 'utf8'), model);
    expect(body, `model ${model} not found in prisma/schema/${file}`).not.toBeNull();
    expect(tiers.get(model)).toBe('core');
    expect(zoneViolations(body ?? [], tiers), `model ${model} (prisma/schema/${file})`).toEqual([]);
  });

  describe('the layout rule itself', () => {
    const fixtureTiers = new Map<string, Tier>([
      ['Org', 'core'],
      ['AiAgent', 'core'],
      ['FwThing', 'framework'],
      ['AppThing', 'app'],
    ]);
    const layout = (core: string[], fw: string[], app: string[]): string[] => [
      '  id   String @id',
      '  name OrgStatus',
      ...core.map((l) => `  ${l}`),
      '',
      `  ${FRAMEWORK_MARKER}`,
      ...fw.map((l) => `  ${l}`),
      '',
      `  ${APP_MARKER}`,
      ...app.map((l) => `  ${l}`),
      '',
      '  @@map("org")',
    ];

    it('accepts each tier in its own zone, including named relations', () => {
      const body = layout(
        ['aiAgents AiAgent[]'],
        ['fwThings FwThing[]'],
        ['appThings AppThing[] @relation("Owner")', 'appShared AppThing[] @relation("Member")']
      );
      expect(zoneViolations(body, fixtureTiers)).toEqual([]);
    });

    it('rejects a core line the formatter appended into the app zone', () => {
      const v = zoneViolations(layout([], [], ['aiAgents AiAgent[]']), fixtureTiers);
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('`aiAgents AiAgent` relates a core model but sits in the app zone');
    });

    it("rejects a fork's pre-zone block left in core's list", () => {
      const v = zoneViolations(layout(['appThings AppThing[]'], [], []), fixtureTiers);
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('sits in core’s list. Move it below the app zone marker');
    });

    it("rejects a leaf's line in the framework zone", () => {
      const v = zoneViolations(layout([], ['appThings AppThing[]'], []), fixtureTiers);
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('sits in the framework zone. Move it below the app zone marker');
    });

    it('rejects a reworded, missing or reordered marker', () => {
      const reworded = layout([], [], []).map((l) =>
        l.includes('App zone') ? '  // ── App zone ──' : l
      );
      expect(zoneViolations(reworded, fixtureTiers)[0]).toContain('framework ×1 and app ×0');

      const swapped = [`  ${APP_MARKER}`, `  ${FRAMEWORK_MARKER}`];
      expect(zoneViolations(swapped, fixtureTiers)).toEqual([
        'the framework zone marker must come before the app zone marker',
      ]);
    });

    it('reads the tier from the file name the reserved tiers use', () => {
      expect(tierOfFile('framework-modules.prisma')).toBe('framework');
      expect(tierOfFile('app.prisma')).toBe('app');
      expect(tierOfFile('app-questionnaire.prisma')).toBe('app');
      expect(tierOfFile('tenancy.prisma')).toBe('core');
      expect(tierOfFile('platform.prisma')).toBe('core');
      expect(tierOfFile('application.prisma')).toBe('core');
    });
  });
});
