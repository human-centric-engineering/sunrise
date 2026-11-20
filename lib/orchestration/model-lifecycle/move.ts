/**
 * Move every use of a model to its replacement, in one audited action
 * (§136 t-1066).
 *
 * A vendor retires a model; the admin names a replacement on the same
 * provider (`checkReplacement`, owner ruling 2026-11-19). This moves what uses
 * the model to it: every org's agents and workflows, and the install's
 * settings pins. {@link previewModelMove} answers what would move, and changes
 * nothing; {@link moveModelUses} moves it.
 *
 * ## One org at a time, in that org's scope
 *
 * Each org is read and written inside its own scope (`runAsOrg` at `multi`),
 * never under the system bypass: row isolation keeps every write inside the
 * org being moved, and each read also names the org. Suspended orgs are
 * skipped, as `forEachOrg` skips them, and counted. At `single` there is one
 * org and one pass.
 *
 * **Each org is one transaction.** Its agents and workflows move together or
 * not at all. It takes erasure's locks for everyone its workflows name before
 * any row lock (`lockRepinSubjects`), the order every definition writer
 * keeps, so it cannot deadlock with an erasure. A workflow whose published
 * version fails the schema or the DAG rules is left, with the reason, and the
 * rest of the org still moves. One org failing rolls back that org only, and is reported with
 * its reason; the orgs before and after it still move. The settings are the
 * install's, written once before the orgs, under the settings row's lock.
 *
 * ## What moves
 *
 * - **Agents** bound to the model, active or not (a turned-off agent turned
 *   back on would otherwise be on a retired model): the model id changes and
 *   the provider stays. Each change is a new agent version, through
 *   `agent-versioning.ts`. An agent whose binding follows the platform's pick
 *   (`bindingFollowsPlatform`) is left and counted: the platform-agent
 *   reconcile re-picks it, ranking a retiring model last, and would undo a
 *   model the move wrote.
 * - **Workflows** pinning it in a step's `modelOverride`: the draft in place,
 *   and a new published version that differs only in the pins
 *   (`repinWorkflow`).
 * - **Settings**: the task defaults, the audio default and the confidential
 *   model. The embedding pins are not moved (`move-plan.ts`).
 *
 * Which pins move and which stay is `move-plan.ts`'s rule, shared by the
 * preview and the move.
 *
 * ## An org on its own key
 *
 * An org may pay for this provider with its own key (§137). The vendor may
 * not let that key use the replacement, and every one of its calls would then
 * fail after the move. So before anything of the org's moves, the key is
 * tested against the replacement (`testProviderKeyOnModel`), and if the test
 * fails the org is skipped with the reason. No org is skipped for policy: a
 * same-provider move never changes which providers an org may use. The test is
 * run by the move, not the preview, since it is billed to the org's key.
 *
 * ## The audit trail
 *
 * One row per agent and per workflow moved, in its org, written once the org
 * commits; one for the settings; and one summary row for the move, in the
 * caller's scope, naming the moved, skipped and failed counts.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { APIError, NotFoundError, StaleRecordError, ValidationError } from '@/lib/api/errors';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { workflowsMayPinWhere } from '@/lib/orchestration/admin/global-config-usage';
import { bindingFollowsPlatform } from '@/lib/orchestration/agents/platform-agent-guard';
import {
  AGENT_BATCH_TRANSACTION_TIMEOUT_MS,
  ensureBaselineVersion,
  isAgentVersionConflict,
  recordAgentVersion,
} from '@/lib/orchestration/agents/agent-versioning';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { withoutKey } from '@/lib/orchestration/llm/org-provider-key-admin';
import { describeError, openOrgProviderKey } from '@/lib/orchestration/llm/org-provider-keys';
import { testProviderKeyOnModel } from '@/lib/orchestration/llm/provider-manager';
import { invalidateSettingsCache } from '@/lib/orchestration/llm/settings-resolver';
import {
  planSettingsMove,
  repinDefinition,
  type LeftCounts,
  type LeftReason,
  type MovePins,
  type SettingsMovePlan,
} from '@/lib/orchestration/model-lifecycle/move-plan';
import { settingsPinsFor } from '@/lib/orchestration/model-lifecycle/settings-pins';
import { checkReplacement } from '@/lib/orchestration/model-lifecycle/state';
import {
  getOrchestrationSettings,
  invalidateOrchestrationSettingsCache,
  parseStoredDefaults,
} from '@/lib/orchestration/settings';
import {
  lockRepinSubjects,
  repinRefusal,
  repinWorkflow,
} from '@/lib/orchestration/workflows/version-service';
import { lockSettingsRow } from '@/lib/orchestration/config-versions';
import { WRITER_TRANSACTION_OPTIONS } from '@/lib/privacy/erased-subjects';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { isMultiTenant, listActiveOrgIds, runAsOrg } from '@/lib/tenancy/context';
import type { TaskType } from '@/types/orchestration';

// ── The two models ──────────────────────────────────────────────────────────

const MODEL_SELECT = {
  id: true,
  name: true,
  providerSlug: true,
  modelId: true,
  capabilities: true,
  isActive: true,
  retiresAt: true,
} as const;

/** A catalogue row, as the move reads it. */
export interface MoveModel {
  id: string;
  name: string;
  providerSlug: string;
  modelId: string;
  capabilities: string[];
  isActive: boolean;
  retiresAt: Date | null;
}

