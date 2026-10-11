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

import type { StorageProvider, StorageProviderType } from '@/lib/storage/providers/types';
import { createS3ProviderFromEnv } from '@/lib/storage/providers/s3';
import { createVercelBlobProviderFromEnv } from '@/lib/storage/providers/vercel-blob';
import { createLocalProviderFromEnv } from '@/lib/storage/providers/local';
import { excludeOrgKeys, scopeStorageToOrg } from '@/lib/storage/org-scoped';
import { logger } from '@/lib/logging';

let storageClient: StorageProvider | null = null;
/** `storageClient` behind `excludeOrgKeys`, built once so callers share one instance. */
let unboundClient: StorageProvider | null = null;
let initWarningLogged = false;

/** Options for {@link getStorageClient}. */
export interface StorageClientOptions {
  /**
   * Bind the client to one org (§109 t-736): every key it is handed must sit
   * under `orgs/{orgId}/`, and signing passes the org down to the provider.
   * Omit it for keys no org owns (avatars); the unbound client then refuses
   * any key under the reserved `orgs/` root. See `lib/storage/org-scoped.ts`.
   */
  orgId?: string;
}

/**
 * Get the configured storage provider (singleton pattern)
 *
 * Returns null if no storage is configured and not in development mode.
 * In development, falls back to local filesystem storage.
 *
 * With `options.orgId`, returns the provider wrapped so it refuses any key
 * outside that org's prefix (built per call). Without it, returns the
 * provider wrapped so it refuses any key under the reserved `orgs/` root —
 * an org's files are reachable only through that org's client. The provider
 * itself stays org-free, so this resolver is also the seam a per-tenant
 * backend (research §5B rungs 2/4) would hang off, without v1 building one.
 *
 * @returns StorageProvider instance or null
 *
 * @example
 * ```typescript
 * const storage = getStorageClient();
 * if (storage) {
 *   await storage.upload(buffer, { key: 'avatars/123.jpg', contentType: 'image/jpeg' });
 * }
 *
 * const orgStorage = getStorageClient({ orgId });
 * await orgStorage?.upload(buffer, { key: `orgs/${orgId}/report.pdf`, contentType: 'application/pdf' });
 * ```
 */
export function getStorageClient(options: StorageClientOptions = {}): StorageProvider | null {
  const provider = getProvider();
  if (!provider) return null;
  if (options.orgId !== undefined) {
    return scopeStorageToOrg(provider, options.orgId);
  }
  unboundClient ??= excludeOrgKeys(provider);
  return unboundClient;
}

/** The process-wide provider, created on first use. */
function getProvider(): StorageProvider | null {
  // Return cached instance if available
  if (storageClient) {
    return storageClient;
  }

  const rawProvider = process.env.STORAGE_PROVIDER;
  const validProviders: readonly string[] = [
    's3',
    'vercel-blob',
    'local',
  ] satisfies StorageProviderType[];
  let explicitProvider: StorageProviderType | undefined;
  if (rawProvider) {
    if (validProviders.includes(rawProvider)) {
      explicitProvider = rawProvider as StorageProviderType;
    } else {
      logger.warn('Unknown STORAGE_PROVIDER value, ignoring', {
        provider: rawProvider,
        validProviders: ['s3', 'vercel-blob', 'local'],
      });
    }
  }
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
        return createLocalProviderFromEnv();
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
    return createLocalProviderFromEnv();
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
  unboundClient = null;
  initWarningLogged = false;
}
