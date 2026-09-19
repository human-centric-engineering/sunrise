/**
 * Coverage guard: every Prisma model is classified (§107 t-705)
 *
 * Every model in `prisma/schema/*.prisma` must be exactly one of tenant-owned
 * (carries `orgId`), on `GLOBAL_CONFIG_MODELS`, or on `SYSTEM_MODELS`. A model
 * that is none of them — upstream's or a fork's — fails here by name, because
 * an unclassified model is one nobody decided about, and the row-isolation
 * policies, injection, probes and enable script all derive from that decision.
 *
 * If this test names a model you just added:
 *   • it belongs to one org → add `orgId String?` + `org Org? @relation(...)`
 *     + `@@index([orgId])` (the shape every tenant-owned model uses) and give
 *     it a disposition in `lib/privacy/org-sources.ts`;
 *   • it is platform configuration every org shares → `GLOBAL_CONFIG_MODELS`;
 *   • it decides or records tenancy → `SYSTEM_MODELS`.
 * Never delete a model from an allowlist to go green — the header of
 * `lib/tenancy/classification.ts` says why.
 *
 * The second half pins the runtime derivation (the generated client's
 * `_runtimeDataModel`) to the schema text: same model set, same `orgId`
 * verdicts, same table names. That is what lets consumers read the roster off
 * the client with no hand-written list.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';

/**
 * A real generated client on a pool that never connects — `_runtimeDataModel`
 * is populated by the constructor, and no test here runs a query.
 */
const realClient = vi.hoisted(async () => {
  const { Pool } = await import('pg');
  const { PrismaPg } = await import('@prisma/adapter-pg');
  const { PrismaClient } = await import('@prisma/client');
  const pool = new Pool({ connectionString: 'postgresql://never:connects@127.0.0.1:1/never' });
  return new PrismaClient({ adapter: new PrismaPg(pool) });
});
vi.mock('@/lib/db/client', async () => ({ prisma: await realClient }));

const {
  SYSTEM_MODELS,
  GLOBAL_CONFIG_MODELS,
  classifyModels,
  readRuntimeDataModel,
  tenantOwnedModels,
} = await import('@/lib/tenancy/classification');
type RuntimeDataModel = import('@/lib/tenancy/classification').RuntimeDataModel;

const SCHEMA_DIR = path.join(process.cwd(), 'prisma', 'schema');
const MODEL_OPEN = /^model\s+(\w+)\s*\{/;
/** The column, by name and exactly — `Session.activeOrgId` is a pointer, not ownership. */
const ORG_ID_FIELD = /^\s*orgId\s+String/;
const MAP = /^\s*@@map\("([^"]+)"\)/;

interface SchemaModel {
  name: string;
  hasOrgId: boolean;
  table: string;
}

/** Every model, whether it declares `orgId`, and its table name, from schema text. */
function scanSchema(files: string[]): Map<string, SchemaModel> {
  const models = new Map<string, SchemaModel>();
  for (const contents of files) {
    let current: SchemaModel | null = null;
    for (const line of contents.split('\n')) {
      const open = MODEL_OPEN.exec(line);
      if (open) {
        current = { name: open[1], hasOrgId: false, table: open[1] };
        models.set(current.name, current);
        continue;
      }
      if (line.startsWith('}')) {
        current = null;
        continue;
      }
      if (!current) continue;
      if (ORG_ID_FIELD.test(line)) current.hasOrgId = true;
      const map = MAP.exec(line);
      if (map) current.table = map[1];
    }
  }
  return models;
}

function readSchemaFiles(): string[] {
  return readdirSync(SCHEMA_DIR)
    .filter((file) => file.endsWith('.prisma'))
    .map((name) => readFileSync(path.join(SCHEMA_DIR, name), 'utf8'));
}

/** Build a runtime-data-model fixture from the schema scan — the same shape the client exposes. */
function toRuntimeDataModel(models: Map<string, SchemaModel>): RuntimeDataModel {
  const out: RuntimeDataModel = { models: {} };
  for (const m of models.values()) {
    out.models[m.name] = {
      dbName: m.table === m.name ? null : m.table,
      fields: [
        { name: 'id', kind: 'scalar', type: 'String' },
        ...(m.hasOrgId ? [{ name: 'orgId', kind: 'scalar' as const, type: 'String' }] : []),
      ],
    };
  }
  return out;
}

