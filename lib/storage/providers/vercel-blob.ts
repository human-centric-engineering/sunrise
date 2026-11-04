/**
 * Vercel Blob Storage Provider
 *
 * Implements the StorageProvider interface for Vercel Blob Storage.
 * Ideal for projects deployed on Vercel.
 *
 * A Vercel Blob store is either wholly public or wholly private, so this
 * provider holds up to two — one per token — and `upload({ public })` picks
 * between them, the way `LocalProvider` picks between its two roots:
 *
 * - **public** (default) → the store `BLOB_READ_WRITE_TOKEN` names, served
 *   from its CDN URL.
 * - **private** (`public: false`) → the store `BLOB_PRIVATE_READ_WRITE_TOKEN`
 *   names. Its objects are read with `download()` or through the signed read
 *   route (`/api/v1/storage/…`), whose tokens `getSignedUrl()` mints.
 *
 * Either store may be absent; an upload that needs the missing one is
 * refused. Reads and deletes span both stores — nothing records which store a
 * key went to, and missing one is how `eraseUser()` would leave a user's
 * private files behind.
 *
 * @see https://vercel.com/docs/storage/vercel-blob
 * @see .context/storage/overview.md for configuration documentation
 */

import { put, del, list, get, BlobNotFoundError } from '@vercel/blob';
import type {
  StorageProvider,
  StorageCapabilities,
  UploadOptions,
  UploadResult,
  DeleteResult,
  SignedUrlOptions,
  StorageObject,
} from '@/lib/storage/providers/types';
import { buildStorageAccessUrl } from '@/lib/storage/access-tokens';
import { logger } from '@/lib/logging';
import { validateStorageKey } from '@/lib/storage/providers/validate-key';

/**
 * Vercel Blob Provider Configuration
 *
 * At least one token is required.
 */
export interface VercelBlobProviderConfig {
  /** Read-write token for the public store */
  token?: string;
  /** Read-write token for the private store */
  privateToken?: string;
}

/** Which of the two stores an operation touches. */
type StoreAccess = 'public' | 'private';

interface Store {
  access: StoreAccess;
  token: string;
}

/**
 * Listing rounds `deletePrefix` makes before giving up. `list()` returns up to
 * 1000 blobs a page, so this covers a prefix of a million blobs.
 */
const MAX_PREFIX_DELETE_ROUNDS = 1000;

/** Listings in a row with nothing new to delete before `deletePrefix` gives up. */
const MAX_STALE_LISTINGS = 10;

/** Wait before re-listing after a listing returned only blobs already deleted. */
const STALE_LISTING_WAIT_MS = 200;

/**
 * How long one `download()` read may take. Every caller is server code
 * holding a request open, and the codebase's objects are capped at a few MB.
 */
const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Vercel Blob Storage Provider
 *
 * Simple, CDN-backed blob storage integrated with Vercel.
 */
export class VercelBlobProvider implements StorageProvider {
  readonly name = 'vercel-blob';
  private publicStore: Store | null;
  private privateStore: Store | null;

  /**
   * `download` works on either store. Private objects, and the signed URLs
   * that serve them, exist only when a private store is configured.
   */
  readonly capabilities: Partial<StorageCapabilities>;

  constructor(config: VercelBlobProviderConfig) {
    this.publicStore = config.token ? { access: 'public', token: config.token } : null;
    this.privateStore = config.privateToken
      ? { access: 'private', token: config.privateToken }
      : null;

    if (!this.publicStore && !this.privateStore) {
      throw new Error('Vercel Blob provider needs a public or a private store token');
    }

    const hasPrivate = this.privateStore !== null;
    this.capabilities = {
      privateObjects: hasPrivate,
      signedUrls: hasPrivate,
      download: true,
    };

    logger.debug('Vercel Blob provider initialized', {
      publicStore: this.publicStore !== null,
      privateStore: hasPrivate,
    });
  }

  /** Configured stores, private first — the order reads and deletes use. */
  private stores(): Store[] {
    return [this.privateStore, this.publicStore].filter((s): s is Store => s !== null);
  }

