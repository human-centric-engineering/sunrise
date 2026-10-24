/**
 * Coverage guard: lib/privacy/org-sources.ts vs prisma/schema/*.prisma (§106 t-672)
 *
 * The org-subject counterpart of `export-sources.test.ts`: holds the org
 * manifest level with every `orgId` column in the schema, so a table cannot
 * join an org without someone deciding what the org receives from it. Core's
 * models are declared in `org-sources.ts`; a fork's are registered through
 * `lib/app/org-export.ts` (§109 t-737) and unioned in here, so a fork table is
 * held to the same rule rather than exempted from it.
 *
 * It also holds every `orgId` model to an explicit `onDelete` on its `Org`
 * relation: org erasure deletes the `Org` row and relies on the cascade, so a
 * model without one either outlives the org's erasure or blocks it.
 *
 * ---------------------------------------------------------------------------
 * IF THIS TEST IS FAILING
 * ---------------------------------------------------------------------------
 * You added an `orgId` column. Add the model to `ORG_DATA_SOURCES` with a
 * disposition (`export` for the org's own records — use Prisma `omit` for
 * credential columns; `attribution` for identity-only rows), or to
 * `ORG_EXCLUDED_SOURCES` with the reason the reader is shown. In a fork,
 * register it from `lib/app/org-export.ts` instead — never edit the core list.
 * Deleting the row ships a short answer to a customer. Give its `Org` relation
 * `onDelete: Cascade` (or `SetNull` for a record that must outlive the org).
 * See `.context/privacy/org-export.md`.
 *
 * The scan is exercised against a synthetic schema as well as the real one,
 * so the rule is shown to fire — in vanilla Sunrise every `orgId` model is
 * declared, and a rule with nothing to catch passes while protecting nothing.
 *
 * @see lib/privacy/org-sources.ts
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';

const prismaMock = vi.hoisted(() => {
  // The named delegates the hand-written tests reach for, plus a fallback
  // that mints a `findMany` for any other model on first touch — the
  // parametric test below drives every tenant-owned source through it.
  const named: Record<string, { findMany: ReturnType<typeof vi.fn> }> = {
    orgMembership: { findMany: vi.fn() },
    verification: { findMany: vi.fn() },
    aiApiKey: { findMany: vi.fn() },
    aiAgentEmbedToken: { findMany: vi.fn() },
    aiAgentInviteToken: { findMany: vi.fn() },
    mcpApiKey: { findMany: vi.fn() },
  };
  return new Proxy(named, {
    get(target, prop: string) {
      if (!(prop in target)) target[prop] = { findMany: vi.fn() };
      return target[prop];
    },
  });
});
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));
vi.mock('@/lib/tenancy/context', () => ({ isMultiTenant: vi.fn(() => false) }));

const { isMultiTenant } = await import('@/lib/tenancy/context');

const { ORG_DATA_SOURCES, ORG_EXCLUDED_SOURCES } = await import('@/lib/privacy/org-sources');
const {
  getAccountedAppOrgModels,
  registerAppOrgSources,
  appOrgDeclarationsFailed,
  __resetAppOrgSourceRegistryForTests,
} = await import('@/lib/privacy/org-source-registry');

const SCHEMA_DIR = path.join(process.cwd(), 'prisma', 'schema');
const MODEL_OPEN = /^model\s+(\w+)\s*\{/;
/**
 * The column, by name and exactly. `activeOrgId` on `Session` is a pointer
 * to the org the session acts in, not the org's data, and must not match;
 * a fork naming its own column `tenantId` is §109's accounting, not this.
 */
const ORG_ID_FIELD = /^\s*orgId\s+String/;

/**
 * The relation that ties a model's `orgId` to `Org`, with its `onDelete`
 * captured when present. Relation lines name the `Org` type and list `orgId`
 * among their `fields` — alone, or in a composite key. `prisma format` keeps
 * an attribute on one line, so a line scan sees the whole relation.
 */
