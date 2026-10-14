/**
 * Model Matrix chat pricing rules (t-774), shared by every writer of
 * `AiProviderModel.inputCostPerMillionTokens` / `outputCostPerMillionTokens`:
 * the admin routes and form, the discover dialog, the audit capabilities and
 * the audit's proposal schema.
 *
 * Import-free apart from Zod, so client components can use it without
 * pulling in the rest of the orchestration validations.
 */

import { z } from 'zod';

/**
 * The most a chat price per 1M tokens may be (t-774). Generous for any real
 * model, and low enough to catch a per-token or per-1K figure typed in its
 * place.
 */
export const MAX_PRICE_PER_MILLION_TOKENS = 10_000;

/**
 * A chat model's price per 1M tokens, input and output apart (t-774). Set
 * as a pair: half a price would record the other half of every turn at $0.
 * Without them a row falls back to `costPerMillionTokens` for both. The
 * pair is also a database CHECK (`ai_provider_model_price_pair`).
 */
export const splitPriceSchema = z.number().nonnegative().max(MAX_PRICE_PER_MILLION_TOKENS);

/**
 * {@link splitPriceSchema} for a value that may arrive as text: the approval
 * screen edits proposed values as strings, so an admin's modified `"3.5"`
 * is read as the number it spells. Anything else is validated as given.
 */
export const splitPriceInputSchema = z.preprocess(numericStringToNumber, splitPriceSchema);

/**
 * A numeric string read as the number it spells (`"3.5"` → `3.5`,
 * `" 16 "` → `16`); anything else is returned as given, for the schema to
 * judge. The approval screen edits proposed values as text.
 */
export function numericStringToNumber(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  const num = Number(trimmed);
  return trimmed !== '' && Number.isFinite(num) ? num : value;
}

/**
 * The capabilities whose models are priced per input and output token
 * (t-774): chat models and reasoning models (the o-series is classed
 * `reasoning`). Every writer of the split prices — the form, the discover
 * dialog — asks this, so a reasoning row is never treated as unpriced.
 */
export const SPLIT_PRICED_CAPABILITIES: readonly string[] = ['chat', 'reasoning'];

/** Whether a model with these capabilities carries input and output prices. */
export function hasSplitPricing(capabilities: readonly string[]): boolean {
  return capabilities.some((c) => SPLIT_PRICED_CAPABILITIES.includes(c));
}

/** The message every writer gives for half a price. */
export const PRICE_PAIR_MESSAGE = 'Set the input and output prices together, or neither';

/**
 * Whether these two prices are half a price: one set, the other not
 * (`null` and `undefined` both count as not set). The one statement of the
 * pair rule; the database holds it too (`ai_provider_model_price_pair`).
 */
export function isHalfPrice(input: unknown, output: unknown): boolean {
  return (input == null) !== (output == null);
}
