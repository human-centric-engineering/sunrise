/**
 * Bring one org's platform agents in line with their code definitions (§116).
 *
 * Every org has its own instance of each platform agent
 * (`platform-agents.ts`). This is the one writer of those instances. It runs
 * when an org is created (`createOrg`), when an org's provider policy changes
 * (`PUT /admin/orgs/[id]/providers`, t-798), on `npm run db:seed`
 * (`prisma/seeds/021-platform-agents.ts`), and from the maintenance tick for
 * any org whose stored registry digest differs from the running code, or
 * whose platform-picked binding is no longer the pick
 * ({@link reconcilePlatformAgentsIfStale}).
 *
 * **The properties it holds** (`fp4`), each pinned by a unit test that fails
 * when the property is removed:
 *
 *  - **Idempotent.** An instance that already matches its definition is not
 *    written — no update, no version row, no `updatedAt` churn — and the
 *    org's marker is rewritten only when it changed.
 *  - **Safe on empty.** An empty registry creates nothing and deactivates
 *    nothing — not even what it placed before, since only a fault can empty
 *    it (a fork cannot remove a core agent).
 *  - **Upserts by `(orgId, slug)`**, inside the org's own scope, so every row
 *    it creates is stamped with that org and nothing else is visible to it.
 *  - **Code-owned fields are overwritten; org-tunable ones never are.** The
 *    split is the agent field registry's (`platformAgent`). Provider, model,
 *    spend, rate and retention are set once, when the instance is created —
 *    except a provider and model the definition picks (`defaultBinding`):
 *    while they are empty or still what the platform last placed (recorded
 *    in `Org.settings.platformAgentBindings`, in the same transaction as the
 *    write), they follow the pick, so they move when what the org can reach
 *    changes. Once the org sets them they are the org's (t-798).
 *  - **Bindings and knowledge grants are set to the declared set** — added,
 *    re-enabled or removed. Document grants are always empty. The one
 *    exception is a definition whose bindings are the org's
 *    (`capabilityBindings: 'org'`, `mcp-system`): its binding rows are left
 *    exactly as they are.
 *  - **A version row is written when a versioned field changes**, holding
 *    the post-change config: chat pins a conversation's provenance to the
 *    agent's latest version, so a silent rewrite would attribute new
 *    behaviour to an old version.
 *  - **The service account is the creator** of every instance and version
 *    row it writes — the platform, not whichever admin triggered the run.
 *  - **An agent dropped from the registry is deactivated, never deleted.**
 *    Conversations, cost rows and evaluations point at it. Only slugs this
 *    reconcile itself placed in the org (the marker's `slugs`, which keeps a
 *    retired agent for as long as its row exists) are candidates,
 *    so a fork's own seeded `isSystem` agent is never touched.
 *  - **It refuses to adopt an org's own agent.** A non-system row holding a
 *    platform slug is the org's; converting it would overwrite their prompt
 *    and lock them out of it. It is logged and skipped.
 *  - **Install-only agents go only into the install org**, and **at `single`
 *    only the install org is reconciled** — the one org there is.
 *  - **The patterns knowledge goes where its agents go** (t-726, t-733): an
 *    org gets its own copy only when one of its definitions declares the
 *    patterns tag, which in core means the install org (the Pattern Advisor
 *    and Quiz Master are install-only). It is written before the agents,
 *    since writing it creates that tag. A copy the org already holds is
 *    left alone. A failure there is logged and does not stop the agents; the
 *    marker then waits, so the next run tries again.
 *
 * Tenancy posture: runs inside `runAsOrg(orgId)`; writes nothing global.
 */
import { isDeepStrictEqual } from 'node:util';
import { Prisma } from '@prisma/client';

