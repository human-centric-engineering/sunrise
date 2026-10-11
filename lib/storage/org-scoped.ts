/**
 * The org-bound and unbound storage clients (§109 t-736).
 *
 * Both wrap the configured provider with a rule about which keys it will
 * touch, checked on upload, read, delete, prefix delete and signing:
 *
 * - **Org-bound** (`scopeStorageToOrg`, via `getStorageClient({ orgId })`):
 *   every key must sit inside one org's prefix, `orgs/{orgId}/…`
 *   (`lib/storage/org-keys.ts`). Signing also passes the org down to the
 *   provider, which local writes into the token's claim.
 * - **Unbound** (`excludeOrgKeys`, via `getStorageClient()`): no key may sit
 *   under the reserved `orgs/` root at all. Keys no org owns (avatars) go
 *   here.
 *
 * Together they make the prefix an enforced boundary rather than a naming
 * convention: there is no client that will write, read or delete an org's
 * key except the one bound to that org. Code that needs an org's files —
 * `upload_to_storage`, the signed read route for an org-claimed token, org
 * erasure — asks for that org's client.
 */

import type { StorageProvider } from '@/lib/storage/providers/types';
import { isKeyInOrg, isUnderOrgRoot, orgKeyPrefix, ORG_KEY_ROOT } from '@/lib/storage/org-keys';

/**
 * Wrap `inner` so every key passes `allowed`, refusing the rest with a
 * rejected promise that says why. `orgId`, when given, is passed to the
 * provider's signer.
 */
function guardKeys(
  inner: StorageProvider,
  allowed: (key: string) => boolean,
  why: (key: string) => string,
  orgId?: string
): StorageProvider {
  // Async so a refusal comes back as a rejected promise: every method on the
  // interface returns one, and a synchronous throw would slip past a caller's
  // `.catch()`.
  const check = (key: string, op: string): Promise<void> =>
    allowed(key)
      ? Promise.resolve()
      : Promise.reject(new Error(`Storage ${op} refused: ${why(key)}`));

  const guarded: StorageProvider = {
    name: inner.name,
    ...(inner.capabilities ? { capabilities: inner.capabilities } : {}),
    upload: async (file, options) => {
      await check(options.key, 'upload');
      return inner.upload(file, options);
    },
    delete: async (key) => {
      await check(key, 'delete');
      return inner.delete(key);
    },
    deletePrefix: async (keyPrefix) => {
      await check(keyPrefix, 'prefix delete');
      return inner.deletePrefix(keyPrefix);
    },
  };

  // Bound, because a fork's provider may be a class whose methods read `this`.
  const getSignedUrl = inner.getSignedUrl?.bind(inner);
  const download = inner.download?.bind(inner);
  if (getSignedUrl) {
    guarded.getSignedUrl = async (key, expiresIn) => {
      await check(key, 'signing');
      // The org goes down with the key. Local writes it into the token's
      // claim; S3 has nowhere to put it, which is why the check above is the
      // control for presigned URLs. Whatever options the caller passed are
      // ignored: a caller cannot sign for an org through a client not bound
      // to it.
      return getSignedUrl(key, expiresIn, orgId !== undefined ? { orgId } : {});
    };
  }
  if (download) {
    guarded.download = async (key) => {
      await check(key, 'read');
      return download(key);
    };
  }

  return guarded;
}

/**
 * Bind `inner` to `orgId`: every key must sit inside `orgs/{orgId}/`.
 *
 * @throws when `orgId` is not a usable prefix segment (see `orgKeyPrefix`)
 */
export function scopeStorageToOrg(inner: StorageProvider, orgId: string): StorageProvider {
  const prefix = orgKeyPrefix(orgId);
  return guardKeys(
    inner,
    (key) => isKeyInOrg(key, orgId),
    (key) => `"${key}" is outside this org's prefix (${prefix})`,
    orgId
  );
}

/**
 * Wrap `inner` so no key under the reserved `orgs/` root gets through, in any
 * letter case: those keys are reachable only through the owning org's client.
 */
export function excludeOrgKeys(inner: StorageProvider): StorageProvider {
  return guardKeys(
    inner,
    (key) => !isUnderOrgRoot(key),
    (key) =>
      `"${key}" is under the reserved ${ORG_KEY_ROOT} root; use getStorageClient({ orgId }) for an org's files`
  );
}
