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
 * The zones fix that by placement. Each model ends with two fixed markers,
 * then its block attributes:
 *
 *     ...core's fields and back-relations...
 *
 *     // ── Framework zone: ... ──     ← a framework fork (Daybreak) writes below
 *
 *     // ── App zone: ... ──           ← a leaf app writes below
 *
 *     @@index(...)                     ← core's, kept last by `prisma format`
 *     @@map("org")
 *
 * Core never edits a field below the first marker, so git always has an
 * unchanged line between core's edits and a fork's, and the merge is clean. A
 * fork filling its zone is therefore not a divergence (CUSTOMIZATION.md, "The
 * divergence ledger").
 *
 * What breaks the arrangement, and what this file fails on:
 *
 * - **A core field below a marker.** `prisma format` appends a missing
 *   back-relation at the end of the model's fields, which is the app zone. A
 *   core change that lets the formatter place its line, or a core scalar added
 *   at the bottom, lands where every leaf writes, and the conflicts are back.
 *   Inside a zone, every field must be a back-relation to that tier's model.
 * - **A fork line above the framework marker, or in another tier's zone.**
 *   Expected once, on the sync that brings the zones in, for a fork that
 *   carried a block before them: move the block below your marker.
 * - **No blank line between the app zone and the block attributes.** Block
 *   attributes are core's and stay at the end. The blank line is the unchanged
 *   line that keeps a core `@@index` edit apart from a leaf's last zone line.
 *   `prisma format` keeps it.
 * - **A marker edited, missing, duplicated or out of order.** The markers are
 *   the unchanged lines the merge relies on; rewording one is itself an edit
 *   every fork has to merge.
 *
 * A model's tier is the tier of the file that defines it, from
 * `schemaTierOf` in `scripts/ci/schema-files.ts`, the same rule every schema
 * guard uses: core is the `CORE_SCHEMA_FILES` allowlist, a top-level file or
 * folder named `framework` / `framework-*` is the framework tier's, and any other file,
 * at any depth, is the app tier's. In Sunrise no fork-tier model exists, so
 * both zones are empty by construction.
 *
 * @see prisma/schema/tenancy.prisma · prisma/schema/auth.prisma
 * @see CUSTOMIZATION.md §5 "Relating your models to `Org` and `User`"
 */

import { describe, it, expect } from 'vitest';
import { readSchemaFiles, schemaTierOf, type SchemaTier } from '@/scripts/ci/schema-files';

const FRAMEWORK_MARKER =
  '// ── Framework zone: back-relations to framework-tier models. Sunrise never edits below here. ──';
const APP_MARKER =
  '// ── App zone: back-relations to app-tier models. Sunrise never edits below here. ──';

/** The body lines of `model <name> { … }` in `source`, or null when absent. */
function modelBody(source: string, name: string): string[] | null {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`model ${name} `) || l === `model ${name}{`);
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && /^\}/.test(l));
  if (end === -1) throw new Error(`model ${name} has no closing brace at column 0`);
  return lines.slice(start + 1, end);
}

/**
 * Every way `body` breaks the zone layout, as readable lines. `tierOf` maps a
 * model name to its tier. Above the framework marker, any field is fine except
 * a back-relation to a fork-tier model. Inside a zone, every field must be a
 * back-relation to a model of that zone's tier.
 */