import { serviceAccountWhere } from '@/lib/auth/account';
import { prisma as defaultDb } from '@/lib/db/client';
import type { TenancyClient } from '@/lib/db/tenancy-extension';
import { logger as defaultLogger, type Logger } from '@/lib/logging';
import { buildChangeSummary } from '@/lib/orchestration/agent-version-diff';
import { getAgentField, snapshotFieldNames } from '@/lib/orchestration/agents/agent-field-registry';
import {
  INITIAL_VERSION_SUMMARY,
  asSnapshotJson,
  buildAgentSnapshot,
  nextAgentVersionNumber,
} from '@/lib/orchestration/agents/agent-versioning';
import {
  PLATFORM_AGENT_BASELINE,
  getPlatformAgent,
  platformAgentRegistryHash,
  platformAgentsForOrg,
  type PlatformAgentDefinition,
} from '@/lib/orchestration/agents/platform-agents';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { invalidateAgentAccess } from '@/lib/orchestration/knowledge/resolveAgentDocumentAccess';
import { PATTERNS_TAG_SLUG } from '@/lib/orchestration/knowledge/patterns-knowledge';
import {
  loadPatternsChunks,
  materialisePatternsKnowledge,
  type PatternsKnowledgeOutcome,
} from '@/lib/orchestration/knowledge/seeder';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { isMultiTenant, runAsOrg } from '@/lib/tenancy/context';
import { forgetOrgProviderPolicy } from '@/lib/orchestration/llm/org-provider-policy';
import {
  isSettingsWriteConflict,
  loadPlatformAgentsState,
  recordPlatformAgentBinding,
  writePlatformAgentsMarker,
  type PlatformAgentBindings,
} from '@/lib/tenancy/org-settings';

/** Why an org's own row was left alone. */
export type PlatformAgentRefusal =
  /** A non-system agent of the org's holds the slug. */
  | 'tenant-agent'
  /** A system agent holding the slug was soft-deleted. */
  | 'deleted';

export interface PlatformAgentReconcileResult {
  orgId: string;
  /** Set when the org was not reconciled at all. */
  skipped?: 'single-tenant-non-install-org';
  created: string[];
  updated: string[];
  unchanged: string[];
  deactivated: string[];
  refused: Array<{ slug: string; reason: PlatformAgentRefusal }>;
  /** Declared capability or tag slugs with no row yet — skipped, not fatal. */
  missing: { capabilities: string[]; knowledgeTags: string[] };
  /**
   * How the org's copy of the patterns knowledge stood; `'failed'` when it
   * could not be written. Absent when no agent of the org's declares its tag.
   */
  knowledge?: PatternsKnowledgeOutcome | 'failed';
}

export interface ReconcileOptions {
  /** The client to write through. The seed passes its own (owner DSN). */
  db?: TenancyClient;
  log?: Logger;
}

type ExistingAgent = Prisma.AiAgentGetPayload<{
  include: {
    capabilities: { select: { id: true; capabilityId: true; isEnabled: true } };
    grantedTags: { select: { tagId: true } };
    grantedDocuments: { select: { documentId: true } };
  };
}>;

/** A provider and model as an agent row stores them; `''`/`''` is "inherit". */
type Binding = { provider: string; model: string };

const INHERIT: Binding = { provider: '', model: '' };

function sameBinding(a: Binding, b: Binding): boolean {
  return a.provider === b.provider && a.model === b.model;
}

/**
 * Whether the platform still owns an agent's provider and model (t-798): it is
 * empty, or still what the platform last placed (`recorded`).
 * Anything else was chosen by the org, and is never touched again — unless the
 * org sets it back to empty, which hands it back.
 */
function platformOwnsBinding(current: Binding, recorded: Binding | undefined): boolean {
  return (
    sameBinding(current, INHERIT) || (recorded !== undefined && sameBinding(current, recorded))
  );
}

/**
 * What one run does with an agent's provider and model, and with its record of
 * them: follow the pick while the platform owns the binding, or drop a record
 * the org's own choice has made stale — so that, should the org later set the
 * platform's old pick again, that choice stays theirs.
 */
type BindingPlan =
  { follow: Binding; recorded: Binding | undefined } | { release: true } | undefined;

/**
 * The record write that leaves `recorded` describing `placed`: an entry for a
 * pinned binding, none for "inherit". `undefined` when it already does.
 */
function recordUpdate(recorded: Binding | undefined, placed: Binding): Binding | null | undefined {
  if (sameBinding(placed, INHERIT)) return recorded === undefined ? undefined : null;
  return recorded !== undefined && sameBinding(recorded, placed) ? undefined : placed;
}

/** Thrown inside an agent's transaction when its binding changed after it was read. */
class BindingChangedConcurrently extends Error {}

/** What the platform would place now: the definition's pick, or "inherit" when nothing qualifies. */
async function desiredBinding(
  definition: PlatformAgentDefinition,
  db: TenancyClient
): Promise<Binding | undefined> {
  if (!definition.defaultBinding) return undefined;
  return (await definition.defaultBinding(db)) ?? INHERIT;
}

