/**
 * Keep work a request started running after the response is sent.
 *
 * On a serverless host the invocation can be frozen or killed as soon as the
 * response goes out, so a bare `void work()` may stop part-way. Handing the
 * promise to Next's `after()` keeps the invocation alive until it settles, for
 * up to the route's `maxDuration` (t-846, after t-844 did the same for the
 * maintenance tick's own chain).
 *
 * **Outside a request the work still runs.** The dev ticker in
 * `instrumentation.ts`, scripts and unit tests have no request scope, where
 * `after()` throws. There the promise runs on the long-lived process exactly as
 * a `void` call would, which is the right behaviour for each of them.
 *
 * **Register while the request, or an enclosing `after()` task, is still
 * live.** Next allows nested `after()` calls, so code already running under
 * `after()` (the tick's background chain, a resumed approval) can call this
 * too. What it cannot do is register once every task has settled. So hand the
 * outermost promise over synchronously in the handler, and let nested work
 * register before that promise resolves.
 */

import { after } from 'next/server';
import { logger } from '@/lib/logging';

/**
 * Next's error code for "`after` was called outside a request scope". Matched
 * by code first, because the message's wording is Next's to change; the
 * message is the fallback for a build that drops the code.
 */
const OUTSIDE_REQUEST_SCOPE_CODE = 'E468';

function isOutsideRequestScope(err: unknown, message: string): boolean {
  if (typeof err === 'object' && err !== null && '__NEXT_ERROR_CODE' in err) {
    return err.__NEXT_ERROR_CODE === OUTSIDE_REQUEST_SCOPE_CODE;
  }
  return message.includes('outside a request scope');
}

/**
 * Run `task` to completion even after the response is sent. Never throws, and
 * the promise handed to `after()` never rejects: a rejection is logged as
 * "`label` failed" instead.
 */
export function keepRunningAfterResponse(
  task: Promise<unknown>,
  label: string,
  meta: Record<string, unknown> = {}
): void {
  const settled = task.then(
    () => undefined,
    (err: unknown) => {
      logger.error(`${label} failed`, err, meta);
    }
  );
  try {
    after(settled);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // No request scope: the long-lived process runs it, as `void` would.
    if (isOutsideRequestScope(err, message)) return;
    // Any other refusal (Next's `waitUntil` unavailable on this host, a broken
    // `onClose`) still leaves the work running, but not kept alive, so say so.
    logger.warn(`${label}: could not keep background work alive after the response`, {
      ...meta,
      error: message,
    });
  }
}
