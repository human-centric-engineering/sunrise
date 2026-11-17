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
import { modeStrictness } from '@/lib/privacy/adapters/policy';
import {
  CONFIDENTIAL_POLICIES_BY_STRICTNESS,
  ENTITY_TYPE_PATTERN,
  PRIVACY_MODES_BY_STRICTNESS,
  type ConfidentialPolicy,
  type PrivacyMode,
  type PrivacyPolicy,
  type SensitivityGroup,
} from '@/lib/privacy/adapters/types';

/**
 * The modes an operator can choose in this version: all five since t-992. Kept
 * apart from {@link PRIVACY_MODES_BY_STRICTNESS} so a mode added to the
 * contract before it is built can be left out here, and the settings API, the
 * settings page and a backup restore then refuse it.
 */
export const PRIVACY_MODES_AVAILABLE = [
  'off',
  'detect',
  'pseudonymise',
  'redact',
  'block',
] as const satisfies readonly PrivacyMode[];

/** What each mode is called on the settings, agent and org forms. */
export const PRIVACY_MODE_LABELS: Record<(typeof PRIVACY_MODES_AVAILABLE)[number], string> = {
  off: 'Off',
  detect: 'Detect (count only)',
  pseudonymise: 'Pseudonymise (placeholders, restored)',
  redact: 'Redact (placeholders, not restored)',
  block: 'Block (refuse calls with personal data)',
};

/**
 * The modes an agent or an org can require (t-1010): every available mode but
 * `off`. Both only ever tighten the install's mode, so `off` would say nothing;
 * "no setting" is `null`, which inherits.
 */
export const PRIVACY_TIGHTENING_MODES = [
  'detect',
  'pseudonymise',
  'redact',
  'block',
] as const satisfies readonly (typeof PRIVACY_MODES_AVAILABLE)[number][];

export type PrivacyTighteningMode = (typeof PRIVACY_TIGHTENING_MODES)[number];

/**
 * A stored agent or org mode, or `null` when none is set. A value that is set
 * but is not one of {@link PRIVACY_TIGHTENING_MODES} throws: it may have been
 * a stricter mode, and reading it as "none" would send the call looser than
 * someone asked. The stage refuses the call instead.
 */
export function parseTighteningMode(raw: unknown): PrivacyTighteningMode | null {
  if (raw === null || raw === undefined) return null;
  if (!isTighteningMode(raw)) throw new Error('stored privacy mode is not a mode');
  return raw;
}

/** Whether `raw` is one of {@link PRIVACY_TIGHTENING_MODES}. */
export function isTighteningMode(raw: unknown): raw is PrivacyTighteningMode {
  return PRIVACY_TIGHTENING_MODES.some((m) => m === raw);
}

/**
 * Whether `mode` replaces what it finds with placeholders: `pseudonymise` and
 * `redact`. (`block` sends nothing it finds, so it masks nothing.)
 */
export function isMaskingMode(mode: PrivacyMode): boolean {
  return mode === 'pseudonymise' || mode === 'redact';
}

/**
 * Whether `mode` protects what is sent: `pseudonymise` or stricter. The test
 * for refusing on a failed detector, for the `local_only` embeddings refusal,
 * and for the settings page's embeddings warning: one definition for all three.
 */
export function protectsContent(mode: PrivacyMode): boolean {
  return modeStrictness(mode) >= modeStrictness('pseudonymise');
}

/**
 * What the layer does about embedding calls (spec § Embeddings). Their input
 * is counted and never masked, because a masked name cannot be searched for.
 *
 * - `allow` — send them to whichever provider the install embeds with.
 * - `local_only` — under `pseudonymise` or stricter, refuse one to a provider
 *   that is not `isLocal`.
 */
export const EMBEDDINGS_POLICIES = ['allow', 'local_only'] as const;

export type EmbeddingsPolicy = (typeof EMBEDDINGS_POLICIES)[number];

/**
 * A stored embeddings policy. Absent (a row shape from before the column)
 * reads as `allow`, the column default; a stored value that is not a policy
 * reads as `local_only`, the stricter, so a corrupted row never loosens it.
 */
export function parseEmbeddingsPolicy(raw: unknown): EmbeddingsPolicy {
  if (raw === undefined) return 'allow';
  return EMBEDDINGS_POLICIES.find((p) => p === raw) ?? 'local_only';
}

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

/**
 * What each confidential-content policy is called on the settings and agent
 * forms (§130). The order is {@link CONFIDENTIAL_POLICIES_BY_STRICTNESS}.
 */
export const CONFIDENTIAL_POLICY_LABELS: Record<ConfidentialPolicy, string> = {
  allow: 'Allow (record only)',
  warn: 'Warn (send, then tell the user)',
  approved_only: 'Trusted or local providers only',
  local_only: 'Local providers only',
  block: 'Block (never send)',
};

