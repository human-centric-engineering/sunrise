/**
 * A model pin: a saved choice of model, naming its provider (§136 t-1068).
 *
 * Two providers can offer the same model id: `gpt-4o` under OpenAI and under
 * Azure, `whisper-1` under OpenAI and Groq. The catalogue keys a model on
 * provider AND id (`@@unique([providerSlug, modelId])`), so a pin that names
 * the id alone cannot say which one it means. Owner ruling, 2026-11-19: a pin
 * names both, so there is no possible confusion between OpenAI's GPT-4o and
 * Azure's.
 *
 * The stored shape is one string, `${providerSlug}::${modelId}`, in the same
 * field the bare id used to occupy: the task defaults
 * (`AiOrchestrationSettings.defaultModels`) and a workflow step's
 * `config.modelOverride`. The audio default has used this shape since before
 * the rest (`audio-default.ts`, which now re-exports these helpers). One
 * string rather than a second field, so a pin is written and read in one
 * place and no stored row or workflow needs migrating.
 *
 * **A bare id is still a valid pin.** Everything written before t-1068 is one,
 * and so is the system's own suggestion for an unsaved slot
 * (`computeDefaultModelMap`, whose registry provider names need not match a
 * provider row's slug). `parseModelPin` returns `providerSlug: null` for it and
 * the caller resolves the provider the old way, from the model registry,
 * until someone re-saves the pin.
 *
 * Pure: no database, no Next.js imports. Safe in client components.
 */

/**
 * Step types whose `config.modelOverride` is a model pin: the semantic
 * validator's PROVIDER_CHOOSING_STEP_TYPES (its LLM_STEP_TYPES plus
 * `supervisor`, which passes its override to the LLM call), in
 * lib/orchestration/workflows/semantic-validator.ts. Kept in sync by hand
 * because exporting from the validator would pull its runtime deps (the
 * model registry) in for no benefit. Read by the uses finder
 * (`global-config-usage.ts`) and the model move (`move-plan.ts`), so the two
 * see the same steps. `chat_turn` takes a pin too and is handled beside this
 * set by each reader, since a bare id there runs on its agent's provider.
 */
export const MODEL_OVERRIDE_STEP_TYPES: ReadonlySet<string> = new Set([
  'llm_call',
  'route',
  'reflect',
  'guard',
  'evaluate',
  'plan',
  'orchestrator',
  'supervisor',
]);

/** The separator between provider slug and model id. */
const SEPARATOR = '::';

export interface ModelPin {
  /** `null` when the pin names the model id alone (a pin saved before t-1068). */
  providerSlug: string | null;
  modelId: string;
}

/** The stored form of a pin naming `providerSlug`'s `modelId`. */
export function formatModelPin(providerSlug: string, modelId: string): string {
  return `${providerSlug}${SEPARATOR}${modelId}`;
}

/**
 * Read a stored pin. Accepts `provider::model` and a bare model id. Returns
 * `null` only for an empty or missing value, so it doubles as a presence
 * check.
 *
 * The split is on the **first** `::`, so a model id containing `::` stays
 * whole. An empty provider or model on either side is not a pair; the whole
 * value is then read as a bare id rather than as a half-formed pair a matcher
 * would treat as valid.
 */
export function parseModelPin(value: string | null | undefined): ModelPin | null {
  if (!value) return null;
  const sep = value.indexOf(SEPARATOR);
  if (sep < 0) return { providerSlug: null, modelId: value };
  const providerSlug = value.slice(0, sep);
  const modelId = value.slice(sep + SEPARATOR.length);
  if (!providerSlug || !modelId) return { providerSlug: null, modelId: value };
  return { providerSlug, modelId };
}

/** The model id a stored pin names, or `''` when there is none. */
export function pinModelId(value: string | null | undefined): string {
  return parseModelPin(value)?.modelId ?? '';
}

/**
 * How the stored pin `value` names the catalogue model `model`: `'pair'` by
 * provider and id, `'id'` by id alone (it may mean another provider's model
 * with the same id), or `null` when it does not name it.
 */
export function pinNames(
  value: string | null | undefined,
  model: { providerSlug: string; modelId: string }
): 'pair' | 'id' | null {
  const pin = parseModelPin(value);
  if (pin === null || pin.modelId !== model.modelId) return null;
  if (pin.providerSlug === null) return 'id';
  return pin.providerSlug === model.providerSlug ? 'pair' : null;
}

/**
 * The provider a pin runs on: the one it names, else `registryProvider`, the
 * provider the model registry gives its id (how a bare pin has always been
 * resolved).
 */
export function pinProvider(pin: ModelPin, registryProvider: string): string {
  return pin.providerSlug ?? registryProvider;
}
