/**
 * File Upload Utilities
 *
 * High-level upload/delete functions that wrap the storage provider.
 * Includes validation, processing, and error handling.
 *
 * @see .context/storage/overview.md for architecture documentation
 */

import { randomUUID } from 'crypto';
import { getStorageClient, isStorageEnabled } from './client';
import { processImage, getExtensionForMimeType, type ProcessImageOptions } from './image';
import type { UploadResult, DeleteResult } from './providers/types';
import { logger } from '@/lib/logging';

/**
 * Default maximum file size in bytes (5 MB)
 */
export const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024;

/**
 * Get configured max file size from environment
 */
export function getMaxFileSize(): number {
  const maxSizeMB = process.env.MAX_FILE_SIZE_MB;
  if (maxSizeMB) {
    const parsed = parseInt(maxSizeMB, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed * 1024 * 1024;
    }
  }
  return DEFAULT_MAX_FILE_SIZE;
}

/**
 * Avatar upload options
 */
export interface AvatarUploadOptions {
  /** User ID for organizing storage */
  userId: string;
  /** Maximum dimensions (default: 500x500) */
  maxWidth?: number;
  maxHeight?: number;
  /** Output quality (default: 85) */
  quality?: number;
}

/**
 * Avatar upload result
 */
export interface AvatarUploadResult extends UploadResult {
  /** Original filename */
  originalName?: string;
  /** Processed dimensions */
  width: number;
  height: number;
}

/**
 * Upload an avatar image
 *
 * Validates, processes (resize), and uploads an avatar image.
 * Generates a unique key to prevent filename collisions.
 *
 * @param file - Image file as Buffer
 * @param options - Upload options
 * @returns Upload result with URL and metadata
 *
 * @example
 * ```typescript
 * const result = await uploadAvatar(buffer, { userId: 'user-123' });
 * console.log(result.url); // https://storage.example.com/avatars/user-123/abc.jpg
 * ```
 */
export async function uploadAvatar(
  file: Buffer,
  options: AvatarUploadOptions
): Promise<AvatarUploadResult> {
  const { userId, maxWidth = 500, maxHeight = 500, quality = 85 } = options;

  // Check storage is enabled
  const storage = getStorageClient();
  if (!storage) {
    throw new Error('Storage is not configured');
  }

  // Validate file size
  const maxSize = getMaxFileSize();
  if (file.length > maxSize) {
    const maxSizeMB = Math.round(maxSize / (1024 * 1024));
    throw new Error(`File size exceeds maximum of ${maxSizeMB} MB`);
  }

  // Process image (validates, resizes, optimizes)
  const processOptions: ProcessImageOptions = {
    maxWidth,
    maxHeight,
    quality,
  };

  const processed = await processImage(file, processOptions);

  // Generate unique storage key
  const extension = getExtensionForMimeType(processed.mimeType);
  const uniqueId = randomUUID().slice(0, 8);
  const key = `avatars/${userId}/${uniqueId}.${extension}`;

  // Upload to storage
  const result = await storage.upload(processed.buffer, {
    key,
    contentType: processed.mimeType,
    metadata: {
      userId,
      uploadedAt: new Date().toISOString(),
    },
    public: true,
  });

  logger.info('Avatar uploaded', {
    userId,
    key: result.key,
    url: result.url,
    size: result.size,
    width: processed.width,
    height: processed.height,
  });

  return {
    ...result,
    width: processed.width,
    height: processed.height,
  };
}

/**
 * Delete a file from storage
 *
 * Handles both URL-based keys (Vercel Blob) and path-based keys (S3, Local).
 *
 * @param keyOrUrl - Storage key or full URL of the file
 * @returns Delete result
 *
 * @example
 * ```typescript
 * await deleteFile('avatars/user-123/abc.jpg');
 * // or
 * await deleteFile('https://storage.example.com/avatars/user-123/abc.jpg');
 * ```
 */
export async function deleteFile(keyOrUrl: string): Promise<DeleteResult> {
  const storage = getStorageClient();
  if (!storage) {
    logger.warn('Cannot delete file - storage not configured', { keyOrUrl });
    return { success: false, key: keyOrUrl };
  }

  // For Vercel Blob, we need to pass the full URL
  // For S3 and Local, we extract the key from the URL if needed
  let key = keyOrUrl;

  // If it's a full URL and not Vercel Blob, extract the path
  if (keyOrUrl.startsWith('http') && storage.name !== 'vercel-blob') {
    try {
      const url = new URL(keyOrUrl);
      // Remove leading slash
      key = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
    } catch {
      // Not a valid URL, use as-is
    }
  }

  const result = await storage.delete(key);

  if (result.success) {
    logger.info('File deleted', { key: result.key, provider: storage.name });
  } else {
    logger.warn('Failed to delete file', { key: result.key, provider: storage.name });
  }

  return result;
}

/**
 * Delete an avatar by extracting key from URL
 *
 * Convenience wrapper that handles URL-to-key conversion.
 *
 * @param avatarUrl - Avatar URL from the database
 * @returns Delete result
 */
export async function deleteAvatar(avatarUrl: string): Promise<DeleteResult> {
  return deleteFile(avatarUrl);
}

/**
 * Re-export storage status check
 */
export { isStorageEnabled };
