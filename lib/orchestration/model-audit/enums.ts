/**
 * Provider-model audit enum registry.
 *
 * Mirrors the Zod enums in `lib/validations/orchestration.ts`
 * (`tierRoleSchema`, `ratingLevelSchema`, etc.) — duplicated here as
 * plain string arrays so they're consumable by:
 *
 *   1. The structured approval UI (`<ReviewField>` Select widgets).
 *   2. The audit workflow's `validate_proposals` guard prompt
 *      (`provider-model-audit.ts` ENUM_SPEC).
 *   3. The `apply_audit_changes` per-field server-side validation that
 *      enforces enums on admin-modified values.
 *
 * Drift risk is bounded: the validation schema is the authoritative
 * gate on writes. If these arrays go out of date, the UI shows
 * stale options and the server rejects them — visible failure, not
 * silent corruption. Keep this file in sync with `lib/validations/
 * orchestration.ts` when adding or removing enum values.
 */

/**
 * Capability tier — what kind of work the model is for. Orthogonal to
 * deployment locus (see {@link DEPLOYMENT_PROFILES}).
 *
 * Until 2026-05-16 this enum included `local_sovereign`, which mixed
 * deployment locus (where the model runs) into capability tier (what
 * the model is for). The audit workflow repeatedly produced wrong
 * proposals because the LLM was forced to pick one when a model like
 * Qwen2.5-72B is legitimately worker-tier AND sovereign-deployable.
 * `deploymentProfiles` now carries the sovereignty signal independently.
 */
export const TIER_ROLES = [
  'thinking',
  'worker',
  'infrastructure',
  'control_plane',
  'embedding',
] as const;

/**
 * Deployment locus — where the model runs. A model can carry one or
 * more profiles. `hosted` means a vendor-managed API; `sovereign` means
 * the operator's own infrastructure. Future expansion: `edge`
 * (browser/device), `air_gapped` (no outbound network).
 */
export const DEPLOYMENT_PROFILES = ['hosted', 'sovereign'] as const;

export const REASONING_DEPTH = ['very_high', 'high', 'medium', 'none'] as const;

export const LATENCY = ['very_fast', 'fast', 'medium'] as const;

/** Used for both `costEfficiency` and `reasoningDepth`. */
export const COST_EFFICIENCY = ['very_high', 'high', 'medium', 'none'] as const;

export const CONTEXT_LENGTH = ['very_high', 'high', 'medium', 'n_a'] as const;

export const TOOL_USE = ['strong', 'moderate', 'none'] as const;

export const QUALITY = ['high', 'medium', 'budget'] as const;

export const CONFIDENCE = ['high', 'medium', 'low'] as const;

export const CAPABILITIES = [
  'chat',
  'reasoning',
  'embedding',
  'audio',
  'image',
  'moderation',
  'vision',
  'documents',
] as const;

/**
 * Named enum lookup for the structured approval UI's
 * `enumValuesFrom: '...'` field-spec attribute.
 */
export const NAMED_ENUMS: Record<string, readonly string[]> = {
  TIER_ROLES,
  DEPLOYMENT_PROFILES,
  REASONING_DEPTH,
  LATENCY,
  COST_EFFICIENCY,
  CONTEXT_LENGTH,
  TOOL_USE,
  QUALITY,
  CONFIDENCE,
  CAPABILITIES,
};

/**
 * Per-field lookup for audit-change rows. The `proposedValue` cell
 * scopes its enum to the row's `field` column: when the field is
 * `tierRole`, the Select shows tier-role values; when it's
 * `reasoningDepth`, reasoning-depth values; etc.
 *
 * Fields not in this map (e.g. `bestRole`, `description`) are free-text
 * and the UI falls back to a text input.
 */
export const ENUM_BY_AUDIT_FIELD: Record<string, readonly string[]> = {
  tierRole: TIER_ROLES,
  deploymentProfiles: DEPLOYMENT_PROFILES,
  reasoningDepth: REASONING_DEPTH,
  latency: LATENCY,
  costEfficiency: COST_EFFICIENCY,
  contextLength: CONTEXT_LENGTH,
  toolUse: TOOL_USE,
  quality: QUALITY,
};
