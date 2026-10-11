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
 * Options for minting a signed URL
 */
export interface SignedUrlOptions {
  /**
   * The org the URL is minted for (§109 t-736). The org-bound client
   * (`lib/storage/org-scoped.ts`) passes it after checking the key is inside
   * that org.
   *
   * What a provider can do with it differs. A provider that ignores it still
   * compiles, but one that mints local-style tokens (`buildStorageAccessUrl`)
   * must forward it: minting refuses an org-owned key without its org, so
   * signing every org key would fail at runtime.
   * - **local** writes it into the token as the `org` claim, and the read
   *   route refuses a token whose claim does not match the key's prefix;
   * - **S3** cannot: a presigned URL is AWS's format and carries no claim of
   *   ours, so the org-bound client's check before signing is the only
   *   control.
   */
  orgId?: string;
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
 * An object read back out of storage
 */
export interface StorageObject {
  /** Storage key the object was read from */
  key: string;
  /** File content */
  body: Buffer;
  /** Size in bytes */
  size: number;
  /**
   * MIME type, when the backend recorded one. Providers that do not store
   * content type (the local filesystem) leave this undefined — the caller
   * knows what it wrote.
   */
  contentType?: string;
}

/**
 * What a storage provider can actually do
 *
 * `upload(buffer, { public: false })` means different things on different
 * backends: private on S3 (with ACLs or a private-by-default bucket),
 * impossible on Vercel Blob, and — before this contract existed — silently
 * ignored on local. Callers that care must ask before writing, rather than
 * sniffing `provider.name`.
 *
 * Read this through {@link getStorageCapabilities}, never off the provider
 * directly: the field is an optional `Partial<>` so that a fork's custom
 * provider (see `.context/storage/overview.md` → Extending) keeps compiling
 * across an upgrade, and an absent field means "cannot", not "unknown".
 */
export interface StorageCapabilities {
  /**
   * `upload(file, { public: false })` produces an object that is not
   * publicly readable. False means the option is accepted but cannot be
   * honoured — treat a `public: false` upload as unsafe.
   */
  privateObjects: boolean;
  /** `getSignedUrl()` is implemented and returns a working time-limited URL. */
  signedUrls: boolean;
  /** `download()` is implemented — a stored object can be read back as bytes. */
  download: boolean;
}

/**
 * The safe assumption for any capability a provider does not declare:
 * it cannot do it.
 */
export const DEFAULT_STORAGE_CAPABILITIES: StorageCapabilities = {
  privateObjects: false,
  signedUrls: false,
  download: false,
};

/**
 * Resolve a provider's full capability set, filling undeclared capabilities
 * with `false`.
 *
 * @example
 * ```typescript
 * const caps = getStorageCapabilities(storage);
 * if (!caps.privateObjects) {
 *   throw new Error(`${storage.name} cannot store private objects`);
 * }
 * ```
 */
export function getStorageCapabilities(provider: StorageProvider): StorageCapabilities {
  return { ...DEFAULT_STORAGE_CAPABILITIES, ...provider.capabilities };
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
   * What this provider can do. Optional: anything left undeclared is
   * assumed unsupported. Read it via {@link getStorageCapabilities}.
   */
  readonly capabilities?: Partial<StorageCapabilities>;

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
   * Delete all files under a key prefix
   *
   * Removes all objects matching the prefix (e.g., 'avatars/user-123/').
   * For local storage, also removes the directory itself.
   *
   * @param prefix - Key prefix to match (e.g., 'avatars/user-123/')
   * @returns Delete result indicating success/failure
   */
  deletePrefix(prefix: string): Promise<DeleteResult>;

  /**
   * Generate a signed URL for private file access (optional)
   *
   * @param key - Storage key of the file
   * @param expiresIn - URL expiration time in seconds
   * @param options - Who the URL is minted for; see {@link SignedUrlOptions}
   * @returns Signed URL with temporary access
   */
  getSignedUrl?(key: string, expiresIn: number, options?: SignedUrlOptions): Promise<string>;

  /**
   * Read an object back as bytes (optional)
   *
   * Buffer-based rather than streaming: every path in this codebase is
   * buffer-based behind a 5 MB default cap, so a stream would buy nothing
   * and cost SDK-type reconciliation across providers.
   *
   * Only call this when `getStorageCapabilities(provider).download` is
   * true.
   *
   * @param key - Storage key of the file
   * @returns The object's bytes and metadata
   * @throws If the object does not exist
   */
  download?(key: string): Promise<StorageObject>;
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
