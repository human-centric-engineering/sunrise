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

        vi.mocked(list)
          .mockResolvedValueOnce({
            blobs: [
              { url: 'https://blob.vercel-storage.com/avatars/user-123/avatar.jpg' },
              { url: 'https://blob.vercel-storage.com/avatars/user-123/thumb.jpg' },
            ],
          } as never)
          .mockResolvedValueOnce({ blobs: [] } as never);
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

      it('re-lists until a listing is empty and never passes a cursor', async () => {
        const { list, del } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');
        const { logger } = await import('@/lib/logging');

        // hasMore/cursor are present on purpose: the provider must ignore them.
        vi.mocked(list)
          .mockResolvedValueOnce({
            blobs: [{ url: 'https://blob.example/orgs/a/1.pdf' }],
            hasMore: true,
            cursor: 'cursor-2',
          } as never)
          .mockResolvedValueOnce({
            blobs: [{ url: 'https://blob.example/orgs/a/2.pdf' }],
            hasMore: true,
            cursor: 'cursor-3',
          } as never)
          .mockResolvedValueOnce({ blobs: [] } as never);
        vi.mocked(del).mockResolvedValue(undefined);

        const provider = new VercelBlobProvider({ token: 'test-token' });

        const result = await provider.deletePrefix('orgs/a/');

        expect(list).toHaveBeenCalledTimes(3);
        for (const [args] of vi.mocked(list).mock.calls) {
          expect(args).toEqual({ prefix: 'orgs/a/', token: 'test-token' });
          expect(args).not.toHaveProperty('cursor');
        }
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

      it('deletes a stuck blob once, then gives up after 10 stale listings in a row', async () => {
        vi.useFakeTimers();
        try {
          const { list, del } = await import('@vercel/blob');
          const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');
          const { logger } = await import('@/lib/logging');

          // A `del` that "succeeds" without removing anything (eventual consistency).
          vi.mocked(list).mockResolvedValue({
            blobs: [{ url: 'https://blob.example/orgs/a/stuck.pdf' }],
          } as never);
          vi.mocked(del).mockResolvedValue(undefined);

          const provider = new VercelBlobProvider({ token: 'test-token' });

          const pending = provider.deletePrefix('orgs/a/');
          await vi.advanceTimersByTimeAsync(10 * 200);
          const result = await pending;

          expect(result).toEqual({ success: false, key: 'orgs/a/' });
          expect(del).toHaveBeenCalledTimes(1);
          expect(del).toHaveBeenCalledWith(['https://blob.example/orgs/a/stuck.pdf'], {
            token: 'test-token',
          });
          // 1 listing that deleted + 10 stale ones
          expect(list).toHaveBeenCalledTimes(11);
          expect(logger.error).toHaveBeenCalledWith(
            'Vercel Blob prefix delete gave up with blobs still listed',
            undefined,
            expect.objectContaining({ prefix: 'orgs/a/', deleted: 1 })
          );
        } finally {
          vi.useRealTimers();
        }
      });

      it('does not re-delete or recount blobs a lagging listing returns again', async () => {
        vi.useFakeTimers();
        try {
          const { list, del } = await import('@vercel/blob');
          const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');
          const { logger } = await import('@/lib/logging');

          const a = 'https://blob.example/orgs/a/A.pdf';
          const b = 'https://blob.example/orgs/a/B.pdf';
          vi.mocked(list)
            .mockResolvedValueOnce({ blobs: [{ url: a }, { url: b }] } as never)
            .mockResolvedValueOnce({ blobs: [{ url: b }] } as never)
            .mockResolvedValueOnce({ blobs: [] } as never);
          vi.mocked(del).mockResolvedValue(undefined);

          const provider = new VercelBlobProvider({ token: 'test-token' });

          const pending = provider.deletePrefix('orgs/a/');
          await vi.advanceTimersByTimeAsync(200);
          const result = await pending;

          expect(result).toEqual({ success: true, key: 'orgs/a/' });
          expect(del).toHaveBeenCalledTimes(1);
          expect(del).toHaveBeenCalledWith([a, b], { token: 'test-token' });
          expect(logger.info).toHaveBeenCalledWith(
            'Blobs deleted from Vercel Blob by prefix',
            expect.objectContaining({ prefix: 'orgs/a/', count: 2 })
          );
        } finally {
          vi.useRealTimers();
        }
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
