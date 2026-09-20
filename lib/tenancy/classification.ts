/**
 * Model classification — which tables are a tenant's, which are the
 * platform's, which are the system's (§107 t-705).
 *
 * Every Prisma model is exactly one of three things, and
 * `tests/unit/lib/tenancy/model-classification.test.ts` fails naming any model
 * that is none of them — including a fork's own:
 *
 *   • **tenant-owned** — carries an `orgId` column and is not on either
 *     allowlist. A row belongs to one org. This is the set the row-isolation
 *     policies, the write-side injection, the drift probes and the enable
 *     script all derive from (design principle 4): a model joins by adding the
 *     column, with no registration step.
 *   • **global config** — {@link GLOBAL_CONFIG_MODELS}: platform configuration
 *     every org shares. A `createdBy` on these is provenance, not ownership.
 *   • **system** — {@link SYSTEM_MODELS}: identity, audit and bootstrap rows
 *     that decide or record tenancy rather than belong to a tenant.
 *
 * **Never delete a model from an allowlist to make the test pass.** A model
 * that leaves an allowlist without gaining `orgId` is unclassified, and the
 * test says so; a model that gains `orgId` while staying on an allowlist is a
 * contradiction the test also names. Move it deliberately, with the column
 * change in the same PR.
 *
 * The tenant-owned set is derived at runtime from the generated client's
 * runtime data model (field names, kinds, and the `@@map` table name), not
 * from a hand-written list — the spike (design doc, Spike register item 8)
 * confirmed that model carries what every consumer needs. The test pins the
 * derivation to `prisma/schema/*.prisma` so the two can never drift apart.
 *
 * @see .context/architecture/multi-tenancy-design.md — principles 4 and 5
 * @see lib/privacy/org-sources.ts — what an org receives from each tenant-owned model
 */

/**
 * System rows: they decide or record tenancy rather than belong to a tenant.
 * `OrgMembership` carries `orgId` but is the join that *decides* which org a
 * request acts for — reading it cross-org is the org switcher's job — and
 * `Session` / `Account` are the user's under multi-membership, not any one
 * org's (§107 planning decision, 2026-09-18).
 */
export const SYSTEM_MODELS = [
  'User',
  'Session',
  'Account',
  'Verification',
  'Org',
  'OrgMembership',
  'AuthBootstrap',
  'SeedHistory',
  'ContactSubmission',
  'DataErasureReceipt',
  'McpAuditLog',
  'AiAdminAuditLog',
] as const;

/**
 * Platform configuration shared by every org. The two singletons
 * (`AiOrchestrationSettings`, `McpServerConfig`) cannot take an `orgId` at
 * all; the rest could, and a fork *may* scope one as a product decision — by
 * adding the column and removing it from this list in the same change.
 */
export const GLOBAL_CONFIG_MODELS = [
  'AiProviderConfig',
  'AiProviderModel',
  'AiCapability',
  'AiAgentProfile',
  'FeatureFlag',
  'KnowledgeTag',
  'McpExposedTool',
  'McpExposedPrompt',
  'McpExposedResource',
  'McpServerConfig',
  'AiOrchestrationSettings',
] as const;

export type SystemModel = (typeof SYSTEM_MODELS)[number];
export type GlobalConfigModel = (typeof GLOBAL_CONFIG_MODELS)[number];

/** The slice of Prisma's runtime data model this module reads. */
export interface RuntimeDataModelField {
  name: string;
  kind: 'scalar' | 'object' | 'enum' | 'unsupported';
  /** The scalar type, or for a relation (`kind: 'object'`) the target model. */
  type: string;
  /** Present on relation fields; the two ends of a relation share it. */
  relationName?: string;
}
export interface RuntimeDataModelModel {
  fields: RuntimeDataModelField[];
  /** The `@@map` table name, or `null` when the model name is the table name. */
  dbName: string | null;
}
export interface RuntimeDataModel {
  models: Record<string, RuntimeDataModelModel>;
}

/**
 * Read the runtime data model off a generated Prisma client. `_runtimeDataModel`
 * is not a documented property; it has been stable across Prisma 7 and the
 * classification test asserts its shape against the schema on every run, so a
 * Prisma release that moves it fails loudly there rather than silently here.
 */
export function readRuntimeDataModel(client: unknown): RuntimeDataModel {
  const rdm = (client as { _runtimeDataModel?: unknown })._runtimeDataModel;
  if (!rdm || typeof rdm !== 'object' || !('models' in rdm)) {
    throw new Error(
      'Prisma client exposes no _runtimeDataModel; the tenancy classification cannot derive the tenant-owned set'
    );
  }
  return rdm as RuntimeDataModel;
}

export interface TenantOwnedModel {
  /** Prisma model name, e.g. `AiAgent`. */
  model: string;
  /** Postgres table name, e.g. `ai_agent`. */
  table: string;
}

export interface ModelClassification {
  tenantOwned: TenantOwnedModel[];
  globalConfig: string[];
  system: string[];
  /** Models that are none of the three — the build fails while this is non-empty. */
  unclassified: string[];
  /** Allowlisted models that also carry `orgId` — a contradiction (system models excepted). */
  contradictions: string[];
}

function hasOrgId(model: RuntimeDataModelModel): boolean {
  return model.fields.some((f) => f.name === 'orgId' && f.kind === 'scalar');
}

/**
 * Classify every model in a runtime data model. Pure — the test runs it on
 * the real client and on synthetic fixtures alike.
 */
export function classifyModels(rdm: RuntimeDataModel): ModelClassification {
  const system = new Set<string>(SYSTEM_MODELS);
  const global = new Set<string>(GLOBAL_CONFIG_MODELS);
  const out: ModelClassification = {
    tenantOwned: [],
    globalConfig: [],
    system: [],
    unclassified: [],
    contradictions: [],
  };
  for (const [name, model] of Object.entries(rdm.models).sort(([a], [b]) => a.localeCompare(b))) {
    const org = hasOrgId(model);
    if (system.has(name)) {
      out.system.push(name);
    } else if (global.has(name)) {
      out.globalConfig.push(name);
      if (org) out.contradictions.push(name);
    } else if (org) {
      out.tenantOwned.push({ model: name, table: model.dbName ?? name });
    } else {
      out.unclassified.push(name);
    }
  }
  return out;
}

const rosters = new WeakMap<object, ReadonlyMap<string, string>>();

/**
 * Model name → table name for every tenant-owned model, derived once per
 * client (pass the application's `prisma`). This is the roster the
 * row-isolation policies, the drift probes and the enable script read;
 * nothing hand-lists it.
 *
 * The client is a parameter rather than an import: `lib/db/client.ts` reads
 * this module to build the chokepoint, so importing the client back from here
 * would be a cycle whose evaluation order depends on which side a script
 * loads first.
 */
export function tenantOwnedModels(client: object): ReadonlyMap<string, string> {
  let roster = rosters.get(client);
  if (!roster) {
    const { tenantOwned } = classifyModels(readRuntimeDataModel(client));
    roster = new Map(tenantOwned.map((m) => [m.model, m.table]));
    rosters.set(client, roster);
  }
  return roster;
}
