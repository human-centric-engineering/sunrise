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
 * Allowed:
 *
 *   • the install org;
 *   • a `system` scope, which has no org and is the platform acting;
 *   • anyone at `single`, where the install org is the only org there is.
 *
 * A call stack that entered nothing at all is refused at `multi`: that is the
 * state `requireTenantContext()` treats as a bug, not a credential. The one
 * credential that legitimately enters no org — an unbound admin API key,
 * which acts as the install org (owner ruling, 2026-10-02) — is allowed by
 * the route guard, the one place that can tell it apart. A capability is
 * never reached from that key with no org: at `multi` a workflow or chat run
 * with no org entered fails on its own tenant-owned reads first.
 *
 * The rule reads the tenant context rather than taking an org, so the route
 * guard (`withAdminAuth({ writesSharedSettings: true })`) and the capability
 * dispatcher (a capability declaring `writesSharedSettings`) ask the same
 * question of the same fact: the org this call stack was entered for.
 *
 * @see lib/tenancy/classification.ts — GLOBAL_CONFIG_MODELS
 */
import { getTenantContext, isMultiTenant } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

/** The words an admin sees on the route's 403. */
export const SHARED_SETTINGS_REFUSAL =
  'Shared settings apply to every organisation and can only be changed from the install organisation. Switch to the install organisation to make this change.';

/**
 * The capability dispatcher's words for the same refusal. A tool result can
 * reach an end user through an agent's reply, where "switch organisation" is
 * an instruction they cannot act on, so it names the rule and not the remedy.
 */
export const SHARED_SETTINGS_CAPABILITY_REFUSAL =
  'This tool changes settings shared by every organisation, and it cannot run from this organisation.';

/**
 * The refusal's one machine-readable name: the route guard's
 * `error.details.reason` and the dispatcher's error `code` alike, so a client
 * recognises it whichever surface refused.
 */
export const SHARED_SETTINGS_REFUSAL_CODE = 'shared_settings_install_org_only';

/**
 * Whether the current call stack may change shared settings. At `multi`:
 * only inside the install org or a system scope.
 */
export function canChangeSharedSettings(): boolean {
  if (!isMultiTenant()) return true;
  const context = getTenantContext();
  if (!context) return false;
  return context.orgId === null || context.orgId === INSTALL_ORG_ID;
}
