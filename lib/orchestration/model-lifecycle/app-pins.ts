/**
 * An app's own model pins, and its say over a model move (§136 t-1067).
 *
 * An app built on Sunrise may name models in its own code and tables, which
 * Sunrise cannot read. Without this the uses finder under-reports, and a move
 * switches the platform's uses while the app's still name the retiring model.
 * An app may also need to vet a replacement before anything moves (run its
 * evaluations against it, say).
 *
 * So an app registers, from `initAppModelPins()` in `lib/app/model-pins.ts`:
 *
 * - **a reporter**, asked once per org, inside that org's scope, for the
 *   app's uses of a model. They appear in the finder (`modelUses`), the
 *   delete check and config health, and in the move's preview. Sunrise never
 *   writes them: the app moves its own pins itself.
 * - **a check**, asked with the model, the replacement and every org's
 *   reported pins before a move. It allows the move or refuses it with a
 *   reason. A refusal stops the whole move before anything is written, and
 *   the preview shows it. It is told which (`phase`): the preview asks on
 *   every replacement an admin picks, so it should answer from what is known.
 * - **a mover** (t-1088), asked once per org the move enters, inside that
 *   org's scope and the org's own transaction (`tx`), to move the app's pins
 *   to the replacement with its own code. It runs after the move has taken
 *   erasure's locks for the org and before any row is written, so the org's
 *   app pins, agents and workflows move together or not at all. It answers
 *   what it moved and what it left. Sunrise still never writes an app's pins
 *   itself: with no mover the app moves them after the move.
 *
 * ## Failure
 *
 * The check fails closed: one that throws, runs past
 * {@link APP_MODEL_MOVE_CHECK_TIMEOUT_MS} or answers nothing usable refuses
 * the move, because the app asked to be consulted. So does an init that
 * throws (rolled back: nothing it registered is kept), since what it meant to
 * register cannot be known, and a reporter that fails while a check is
 * registered, since the check cannot then be asked honestly.
 *
 * The mover fails closed too: one that throws, runs past
 * {@link APP_MODEL_PIN_MOVE_TIMEOUT_MS} or answers nothing usable fails its
 * org's transaction ({@link AppModelPinMoveError}), so nothing in that org
 * moves, and the move reports the org failed and goes on to the next.
 *
 * A reporter is informational, so with no check registered its failure does
 * not refuse a move: the finder and the preview say the app's uses could not
 * be read (`failed`). Its readers decide the rest: the model's delete, which
 * cannot be undone, refuses, and config health's retiring-model checks report
 * that they could not run.
 *
 * With nothing registered nothing here runs: no org is entered and every
 * answer is empty, so the finder and the move behave as they did before this
 * seam existed.
 *
 * Platform-agnostic: no Next.js imports.
 */

import type { Prisma } from '@prisma/client';
import { z } from 'zod';

import { initAppModelPins } from '@/lib/app/model-pins';
import { createAppInitGate } from '@/lib/fork-init';
import { logger } from '@/lib/logging';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { prisma } from '@/lib/db/client';
import { getTenantContext, isMultiTenant, runAsOrg } from '@/lib/tenancy/context';
import { withTimeout } from '@/lib/utils/with-timeout';

/** How long one org's report may take before it counts as failed. */
export const APP_MODEL_PIN_REPORT_TIMEOUT_MS = 10_000;
/**
 * How long one report over every org may take in all. An org not answered
 * by then counts as failed, so a slow reporter delays a page by this much at
 * most, however many orgs there are.
 */
export const APP_MODEL_PIN_REPORT_BUDGET_MS = 20_000;
/** How long the check may take before it counts as a refusal. */
export const APP_MODEL_MOVE_CHECK_TIMEOUT_MS = 120_000;
/**
 * How long the mover may take in one org. It runs inside the org's
 * transaction, whose timeout allows for it (`move.ts`).
 */
export const APP_MODEL_PIN_MOVE_TIMEOUT_MS = 30_000;
/**
 * Orgs asked for their report at once: well under the database pool, since a
 * reporter that ignores its signal keeps its connection after its timeout.
 */
const REPORT_CONCURRENCY = 4;
/** The most pins one org's report may hold; more is a reporter bug. */
const MAX_PINS_PER_ORG = 1_000;

/** A catalogue model, as the reporter and the check are told it. */
export interface AppPinModel {
  /** The catalogue row's id. */
  id: string;
  name: string;
  providerSlug: string;
  modelId: string;
}

/** What the reporter is asked. */
export interface AppModelPinQuery {
  model: AppPinModel;
  /** The org whose pins to report: the scope the reporter runs in. */
  orgId: string;
  /**
   * Aborts when the report runs out of time. Honour it (pass it to your
   * queries or stop on it): Sunrise stops waiting either way, but a reporter
   * that runs on holds its database connection.
   */
  signal: AbortSignal;
}

