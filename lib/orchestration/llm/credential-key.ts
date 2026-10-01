/**
 * The key a provider's per-credential process state is held under.
 *
 * The instance cache, the circuit breakers and the in-flight counter used to
 * key on the provider slug alone. That was right only while the slug WAS the
 * credential's identity — one env var per row. Once a fork's credential
 * resolver can hand two orgs different credentials for the same row
 * (`lib/orchestration/llm/provider-credentials.ts`, §120 t-744), a slug-keyed
 * cache would serve org A's credential to org B, and one org's failures would
 * open the breaker for another org's healthy key. So all three key on
 * (slug, identity).
 *
 * The empty identity is the install's shared credential — the default, and
 * every row while no resolver is registered — and its key IS the slug. That is
 * what keeps every existing key, log line, breaker status and dashboard row
 * byte-identical at rest.
 *
 * Pure and import-free, so the breaker and the counter can depend on it
 * without pulling in the resolver's tenancy and Prisma imports.
 *
 * Tenancy posture: no-tenant-data — pure functions (lib/tenancy/process-state.ts).
 */

/** Joins a slug and a non-empty identity. Slugs are kebab-case, so it cannot appear in one. */
const SEPARATOR = '#';

/** The process-state key for a provider row used with one credential. */
export function credentialKey(slug: string, identity: string): string {
  return identity === '' ? slug : `${slug}${SEPARATOR}${identity}`;
}

/** The provider slug a {@link credentialKey} was built from. */
export function slugOfCredentialKey(key: string): string {
  const at = key.indexOf(SEPARATOR);
  return at === -1 ? key : key.slice(0, at);
}
