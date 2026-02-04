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
}
