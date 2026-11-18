/**
 * Organisations' own AI keys (§137 t-1044).
 *
 * An org can save its own vendor key for a provider row, and while the
 * install's switch is on (`AiOrchestrationSettings.orgProviderKeysEnabled`)
 * its calls on that row go out on that key instead of the install's. The key
 * is held sealed (`lib/security/sealed-secrets.ts`) in `AiOrgProviderKey` and
 * opened here, on the call path, and nowhere else.
 *
 * `resolveProviderCredential` (`provider-credentials.ts`) asks
 * {@link resolveOrgProviderKey} first, ahead of the app's resolver, at `multi`
 * and only for an org in scope. An org with no key for the row is answered
 * `null` and resolves exactly as it did before this module existed. At
 * `single` nothing here is read: the one org's key is the install's.
 *
 * ## An org with a key is never moved to another key
 *
 * Once an org has saved a key for a row, that row's calls for it either go out
 * on that key or are refused (`credential_unavailable`). They are never sent on
 * the install's key or handed to the app's resolver, because the org's data
 * agreement is with its own vendor account:
 *
 * - the switch is off (turned off with keys saved: those orgs are refused,
 *   visibly, until it is turned back on or they remove their keys);
 * - the org is not approved for the provider (§120's policy; approval stays
 *   with platform staff, and a saved key does not grant it);
 * - the key will not open (the master key it was sealed under is gone, or
 *   the envelope was tampered with or copied from another org's record);
 * - the lookup itself failed, so whether there is a key is unknown.
 *
 * Removing its key is how an org returns to the install's key.
 *
 * ## The identity changes whenever the key does
 *
 * The provider manager keeps a client per (slug, identity) for five minutes.
 * The identity here is `org-key:<orgId>:<keyRowId>:<version>`: `version` rises
 * on every save over an existing key, and a key removed and saved again gets a
 * new row id. So a replaced or removed key is never served by a client built
 * with it, once this module has seen the change.
 *
 * ## How long a change takes to be seen
 *
 * The row lookup is cached for {@link ORG_PROVIDER_KEY_TTL_MS} (60 seconds)
 * per org and provider row, because it runs on every provider fetch and every
 * reachability check. A save or removal through this module clears this
 * process's entry at once, so the next fetch in the writing process uses the
 * new key, or the install's. **In another process the old answer can stand for
 * up to 60 seconds**: a removed or replaced key may still be used there for
 * that long, and a newly saved one not yet used. The same window, for the
 * same reason, as a revoked provider approval (`org-provider-policy.ts`). The
 * switch is read through the orchestration settings cache, so turning it off
 * reaches another process within that cache's 30 seconds.
 *
 * Tenancy posture: row-keyed — the lookup cache is keyed by org id and
 * provider row id, and filled by a query filtered on both
 * (lib/tenancy/process-state.ts).
 *
 * @see lib/orchestration/llm/provider-credentials.ts — where it is asked
 * @see .context/orchestration/llm-providers.md — Organisations' own keys
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { applyOrgProviderPolicy } from '@/lib/orchestration/llm/org-provider-policy';
import { ProviderError } from '@/lib/orchestration/llm/provider';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import { openSecret, SealedSecretOpenError, sealSecret } from '@/lib/security/sealed-secrets';
import type { SealedStore, SealedValue } from '@/lib/security/sealed-stores';
import { isMultiTenant, requireTenantContext, runAsSystem } from '@/lib/tenancy/context';
import { KEY_DISALLOWED_CHARACTER, PROVIDER_KEY_MAX_LENGTH } from '@/lib/validations/tenancy';

/** How long a looked-up key row answers before it is read again. */
export const ORG_PROVIDER_KEY_TTL_MS = 60_000;

/** The longest key accepted. Vendor keys are well under this; a longer value is a paste error. */
export const ORG_PROVIDER_KEY_MAX_LENGTH = PROVIDER_KEY_MAX_LENGTH;

/** The provider row a key is looked up for: its id names the key, its slug the policy and logs. */
export interface OrgProviderKeyConfig {
  id: string;
  slug: string;
}

/** What {@link resolveOrgProviderKey} answers for an org that holds a key. */
export interface OrgProviderCredential {
  apiKey: string;
  identity: string;
}

