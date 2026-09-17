/**
 * Coverage guard: lib/privacy/export-sources.ts vs prisma/schema/*.prisma
 *
 * This is the test issue #467 asks for. It holds the subject-access manifest
 * level with the schema, so a table that relates to `User` cannot be added
 * without someone deciding what a data subject receives from it.
 *
 * Why it has to be a *build* failure rather than a review checklist: an export
 * that omits a table looks exactly like a complete answer to the person reading
 * it. Nothing about the response reveals the gap — not to the subject, not to
 * the operator who sent it. Erasure has the mirror-image rule (a missing
 * `onDelete` throws `P2003` and breaks erasure loudly); access has no natural
 * loud failure, so this test is it.
 *
 * ---------------------------------------------------------------------------
 * IF THIS TEST IS FAILING
 * ---------------------------------------------------------------------------
 * You added a model with a `userId` / `createdBy` FK to `User`. Add it to
 * `SUBJECT_DATA_SOURCES` with a disposition:
 *
 *   • `export`      — it holds the subject's own data. Use Prisma `omit` to
 *                     drop credential columns; do NOT use `select`, which
 *                     silently narrows the export every time a column is added.
 *   • `attribution` — it is org config they created. Return id + label + date.
 *
 * Deleting the row to make the test pass ships a short answer to a data
 * subject. See `.context/privacy/data-export.md`.
 *
 * ---------------------------------------------------------------------------
 * FORK NOTE — you satisfy this from your own code, and it still checks you
 * ---------------------------------------------------------------------------
 * Every schema file in `prisma/schema/` that is not one of Sunrise's own — the
 * list is `CORE_SCHEMA_FILES` below — is yours, whatever you named it. Models
 * in one are held to a stricter rule than core holds itself: **every** model
 * must be declared through `registerAppSubjectSources()` — as a source or as an
 * exclusion with a reason — from `lib/app/data-export.ts` or your framework
 * tier's own init. Nothing here needs editing, and nothing is skipped (#533).
 *
 * Full accounting rather than core's user-id heuristic because core reads its
 * own column vocabulary and cannot read yours: a table keyed `authorId` or
 * `respondentId` is invisible to that scan, and the tables it cannot see are
 * exactly the ones nobody remembers. The alternative fix — exempting the fork
 * namespaces from the scan — would have traded a noisy false positive for a
 * silent false negative, which for an Art. 15 guard is the wrong direction.
 *
 * @see lib/privacy/export-sources.ts
 * @see lib/privacy/subject-source-registry.ts
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeAll } from 'vitest';

// The manifest imports the Prisma client at module scope. Its delegates are
// only touched inside `fetch` closures, which this file never calls — the stub
// just keeps the import from standing up a real client.
vi.mock('@/lib/db/client', () => ({ prisma: {} }));

const { SUBJECT_DATA_SOURCES, EXCLUDED_SOURCES } = await import('@/lib/privacy/export-sources');
const {
  getAppSubjectSources,
  getAppExcludedSubjectSources,
  getAccountedAppModels,
  __resetAppSubjectSourceRegistryForTests,
} = await import('@/lib/privacy/subject-source-registry');

const SCHEMA_DIR = path.join(process.cwd(), 'prisma', 'schema');

/** A field declaring an FK to `User` — `creator User? @relation(...)`. */
const USER_RELATION_FIELD = /^\s*\w+\s+User\??\s+@relation\(/;
const MODEL_OPEN = /^model\s+(\w+)\s*\{/;

/**
 * A plain `String` column holding a user id with no `@relation` behind it.
 *
 * These are the tables the relation scan cannot see, and they have been missed
 * twice: `ContactSubmission` (the public contact form takes an address, not a
 * session) and `FeatureFlag` (`createdBy` written by the admin route). Both are
 * in the manifest by hand. Scanning for the column name as well as the relation
 * is what stops a third.
 *
 * It is a list of *core's* column names, which is precisely why it is not the
 * rule applied to fork-owned files — see the FORK NOTE above.
 */
const USER_SCALAR_FIELD =
  /^\s*(userId|createdBy|uploadedBy|ownerId|actorUserId|subjectUserId)\s+String/;

/**
 * Sunrise's own schema files. **Everything else in `prisma/schema/` belongs to a
 * fork tier**, whatever it is named.
 *
 * Stated as an allowlist rather than a pattern for the fork-reserved names,
 * because core knows its own files exactly and cannot know what a fork will
 * call theirs. Matching only `app.prisma` and `framework-*.prisma` left a fork
 * that splits its domain across `app-billing.prisma` — normal enough that core
 * itself has eleven of these — classified as core-owned, held to core's column
 * heuristic, and unable to satisfy the result from fork-owned code. That is
 * #533 again, one filename away.
 *
 * Adding a core schema file means adding it here. The failure is loud and the
 * message says so: until it is listed, its models are treated as a fork tier's
 * and the accounting rule asks someone to declare them.
 */
const CORE_SCHEMA_FILES = new Set([
  'auth.prisma',
  'base.prisma',
  'mcp.prisma',
  'orchestration-agents.prisma',
  'orchestration-conversations.prisma',
  'orchestration-evaluation.prisma',
  'orchestration-knowledge.prisma',
  'orchestration-ops.prisma',
  'orchestration-providers.prisma',
  'orchestration-workflows.prisma',
  'tenancy.prisma',
  // Sunrise's own app-domain models (ContactSubmission, FeatureFlag,
  // AuthBootstrap) live here, NOT in the fork-reserved app.prisma.
  'platform.prisma',
]);

/**
 * Whether a schema file belongs to a fork tier. Models here are accounted for
 * through the registry, not the core manifest.
 */
function isForkOwnedSchemaFile(file: string): boolean {
  return !CORE_SCHEMA_FILES.has(file);
}

/**
 * Models carrying a user-id scalar that the export handles OUTSIDE the manifest,
 * with the reason. Kept deliberately tiny — it is an accounting note, not an
 * escape hatch, and anything added here still has to be justified to a reader.
 */
const HANDLED_OUTSIDE_MANIFEST = new Map([
  [
    'DataErasureReceipt',
    'Fetched directly by exportUserData() and returned as the bundle’s `erasureReceipts` section, so it is exported — just not through a manifest source.',
  ],
]);

interface SchemaFile {
  name: string;
  contents: string;
}

interface SchemaScan {
  /** Core-owned models that declare at least one FK to `User`. */
  userLinked: Set<string>;
  /** Core-owned models holding a user-id scalar with NO `@relation` — invisible to the FK scan. */
  scalarLinked: Set<string>;
  /** Every model name in the schema, core and fork, for typo/rename detection. */
  allModels: Set<string>;
  /** Every model declared in a fork-reserved schema file. */
  forkModels: Set<string>;
}

/**
 * Parse `.prisma` sources. Takes its input rather than reading the directory so
 * the fork-accounting rule below can be exercised against a synthetic tier — in
 * vanilla Sunrise there are no fork models, and a rule with nothing to check
 * passes while protecting nothing.
 */
function scanSchemaFiles(files: SchemaFile[]): SchemaScan {
  const userLinked = new Set<string>();
  const scalarLinked = new Set<string>();
  const allModels = new Set<string>();
  const forkModels = new Set<string>();

  for (const file of files) {
    const isFork = isForkOwnedSchemaFile(file.name);
    let currentModel: string | null = null;
    let modelHasRelation = false;
    let modelScalars: string[] = [];

    const closeModel = (): void => {
      // A user-id column backed by a real `@relation` is already covered by the
      // FK scan; only the relation-less ones need the second net.
      if (currentModel && !isFork && !modelHasRelation && modelScalars.length > 0) {
        scalarLinked.add(currentModel);
      }
      currentModel = null;
      modelHasRelation = false;
      modelScalars = [];
    };

    for (const line of file.contents.split('\n')) {
      const open = MODEL_OPEN.exec(line);
      if (open) {
        closeModel();
        currentModel = open[1];
        allModels.add(currentModel);
        if (isFork) forkModels.add(currentModel);
        continue;
      }
      if (line.startsWith('}')) {
        closeModel();
        continue;
      }
      if (!currentModel) continue;
      // `model User` itself holds the back-relations (`AiAgent[]`), whose field
      // type is the other model — they never match the User-typed pattern, so
      // User is excluded naturally rather than by special case.
      if (USER_RELATION_FIELD.test(line)) {
        if (!isFork) userLinked.add(currentModel);
        modelHasRelation = true;
      }
      const scalar = USER_SCALAR_FIELD.exec(line);
      if (scalar) modelScalars.push(scalar[1]);
    }

    closeModel();
  }

  return { userLinked, scalarLinked, allModels, forkModels };
}

function readSchemaFiles(): SchemaFile[] {
  return readdirSync(SCHEMA_DIR)
    .filter((file) => file.endsWith('.prisma'))
    .map((name) => ({ name, contents: readFileSync(path.join(SCHEMA_DIR, name), 'utf8') }));
}

/**
 * Fork-owned models no tier has decided about. The whole fork rule, in one
 * function, so the real schema and the synthetic tier below run identical code.
 */
function unaccountedForkModels(scan: SchemaScan, accounted: Set<string>): string[] {
  return [...scan.forkModels].filter((model) => !accounted.has(model)).sort();
}

describe('subject-data source manifest', () => {
  const { userLinked, scalarLinked, allModels, forkModels } = scanSchemaFiles(readSchemaFiles());
  const declared = new Set(SUBJECT_DATA_SOURCES.map((source) => source.model));

  beforeAll(() => {
    // Drive the REAL seam: reset so the lazy init runs against
    // `lib/app/data-export.ts` as shipped rather than whatever another suite
    // left behind.
    __resetAppSubjectSourceRegistryForTests();
  });

  describe('the scan itself', () => {
    // A regex that quietly stops matching would make every assertion below
    // vacuously true — the guard would pass while protecting nothing. These two
    // rows are the guard on the guard.
    it('finds the schema files', () => {
      expect(allModels.size).toBeGreaterThan(40);
      expect(allModels.has('User')).toBe(true);
    });

    it('finds a plausible number of User-linked models', () => {
      expect(userLinked.size).toBeGreaterThanOrEqual(25);
    });

    it('recognises both FK spellings', () => {
      // `userId` (Cascade, personal data) and `createdBy` (SetNull, retained).
      expect(userLinked.has('Session')).toBe(true);
      expect(userLinked.has('AiAgent')).toBe(true);
    });

    it('knows which schema files belong to a fork tier', () => {
      expect(isForkOwnedSchemaFile('app.prisma')).toBe(true);
      expect(isForkOwnedSchemaFile('framework-tasks.prisma')).toBe(true);
      // The reason this is an allowlist and not a pattern: a fork splitting its
      // domain across files is normal, and core cannot enumerate their names.
      expect(isForkOwnedSchemaFile('app-billing.prisma')).toBe(true);
      expect(isForkOwnedSchemaFile('obsiddy.prisma')).toBe(true);
      // Sunrise's own app-domain models live here, and stay core's problem.
      expect(isForkOwnedSchemaFile('platform.prisma')).toBe(false);
      expect(isForkOwnedSchemaFile('orchestration-agents.prisma')).toBe(false);
    });

    it('lists every core schema file that is actually on disk', () => {
      // Drift guard, direction one: a rename or a removal leaves a name here
      // matching nothing, and the file it used to cover would be silently
      // reclassified as a fork tier's.
      const onDisk = new Set(readSchemaFiles().map((file) => file.name));
      const stale = [...CORE_SCHEMA_FILES].filter((name) => !onDisk.has(name)).sort();

      expect(stale, 'CORE_SCHEMA_FILES names a file that no longer exists').toEqual([]);
    });

    it('lists whichever file every core-manifest model actually lives in', () => {
      // Drift guard, direction two — the one that matters more, because nothing
      // else catches it. A NEW core schema file nobody adds to
      // `CORE_SCHEMA_FILES` is treated as a fork tier's, which lifts its models
      // out of core's strict rule. This finds it the moment core's own manifest
      // names a model living there.
      const coreManifestModels = new Set([
        ...SUBJECT_DATA_SOURCES.map((source) => source.model),
        ...EXCLUDED_SOURCES.map((source) => source.model),
      ]);
      const inCoreFiles = new Set(
        readSchemaFiles()
          .filter((file) => CORE_SCHEMA_FILES.has(file.name))
          .flatMap((file) => [...file.contents.matchAll(/^model\s+(\w+)\s*\{/gm)])
          .map((match) => match[1])
      );
      const elsewhere = [...coreManifestModels].filter((model) => !inCoreFiles.has(model)).sort();

      expect(
        elsewhere,
        elsewhere.length === 0
          ? ''
          : `Core's manifest names models that are not in any file listed in ` +
              `CORE_SCHEMA_FILES: ${elsewhere.join(', ')}. If you added a core schema ` +
              `file, add its name to CORE_SCHEMA_FILES — until you do it is treated as ` +
              `a fork tier's, and its User-linked models drop out of the strict rule.`
      ).toEqual([]);
    });
  });

  describe('coverage', () => {
    it('declares every User-linked model', () => {
      const missing = [...userLinked].filter((model) => !declared.has(model)).sort();

      expect(
        missing,
        missing.length === 0
          ? ''
          : `These models relate to User but are missing from SUBJECT_DATA_SOURCES, so a ` +
              `data subject's export silently omits them: ${missing.join(', ')}. ` +
              `Add each with a disposition — 'export' for the subject's own data ` +
              `(use Prisma \`omit\` for credential columns), 'attribution' for org ` +
              `config they created. See .context/privacy/data-export.md.`
      ).toEqual([]);
    });

    it('names only models that exist', () => {
      // Catches a rename or typo, which would otherwise leave a source in the
      // manifest that queries nothing and reports zero rows forever.
      const unknown = SUBJECT_DATA_SOURCES.map((source) => source.model)
        .filter((model) => !allModels.has(model))
        .sort();

      expect(unknown).toEqual([]);
    });

    it('covers ContactSubmission, which has no User FK', () => {
      // The public contact form takes an address, not a session, so this table
      // is matched by email and is invisible to the relation scan. It is in the
      // manifest by hand — this row is what stops a tidy-up from dropping it.
      expect(declared.has('ContactSubmission')).toBe(true);
      expect(userLinked.has('ContactSubmission')).toBe(false);
    });

    it('declares every model holding a user id with no relation behind it', () => {
      // The second net. A `createdBy String?` with no `@relation` is invisible
      // to the FK scan above, and has been missed twice — ContactSubmission and
      // FeatureFlag. Catching the column name as well as the relation is what
      // makes the coverage rule hold for tables Prisma does not link.
      const missing = [...scalarLinked]
        .filter((model) => !declared.has(model))
        .filter((model) => !EXCLUDED_SOURCES.some((source) => source.model === model))
        .filter((model) => !HANDLED_OUTSIDE_MANIFEST.has(model))
        .sort();

      expect(
        missing,
        missing.length === 0
          ? ''
          : `These models store a user id in a plain column with no Prisma relation, ` +
              `so the FK scan cannot see them and a data subject's export silently ` +
              `omits them: ${missing.join(', ')}. Add each to SUBJECT_DATA_SOURCES by ` +
              `hand (matching on its own column), or to EXCLUDED_SOURCES with a reason. ` +
              `See .context/privacy/data-export.md.`
      ).toEqual([]);
    });

    it('finds the relation-less tables it is meant to find', () => {
      // Guard on the guard: if the scalar regex stops matching, the check above
      // passes while protecting nothing.
      //
      // `ContactSubmission` is deliberately NOT expected here — it holds no user
      // id at all, only an email, so no column scan can reach it. That is the
      // residual gap this pair of nets does not close, and why the manifest
      // still needs a human deciding what a new table holds.
      expect(scalarLinked.has('FeatureFlag')).toBe(true);
      expect(scalarLinked.has('DataErasureReceipt')).toBe(true);
    });
  });

  describe('fork-owned schema files', () => {
    it('accounts for every model in a fork-owned schema file', () => {
      // Core's `SUBJECT_DATA_SOURCES` counts as accounting — a framework tier
      // moving rows out of it and into the registry is doing the right thing,
      // and failing them twice while they do it is noise, not protection.
      //
      // `EXCLUDED_SOURCES` deliberately does NOT. It used to, and that opened a
      // hole in the other direction: a NEW core schema file that nobody adds to
      // `CORE_SCHEMA_FILES` is classified fork-owned, which lifts its models out
      // of `userLinked` and so out of the strict core rule — where an exclusion
      // is never an escape from a `User` relation. Accepting an exclusion here
      // as well would let a User-linked CORE table be written off with one
      // `EXCLUDED_SOURCES` row and a forgotten filename, and vanish from every
      // Art. 15 export with the suite green.
      const accounted = new Set([...getAccountedAppModels(), ...declared]);
      const scan = { userLinked, scalarLinked, allModels, forkModels };
      const missing = unaccountedForkModels(scan, accounted);

      expect(
        missing,
        missing.length === 0
          ? ''
          : `These models live in a fork-owned schema file and no tier has said ` +
              `what a data subject receives from them: ${missing.join(', ')}. Declare ` +
              `each through registerAppSubjectSources() — as a \`source\` if it holds ` +
              `data about a person, or in \`excluded\` with a reason if it does not. ` +
              `Core cannot read your column vocabulary, so it asks for every model ` +
              `rather than guessing which hold a user id. ` +
              `See lib/app/data-export.ts and .context/privacy/data-export.md. ` +
              `(Sunrise maintainers: if you just added a CORE schema file, add its ` +
              `name to CORE_SCHEMA_FILES in this file instead.)`
      ).toEqual([]);
    });
  });

  /**
   * The fork rule, exercised against a synthetic tier.
   *
   * Vanilla Sunrise has zero fork models, so the assertions above pass
   * vacuously — a broken predicate would look exactly as healthy as a working
   * one. These cases run the same `scanSchemaFiles` + `unaccountedForkModels`
   * pair over fixture sources, which is the only place the rule is observed
   * doing anything at all upstream.
   */
  describe('the fork rule, against a synthetic tier', () => {
    const FIXTURE: SchemaFile[] = [
      {
        name: 'framework-tasks.prisma',
        contents: [
          'model FrameworkTask {',
          '  id        String @id @default(cuid())',
          // Deliberately NOT one of core's column names: this is the shape the
          // user-id heuristic cannot see, and the reason the rule is total.
          '  authorId  String',
          '  title     String',
          '}',
          '',
          'model FrameworkTaskTag {',
          '  taskId String',
          '  tagId  String',
          '}',
        ].join('\n'),
      },
      {
        name: 'app.prisma',
        contents: ['model AppInvoice {', '  id     String @id', '  userId String', '}'].join('\n'),
      },
    ];

    const scan = scanSchemaFiles(FIXTURE);

    it('sees the fork models and keeps them out of the core nets', () => {
      expect([...scan.forkModels].sort()).toEqual([
        'AppInvoice',
        'FrameworkTask',
        'FrameworkTaskTag',
      ]);
      // `AppInvoice.userId` matches core's scalar pattern, but a fork model must
      // never land in a core net — that is the failure a fork cannot satisfy.
      expect(scan.scalarLinked.size).toBe(0);
      expect(scan.userLinked.size).toBe(0);
    });

    it('flags every model when no tier has declared', () => {
      expect(unaccountedForkModels(scan, new Set())).toEqual([
        'AppInvoice',
        'FrameworkTask',
        'FrameworkTaskTag',
      ]);
    });

    it('flags a table whose user column core’s heuristic cannot see', () => {
      // Everything accounted for EXCEPT the `authorId` table — the case that
      // makes full accounting worth its noise.
      const accounted = new Set(['AppInvoice', 'FrameworkTaskTag']);
      expect(unaccountedForkModels(scan, accounted)).toEqual(['FrameworkTask']);
    });

    it('passes once both tiers have declared, sources and exclusions alike', () => {
      const accounted = new Set(['AppInvoice', 'FrameworkTask', 'FrameworkTaskTag']);
      expect(unaccountedForkModels(scan, accounted)).toEqual([]);
    });
  });

  /**
   * Deliberately NOT asserted here: that the registry is empty in vanilla
   * Sunrise, and that `app.prisma` declares no models.
   *
   * Both are true, and both are already pinned — the first by the
   * `lib/app/data-export.ts` row in `defaults.test.ts`, the second by
   * `reserved-fork-tiers.test.ts`. Restating them would cost a fork a second
   * and third core-file edit to do the supported thing while buying no
   * protection at all, which is the defect this file was changed to fix.
   */
  describe('app-tier declarations', () => {
    it('names only models that exist', () => {
      const unknown = [...getAppSubjectSources(), ...getAppExcludedSubjectSources()]
        .map((source) => source.model)
        .filter((model) => !allModels.has(model))
        .sort();

      expect(
        unknown,
        unknown.length === 0
          ? ''
          : `registerAppSubjectSources() names models that are not in any .prisma ` +
              `file: ${unknown.join(', ')}. A declaration for a model that does not ` +
              `exist accounts for nothing and hides a rename.`
      ).toEqual([]);
    });

    it('never claims a model core already exports', () => {
      // Checked here rather than at registration: the registry stays free of the
      // core manifest so `lib/app/**` can import it without dragging Prisma into
      // the extension surface. A collision would have two manifests describing
      // one table, and the subject receiving whichever ran last.
      const coreOwned = new Set([
        ...declared,
        ...EXCLUDED_SOURCES.map((source) => source.model),
        ...HANDLED_OUTSIDE_MANIFEST.keys(),
      ]);
      const claimed = [...getAppSubjectSources(), ...getAppExcludedSubjectSources()]
        .map((source) => source.model)
        .filter((model) => coreOwned.has(model))
        .sort();

      expect(claimed).toEqual([]);
    });
  });

  describe('manifest integrity', () => {
    it('lists each model once', () => {
      const models = SUBJECT_DATA_SOURCES.map((source) => source.model);
      expect(models).toHaveLength(new Set(models).size);
    });

    it('gives each source its own section key', () => {
      // A collision would have one source overwrite another in the bundle —
      // silent data loss with a passing coverage check.
      const sections = SUBJECT_DATA_SOURCES.map((source) => source.section);
      expect(sections).toHaveLength(new Set(sections).size);
    });

    it('describes every source for the subject', () => {
      // The descriptions are echoed in the export's `meta`; a blank one leaves
      // the reader guessing what a section is.
      const undescribed = SUBJECT_DATA_SOURCES.filter(
        (source) => source.description.trim().length < 10
      ).map((source) => source.model);

      expect(undescribed).toEqual([]);
    });

    it('no longer narrows the two sources that inbound mis-attribution forced', () => {
      // These two returned only SOME of the subject's matching rows between
      // #467 and #502: inbound traffic was stamped with the operator who
      // configured the channel, so matching on `userId` alone would have
      // handed them a third party's phone number and message bodies. The
      // filters contained that; #502 removed its cause by making those rows
      // system-owned, so the subject now gets the whole set.
      //
      // Pinned in this direction so a reinstated filter has to be deliberate.
      // If one ever is needed again, it must arrive with a `scopeNote` — an
      // export that quietly returns a subset reads exactly like a complete
      // answer, which is the failure this manifest exists to prevent.
      for (const model of ['AiConversation', 'AiWorkflowExecution']) {
        const source = SUBJECT_DATA_SOURCES.find((entry) => entry.model === model);
        expect(source?.scopeNote, `${model} should return every row it matches`).toBeUndefined();
      }
    });

    it('writes scope notes that actually explain the narrowing', () => {
      const thin = SUBJECT_DATA_SOURCES.filter(
        (source) => source.scopeNote !== undefined && source.scopeNote.trim().length < 40
      ).map((source) => source.model);

      expect(thin).toEqual([]);
    });

    it('uses only the two known dispositions', () => {
      const dispositions = new Set(SUBJECT_DATA_SOURCES.map((source) => source.disposition));
      expect([...dispositions].sort()).toEqual(['attribution', 'export']);
    });
  });

  describe('documented exclusions', () => {
    it('gives a reason for each', () => {
      const unexplained = EXCLUDED_SOURCES.filter((source) => source.reason.trim().length < 20).map(
        (source) => source.model
      );

      expect(unexplained).toEqual([]);
    });

    it('refers to models that exist', () => {
      const unknown = EXCLUDED_SOURCES.map((source) => source.model)
        .filter((model) => !allModels.has(model))
        .sort();

      expect(unknown).toEqual([]);
    });

    it('never excludes a model that is also exported', () => {
      const both = EXCLUDED_SOURCES.map((source) => source.model).filter((model) =>
        declared.has(model)
      );

      expect(both).toEqual([]);
    });

    it('never excludes a User-linked model', () => {
      // The exclusion list is for tables a reader would wonder about, not an
      // escape hatch from the coverage rule above. A model with a User FK must
      // be exported or attributed — not written off with a reason.
      const escaped = EXCLUDED_SOURCES.map((source) => source.model).filter((model) =>
        userLinked.has(model)
      );

      expect(escaped).toEqual([]);
    });
  });
});
