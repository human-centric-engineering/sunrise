/**
 * LLM privacy layer — the adapter contracts (§127).
 *
 * Every stage of the privacy layer sits behind one of these interfaces, and
 * Sunrise's own local implementation of each is just the default adapter,
 * registered through the same registry an app uses
 * (`lib/privacy/adapters/registry.ts`). If an app cannot do something through
 * an adapter, neither can core.
 *
 * Four slots ship now — the four this feature consumes. The proposal's other
 * two, `SensitivityClassifier` and `MediaProcessor`, arrive with the
 * sensitive-content routing and attachments features that use them: an
 * interface forks build on is public surface, and one defined before anything
 * consumes it is the one that turns out wrong.
 *
 * Type-only module: no runtime imports, so a fork's `lib/app/` scaffold can
 * import from here without pulling the registry's module graph in.
 *
 * @see .context/privacy/llm-privacy-layer.md — the binding spec
 */

// ---------------------------------------------------------------------------
// Entity types
// ---------------------------------------------------------------------------

/**
 * The entity types Sunrise's own detectors find. A detector may declare types
 * beyond these (a fork's country ID rules, say): any name matching
 * {@link ENTITY_TYPE_PATTERN} is valid, provided the detector that reports it
 * declared it in {@link PrivacyDetector.entityTypes}.
 */
export const CORE_ENTITY_TYPES = [
  'PERSON',
  'ORG',
  'EMAIL',
  'PHONE',
  'ADDRESS',
  'POSTCODE',
  'UK_NINO',
  'NHS_NUMBER',
  'SORT_CODE',
  'BANK_ACCOUNT',
  'IBAN',
  'CARD_NUMBER',
  'UK_UTR',
  'UK_VAT',
  'UK_PASSPORT',
  'UK_DRIVING_LICENCE',
  'IP_ADDRESS',
  'SECRET',
  'DATE_OF_BIRTH',
  'DATE',
  'LOCATION',
] as const;

export type CoreEntityType = (typeof CORE_ENTITY_TYPES)[number];

/**
 * An entity type name. Upper snake case, because it becomes part of the
 * placeholder the model sees (`PERSON_1`): anything else would let a detector
 * put arbitrary text into the prompt.
 */
export type EntityType = string;

/** What a valid {@link EntityType} looks like. */
export const ENTITY_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{0,39}$/;

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

/**
 * Where an adapter sends the text it is given.
 *
 * - `in_process` — never leaves this process (Sunrise's own tiers).
 * - `self_hosted` — a service the operator runs (a Presidio container).
 * - `external` — another processor (a cloud API). This is the case the layer
 *   exists to govern; the service-adapters feature checks it against the org
 *   provider policy. Until then it is recorded and shown, not enforced.
 */
export const ADAPTER_EGRESS_VALUES = ['in_process', 'self_hosted', 'external'] as const;

export type AdapterEgress = (typeof ADAPTER_EGRESS_VALUES)[number];

/**
 * One match a detector found.
 *
 * **Offsets are JavaScript string indices** — UTF-16 code units, as
 * `String.prototype.slice` takes them. A service in another language usually
 * counts code points instead, and the two disagree after any emoji or other
 * astral character: an adapter that passes such offsets through masks the
 * wrong text and leaves the real value in the prompt. Convert at the adapter.
 */
export interface DetectedSpan {
  type: EntityType;
  /** Inclusive start index. */
  start: number;
  /** Exclusive end index. */
  end: number;
  /**
   * 0–1. Doubles as specificity when spans overlap: the higher one names the
   * merged span's type. A checksum-valid match reports 1, a known value a
   * little less, a list guess well below — see the spec's *Overlaps*.
   */
  confidence: number;
  /**
   * True when the detector matched this only because it learned the value
   * from elsewhere in the same text: a surname after the full name, a
   * company's short form after its full name (§127 t-1018). Not a value it
   * would report standing alone, such as a known first name. It is
   * masked and refused like any other span. A refusal under `block` does not
   * count it when it says which messages held personal details, so the
   * message the value was learned from is the one that is placed. Leave it
   * out for a value found where it stands.
   */
  learned?: boolean;
}

/** A span after the layer has accepted it, carrying which adapter found it. */
export interface AttributedSpan extends DetectedSpan {
  /** The detector's id. */
  source: string;
}

/** A value the layer already knows belongs to someone in this call. */
export interface KnownValue {
  type: EntityType;
  value: string;
}

/** The text to scan. */
export interface DetectInput {
  text: string;
}

/** What a detector is told about the call it is scanning for. */
export interface DetectContext {
  /**
   * Aborted when the layer's per-adapter timeout fires, or when the call
   * itself is abandoned. An adapter that does I/O must honour it.
   */
  signal: AbortSignal;
  /** The privacy scope this scan belongs to (a conversation or execution). */
  scopeId: string;
  orgId?: string;
  agentId?: string;
  /** What core already knows, so a service adapter can use it too. */
  knownValues: readonly KnownValue[];
  /** What earlier adapters in this run found, already validated. */
  priorSpans: readonly AttributedSpan[];
}

/** Reported on the admin page. */
export interface AdapterHealth {
  ok: boolean;
  /** Shown to an admin. Must not contain request text. */
  detail?: string;
}

/** Finds spans in text. Many run per call; their results are merged. */
export interface PrivacyDetector {
  /** Unique across the registry. Core's are `core.*`; use your own prefix. */
  id: string;
  egress: AdapterEgress;
  /** Where an `external` service processes data, e.g. `'UK'`, `'EU'`, `'US'`. */
  jurisdiction?: string;
  /** Every type this detector may report. A span of any other type is rejected. */
  entityTypes: readonly EntityType[];
  /** BCP 47 tags, if the detector only handles some languages. */
  languages?: readonly string[];
  detect(input: DetectInput, ctx: DetectContext): Promise<readonly DetectedSpan[]>;
  health?(): Promise<AdapterHealth>;
}

