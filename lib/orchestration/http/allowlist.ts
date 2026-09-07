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
 * The orchestration layer has four outbound planes. This allowlist governs one:
 *
 * | plane | destination control | applied |
 * | --- | --- | --- |
 * | `external_call` step / `call_external_api` capability | **this allowlist** | per call |
 * | webhook subscriptions | `isSafeProviderUrl` in the create/update schema | write time |
 * | event hooks | `isSafeProviderUrl` on the action URL (`hooks/types.ts`) | write time |
 * | escalation notifier, knowledge URL fetcher | `checkSafeProviderUrl` | write **and** call time |
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
 * **Write time vs call time.** The hook planes check when the row is written,
 * not on every dispatch, and that is sufficient rather than lax:
 * `checkSafeProviderUrl` performs **no DNS resolution** (see its own docblock),
 * so re-running the same string check at dispatch would decide the same thing.
 * The one write path that skips the schema — the backup importer — forces
 * `isActive: false` with an empty secret, and dispatch refuses a subscription
 * with no secret, so an imported row cannot deliver until an admin re-enables it
 * through the update schema, which does refine.
 *
 * If you add a fifth outbound path, say so here. Nothing enforces that; this
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