/** Every code-owned value for one definition: the baseline, overlaid by it. */
function codeOwnedValues(definition: PlatformAgentDefinition): Record<string, unknown> {
  return { ...PLATFORM_AGENT_BASELINE, ...definition.agent };
}

/** A JSON column takes `Prisma.JsonNull`, not `null`, to store SQL-null JSON. */
function toWriteValue(field: string, value: unknown): unknown {
  return value === null && getAgentField(field)?.json ? Prisma.JsonNull : value;
}

function writeData(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([field, value]) => [field, toWriteValue(field, value)])
  );
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * A write another run or request got to first: a unique-key race, a
 * SERIALIZABLE clash on the binding record, or a binding an admin changed
 * after this run read it. Each rolled its agent's transaction back whole.
 */
function isConcurrentWrite(err: unknown): boolean {
  return (
    isUniqueViolation(err) ||
    isSettingsWriteConflict(err) ||
    err instanceof BindingChangedConcurrently
  );
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  return left.size === new Set(b).size && b.every((x) => left.has(x));
}

/**
 * Reconcile every platform agent in one org. Enters the org's scope itself, so
 * a caller cannot run it as the wrong org.
 *
 * Throws on a database failure part-way; what it wrote before that stands
 * (each agent is its own transaction) and the marker is not updated, so the
 * next maintenance tick runs it again from the start.
 */
