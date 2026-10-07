/**
 * Provider Manager
 *
 * Factory + cache for `LlmProvider` instances, keyed off
 * `AiProviderConfig` rows from Prisma. This is the single place where
 * we translate persisted provider configuration into ready-to-use
 * SDK-backed provider objects:
 *
 *   AiProviderConfig row
 *     → resolve the credential (provider-credentials.ts; default process.env[apiKeyEnvVar])
 *     → instantiate AnthropicProvider or OpenAiCompatibleProvider
 *     → cache by slug
 *
 * Callers (chat handler, workflow engine, evaluation harness) go
 * through `getProvider(slug)` and never touch the database or SDKs
 * directly.
 *
 * Platform-agnostic: no Next.js imports. The cache is a plain `Map`
 * in module state — no `React cache()`, no request-scoped lifecycles.
 *
 * Tenancy posture: shared-by-decision — rows are global config; the clients
 * built from them are keyed per credential identity, so one org's key never
 * serves another, and the install's shared credential is shared by decision
 * (§120 t-744) (lib/tenancy/process-state.ts).
 */

import type { AiProviderConfig } from '@/types/prisma';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { checkSafeProviderUrl } from '@/lib/security/safe-url';
import { AnthropicProvider } from '@/lib/orchestration/llm/anthropic';
import { getBreaker, peekBreaker } from '@/lib/orchestration/llm/circuit-breaker';
import { credentialKey } from '@/lib/orchestration/llm/credential-key';
import {
  hasProviderCredentialResolver,
  hasProviderKey,
  readEnvKey,
  resolveProviderCredential,
} from '@/lib/orchestration/llm/provider-credentials';
import {
  assertProviderCallPermitted,
  fallbackCallContext,
  isProviderEligible,
  primaryCallContext,
  type BindingProvenance,
  type CallOrigin,
  type ProviderEligibilityContext,
} from '@/lib/orchestration/llm/provider-eligibility';
import { track, trackStream } from '@/lib/orchestration/llm/in-flight-counter';
import { OpenAiCompatibleProvider } from '@/lib/orchestration/llm/openai-compatible';
import { forgetProviderRow } from '@/lib/orchestration/llm/org-provider-policy';
import { hydrateFromDb as hydrateModelRegistryFromDb } from '@/lib/orchestration/llm/model-registry-db-hydrate';
import {
  ProviderError,
  type LlmProvider,
  type ProviderTestResult,
} from '@/lib/orchestration/llm/provider';
import type { ProviderConfig } from '@/lib/orchestration/llm/types';
import { VoyageProvider } from '@/lib/orchestration/llm/voyage';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import { parseAudioDefault } from '@/lib/orchestration/llm/audio-default';
import type { TaskType } from '@/types/orchestration';

/** Status returned by `listProviders` for each configured row. */
export interface ProviderStatus {
  config: AiProviderConfig;
  status: 'ok' | 'error' | 'unknown';
  models?: string[];
  error?: string;
}

/**
 * Row shape returned by `listProvidersWithStatus`. Hydrates an
 * `AiProviderConfig` with runtime metadata the admin API needs:
 *
 *   - `apiKeyPresent` — whether the credential seam gives the row a key in
 *     this context (`hasProviderKey`; by default, whether
 *     `process.env[row.apiKeyEnvVar]` is set). The value is never returned.
 *   - `status` — last-known health; always `'unknown'` unless the caller
 *     has already invoked `testProvider` for this slug in-process.
 *
 * This is the single place admin routes call for provider listings; it
 * guarantees the no-secrets rule cannot be accidentally bypassed.
 */
export interface ProviderConfigWithStatus {
  config: AiProviderConfig;
  apiKeyPresent: boolean;
  status: 'ok' | 'error' | 'unknown';
}

/** How long (ms) a cached provider instance is considered fresh. */
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** One constructed client: a row (or registrar name) used with one credential. */
interface BuiltProvider {
  /** The built instance, unwrapped. Never handed out: every read goes through {@link viewOf}. */
  instance: LlmProvider;
  /**
   * The slug the call-time gate evaluates: the BUILT row's `config.slug`, or a
   * registrar's name — never the string a caller asked `getProvider` for.
   */
  slug: string;
  /**
   * The credential's identity (`provider-credentials.ts`); `''` for the shared
   * one. With `slug` it makes the key the in-flight counter and the circuit
   * breaker use, so one org's key never shares state with another's.
   */
  identity: string;
  /**
   * One Proxy per call origin. The gate needs to know where the provider came
   * from and the instance is shared by every caller with this credential, so
   * the origin lives on the view each caller is handed rather than on the
   * instance. Kept so that repeat reads with the same origin return the same
   * object. Bounded by tasks × sources × primary slugs, dropped with the row.
   */
  views: Map<string, LlmProvider>;
}

/**
 * A cached provider row and the clients built from it, one per credential
 * identity (§120 t-744). Keyed by slug, and by a registrar's name.
 *
 * The client is keyed on the credential, not the row: a credential resolver
 * may give two orgs different keys for one row, and a client built with org
 * A's key must never serve org B. Rows are cached so the database is not read
 * per call; the resolver is asked per call, because which credential applies
 * depends on the org in context.
 */
interface CachedRow {
  /** The row, or `null` for a registrar entry, which carries its own key and bypasses the resolver. */
  config: AiProviderConfig | null;
  slug: string;
  cachedAt: number;
  byIdentity: Map<string, BuiltProvider>;
}

const instanceCache = new Map<string, CachedRow>();

/** Which credential key each view counts and breaks under. See {@link breakerKeyOf}. */
const viewKeys = new WeakMap<LlmProvider, string>();

function isFresh(row: CachedRow | undefined): row is CachedRow {
  return row !== undefined && Date.now() - row.cachedAt < CACHE_TTL_MS;
}

