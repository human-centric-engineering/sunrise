import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, unlink, mkdir, rm, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import {
  LocalProvider,
  createLocalProvider,
  createLocalProviderFromEnv,
} from '@/lib/storage/providers/local';
import { getStorageCapabilities } from '@/lib/storage/providers/types';
import { logger } from '@/lib/logging';

// Root paths here are inert strings — `fs` is mocked, so nothing is ever
// written. They deliberately avoid `/tmp`: CodeQL's js/insecure-temporary-file
// traces an OS-temp-dir literal through the provider to its `writeFile` and
// flags the sink in `local.ts`, so a hardcoded `/tmp` root in a test fails the
// build on production code that is doing nothing wrong.
vi.mock('fs/promises', () => {
  const mockWriteFile = vi.fn();
  const mockUnlink = vi.fn();
  const mockMkdir = vi.fn();
  const mockRm = vi.fn();
  const mockReadFile = vi.fn();
  const mockStat = vi.fn();

  return {
    writeFile: mockWriteFile,
    unlink: mockUnlink,
    mkdir: mockMkdir,
    rm: mockRm,
    readFile: mockReadFile,
    stat: mockStat,
    default: {
      writeFile: mockWriteFile,
      unlink: mockUnlink,
      mkdir: mockMkdir,
      rm: mockRm,
      readFile: mockReadFile,
      stat: mockStat,
    },
  };
});