// ---------------------------------------------------------------------------
// Token strategy
// ---------------------------------------------------------------------------

/**
 * One scope's placeholder map: a chat turn's, a workflow step's, or a single
 * provider call's when it runs outside any scope. Created on the first masked
 * call in the scope, used by every masked call after it there, and discarded
 * with the scope, unless the strategy is persistent. So a value keeps its
 * placeholder across a turn's tool loop.
 */
export interface TokenSession {
  /**
   * The placeholder for `value`. The same value returns the same placeholder
   * for the life of the session.
   *
   * **Written as `[TYPE_n]`** — `formatPlaceholder()` in
   * `lib/privacy/pii/token-strategy.ts`. Restoring, its leniency (a missing
   * bracket, a possessive) and the masking of text that already looks like a
   * placeholder all read that grammar, so a strategy that writes another form
   * would have its placeholders reach the user unrestored.
   */
  placeholderFor(type: EntityType, value: string): string;
  /** The value behind a placeholder this session issued, or `undefined`. */
  valueFor(placeholder: string): string | undefined;
  /** Every placeholder issued so far, in the order they were issued. */
  entries(): readonly { placeholder: string; type: EntityType; value: string }[];
}

interface TokenStrategyBase {
  id: string;
  /** Start one scope's session (see {@link TokenSession}). */
  createSession(ctx: { scopeId: string; orgId?: string }): TokenSession;
}

/**
 * Decides what a placeholder looks like and how it maps back. Exactly one is
 * active.
 *
 * A strategy that stores the map between calls stores personal data, so it
 * must say so and say where: its tables then need a `SUBJECT_DATA_SOURCES`
 * row and an erasure path like any other personal-data table (CLAUDE.md,
 * "New `User` relations"). The registry refuses a persistent strategy that
 * names no table.
 */
export type PrivacyTokenStrategy =
  | (TokenStrategyBase & { persistent: false })
  | (TokenStrategyBase & {
      persistent: true;
      /** The Prisma models the map is stored in. */
      storesIn: readonly string[];
    });

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * What the layer does to a call. Listed least to most strict; see
 * {@link PRIVACY_MODES_BY_STRICTNESS}.
 *
 * - `off` — nothing. The call is untouched.
 * - `detect` — scan and count; send the call unchanged.
 * - `pseudonymise` — replace identifiers with placeholders, restore them in
 *   the reply and in tool-call arguments.
 * - `redact` — replace identifiers, never restore.
 * - `block` — refuse a call that contains any.
 */
export const PRIVACY_MODES_BY_STRICTNESS = [
  'off',
  'detect',
  'pseudonymise',
  'redact',
  'block',
] as const;

export type PrivacyMode = (typeof PRIVACY_MODES_BY_STRICTNESS)[number];

/** What to do when a detector fails. `block` is the stricter. */
export const DETECTOR_FAILURE_ACTIONS = ['fallback', 'block'] as const;

export type DetectorFailureAction = (typeof DETECTOR_FAILURE_ACTIONS)[number];

/** The resolved policy for one call. */
export interface PrivacyPolicy {
  mode: PrivacyMode;
  /**
   * Entity types left alone. Every other type the detectors find is acted on.
   * A list of exclusions rather than inclusions, so a type a new detector
   * introduces is protected by default.
   */
  ignoredEntityTypes: readonly EntityType[];
  /** Apply the layer to `isLocal` providers too. Off by default: the text never leaves. */
  protectLocalProviders: boolean;
  /** When a detector fails: carry on with the rest (`fallback`) or refuse the call. */
  onDetectorFailure: DetectorFailureAction;
}

/** What a resolver is told about the call. */
export interface PolicyInput {
  orgId?: string;
  agentId?: string;
  userId?: string;
  providerSlug: string;
  isLocalProvider: boolean;
}

/**
 * Decides policy for a call. Many may run. **A resolver can only make policy
 * stricter**: the layer combines its answer with the current one field by
 * field and keeps the stricter value, so a resolver that returns a looser
 * policy changes nothing. It never needs to be trusted to get that right.
 */
export interface PrivacyPolicyResolver {
  id: string;
  /**
   * Return the fields to tighten, `{}` or `undefined` for no change. `signal`
   * aborts at the resolver's timeout or when the call is abandoned; a resolver
   * that does I/O must honour it.
   */
  resolve(
    input: PolicyInput,
    current: PrivacyPolicy,
    ctx: { signal: AbortSignal }
  ): PolicyResolution | Promise<PolicyResolution>;
}

/** What a resolver returns: the fields to tighten, or nothing to change. */
export type PolicyResolution = Partial<PrivacyPolicy> | undefined;

// ---------------------------------------------------------------------------
// Observer
// ---------------------------------------------------------------------------

/**
 * What happened to one call. Counts and ids only: no value the layer found,
 * and no request text, ever reaches an observer.
 */
export interface PrivacyEvent {
  scopeId: string;
  orgId?: string;
  agentId?: string;
  providerSlug: string;
  mode: PrivacyMode;
  /** Spans acted on, by entity type. */
  counts: Readonly<Record<EntityType, number>>;
  /** A detector failed or timed out and the call went ahead without it. */
  degraded: boolean;
  /** Ids of the adapters that failed. */
  failedAdapters: readonly string[];
  outcome: 'sent' | 'refused' | 'skipped';
}

/** Receives a {@link PrivacyEvent} per call. Cannot affect the call. */
export interface PrivacyObserver {
  id: string;
  observe(event: PrivacyEvent): void | Promise<void>;
}