const ORG_RELATION = /^\s*\w+\s+Org\??\s+@relation\(.*fields:\s*\[[^\]]*\borgId\b[^\]]*\]/;
const ON_DELETE = /onDelete:\s*(\w+)/;
/**
 * The two policies under which org erasure neither fails nor leaves a row
 * pointing at a deleted org: delete with the org, or detach from it. SetNull
 * KEEPS the rows — right for a record that must outlive the org (`AiCostLog`,
 * a billing record), wrong for the org's own data. This rule cannot tell the
 * two apart; choosing SetNull is a retention decision its author owns.
 */
const ERASURE_SAFE = new Set(['Cascade', 'SetNull']);

interface SchemaFile {
  name: string;
  contents: string;
}

/**
 * Every model declaring an `orgId` column, every model name, and the
 * `onDelete` each model's `Org` relation declares (`null` for a relation with
 * none; absent for no relation at all), from the given sources.
 */
function scanSchemaFiles(files: SchemaFile[]): {
  orgLinked: Set<string>;
  allModels: Set<string>;
  orgOnDelete: Map<string, string | null>;
} {
  const orgLinked = new Set<string>();
  const allModels = new Set<string>();
  const orgOnDelete = new Map<string, string | null>();
  for (const file of files) {
    let currentModel: string | null = null;
    for (const line of file.contents.split('\n')) {
      const open = MODEL_OPEN.exec(line);
      if (open) {
        currentModel = open[1];
        allModels.add(currentModel);
        continue;
      }
      if (line.startsWith('}')) {
        currentModel = null;
        continue;
      }
      if (!currentModel) continue;
      if (ORG_ID_FIELD.test(line)) orgLinked.add(currentModel);
      // Read the code, not a trailing comment: `// TODO onDelete: Cascade` on a
      // relation Prisma applies as Restrict must not pass.
      const code = line.replace(/\/\/.*$/, '');
      if (ORG_RELATION.test(code)) {
        const policy = ON_DELETE.exec(code)?.[1] ?? null;
        const previous = orgOnDelete.get(currentModel);
        // Two Org relations over orgId: keep the unsafe one, so neither hides the other.
        const previousSafe =
          previous !== undefined && previous !== null && ERASURE_SAFE.has(previous);
        if (previous === undefined || previousSafe) orgOnDelete.set(currentModel, policy);
      }
    }
  }
  return { orgLinked, allModels, orgOnDelete };
}

function readSchemaFiles(): SchemaFile[] {
  return readdirSync(SCHEMA_DIR)
    .filter((file) => file.endsWith('.prisma'))
    .map((name) => ({ name, contents: readFileSync(path.join(SCHEMA_DIR, name), 'utf8') }));
}

/** The rule, in one function, so the real schema and the fixture run identical code. */
function undeclaredOrgModels(orgLinked: Set<string>, declared: Set<string>): string[] {
  return [...orgLinked].filter((model) => !declared.has(model)).sort();
}

/**
 * Every model accounted for: core's manifest, unioned with what a fork
 * registered. A union, not a count — a fork adds a model and a registration
 * and is done, without editing this file.
 */
function declaredModels(): Set<string> {
  return new Set([
    ...ORG_DATA_SOURCES.map((source) => source.model),
    ...ORG_EXCLUDED_SOURCES.map((source) => source.model),
    ...getAccountedAppOrgModels(),
  ]);
}

/** Fork-registered models that are also in core's manifest — a fork must not claim one. */
function shadowedCoreModels(): string[] {
  const core = new Set([
    ...ORG_DATA_SOURCES.map((source) => source.model),
    ...ORG_EXCLUDED_SOURCES.map((source) => source.model),
  ]);
  return [...getAccountedAppOrgModels()].filter((model) => core.has(model)).sort();
}

/** `orgId` models whose `Org` relation is missing or declares no erasure-safe `onDelete`. */
function unsafeOnErasure(
  orgLinked: Set<string>,
  orgOnDelete: Map<string, string | null>
): string[] {
  return [...orgLinked]
    .filter((model) => {
      const policy = orgOnDelete.get(model);
      return policy === undefined || policy === null || !ERASURE_SAFE.has(policy);
    })
    .sort();
}