export async function reconcilePlatformAgents(
  orgId: string,
  options: ReconcileOptions = {}
): Promise<PlatformAgentReconcileResult> {
  const db = options.db ?? defaultDb;
  const log = options.log ?? defaultLogger;
  const result: PlatformAgentReconcileResult = {
    orgId,
    created: [],
    updated: [],
    unchanged: [],
    deactivated: [],
    refused: [],
    missing: { capabilities: [], knowledgeTags: [] },
  };

  if (!isMultiTenant() && orgId !== INSTALL_ORG_ID) {
    return { ...result, skipped: 'single-tenant-non-install-org' };
  }

  return runAsOrg(orgId, async () => {
    const definitions = platformAgentsForOrg(orgId);
    const hash = platformAgentRegistryHash();
    const state = await loadPlatformAgentsState(orgId, db);
    const previous = state?.marker ?? null;
    const recordedBindings: PlatformAgentBindings = state?.bindings ?? {};

    const owner = await db.user.findFirst({ where: serviceAccountWhere, select: { id: true } });
    if (!owner) {
      throw new Error('No service account found — ensure 001-system-owner has run.');
    }

    // First: writing the copy creates the tag the knowledge agents declare,
    // so a new org's grants land on this run rather than the next. Only where
    // an agent of this org's declares it: the knowledge serves those agents.
    if (definitions.some((d) => d.knowledgeTags.includes(PATTERNS_TAG_SLUG))) {
      result.knowledge = await reconcilePatternsKnowledge(db, log, orgId);
    }

    const wanted = new Set(definitions.map((d) => d.slug));
    const placedBefore = previous?.slugs ?? [];
    const rows = await db.aiAgent.findMany({
      where: { orgId, slug: { in: [...new Set([...wanted, ...placedBefore])] } },
      include: {
        capabilities: { select: { id: true, capabilityId: true, isEnabled: true } },
        grantedTags: { select: { tagId: true } },
        grantedDocuments: { select: { documentId: true } },
      },
    });
    const bySlug = new Map(rows.map((row) => [row.slug, row]));

    const capabilitySlugs = [...new Set(definitions.flatMap((d) => d.capabilities))];
    const tagSlugs = [...new Set(definitions.flatMap((d) => d.knowledgeTags))];
    const [capabilities, tags] = await Promise.all([
      capabilitySlugs.length > 0
        ? db.aiCapability.findMany({
            where: { slug: { in: capabilitySlugs } },
            select: { id: true, slug: true },
          })
        : Promise.resolve([]),
      tagSlugs.length > 0
        ? db.knowledgeTag.findMany({
            where: { slug: { in: tagSlugs } },
            select: { id: true, slug: true },
          })
        : Promise.resolve([]),
    ]);
    const capabilityIds = new Map(capabilities.map((c) => [c.slug, c.id]));
    const tagIds = new Map(tags.map((t) => [t.slug, t.id]));
    result.missing.capabilities = capabilitySlugs.filter((s) => !capabilityIds.has(s));
    result.missing.knowledgeTags = tagSlugs.filter((s) => !tagIds.has(s));
    if (result.missing.capabilities.length > 0 || result.missing.knowledgeTags.length > 0) {
      log.warn('Platform agents declare capabilities or tags that have no row yet — skipped', {
        orgId,
        ...result.missing,
      });
    }

    const placed: string[] = [];
    let bindingsChanged = false;
    /** False when a concurrent run got there first: leave the marker, so the next run records it. */
    let complete = true;

    for (const definition of definitions) {
      const existing = bySlug.get(definition.slug);
      const desiredCapabilityIds = definition.capabilities
        .map((slug) => capabilityIds.get(slug))
        .filter((id): id is string => id !== undefined);
      const desiredTagIds = definition.knowledgeTags
        .map((slug) => tagIds.get(slug))
        .filter((id): id is string => id !== undefined);

      if (existing && !existing.isSystem) {
        log.warn('Platform agent slug is held by an org’s own agent — left alone', {
          orgId,
          slug: definition.slug,
          agentId: existing.id,
        });
        result.refused.push({ slug: definition.slug, reason: 'tenant-agent' });
        continue;
      }
      if (existing && existing.deletedAt !== null) {
        log.warn('Platform agent was soft-deleted in this org — left alone', {
          orgId,
          slug: definition.slug,
          agentId: existing.id,
        });
        result.refused.push({ slug: definition.slug, reason: 'deleted' });
        continue;
      }

      // The pick is asked only where its answer is used — a new instance, or
      // a binding the platform still owns — and before any write for that
      // agent: a policy that cannot be read throws here, and the run is
      // retried. An org that chose its own provider never depends on it.
      const recorded = recordedBindings[definition.slug];
      const owned = !existing || platformOwnsBinding(existing, recorded);
      const pick =
        definition.defaultBinding && owned ? await desiredBinding(definition, db) : undefined;

      if (!existing) {
        try {
          await createInstance(db, orgId, definition, pick && { follow: pick, recorded }, {
            ownerId: owner.id,
            capabilityIds: desiredCapabilityIds,
            tagIds: desiredTagIds,
          });
        } catch (err) {
          // Two reconciles of one org at once — the seed beside the job, or
          // two instances each serving a tick — both find the agent missing,
          // and the second create meets the per-org slug key. The row exists
          // either way; the next run reconciles whatever it holds, or refuses
          // it if an org's own agent took the slug in between — and the
          // marker is not written, so that next run happens.
          if (!isConcurrentWrite(err)) throw err;
          complete = false;
          log.info('Platform agent created concurrently — left to the next run', {
            orgId,
            slug: definition.slug,
          });
          result.unchanged.push(definition.slug);
          continue;
        }
        placed.push(definition.slug);
        bindingsChanged ||= desiredCapabilityIds.length > 0;
        result.created.push(definition.slug);
        continue;
      }

      placed.push(definition.slug);

      let outcome: Awaited<ReturnType<typeof updateInstance>>;
      try {
        outcome = await updateInstance(
          db,
          orgId,
          definition,
          existing,
          pick
            ? { follow: pick, recorded }
            : recorded !== undefined && !owned
              ? { release: true }
              : undefined,
          { ownerId: owner.id, capabilityIds: desiredCapabilityIds, tagIds: desiredTagIds }
        );
      } catch (err) {
        // The same race on an existing agent: two runs number the same
        // version, and the second insert meets `(agentId, version)`. Its
        // whole transaction rolled back; the winner wrote the same change.
        // Or an admin set the binding after this run read it: theirs stands,
        // and the next run sees it as theirs.
        if (!isConcurrentWrite(err)) throw err;
        complete = false;
        log.info('Platform agent updated concurrently — left to the next run', {
          orgId,
          slug: definition.slug,
        });
        result.unchanged.push(definition.slug);
        continue;
      }
      bindingsChanged ||= outcome.bindingsChanged;
      if (outcome.accessChanged) invalidateAgentAccess(existing.id);
      (outcome.changed ? result.updated : result.unchanged).push(definition.slug);
    }

    // An empty registry beside a non-empty marker is a fault, not a removal:
    // a fork can add or replace a platform agent but not remove one, so the
    // list can only come back empty from a broken import. Deactivating on it
    // would switch off every platform agent in every org at once.
    if (definitions.length === 0 && placedBefore.length > 0) {
      log.error('Platform agent registry resolved empty — nothing deactivated, marker kept', {
        orgId,
        placedBefore,
      });
      return result;
    }

    // Deactivate what this reconcile placed before and the registry no longer
    // has. Only `placedBefore`: an `isSystem` agent it never placed — a fork's
    // own seeded one — is not its to switch off. A retired agent stays in the
    // marker while its row does: it is still `isSystem`, so the org cannot
    // delete it or switch it off itself, and dropping it from the marker would
    // leave nobody able to — every later reconcile switches it off again.
    const retired: string[] = [];
    for (const slug of placedBefore) {
      if (wanted.has(slug)) continue;
      const row = bySlug.get(slug);
      if (!row || !row.isSystem || row.deletedAt !== null) continue;
      retired.push(slug);
      if (!row.isActive) continue;
      // Removed from the registry, or still in it and install-only now (the
      // one other way out of `wanted`; t-733's pair): the version row says which.
      const summary = getPlatformAgent(slug)
        ? 'Now the install org’s only, so switched off here'
        : 'Removed from the platform agent registry';
      try {
        await deactivateInstance(db, row, owner.id, summary);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        complete = false;
        log.info('Platform agent deactivated concurrently — left to the next run', { orgId, slug });
        continue;
      }
      result.deactivated.push(slug);
    }

    if (bindingsChanged) capabilityDispatcher.clearCache();

    const marker = { hash, slugs: [...placed, ...retired].sort() };
    const markerChanged =
      !previous || previous.hash !== marker.hash || !sameSet(previous.slugs, marker.slugs);
    // A declared capability or tag with no row yet leaves the org short of its
    // definition. Recording the current digest would stop the job from ever
    // coming back for it, so the marker waits until nothing is missing.
    const nothingMissing =
      result.missing.capabilities.length === 0 &&
      result.missing.knowledgeTags.length === 0 &&
      result.knowledge !== 'failed';
    if (complete && nothingMissing && markerChanged) {
      await writePlatformAgentsMarker(orgId, marker, db);
    }

    if (
      result.created.length + result.updated.length + result.deactivated.length > 0 ||
      result.refused.length > 0 ||
      result.knowledge === 'created'
    ) {
      log.info('Platform agents reconciled', {
        orgId,
        knowledge: result.knowledge,
        created: result.created,
        updated: result.updated,
        deactivated: result.deactivated,
        refused: result.refused,
      });
    }
    return result;
  });
}

