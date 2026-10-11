/**
 * Org-owned storage keys (§109 t-736).
 *
 * At `TENANCY_MODE=multi`, an object an org owns lives under
 * `orgs/{orgId}/…`. The prefix is what lets storage answer "whose is this?"
 * at all: the key is the only thing every backend keeps, so it is where the
 * owner has to be written. Three things read it:
 *
 * - the org-bound client (`lib/storage/org-scoped.ts`), which refuses any key
 *   outside its org on upload, read, delete and signing;
 * - the local access token's `org` claim (`lib/storage/access-tokens.ts`),
 *   minted only for keys inside that org and compared again on read;
 * - org erasure (`lib/privacy/erase-org.ts`), which deletes the org's prefix.
 *
 * **Not every key is org-owned.** Avatars stay at `avatars/{userId}/…`: a user
 * is a system model and can belong to several orgs. Keys written before this
 * existed (`agent-uploads/{agentId}/…`) carry no org and are reached by none of
 * the three above. At `single` nothing is prefixed, so a single-tenant fork's
 * keys do not change.
 */

/** The segment every org-owned key starts with. */
export const ORG_KEY_ROOT = 'orgs/';

/**
 * The prefix an org's objects live under: `orgs/{orgId}/`.
 *
 * @throws when `orgId` is empty or contains a `/`, either of which would let
 *   the prefix name another org's keys or the root itself
 */
export function orgKeyPrefix(orgId: string): string {
  if (!orgId || orgId.includes('/')) {
    throw new Error('An org storage prefix needs an org id with no "/" in it');
  }
  return `${ORG_KEY_ROOT}${orgId}/`;
}

/**
 * The org a key belongs to, read from its prefix, or `null` for a key that is
 * not org-owned (an avatar, a pre-prefix upload).
 *
 * A key that starts `orgs/` but names no org segment (`orgs/`, `orgs//x`) is
 * malformed rather than unowned; it returns `null` too, and every caller then
 * treats it as outside every org.
 */
export function orgOfKey(key: string): string | null {
  if (!key.startsWith(ORG_KEY_ROOT)) return null;
  const rest = key.slice(ORG_KEY_ROOT.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  return rest.slice(0, slash);
}

/**
 * True when `key` sits strictly inside `orgId`'s prefix.
 *
 * The prefix itself is inside (`orgs/a/` names the org's whole tree, which is
 * what erasure deletes); a sibling whose id merely starts the same way
 * (`orgs/ab/…` for org `a`) is not, because the comparison includes the
 * trailing `/`.
 */
export function isKeyInOrg(key: string, orgId: string): boolean {
  return key.startsWith(orgKeyPrefix(orgId));
}