describe('model classification', () => {
  const schema = scanSchema(readSchemaFiles());
  const fromSchema = classifyModels(toRuntimeDataModel(schema));

  it('finds the schema', () => {
    expect(schema.size).toBeGreaterThan(60);
  });

  it('classifies every model as exactly one of tenant-owned, global config or system', () => {
    expect(
      fromSchema.unclassified,
      `These models carry no orgId and are on neither allowlist. Decide: add orgId (tenant-owned), ` +
        `or add to GLOBAL_CONFIG_MODELS / SYSTEM_MODELS in lib/tenancy/classification.ts — never by deleting from an allowlist.`
    ).toEqual([]);
    const total =
      fromSchema.tenantOwned.length + fromSchema.globalConfig.length + fromSchema.system.length;
    expect(total).toBe(schema.size);
  });

  it('has no global-config model carrying orgId (a contradiction, not a classification)', () => {
    expect(fromSchema.contradictions).toEqual([]);
  });

  it('allowlists name only models that exist, and do not overlap', () => {
    const names = new Set(schema.keys());
    for (const m of [...SYSTEM_MODELS, ...GLOBAL_CONFIG_MODELS]) {
      expect(names.has(m), `${m} is allowlisted but is not a model in the schema`).toBe(true);
    }
    const overlap = SYSTEM_MODELS.filter((m) =>
      (GLOBAL_CONFIG_MODELS as readonly string[]).includes(m)
    );
    expect(overlap).toEqual([]);
  });

  it('classifies the credential models and the org rows the way §106/§107 decided', () => {
    const tenant = new Set(fromSchema.tenantOwned.map((m) => m.model));
    for (const m of [
      'AiApiKey',
      'AiAgentEmbedToken',
      'AiAgentInviteToken',
      'McpApiKey',
      'AiAgent',
      'AiMessage',
    ]) {
      expect(tenant.has(m), `${m} should be tenant-owned`).toBe(true);
    }
    // OrgMembership carries orgId but is the join that decides the tenant.
    expect(fromSchema.system).toContain('OrgMembership');
    expect(tenant.has('OrgMembership')).toBe(false);
  });

  describe('the rule, shown to fire', () => {
    it('names a model with no orgId that is on neither allowlist', () => {
      const fixture = toRuntimeDataModel(
        new Map([
          ...schema,
          ['AppWidget', { name: 'AppWidget', hasOrgId: false, table: 'app_widget' }],
        ])
      );
      expect(classifyModels(fixture).unclassified).toEqual(['AppWidget']);
    });

    it('is satisfied by adding orgId — no registration step', () => {
      const fixture = toRuntimeDataModel(
        new Map([
          ...schema,
          ['AppWidget', { name: 'AppWidget', hasOrgId: true, table: 'app_widget' }],
        ])
      );
      const result = classifyModels(fixture);
      expect(result.unclassified).toEqual([]);
      expect(result.tenantOwned).toContainEqual({ model: 'AppWidget', table: 'app_widget' });
    });

    it('names a global-config model that grew an orgId', () => {
      const fixture = toRuntimeDataModel(
        new Map([
          ...schema,
          ['FeatureFlag', { name: 'FeatureFlag', hasOrgId: true, table: 'feature_flag' }],
        ])
      );
      expect(classifyModels(fixture).contradictions).toEqual(['FeatureFlag']);
    });
  });

  describe('runtime derivation agrees with the schema text', () => {
    it('reads the runtime data model off a generated client', async () => {
      const rdm = readRuntimeDataModel(await realClient);
      expect(Object.keys(rdm.models).sort()).toEqual([...schema.keys()].sort());
    });

    it('derives the same tenant-owned set, with the same table names', async () => {
      const fromClient = classifyModels(readRuntimeDataModel(await realClient));
      expect(fromClient.tenantOwned).toEqual(fromSchema.tenantOwned);
      expect(fromClient.unclassified).toEqual([]);
      expect(fromClient.contradictions).toEqual([]);
    });

    it('tenantOwnedModels() serves that roster from the application client', () => {
      const roster = tenantOwnedModels();
      expect([...roster.entries()]).toEqual(fromSchema.tenantOwned.map((m) => [m.model, m.table]));
      expect(roster.get('AiAgent')).toBe('ai_agent');
      expect(roster.has('Org')).toBe(false);
    });

    it('throws a named error when a client has no runtime data model', () => {
      expect(() => readRuntimeDataModel({})).toThrow(/_runtimeDataModel/);
    });
  });
});
