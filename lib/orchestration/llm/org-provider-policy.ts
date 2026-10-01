/**
 * Core's built-in provider policy at `multi` (§120 t-742).
 *
 * Design Q15 decided deny-by-default at `multi`; the owner ruling of
 * 2026-09-30 says how: **the install org is unrestricted, and every other org
 * may use only the providers a platform admin has approved it for** — none,
 * until one is granted. The approval lives in the org's `settings.providers`
 * slice (`lib/tenancy/org-settings.ts`) as provider row ids, optionally with
 * the jurisdictions the org is held to, which are matched against
 * `AiProviderConfig.jurisdiction`.
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
 * a revoked grant, or a changed jurisdiction, may still answer in ANOTHER
 * process; a write through the admin API clears this process's entry at once,
 * and a provider-row write clears the row's entry via the provider manager's
 * `clearCache`.
 * The same window, for the same reason, as `resolveAgentDocumentAccess`.
 *
 * Tenancy posture: row-keyed — the policy cache is keyed by org id and filled
 * by a `findUnique` on it; the provider-row cache holds global provider config
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

/** How long a read policy or provider row answers before it is read again. */
export const ORG_PROVIDER_POLICY_TTL_MS = 60_000;

/**
 * The LOOKUP is cached, not its answer: the entry is set before the query
 * runs, so concurrent misses share one query, and `forget` evicts it outright.
 * Caching the answer once the query returned would let a read that started
 * before a write put the old policy back after the write's `forget` — a
 * revoked grant answering for another full TTL in the very process that was
 * told about the revocation.
 */
interface Entry<T> {
  value: Promise<T>;
  cachedAt: number;
}

/** What the policy needs of a provider row: the id a grant names, and where it is. */
interface ProviderRow {
  id: string;
  jurisdiction: string | null;
}

const policyCache = new Map<string, Entry<OrgProviderPolicy>>();
const providerRowCache = new Map<string, Entry<ProviderRow | null>>();

function fresh<T>(entry: Entry<T> | undefined): entry is Entry<T> {
  return entry !== undefined && Date.now() - entry.cachedAt < ORG_PROVIDER_POLICY_TTL_MS;
}

/** Cache `value` under `key`, and drop it again if it rejects. */
function remember<T>(cache: Map<string, Entry<T>>, key: string, value: Promise<T>): Promise<T> {
  const entry: Entry<T> = { value, cachedAt: Date.now() };
  cache.set(key, entry);
  // A failed read is not an answer: the next caller asks again.
  value.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  return value;
}

/** One org's policy. An org that does not exist has approved nothing. */
function loadPolicy(orgId: string): Promise<OrgProviderPolicy> {
  const cached = policyCache.get(orgId);
  if (fresh(cached)) return cached.value;
  return remember(
    policyCache,
    orgId,
    prisma.org
      .findUnique({ where: { id: orgId }, select: { settings: true } })
      .then((org) => readOrgProviderPolicy(org?.settings ?? null, { orgId }))
  );
}

/**
 * The row behind each candidate; one with no row maps to `null`. A candidate
 * is matched as `getProvider` matches it — a row with that slug first, else a
 * row with that name — so a fallback list holding a provider's name is judged
 * by the row it would actually reach.
 */
async function loadProviderRows(
  slugs: readonly string[]
): Promise<Map<string, ProviderRow | null>> {
  const missing = slugs.filter((slug) => !fresh(providerRowCache.get(slug)));
  if (missing.length > 0) {
    const rows = prisma.aiProviderConfig.findMany({
      where: { OR: [{ slug: { in: missing } }, { name: { in: missing } }] },
      select: { id: true, slug: true, name: true, jurisdiction: true },
    });
    for (const slug of missing) {
      // Awaited below, from the cache, with the rest.
      void remember(
        providerRowCache,
        slug,
        rows.then((found) => {
          const row =
            found.find((candidate) => candidate.slug === slug) ??
            found.find((candidate) => candidate.name === slug);
          if (!row) {
            // A miss is not cached: the write-time check is handed whatever
            // an admin typed, so caching misses would grow this map without
            // bound, and a row created in another process would read as
            // missing here until the TTL ran out. (The entry is already set
            // by now; callers holding its promise still get this answer.)
            providerRowCache.delete(slug);
            return null;
          }
          // Upper-cased to match the stored restriction, which the schema
          // upper-cases; a row written before the column was validated still
          // matches its own code.
          return { id: row.id, jurisdiction: row.jurisdiction?.toUpperCase() ?? null };
        })
      );
    }
  }
  const answers = await Promise.all(
    slugs.map((slug) => providerRowCache.get(slug)?.value ?? Promise.resolve(null))
  );
  return new Map(slugs.map((slug, index) => [slug, answers[index]]));
}

