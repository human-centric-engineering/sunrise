/**
 * Case-insensitive merge of HTTP header maps.
 *
 * JS object spread is case-sensitive but HTTP header names are case-
 * insensitive (RFC 7230 §3.2). Plain `{ ...a, ...b }` lets two entries that
 * differ only in case coexist; when that object reaches `fetch()`, undici's
 * `Headers` constructor lowercase-normalises and `append`s repeats — so
 * `{ Authorization: 'a', authorization: 'b' }` becomes `authorization: a, b`
 * on the wire, **not** an override.
 *
 * That defeats the contract of any merge where a later source is supposed
 * to override an earlier one across trust boundaries:
 *  - LLM-supplied `args.headers` overridden by admin `forcedHeaders`
 *  - Caller-supplied headers overridden by resolved auth / idempotency
 *
 * `mergeHeaders` enforces case-insensitive deduplication while preserving
 * the winning entry's original casing (so trace logs stay readable). Later
 * sources win on the same logical header name.
 */

export function mergeHeaders(
  ...sources: Array<Record<string, string> | undefined>
): Record<string, string> {
  const seen = new Map<string, [string, string]>();
  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      seen.set(key.toLowerCase(), [key, value]);
    }
  }
  const out: Record<string, string> = {};
  for (const [originalKey, value] of seen.values()) {
    out[originalKey] = value;
  }
  return out;
}
