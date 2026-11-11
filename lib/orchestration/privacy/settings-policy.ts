/**
 * The LLM privacy layer's install-wide settings, as a policy (§127).
 *
 * `AiOrchestrationSettings` holds the global mode, the ignored entity types
 * and whether local providers are protected. This turns them into the base
 * `PrivacyPolicy` the stage starts every call from; policy resolvers can only
 * tighten it from there.
 *
 * @see .context/privacy/llm-privacy-layer.md — *Settings*
 */
import {
  ENTITY_TYPE_PATTERN,
  PRIVACY_MODES_BY_STRICTNESS,
  type PrivacyMode,
  type PrivacyPolicy,
} from '@/lib/privacy/adapters/types';

/**
 * The modes an operator can choose in this version. `pseudonymise`, `redact`
 * and `block` are built by t-992; until then the settings API refuses them,
 * and the stage refuses a call a resolver raises to one, rather than send it
 * unprotected under a mode that promised protection.
 */
export const PRIVACY_MODES_AVAILABLE = ['off', 'detect'] as const satisfies readonly PrivacyMode[];

/** The ignored types a new settings row starts with: the column default. */
export const DEFAULT_PRIVACY_IGNORED_ENTITY_TYPES: readonly string[] = ['DATE', 'LOCATION'];

/** A stored mode, or `null` when the stored value is not one. */
export function parsePrivacyMode(raw: unknown): PrivacyMode | null {
  return PRIVACY_MODES_BY_STRICTNESS.find((mode) => mode === raw) ?? null;
}

/**
 * Stored ignored types. A value that is not a list of entity type names reads
 * as `[]`: nothing ignored, which is the stricter reading of a list of
 * exclusions.
 */
export function parseIgnoredEntityTypes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const valid = raw.filter(
    (t): t is string => typeof t === 'string' && ENTITY_TYPE_PATTERN.test(t)
  );
  if (valid.length !== raw.length) return [];
  return [...new Set(valid)];
}

/** The settings the stage reads. */
export interface PrivacySettings {
  /** `null` when the stored mode is unreadable; the stage then refuses. */
  privacyMode: PrivacyMode | null;
  privacyIgnoredEntityTypes: readonly string[];
  privacyProtectLocalProviders: boolean;
}

/**
 * The base policy for a call, or `null` when the settings cannot give one.
 * `onDetectorFailure` starts at `fallback`: a detector that fails marks the
 * call degraded. A resolver can raise it to `block`.
 */
export function basePolicyFromSettings(settings: PrivacySettings): PrivacyPolicy | null {
  if (settings.privacyMode === null) return null;
  return {
    mode: settings.privacyMode,
    ignoredEntityTypes: [...settings.privacyIgnoredEntityTypes],
    protectLocalProviders: settings.privacyProtectLocalProviders,
    onDetectorFailure: 'fallback',
  };
}