/**
 * What may be read of a saved key outside this module: everything but the
 * key. Every reader that is not the call path selects this, so the sealed
 * value never reaches an export, a response or a log by a wide select.
 */
export const ORG_PROVIDER_KEY_SUMMARY_SELECT = {
  id: true,
  orgId: true,
  providerConfigId: true,
  version: true,
  hint: true,
  savedById: true,
  savedAt: true,
  createdAt: true,
} as const satisfies Prisma.AiOrgProviderKeySelect;

export type OrgProviderKeySummary = Prisma.AiOrgProviderKeyGetPayload<{
  select: typeof ORG_PROVIDER_KEY_SUMMARY_SELECT;
}>;

/**
 * The purpose a key is sealed for. It names the org and the provider row, so
 * an envelope copied onto another org's or another row's record does not
 * open. Ids are cuids, which contain no `:`.
 */
export function orgProviderKeyPurpose(orgId: string, providerConfigId: string): string {
  return `org-provider-key:${orgId}:${providerConfigId}`;
}

/** The credential identity for one saved version of one org's key. Never the key. */
export function orgProviderKeyIdentity(orgId: string, keyId: string, version: number): string {
  return `org-key:${orgId}:${keyId}:${version}`;
}

/** The shortest key that is given a hint: below it, four characters are too much of it. */
const HINT_MIN_KEY_LENGTH = 16;

/**
 * The key's last four characters, for a person to recognise it by; empty for
 * a key shorter than {@link HINT_MIN_KEY_LENGTH}, whose last four would be a
 * large part of it. The hint is stored in the clear and exported.
 */
export function orgProviderKeyHint(apiKey: string): string {
  return apiKey.length < HINT_MIN_KEY_LENGTH ? '' : apiKey.slice(-4);
}

/** What the call path needs of a key row. */
interface StoredKey {
  id: string;
  version: number;
  sealedKey: string;
}

/**
 * The LOOKUP is cached, not its answer, as in `org-provider-policy.ts`: the
 * entry is set before the query runs, so concurrent misses share one query,
 * and a write's `forget` evicts it outright. A read that started before the
 * write answers its own callers and no later one.
 */
interface Entry {
  value: Promise<StoredKey | null>;
  cachedAt: number;
}

const lookupCache = new Map<string, Entry>();

function cacheKey(orgId: string, providerConfigId: string): string {
  return `${orgId}:${providerConfigId}`;
}

/** The org's stored key row for a provider row, or `null` for none. Cached. */
function lookup(orgId: string, providerConfigId: string): Promise<StoredKey | null> {
  const key = cacheKey(orgId, providerConfigId);
  const cached = lookupCache.get(key);
  if (cached && Date.now() - cached.cachedAt < ORG_PROVIDER_KEY_TTL_MS) return cached.value;
  const entry: Entry = {
    value: prisma.aiOrgProviderKey.findUnique({
      where: { orgId_providerConfigId: { orgId, providerConfigId } },
      select: { id: true, version: true, sealedKey: true },
    }),
    cachedAt: Date.now(),
  };
  lookupCache.set(key, entry);
  // A failed read is not an answer: the next caller asks again.
  entry.value.catch(() => {
    if (lookupCache.get(key) === entry) lookupCache.delete(key);
  });
  return entry.value;
}

/** Why an org's key was refused, for the log. Never carries the key. */
type Refusal = 'lookup_failed' | 'switched_off' | 'not_approved' | 'will_not_open';

const REFUSAL_FIX: Record<Refusal, string> = {
  lookup_failed:
    'Whether this org has its own key could not be read, so it is not sent on any key until it can be.',
  switched_off:
    'This org has saved its own key, and organisations’ own keys are switched off in the orchestration settings. Turn them back on, or remove the org’s key to return it to the install’s key.',
  not_approved:
    'This org has saved its own key for a provider it is not approved for. A platform admin approves providers per org.',
  will_not_open:
    'The org’s saved key will not open: the master key it was sealed under is not configured, or the stored value is not this org’s. The org must save its key again.',
};

/**
 * When each (org, row, reason) refusal was last logged. The lookup runs on
 * every reachability check as well as every call, so an org refused while the
 * switch is off would otherwise log on every turn and every admin list load.
 * Once per {@link ORG_PROVIDER_KEY_TTL_MS} is enough to be seen.
 */
const lastWarned = new Map<string, number>();

