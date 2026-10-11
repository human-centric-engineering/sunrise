/**
 * The org-bound storage client (§109 t-736).
 *
 * Wraps the configured provider so that every key it is handed must sit
 * inside one org's prefix (`orgs/{orgId}/…`, `lib/storage/org-keys.ts`).
 * Upload, read, delete, prefix delete and signing all refuse a key outside
 * it, which is what makes the prefix an enforced boundary rather than a
 * naming convention a caller could forget.
 *
 * Reach it through `getStorageClient({ orgId })`. It is built per call and
 * holds nothing but the inner provider and the org id, so the process-wide
 * singleton in `client.ts` stays a single, org-free provider handle.
 *
 * **What it cannot do** is check a key that never passes through it. A caller
 * using the unbound `getStorageClient()` can still write anywhere; the rule
 * is that tenant-owned writes at `multi` go through this client, and today
 * the one such writer is `upload_to_storage`.
 */

import type { StorageProvider } from '@/lib/storage/providers/types';
import { isKeyInOrg, orgKeyPrefix } from '@/lib/storage/org-keys';

/**
 * Bind `inner` to `orgId`.
 *
 * @throws when `orgId` is not a usable prefix segment (see `orgKeyPrefix`)
 */
export function scopeStorageToOrg(inner: StorageProvider, orgId: string): StorageProvider {
  const prefix = orgKeyPrefix(orgId);

  // Async so a refusal comes back as a rejected promise: every method on the
  // interface returns one, and a synchronous throw would slip past a caller's
  // `.catch()`.
  const inOrg = (key: string, op: string): Promise<void> => {
    if (isKeyInOrg(key, orgId)) return Promise.resolve();
    return Promise.reject(
      new Error(`Storage ${op} refused: "${key}" is outside this org's prefix (${prefix})`)
    );
  };

  const scoped: StorageProvider = {
    name: inner.name,
    ...(inner.capabilities ? { capabilities: inner.capabilities } : {}),
    upload: async (file, options) => {
      await inOrg(options.key, 'upload');
      return inner.upload(file, options);
    },
    delete: async (key) => {
      await inOrg(key, 'delete');
      return inner.delete(key);
    },
    deletePrefix: async (keyPrefix) => {
      await inOrg(keyPrefix, 'prefix delete');
      return inner.deletePrefix(keyPrefix);
    },
  };

  // Bound, because a fork's provider may be a class whose methods read `this`.
  const getSignedUrl = inner.getSignedUrl?.bind(inner);
  const download = inner.download?.bind(inner);
  if (getSignedUrl) {
    scoped.getSignedUrl = async (key, expiresIn) => {
      await inOrg(key, 'signing');
      // The org goes down with the key. Local writes it into the token's
      // claim; S3 has nowhere to put it, which is why the check above is the
      // control for presigned URLs.
      return getSignedUrl(key, expiresIn, { orgId });
    };
  }
  if (download) {
    scoped.download = async (key) => {
      await inOrg(key, 'read');
      return download(key);
    };
  }

  return scoped;
}
