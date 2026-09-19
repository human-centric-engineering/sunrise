/**
 * Coverage guard: lib/privacy/org-sources.ts vs prisma/schema/*.prisma (§106 t-672)
 *
 * The org-subject counterpart of `export-sources.test.ts`: holds the org
 * manifest level with every `orgId` column in the schema, so a table cannot
 * join an org without someone deciding what the org receives from it. Today
 * that is five models; when row isolation (§107) adds `orgId` to the
 * tenant-owned models this test names every one of them until it is
 * classified — as a source, or as an exclusion with a reason.
 *
 * ---------------------------------------------------------------------------
 * IF THIS TEST IS FAILING
 * ---------------------------------------------------------------------------
 * You added an `orgId` column. Add the model to `ORG_DATA_SOURCES` with a
 * disposition (`export` for the org's own records — use Prisma `omit` for
 * credential columns; `attribution` for identity-only rows), or to
 * `ORG_EXCLUDED_SOURCES` with the reason the reader is shown. Deleting the
 * row ships a short answer to a customer. See `.context/privacy/org-export.md`.
 *
 * The scan is exercised against a synthetic schema as well as the real one,
 * so the rule is shown to fire — in vanilla Sunrise every `orgId` model is
 * declared, and a rule with nothing to catch passes while protecting nothing.
 *
 * @see lib/privacy/org-sources.ts
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';

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

const { ORG_DATA_SOURCES, ORG_EXCLUDED_SOURCES } = await import('@/lib/privacy/org-sources');

const SCHEMA_DIR = path.join(process.cwd(), 'prisma', 'schema');
const MODEL_OPEN = /^model\s+(\w+)\s*\{/;
/**
 * The column, by name and exactly. `activeOrgId` on `Session` is a pointer
 * to the org the session acts in, not the org's data, and must not match;
 * a fork naming its own column `tenantId` is §109's accounting, not this.
 */
const ORG_ID_FIELD = /^\s*orgId\s+String/;

interface SchemaFile {
  name: string;
  contents: string;
}

/** Every model declaring an `orgId` column, and every model name, from the given sources. */
function scanSchemaFiles(files: SchemaFile[]): { orgLinked: Set<string>; allModels: Set<string> } {
  const orgLinked = new Set<string>();
  const allModels = new Set<string>();
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
      if (currentModel && ORG_ID_FIELD.test(line)) orgLinked.add(currentModel);
    }
  }
  return { orgLinked, allModels };
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

describe('org-data source manifest', () => {
  const { orgLinked, allModels } = scanSchemaFiles(readSchemaFiles());
  const declared = new Set([
    ...ORG_DATA_SOURCES.map((source) => source.model),
    ...ORG_EXCLUDED_SOURCES.map((source) => source.model),
  ]);

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
      expect(orgLinked.size).toBe(43);
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
  });

  describe('what the sources ask Prisma for', () => {
    /** The three sources whose rows carry a signing secret, and the column each withholds. */
    const SECRET_COLUMNS: Record<string, string> = {
      AiWebhookSubscription: 'secret',
      AiWorkflowTrigger: 'signingSecret',
      AiEventHook: 'secret',
    };
    const lowerFirst = (name: string) => name[0].toLowerCase() + name.slice(1);
    const tenantOwnedExports = ORG_DATA_SOURCES.filter(
      (source) =>
        source.disposition === 'export' && !['OrgMembership', 'Verification'].includes(source.model)
    );

    it('drives every tenant-owned export source (the §107 t-705 set is 36)', () => {
      expect(tenantOwnedExports.length).toBe(36);
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

    it('withholds a secret from exactly the three sources that carry one', () => {
      const withOmit = tenantOwnedExports
        .map((source) => source.model)
        .filter((model) => model in SECRET_COLUMNS);
      expect(withOmit.sort()).toEqual(Object.keys(SECRET_COLUMNS).sort());
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
