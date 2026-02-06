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
import type { StorageProvider, UploadOptions, UploadResult, DeleteResult } from './types';
import { logger } from '@/lib/logging';
import { validateStorageKey } from './validate-key';

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
export class VercelBlobProvider implements StorageProvider {
  readonly name = 'vercel-blob';
  private token: string;

  constructor(config: VercelBlobProviderConfig) {
    this.token = config.token;
    logger.debug('Vercel Blob provider initialized');
  }

  async upload(file: Buffer, options: UploadOptions): Promise<UploadResult> {
    const { key, contentType } = options;
    validateStorageKey(key);

    // Vercel Blob uses the filename as the key
    // It automatically adds a unique prefix to prevent collisions
    const blob = await put(key, file, {
      access: options.public !== false ? 'public' : 'public', // Vercel Blob only supports public
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

  async deletePrefix(prefix: string): Promise<DeleteResult> {
    validateStorageKey(prefix);
    try {
      // List all blobs matching the prefix
      const { blobs } = await list({ prefix, token: this.token });

      if (blobs.length === 0) {
        logger.debug('No blobs found for prefix', { prefix });
        return { success: true, key: prefix };
      }

      // Delete all matching blobs
      const urls = blobs.map((blob) => blob.url);
      await del(urls, { token: this.token });

      logger.info('Blobs deleted from Vercel Blob by prefix', {
        prefix,
        count: blobs.length,
      });

      return { success: true, key: prefix };
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
