/**
 * Vercel Blob Storage Provider
 *
 * Implements the StorageProvider interface for Vercel Blob Storage.
 * Ideal for projects deployed on Vercel.
 *
 * @see https://vercel.com/docs/storage/vercel-blob
 * @see .context/storage/overview.md for configuration documentation
 */

import { put, del, list } from '@vercel/blob';
import type {
  StorageProvider,
  StorageCapabilities,
  UploadOptions,
  UploadResult,
  DeleteResult,
} from '@/lib/storage/providers/types';
import { logger } from '@/lib/logging';
import { validateStorageKey } from '@/lib/storage/providers/validate-key';

/**
 * Vercel Blob Provider Configuration
 */
export interface VercelBlobProviderConfig {
  /** Vercel Blob read-write token */
  token: string;
}

/**
 * Vercel Blob Storage Provider
 *
 * Simple, CDN-backed blob storage integrated with Vercel.
 */
/**
 * Listing rounds `deletePrefix` makes before giving up. `list()` returns up to
 * 1000 blobs a page, so this covers a prefix of a million blobs.
 */
const MAX_PREFIX_DELETE_ROUNDS = 1000;

/** Listings in a row with nothing new to delete before `deletePrefix` gives up. */
const MAX_STALE_LISTINGS = 10;

/** Wait before re-listing after a listing returned only blobs already deleted. */
const STALE_LISTING_WAIT_MS = 200;

export class VercelBlobProvider implements StorageProvider {
  readonly name = 'vercel-blob';
  private token: string;

  /**
   * Everything is false, and stated rather than left to the default so it
   * is clear this is a fact about the backend and not an oversight: blobs
   * are public-only, there are no signed URLs, and reading bytes back goes
   * through the public URL rather than the provider interface.
   */
  readonly capabilities: Partial<StorageCapabilities> = {
    privateObjects: false,
    signedUrls: false,
    download: false,
  };

  constructor(config: VercelBlobProviderConfig) {
    this.token = config.token;
    logger.debug('Vercel Blob provider initialized');
  }

  async upload(file: Buffer, options: UploadOptions): Promise<UploadResult> {
    const { key, contentType } = options;
    validateStorageKey(key);

    // Unlike S3, there is no configuration under which this provider could
    // honour `public: false` — every blob is served from a public CDN URL.
    // Refusing is the only honest answer: silently storing the object
    // publicly is how a caller ends up publishing a user's file.
    if (options.public === false) {
      throw new Error(
        'Vercel Blob cannot store private objects — every blob is publicly readable. ' +
          'Use S3 (or the local provider) for private uploads, or check ' +
          'getStorageCapabilities(provider).privateObjects before uploading.'
      );
    }

    // Vercel Blob uses the filename as the key
    // It automatically adds a unique prefix to prevent collisions
    const blob = await put(key, file, {
      access: 'public', // Vercel Blob only supports public
      contentType,
      token: this.token,
      addRandomSuffix: false, // We handle uniqueness ourselves
    });

    logger.info('File uploaded to Vercel Blob', {
      key,
      contentType,
      size: file.length,
      url: blob.url,
    });

    return {
      key,
      url: blob.url,
      size: file.length,
    };
  }

  async delete(key: string): Promise<DeleteResult> {
    validateStorageKey(key);
    try {
      // Vercel Blob delete expects a URL, so we need to construct it
      // The key stored should be the full URL for Vercel Blob
      await del(key, { token: this.token });

      logger.info('File deleted from Vercel Blob', { key });

      return {
        success: true,
        key,
      };
    } catch (error) {
      logger.error('Failed to delete file from Vercel Blob', error, { key });
      return {
        success: false,
        key,
      };
    }
  }

  /**
   * Delete every blob under a prefix.
   *
   * Re-lists from the start after each deleted page rather than following the
   * listing's `cursor`: nothing documents whether that cursor survives the
   * deletion of the page it came from, and if it is positional, deleting page
   * one would make the next listing skip blobs while this still reported
   * success. Listing until the prefix comes back empty is correct either way.
   * Org erasure reports this verdict as `storageSwept` (§109 t-736).
   *
   * A listing can lag a delete (eventual consistency) and return blobs already
   * deleted. Those are not deleted or counted again; a listing with nothing
   * new waits {@link STALE_LISTING_WAIT_MS} and lists again, and
   * {@link MAX_STALE_LISTINGS} such listings in a row end it as a failure.
   * {@link MAX_PREFIX_DELETE_ROUNDS} bounds the whole loop.
   */
  async deletePrefix(prefix: string): Promise<DeleteResult> {
    validateStorageKey(prefix);
    try {
      const deleted = new Set<string>();
      let staleListings = 0;
      for (let round = 0; round < MAX_PREFIX_DELETE_ROUNDS; round++) {
        const { blobs } = await list({ prefix, token: this.token });
        if (blobs.length === 0) {
          if (deleted.size === 0) {
            logger.debug('No blobs found for prefix', { prefix });
          } else {
            logger.info('Blobs deleted from Vercel Blob by prefix', {
              prefix,
              count: deleted.size,
            });
          }
          return { success: true, key: prefix };
        }

        const fresh = blobs.map((blob) => blob.url).filter((url) => !deleted.has(url));
        if (fresh.length === 0) {
          staleListings += 1;
          if (staleListings >= MAX_STALE_LISTINGS) break;
          await new Promise((resolve) => setTimeout(resolve, STALE_LISTING_WAIT_MS));
          continue;
        }

        staleListings = 0;
        await del(fresh, { token: this.token });
        for (const url of fresh) deleted.add(url);
      }
      logger.error('Vercel Blob prefix delete gave up with blobs still listed', undefined, {
        prefix,
        deleted: deleted.size,
      });
      return { success: false, key: prefix };
    } catch (error) {
      logger.error('Failed to delete blobs from Vercel Blob by prefix', error, { prefix });
      return { success: false, key: prefix };
    }
  }

  // Vercel Blob doesn't support signed URLs - all files are public
  // getSignedUrl is not implemented
}

/**
 * Create Vercel Blob provider from environment variables
 *
 * Returns null if required configuration is missing.
 */
export function createVercelBlobProviderFromEnv(): VercelBlobProvider | null {
  const token = process.env.BLOB_READ_WRITE_TOKEN;

  if (!token) {
    logger.debug('Vercel Blob provider not configured - missing BLOB_READ_WRITE_TOKEN');
    return null;
  }

  return new VercelBlobProvider({ token });
}