vi.mock('fs', () => {
  const mockExistsSync = vi.fn();

  return {
    existsSync: mockExistsSync,
    default: {
      existsSync: mockExistsSync,
    },
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

describe('lib/storage/providers/local', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` clears calls but keeps implementations, so a
    // `mockRejectedValue` set by one test would otherwise leak into the next.
    // `upload()` now unlinks any stale copy in the opposite root, which makes
    // that leakage visible well beyond the delete tests.
    vi.mocked(unlink).mockResolvedValue(undefined);
    vi.mocked(rm).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('LocalProvider', () => {
    describe('upload', () => {
      it('should create directory and write file', async () => {
        vi.mocked(existsSync).mockReturnValue(false);
        vi.mocked(mkdir).mockResolvedValue(undefined);
        vi.mocked(writeFile).mockResolvedValue(undefined);

        const provider = new LocalProvider({ baseDir: '/srv/test-uploads', baseUrl: '/uploads' });
        const file = Buffer.from('test content');

        const result = await provider.upload(file, {
          key: 'avatars/user-123/avatar.jpg',
          contentType: 'image/jpeg',
        });

        expect(mkdir).toHaveBeenCalledWith(expect.stringContaining('avatars/user-123'), {
          recursive: true,
        });
        expect(writeFile).toHaveBeenCalledWith(
          expect.stringContaining('avatars/user-123/avatar.jpg'),
          file
        );
        expect(result).toEqual({
          key: 'avatars/user-123/avatar.jpg',
          url: '/uploads/avatars/user-123/avatar.jpg',
          size: file.length,
        });
      });

      it('should skip mkdir when directory already exists', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(writeFile).mockResolvedValue(undefined);

        const provider = new LocalProvider({ baseDir: '/srv/test-uploads' });
        const file = Buffer.from('test');

        await provider.upload(file, {
          key: 'avatars/user-123/avatar.jpg',
          contentType: 'image/jpeg',
        });

        expect(mkdir).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
      });

      it('should return correct file size', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(writeFile).mockResolvedValue(undefined);

        const provider = new LocalProvider();
        const file = Buffer.alloc(2048);

        const result = await provider.upload(file, {
          key: 'test.jpg',
          contentType: 'image/jpeg',
        });

        expect(result.size).toBe(2048);
      });
    });

    describe('delete', () => {
      it('should unlink file when it exists', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(unlink).mockResolvedValue(undefined);

        const provider = new LocalProvider({ baseDir: '/srv/test-uploads' });

        const result = await provider.delete('avatars/user-123/avatar.jpg');

        expect(unlink).toHaveBeenCalledWith(expect.stringContaining('avatars/user-123/avatar.jpg'));
        expect(result).toEqual({ success: true, key: 'avatars/user-123/avatar.jpg' });
        expect(logger.info).toHaveBeenCalledWith(
          'File deleted from local storage',
          expect.objectContaining({ key: 'avatars/user-123/avatar.jpg' })
        );
      });

      it('should handle missing file gracefully (ENOENT)', async () => {
        vi.mocked(existsSync).mockReturnValue(false);

        const provider = new LocalProvider({ baseDir: '/srv/test-uploads' });

        const result = await provider.delete('nonexistent.jpg');

        expect(unlink).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
        expect(result).toEqual({ success: true, key: 'nonexistent.jpg' });
      });

      it('should handle other errors gracefully', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(unlink).mockRejectedValue(new Error('Permission denied'));

        const provider = new LocalProvider({ baseDir: '/srv/test-uploads' });

        const result = await provider.delete('protected.jpg');

        expect(result).toEqual({ success: false, key: 'protected.jpg' });
        expect(logger.error).toHaveBeenCalledWith(
          'Failed to delete file from local storage',
          expect.any(Error),
          expect.objectContaining({ key: 'protected.jpg' })
        );
      });
    });

    describe('deletePrefix', () => {
      it('should remove directory recursively when it exists', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(rm).mockResolvedValue(undefined);

        const provider = new LocalProvider({ baseDir: '/srv/test-uploads' });

        const result = await provider.deletePrefix('avatars/user-123/');

        // `resolve()` normalises away the trailing slash — immaterial to
        // `rm`, which takes a directory either way.
        expect(rm).toHaveBeenCalledWith(expect.stringContaining('avatars/user-123'), {
          recursive: true,
        });
        expect(result).toEqual({ success: true, key: 'avatars/user-123/' });
        expect(logger.info).toHaveBeenCalledWith(
          'Directory deleted from local storage',
          expect.objectContaining({ prefix: 'avatars/user-123/' })
        );
      });

      it('should handle non-existent directory gracefully', async () => {
        vi.mocked(existsSync).mockReturnValue(false);

        const provider = new LocalProvider({ baseDir: '/srv/test-uploads' });

        const result = await provider.deletePrefix('avatars/user-999/');

        expect(rm).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
        expect(result).toEqual({ success: true, key: 'avatars/user-999/' });
        expect(logger.debug).toHaveBeenCalledWith(
          'Directory not found for deletion',
          expect.objectContaining({ prefix: 'avatars/user-999/' })
        );
      });

      it('should handle errors gracefully', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(rm).mockRejectedValue(new Error('Permission denied'));

        const provider = new LocalProvider({ baseDir: '/srv/test-uploads' });

        const result = await provider.deletePrefix('avatars/user-123/');

        expect(result).toEqual({ success: false, key: 'avatars/user-123/' });
        expect(logger.error).toHaveBeenCalledWith(
          'Failed to delete directory from local storage',
          expect.any(Error),
          expect.objectContaining({ prefix: 'avatars/user-123/' })
        );
      });

      // #508: `validateStorageKey(".")` passes and `resolve(root, ".")` is
      // `root`, which `resolveWithin` permits — so these spellings used to
      // reach `rm(root, { recursive: true })` and erase every object the
      // provider holds. `existsSync` returns true throughout so the delete is
      // reached if the guard is absent.
      describe('root-equivalent prefixes', () => {
        it.each([['.'], ['./'], ['./.'], ['././']])(
          'refuses %j without deleting anything',
          async (prefix) => {
            vi.mocked(existsSync).mockReturnValue(true);

            const provider = new LocalProvider({
              baseDir: '/srv/test-uploads',
              privateDir: '/srv/test-private',
            });

            await expect(provider.deletePrefix(prefix)).rejects.toThrow(
              'Storage key must not resolve to the storage root'
            );
            expect(rm).not.toHaveBeenCalled(); // test-review:accept no_arg_called — the whole point of the guard is that the recursive delete never runs
          }
        );

        // The other root-adjacent spellings never reach the new guard —
        // `validateStorageKey` stops them first. Pinned so a future
        // relaxation of that validator shows up here rather than silently
        // handing these to `resolveWithin`.
        it.each([
          ['', /must not be empty/i],
          ['/', /must not be an absolute path/i],
          ['..', /must not contain "\.\."/],
          ['a/..', /must not contain "\.\."/],
        ])('refuses %j earlier, in validateStorageKey', async (prefix, message) => {
          vi.mocked(existsSync).mockReturnValue(true);

          const provider = new LocalProvider({ baseDir: '/srv/test-uploads' });

          await expect(provider.deletePrefix(prefix)).rejects.toThrow(message);
          expect(rm).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
        });

        it('refuses before touching either root, not after clearing the first', async () => {
          // Both prefixes resolve, then both are deleted. If the guard ran
          // per-root inside the loop, the private root would already be gone
          // by the time the public one was refused.
          vi.mocked(existsSync).mockReturnValue(true);

          const provider = new LocalProvider({
            baseDir: '/srv/test-uploads',
            privateDir: '/srv/test-private',
          });

          await expect(provider.deletePrefix('.')).rejects.toThrow(
            'Storage key must not resolve to the storage root'
          );
          expect(rm).not.toHaveBeenCalled(); // test-review:accept no_arg_called — asserts the private root survived too
        });

        it('still deletes a genuine prefix one level below the root', async () => {
          // The guard rejects the root, not everything near it.
          vi.mocked(existsSync).mockReturnValue(true);

          const provider = new LocalProvider({ baseDir: '/srv/test-uploads' });

          const result = await provider.deletePrefix('avatars/');

          expect(rm).toHaveBeenCalledWith(expect.stringContaining('avatars'), {
            recursive: true,
          });
          expect(result).toEqual({ success: true, key: 'avatars/' });
        });

        // The guard lives in `resolveWithin`, so it covers every caller, not
        // just the recursive delete. `upload` is the one where the first cut
        // of #508 was wrong about the fallback: it does NOT fail on EISDIR
        // when the root is absent (the default `.storage/private` on a fresh
        // checkout). It mkdirs `dirname(root)` — outside the root this
        // function exists to contain — then writes a regular file at the root
        // path, after which every later upload fails ENOTDIR.
        it('refuses a root-resolving key in upload(), before mkdir or writeFile', async () => {
          vi.mocked(existsSync).mockReturnValue(false);

          const provider = new LocalProvider({ baseDir: '/srv/test-uploads' });

          await expect(
            provider.upload(Buffer.from('x'), { key: '.', contentType: 'text/plain' })
          ).rejects.toThrow('Storage key must not resolve to the storage root');
          expect(mkdir).not.toHaveBeenCalled(); // test-review:accept no_arg_called — mkdir would create a directory OUTSIDE the storage root
          expect(writeFile).not.toHaveBeenCalled(); // test-review:accept no_arg_called — writeFile would turn the storage root into a file
        });

        it.each([['delete'], ['download']] as const)(
          'refuses a root-resolving key in %s()',
          async (method) => {
            vi.mocked(existsSync).mockReturnValue(true);

            const provider = new LocalProvider({ baseDir: '/srv/test-uploads' });

            await expect(provider[method]('.')).rejects.toThrow(
              'Storage key must not resolve to the storage root'
            );
          }
        );
      });
    });

    describe('private objects', () => {
      const TWO_ROOTS = { baseDir: '/srv/test-uploads', privateDir: '/srv/test-private' };

      it('writes a public:false upload to the private root, never the public one', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(writeFile).mockResolvedValue(undefined);

        const provider = new LocalProvider(TWO_ROOTS);

        await provider.upload(Buffer.from('secret'), {
          key: 'documents/user-1/contract.pdf',
          contentType: 'application/pdf',
          public: false,
        });

        const writtenPath = vi.mocked(writeFile).mock.calls[0]?.[0] as string;
        expect(writtenPath).toContain('/srv/test-private/');
        // The bug this fixes: the file used to land under public/uploads/,
        // where Next serves it to anyone who guesses the key.
        expect(writtenPath).not.toContain('/srv/test-uploads/');
      });

      it('returns the signed route path rather than a statically served URL', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(writeFile).mockResolvedValue(undefined);

        const provider = new LocalProvider(TWO_ROOTS);

        const result = await provider.upload(Buffer.from('secret'), {
          key: 'documents/user-1/contract.pdf',
          contentType: 'application/pdf',
          public: false,
        });

        expect(result.url).toBe('/api/v1/storage/documents/user-1/contract.pdf');
      });

      it('still writes public uploads to the public root with a static URL', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(writeFile).mockResolvedValue(undefined);

        const provider = new LocalProvider(TWO_ROOTS);

        const result = await provider.upload(Buffer.from('hi'), {
          key: 'avatars/user-1/avatar.jpg',
          contentType: 'image/jpeg',
        });

        expect(vi.mocked(writeFile).mock.calls[0]?.[0]).toContain('/srv/test-uploads/');
        expect(result.url).toBe('/uploads/avatars/user-1/avatar.jpg');
      });

      it('fails the upload when the stale copy in the other root cannot be removed', async () => {
        // Reporting success here would tell the caller the object is private
        // while the old copy is still served at /uploads/<key>.
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(writeFile).mockResolvedValue(undefined);
        vi.mocked(unlink).mockRejectedValue(new Error('EACCES'));

        const provider = new LocalProvider(TWO_ROOTS);

        await expect(
          provider.upload(Buffer.from('secret'), {
            key: 'documents/user-1/contract.pdf',
            contentType: 'application/pdf',
            public: false,
          })
        ).rejects.toThrow(/may still be readable/i);
      });

      it('declares privateObjects, signedUrls and download', () => {
        const provider = new LocalProvider(TWO_ROOTS);

        expect(getStorageCapabilities(provider)).toEqual({
          privateObjects: true,
          signedUrls: true,
          download: true,
        });
      });

      it('signs a URL pointing at the storage read route', async () => {
        const provider = new LocalProvider(TWO_ROOTS);

        const url = await provider.getSignedUrl('documents/user-1/contract.pdf', 300);

        expect(url).toMatch(/^\/api\/v1\/storage\/documents\/user-1\/contract\.pdf\?token=/);
      });

      it('refuses to sign a traversal key', async () => {
        const provider = new LocalProvider(TWO_ROOTS);

        await expect(provider.getSignedUrl('../../etc/passwd', 300)).rejects.toThrow(
          'must not contain ".."'
        );
      });
    });

    describe('deletion spans both roots', () => {
      const TWO_ROOTS = { baseDir: '/srv/test-uploads', privateDir: '/srv/test-private' };

      it('deletes a key from the private root as well as the public one', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(unlink).mockResolvedValue(undefined);

        const provider = new LocalProvider(TWO_ROOTS);
        const result = await provider.delete('documents/user-1/contract.pdf');

        const paths = vi.mocked(unlink).mock.calls.map((call) => call[0] as string);
        expect(paths.some((p) => p.startsWith('/srv/test-private/'))).toBe(true);
        expect(paths.some((p) => p.startsWith('/srv/test-uploads/'))).toBe(true);
        expect(result).toEqual({ success: true, key: 'documents/user-1/contract.pdf' });
      });

      it('clears a prefix from both roots — the GDPR erasure path', async () => {
        // eraseUser() calls deleteByPrefix('avatars/<id>/'). Sweeping only
        // the public root would leave the user's private files on disk and
        // turn erasure into a partial delete.
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(rm).mockResolvedValue(undefined);

        const provider = new LocalProvider(TWO_ROOTS);
        const result = await provider.deletePrefix('avatars/user-123/');

        const paths = vi.mocked(rm).mock.calls.map((call) => call[0] as string);
        expect(paths.some((p) => p.startsWith('/srv/test-private/'))).toBe(true);
        expect(paths.some((p) => p.startsWith('/srv/test-uploads/'))).toBe(true);
        expect(result).toEqual({ success: true, key: 'avatars/user-123/' });
      });

      it('reports failure when the private root cannot be swept', async () => {
        // A partial erasure must not report success — that is the difference
        // between a retryable failure and silent non-compliance.
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(rm)
          .mockRejectedValueOnce(new Error('Permission denied')) // private root
          .mockResolvedValueOnce(undefined); // public root

        const provider = new LocalProvider(TWO_ROOTS);
        const result = await provider.deletePrefix('avatars/user-123/');

        expect(result.success).toBe(false);
        // The public root is still swept — one failure must not abort the other.
        expect(rm).toHaveBeenCalledTimes(2);
      });
    });

    describe('download', () => {
      const TWO_ROOTS = { baseDir: '/srv/test-uploads', privateDir: '/srv/test-private' };

      /** A rejection shaped like Node's, since `download()` branches on `.code`. */
      function errno(code: string): NodeJS.ErrnoException {
        const err: NodeJS.ErrnoException = new Error(code);
        err.code = code;
        return err;
      }

      it('reads a private object back as bytes', async () => {
        const body = Buffer.from('secret contents');
        vi.mocked(readFile).mockImplementation((p) =>
          typeof p === 'string' && p.startsWith('/srv/test-private/')
            ? Promise.resolve(body)
            : Promise.reject(errno('ENOENT'))
        );

        const provider = new LocalProvider(TWO_ROOTS);
        const object = await provider.download('documents/user-1/contract.pdf');

        expect(object.body.toString()).toBe('secret contents');
        expect(object.size).toBe(body.length);
        expect(object.key).toBe('documents/user-1/contract.pdf');
      });

      it('falls back to the public root when the key is not private', async () => {
        const body = Buffer.from('avatar bytes');
        vi.mocked(readFile).mockImplementation((p) =>
          typeof p === 'string' && p.startsWith('/srv/test-uploads/')
            ? Promise.resolve(body)
            : Promise.reject(errno('ENOENT'))
        );

        const provider = new LocalProvider(TWO_ROOTS);
        const object = await provider.download('avatars/user-1/avatar.jpg');

        // Private root tried first, then the public one.
        expect(vi.mocked(readFile).mock.calls[0]?.[0]).toContain('/srv/test-private/');
        expect(object.body.toString()).toBe('avatar bytes');
      });

      it('throws when the key exists in neither root', async () => {
        vi.mocked(readFile).mockRejectedValue(errno('ENOENT'));

        const provider = new LocalProvider(TWO_ROOTS);

        await expect(provider.download('missing.pdf')).rejects.toThrow(/not found/i);
        // Both roots were attempted before giving up.
        expect(readFile).toHaveBeenCalledTimes(2);
      });

      it('treats a key naming a directory as absent rather than surfacing EISDIR', async () => {
        vi.mocked(readFile).mockRejectedValue(errno('EISDIR'));

        const provider = new LocalProvider(TWO_ROOTS);

        await expect(provider.download('documents/user-1')).rejects.toThrow(/not found/i);
      });

      it('propagates a genuine filesystem fault instead of reporting not-found', async () => {
        // EACCES means the object may well exist and we failed to read it —
        // reporting "not found" would turn a fault into a silent 404.
        vi.mocked(readFile).mockRejectedValue(errno('EACCES'));

        const provider = new LocalProvider(TWO_ROOTS);

        await expect(provider.download('documents/user-1/contract.pdf')).rejects.toThrow('EACCES');
      });

      it('rejects a traversal key before touching the filesystem', async () => {
        const provider = new LocalProvider(TWO_ROOTS);

        await expect(provider.download('../../etc/passwd')).rejects.toThrow(
          'must not contain ".."'
        );
        expect(readFile).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
      });
    });

    describe('key validation', () => {
      it('should throw for invalid key with path traversal in upload()', async () => {
        const provider = new LocalProvider({ baseDir: '/srv/test-uploads' });

        await expect(
          provider.upload(Buffer.from('test'), {
            key: '../etc/passwd',
            contentType: 'text/plain',
          })
        ).rejects.toThrow('must not contain ".."');
      });

      it('should throw for invalid key with path traversal in delete()', async () => {
        const provider = new LocalProvider({ baseDir: '/srv/test-uploads' });

        await expect(provider.delete('../etc/passwd')).rejects.toThrow('must not contain ".."');
      });

      it('should throw for invalid key with path traversal in deletePrefix()', async () => {
        const provider = new LocalProvider({ baseDir: '/srv/test-uploads' });

        await expect(provider.deletePrefix('../etc/')).rejects.toThrow('must not contain ".."');
      });
    });
  });

  describe('createLocalProvider', () => {
    it('should return provider with name local', () => {
      const provider = createLocalProvider();

      expect(provider.name).toBe('local');
    });

    it('accepts configuration — it used to take no arguments at all', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(writeFile).mockResolvedValue(undefined);

      const provider = createLocalProvider({ baseDir: '/custom/uploads', baseUrl: '/files' });
      const result = await provider.upload(Buffer.from('x'), {
        key: 'a.txt',
        contentType: 'text/plain',
      });

      expect(vi.mocked(writeFile).mock.calls[0]?.[0]).toContain('/custom/uploads');
      expect(result.url).toBe('/files/a.txt');
    });
  });

  describe('createLocalProviderFromEnv', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('uses the configured private directory', async () => {
      vi.stubEnv('STORAGE_LOCAL_PRIVATE_DIR', '/var/private-objects');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(writeFile).mockResolvedValue(undefined);

      const provider = createLocalProviderFromEnv();
      await provider.upload(Buffer.from('secret'), {
        key: 'doc.pdf',
        contentType: 'application/pdf',
        public: false,
      });

      expect(vi.mocked(writeFile).mock.calls[0]?.[0]).toContain('/var/private-objects');
    });

    it('defaults the private root to .storage/private when unset', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(writeFile).mockResolvedValue(undefined);

      const provider = createLocalProviderFromEnv();
      await provider.upload(Buffer.from('secret'), {
        key: 'doc.pdf',
        contentType: 'application/pdf',
        public: false,
      });

      const writtenPath = vi.mocked(writeFile).mock.calls[0]?.[0] as string;
      expect(writtenPath).toContain('.storage/private');
      // Must not be under public/, or Next serves it statically.
      expect(writtenPath).not.toContain('public/uploads');
    });
  });
});
