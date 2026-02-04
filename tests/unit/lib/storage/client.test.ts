import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies
vi.mock('@/lib/logging', () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock S3 provider
vi.mock('@/lib/storage/providers/s3', () => ({
  createS3ProviderFromEnv: vi.fn(() => null),
}));

// Mock Vercel Blob provider
vi.mock('@/lib/storage/providers/vercel-blob', () => ({
  createVercelBlobProviderFromEnv: vi.fn(() => null),
}));

// Mock Local provider
vi.mock('@/lib/storage/providers/local', () => ({
  createLocalProvider: vi.fn(() => ({
    name: 'local',
    upload: vi.fn(),
    delete: vi.fn(),
  })),
}));

describe('lib/storage/client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('getStorageClient', () => {
    it('should return local provider in development when no provider configured', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('STORAGE_PROVIDER', '');

      const { getStorageClient, resetStorageClient } = await import('@/lib/storage/client');
      const { logger } = await import('@/lib/logging');

      resetStorageClient();
      const client = getStorageClient();

      expect(client).not.toBeNull();
      expect(client?.name).toBe('local');
      expect(logger.info).toHaveBeenCalledWith('Storage client initialized', { provider: 'local' });
    });

    it('should return null in production when no provider configured', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('STORAGE_PROVIDER', '');

      const { getStorageClient, resetStorageClient } = await import('@/lib/storage/client');
      const { logger } = await import('@/lib/logging');

      resetStorageClient();
      const client = getStorageClient();

      expect(client).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        'Storage not configured - file uploads disabled',
        expect.objectContaining({
          isDevelopment: false,
        })
      );
    });

    it('should return local provider when STORAGE_PROVIDER=local', async () => {
      vi.stubEnv('STORAGE_PROVIDER', 'local');
      vi.stubEnv('NODE_ENV', 'production');

      const { getStorageClient, resetStorageClient } = await import('@/lib/storage/client');

      resetStorageClient();
      const client = getStorageClient();

      expect(client).not.toBeNull();
      expect(client?.name).toBe('local');
    });

    it('should return singleton instance on subsequent calls', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('STORAGE_PROVIDER', '');

      const { getStorageClient, resetStorageClient } = await import('@/lib/storage/client');

      resetStorageClient();
      const client1 = getStorageClient();
      const client2 = getStorageClient();

      expect(client1).toBe(client2);
    });

    it('should log error when S3 provider requested but not configured', async () => {
      vi.stubEnv('STORAGE_PROVIDER', 's3');
      vi.stubEnv('NODE_ENV', 'production');

      const { getStorageClient, resetStorageClient } = await import('@/lib/storage/client');
      const { logger } = await import('@/lib/logging');

      resetStorageClient();
      const client = getStorageClient();

      expect(client).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        'S3 provider requested but not configured',
        expect.objectContaining({
          missingVars: expect.arrayContaining(['S3_BUCKET']),
        })
      );
    });

    it('should log error when Vercel Blob provider requested but not configured', async () => {
      vi.stubEnv('STORAGE_PROVIDER', 'vercel-blob');
      vi.stubEnv('NODE_ENV', 'production');

      const { getStorageClient, resetStorageClient } = await import('@/lib/storage/client');
      const { logger } = await import('@/lib/logging');

      resetStorageClient();
      const client = getStorageClient();

      expect(client).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        'Vercel Blob provider requested but not configured',
        expect.objectContaining({
          missingVars: expect.arrayContaining(['BLOB_READ_WRITE_TOKEN']),
        })
      );
    });

    it('should warn about unknown provider and return null', async () => {
      vi.stubEnv('STORAGE_PROVIDER', 'unknown-provider');
      vi.stubEnv('NODE_ENV', 'production');

      const { getStorageClient, resetStorageClient } = await import('@/lib/storage/client');
      const { logger } = await import('@/lib/logging');

      resetStorageClient();
      const client = getStorageClient();

      expect(client).toBeNull();
      // Should warn specifically about the invalid provider value
      expect(logger.warn).toHaveBeenCalledWith(
        'Unknown STORAGE_PROVIDER value, ignoring',
        expect.objectContaining({
          provider: 'unknown-provider',
          validProviders: ['s3', 'vercel-blob', 'local'],
        })
      );
    });
  });

  describe('isStorageEnabled', () => {
    it('should return true when storage is configured', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('STORAGE_PROVIDER', '');

      const { isStorageEnabled, resetStorageClient } = await import('@/lib/storage/client');

      resetStorageClient();
      const result = isStorageEnabled();

      expect(result).toBe(true);
    });

    it('should return false when storage is not configured', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('STORAGE_PROVIDER', '');

      const { isStorageEnabled, resetStorageClient } = await import('@/lib/storage/client');

      resetStorageClient();
      const result = isStorageEnabled();

      expect(result).toBe(false);
    });
  });

  describe('getStorageProviderName', () => {
    it('should return provider name when configured', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('STORAGE_PROVIDER', '');

      const { getStorageProviderName, resetStorageClient } = await import('@/lib/storage/client');

      resetStorageClient();
      const name = getStorageProviderName();

      expect(name).toBe('local');
    });

    it('should return null when no provider configured', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('STORAGE_PROVIDER', '');

      const { getStorageProviderName, resetStorageClient } = await import('@/lib/storage/client');

      resetStorageClient();
      const name = getStorageProviderName();

      expect(name).toBeNull();
    });
  });

  describe('auto-detection', () => {
    it('should auto-detect S3 when createS3ProviderFromEnv returns a provider', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('STORAGE_PROVIDER', ''); // No explicit provider

      const { createS3ProviderFromEnv } = await import('@/lib/storage/providers/s3');
      const { logger } = await import('@/lib/logging');

      // Mock S3 provider to return a provider
      vi.mocked(createS3ProviderFromEnv).mockReturnValue({
        name: 's3',
        upload: vi.fn(),
        delete: vi.fn(),
        deletePrefix: vi.fn(),
      } as any);

      const { getStorageClient, resetStorageClient } = await import('@/lib/storage/client');

      resetStorageClient();
      const client = getStorageClient();

      expect(client).not.toBeNull();
      expect(client?.name).toBe('s3');
      expect(logger.debug).toHaveBeenCalledWith('Auto-detected S3 storage configuration');
      expect(logger.info).toHaveBeenCalledWith('Storage client initialized', { provider: 's3' });
    });

    it('should auto-detect Vercel Blob when S3 is not available but Vercel Blob is', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('STORAGE_PROVIDER', ''); // No explicit provider

      const { createS3ProviderFromEnv } = await import('@/lib/storage/providers/s3');
      const { createVercelBlobProviderFromEnv } =
        await import('@/lib/storage/providers/vercel-blob');
      const { logger } = await import('@/lib/logging');

      // S3 returns null
      vi.mocked(createS3ProviderFromEnv).mockReturnValue(null);
      // Vercel Blob returns a provider
      vi.mocked(createVercelBlobProviderFromEnv).mockReturnValue({
        name: 'vercel-blob',
        upload: vi.fn(),
        delete: vi.fn(),
        deletePrefix: vi.fn(),
      } as any);

      const { getStorageClient, resetStorageClient } = await import('@/lib/storage/client');

      resetStorageClient();
      const client = getStorageClient();

      expect(client).not.toBeNull();
      expect(client?.name).toBe('vercel-blob');
      expect(logger.debug).toHaveBeenCalledWith('Auto-detected Vercel Blob storage configuration');
      expect(logger.info).toHaveBeenCalledWith('Storage client initialized', {
        provider: 'vercel-blob',
      });
    });

    it('should prefer S3 over Vercel Blob when both are available', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('STORAGE_PROVIDER', ''); // No explicit provider

      const { createS3ProviderFromEnv } = await import('@/lib/storage/providers/s3');
      const { createVercelBlobProviderFromEnv } =
        await import('@/lib/storage/providers/vercel-blob');

      // Both return providers
      vi.mocked(createS3ProviderFromEnv).mockReturnValue({
        name: 's3',
        upload: vi.fn(),
        delete: vi.fn(),
        deletePrefix: vi.fn(),
      } as any);
      vi.mocked(createVercelBlobProviderFromEnv).mockReturnValue({
        name: 'vercel-blob',
        upload: vi.fn(),
        delete: vi.fn(),
        deletePrefix: vi.fn(),
      } as any);

      const { getStorageClient, resetStorageClient } = await import('@/lib/storage/client');

      resetStorageClient();
      const client = getStorageClient();

      expect(client).not.toBeNull();
      expect(client?.name).toBe('s3'); // S3 is preferred
    });
  });
});
