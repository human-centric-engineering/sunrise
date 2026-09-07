/**
 * Provider Manager
 *
 * Factory + cache for `LlmProvider` instances, keyed off
 * `AiProviderConfig` rows from Prisma. This is the single place where
 * we translate persisted provider configuration into ready-to-use
 * SDK-backed provider objects:
 *
 *   AiProviderConfig row
 *     → resolve apiKey via process.env[apiKeyEnvVar]
 *     → instantiate AnthropicProvider or OpenAiCompatibleProvider
 *     → cache by slug
 *
 * Callers (chat handler, workflow engine, evaluation harness) go
 * through `getProvider(slug)` and never touch the database or SDKs
 * directly.
 *
 * Platform-agnostic: no Next.js imports. The cache is a plain `Map`
 * in module state — no `React cache()`, no request-scoped lifecycles.
 */

import type { AiProviderConfig } from '@/types/prisma';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { checkSafeProviderUrl } from '@/lib/security/safe-url';
import { AnthropicProvider } from '@/lib/orchestration/llm/anthropic';
import { getBreaker } from '@/lib/orchestration/llm/circuit-breaker';
import { isProviderEligible } from '@/lib/orchestration/llm/provider-eligibility';
import { track, trackStream } from '@/lib/orchestration/llm/in-flight-counter';
import { OpenAiCompatibleProvider } from '@/lib/orchestration/llm/openai-compatible';
import {
  ProviderError,
  type LlmProvider,
  type ProviderTestResult,
} from '@/lib/orchestration/llm/provider';
import type { ProviderConfig } from '@/lib/orchestration/llm/types';
import { VoyageProvider } from '@/lib/orchestration/llm/voyage';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import { parseAudioDefault } from '@/lib/orchestration/llm/audio-default';

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
 *   - `apiKeyPresent` — whether `process.env[row.apiKeyEnvVar]` is set to
 *     a non-empty string. The env var *value* is never returned.
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

interface CachedProvider {
  provider: LlmProvider;
  cachedAt: number;
}

const instanceCache = new Map<string, CachedProvider>();

/**
 * Resolve a provider instance by slug (or name).
 *
 * Loads the `AiProviderConfig` row, validates it, resolves the API
 * key from the process environment, constructs the concrete provider,
 * and caches the instance under its slug.
 *
 * Cached instances are evicted after `CACHE_TTL_MS` (5 minutes) so
 * that config changes in the database take effect without a restart.
 */
export async function getProvider(slugOrName: string): Promise<LlmProvider> {
  const cached = instanceCache.get(slugOrName);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.provider;

  const config = await prisma.aiProviderConfig.findFirst({
    where: {
      OR: [{ slug: slugOrName }, { name: slugOrName }],
    },
  });

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

  const instance = withInFlightTracking(buildProviderFromConfig(config), config.slug);
  const entry: CachedProvider = { provider: instance, cachedAt: Date.now() };
  instanceCache.set(config.slug, entry);
  // Also key by name so callers that already looked up via name are consistent.
  if (slugOrName !== config.slug) instanceCache.set(slugOrName, entry);
  return instance;
}

/**
 * How the in-flight Proxy treats one method on the provider surface.
 *
 *  - `'track'` — a single-shot vendor call; wrapped in `track(slug, …)`.
 *  - `'trackStream'` — a vendor call returning an `AsyncIterable`; wrapped in
 *    `trackStream(slug, …)`, which holds the count until the stream settles.
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
  chat: 'track',
  embed: 'track',
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
 * A frozen list also fails in the right direction. A future runtime adding a
 * member to `Object.prototype` gets refused rather than silently exempted, and
 * the error names the file to edit.
 *
 * `constructor` is included because it is the same category — reached by test
 * runners and `instanceof` checks, never by a vendor.
 */
