/**
 * Model classification — which tables are a tenant's, which are the
 * platform's, which are the system's (§107 t-705).
 *
 * Every Prisma model is exactly one of four things, and
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
 *   • **user-owned** — {@link USER_OWNED_MODELS} (t-984, #1041): rows a person
 *     owns outside any org — a drummer's kits, a practice run. No `orgId` (a
 *     person spans orgs), and a link to a user. Neither isolated by org nor a
 *     shared setting: routes writing one are not asked to declare a
 *     shared-settings write. A `per-org` job must not sweep one — it would run
 *     once per active org (`.context/architecture/multi-tenancy.md`).
 *
 * A fork classifies its own models through `lib/app/tenancy-classification.ts`
 * (t-983, #964), never by editing these lists; {@link classifyModels} reads
 * core's lists and every tier's registrations alike.
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

import { initAppTenancyClassification } from '@/lib/app/tenancy-classification';
import { createAppInitGate, restoreMap } from '@/lib/fork-init';
import { logger } from '@/lib/logging';

/**
 * System rows: they decide or record tenancy rather than belong to a tenant.
 * `OrgMembership` carries `orgId` but is the join that *decides* which org a
 * request acts for — reading it cross-org is the org switcher's job — and
 * `Session` / `Account` are the user's under multi-membership, not any one
 * org's (§107 planning decision, 2026-09-18). `OrgSupportGrant` (§121 t-823)
 * is `OrgMembership`'s other half: it decides whether a non-member may enter,
 * so it is read before any org is.
 */
export const SYSTEM_MODELS = [
  'User',
  'Session',
  'Account',
  'Verification',
  'Org',
  'OrgMembership',
  'OrgSupportGrant',
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

/**
 * Rows a person owns outside any org (t-984). Empty in core today: core's
 * per-person rows (`Session`, `Account`) decide or record identity, and are
 * system. The class exists for forks' product data, declared through the seam.
 */
// Frozen, not `[] as const`: an empty literal reads as a registry filled later,
// and this list is core's, fixed at build time.
export const USER_OWNED_MODELS: readonly string[] = Object.freeze<string[]>([]);

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

/**
 * Read the schema text the generated client embeds for its query compiler.
 * `_engineConfig.inlineSchema` is, like `_runtimeDataModel`, undocumented;
 * the classification test pins it to `prisma/schema/*.prisma` on every run.
 */
export function readInlineSchema(client: unknown): string {
  const text = (client as { _engineConfig?: { inlineSchema?: unknown } })._engineConfig
    ?.inlineSchema;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error(
      'Prisma client exposes no _engineConfig.inlineSchema; the tenancy chokepoint cannot tell which relations carry their foreign key'
    );
  }
  return text;
}

