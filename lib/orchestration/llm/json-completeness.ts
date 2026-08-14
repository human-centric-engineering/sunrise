/**
 * Shared JSON-completeness test for the adapters' truncation guards.
 *
 * Both adapters need to tell a JSON-shaped response that merely *ended* at the
 * token cap from one that was cut off mid-value. Only the second is a
 * truncation worth failing: if the object closed, the caller can use it, and
 * `finishReason: 'length'` still tells anyone who cares that the model wanted
 * more room.
 *
 * Lives here rather than in either adapter because both now use it and they
 * must not diverge — a response one adapter accepts and the other rejects is
 * the exact failure #594 set out to remove.
 *
 * **Where it does and does not apply.** It is right for any response whose
 * text is the model's raw output — every `json_object` response on both
 * adapters, and OpenAI's `json_schema` (native `response_format`). It is
 * deliberately NOT applied to Anthropic's `json_schema` path: there the
 * payload is rebuilt with `JSON.stringify` from the forced tool's
 * already-parsed input, so even a truncated one serialises to valid JSON and a
 * parse gate would silently disable that guard entirely. Anthropic's
 * extraction path keys on `stop_reason` alone, and must keep doing so.
 */

/**
 * Is `text` a complete JSON value?
 *
 * Mirrors `tryParseJson` / `stripCodeFence` in
 * `evaluations/parse-structured.ts` — raw first, then one unwrapped code
 * fence. A guard that is STRICTER than the parser it protects turns a response
 * the caller would have accepted into a hard failure, which is the same class
 * of bug as not guarding at all. Deliberately no more lenient either: digging a
 * complete object out of surrounding prose would let a genuinely truncated
 * response through.
 *
 * (Duplicated from `evaluations/parse-structured.ts` rather than imported —
 * the provider layer must not depend on `evaluations/`.)
 */
export function isCompleteJson(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  for (const candidate of [trimmed, trimmed.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1')]) {
    try {
      JSON.parse(candidate);
      return true;
    } catch {
      // try the next candidate
    }
  }
  return false;
}
