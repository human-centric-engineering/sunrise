/**
 * Image Processing Utilities
 *
 * Provides image validation and processing using Sharp.
 * Handles magic byte validation, resizing, and format conversion.
 *
 * @see .context/storage/overview.md for configuration documentation
 */

import sharp from 'sharp';
import { logger } from '@/lib/logging';

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

/**
 * Magic byte signatures for image types
 *
 * Used for server-side validation that doesn't trust client-provided MIME types.
 */
const MAGIC_BYTES: Record<SupportedImageType, number[][]> = {
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  'image/webp': [
    [0x52, 0x49, 0x46, 0x46], // RIFF header (WebP starts with RIFF....WEBP)
  ],
  'image/gif': [
    [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], // GIF87a
    [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], // GIF89a
  ],
};

/**
 * Image validation result
 */
export interface ImageValidationResult {
  valid: boolean;
  detectedType: SupportedImageType | null;
  error?: string;
}

/**
 * Validate image by checking magic bytes
 *
 * This provides server-side validation that doesn't trust client-provided MIME types.
 * Essential for security - prevents malicious file uploads disguised as images.
 *
 * @param buffer - Image file content
 * @returns Validation result with detected MIME type
 *
 * @example
 * ```typescript
 * const result = validateImageMagicBytes(buffer);
 * if (!result.valid) {
 *   throw new Error(result.error);
 * }
 * const mimeType = result.detectedType; // 'image/jpeg'
 * ```
 */
export function validateImageMagicBytes(buffer: Buffer): ImageValidationResult {
  if (buffer.length < 8) {
    return {
      valid: false,
      detectedType: null,
      error: 'File too small to be a valid image',
    };
  }

  // Check each supported type
  for (const [mimeType, signatures] of Object.entries(MAGIC_BYTES)) {
    for (const signature of signatures) {
      let matches = true;

      // Special handling for WebP (needs to check RIFF header + WEBP at offset 8)
      if (mimeType === 'image/webp') {
        // Check RIFF header
        for (let i = 0; i < signature.length; i++) {
          if (buffer[i] !== signature[i]) {
            matches = false;
            break;
          }
        }
        // Also verify WEBP signature at offset 8
        if (matches && buffer.length >= 12) {
          const webpSig = [0x57, 0x45, 0x42, 0x50]; // WEBP
          for (let i = 0; i < webpSig.length; i++) {
            if (buffer[8 + i] !== webpSig[i]) {
              matches = false;
              break;
            }
          }
        } else {
          matches = false;
        }
      } else {
        // Standard signature check
        for (let i = 0; i < signature.length; i++) {
          if (buffer[i] !== signature[i]) {
            matches = false;
            break;
          }
        }
      }

      if (matches) {
        return {
          valid: true,
          detectedType: mimeType as SupportedImageType,
        };
      }
    }
  }

  return {
    valid: false,
    detectedType: null,
    error: 'Invalid or unsupported image format',
  };
}

/**
 * Image processing options
 */
export interface ProcessImageOptions {
  /** Maximum width in pixels (default: 500) */
  maxWidth?: number;
  /** Maximum height in pixels (default: 500) */
  maxHeight?: number;
  /** Output quality 1-100 (default: 85) */
  quality?: number;
  /** Output format (default: keeps original format, but GIF converts to PNG) */
  format?: 'jpeg' | 'png' | 'webp';
}

/**
 * Processed image result
 */
export interface ProcessedImage {
  buffer: Buffer;
  mimeType: SupportedImageType;
  width: number;
  height: number;
}

/**
 * Process an image: validate, resize, and optimize
 *
 * - Validates the image using magic bytes
 * - Resizes if larger than max dimensions (preserves aspect ratio)
 * - Optimizes quality for smaller file size
 * - Converts GIF to PNG (Sharp has limited GIF support)
 *
 * @param buffer - Original image buffer
 * @param options - Processing options
 * @returns Processed image with metadata
 *
 * @example
 * ```typescript
 * const result = await processImage(buffer, { maxWidth: 500, maxHeight: 500 });
 * console.log(result.width, result.height); // Resized dimensions
 * ```
 */
export async function processImage(
  buffer: Buffer,
  options: ProcessImageOptions = {}
): Promise<ProcessedImage> {
  const { maxWidth = 500, maxHeight = 500, quality = 85 } = options;

  // Validate magic bytes first
  const validation = validateImageMagicBytes(buffer);
  if (!validation.valid || !validation.detectedType) {
    throw new Error(validation.error || 'Invalid image');
  }

  const detectedType = validation.detectedType;
  logger.debug('Processing image', { detectedType, originalSize: buffer.length });

  // Create Sharp instance
  let image = sharp(buffer);
  const metadata = await image.metadata();

  // Determine output format
  // Convert GIF to PNG (Sharp has limited animated GIF support)
  let outputFormat: 'jpeg' | 'png' | 'webp' = options.format || 'jpeg';
  if (!options.format) {
    switch (detectedType) {
      case 'image/jpeg':
        outputFormat = 'jpeg';
        break;
      case 'image/png':
        outputFormat = 'png';
        break;
      case 'image/webp':
        outputFormat = 'webp';
        break;
      case 'image/gif':
        outputFormat = 'png'; // Convert GIF to PNG
        break;
    }
  }

  // Resize if needed (only shrink, don't enlarge)
  const needsResize =
    (metadata.width && metadata.width > maxWidth) ||
    (metadata.height && metadata.height > maxHeight);

  if (needsResize) {
    image = image.resize(maxWidth, maxHeight, {
      fit: 'inside', // Maintain aspect ratio, fit within bounds
      withoutEnlargement: true, // Don't upscale small images
    });
  }

  // Apply format and quality
  switch (outputFormat) {
    case 'jpeg':
      image = image.jpeg({ quality, mozjpeg: true });
      break;
    case 'png':
      image = image.png({ quality, compressionLevel: 9 });
      break;
    case 'webp':
      image = image.webp({ quality });
      break;
  }

  // Process and get result
  const processedBuffer = await image.toBuffer();
  const processedMetadata = await sharp(processedBuffer).metadata();

  const outputMimeType: SupportedImageType = `image/${outputFormat}` as SupportedImageType;

  logger.debug('Image processed', {
    originalType: detectedType,
    outputType: outputMimeType,
    originalSize: buffer.length,
    processedSize: processedBuffer.length,
    width: processedMetadata.width,
    height: processedMetadata.height,
    wasResized: needsResize,
  });

  return {
    buffer: processedBuffer,
    mimeType: outputMimeType,
    width: processedMetadata.width || maxWidth,
    height: processedMetadata.height || maxHeight,
  };
}

/**
 * Get file extension for a MIME type
 */
export function getExtensionForMimeType(mimeType: SupportedImageType): string {
  return IMAGE_EXTENSIONS[mimeType] || 'bin';
}

/**
 * Check if a MIME type is a supported image type
 */
export function isSupportedImageType(mimeType: string): mimeType is SupportedImageType {
  return SUPPORTED_IMAGE_TYPES.includes(mimeType as SupportedImageType);
}
