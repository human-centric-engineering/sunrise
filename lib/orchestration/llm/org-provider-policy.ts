/**
 * Core's built-in provider policy at `multi` (§120 t-742).
 *
 * Design Q15 decided deny-by-default at `multi`; the owner ruling of
 * 2026-09-30 says how: **the install org is unrestricted, and every other org
 * may use only the providers a platform admin has approved it for** — none,
 * until one is granted. The approval lives in the org's `settings.providers`
 * slice (`lib/tenancy/org-settings.ts`), optionally with the jurisdictions the
 * org is held to, which are matched against `AiProviderConfig.jurisdiction`.
 *
 * At `single` this is identity: nothing is read and nothing is filtered.
 *
 * `resolveEligibleProviders` applies this BEFORE a fork's registered rule and
 * hands the fork only what survived, so a fork rule composes with it and can
 * only narrow it — the floor-not-ceiling shape of the `admin` key scope (Q6).
 * Because every selection site and the call-time gate go through that one
 * function, this rule reaches everything they reach.
 *
 * **The org is read from tenant context**, not from `ProviderEligibilityContext`,
 * which stays as it is: every caller already runs inside the org it acts for
 * (the call-time gate refuses one that does not), so widening the context
 * would add a second source for a value that has one.
 *
 * **Cached for 60 seconds per org and per provider slug**, because this runs
 * on the request hot path several times per chat turn. The window is how long
 * a revoked grant may still answer in another process; a write through the
 * admin API clears this process's entry at once, and a provider-row write
 * clears the jurisdiction entries via the provider manager's `clearCache`.
 * The same window, for the same reason, as `resolveAgentDocumentAccess`.
 *
 * Tenancy posture: row-keyed — the policy cache is keyed by org id and filled
 * by a `findUnique` on it; the jurisdiction cache holds global provider config
 * keyed by slug (lib/tenancy/process-state.ts).
 *
 * @see lib/orchestration/llm/provider-eligibility.ts — where it is applied
 * @see app/api/v1/admin/orgs/[id]/providers/route.ts — where it is written
 */

import { prisma } from '@/lib/db/client';
import { getTenantContext, isMultiTenant } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { readOrgProviderPolicy } from '@/lib/tenancy/org-settings';
import type { OrgProviderPolicy } from '@/lib/validations/tenancy';

/** How long a read policy or jurisdiction answers before it is read again. */
export const ORG_PROVIDER_POLICY_TTL_MS = 60_000;

const policyCache = new Map<string, { policy: OrgProviderPolicy; cachedAt: number }>();
const jurisdictionCache = new Map<string, { jurisdiction: string | null; cachedAt: number }>();

function fresh(cachedAt: number): boolean {
  return Date.now() - cachedAt < ORG_PROVIDER_POLICY_TTL_MS;
}

/** One org's policy. An org that does not exist has approved nothing. */
async function loadPolicy(orgId: string): Promise<OrgProviderPolicy> {
  const cached = policyCache.get(orgId);
  if (cached && fresh(cached.cachedAt)) return cached.policy;
  const org = await prisma.org.findUnique({ where: { id: orgId }, select: { settings: true } });
  const policy = readOrgProviderPolicy(org?.settings ?? null, { orgId });
  policyCache.set(orgId, { policy, cachedAt: Date.now() });
  return policy;
}

/** The recorded jurisdiction of each slug; a slug with no row has none. */
async function loadJurisdictions(slugs: readonly string[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const missing: string[] = [];
  for (const slug of slugs) {
    const cached = jurisdictionCache.get(slug);
    if (cached && fresh(cached.cachedAt)) result.set(slug, cached.jurisdiction);
    else missing.push(slug);
  }
  if (missing.length > 0) {
    const rows = await prisma.aiProviderConfig.findMany({
      where: { slug: { in: missing } },
      select: { slug: true, jurisdiction: true },
    });
    const bySlug = new Map(rows.map((row) => [row.slug, row.jurisdiction]));
    const now = Date.now();
    for (const slug of missing) {
      // Upper-cased to match the stored restriction, which the schema
      // upper-cases; a row written before the column was validated still
      // matches its own code.
      const jurisdiction = bySlug.get(slug)?.toUpperCase() ?? null;
      jurisdictionCache.set(slug, { jurisdiction, cachedAt: now });
      result.set(slug, jurisdiction);
    }
  }
  return result;
}

/**
 * The subset of `candidates` core's policy permits for the org in context.
 *
 *  - `single`: `candidates`, unchanged.
 *  - `multi`, no org in context (none entered, or `runAsSystem`): `[]` —
 *    there is no org whose policy could permit anything.
 *  - `multi`, the install org: `candidates`, unchanged.
 *  - `multi`, any other org: the candidates in its approved set and, when it
 *    is restricted to some jurisdictions, recorded in one of them. Order is
 *    kept, because fallbacks are tried in it.
 *
 * Throws when the policy cannot be read; `resolveEligibleProviders` turns that
 * into "nothing is eligible", as it does for a throwing fork rule.
 */
export async function applyOrgProviderPolicy(
  candidates: readonly string[]
): Promise<readonly string[]> {
  if (!isMultiTenant()) return candidates;
  const orgId = getTenantContext()?.orgId ?? null;
  if (orgId === null) return [];
  if (orgId === INSTALL_ORG_ID) return candidates;

  const policy = await loadPolicy(orgId);
  const approved = new Set(policy.approved);
  const permitted = candidates.filter((slug) => approved.has(slug));
  if (!policy.jurisdictions || permitted.length === 0) return permitted;

  const allowed = new Set(policy.jurisdictions);
  const recorded = await loadJurisdictions(permitted);
  return permitted.filter((slug) => {
    const jurisdiction = recorded.get(slug) ?? null;
    // Not recorded is not a match: an org held to the EU is not sent to a
    // provider nobody has said is in the EU.
    return jurisdiction !== null && allowed.has(jurisdiction);
  });
}

/** Drop one org's cached policy, or every org's. Called after a write. */
export function forgetOrgProviderPolicy(orgId?: string): void {
  if (orgId === undefined) policyCache.clear();
  else policyCache.delete(orgId);
}

/**
 * Drop one provider's cached jurisdiction, or every provider's. The provider
 * manager's `clearCache` calls this, so every provider-row write that evicts
 * the client also evicts the jurisdiction.
 */
export function forgetProviderJurisdiction(slug?: string): void {
  if (slug === undefined) jurisdictionCache.clear();
  else jurisdictionCache.delete(slug);
}