/**
 * Reconcile the org if it is behind: its stored digest differs from the
 * running registry's, or an agent's binding is not where the platform would
 * put it now ({@link platformBindingsDrifted}). The maintenance job's entry
 * point. When nothing changed it costs one `Org` read, plus, for an org with
 * an agent that picks its own binding, the agents' bindings, the org's
 * provider policy and the pick's provider and model reads.
 *
 * The org's cached provider policy is dropped first. This process may have
 * cached it before a grant or revocation served by another instance, and a
 * pick made from it would put a binding back where the org can no longer go.
 */
export async function reconcilePlatformAgentsIfStale(
  orgId: string,
  options: ReconcileOptions = {}
): Promise<{ reconciled: boolean; result?: PlatformAgentReconcileResult }> {
  if (!isMultiTenant() && orgId !== INSTALL_ORG_ID) return { reconciled: false };
  const db = options.db ?? defaultDb;
  forgetOrgProviderPolicy(orgId);
  const state = await loadPlatformAgentsState(orgId, db);
  if (
    state?.marker?.hash === platformAgentRegistryHash() &&
    !(await platformBindingsDrifted(orgId, state.bindings, db))
  ) {
    return { reconciled: false };
  }
  return { reconciled: true, result: await reconcilePlatformAgents(orgId, options) };
}

