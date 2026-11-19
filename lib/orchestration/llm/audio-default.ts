/**
 * `defaultModels.audio` carries a `${providerSlug}::${modelId}` composite
 * because the same `modelId` (e.g. `whisper-1`) can legitimately live on
 * multiple providers — the schema's `@@unique([providerSlug, modelId])`
 * compound allows OpenAI and Groq to both register a `whisper-1` row.
 *
 * Since §136 t-1068 every model pin has this shape, not only audio's: the
 * helpers live in `model-pin.ts`, and these names are kept so existing
 * imports (a fork's included) keep working.
 *
 * Legacy values written before the composite landed are bare model ids
 * with no `::` separator. `parseAudioDefault` returns
 * `{ providerSlug: null, modelId }` for those so callers can fall back
 * to the legacy matching rule (modelId only, ambiguous when two
 * providers share an id). On the next operator save the value is
 * rewritten with the composite.
 */

import { formatModelPin, parseModelPin, type ModelPin } from '@/lib/orchestration/llm/model-pin';

export type ParsedAudioDefault = ModelPin;

/** Build the wire format for `defaultModels.audio`. */
export const formatAudioDefault = formatModelPin;

/**
 * Decode the wire format. Accepts both the composite (`provider::model`)
 * and the legacy bare-model-id shape. Returns `null` only when given an
 * empty string or `undefined` so callers can use it as a presence check.
 */
export const parseAudioDefault = parseModelPin;
