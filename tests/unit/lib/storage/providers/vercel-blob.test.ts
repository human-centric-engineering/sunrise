import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@vercel/blob', () => {
  // The provider tells "not in this store" apart from a real failure with
  // `instanceof`, so the mock needs a real class, not a plain function.
  class BlobNotFoundError extends Error {
    constructor() {
      super('Vercel Blob: The requested blob does not exist');
    }
  }
  return {
    put: vi.fn(),
    del: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    BlobNotFoundError,
  };
});

vi.mock('@/lib/logging', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// `getSignedUrl()` mints an HMAC token from BETTER_AUTH_SECRET, which the
// unit environment does not set.
vi.mock('@/lib/env', () => ({
  env: {
    BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters-long',
    BETTER_AUTH_URL: 'https://app.example.com',
  },
}));

const PUBLIC = 'public-token';
const PRIVATE = 'private-token';

/** A `get()` 200 result carrying `text`, as the SDK returns it. */
function blobResult(text: string, contentType = 'application/pdf') {
  const body = new Response(text).body;
  return {
    statusCode: 200 as const,
    stream: body,
    headers: new Headers(),
    blob: {
      url: 'https://store.private.blob.vercel-storage.com/k',
      downloadUrl: 'https://store.private.blob.vercel-storage.com/k?download=1',
      pathname: 'k',
      contentDisposition: 'inline',
      cacheControl: 'public, max-age=60',
      uploadedAt: new Date('2026-11-04T00:00:00Z'),
      etag: '"abc"',
      contentType,
      size: text.length,
    },
  };
}

describe('lib/storage/providers/vercel-blob', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.unstubAllEnvs();
    // `clearAllMocks` keeps implementations, so a rejection set by one test
    // would leak into the next. `upload()` now deletes any stale copy in the
    // other store, which makes that leakage visible beyond the delete tests.
    const { del, get } = await import('@vercel/blob');
    vi.mocked(del).mockResolvedValue(undefined);
    vi.mocked(get).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('VercelBlobProvider', () => {
    describe('construction', () => {
      it('refuses a config with neither token', async () => {
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        expect(() => new VercelBlobProvider({})).toThrow(/needs a public or a private store/);
      });
    });

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
      it('refuses public: false with no private store, instead of storing the object publicly', async () => {
        const { put } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        const provider = new VercelBlobProvider({ token: PUBLIC });

        await expect(
          provider.upload(Buffer.from('secret'), {
            key: 'documents/user-123/contract.pdf',
            contentType: 'application/pdf',
            public: false,
          })
        ).rejects.toThrow(/no private store configured/i);

        // No blob written — a thrown error the caller can catch is the point;
        // uploading anyway would publish the file to a public CDN URL.
        expect(put).not.toHaveBeenCalled();
      });

      it('refuses a public upload with no public store, instead of hiding it in the private one', async () => {
        const { put } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        const provider = new VercelBlobProvider({ privateToken: PRIVATE });

        await expect(
          provider.upload(Buffer.from('face'), {
            key: 'avatars/user-1/avatar.jpg',
            contentType: 'image/jpeg',
          })
        ).rejects.toThrow(/no public store configured/i);
        expect(put).not.toHaveBeenCalled();
      });

      it('stores public: false in the private store and returns the signed read route address', async () => {
        const { put } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        vi.mocked(put).mockResolvedValue({
          url: 'https://store.private.blob.vercel-storage.com/documents/user-1/my%20contract.pdf',
        } as never);

        const provider = new VercelBlobProvider({ token: PUBLIC, privateToken: PRIVATE });
        const file = Buffer.from('secret');

        const result = await provider.upload(file, {
          key: 'documents/user-1/my contract.pdf',
          contentType: 'application/pdf',
          public: false,
        });

        expect(put).toHaveBeenCalledWith('documents/user-1/my contract.pdf', file, {
          access: 'private',
          contentType: 'application/pdf',
          token: PRIVATE,
          addRandomSuffix: false,
        });
        // Not the blob's own URL, which needs the store token to open.
        expect(result.url).toBe('/api/v1/storage/documents/user-1/my%20contract.pdf');
      });

      it('stores a public upload in the public store when both exist', async () => {
        const { put } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        vi.mocked(put).mockResolvedValue({
          url: 'https://store.public.blob.vercel-storage.com/avatars/user-1/a.jpg',
        } as never);

        const provider = new VercelBlobProvider({ token: PUBLIC, privateToken: PRIVATE });

        const result = await provider.upload(Buffer.from('face'), {
          key: 'avatars/user-1/a.jpg',
          contentType: 'image/jpeg',
        });

        expect(vi.mocked(put).mock.calls[0][2]).toMatchObject({ access: 'public', token: PUBLIC });
        expect(result.url).toBe(
          'https://store.public.blob.vercel-storage.com/avatars/user-1/a.jpg'
        );
      });

      it('removes the copy in the other store after writing, so a flipped key is not left public', async () => {
        const { put, del } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        vi.mocked(put).mockResolvedValue({ url: 'https://x/k' } as never);

        const provider = new VercelBlobProvider({ token: PUBLIC, privateToken: PRIVATE });
        await provider.upload(Buffer.from('secret'), {
          key: 'documents/user-1/c.pdf',
          contentType: 'application/pdf',
          public: false,
        });

        expect(del).toHaveBeenCalledTimes(1);
        expect(del).toHaveBeenCalledWith('documents/user-1/c.pdf', { token: PUBLIC });
        // The write comes first: a failed upload must never destroy the old object.
        expect(vi.mocked(put).mock.invocationCallOrder[0]).toBeLessThan(
          vi.mocked(del).mock.invocationCallOrder[0]
        );
      });

      it('treats a stale copy the other store does not hold as nothing to remove', async () => {
        const { put, del, BlobNotFoundError } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        vi.mocked(put).mockResolvedValue({ url: 'https://x/k' } as never);
        vi.mocked(del).mockRejectedValue(new BlobNotFoundError());

        const provider = new VercelBlobProvider({ token: PUBLIC, privateToken: PRIVATE });
        const result = await provider.upload(Buffer.from('secret'), {
          key: 'documents/user-1/c.pdf',
          contentType: 'application/pdf',
          public: false,
        });

        expect(result.url).toBe('/api/v1/storage/documents/user-1/c.pdf');
      });

      it('fails the upload when the other store still holds a copy it could not remove', async () => {
        const { put, del } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        vi.mocked(put).mockResolvedValue({ url: 'https://x/k' } as never);
        vi.mocked(del).mockRejectedValue(new Error('503 Service Unavailable'));

        const provider = new VercelBlobProvider({ token: PUBLIC, privateToken: PRIVATE });

        await expect(
          provider.upload(Buffer.from('secret'), {
            key: 'documents/user-1/c.pdf',
            contentType: 'application/pdf',
            public: false,
          })
        ).rejects.toThrow(/could not remove the existing copy in the public store/);
      });

      it('makes no stale-copy call when there is only one store', async () => {
        const { put, del } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        vi.mocked(put).mockResolvedValue({ url: 'https://x/k' } as never);

        const provider = new VercelBlobProvider({ token: PUBLIC });
        await provider.upload(Buffer.from('face'), { key: 'a/b.jpg', contentType: 'image/jpeg' });

        expect(del).not.toHaveBeenCalled(); // test-review:accept no_arg_called — a public-only install has no other store to sweep;
      });
    });

    describe('capabilities', () => {
      it('with only a public store: download, but no private objects or signed URLs', async () => {
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');
        const { getStorageCapabilities } = await import('@/lib/storage/providers/types');

        const provider = new VercelBlobProvider({ token: PUBLIC });

        expect(getStorageCapabilities(provider)).toEqual({
          privateObjects: false,
          signedUrls: false,
          download: true,
        });
      });

      it('with a private store: private objects, signed URLs and download', async () => {
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');
        const { getStorageCapabilities } = await import('@/lib/storage/providers/types');

        const provider = new VercelBlobProvider({ token: PUBLIC, privateToken: PRIVATE });

        expect(getStorageCapabilities(provider)).toEqual({
          privateObjects: true,
          signedUrls: true,
          download: true,
        });
      });
    });

    describe('delete', () => {
      it('should delete file by key', async () => {
        const { del } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

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

        vi.mocked(del).mockRejectedValue(new Error('Network error'));

        const provider = new VercelBlobProvider({ token: 'test-token' });

        const result = await provider.delete('invalid-key');

        expect(result.success).toBe(false);
        expect(logger.error).toHaveBeenCalledWith(
          'Failed to delete file from Vercel Blob',
          expect.any(Error),
          { key: 'invalid-key', store: 'public' }
        );
      });

      it('sweeps both stores, private first', async () => {
        const { del } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        const provider = new VercelBlobProvider({ token: PUBLIC, privateToken: PRIVATE });

        const result = await provider.delete('documents/user-1/c.pdf');

        expect(del).toHaveBeenCalledTimes(2);
        expect(del).toHaveBeenNthCalledWith(1, 'documents/user-1/c.pdf', { token: PRIVATE });
        expect(del).toHaveBeenNthCalledWith(2, 'documents/user-1/c.pdf', { token: PUBLIC });
        expect(result).toEqual({ success: true, key: 'documents/user-1/c.pdf' });
      });

      it('succeeds when one store reports the key not found', async () => {
        const { del, BlobNotFoundError } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');
        const { logger } = await import('@/lib/logging');

        vi.mocked(del).mockRejectedValueOnce(new BlobNotFoundError()).mockResolvedValueOnce();

        const provider = new VercelBlobProvider({ token: PUBLIC, privateToken: PRIVATE });

        const result = await provider.delete('avatars/user-1/a.jpg');

        expect(result).toEqual({ success: true, key: 'avatars/user-1/a.jpg' });
        expect(logger.error).not.toHaveBeenCalled(); // test-review:accept no_arg_called — not-found must not be logged as a failure;
      });

      it('succeeds when neither store holds the key', async () => {
        const { del, BlobNotFoundError } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        vi.mocked(del).mockRejectedValue(new BlobNotFoundError());

        const provider = new VercelBlobProvider({ token: PUBLIC, privateToken: PRIVATE });

        const result = await provider.delete('avatars/user-1/gone.jpg');

        expect(del).toHaveBeenCalledTimes(2);
        expect(result.success).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
      });

      it('sends a public blob URL to the public store only', async () => {
        const { del } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        // What deleteFile() passes for a stored avatar URL.
        const url = 'https://abc123.public.blob.vercel-storage.com/avatars/user-1/a.jpg';
        const provider = new VercelBlobProvider({ token: PUBLIC, privateToken: PRIVATE });

        const result = await provider.delete(url);

        expect(del).toHaveBeenCalledTimes(1);
        expect(del).toHaveBeenCalledWith(url, { token: PUBLIC });
        expect(result).toEqual({ success: true, key: url });
      });

      it('sends a private blob URL to the private store only', async () => {
        const { del } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        const url = 'https://abc123.private.blob.vercel-storage.com/documents/user-1/c.pdf';
        const provider = new VercelBlobProvider({ token: PUBLIC, privateToken: PRIVATE });

        await provider.delete(url);

        expect(del).toHaveBeenCalledTimes(1);
        expect(del).toHaveBeenCalledWith(url, { token: PRIVATE });
      });

      it('fails a blob URL whose store has no token, without trying the other store', async () => {
        const { del } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');
        const { logger } = await import('@/lib/logging');

        const url = 'https://abc123.public.blob.vercel-storage.com/avatars/user-1/a.jpg';
        const provider = new VercelBlobProvider({ privateToken: PRIVATE });

        const result = await provider.delete(url);

        expect(result).toEqual({ success: false, key: url });
        expect(del).not.toHaveBeenCalled(); // test-review:accept no_arg_called — the wrong store's token must not be used;
        expect(logger.error).toHaveBeenCalledWith(
          'Cannot delete a Vercel Blob URL from a store with no token',
          undefined,
          { key: url, store: 'public' }
        );
      });

      it('sweeps both stores for a URL that names no Vercel Blob store', async () => {
        const { del } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        const url = 'https://cdn.example.com/avatars/user-1/a.jpg';
        const provider = new VercelBlobProvider({ token: PUBLIC, privateToken: PRIVATE });

        await provider.delete(url);

        expect(del).toHaveBeenCalledTimes(2);
      });

      it('fails when either store fails, and still tries the other', async () => {
        const { del } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');
        const { logger } = await import('@/lib/logging');

        // Private store errors; public store succeeds.
        vi.mocked(del).mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce();

        const provider = new VercelBlobProvider({ token: PUBLIC, privateToken: PRIVATE });

        const result = await provider.delete('documents/user-1/c.pdf');

        expect(del).toHaveBeenCalledTimes(2);
        expect(result).toEqual({ success: false, key: 'documents/user-1/c.pdf' });
        expect(logger.error).toHaveBeenCalledWith(
          'Failed to delete file from Vercel Blob',
          expect.any(Error),
          { key: 'documents/user-1/c.pdf', store: 'private' }
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
          store: 'public',
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
          { prefix: 'avatars/user-123/', store: 'public' }
        );
      });

      it('sweeps both stores, each with its own token', async () => {
        const { list, del } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        // Private store: one page then empty. Public store: one page then empty.
        vi.mocked(list)
          .mockResolvedValueOnce({ blobs: [{ url: 'https://p/orgs/a/secret.pdf' }] } as never)
          .mockResolvedValueOnce({ blobs: [] } as never)
          .mockResolvedValueOnce({ blobs: [{ url: 'https://q/orgs/a/logo.png' }] } as never)
          .mockResolvedValueOnce({ blobs: [] } as never);

        const provider = new VercelBlobProvider({ token: PUBLIC, privateToken: PRIVATE });

        const result = await provider.deletePrefix('orgs/a/');

        expect(result).toEqual({ success: true, key: 'orgs/a/' });
        expect(vi.mocked(list).mock.calls.map(([args]) => args)).toEqual([
          { prefix: 'orgs/a/', token: PRIVATE },
          { prefix: 'orgs/a/', token: PRIVATE },
          { prefix: 'orgs/a/', token: PUBLIC },
          { prefix: 'orgs/a/', token: PUBLIC },
        ]);
        expect(del).toHaveBeenNthCalledWith(1, ['https://p/orgs/a/secret.pdf'], {
          token: PRIVATE,
        });
        expect(del).toHaveBeenNthCalledWith(2, ['https://q/orgs/a/logo.png'], { token: PUBLIC });
      });

      it('fails when the private store fails, even though the public store came back clean', async () => {
        const { list } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        vi.mocked(list)
          .mockRejectedValueOnce(new Error('private store unreachable'))
          .mockResolvedValueOnce({ blobs: [] } as never);

        const provider = new VercelBlobProvider({ token: PUBLIC, privateToken: PRIVATE });

        const result = await provider.deletePrefix('orgs/a/');

        // Erasure reads this as `storageSwept`: a clean public store must not
        // hide private blobs left behind.
        expect(result).toEqual({ success: false, key: 'orgs/a/' });
        expect(list).toHaveBeenCalledTimes(2);
        expect(vi.mocked(list).mock.calls[1][0]).toEqual({ prefix: 'orgs/a/', token: PUBLIC });
      });
    });

    describe('download', () => {
      it('reads an object back with its bytes, size and content type', async () => {
        const { get } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        vi.mocked(get).mockResolvedValue(blobResult('hello world', 'text/plain') as never);

        const provider = new VercelBlobProvider({ token: PUBLIC });

        const object = await provider.download('notes/user-1/a.txt');

        expect(object.key).toBe('notes/user-1/a.txt');
        expect(object.body.toString('utf8')).toBe('hello world');
        expect(object.size).toBe(11);
        expect(object.contentType).toBe('text/plain');
        expect(get).toHaveBeenCalledWith('notes/user-1/a.txt', {
          access: 'public',
          token: PUBLIC,
          abortSignal: expect.any(AbortSignal),
        });
      });

      it('reads the private store first, and does not read the public store when found', async () => {
        const { get } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        vi.mocked(get).mockResolvedValueOnce(blobResult('private bytes') as never);

        const provider = new VercelBlobProvider({ token: PUBLIC, privateToken: PRIVATE });

        const object = await provider.download('documents/user-1/c.pdf');

        expect(object.body.toString('utf8')).toBe('private bytes');
        expect(get).toHaveBeenCalledTimes(1);
        expect(vi.mocked(get).mock.calls[0][1]).toMatchObject({
          access: 'private',
          token: PRIVATE,
        });
      });

      it('falls back to the public store when the private store does not hold the key', async () => {
        const { get } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        vi.mocked(get)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(blobResult('public bytes') as never);

        const provider = new VercelBlobProvider({ token: PUBLIC, privateToken: PRIVATE });

        const object = await provider.download('avatars/user-1/a.jpg');

        expect(object.body.toString('utf8')).toBe('public bytes');
        expect(vi.mocked(get).mock.calls.map(([, opts]) => opts.access)).toEqual([
          'private',
          'public',
        ]);
      });

      it('throws when neither store holds the key', async () => {
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        const provider = new VercelBlobProvider({ token: PUBLIC, privateToken: PRIVATE });

        await expect(provider.download('documents/user-1/gone.pdf')).rejects.toThrow(
          'Object not found in Vercel Blob: documents/user-1/gone.pdf'
        );
      });

      it('throws on an unexpected status rather than returning an empty body', async () => {
        const { get } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        vi.mocked(get).mockResolvedValue({ statusCode: 304, stream: null } as never);

        const provider = new VercelBlobProvider({ token: PUBLIC });

        await expect(provider.download('a/b.pdf')).rejects.toThrow(/Unexpected 304/);
      });

      it('propagates a read failure, such as the timeout aborting the request', async () => {
        const { get } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        vi.mocked(get).mockRejectedValue(
          new DOMException('The operation timed out', 'TimeoutError')
        );

        const provider = new VercelBlobProvider({ token: PUBLIC, privateToken: PRIVATE });

        await expect(provider.download('a/b.pdf')).rejects.toThrow('The operation timed out');
        // A failure in the private store is not "not found": it must not fall
        // through to the public store and maybe return a different object.
        expect(get).toHaveBeenCalledTimes(1);
      });

      it('refuses an invalid key before any read', async () => {
        const { get } = await import('@vercel/blob');
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        const provider = new VercelBlobProvider({ token: PUBLIC });

        await expect(provider.download('../etc/passwd')).rejects.toThrow('must not contain ".."');
        expect(get).not.toHaveBeenCalled(); // test-review:accept no_arg_called — validation must precede the SDK call;
      });
    });

    describe('getSignedUrl', () => {
      it('mints a signed read route URL carrying the org claim', async () => {
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');
        const { verifyStorageAccessToken } = await import('@/lib/storage/access-tokens');

        const provider = new VercelBlobProvider({ token: PUBLIC, privateToken: PRIVATE });

        const url = await provider.getSignedUrl('orgs/org-a/report.pdf', 300, { orgId: 'org-a' });

        expect(url).toMatch(/^\/api\/v1\/storage\/orgs\/org-a\/report\.pdf\?token=/);
        const token = decodeURIComponent(url.split('token=')[1]);
        expect(verifyStorageAccessToken(token)).toMatchObject({
          key: 'orgs/org-a/report.pdf',
          org: 'org-a',
        });
      });

      it('refuses to sign without a private store', async () => {
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        const provider = new VercelBlobProvider({ token: PUBLIC });

        await expect(provider.getSignedUrl('documents/user-1/c.pdf', 300)).rejects.toThrow(
          /cannot sign URLs/
        );
      });

      it('refuses an invalid key as a rejected promise', async () => {
        const { VercelBlobProvider } = await import('@/lib/storage/providers/vercel-blob');

        const provider = new VercelBlobProvider({ token: PUBLIC, privateToken: PRIVATE });

        await expect(provider.getSignedUrl('../etc/passwd', 300)).rejects.toThrow(
          'must not contain ".."'
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
      const { getStorageCapabilities } = await import('@/lib/storage/providers/types');

      const provider = createVercelBlobProviderFromEnv();

      expect(provider?.name).toBe('vercel-blob');
      expect(getStorageCapabilities(provider!).privateObjects).toBe(false);
    });

    it('should return null when neither token is set', async () => {
      const { createVercelBlobProviderFromEnv } =
        await import('@/lib/storage/providers/vercel-blob');

      const provider = createVercelBlobProviderFromEnv();

      expect(provider).toBeNull();
    });

    it('treats an empty token as unset', async () => {
      vi.stubEnv('BLOB_READ_WRITE_TOKEN', '');
      vi.stubEnv('BLOB_PRIVATE_READ_WRITE_TOKEN', '');

      const { createVercelBlobProviderFromEnv } =
        await import('@/lib/storage/providers/vercel-blob');

      expect(createVercelBlobProviderFromEnv()).toBeNull();
    });

    it('gives the provider a private store when BLOB_PRIVATE_READ_WRITE_TOKEN is set', async () => {
      vi.stubEnv('BLOB_READ_WRITE_TOKEN', PUBLIC);
      vi.stubEnv('BLOB_PRIVATE_READ_WRITE_TOKEN', PRIVATE);

      const { put } = await import('@vercel/blob');
      const { createVercelBlobProviderFromEnv } =
        await import('@/lib/storage/providers/vercel-blob');
      const { getStorageCapabilities } = await import('@/lib/storage/providers/types');
      const { logger } = await import('@/lib/logging');

      vi.mocked(put).mockResolvedValue({ url: 'https://x/k' } as never);

      const provider = createVercelBlobProviderFromEnv();
      expect(getStorageCapabilities(provider!).privateObjects).toBe(true);
      await provider!.upload(Buffer.from('s'), {
        key: 'a/b.pdf',
        contentType: 'application/pdf',
        public: false,
      });

      expect(vi.mocked(put).mock.calls[0][2]).toMatchObject({ access: 'private', token: PRIVATE });
      expect(logger.warn).not.toHaveBeenCalled(); // test-review:accept no_arg_called — both stores configured, nothing to warn about;
    });

    it('creates a private-only provider and warns that public uploads will be refused', async () => {
      vi.stubEnv('BLOB_PRIVATE_READ_WRITE_TOKEN', PRIVATE);

      const { createVercelBlobProviderFromEnv } =
        await import('@/lib/storage/providers/vercel-blob');
      const { logger } = await import('@/lib/logging');

      const provider = createVercelBlobProviderFromEnv();

      expect(provider?.name).toBe('vercel-blob');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('public uploads such as avatars will be refused'),
        { missingVars: ['BLOB_READ_WRITE_TOKEN'] }
      );
    });
  });
});
