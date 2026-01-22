/**
 * Storage Client
 *
 * Singleton client that manages the storage provider based on configuration.
 * Follows the same pattern as the email client (graceful degradation).
 *
 * Provider selection priority:
 * 1. STORAGE_PROVIDER env var (explicit selection)
 * 2. Auto-detection based on available credentials
 * 3. Local provider fallback in development
 *
 * @see .context/storage/overview.md for architecture documentation
 */

import type { StorageProvider, StorageProviderType } from './providers/types';
import { createS3ProviderFromEnv } from './providers/s3';
import { createVercelBlobProviderFromEnv } from './providers/vercel-blob';
import { createLocalProvider } from './providers/local';
import { logger } from '@/lib/logging';

let storageClient: StorageProvider | null = null;
let initWarningLogged = false;

/**
 * Get the configured storage provider (singleton pattern)
 *
 * Returns null if no storage is configured and not in development mode.
 * In development, falls back to local filesystem storage.
 *
 * @returns StorageProvider instance or null
 *
 * @example
 * ```typescript
 * const storage = getStorageClient();
 * if (storage) {
 *   await storage.upload(buffer, { key: 'avatars/123.jpg', contentType: 'image/jpeg' });
 * }
 * ```
 */
export function getStorageClient(): StorageProvider | null {
  // Return cached instance if available
  if (storageClient) {
    return storageClient;
  }

  const explicitProvider = process.env.STORAGE_PROVIDER as StorageProviderType | undefined;
  const isDevelopment = process.env.NODE_ENV === 'development';

  // Try to create provider based on explicit configuration or auto-detection
  storageClient = createProvider(explicitProvider, isDevelopment);

  // Log initialization result
  if (storageClient) {
    logger.info('Storage client initialized', { provider: storageClient.name });
  } else if (!initWarningLogged) {
    initWarningLogged = true;
    logger.warn('Storage not configured - file uploads disabled', {
      explicitProvider,
      isDevelopment,
      recommendation: 'Set STORAGE_PROVIDER and credentials, or use local storage in development',
    });
  }

  return storageClient;
}

/**
 * Create storage provider based on configuration
 */
function createProvider(
  explicitProvider: StorageProviderType | undefined,
  isDevelopment: boolean
): StorageProvider | null {
  // Explicit provider selection
  if (explicitProvider) {
    switch (explicitProvider) {
      case 's3': {
        const provider = createS3ProviderFromEnv();
        if (!provider) {
          logger.error('S3 provider requested but not configured', {
            missingVars: ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'],
          });
        }
        return provider;
      }
      case 'vercel-blob': {
        const provider = createVercelBlobProviderFromEnv();
        if (!provider) {
          logger.error('Vercel Blob provider requested but not configured', {
            missingVars: ['BLOB_READ_WRITE_TOKEN'],
          });
        }
        return provider;
      }
      case 'local':
        return createLocalProvider();
      default:
        logger.error('Unknown storage provider', { provider: explicitProvider });
        return null;
    }
  }

  // Auto-detection: try providers in order of preference
  // S3 first (most common for production)
  const s3Provider = createS3ProviderFromEnv();
  if (s3Provider) {
    logger.debug('Auto-detected S3 storage configuration');
    return s3Provider;
  }

  // Vercel Blob second
  const blobProvider = createVercelBlobProviderFromEnv();
  if (blobProvider) {
    logger.debug('Auto-detected Vercel Blob storage configuration');
    return blobProvider;
  }

  // Fall back to local storage in development
  if (isDevelopment) {
    logger.debug('Using local storage provider (development fallback)');
    return createLocalProvider();
  }

  // No provider available
  return null;
}

/**
 * Check if storage is enabled and configured
 *
 * Use this to conditionally show/hide upload features in the UI.
 *
 * @example
 * ```typescript
 * if (isStorageEnabled()) {
 *   // Show upload button
 * } else {
 *   // Show "uploads not available" message
 * }
 * ```
 */
export function isStorageEnabled(): boolean {
  return getStorageClient() !== null;
}

/**
 * Get the name of the current storage provider
 *
 * @returns Provider name or null if not configured
 */
export function getStorageProviderName(): string | null {
  const client = getStorageClient();
  return client?.name ?? null;
}

/**
 * Reset the storage client (useful for testing)
 *
 * @internal
 */
export function resetStorageClient(): void {
  storageClient = null;
  initWarningLogged = false;
}