/** The model whose uses move, and the one they move to. */
export interface MoveTarget {
  model: MoveModel;
  replacement: MoveModel;
  /** The other active providers that offer the model's id (`move-plan.ts`). */
  sharedWith: string[];
}

/**
 * Read the model and its proposed replacement, and check the replacement
 * now: a stored replacement can have stopped qualifying since it was chosen
 * (§136 t-1064), and the request may name another.
 *
 * @throws NotFoundError when the model does not exist.
 * @throws ValidationError (`replacementId`) when the replacement does not
 *   exist or does not qualify, a model on another provider included.
 */
export async function loadMoveTarget(
  modelRowId: string,
  replacementRowId: string
): Promise<MoveTarget> {
  const [model, replacement] = await Promise.all([
    prisma.aiProviderModel.findUnique({ where: { id: modelRowId }, select: MODEL_SELECT }),
    prisma.aiProviderModel.findUnique({ where: { id: replacementRowId }, select: MODEL_SELECT }),
  ]);
  if (!model) throw new NotFoundError(`Provider model ${modelRowId} not found`);
  if (!replacement) {
    throw new ValidationError('The replacement model does not exist', {
      replacementId: ['The replacement model does not exist'],
    });
  }
  const problem = checkReplacement(model, replacement);
  if (problem) throw new ValidationError(problem, { replacementId: [problem] });
  // Only active rows: the model registry loads no other, so a bare id can
  // only run on an active one (as the uses finder reads it).
  const siblings = await prisma.aiProviderModel.findMany({
    where: { modelId: model.modelId, providerSlug: { not: model.providerSlug }, isActive: true },
    select: { providerSlug: true },
    orderBy: { providerSlug: 'asc' },
  });
  return { model, replacement, sharedWith: siblings.map((s) => s.providerSlug) };
}

function movePins(target: MoveTarget): MovePins {
  return {
    providerSlug: target.model.providerSlug,
    modelId: target.model.modelId,
    replacementModelId: target.replacement.modelId,
    idShared: target.sharedWith.length > 0,
  };
}

// ── The orgs ────────────────────────────────────────────────────────────────

interface OrgPass {
  orgId: string;
  name: string;
}

interface OrgPasses {
  passes: OrgPass[];
  /** Suspended orgs, which the move does not enter (as `forEachOrg`). */
  suspended: number;
}

/**
 * The orgs the move walks: every active org at `multi`, in `forEachOrg`'s
 * order and by its rule (`listActiveOrgIds`); the install org alone at
 * `single`, where every row is the install's.
 */
async function orgPasses(): Promise<OrgPasses> {
  if (!isMultiTenant()) {
    const install = await prisma.org.findUnique({
      where: { id: INSTALL_ORG_ID },
      select: { name: true },
    });
    return {
      passes: [{ orgId: INSTALL_ORG_ID, name: install?.name ?? 'This platform' }],
      suspended: 0,
    };
  }
  const ids = await listActiveOrgIds();
  const [rows, suspended] = await Promise.all([
    prisma.org.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    prisma.org.count({ where: { status: { not: 'ACTIVE' } } }),
  ]);
  const names = new Map(rows.map((r) => [r.id, r.name]));
  return {
    passes: ids.map((orgId) => ({ orgId, name: names.get(orgId) ?? orgId })),
    suspended,
  };
}