function zoneViolations(body: string[], tierOf: Map<string, SchemaTier>): string[] {
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

  const firstAttribute = trimmed.findIndex((l) => l.startsWith('@@'));
  if (firstAttribute !== -1 && firstAttribute < trimmed.indexOf(APP_MARKER)) {
    problems.push(
      `\`${trimmed[firstAttribute]}\` sits above the app zone. Block attributes are core's ` +
        'and go after the app zone, where `prisma format` keeps them; one above or inside a ' +
        'zone puts a core edit among fork lines.'
    );
  } else if (firstAttribute !== -1 && trimmed[firstAttribute - 1] !== '') {
    problems.push(
      'keep one blank line between the app zone and the block attributes (`@@…`). It is ' +
        'the unchanged line that keeps a core attribute edit from conflicting with the ' +
        "app zone's last line."
    );
  }

  let zone: SchemaTier = 'core';
  let afterAttributes = false;
  for (const line of trimmed) {
    if (line.startsWith('@@')) afterAttributes = true;
    if (line === FRAMEWORK_MARKER) zone = 'framework';
    else if (line === APP_MARKER) zone = 'app';
    if (line === '' || line.startsWith('//') || line.startsWith('@')) continue;
    const field = /^(\w+)\s+(\w+)/.exec(line);
    if (!field) continue;
    const [, name, type] = field;
    if (afterAttributes) {
      problems.push(
        `\`${name} ${type}\` comes after a block attribute. Fields go above the \`@@\` lines, ` +
          "which are core's and stay last; a zone line among them puts a core attribute edit " +
          'next to a fork line.'
      );
      continue;
    }
    const tier = tierOf.get(type);
    if (tier === zone) continue;
    if (zone === 'core') {
      if (tier === undefined) continue; // a core scalar or enum field, in core's list
      problems.push(
        `\`${name} ${type}\` relates ${tier === 'app' ? 'an app' : 'a framework'}-tier model but ` +
          `sits in core’s list. Move it below the ${tier} zone marker. A fork adopting the ` +
          `zones moves its whole block there once, and its divergence-ledger row for it can ` +
          `be retired.`
      );
      continue;
    }
    problems.push(
      tier === undefined
        ? `\`${name} ${type}\` is not a back-relation to ${zone === 'app' ? 'an app' : 'a framework'}` +
            `-tier model but sits in the ` +
            `${zone} zone. The zones hold only fork back-relations; core's fields go in core's ` +
            `list above the framework marker.`
        : tier === 'core'
          ? `\`${name} ${type}\` relates a core model but sits in the ${zone} zone. The zones ` +
            `hold back-relations to fork-tier models only. If core added it, move it into ` +
            `core's list above the framework marker by hand, since \`prisma format\` appends ` +
            `missing ones at the end of the model. If your fork added it, it pairs with your ` +
            `edit to a core model, which is already a divergence: put it in core's list and ` +
            `give it a ledger row with that edit.`
          : `\`${name} ${type}\` relates ${tier === 'app' ? 'an app' : 'a framework'}-tier model ` +
            `but sits in the ${zone} zone. Move it below the ${tier} zone marker.`
    );
  }
  return problems;
}

/**
 * Every model and view in prisma/schema, at any depth, with the tier of the
 * file that defines it. A view can carry a relation, so its back-relation is
 * placed by the same rule as a model's.
 */
function readModelTiers(): Map<string, SchemaTier> {
  const tiers = new Map<string, SchemaTier>();
  for (const file of readSchemaFiles()) {
    for (const m of file.contents.matchAll(/^(?:model|view) (\w+)\s*\{/gm)) {
      tiers.set(m[1], schemaTierOf(file.name));
    }
  }
  return tiers;
}

describe('fork back-relation zones on Org and User (sunrise#859)', () => {
  const files = readSchemaFiles();
  const tiers = readModelTiers();

  it.each([
    ['Org', 'tenancy.prisma'],
    ['User', 'auth.prisma'],
  ])('%s in %s keeps core, framework and app back-relations in their zones', (model, file) => {
    const source = files.find((f) => f.name === file)?.contents ?? '';
    const body = modelBody(source, model);
    expect(body, `model ${model} not found in prisma/schema/${file}`).not.toBeNull();
    expect(tiers.get(model)).toBe('core');
    expect(zoneViolations(body ?? [], tiers), `model ${model} (prisma/schema/${file})`).toEqual([]);
  });

  describe('the layout rule itself', () => {
    const fixtureTiers = new Map<string, SchemaTier>([
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
      '  @@index([name])',
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

    it('rejects a core scalar or enum field added below a marker', () => {
      const v = zoneViolations(
        layout([], ['seats Int'], ['tier OrgTier @default(FREE)']),
        fixtureTiers
      );
      expect(v).toEqual([
        expect.stringContaining('`seats Int` is not a back-relation to a framework-tier model'),
        expect.stringContaining('`tier OrgTier` is not a back-relation to an app-tier model'),
      ]);
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

    it('rejects block attributes with no blank line after the app zone', () => {
      const body = layout([], [], ['appThings AppThing[]']).filter(
        (l, i, all) => !(l === '' && all[i + 1]?.includes('@@index'))
      );
      const v = zoneViolations(body, fixtureTiers);
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('keep one blank line between the app zone and the block attributes');
    });

    it('rejects a block attribute written into a zone', () => {
      const body = layout([], [], []);
      body.splice(body.indexOf(`  ${APP_MARKER}`), 0, '  @@index([createdAt])');
      const v = zoneViolations(body, fixtureTiers);
      expect(v).toEqual([
        expect.stringContaining('`@@index([createdAt])` sits above the app zone'),
      ]);
    });

    it('rejects a fork line after a block attribute', () => {
      const body = [...layout([], [], ['appThings AppThing[]']), '  appMore AppThing[]'];
      const v = zoneViolations(body, fixtureTiers);
      expect(v).toEqual([
        expect.stringContaining('`appMore AppThing` comes after a block attribute'),
      ]);
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

    it('fails loudly on a model with no closing brace instead of dropping lines', () => {
      expect(() => modelBody('model Org {\n  id String @id\n', 'Org')).toThrow(
        'model Org has no closing brace'
      );
      expect(modelBody('model Orgs {\n}\n', 'Org')).toBeNull();
    });
  });
});
