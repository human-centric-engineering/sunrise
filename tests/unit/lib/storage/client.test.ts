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

// Mock Local provider. The client builds it through the env-reading factory
// so that STORAGE_LOCAL_* (notably the private root) is honoured — a plain
// `createLocalProvider()` would ignore all of it.
vi.mock('@/lib/storage/providers/local', () => ({
  createLocalProviderFromEnv: vi.fn(() => ({
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

    describe('unbound client guard', () => {
      /** A provider whose upload/delete are observable. */
      function makeProvider(name: string) {
        return {
          name,
          upload: vi.fn().mockResolvedValue({ key: 'k', url: 'u', size: 1 }),
          delete: vi.fn().mockResolvedValue({ success: true, key: 'k' }),
          deletePrefix: vi.fn().mockResolvedValue({ success: true, key: 'p' }),
        };
      }

      it('refuses an upload to an orgs/ key and does not reach the provider', async () => {
        vi.stubEnv('STORAGE_PROVIDER', 'local');
        const provider = makeProvider('local');
        const { createLocalProviderFromEnv } = await import('@/lib/storage/providers/local');
        vi.mocked(createLocalProviderFromEnv).mockReturnValueOnce(provider as never);
        const { getStorageClient, resetStorageClient } = await import('@/lib/storage/client');
        resetStorageClient();

        const client = getStorageClient();

        await expect(
          client!.upload(Buffer.from('x'), {
            key: 'orgs/org1/f.pdf',
            contentType: 'application/pdf',
          })
        ).rejects.toThrow(/reserved orgs\/ root/);
        expect(provider.upload).not.toHaveBeenCalled();
      });

      it('still uploads a key outside the orgs/ root', async () => {
        vi.stubEnv('STORAGE_PROVIDER', 'local');
        const provider = makeProvider('local');
        const { createLocalProviderFromEnv } = await import('@/lib/storage/providers/local');
        vi.mocked(createLocalProviderFromEnv).mockReturnValueOnce(provider as never);
        const { getStorageClient, resetStorageClient } = await import('@/lib/storage/client');
        resetStorageClient();

        const buf = Buffer.from('x');
        const opts = { key: 'avatars/u1/me.jpg', contentType: 'image/jpeg' };
        await getStorageClient()!.upload(buf, opts);

        expect(provider.upload).toHaveBeenCalledWith(buf, opts);
      });

      it('returns the same unbound instance on every call', async () => {
        vi.stubEnv('STORAGE_PROVIDER', 'local');
        const { getStorageClient, resetStorageClient } = await import('@/lib/storage/client');
        resetStorageClient();

        expect(getStorageClient()).toBe(getStorageClient());
      });

      it('does not hand back the raw provider instance', async () => {
        vi.stubEnv('STORAGE_PROVIDER', 'local');
        const provider = makeProvider('local');
        const { createLocalProviderFromEnv } = await import('@/lib/storage/providers/local');
        vi.mocked(createLocalProviderFromEnv).mockReturnValueOnce(provider as never);
        const { getStorageClient, resetStorageClient } = await import('@/lib/storage/client');
        resetStorageClient();

        expect(getStorageClient()).not.toBe(provider);
      });

      it('resetStorageClient drops the cached wrapper so a new provider is picked up', async () => {
        vi.stubEnv('STORAGE_PROVIDER', 'local');
        const { createLocalProviderFromEnv } = await import('@/lib/storage/providers/local');
        const { createS3ProviderFromEnv } = await import('@/lib/storage/providers/s3');
        vi.mocked(createLocalProviderFromEnv).mockReturnValueOnce(makeProvider('local') as never);
        vi.mocked(createS3ProviderFromEnv).mockReturnValueOnce(makeProvider('s3') as never);
        const { getStorageClient, resetStorageClient } = await import('@/lib/storage/client');
        resetStorageClient();
        const before = getStorageClient();
        expect(before?.name).toBe('local');

        vi.stubEnv('STORAGE_PROVIDER', 's3');
        resetStorageClient();
        const after = getStorageClient();

        expect(after?.name).toBe('s3');
        expect(after).not.toBe(before);
      });
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

      expect(result).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
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

  describe('getStorageClient({ orgId })', () => {
    it('refuses an out-of-org upload when bound, but not when unbound (same singleton)', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('STORAGE_PROVIDER', '');

      const { createLocalProviderFromEnv } = await import('@/lib/storage/providers/local');
      const innerUpload = vi.fn().mockResolvedValue({ key: 'avatars/u/x', url: 'u', size: 1 });
      vi.mocked(createLocalProviderFromEnv).mockReturnValueOnce({
        name: 'local',
        upload: innerUpload,
        delete: vi.fn(),
        deletePrefix: vi.fn(),
      } as never);

      const { getStorageClient, resetStorageClient } = await import('@/lib/storage/client');
      resetStorageClient();
      const opts = { key: 'avatars/u/x', contentType: 'image/png' };

      const bound = getStorageClient({ orgId: 'org1' });
      await expect(bound?.upload(Buffer.from('x'), opts)).rejects.toThrow(
        /outside this org's prefix/
      );
      expect(innerUpload).not.toHaveBeenCalled();

      await getStorageClient()?.upload(Buffer.from('x'), opts);
      expect(innerUpload).toHaveBeenCalledTimes(1);
      expect(createLocalProviderFromEnv).toHaveBeenCalledTimes(1);
    });

    it('lets a bound client write inside its own org prefix', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('STORAGE_PROVIDER', '');

      const { createLocalProviderFromEnv } = await import('@/lib/storage/providers/local');
      const innerUpload = vi.fn().mockResolvedValue({ key: 'k', url: 'u', size: 1 });
      vi.mocked(createLocalProviderFromEnv).mockReturnValueOnce({
        name: 'local',
        upload: innerUpload,
        delete: vi.fn(),
        deletePrefix: vi.fn(),
      } as never);

      const { getStorageClient, resetStorageClient } = await import('@/lib/storage/client');
      resetStorageClient();
      const opts = { key: 'orgs/org1/a.pdf', contentType: 'application/pdf' };

      await getStorageClient({ orgId: 'org1' })?.upload(Buffer.from('x'), opts);

      expect(innerUpload).toHaveBeenCalledWith(expect.any(Buffer), opts);
    });

    it('returns null for a bound request when storage is not configured', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('STORAGE_PROVIDER', '');

      const { getStorageClient, resetStorageClient } = await import('@/lib/storage/client');
      resetStorageClient();

      expect(getStorageClient({ orgId: 'org1' })).toBeNull();
    });

    it('rejects an unusable org id instead of returning an unscoped client', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('STORAGE_PROVIDER', '');

      const { getStorageClient, resetStorageClient } = await import('@/lib/storage/client');
      resetStorageClient();

      expect(() => getStorageClient({ orgId: '' })).toThrow();
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