/** `fn` inside the org's scope at `multi`; as it is at `single`. */
function inOrg<T>(pass: OrgPass, fn: () => Promise<T>): Promise<T> {
  return isMultiTenant() ? runAsOrg(pass.orgId, fn, { source: 'job' }) : fn();
}

/**
 * The org's rows, named as well as bounded by row isolation at `multi`; every
 * row at `single`, `NULL`-org ones included.
 */
function orgWhere(pass: OrgPass): { orgId?: string } {
  return isMultiTenant() ? { orgId: pass.orgId } : {};
}

// ── One org's uses ──────────────────────────────────────────────────────────

/** A step left on the model, and why. */
export interface LeftStep {
  workflowId: string;
  stepId: string;
  reason: LeftReason;
}

interface OrgUses {
  agents: Array<{ id: string; name: string; isActive: boolean }>;
  /** Agents on the model whose binding follows the platform's pick: left, as it moves them. */
  followingPlatform: number;
  /** Workflows with a step that moves: the draft, the published snapshot, or both. */
  workflows: Array<{ id: string; name: string; draft: boolean; published: boolean }>;
  left: LeftStep[];
}

async function readOrgUses(pass: OrgPass, target: MoveTarget): Promise<OrgUses> {
  const pins = movePins(target);
  const [agents, workflows] = await Promise.all([
    prisma.aiAgent.findMany({
      where: {
        ...orgWhere(pass),
        provider: target.model.providerSlug,
        model: target.model.modelId,
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
        isActive: true,
        isSystem: true,
        slug: true,
        bindingOwner: true,
      },
      orderBy: { name: 'asc' },
    }),
    prisma.aiWorkflow.findMany({
      where: {
        ...orgWhere(pass),
        ...workflowsMayPinWhere(target.model.providerSlug, target.model.modelId),
      },
      select: {
        id: true,
        name: true,
        draftDefinition: true,
        publishedVersion: { select: { snapshot: true } },
      },
      orderBy: { name: 'asc' },
    }),
  ]);
  const moving = agents.filter((a) => !bindingFollowsPlatform(a));
  const uses: OrgUses = {
    agents: moving.map(({ id, name, isActive }) => ({ id, name, isActive })),
    followingPlatform: agents.length - moving.length,
    workflows: [],
    left: [],
  };
  for (const w of workflows) {
    const draft = w.draftDefinition === null ? null : repinDefinition(w.draftDefinition, pins);
    const published = w.publishedVersion
      ? repinDefinition(w.publishedVersion.snapshot, pins)
      : null;
    // A step left in both the draft and the published version is one step.
    const left = new Map<string, LeftReason>();
    for (const l of [...(published?.left ?? []), ...(draft?.left ?? [])])
      left.set(l.stepId, l.reason);
    for (const [stepId, reason] of left) uses.left.push({ workflowId: w.id, stepId, reason });
    const draftMoves = (draft?.moved ?? 0) > 0;
    const publishedMoves = (published?.moved ?? 0) > 0;
    // The move leaves such a workflow whole (`repinWorkflow`); say so now.
    if (publishedMoves && repinRefusal(published?.definition) !== null) {
      uses.left.push({ workflowId: w.id, stepId: '', reason: 'published_invalid' });
      continue;
    }
    if (draftMoves || publishedMoves) {
      uses.workflows.push({ id: w.id, name: w.name, draft: draftMoves, published: publishedMoves });
    }
  }
  return uses;
}

/**
 * The steps left, counted by reason: what leaves this module, so another
 * org's workflow and step ids never reach the browser.
 */
function countLeft(left: readonly LeftStep[]): LeftCounts {
  const counts: LeftCounts = {};
  for (const step of left) counts[step.reason] = (counts[step.reason] ?? 0) + 1;
  return counts;
}

/** Whether the org has anything to move or to report as left. */
function usesSomething(uses: OrgUses): boolean {
  return uses.agents.length + uses.workflows.length + uses.left.length + uses.followingPlatform > 0;
}

/** The provider row for the model's slug, which an org's own key is saved against. */
function providerConfigFor(slug: string) {
  return prisma.aiProviderConfig.findUnique({ where: { slug } });
}

