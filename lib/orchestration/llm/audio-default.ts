/**
 * `defaultModels.audio` carries a `${providerSlug}::${modelId}` composite
 * because the same `modelId` (e.g. `whisper-1`) can legitimately live on
 * multiple providers — the schema's `@@unique([providerSlug, modelId])`
 * compound allows OpenAI and Groq to both register a `whisper-1` row.
 * The other `TaskType` slots (`routing`, `chat`, `reasoning`, `embeddings`)
 * resolve through the static chat-model registry where ids are globally
 * unique, so they keep storing the bare model id.
 *
 * These helpers are the single chokepoint for the audio slot's wire
 * format. They keep the asymmetry honest: every consumer (settings form,
 * PATCH validator, runtime resolver, matrix `defaultFor` reverse-index)
 * routes through `parseAudioDefault` so a future change to the encoding
 * (e.g. moving to a struct in the JSON column) is a one-file edit.
 *
 * Legacy values written before the composite landed are bare model ids
 * with no `::` separator. `parseAudioDefault` returns
 * `{ providerSlug: null, modelId }` for those so callers can fall back
 * to the legacy matching rule (modelId only, ambiguous when two
 * providers share an id). On the next operator save the value is
 * rewritten with the composite, so the legacy path is short-lived.
 */

export interface ParsedAudioDefault {
  /** `null` when the stored value predates the composite encoding. */
  providerSlug: string | null;
  modelId: string;
}

/** Build the wire format for `defaultModels.audio`. */
export function formatAudioDefault(providerSlug: string, modelId: string): string {
  return `${providerSlug}::${modelId}`;
}

/**
 * Decode the wire format. Accepts both the composite (`provider::model`)
 * and the legacy bare-model-id shape. Returns `null` only when given an
 * empty string or `undefined` so callers can use it as a presence check.
 *
 * The split is on the **first** `::` — if a provider slug ever contains
 * `::` (currently disallowed by validation), the rest of the string
 * remains intact as the modelId.
 */
export function parseAudioDefault(value: string | null | undefined): ParsedAudioDefault | null {
  if (!value) return null;
  const sep = value.indexOf('::');
  if (sep < 0) return { providerSlug: null, modelId: value };
  const providerSlug = value.slice(0, sep);
  const modelId = value.slice(sep + 2);
  // Defensive: an empty providerSlug or modelId is meaningless. Fall
  // back to the legacy single-id interpretation rather than returning
  // a half-formed pair the matcher would treat as valid.
  if (!providerSlug || !modelId) return { providerSlug: null, modelId: value };
  return { providerSlug, modelId };
}
