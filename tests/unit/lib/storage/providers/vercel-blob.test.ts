import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@vercel/blob', () => ({
  put: vi.fn(),
  del: vi.fn(),
  list: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('lib/storage/providers/vercel-blob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('VercelBlobProvider', () => {
    describe('upload', () => {
      it('should upload file with correct params', async () => {
        const { put } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        vi.mocked(put).mockResolvedValue({
          url: 'https://blob.vercel-storage.com/avatars/user-123/avatar.jpg',
          pathname: 'avatars/user-123/avatar.jpg',
          downloadUrl: 'https://blob.vercel-storage.com/avatars/user-123/avatar.jpg',
          contentType: 'image/jpeg',
          contentDisposition: 'inline',
        } as never);

        const provider = new VercelBlobProvider({ token: 'test-token' });
        const file = Buffer.from('test content');

        const result = await provider.upload(file, {
          key: 'avatars/user-123/avatar.jpg',
          contentType: 'image/jpeg',
        });

        expect(put).toHaveBeenCalledWith('avatars/user-123/avatar.jpg', file, {
          access: 'public',
          contentType: 'image/jpeg',
          token: 'test-token',
          addRandomSuffix: false,
        });
        expect(result.url).toBe('https://blob.vercel-storage.com/avatars/user-123/avatar.jpg');
        expect(result.size).toBe(file.length);
      });
    });

    describe('delete', () => {
      it('should delete file by key', async () => {
        const { del } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        vi.mocked(del).mockResolvedValue(undefined);

        const provider = new VercelBlobProvider({ token: 'test-token' });

        const result = await provider.delete(
          'https://blob.vercel-storage.com/avatars/user-123/avatar.jpg'
        );

        expect(del).toHaveBeenCalledWith(
          'https://blob.vercel-storage.com/avatars/user-123/avatar.jpg',
          { token: 'test-token' }
        );
        expect(result.success).toBe(true);
      });

      it('should handle errors gracefully', async () => {
        const { del } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');
        const { logger } = await import('@/lib/logging');

        vi.mocked(del).mockRejectedValue(new Error('Not found'));

        const provider = new VercelBlobProvider({ token: 'test-token' });

        const result = await provider.delete('invalid-key');

        expect(result.success).toBe(false);
        expect(logger.error).toHaveBeenCalledWith(
          'Failed to delete file from Vercel Blob',
          expect.any(Error),
          { key: 'invalid-key' }
        );
      });
    });

    describe('deletePrefix', () => {
      it('should list and delete all blobs with prefix', async () => {
        const { list, del } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        vi.mocked(list).mockResolvedValue({
          blobs: [
            { url: 'https://blob.vercel-storage.com/avatars/user-123/avatar.jpg' },
            { url: 'https://blob.vercel-storage.com/avatars/user-123/thumb.jpg' },
          ],
        } as never);
        vi.mocked(del).mockResolvedValue(undefined);

        const provider = new VercelBlobProvider({ token: 'test-token' });

        const result = await provider.deletePrefix('avatars/user-123/');

        expect(list).toHaveBeenCalledWith({ prefix: 'avatars/user-123/', token: 'test-token' });
        expect(del).toHaveBeenCalledWith(
          [
            'https://blob.vercel-storage.com/avatars/user-123/avatar.jpg',
            'https://blob.vercel-storage.com/avatars/user-123/thumb.jpg',
          ],
          { token: 'test-token' }
        );
        expect(result.success).toBe(true);
      });

      it('should handle empty prefix results', async () => {
        const { list, del } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');
        const { logger } = await import('@/lib/logging');

        vi.mocked(list).mockResolvedValue({ blobs: [] } as never);

        const provider = new VercelBlobProvider({ token: 'test-token' });

        const result = await provider.deletePrefix('avatars/user-999/');

        expect(del).not.toHaveBeenCalled();
        expect(result.success).toBe(true);
        expect(logger.debug).toHaveBeenCalledWith('No blobs found for prefix', {
          prefix: 'avatars/user-999/',
        });
      });

      it('should handle errors gracefully', async () => {
        const { list } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');
        const { logger } = await import('@/lib/logging');

        vi.mocked(list).mockRejectedValue(new Error('Network error'));

        const provider = new VercelBlobProvider({ token: 'test-token' });

        const result = await provider.deletePrefix('avatars/user-123/');

        expect(result.success).toBe(false);
        expect(logger.error).toHaveBeenCalledWith(
          'Failed to delete blobs from Vercel Blob by prefix',
          expect.any(Error),
          { prefix: 'avatars/user-123/' }
        );
      });
    });

    describe('key validation', () => {
      it('should throw for invalid key with path traversal in upload', async () => {
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        const provider = new VercelBlobProvider({ token: 'test-token' });

        await expect(
          provider.upload(Buffer.from('test'), {
            key: '../etc/passwd',
            contentType: 'text/plain',
          })
        ).rejects.toThrow('must not contain ".."');
      });

      it('should throw for invalid key with path traversal in delete', async () => {
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        const provider = new VercelBlobProvider({ token: 'test-token' });

        await expect(provider.delete('../etc/passwd')).rejects.toThrow('must not contain ".."');
      });

      it('should throw for invalid key with path traversal in deletePrefix', async () => {
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        const provider = new VercelBlobProvider({ token: 'test-token' });

        await expect(provider.deletePrefix('../etc/')).rejects.toThrow('must not contain ".."');
      });
    });
  });

  describe('createVercelBlobProviderFromEnv', () => {
    it('should create provider when BLOB_READ_WRITE_TOKEN is set', async () => {
      vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'test-token');

      const { createVercelBlobProviderFromEnv } =
        await import('@/lib/storage/providers/vercel-blob');

      const provider = createVercelBlobProviderFromEnv();

      expect(provider).not.toBeNull();
      expect(provider?.name).toBe('vercel-blob');
    });

    it('should return null when BLOB_READ_WRITE_TOKEN is missing', async () => {
      const { createVercelBlobProviderFromEnv } =
        await import('@/lib/storage/providers/vercel-blob');

      const provider = createVercelBlobProviderFromEnv();

      expect(provider).toBeNull();
    });
  });
});
