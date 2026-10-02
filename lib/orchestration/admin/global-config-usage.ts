/**
 * Who uses a piece of global config, counted across every org (§107 t-731).
 *
 * Providers, provider models, knowledge tags and agent profiles are global
 * config: one row serves every org. What uses them is tenant-owned: agents,
 * workflows, cost rows, grants. At `TENANCY_MODE=multi` the `org_isolation`
 * policy hides other orgs' rows, so an in-use check written as a plain count
 * saw only the caller's org. An admin could then delete a provider, model or
 * tag that another org's agents still depend on, and an agent profile's
 * "attached agents" count was too low.
 *
 * So at `multi` every count here runs under the system scope, the audited
 * bypass, entered through `runAsCrossOrgCount` (§107 t-752): the same bypass
 * as `runAsSystem`, logged at debug because the admin pages ask on every
 * load, and confined to this module by a test. The answer to "is it in
 * use?" includes every org. Only the caller's own rows are ever returned by
 * name; another org's usage leaves this module as a number, and nothing here
 * writes. At `single` there is one org, no policy to bypass, and every row
 * is the caller's, so the reads run as they are.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { prisma } from '@/lib/db/client';
import { getTenantContext, isMultiTenant, runAsCrossOrgCount } from '@/lib/tenancy/context';

const REASON = 'in-use check on global config (counted across orgs)';

/** `fn` reading every org: the cross-org count scope at `multi`, as it is at `single`. */
function acrossOrgs<T>(fn: () => Promise<T>): Promise<T> {
  return isMultiTenant() ? runAsCrossOrgCount(REASON, fn) : fn();
}

/**
 * The `where` that narrows a tenant-owned row to the caller's own, read
 * BEFORE entering the system scope: `{}` at `single` (every row, `NULL`-org
 * ones included), the entered org at `multi`, and `null` (none) at `multi`
 * with no org entered.
 */
function callersWhere(): { orgId?: string } | null {
  if (!isMultiTenant()) return {};
  const current = getTenantContext()?.orgId;
  return current ? { orgId: current } : null;
}

/** A row the caller may see named: one of its own org's. */
export interface NamedRef {
  id: string;
  name: string;
  slug: string;
}

/**
 * Which rows the caller may see by name, decided from the caller's scope.
 * Read BEFORE entering the system scope, which has no org of its own. At
 * `single` every row is the caller's, `NULL`-org rows included. At `multi`
 * only the entered org's rows are, and with no org entered (an admin API
 * key) none are.
 */
function callersRows(): (orgId: string | null) => boolean {
  if (!isMultiTenant()) return () => true;
  const current = getTenantContext()?.orgId;
  return (orgId) => current != null && orgId === current;
}

function named(
  rows: Array<NamedRef & { orgId: string | null }>,
  isCallers: (orgId: string | null) => boolean
): { own: NamedRef[]; elsewhere: number } {
  const own = rows
    .filter((r) => isCallers(r.orgId))
    .map(({ id, name, slug }) => ({ id, name, slug }));
  return { own, elsewhere: rows.length - own.length };
}

// ── Providers ───────────────────────────────────────────────────────────────

export interface ProviderUsage {
  /** Agents with this provider as primary, in every org. */
  primaryAgents: number;
  /** Agents with it in `fallbackProviders`, in every org. */
  fallbackAgents: number;
  /** Cost rows recorded against it, in every org. */
  costLogRows: number;
}

/** What still references a provider's slug, in every org. Counts only. */
export function providerUsage(slug: string): Promise<ProviderUsage> {
  return acrossOrgs(async () => {
    const [primaryAgents, fallbackAgents, costLogRows] = await Promise.all([
      prisma.aiAgent.count({ where: { provider: slug } }),
      prisma.aiAgent.count({ where: { fallbackProviders: { has: slug } } }),
      prisma.aiCostLog.count({ where: { provider: slug } }),
    ]);
    return { primaryAgents, fallbackAgents, costLogRows };
  });
}