  async upload(file: Buffer, options: UploadOptions): Promise<UploadResult> {
    const { key, contentType } = options;
    validateStorageKey(key);

    const isPrivate = options.public === false;
    const store = isPrivate ? this.privateStore : this.publicStore;

    // No store for this visibility. Refusing is the only honest answer:
    // storing a private object in the public store is how a caller ends up
    // publishing a user's file, and the other way round hands back a URL
    // nobody can open.
    if (!store) {
      throw new Error(
        isPrivate
          ? 'Vercel Blob has no private store configured — set BLOB_PRIVATE_READ_WRITE_TOKEN, ' +
              'or check getStorageCapabilities(provider).privateObjects before uploading.'
          : 'Vercel Blob has no public store configured — set BLOB_READ_WRITE_TOKEN to store ' +
              'public objects such as avatars.'
      );
    }

    const blob = await put(key, file, {
      access: store.access,
      contentType,
      token: store.token,
      addRandomSuffix: false, // We handle uniqueness ourselves
    });

    // Enforce one-key-one-store, as LocalProvider does one-key-one-root.
    // Re-uploading a key with the opposite visibility would otherwise leave
    // the old copy in place: `download()` reads the private store first, so a
    // key flipped from public to private would return the private bytes while
    // the original stayed world-readable at its CDN URL. Removal happens after
    // the write succeeds, so a failed upload never destroys the existing
    // object.
    const staleStore = isPrivate ? this.publicStore : this.privateStore;
    if (staleStore) {
      const outcome = await this.deleteFrom(staleStore, key);
      if (outcome === 'failed') {
        // Fail the upload even though the write succeeded. Returning success
        // here would tell the caller the object is private while the old copy
        // is still served publicly. Retrying the upload is safe and idempotent.
        throw new Error(
          `Uploaded ${key} but could not remove the existing copy in the ` +
            `${staleStore.access} store — the object may still be readable there`
        );
      }
      if (outcome === 'deleted') {
        logger.info('Removed stale copy of key from the other Vercel Blob store', {
          key,
          newVisibility: store.access,
        });
      }
    }

    // A private blob's own URL needs the store token to open, so it is not an
    // address a caller can hand out. Point at the signed read route, as
    // LocalProvider does: the path alone won't serve the file — the route
    // requires a token from `getSignedUrl()` — but it is the object's address.
    // Encoded per segment, matching what `buildStorageAccessUrl()` emits.
    const url = isPrivate
      ? `/api/v1/storage/${key.split('/').map(encodeURIComponent).join('/')}`
      : blob.url;

    logger.info('File uploaded to Vercel Blob', {
      key,
      contentType,
      size: file.length,
      url,
      visibility: store.access,
    });

    return {
      key,
      url,
      size: file.length,
    };
  }

  /**
   * Delete a key from **both** stores.
   *
   * The caller does not say which store holds it, and nothing records it, so
   * both are swept. A key in neither store is a successful delete.
   *
   * A blob URL is the exception (`deleteFile()` passes a stored avatar URL
   * straight through): its hostname names the store it lives in, so it goes
   * to that store only. Sent to the other store, the other token may be
   * refused rather than told "not found", which would fail a delete that
   * worked.
   */
  async delete(key: string): Promise<DeleteResult> {
    validateStorageKey(key);

    const urlAccess = blobUrlAccess(key);
    if (urlAccess !== null) {
      const store = urlAccess === 'private' ? this.privateStore : this.publicStore;
      if (!store) {
        logger.error('Cannot delete a Vercel Blob URL from a store with no token', undefined, {
          key,
          store: urlAccess,
        });
        return { success: false, key };
      }
      const outcome = await this.deleteFrom(store, key);
      if (outcome === 'deleted') {
        logger.info('File deleted from Vercel Blob', { key, store: store.access });
      }
      return { success: outcome !== 'failed', key };
    }

    let success = true;
    for (const store of this.stores()) {
      const outcome = await this.deleteFrom(store, key);
      if (outcome === 'failed') success = false;
      else if (outcome === 'deleted') {
        logger.info('File deleted from Vercel Blob', { key, store: store.access });
      }
    }

    return { success, key };
  }