/**
 * What each group covers, as the settings page and the agent form say it
 * (§130). One wording for both, kept beside the policy labels.
 */
export const CONFIDENTIAL_GROUP_DESCRIPTIONS: Record<SensitivityGroup, string> = {
  personal:
    "Someone's health, ethnicity, religion, politics, trade-union membership, sexuality or criminal record, an HR or legal matter about them, or their debts.",
  commercial:
    "The organisation's own secrets: unannounced or embargoed plans, a deal, restructuring or redundancies, a business in trouble, a legal dispute.",
};

/**
 * The confidential-content policies an agent can require: every one but
 * `allow`. An agent only ever tightens the install's policy, so `allow` would
 * say nothing; "no setting" is `null`, which inherits.
 */
export const CONFIDENTIAL_TIGHTENING_POLICIES = [
  'warn',
  'approved_only',
  'local_only',
  'block',
] as const satisfies readonly ConfidentialPolicy[];

export type ConfidentialTighteningPolicy = (typeof CONFIDENTIAL_TIGHTENING_POLICIES)[number];

/**
 * A stored install-wide confidential-content policy. Absent (a row shape from
 * before the column) reads as `allow`, what the migration filled an upgraded
 * row with; a stored value that is not a policy reads as `block`, the
 * strictest, so a corrupted row never loosens it.
 */
export function parseConfidentialPolicy(raw: unknown): ConfidentialPolicy {
  if (raw === undefined) return 'allow';
  return CONFIDENTIAL_POLICIES_BY_STRICTNESS.find((p) => p === raw) ?? 'block';
}

/**
 * A stored agent confidential-content policy, or `null` when none is set. A
 * value that is set but is not one of {@link CONFIDENTIAL_TIGHTENING_POLICIES}
 * throws, as {@link parseTighteningMode} does: the stage refuses the call
 * rather than send it looser than someone asked.
 */
export function parseTighteningConfidentialPolicy(
  raw: unknown
): ConfidentialTighteningPolicy | null {
  if (raw === null || raw === undefined) return null;
  if (!isConfidentialTighteningPolicy(raw)) {
    throw new Error('stored confidential-content policy is not a policy');
  }
  return raw;
}

/**
 * Whether `raw` is a stored agent confidential-content policy an export may
 * carry: `null` (inherit) or one of {@link CONFIDENTIAL_TIGHTENING_POLICIES}.
 * A value that is neither is left out, as an unknown privacy mode is.
 */
export function isStoredConfidentialPolicy(
  raw: unknown
): raw is ConfidentialTighteningPolicy | null {
  return raw === null || isConfidentialTighteningPolicy(raw);
}

/** Whether `raw` is one of {@link CONFIDENTIAL_TIGHTENING_POLICIES}. */
export function isConfidentialTighteningPolicy(raw: unknown): raw is ConfidentialTighteningPolicy {
  return CONFIDENTIAL_TIGHTENING_POLICIES.some((p) => p === raw);
}

/** The policy field of {@link PrivacyPolicy} that governs `group`. */
export const CONFIDENTIAL_POLICY_FIELD = {
  personal: 'confidentialPersonal',
  commercial: 'confidentialCommercial',
} as const satisfies Record<SensitivityGroup, keyof PrivacyPolicy>;

/** The settings the stage reads. */
export interface PrivacySettings {
  /** `null` when the stored mode is unreadable; the stage then refuses. */
  privacyMode: PrivacyMode | null;
  privacyIgnoredEntityTypes: readonly string[];
  privacyProtectLocalProviders: boolean;
  privacyConfidentialPersonal: ConfidentialPolicy;
  privacyConfidentialCommercial: ConfidentialPolicy;
}

/**
 * The base policy for a call, or `null` when the settings cannot give one.
 * `onDetectorFailure` starts at `fallback`: a detector that fails marks the
 * call degraded. A resolver can raise it to `block`.
 */
export function basePolicyFromSettings(settings: PrivacySettings): PrivacyPolicy | null {
  // Checked again, not trusted: anything that is not a mode gives no policy.
  const mode = parsePrivacyMode(settings.privacyMode);
  if (mode === null) return null;
  return {
    mode,
    ignoredEntityTypes: [...settings.privacyIgnoredEntityTypes],
    protectLocalProviders: settings.privacyProtectLocalProviders,
    onDetectorFailure: 'fallback',
    // Checked again, not trusted: anything that is not a policy reads as `block`.
    confidentialPersonal: parseConfidentialPolicy(settings.privacyConfidentialPersonal),
    confidentialCommercial: parseConfidentialPolicy(settings.privacyConfidentialCommercial),
  };
}
