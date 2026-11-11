/**
 * Combining privacy policies so they can only get stricter (§127).
 *
 * A policy resolver proposes a policy; the layer keeps, field by field, the
 * stricter of the proposal and what it already had. That is the whole
 * mechanism behind "resolvers can only make policy stricter": it never depends
 * on a resolver getting it right, so an app's resolver, an agent override and
 * an org floor all compose the same way.
 *
 * @see .context/privacy/llm-privacy-layer.md — *Policy*
 */
import { z } from 'zod';
import {
  DETECTOR_FAILURE_ACTIONS,
  ENTITY_TYPE_PATTERN,
  PRIVACY_MODES_BY_STRICTNESS,
  type PrivacyMode,
  type PrivacyPolicy,
} from '@/lib/privacy/adapters/types';

/** How strict a mode is: its position in {@link PRIVACY_MODES_BY_STRICTNESS}. */
export function modeStrictness(mode: PrivacyMode): number {
  return PRIVACY_MODES_BY_STRICTNESS.indexOf(mode);
}

/** The stricter of two modes. */
export function stricterMode(a: PrivacyMode, b: PrivacyMode): PrivacyMode {
  return modeStrictness(b) > modeStrictness(a) ? b : a;
}

/**
 * A whole policy: what the stage's base must be. Checked at the boundary,
 * because an unknown mode would otherwise rank as looser than `off`.
 */
export const privacyPolicySchema = z
  .object({
    mode: z.enum(PRIVACY_MODES_BY_STRICTNESS),
    ignoredEntityTypes: z.array(z.string().regex(ENTITY_TYPE_PATTERN)),
    protectLocalProviders: z.boolean(),
    onDetectorFailure: z.enum(DETECTOR_FAILURE_ACTIONS),
  })
  .strict() satisfies z.ZodType<PrivacyPolicy>;

/**
 * What a resolver may return. Validated, because a resolver is fork code and
 * a value that is not a policy must fail the resolver rather than be read as
 * one. Unknown keys are refused for the same reason: a misspelt field would
 * otherwise be a tightening that silently did nothing.
 */
export const privacyPolicyPatchSchema = privacyPolicySchema.partial() satisfies z.ZodType<
  Partial<PrivacyPolicy>
>;

/**
 * Fails to compile when `PrivacyPolicy` gains or loses a field the schema does
 * not: `.strict()` would otherwise refuse every resolver that returns
 * `{ ...current }`, and so every protected call.
 */
type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false;
const schemaCoversPolicy: SameKeys<z.infer<typeof privacyPolicyPatchSchema>, PrivacyPolicy> = true;
void schemaCoversPolicy;

export type PrivacyPolicyPatch = z.infer<typeof privacyPolicyPatchSchema>;

/**
 * Apply `patch` to `current`, keeping the stricter value of every field:
 *
 * - `mode` — the later in {@link PRIVACY_MODES_BY_STRICTNESS}.
 * - `ignoredEntityTypes` — the intersection. Fewer ignored types is stricter,
 *   so a patch can stop ignoring a type but never start.
 * - `protectLocalProviders` — `true` wins.
 * - `onDetectorFailure` — `block` wins.
 *
 * A field the patch leaves out is unchanged.
 */
export function tightenPolicy(current: PrivacyPolicy, patch: PrivacyPolicyPatch): PrivacyPolicy {
  const ignored =
    patch.ignoredEntityTypes === undefined
      ? current.ignoredEntityTypes
      : current.ignoredEntityTypes.filter((t) => patch.ignoredEntityTypes?.includes(t));
  return {
    mode: patch.mode === undefined ? current.mode : stricterMode(current.mode, patch.mode),
    ignoredEntityTypes: ignored,
    protectLocalProviders: current.protectLocalProviders || patch.protectLocalProviders === true,
    onDetectorFailure:
      current.onDetectorFailure === 'block' || patch.onDetectorFailure === 'block'
        ? 'block'
        : 'fallback',
  };
}