// ── Provider models ─────────────────────────────────────────────────────────

/**
 * Step types whose `config.modelOverride` pins a model: the semantic
 * validator's PROVIDER_CHOOSING_STEP_TYPES (its LLM_STEP_TYPES plus
 * `supervisor`, which passes its override to the LLM call), in
 * lib/orchestration/workflows/semantic-validator.ts. Kept in sync by hand
 * because exporting from the validator would pull its runtime deps (the
 * model registry) in for no benefit. Moved here from the provider-models
 * route with the check it serves, which left `supervisor` out until t-731's
 * review.
 */
const LLM_STEP_TYPES = new Set([
  'llm_call',
  'route',
  'reflect',
  'guard',
  'evaluate',
  'plan',
  'orchestrator',
  'supervisor',
]);

function definitionPinsModel(definition: unknown, modelId: string): boolean {
  if (!definition || typeof definition !== 'object') return false;
  const steps = (definition as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return false;
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const type = (step as { type?: unknown }).type;
    if (typeof type !== 'string' || !LLM_STEP_TYPES.has(type)) continue;
    const config = (step as { config?: unknown }).config;
    if (!config || typeof config !== 'object') continue;
    const override = (config as { modelOverride?: unknown }).modelOverride;
    if (typeof override === 'string' && override === modelId) return true;
  }
  return false;
}

export interface ProviderModelUsage {
  /** The caller's active agents bound to the model, by name. */
  agents: NamedRef[];
  /** The caller's active workflows pinning it (draft or published), by name. */
  workflows: NamedRef[];
  /** Active agents in other orgs bound to it. */
  otherOrgAgents: number;
  /** Active workflows in other orgs pinning it. */
  otherOrgWorkflows: number;
}

/**
 * Active agents bound to `(providerSlug, modelId)` and active workflows
 * pinning `modelId` in a step's `modelOverride`, in every org. The caller's
 * are named, other orgs' are counted.
 */
export function providerModelUsage(
  providerSlug: string,
  modelId: string
): Promise<ProviderModelUsage> {
  const isCallers = callersRows();
  // A prefilter, not the check: JSON containment (`@>`) narrows the read to
  // definitions with SOME step pinning `modelId`, so every org's workflow
  // JSON no longer crosses the wire; `definitionPinsModel` below still
  // decides, by step type (§107 t-752).
  const pins = { path: ['steps'], array_contains: [{ config: { modelOverride: modelId } }] };
  return acrossOrgs(async () => {
    const [agentRows, workflowRows] = await Promise.all([
      prisma.aiAgent.findMany({
        where: { isActive: true, provider: providerSlug, model: modelId },
        select: { id: true, name: true, slug: true, orgId: true },
        orderBy: { name: 'asc' },
      }),
      prisma.aiWorkflow.findMany({
        where: {
          isActive: true,
          OR: [{ draftDefinition: pins }, { publishedVersion: { is: { snapshot: pins } } }],
        },
        select: {
          id: true,
          name: true,
          slug: true,
          orgId: true,
          draftDefinition: true,
          publishedVersion: { select: { snapshot: true } },
        },
        orderBy: { name: 'asc' },
      }),
    ]);
    const pinning = workflowRows.filter(
      (w) =>
        definitionPinsModel(w.draftDefinition, modelId) ||
        definitionPinsModel(w.publishedVersion?.snapshot, modelId)
    );
    const agents = named(agentRows, isCallers);
    const workflows = named(pinning, isCallers);
    return {
      agents: agents.own,
      workflows: workflows.own,
      otherOrgAgents: agents.elsewhere,
      otherOrgWorkflows: workflows.elsewhere,
    };
  });
}

/** Who uses a provider model, for a list: the caller's agents by name, other orgs' counted. */
export interface ModelAgentUsage {
  /** The caller's active agents bound to the model, by name. */
  agents: NamedRef[];
  /** Active agents in other orgs bound to it. */
  otherOrgAgents: number;
}

