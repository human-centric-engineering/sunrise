import { describe, it, expect } from 'vitest';

import { validatePdfMagicBytes } from '@/lib/storage/image';

describe('validatePdfMagicBytes', () => {
  it('returns true for a buffer starting with %PDF-', () => {
    const buf = Buffer.from('%PDF-1.4\n%âãÏÓ\n...rest of pdf...');
    expect(validatePdfMagicBytes(buf)).toBe(true);
  });

  it('returns true for the minimum %PDF- header (5 bytes)', () => {
    const buf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect(validatePdfMagicBytes(buf)).toBe(true);
  });

  it('returns false for a buffer too short to contain the header', () => {
    const buf = Buffer.from([0x25, 0x50, 0x44, 0x46]); // 4 bytes, missing '-'
    expect(validatePdfMagicBytes(buf)).toBe(false);
  });

  it('returns false for an empty buffer', () => {
    expect(validatePdfMagicBytes(Buffer.alloc(0))).toBe(false);
  });

  it('returns false for a JPEG masquerading as a PDF', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    expect(validatePdfMagicBytes(jpeg)).toBe(false);
  });

  it('returns false for a PNG masquerading as a PDF', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]);
    expect(validatePdfMagicBytes(png)).toBe(false);
  });

  it('returns false when the %PDF- header is offset (not at byte 0)', () => {
    const buf = Buffer.from([0x00, 0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect(validatePdfMagicBytes(buf)).toBe(false);
  });

  it('returns false for an executable header (MZ — Windows PE)', () => {
    const exe = Buffer.from([0x4d, 0x5a, 0x00, 0x00, 0x00]);
    expect(validatePdfMagicBytes(exe)).toBe(false);
  });
});
