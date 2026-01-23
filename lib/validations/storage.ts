/**
 * Storage Validation Schemas
 *
 * Zod schemas for file upload validation.
 *
 * @see .context/storage/overview.md for documentation
 */

import { z } from 'zod';
import { SUPPORTED_IMAGE_TYPES } from '@/lib/storage/image';

/**
 * Default max file size (5 MB)
 */
export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * Get max file size from environment
 */
export function getMaxFileSizeBytes(): number {
  const maxSizeMB = process.env.MAX_FILE_SIZE_MB;
  if (maxSizeMB) {
    const parsed = parseInt(maxSizeMB, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed * 1024 * 1024;
    }
  }
  return MAX_FILE_SIZE_BYTES;
}

/**
 * File metadata schema for validation
 */
export const fileMetadataSchema = z.object({
  name: z.string().min(1, 'Filename is required'),
  size: z.number().positive('File size must be positive'),
  type: z.string().min(1, 'File type is required'),
});

/**
 * Image file validation schema
 *
 * Validates that the file appears to be an image based on MIME type.
 * Note: Server-side magic byte validation is still required.
 */
export const imageFileSchema = fileMetadataSchema.extend({
  type: z.enum(SUPPORTED_IMAGE_TYPES, {
    message: `Unsupported image format. Supported: ${SUPPORTED_IMAGE_TYPES.join(', ')}`,
  }),
});

/**
 * Avatar upload validation schema
 *
 * Validates file metadata before upload attempt.
 */
export const avatarUploadSchema = z.object({
  file: imageFileSchema.refine(
    (file) => file.size <= getMaxFileSizeBytes(),
    `File exceeds maximum size of ${Math.round(getMaxFileSizeBytes() / 1024 / 1024)}MB`
  ),
});

/**
 * Storage configuration schema (for environment validation)
 */
export const storageConfigSchema = z.object({
  provider: z.enum(['s3', 'vercel-blob', 'local']).optional(),
  maxFileSizeMB: z.coerce.number().positive().optional(),
});

/**
 * S3 configuration schema
 */
export const s3ConfigSchema = z.object({
  bucket: z.string().min(1, 'S3_BUCKET is required'),
  region: z.string().default('us-east-1'),
  accessKeyId: z.string().min(1, 'S3_ACCESS_KEY_ID is required'),
  secretAccessKey: z.string().min(1, 'S3_SECRET_ACCESS_KEY is required'),
  endpoint: z.string().url().optional(),
  publicUrlBase: z.string().url().optional(),
});

/**
 * Vercel Blob configuration schema
 */
export const vercelBlobConfigSchema = z.object({
  token: z.string().min(1, 'BLOB_READ_WRITE_TOKEN is required'),
});

/**
 * Type exports
 */
export type FileMetadata = z.infer<typeof fileMetadataSchema>;
export type ImageFile = z.infer<typeof imageFileSchema>;
export type AvatarUpload = z.infer<typeof avatarUploadSchema>;
export type StorageConfig = z.infer<typeof storageConfigSchema>;
export type S3Config = z.infer<typeof s3ConfigSchema>;
export type VercelBlobConfig = z.infer<typeof vercelBlobConfigSchema>;
