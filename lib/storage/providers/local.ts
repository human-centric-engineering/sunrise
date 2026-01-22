/**
 * Local Filesystem Storage Provider
 *
 * Implements the StorageProvider interface for local filesystem storage.
 * Designed for development only - not suitable for production.
 *
 * Files are stored in public/uploads/ and served by Next.js static file serving.
 *
 * @see .context/storage/overview.md for configuration documentation
 */

import { writeFile, unlink, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import type { StorageProvider, UploadOptions, UploadResult, DeleteResult } from './types';
import { logger } from '@/lib/logging';

/**
 * Local Provider Configuration
 */
export interface LocalProviderConfig {
  /** Base directory for file storage (default: public/uploads) */
  baseDir?: string;
  /** Base URL for serving files (default: /uploads) */
  baseUrl?: string;
}

/**
 * Local Filesystem Storage Provider
 *
 * Stores files in the public directory for static serving.
 * Only use in development - files are not persisted across deploys.
 */
export class LocalProvider implements StorageProvider {
  readonly name = 'local';
  private baseDir: string;
  private baseUrl: string;

  constructor(config: LocalProviderConfig = {}) {
    this.baseDir = config.baseDir || join(process.cwd(), 'public', 'uploads');
    this.baseUrl = config.baseUrl || '/uploads';

    logger.debug('Local storage provider initialized', {
      baseDir: this.baseDir,
      baseUrl: this.baseUrl,
    });
  }

  async upload(file: Buffer, options: UploadOptions): Promise<UploadResult> {
    const { key } = options;
    const filePath = join(this.baseDir, key);
    const fileDir = dirname(filePath);

    // Ensure directory exists
    if (!existsSync(fileDir)) {
      await mkdir(fileDir, { recursive: true });
    }

    // Write file
    await writeFile(filePath, file);

    const url = `${this.baseUrl}/${key}`;

    logger.info('File uploaded to local storage', {
      key,
      filePath,
      size: file.length,
      url,
    });

    return {
      key,
      url,
      size: file.length,
    };
  }

  async delete(key: string): Promise<DeleteResult> {
    const filePath = join(this.baseDir, key);

    try {
      if (existsSync(filePath)) {
        await unlink(filePath);
        logger.info('File deleted from local storage', { key, filePath });
      } else {
        logger.debug('File not found for deletion', { key, filePath });
      }

      return {
        success: true,
        key,
      };
    } catch (error) {
      logger.error('Failed to delete file from local storage', error, { key, filePath });
      return {
        success: false,
        key,
      };
    }
  }

  // Local provider doesn't need signed URLs - files are served statically
  // getSignedUrl is not implemented
}

/**
 * Create Local provider
 *
 * Always returns a valid provider - no configuration required.
 */
export function createLocalProvider(): LocalProvider {
  return new LocalProvider();
}
