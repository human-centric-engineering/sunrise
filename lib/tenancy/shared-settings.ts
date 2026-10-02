/**
 * Who may change shared settings (§107 t-751).
 *
 * Shared settings are the {@link GLOBAL_CONFIG_MODELS} — providers, provider
 * models, capabilities, agent profiles, knowledge tags, feature flags, MCP
 * exposure and server config, orchestration settings. One row serves every
 * org, so a change made from inside a customer's org lands in every other
 * org too. The owner's ruling (2026-10-02): at `multi` they change only from
 * the install org. A platform admin switched into a customer's org keeps
 * read access; their writes are refused with a message saying where to go.
 *
 * Three callers are allowed:
 *
 *   • the install org;
 *   • no org at all — an unbound admin API key enters none, and acts as the
 *     install org (ruling, same day). A `system` scope has no org either;
 *   • anyone at `single`, where the install org is the only org there is.
 *
 * The rule reads the tenant context rather than taking an org, so the route
 * guard (`withAdminAuth({ writesSharedSettings: true })`) and the built-in
 * capabilities that write provider models ask the same question of the same
 * fact: the org this call stack was entered for.
 *
 * @see lib/tenancy/classification.ts — GLOBAL_CONFIG_MODELS
 */
import { getTenantContext, isMultiTenant } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

/** The words a refused caller sees — the route's 403 and the capability's error alike. */
export const SHARED_SETTINGS_REFUSAL =
  'Shared settings apply to every organisation and can only be changed from the install organisation. Switch to the install organisation to make this change.';

/** Machine-readable reason on the refusal, so a client can tell it from any other 403. */
export const SHARED_SETTINGS_REFUSAL_REASON = 'shared-settings-install-org-only';

/**
 * Whether the current call stack may change shared settings. `false` only at
 * `multi`, inside an org that is not the install org.
 */
export function canChangeSharedSettings(): boolean {
  if (!isMultiTenant()) return true;
  const orgId = getTenantContext()?.orgId ?? null;
  return orgId === null || orgId === INSTALL_ORG_ID;
}