const HOST_MACHINERY: ReadonlySet<string> = new Set([
  'constructor',
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

function dispositionOf(prop: string): MethodDisposition | undefined {
  return Object.prototype.hasOwnProperty.call(METHOD_DISPOSITION, prop)
    ? METHOD_DISPOSITION[prop as ProviderMethodName]
    : undefined;
}

/**
 * Wrap a freshly-built provider so its vendor calls are accounted in the
 * in-flight counter under `slug`, and so no unclassified method on the
 * instance can reach a vendor unnoticed.
 *
 * Uses a `Proxy` so the returned value preserves the original prototype —
 * existing call sites (and tests) doing `instanceof AnthropicProvider` keep
 * working. The handler rebinds intercepted methods to the original target so
 * `this` inside the SDK call is the real provider instance, which also means a
 * provider's own internal `this.foo()` calls never re-enter the trap.
 *
 * Wrapping happens once per cache entry, not per call, so the proxy cost is
 * negligible; the closures it returns run per call. Returns the original
 * instance unchanged when `slug` is empty (defensive — should not happen with
 * current call sites).
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
function withInFlightTracking(provider: LlmProvider, slug: string): LlmProvider {
  if (!slug) return provider;
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

      switch (dispositionOf(prop)) {
        case 'track':
          return (...args: unknown[]): Promise<unknown> =>
            track(slug, () => fn.apply(target, args) as Promise<unknown>);
        case 'trackStream':
          return (...args: unknown[]): AsyncIterable<unknown> =>
            trackStream(slug, () => fn.apply(target, args) as AsyncIterable<unknown>);
        case 'passthrough':
          // Forwarded bound to the original instance so `this` resolution
          // inside the SDK call stays intact.
          return fn.bind(target);
      }

      // Host machinery — reached by test runners, structured logging and
      // `util.inspect`, never by a vendor. Refusing these would fail on the
      // observer rather than on the thing observed. See HOST_MACHINERY for why
      // it is a fixed list and not `prop in Object.prototype`.
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
 * Register a provider instance programmatically (tests, scripts, or
 * callers that want to bypass the database). The instance is cached
 * under `config.name` so `getProvider(name)` returns it.
 *
 * Returns the wrapped instance — the same object `getProvider(config.name)`
 * will hand back, not the bare construction. See
 * {@link registerProviderInstance} for why.
 */
export function registerProvider(config: ProviderConfig): LlmProvider {
  const instance = withInFlightTracking(buildProviderFromInMemoryConfig(config), config.name);
  instanceCache.set(config.name, { provider: instance, cachedAt: Date.now() });
  return instance;
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
  instanceCache.set(name, { provider: withInFlightTracking(instance, name), cachedAt: Date.now() });
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
 * Same as `listProviders` but also reports whether the configured
 * `apiKeyEnvVar` is set in `process.env`. Only inspects `typeof value`
 * and `length > 0` — never returns or logs the value itself.
 */
export async function listProvidersWithStatus(
  where: Parameters<typeof prisma.aiProviderConfig.findMany>[0] = {}
): Promise<ProviderConfigWithStatus[]> {
  const rows = await prisma.aiProviderConfig.findMany({
    ...where,
    orderBy: where?.orderBy ?? { createdAt: 'asc' },
  });
  return rows.map((config) => ({
    config,
    apiKeyPresent: isApiKeyEnvVarSet(config.apiKeyEnvVar),
    status: 'unknown' as const,
  }));
}

/**
 * Report whether a single row's `apiKeyEnvVar` is set in the current
 * process. Exposed so the single-item GET route can hydrate its
 * response the same way `listProvidersWithStatus` does.
 */
export function isApiKeyEnvVarSet(apiKeyEnvVar: string | null): boolean {
  if (!apiKeyEnvVar) return false;
  const value = process.env[apiKeyEnvVar];
  return typeof value === 'string' && value.length > 0;
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
 */
export async function getProviderWithFallbacks(
  primarySlug: string,
  fallbackSlugs: string[]
): Promise<{ provider: LlmProvider; usedSlug: string }> {
  const candidates = [primarySlug, ...fallbackSlugs];

  for (const slug of candidates) {
    const breaker = getBreaker(slug);
    if (!breaker.canAttempt()) {
      logger.info('Skipping provider — circuit breaker open', { provider: slug });
      continue;
    }

    try {
      const provider = await getProvider(slug);
      if (slug !== primarySlug) {
        logger.info('Using fallback provider', {
          primary: primarySlug,
          fallback: slug,
        });
      }
      return { provider, usedSlug: slug };
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
  // Provider eligibility, on the fallback arm only. `'matrix_fallback'` is
  // Sunrise choosing — no operator pinned this row, we are walking the matrix
  // in order — so an org's policy applies to it exactly as it applies to the
  // agent resolver's automatic fill. `'operator_default'` is the pin an
  // operator set in Settings → Default models, the same category as an
  // explicit `agent.provider`, and is left alone.
  //
  // Denial returns `null` rather than throwing, because that is what every
  // other guard in this function already does and what the loop above is
  // written to handle: an unusable row yields to the next one. A rule that
  // permits nothing therefore ends at `getAudioProvider() === null`, which all
  // three callers already treat as "speech-to-text is unavailable" — a
  // fail-closed outcome with an existing, tested user-facing path, and one
  // that still lets a permitted row further down the matrix serve the request.
  if (source === 'matrix_fallback') {
    const permitted = await isProviderEligible(row.providerSlug, {
      task: 'audio',
      source: 'primary',
      primarySlug: null,
    });
    if (!permitted) {
      logger.info('Skipping audio provider — not permitted by the app eligibility rule', {
        providerSlug: row.providerSlug,
        modelId: row.modelId,
        source,
      });
      return null;
    }
  }

  const breaker = getBreaker(row.providerSlug);
  if (!breaker.canAttempt()) {
    logger.info('Skipping audio provider — circuit breaker open', {
      providerSlug: row.providerSlug,
      modelId: row.modelId,
      source,
    });
    return null;
  }

  let provider: LlmProvider;
  try {
    provider = await getProvider(row.providerSlug);
  } catch (err) {
    logger.warn('Audio provider resolution failed, trying next', {
      providerSlug: row.providerSlug,
      error: err instanceof Error ? err.message : String(err),
      source,
    });
    return null;
  }

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

/** Evict one (or all) cached provider instances. */
export function clearCache(slugOrName?: string): void {
  if (slugOrName) {
    instanceCache.delete(slugOrName);
  } else {
    instanceCache.clear();
  }
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

function buildProviderFromConfig(config: AiProviderConfig): LlmProvider {
  const apiKey = resolveApiKey(config);

  if (config.providerType === 'anthropic') {
    if (!apiKey) {
      throw new ProviderError(
        `Provider "${config.slug}" requires env var "${config.apiKeyEnvVar ?? '<unset>'}" to be set`,
        { code: 'missing_api_key', retriable: false }
      );
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
      throw new ProviderError(
        `Provider "${config.slug}" requires env var "${config.apiKeyEnvVar ?? '<unset>'}" to be set`,
        { code: 'missing_api_key', retriable: false }
      );
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
      throw new ProviderError(
        `Provider "${config.slug}" requires env var "${config.apiKeyEnvVar ?? '<unset>'}" to be set`,
        { code: 'missing_api_key', retriable: false }
      );
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

function resolveApiKey(config: AiProviderConfig): string | undefined {
  if (!config.apiKeyEnvVar) return undefined;
  const value = process.env[config.apiKeyEnvVar];
  if (!value) {
    logger.warn('Provider apiKeyEnvVar is set but process.env value is empty', {
      provider: config.slug,
      envVar: config.apiKeyEnvVar,
    });
    return undefined;
  }
  return value;
}
