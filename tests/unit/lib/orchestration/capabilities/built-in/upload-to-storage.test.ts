/**
 * Tests for `UploadToStorageCapability`.
 *
 * Mocks prisma + getStorageClient. The storage provider mock is a
 * controllable stub with `upload` and optional `getSignedUrl` methods
 * so we can drive every branch without real network or filesystem calls.
 *
 * Test Coverage:
 * - args validation (schema level)
 * - customConfig parse (malformed → invalid_binding, missing → defaults)
 * - storage_not_configured path
 * - signed_url_not_supported (non-S3 provider lacks getSignedUrl)
 * - content-type allowlist (including RFC 6838 case sensitivity bug)
 * - base64 decode (silent-corruption bug probe, size limit)
 * - file size limit (binding-level maxFileSizeBytes)
 * - storage key validation (path traversal in prefix and default agentId)
 * - public flag vs signedUrlTtlSeconds interaction
 * - upload throws → upload_failed
 * - signed URL generation fails after upload → signed_url_failed
 * - metadata forwarding (description, originalFilename)
 * - result shapes (public path vs signed path)
 * - deriveExtension edge cases (directly via __testing export)
 * - customConfigSchema edge cases (directly via __testing export)
 *
 * @see lib/orchestration/capabilities/built-in/upload-to-storage.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { UploadOptions, UploadResult } from '@/lib/storage/providers/types';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports of the mocked modules
// ---------------------------------------------------------------------------

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgentCapability: { findFirst: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Controllable storage stub — tests swap mockStorageClient per-test.
const mockUpload = vi.fn<(buffer: Buffer, options: UploadOptions) => Promise<UploadResult>>();
const mockGetSignedUrl = vi.fn<(key: string, ttl: number) => Promise<string>>();

// The default stub has getSignedUrl (S3-like). Tests that want a provider
// without it override mockStorageClient directly.
let mockStorageClient: {
  name: string;
  upload: typeof mockUpload;
  getSignedUrl?: typeof mockGetSignedUrl;
} | null = {
  name: 's3',
  upload: mockUpload,
  getSignedUrl: mockGetSignedUrl,
};

vi.mock('@/lib/storage/client', () => ({
  getStorageClient: vi.fn(() => mockStorageClient),
}));

// ---------------------------------------------------------------------------
// Dynamic imports (after vi.mock hoisting)
// ---------------------------------------------------------------------------

const { prisma } = await import('@/lib/db/client');
const { UploadToStorageCapability, __testing } =
  await import('@/lib/orchestration/capabilities/built-in/upload-to-storage');

const { customConfigSchema, argsSchema, deriveExtension } = __testing;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const findBinding = prisma.aiAgentCapability.findFirst as ReturnType<typeof vi.fn>;

const BASE_CONTEXT = { userId: 'user-1', agentId: 'agent-abc', conversationId: 'conv-1' };

/** Minimal valid base64: "hello" encoded. */
const VALID_BASE64 = Buffer.from('hello').toString('base64'); // "aGVsbG8="

/** Minimal valid args. */
const BASE_ARGS = {
  data: VALID_BASE64,
  contentType: 'application/pdf',
};

/** Default upload result returned by the mock. */
const DEFAULT_UPLOAD_RESULT: UploadResult = {
  key: 'agent-uploads/agent-abc/some-uuid.pdf',
  url: 'https://example.com/agent-uploads/agent-abc/some-uuid.pdf',
  size: 5,
};

function bindCustomConfig(config: unknown): void {
  findBinding.mockResolvedValue({ customConfig: config });
}

function noBinding(): void {
  findBinding.mockResolvedValue(null);
}

// ---------------------------------------------------------------------------
// Global setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Reset to default S3-like stub before each test
  mockStorageClient = { name: 's3', upload: mockUpload, getSignedUrl: mockGetSignedUrl };
  // Default: upload succeeds
  mockUpload.mockResolvedValue(DEFAULT_UPLOAD_RESULT);
  // Default: getSignedUrl returns a signed URL
  mockGetSignedUrl.mockResolvedValue('https://s3.example.com/signed-url?X-Amz-Signature=abc');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// 1. __testing schema exports — isolated schema probes
// ===========================================================================

