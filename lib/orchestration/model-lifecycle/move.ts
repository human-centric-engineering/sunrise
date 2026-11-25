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
 * fail after the move. So before anything moves, every org's key for the
 * provider is tested against the replacement (`testProviderKeyOnModel`), and
 * an org whose test fails is skipped with the reason. The install settings
 * are then left too: an agent with no model of its own follows them, in that
 * org as in any other. No org is skipped for policy: a
 * same-provider move never changes which providers an org may use. The test is
 * run by the move, not the preview, since it is billed to the org's key.
 *
 * ## The app's own pins and its check (§136 t-1067)
 *
 * An app may report the models it names itself, and register a check on a
 * move (`app-pins.ts`, the `lib/app/model-pins.ts` seam). The preview counts
 * the app's pins per org and shows the check's verdict. The move asks the
 * check again, first of all, and a refusal throws `ConflictError` with the
 * app's reason before any key is tested or anything is written. Sunrise never
 * writes the app's pins itself. An app that registers a mover (t-1088) moves
 * them in each org's transaction, with its own code, after the org's erasure
 * locks and before any row is written: a mover that fails rolls its org back
 * like any other failure there. With a mover an org with no platform use is
 * entered for it too, unless the app's reporter counted no pins there.
 *
 * ## The audit trail
 *
 * One row per agent and per workflow moved, in its org, written once the org
 * commits; one for the settings; and one summary row for the move, in the
 * caller's scope, naming the moved, skipped and failed counts.
 *
 * Platform-agnostic: no Next.js imports.
 */

