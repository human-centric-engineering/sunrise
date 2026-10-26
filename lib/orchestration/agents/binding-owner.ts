/**
 * Who decides a platform agent's provider and model (t-798) — the
 * `AiAgent.bindingOwner` column.
 *
 * A platform agent whose definition picks its own binding (`defaultBinding`,
 * the clean-up agent in core) follows that pick while the platform owns it,
 * so it moves as what the org can reach changes. Once an admin sets provider
 * or model it is the org's, and the platform never moves it again. Ownership
 * is stored rather than inferred from the values, because a value cannot say
 * who wrote it: an admin who picks inherit, or the model the platform last
 * placed, would otherwise read as the platform.
 *
 * `null` is "not yet classified": an agent from before t-798, or any agent
 * the reconcile does not place. The reconcile classifies a platform agent's
 * row on its next run (`reconcile-platform-agents.ts`).
 *
 * Pure, so the validation schemas (bundled into the client) can import it;
 * the PATCH rule that needs the platform registry is `bindingOwnerForPatch`
 * in `platform-agent-guard.ts`.
 */

export const BINDING_OWNERS = ['platform', 'org'] as const;

export type BindingOwner = (typeof BINDING_OWNERS)[number];

/**
 * What a version restore leaves as it is while the platform owns a platform
 * agent's binding (t-821): the binding, and the configuration of whichever
 * provider is primary. The restore route skips these, and the Versions tab's
 * confirm dialog leaves them out of what it says comes back.
 */
export const PLATFORM_BINDING_FIELDS = ['provider', 'model', 'providerConfig'] as const;

/**
 * What a write leaves `bindingOwner` as: `'org'` when it changes provider or
 * model, `undefined` (no change) otherwise. Compared by value, so a client
 * echoing the agent back takes nothing over. Every route that writes either
 * field of a platform agent that picks its own binding (`picksOwnBinding` in
 * `platform-agent-guard.ts`) calls this; every other agent's owner stays null.
 * The reconcile is the only writer of `'platform'` besides a hand-back.
 */
export function bindingOwnerAfterWrite(
  current: { provider: string; model: string },
  next: { provider?: string; model?: string }
): 'org' | undefined {
  const changed =
    (next.provider !== undefined && next.provider !== current.provider) ||
    (next.model !== undefined && next.model !== current.model);
  return changed ? 'org' : undefined;
}
