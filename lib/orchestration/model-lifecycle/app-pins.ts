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
 *   the preview shows it.
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
 * A reporter is informational, so its failure degrades: the finder and the
 * preview say the app's uses could not be read, and are otherwise as before.
 *
 * With nothing registered nothing here runs: no org is entered and every
 * answer is empty, so the finder and the move behave as they did before this
 * seam existed.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { z } from 'zod';

import { initAppModelPins } from '@/lib/app/model-pins';
import { createAppInitGate } from '@/lib/fork-init';
import { logger } from '@/lib/logging';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { getTenantContext, isMultiTenant, listActiveOrgIds, runAsOrg } from '@/lib/tenancy/context';
import { withTimeout } from '@/lib/utils/with-timeout';

/** How long one org's report may take before it counts as failed. */
export const APP_MODEL_PIN_REPORT_TIMEOUT_MS = 10_000;
/** How long the check may take before it counts as a refusal. */
export const APP_MODEL_MOVE_CHECK_TIMEOUT_MS = 120_000;
/** Orgs asked for their report at once. */
const REPORT_CONCURRENCY = 8;
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
  /** Aborts when the report runs out of time. */
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

/** What the check is asked. */
export interface AppModelMoveCheckRequest {
  model: AppPinModel;
  replacement: AppPinModel;
  /** Every org's reported pins; empty with no reporter. */
  pins: readonly ReportedAppModelPin[];
  /** Aborts when the check runs out of time. */
  signal: AbortSignal;
}

export type AppModelMoveCheckAnswer = { allow: true } | { allow: false; reason: string };

export type AppModelMoveCheck = (
  request: AppModelMoveCheckRequest
) => AppModelMoveCheckAnswer | Promise<AppModelMoveCheckAnswer>;

/** App code's output: validated, not trusted. */
const pinsSchema = z
  .array(
    z.object({
      label: z.string().trim().min(1).max(200),
      where: z.string().trim().min(1).max(500),
    })
  )
  .max(MAX_PINS_PER_ORG);

const answerSchema = z.discriminatedUnion('allow', [
  z.object({ allow: z.literal(true) }),
  z.object({ allow: z.literal(false), reason: z.string().trim().min(1).max(1_000) }),
]);

let reporter: AppModelPinReporter | null = null;
let check: AppModelMoveCheck | null = null;
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
 * Run the fork's init once, lazily, before the first read — see
 * `lib/fork-init.ts`. Rolled back on a throw (both holders), and latched as
 * failed, which refuses every move.
 */
const appInit = createAppInitGate({
  label: 'model-pins: initAppModelPins',
  subject: 'app model pins',
  init: initAppModelPins,
  snapshot: () => ({ reporter, check }),
  restore: (before) => {
    reporter = before.reporter;
    check = before.check;
  },
  onFailure: () => {
    initFailed = true;
  },
});

/** What the app registered. Runs the fork's init first. */
export function appModelPinsRegistered(): { reporter: boolean; check: boolean; failed: boolean } {
  appInit.ensure();
  return { reporter: reporter !== null, check: check !== null, failed: initFailed };
}

/** Test-only: forget what was registered and re-arm the one-shot init. */
export function __resetAppModelPinsForTests(): void {
  reporter = null;
  check = null;
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
 * The orgs whose pins a read covers. Every active org at `multi` when
 * `acrossOrgs`, else the entered org alone (none when no org is entered); the
 * install org at `single`, where every row is the install's.
 */
async function orgsToAsk(acrossOrgs: boolean): Promise<string[]> {
  if (!isMultiTenant()) return [INSTALL_ORG_ID];
  if (acrossOrgs) return listActiveOrgIds();
  const current = getTenantContext()?.orgId;
  return current ? [current] : [];
}

async function reportOne(
  ask: AppModelPinReporter,
  model: AppPinModel,
  orgId: string
): Promise<ReportedAppModelPin[] | null> {
  const run = () =>
    withTimeout(APP_MODEL_PIN_REPORT_TIMEOUT_MS, 'model-pin reporter', (signal) =>
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
    logger.error('App model-pin reporter gave no usable answer', {
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
 * The app's uses of `model`, in every active org by default, or in the
 * caller's org alone with `acrossOrgs: false` (as `providerModelUsage`'s
 * option). Each org is asked inside its own scope. With no reporter
 * registered nothing is asked and the report is empty.
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
  for (let i = 0; i < orgIds.length; i += REPORT_CONCURRENCY) {
    const batch = await Promise.all(
      orgIds.slice(i, i + REPORT_CONCURRENCY).map((orgId) => reportOne(ask, model, orgId))
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
  report: AppModelPinReport
): Promise<AppMoveVerdict> {
  appInit.ensure();
  if (initFailed) return { allowed: false, reason: INIT_FAILED_REASON };
  const ask = check;
  if (!ask) return { allowed: true };
  if (report.failed) return { allowed: false, reason: REPORT_FAILED_REASON };
  const log = { providerModelId: model.id, replacementId: replacement.id };
  let raw: unknown;
  try {
    raw = await withTimeout(APP_MODEL_MOVE_CHECK_TIMEOUT_MS, 'model-move check', (signal) =>
      Promise.resolve(ask({ model, replacement, pins: report.pins, signal }))
    );
  } catch (error) {
    logger.error('App model-move check failed; the move is refused', error, log);
    return { allowed: false, reason: CHECK_FAILED_REASON };
  }
  const parsed = answerSchema.safeParse(raw);
  if (!parsed.success) {
    logger.error('App model-move check gave no usable answer; the move is refused', {
      ...log,
      answered: raw === null || raw === undefined ? String(raw) : typeof raw,
    });
    return { allowed: false, reason: CHECK_FAILED_REASON };
  }
  if (parsed.data.allow) return { allowed: true };
  logger.info('App model-move check refused the move', { ...log, reason: parsed.data.reason });
  return { allowed: false, reason: parsed.data.reason };
}