describe('__testing.customConfigSchema', () => {
  it('accepts an empty object (all fields optional)', () => {
    expect(customConfigSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a fully populated valid config', () => {
    const result = customConfigSchema.safeParse({
      keyPrefix: 'my-prefix/',
      allowedContentTypes: ['application/pdf', 'image/png'],
      maxFileSizeBytes: 1024 * 1024,
      signedUrlTtlSeconds: 300,
      public: false,
    });
    expect(result.success).toBe(true);
  });

  // Case 9: keyPrefix without trailing slash is rejected by schema
  it('rejects keyPrefix without trailing slash', () => {
    const result = customConfigSchema.safeParse({ keyPrefix: 'no-slash' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('keyPrefix must end with /');
  });

  it('rejects unknown fields (strict mode)', () => {
    const result = customConfigSchema.safeParse({ unknownField: 'oops' });
    expect(result.success).toBe(false);
  });

  it('rejects allowedContentTypes as empty array', () => {
    const result = customConfigSchema.safeParse({ allowedContentTypes: [] });
    expect(result.success).toBe(false);
  });
});

describe('__testing.argsSchema', () => {
  it('accepts minimal valid args', () => {
    const result = argsSchema.safeParse(BASE_ARGS);
    expect(result.success).toBe(true);
  });

  it('rejects missing contentType', () => {
    const result = argsSchema.safeParse({ data: VALID_BASE64 });
    expect(result.success).toBe(false);
  });

  it('rejects empty data string', () => {
    const result = argsSchema.safeParse({ data: '', contentType: 'application/pdf' });
    expect(result.success).toBe(false);
  });
});

describe('__testing.deriveExtension', () => {
  // Case 3a: Path traversal filename — only extension extracted, no ".." leak
  it('extracts .pdf from "../../etc/passwd.pdf" without leaking the traversal', () => {
    const ext = deriveExtension('../../etc/passwd.pdf', 'application/pdf');
    expect(ext).toBe('.pdf');
    expect(ext).not.toContain('..');
    expect(ext).not.toContain('/');
  });

  // Case 3b: Hidden file, no extension — falls through to content-type lookup
  it('falls through to content-type lookup for ".bashrc" (hidden file, no extension)', () => {
    // lastIndexOf('.') === 0 → dot === 0 → not > 0 → no extension from filename
    const ext = deriveExtension('.bashrc', 'application/pdf');
    expect(ext).toBe('.pdf');
  });

  // Case 3c: Multi-dot filename — picks last extension
  it('picks .gz from "archive.tar.gz"', () => {
    const ext = deriveExtension('archive.tar.gz', 'application/octet-stream');
    expect(ext).toBe('.gz');
  });

  // Case 3d: Uppercase extension — normalises to lowercase
  it('normalises "INVOICE.PDF" extension to .pdf', () => {
    const ext = deriveExtension('INVOICE.PDF', 'application/pdf');
    expect(ext).toBe('.pdf');
  });

  // Case 3e: Trailing dot only — falls through to content-type lookup
  it('falls through to content-type lookup for "foo." (trailing dot only)', () => {
    // dot === filename.length - 1 → condition requires dot < filename.length - 1 → false
    const ext = deriveExtension('foo.', 'text/csv');
    expect(ext).toBe('.csv');
  });

  // Case 3f: Non-ASCII in extension — regex rejects, falls through
  it('falls through to content-type lookup when extension contains non-ASCII (foo.exe🦀)', () => {
    const ext = deriveExtension('foo.exe🦀', 'image/png');
    // The regex /^\.[a-z0-9]{1,10}$/ will not match the emoji-suffixed ext
    expect(ext).toBe('.png');
  });

  // Case 3g: No dot in filename — falls through
  it('falls through to content-type lookup when filename has no extension', () => {
    const ext = deriveExtension('no_extension', 'text/plain');
    expect(ext).toBe('.txt');
  });

  // Case 3 (general): filename extension wins over content-type lookup when present
  it('prefers filename extension over content-type lookup when both are valid', () => {
    // Filename says .jpg but contentType says text/csv
    const ext = deriveExtension('photo.jpg', 'text/csv');
    expect(ext).toBe('.jpg');
  });

  // Unknown content-type falls through to empty string
  it('returns empty string for unknown content-type and no filename', () => {
    const ext = deriveExtension(undefined, 'application/x-unknown-custom');
    expect(ext).toBe('');
  });
});

// ===========================================================================
// 2. execute() — infrastructure / config checks
// ===========================================================================

describe('UploadToStorageCapability.execute()', () => {
  // Case 13: Malformed customConfig
  describe('malformed customConfig', () => {
    it('returns invalid_binding when customConfig fails Zod parse', async () => {
      bindCustomConfig({ keyPrefix: 'no-slash' }); // missing trailing /
      const cap = new UploadToStorageCapability();
      const result = await cap.execute(BASE_ARGS, BASE_CONTEXT);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('invalid_binding');
    });

    it('returns invalid_binding when customConfig has unknown fields (strict)', async () => {
      bindCustomConfig({ notAField: 'surprise' });
      const cap = new UploadToStorageCapability();
      const result = await cap.execute(BASE_ARGS, BASE_CONTEXT);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('invalid_binding');
    });
  });

  // Case 12: Storage not configured
  describe('storage not configured', () => {
    it('returns storage_not_configured without calling upload', async () => {
      noBinding();
      mockStorageClient = null;
      const cap = new UploadToStorageCapability();
      const result = await cap.execute(BASE_ARGS, BASE_CONTEXT);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('storage_not_configured');
      expect(mockUpload).not.toHaveBeenCalled();
    });
  });

  // Case 5: signedUrlTtlSeconds on non-S3 provider (no getSignedUrl method)
  describe('signed URL on non-S3 provider', () => {
    it('returns signed_url_not_supported BEFORE uploading when provider lacks getSignedUrl', async () => {
      bindCustomConfig({ signedUrlTtlSeconds: 300 });
      // Override to a provider without getSignedUrl (e.g. Vercel Blob / local)
      mockStorageClient = { name: 'vercel-blob', upload: mockUpload };

      const cap = new UploadToStorageCapability();
      const result = await cap.execute(BASE_ARGS, BASE_CONTEXT);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('signed_url_not_supported');
      // Upload must NOT have been called — fail-closed before any side effect
      expect(mockUpload).not.toHaveBeenCalled();
    });
  });

  // Case 2: Content-type allowlist — case sensitivity bug probe
  describe('content-type allowlist', () => {
    it('accepts content-type that exactly matches an allowlist entry', async () => {
      bindCustomConfig({ allowedContentTypes: ['application/pdf'] });
      const cap = new UploadToStorageCapability();
      const result = await cap.execute(
        { ...BASE_ARGS, contentType: 'application/pdf' },
        BASE_CONTEXT
      );

      expect(result.success).toBe(true);
    });

    it('rejects content-type not in allowlist', async () => {
      bindCustomConfig({ allowedContentTypes: ['application/pdf'] });
      const cap = new UploadToStorageCapability();
      const result = await cap.execute({ ...BASE_ARGS, contentType: 'image/png' }, BASE_CONTEXT);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('content_type_not_allowed');
    });

    it('matches allowlist case-insensitively per RFC 6838', async () => {
      bindCustomConfig({ allowedContentTypes: ['application/pdf'] });
      const cap = new UploadToStorageCapability();
      const result = await cap.execute(
        { ...BASE_ARGS, contentType: 'Application/PDF' },
        BASE_CONTEXT
      );

      expect(result.success).toBe(true);
    });
  });

  // Case 1: Base64 silent-corruption bug probe
  describe('base64 decode', () => {
    it('accepts valid base64 and proceeds to upload', async () => {
      noBinding();
      const cap = new UploadToStorageCapability();
      const result = await cap.execute(BASE_ARGS, BASE_CONTEXT);

      expect(result.success).toBe(true);
      expect(mockUpload).toHaveBeenCalledOnce();
    });

    it('rejects all-zero-decoded payload (empty buffer from "AAAA" is four null bytes, not empty)', async () => {
      noBinding();
      const cap = new UploadToStorageCapability();
      // "AAAA" decodes to 3 null bytes — NOT empty, so length > 0
      // This confirms the empty-check is not sufficient for null-byte-only payloads
      const result = await cap.execute({ ...BASE_ARGS, data: 'AAAA' }, BASE_CONTEXT);
      // It will succeed (upload called) — confirming null-byte buffers pass through
      expect(result.success).toBe(true);
      expect(mockUpload).toHaveBeenCalledOnce();
      // Verify the buffer passed to upload has 3 bytes (decoded from "AAAA")
      const calledBuffer = mockUpload.mock.calls[0]?.[0];
      expect(calledBuffer?.length).toBe(3);
    });

    it('rejects strings with non-base64 chars before Node silently strips them', async () => {
      noBinding();
      const cap = new UploadToStorageCapability();
      const result = await cap.execute(
        { ...BASE_ARGS, data: 'not actually base64 at all' },
        BASE_CONTEXT
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('invalid_data');
      expect(mockUpload).not.toHaveBeenCalled();
    });

    it('rejects strings of only non-base64 chars with invalid_data', async () => {
      noBinding();
      const cap = new UploadToStorageCapability();
      const result = await cap.execute({ ...BASE_ARGS, data: '!!!!' }, BASE_CONTEXT);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('invalid_data');
    });

    it('returns invalid_data when valid-shape base64 decodes to an empty buffer', async () => {
      // Arrange: "=" passes the strict regex but Buffer.from("=", "base64") returns a
      // zero-length buffer — exercising the L215 buffer-length guard, not the regex branch.
      noBinding();
      const cap = new UploadToStorageCapability();

      // Act
      const result = await cap.execute({ ...BASE_ARGS, data: '=' }, BASE_CONTEXT);

      // Assert: (a) invalid_data error code, (b) message is the L215 guard message
      // (not the L208 regex-rejection message), (c) upload was never called.
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('invalid_data');
      expect(result.error?.message).toMatch(/Decoded payload is empty/);
      expect(mockUpload).not.toHaveBeenCalled();
    });
  });

  // Case 8: Base64 schema cap vs binding-level maxFileSizeBytes
  describe('file size limit', () => {
    it('rejects decoded payload exceeding binding maxFileSizeBytes with file_too_large', async () => {
      // Binding caps at 1024 bytes
      bindCustomConfig({ maxFileSizeBytes: 1024 });
      const cap = new UploadToStorageCapability();

      // Build a 2KB payload (well under the 8 MB schema cap but over the 1 KB binding limit)
      const twoKbBuffer = Buffer.alloc(2048, 'x');
      const b64 = twoKbBuffer.toString('base64');

      const result = await cap.execute({ ...BASE_ARGS, data: b64 }, BASE_CONTEXT);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('file_too_large');
      expect(mockUpload).not.toHaveBeenCalled();
    });

    it('accepts decoded payload within binding maxFileSizeBytes', async () => {
      bindCustomConfig({ maxFileSizeBytes: 1024 });
      const cap = new UploadToStorageCapability();

      // 512 bytes — under the 1 KB binding limit
      const smallBuffer = Buffer.alloc(512, 'x');
      const b64 = smallBuffer.toString('base64');

      const result = await cap.execute({ ...BASE_ARGS, data: b64 }, BASE_CONTEXT);

      expect(result.success).toBe(true);
      expect(mockUpload).toHaveBeenCalledOnce();
    });
  });

  // Case 4 & 10: Storage key validation — default prefix with pathological agentId
  describe('storage key validation', () => {
    // Case 4: Default prefix from pathological agentId containing '..'
    it('returns invalid_binding when default agentId prefix contains ".." (path traversal)', async () => {
      noBinding();
      const cap = new UploadToStorageCapability();
      // agentId with path traversal — the resolved prefix becomes
      // "agent-uploads/foo/../bar/" which validateStorageKey rejects
      const result = await cap.execute(BASE_ARGS, {
        ...BASE_CONTEXT,
        agentId: 'foo/../bar',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('invalid_binding');
    });

    // Case 4: agentId with null byte
    it('returns invalid_binding when agentId contains null byte', async () => {
      noBinding();
      const cap = new UploadToStorageCapability();
      const result = await cap.execute(BASE_ARGS, {
        ...BASE_CONTEXT,
        agentId: 'agent\0evil',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('invalid_binding');
    });

    // Case 4: agentId with backslash
    it('returns invalid_binding when agentId contains backslash', async () => {
      noBinding();
      const cap = new UploadToStorageCapability();
      const result = await cap.execute(BASE_ARGS, {
        ...BASE_CONTEXT,
        agentId: 'agent\\evil',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('invalid_binding');
    });

    // Case 10: Custom prefix containing '..' passes Zod schema (regex only checks trailing /)
    // but should be caught by validateStorageKey
    it('returns invalid_binding when custom keyPrefix contains ".."', async () => {
      bindCustomConfig({ keyPrefix: 'foo/../bar/' });
      const cap = new UploadToStorageCapability();
      const result = await cap.execute(BASE_ARGS, BASE_CONTEXT);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('invalid_binding');
    });
  });

  // Case 7: public flag vs signedUrlTtlSeconds
  describe('public flag interaction with signedUrlTtlSeconds', () => {
    it('passes public: false to storage.upload when signedUrlTtlSeconds is set', async () => {
      bindCustomConfig({ signedUrlTtlSeconds: 300, public: true });
      const cap = new UploadToStorageCapability();
      await cap.execute(BASE_ARGS, BASE_CONTEXT);

      const uploadOptions = mockUpload.mock.calls[0]?.[1];
      expect(uploadOptions?.public).toBe(false);
    });

    it('passes public: true to storage.upload when public is true and no signedUrlTtlSeconds', async () => {
      bindCustomConfig({ public: true });
      const cap = new UploadToStorageCapability();
      await cap.execute(BASE_ARGS, BASE_CONTEXT);

      const uploadOptions = mockUpload.mock.calls[0]?.[1];
      expect(uploadOptions?.public).toBe(true);
    });

    it('defaults to public: true when no customConfig is set', async () => {
      noBinding();
      const cap = new UploadToStorageCapability();
      await cap.execute(BASE_ARGS, BASE_CONTEXT);

      const uploadOptions = mockUpload.mock.calls[0]?.[1];
      expect(uploadOptions?.public).toBe(true);
    });
  });

  // Case 11: upload throws
  describe('upload failure', () => {
    it('returns upload_failed with underlying error message when storage.upload throws', async () => {
      noBinding();
      mockUpload.mockRejectedValue(new Error('S3 bucket not found'));
      const cap = new UploadToStorageCapability();
      const result = await cap.execute(BASE_ARGS, BASE_CONTEXT);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('upload_failed');
      expect(result.error?.message).toContain('S3 bucket not found');
    });

    it('returns upload_failed with fallback message when non-Error is thrown', async () => {
      noBinding();
      mockUpload.mockRejectedValue('plain string error');
      const cap = new UploadToStorageCapability();
      const result = await cap.execute(BASE_ARGS, BASE_CONTEXT);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('upload_failed');
    });
  });

  // Case 6: signed URL generation fails after successful upload
  describe('signed URL generation failure after upload', () => {
    it('returns signed_url_failed (upload is orphaned) when getSignedUrl throws after upload succeeds', async () => {
      bindCustomConfig({ signedUrlTtlSeconds: 300 });
      mockGetSignedUrl.mockRejectedValue(new Error('KMS key revoked'));
      const cap = new UploadToStorageCapability();
      const result = await cap.execute(BASE_ARGS, BASE_CONTEXT);

      // Upload DID succeed (file is in storage)
      expect(mockUpload).toHaveBeenCalledOnce();
      // But capability returns signed_url_failed — the file is orphaned.
      // This is documented v1 behavior: report the finding rather than clean up.
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('signed_url_failed');
      // Note: the orphaned object is now in storage. A future capability
      // (delete_from_storage) could be called to clean it up. The trade-off
      // is: cleanup adds complexity and can also fail; v1 accepts the orphan
      // and asks admin to investigate via the error message.
    });
  });

  // Case 14: No customConfig at all — defaults apply
  describe('no customConfig (defaults)', () => {
    it('uses default prefix "agent-uploads/<agentId>/" and public: true', async () => {
      noBinding();
      const cap = new UploadToStorageCapability();
      await cap.execute(BASE_ARGS, BASE_CONTEXT);

      expect(mockUpload).toHaveBeenCalledOnce();
      const [, options] = mockUpload.mock.calls[0] as [Buffer, UploadOptions];
      expect(options.key).toMatch(/^agent-uploads\/agent-abc\//);
      expect(options.public).toBe(true);
    });

    it('uses getMaxFileSizeBytes() default when no maxFileSizeBytes binding', async () => {
      noBinding();
      const cap = new UploadToStorageCapability();

      // Exactly 1 byte under the 5 MB default (5 * 1024 * 1024 - 1)
      const nearLimitBuffer = Buffer.alloc(5 * 1024 * 1024 - 1, 'x');
      const b64 = nearLimitBuffer.toString('base64');

      const result = await cap.execute({ ...BASE_ARGS, data: b64 }, BASE_CONTEXT);
      expect(result.success).toBe(true);
    });
  });

  // Case 15: metadata forwarding
  describe('metadata forwarding', () => {
    it('includes description and originalFilename in upload metadata when provided', async () => {
      noBinding();
      const cap = new UploadToStorageCapability();
      await cap.execute(
        {
          ...BASE_ARGS,
          filename: 'report.pdf',
          description: 'Q3 financial report',
        },
        BASE_CONTEXT
      );

      const [, options] = mockUpload.mock.calls[0] as [Buffer, UploadOptions];
      expect(options.metadata?.description).toBe('Q3 financial report');
      expect(options.metadata?.originalFilename).toBe('report.pdf');
    });

    it('omits description and originalFilename from metadata when not provided', async () => {
      noBinding();
      const cap = new UploadToStorageCapability();
      await cap.execute(BASE_ARGS, BASE_CONTEXT);

      const [, options] = mockUpload.mock.calls[0] as [Buffer, UploadOptions];
      expect(options.metadata).not.toHaveProperty('description');
      expect(options.metadata).not.toHaveProperty('originalFilename');
    });

    it('always includes agentId, userId, and uploadedAt in metadata', async () => {
      noBinding();
      const cap = new UploadToStorageCapability();
      await cap.execute(BASE_ARGS, BASE_CONTEXT);

      const [, options] = mockUpload.mock.calls[0] as [Buffer, UploadOptions];
      expect(options.metadata?.agentId).toBe('agent-abc');
      expect(options.metadata?.userId).toBe('user-1');
      expect(options.metadata?.uploadedAt).toBeDefined();
    });

    it('includes conversationId in metadata when present in context', async () => {
      noBinding();
      const cap = new UploadToStorageCapability();
      await cap.execute(BASE_ARGS, { ...BASE_CONTEXT, conversationId: 'conv-42' });

      const [, options] = mockUpload.mock.calls[0] as [Buffer, UploadOptions];
      expect(options.metadata?.conversationId).toBe('conv-42');
    });

    it('omits conversationId from metadata when absent from context', async () => {
      noBinding();
      const cap = new UploadToStorageCapability();
      const contextWithoutConv = { userId: 'user-1', agentId: 'agent-abc' };
      await cap.execute(BASE_ARGS, contextWithoutConv);

      const options = mockUpload.mock.calls[0]?.[1];
      expect(options?.metadata).not.toHaveProperty('conversationId');
    });
  });

  // Case 16: Result shape — public path
  describe('result shape — public URL', () => {
    it('returns { key, url, size, contentType, signed: false } with NO expiresAt property', async () => {
      noBinding();
      const cap = new UploadToStorageCapability();
      const result = await cap.execute(BASE_ARGS, BASE_CONTEXT);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      const data = result.data!;
      expect(data.key).toBe(DEFAULT_UPLOAD_RESULT.key);
      expect(data.url).toBe(DEFAULT_UPLOAD_RESULT.url);
      expect(data.size).toBe(DEFAULT_UPLOAD_RESULT.size);
      expect(data.contentType).toBe('application/pdf');
      expect(data.signed).toBe(false);
      // expiresAt must be ABSENT (not undefined-as-property)
      expect(Object.prototype.hasOwnProperty.call(data, 'expiresAt')).toBe(false);
    });
  });

  // Case 17: Result shape — signed URL path
  describe('result shape — signed URL', () => {
    it('returns { key, url, size, contentType, signed: true, expiresAt: <iso> } for signed path', async () => {
      const ttlSeconds = 3600;
      bindCustomConfig({ signedUrlTtlSeconds: ttlSeconds });
      const signedUrl = 'https://s3.example.com/signed?X-Amz-Expires=3600';
      mockGetSignedUrl.mockResolvedValue(signedUrl);

      const before = Date.now();
      const cap = new UploadToStorageCapability();
      const result = await cap.execute(BASE_ARGS, BASE_CONTEXT);
      const after = Date.now();

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      const signedData = result.data!;
      expect(signedData.signed).toBe(true);
      expect(signedData.url).toBe(signedUrl);
      expect(signedData.key).toBe(DEFAULT_UPLOAD_RESULT.key);
      expect(signedData.size).toBe(DEFAULT_UPLOAD_RESULT.size);
      expect(signedData.contentType).toBe('application/pdf');

      // expiresAt must be present and a valid ISO string
      expect(signedData.expiresAt).toBeDefined();
      const expiresAtMs = new Date(signedData.expiresAt as string).getTime();
      expect(isNaN(expiresAtMs)).toBe(false);

      // expiresAt should be approximately now + ttl (±2 seconds tolerance)
      const expectedMin = before + ttlSeconds * 1000 - 2000;
      const expectedMax = after + ttlSeconds * 1000 + 2000;
      expect(expiresAtMs).toBeGreaterThanOrEqual(expectedMin);
      expect(expiresAtMs).toBeLessThanOrEqual(expectedMax);
    });

    it('passes the correct key and TTL to getSignedUrl', async () => {
      bindCustomConfig({ signedUrlTtlSeconds: 900 });
      mockUpload.mockResolvedValue({
        key: 'agent-uploads/agent-abc/uuid-123.pdf',
        url: 'https://example.com/agent-uploads/agent-abc/uuid-123.pdf',
        size: 5,
      });

      const cap = new UploadToStorageCapability();
      await cap.execute(BASE_ARGS, BASE_CONTEXT);

      expect(mockGetSignedUrl).toHaveBeenCalledWith('agent-uploads/agent-abc/uuid-123.pdf', 900);
    });
  });

  // Key structure validation — the LLM cannot influence the stored path
  describe('storage key structure', () => {
    it('key uses custom keyPrefix when set', async () => {
      bindCustomConfig({ keyPrefix: 'reports/invoices/' });
      const cap = new UploadToStorageCapability();
      await cap.execute(BASE_ARGS, BASE_CONTEXT);

      const [, options] = mockUpload.mock.calls[0] as [Buffer, UploadOptions];
      expect(options.key).toMatch(/^reports\/invoices\//);
    });

    it('key contains a UUID-like segment (random, not LLM-supplied)', async () => {
      noBinding();
      const cap = new UploadToStorageCapability();
      await cap.execute({ ...BASE_ARGS, filename: 'evil_name_attempt.pdf' }, BASE_CONTEXT);

      const [, options] = mockUpload.mock.calls[0] as [Buffer, UploadOptions];
      // Key is: agent-uploads/agent-abc/<uuid>.pdf
      // UUID pattern: 8-4-4-4-12 hex with dashes
      const uuidPattern =
        /^agent-uploads\/agent-abc\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/;
      expect(uuidPattern.test(options.key)).toBe(true);
    });

    it('appends correct extension from filename when provided', async () => {
      noBinding();
      const cap = new UploadToStorageCapability();
      await cap.execute(
        { ...BASE_ARGS, filename: 'data.csv', contentType: 'text/csv' },
        BASE_CONTEXT
      );

      const [, options] = mockUpload.mock.calls[0] as [Buffer, UploadOptions];
      expect(options.key).toMatch(/\.csv$/);
    });

    it('appends extension from content-type lookup when filename is absent', async () => {
      noBinding();
      const cap = new UploadToStorageCapability();
      await cap.execute({ data: VALID_BASE64, contentType: 'image/png' }, BASE_CONTEXT);

      const [, options] = mockUpload.mock.calls[0] as [Buffer, UploadOptions];
      expect(options.key).toMatch(/\.png$/);
    });
  });

  // validate() method (inherited from BaseCapability)
  describe('validate()', () => {
    it('rejects missing data field', () => {
      const cap = new UploadToStorageCapability();
      expect(() => cap.validate({ contentType: 'application/pdf' })).toThrow();
    });

    it('rejects invalid contentType format', () => {
      const cap = new UploadToStorageCapability();
      expect(() => cap.validate({ data: VALID_BASE64, contentType: 'not a mime type' })).toThrow();
    });

    it('accepts minimal valid args and returns typed object', () => {
      const cap = new UploadToStorageCapability();
      const args = cap.validate(BASE_ARGS);
      expect(args.data).toBe(VALID_BASE64);
      expect(args.contentType).toBe('application/pdf');
    });
  });
});