function newBuilt(instance: LlmProvider, slug: string, identity: string): BuiltProvider {
  const built: BuiltProvider = { instance, slug, identity, views: new Map() };
  // Build the unprovenanced view now, so an unwrappable instance (an empty
  // slug) throws when it is built rather than on its first read.
  viewOf(built, undefined);
  return built;
}

/** A registrar's entry: no row, its own key, the shared identity. */
function registrarRow(instance: LlmProvider, name: string): CachedRow {
  const built = newBuilt(instance, name, '');
  return { config: null, slug: name, cachedAt: Date.now(), byIdentity: new Map([['', built]]) };
}

/** The gated, in-flight-tracked view of `built` for one call origin. */
function viewOf(built: BuiltProvider, origin: CallOrigin): LlmProvider {
  const key = !origin
    ? ''
    : 'source' in origin
      ? `${origin.task}|${origin.source}|${origin.primarySlug ?? ''}`
      : `unrecorded-fallback|${origin.unrecordedFallbackOf}`;
  let view = built.views.get(key);
  if (!view) {
    const stateKey = credentialKey(built.slug, built.identity);
    view = withInFlightTracking(built.instance, built.slug, origin, stateKey);
    viewKeys.set(view, stateKey);
    built.views.set(key, view);
  }
  return view;
}

/**
 * The circuit-breaker key for a provider `getProvider` returned: its slug
 * joined with its credential's identity (`credential-key.ts`). Pass it to
 * `getBreaker`, so a failure is recorded against the credential that failed
 * and not against every org using the row. `undefined` for an object that did
 * not come from the manager (a test double); fall back to the slug then.
 */
export function breakerKeyOf(provider: LlmProvider): string | undefined {
  return viewKeys.get(provider);
}

/**
 * Resolve a provider instance by slug (or name).
 *
 * Loads the `AiProviderConfig` row, validates it, resolves the API key
 * through the credential seam (`provider-credentials.ts`; by default the
 * row's env var), constructs the concrete provider, and caches it under the
 * row's slug and the credential's identity.
 *
 * Cached rows and clients are evicted after `CACHE_TTL_MS` (5 minutes) so
 * that config changes in the database take effect without a restart. The
 * credential is resolved on every call, because which one applies depends on
 * the org in context; a rotated key under an unchanged identity takes effect
 * when the TTL expires, as an edited env var always has.
 *
 * `context` is where the caller got this provider from — see
 * `assertProviderCallPermitted`, which every vendor call on the returned
 * object passes through. Pass it wherever it is known: without it a call is
 * permitted only if the eligibility rule permits it both as an auto-picked and
 * as an operator-chosen primary.
 *
 * A slug match wins over a name match. The two used to be one
 * `findFirst({ OR: [...] })` with no ordering, so a caller holding row A's slug
 * could be handed row B, whose NAME equals A's slug. The gate evaluates the
 * built row's own slug either way, so that was never a policy bypass, but a
 * caller that checked A should get A.
 */
export async function getProvider(
  slugOrName: string,
  context?: ProviderEligibilityContext
): Promise<LlmProvider> {
  return acquireProvider(slugOrName, context);
}

/** `getProvider` for any call origin, including an unrecorded fallback. */
async function acquireProvider(slugOrName: string, context: CallOrigin): Promise<LlmProvider> {
  // Every LLM call resolves its provider here before its cost is computed, so
  // the registry must hold the matrix's models by now — otherwise a model only
  // the matrix knows is costed at $0 in a module graph that never hydrated
  // (#813). Throttled and soft-failing, so this is one SELECT a minute at most.
  await hydrateModelRegistryFromDb();
  let row = instanceCache.get(slugOrName);
  if (!isFresh(row)) {
    const config =
      (await prisma.aiProviderConfig.findFirst({ where: { slug: slugOrName } })) ??
      (await prisma.aiProviderConfig.findFirst({ where: { name: slugOrName } }));

    if (!config) {
      throw new ProviderError(`Provider "${slugOrName}" not found`, {
        code: 'provider_not_found',
        retriable: false,
      });
    }

    if (!config.isActive) {
      throw new ProviderError(`Provider "${config.slug}" is disabled`, {
        code: 'provider_disabled',
        retriable: false,
      });
    }

    // A name lookup lands here on every call (it is not cached under the
    // name), so reuse the slug's live row rather than replacing it and the
    // clients every slug caller shares. Cached under the row's slug only: a
    // name alias outlived the "slug wins" rule, shadowing a row created later
    // with that string as its SLUG until the TTL ran out.
    const live = instanceCache.get(config.slug);
    if (isFresh(live)) {
      row = live;
    } else {
      row = { config, slug: config.slug, cachedAt: Date.now(), byIdentity: new Map() };
      instanceCache.set(config.slug, row);
    }
  }

  if (!row.config) {
    // A registrar entry: built with its own key, outside the credential seam.
    const built = row.byIdentity.get('');
    if (!built) throw new Error(`Registered provider "${row.slug}" has no instance`);
    return viewOf(built, context);
  }

  const credential = await resolveProviderCredential(row.config);
  let built = row.byIdentity.get(credential.identity);
  if (!built) {
    // Once per client build, as before the seam — not on every reachability
    // check, which now runs the same credential read every turn.
    if (!credential.apiKey && row.config.apiKeyEnvVar && !hasProviderCredentialResolver()) {
      logger.warn('Provider apiKeyEnvVar is set but process.env value is empty', {
        provider: row.config.slug,
        envVar: row.config.apiKeyEnvVar,
      });
    }
    built = newBuilt(
      buildProviderFromConfig(row.config, credential.apiKey),
      row.config.slug,
      credential.identity
    );
    row.byIdentity.set(credential.identity, built);
  }
  return viewOf(built, context);
}

