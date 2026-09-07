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
 * | webhook subscriptions | `isSafeProviderUrl` (create + update schema, and the PATCH route on activate) | write time |
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
 * **Write time vs call time.** The hook planes check when the row is written,
 * not on every dispatch, and that is sufficient rather than lax:
 * `checkSafeProviderUrl` performs **no DNS resolution** (see its own docblock),
 * so re-running the same string check at dispatch would decide the same thing.
 *
 * "Write time" has to mean every write, though, and it did not. The backup
 * importer skips the create schema, and `updateWebhookSchema.url` is
 * `.optional()` — so a patch of `{ isActive, secret }` activated a stored URL
 * nothing had ever checked, which is precisely what the importer instructs an
 * admin to do. An earlier draft of this docblock asserted that path was closed;
 * it was not. Now it is, in two places: `backup/schema.ts` refuses to persist an
 * unsafe destination, and the PATCH route revalidates the stored URL before
 * activating, which also covers rows imported before that refine existed.
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
