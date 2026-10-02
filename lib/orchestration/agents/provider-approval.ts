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
import { logger } from '@/lib/logging';
import {
  orgProviderPolicyScope,
  unapprovedProviders,
} from '@/lib/orchestration/llm/org-provider-policy';

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
 * a provider `current` already holds, as primary or fallback, is not new.
 */
export async function findUnapprovedAgentProviders(
  next: AgentProviderFields,
  current: AgentProviderFields = {}
): Promise<UnapprovedAgentProviders> {
  // Held means anywhere on the agent now: keeping a revoked primary as a
  // fallback, or promoting a fallback to primary, introduces nothing.
  const held = new Set([
    ...(current.provider ? [current.provider] : []),
    ...(current.fallbackProviders ?? []),
  ]);
  const provider =
    typeof next.provider === 'string' && !held.has(next.provider) ? [next.provider] : [];
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
    orgProviderPolicyScope() === 'no-org'
      ? `No organisation is in scope for this request, so ${names.map((slug) => `"${slug}"`).join(', ')} cannot be approved for it. ` +
        'Make the request from inside an organisation.'
      : `This organisation is not approved to use ${names.map((slug) => `"${slug}"`).join(', ')}. ` +
        'A platform admin grants providers to an organisation; until then every call to it is refused.';
  const errors = [
    ...(found.provider.length > 0 ? [{ path: 'provider', message: reason(found.provider) }] : []),
    ...(found.fallbackProviders.length > 0
      ? [{ path: 'fallbackProviders', message: reason(found.fallbackProviders) }]
      : []),
  ];
  throw new ValidationError(reason(slugs), { errors, unapprovedProviders: slugs });
}

/** The agent fields a read reports on. */
export interface StoredAgentProviders extends AgentProviderFields {
  id: string;
}

/**
 * For admin reads that decorate a list with the org's provider policy (§120
 * t-745): the slugs among `slugs` the org in context may not use, or `null`
 * when that is unknown.
 *
 * Unknown is two cases. With no org in scope (`multi`, a platform credential
 * outside any org) there is no org to judge against: the policy would refuse
 * everything, and saying "this organisation is not approved" of every
 * provider would be false. And a policy that cannot be read is logged and
 * reported as unknown rather than failing the read or reporting all clear.
 */
export async function refusedProvidersOrUnknown(
  slugs: readonly string[]
): Promise<Set<string> | null> {
  if (orgProviderPolicyScope() === 'no-org') return null;
  try {
    return new Set(await unapprovedProviders(slugs));
  } catch (error) {
    logger.warn('Could not read the org provider policy for an admin read', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * For the admin reads (§120 t-745): per agent, the providers it names that its
 * org is no longer approved for — an agent stranded by a policy change, whose
 * calls the runtime refuses. Keyed by agent id; an agent naming none is `[]`.
 *
 * One policy read for the whole page; the read is scoped to the org in
 * context, as the list is. `null` when that is unknown (see
 * {@link refusedProvidersOrUnknown}).
 *
 * An agent that names no provider of its own (`provider: ''`) inherits one
 * per turn, chosen among what the org may use, so it is never stranded by a
 * provider it names. It can still fail when the org may use no reachable
 * provider at all; that is the org's state, not the agent's, and the runtime
 * refusal names the org's approved providers.
 */
export async function strandedAgentProviders(
  agents: readonly StoredAgentProviders[]
): Promise<Map<string, string[]> | null> {
  const refused = await refusedProvidersOrUnknown(
    agents.flatMap((agent) => [agent.provider ?? '', ...(agent.fallbackProviders ?? [])])
  );
  if (refused === null) return null;
  return new Map(
    agents.map((agent) => [
      agent.id,
      [...new Set([agent.provider ?? '', ...(agent.fallbackProviders ?? [])])].filter((slug) =>
        refused.has(slug)
      ),
    ])
  );
}

/** The agent fields an import reports on. */
export interface ImportedAgentProviders extends AgentProviderFields {
  slug: string;
}

/**
 * For the import paths: a warning per imported agent that names a provider its
 * org is not approved for, keyed by agent slug.
 *
 * Imports do not refuse such an agent; they import it and say so. An import
 * restores a configuration wholesale, and skipping one agent would silently
 * drop what other imported rows — a workflow's `agent_call`, say — point at.
 * The call-time gate refuses every call the agent makes until the org is
 * granted the provider, and the warning tells the importer why.
 *
 * Asked ONCE for the whole import, before its transaction opens, so the policy
 * read neither holds the transaction's connection nor runs per agent. Every
 * provider an agent names is reported, not only what differs from a row it
 * overwrites: the importer wants to know the agent will be refused.
 *
 * A policy that cannot be read does not fail the import — this is a warning,
 * not a gate — and is reported as one general warning instead.
 */
export async function importedAgentProviderWarnings(
  agents: readonly ImportedAgentProviders[]
): Promise<{ bySlug: Map<string, string>; unchecked: string | null }> {
  const bySlug = new Map<string, string>();
  let refused: Set<string>;
  try {
    refused = new Set(
      await unapprovedProviders(
        agents.flatMap((agent) => [agent.provider ?? '', ...(agent.fallbackProviders ?? [])])
      )
    );
  } catch (error) {
    logger.error('Import could not check agents against the org provider policy', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      bySlug,
      unchecked:
        "Agents were imported without checking their providers against this organisation's approved providers, which could not be read",
    };
  }
  for (const agent of agents) {
    const names = [...new Set([agent.provider ?? '', ...(agent.fallbackProviders ?? [])])].filter(
      (slug) => refused.has(slug)
    );
    if (names.length === 0) continue;
    bySlug.set(
      agent.slug,
      `Agent '${agent.slug}': imported, but this organisation is not approved to use ` +
        `${names.map((name) => `"${name}"`).join(', ')} — its calls are refused until a platform admin grants ` +
        `${names.length === 1 ? 'it' : 'them'}`
    );
  }
  return { bySlug, unchecked: null };
}
