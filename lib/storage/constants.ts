/**
 * Storage Constants (client-safe)
 *
 * Constants that can be imported from both client and server components.
 * Separated from image.ts to avoid pulling in sharp (server-only) on the client.
 */

/**
 * Supported image MIME types
 */
export const SUPPORTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

/**
 * File extension mapping for MIME types
 */
export const IMAGE_EXTENSIONS: Record<SupportedImageType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