/** One of the app's uses of a model, as its reporter answers it. */
export interface AppModelPin {
  /** What uses it, as an admin would name it: "Panel: Contract review". */
  label: string;
  /** Where it is set, so an admin can find it: "Panels › Contract review › Judge". */
  where: string;
}

/** A pin with the org whose report it came from, stamped by Sunrise. */
export interface ReportedAppModelPin extends AppModelPin {
  orgId: string;
}

export type AppModelPinReporter = (
  query: AppModelPinQuery
) => readonly AppModelPin[] | Promise<readonly AppModelPin[]>;

/** When the check is asked. */
export type AppModelMovePhase = 'preview' | 'move';

/** What the check is asked. */
export interface AppModelMoveCheckRequest {
  model: AppPinModel;
  replacement: AppPinModel;
  /** Every org's reported pins; empty with no reporter. */
  pins: readonly ReportedAppModelPin[];
  /**
   * `preview` while an admin is looking at the move, asked each time they
   * pick a replacement, so answer from what is already known rather than run
   * anything slow or billed; `move` once, just before the move writes. The
   * move's request has 300 seconds in all, this check included.
   */
  phase: AppModelMovePhase;
  /** Aborts when the check runs out of time. */
  signal: AbortSignal;
}

export type AppModelMoveCheckAnswer = { allow: true } | { allow: false; reason: string };

export type AppModelMoveCheck = (
  request: AppModelMoveCheckRequest
) => AppModelMoveCheckAnswer | Promise<AppModelMoveCheckAnswer>;

/** What the mover is asked. */
export interface AppModelPinMoveRequest {
  model: AppPinModel;
  replacement: AppPinModel;
  /** The org whose pins to move: the scope the mover runs in. */
  orgId: string;
  /**
   * The org's transaction. Write through it, so your pins move with the
   * org's agents and workflows or not at all; a write through `prisma`
   * outside it is not rolled back with the org. Erasure's locks for the
   * people the move's own rows name are already held; if your rows name
   * someone else, take their lock (`lockSubjects` in
   * `lib/privacy/erased-subjects.ts`) before your first write.
   */
  tx: Prisma.TransactionClient;
  /** Aborts when the mover runs out of time. Stop on it: the org is rolled back either way. */
  signal: AbortSignal;
}

/** A pin the mover left on the model, and why. */
export interface AppModelPinLeft extends AppModelPin {
  reason: string;
}

/** What the mover answers: the pins it moved, and any it left. */
export interface AppModelPinMoveAnswer {
  moved: readonly AppModelPin[];
  left?: readonly AppModelPinLeft[];
}

export type AppModelPinMover = (
  request: AppModelPinMoveRequest
) => AppModelPinMoveAnswer | Promise<AppModelPinMoveAnswer>;

/** App code's output: validated, not trusted. */
const pinSchema = z.object({
  label: z.string().trim().min(1).max(200),
  where: z.string().trim().min(1).max(500),
});

const pinsSchema = z.array(pinSchema).max(MAX_PINS_PER_ORG);

/**
 * Not capped like a report: the mover's writes have already happened in the
 * org's transaction, so a cap would roll back a move that worked, and fail
 * the same way on every retry. The counts are kept whole; the audit names
 * only the first few (`move.ts`).
 */
const moveAnswerSchema = z.object({
  moved: z.array(pinSchema),
  left: z.array(pinSchema.extend({ reason: z.string().trim().min(1).max(500) })).optional(),
});

const answerSchema = z.discriminatedUnion('allow', [
  z.object({ allow: z.literal(true) }),
  z.object({ allow: z.literal(false), reason: z.string().trim().min(1).max(1_000) }),
]);

let reporter: AppModelPinReporter | null = null;
let check: AppModelMoveCheck | null = null;
let mover: AppModelPinMover | null = null;
let initFailed = false;

/**
 * Register the app's reporter. Call it inside `initAppModelPins()`;
 * registering twice replaces the first.
 */
export function registerModelPinReporter(next: AppModelPinReporter): void {
  reporter = next;
}

/**
 * Register the app's pre-move check. Call it inside `initAppModelPins()`;
 * registering twice replaces the first.
 */
export function registerModelMoveCheck(next: AppModelMoveCheck): void {
  check = next;
}

/**
 * Register the app's mover. Call it inside `initAppModelPins()`; registering
 * twice replaces the first.
 */
export function registerModelPinMover(next: AppModelPinMover): void {
  mover = next;
}

