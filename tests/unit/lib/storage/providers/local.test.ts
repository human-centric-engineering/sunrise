import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, unlink, mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { LocalProvider, createLocalProvider } from '@/lib/storage/providers/local';
import { logger } from '@/lib/logging';

vi.mock('fs/promises', () => {
  const mockWriteFile = vi.fn();
  const mockUnlink = vi.fn();
  const mockMkdir = vi.fn();
  const mockRm = vi.fn();

  return {
    writeFile: mockWriteFile,
    unlink: mockUnlink,
    mkdir: mockMkdir,
    rm: mockRm,
    default: {
      writeFile: mockWriteFile,
      unlink: mockUnlink,
      mkdir: mockMkdir,
      rm: mockRm,
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

describe('lib/storage/providers/local', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

        const provider = new LocalProvider({ baseDir: '/tmp/uploads', baseUrl: '/uploads' });
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

        const provider = new LocalProvider({ baseDir: '/tmp/uploads' });
        const file = Buffer.from('test');

        await provider.upload(file, {
          key: 'avatars/user-123/avatar.jpg',
          contentType: 'image/jpeg',
        });

        expect(mkdir).not.toHaveBeenCalled();
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

        const provider = new LocalProvider({ baseDir: '/tmp/uploads' });

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

        const provider = new LocalProvider({ baseDir: '/tmp/uploads' });

        const result = await provider.delete('nonexistent.jpg');

        expect(unlink).not.toHaveBeenCalled();
        expect(result).toEqual({ success: true, key: 'nonexistent.jpg' });
      });

      it('should handle other errors gracefully', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(unlink).mockRejectedValue(new Error('Permission denied'));

        const provider = new LocalProvider({ baseDir: '/tmp/uploads' });

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

        const provider = new LocalProvider({ baseDir: '/tmp/uploads' });

        const result = await provider.deletePrefix('avatars/user-123/');

        expect(rm).toHaveBeenCalledWith(expect.stringContaining('avatars/user-123/'), {
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

        const provider = new LocalProvider({ baseDir: '/tmp/uploads' });

        const result = await provider.deletePrefix('avatars/user-999/');

        expect(rm).not.toHaveBeenCalled();
        expect(result).toEqual({ success: true, key: 'avatars/user-999/' });
        expect(logger.debug).toHaveBeenCalledWith(
          'Directory not found for deletion',
          expect.objectContaining({ prefix: 'avatars/user-999/' })
        );
      });

      it('should handle errors gracefully', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(rm).mockRejectedValue(new Error('Permission denied'));

        const provider = new LocalProvider({ baseDir: '/tmp/uploads' });

        const result = await provider.deletePrefix('avatars/user-123/');

        expect(result).toEqual({ success: false, key: 'avatars/user-123/' });
        expect(logger.error).toHaveBeenCalledWith(
          'Failed to delete directory from local storage',
          expect.any(Error),
          expect.objectContaining({ prefix: 'avatars/user-123/' })
        );
      });
    });

    describe('key validation', () => {
      it('should throw for invalid key with path traversal in upload()', async () => {
        const provider = new LocalProvider({ baseDir: '/tmp/uploads' });

        await expect(
          provider.upload(Buffer.from('test'), {
            key: '../etc/passwd',
            contentType: 'text/plain',
          })
        ).rejects.toThrow('must not contain ".."');
      });

      it('should throw for invalid key with path traversal in delete()', async () => {
        const provider = new LocalProvider({ baseDir: '/tmp/uploads' });

        await expect(provider.delete('../etc/passwd')).rejects.toThrow('must not contain ".."');
      });

      it('should throw for invalid key with path traversal in deletePrefix()', async () => {
        const provider = new LocalProvider({ baseDir: '/tmp/uploads' });

        await expect(provider.deletePrefix('../etc/')).rejects.toThrow('must not contain ".."');
      });
    });
  });

  describe('createLocalProvider', () => {
    it('should return provider with name local', () => {
      const provider = createLocalProvider();

      expect(provider.name).toBe('local');
    });
  });
});
