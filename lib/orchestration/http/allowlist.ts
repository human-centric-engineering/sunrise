/**
 * Outbound host allowlist for orchestration HTTP calls.
 *
 * Reads `ORCHESTRATION_ALLOWED_HOSTS` (comma-separated hostnames) and
 * caches the parsed set until the env var changes. Both the workflow
 * `external_call` executor and the `call_external_api` capability go
 * through this module — there is no other path for outbound HTTP from
 * the orchestration layer.
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