/** The key {@link modelAgentUsage} answers under. */
export function modelUsageKey(providerSlug: string, modelId: string): string {
  return `${providerSlug}::${modelId}`;
}

/**
 * Active agents bound to each `(provider, model)` pair among `providerSlugs`
 * and, when given, `modelIds`, in every org, in one read — for the models
 * matrix and a provider's model list (§107 t-752). Keyed by
 * {@link modelUsageKey}; a pair with no agent is absent.
 */
export function modelAgentUsage(
  providerSlugs: string[],
  modelIds?: string[]
): Promise<Map<string, ModelAgentUsage>> {
  if (providerSlugs.length === 0 || modelIds?.length === 0) {
    return Promise.resolve(new Map<string, ModelAgentUsage>());
  }
  const isCallers = callersRows();
  return acrossOrgs(async () => {
    const rows = await prisma.aiAgent.findMany({
      where: {
        isActive: true,
        provider: { in: providerSlugs },
        ...(modelIds ? { model: { in: modelIds } } : {}),
      },
      select: { id: true, name: true, slug: true, orgId: true, provider: true, model: true },
      orderBy: { name: 'asc' },
    });
    const usage = new Map<string, ModelAgentUsage>();
    for (const row of rows) {
      if (!row.provider || !row.model) continue;
      const key = modelUsageKey(row.provider, row.model);
      const found = usage.get(key) ?? { agents: [], otherOrgAgents: 0 };
      if (isCallers(row.orgId)) found.agents.push({ id: row.id, name: row.name, slug: row.slug });
      else found.otherOrgAgents += 1;
      usage.set(key, found);
    }
    return usage;
  });
}

// ── Capabilities ────────────────────────────────────────────────────────────

/** An agent a capability is attached to, as the capabilities pages show it. */
export interface CapabilityAgentRef extends NamedRef {
  isActive: boolean;
}

/** Who uses a capability: the caller's agents by name, other orgs' counted. */
export interface CapabilityAgentUsage {
  /** The caller's agents with the capability attached, by name, active or not. */
  agents: CapabilityAgentRef[];
  /** Agents in other orgs with it attached. */
  otherOrgAgents: number;
}

/**
 * Agents with each capability attached, in every org, in one read — for the
 * capabilities list, a capability's page and its delete warning (§107
 * t-752). The pivot carries its own `orgId`. A capability with no agent is
 * absent.
 */
export function capabilityAgentUsage(
  capabilityIds: string[]
): Promise<Map<string, CapabilityAgentUsage>> {
  if (capabilityIds.length === 0) return Promise.resolve(new Map<string, CapabilityAgentUsage>());
  const isCallers = callersRows();
  return acrossOrgs(async () => {
    const links = await prisma.aiAgentCapability.findMany({
      where: { capabilityId: { in: capabilityIds } },
      select: {
        capabilityId: true,
        orgId: true,
        agent: { select: { id: true, name: true, slug: true, isActive: true } },
      },
      orderBy: { agent: { name: 'asc' } },
    });
    const usage = new Map<string, CapabilityAgentUsage>();
    for (const link of links) {
      const found = usage.get(link.capabilityId) ?? { agents: [], otherOrgAgents: 0 };
      if (isCallers(link.orgId)) found.agents.push(link.agent);
      else found.otherOrgAgents += 1;
      usage.set(link.capabilityId, found);
    }
    return usage;
  });
}

// ── Knowledge tags ──────────────────────────────────────────────────────────

/** How many of the caller's granted agents a tag's usage names. */
export const MAX_NAMED_TAG_AGENTS = 50;

export interface KnowledgeTagUsage {
  /** Agents granted the tag, in every org. */
  agentGrants: number;
  /** Documents carrying the tag, in every org. */
  documentLinks: number;
  /** The caller's granted agents, by name, oldest grant first, at most {@link MAX_NAMED_TAG_AGENTS}. */
  agents: NamedRef[];
  /** Agents in other orgs granted the tag. */
  otherOrgAgentGrants: number;
  /** Documents in other orgs carrying the tag. A forced delete strips these too. */
  otherOrgDocumentLinks: number;
}