/**
 * Whether core's policy restricts the org in context: `'open'` at `single` and
 * for the install org, `'no-org'` at `multi` with no org in scope (nothing is
 * permitted), `'enforced'` otherwise. For write-time callers that word their
 * refusal, or skip work, by it.
 */
export function orgProviderPolicyScope(): 'open' | 'no-org' | 'enforced' {
  if (!isMultiTenant()) return 'open';
  const orgId = getTenantContext()?.orgId ?? null;
  if (orgId === null) return 'no-org';
  return orgId === INSTALL_ORG_ID ? 'open' : 'enforced';
}

/**
 * The subset of `candidates` core's policy permits for the org in context.
 *
 *  - `single`: `candidates`, unchanged.
 *  - `multi`, no org in context (none entered, or `runAsSystem`): `[]` —
 *    there is no org whose policy could permit anything.
 *  - `multi`, the install org: `candidates`, unchanged.
 *  - `multi`, any other org: the candidates whose provider ROW it is approved
 *    for and, when it is restricted to some jurisdictions, recorded in one of
 *    them. Order is kept, because fallbacks are tried in it.
 *
 * **A grant names the row's id, never its slug.** Candidates arrive as slugs,
 * and each is resolved to its row here. A slug is something a platform admin
 * can rename, delete and re-create; an id is not. Keyed on the slug, a grant
 * followed whichever row held that slug, so deleting a provider and creating
 * another under its old slug handed the new one every grant the old one had.
 * Keyed on the id, a renamed row keeps its grants and a new row starts with
 * none, whatever path wrote the slug — once this process has read the row.
 * The slug-to-row answer is cached for the TTL like the policy, so a delete
 * and re-create made in ANOTHER process (or by a seed, which does not call
 * the provider manager's `clearCache`) can be judged against the old row for
 * up to 60 seconds: the same window as a revoked grant.
 *
 * A provider with no row — one registered in code with `registerProvider`
 * or `registerProviderInstance` — cannot be granted, so at `multi` it serves
 * the install org only.
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

  // Independent reads, both cached; on a miss they share the round trip.
  const [policy, rows] = await Promise.all([loadPolicy(orgId), loadProviderRows(candidates)]);
  const approved = new Set(policy.approved);
  const allowed = policy.jurisdictions ? new Set(policy.jurisdictions) : null;
  return candidates.filter((slug) => {
    const row = rows.get(slug) ?? null;
    if (row === null || !approved.has(row.id)) return false;
    // Not recorded is not a match: an org held to the EU is not sent to a
    // provider nobody has said is in the EU.
    return allowed === null || (row.jurisdiction !== null && allowed.has(row.jurisdiction));
  });
}

/**
 * The providers among `slugs` the org in context is NOT approved for, by core's
 * policy alone — the write-time question (§120 t-743): "may this org save a
 * configuration naming these?". Blank entries (an inherited provider) and
 * duplicates are ignored; order is kept.
 *
 * Empty at `single`, for the install org, and whenever every slug is approved.
 * Deliberately not the fork's eligibility rule: that rule answers per call and
 * per source, and may be a network lookup, so a save would fail whenever the
 * fork's policy backend was down. The call-time gate still asks it on every
 * call.
 *
 * Throws when the org's policy cannot be read, so a save fails loudly rather
 * than being waved through on a read that never happened.
 */
export async function unapprovedProviders(slugs: readonly string[]): Promise<string[]> {
  const named = [...new Set(slugs.filter((slug) => slug.length > 0))];
  if (named.length === 0) return [];
  const permitted = new Set(await applyOrgProviderPolicy(named));
  return named.filter((slug) => !permitted.has(slug));
}

/**
 * Drop one org's cached policy, or every org's. Called after a write; a
 * lookup already in flight still answers its own callers, but no later one.
 */
export function forgetOrgProviderPolicy(orgId?: string): void {
  if (orgId === undefined) policyCache.clear();
  else policyCache.delete(orgId);
}

/**
 * Drop one slug's cached provider row, or every one. The provider manager's
 * `clearCache` calls this, so every provider-row write that evicts the client
 * also evicts what the policy knows of the row.
 */
export function forgetProviderRow(slug?: string): void {
  if (slug === undefined) providerRowCache.clear();
  else providerRowCache.delete(slug);
}
