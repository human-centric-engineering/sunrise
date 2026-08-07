/**
 * Describing an outbound `fetch` failure.
 *
 * undici (Node's `fetch`) reports almost every network-layer failure as a bare
 * `TypeError: fetch failed` and puts the actual reason on `error.cause`. A
 * refused redirect, a DNS miss, a TLS failure and a connection reset are
 * therefore indistinguishable from the message alone — which matters wherever
 * that message is the operator's only signal, such as a webhook delivery log.
 *
 * Extracted once three call sites needed it (`hooks/registry.ts`,
 * `webhooks/dispatcher.ts`, `escalation-notifier.ts`), all of them added
 * `redirect: 'error'` in #534/#553 and all of them needing to explain that
 * refusal to a human.
 */

/**
 * A human-readable description of a thrown value, unwrapping undici's `cause`.
 *
 * Only `Error` and `string` causes are unwrapped: an arbitrary object would
 * render as `"[object Object]"` in the operator-visible log it lands in, which
 * is worse than saying nothing.
 *
 * @example
 * ```typescript
 * describeFetchFailure(new TypeError('fetch failed'));
 * // 'fetch failed'
 *
 * describeFetchFailure(
 *   Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') })
 * );
 * // 'fetch failed: unexpected redirect'
 * ```
 */
export function describeFetchFailure(err: unknown): string {
  if (!(err instanceof Error)) return String(err);

  const { cause } = err;
  const detail = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : null;

  return detail ? `${err.message}: ${detail}` : err.message;
}