// ── Preview ─────────────────────────────────────────────────────────────────

/** One org in the preview. Counts only: an org's rows are not named here. */
export interface OrgMovePreview {
  orgId: string;
  name: string;
  agents: number;
  /** How many of {@link agents} are turned off. */
  inactiveAgents: number;
  /** Agents left because the platform picks their model, and moves them itself. */
  agentsFollowingPlatform: number;
  workflows: number;
  /** What is left on the model, counted by reason. */
  left: LeftCounts;
  /** The org pays for the provider with its own key, which the move tests first. */
  ownKey: boolean;
}

/** What {@link previewModelMove} answers. */
export interface ModelMovePreview {
  model: { id: string; name: string; modelId: string; providerSlug: string };
  replacement: { id: string; name: string; modelId: string };
  /** Orgs with something that moves or is left; an org using nothing is not listed. */
  orgs: OrgMovePreview[];
  settings: SettingsMovePlan;
  suspendedOrgs: number;
  sharedWith: string[];
}

function modelSummary(target: MoveTarget): Pick<ModelMovePreview, 'model' | 'replacement'> {
  const { model, replacement } = target;
  return {
    model: {
      id: model.id,
      name: model.name,
      modelId: model.modelId,
      providerSlug: model.providerSlug,
    },
    replacement: { id: replacement.id, name: replacement.name, modelId: replacement.modelId },
  };
}

async function settingsPlan(target: MoveTarget): Promise<SettingsMovePlan> {
  const settings = await getOrchestrationSettings();
  return planSettingsMove(settingsPinsFor(target.model, settings), settings, movePins(target));
}

/** What moving the model's uses to the replacement would do. Changes nothing. */
export async function previewModelMove(target: MoveTarget): Promise<ModelMovePreview> {
  const [{ passes, suspended }, config] = await Promise.all([
    orgPasses(),
    providerConfigFor(target.model.providerSlug),
  ]);
  const orgs: OrgMovePreview[] = [];
  for (const pass of passes) {
    const preview = await inOrg(pass, async () => {
      const uses = await readOrgUses(pass, target);
      if (!usesSomething(uses)) return null;
      const ownKey =
        isMultiTenant() && config
          ? (await prisma.aiOrgProviderKey.count({
              where: { orgId: pass.orgId, providerConfigId: config.id },
            })) > 0
          : false;
      return {
        orgId: pass.orgId,
        name: pass.name,
        agents: uses.agents.length,
        inactiveAgents: uses.agents.filter((a) => !a.isActive).length,
        agentsFollowingPlatform: uses.followingPlatform,
        workflows: uses.workflows.length,
        left: countLeft(uses.left),
        ownKey,
      };
    });
    if (preview) orgs.push(preview);
  }
  return {
    ...modelSummary(target),
    orgs,
    settings: await settingsPlan(target),
    suspendedOrgs: suspended,
    sharedWith: target.sharedWith,
  };
}

// ── Move ────────────────────────────────────────────────────────────────────

/**
 * How one org fared: `left` when it had nothing the move could change, only
 * uses it leaves (listed in `left` and `agentsFollowingPlatform`).
 */
export type OrgMoveStatus = 'moved' | 'left' | 'skipped' | 'failed';

export interface OrgMoveResult {
  orgId: string;
  name: string;
  status: OrgMoveStatus;
  /** Why the org was skipped or failed. */
  reason?: string;
  agents: number;
  workflows: number;
  /** What is left on the model, counted by reason. */
  left: LeftCounts;
  /** Agents left because the platform picks their model, and moves them itself. */
  agentsFollowingPlatform: number;
}

/** What {@link moveModelUses} answers. */
export interface ModelMoveResult extends Pick<ModelMovePreview, 'model' | 'replacement'> {
  orgs: OrgMoveResult[];
  settings: SettingsMovePlan;
  suspendedOrgs: number;
  totals: { agents: number; workflows: number; settings: number; skipped: number; failed: number };
}

export interface MoveActor {
  userId: string;
  clientIp: string | null;
}

/** The version label and summary every moved entity carries. */
function changeLabel(target: MoveTarget): string {
  return `Model ${target.model.modelId} moved to ${target.replacement.modelId} (retiring model)`;
}

