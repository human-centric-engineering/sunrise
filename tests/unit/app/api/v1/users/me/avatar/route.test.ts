import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth/config', () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    user: {
      update: vi.fn(),
    },
  },
}));

vi.mock('@/lib/storage/upload', () => ({
  uploadAvatar: vi.fn(),
  isStorageEnabled: vi.fn(),
  getMaxFileSize: vi.fn().mockReturnValue(5 * 1024 * 1024),
  deleteByPrefix: vi.fn(),
}));

vi.mock('@/lib/storage/image', () => ({
  validateImageMagicBytes: vi.fn(),
  SUPPORTED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  uploadLimiter: {
    check: vi.fn(() => ({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Math.ceil((Date.now() + 900000) / 1000),
    })),
  },
  createRateLimitResponse: vi.fn(
    () =>
      new Response(
        JSON.stringify({
          success: false,
          error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests.' },
        }),
        { status: 429 }
      )
  ),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

// Helper to create upload request with a file
function createUploadRequest(file?: File | null): NextRequest {
  const formData = new FormData();
  if (file) {
    formData.append('file', file);
  }
  return new NextRequest('http://localhost:3000/api/v1/users/me/avatar', {
    method: 'POST',
    body: formData,
  });
}

function createDeleteRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/users/me/avatar', {
    method: 'DELETE',
  });
}

function createMockFile(
  content = 'fake image data',
  name = 'test.jpg',
  type = 'image/jpeg',
  size?: number
): File {
  const file = new File([content], name, { type });
  if (size !== undefined) {
    Object.defineProperty(file, 'size', { value: size });
  }
  return file;
}