function refuse(
  config: OrgProviderKeyConfig,
  orgId: string,
  reason: Refusal,
  detail?: string
): never {
  const warnKey = `${cacheKey(orgId, config.id)}:${reason}`;
  const last = lastWarned.get(warnKey);
  if (last === undefined || Date.now() - last >= ORG_PROVIDER_KEY_TTL_MS) {
    lastWarned.set(warnKey, Date.now());
    logger.warn('Refusing a provider call: the org’s own key cannot be used', {
      provider: config.slug,
      orgId,
      reason,
      ...(detail ? { detail } : {}),
      fix: REFUSAL_FIX[reason],
    });
  }
  throw new ProviderError(`No credential is available for provider "${config.slug}"`, {
    code: 'credential_unavailable',
    retriable: false,
  });
}

/** An error's name and code. Never its message, which can echo a query or a value. */
export function describeError(err: unknown): string {
  if (err instanceof SealedSecretOpenError) return `${err.name} ${err.reason}`;
  if (!(err instanceof Error)) return typeof err;
  const code: unknown = 'code' in err ? err.code : undefined;
  return typeof code === 'string' || typeof code === 'number' ? `${err.name} ${code}` : err.name;
}

/**
 * The org's own credential for `config`, or `null` when the org has saved no
 * key for that row (resolve as before). Call it for an org in scope at
 * `multi` only; `resolveProviderCredential` does.
 *
 * @throws ProviderError `credential_unavailable` when the org has a key that
 *   cannot be used, or whether it has one cannot be read. See the header.
 */
export async function resolveOrgProviderKey(
  config: OrgProviderKeyConfig,
  orgId: string
): Promise<OrgProviderCredential | null> {
  let stored: StoredKey | null;
  try {
    stored = await lookup(orgId, config.id);
  } catch (err) {
    return refuse(config, orgId, 'lookup_failed', describeError(err));
  }
  if (!stored) return null;

  let enabled: boolean;
  let approved: boolean;
  try {
    // Both cached; on a miss they share the wait.
    const [settings, permitted] = await Promise.all([
      getOrchestrationSettings(),
      applyOrgProviderPolicy([config.slug]),
    ]);
    enabled = settings.orgProviderKeysEnabled;
    approved = permitted.includes(config.slug);
  } catch (err) {
    return refuse(config, orgId, 'lookup_failed', describeError(err));
  }
  if (!enabled) return refuse(config, orgId, 'switched_off');
  if (!approved) return refuse(config, orgId, 'not_approved');

  let apiKey: string;
  try {
    apiKey = await openSecret(stored.sealedKey, orgProviderKeyPurpose(orgId, config.id));
  } catch (err) {
    return refuse(config, orgId, 'will_not_open', describeError(err));
  }
  return { apiKey, identity: orgProviderKeyIdentity(orgId, stored.id, stored.version) };
}

/**
 * What an org's saved key does on its next call: `in_use`, or the reason the
 * call is refused, in the order the call path checks. `provider_off` comes
 * first because the provider manager refuses an inactive row before any
 * credential is asked for; the rest are {@link resolveOrgProviderKey}'s.
 * The lookup failing is not a state; reading the states fails instead.
 */
export type OrgProviderKeyState =
  'in_use' | 'provider_off' | 'switched_off' | 'not_approved' | 'will_not_open';

/** A saved key as the people administering the org see it: the summary and its state. */
export interface OrgProviderKeyStatus extends OrgProviderKeySummary {
  state: OrgProviderKeyState;
}

/**
 * Every key the org in scope has saved, each with its state (§137 t-1045).
 * The same checks as the call path, so the page says what the next call will
 * do: but read fresh rather than from the lookup cache, and the key is opened
 * only to learn whether it opens. Nothing returned carries it.
 *
 * @throws when the keys, the settings or the org's approvals cannot be read.
 */
