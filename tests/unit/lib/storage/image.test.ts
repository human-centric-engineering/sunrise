import { describe, it, expect, vi, beforeEach } from 'vitest';

// Create a shared mock instance that will be reused for all calls
const mockSharpInstance = {
  metadata: vi.fn().mockResolvedValue({ width: 1000, height: 1000 }),
  resize: vi.fn().mockReturnThis(),
  jpeg: vi.fn().mockReturnThis(),
  png: vi.fn().mockReturnThis(),
  webp: vi.fn().mockReturnThis(),
  toBuffer: vi.fn().mockResolvedValue(Buffer.from('processed')),
};

// Mock sharp to return the same instance every time
vi.mock('sharp', () => {
  const mockSharp = vi.fn(() => mockSharpInstance);
  return { default: mockSharp };
});

vi.mock('@/lib/logging', () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

describe('lib/storage/image', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validateImageMagicBytes', () => {
    it('should detect JPEG images', async () => {
      const { validateImageMagicBytes } = await import('@/lib/storage/image');

      // JPEG magic bytes: FF D8 FF
      const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

      const result = validateImageMagicBytes(jpegBuffer);

      expect(result.valid).toBe(true);
      expect(result.detectedType).toBe('image/jpeg');
    });

    it('should detect PNG images', async () => {
      const { validateImageMagicBytes } = await import('@/lib/storage/image');

      // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
      const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

      const result = validateImageMagicBytes(pngBuffer);

      expect(result.valid).toBe(true);
      expect(result.detectedType).toBe('image/png');
    });

    it('should detect GIF87a images', async () => {
      const { validateImageMagicBytes } = await import('@/lib/storage/image');

      // GIF87a magic bytes: 47 49 46 38 37 61
      const gifBuffer = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x00, 0x00]);

      const result = validateImageMagicBytes(gifBuffer);

      expect(result.valid).toBe(true);
      expect(result.detectedType).toBe('image/gif');
    });

    it('should detect GIF89a images', async () => {
      const { validateImageMagicBytes } = await import('@/lib/storage/image');

      // GIF89a magic bytes: 47 49 46 38 39 61
      const gifBuffer = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00]);

      const result = validateImageMagicBytes(gifBuffer);

      expect(result.valid).toBe(true);
      expect(result.detectedType).toBe('image/gif');
    });

    it('should detect WebP images', async () => {
      const { validateImageMagicBytes } = await import('@/lib/storage/image');

      // WebP magic bytes: RIFF....WEBP (52 49 46 46 xx xx xx xx 57 45 42 50)
      const webpBuffer = Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      ]);

      const result = validateImageMagicBytes(webpBuffer);

      expect(result.valid).toBe(true);
      expect(result.detectedType).toBe('image/webp');
    });

    it('should reject non-image files', async () => {
      const { validateImageMagicBytes } = await import('@/lib/storage/image');

      // PDF magic bytes: 25 50 44 46 (PDF)
      const pdfBuffer = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

      const result = validateImageMagicBytes(pdfBuffer);

      expect(result.valid).toBe(false);
      expect(result.detectedType).toBeNull();
      expect(result.error).toBe('Invalid or unsupported image format');
    });

    it('should reject files that are too small', async () => {
      const { validateImageMagicBytes } = await import('@/lib/storage/image');

      const tinyBuffer = Buffer.from([0xff, 0xd8]);

      const result = validateImageMagicBytes(tinyBuffer);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('File too small to be a valid image');
    });

    it('should reject empty buffer', async () => {
      const { validateImageMagicBytes } = await import('@/lib/storage/image');

      const emptyBuffer = Buffer.alloc(0);

      const result = validateImageMagicBytes(emptyBuffer);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('File too small to be a valid image');
    });

    it('should reject truncated WebP (RIFF header but too short for WEBP signature)', async () => {
      const { validateImageMagicBytes } = await import('@/lib/storage/image');

      // RIFF header only, buffer too short to check WEBP at offset 8
      const truncatedWebP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00]);

      const result = validateImageMagicBytes(truncatedWebP);

      expect(result.valid).toBe(false);
      expect(result.detectedType).toBeNull();
    });

    it('should reject RIFF file with invalid WEBP signature', async () => {
      const { validateImageMagicBytes } = await import('@/lib/storage/image');

      // RIFF header but wrong signature at offset 8 (not 'WEBP')
      // This hits lines 107-108 where it checks each byte of the WEBP signature and sets matches = false
      const invalidWebP = Buffer.from([
        0x52,
        0x49,
        0x46,
        0x46, // RIFF
        0x00,
        0x00,
        0x00,
        0x00, // size
        0x58,
        0x58,
        0x58,
        0x58, // XXXX instead of WEBP
      ]);

      const result = validateImageMagicBytes(invalidWebP);

      expect(result.valid).toBe(false);
      expect(result.detectedType).toBeNull();
    });
  });

  describe('getExtensionForMimeType', () => {
    it('should return correct extensions for supported types', async () => {
      const { getExtensionForMimeType } = await import('@/lib/storage/image');

      expect(getExtensionForMimeType('image/jpeg')).toBe('jpg');
      expect(getExtensionForMimeType('image/png')).toBe('png');
      expect(getExtensionForMimeType('image/webp')).toBe('webp');
      expect(getExtensionForMimeType('image/gif')).toBe('gif');
    });
  });

  describe('isSupportedImageType', () => {
    it('should return true for supported types', async () => {
      const { isSupportedImageType } = await import('@/lib/storage/image');

      expect(isSupportedImageType('image/jpeg')).toBe(true);
      expect(isSupportedImageType('image/png')).toBe(true);
      expect(isSupportedImageType('image/webp')).toBe(true);
      expect(isSupportedImageType('image/gif')).toBe(true);
    });

    it('should return false for unsupported types', async () => {
      const { isSupportedImageType } = await import('@/lib/storage/image');

      expect(isSupportedImageType('image/svg+xml')).toBe(false);
      expect(isSupportedImageType('application/pdf')).toBe(false);
      expect(isSupportedImageType('text/plain')).toBe(false);
    });
  });

  describe('SUPPORTED_IMAGE_TYPES', () => {
    it('should contain all expected types', async () => {
      const { SUPPORTED_IMAGE_TYPES } = await import('@/lib/storage/image');

      expect(SUPPORTED_IMAGE_TYPES).toContain('image/jpeg');
      expect(SUPPORTED_IMAGE_TYPES).toContain('image/png');
      expect(SUPPORTED_IMAGE_TYPES).toContain('image/webp');
      expect(SUPPORTED_IMAGE_TYPES).toContain('image/gif');
      expect(SUPPORTED_IMAGE_TYPES).toHaveLength(4);
    });
  });

  describe('processImage', () => {
    it('should throw error for invalid image', async () => {
      const { processImage } = await import('@/lib/storage/image');

      // PDF magic bytes - not a valid image
      const pdfBuffer = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

      await expect(processImage(pdfBuffer)).rejects.toThrow('Invalid or unsupported image format');
    });

    it('should process JPEG image with default options', async () => {
      const sharp = (await import('sharp')).default;
      const { processImage } = await import('@/lib/storage/image');

      // JPEG magic bytes
      const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

      const result = await processImage(jpegBuffer);

      expect(result.buffer).toEqual(Buffer.from('processed'));
      expect(result.mimeType).toBe('image/jpeg');
      expect(sharp).toHaveBeenCalledWith(jpegBuffer);
    });

    it('should process PNG image and keep PNG format when no format specified', async () => {
      const { processImage } = await import('@/lib/storage/image');

      // PNG magic bytes
      const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

      const result = await processImage(pngBuffer);

      expect(result.mimeType).toBe('image/png');
    });

    it('should process WebP image and keep WebP format when no format specified', async () => {
      const { processImage } = await import('@/lib/storage/image');

      // WebP magic bytes: RIFF....WEBP
      const webpBuffer = Buffer.from([
        0x52,
        0x49,
        0x46,
        0x46, // RIFF
        0x00,
        0x00,
        0x00,
        0x00, // size
        0x57,
        0x45,
        0x42,
        0x50, // WEBP
      ]);

      const result = await processImage(webpBuffer);

      expect(result.mimeType).toBe('image/webp');
      expect(mockSharpInstance.webp).toHaveBeenCalled();
    });

    it('should convert GIF to PNG when no format specified', async () => {
      const { processImage } = await import('@/lib/storage/image');

      // GIF89a magic bytes
      const gifBuffer = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00]);

      const result = await processImage(gifBuffer);

      expect(result.mimeType).toBe('image/png');
    });

    it('should use specified format override', async () => {
      const { processImage } = await import('@/lib/storage/image');

      // JPEG magic bytes
      const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

      const result = await processImage(jpegBuffer, { format: 'webp' });

      expect(result.mimeType).toBe('image/webp');
    });

    it('should resize to square using cover fit and centre position', async () => {
      const { processImage } = await import('@/lib/storage/image');

      // JPEG magic bytes
      const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

      await processImage(jpegBuffer);

      expect(mockSharpInstance.resize).toHaveBeenCalledWith(500, 500, {
        fit: 'cover',
        position: 'centre',
      });
    });

    it('should use custom maxWidth/maxHeight options', async () => {
      const { processImage } = await import('@/lib/storage/image');

      // JPEG magic bytes
      const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

      await processImage(jpegBuffer, { maxWidth: 300, maxHeight: 300 });

      expect(mockSharpInstance.resize).toHaveBeenCalledWith(300, 300, {
        fit: 'cover',
        position: 'centre',
      });
    });

    it('should use custom quality option for JPEG', async () => {
      const { processImage } = await import('@/lib/storage/image');

      // JPEG magic bytes
      const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

      await processImage(jpegBuffer, { quality: 95 });

      expect(mockSharpInstance.jpeg).toHaveBeenCalledWith({ quality: 95, mozjpeg: true });
    });

    it('should return width and height from processed image metadata', async () => {
      const { processImage } = await import('@/lib/storage/image');

      // JPEG magic bytes
      const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

      const result = await processImage(jpegBuffer);

      // The mock metadata returns { width: 1000, height: 1000 }
      expect(result.width).toBe(1000);
      expect(result.height).toBe(1000);
    });

    it('should use maxWidth/maxHeight as fallback when processed metadata has no dimensions', async () => {
      const { processImage } = await import('@/lib/storage/image');

      // Mock the metadata to return dimensions for the first call (original image),
      // but no dimensions for the second call (processed image)
      mockSharpInstance.metadata
        .mockResolvedValueOnce({ width: 1000, height: 1000 }) // first call (original image)
        .mockResolvedValueOnce({}); // second call (processed image, no dimensions)

      // JPEG magic bytes
      const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

      const result = await processImage(jpegBuffer, { maxWidth: 300, maxHeight: 250 });

      // Should fall back to maxWidth/maxHeight
      expect(result.width).toBe(300);
      expect(result.height).toBe(250);
    });
  });
});
