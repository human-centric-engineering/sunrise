/**
 * `maybeParseJson` — unwrap JSON-encoded structured strings.
 *
 * LLM step outputs (`llm_call`, `agent_call`) arrive in `ctx.stepOutputs`
 * as raw response strings. Downstream consumers that need to walk the
 * structure (compound schema-mode guards, review-schema source paths,
 * `{{step.output.foo}}` resolvers) must JSON-parse first.
 *
 * Semantics:
 *   - Non-strings pass through unchanged.
 *   - Strings whose trimmed form starts with `{` or `[` are parsed and
 *     the parsed value returned. Parse failure (malformed JSON, fenced
 *     markdown, leading prose, etc.) falls back to the original string
 *     so the caller's schema/shape check produces the actionable
 *     "expected object, received string" error rather than a generic
 *     `SyntaxError`.
 *   - Strings that don't start with `{` / `[` pass through (a JSON-
 *     encoded primitive like `'"hello"'` would otherwise be silently
 *     unwrapped, which is rarely what consumers want).
 */
export function maybeParseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}
