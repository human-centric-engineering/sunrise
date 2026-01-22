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

    it('should log error for unknown provider', async () => {
      vi.stubEnv('STORAGE_PROVIDER', 'unknown-provider');
      vi.stubEnv('NODE_ENV', 'production');

      const { getStorageClient, resetStorageClient } = await import('@/lib/storage/client');
      const { logger } = await import('@/lib/logging');

      resetStorageClient();
      const client = getStorageClient();

      expect(client).toBeNull();
      expect(logger.error).toHaveBeenCalledWith('Unknown storage provider', {
        provider: 'unknown-provider',
      });
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
});