/**
 * Run the fork's init once, lazily, before the first read — see
 * `lib/fork-init.ts`. Rolled back on a throw (both holders), and latched as
 * failed, which refuses every move.
 */
const appInit = createAppInitGate({
  label: 'model-pins: initAppModelPins',
  subject: 'app model pins',
  init: initAppModelPins,
  snapshot: () => ({ reporter, check, mover }),
  restore: (before) => {
    reporter = before.reporter;
    check = before.check;
    mover = before.mover;
  },
  onFailure: () => {
    initFailed = true;
  },
});

/** What the app registered. Runs the fork's init first. */
export function appModelPinsRegistered(): {
  reporter: boolean;
  check: boolean;
  mover: boolean;
  failed: boolean;
} {
  appInit.ensure();
  return {
    reporter: reporter !== null,
    check: check !== null,
    mover: mover !== null,
    failed: initFailed,
  };
}

/** Test-only: forget what was registered and re-arm the one-shot init. */
export function __resetAppModelPinsForTests(): void {
  reporter = null;
  check = null;
  mover = null;
  initFailed = false;
  appInit.reset();
}

/** The app's pins across the orgs asked. */
export interface AppModelPinReport {
  pins: ReportedAppModelPin[];
  /** Some org's report failed (or the init did): the list may be short. */
  failed: boolean;
}

/**
 * The orgs whose pins a read covers. Every org at `multi` when `acrossOrgs`,
 * suspended ones too, as `providerModelUsage` counts every org's agents: an
 * org suspended today may be back, still naming the model, after a delete.
 * Else the entered org alone (none when no org is entered); the install org at
 * `single`, where every row is the install's.
 */
async function orgsToAsk(acrossOrgs: boolean): Promise<string[]> {
  if (!isMultiTenant()) return [INSTALL_ORG_ID];
  if (acrossOrgs) {
    const orgs = await prisma.org.findMany({ select: { id: true }, orderBy: { createdAt: 'asc' } });
    return orgs.map((org) => org.id);
  }
  const current = getTenantContext()?.orgId;
  return current ? [current] : [];
}

async function reportOne(
  ask: AppModelPinReporter,
  model: AppPinModel,
  orgId: string,
  timeoutMs: number
): Promise<ReportedAppModelPin[] | null> {
  const run = () =>
    withTimeout(timeoutMs, 'model-pin reporter', (signal) =>
      Promise.resolve(ask({ model, orgId, signal }))
    );
  let raw: unknown;
  try {
    raw = await (isMultiTenant() ? runAsOrg(orgId, run, { source: 'job' }) : run());
  } catch (error) {
    logger.error('App model-pin reporter failed', error, { orgId, providerModelId: model.id });
    return null;
  }
  const parsed = pinsSchema.safeParse(raw);
  if (!parsed.success) {
    logger.error('App model-pin reporter gave no usable answer', undefined, {
      orgId,
      providerModelId: model.id,
      issues: parsed.error.issues.slice(0, 5).map((issue) => issue.message),
    });
    return null;
  }
  // The org is Sunrise's to stamp: a pin is the org's whose scope reported it.
  return parsed.data.map((pin) => ({ ...pin, orgId }));
}

/**
 * The app's uses of `model`, in every org by default (suspended ones too), or in the
 * caller's org alone with `acrossOrgs: false` (as `providerModelUsage`'s
 * option). Each org is asked inside its own scope, four at a time, each for
 * at most {@link APP_MODEL_PIN_REPORT_TIMEOUT_MS} and all of them within
 * {@link APP_MODEL_PIN_REPORT_BUDGET_MS}: an org not answered in time counts
 * as failed. With no reporter registered nothing is asked and the report is
 * empty.
 */
export async function reportAppModelPins(
  model: AppPinModel,
  options: { acrossOrgs?: boolean } = {}
): Promise<AppModelPinReport> {
  appInit.ensure();
  const ask = reporter;
  if (!ask) return { pins: [], failed: initFailed };
  const orgIds = await orgsToAsk(options.acrossOrgs !== false);
  const pins: ReportedAppModelPin[] = [];
  let failed = false;
  const deadline = Date.now() + APP_MODEL_PIN_REPORT_BUDGET_MS;
  for (let i = 0; i < orgIds.length; i += REPORT_CONCURRENCY) {
    const left = deadline - Date.now();
    if (left <= 0) {
      logger.error(
        'App model-pin report ran out of time; the rest of the orgs were not asked',
        undefined,
        {
          providerModelId: model.id,
          notAsked: orgIds.length - i,
        }
      );
      failed = true;
      break;
    }
    const timeoutMs = Math.min(APP_MODEL_PIN_REPORT_TIMEOUT_MS, left);
    const batch = await Promise.all(
      orgIds
        .slice(i, i + REPORT_CONCURRENCY)
        .map((orgId) => reportOne(ask, model, orgId, timeoutMs))
    );
    for (const result of batch) {
      if (result) pins.push(...result);
      else failed = true;
    }
  }
  return { pins, failed };
}