describe('org-data source manifest', () => {
  const { orgLinked, allModels, orgOnDelete } = scanSchemaFiles(readSchemaFiles());
  const declared = declaredModels();

  describe('the scan itself', () => {
    it('finds the schema files', () => {
      expect(allModels.size).toBeGreaterThan(40);
      expect(allModels.has('Org')).toBe(true);
    });

    it('finds the orgId columns it is meant to find', () => {
      // Guard on the guard: if the regex stops matching, the coverage rule
      // below passes while protecting nothing. The five §106 columns are
      // pinned by name; §107 t-705 took the count to 43 (42 tenant-owned +
      // OrgMembership) and the classification test owns that roster.
      for (const model of [
        'AiAgentEmbedToken',
        'AiAgentInviteToken',
        'AiApiKey',
        'McpApiKey',
        'OrgMembership',
      ]) {
        expect(orgLinked.has(model), model).toBe(true);
      }
      // A lower bound, not a total: a fork adds a column plus a disposition
      // and is done — it must not have to edit this file too.
      expect(orgLinked.size).toBeGreaterThanOrEqual(43);
    });

    it('does not mistake Session.activeOrgId for the org’s data', () => {
      expect(orgLinked.has('Session')).toBe(false);
    });
  });

  describe('coverage', () => {
    it('declares every model that carries an orgId', () => {
      const missing = undeclaredOrgModels(orgLinked, declared);

      expect(
        missing,
        missing.length === 0
          ? ''
          : `These models carry an orgId column but are in neither ORG_DATA_SOURCES nor ` +
              `ORG_EXCLUDED_SOURCES, so an org's export silently omits them: ${missing.join(', ')}. ` +
              `Add each with a disposition, or exclude it with a reason. See .context/privacy/org-export.md.`
      ).toEqual([]);
    });

    it('names only models that exist', () => {
      const unknown = [...declared].filter((model) => !allModels.has(model)).sort();
      expect(unknown).toEqual([]);
    });

    it('declares each model once', () => {
      const models = [
        ...ORG_DATA_SOURCES.map((source) => source.model),
        ...ORG_EXCLUDED_SOURCES.map((source) => source.model),
      ];
      expect(new Set(models).size).toBe(models.length);
    });

    it('accepts every declaration this checkout’s seam makes', () => {
      // A rejected fork row is dropped with a log, and the export then refuses
      // every org — in production, at the first export. This is where it turns
      // red at build time instead: vanilla registers nothing, so it passes; a
      // fork with a malformed or clashing row fails here, and the log above the
      // failure says which row and why.
      __resetAppOrgSourceRegistryForTests();
      expect(appOrgDeclarationsFailed()).toBe(false);
    });

    it('has no fork registration shadowing a core manifest model', () => {
      // The registry cannot check this itself without importing the core
      // manifest and its Prisma client, so the guard does — a fork claiming a
      // core model would export it twice or exclude a table core exports.
      expect(shadowedCoreModels()).toEqual([]);
    });

    it('gives every orgId model an Org relation that cascades or detaches on erasure', () => {
      // Org erasure deletes the Org row and lets the database cascade; it does
      // not walk a manifest. No relation: the rows outlive the erasure, holding
      // an org id nothing resolves. The default (Restrict): erasure fails.
      const unsafe = unsafeOnErasure(orgLinked, orgOnDelete);
      expect(
        unsafe,
        unsafe.length === 0
          ? ''
          : `These models carry an orgId but their Org relation is missing or has no ` +
              `onDelete: Cascade / SetNull, so org erasure would leave or refuse their rows: ` +
              `${unsafe.join(', ')}. See .context/privacy/org-erasure.md.`
      ).toEqual([]);
    });

    it('covers pending invitations, which have no orgId column', () => {
      // The org is in `Verification.metadata`, keyed by the invitee's email —
      // invisible to the column scan, listed by hand, pinned here.
      expect(declared.has('Verification')).toBe(true);
      expect(orgLinked.has('Verification')).toBe(false);
    });

    it('classifies the four credential kinds as attribution — identity, not material', () => {
      for (const model of ['AiApiKey', 'AiAgentEmbedToken', 'AiAgentInviteToken', 'McpApiKey']) {
        const source = ORG_DATA_SOURCES.find((candidate) => candidate.model === model);
        expect(source?.disposition, model).toBe('attribution');
      }
    });

    it('gives every source a section and a description the reader sees', () => {
      for (const source of ORG_DATA_SOURCES) {
        expect(source.section, source.model).toMatch(/^[a-z][A-Za-z]+$/);
        expect(source.description.length, source.model).toBeGreaterThan(20);
      }
      expect(new Set(ORG_DATA_SOURCES.map((source) => source.section)).size).toBe(
        ORG_DATA_SOURCES.length
      );
    });
  });

  /**
   * The rule, shown to fire. A schema with an `orgId` model that the
   * manifest does not know is named — this is what §107 t-705 hit 38 times.
   */
  describe('the rule against a synthetic schema', () => {
    const fixture: SchemaFile[] = [
      {
        name: 'orchestration-agents.prisma',
        contents: [
          'model AppWidget {',
          '  id    String @id',
          '  orgId String?',
          '  org   Org?   @relation(fields: [orgId], references: [id])',
          '}',
          'model Session {',
          '  id          String  @id',
          '  activeOrgId String?',
          '}',
          'model Org {',
          '  id String @id',
          '}',
        ].join('\n'),
      },
    ];

    it('names a model with an orgId column that neither list declares', () => {
      const scan = scanSchemaFiles(fixture);
      expect(undeclaredOrgModels(scan.orgLinked, declared)).toEqual(['AppWidget']);
    });

    it('is satisfied by a declaration in either list', () => {
      const scan = scanSchemaFiles(fixture);
      expect(undeclaredOrgModels(scan.orgLinked, new Set([...declared, 'AppWidget']))).toEqual([]);
    });

    describe('a fork model registered through the app seam', () => {
      afterEach(() => __resetAppOrgSourceRegistryForTests());

      /**
       * A clean registry with the seam's own init already run, so the test's
       * rows land on top of whatever this checkout's `initAppOrgSources()`
       * registers rather than having that init run after them, and collide.
       */
      const freshRegistry = (): void => {
        __resetAppOrgSourceRegistryForTests();
        getAccountedAppOrgModels();
      };

      it('is accepted once registered as a source', () => {
        freshRegistry();
        registerAppOrgSources({
          tier: 'app',
          sources: [
            {
              model: 'AppWidget',
              section: 'widgets',
              disposition: 'export',
              description: 'Widgets the organisation configured.',
              fetch: () => Promise.resolve([]),
            },
          ],
        });
        const scan = scanSchemaFiles(fixture);
        expect(undeclaredOrgModels(scan.orgLinked, declaredModels())).toEqual([]);
      });

      it('is accepted once registered as an exclusion', () => {
        freshRegistry();
        registerAppOrgSources({
          tier: 'app',
          excluded: [
            { model: 'AppWidget', reason: 'Render cache rebuilt from rows the export carries.' },
          ],
        });
        const scan = scanSchemaFiles(fixture);
        expect(undeclaredOrgModels(scan.orgLinked, declaredModels())).toEqual([]);
      });

      it('still fails when a different fork model is registered instead', () => {
        freshRegistry();
        registerAppOrgSources({
          tier: 'app',
          excluded: [{ model: 'AppGadget', reason: 'Not the model the schema adds, on purpose.' }],
        });
        const scan = scanSchemaFiles(fixture);
        expect(undeclaredOrgModels(scan.orgLinked, declaredModels())).toEqual(['AppWidget']);
      });

      it('is flagged when it shadows a core manifest model', () => {
        freshRegistry();
        registerAppOrgSources({
          tier: 'app',
          excluded: [
            { model: 'AiAgent', reason: 'A fork claiming a core model, which it must not.' },
          ],
        });
        expect(shadowedCoreModels()).toEqual(['AiAgent']);
      });
    });

    describe('the erasure rule', () => {
      const relationFixture = (relation: string): SchemaFile[] => [
        {
          name: 'app.prisma',
          contents: [
            'model AppWidget {',
            '  id    String @id',
            '  orgId String?',
            relation,
            '}',
          ].join('\n'),
        },
      ];

      it.each([
        [
          'Cascade',
          '  org   Org?   @relation(fields: [orgId], references: [id], onDelete: Cascade)',
        ],
        [
          'SetNull',
          '  org   Org?   @relation(fields: [orgId], references: [id], onDelete: SetNull)',
        ],
        [
          'a required relation',
          '  org   Org    @relation(fields: [orgId], references: [id], onDelete: Cascade)',
        ],
        [
          'a composite key',
          '  org   Org    @relation(fields: [orgId, key], references: [id, key], onDelete: Cascade)',
        ],
      ])('accepts %s', (_label, relation) => {
        const scan = scanSchemaFiles(relationFixture(relation));
        expect(unsafeOnErasure(scan.orgLinked, scan.orgOnDelete)).toEqual([]);
      });

      it.each([
        [
          'no onDelete (Restrict by default)',
          '  org   Org?   @relation(fields: [orgId], references: [id])',
        ],
        [
          'Restrict',
          '  org   Org?   @relation(fields: [orgId], references: [id], onDelete: Restrict)',
        ],
        [
          'NoAction',
          '  org   Org?   @relation(fields: [orgId], references: [id], onDelete: NoAction)',
        ],
        ['no relation at all', '  note  String?'],
        [
          'an onDelete only in a trailing comment',
          '  org   Org?   @relation(fields: [orgId], references: [id]) // TODO onDelete: Cascade',
        ],
        [
          'a second Org relation that is unsafe',
          '  org   Org?   @relation("a", fields: [orgId], references: [id], onDelete: Cascade)\n' +
            '  org2  Org?   @relation("b", fields: [orgId], references: [id])',
        ],
        [
          'an unsafe Org relation before a safe one',
          '  org   Org?   @relation("a", fields: [orgId], references: [id])\n' +
            '  org2  Org?   @relation("b", fields: [orgId], references: [id], onDelete: Cascade)',
        ],
      ])('names a model with %s', (_label, relation) => {
        const scan = scanSchemaFiles(relationFixture(relation));
        expect(unsafeOnErasure(scan.orgLinked, scan.orgOnDelete)).toEqual(['AppWidget']);
      });

      it('reads the real schema’s relations at all', () => {
        // Guard on the guard: a relation regex that matched nothing would
        // name every model, and one that matched everything would name none.
        expect(orgOnDelete.size).toBe(orgLinked.size);
        expect(orgOnDelete.get('AiCostLog')).toBe('SetNull');
        expect(orgOnDelete.get('AiAgent')).toBe('Cascade');
      });
    });
  });

  describe('what the sources ask Prisma for', () => {
    /**
     * Sources whose rows carry a secret column withheld with `omit`.
     * `AiEventHook` is the fourth secret-bearing source but is not here: its
     * rows are mapped through `toSafeHook` instead, pinned separately below.
     */
    const SECRET_COLUMNS: Record<string, string> = {
      AiWebhookSubscription: 'secret',
      AiWorkflowTrigger: 'signingSecret',
      AiWorkflowExecution: 'leaseToken',
    };
    const MAPPED_SOURCES = new Set(['AiEventHook']);
    const lowerFirst = (name: string) => name[0].toLowerCase() + name.slice(1);
    // Core's sources only: a fork's `fetch` is its own, with no core delegate
    // behind it, so these assertions about core's queries do not apply to it.
    const tenantOwnedExports = ORG_DATA_SOURCES.filter(
      (source) =>
        source.disposition === 'export' && !['OrgMembership', 'Verification'].includes(source.model)
    );

    it('drives every tenant-owned export source (the §107 t-705 set is 36; a fork may add more)', () => {
      expect(tenantOwnedExports.length).toBeGreaterThanOrEqual(36);
    });

    it.each(tenantOwnedExports.map((source) => [source.model, source] as const))(
      '%s: scopes by the org, in a stable order, and withholds only its named secret',
      async (model, source) => {
        const delegate = prismaMock[lowerFirst(model)];
        delegate.findMany.mockResolvedValue([]);
        await source.fetch({ orgId: 'cmorg000000000000000other' });

        expect(delegate.findMany).toHaveBeenCalledTimes(1);
        const args = delegate.findMany.mock.calls[0][0] as {
          where?: unknown;
          omit?: Record<string, boolean>;
          orderBy?: unknown;
          select?: unknown;
        };
        expect(args.where).toEqual({ orgId: 'cmorg000000000000000other' });
        expect(args.orderBy).toBeDefined();
        // `export` means full rows: never a `select` (which would silently drop a column added tomorrow).
        expect(args.select).toBeUndefined();
        const secret = SECRET_COLUMNS[model];
        if (secret) {
          expect(args.omit).toEqual({ [secret]: true });
        } else {
          expect(args.omit).toBeUndefined();
        }
      }
    );

    describe('a NULL orgId is the install org’s at single, and nobody’s at multi', () => {
      const install = 'install';

      it('the install org’s export reads orgId IS NULL too — rows born before the chokepoint writes the column', async () => {
        const source = ORG_DATA_SOURCES.find((candidate) => candidate.model === 'AiAgent');
        prismaMock.aiAgent.findMany.mockResolvedValue([]);
        await source!.fetch({ orgId: install });
        expect(prismaMock.aiAgent.findMany).toHaveBeenLastCalledWith(
          expect.objectContaining({ where: { OR: [{ orgId: install }, { orgId: null }] } })
        );
      });

      it('another org’s export never reads NULL rows', async () => {
        const source = ORG_DATA_SOURCES.find((candidate) => candidate.model === 'AiAgent');
        prismaMock.aiAgent.findMany.mockResolvedValue([]);
        await source!.fetch({ orgId: 'cmorg000000000000000other' });
        expect(prismaMock.aiAgent.findMany).toHaveBeenLastCalledWith(
          expect.objectContaining({ where: { orgId: 'cmorg000000000000000other' } })
        );
      });

      it('at multi the install org’s match is strict — enable backfills NULL before enforcing', async () => {
        vi.mocked(isMultiTenant).mockReturnValue(true);
        try {
          const source = ORG_DATA_SOURCES.find((candidate) => candidate.model === 'AiAgent');
          prismaMock.aiAgent.findMany.mockResolvedValue([]);
          await source!.fetch({ orgId: install });
          expect(prismaMock.aiAgent.findMany).toHaveBeenLastCalledWith(
            expect.objectContaining({ where: { orgId: install } })
          );
        } finally {
          vi.mocked(isMultiTenant).mockReturnValue(false);
        }
      });

      it('a NULL-org credential is a platform key, never the install org’s — attribution stays strict', async () => {
        const source = ORG_DATA_SOURCES.find((candidate) => candidate.model === 'AiApiKey');
        prismaMock.aiApiKey.findMany.mockResolvedValue([]);
        await source!.fetch({ orgId: install });
        expect(prismaMock.aiApiKey.findMany).toHaveBeenLastCalledWith(
          expect.objectContaining({ where: { orgId: install } })
        );
      });
    });

    it('withholds a secret from exactly the sources that carry one', () => {
      const withOmit = tenantOwnedExports
        .map((source) => source.model)
        .filter((model) => model in SECRET_COLUMNS || MAPPED_SOURCES.has(model));
      expect(withOmit.sort()).toEqual([...Object.keys(SECRET_COLUMNS), ...MAPPED_SOURCES].sort());
    });

    it('masks an event hook’s custom header values and drops its secret (toSafeHook), keeping the header names', async () => {
      // The receiver's bearer token lives in `action.headers` — the admin API
      // never returns it in plaintext, and neither may the org export.
      prismaMock.aiEventHook.findMany.mockResolvedValue([
        {
          id: 'hook-1',
          name: 'Notify CRM',
          eventType: 'conversation.ended',
          action: {
            type: 'webhook',
            url: 'https://crm.example/hooks',
            headers: { Authorization: 'Bearer live-token', 'X-Env': 'prod' },
          },
          filter: null,
          isEnabled: true,
          secret: 'signing-secret',
          createdBy: 'user-1',
          createdAt: new Date('2026-09-01'),
          updatedAt: new Date('2026-09-01'),
          orgId: 'cmorg000000000000000other',
        },
      ]);
      const source = ORG_DATA_SOURCES.find((candidate) => candidate.model === 'AiEventHook');
      const [row] = (await source!.fetch({ orgId: 'cmorg000000000000000other' })) as Array<
        Record<string, unknown>
      >;

      expect(row).not.toHaveProperty('secret');
      expect(row.hasSecret).toBe(true);
      expect((row.action as { url: string }).url).toBe('https://crm.example/hooks');
      expect((row.action as { headers: Record<string, string> }).headers).toEqual({
        Authorization: '••••••••',
        'X-Env': '••••••••',
      });
      expect(JSON.stringify(row)).not.toContain('live-token');
      expect(JSON.stringify(row)).not.toContain('signing-secret');
    });

    it('strips agent_call thinking blocks from a running step’s turns, keeping the rest of each turn', async () => {
      // A step paused for approval keeps its running-step row, and its
      // checkpoint turns carry the signed thinking a resume replays.
      const toolTurn = {
        kind: 'agent_call',
        phase: 'continuing',
        index: 0,
        assistantContent: '',
        toolCall: { id: 'tc_1', name: 'cap', arguments: {} },
        toolResult: { ok: true },
        tokensUsed: 10,
        costUsd: 0.01,
      };
      const reflectTurn = { kind: 'reflect', iteration: 0, draft: 'd', converged: false };
      prismaMock.aiWorkflowRunningStep.findMany.mockResolvedValue([
        {
          id: 'rs-1',
          executionId: 'exec-1',
          stepId: 'a',
          turns: [
            {
              ...toolTurn,
              reasoning: [
                { type: 'thinking', thinking: 'secret plan', signature: 'sig-1' },
                { type: 'redacted_thinking', data: 'opaque-blob' },
              ],
            },
            reflectTurn,
          ],
          orgId: 'cmorg000000000000000other',
        },
        { id: 'rs-2', executionId: 'exec-1', stepId: 'b', turns: null, orgId: null },
      ]);
      const source = ORG_DATA_SOURCES.find((c) => c.model === 'AiWorkflowRunningStep');
      const rows = (await source!.fetch({ orgId: 'cmorg000000000000000other' })) as Array<
        Record<string, unknown>
      >;

      expect(rows[0].turns).toEqual([toolTurn, reflectTurn]);
      expect(rows[0]).toMatchObject({ id: 'rs-1', executionId: 'exec-1', stepId: 'a' });
      expect(rows[1].turns).toBeNull();
      expect(JSON.stringify(rows)).not.toContain('secret plan');
      expect(JSON.stringify(rows)).not.toContain('opaque-blob');
    });

    it('withholds the invitation token and selects invitations INTO this org only', async () => {
      prismaMock.verification.findMany.mockResolvedValue([]);
      const source = ORG_DATA_SOURCES.find((candidate) => candidate.model === 'Verification');
      await source!.fetch({ orgId: 'cmorg000000000000000other' });

      expect(prismaMock.verification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            identifier: { startsWith: 'invitation:' },
            metadata: { path: ['orgId'], equals: 'cmorg000000000000000other' },
          },
          omit: { value: true },
        })
      );
    });

    it('returns the roster with each member’s id, name and email — nothing else of theirs', async () => {
      prismaMock.orgMembership.findMany.mockResolvedValue([]);
      const source = ORG_DATA_SOURCES.find((candidate) => candidate.model === 'OrgMembership');
      await source!.fetch({ orgId: 'cmorg000000000000000other' });

      expect(prismaMock.orgMembership.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orgId: 'cmorg000000000000000other' },
          include: { user: { select: { id: true, name: true, email: true } } },
        })
      );
    });

    it('reduces every credential to id + label + date, never a hash or a scope', async () => {
      const row = { id: 'k1', name: 'CI key', label: 'Widget', createdAt: new Date('2026-09-01') };
      prismaMock.aiApiKey.findMany.mockResolvedValue([row]);
      prismaMock.mcpApiKey.findMany.mockResolvedValue([row]);
      prismaMock.aiAgentEmbedToken.findMany.mockResolvedValue([row]);
      prismaMock.aiAgentInviteToken.findMany.mockResolvedValue([row]);

      for (const model of ['AiApiKey', 'McpApiKey', 'AiAgentEmbedToken', 'AiAgentInviteToken']) {
        const source = ORG_DATA_SOURCES.find((candidate) => candidate.model === model);
        const rows = (await source!.fetch({ orgId: 'x' })) as Record<string, unknown>[];
        expect(rows, model).toHaveLength(1);
        expect(Object.keys(rows[0]).sort(), model).toEqual(['createdAt', 'id', 'label']);
      }
      // And the query itself selects those columns rather than fetching the row.
      expect(prismaMock.aiApiKey.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ select: { id: true, name: true, createdAt: true } })
      );
    });
  });
});