/**
 * Why an org on its own key is skipped, or `null` when its key passes the
 * test against the replacement, or it has no key for this provider. Inside
 * the org's scope. The vendor's message is logged with the key cut out, and
 * never returned.
 */
async function ownKeyProblem(
  pass: OrgPass,
  target: MoveTarget,
  config: Awaited<ReturnType<typeof providerConfigFor>>
): Promise<string | null> {
  if (!isMultiTenant() || !config) return null;
  const key = await openOrgProviderKey(config.id);
  if (!key) return null;
  if (key.apiKey === null) {
    return 'Its own key for this provider cannot be opened, so it could not be tested against the replacement.';
  }
  const { replacement } = target;
  let result;
  try {
    result = await testProviderKeyOnModel(config, key.apiKey, replacement.modelId, {
      chat: replacement.capabilities.includes('chat'),
    });
  } catch (err) {
    logger.warn('Model move: an org’s own key could not be tested', {
      orgId: pass.orgId,
      provider: config.slug,
      error: describeError(err),
    });
    return 'Its own key for this provider could not be tested against the replacement.';
  }
  if (result.ok) return null;
  logger.warn('Model move: an org’s own key failed its test against the replacement', {
    orgId: pass.orgId,
    provider: config.slug,
    model: replacement.modelId,
    failedAt: result.failedAt,
    ...(result.error ? { detail: withoutKey(result.error, key.apiKey) } : {}),
  });
  return result.failedAt === 'model'
    ? `Its own key for this provider could not use ${replacement.name} (a test message to it failed).`
    : 'The provider refused its own key for this provider.';
}

/** What an org's failure says: our own errors' messages, and nothing a database error carries. */
function failureReason(err: unknown): string {
  if (isAgentVersionConflict(err)) {
    return 'One of its agents was changed at the same moment. Run the move again.';
  }
  if (err instanceof StaleRecordError) {
    return 'One of its workflows was changed during the move, so nothing in it moved. Run the move again.';
  }
  if (err instanceof APIError) return err.message;
  return 'Its changes could not be written. Nothing in it moved.';
}

interface OrgWrites {
  agents: Array<{ id: string; name: string; version: number | null }>;
  /** Workflows left because their published version fails the checks. */
  refused: LeftStep[];
  workflows: Array<{
    id: string;
    name: string;
    draftChanged: boolean;
    published: { from: number; to: number } | null;
  }>;
}

/** One org's agents and workflows, moved in one transaction. */
async function writeOrg(
  pass: OrgPass,
  target: MoveTarget,
  uses: OrgUses,
  actor: MoveActor
): Promise<OrgWrites> {
  const pins = movePins(target);
  const label = changeLabel(target);
  return prisma.$transaction(
    async (tx) => {
      const writes: OrgWrites = { agents: [], refused: [], workflows: [] };
      // Erasure's locks for everyone the workflows name, before any row lock
      // (an agent's included), the order every definition writer keeps.
      const readAt = await lockRepinSubjects(
        tx,
        uses.workflows.map((w) => w.id)
      );
      for (const agent of uses.agents) {
        // Exactly the binding read above: an agent moved off the model since
        // is left as its editor left it, with no version written for it.
        const still = await tx.aiAgent.findFirst({
          where: {
            id: agent.id,
            ...orgWhere(pass),
            provider: target.model.providerSlug,
            model: target.model.modelId,
            deletedAt: null,
          },
          select: { id: true },
        });
        if (!still) continue;
        await ensureBaselineVersion(tx, agent.id, actor.userId);
        const changed = await tx.aiAgent.updateMany({
          where: {
            id: agent.id,
            ...orgWhere(pass),
            provider: target.model.providerSlug,
            model: target.model.modelId,
            deletedAt: null,
          },
          data: { model: target.replacement.modelId },
        });
        if (changed.count === 0) continue;
        const version = await recordAgentVersion(tx, agent.id, {
          label,
          createdBy: actor.userId,
        });
        writes.agents.push({ id: agent.id, name: agent.name, version });
      }
      for (const workflow of uses.workflows) {
        const at = readAt.get(workflow.id);
        if (at === undefined) continue; // deleted since it was read
        const result = await repinWorkflow({
          tx,
          workflowId: workflow.id,
          readAt: at,
          rewrite: (definition) => repinDefinition(definition, pins).definition,
          changeSummary: label,
          userId: actor.userId,
        });
        if (result.refused) {
          logger.warn('Model move: a workflow was left', {
            orgId: pass.orgId,
            workflowId: workflow.id,
            reason: result.refused,
          });
          writes.refused.push({ workflowId: workflow.id, stepId: '', reason: 'published_invalid' });
          continue;
        }
        if (result.draftChanged || result.published) {
          writes.workflows.push({
            id: workflow.id,
            name: workflow.name,
            draftChanged: result.draftChanged,
            published: result.published,
          });
        }
      }
      return writes;
    },
    // It may first wait on an erasure holding a subject's lock for up to the
    // writers' allowance (`WRITER_TRANSACTION_OPTIONS`), then version a batch.
    { timeout: WRITER_TRANSACTION_OPTIONS.timeout + AGENT_BATCH_TRANSACTION_TIMEOUT_MS }
  );
}