/**
 * Whether any agent whose provider and model the platform owns is not on what
 * the platform would pick now (t-798). What the org can reach changes without
 * the registry changing: a provider granted or revoked, switched on or off, its
 * credential set, a tool-using model added, a fork's eligibility rule. None of
 * those has one write a hook could catch — an env var or a fork's resolver
 * has none at all — so the job asks the question itself, every pass.
 *
 * An agent the org has set is the org's, and its pick is not asked; it counts
 * as drift only while a record of the platform's old pick remains, so a run
 * drops it. A missing or refused agent is left to the digest check. Throws
 * when the pick cannot read the org's policy, so the job logs the org and
 * asks again next pass.
 */
async function platformBindingsDrifted(
  orgId: string,
  recordedBindings: PlatformAgentBindings,
  db: TenancyClient
): Promise<boolean> {
  const definitions = platformAgentsForOrg(orgId).filter((d) => d.defaultBinding);
  if (definitions.length === 0) return false;
  return runAsOrg(orgId, async () => {
    const rows = await db.aiAgent.findMany({
      where: {
        orgId,
        slug: { in: definitions.map((d) => d.slug) },
        isSystem: true,
        deletedAt: null,
      },
      select: { slug: true, provider: true, model: true },
    });
    for (const definition of definitions) {
      const row = rows.find((r) => r.slug === definition.slug);
      if (!row) continue;
      const recorded = recordedBindings[definition.slug];
      if (!platformOwnsBinding(row, recorded)) {
        if (recorded !== undefined) return true;
        continue;
      }
      const desired = await desiredBinding(definition, db);
      if (
        desired &&
        (!sameBinding(row, desired) || recordUpdate(recorded, desired) !== undefined)
      ) {
        return true;
      }
    }
    return false;
  });
}

/**
 * Reconcile the org now, for a request that just changed what its agents can
 * use (a provider grant), and never throw. The maintenance job is what
 * guarantees the result: anything this misses — a failure, or a suspended org,
 * which only the job reconciles once it is reinstated — it catches up, since a
 * binding the platform owns that is not on its pick makes the org stale. This
 * only saves the wait for the next pass.
 */