/**
 * How the in-flight Proxy treats one method on the provider surface.
 *
 *  - `'track'` — a single-shot vendor call; wrapped in `track(key, …)`, where
 *    `key` is `credentialKey(slug, identity)` (§120 t-744).
 *  - `'trackStream'` — a vendor call returning an `AsyncIterable`; wrapped in
 *    `trackStream(key, …)`, which holds the count until the stream settles.
 *  - `'passthrough'` — reaches the vendor but is deliberately NOT counted:
 *    short admin-metadata calls that are not part of the runtime workload the
 *    dashboard measures. Listing them is not a formality — it is the
 *    difference between "we decided not to count this" and "nobody looked".
 */
type MethodDisposition = 'track' | 'trackStream' | 'passthrough';

/**
 * Every method member of `LlmProvider`, optional ones included.
 *
 * Derived from the interface rather than written out, so
 * {@link METHOD_DISPOSITION} below cannot compile while a method exists that
 * nobody has classified.
 */
type ProviderMethodName = {
  [K in keyof LlmProvider]-?: NonNullable<LlmProvider[K]> extends (...args: never[]) => unknown
    ? K
    : never;
}[keyof LlmProvider];

/**
 * The complete classification of the provider surface.
 *
 * **This is an allowlist, not an opt-in list, and that is the point.** The
 * previous shape was two `Set`s of method names: anything absent from both was
 * silently forwarded, so adding a method to `LlmProvider` made a new vendor-
 * reaching operation that nothing counted and nothing could gate, with no
 * signal of any kind. `transcribeStream` sat in exactly that state from the day
 * it was added — latent only because no shipped provider implements it.
 *
 * `Record<ProviderMethodName, …>` makes that impossible: the type is derived
 * from the interface, so a new method is a type error here until someone
 * decides what it is. That is the whole mechanism — a compile-time failure at
 * the moment the surface widens, rather than a runtime hole discovered later.
 *
 * See `.context/orchestration/llm-providers.md` for the outbound-egress
 * guarantee this supports, and its limits.
 */
const METHOD_DISPOSITION: Record<ProviderMethodName, MethodDisposition> = {
  // Every `track` / `trackStream` method is also gated by
  // `assertProviderCallPermitted`; `passthrough` is not. See TASK_OF_METHOD.
  chat: 'track',
  embed: 'track',
  embedMany: 'track',
  transcribe: 'track',
  chatStream: 'trackStream',
  transcribeStream: 'trackStream',
  listModels: 'passthrough',
  testConnection: 'passthrough',
};

/**
 * Method names that every object carries and no vendor ever sees.
 *
 * Written out rather than tested with `prop in Object.prototype`, which was the
 * first cut. That version asked a *mutable* object what counts as host
 * machinery: anything that writes to `Object.prototype` — a prototype-pollution
 * gadget, or a careless polyfill — widens the exemption by exactly the name it
 * writes, and a provider method with that name would then be forwarded instead
 * of refused. It grants nothing today, because no provider in the tree has an
 * unclassified method to forward; under the architecture this is groundwork for
 * a fork's provider does, and the refusal is the whole control.
 *
 * A fixed list also fails in the right direction. A future runtime adding a
 * member to `Object.prototype` gets refused rather than silently exempted, and
 * the error names the file to edit.
 *
 * `ReadonlySet` is a compile-time claim, not a runtime one — a `Set` cannot be
 * meaningfully frozen, since `Object.freeze` does not stop `Set.prototype.add`.
 * What makes it safe is that it is module-private and unexported, so no caller
 * has a reference to mutate. Do not export it.
 *
 * `constructor` is deliberately NOT in this set: it is handled by its own
 * branch at the call site, which runs first and returns it unbound. Listing it
 * here as well would be a dead entry whose presence implied this set was what
 * protected it.
 */