/** The audit rows for one org's writes, in that org (the caller is inside its scope). */
function auditOrg(target: MoveTarget, writes: OrgWrites, actor: MoveActor): void {
  const metadata = {
    providerModelId: target.model.id,
    replacementId: target.replacement.id,
    via: 'model_move',
  };
  for (const agent of writes.agents) {
    logAdminAction({
      userId: actor.userId,
      action: 'agent.model_moved',
      entityType: 'agent',
      entityId: agent.id,
      entityName: agent.name,
      changes: { model: { from: target.model.modelId, to: target.replacement.modelId } },
      metadata: { ...metadata, version: agent.version },
      clientIp: actor.clientIp,
    });
  }
  for (const workflow of writes.workflows) {
    logAdminAction({
      userId: actor.userId,
      action: 'workflow.model_moved',
      entityType: 'workflow',
      entityId: workflow.id,
      entityName: workflow.name,
      changes: workflow.published ? { publishedVersion: workflow.published } : null,
      metadata: { ...metadata, draftChanged: workflow.draftChanged },
      clientIp: actor.clientIp,
    });
  }
}

/** Move one org: test its own key, then its agents and workflows, in its scope. */
async function moveOrg(
  pass: OrgPass,
  target: MoveTarget,
  config: Awaited<ReturnType<typeof providerConfigFor>>,
  actor: MoveActor
): Promise<OrgMoveResult | null> {
  return inOrg(pass, async () => {
    const uses = await readOrgUses(pass, target);
    if (!usesSomething(uses)) return null;
    const base = {
      orgId: pass.orgId,
      name: pass.name,
      left: countLeft(uses.left),
      agentsFollowingPlatform: uses.followingPlatform,
    };
    if (uses.agents.length + uses.workflows.length === 0) {
      return { ...base, status: 'left', agents: 0, workflows: 0 };
    }
    let problem: string | null;
    try {
      problem = await ownKeyProblem(pass, target, config);
    } catch (err) {
      logger.warn('Model move: an org’s own key could not be read', {
        orgId: pass.orgId,
        error: describeError(err),
      });
      problem = 'Its own key for this provider could not be read, so it could not be tested.';
    }
    if (problem) return { ...base, status: 'skipped', reason: problem, agents: 0, workflows: 0 };
    let writes: OrgWrites;
    try {
      writes = await writeOrg(pass, target, uses, actor);
    } catch (err) {
      logger.error('Model move: an org’s changes were rolled back', undefined, {
        orgId: pass.orgId,
        providerModelId: target.model.id,
        error: describeError(err),
      });
      return { ...base, status: 'failed', reason: failureReason(err), agents: 0, workflows: 0 };
    }
    auditOrg(target, writes, actor);
    const moved = writes.agents.length + writes.workflows.length;
    return {
      ...base,
      left: countLeft([...writes.refused, ...uses.left]),
      status: moved > 0 ? 'moved' : 'left',
      agents: writes.agents.length,
      workflows: writes.workflows.length,
    };
  });
}

/**
 * Write the install settings' moved slots. The task defaults are merged into
 * what is stored, as the settings route merges a save, and only the slots
 * the plan names change; a slot changed since the plan was made is left and
 * reported (`changed_since`).
 */