import {
  APIError,
  ConflictError,
  NotFoundError,
  StaleRecordError,
  ValidationError,
} from '@/lib/api/errors';
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
import {
  APP_MODEL_PIN_MOVE_TIMEOUT_MS,
  AppModelPinMoveError,
  appModelPinsRegistered,
  checkAppModelMove,
  moveAppModelPins,
  reportAppModelPins,
  type AppModelMovePhase,
  type AppModelPinReport,
  type AppMoveVerdict,
  type AppModelPinMoveResult,
  type AppPinModel,
} from '@/lib/orchestration/model-lifecycle/app-pins';
import { settingsPinsFor } from '@/lib/orchestration/model-lifecycle/settings-pins';
import { checkReplacement } from '@/lib/orchestration/model-lifecycle/state';
import {
  getOrchestrationSettings,
  hydrateSettings,
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

/** A catalogue row as the app's reporter and check are told it. */
function appPinModel(model: MoveModel): AppPinModel {
  return {
    id: model.id,
    name: model.name,
    providerSlug: model.providerSlug,
    modelId: model.modelId,
  };
}

/** The app's pins in every org, and its check's verdict on this move. */
async function askApp(target: MoveTarget, phase: AppModelMovePhase) {
  const report: AppModelPinReport = await reportAppModelPins(appPinModel(target.model));
  const verdict = await checkAppModelMove(
    appPinModel(target.model),
    appPinModel(target.replacement),
    report,
    phase
  );
  const perOrg = new Map<string, number>();
  for (const pin of report.pins) perOrg.set(pin.orgId, (perOrg.get(pin.orgId) ?? 0) + 1);
  return { report, verdict, perOrg };
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
  agents: Array<{ id: string; name: string; isActive: boolean; createdBy: string | null }>;
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
        createdBy: true,
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
    agents: moving.map(({ id, name, isActive, createdBy }) => ({ id, name, isActive, createdBy })),
    followingPlatform: agents.length - moving.length,
    workflows: [],
    left: [],
  };
  for (const w of workflows) {
    const draft = w.draftDefinition === null ? null : repinDefinition(w.draftDefinition, pins);
    const published = w.publishedVersion
      ? repinDefinition(w.publishedVersion.snapshot, pins)
      : null;
    // A step left in both the draft and the published version is one step,
    // matched by id; steps with no id are counted from whichever of the two
    // has more of them.
    const left = new Map<string, LeftReason>();
    const unnamed = [published?.left ?? [], draft?.left ?? []].map((ls) =>
      ls.filter((l) => l.stepId === '')
    );
    for (const l of [...(published?.left ?? []), ...(draft?.left ?? [])]) {
      if (l.stepId !== '') left.set(l.stepId, l.reason);
    }
    for (const [stepId, reason] of left) uses.left.push({ workflowId: w.id, stepId, reason });
    const moreUnnamed = unnamed[0].length >= unnamed[1].length ? unnamed[0] : unnamed[1];
    for (const l of moreUnnamed) uses.left.push({ workflowId: w.id, stepId: '', reason: l.reason });
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
  /**
   * The app's own uses in the org (§136 t-1067): its mover moves them in the
   * move when it registered one (`app.mover`), else the app moves them itself.
   */
  appPins: number;
}

/** What the app said about the move (§136 t-1067). */
export interface AppMovePreview {
  /** Some org's report of the app's uses failed: the counts may be short. */
  pinsUnavailable: boolean;
  /** Why the app refuses the move, or `null` when it allows it (or has no check). */
  refused: string | null;
  /** The app registered a mover (t-1088): its pins move with each org. */
  mover: boolean;
  /**
   * The mover may move pins the counts leave out: the app registered no
   * reporter, or its report failed. A move can then change something even
   * when every count here is zero.
   */
  uncounted: boolean;
}

/** What {@link previewModelMove} answers. */
export interface ModelMovePreview {
  model: { id: string; name: string; modelId: string; providerSlug: string };
  replacement: { id: string; name: string; modelId: string };
  /**
   * Active orgs with something that moves or is left, or with the app's own
   * uses (§136 t-1067; an org may be listed for those alone, with nothing to
   * move); an org using nothing is not listed.
   */
  orgs: OrgMovePreview[];
  settings: SettingsMovePlan;
  suspendedOrgs: number;
  sharedWith: string[];
  app: AppMovePreview;
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
  const [{ passes, suspended }, config, app] = await Promise.all([
    orgPasses(),
    providerConfigFor(target.model.providerSlug),
    askApp(target, 'preview'),
  ]);
  const orgs: OrgMovePreview[] = [];
  for (const pass of passes) {
    const appPins = app.perOrg.get(pass.orgId) ?? 0;
    const preview = await inOrg(pass, async () => {
      const uses = await readOrgUses(pass, target);
      if (!usesSomething(uses) && appPins === 0) return null;
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
        appPins,
      };
    });
    if (preview) orgs.push(preview);
  }
  const registered = appModelPinsRegistered();
  return {
    ...modelSummary(target),
    orgs,
    settings: await settingsPlan(target),
    suspendedOrgs: suspended,
    sharedWith: target.sharedWith,
    app: {
      pinsUnavailable: app.report.failed,
      refused: app.verdict.allowed ? null : app.verdict.reason,
      mover: registered.mover,
      uncounted: registered.mover && (!registered.reporter || app.report.failed),
    },
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
  /** What the app's mover moved and left in the org (t-1088); zero with no mover. */
  appPins: { moved: number; left: number };
}

/** What {@link moveModelUses} answers. */
export interface ModelMoveResult extends Pick<ModelMovePreview, 'model' | 'replacement'> {
  orgs: OrgMoveResult[];
  settings: SettingsMovePlan;
  suspendedOrgs: number;
  totals: {
    agents: number;
    workflows: number;
    settings: number;
    skipped: number;
    failed: number;
    /** App pins its mover moved, over every org (t-1088). */
    appPins: number;
  };
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
  if (err instanceof NotFoundError) {
    return 'One of its workflows was removed during the move, so nothing in it moved. Run the move again.';
  }
  if (err instanceof StaleRecordError) {
    return 'One of its workflows was changed during the move, so nothing in it moved. Run the move again.';
  }
  if (err instanceof APIError || err instanceof AppModelPinMoveError) return err.message;
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
  /** What the app's mover did in the org; `null` with no mover. */
  appPins: AppModelPinMoveResult | null;
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
      const writes: OrgWrites = { agents: [], refused: [], workflows: [], appPins: null };
      // Erasure's locks before any row lock (an agent's included), the order
      // every definition writer keeps: everyone the workflows name, the
      // creators of every row this writes (an erasure's delete cascades onto
      // them after it takes the person's lock), and the acting admin.
      const readAt = await lockRepinSubjects(
        tx,
        uses.workflows.map((w) => w.id),
        [actor.userId, ...uses.agents.flatMap((a) => (a.createdBy ? [a.createdBy] : []))]
      );
      // The app's pins next (t-1088): after erasure's locks, before any row
      // lock, so a mover that takes locks of its own keeps that order. A
      // mover that fails throws, and the org rolls back.
      writes.appPins = await moveAppModelPins(
        tx,
        appPinModel(target.model),
        appPinModel(target.replacement),
        pass.orgId
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
    // writers' allowance (`WRITER_TRANSACTION_OPTIONS`), then run the app's
    // mover, then version a batch.
    {
      timeout:
        WRITER_TRANSACTION_OPTIONS.timeout +
        APP_MODEL_PIN_MOVE_TIMEOUT_MS +
        AGENT_BATCH_TRANSACTION_TIMEOUT_MS,
    }
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
  const app = writes.appPins;
  if (app && app.moved.length + app.left.length > 0) {
    logAdminAction({
      userId: actor.userId,
      action: 'app.model_pins_moved',
      entityType: 'provider_model',
      entityId: target.model.id,
      entityName: target.model.name,
      changes: { model: { from: target.model.modelId, to: target.replacement.modelId } },
      metadata: {
        ...metadata,
        moved: app.moved.length,
        left: app.left.length,
        movedPins: app.moved.slice(0, AUDITED_APP_PINS),
        leftPins: app.left.slice(0, AUDITED_APP_PINS),
      },
      clientIp: actor.clientIp,
    });
  }
}

/** The most app pins one org's audit row names; the counts are always whole. */
const AUDITED_APP_PINS = 50;

/**
 * Whether the org's own key passes its test against the replacement: the
 * reason it fails, or `null` (no key for this provider, or it passes). In the
 * org's scope. A key that cannot be read fails, as one that cannot be tested.
 */
async function testOrgKey(
  pass: OrgPass,
  target: MoveTarget,
  config: Awaited<ReturnType<typeof providerConfigFor>>
): Promise<string | null> {
  return inOrg(pass, async () => {
    try {
      return await ownKeyProblem(pass, target, config);
    } catch (err) {
      logger.warn('Model move: an org’s own key could not be read', {
        orgId: pass.orgId,
        error: describeError(err),
      });
      return 'Its own key for this provider could not be read, so it could not be tested.';
    }
  });
}

const NO_APP_PINS = { moved: 0, left: 0 } as const;

/** What the move knows of the app in one org. */
interface OrgApp {
  /** The app registered a mover. */
  mover: boolean;
  /**
   * Pins its reporter counted in the org; `null` when that is not known (no
   * reporter, or its report failed).
   */
  reported: number | null;
}

/**
 * Move one org's agents and workflows, and the app's pins when it registered
 * a mover (`app.mover`), in its scope. `keyProblem` is why its own key failed
 * the test against the replacement ({@link testOrgKey}), which skips it.
 */
async function moveOrg(
  pass: OrgPass,
  target: MoveTarget,
  keyProblem: string | null,
  actor: MoveActor,
  app: OrgApp
): Promise<OrgMoveResult | null> {
  const appMover = app.mover;
  return inOrg(pass, async () => {
    const uses = await readOrgUses(pass, target);
    // With nothing of the platform's here, the org is entered only for the
    // mover, and not when its reporter counted none of the app's pins here:
    // a move enters only orgs with something to move, so its walk stays as
    // long as the uses. With the count unknown, the mover is asked.
    if (!usesSomething(uses) && (!appMover || app.reported === 0)) return null;
    const base = {
      orgId: pass.orgId,
      name: pass.name,
      left: countLeft(uses.left),
      agentsFollowingPlatform: uses.followingPlatform,
      appPins: NO_APP_PINS,
    };
    if (uses.agents.length + uses.workflows.length === 0 && !appMover) {
      return { ...base, status: 'left', agents: 0, workflows: 0 };
    }
    if (keyProblem) {
      // Listed as skipped: an org with nothing of the platform's here reaches
      // this only when the app may have pins here (counted, or not known).
      return { ...base, status: 'skipped', reason: keyProblem, agents: 0, workflows: 0 };
    }
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
    const appPins = writes.appPins
      ? { moved: writes.appPins.moved.length, left: writes.appPins.left.length }
      : NO_APP_PINS;
    const moved = writes.agents.length + writes.workflows.length + appPins.moved;
    // An org the mover had nothing in, and the platform nothing either, is
    // not listed, as before there was a mover.
    if (moved === 0 && appPins.left === 0 && !usesSomething(uses)) return null;
    return {
      ...base,
      left: countLeft([...writes.refused, ...uses.left]),
      status: moved > 0 ? 'moved' : 'left',
      agents: writes.agents.length,
      workflows: writes.workflows.length,
      appPins,
    };
  });
}

/**
 * Write the install settings' moved slots, planned from the row as read
 * under its lock, so neither a settings save nor this process's settings
 * cache can make it miss or overwrite a slot. The task defaults are merged
 * into what is stored, as the settings route merges a save.
 *
 * When some org's own key failed its test against the replacement
 * (`keyFailures` > 0), nothing is written: agents with no model of their own
 * follow these settings, so moving them would move that org's agents onto a
 * model its key cannot use. Every slot that would have moved is reported as
 * left (`own_key_refused`).
 */
async function moveSettings(
  target: MoveTarget,
  keyFailures: number,
  actor: MoveActor
): Promise<SettingsMovePlan> {
  const pins = movePins(target);
  const plan = await prisma.$transaction(async (tx) => {
    await lockSettingsRow(tx, 'global');
    const row = await tx.aiOrchestrationSettings.findUnique({ where: { slug: 'global' } });
    if (!row) return { moved: [], left: [] };
    const current = hydrateSettings(row);
    const planned = planSettingsMove(settingsPinsFor(target.model, current), current, pins);
    if (planned.moved.length === 0) return planned;
    if (keyFailures > 0) {
      return {
        moved: [],
        left: [
          ...planned.left,
          ...planned.moved.map((m) => ({ slot: m.slot, reason: 'own_key_refused' as const })),
        ],
      };
    }
    const defaults: Partial<Record<TaskType, string>> = parseStoredDefaults(row.defaultModels);
    let confidential: string | null = null;
    for (const slot of planned.moved) {
      if (slot.slot === 'confidential') confidential = slot.to;
      else if (slot.slot !== 'active_embedding') defaults[slot.slot] = slot.to;
    }
    await tx.aiOrchestrationSettings.update({
      where: { slug: 'global' },
      data: {
        defaultModels: defaults,
        ...(confidential !== null ? { confidentialModel: confidential } : {}),
      },
    });
    return planned;
  });
  invalidateSettingsCache();
  invalidateOrchestrationSettingsCache();
  if (plan.moved.length > 0) {
    logAdminAction({
      userId: actor.userId,
      action: 'settings.model_moved',
      entityType: 'settings',
      entityId: 'global',
      changes: Object.fromEntries(plan.moved.map((s) => [s.slot, { from: s.from, to: s.to }])),
      metadata: { providerModelId: target.model.id, replacementId: target.replacement.id },
      clientIp: actor.clientIp,
    });
  }
  return plan;
}

/**
 * Move every use of `target.model` to `target.replacement`: the install
 * settings, then each active org's agents and workflows, one org at a time in
 * its own scope and its own transaction. See the module header.
 *
 * @throws ConflictError when the app's check refuses the move (§136 t-1067),
 *   before anything is tested or written.
 */
export async function moveModelUses(
  target: MoveTarget,
  actor: MoveActor
): Promise<ModelMoveResult> {
  // The app first: a refusal stops the move before any key is billed or any
  // row is written. Its pins are read for its check, which they inform.
  const app = appModelPinsRegistered();
  // With a mover the report is read too (within its own 20-second budget):
  // an org with nothing on the model, the app's pins included, is then not
  // entered, and not listed as skipped for its key.
  const asked =
    app.check || app.failed || (app.mover && app.reporter) ? await askApp(target, 'move') : null;
  const verdict: AppMoveVerdict = asked?.verdict ?? { allowed: true };
  if (!verdict.allowed) {
    logger.warn('Model move refused by the app', {
      providerModelId: target.model.id,
      replacementId: target.replacement.id,
      userId: actor.userId,
    });
    throw new ConflictError(verdict.reason, { refusedBy: 'app' });
  }
  const [{ passes, suspended }, config] = await Promise.all([
    orgPasses(),
    providerConfigFor(target.model.providerSlug),
  ]);
  // Every org's own key first (§137), whether or not it uses the model
  // directly: its agents with no model of their own follow the settings.
  const keyProblems = new Map<string, string>();
  if (isMultiTenant() && config) {
    for (const pass of passes) {
      const problem = await testOrgKey(pass, target, config);
      if (problem) keyProblems.set(pass.orgId, problem);
    }
  }
  // The install settings next: one quick write, which then holds even if a
  // long walk over the orgs is cut off. Left when any org's key failed.
  const settings = await moveSettings(target, keyProblems.size, actor);
  const orgs: OrgMoveResult[] = [];
  for (const pass of passes) {
    const result = await moveOrg(pass, target, keyProblems.get(pass.orgId) ?? null, actor, {
      mover: app.mover,
      reported: asked && !asked.report.failed ? (asked.perOrg.get(pass.orgId) ?? 0) : null,
    });
    if (result) orgs.push(result);
  }
  const totals = {
    agents: orgs.reduce((n, o) => n + o.agents, 0),
    workflows: orgs.reduce((n, o) => n + o.workflows, 0),
    settings: settings.moved.length,
    skipped: orgs.filter((o) => o.status === 'skipped').length,
    failed: orgs.filter((o) => o.status === 'failed').length,
    appPins: orgs.reduce((n, o) => n + o.appPins.moved, 0),
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
        .filter((o) => o.status === 'skipped')
        .map((o) => ({ orgId: o.orgId, reason: o.reason })),
      failedOrgs: orgs
        .filter((o) => o.status === 'failed')
        .map((o) => ({ orgId: o.orgId, reason: o.reason })),
      // Every org whose key failed, those with nothing of their own to move
      // included: why the settings were left.
      keyFailedOrgs: [...keyProblems.keys()],
    },
    clientIp: actor.clientIp,
  });
  return { ...modelSummary(target), orgs, settings, suspendedOrgs: suspended, totals };
}