const MODEL_OPEN = /^model\s+(\w+)\s*\{/;
const FK_RELATION = /^\s*(\w+)\s+\w+\??\s+@relation\([^)]*\bfields:\s*\[/;

/**
 * For every model, the relation fields whose foreign key lives on that model
 * — `@relation(fields: [...])`. These are the fields Prisma's *checked*
 * create input carries in place of the scalar FK: a create naming one of
 * them cannot also name a scalar FK such as `orgId`, and vice versa. The
 * compact runtime data model does not record which side of a relation holds
 * the key, so this is read from the schema text instead.
 */
export function foreignKeyRelations(schemaText: string): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, Set<string>>();
  let current: Set<string> | null = null;
  for (const line of schemaText.split('\n')) {
    const open = MODEL_OPEN.exec(line);
    if (open) {
      current = new Set();
      out.set(open[1], current);
      continue;
    }
    if (line.startsWith('}')) {
      current = null;
      continue;
    }
    if (!current) continue;
    const fk = FK_RELATION.exec(line);
    if (fk) current.add(fk[1]);
  }
  return out;
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
  userOwned: string[];
  /** Models that are none of the four — the build fails while this is non-empty. */
  unclassified: string[];
  /**
   * Global-config or user-owned models that also carry `orgId` — a
   * contradiction. A system model may carry one (`OrgMembership`).
   */
  contradictions: string[];
  /**
   * System models that carry `orgId`, and so are left out of row isolation on
   * purpose — `OrgMembership` in core. A fork's entry here is logged.
   */
  systemWithOrgId: string[];
}

function hasOrgId(model: RuntimeDataModelModel): boolean {
  return model.fields.some((f) => f.name === 'orgId' && f.kind === 'scalar');
}

/**
 * Classify every model in a runtime data model, against core's lists and the
 * fork tiers' registrations (running the fork's init on first use). Otherwise
 * pure: the test runs it on the real client and on synthetic fixtures alike,
 * and a fixture model a fork has also registered takes the fork's class.
 */
export function classifyModels(rdm: RuntimeDataModel): ModelClassification {
  const system = new Set<string>(allSystemModels());
  const global = new Set<string>(allGlobalConfigModels());
  const userOwned = new Set<string>(allUserOwnedModels());
  const out: ModelClassification = {
    tenantOwned: [],
    globalConfig: [],
    system: [],
    userOwned: [],
    unclassified: [],
    contradictions: [],
    systemWithOrgId: [],
  };
  for (const [name, model] of Object.entries(rdm.models).sort(([a], [b]) => a.localeCompare(b))) {
    const org = hasOrgId(model);
    if (system.has(name)) {
      out.system.push(name);
      if (org) out.systemWithOrgId.push(name);
    } else if (global.has(name)) {
      out.globalConfig.push(name);
      if (org) out.contradictions.push(name);
    } else if (userOwned.has(name)) {
      out.userOwned.push(name);
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
    const classification = classifyModels(readRuntimeDataModel(client));
    warnAboutAppIsolationExemptions(classification);
    const { tenantOwned } = classification;
    roster = new Map(tenantOwned.map((m) => [m.model, m.table]));
    rosters.set(client, roster);
  }
  return roster;
}

// ── fork tiers (t-983) ───────────────────────────────────────────────────────

/** The classes a fork tier may put its own models in. Tenant-owned is never registered: it is the `orgId` column. */
export type AppTenancyClass = 'system' | 'globalConfig' | 'userOwned';

/** One tier's classification of its own models. */
export interface AppTenancyClassificationContribution {
  /**
   * `'app'` for a leaf fork, `'framework'` for a framework tier. Not only a
   * label: a model another tier already classified keeps that tier's class,
   * and the coverage guard holds an `'app'` registration to the leaf's own
   * models. Required, non-empty.
   */
  tier: string;
  /** Models that decide or record tenancy. One carrying `orgId` leaves row isolation, and is logged. */
  system?: readonly string[];
  /** Platform configuration every org shares. Routes writing one must declare it (`writesSharedSettings`). */
  globalConfig?: readonly string[];
  /** Rows a person owns outside any org: no `orgId`, and a link to a user. */
  userOwned?: readonly string[];
}

/** One fork registration: the class, and the tier that registered it. */
export interface AppTenancyRegistration {
  cls: AppTenancyClass;
  tier: string;
}

/** Fork registrations, keyed by model. */
const appRegistrations = new Map<string, AppTenancyRegistration>();
/**
 * Models a tier listed in two classes. Refused for the life of the registry —
 * not just at the clash — so a third listing, or another tier, cannot classify
 * one after its entries were dropped: the coverage guard must name it.
 */
const clashedModels = new Set<string>();

const CORE_CLASSIFIED: ReadonlySet<string> = new Set<string>([
  ...SYSTEM_MODELS,
  ...GLOBAL_CONFIG_MODELS,
  ...USER_OWNED_MODELS,
]);

function rejectApp(tier: string, model: string, why: string): void {
  // A dropped row leaves the model unclassified (the coverage guard names it)
  // or keeps an earlier classification (this log is then the only signal).
  logger.error('tenancy-classification: app classification rejected', {
    tier,
    model,
    reason: why,
  });
}

/**
 * Classify your tier's own models for tenancy.
 *
 * Call from `lib/app/tenancy-classification.ts`'s
 * `initAppTenancyClassification()`, or from a framework tier's function that it
 * calls. Idempotent by model and class.
 *
 * A row is dropped with a log, never thrown, when it names a model on one of
 * core's lists, a model another tier has classified (the first stands), or an
 * empty name; a contribution with no `tier` is dropped whole. A model this tier
 * lists in two classes loses every entry, now and later, so it stays
 * unclassified and the coverage guard names it.
 *
 * **Register only your own models.** Core's tenant-owned models are defined by
 * their `orgId` column and listed nowhere, so this cannot refuse one — but the
 * coverage guard (`model-classification.test.ts`) fails naming any registration
 * of a model from a core schema file, or an `'app'` registration of a framework
 * tier's model. Registering one as system would take it out of row isolation.
 *
 * Name only what this file decides. Whether a model carries `orgId`, and so
 * whether the class is a contradiction, is the coverage guard's to judge
 * against the schema.
 */
export function registerAppTenancyClassification(
  contribution: AppTenancyClassificationContribution
): void {
  const tier = typeof contribution.tier === 'string' ? contribution.tier.trim() : '';
  if (tier === '') {
    rejectApp(String(contribution.tier), '<all>', '`tier` is required');
    return;
  }
  const lists: ReadonlyArray<readonly [AppTenancyClass, unknown]> = [
    ['system', contribution.system],
    ['globalConfig', contribution.globalConfig],
    ['userOwned', contribution.userOwned],
  ];
  for (const [cls, models] of lists) {
    if (models === undefined) continue;
    if (!Array.isArray(models)) {
      rejectApp(tier, `<${cls}>`, `\`${cls}\` must be an array of model names`);
      continue;
    }
    for (const raw of models as unknown[]) {
      const model = typeof raw === 'string' ? raw.trim() : '';
      if (model === '') {
        rejectApp(tier, String(raw), 'model is empty or not a string');
        continue;
      }
      if (CORE_CLASSIFIED.has(model)) {
        rejectApp(tier, model, 'core already classifies this model');
        continue;
      }
      if (clashedModels.has(model)) {
        rejectApp(tier, model, 'was listed in two classes; every entry for it is refused');
        continue;
      }
      const existing = appRegistrations.get(model);
      if (existing !== undefined && existing.tier !== tier) {
        rejectApp(tier, model, `already classified by tier '${existing.tier}'`);
        continue;
      }
      if (existing !== undefined && existing.cls !== cls) {
        rejectApp(tier, model, `listed as both '${existing.cls}' and '${cls}'`);
        appRegistrations.delete(model);
        clashedModels.add(model);
        continue;
      }
      appRegistrations.set(model, { cls, tier });
    }
  }
}

/**
 * Run the fork's classification init once, lazily, rolling a partial init
 * back — see `lib/fork-init.ts`.
 *
 * **A throwing init degrades rather than refusing.** A throw leaves every fork
 * model as core alone would see it: one with `orgId` tenant-owned (isolated —
 * the safe side), one without unclassified, which the coverage guard names.
 * Refusing would mean failing the Prisma client, which is built from
 * {@link classifyModels}, and every read in the app with it.
 */
const appInit = createAppInitGate({
  label: 'tenancy-classification: initAppTenancyClassification',
  subject: 'app tenancy classifications',
  init: initAppTenancyClassification,
  snapshot: () => ({ registrations: new Map(appRegistrations), clashed: new Set(clashedModels) }),
  restore: (before) => {
    restoreMap(appRegistrations, before.registrations);
    clashedModels.clear();
    for (const model of before.clashed) clashedModels.add(model);
  },
});

function appModelsIn(cls: AppTenancyClass): string[] {
  appInit.ensure();
  return [...appRegistrations].filter(([, r]) => r.cls === cls).map(([model]) => model);
}

/** Core's system models and every tier's. */
export function allSystemModels(): string[] {
  return [...SYSTEM_MODELS, ...appModelsIn('system')];
}

/** Core's shared-settings models and every tier's — what the shared-settings scanner covers. */
export function allGlobalConfigModels(): string[] {
  return [...GLOBAL_CONFIG_MODELS, ...appModelsIn('globalConfig')];
}

/** Core's user-owned models and every tier's. */
export function allUserOwnedModels(): string[] {
  return [...USER_OWNED_MODELS, ...appModelsIn('userOwned')];
}

/** Only the fork tiers' registrations, by model: the class and the tier that registered it. */
export function appTenancyClassifications(): ReadonlyMap<string, AppTenancyRegistration> {
  appInit.ensure();
  return new Map(appRegistrations);
}

let exemptionsWarned = false;

/**
 * Log, once per process, every fork system model that carries `orgId`: it is
 * left out of row isolation by that registration, and nothing else says so.
 */
export function warnAboutAppIsolationExemptions(classification: ModelClassification): void {
  if (exemptionsWarned) return;
  const exempt = classification.systemWithOrgId.filter((model) => !CORE_CLASSIFIED.has(model));
  if (exempt.length === 0) return;
  exemptionsWarned = true;
  logger.warn('tenancy-classification: fork system models carry orgId and are not row-isolated', {
    models: exempt,
    hint: 'Registered as system in lib/app/tenancy-classification.ts. Their rows are readable across orgs at TENANCY_MODE=multi. Intended for a join that decides the tenant, as OrgMembership is in core.',
  });
}

/** Test-only: clear the fork registry, re-arm the one-shot init and the warning. */
export function __resetAppTenancyClassificationForTests(): void {
  appRegistrations.clear();
  clashedModels.clear();
  appInit.reset();
  exemptionsWarned = false;
}
