/**
 * Storage Provider Types
 *
 * Defines the interface and types for storage providers.
 * All providers (S3, Vercel Blob, Local) implement the StorageProvider interface.
 *
 * @see .context/storage/overview.md for architecture documentation
 */

/**
 * Options for uploading a file
 */
export interface UploadOptions {
  /** Storage key (path/filename in storage) */
  key: string;
  /** MIME type of the file */
  contentType: string;
  /** Optional metadata to store with the file */
  metadata?: Record<string, string>;
  /** Whether the file should be publicly accessible (default: true) */
  public?: boolean;
}

/**
 * Result of a successful upload
 */
export interface UploadResult {
  /** Storage key (path/filename in storage) */
  key: string;
  /** Public URL to access the file */
  url: string;
  /** Size of the uploaded file in bytes */
  size: number;
}

/**
 * Result of a delete operation
 */
export interface DeleteResult {
  /** Whether the deletion was successful */
  success: boolean;
  /** The key that was deleted */
  key: string;
}

/**
 * Storage Provider Interface
 *
 * All storage providers must implement this interface to ensure
 * consistent behavior across different storage backends.
 *
 * @example
 * ```typescript
 * const provider: StorageProvider = new S3Provider();
 * const result = await provider.upload(buffer, { key: 'avatars/123.jpg', contentType: 'image/jpeg' });
 * console.log(result.url); // https://bucket.s3.amazonaws.com/avatars/123.jpg
 * ```
 */
export interface StorageProvider {
  /** Provider name for logging and debugging */
  name: string;

  /**
   * Upload a file to storage
   *
   * @param file - File content as a Buffer
   * @param options - Upload options (key, contentType, etc.)
   * @returns Upload result with URL and metadata
   */
  upload(file: Buffer, options: UploadOptions): Promise<UploadResult>;

  /**
   * Delete a file from storage
   *
   * @param key - Storage key of the file to delete
   * @returns Delete result indicating success/failure
   */
  delete(key: string): Promise<DeleteResult>;

  /**
   * Generate a signed URL for private file access (optional)
   *
   * @param key - Storage key of the file
   * @param expiresIn - URL expiration time in seconds
   * @returns Signed URL with temporary access
   */
  getSignedUrl?(key: string, expiresIn: number): Promise<string>;
}

/**
 * Storage provider types
 */
export type StorageProviderType = 's3' | 'vercel-blob' | 'local';

/**
 * Configuration for storage providers
 */
export interface StorageConfig {
  provider: StorageProviderType;
  maxFileSizeMB: number;
}
