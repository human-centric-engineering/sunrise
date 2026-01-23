/**
 * Storage Validation Tests
 *
 * Tests the storage validation schemas for:
 * - File metadata validation
 * - Image file validation
 * - Avatar upload validation
 * - Configuration schemas (S3, Vercel Blob, Storage)
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/lib/validations/storage.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  fileMetadataSchema,
  imageFileSchema,
  avatarUploadSchema,
  storageConfigSchema,
  s3ConfigSchema,
  vercelBlobConfigSchema,
  getMaxFileSizeBytes,
  MAX_FILE_SIZE_BYTES,
} from '@/lib/validations/storage';

/**
 * Test Suite: Storage Validations
 */
describe('lib/validations/storage', () => {
  describe('getMaxFileSizeBytes', () => {
    const originalEnv = process.env.MAX_FILE_SIZE_MB;

    afterEach(() => {
      // Restore original env
      if (originalEnv !== undefined) {
        process.env.MAX_FILE_SIZE_MB = originalEnv;
      } else {
        delete process.env.MAX_FILE_SIZE_MB;
      }
    });

    it('should return default size when env not set', () => {
      // Arrange
      delete process.env.MAX_FILE_SIZE_MB;

      // Act
      const result = getMaxFileSizeBytes();

      // Assert
      expect(result).toBe(MAX_FILE_SIZE_BYTES);
      expect(result).toBe(5 * 1024 * 1024); // 5 MB
    });

    it('should return parsed size from environment variable', () => {
      // Arrange
      process.env.MAX_FILE_SIZE_MB = '10';

      // Act
      const result = getMaxFileSizeBytes();

      // Assert
      expect(result).toBe(10 * 1024 * 1024);
    });

    it('should return default when env value is invalid', () => {
      // Arrange
      process.env.MAX_FILE_SIZE_MB = 'invalid';

      // Act
      const result = getMaxFileSizeBytes();

      // Assert
      expect(result).toBe(MAX_FILE_SIZE_BYTES);
    });

    it('should return default when env value is negative', () => {
      // Arrange
      process.env.MAX_FILE_SIZE_MB = '-5';

      // Act
      const result = getMaxFileSizeBytes();

      // Assert
      expect(result).toBe(MAX_FILE_SIZE_BYTES);
    });

    it('should return default when env value is zero', () => {
      // Arrange
      process.env.MAX_FILE_SIZE_MB = '0';

      // Act
      const result = getMaxFileSizeBytes();

      // Assert
      expect(result).toBe(MAX_FILE_SIZE_BYTES);
    });

    it('should handle decimal values correctly', () => {
      // Arrange
      process.env.MAX_FILE_SIZE_MB = '2.5';

      // Act
      const result = getMaxFileSizeBytes();

      // Assert
      expect(result).toBe(2 * 1024 * 1024); // parseInt truncates to 2
    });
  });

  describe('fileMetadataSchema', () => {
    it('should validate file with valid metadata', () => {
      // Arrange
      const validFile = {
        name: 'test.jpg',
        size: 1024,
        type: 'image/jpeg',
      };

      // Act
      const result = fileMetadataSchema.safeParse(validFile);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(validFile);
      }
    });

    it('should reject file with empty name', () => {
      // Arrange
      const invalidFile = {
        name: '',
        size: 1024,
        type: 'image/jpeg',
      };

      // Act
      const result = fileMetadataSchema.safeParse(invalidFile);

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Filename is required');
      }
    });

    it('should reject file with missing name', () => {
      // Arrange
      const invalidFile = {
        size: 1024,
        type: 'image/jpeg',
      };

      // Act
      const result = fileMetadataSchema.safeParse(invalidFile);

      // Assert
      expect(result.success).toBe(false);
    });

    it('should reject file with zero size', () => {
      // Arrange
      const invalidFile = {
        name: 'test.jpg',
        size: 0,
        type: 'image/jpeg',
      };

      // Act
      const result = fileMetadataSchema.safeParse(invalidFile);

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('File size must be positive');
      }
    });

    it('should reject file with negative size', () => {
      // Arrange
      const invalidFile = {
        name: 'test.jpg',
        size: -100,
        type: 'image/jpeg',
      };

      // Act
      const result = fileMetadataSchema.safeParse(invalidFile);

      // Assert
      expect(result.success).toBe(false);
    });

    it('should reject file with empty type', () => {
      // Arrange
      const invalidFile = {
        name: 'test.jpg',
        size: 1024,
        type: '',
      };

      // Act
      const result = fileMetadataSchema.safeParse(invalidFile);

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('File type is required');
      }
    });

    it('should reject file with missing type', () => {
      // Arrange
      const invalidFile = {
        name: 'test.jpg',
        size: 1024,
      };

      // Act
      const result = fileMetadataSchema.safeParse(invalidFile);

      // Assert
      expect(result.success).toBe(false);
    });
  });

  describe('imageFileSchema', () => {
    it('should validate JPEG image', () => {
      // Arrange
      const validImage = {
        name: 'photo.jpg',
        size: 2048,
        type: 'image/jpeg',
      };

      // Act
      const result = imageFileSchema.safeParse(validImage);

      // Assert
      expect(result.success).toBe(true);
    });

    it('should validate PNG image', () => {
      // Arrange
      const validImage = {
        name: 'photo.png',
        size: 2048,
        type: 'image/png',
      };

      // Act
      const result = imageFileSchema.safeParse(validImage);

      // Assert
      expect(result.success).toBe(true);
    });

    it('should validate WebP image', () => {
      // Arrange
      const validImage = {
        name: 'photo.webp',
        size: 2048,
        type: 'image/webp',
      };

      // Act
      const result = imageFileSchema.safeParse(validImage);

      // Assert
      expect(result.success).toBe(true);
    });

    it('should validate GIF image', () => {
      // Arrange
      const validImage = {
        name: 'animation.gif',
        size: 2048,
        type: 'image/gif',
      };

      // Act
      const result = imageFileSchema.safeParse(validImage);

      // Assert
      expect(result.success).toBe(true);
    });

    it('should reject non-image file (PDF)', () => {
      // Arrange
      const invalidImage = {
        name: 'document.pdf',
        size: 2048,
        type: 'application/pdf',
      };

      // Act
      const result = imageFileSchema.safeParse(invalidImage);

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Unsupported image format');
        expect(result.error.issues[0].message).toContain('image/jpeg');
      }
    });

    it('should reject non-image file (text)', () => {
      // Arrange
      const invalidImage = {
        name: 'document.txt',
        size: 2048,
        type: 'text/plain',
      };

      // Act
      const result = imageFileSchema.safeParse(invalidImage);

      // Assert
      expect(result.success).toBe(false);
    });

    it('should reject unsupported image format (SVG)', () => {
      // Arrange
      const invalidImage = {
        name: 'icon.svg',
        size: 2048,
        type: 'image/svg+xml',
      };

      // Act
      const result = imageFileSchema.safeParse(invalidImage);

      // Assert
      expect(result.success).toBe(false);
    });

    it('should reject file with invalid metadata (empty name)', () => {
      // Arrange
      const invalidImage = {
        name: '',
        size: 2048,
        type: 'image/jpeg',
      };

      // Act
      const result = imageFileSchema.safeParse(invalidImage);

      // Assert
      expect(result.success).toBe(false);
    });
  });

  describe('avatarUploadSchema', () => {
    beforeEach(() => {
      delete process.env.MAX_FILE_SIZE_MB;
    });

    it('should validate avatar within size limit', () => {
      // Arrange
      const validAvatar = {
        file: {
          name: 'avatar.jpg',
          size: 1024 * 1024, // 1 MB
          type: 'image/jpeg',
        },
      };

      // Act
      const result = avatarUploadSchema.safeParse(validAvatar);

      // Assert
      expect(result.success).toBe(true);
    });

    it('should reject avatar exceeding default size limit', () => {
      // Arrange
      const largeAvatar = {
        file: {
          name: 'avatar.jpg',
          size: 6 * 1024 * 1024, // 6 MB (exceeds 5 MB default)
          type: 'image/jpeg',
        },
      };

      // Act
      const result = avatarUploadSchema.safeParse(largeAvatar);

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('File exceeds maximum size of 5MB');
      }
    });

    it('should respect custom max file size from environment', () => {
      // Arrange
      process.env.MAX_FILE_SIZE_MB = '10';

      const avatar = {
        file: {
          name: 'avatar.jpg',
          size: 8 * 1024 * 1024, // 8 MB
          type: 'image/jpeg',
        },
      };

      // Act
      const result = avatarUploadSchema.safeParse(avatar);

      // Assert
      expect(result.success).toBe(true); // Should pass with 10 MB limit
    });

    it('should reject avatar with invalid type', () => {
      // Arrange
      const invalidAvatar = {
        file: {
          name: 'document.pdf',
          size: 1024,
          type: 'application/pdf',
        },
      };

      // Act
      const result = avatarUploadSchema.safeParse(invalidAvatar);

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Unsupported image format');
      }
    });

    it('should validate avatar at exactly max size', () => {
      // Arrange
      const avatar = {
        file: {
          name: 'avatar.jpg',
          size: 5 * 1024 * 1024, // Exactly 5 MB
          type: 'image/jpeg',
        },
      };

      // Act
      const result = avatarUploadSchema.safeParse(avatar);

      // Assert
      expect(result.success).toBe(true);
    });

    it('should reject avatar at one byte over max size', () => {
      // Arrange
      const avatar = {
        file: {
          name: 'avatar.jpg',
          size: 5 * 1024 * 1024 + 1, // 5 MB + 1 byte
          type: 'image/jpeg',
        },
      };

      // Act
      const result = avatarUploadSchema.safeParse(avatar);

      // Assert
      expect(result.success).toBe(false);
    });
  });

  describe('storageConfigSchema', () => {
    it('should validate s3 provider', () => {
      // Arrange
      const config = {
        provider: 's3',
      };

      // Act
      const result = storageConfigSchema.safeParse(config);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.provider).toBe('s3');
      }
    });

    it('should validate vercel-blob provider', () => {
      // Arrange
      const config = {
        provider: 'vercel-blob',
      };

      // Act
      const result = storageConfigSchema.safeParse(config);

      // Assert
      expect(result.success).toBe(true);
    });

    it('should validate local provider', () => {
      // Arrange
      const config = {
        provider: 'local',
      };

      // Act
      const result = storageConfigSchema.safeParse(config);

      // Assert
      expect(result.success).toBe(true);
    });

    it('should validate empty config', () => {
      // Arrange
      const config = {};

      // Act
      const result = storageConfigSchema.safeParse(config);

      // Assert
      expect(result.success).toBe(true); // All fields are optional
    });

    it('should reject invalid provider', () => {
      // Arrange
      const config = {
        provider: 'azure',
      };

      // Act
      const result = storageConfigSchema.safeParse(config);

      // Assert
      expect(result.success).toBe(false);
    });

    it('should validate maxFileSizeMB as positive number', () => {
      // Arrange
      const config = {
        maxFileSizeMB: 10,
      };

      // Act
      const result = storageConfigSchema.safeParse(config);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.maxFileSizeMB).toBe(10);
      }
    });

    it('should coerce string to number for maxFileSizeMB', () => {
      // Arrange
      const config = {
        maxFileSizeMB: '15',
      };

      // Act
      const result = storageConfigSchema.safeParse(config);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.maxFileSizeMB).toBe(15);
      }
    });

    it('should reject negative maxFileSizeMB', () => {
      // Arrange
      const config = {
        maxFileSizeMB: -5,
      };

      // Act
      const result = storageConfigSchema.safeParse(config);

      // Assert
      expect(result.success).toBe(false);
    });

    it('should reject zero maxFileSizeMB', () => {
      // Arrange
      const config = {
        maxFileSizeMB: 0,
      };

      // Act
      const result = storageConfigSchema.safeParse(config);

      // Assert
      expect(result.success).toBe(false);
    });
  });

  describe('s3ConfigSchema', () => {
    it('should validate complete S3 config', () => {
      // Arrange
      const config = {
        bucket: 'my-bucket',
        region: 'us-west-2',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        endpoint: 'https://s3.us-west-2.amazonaws.com',
        publicUrlBase: 'https://cdn.example.com',
      };

      // Act
      const result = s3ConfigSchema.safeParse(config);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.bucket).toBe('my-bucket');
        expect(result.data.region).toBe('us-west-2');
      }
    });

    it('should use default region when not provided', () => {
      // Arrange
      const config = {
        bucket: 'my-bucket',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      };

      // Act
      const result = s3ConfigSchema.safeParse(config);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.region).toBe('us-east-1'); // Default value
      }
    });

    it('should validate minimal S3 config', () => {
      // Arrange
      const config = {
        bucket: 'my-bucket',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      };

      // Act
      const result = s3ConfigSchema.safeParse(config);

      // Assert
      expect(result.success).toBe(true);
    });

    it('should reject missing bucket', () => {
      // Arrange
      const config = {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      };

      // Act
      const result = s3ConfigSchema.safeParse(config);

      // Assert
      expect(result.success).toBe(false);
    });

    it('should reject empty bucket', () => {
      // Arrange
      const config = {
        bucket: '',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      };

      // Act
      const result = s3ConfigSchema.safeParse(config);

      // Assert
      expect(result.success).toBe(false);
    });

    it('should reject missing accessKeyId', () => {
      // Arrange
      const config = {
        bucket: 'my-bucket',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      };

      // Act
      const result = s3ConfigSchema.safeParse(config);

      // Assert
      expect(result.success).toBe(false);
    });

    it('should reject missing secretAccessKey', () => {
      // Arrange
      const config = {
        bucket: 'my-bucket',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      };

      // Act
      const result = s3ConfigSchema.safeParse(config);

      // Assert
      expect(result.success).toBe(false);
    });

    it('should reject invalid endpoint URL', () => {
      // Arrange
      const config = {
        bucket: 'my-bucket',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        endpoint: 'not-a-valid-url',
      };

      // Act
      const result = s3ConfigSchema.safeParse(config);

      // Assert
      expect(result.success).toBe(false);
    });

    it('should reject invalid publicUrlBase', () => {
      // Arrange
      const config = {
        bucket: 'my-bucket',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        publicUrlBase: 'invalid-url',
      };

      // Act
      const result = s3ConfigSchema.safeParse(config);

      // Assert
      expect(result.success).toBe(false);
    });
  });

  describe('vercelBlobConfigSchema', () => {
    it('should validate complete Vercel Blob config', () => {
      // Arrange
      const config = {
        token: 'vercel_blob_rw_ABC123XYZ789',
      };

      // Act
      const result = vercelBlobConfigSchema.safeParse(config);

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.token).toBe('vercel_blob_rw_ABC123XYZ789');
      }
    });

    it('should reject missing token', () => {
      // Arrange
      const config = {};

      // Act
      const result = vercelBlobConfigSchema.safeParse(config);

      // Assert
      expect(result.success).toBe(false);
    });

    it('should reject empty token', () => {
      // Arrange
      const config = {
        token: '',
      };

      // Act
      const result = vercelBlobConfigSchema.safeParse(config);

      // Assert
      expect(result.success).toBe(false);
    });
  });
});