export async function tryReconcilePlatformAgents(orgId: string, trigger: string): Promise<void> {
  try {
    const org = await defaultDb.org.findUnique({ where: { id: orgId }, select: { status: true } });
    if (!org || org.status === 'SUSPENDED') return;
    await reconcilePlatformAgents(orgId);
  } catch (err) {
    defaultLogger.error('Platform agents not reconciled; the maintenance job catches up', {
      orgId,
      trigger,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Write the org's copy of the patterns knowledge if it has none. Never throws:
 * the agents matter more than the knowledge (the judges, the clean-up
 * assistant), so they are reconciled either way, and `'failed'` holds the
 * marker back for the next run.
 */
async function reconcilePatternsKnowledge(
  db: TenancyClient,
  log: Logger,
  orgId: string
): Promise<PatternsKnowledgeOutcome | 'failed'> {
  try {
    const { outcome } = await materialisePatternsKnowledge(await loadPatternsChunks(), { db, log });
    return outcome;
  } catch (err) {
    // A race to write the copy comes back as 'present'; anything thrown is a
    // failure that would repeat, so it is an error.
    log.error('Patterns knowledge not written — the next run retries', {
      orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'failed';
  }
}

interface DesiredSets {
  ownerId: string;
  capabilityIds: string[];
  tagIds: string[];
}

/**
 * The isolation an agent's transaction runs at: SERIALIZABLE when it also
 * writes the binding record, so that read-modify-write of `Org.settings`
 * cannot lose a concurrent write of another slice.
 */
function isolationFor(record: Binding | null | undefined) {
  return record === undefined
    ? undefined
    : { isolationLevel: Prisma.TransactionIsolationLevel.Serializable };
}

async function createInstance(
  db: TenancyClient,
  orgId: string,
  definition: PlatformAgentDefinition,
  plan: { follow: Binding; recorded: Binding | undefined } | undefined,
  desired: DesiredSets
): Promise<void> {
  const starting = { provider: '', model: '', ...definition.defaults };
  // A definition that sets its own default binding owns it outright.
  const placedBinding = plan && sameBinding(starting, INHERIT) ? plan.follow : undefined;
  if (placedBinding) Object.assign(starting, placedBinding);
  const record = placedBinding && recordUpdate(plan?.recorded, placedBinding);

  await db.$transaction(async (tx) => {
    const created = await tx.aiAgent.create({
      data: {
        ...(writeData(codeOwnedValues(definition)) as Omit<
          Prisma.AiAgentUncheckedCreateInput,
          'slug' | 'provider' | 'model'
        >),
        ...starting,
        slug: definition.slug,
        isSystem: true,
        createdBy: desired.ownerId,
      },
    });
    if (desired.capabilityIds.length > 0) {
      await tx.aiAgentCapability.createMany({
        data: desired.capabilityIds.map((capabilityId) => ({
          agentId: created.id,
          capabilityId,
          isEnabled: true,
        })),
      });
    }
    if (desired.tagIds.length > 0) {
      await tx.aiAgentKnowledgeTag.createMany({
        data: desired.tagIds.map((tagId) => ({ agentId: created.id, tagId })),
      });
    }
    await tx.aiAgentVersion.create({
      data: {
        agentId: created.id,
        version: 1,
        snapshot: asSnapshotJson(
          buildAgentSnapshot(created, { grantedTagIds: desired.tagIds, grantedDocumentIds: [] })
        ),
        changeSummary: INITIAL_VERSION_SUMMARY,
        createdBy: desired.ownerId,
      },
    });
    if (record !== undefined) {
      await recordPlatformAgentBinding(tx, orgId, definition.slug, record);
    }
  }, isolationFor(record));
}

/**
 * `plan` (see {@link BindingPlan}) says what happens to the binding: while the
 * platform owns it, it is moved to the pick — onto a model newly reachable,
 * off a provider the org lost, or back to "inherit" when nothing qualifies —
 * and the record moves with it, in the same transaction.
 */
async function updateInstance(
  db: TenancyClient,
  orgId: string,
  definition: PlatformAgentDefinition,
  existing: ExistingAgent,
  plan: BindingPlan,
  desired: DesiredSets
): Promise<{ changed: boolean; bindingsChanged: boolean; accessChanged: boolean }> {
  const current: Record<string, unknown> = existing;
  const changes: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(codeOwnedValues(definition))) {
    if (!isDeepStrictEqual(current[field], value)) changes[field] = value;
  }
  const moveBinding = plan && 'follow' in plan && !sameBinding(existing, plan.follow);
  if (moveBinding) Object.assign(changes, plan.follow);
  const record = !plan
    ? undefined
    : 'release' in plan
      ? null
      : recordUpdate(plan.recorded, plan.follow);

  const currentTagIds = existing.grantedTags.map((g) => g.tagId);
  const currentDocumentIds = existing.grantedDocuments.map((g) => g.documentId);
  const tagsChanged = !sameSet(currentTagIds, desired.tagIds);
  const documentsChanged = currentDocumentIds.length > 0;

  // Bindings the org owns are not this reconcile's to diff (see
  // `capabilityBindings` on the definition).
  const bindingsOwned = definition.capabilityBindings !== 'org';
  const bindings = bindingsOwned ? existing.capabilities : [];
  const wantedCapabilities = new Set(desired.capabilityIds);
  const staleBindingIds = bindings
    .filter((b) => !wantedCapabilities.has(b.capabilityId))
    .map((b) => b.id);
  const disabledBindingIds = bindings
    .filter((b) => wantedCapabilities.has(b.capabilityId) && !b.isEnabled)
    .map((b) => b.id);
  const bound = new Set(bindings.map((b) => b.capabilityId));
  const missingCapabilityIds = bindingsOwned
    ? desired.capabilityIds.filter((id) => !bound.has(id))
    : [];
  const bindingsChanged =
    staleBindingIds.length > 0 || disabledBindingIds.length > 0 || missingCapabilityIds.length > 0;

  const changedFields = Object.keys(changes);
  const versionedChanges = [
    ...changedFields.filter((f) => snapshotFieldNames().includes(f)),
    ...(tagsChanged ? ['grantedTagIds'] : []),
    ...(documentsChanged ? ['grantedDocumentIds'] : []),
  ];

  const changed = changedFields.length > 0 || tagsChanged || documentsChanged || bindingsChanged;
  if (!changed && record === undefined) {
    return { changed: false, bindingsChanged: false, accessChanged: false };
  }

  await db.$transaction(async (tx) => {
    // Numbered first, as the PATCH route does: a legacy agent with no history
    // gets its PRE-change config kept as v1, so the original is not lost.
    let postVersion = 0;
    if (versionedChanges.length > 0) {
      const first = await nextAgentVersionNumber(tx, existing.id);
      if (first === 1) {
        await tx.aiAgentVersion.create({
          data: {
            agentId: existing.id,
            version: 1,
            snapshot: asSnapshotJson(
              buildAgentSnapshot(current, {
                grantedTagIds: currentTagIds,
                grantedDocumentIds: currentDocumentIds,
              })
            ),
            changeSummary: INITIAL_VERSION_SUMMARY,
            createdBy: desired.ownerId,
          },
        });
        postVersion = 2;
      } else {
        postVersion = first;
      }
    }

    if (staleBindingIds.length > 0) {
      await tx.aiAgentCapability.deleteMany({ where: { id: { in: staleBindingIds } } });
    }
    if (disabledBindingIds.length > 0) {
      await tx.aiAgentCapability.updateMany({
        where: { id: { in: disabledBindingIds } },
        data: { isEnabled: true },
      });
    }
    if (missingCapabilityIds.length > 0) {
      await tx.aiAgentCapability.createMany({
        data: missingCapabilityIds.map((capabilityId) => ({
          agentId: existing.id,
          capabilityId,
          isEnabled: true,
        })),
      });
    }
    if (tagsChanged) {
      await tx.aiAgentKnowledgeTag.deleteMany({ where: { agentId: existing.id } });
      if (desired.tagIds.length > 0) {
        await tx.aiAgentKnowledgeTag.createMany({
          data: desired.tagIds.map((tagId) => ({ agentId: existing.id, tagId })),
        });
      }
    }
    if (documentsChanged) {
      await tx.aiAgentKnowledgeDocument.deleteMany({ where: { agentId: existing.id } });
    }

    let updated: Prisma.AiAgentGetPayload<object> = existing;
    if (moveBinding) {
      // Only while the binding is still what this run read: an admin's choice
      // saved since then is theirs, and nothing of this run's is written.
      const { count } = await tx.aiAgent.updateMany({
        where: { id: existing.id, provider: existing.provider, model: existing.model },
        data: writeData(changes),
      });
      if (count === 0) throw new BindingChangedConcurrently();
      updated = await tx.aiAgent.findUniqueOrThrow({ where: { id: existing.id } });
    } else if (changedFields.length > 0) {
      updated = await tx.aiAgent.update({ where: { id: existing.id }, data: writeData(changes) });
    }
    if (record !== undefined) {
      await recordPlatformAgentBinding(tx, orgId, definition.slug, record);
    }

    if (versionedChanges.length > 0) {
      await tx.aiAgentVersion.create({
        data: {
          agentId: existing.id,
          version: postVersion,
          snapshot: asSnapshotJson(
            buildAgentSnapshot(updated, { grantedTagIds: desired.tagIds, grantedDocumentIds: [] })
          ),
          changeSummary: `Platform definition: ${buildChangeSummary(versionedChanges)}`,
          createdBy: desired.ownerId,
        },
      });
    }
  }, isolationFor(record));

  return {
    changed,
    bindingsChanged,
    accessChanged: tagsChanged || documentsChanged || 'knowledgeAccessMode' in changes,
  };
}

async function deactivateInstance(
  db: TenancyClient,
  row: ExistingAgent,
  ownerId: string,
  changeSummary: string
): Promise<void> {
  const grants = {
    grantedTagIds: row.grantedTags.map((g) => g.tagId),
    grantedDocumentIds: row.grantedDocuments.map((g) => g.documentId),
  };
  await db.$transaction(async (tx) => {
    // As in `updateInstance`: an agent with no history keeps its active,
    // pre-removal config as v1, so a restore can still bring it back.
    let version = await nextAgentVersionNumber(tx, row.id);
    if (version === 1) {
      await tx.aiAgentVersion.create({
        data: {
          agentId: row.id,
          version: 1,
          snapshot: asSnapshotJson(buildAgentSnapshot(row, grants)),
          changeSummary: INITIAL_VERSION_SUMMARY,
          createdBy: ownerId,
        },
      });
      version = 2;
    }
    const updated = await tx.aiAgent.update({ where: { id: row.id }, data: { isActive: false } });
    await tx.aiAgentVersion.create({
      data: {
        agentId: row.id,
        version,
        snapshot: asSnapshotJson(buildAgentSnapshot(updated, grants)),
        changeSummary,
        createdBy: ownerId,
      },
    });
  });
}
