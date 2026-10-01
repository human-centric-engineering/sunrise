/**
 * App provider-credential registration.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body).
 *
 * Auto-wired: `lib/orchestration/llm/provider-credentials.ts` calls this once,
 * lazily, before it first resolves a provider's key, through the shared fork
 * init gate. A throw here is rolled back and logged, and then NO provider
 * credential resolves until it is fixed — there is deliberately no fallback to
 * the environment, which may hold a key you did not mean your orgs to use.
 *
 * By default every provider row's key is read from the environment variable
 * the row names (`apiKeyEnvVar`). Register a resolver to fetch keys from
 * somewhere else — a gateway, a vault reference, workload federation — or to
 * give each org its own key:
 *
 *   import { registerProviderCredentialResolver } from '@/lib/orchestration/llm/provider-credentials';
 *
 *   export function initAppProviderCredentials(): void {
 *     registerProviderCredentialResolver(async (config, { orgId }) => {
 *       const key = await vault.read(`llm/${orgId}/${config.slug}`); // cache this
 *       return { apiKey: key, identity: `org:${orgId}` };
 *     });
 *   }
 *
 * **Sunrise stores no tenant's vendor key.** The resolver is called when a
 * provider is needed; the key is used to construct a client held in memory
 * for the instance cache's TTL, and written nowhere.
 *
 * Read before writing one:
 *
 *  - **`identity` is what keeps orgs apart.** The provider client cache, the
 *    circuit breakers and the in-flight counter key on (slug, identity). Give
 *    every distinct key a distinct identity, or two orgs will share one client
 *    — and one org's calls will go out on the other's key. Give a SHARED key a
 *    shared identity, so its callers share a client and a breaker. `''` means
 *    the install's shared credential.
 *  - **The identity is not secret and must not be the key.** It appears in
 *    breaker and dashboard keys and in logs. It must not contain `#`.
 *  - **It runs every time a provider is fetched** — every chat turn, workflow
 *    step and embedding batch. Cache whatever you look up.
 *  - **A throw, or a non-credential, makes the provider unavailable** for that
 *    call (`credential_unavailable`). There is no fallback to the env var.
 *  - **Register synchronously.** This function must not be `async`; load
 *    anything the resolver needs inside the resolver.
 *
 * Empty = today's behaviour, byte-for-byte.
 *
 * Full guide: .context/orchestration/llm-providers.md (Provider credentials)
 */
export function initAppProviderCredentials(): void {
  // No credential resolver by default: keys come from `apiKeyEnvVar`.
}
