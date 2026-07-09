/**
 * Guard-events seam
 *
 * The post-detection sibling of the guard-floor seam. When an inline chat guard
 * (input / output / citation) FLAGS, the handler calls `emitGuardEvent` so a
 * fork can OBSERVE the firing and react (notify, log, escalate) WITHOUT editing
 * the guard sites or changing detection.
 *
 * **Fire-and-forget:** emission never delays or breaks the turn. Each
 * contributor runs on a microtask; a synchronous throw OR an async rejection is
 * swallowed and logged. An empty registry is a no-op, so vanilla behaviour is
 * unchanged.
 *
 * Pairs with the guard-floor seam (`guard-floor.ts`): a floor is a
 * **pre-detection** input to how strictly a guard acts; an event is a
 * **post-detection** observation that a guard fired. A guard-event contributor
 * cannot change detection or the action taken — use a guard-floor contributor
 * for that.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { logger } from '@/lib/logging';
import { initAppGuardEventContributors } from '@/lib/app/guard-event-contributors';
import type { GuardKind, GuardMode } from '@/lib/orchestration/chat/guard-floor';

/** The turn identity a contributor keys its reaction on. */
export interface GuardEventContext {
  contextType?: string;
  contextId?: string;
  agentId: string;
  userId: string;
  conversationId: string;
}

/** What fired and what the guard did about it. */
export interface GuardEvent {
  /** Which inline guard flagged. */
  guard: GuardKind;
  /**
   * The effective mode the guard acted in — after agent/global resolution and
   * any guard-floor raise. `block` = the turn was stopped; `warn_and_continue`
   * = a warning was surfaced; `log_only` = logged only; `none` = flagged but no
   * action.
   */
  outcome: GuardMode;
}

/**
 * Observes a guard firing. May be async. Runs fire-and-forget: its return value
 * is not awaited and its errors never surface to the turn.
 */
export type GuardEventContributor = (
  context: GuardEventContext,
  event: GuardEvent
) => void | Promise<void>;

function isGuardMode(value: string): value is GuardMode {
  return (
    value === 'none' || value === 'log_only' || value === 'warn_and_continue' || value === 'block'
  );
}

const contributors = new Map<string, GuardEventContributor>();

/** Whether the auto-wired app contributor init has run. */
let appInited = false;

/**
 * Register a guard-event contributor. Lets a fork react to an inline guard
 * firing (notify / log / escalate) without editing the guard sites. Idempotent
 * by key: re-registering the same key replaces the prior contributor (mirrors
 * `registerContextContributor`). Observation only — it cannot change detection
 * or the guard's action. Call at module-import time from
 * `lib/app/guard-event-contributors.ts`.
 *
 * @see .context/orchestration/chat.md — the app-author guide
 */
export function registerGuardEventContributor(
  key: string,
  contributor: GuardEventContributor
): void {
  contributors.set(key, contributor);
}

/**
 * Run the fork's auto-wired contributor init exactly once, lazily, before the
 * first emit. Latch BEFORE running so a throwing init neither retries nor
 * propagates — an init failure degrades to "no guard-event contributors".
 */
function ensureAppGuardEventContributorsInited(): void {
  if (appInited) return;
  appInited = true;
  try {
    initAppGuardEventContributors();
  } catch (err) {
    logger.error(
      'guard-events: initAppGuardEventContributors threw — app guard-event contributors disabled',
      { error: err instanceof Error ? err.message : String(err) }
    );
  }
}

/**
 * Test-only: drop all registered contributors and re-arm the one-shot app init
 * so each test starts from a known state. Not exported from the barrel.
 */
export function __resetGuardEventContributorsForTests(): void {
  contributors.clear();
  appInited = false;
}

/**
 * Emit a guard-firing event to every registered contributor, **fire-and-forget**.
 * Returns immediately (`void`): contributors run on a microtask so emission
 * never blocks the chat turn — even when the guard's action is `block` and the
 * turn short-circuits right after. A synchronous throw or an async rejection
 * from a contributor is caught and logged. An empty registry is a no-op.
 *
 * `resolvedMode` is the effective guard-mode string (post resolution + floor);
 * an unrecognised value is reported to observers as `'none'` (the guard took no
 * action), so a contributor never sees a bogus mode.
 */
export function emitGuardEvent(
  context: GuardEventContext,
  guard: GuardKind,
  resolvedMode: string
): void {
  ensureAppGuardEventContributorsInited();
  if (contributors.size === 0) return;

  const event: GuardEvent = {
    guard,
    outcome: isGuardMode(resolvedMode) ? resolvedMode : 'none',
  };

  for (const [key, contributor] of contributors) {
    // Defer to a microtask and isolate failures: a fork's observer must never
    // delay or break the turn. Deferring means a slow/throwing SYNC contributor
    // can't block the emit call; the `.catch` swallows both a synchronous throw
    // (inside the `.then` callback) and a rejected promise.
    void Promise.resolve()
      .then(() => contributor(context, event))
      .catch((err) => {
        logger.error('guard-events: contributor threw — ignoring', {
          contributorKey: key,
          agentId: context.agentId,
          guard,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
}
