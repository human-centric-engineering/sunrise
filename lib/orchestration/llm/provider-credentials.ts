/**
 * Provider credential seam (§120 t-744).
 *
 * Where a provider row's API key comes from. By default it is what it always
 * was, the environment variable the row names (`process.env[apiKeyEnvVar]`).
 * A fork that keeps keys in a gateway, behind a vault reference, or behind
 * workload federation registers a resolver from
 * `lib/app/provider-credentials.ts` instead of editing the provider manager.
 *
 * **Sunrise stores no tenant's vendor key, and this seam does not change that**
 * (multi-tenancy design Q5: credential custody is declined as policy). A
 * resolver fetches a credential from wherever the fork keeps it, at the moment
 * a provider is needed; Sunrise holds the constructed client in memory for the
 * instance cache's TTL, as it always has, and writes the key nowhere.
 *
 * ## The identity is the half that matters for isolation
 *
 * A resolver returns the key AND an `identity`: a stable, non-secret name for
 * the credential (`'org:cm123'`, `'gateway:eu'`). The provider manager's
 * instance cache, the circuit breakers and the in-flight counter all key on
 * (slug, identity) — see `credential-key.ts`. Two orgs given different keys for
 * one row must be given different identities, or they share one client, and
 * one org's calls go out on the other's key. Two orgs that share a key should
 * share an identity, so they share a client and a breaker.
 *
 * The identity must never be the key itself: it appears in breaker and
 * dashboard keys and in logs.
 *
 * ## Default and failure behaviour
 *
 * - Nothing registered: the row's env var, identity `''` (the shared
 *   credential, whose cache and breaker key is the bare slug). Byte-identical
 *   to before the seam existed.
 * - A resolver that throws, or returns something that is not a credential:
 *   the provider is unavailable for that call (`ProviderError`,
 *   `credential_unavailable`). It never falls back to the env var — a fork that
 *   moved keys out of the environment did so on purpose, and a silent fallback
 *   would send an org's prompts out on whatever key the process happens to hold.
 * - A fork init that throws while REGISTERING: rolled back by the shared gate
 *   and logged — and then every credential is REFUSED (`credential_unavailable`),
 *   not served from the env var. The rollback is all-or-nothing as for every
 *   seam, but the usual "the default applies" would be the silent fallback
 *   above: a fork that moved keys out of the environment did not mean the
 *   environment's key (possibly the platform's own) to be used for its orgs.
 *   A broken registration is fixed loudly, not routed around.
 *
 * Tenancy posture: global-config — one resolver for the process, registered
 * from code (lib/tenancy/process-state.ts).
 *
 * @see lib/app/provider-credentials.ts — the fork-owned registration point
 * @see .context/orchestration/llm-providers.md — Provider credentials
 */

import { z } from 'zod';

import { initAppProviderCredentials } from '@/lib/app/provider-credentials';
import { createAppInitGate } from '@/lib/fork-init';
import { logger } from '@/lib/logging';
import { ProviderError } from '@/lib/orchestration/llm/provider';
import { getTenantContext, isMultiTenant } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import type { AiProviderConfig } from '@/types/prisma';

/** The provider row a credential is wanted for. Read-only: a resolver does not edit config. */
export type ProviderCredentialConfig = Readonly<
  Pick<AiProviderConfig, 'id' | 'slug' | 'name' | 'providerType' | 'apiKeyEnvVar' | 'isLocal'>
>;

/** Who the credential is wanted for. */
export interface ProviderCredentialContext {
  /**
   * The org the calling code acts for. At `single` this is the install org even
   * when no scope was entered (as `requireTenantContext` answers). At `multi`
   * it is `null` outside an org scope or inside `runAsSystem` — and the
   * call-time gate refuses any vendor call made there, so a resolver may answer
   * `null` however is simplest.
   */
  orgId: string | null;
}

export interface ProviderCredential {
  /** The key to send. `undefined` means none: a non-local row then refuses to build. */
  apiKey: string | undefined;
  /**
   * Stable, non-secret name for this credential. `''` is the install's shared
   * credential. Different keys need different identities.
   */
  identity: string;
}

export type ProviderCredentialResolver = (
  config: ProviderCredentialConfig,
  context: ProviderCredentialContext
) => ProviderCredential | Promise<ProviderCredential>;