  /**
   * Delete one key from one store.
   *
   * Not found is "not in this store", not a failure: depending on the API,
   * `del()` either resolves for a key the store doesn't hold or throws
   * `BlobNotFoundError`, and both mean there is nothing left to remove.
   * Any other error is a failure, and is logged here.
   */
  private async deleteFrom(store: Store, key: string): Promise<'deleted' | 'absent' | 'failed'> {
    try {
      await del(key, { token: store.token });
      return 'deleted';
    } catch (error) {
      if (error instanceof BlobNotFoundError) return 'absent';
      logger.error('Failed to delete file from Vercel Blob', error, { key, store: store.access });
      return 'failed';
    }
  }

  /**
   * Delete every blob under a prefix, in **both** stores.
   *
   * This is the erasure path: `eraseUser()` clears a user's blobs through it
   * and org erasure reports its verdict as `storageSwept` (§109 t-736), so it
   * succeeds only when every configured store came back clean. Sweeping only
   * the public store would leave the private copies behind and turn erasure
   * into a partial delete.
   */
  async deletePrefix(prefix: string): Promise<DeleteResult> {
    validateStorageKey(prefix);

    let success = true;
    for (const store of this.stores()) {
      if (!(await this.sweepPrefix(store, prefix))) success = false;
    }
    return { success, key: prefix };
  }

  /**
   * Delete every blob under a prefix in one store; true when it came back
   * clean.
   *
   * Re-lists from the start after each deleted page rather than following the
   * listing's `cursor`: nothing documents whether that cursor survives the
   * deletion of the page it came from, and if it is positional, deleting page
   * one would make the next listing skip blobs while this still reported
   * success. Listing until the prefix comes back empty is correct either way.
   *
   * A listing can lag a delete (eventual consistency) and return blobs already
   * deleted. Those are not deleted or counted again; a listing with nothing
   * new waits {@link STALE_LISTING_WAIT_MS} and lists again, and
   * {@link MAX_STALE_LISTINGS} such listings in a row end it as a failure.
   * {@link MAX_PREFIX_DELETE_ROUNDS} bounds the whole loop.
   */
  private async sweepPrefix(store: Store, prefix: string): Promise<boolean> {
    try {
      const deleted = new Set<string>();
      let staleListings = 0;
      for (let round = 0; round < MAX_PREFIX_DELETE_ROUNDS; round++) {
        const { blobs } = await list({ prefix, token: store.token });
        if (blobs.length === 0) {
          if (deleted.size === 0) {
            logger.debug('No blobs found for prefix', { prefix, store: store.access });
          } else {
            logger.info('Blobs deleted from Vercel Blob by prefix', {
              prefix,
              store: store.access,
              count: deleted.size,
            });
          }
          return true;
        }

        const fresh = blobs.map((blob) => blob.url).filter((url) => !deleted.has(url));
        if (fresh.length === 0) {
          staleListings += 1;
          if (staleListings >= MAX_STALE_LISTINGS) break;
          await new Promise((resolve) => setTimeout(resolve, STALE_LISTING_WAIT_MS));
          continue;
        }

        staleListings = 0;
        await del(fresh, { token: store.token });
        for (const url of fresh) deleted.add(url);
      }
      logger.error('Vercel Blob prefix delete gave up with blobs still listed', undefined, {
        prefix,
        store: store.access,
        deleted: deleted.size,
      });
      return false;
    } catch (error) {
      logger.error('Failed to delete blobs from Vercel Blob by prefix', error, {
        prefix,
        store: store.access,
      });
      return false;
    }
  }

