/**
 * Storage Type Definitions
 *
 * TypeScript types for the file storage system.
 * Re-exports provider types and adds API-specific types.
 *
 * @see .context/storage/overview.md for documentation
 */

// Re-export provider types
export type {
  StorageProvider,
  StorageProviderType,
  StorageConfig,
  UploadOptions,
  UploadResult,
  DeleteResult,
} from '@/lib/storage/providers/types';

// Re-export image types
export type { SupportedImageType, ProcessedImage, ProcessImageOptions } from '@/lib/storage/image';

/**
 * Avatar upload request (client-side)
 *
 * Used when uploading via API from the client.
 */
export interface AvatarUploadRequest {
  /** The image file to upload */
  file: File;
}

/**
 * Avatar upload response (API response)
 */
export interface AvatarUploadResponse {
  /** Public URL of the uploaded avatar */
  url: string;
  /** Storage key for the file */
  key: string;
  /** File size in bytes */
  size: number;
  /** Image width in pixels */
  width: number;
  /** Image height in pixels */
  height: number;
}

/**
 * Avatar delete response
 */
export interface AvatarDeleteResponse {
  /** Whether the deletion was successful */
  success: boolean;
  /** Message describing the result */
  message: string;
}

/**
 * Storage status (for capability checks)
 */
export interface StorageStatus {
  /** Whether storage is enabled */
  enabled: boolean;
  /** Name of the active provider (or null if disabled) */
  provider: string | null;
  /** Maximum file size in bytes */
  maxFileSize: number;
  /** Supported image types */
  supportedTypes: string[];
}
