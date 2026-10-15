/**
 * Bring one org's platform agents in line with their code definitions (§116).
 *
 * Every org has its own instance of each platform agent
 * (`platform-agents.ts`). This is the one writer of those instances. It runs
 * when an org is created (`createOrg`), when an org's provider policy changes
 * (`PUT /admin/orgs/[id]/providers`, t-798), when an admin hands a binding
 * back to the platform (`PATCH /agents/:id`, t-798), on `npm run db:seed`
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
 *    while the row's `bindingOwner` is `'platform'` they follow the pick, so
 *    they move when what the org can reach changes. An admin write to either
 *    makes them the org's, and they are never moved again (t-798; see
 *    `binding-owner.ts`, {@link bindingTarget} and {@link classifyBindingOwner}).
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
import { z } from 'zod';

import { serviceAccountWhere } from '@/lib/auth/account';
import { prisma as defaultDb } from '@/lib/db/client';
import type { TenancyClient } from '@/lib/db/tenancy-extension';
import { logger as defaultLogger, type Logger } from '@/lib/logging';
import { buildChangeSummary } from '@/lib/orchestration/agent-version-diff';
import type { BindingOwner } from '@/lib/orchestration/agents/binding-owner';
import { getAgentField, snapshotFieldNames } from '@/lib/orchestration/agents/agent-field-registry';
import {
  INITIAL_VERSION_SUMMARY,
  asSnapshotJson,
  buildAgentSnapshot,
  nextAgentVersionNumber,
} from '@/lib/orchestration/agents/agent-versioning';
import {
  PLATFORM_AGENT_BASELINE,
  definitionPicksBinding,
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
  loadPlatformAgentsMarker,
  writePlatformAgentsMarker,
  type PlatformAgentsMarker,
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

/** A stored `bindingOwner`, or `null` for one nobody has classified (any other value too). */
function storedOwner(value: string | null): BindingOwner | null {
  return value === 'platform' || value === 'org' ? value : null;
}

/**
 * The definition's pick, or "inherit" when nothing qualifies (t-798): where a
 * binding the platform owns goes. The one rule both the reconcile and the
 * job's drift check apply, so the two cannot disagree. Only for a definition
 * that has a `defaultBinding`.
 */
async function askPick(definition: PlatformAgentDefinition, db: TenancyClient): Promise<Binding> {
  return (await definition.defaultBinding?.(db)) ?? INHERIT;
}

/** A pick the run could not get (the org's policy unreadable, say). */
const PICK_UNAVAILABLE = 'unavailable';

type Pick = Binding | typeof PICK_UNAVAILABLE;

/**
 * One agent's pick for one run: asked only when something needs it, and at
 * most once. A pick that throws is reported to `onUnavailable` and answers
 * {@link PICK_UNAVAILABLE}: that agent's binding is left as it is, and the
 * caller holds the marker back so the job asks again next pass, while every
 * other agent in the org is still reconciled.
 */
function lazyPick(
  definition: PlatformAgentDefinition,
  db: TenancyClient,
  onUnavailable: (error: unknown) => void
): () => Promise<Pick> {
  let answer: Promise<Pick> | undefined;
  return () =>
    (answer ??= askPick(definition, db).catch((error: unknown) => {
      onUnavailable(error);
      return PICK_UNAVAILABLE;
    }));
}

/**
 * Who owns the binding of a platform agent nobody has classified yet — one
 * from before t-798 (`bindingOwner` null). Decided once, by the reconcile,
 * with the same answer {@link createInstance} gives a new agent where it can:
 *
 *  - a definition with its own starting binding: the org's;
 *  - "inherit", or the platform's pick today: the platform's, since that is
 *    what it would have placed;
 *  - otherwise, whoever wrote the binding the row holds: the author of the
 *    version where it took that value ({@link bindingAuthor}). The service
 *    account's means the platform pinned it, and it moves (off a provider
 *    since revoked, say); anyone else's — or no history to tell — means the
 *    org's, since moving an admin's choice is worse than leaving a pin the
 *    platform placed.
 *
 * `null` — still unclassified — when the pick is unavailable and the history
 * alone cannot say it is the platform's; the next run asks again.
 */
async function classifyBindingOwner(
  definition: PlatformAgentDefinition,
  row: Binding & { id: string; createdAt: Date },
  pick: () => Promise<Pick>,
  db: TenancyClient,
  serviceAccountId: string
): Promise<BindingOwner | null> {
  if (!definitionPicksBinding(definition)) return 'org';
  if (sameBinding(row, INHERIT)) return 'platform';
  const today = await pick();
  if (today !== PICK_UNAVAILABLE && sameBinding(row, today)) return 'platform';
  if ((await bindingAuthor(db, row)) === serviceAccountId) return 'platform';
  return today === PICK_UNAVAILABLE ? null : 'org';
}

const snapshotBindingSchema = z.object({ provider: z.string(), model: z.string() });

/** How long after an agent's creation its first version still records who created it. */
const CREATED_WITH_AGENT_MS = 60_000;

