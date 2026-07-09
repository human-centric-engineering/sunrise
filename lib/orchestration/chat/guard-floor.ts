/**
 * Guard-floor seam
 *
 * Lets a fork enforce a per-turn **minimum** mode for the three inline chat
 * guards (input / output / citation) without editing the guard sites. A
 * contributor keyed on the turn's `(contextType, contextId, agentId)` returns a
 * per-guard floor; the handler raises each guard to the strictest registered
 * floor before acting on it.
 *
 * **A floor only ever RAISES a guard, never lowers it.** Guard strictness is
 * ordered `none` < `log_only` < `warn_and_continue` < `block`, so the effective
 * mode is `max(resolved agent/global mode, strictest registered floor)`. An
 * empty registry leaves guard-mode resolution byte-for-byte unchanged. A
 * throwing contributor is caught and contributes nothing — a fork's policy bug
 * must never fail the chat turn.
 *
 * Pairs with a sibling post-detection observation seam (filed separately as
 * #414): a floor is a **pre-detection** input to how strictly a guard acts; an
 * event is a **post-detection** observation that a guard fired.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { logger } from '@/lib/logging';
import { initAppGuardFloorContributors } from '@/lib/app/guard-floor-contributors';

/** The three inline guards a floor can raise. */
export type GuardKind = 'input' | 'output' | 'citation';

/** Effective guard modes, least → most strict. `none` = the guard does nothing. */
export type GuardMode = 'none' | 'log_only' | 'warn_and_continue' | 'block';

/** A per-guard set of minimum modes. A guard absent from the map has no floor. */
export type GuardFloors = Partial<Record<GuardKind, GuardMode>>;

/** The turn identity a contributor keys its floor decision on. */
export interface GuardFloorRequest {
  contextType?: string;
  contextId?: string;
  agentId: string;
}

/**
 * Returns the per-guard minimums to enforce for this turn (or a subset). May be
 * async (e.g. a policy lookup). Absent guards / an empty object = no floor.
 */
export type GuardFloorContributor = (
  request: GuardFloorRequest
) => GuardFloors | Promise<GuardFloors>;

const GUARD_KINDS: readonly GuardKind[] = ['input', 'output', 'citation'];

const GUARD_MODE_RANK: Record<GuardMode, number> = {
  none: 0,
  log_only: 1,
  warn_and_continue: 2,
  block: 3,
};

function isGuardMode(value: unknown): value is GuardMode {
  return (
    value === 'none' || value === 'log_only' || value === 'warn_and_continue' || value === 'block'
  );
}

/**
 * Rank of a mode string. An unrecognised value ranks as `0` (least strict), so a
 * malformed resolved mode can only ever be RAISED by a floor, never used to
 * lower one — keeping the raise-only invariant literally true.
 */
function rank(mode: string): number {
  return isGuardMode(mode) ? GUARD_MODE_RANK[mode] : 0;
}

const contributors = new Map<string, GuardFloorContributor>();

/** Whether the auto-wired app contributor init has run. */
let appInited = false;

/**
 * Register a guard-floor contributor. Lets a fork mandate a stricter minimum for
 * certain turns without editing the guard sites. Idempotent by key:
 * re-registering the same key replaces the prior contributor (mirrors
 * `registerContextContributor`). A floor can only RAISE a guard. Call at
 * module-import time from `lib/app/guard-floor-contributors.ts`.
 *
 * @see .context/orchestration/chat.md — the app-author guide
 */
export function registerGuardFloorContributor(
  key: string,
  contributor: GuardFloorContributor
): void {
  contributors.set(key, contributor);
}

/**
 * Run the fork's auto-wired contributor init exactly once, lazily, before the
 * first collection. Latch BEFORE running so a throwing init neither retries on
 * every turn nor propagates out to fail the chat turn — an init failure degrades
 * to "no guard-floor contributors".
 */
function ensureAppGuardFloorContributorsInited(): void {
  if (appInited) return;
  appInited = true;
  try {
    initAppGuardFloorContributors();
  } catch (err) {
    logger.error(
      'guard-floor: initAppGuardFloorContributors threw — app guard-floor contributors disabled',
      { error: err instanceof Error ? err.message : String(err) }
    );
  }
}

/**
 * Test-only: drop all registered contributors and re-arm the one-shot app init
 * so each test starts from a known state. Not exported from the barrel.
 */
export function __resetGuardFloorContributorsForTests(): void {
  contributors.clear();
  appInited = false;
}

/**
 * Consult every registered contributor for one turn, in parallel, and merge
 * their floors to the strictest per guard. Never throws: a contributor that
 * rejects OR throws synchronously is logged and contributes nothing. A returned
 * mode that isn't a known `GuardMode` is ignored (a fork can't inject a bogus
 * mode). An empty registry short-circuits to `{}` — no floors, no behaviour
 * change.
 */
export async function collectGuardFloors(request: GuardFloorRequest): Promise<GuardFloors> {
  ensureAppGuardFloorContributorsInited();
  if (contributors.size === 0) return {};

  const results = await Promise.all(
    Array.from(contributors.entries()).map(async ([key, contributor]) => {
      try {
        return await contributor(request);
      } catch (err) {
        logger.error('guard-floor: contributor threw — ignoring', {
          contributorKey: key,
          agentId: request.agentId,
          error: err instanceof Error ? err.message : String(err),
        });
        return {} satisfies GuardFloors;
      }
    })
  );

  const merged: GuardFloors = {};
  for (const floors of results) {
    for (const guard of GUARD_KINDS) {
      const mode = floors?.[guard];
      // Ignore an absent or malformed mode; only raise toward the stricter.
      if (!isGuardMode(mode)) continue;
      const current = merged[guard];
      if (current === undefined || rank(mode) > rank(current)) {
        merged[guard] = mode;
      }
    }
  }
  return merged;
}

/**
 * Raise a single guard's resolved mode to its floor when the floor is stricter.
 * Pure: returns `resolvedMode` unchanged when there is no floor for `guard` (or
 * it's not stricter). `resolvedMode` is accepted as a plain string because the
 * guard sites resolve it from nullable config; an unrecognised value ranks as
 * least strict, so a floor can still raise it.
 */
export function applyGuardFloor(
  guard: GuardKind,
  resolvedMode: string,
  floors: GuardFloors
): string {
  const floor = floors[guard];
  if (floor === undefined) return resolvedMode;
  return rank(floor) > rank(resolvedMode) ? floor : resolvedMode;
}
