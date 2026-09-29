/**
 * What an org may change on a platform agent, and which slugs it may not take
 * (§116 t-725).
 *
 * Every org has its own instance of each platform agent (`isSystem: true`),
 * and the reconcile writes the platform's fields back on each release
 * (`reconcile-platform-agents.ts`). So an edit to one of those fields is
 * accepted, audited as a success, and then quietly undone. Refusing it is the
 * honest answer, and every write path consults this module to do so: the agent
 * PATCH, the binding routes and the widget config. (Version restore reads the
 * same registry split directly: it skips fields rather than refusing them.)
 *
 * **The split is the field registry's**, not a list here: a field declared
 * `platformAgent: 'code'` is the platform's, `'org'` is the org's (provider,
 * model, fallbacks, provider config, budget, per-turn cap, rate limit,
 * retention). A new column takes a side there and is guarded here by
 * construction.
 *
 * **Gate on the value CHANGING, not on the field being present** — the
 * capability precedent (`capabilities/seed-owned.ts`). A client echoing the
 * whole agent back with only the model changed must not be refused for the
 * forty fields it did not touch.
 *
 * **Reserved slugs.** The reconcile never adopts an org's own agent that
 * holds a platform slug, and the features that look a platform agent up by
 * slug must not find one either. So no agent an org creates, renames, clones
 * or imports may take a registered platform slug, whether or not this org
 * gets an instance of it.
 */
import { ForbiddenError, ValidationError } from '@/lib/api/errors';
import { platformAgentFieldNames } from '@/lib/orchestration/agents/agent-field-registry';
import { getPlatformAgent } from '@/lib/orchestration/agents/platform-agents';
import { jsonEquals } from '@/lib/utils/json-equal';

/** The two grant relations, compared as sets: their order means nothing. */
const GRANT_FIELDS = new Set(['grantedTagIds', 'grantedDocumentIds']);

/**
 * The agent as stored, with its grants flattened to id lists. A caller that
 * never writes grants may leave them out; the guard only compares fields the
 * incoming write carries.
 */
export type PlatformOwnedCurrentValues = Record<string, unknown> & {
  grantedTagIds?: readonly string[];
  grantedDocumentIds?: readonly string[];
};

/**
 * Whether two grant lists grant the same things: compared as sets, because
 * the write path skips duplicates. The agent PATCH uses the same rule to
 * decide whether grants changed, so the guard and versioning agree.
 */
export function sameGrantSet(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return jsonEquals(a, b);
  // As sets: the write path skips duplicates, so [a, b, b] grants [a, b].
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...right].every((id) => left.has(id));
}

/**
 * The platform-owned fields an incoming write to a system agent would actually
 * change, in registry order. Fields absent from `incoming` are not being
 * written and are skipped. `[]` is the ordinary answer for any write that
 * leaves the platform's fields as they are.
 */
export function changedPlatformOwnedFields(
  current: PlatformOwnedCurrentValues,
  incoming: Record<string, unknown>
): string[] {
  return platformAgentFieldNames('code').filter((field) => {
    const next = incoming[field];
    if (next === undefined) return false;
    return GRANT_FIELDS.has(field)
      ? !sameGrantSet(next, current[field])
      : !jsonEquals(next, current[field]);
  });
}

/** Refuse a write that changes any platform-owned field of a system agent. */
export function assertPlatformOwnedFieldsUnchanged(
  agent: { isSystem: boolean; name: string },
  current: PlatformOwnedCurrentValues,
  incoming: Record<string, unknown>
): void {
  if (!agent.isSystem) return;
  const changed = changedPlatformOwnedFields(current, incoming);
  if (changed.length === 0) return;
  throw new ForbiddenError(
    `"${agent.name}" is a platform agent, so ${changed.join(', ')} ${
      changed.length === 1 ? 'is' : 'are'
    } set by the platform and cannot be changed here. This org can change: ${platformAgentFieldNames(
      'org'
    ).join(', ')}.`
  );
}

/**
 * Whether a system agent's capability bindings are the platform's. They are,
 * unless its definition leaves them to the org (`capabilityBindings: 'org'`,
 * as `mcp-system` does). A system agent with no definition — one a release
 * retired — keeps the platform's answer: nothing an org does to it survives.
 */