describe('app/api/v1/users/me/avatar/route', () => {
  const userId = 'user-123';
  const mockSession = {
    user: { id: userId, email: 'test@example.com', role: 'USER' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/v1/users/me/avatar', () => {
    it('should return 503 when storage is not enabled', async () => {
      const { auth } = await import('@/lib/auth/config');
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);

      const { isStorageEnabled } = await import('@/lib/storage/upload');
      vi.mocked(isStorageEnabled).mockReturnValue(false);

      const { POST } = await import('@/app/api/v1/users/me/avatar/route');
      const request = createUploadRequest(createMockFile());

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(503);
      expect(data.success).toBe(false);
    });

    it('should return 401 when not authenticated', async () => {
      const { isStorageEnabled } = await import('@/lib/storage/upload');
      const { auth } = await import('@/lib/auth/config');

      vi.mocked(isStorageEnabled).mockReturnValue(true);
      vi.mocked(auth.api.getSession).mockResolvedValue(null as never);

      const { POST } = await import('@/app/api/v1/users/me/avatar/route');
      const request = createUploadRequest(createMockFile());

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
    });

    it('should return 400 when no file provided', async () => {
      const { isStorageEnabled } = await import('@/lib/storage/upload');
      const { auth } = await import('@/lib/auth/config');

      vi.mocked(isStorageEnabled).mockReturnValue(true);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);

      const { POST } = await import('@/app/api/v1/users/me/avatar/route');
      // Create request without file
      const request = createUploadRequest(null);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
    });

    it('should return 400 when file exceeds max size', async () => {
      const { isStorageEnabled, getMaxFileSize } = await import('@/lib/storage/upload');
      const { auth } = await import('@/lib/auth/config');

      vi.mocked(isStorageEnabled).mockReturnValue(true);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);
      // Set max file size to 10 bytes to trigger size check with normal-sized file
      vi.mocked(getMaxFileSize).mockReturnValue(10);

      const { POST } = await import('@/app/api/v1/users/me/avatar/route');
      // File with 14 bytes of content ('fake image data') exceeds the 10 byte limit
      const largeFile = createMockFile('fake image data', 'large.jpg', 'image/jpeg');
      const request = createUploadRequest(largeFile);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe('FILE_TOO_LARGE');
    });

    it('should return 400 when file has invalid magic bytes', async () => {
      const { isStorageEnabled, getMaxFileSize } = await import('@/lib/storage/upload');
      const { auth } = await import('@/lib/auth/config');
      const { validateImageMagicBytes } = await import('@/lib/storage/image');

      vi.mocked(isStorageEnabled).mockReturnValue(true);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);
      vi.mocked(getMaxFileSize).mockReturnValue(5 * 1024 * 1024); // Reset to normal size
      vi.mocked(validateImageMagicBytes).mockReturnValue({
        valid: false,
        detectedType: null,
        error: 'Not a valid image file',
      });

      const { POST } = await import('@/app/api/v1/users/me/avatar/route');
      const request = createUploadRequest(createMockFile());

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe('INVALID_FILE_TYPE');
    });

    it('should successfully upload avatar and return cache-busted URL', async () => {
      const { isStorageEnabled, uploadAvatar, getMaxFileSize } =
        await import('@/lib/storage/upload');
      const { auth } = await import('@/lib/auth/config');
      const { validateImageMagicBytes } = await import('@/lib/storage/image');
      const { prisma } = await import('@/lib/db/client');

      vi.mocked(isStorageEnabled).mockReturnValue(true);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);
      vi.mocked(getMaxFileSize).mockReturnValue(5 * 1024 * 1024); // Reset to normal size
      vi.mocked(validateImageMagicBytes).mockReturnValue({
        valid: true,
        detectedType: 'image/jpeg',
      });
      vi.mocked(uploadAvatar).mockResolvedValue({
        url: 'https://storage.example.com/avatars/user-123/avatar.jpg',
        key: 'avatars/user-123/avatar.jpg',
        size: 2048,
        width: 500,
        height: 500,
      });
      vi.mocked(prisma.user.update).mockResolvedValue({} as never);

      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const { POST } = await import('@/app/api/v1/users/me/avatar/route');
      const request = createUploadRequest(createMockFile());

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.url).toContain('?v=');
      expect(data.data.width).toBe(500);
      expect(data.data.height).toBe(500);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: userId },
        data: { image: expect.stringContaining('?v=') },
      });
    });

    it('should handle uploadAvatar failures', async () => {
      const { isStorageEnabled, uploadAvatar, getMaxFileSize } =
        await import('@/lib/storage/upload');
      const { auth } = await import('@/lib/auth/config');
      const { validateImageMagicBytes } = await import('@/lib/storage/image');

      vi.mocked(isStorageEnabled).mockReturnValue(true);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);
      vi.mocked(getMaxFileSize).mockReturnValue(5 * 1024 * 1024); // Reset to normal size
      vi.mocked(validateImageMagicBytes).mockReturnValue({
        valid: true,
        detectedType: 'image/jpeg',
      });
      vi.mocked(uploadAvatar).mockRejectedValue(new Error('Storage unavailable'));

      const { POST } = await import('@/app/api/v1/users/me/avatar/route');
      const request = createUploadRequest(createMockFile());

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
    });
  });

  describe('Filename Sanitization (Batch 5 Fix)', () => {
    it('should sanitize filename with special characters before logging', async () => {
      const { isStorageEnabled, uploadAvatar, getMaxFileSize } =
        await import('@/lib/storage/upload');
      const { auth } = await import('@/lib/auth/config');
      const { validateImageMagicBytes } = await import('@/lib/storage/image');
      const { logger } = await import('@/lib/logging');

      vi.mocked(isStorageEnabled).mockReturnValue(true);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);
      vi.mocked(getMaxFileSize).mockReturnValue(5 * 1024 * 1024);
      vi.mocked(validateImageMagicBytes).mockReturnValue({
        valid: true,
        detectedType: 'image/jpeg',
      });
      vi.mocked(uploadAvatar).mockResolvedValue({
        url: 'https://storage.example.com/avatars/user-123/avatar.jpg',
        key: 'avatars/user-123/avatar.jpg',
        size: 2048,
        width: 500,
        height: 500,
      });

      const { POST } = await import('@/app/api/v1/users/me/avatar/route');

      // Create file with special characters in filename
      const maliciousFile = createMockFile(
        'fake image data',
        '../../../etc/passwd\n<script>alert("xss")</script>.jpg',
        'image/jpeg'
      );
      const request = createUploadRequest(maliciousFile);

      await POST(request);

      // Assert: Logger was called with sanitized filename
      expect(logger.info).toHaveBeenCalledWith(
        'Avatar upload started',
        expect.objectContaining({
          // Special characters should be replaced with underscores
          fileName: expect.stringMatching(/^[.\w\-_]+$/),
          userId: mockSession.user.id,
        })
      );

      // Verify special characters are removed/replaced
      const logCall = vi
        .mocked(logger.info)
        .mock.calls.find((call) => call[0] === 'Avatar upload started');
      expect(logCall).toBeDefined();
      const loggedFileName = (logCall?.[1] as any)?.fileName;

      // The sanitization regex /[^\w.\-]/g replaces non-word, non-dot, non-hyphen chars with _
      // So slashes, angle brackets, parentheses, newlines become underscores
      expect(loggedFileName).not.toContain('/');
      expect(loggedFileName).not.toContain('<');
      expect(loggedFileName).not.toContain('>');
      expect(loggedFileName).not.toContain('(');
      expect(loggedFileName).not.toContain(')');
      expect(loggedFileName).not.toContain('\n');

      // Filename should only contain safe characters (alphanumeric, dots, underscores, hyphens)
      expect(loggedFileName).toMatch(/^[.\w-]+$/);

      // The dangerous path traversal pattern "../" becomes ".._" (slash replaced with underscore)
      // This prevents log injection but dots themselves are preserved as valid filename chars
    });

    it('should sanitize very long filenames before logging', async () => {
      const { isStorageEnabled, uploadAvatar, getMaxFileSize } =
        await import('@/lib/storage/upload');
      const { auth } = await import('@/lib/auth/config');
      const { validateImageMagicBytes } = await import('@/lib/storage/image');
      const { logger } = await import('@/lib/logging');

      vi.mocked(isStorageEnabled).mockReturnValue(true);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);
      vi.mocked(getMaxFileSize).mockReturnValue(5 * 1024 * 1024);
      vi.mocked(validateImageMagicBytes).mockReturnValue({
        valid: true,
        detectedType: 'image/jpeg',
      });
      vi.mocked(uploadAvatar).mockResolvedValue({
        url: 'https://storage.example.com/avatars/user-123/avatar.jpg',
        key: 'avatars/user-123/avatar.jpg',
        size: 2048,
        width: 500,
        height: 500,
      });

      const { POST } = await import('@/app/api/v1/users/me/avatar/route');

      // Create file with very long filename (300 characters)
      const longFileName = 'a'.repeat(300) + '.jpg';
      const longFile = createMockFile('fake image data', longFileName, 'image/jpeg');
      const request = createUploadRequest(longFile);

      await POST(request);

      // Assert: Filename truncated to 255 characters
      const logCall = vi
        .mocked(logger.info)
        .mock.calls.find((call) => call[0] === 'Avatar upload started');
      const loggedFileName = (logCall?.[1] as any)?.fileName;
      expect(loggedFileName.length).toBeLessThanOrEqual(255);
    });

    it('should sanitize control characters in filename', async () => {
      const { isStorageEnabled, uploadAvatar, getMaxFileSize } =
        await import('@/lib/storage/upload');
      const { auth } = await import('@/lib/auth/config');
      const { validateImageMagicBytes } = await import('@/lib/storage/image');
      const { logger } = await import('@/lib/logging');

      vi.mocked(isStorageEnabled).mockReturnValue(true);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);
      vi.mocked(getMaxFileSize).mockReturnValue(5 * 1024 * 1024);
      vi.mocked(validateImageMagicBytes).mockReturnValue({
        valid: true,
        detectedType: 'image/jpeg',
      });
      vi.mocked(uploadAvatar).mockResolvedValue({
        url: 'https://storage.example.com/avatars/user-123/avatar.jpg',
        key: 'avatars/user-123/avatar.jpg',
        size: 2048,
        width: 500,
        height: 500,
      });

      const { POST } = await import('@/app/api/v1/users/me/avatar/route');

      // Create file with control characters
      const fileWithControlChars = createMockFile(
        'fake image data',
        'test\r\n\t\x00file.jpg',
        'image/jpeg'
      );
      const request = createUploadRequest(fileWithControlChars);

      await POST(request);

      // Assert: Control characters removed/replaced
      const logCall = vi
        .mocked(logger.info)
        .mock.calls.find((call) => call[0] === 'Avatar upload started');
      const loggedFileName = (logCall?.[1] as any)?.fileName;
      expect(loggedFileName).not.toContain('\r');
      expect(loggedFileName).not.toContain('\n');
      expect(loggedFileName).not.toContain('\t');
      expect(loggedFileName).not.toContain('\x00');
    });

    it('should preserve valid filename characters', async () => {
      const { isStorageEnabled, uploadAvatar, getMaxFileSize } =
        await import('@/lib/storage/upload');
      const { auth } = await import('@/lib/auth/config');
      const { validateImageMagicBytes } = await import('@/lib/storage/image');
      const { logger } = await import('@/lib/logging');

      vi.mocked(isStorageEnabled).mockReturnValue(true);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);
      vi.mocked(getMaxFileSize).mockReturnValue(5 * 1024 * 1024);
      vi.mocked(validateImageMagicBytes).mockReturnValue({
        valid: true,
        detectedType: 'image/jpeg',
      });
      vi.mocked(uploadAvatar).mockResolvedValue({
        url: 'https://storage.example.com/avatars/user-123/avatar.jpg',
        key: 'avatars/user-123/avatar.jpg',
        size: 2048,
        width: 500,
        height: 500,
      });

      const { POST } = await import('@/app/api/v1/users/me/avatar/route');

      // Create file with valid characters
      const validFile = createMockFile(
        'fake image data',
        'my-avatar_2024.profile.jpg',
        'image/jpeg'
      );
      const request = createUploadRequest(validFile);

      await POST(request);

      // Assert: Valid characters preserved
      const logCall = vi
        .mocked(logger.info)
        .mock.calls.find((call) => call[0] === 'Avatar upload started');
      const loggedFileName = (logCall?.[1] as any)?.fileName;
      expect(loggedFileName).toBe('my-avatar_2024.profile.jpg');
    });
  });

  describe('DELETE /api/v1/users/me/avatar', () => {
    it('should return 401 when not authenticated', async () => {
      const { auth } = await import('@/lib/auth/config');

      vi.mocked(auth.api.getSession).mockResolvedValue(null as never);

      const { DELETE } = await import('@/app/api/v1/users/me/avatar/route');
      const request = createDeleteRequest();

      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
    });

    it('should successfully remove avatar', async () => {
      const { auth } = await import('@/lib/auth/config');
      const { isStorageEnabled, deleteByPrefix } = await import('@/lib/storage/upload');
      const { prisma } = await import('@/lib/db/client');

      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);
      vi.mocked(isStorageEnabled).mockReturnValue(true);
      vi.mocked(deleteByPrefix).mockResolvedValue({ success: true, key: `avatars/${userId}/` });
      vi.mocked(prisma.user.update).mockResolvedValue({} as never);

      const { DELETE } = await import('@/app/api/v1/users/me/avatar/route');
      const request = createDeleteRequest();

      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.message).toBe('Avatar removed');

      expect(deleteByPrefix).toHaveBeenCalledWith(`avatars/${userId}/`);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: userId },
        data: { image: null },
      });
    });

    it('should skip storage deletion when storage not enabled', async () => {
      const { auth } = await import('@/lib/auth/config');
      const { isStorageEnabled, deleteByPrefix } = await import('@/lib/storage/upload');
      const { prisma } = await import('@/lib/db/client');

      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);
      vi.mocked(isStorageEnabled).mockReturnValue(false);
      vi.mocked(prisma.user.update).mockResolvedValue({} as never);

      const { DELETE } = await import('@/app/api/v1/users/me/avatar/route');
      const request = createDeleteRequest();

      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(deleteByPrefix).not.toHaveBeenCalled();
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: userId },
        data: { image: null },
      });
    });
  });
});
