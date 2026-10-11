/**
 * Storage Key Validation
 *
 * Validates storage keys to prevent path traversal and injection attacks.
 * Used by all storage providers before accepting a key for upload, delete,
 * or prefix operations.
 */

/**
 * Validate a storage key for safety.
 *
 * Rejects keys that could cause path traversal, injection, or other
 * filesystem/object-storage attacks.
 *
 * @param key - The storage key to validate
 * @throws Error if the key is invalid
 */
export function validateStorageKey(key: string): void {
  if (!key || key.trim().length === 0) {
    throw new Error('Storage key must not be empty');
  }

  // Reject path traversal
  if (key.includes('..')) {
    throw new Error('Storage key must not contain ".."');
  }

  // Reject absolute paths
  if (key.startsWith('/') || key.startsWith('\\')) {
    throw new Error('Storage key must not be an absolute path');
  }

  // Reject null bytes (can cause truncation in C-based file APIs)
  if (key.includes('\0')) {
    throw new Error('Storage key must not contain null bytes');
  }

  // Reject backslashes (normalize to forward slashes only)
  if (key.includes('\\')) {
    throw new Error('Storage key must not contain backslashes');
  }

  // Reject `.` and empty segments (a trailing `/` marks a prefix and is
  // fine). The local provider resolves keys as filesystem paths, so
  // `./orgs/b/x` or `a//b` would land somewhere other than the string says,
  // while every ownership rule (the `orgs/` root, an org's prefix) reads the
  // string (§109 t-736).
  // Vercel Blob is addressed by full URL, whose `://` is not a path segment:
  // check the URL's path instead.
  const segments = storagePathOf(key).split('/');
  const last = segments.length - 1;
  if (segments.some((segment, i) => segment === '.' || (segment === '' && i !== last))) {
    throw new Error('Storage key must not contain "." or empty path segments');
  }
}

/**
 * The path part of a storage key: the key itself, or for a full `http(s)` URL
 * (how Vercel Blob addresses an object) its pathname without the leading `/`.
 * Shared with the org-key guard (`lib/storage/org-scoped.ts`), which must
 * judge a URL-addressed object by the path it names, not by its scheme.
 */
export function storagePathOf(key: string): string {
  if (!/^https?:\/\//i.test(key)) return key;
  try {
    return decodeURIComponent(new URL(key).pathname).replace(/^\//, '');
  } catch {
    return key;
  }
}