const HOST_MACHINERY: ReadonlySet<string> = new Set([
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

/**
 * The task the gate assumes for a call whose caller recorded no provenance.
 * Only the gated methods need one. A recorded context carries its own task,
 * which wins: a summariser `chat` call made for a chat binding is still `chat`,
 * and a routing call is `routing`, which no method name can tell apart.
 */
function taskOfMethod(prop: ProviderMethodName): TaskType {
  switch (prop) {
    case 'embed':
    case 'embedMany':
      return 'embeddings';
    case 'transcribe':
    case 'transcribeStream':
      return 'audio';
    default:
      return 'chat';
  }
}

function dispositionOf(prop: string): MethodDisposition | undefined {
  return Object.prototype.hasOwnProperty.call(METHOD_DISPOSITION, prop)
    ? METHOD_DISPOSITION[prop as ProviderMethodName]
    : undefined;
}

/**
 * Wrap a freshly-built provider so its vendor calls are refused when the
 * eligibility rule says so, accounted in the in-flight counter under
 * `stateKey` (the slug, or slug + credential identity),
 * and so no unclassified method on the instance can reach a vendor unnoticed.
 *
 * Uses a `Proxy` so the returned value preserves the original prototype —
 * existing call sites (and tests) doing `instanceof AnthropicProvider` keep
 * working. The handler rebinds intercepted methods to the original target so
 * `this` inside the SDK call is the real provider instance, which also means a
 * provider's own internal `this.foo()` calls never re-enter the trap.
 *
 * Wrapping happens once per cache entry and call provenance (see
 * {@link viewOf}), not per call, so the proxy cost is negligible; the closures
 * it returns run per call.
 *
 * **Every `track` / `trackStream` call is gated** by
 * `assertProviderCallPermitted` against `slug` and `context` (§120 t-741), so
 * the provider eligibility rule applies to every vendor call core makes through
 * the manager, whichever site chose the provider. `passthrough` methods are not
 * gated; that function says why. Throws on an empty `slug`,
 * because the alternative — returning the instance unwrapped — is the one way
 * the cache's invariant could quietly fail.
 *
 * **Unclassified methods throw on access.** A function property that is not on
 * {@link METHOD_DISPOSITION} and not host machinery is a method someone added
 * to a concrete provider class without putting it on the `LlmProvider`
 * contract. Forwarding it would reproduce the hole this function exists to
 * close, one class at a time instead of one interface at a time, so it is
 * refused. Throwing on *access* rather than on call is deliberate: feature
 * detection (`if (provider.newThing)`) is exactly how such a method gets
 * called, and it should fail there too.
 */
function withInFlightTracking(
  provider: LlmProvider,
  slug: string,
  context: CallOrigin,
  stateKey: string = slug
): LlmProvider {
  // Refuse rather than return the bare instance. This used to be
  // `if (!slug) return provider;`, described as defensive — but the callers are
  // the three ways into `instanceCache`, so "everything `getProvider` returns
  // has been through the Proxy" was a property with a silent exception in it,
  // and an exception nobody could see at the read. An empty slug is a caller
  // bug either way; this is the version that says so.
  if (!slug) {
    throw new ProviderError('Cannot wrap a provider instance without a slug', {
      code: 'missing_provider_slug',
      retriable: false,
    });
  }
  return new Proxy(provider, {
    get(target, prop, receiver): unknown {
      const value: unknown = Reflect.get(target, prop, receiver);
      // Symbol-keyed accesses (e.g. Symbol.toPrimitive, Symbol.iterator)
      // and non-function properties pass through unwrapped. Wrapping a
      // Symbol-keyed function as if it were a tracked method would
      // double-count or corrupt host-runtime behaviour (e.g. JSON
      // serialisation calling `Symbol.toPrimitive`).
      if (typeof prop !== 'string' || typeof value !== 'function') return value;
      const fn = value as (this: LlmProvider, ...args: unknown[]) => unknown;

      // The call-time gate (§120 t-741) runs inside each returned closure, so
      // the rule is asked on every CALL. Asking once here, on access, or once
      // per cached instance would let a rule's changed answer wait out the
      // cache TTL. A refusal is thrown before `track` counts anything.
      switch (dispositionOf(prop)) {
        case 'track': {
          const task = taskOfMethod(prop as ProviderMethodName);
          return async (...args: unknown[]): Promise<unknown> => {
            await assertProviderCallPermitted(slug, context, task);
            return track(stateKey, () => fn.apply(target, args) as Promise<unknown>);
          };
        }
        case 'trackStream': {
          const task = taskOfMethod(prop as ProviderMethodName);
          return (...args: unknown[]): AsyncIterable<unknown> =>
            gatedStream(slug, context, task, () =>
              trackStream(stateKey, () => fn.apply(target, args) as AsyncIterable<unknown>)
            );
        }
        case 'passthrough':
          // Forwarded bound to the original instance so `this` resolution
          // inside the SDK call stays intact.
          return fn.bind(target);
      }

      // `constructor` is a class, not a method that needs a `this` rebind, and
      // binding it corrupts two things callers legitimately read: identity
      // (`provider.constructor === AnthropicProvider` becomes false) and name
      // (`.name` becomes "bound AnthropicProvider", which is what a diagnostic
      // logging `constructor.name` would print). Return it untouched.
      // `instanceof` was never affected — it walks the prototype chain, which
      // the Proxy preserves.
      if (prop === 'constructor') return value;

      // The rest is host machinery — reached by test runners, structured
      // logging and `util.inspect`, never by a vendor. Refusing these would
      // fail on the observer rather than on the thing observed. See
      // HOST_MACHINERY for why it is a fixed list and not
      // `prop in Object.prototype`.
      if (HOST_MACHINERY.has(prop)) return fn.bind(target);

      logger.error('Refusing an unclassified method on a provider instance', undefined, {
        provider: slug,
        method: prop,
      });
      throw new ProviderError(
        `Provider "${slug}" exposes method "${prop}", which is not on the LlmProvider ` +
          'contract. Add it to LlmProvider and classify it in METHOD_DISPOSITION ' +
          '(lib/orchestration/llm/provider-manager.ts) before calling it.',
        { code: 'unclassified_provider_method', retriable: false }
      );
    },
  });
}

/**
 * A stream that asks the gate before the first chunk. The vendor stream is not
 * even created until the gate permits it, so a refused call opens no
 * connection and the in-flight counter never sees it.
 */
async function* gatedStream(
  slug: string,
  context: CallOrigin,
  task: TaskType,
  open: () => AsyncIterable<unknown>
): AsyncGenerator<unknown> {
  await assertProviderCallPermitted(slug, context, task);
  yield* open();
}

/**
 * Register a provider instance programmatically (tests, scripts, or
 * callers that want to bypass the database). The instance is cached
 * under `config.name` so `getProvider(name)` returns it.
 *
 * Returns the wrapped instance — the same object `getProvider(config.name)`
 * will hand back, not the bare construction. See
 * {@link registerProviderInstance} for why.
 */
export function registerProvider(config: ProviderConfig): LlmProvider {
  const row = registrarRow(buildProviderFromInMemoryConfig(config), config.name);
  instanceCache.set(config.name, row);
  return viewOf(row.byIdentity.get('')!, undefined);
}

/**
 * Inject a pre-built `LlmProvider` into the cache under `name`. Used by
 * smoke scripts and tests that need to exercise downstream consumers
 * (chat handler, workflow engine) without a real SDK, API key, or
 * `AiProviderConfig` row. `getProvider(name)` will return this instance
 * and skip the database lookup entirely.
 *
 * **The instance is wrapped before it is cached**, so "everything
 * `getProvider` returns has been through the Proxy" is a property of the
 * cache rather than a property of one of the three ways into it. Both
 * registrars used to write bare instances straight in, which meant the
 * invariant held by convention: it was true of what the manager built and
 * false of what anyone else put there, with no way to tell the two apart at
 * the read. Wrapping here is also the only fix that scales — a check at
 * `getProvider` would have to decide whether an arbitrary object is already
 * wrapped, which a `Proxy` deliberately makes unanswerable.
 *
 * Consequence for callers, and it is a real one: `getProvider(name)` no
 * longer returns the object you passed in. It returns a Proxy over it, so
 * identity comparisons (`expect(retrieved).toBe(fake)`) fail while every
 * call, spy and `instanceof` still works. Assert on behaviour instead.
 */
export function registerProviderInstance(name: string, instance: LlmProvider): void {
  instanceCache.set(name, registrarRow(instance, name));
}

/**
 * List every configured provider row with its last-known status.
 *
 * This does NOT eagerly ping providers — `status` is `'unknown'`
 * unless the caller has already invoked `testProvider` for that slug
 * in the current process. Use `testProvider` when you need live health.
 */
export async function listProviders(): Promise<ProviderStatus[]> {
  const rows = await prisma.aiProviderConfig.findMany({
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((config) => ({ config, status: 'unknown' as const }));
}

/**
 * Same as `listProviders` but also reports whether each row has an API key,
 * asked through the credential seam (`hasProviderKey`; by default whether its
 * `apiKeyEnvVar` is set in `process.env`). Never returns or logs the key.
 */
export async function listProvidersWithStatus(
  where: Parameters<typeof prisma.aiProviderConfig.findMany>[0] = {}
): Promise<ProviderConfigWithStatus[]> {
  const rows = await prisma.aiProviderConfig.findMany({
    ...where,
    orderBy: where?.orderBy ?? { createdAt: 'asc' },
  });
  // Through the credential seam (§120 t-744): with a resolver registered the
  // env var may be deliberately empty, and "API key missing" would be wrong.
  return Promise.all(
    rows.map(async (config) => ({
      config,
      apiKeyPresent: await hasProviderKey(config),
      status: 'unknown' as const,
    }))
  );
}

/**
 * Report whether a named env var is set in the current process. This is the
 * ENV VAR question only, not "does this provider have a key" — that is
 * `hasProviderKey` / `hasProviderCredential` in `provider-credentials.ts`,
 * which a fork's credential resolver answers. Use those for anything about a
 * provider row; this is for a check that is genuinely about the variable
 * (the embedder's hint about a retired bare-`OPENAI_API_KEY` setup).
 */
export function isApiKeyEnvVarSet(apiKeyEnvVar: string | null): boolean {
  return readEnvKey(apiKeyEnvVar) !== undefined;
}

/**
 * Test a provider's connectivity and return the models it reports.
 */
export async function testProvider(slugOrName: string): Promise<ProviderTestResult> {
  const provider = await getProvider(slugOrName);
  return provider.testConnection();
}

/**
 * Resolve a provider instance, falling back through a list of
 * alternatives if the primary's circuit breaker is open.
 *
 * Returns the resolved provider and the slug that was actually used,
 * so the caller can record success/failure on the correct breaker.
 *
 * `provenance` is the resolved binding's (`ResolvedAgentBinding.provenance`):
 * the primary is fetched with its primary context and each fallback with its
 * fallback context, so the call-time gate tells the rule which one it is.
 * Without it each call is evaluated as unrecorded for its position: the
 * primary as both kinds of primary, a fallback as both kinds of fallback.
 */
export async function getProviderWithFallbacks(
  primarySlug: string,
  fallbackSlugs: string[],
  provenance?: BindingProvenance
): Promise<{
  provider: LlmProvider;
  usedSlug: string;
  /**
   * The circuit-breaker key for the credential that was used (§120 t-744):
   * pass it to `getBreaker` rather than `usedSlug`. Always set here; optional
   * so a test double that returns `{ provider, usedSlug }` still fits, and a
   * caller falls back to `usedSlug` for one.
   */
  breakerKey?: string;
}> {
  const candidates = [primarySlug, ...fallbackSlugs];

  for (const [index, slug] of candidates.entries()) {
    try {
      // Without a binding provenance a fallback is still asked AS a fallback
      // (`'explicit'` and `'system'`, with the real primary), so a rule that
      // refuses a provider only as the silent fill is not skipped.
      const origin: CallOrigin =
        index === 0
          ? primaryCallContext(provenance)
          : (fallbackCallContext(provenance, primarySlug) ?? { unrecordedFallbackOf: primarySlug });
      const acquired = await acquireIfBreakerClosed(slug, origin);
      if (!acquired) {
        logger.info('Skipping provider — circuit breaker open', { provider: slug });
        continue;
      }
      const { provider, breakerKey } = acquired;
      if (slug !== primarySlug) {
        logger.info('Using fallback provider', {
          primary: primarySlug,
          fallback: slug,
        });
      }
      return { provider, usedSlug: slug, breakerKey };
    } catch (err) {
      // Provider not found or disabled — skip to next candidate
      logger.warn('Provider resolution failed, trying next', {
        provider: slug,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
  }

  throw new ProviderError('All providers are unavailable', {
    code: 'all_providers_exhausted',
    retriable: true,
  });
}

/**
 * Fetch `slug` for one call if its CREDENTIAL's circuit breaker is closed;
 * `null` when it is open (§120 t-744). Every path that picks a provider by
 * trying candidates in turn goes through this — `getProviderWithFallbacks`,
 * the audio matrix walk and chat's mid-stream failover — so none of them sends
 * a call to a credential known to be down, and none of them lets the shared
 * credential's breaker block an org whose resolver gives it its own key.
 *
 * The breaker is the credential's, so in general it can only be checked once
 * the provider is fetched: that is what says which credential this org gets.
 * With no resolver registered every credential is the shared one and its key
 * is the slug, so the breaker is checked first and an open one skips the
 * fetch entirely, as it always did.
 *
 * `origin` is the call's provenance, as `getProvider`'s `context`, or
 * `{ unrecordedFallbackOf: primarySlug }` for a fallback with none recorded —
 * which `getProviderWithFallbacks` passes too, so a fallback is gated as one
 * whichever path picked it.
 *
 * @throws whatever `getProvider` throws (not found, disabled, no credential).
 */
export async function getProviderIfBreakerClosed(
  slug: string,
  origin?: CallOrigin
): Promise<{ provider: LlmProvider; breakerKey: string } | null> {
  return acquireIfBreakerClosed(slug, origin);
}

async function acquireIfBreakerClosed(
  slug: string,
  origin: CallOrigin
): Promise<{ provider: LlmProvider; breakerKey: string } | null> {
  // Peek, never create: `slug` may be a row NAME, and getBreaker would leave a
  // breaker under a key that is no credential's.
  if (!hasProviderCredentialResolver() && peekBreaker(slug)?.canAttempt() === false) return null;
  const provider = await acquireProvider(slug, origin);
  const breakerKey = breakerKeyOf(provider) ?? slug;
  if (!getBreaker(breakerKey).canAttempt()) return null;
  return { provider, breakerKey };
}

/**
 * Resolved audio provider for transcription.
 *
 * `provider` is guaranteed to expose a `transcribe()` method (the
 * helper rejects rows whose provider class doesn't implement audio).
 * `modelId` is the upstream model id from `AiProviderModel.modelId`.
 */
export interface AudioProviderResolution {
  provider: LlmProvider & { transcribe: NonNullable<LlmProvider['transcribe']> };
  modelId: string;
  providerSlug: string;
}

/**
 * Try a single matrix row as an audio provider. Returns the resolved
 * provider + model id if every guard (breaker closed, eligible under the
 * app's provider rule, provider loads, transcribe() exists) passes, or
 * `null` so the caller can fall through. Logs each rejection at the same
 * level the old inline loop used.
 */
async function tryAudioRow(
  row: { providerSlug: string; modelId: string },
  source: 'operator_default' | 'matrix_fallback'
): Promise<AudioProviderResolution | null> {
  // Provider eligibility, on both arms. `'matrix_fallback'` is Sunrise
  // choosing — no operator pinned this row, we are walking the matrix in order —
  // so it is asked as `'primary'`, exactly as the agent resolver's automatic
  // pick is. `'operator_default'` is the pin an operator set in Settings →
  // Default models, the same category as an explicit `agent.provider`, so it is
  // asked as `'explicit'`.
  //
  // The pin is asked HERE, and not left to the call-time gate, because of what
  // this function promises about a pin: an unusable one falls through to the
  // matrix (an open breaker, a missing `transcribe()`). Left to the gate, a
  // refused pin was returned as resolved, `transcribe()` was refused, and a
  // permitted row further down was never tried, so voice input was dead (§120
  // t-741 review). A refused pin is unusable in the same sense.
  //
  // Denial returns `null` rather than throwing, because that is what every
  // other guard in this function already does and what the loop above is
  // written to handle: an unusable row yields to the next one. A rule that
  // permits nothing therefore ends at `getAudioProvider() === null`, which all
  // three callers already treat as "speech-to-text is unavailable" — a
  // fail-closed outcome with an existing, tested user-facing path, and one
  // that still lets a permitted row further down the matrix serve the request.
  const asked = {
    task: 'audio',
    source: source === 'operator_default' ? 'explicit' : 'primary',
    primarySlug: source === 'operator_default' ? row.providerSlug : null,
  } as const satisfies ProviderEligibilityContext;
  if (!(await isProviderEligible(row.providerSlug, asked))) {
    logger.info('Skipping audio provider — not permitted by the app eligibility rule', {
      providerSlug: row.providerSlug,
      modelId: row.modelId,
      source,
    });
    return null;
  }

  let acquired: { provider: LlmProvider; breakerKey: string } | null;
  try {
    // The call-time gate is told the same thing the check above was.
    acquired = await acquireIfBreakerClosed(row.providerSlug, asked);
  } catch (err) {
    logger.warn('Audio provider resolution failed, trying next', {
      providerSlug: row.providerSlug,
      error: err instanceof Error ? err.message : String(err),
      source,
    });
    return null;
  }

  // The CREDENTIAL's breaker (§120 t-744) — see acquireIfBreakerClosed.
  if (!acquired) {
    logger.info('Skipping audio provider — circuit breaker open', {
      providerSlug: row.providerSlug,
      modelId: row.modelId,
      source,
    });
    return null;
  }
  const { provider } = acquired;

  if (typeof provider.transcribe !== 'function') {
    logger.warn(
      'Provider seeded with audio capability but does not implement transcribe(); skipping',
      {
        providerSlug: row.providerSlug,
        modelId: row.modelId,
        source,
      }
    );
    return null;
  }

  logger.info('Audio provider resolved', {
    providerSlug: row.providerSlug,
    modelId: row.modelId,
    source,
  });
  return {
    provider: provider as AudioProviderResolution['provider'],
    modelId: row.modelId,
    providerSlug: row.providerSlug,
  };
}

/**
 * Resolve a provider + model for speech-to-text.
 *
 * Selection order:
 *   1. **Operator default** — `OrchestrationSettings.defaultModels.audio`.
 *      When set, the matching `(providerSlug, modelId)` matrix row is
 *      tried first. Failing the breaker / transcribe() guard falls
 *      through to the matrix-ordered loop rather than erroring,
 *      keeping voice input working even if the operator's pin is
 *      temporarily unreachable.
 *   2. **Matrix fallback** — every other active `AiProviderModel` row
 *      whose `capabilities` array includes `'audio'`, in registry
 *      order (`isDefault DESC, createdAt ASC`). First row whose
 *      backing provider has a closed breaker and a `transcribe()`
 *      method wins.
 *
 * Returns `null` when no audio-capable model is configured. Callers
 * map this to a `NO_AUDIO_PROVIDER` user-facing error rather than a
 * thrown exception, because "voice not configured" is an expected
 * deployment state, not an error.
 */
export async function getAudioProvider(): Promise<AudioProviderResolution | null> {
  const [settings, rows] = await Promise.all([
    getOrchestrationSettings(),
    prisma.aiProviderModel.findMany({
      where: {
        isActive: true,
        capabilities: { has: 'audio' },
      },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    }),
  ]);

  if (rows.length === 0) return null;

  // Operator-saved audio default takes priority. The settings PATCH
  // handler validates that the (providerSlug, modelId) pair exists
  // in the matrix with capability:'audio', but be defensive — a row
  // could have been deleted or deactivated since the setting was
  // saved.
  //
  // Stored values are `${providerSlug}::${modelId}` composites — see
  // `lib/orchestration/llm/audio-default.ts` for why we need the
  // provider scope (multiple providers can register the same model
  // id, e.g. OpenAI + Groq both have a `whisper-1`). Legacy bare-
  // modelId values still parse (providerSlug=null) and fall back to
  // the modelId-only match, with the historical "first row wins"
  // ambiguity — those values get rewritten on the next operator save.
  const operatorDefault = settings.defaultModels.audio;
  const parsedDefault = parseAudioDefault(operatorDefault);
  const pinnedRow = parsedDefault
    ? rows.find(
        (r) =>
          r.modelId === parsedDefault.modelId &&
          (parsedDefault.providerSlug === null || r.providerSlug === parsedDefault.providerSlug)
      )
    : null;
  if (parsedDefault) {
    if (pinnedRow) {
      const resolved = await tryAudioRow(pinnedRow, 'operator_default');
      if (resolved) return resolved;
      // Pinned row exists but its provider is currently unreachable
      // (breaker open, no transcribe(), getProvider threw). Fall
      // through to the matrix-ordered loop so voice input still
      // works on a hot fallback path.
    } else {
      logger.warn('Operator audio default does not match any active audio row; falling through', {
        operatorDefault,
        providerSlug: parsedDefault.providerSlug,
        modelId: parsedDefault.modelId,
      });
    }
  }

  for (const row of rows) {
    // Skip the pinned row in the fallback loop — already tried above.
    if (pinnedRow && row === pinnedRow) continue;
    const resolved = await tryAudioRow(row, 'matrix_fallback');
    if (resolved) return resolved;
  }

  return null;
}

/**
 * Capability kinds we gate per chat-attachment turn. `'vision'` means
 * image input; `'documents'` means native PDF input. The union is
 * intentionally narrower than `ModelCapability` — only attachment
 * kinds matter here; chat / reasoning / embedding / audio are gated
 * elsewhere by separate resolvers.
 */
export type AttachmentCapability = 'vision' | 'documents';

/**
 * Assert that the curated `AiProviderModel` row for the given
 * `(providerSlug, modelId)` pair carries every required attachment
 * capability. Throws `ProviderError({ code: 'CAPABILITY_NOT_SUPPORTED' })`
 * when any capability is missing — the chat handler catches this and
 * maps to a user-facing SSE error (`IMAGE_NOT_SUPPORTED` /
 * `PDF_NOT_SUPPORTED`).
 *
 * Distinct from `getAudioProvider`: vision and document understanding
 * are intrinsic capabilities of the chat model that handles the turn,
 * not a separate model resolution step. There is no fallback path —
 * if the selected model can't process the attachment, that's a user-
 * facing configuration error, not a transient runtime issue.
 */
export async function assertModelSupportsAttachments(
  providerSlug: string,
  modelId: string,
  required: AttachmentCapability[]
): Promise<void> {
  if (required.length === 0) return;

  const row = await prisma.aiProviderModel.findFirst({
    where: {
      providerSlug,
      modelId,
      isActive: true,
    },
    select: { capabilities: true },
  });

  // Row absent = model isn't in the curated matrix. Be strict: if an
  // admin selected a model the matrix doesn't know about, we have no
  // basis to claim vision/documents support. Surface as
  // CAPABILITY_NOT_SUPPORTED rather than passing through silently.
  if (!row) {
    logger.warn('Attachment capability check failed — model row not found in matrix', {
      providerSlug,
      modelId,
      required,
    });
    throw new ProviderError(
      `Model ${providerSlug}/${modelId} is not registered with the required capabilities (${required.join(', ')})`,
      { code: 'CAPABILITY_NOT_SUPPORTED', retriable: false }
    );
  }

  const missing = required.filter((cap) => !row.capabilities.includes(cap));
  if (missing.length > 0) {
    logger.info('Attachment capability check failed — model lacks required capability', {
      providerSlug,
      modelId,
      required,
      missing,
      modelCapabilities: row.capabilities,
    });
    throw new ProviderError(
      `Model ${providerSlug}/${modelId} does not support: ${missing.join(', ')}`,
      { code: 'CAPABILITY_NOT_SUPPORTED', retriable: false }
    );
  }
}

/**
 * Returns `true` when at least one active `AiProviderModel` row
 * carries the given capability. Used by the widget-config resolver to
 * decide whether to expose the attach affordance — if no vision-
 * capable provider exists in the deployment, the paperclip stays
 * hidden so users aren't offered a control guaranteed to error.
 */
export async function hasModelWithCapability(capability: string): Promise<boolean> {
  const count = await prisma.aiProviderModel.count({
    where: {
      isActive: true,
      capabilities: { has: capability },
    },
  });
  return count > 0;
}

/**
 * Evict one (or all) cached provider instances, and what the provider policy
 * has cached of the same row (§120 t-742) — every provider-row write already
 * calls this, so a changed jurisdiction applies at once in this process.
 */
export function clearCache(slugOrName?: string): void {
  if (slugOrName) {
    instanceCache.delete(slugOrName);
    forgetProviderRow(slugOrName);
  } else {
    instanceCache.clear();
    forgetProviderRow();
  }
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Why a row has no key. The env var by default; with a credential resolver
 * registered the env var may be deliberately empty, so saying only "set the env
 * var" would send an operator to the wrong place.
 */
function missingKeyMessage(config: AiProviderConfig): string {
  return hasProviderCredentialResolver()
    ? `Provider "${config.slug}" has no API key: the registered credential resolver returned none`
    : `Provider "${config.slug}" requires env var "${config.apiKeyEnvVar ?? '<unset>'}" to be set`;
}

/**
 * Build a client from a row and the key the credential seam resolved for it.
 * The key is passed in, never read here: `provider-credentials.ts` is the one
 * place a provider credential is resolved.
 */
function buildProviderFromConfig(
  config: AiProviderConfig,
  apiKey: string | undefined
): LlmProvider {
  if (config.providerType === 'anthropic') {
    if (!apiKey) {
      throw new ProviderError(missingKeyMessage(config), {
        code: 'missing_api_key',
        retriable: false,
      });
    }
    return new AnthropicProvider({
      name: config.name,
      type: 'anthropic',
      apiKey,
      isLocal: config.isLocal,
      ...(config.timeoutMs != null ? { timeoutMs: config.timeoutMs } : {}),
      ...(config.maxRetries != null ? { maxRetries: config.maxRetries } : {}),
    });
  }

  if (config.providerType === 'voyage') {
    if (!apiKey) {
      throw new ProviderError(missingKeyMessage(config), {
        code: 'missing_api_key',
        retriable: false,
      });
    }
    // A configured `baseUrl` is where knowledge text is posted
    // (`VoyageProvider.embedMany`) and where chat would go, so it gets the
    // same point-of-use check as the openai-compatible branch below. The
    // knowledge embedder ran this check itself before it moved behind the
    // manager (t-740); without it here, that check would have been lost in the
    // move. Absent `baseUrl` means Voyage's own fixed host, and nothing to check.
    if (config.baseUrl) {
      // `isLocal` decides loopback, the same rule as the openai-compatible
      // branch and what the embedder's own check used: a Voyage row marked
      // local (a caching proxy on this host) is the operator's stated intent.
      const urlCheck = checkSafeProviderUrl(config.baseUrl, { allowLoopback: config.isLocal });
      if (!urlCheck.ok) {
        logger.error('Provider baseUrl rejected by SSRF guard at build time', {
          provider: config.slug,
          reason: urlCheck.reason,
        });
        throw new ProviderError(
          `Provider "${config.slug}" has an unsafe baseUrl (${urlCheck.reason ?? 'blocked'})`,
          { code: 'unsafe_base_url', retriable: false }
        );
      }
    }
    return new VoyageProvider({
      name: config.name,
      type: 'voyage',
      apiKey,
      baseUrl: config.baseUrl ?? undefined,
      isLocal: false,
      ...(config.timeoutMs != null ? { timeoutMs: config.timeoutMs } : {}),
      ...(config.maxRetries != null ? { maxRetries: config.maxRetries } : {}),
    });
  }

  if (config.providerType === 'openai-compatible') {
    if (!config.baseUrl) {
      throw new ProviderError(`Provider "${config.slug}" is openai-compatible but has no baseUrl`, {
        code: 'missing_base_url',
        retriable: false,
      });
    }
    // Defense-in-depth SSRF guard. The Zod schema on create/update runs
    // the same check, but this catches:
    //   - PATCH merges where isLocal was flipped without re-validating
    //     baseUrl against the new flag
    //   - Direct DB writes (migrations, seed scripts, manual SQL) that
    //     bypass the Zod layer entirely
    // The baseUrl string ends up in an outbound fetch from the OpenAI
    // SDK, so it must be re-checked at the point of use.
    //
    // This check is per-URL, so it covers the FIRST hop only. That was the
    // whole of the guarantee until #635: the SDK sets no redirect policy and
    // undici defaults to `follow`, so every later hop got the prompt with
    // nothing having checked it. The other half now lives where it has to —
    // the `fetch` wrapper passed to `new OpenAI()` in `openai-compatible.ts`.
    // Both halves are needed; neither is sufficient.
    const urlCheck = checkSafeProviderUrl(config.baseUrl, { allowLoopback: config.isLocal });
    if (!urlCheck.ok) {
      logger.error('Provider baseUrl rejected by SSRF guard at build time', {
        provider: config.slug,
        reason: urlCheck.reason,
      });
      throw new ProviderError(
        `Provider "${config.slug}" has an unsafe baseUrl (${urlCheck.reason ?? 'blocked'})`,
        { code: 'unsafe_base_url', retriable: false }
      );
    }
    if (!config.isLocal && !apiKey) {
      throw new ProviderError(missingKeyMessage(config), {
        code: 'missing_api_key',
        retriable: false,
      });
    }
    return new OpenAiCompatibleProvider({
      name: config.name,
      baseUrl: config.baseUrl,
      ...(apiKey !== undefined ? { apiKey } : {}),
      isLocal: config.isLocal,
      ...(config.timeoutMs != null ? { timeoutMs: config.timeoutMs } : {}),
      ...(config.maxRetries != null ? { maxRetries: config.maxRetries } : {}),
    });
  }

  throw new ProviderError(`Unknown providerType "${config.providerType}"`, {
    code: 'unknown_provider_type',
    retriable: false,
  });
}

function buildProviderFromInMemoryConfig(config: ProviderConfig): LlmProvider {
  if (config.type === 'anthropic') {
    return new AnthropicProvider(config);
  }
  if (config.type === 'voyage') {
    return new VoyageProvider(config);
  }
  // Both 'openai' and 'openai-compatible' resolve to the OpenAI-compatible provider.
  // 'openai' is collapsed to the public api.openai.com base URL when not provided.
  const baseUrl =
    config.baseUrl ?? (config.type === 'openai' ? 'https://api.openai.com/v1' : undefined);
  if (!baseUrl) {
    throw new ProviderError(`Provider "${config.name}" requires a baseUrl`, {
      code: 'missing_base_url',
      retriable: false,
    });
  }
  return new OpenAiCompatibleProvider({
    name: config.name,
    baseUrl,
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    isLocal: config.isLocal,
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
  });
}
