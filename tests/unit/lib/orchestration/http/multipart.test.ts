/**
 * Tests for `lib/orchestration/http/multipart.ts`.
 *
 * Covers:
 *   - Schema acceptance for canonical shapes (files-only / files + fields).
 *   - Schema rejection for missing/empty fields, bad content types,
 *     too many parts, oversized base64.
 *   - Strict-base64 rejection in the builder (vs Zod's max-length).
 *   - Per-file decoded-size cap.
 *   - Total-body cap (sum of files + fields).
 *   - FormData assembly correctness — entry count, Blob types,
 *     filename defaults, field values.
 *   - Error code mapping per failure mode.
 */

import { describe, it, expect } from 'vitest';

import {
  ABSOLUTE_MAX_FILE_BASE64_LENGTH,
  MAX_FIELD_NAME_LENGTH,
  MAX_FIELD_PARTS,
  MAX_FIELD_VALUE_LENGTH,
  MAX_FILE_PARTS,
  MAX_TOTAL_MULTIPART_BYTES,
  MultipartError,
  buildMultipartBody,
  multipartShapeSchema,
} from '@/lib/orchestration/http/multipart';

const helloBase64 = Buffer.from('hello').toString('base64');
const pngBase64 = Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47])).toString('base64');

describe('multipartShapeSchema', () => {
  it('accepts a single file part', () => {
    const result = multipartShapeSchema.safeParse({
      files: [{ name: 'index.html', contentType: 'text/html', data: helloBase64 }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts files plus fields', () => {
    const result = multipartShapeSchema.safeParse({
      files: [{ name: 'doc.pdf', contentType: 'application/pdf', data: helloBase64 }],
      fields: { paperWidth: '8.5', paperHeight: '11' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty files array', () => {
    const result = multipartShapeSchema.safeParse({ files: [] });
    expect(result.success).toBe(false);
  });

  it('rejects missing name on a file part', () => {
    const result = multipartShapeSchema.safeParse({
      files: [{ contentType: 'text/html', data: helloBase64 }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects malformed contentType', () => {
    const result = multipartShapeSchema.safeParse({
      files: [{ name: 'x', contentType: 'not a mime type', data: helloBase64 }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than MAX_FILE_PARTS files', () => {
    const files = Array.from({ length: MAX_FILE_PARTS + 1 }, (_, i) => ({
      name: `f${i}`,
      contentType: 'text/plain',
      data: helloBase64,
    }));
    const result = multipartShapeSchema.safeParse({ files });
    expect(result.success).toBe(false);
  });

  it('rejects more than MAX_FIELD_PARTS fields via refine', () => {
    const fields: Record<string, string> = {};
    for (let i = 0; i < MAX_FIELD_PARTS + 1; i++) fields[`f${i}`] = String(i);
    const result = multipartShapeSchema.safeParse({
      files: [{ name: 'x', contentType: 'text/plain', data: helloBase64 }],
      fields,
    });
    expect(result.success).toBe(false);
  });

  it('rejects file data over ABSOLUTE_MAX_FILE_BASE64_LENGTH', () => {
    const oversized = 'A'.repeat(ABSOLUTE_MAX_FILE_BASE64_LENGTH + 1);
    const result = multipartShapeSchema.safeParse({
      files: [{ name: 'big', contentType: 'application/octet-stream', data: oversized }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown top-level keys (strict)', () => {
    const result = multipartShapeSchema.safeParse({
      files: [{ name: 'x', contentType: 'text/plain', data: helloBase64 }],
      extra: 'nope',
    });
    expect(result.success).toBe(false);
  });

  it('rejects field name longer than MAX_FIELD_NAME_LENGTH', () => {
    const longName = 'x'.repeat(MAX_FIELD_NAME_LENGTH + 1);
    const result = multipartShapeSchema.safeParse({
      files: [{ name: 'doc', contentType: 'text/plain', data: helloBase64 }],
      fields: { [longName]: 'value' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty field name', () => {
    const result = multipartShapeSchema.safeParse({
      files: [{ name: 'doc', contentType: 'text/plain', data: helloBase64 }],
      fields: { '': 'value' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects field value longer than MAX_FIELD_VALUE_LENGTH', () => {
    const oversized = 'a'.repeat(MAX_FIELD_VALUE_LENGTH + 1);
    const result = multipartShapeSchema.safeParse({
      files: [{ name: 'doc', contentType: 'text/plain', data: helloBase64 }],
      fields: { description: oversized },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a field value at exactly MAX_FIELD_VALUE_LENGTH', () => {
    const atCap = 'a'.repeat(MAX_FIELD_VALUE_LENGTH);
    const result = multipartShapeSchema.safeParse({
      files: [{ name: 'doc', contentType: 'text/plain', data: helloBase64 }],
      fields: { html: atCap },
    });
    expect(result.success).toBe(true);
  });
});

describe('buildMultipartBody', () => {
  it('returns a FormData with one file entry for a single file part', () => {
    const fd = buildMultipartBody({
      files: [{ name: 'index.html', contentType: 'text/html', data: helloBase64 }],
    });
    expect(fd).toBeInstanceOf(FormData);
    const entries = Array.from(fd.entries());
    expect(entries).toHaveLength(1);
    const [name, value] = entries[0];
    expect(name).toBe('index.html');
    expect(value).toBeInstanceOf(File); // Node FormData wraps Blob+filename as File
  });

  it('uses filename when supplied, falls back to name otherwise', () => {
    const fd = buildMultipartBody({
      files: [
        {
          name: 'with_filename',
          filename: 'custom.txt',
          contentType: 'text/plain',
          data: helloBase64,
        },
        { name: 'no_filename', contentType: 'text/plain', data: helloBase64 },
      ],
    });
    const files = Array.from(fd.entries()).map(([, v]) => v as File);
    expect(files[0].name).toBe('custom.txt');
    expect(files[1].name).toBe('no_filename');
  });

  it('preserves contentType on file blobs', () => {
    const fd = buildMultipartBody({
      files: [{ name: 'pic', contentType: 'image/png', data: pngBase64 }],
    });
    const file = Array.from(fd.entries())[0][1] as File;
    expect(file.type).toBe('image/png');
  });

  it('appends both file parts and field parts', () => {
    const fd = buildMultipartBody({
      files: [{ name: 'doc.pdf', contentType: 'application/pdf', data: helloBase64 }],
      fields: { paperWidth: '8.5', orientation: 'portrait' },
    });
    expect(fd.get('doc.pdf')).toBeInstanceOf(File);
    expect(fd.get('paperWidth')).toBe('8.5');
    expect(fd.get('orientation')).toBe('portrait');
  });

  it('round-trips file bytes correctly', async () => {
    const original = Buffer.from('round-trip me 123\n\xff\x00');
    const fd = buildMultipartBody({
      files: [
        { name: 'bin', contentType: 'application/octet-stream', data: original.toString('base64') },
      ],
    });
    const file = fd.get('bin') as File;
    const buffer = Buffer.from(await file.arrayBuffer());
    expect(buffer.equals(original)).toBe(true);
  });

  it('throws MultipartError("invalid_shape") on schema failure', () => {
    expect(() => buildMultipartBody({ files: [] })).toThrow(MultipartError);
    try {
      buildMultipartBody({ files: [] });
      expect.fail('expected throw');
    } catch (err) {
      expect((err as MultipartError).code).toBe('invalid_shape');
    }
  });

  it('throws MultipartError("invalid_base64") for non-base64 file data', () => {
    try {
      buildMultipartBody({
        files: [{ name: 'x', contentType: 'text/plain', data: 'not valid base64!!!!' }],
      });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MultipartError);
      expect((err as MultipartError).code).toBe('invalid_base64');
    }
  });

  it('rejects whitespace inside base64 (strict)', () => {
    try {
      buildMultipartBody({
        files: [{ name: 'x', contentType: 'text/plain', data: 'aGVs bG8=' }],
      });
      expect.fail('expected throw');
    } catch (err) {
      expect((err as MultipartError).code).toBe('invalid_base64');
    }
  });

  it('throws MultipartError("invalid_base64") when input decodes to zero bytes', () => {
    try {
      // Empty base64 input would fail Zod min(1) — but a single padding
      // char that decodes to nothing should hit our zero-byte guard.
      buildMultipartBody({
        files: [{ name: 'x', contentType: 'text/plain', data: '=' }],
      });
      expect.fail('expected throw');
    } catch (err) {
      expect((err as MultipartError).code).toBe('invalid_base64');
    }
  });

  it('throws MultipartError("body_too_large") when summed file bytes exceed the cap', () => {
    // 5 × 8 MB base64 ≈ 5 × 6 MB decoded = 30 MB — over the 25 MB
    // total cap. Strict regex requires real base64; build a buffer
    // of the right decoded size and re-encode for each part.
    const sixMb = Buffer.alloc(6 * 1024 * 1024, 0x41).toString('base64');
    try {
      buildMultipartBody({
        files: [
          { name: 'a', contentType: 'application/octet-stream', data: sixMb },
          { name: 'b', contentType: 'application/octet-stream', data: sixMb },
          { name: 'c', contentType: 'application/octet-stream', data: sixMb },
          { name: 'd', contentType: 'application/octet-stream', data: sixMb },
          { name: 'e', contentType: 'application/octet-stream', data: sixMb },
        ],
      });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MultipartError);
      expect((err as MultipartError).code).toBe('body_too_large');
    }
  });

  it('throws body_too_large from fields alone when their byte sum exceeds the cap', () => {
    // Exercise the early field-budget check (runs before any base64
    // decode). Each field is at the per-field cap; 30 fields × 1 MB
    // sums to ~30 MB > 25 MB total cap. Per-field cap means the
    // schema doesn't reject; the body-cap math fires inside the
    // builder.
    const oneMb = 'x'.repeat(MAX_FIELD_VALUE_LENGTH);
    const fields: Record<string, string> = {};
    for (let i = 0; i < 30; i++) fields[`f${i}`] = oneMb;
    try {
      buildMultipartBody({
        files: [{ name: 'small', contentType: 'text/plain', data: helloBase64 }],
        fields,
      });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MultipartError);
      expect((err as MultipartError).code).toBe('body_too_large');
    }
  });

  it('fails fast on the offending file rather than decoding everything first', () => {
    // Five 6 MB files: running totals 6/12/18/24/30. The 5th pushes
    // total over the 25 MB cap and triggers the throw — the 6th
    // (which would be wasted work) is never decoded. Each
    // individual file passes the schema's per-file cap.
    const sixMb = Buffer.alloc(6 * 1024 * 1024, 0x41).toString('base64');
    try {
      buildMultipartBody({
        files: [
          { name: 'first', contentType: 'application/octet-stream', data: sixMb },
          { name: 'second', contentType: 'application/octet-stream', data: sixMb },
          { name: 'third', contentType: 'application/octet-stream', data: sixMb },
          { name: 'fourth', contentType: 'application/octet-stream', data: sixMb },
          { name: 'fifth', contentType: 'application/octet-stream', data: sixMb },
          { name: 'sixth', contentType: 'application/octet-stream', data: sixMb },
        ],
      });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MultipartError);
      expect((err as MultipartError).code).toBe('body_too_large');
      // The error message names the file that pushed the total
      // over the cap; later files in the array were never decoded.
      expect((err as MultipartError).message).toContain('"fifth"');
      expect((err as MultipartError).message).not.toContain('"sixth"');
    }
  });

  it('exports MAX_TOTAL_MULTIPART_BYTES as a positive integer', () => {
    expect(MAX_TOTAL_MULTIPART_BYTES).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_TOTAL_MULTIPART_BYTES)).toBe(true);
  });
});