  /**
   * Read an object back as bytes.
   *
   * Private store first, as LocalProvider reads its private root first: a
   * caller asking for bytes by key is usually after the private object, and
   * checking it first means a public blob never shadows a private one of the
   * same key.
   *
   * Uses the SDK's `get()` with a pathname, so the request goes only to the
   * store the token names — never to a URL a caller supplied.
   *
   * @throws If the object is in neither store, or a read fails
   */
  async download(key: string): Promise<StorageObject> {
    validateStorageKey(key);

    for (const store of this.stores()) {
      const result = await get(key, {
        access: store.access,
        token: store.token,
        abortSignal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (result === null) continue;
      if (result.statusCode !== 200) {
        // Only a conditional request gets a 304, and this one sends none.
        throw new Error(`Unexpected ${result.statusCode} reading ${key} from Vercel Blob`);
      }

      const body = Buffer.from(await new Response(result.stream).arrayBuffer());

      // Length of what we actually read — the signed read route uses this as
      // a Content-Length, so it must describe these exact bytes.
      return { key, body, size: body.length, contentType: result.blob.contentType };
    }

    throw new Error(`Object not found in Vercel Blob: ${key}`);
  }

  /**
   * Mint a time-limited URL for the signed read route, as LocalProvider does.
   *
   * Vercel's own presigned URLs are not used: they need a second credential
   * flow, and they cannot carry the token's `org` claim the route checks
   * (§109 t-736). Like LocalProvider this does not check that the object
   * exists — the route resolves the key when the URL is used.
   *
   * Only meaningful with a private store, which is when `signedUrls` is
   * declared; without one there is nothing a signed URL would protect.
   */
  // Signing is an HMAC, not a round trip. It stays `async` so a rejected key
  // comes back as a rejected promise, as the interface's `Promise<string>`
  // promises every caller.
  // eslint-disable-next-line @typescript-eslint/require-await
  async getSignedUrl(
    key: string,
    expiresIn: number = 3600,
    options: SignedUrlOptions = {}
  ): Promise<string> {
    validateStorageKey(key);
    if (!this.privateStore) {
      throw new Error(
        'Vercel Blob has no private store configured, so it cannot sign URLs — set ' +
          'BLOB_PRIVATE_READ_WRITE_TOKEN, or check getStorageCapabilities(provider).signedUrls.'
      );
    }

    const { url } = buildStorageAccessUrl(key, expiresIn, undefined, options);

    logger.debug('Generated signed URL for Vercel Blob', {
      key,
      expiresIn,
      orgId: options.orgId,
    });

    return url;
  }
}

/**
 * Which store a Vercel Blob URL belongs to, or null for a pathname or any
 * other URL.
 *
 * The SDK builds blob URLs as `https://<storeId>.<access>.blob.vercel-storage.com/<pathname>`.
 */
function blobUrlAccess(keyOrUrl: string): StoreAccess | null {
  if (!/^https?:\/\//i.test(keyOrUrl)) return null;
  let hostname: string;
  try {
    hostname = new URL(keyOrUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (hostname.endsWith('.public.blob.vercel-storage.com')) return 'public';
  if (hostname.endsWith('.private.blob.vercel-storage.com')) return 'private';
  return null;
}

/**
 * Create Vercel Blob provider from environment variables
 *
 * Returns null if neither store token is set.
 */
export function createVercelBlobProviderFromEnv(): VercelBlobProvider | null {
  const token = process.env.BLOB_READ_WRITE_TOKEN || undefined;
  const privateToken = process.env.BLOB_PRIVATE_READ_WRITE_TOKEN || undefined;

  if (!token && !privateToken) {
    logger.debug(
      'Vercel Blob provider not configured - missing BLOB_READ_WRITE_TOKEN and BLOB_PRIVATE_READ_WRITE_TOKEN'
    );
    return null;
  }

  if (!token) {
    // Legal, and refused per upload — but avatars are public uploads, so say
    // it once at start-up rather than only when the first one fails.
    logger.warn(
      'Vercel Blob has a private store but no public store: public uploads such as avatars will be refused',
      { missingVars: ['BLOB_READ_WRITE_TOKEN'] }
    );
  }

  return new VercelBlobProvider({ token, privateToken });
}