const credentialSchema = z.object({
  apiKey: z.string().optional(),
  // A separator in an identity would make two (slug, identity) keys collide.
  identity: z
    .string()
    .max(200)
    .regex(/^[^#]*$/, 'identity must not contain "#"'),
});

let appResolver: ProviderCredentialResolver | null = null;

/** Set when the fork's init threw: every credential is then refused. See the module header. */
let registrationFailed = false;

const appInit = createAppInitGate({
  label: 'provider-credentials: initAppProviderCredentials',
  subject: 'the provider credential resolver',
  init: initAppProviderCredentials,
  snapshot: () => appResolver,
  restore: (before) => {
    appResolver = before;
  },
  onFailure: () => {
    registrationFailed = true;
  },
});

/**
 * Register the app's credential resolver. One resolver, registered once:
 * re-registering the same function is a no-op, a different one throws, because
 * two would mean one of them is silently not running.
 *
 * @throws if a different resolver is already registered.
 */
export function registerProviderCredentialResolver(resolver: ProviderCredentialResolver): void {
  if (appResolver && appResolver !== resolver) {
    throw new Error(
      'registerProviderCredentialResolver: a different resolver is already registered. ' +
        'Provider credentials are resolved by one function — branch inside it rather than ' +
        'registering twice.'
    );
  }
  appResolver = resolver;
}

/** Test-only: clear the resolver and re-arm the fork init. */
export function resetProviderCredentialResolver(): void {
  appResolver = null;
  registrationFailed = false;
  appInit.reset();
}

/** Whether an app resolver is registered. Runs the fork init first, like every read. */
export function hasProviderCredentialResolver(): boolean {
  appInit.ensure();
  return appResolver !== null;
}

/** The env-var default: exactly what the provider manager did before the seam. */
function credentialFromEnv(config: ProviderCredentialConfig): ProviderCredential {
  return { apiKey: readEnvKey(config.apiKeyEnvVar), identity: '' };
}

/**
 * The value of a named env var, or `undefined` when it is unset or empty. The
 * one place a provider key is read from the environment: the seam's default
 * uses it, and so does `isApiKeyEnvVarSet` (the admin "env var present" flag),
 * so the two cannot disagree. Silent: it runs on reachability checks every
 * turn, and the provider manager warns about a missing key once, when it
 * builds a client.
 */
export function readEnvKey(apiKeyEnvVar: string | null): string | undefined {
  if (!apiKeyEnvVar) return undefined;
  const value = process.env[apiKeyEnvVar];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The org a credential is resolved for, from the async context. */
function currentCredentialContext(): ProviderCredentialContext {
  const tenant = getTenantContext();
  if (tenant) return { orgId: tenant.orgId };
  return { orgId: isMultiTenant() ? null : INSTALL_ORG_ID };
}

/**
 * Resolve the credential for `config` in the current async context.
 *
 * @throws ProviderError `credential_unavailable` when a registered resolver
 *   throws or returns something that is not a credential. Never falls back to
 *   the env var.
 */
export async function resolveProviderCredential(
  config: ProviderCredentialConfig
): Promise<ProviderCredential> {
  appInit.ensure();
  if (registrationFailed) {
    // Logged once, loudly, by the gate when the init threw; this names the
    // provider each refusal is for.
    logger.warn('Refusing a provider credential: the credential resolver failed to register', {
      provider: config.slug,
      fix: 'lib/app/provider-credentials.ts threw in initAppProviderCredentials. Until it is fixed no provider credential resolves, rather than silently falling back to the environment.',
    });
    throw new ProviderError(`No credential is available for provider "${config.slug}"`, {
      code: 'credential_unavailable',
      retriable: false,
    });
  }
  const resolver = appResolver;
  if (!resolver) return credentialFromEnv(config);

  const context = currentCredentialContext();
  let returned: unknown;
  try {
    returned = await resolver(config, context);
  } catch (err) {
    logger.error('Provider credential resolver threw; the provider is unavailable', {
      provider: config.slug,
      orgId: context.orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new ProviderError(`No credential is available for provider "${config.slug}"`, {
      code: 'credential_unavailable',
      retriable: false,
    });
  }

  const parsed = credentialSchema.safeParse(returned);
  if (!parsed.success) {
    // The issues name fields, never values: `returned` may hold the key.
    logger.error('Provider credential resolver returned an invalid credential', {
      provider: config.slug,
      orgId: context.orgId,
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
    throw new ProviderError(`No credential is available for provider "${config.slug}"`, {
      code: 'credential_unavailable',
      retriable: false,
    });
  }
  return { apiKey: parsed.data.apiKey || undefined, identity: parsed.data.identity };
}

/**
 * Whether `config` can be called at all in the current context: a local row,
 * or one the resolver gives a key. With nothing registered this is exactly the
 * old check (`isLocal || process.env[apiKeyEnvVar]` set).
 *
 * The callers that decide which providers are reachable — auto-pick, the agent
 * form's preview, the clean-up agent's pin — use this rather than reading the
 * env var, so a fork whose keys are not in the environment is not left with
 * every provider looking unconfigured. A resolver failure answers `false`.
 */
export async function hasProviderCredential(config: ProviderCredentialConfig): Promise<boolean> {
  // A local row is asked too, because `getProvider` asks the resolver for every
  // row: a resolver that throws for it makes the row unbuildable, and calling
  // it reachable would bind an agent to a provider that always fails. It just
  // does not need a key.
  try {
    const { apiKey } = await resolveProviderCredential(config);
    return config.isLocal || (typeof apiKey === 'string' && apiKey.length > 0);
  } catch {
    return false;
  }
}

/**
 * Whether the credential seam gives `config` a KEY in this context — what the
 * admin "API key present" flag reports. Unlike {@link hasProviderCredential}
 * a local row without one answers `false`, as the flag always has.
 */
export async function hasProviderKey(config: ProviderCredentialConfig): Promise<boolean> {
  try {
    const { apiKey } = await resolveProviderCredential(config);
    return typeof apiKey === 'string' && apiKey.length > 0;
  } catch {
    return false;
  }
}

/**
 * The rows of `configs` that {@link hasProviderCredential}, in their order.
 * Order is load-bearing for every caller (the first reachable row wins).
 */
export async function filterProvidersWithCredential<T extends ProviderCredentialConfig>(
  configs: readonly T[]
): Promise<T[]> {
  const reachable = await Promise.all(configs.map((config) => hasProviderCredential(config)));
  return configs.filter((_, index) => reachable[index]);
}
