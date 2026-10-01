/**
 * Write-time check that an agent names only providers its org may use
 * (§120 t-743).
 *
 * At `TENANCY_MODE=multi` an org other than the install org may call only the
 * providers a platform admin approved it for (`org-provider-policy.ts`). The
 * call-time gate refuses everything else, but an agent saved naming such a
 * provider would fail on its first conversation, with the reason far from the
 * form that caused it. So every route that writes an agent's `provider` or
 * `fallbackProviders` asks here first and refuses with a 400 naming the
 * providers. At `single`, and for the install org, nothing is refused.
 *
 * **Only what a write introduces is checked.** An agent stranded by a later
 * policy change can still be edited — renamed, re-prompted, deactivated —
 * without first fixing its provider; what it cannot do is take on a provider
 * it was not already using. Otherwise the only way to edit a stranded agent
 * would be to change the one field its owner may not yet know how to fix.
 *
 * The runtime gate stays the backstop for anything that does not come through
 * a route: seeds, the platform-agent reconcile, direct database writes.
 */

import { ValidationError } from '@/lib/api/errors';
import { unapprovedProviders } from '@/lib/orchestration/llm/org-provider-policy';

/** The provider fields of an agent, as a write sets them. */
export interface AgentProviderFields {
  provider?: string | null;
  fallbackProviders?: readonly string[] | null;
}

/** What each field newly names that the org is not approved for. */
export interface UnapprovedAgentProviders {
  provider: string[];
  fallbackProviders: string[];
}

/**
 * The providers `next` introduces that the org in context is not approved
 * for. A field `next` leaves undefined is not being written and is not checked;
 * a value `current` already holds is not new.
 */
export async function findUnapprovedAgentProviders(
  next: AgentProviderFields,
  current: AgentProviderFields = {}
): Promise<UnapprovedAgentProviders> {
  const provider =
    typeof next.provider === 'string' && next.provider !== current.provider ? [next.provider] : [];
  const held = new Set(current.fallbackProviders ?? []);
  const fallbackProviders = (next.fallbackProviders ?? []).filter((slug) => !held.has(slug));

  const refused = new Set(await unapprovedProviders([...provider, ...fallbackProviders]));
  return {
    provider: provider.filter((slug) => refused.has(slug)),
    fallbackProviders: fallbackProviders.filter((slug) => refused.has(slug)),
  };
}

/** Every slug in a finding, primary first, once each. */
export function unapprovedSlugs(found: UnapprovedAgentProviders): string[] {
  return [...new Set([...found.provider, ...found.fallbackProviders])];
}

/**
 * Refuse a write that would give an agent a provider its org is not approved
 * for, with a 400 shaped like a body-validation error so a form can place it
 * on the field.
 *
 * @throws ValidationError naming each refused provider.
 */
export async function assertAgentProvidersApproved(
  next: AgentProviderFields,
  current?: AgentProviderFields
): Promise<void> {
  const found = await findUnapprovedAgentProviders(next, current);
  const slugs = unapprovedSlugs(found);
  if (slugs.length === 0) return;

  const reason = (names: string[]) =>
    `This organisation is not approved to use ${names.map((slug) => `"${slug}"`).join(', ')}. ` +
    'A platform admin grants providers to an organisation; until then every call to it is refused.';
  const errors = [
    ...(found.provider.length > 0 ? [{ path: 'provider', message: reason(found.provider) }] : []),
    ...(found.fallbackProviders.length > 0
      ? [{ path: 'fallbackProviders', message: reason(found.fallbackProviders) }]
      : []),
  ];
  throw new ValidationError(reason(slugs), { errors, unapprovedProviders: slugs });
}

/**
 * For the import paths: the warning to report when an imported agent names a
 * provider its org is not approved for, or `null` when it names none.
 *
 * Imports do not refuse such an agent; they import it and say so. An import
 * restores a configuration wholesale, and skipping one agent would silently
 * drop what other imported rows — a workflow's `agent_call`, say — point at.
 * The call-time gate refuses every call the agent makes until the org is
 * granted the provider, and the warning tells the importer why.
 */
export async function unapprovedAgentProvidersWarning(
  slug: string,
  imported: AgentProviderFields
): Promise<string | null> {
  // Everything the imported agent names, not only what differs from a row it
  // overwrites: the importer wants to know the agent will be refused, whether
  // or not it was before.
  const names = unapprovedSlugs(await findUnapprovedAgentProviders(imported));
  if (names.length === 0) return null;
  return (
    `Agent '${slug}': imported, but this organisation is not approved to use ` +
    `${names.map((name) => `"${name}"`).join(', ')} — its calls are refused until a platform admin grants ` +
    `${names.length === 1 ? 'it' : 'them'}`
  );
}