export function platformBindingsLocked(agent: { isSystem: boolean; slug: string }): boolean {
  if (!agent.isSystem) return false;
  return getPlatformAgent(agent.slug)?.capabilityBindings !== 'org';
}

/**
 * The binding columns the platform owns on a platform-bound agent: only
 * `isEnabled`, which the reconcile writes back (it re-enables every declared
 * binding). The binding set itself is guarded by {@link assertBindingsEditable}.
 * `customConfig` and `customRateLimit` are the org's: the reconcile never
 * writes them, so locking them would freeze whatever they hold with no way to
 * change or clear it.
 */
export const PLATFORM_OWNED_BINDING_FIELDS = ['isEnabled'] as const;

/** The platform-owned binding fields an incoming write would actually change. */
export function changedPlatformOwnedBindingFields(
  current: { isEnabled: boolean },
  incoming: { isEnabled?: boolean }
): string[] {
  return PLATFORM_OWNED_BINDING_FIELDS.filter((field) => {
    const next = incoming[field];
    return next !== undefined && !jsonEquals(next, current[field]);
  });
}

/**
 * Refuse a change to a platform-owned binding field. Call only for an agent
 * whose bindings are locked ({@link platformBindingsLocked}).
 */
export function assertBindingFieldsUnchanged(
  agent: { name: string },
  current: { isEnabled: boolean },
  incoming: { isEnabled?: boolean }
): void {
  const changed = changedPlatformOwnedBindingFields(current, incoming);
  if (changed.length === 0) return;
  throw new ForbiddenError(
    `"${agent.name}" is a platform agent, so ${changed.join(' and ')} on its capabilities ${
      changed.length === 1 ? 'is' : 'are'
    } set by the platform and cannot be changed here. This org can change customConfig and customRateLimit.`
  );
}

/** Refuse a binding change on a system agent whose bindings are the platform's. */
export function assertBindingsEditable(agent: {
  isSystem: boolean;
  slug: string;
  name: string;
}): void {
  if (!platformBindingsLocked(agent)) return;
  throw new ForbiddenError(
    `"${agent.name}" is a platform agent, so its capabilities are set by the platform and cannot be changed here.`
  );
}

/**
 * What the admin surfaces need to show a system agent read-only where the API
 * would refuse the edit. `null` for an org's own agent.
 */
export interface PlatformAgentEditPolicy {
  /** Fields the API refuses to change (scalars and the two grant lists). */
  lockedFields: string[];
  /** Fields this org may change: how the agent runs here. */
  tunableFields: string[];
  /** Whether the capability-binding routes refuse changes. */
  bindingsLocked: boolean;
}

export function platformAgentEditPolicy(agent: {
  isSystem: boolean;
  slug: string;
}): PlatformAgentEditPolicy | null {
  if (!agent.isSystem) return null;
  return {
    lockedFields: platformAgentFieldNames('code'),
    tunableFields: platformAgentFieldNames('org'),
    bindingsLocked: platformBindingsLocked(agent),
  };
}

/** Whether a slug belongs to a registered platform agent. */
export function isReservedAgentSlug(slug: string): boolean {
  return getPlatformAgent(slug) !== undefined;
}

/** The message a refused slug carries, shared by the routes and importers. */
export function reservedAgentSlugMessage(slug: string): string {
  return `The slug "${slug}" is reserved for a platform agent`;
}

/**
 * A `where` fragment for finding an agent by slug. A platform slug names the
 * org's platform instance only, so an org's own agent that took the slug
 * before it was reserved is not found in its place; any other slug is
 * unconstrained.
 */
export function platformSlugWhere(slug: string): { isSystem?: true } {
  return isReservedAgentSlug(slug) ? { isSystem: true } : {};
}

/**
 * The same rule for a lookup by a list of slugs: an org's own agent under
 * any platform slug in the list is excluded, every other match is kept.
 */
export function platformSlugsWhere(slugs: readonly string[]): {
  NOT?: { slug: { in: string[] }; isSystem: false };
} {
  const reserved = slugs.filter(isReservedAgentSlug);
  return reserved.length > 0 ? { NOT: { slug: { in: reserved }, isSystem: false } } : {};
}

/** Refuse a reserved slug as a validation error on the `slug` field. */
export function assertAgentSlugNotReserved(slug: string): void {
  if (!isReservedAgentSlug(slug)) return;
  const message = reservedAgentSlugMessage(slug);
  throw new ValidationError(message, { slug: [message] });
}
