import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  chatAttachmentSchema,
  chatAttachmentsArraySchema,
  MAX_CHAT_ATTACHMENT_BASE64_CHARS,
  MAX_CHAT_ATTACHMENT_COMBINED_BASE64_CHARS,
} from '@/lib/validations/orchestration';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('chatAttachmentSchema', () => {
  it('accepts a minimal valid PNG attachment', () => {
    const result = chatAttachmentSchema.safeParse({
      name: 'screenshot.png',
      mediaType: 'image/png',
      data: TINY_PNG_BASE64,
    });
    expect(result.success).toBe(true);
  });

  it('accepts each documented MIME type', () => {
    const mimes = [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'application/pdf',
      'text/plain',
      'text/csv',
      'text/markdown',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    for (const mediaType of mimes) {
      const result = chatAttachmentSchema.safeParse({
        name: 'file',
        mediaType,
        data: TINY_PNG_BASE64,
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects unknown MIME types', () => {
    const result = chatAttachmentSchema.safeParse({
      name: 'evil.exe',
      mediaType: 'application/octet-stream',
      data: TINY_PNG_BASE64,
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty name', () => {
    const result = chatAttachmentSchema.safeParse({
      name: '',
      mediaType: 'image/png',
      data: TINY_PNG_BASE64,
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty data', () => {
    const result = chatAttachmentSchema.safeParse({
      name: 'screenshot.png',
      mediaType: 'image/png',
      data: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an attachment one byte over the per-attachment cap', () => {
    const oversize = 'A'.repeat(MAX_CHAT_ATTACHMENT_BASE64_CHARS + 1);
    const result = chatAttachmentSchema.safeParse({
      name: 'big.png',
      mediaType: 'image/png',
      data: oversize,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /5MB/i.test(i.message))).toBe(true);
    }
  });

  it('accepts an attachment exactly at the per-attachment cap', () => {
    const atCap = 'A'.repeat(MAX_CHAT_ATTACHMENT_BASE64_CHARS);
    const result = chatAttachmentSchema.safeParse({
      name: 'big.png',
      mediaType: 'image/png',
      data: atCap,
    });
    expect(result.success).toBe(true);
  });
});

describe('chatAttachmentsArraySchema', () => {
  it('accepts an empty array', () => {
    expect(chatAttachmentsArraySchema.safeParse([]).success).toBe(true);
  });

  it('accepts up to 10 attachments', () => {
    const tenAttachments = Array.from({ length: 10 }, (_, i) => ({
      name: `image-${i}.png`,
      mediaType: 'image/png' as const,
      data: TINY_PNG_BASE64,
    }));
    expect(chatAttachmentsArraySchema.safeParse(tenAttachments).success).toBe(true);
  });

  it('rejects more than 10 attachments', () => {
    const elevenAttachments = Array.from({ length: 11 }, (_, i) => ({
      name: `image-${i}.png`,
      mediaType: 'image/png' as const,
      data: TINY_PNG_BASE64,
    }));
    const result = chatAttachmentsArraySchema.safeParse(elevenAttachments);
    expect(result.success).toBe(false);
  });

  it('rejects when combined base64 size exceeds the per-turn cap', () => {
    // 6 attachments × 5MB-ish each = ~30MB combined; the cap is 25MB.
    const sixLarge = Array.from({ length: 6 }, (_, i) => ({
      name: `image-${i}.png`,
      mediaType: 'image/png' as const,
      // Just under the per-item cap so each attachment is individually
      // valid; the combined-size rule is what trips.
      data: 'A'.repeat(MAX_CHAT_ATTACHMENT_BASE64_CHARS - 1),
    }));
    const result = chatAttachmentsArraySchema.safeParse(sixLarge);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /Combined attachment size/i.test(i.message))).toBe(
        true
      );
    }
  });

  it('accepts a combined payload exactly at the per-turn cap', () => {
    // 5 attachments at exactly the per-item cap = 5 × 7.5M = 37.5M chars,
    // which is the combined cap.
    const fiveAtCap = Array.from({ length: 5 }, (_, i) => ({
      name: `image-${i}.png`,
      mediaType: 'image/png' as const,
      data: 'A'.repeat(MAX_CHAT_ATTACHMENT_BASE64_CHARS),
    }));
    const combined = fiveAtCap.reduce((sum, a) => sum + a.data.length, 0);
    expect(combined).toBe(MAX_CHAT_ATTACHMENT_COMBINED_BASE64_CHARS);
    expect(chatAttachmentsArraySchema.safeParse(fiveAtCap).success).toBe(true);
  });
});
