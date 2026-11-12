/**
 * The privacy adapter registry (§127).
 *
 * Holds every adapter the privacy layer runs: Sunrise's own defaults
 * (`core-defaults.ts`) and whatever an app registers from
 * `lib/app/privacy-adapters.ts`. Core goes in first, then the app's init runs
 * through the shared fork-init gate, once, lazily, at the top of every public
 * read — so whichever bundle realm reads first gets the same contents
 * (`.context/architecture/fork-init-seams.md`).
 *
 * **A failed app init is remembered, not just rolled back.** Every other
 * degrade-style seam falls back to Sunrise's own behaviour, and for them that
 * is the safe answer. Here it is not: an app that registered a required
 * service detector, or a stricter policy resolver, would otherwise run on
 * core alone while believing its own protection was live. So the gate still
 * rolls the registry back, and {@link getPrivacyAdapters} reports
 * `appInitFailure`; the privacy stage then refuses EVERY call, whatever the
 * mode, because a rolled-back resolver may have been what raised it from
 * `off`. A core adapter that fails to install is reported as `coreFailure`,
 * and refuses every call for the same reason: the install stops at the
 * first throw, so core's own policy resolvers may be among what is missing.
 *
 * @see .context/privacy/llm-privacy-layer.md — the binding spec
 */
import { initAppPrivacyAdapters } from '@/lib/app/privacy-adapters';
import { createAppInitGate, describeThrown, restoreMap } from '@/lib/fork-init';
import { logger } from '@/lib/logging';
import { corePrivacyAdapters } from '@/lib/privacy/adapters/core-defaults';
import { formatPlaceholder, LITERAL_TYPE } from '@/lib/privacy/pii/token-strategy';
import {
  ADAPTER_EGRESS_VALUES,
  ENTITY_TYPE_PATTERN,
  type AdapterEgress,
  type EntityType,
  type PrivacyDetector,
  type PrivacyObserver,
  type PrivacyPolicyResolver,
  type PrivacyTokenStrategy,
} from '@/lib/privacy/adapters/types';

/** The id prefix reserved for Sunrise's own adapters. */
export const CORE_ADAPTER_PREFIX = 'core.';

/** Default per-detector timeout. A service adapter usually wants less. */
export const DEFAULT_DETECTOR_TIMEOUT_MS = 1000;

/** The longest timeout a detector may ask for. */
export const MAX_DETECTOR_TIMEOUT_MS = 30_000;

/** How a detector is registered. */
export interface DetectorRegistrationOptions {
  /**
   * A required detector that fails makes the call fail or fall back as the
   * policy says (`onDetectorFailure`); an optional one is skipped and the call
   * marked degraded. Default `false` for an app's detector, and `true` for one
   * that replaces a core detector, since it stands in for one that was
   * required. Core's are always required.
   */
  required?: boolean;
  /** Enforced through the detector's abort signal. Default {@link DEFAULT_DETECTOR_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * The id of a core detector this one replaces. The core detector stops
   * running and the admin page shows it as replaced. The only way to turn a
   * core detector off, so it cannot happen by accident.
   */
  replace?: string;
}

/** A registered detector, as the registry holds it. Frozen. */
export interface DetectorRegistration {
  readonly detector: PrivacyDetector;
  /**
   * The detector's `id`, `egress`, `jurisdiction` and `entityTypes` as they
   * were when validated, copied and frozen. The layer reads these, never the
   * detector object's own fields, which a getter or a later assignment could
   * change after validation.
   */
  readonly id: string;
  readonly egress: AdapterEgress;
  readonly jurisdiction: string | undefined;
  readonly entityTypes: readonly EntityType[];
  readonly required: boolean;
  readonly timeoutMs: number;
  readonly core: boolean;
  /** Replaces a core detector, so it runs and ranks in that detector's place. */
  readonly replacesCore: string | undefined;
}

