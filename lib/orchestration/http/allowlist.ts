/**
 * Outbound host allowlist for orchestration HTTP calls.
 *
 * Reads `ORCHESTRATION_ALLOWED_HOSTS` (comma-separated hostnames) and
 * caches the parsed set until the env var changes. Both the workflow
 * `external_call` executor and the `call_external_api` capability go
 * through this module.
 *
 * **Scope: those two callers, and nothing else.** This docstring used to end
 * "there is no other path for outbound HTTP from the orchestration layer",
 * which was false and actively harmful — a spike doc repeated the claim because
 * a reader of a module reasonably trusts what it says about itself, and the
 * error propagated from here.
 *
 * The orchestration layer has FIVE outbound planes. This allowlist governs one:
 *
 * | plane | destination control | applied |
 * | --- | --- | --- |
 * | `external_call` step / `call_external_api` capability | **this allowlist** | per call |
 * | LLM + embedding provider `baseUrl` | `checkSafeProviderUrl` | write and build time |
 * | webhook subscriptions | `checkSafeProviderUrl` in `attemptWebhookDelivery`, plus `isSafeProviderUrl` on create, update, backup import and `/test` | **point of use** + write time |
 * | event hooks | `isSafeProviderUrl` on the action URL (`hooks/types.ts`) | write **and** dispatch time |
 * | escalation notifier, knowledge URL fetcher | `checkSafeProviderUrl` | write **and** call time |
 *
 * The LLM row is the one that carries prompts and documents off-box, and the
 * first version of this table omitted it — while asking readers to add a plane
 * if they found one. Left as a reminder that a hand-maintained list is a
 * convention, not a control.
 *
 * Two distinctions worth keeping straight, because conflating them is what
 * produced the sentence above.
 *
 * **Allowlist vs shape check.** This module answers "which third parties may we
 * reach". The other three answer only "is this a third party at all, or is it
 * our own network". The hook planes deliberately get no allowlist: their
 * destinations are operator-configured and honouring the URL is the feature —
 * see the reasoning beside `attemptWebhookDelivery` in `webhooks/dispatcher.ts`.
 *
 * **Where the check runs.** For webhooks, at the point of use in
 * `attemptWebhookDelivery`, and additionally on the write paths so an operator
 * hears about a bad destination while they can still fix it. Write-path checks
 * alone were tried and were not enough: guarding writes means guarding a list of
 * state transitions, and two successive cuts of that list were each walked
 * around by the transition they had missed. Event hooks already have this
 * shape — `loadHooks` and `parseDeliveryForDispatch` re-parse the stored action
 * through `WebhookActionSchema`, which carries the refine.
 *
 * **Why it is worth the machinery.** This is tenancy groundwork. Today an admin
 * IS the platform operator, so a webhook aimed at the deployment's own network
 * reaches infrastructure they already own. Under multi-tenancy an org admin is
 * not the operator, and the identical request crosses an isolation boundary into
 * the platform's network. The guard is written for that reader — judging it
 * against today's single-tenant install is judging groundwork by the absence of
 * the thing it is groundwork for.
 *
 * If you add a sixth outbound path, say so here. Nothing enforces that; this
 * table is a convention, which is exactly why the sentence it replaced went
 * unchallenged for so long.
 */

export const ALLOWED_HOSTS_ENV = 'ORCHESTRATION_ALLOWED_HOSTS';

let cachedAllowedHosts: Set<string> | null = null;
let cachedAllowedHostsRaw: string | undefined;

function getAllowedHosts(): Set<string> {
  const raw = process.env[ALLOWED_HOSTS_ENV] ?? '';
  if (cachedAllowedHosts && cachedAllowedHostsRaw === raw) return cachedAllowedHosts;
  cachedAllowedHostsRaw = raw;
  cachedAllowedHosts = new Set(
    raw
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0)
  );
  return cachedAllowedHosts;
}

export function isHostAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    return getAllowedHosts().has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Reset cached allowlist — for tests. */
export function resetAllowlistCache(): void {
  cachedAllowedHosts = null;
  cachedAllowedHostsRaw = undefined;
}