/** Split per-org counts into every org's total and the caller's share. */
function split(
  groups: Array<{ orgId: string | null; _count: { _all: number } }>,
  isCallers: (orgId: string | null) => boolean
): { total: number; own: number } {
  let total = 0;
  let own = 0;
  for (const g of groups) {
    total += g._count._all;
    if (isCallers(g.orgId)) own += g._count._all;
  }
  return { total, own };
}

/**
 * Grants and document links on a knowledge tag, in every org. Both join
 * tables carry their own `orgId`, so one count per org gives the total and
 * the caller's share at once, and only the caller's first
 * {@link MAX_NAMED_TAG_AGENTS} grants are read by row.
 */
export function knowledgeTagUsage(tagId: string): Promise<KnowledgeTagUsage> {
  const own = callersWhere();
  const isCallers = callersRows();
  return acrossOrgs(async () => {
    const [grantGroups, linkGroups, ownNamed] = await Promise.all([
      prisma.aiAgentKnowledgeTag.groupBy({
        by: ['orgId'],
        where: { tagId },
        _count: { _all: true },
      }),
      prisma.aiKnowledgeDocumentTag.groupBy({
        by: ['orgId'],
        where: { tagId },
        _count: { _all: true },
      }),
      own
        ? prisma.aiAgentKnowledgeTag.findMany({
            where: { tagId, ...own },
            select: { agent: { select: { id: true, name: true, slug: true } } },
            orderBy: { createdAt: 'asc' },
            take: MAX_NAMED_TAG_AGENTS,
          })
        : [],
    ]);
    const grants = split(grantGroups, isCallers);
    const links = split(linkGroups, isCallers);
    return {
      agentGrants: grants.total,
      documentLinks: links.total,
      agents: ownNamed.map((g) => g.agent),
      otherOrgAgentGrants: grants.total - grants.own,
      otherOrgDocumentLinks: links.total - links.own,
    };
  });
}

/** Grants and document links on each tag, in every org, for a list page. A tag with none is absent. */
export function knowledgeTagCounts(
  tagIds: string[]
): Promise<Map<string, { agents: number; documents: number }>> {
  if (tagIds.length === 0) {
    return Promise.resolve(new Map<string, { agents: number; documents: number }>());
  }
  return acrossOrgs(async () => {
    const where = { tagId: { in: tagIds } };
    const [grants, links] = await Promise.all([
      prisma.aiAgentKnowledgeTag.groupBy({ by: ['tagId'], where, _count: { _all: true } }),
      prisma.aiKnowledgeDocumentTag.groupBy({ by: ['tagId'], where, _count: { _all: true } }),
    ]);
    const counts = new Map<string, { agents: number; documents: number }>();
    const entry = (tagId: string) => {
      const found = counts.get(tagId) ?? { agents: 0, documents: 0 };
      counts.set(tagId, found);
      return found;
    };
    for (const g of grants) entry(g.tagId).agents = g._count._all;
    for (const l of links) entry(l.tagId).documents = l._count._all;
    return counts;
  });
}

// ── Agent profiles ──────────────────────────────────────────────────────────

/** Agents attached to each profile, in every org. A profile with none is absent. */
export function agentProfileUsage(profileIds: string[]): Promise<Map<string, number>> {
  if (profileIds.length === 0) return Promise.resolve(new Map<string, number>());
  return acrossOrgs(async () => {
    const groups = await prisma.aiAgent.groupBy({
      by: ['profileId'],
      where: { profileId: { in: profileIds } },
      _count: { _all: true },
    });
    const counts = new Map<string, number>();
    for (const g of groups) {
      if (g.profileId) counts.set(g.profileId, g._count._all);
    }
    return counts;
  });
}