export async function orgProviderKeyStatuses(): Promise<OrgProviderKeyStatus[]> {
  const orgId = writingOrg();
  const rows = await prisma.aiOrgProviderKey.findMany({
    where: { orgId },
    select: {
      ...ORG_PROVIDER_KEY_SUMMARY_SELECT,
      sealedKey: true,
      providerConfig: { select: { slug: true, isActive: true } },
    },
    orderBy: { savedAt: 'asc' },
  });
  if (rows.length === 0) return [];
  const [settings, permitted] = await Promise.all([
    getOrchestrationSettings(),
    applyOrgProviderPolicy(rows.map((row) => row.providerConfig.slug)),
  ]);
  const approved = new Set(permitted);
  return Promise.all(
    rows.map(async ({ sealedKey, providerConfig, ...summary }) => {
      let state: OrgProviderKeyState = 'in_use';
      if (!providerConfig.isActive) state = 'provider_off';
      else if (!settings.orgProviderKeysEnabled) state = 'switched_off';
      else if (!approved.has(providerConfig.slug)) state = 'not_approved';
      else if (!(await opens(sealedKey, orgId, summary.providerConfigId))) state = 'will_not_open';
      return { ...summary, state };
    })
  );
}

/** Whether a stored envelope opens for this org and row. */
async function opens(sealedKey: string, orgId: string, providerConfigId: string): Promise<boolean> {
  try {
    await openSecret(sealedKey, orgProviderKeyPurpose(orgId, providerConfigId));
    return true;
  } catch {
    return false;
  }
}

/**
 * The org-in-scope's saved key for a provider row, opened, for the on-demand
 * test (§137 t-1045): `null` when it has none, and `apiKey: null` when it is
 * saved but will not open. The key is for a vendor call on the server only;
 * never return it to a browser or log it.
 *
 * @throws when the row cannot be read, or opening fails for any reason but
 *   the envelope itself (a missing master key is thrown, not reported).
 */
export async function openOrgProviderKey(
  providerConfigId: string
): Promise<{ apiKey: string | null; summary: OrgProviderKeySummary } | null> {
  const orgId = writingOrg();
  const row = await prisma.aiOrgProviderKey.findUnique({
    where: { orgId_providerConfigId: { orgId, providerConfigId } },
    select: { ...ORG_PROVIDER_KEY_SUMMARY_SELECT, sealedKey: true },
  });
  if (!row) return null;
  const { sealedKey, ...summary } = row;
  try {
    return {
      apiKey: await openSecret(sealedKey, orgProviderKeyPurpose(orgId, providerConfigId)),
      summary,
    };
  } catch (err) {
    if (err instanceof SealedSecretOpenError) return { apiKey: null, summary };
    throw err;
  }
}

/** The org a read or write of its own keys acts for: the one in scope. It needs one. */
function writingOrg(): string {
  const { orgId } = requireTenantContext();
  if (orgId === null) {
    throw new Error(
      'An org’s own provider keys are read, saved or removed inside that org’s scope.'
    );
  }
  return orgId;
}

/**
 * Save the org-in-scope's key for a provider row: a first key, or one that
 * replaces the key it had (its version then rises by one). Seals it, and
 * clears this process's cached lookup, so the next fetch here uses it.
 *
 * Saving a key does not approve the provider for the org, and does not turn
 * the switch on. Validation of what a person typed is the caller's; this
 * refuses only what can never be a key.
 *
 * @throws when the key is empty, too long, or holds anything but printable ASCII; when
 *   no master key is configured (`SealedSecretKeyMissingError`); or when no
 *   org is in scope.
 */
export async function saveOrgProviderKey(input: {
  providerConfigId: string;
  apiKey: string;
  savedById: string | null;
}): Promise<OrgProviderKeySummary> {
  const { providerConfigId, apiKey, savedById } = input;
  if (
    apiKey.length === 0 ||
    apiKey.length > ORG_PROVIDER_KEY_MAX_LENGTH ||
    // Anything but printable ASCII (a space, a wrapped paste's line break, a
    // zero-width space): no vendor key has one, and most cannot be sent as a
    // header value, so every call would fail at the vendor client.
    KEY_DISALLOWED_CHARACTER.test(apiKey)
  ) {
    throw new Error(
      `An org's provider key must be 1–${ORG_PROVIDER_KEY_MAX_LENGTH} printable ASCII characters with no spaces.`
    );
  }
  const orgId = writingOrg();
  const sealedKey = await sealSecret(apiKey, orgProviderKeyPurpose(orgId, providerConfigId));
  const hint = orgProviderKeyHint(apiKey);
  const savedAt = new Date();
  const write = () =>
    prisma.aiOrgProviderKey.upsert({
      where: { orgId_providerConfigId: { orgId, providerConfigId } },
      create: { orgId, providerConfigId, sealedKey, hint, savedById, savedAt },
      update: { sealedKey, hint, savedById, savedAt, version: { increment: 1 } },
      select: ORG_PROVIDER_KEY_SUMMARY_SELECT,
    });
  try {
    try {
      return await write();
    } catch (err) {
      // Two first saves at once both take the create branch, and the loser
      // hits the unique key. Once more takes the update branch: the later
      // save replaces the earlier, as it would have a moment later.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return await write();
      }
      throw err;
    }
  } finally {
    // Also on a failed write: whatever the row now holds is read fresh.
    forgetOrgProviderKey(orgId, providerConfigId);
  }
}

