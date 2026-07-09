/**
 * JSON parse helpers for LLM-as-judge output.
 *
 * The structured-completion runner these were once colocated with now lives
 * at `@/lib/orchestration/llm/structured-completion` (a neutral LLM home);
 * these two helpers stay here because every caller is an evaluation grader
 * turning a model's free-text response into a validated shape.
 *
 * Platform-agnostic: no Next.js imports.
 */

/**
 * Try to parse `raw` as JSON, then run it through `validate`. The model
 * may include surrounding whitespace or a stray code fence even when
 * asked not to — we try the raw string first, then strip common wrappers.
 */
export function tryParseJson<T>(raw: string, validate: (parsed: unknown) => T | null): T | null {
  const candidates = [raw.trim(), stripCodeFence(raw.trim())];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const validated = validate(parsed);
      if (validated !== null) return validated;
    } catch {
      // fall through
    }
  }
  return null;
}

export function stripCodeFence(input: string): string {
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/;
  const match = input.match(fence);
  return match ? match[1] : input;
}
