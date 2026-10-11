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

    describe('object visibility', () => {
      it('throws on public: false instead of storing the object publicly', async () => {
        const { put } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        const provider = new VercelBlobProvider({ token: 'test-token' });

        await expect(
          provider.upload(Buffer.from('secret'), {
            key: 'documents/user-123/contract.pdf',
            contentType: 'application/pdf',
            public: false,
          })
        ).rejects.toThrow(/cannot store private objects/i);

        // No blob written — a thrown error the caller can catch is the point;
        // uploading anyway would publish the file to a public CDN URL.
        expect(put).not.toHaveBeenCalled();
      });

      it('declares that it supports neither private objects, signed URLs, nor download', async () => {
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');
        const { getStorageCapabilities } = await import('@/lib/storage/providers/types');

        const provider = new VercelBlobProvider({ token: 'test-token' });

        expect(getStorageCapabilities(provider)).toEqual({
          privateObjects: false,
          signedUrls: false,
          download: false,
        });
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
        expect(result.success).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
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
        expect(result.success).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
      });

      it('follows the cursor and deletes the blobs from every page', async () => {
        const { list, del } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');
        const { logger } = await import('@/lib/logging');

        vi.mocked(list)
          .mockResolvedValueOnce({
            blobs: [{ url: 'https://blob.example/orgs/a/1.pdf' }],
            hasMore: true,
            cursor: 'cursor-2',
          } as never)
          .mockResolvedValueOnce({
            blobs: [{ url: 'https://blob.example/orgs/a/2.pdf' }],
            hasMore: false,
          } as never);
        vi.mocked(del).mockResolvedValue(undefined);

        const provider = new VercelBlobProvider({ token: 'test-token' });

        const result = await provider.deletePrefix('orgs/a/');

        expect(list).toHaveBeenCalledTimes(2);
        expect(list).toHaveBeenNthCalledWith(1, { prefix: 'orgs/a/', token: 'test-token' });
        expect(list).toHaveBeenNthCalledWith(2, {
          prefix: 'orgs/a/',
          token: 'test-token',
          cursor: 'cursor-2',
        });
        expect(del).toHaveBeenCalledTimes(2);
        expect(del).toHaveBeenNthCalledWith(1, ['https://blob.example/orgs/a/1.pdf'], {
          token: 'test-token',
        });
        expect(del).toHaveBeenNthCalledWith(2, ['https://blob.example/orgs/a/2.pdf'], {
          token: 'test-token',
        });
        expect(result).toEqual({ success: true, key: 'orgs/a/' });
        expect(logger.info).toHaveBeenCalledWith(
          'Blobs deleted from Vercel Blob by prefix',
          expect.objectContaining({ prefix: 'orgs/a/', count: 2 })
        );
      });

      it('should handle empty prefix results', async () => {
        const { list, del } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');
        const { logger } = await import('@/lib/logging');

        vi.mocked(list).mockResolvedValue({ blobs: [] } as never);

        const provider = new VercelBlobProvider({ token: 'test-token' });

        const result = await provider.deletePrefix('avatars/user-999/');

        expect(del).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
        expect(result.success).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
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