/** The check's verdict on a move. */
export type AppMoveVerdict = { allowed: true } | { allowed: false; reason: string };

const INIT_FAILED_REASON =
  'The app’s model-pin setup failed to load, so it could not be asked about this move. Nothing was moved; see the server log.';
const REPORT_FAILED_REASON =
  'The app’s own uses of this model could not all be read, so its check could not be asked honestly. Nothing was moved; see the server log.';
const CHECK_FAILED_REASON =
  'The app’s check on this move failed. Nothing was moved; see the server log.';

/**
 * Ask the app whether `model`'s uses may move to `replacement`, given the
 * report from {@link reportAppModelPins}. Allowed when no check is registered
 * (and the init did not fail). Fails closed — see the module header. Runs in
 * the caller's scope.
 */
export async function checkAppModelMove(
  model: AppPinModel,
  replacement: AppPinModel,
  report: AppModelPinReport,
  phase: AppModelMovePhase
): Promise<AppMoveVerdict> {
  appInit.ensure();
  if (initFailed) return { allowed: false, reason: INIT_FAILED_REASON };
  const ask = check;
  if (!ask) return { allowed: true };
  if (report.failed) return { allowed: false, reason: REPORT_FAILED_REASON };
  const log = { providerModelId: model.id, replacementId: replacement.id, phase };
  let raw: unknown;
  try {
    raw = await withTimeout(APP_MODEL_MOVE_CHECK_TIMEOUT_MS, 'model-move check', (signal) =>
      Promise.resolve(ask({ model, replacement, pins: report.pins, phase, signal }))
    );
  } catch (error) {
    logger.error('App model-move check failed; the move is refused', error, log);
    return { allowed: false, reason: CHECK_FAILED_REASON };
  }
  const parsed = answerSchema.safeParse(raw);
  if (!parsed.success) {
    logger.error('App model-move check gave no usable answer; the move is refused', undefined, {
      ...log,
      answered: raw === null || raw === undefined ? String(raw) : typeof raw,
    });
    return { allowed: false, reason: CHECK_FAILED_REASON };
  }
  if (parsed.data.allow) return { allowed: true };
  logger.info('App model-move check refused the move', { ...log, reason: parsed.data.reason });
  return { allowed: false, reason: parsed.data.reason };
}

// ── The mover (t-1088) ──────────────────────────────────────────────────────

/**
 * The mover failed in an org: thrown inside the org's transaction, so the
 * org rolls back. Its message is Sunrise's, safe to show an admin.
 */
export class AppModelPinMoveError extends Error {
  constructor() {
    super('The app’s own uses in it could not be moved. Nothing in it moved.');
    this.name = 'AppModelPinMoveError';
  }
}

/** What the mover did in one org, as validated. */
export interface AppModelPinMoveResult {
  moved: AppModelPin[];
  left: AppModelPinLeft[];
}

/**
 * Ask the app's mover to move its pins in `orgId`, through `tx`, the org's
 * transaction. `null` when no mover is registered. Runs in the caller's
 * scope (the org's). Fails closed: a mover that throws, runs past
 * {@link APP_MODEL_PIN_MOVE_TIMEOUT_MS} or answers nothing usable throws
 * {@link AppModelPinMoveError}, which rolls the org back.
 */
export async function moveAppModelPins(
  tx: Prisma.TransactionClient,
  model: AppPinModel,
  replacement: AppPinModel,
  orgId: string
): Promise<AppModelPinMoveResult | null> {
  appInit.ensure();
  const move = mover;
  if (!move) return null;
  const log = { orgId, providerModelId: model.id, replacementId: replacement.id };
  let raw: unknown;
  try {
    raw = await withTimeout(APP_MODEL_PIN_MOVE_TIMEOUT_MS, 'model-pin mover', (signal) =>
      Promise.resolve(move({ model, replacement, orgId, tx, signal }))
    );
  } catch (error) {
    logger.error('App model-pin mover failed; the org is rolled back', error, log);
    throw new AppModelPinMoveError();
  }
  const parsed = moveAnswerSchema.safeParse(raw);
  if (!parsed.success) {
    logger.error('App model-pin mover gave no usable answer; the org is rolled back', undefined, {
      ...log,
      issues: parsed.error.issues.slice(0, 5).map((issue) => issue.message),
    });
    throw new AppModelPinMoveError();
  }
  return { moved: parsed.data.moved, left: parsed.data.left ?? [] };
}