async function moveSettings(
  target: MoveTarget,
  plan: SettingsMovePlan,
  actor: MoveActor
): Promise<SettingsMovePlan> {
  if (plan.moved.length === 0) return plan;
  const written = await prisma.$transaction(async (tx) => {
    // Locked, so a settings save cannot commit between this read and the
    // write below and be overwritten by it.
    await lockSettingsRow(tx, 'global');
    const row = await tx.aiOrchestrationSettings.findUnique({ where: { slug: 'global' } });
    if (!row)
      return {
        done: [],
        changed: plan.moved.map((m) => ({ slot: m.slot, reason: 'changed_since' as const })),
      };
    const stored = parseStoredDefaults(row.defaultModels);
    const defaults: Partial<Record<TaskType, string>> = { ...stored };
    let confidential: string | null = null;
    const done: SettingsMovePlan['moved'] = [];
    const changed: SettingsMovePlan['left'] = [];
    for (const slot of plan.moved) {
      if (slot.slot === 'confidential') {
        if (
          row.confidentialModelProvider === target.model.providerSlug &&
          row.confidentialModel === slot.from
        ) {
          confidential = slot.to;
          done.push(slot);
        } else {
          changed.push({ slot: slot.slot, reason: 'changed_since' });
        }
        continue;
      }
      if (slot.slot === 'active_embedding') continue;
      // A saved slot must still hold what the plan read; a suggested one must
      // still be unsaved.
      const now = stored[slot.slot];
      if (slot.source === 'saved' ? now !== slot.from : now !== undefined && now !== '') {
        changed.push({ slot: slot.slot, reason: 'changed_since' });
        continue;
      }
      defaults[slot.slot] = slot.to;
      done.push(slot);
    }
    if (done.length === 0) return { done, changed };
    await tx.aiOrchestrationSettings.update({
      where: { slug: 'global' },
      data: {
        defaultModels: defaults,
        ...(confidential !== null ? { confidentialModel: confidential } : {}),
      },
    });
    return { done, changed };
  });
  invalidateSettingsCache();
  invalidateOrchestrationSettingsCache();
  if (written.done.length > 0) {
    logAdminAction({
      userId: actor.userId,
      action: 'settings.model_moved',
      entityType: 'settings',
      entityId: 'global',
      changes: Object.fromEntries(written.done.map((s) => [s.slot, { from: s.from, to: s.to }])),
      metadata: { providerModelId: target.model.id, replacementId: target.replacement.id },
      clientIp: actor.clientIp,
    });
  }
  return { moved: written.done, left: [...plan.left, ...written.changed] };
}

/**
 * Move every use of `target.model` to `target.replacement`: the install
 * settings, then each active org's agents and workflows, one org at a time in
 * its own scope and its own transaction. See the module header.
 */
export async function moveModelUses(
  target: MoveTarget,
  actor: MoveActor
): Promise<ModelMoveResult> {
  const [{ passes, suspended }, config] = await Promise.all([
    orgPasses(),
    providerConfigFor(target.model.providerSlug),
  ]);
  // The install settings first: one quick write, which then holds even if a
  // long walk over the orgs is cut off.
  const settings = await moveSettings(target, await settingsPlan(target), actor);
  const orgs: OrgMoveResult[] = [];
  for (const pass of passes) {
    const result = await moveOrg(pass, target, config, actor);
    if (result) orgs.push(result);
  }
  const totals = {
    agents: orgs.reduce((n, o) => n + o.agents, 0),
    workflows: orgs.reduce((n, o) => n + o.workflows, 0),
    settings: settings.moved.length,
    skipped: orgs.filter((o) => o.status === 'skipped').length,
    failed: orgs.filter((o) => o.status === 'failed').length,
  };
  logAdminAction({
    userId: actor.userId,
    action: 'provider_model.uses_moved',
    entityType: 'provider_model',
    entityId: target.model.id,
    entityName: target.model.name,
    metadata: {
      replacementId: target.replacement.id,
      replacementModelId: target.replacement.modelId,
      ...totals,
      suspendedOrgs: suspended,
      skippedOrgs: orgs
        .filter((o) => o.status === 'skipped' || o.status === 'failed')
        .map((o) => ({ orgId: o.orgId, status: o.status, reason: o.reason })),
    },
    clientIp: actor.clientIp,
  });
  return { ...modelSummary(target), orgs, settings, suspendedOrgs: suspended, totals };
}
