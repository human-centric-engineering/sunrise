import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock storage client
vi.mock('@/lib/storage/client', () => ({
  getStorageClient: vi.fn(),
  isStorageEnabled: vi.fn(),
}));

// Mock image processing
vi.mock('@/lib/storage/image', () => ({
  processImage: vi.fn(),
  getExtensionForMimeType: vi.fn(() => 'jpg'),
  validateImageMagicBytes: vi.fn(() => ({ valid: true, detectedType: 'image/jpeg' })),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

describe('lib/storage/upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('getMaxFileSize', () => {
    it('should return default 5MB when MAX_FILE_SIZE_MB is not set', async () => {
      const { getMaxFileSize, DEFAULT_MAX_FILE_SIZE } = await import('@/lib/storage/upload');

      const size = getMaxFileSize();

      expect(size).toBe(DEFAULT_MAX_FILE_SIZE);
      expect(size).toBe(5 * 1024 * 1024);
    });

    it('should return configured size when MAX_FILE_SIZE_MB is set', async () => {
      vi.stubEnv('MAX_FILE_SIZE_MB', '10');

      const { getMaxFileSize } = await import('@/lib/storage/upload');

      const size = getMaxFileSize();

      expect(size).toBe(10 * 1024 * 1024);
    });

    it('should return default when MAX_FILE_SIZE_MB is invalid', async () => {
      vi.stubEnv('MAX_FILE_SIZE_MB', 'invalid');

      const { getMaxFileSize, DEFAULT_MAX_FILE_SIZE } = await import('@/lib/storage/upload');

      const size = getMaxFileSize();

      expect(size).toBe(DEFAULT_MAX_FILE_SIZE);
    });

    it('should return default when MAX_FILE_SIZE_MB is zero or negative', async () => {
      vi.stubEnv('MAX_FILE_SIZE_MB', '0');

      const { getMaxFileSize, DEFAULT_MAX_FILE_SIZE } = await import('@/lib/storage/upload');

      const size = getMaxFileSize();

      expect(size).toBe(DEFAULT_MAX_FILE_SIZE);
    });
  });

  describe('uploadAvatar', () => {
    it('should throw error when storage is not configured', async () => {
      const { getStorageClient } = await import('@/lib/storage/client');
      vi.mocked(getStorageClient).mockReturnValue(null);

      const { uploadAvatar } = await import('@/lib/storage/upload');

      const buffer = Buffer.from('test');

      await expect(uploadAvatar(buffer, { userId: 'user-123' })).rejects.toThrow(
        'Storage is not configured'
      );
    });

    it('should throw error when file exceeds max size', async () => {
      const mockProvider = {
        name: 'mock',
        upload: vi.fn(),
        delete: vi.fn(),
      };

      const { getStorageClient } = await import('@/lib/storage/client');
      vi.mocked(getStorageClient).mockReturnValue(mockProvider);

      const { uploadAvatar } = await import('@/lib/storage/upload');

      // Create a buffer larger than 5MB
      const largeBuffer = Buffer.alloc(6 * 1024 * 1024);

      await expect(uploadAvatar(largeBuffer, { userId: 'user-123' })).rejects.toThrow(
        /File size exceeds maximum/
      );
    });

    it('should upload processed image and return result', async () => {
      const mockProvider = {
        name: 'mock',
        upload: vi.fn().mockResolvedValue({
          key: 'avatars/user-123/abc.jpg',
          url: 'https://storage.example.com/avatars/user-123/abc.jpg',
          size: 1000,
        }),
        delete: vi.fn(),
      };

      const { getStorageClient } = await import('@/lib/storage/client');
      vi.mocked(getStorageClient).mockReturnValue(mockProvider);

      const { processImage } = await import('@/lib/storage/image');
      vi.mocked(processImage).mockResolvedValue({
        buffer: Buffer.from('processed'),
        mimeType: 'image/jpeg',
        width: 500,
        height: 500,
      });

      const { uploadAvatar } = await import('@/lib/storage/upload');
      const { logger } = await import('@/lib/logging');

      // Valid JPEG buffer (small enough)
      const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

      const result = await uploadAvatar(buffer, { userId: 'user-123' });

      expect(result.url).toBe('https://storage.example.com/avatars/user-123/abc.jpg');
      expect(result.width).toBe(500);
      expect(result.height).toBe(500);
      expect(mockProvider.upload).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({
          key: 'avatars/user-123/avatar.jpg',
          contentType: 'image/jpeg',
        })
      );
      expect(logger.info).toHaveBeenCalledWith(
        'Avatar uploaded',
        expect.objectContaining({ userId: 'user-123' })
      );
    });
  });

  describe('deleteFile', () => {
    it('should return failure when storage is not configured', async () => {
      const { getStorageClient } = await import('@/lib/storage/client');
      vi.mocked(getStorageClient).mockReturnValue(null);

      const { deleteFile } = await import('@/lib/storage/upload');
      const { logger } = await import('@/lib/logging');

      const result = await deleteFile('avatars/user-123/abc.jpg');

      expect(result.success).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        'Cannot delete file - storage not configured',
        expect.objectContaining({ keyOrUrl: 'avatars/user-123/abc.jpg' })
      );
    });

    it('should extract key from URL for non-Vercel providers', async () => {
      const mockProvider = {
        name: 's3',
        upload: vi.fn(),
        delete: vi.fn().mockResolvedValue({ success: true, key: 'avatars/user-123/abc.jpg' }),
      };

      const { getStorageClient } = await import('@/lib/storage/client');
      vi.mocked(getStorageClient).mockReturnValue(mockProvider);

      const { deleteFile } = await import('@/lib/storage/upload');

      const result = await deleteFile('https://bucket.s3.amazonaws.com/avatars/user-123/abc.jpg');

      expect(result.success).toBe(true);
      expect(mockProvider.delete).toHaveBeenCalledWith('avatars/user-123/abc.jpg');
    });

    it('should pass full URL for Vercel Blob provider', async () => {
      const mockProvider = {
        name: 'vercel-blob',
        upload: vi.fn(),
        delete: vi.fn().mockResolvedValue({ success: true, key: 'https://vercel.blob/abc.jpg' }),
      };

      const { getStorageClient } = await import('@/lib/storage/client');
      vi.mocked(getStorageClient).mockReturnValue(mockProvider);

      const { deleteFile } = await import('@/lib/storage/upload');

      const result = await deleteFile('https://vercel.blob/avatars/user-123/abc.jpg');

      expect(result.success).toBe(true);
      expect(mockProvider.delete).toHaveBeenCalledWith(
        'https://vercel.blob/avatars/user-123/abc.jpg'
      );
    });
  });

  describe('isStorageEnabled (re-export)', () => {
    it('should re-export isStorageEnabled from client', async () => {
      const { isStorageEnabled: clientIsStorageEnabled } = await import('@/lib/storage/client');
      vi.mocked(clientIsStorageEnabled).mockReturnValue(true);

      const { isStorageEnabled } = await import('@/lib/storage/upload');

      expect(isStorageEnabled()).toBe(true);
    });
  });
});
