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
import { AnthropicProvider } from './anthropic';
import { getBreaker } from './circuit-breaker';
import { OpenAiCompatibleProvider } from './openai-compatible';
import { ProviderError, type LlmProvider, type ProviderTestResult } from './provider';
import type { ProviderConfig } from './types';
import { VoyageProvider } from './voyage';

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

const instanceCache = new Map<string, LlmProvider>();

/**
 * Resolve a provider instance by slug (or name).
 *
 * Loads the `AiProviderConfig` row, validates it, resolves the API
 * key from the process environment, constructs the concrete provider,
 * and caches the instance under its slug.
 */
export async function getProvider(slugOrName: string): Promise<LlmProvider> {
  const cached = instanceCache.get(slugOrName);
  if (cached) return cached;

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

  const instance = buildProviderFromConfig(config);
  instanceCache.set(config.slug, instance);
  // Also key by name so callers that already looked up via name are consistent.
  if (slugOrName !== config.slug) instanceCache.set(slugOrName, instance);
  return instance;
}

/**
 * Register a provider instance programmatically (tests, scripts, or
 * callers that want to bypass the database). The instance is cached
 * under `config.name` so `getProvider(name)` returns it.
 */
export function registerProvider(config: ProviderConfig): LlmProvider {
  const instance = buildProviderFromInMemoryConfig(config);
  instanceCache.set(config.name, instance);
  return instance;
}

/**
 * Inject a pre-built `LlmProvider` into the cache under `name`. Used by
 * smoke scripts and tests that need to exercise downstream consumers
 * (chat handler, workflow engine) without a real SDK, API key, or
 * `AiProviderConfig` row. `getProvider(name)` will return this instance
 * and skip the database lookup entirely.
 */
export function registerProviderInstance(name: string, instance: LlmProvider): void {
  instanceCache.set(name, instance);
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