/**
 * Who wrote the version where `row`'s current binding began, from its
 * history; `null` if that cannot be told. A first version written well after
 * the agent was created is a backfill — a later writer saving the PRE-change
 * state of an agent that had no history (the reconcile and the PATCH route
 * both do) — so its author is who backfilled it, not who chose the binding,
 * and it counts as unknown. So does a binding the newest version does not
 * hold: it was written without one.
 */
async function bindingAuthor(
  db: TenancyClient,
  row: Binding & { id: string; createdAt: Date }
): Promise<string | null> {
  const versions = await db.aiAgentVersion.findMany({
    where: { agentId: row.id },
    orderBy: { version: 'asc' },
    select: { snapshot: true, createdBy: true, changeSummary: true, createdAt: true },
  });
  let author: string | null = null;
  let held = false;
  for (const version of versions) {
    const parsed = snapshotBindingSchema.safeParse(version.snapshot);
    const holds = parsed.success && sameBinding(parsed.data, row);
    const backfill =
      version.changeSummary === INITIAL_VERSION_SUMMARY &&
      version.createdAt.getTime() - row.createdAt.getTime() > CREATED_WITH_AGENT_MS;
    if (holds && !held) author = backfill ? null : version.createdBy;
    if (!holds) author = null;
    held = holds;
  }
  return author;
}

/** Thrown inside an agent's transaction when its binding changed after it was read. */
class BindingChangedConcurrently extends Error {}

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
 * A write another run or request got to first: a unique-key race, or a
 * binding an admin changed after this run read it. Either rolled its agent's
 * transaction back whole.
 */