/**
 * Remove the org-in-scope's key for a provider row, returning the org to the
 * install's key for it (if it is approved for the provider). Clears this
 * process's cached lookup. Answers whether there was a key.
 */
export async function removeOrgProviderKey(providerConfigId: string): Promise<boolean> {
  const orgId = writingOrg();
  try {
    const { count } = await prisma.aiOrgProviderKey.deleteMany({
      where: { orgId, providerConfigId },
    });
    return count > 0;
  } finally {
    forgetOrgProviderKey(orgId, providerConfigId);
  }
}

/**
 * How many orgs hold at least one saved key, across the install. What the
 * switch shows before it is turned off, and what Config Health reports.
 */
export async function countOrgsWithProviderKeys(): Promise<number> {
  // At `single` no org key is read, and the switch is not shown: nothing to count.
  if (!isMultiTenant()) return 0;
  // Install-wide by definition: under row isolation a count from inside one
  // org would see that org's keys alone.
  const orgs = await runAsSystem('count the orgs holding their own provider keys', () =>
    prisma.aiOrgProviderKey.findMany({ distinct: ['orgId'], select: { orgId: true } })
  );
  return orgs.length;
}

/**
 * How many orgs have saved their own key for one provider row, across the
 * install: what a permanent delete of the row would silently take with it.
 */
export async function countOrgKeysForProvider(providerConfigId: string): Promise<number> {
  return runAsSystem('count the orgs holding their own key for a provider row', () =>
    prisma.aiOrgProviderKey.count({ where: { providerConfigId } })
  );
}

/**
 * Drop one org's cached lookup for one provider row, one org's for every
 * row, or every one. The write functions above call it; a write made any
 * other way must too, or this process answers from the old row for up to
 * {@link ORG_PROVIDER_KEY_TTL_MS}.
 */
export function forgetOrgProviderKey(orgId?: string, providerConfigId?: string): void {
  if (orgId === undefined) {
    lookupCache.clear();
    lastWarned.clear();
    return;
  }
  if (providerConfigId !== undefined) {
    lookupCache.delete(cacheKey(orgId, providerConfigId));
    return;
  }
  const prefix = `${orgId}:`;
  for (const key of lookupCache.keys()) {
    if (key.startsWith(prefix)) lookupCache.delete(key);
  }
}

const RESEAL_PAGE = 200;

/**
 * Where orgs' keys are kept, for `npm run secrets:reseal` (§137 t-1043).
 * Registered by `lib/security/sealed-stores.ts`; walked inside `runAsSystem`.
 */
export const orgProviderKeySealedStore: SealedStore = {
  name: 'org-provider-keys',
  async *list(): AsyncIterable<SealedValue> {
    let cursor: string | undefined;
    for (;;) {
      const page = await prisma.aiOrgProviderKey.findMany({
        take: RESEAL_PAGE,
        orderBy: { id: 'asc' },
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: { id: true, orgId: true, providerConfigId: true, sealedKey: true },
      });
      for (const row of page) {
        yield {
          id: row.id,
          sealed: row.sealedKey,
          purpose: orgProviderKeyPurpose(row.orgId, row.providerConfigId),
        };
      }
      if (page.length < RESEAL_PAGE) return;
      cursor = page[page.length - 1].id;
    }
  },
  async replace(id, previous, next) {
    // Only where the row still holds what was read, so a key saved during the
    // walk is never overwritten with the older one. The key and its version
    // are unchanged: only the envelope around it moves.
    const { count } = await prisma.aiOrgProviderKey.updateMany({
      where: { id, sealedKey: previous },
      data: { sealedKey: next },
    });
    if (count === 1) forgetOrgProviderKey();
    return count === 1;
  },
};
