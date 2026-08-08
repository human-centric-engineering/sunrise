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

  const detail = describeCause(err.cause);
  return detail ? `${err.message}: ${detail}` : err.message;
}

/**
 * Pull a usable description out of undici's `cause`.
 *
 * Reading `cause.message` alone is not enough, and the case it misses is the
 * common one: when a host resolves to more than one address — which any real
 * hostname does, A plus AAAA — undici attempts each and reports an
 * `AggregateError` whose own `message` is the empty string, with the per-address
 * failures on `.errors` and the shared reason on `.code`. So a webhook endpoint
 * simply being down produced exactly the bare `"fetch failed"` this module
 * exists to prevent.
 *
 * Order: a real message, else the aggregated per-address messages, else the
 * error code. Only shapes that stringify usefully are used — an arbitrary
 * object would reach the operator's log as `"[object Object]"`.
 */
function describeCause(cause: unknown): string | null {
  if (typeof cause === 'string') return cause || null;
  if (!(cause instanceof Error)) return null;

  if (cause.message) return cause.message;

  // AggregateError.errors — one entry per address attempted. Duplicates are
  // common (same refusal on v4 and v6), so collapse them.
  const aggregated = (cause as AggregateError).errors;
  if (Array.isArray(aggregated)) {
    const messages = [
      ...new Set(
        aggregated
          .map((inner) => (inner instanceof Error ? inner.message : null))
          .filter((message): message is string => Boolean(message))
      ),
    ];
    if (messages.length > 0) return messages.join('; ');
  }

  const code = (cause as NodeJS.ErrnoException).code;
  return typeof code === 'string' && code ? code : null;
}