/** How a policy resolver is registered. */
export interface PolicyResolverRegistrationOptions {
  /** Enforced through the resolver's abort signal. Default {@link DEFAULT_DETECTOR_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** A registered policy resolver, as the registry holds it. Frozen. */
export interface PolicyResolverRegistration {
  readonly resolver: PrivacyPolicyResolver;
  /** The id as validated; read this, not `resolver.id`. */
  readonly id: string;
  readonly timeoutMs: number;
  readonly core: boolean;
}

/** A registered observer, as the registry holds it. Frozen. */
export interface ObserverRegistration {
  readonly observer: PrivacyObserver;
  /** The id as validated; read this, not `observer.id`. */
  readonly id: string;
  readonly core: boolean;
}

/** Everything the privacy layer runs, read in one go. */
export interface PrivacyAdapterSnapshot {
  /**
   * In run order: `in_process` first, then `self_hosted`, then `external`;
   * registration order within each, core before app.
   */
  detectors: readonly DetectorRegistration[];
  /** `null` until one is registered. */
  tokenStrategy: PrivacyTokenStrategy | null;
  /** In registration order, core first. */
  policyResolvers: readonly PolicyResolverRegistration[];
  observers: readonly ObserverRegistration[];
  /** Core detectors an app replaced, by id. */
  replacedCoreDetectors: readonly string[];
  /**
   * Set when the app's `initAppPrivacyAdapters()` threw and was rolled back.
   * The stage refuses EVERY call while it is set, mode `off` included: what
   * was rolled back may have been the resolver that raised the mode.
   */
  appInitFailure: string | null;
  /**
   * Set when one of Sunrise's own adapters failed to install. The stage
   * refuses every call, mode `off` included: the install stops at the first
   * throw, so core's own policy resolvers may be missing. Kept apart from
   * `appInitFailure` so neither message hides the other.
   */
  coreFailure: string | null;
}

const detectors = new Map<string, DetectorRegistration>();
/** Replaced core detector id → the id of the detector that replaced it. */
const replacedCore = new Map<string, string>();
const policyResolvers = new Map<string, PolicyResolverRegistration>();
const observers = new Map<string, ObserverRegistration>();
/** One slot, held in a Map so the gate can snapshot and restore it like the rest. */
const tokenStrategySlot = new Map<'active', { strategy: PrivacyTokenStrategy; core: boolean }>();

let coreInstalled = false;
let coreFailure: string | null = null;
let appInitFailure: string | null = null;
/**
 * True while the app's init is on the stack (from the gate's snapshot to its
 * verdict). A replacement made then is logged only once the init succeeds, so
 * a rolled-back one is never reported as having happened.
 */
let initRunning = false;

interface Snapshot {
  detectors: Map<string, DetectorRegistration>;
  replacedCore: Map<string, string>;
  policyResolvers: Map<string, PolicyResolverRegistration>;
  observers: Map<string, ObserverRegistration>;
  tokenStrategySlot: Map<'active', { strategy: PrivacyTokenStrategy; core: boolean }>;
}

function logReplacedCoreDetector(replaced: string, by: string): void {
  logger.warn('privacy-adapters: a core detector was replaced', { replaced, by });
}

function logReplacedTokenStrategy(replaced: string, by: string): void {
  logger.info('privacy-adapters: token strategy replaced', { replaced, by });
}

const appInit = createAppInitGate<Snapshot>({
  label: 'privacy-adapters: initAppPrivacyAdapters',
  subject: 'app privacy adapters',
  init: initAppPrivacyAdapters,
  // Every map and set the registry owns, or a rolled-back init leaves an entry
  // behind (platform.seam-design).
  snapshot: () => {
    initRunning = true;
    return {
      detectors: new Map(detectors),
      replacedCore: new Map(replacedCore),
      policyResolvers: new Map(policyResolvers),
      observers: new Map(observers),
      tokenStrategySlot: new Map(tokenStrategySlot),
    };
  },
  restore: (before) => {
    restoreMap(detectors, before.detectors);
    restoreMap(replacedCore, before.replacedCore);
    restoreMap(policyResolvers, before.policyResolvers);
    restoreMap(observers, before.observers);
    restoreMap(tokenStrategySlot, before.tokenStrategySlot);
  },
  onSuccess: (before) => {
    initRunning = false;
    for (const [replaced, by] of replacedCore) {
      if (!before.replacedCore.has(replaced)) logReplacedCoreDetector(replaced, by);
    }
    const was = before.tokenStrategySlot.get('active')?.strategy;
    const now = tokenStrategySlot.get('active')?.strategy;
    if (was && now && was !== now) logReplacedTokenStrategy(was.id, now.id);
  },
  onFailure: (err) => {
    initRunning = false;
    appInitFailure = `the app's initAppPrivacyAdapters() threw: ${describeThrown(err)}`;
  },
});

function ensureLoaded(): void {
  installCoreOnce();
  // Cleared here as well as in the gate's hooks: whatever path the gate took,
  // once ensure() has settled the init is no longer on the stack.
  if (appInit.ensure() !== 'running') initRunning = false;
}

/** Put Sunrise's own adapters in, once, before anything else reads or registers. */
function installCoreOnce(): void {
  if (coreInstalled) return;
  coreInstalled = true;
  try {
    const core = corePrivacyAdapters();
    for (const { detector, timeoutMs } of core.detectors) {
      addDetector(detector, { required: true, timeoutMs }, true);
    }
    if (core.tokenStrategy) setTokenStrategy(core.tokenStrategy, true);
    for (const { resolver, timeoutMs } of core.policyResolvers) {
      addPolicyResolver(resolver, timeoutMs === undefined ? {} : { timeoutMs }, true);
    }
    for (const observer of core.observers) addObserver(observer, true);
  } catch (err) {
    coreFailure = `a core privacy adapter failed to install: ${describeThrown(err)}`;
    logger.error('privacy-adapters: core adapter install failed', { error: describeThrown(err) });
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function checkId(kind: string, id: unknown, core: boolean): string {
  if (typeof id !== 'string' || id.trim() === '' || id !== id.trim()) {
    throw new Error(`${kind}: id must be a non-empty string with no surrounding spaces`);
  }
  if (core !== id.startsWith(CORE_ADAPTER_PREFIX)) {
    throw new Error(
      core
        ? `${kind} ${id}: a core adapter's id must start with "${CORE_ADAPTER_PREFIX}"`
        : `${kind} ${id}: the "${CORE_ADAPTER_PREFIX}" prefix is reserved for Sunrise's own adapters`
    );
  }
  return id;
}

function checkFunction(kind: string, id: string, name: string, isFunction: boolean): void {
  if (!isFunction) throw new Error(`${kind} ${id}: ${name} is not a function`);
}

function isEgress(value: unknown): value is AdapterEgress {
  return ADAPTER_EGRESS_VALUES.some((egress) => egress === value);
}

// ---------------------------------------------------------------------------
// Registration (internal, shared by core and app)
// ---------------------------------------------------------------------------

function addDetector(
  detector: PrivacyDetector,
  options: DetectorRegistrationOptions,
  core: boolean
): void {
  const kind = 'privacy detector';
  const id = checkId(kind, detector.id, core);
  if (detectors.has(id)) throw new Error(`${kind} ${id}: already registered`);
  // Each field is read ONCE, and the value checked is the value kept.
  const egress: unknown = detector.egress;
  if (!isEgress(egress)) {
    throw new Error(`${kind} ${id}: egress must be one of ${ADAPTER_EGRESS_VALUES.join(', ')}`);
  }
  const jurisdiction: unknown = detector.jurisdiction;
  if (jurisdiction !== undefined && typeof jurisdiction !== 'string') {
    throw new Error(`${kind} ${id}: jurisdiction must be a string`);
  }
  const declared: unknown = detector.entityTypes;
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error(`${kind} ${id}: entityTypes must list at least one type`);
  }
  const entityTypes: EntityType[] = [];
  for (const type of declared) {
    if (typeof type !== 'string' || !ENTITY_TYPE_PATTERN.test(type)) {
      throw new Error(`${kind} ${id}: entity type ${String(type)} is not a valid name`);
    }
    // Reserved for text that only looked like a placeholder: a detection under
    // it would be counted as a look-alike and numbered with them.
    if (type === LITERAL_TYPE) {
      throw new Error(`${kind} ${id}: entity type ${LITERAL_TYPE} is reserved`);
    }
    entityTypes.push(type);
  }
  const required: unknown = options.required;
  if (required !== undefined && typeof required !== 'boolean') {
    throw new Error(`${kind} ${id}: required must be true or false`);
  }
  checkFunction(kind, id, 'detect', typeof detector.detect === 'function');
  if (detector.health !== undefined)
    checkFunction(kind, id, 'health', typeof detector.health === 'function');

  const timeoutMs = checkTimeout(kind, id, options.timeoutMs);

  if (options.replace !== undefined) {
    const target = detectors.get(options.replace);
    if (!target?.core) {
      throw new Error(
        `${kind} ${id}: replace names ${options.replace}, which is not a registered core detector`
      );
    }
  }

  const registration: DetectorRegistration = Object.freeze({
    detector,
    id,
    egress,
    jurisdiction,
    entityTypes: Object.freeze(entityTypes),
    // A replacement stands in for a core detector, and core's are required,
    // so it is required unless the app says otherwise.
    required: core || (required ?? options.replace !== undefined),
    timeoutMs,
    core,
    replacesCore: options.replace,
  });

  if (options.replace === undefined) {
    detectors.set(id, registration);
    return;
  }
  // In the replaced detector's place, so it runs where that one ran (its
  // spans reach the same later detectors) and wins the same tie-breaks.
  const entries = [...detectors];
  detectors.clear();
  for (const [key, value] of entries) {
    if (key === options.replace) detectors.set(id, registration);
    else detectors.set(key, value);
  }
  replacedCore.set(options.replace, id);
  // Inside the init, onSuccess logs it once the init can no longer roll back.
  if (!initRunning) logReplacedCoreDetector(options.replace, id);
}

function checkTimeout(kind: string, id: string, requested: number | undefined): number {
  const timeoutMs = requested ?? DEFAULT_DETECTOR_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_DETECTOR_TIMEOUT_MS) {
    throw new Error(`${kind} ${id}: timeoutMs must be between 1 and ${MAX_DETECTOR_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

function checkPlaceholderForm(kind: string, id: string, strategy: PrivacyTokenStrategy): void {
  // `orgId` is optional in the contract, so a strategy must work without one.
  // Two types: a detected one, and LITERAL, which masking always uses.
  for (const type of ['PERSON', LITERAL_TYPE]) {
    let placeholder: string;
    let back: string | undefined;
    try {
      const session = strategy.createSession({ scopeId: 'privacy-registry-check' });
      placeholder = session.placeholderFor(type, 'check');
      back = session.valueFor(placeholder);
    } catch (err) {
      throw new Error(`${kind} ${id}: creating a session failed (${describeThrown(err)})`);
    }
    const n = /_(\d+)/.exec(placeholder)?.[1];
    if (n === undefined || placeholder !== formatPlaceholder(type, n) || back !== 'check') {
      throw new Error(
        `${kind} ${id}: placeholders must be written as ${formatPlaceholder('PERSON', 1)} and map back to their value`
      );
    }
  }
}

function setTokenStrategy(strategy: PrivacyTokenStrategy, core: boolean): void {
  const kind = 'privacy token strategy';
  const id = checkId(kind, strategy.id, core);
  checkFunction(kind, id, 'createSession', typeof strategy.createSession === 'function');
  const persistent: unknown = strategy.persistent;
  if (persistent !== true && persistent !== false) {
    throw new Error(`${kind} ${id}: persistent must be declared true or false`);
  }
  // Restore reads placeholders as `[TYPE_n]`. A strategy that stores nothing
  // is tried once, so one writing another form fails here, loudly, rather
  // than leaving every reply unrestored. A persistent one is not tried: its
  // sessions may write to its tables. It must follow the same form.
  if (!persistent) checkPlaceholderForm(kind, id, strategy);
  // `persistent` is read once, above; a getter must not answer differently here.
  if (persistent) {
    const storesIn: unknown = 'storesIn' in strategy ? strategy.storesIn : undefined;
    if (
      !Array.isArray(storesIn) ||
      storesIn.length === 0 ||
      !storesIn.every((m) => typeof m === 'string' && m.trim() !== '')
    ) {
      throw new Error(
        `${kind} ${id}: a persistent strategy stores personal data and must name the models it stores in (storesIn)`
      );
    }
  }
  const current = tokenStrategySlot.get('active');
  if (current && !current.core && !core) {
    throw new Error(
      `${kind} ${id}: ${current.strategy.id} is already registered, and only one strategy is active`
    );
  }
  if (current && !initRunning) logReplacedTokenStrategy(current.strategy.id, id);
  tokenStrategySlot.set('active', { strategy, core });
}

function addPolicyResolver(
  resolver: PrivacyPolicyResolver,
  options: PolicyResolverRegistrationOptions,
  core: boolean
): void {
  const kind = 'privacy policy resolver';
  const id = checkId(kind, resolver.id, core);
  if (policyResolvers.has(id)) throw new Error(`${kind} ${id}: already registered`);
  checkFunction(kind, id, 'resolve', typeof resolver.resolve === 'function');
  const timeoutMs = checkTimeout(kind, id, options.timeoutMs);
  policyResolvers.set(id, Object.freeze({ resolver, id, timeoutMs, core }));
}

function addObserver(observer: PrivacyObserver, core: boolean): void {
  const kind = 'privacy observer';
  const id = checkId(kind, observer.id, core);
  if (observers.has(id)) throw new Error(`${kind} ${id}: already registered`);
  checkFunction(kind, id, 'observe', typeof observer.observe === 'function');
  observers.set(id, Object.freeze({ observer, id, core }));
}

// ---------------------------------------------------------------------------
// Public registration — call these from initAppPrivacyAdapters()
// ---------------------------------------------------------------------------

/**
 * Add a detector. It runs alongside core's, and its spans are merged with
 * theirs. Pass `{ replace: 'core.<id>' }` to turn a core detector off in its
 * favour. Throws on a malformed detector, a duplicate id, or a `replace` that
 * names no core detector — inside `initAppPrivacyAdapters()` that rolls back
 * everything the init registered and the layer refuses every call until it is
 * fixed.
 */
export function registerPrivacyDetector(
  detector: PrivacyDetector,
  options: DetectorRegistrationOptions = {}
): void {
  installCoreOnce();
  addDetector(detector, options, false);
}

/**
 * Replace the token strategy. Exactly one is active, so this displaces core's
 * default; a second app strategy throws.
 */
export function registerPrivacyTokenStrategy(strategy: PrivacyTokenStrategy): void {
  installCoreOnce();
  setTokenStrategy(strategy, false);
}

/** Add a policy resolver. It can only make a call's policy stricter. */
export function registerPrivacyPolicyResolver(
  resolver: PrivacyPolicyResolver,
  options: PolicyResolverRegistrationOptions = {}
): void {
  installCoreOnce();
  addPolicyResolver(resolver, options, false);
}

/** Add an observer. It receives counts and ids per call, never values. */
export function registerPrivacyObserver(observer: PrivacyObserver): void {
  installCoreOnce();
  addObserver(observer, false);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

const EGRESS_ORDER: Record<AdapterEgress, number> = { in_process: 0, self_hosted: 1, external: 2 };

/** Everything the privacy layer runs. Loads core and the app's init on first call. */
export function getPrivacyAdapters(): PrivacyAdapterSnapshot {
  ensureLoaded();
  const ordered = [...detectors.values()]
    .map((registration, index) => ({ registration, index }))
    .sort(
      (a, b) =>
        EGRESS_ORDER[a.registration.egress] - EGRESS_ORDER[b.registration.egress] ||
        a.index - b.index
    )
    .map(({ registration }) => registration);
  return {
    detectors: ordered,
    tokenStrategy: tokenStrategySlot.get('active')?.strategy ?? null,
    policyResolvers: [...policyResolvers.values()],
    observers: [...observers.values()],
    replacedCoreDetectors: [...replacedCore.keys()],
    appInitFailure,
    coreFailure,
  };
}

/**
 * Test-only: empty the registry and re-arm both the core install and the app
 * init, so each test starts from a known state.
 */
export function __resetPrivacyAdaptersForTests(): void {
  detectors.clear();
  replacedCore.clear();
  policyResolvers.clear();
  observers.clear();
  tokenStrategySlot.clear();
  coreInstalled = false;
  coreFailure = null;
  appInitFailure = null;
  initRunning = false;
  appInit.reset();
}