function isConcurrentWrite(err: unknown): boolean {
  return isUniqueViolation(err) || err instanceof BindingChangedConcurrently;
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
    const previous = await loadPlatformAgentsMarker(orgId, db);

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

      // Asked before any write for this agent, and only if needed.
      const pick = lazyPick(definition, db, (error) => {
        complete = false;
        log.warn('Platform agent binding pick unavailable — binding left as it is', {
          orgId,
          slug: definition.slug,
          error: error instanceof Error ? error.message : String(error),
        });
      });

      if (!existing) {
        const ownerOfBinding = definition.defaultBinding
          ? definitionPicksBinding(definition)
            ? ('platform' as const)
            : ('org' as const)
          : null;
        const picked = ownerOfBinding === 'platform' ? await pick() : undefined;
        try {
          await createInstance(
            db,
            definition,
            {
              owner: ownerOfBinding,
              target: picked === PICK_UNAVAILABLE ? undefined : picked,
            },
            {
              ownerId: owner.id,
              capabilityIds: desiredCapabilityIds,
              tagIds: desiredTagIds,
            }
          );
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

      const bindingOwner =
        storedOwner(existing.bindingOwner) ??
        (definition.defaultBinding
          ? await classifyBindingOwner(definition, existing, pick, db, owner.id)
          : null);
      const picked = bindingOwner === 'platform' ? await pick() : undefined;
      const plan = {
        owner: bindingOwner,
        target: picked === PICK_UNAVAILABLE ? undefined : picked,
      };
      let outcome: Awaited<ReturnType<typeof updateInstance>>;
      try {
        outcome = await updateInstance(db, definition, existing, plan, {
          ownerId: owner.id,
          capabilityIds: desiredCapabilityIds,
          tagIds: desiredTagIds,
        });
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

    const marker: PlatformAgentsMarker = { hash, slugs: [...placed, ...retired].sort() };
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
 * For an org whose agents pick a binding, its cached provider policy is
 * dropped first: this process may have cached it before a grant or revocation
 * served by another instance, and a pick made from it would put a binding
 * back where the org can no longer go. The provider rows the policy judges
 * (their jurisdiction) are left to their 60-second cache — clearing that
 * process-wide cache once per org per pass would cost every chat call a
 * re-read — so a jurisdiction change served elsewhere is seen within a
 * minute, and a pick made in that minute is corrected next pass.
 */
export async function reconcilePlatformAgentsIfStale(
  orgId: string,
  options: ReconcileOptions = {}
): Promise<{ reconciled: boolean; result?: PlatformAgentReconcileResult }> {
  if (!isMultiTenant() && orgId !== INSTALL_ORG_ID) return { reconciled: false };
  const db = options.db ?? defaultDb;
  if (platformAgentsForOrg(orgId).some((d) => d.defaultBinding)) forgetOrgProviderPolicy(orgId);
  const marker = await loadPlatformAgentsMarker(orgId, db);
  if (
    marker?.hash === platformAgentRegistryHash() &&
    !(await platformBindingsDrifted(orgId, db, options.log ?? defaultLogger))
  ) {
    return { reconciled: false };
  }
  return { reconciled: true, result: await reconcilePlatformAgents(orgId, options) };
}

/**
 * Whether any agent's provider and model are not where {@link askPick}
 * would put them now (t-798). What the org can reach changes without the
 * registry changing: a provider granted or revoked, switched on or off, its
 * credential set, a tool-using model added, a fork's eligibility rule. None of
 * those has one write a hook could catch — an env var or a fork's resolver
 * has none at all — so the job asks the question itself, every pass. An agent
 * the org owns asks nothing; one nobody has classified yet counts, so a run
 * classifies it. A pick that cannot be answered is logged and skipped, as the
 * reconcile would leave that binding as it is.
 *
 * A missing or refused agent is left to the digest check.
 */
async function platformBindingsDrifted(
  orgId: string,
  db: TenancyClient,
  log: Logger
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
      select: { slug: true, provider: true, model: true, bindingOwner: true },
    });
    for (const definition of definitions) {
      const row = rows.find((r) => r.slug === definition.slug);
      if (!row) continue;
      const owner = storedOwner(row.bindingOwner);
      if (owner === null) return true;
      if (owner === 'org') continue;
      try {
        if (!sameBinding(row, await askPick(definition, db))) return true;
      } catch (error) {
        // The reconcile would leave this binding as it is too; ask next pass.
        log.warn('Platform agent binding pick unavailable — drift not checked', {
          orgId,
          slug: definition.slug,
          error: error instanceof Error ? error.message : String(error),
        });
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
    // As the job does: this process may hold a policy another instance has
    // since changed, and a pick made from it would undo the change.
    forgetOrgProviderPolicy(orgId);
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
 * `binding` is who owns the new agent's provider and model and, while that is
 * the platform, where they start ({@link definitionPicksBinding}); with no
 * target the agent starts on "inherit", as a definition with no pick does.
 */
async function createInstance(
  db: TenancyClient,
  definition: PlatformAgentDefinition,
  binding: { owner: BindingOwner | null; target: Binding | undefined },
  desired: DesiredSets
): Promise<void> {
  const starting = {
    provider: '',
    model: '',
    ...definition.defaults,
    ...binding.target,
    bindingOwner: binding.owner,
  };

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
  });
}

/**
 * `plan` is who owns the binding after this run and, while that is the
 * platform, where it goes ({@link bindingTarget}).
 */
async function updateInstance(
  db: TenancyClient,
  definition: PlatformAgentDefinition,
  existing: ExistingAgent,
  plan: { owner: BindingOwner | null; target: Binding | undefined },
  desired: DesiredSets
): Promise<{ changed: boolean; bindingsChanged: boolean; accessChanged: boolean }> {
  const current: Record<string, unknown> = existing;
  const changes: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(codeOwnedValues(definition))) {
    if (!isDeepStrictEqual(current[field], value)) changes[field] = value;
  }
  const movesBinding = plan.target !== undefined && !sameBinding(existing, plan.target);
  const ownerChanges = plan.owner !== existing.bindingOwner;
  if (movesBinding) Object.assign(changes, plan.target);
  if (ownerChanges) changes.bindingOwner = plan.owner;
  const writesBinding = movesBinding || ownerChanges;

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

  if (changedFields.length === 0 && !tagsChanged && !documentsChanged && !bindingsChanged) {
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
    if (writesBinding) {
      // Only while the binding and its owner are still what this run read:
      // an admin's save since then made it theirs, and nothing of this run's
      // is written.
      try {
        updated = await tx.aiAgent.update({
          where: {
            id: existing.id,
            provider: existing.provider,
            model: existing.model,
            bindingOwner: existing.bindingOwner,
          },
          data: writeData(changes),
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
          throw new BindingChangedConcurrently();
        }
        throw err;
      }
    } else if (changedFields.length > 0) {
      updated = await tx.aiAgent.update({ where: { id: existing.id }, data: writeData(changes) });
    }

    if (versionedChanges.length > 0) {
      await tx.aiAgentVersion.create({
        data: {
          agentId: existing.id,
          version: postVersion,
          snapshot: asSnapshotJson(
            buildAgentSnapshot(updated, { grantedTagIds: desired.tagIds, grantedDocumentIds: [] })
          ),
          changeSummary: platformChangeSummary(versionedChanges),
          createdBy: desired.ownerId,
        },
      });
    }
  });

  return {
    changed: true,
    bindingsChanged,
    accessChanged: tagsChanged || documentsChanged || 'knowledgeAccessMode' in changes,
  };
}

/**
 * A version row's summary, naming why the platform changed the agent: its
 * definition (a deploy), or the pick following what the org can reach — so an
 * admin tracing a model switch looks for a grant, not a release.
 */
function platformChangeSummary(versionedChanges: readonly string[]): string {
  const picked = versionedChanges.filter((f) => f === 'provider' || f === 'model');
  const defined = versionedChanges.filter((f) => f !== 'provider' && f !== 'model');
  return [
    ...(defined.length > 0 ? [`Platform definition: ${buildChangeSummary(defined)}`] : []),
    ...(picked.length > 0
      ? [`Re-picked for what the org can reach: ${buildChangeSummary(picked)}`]
      : []),
  ].join('; ');
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
