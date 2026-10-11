/**
 * Integration Test: Signed storage read route
 *
 * Tests GET /api/v1/storage/<key...>?token=<signed>
 *
 * The route's access-control model is unusual and worth stating: the signed
 * token is the *only* credential, and it grants exactly one key. There is no
 * session fallback, because storage keys encode no ownership — a `withAuth()`
 * here would let any logged-in user read any private object. The tests that
 * matter most are therefore the refusals: no token, wrong key, expired,
 * tampered.
 *
 * Test Coverage:
 * - Happy path: valid token → bytes, with headers that prevent inline render
 * - Missing / malformed / expired / tampered token → 401
 * - Token minted for a different key → 403 (the cross-object read)
 * - Token whose org claim does not match the key's org → 403 TOKEN_ORG_MISMATCH
 * - Storage unconfigured → 503; provider without `download` → 501
 * - Object missing → 404
 * - Multi-segment keys reassemble correctly
 *
 * @see app/api/v1/storage/[...key]/route.ts
 * @see lib/storage/access-tokens.ts
 */

import { createHmac } from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { StorageCapabilities, StorageObject } from '@/lib/storage/providers/types';

vi.mock('@/lib/env', () => ({
  env: {
    BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters-long',
    BETTER_AUTH_URL: 'https://app.example.com',
    NODE_ENV: 'test',
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockOrgFindUnique = vi.fn<(args: unknown) => Promise<{ status: string } | null>>();

vi.mock('@/lib/db/client', () => ({
  prisma: { org: { findUnique: (args: unknown) => mockOrgFindUnique(args) } },
}));

const mockDownload = vi.fn<(key: string) => Promise<StorageObject>>();

type MockStorage = {
  name: string;
  download?: typeof mockDownload;
  capabilities?: Partial<StorageCapabilities>;
} | null;

let mockStorageClient: MockStorage = null;

vi.mock('@/lib/storage/client', () => ({
  getStorageClient: vi.fn(() => mockStorageClient),
}));

const { GET } = await import('@/app/api/v1/storage/[...key]/route');
const { generateStorageAccessToken } = await import('@/lib/storage/access-tokens');

const KEY = 'documents/user-1/contract.pdf';
const SEGMENTS = KEY.split('/');

/** Build a request for `key`, carrying `token` when supplied. */
function buildRequest(key: string, token?: string): NextRequest {
  const url = new URL(`https://app.example.com/api/v1/storage/${key}`);
  if (token !== undefined) url.searchParams.set('token', token);
  return { nextUrl: url } as unknown as NextRequest;
}

const SECRET = 'test-secret-that-is-at-least-32-characters-long';

/**
 * Sign a payload by hand. Minting refuses an org/key mismatch, so the only way
 * to present one to the route is to sign it ourselves — the construction is
 * `<base64url(json)>.<base64url(HMAC-SHA256(secret, json))>`.
 */
function signToken(key: string, org?: string): string {
  const json = JSON.stringify({
    typ: 'storage-read',
    key,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    ...(org !== undefined ? { org } : {}),
  });
  const signature = createHmac('sha256', SECRET).update(json, 'utf8').digest('base64url');
  return `${Buffer.from(json, 'utf8').toString('base64url')}.${signature}`;
}

function call(segments: string[], token?: string): Promise<Response> {
  return GET(buildRequest(segments.join('/'), token), {
    params: Promise.resolve({ key: segments }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  mockStorageClient = {
    name: 'local',
    download: mockDownload,
    capabilities: { privateObjects: true, signedUrls: true, download: true },
  };
  mockDownload.mockResolvedValue({
    key: KEY,
    body: Buffer.from('confidential contents'),
    size: Buffer.byteLength('confidential contents'),
  });
  mockOrgFindUnique.mockResolvedValue({ status: 'ACTIVE' });
});

describe('GET /api/v1/storage/[...key]', () => {
  describe('with a valid token', () => {
    it('returns the object bytes', async () => {
      const { token } = generateStorageAccessToken(KEY, 300);

      const response = await call(SEGMENTS, token);

      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('confidential contents');
      expect(mockDownload).toHaveBeenCalledWith(KEY);
    });

    it('reassembles a multi-segment key before reading it', async () => {
      const { token } = generateStorageAccessToken('a/b/c/d.pdf', 300);

      await call(['a', 'b', 'c', 'd.pdf'], token);

      expect(mockDownload).toHaveBeenCalledWith('a/b/c/d.pdf');
    });

    it('forces a download rather than an inline render', async () => {
      // User-supplied bytes served from the app's own origin: rendering an
      // uploaded .html or .svg inline would be stored XSS against a session.
      const { token } = generateStorageAccessToken(KEY, 300);

      const response = await call(SEGMENTS, token);

      expect(response.headers.get('content-type')).toBe('application/octet-stream');
      expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    });

    it('does not let shared caches keep the bytes past the token', async () => {
      const { token } = generateStorageAccessToken(KEY, 300);

      const response = await call(SEGMENTS, token);

      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(response.headers.get('cache-control')).toContain('private');
    });

    it('reports the object size', async () => {
      const { token } = generateStorageAccessToken(KEY, 300);

      const response = await call(SEGMENTS, token);

      expect(response.headers.get('content-length')).toBe(
        String(Buffer.byteLength('confidential contents'))
      );
    });

    it('measures Content-Length from the body, not the provider’s size field', async () => {
      // A provider whose `size` disagrees with its bytes would otherwise
      // produce a response the client truncates or hangs waiting on.
      const body = Buffer.from('twelve bytes');
      mockDownload.mockResolvedValue({ key: KEY, body, size: 99999 });
      const { token } = generateStorageAccessToken(KEY, 300);

      const response = await call(SEGMENTS, token);

      expect(response.headers.get('content-length')).toBe(String(body.length));
    });

    it('sanitises the filename in Content-Disposition', async () => {
      const key = 'documents/user-1/inv"oice; x.pdf';
      const { token } = generateStorageAccessToken(key, 300);

      const response = await call(['documents', 'user-1', 'inv"oice; x.pdf'], token);

      const disposition = response.headers.get('content-disposition')!;
      expect(disposition).not.toContain('"oice');
      expect(disposition).toMatch(/^attachment; filename="[\w.-]+"$/);
    });
  });

  describe('token refusals', () => {
    it('refuses a request with no token', async () => {
      const response = await call(SEGMENTS);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('TOKEN_REQUIRED');
      expect(mockDownload).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('refuses a token minted for a different key', async () => {
      // The cross-object read: without the key comparison, any valid token
      // would be a universal read grant.
      const { token } = generateStorageAccessToken('documents/user-2/private.pdf', 300);

      const response = await call(SEGMENTS, token);

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error.code).toBe('TOKEN_KEY_MISMATCH');
      expect(mockDownload).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('refuses an expired token', async () => {
      const { token } = generateStorageAccessToken(KEY, 60);

      vi.useFakeTimers();
      vi.setSystemTime(new Date(Date.now() + 61_000));

      const response = await call(SEGMENTS, token);

      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe('INVALID_TOKEN');
      expect(mockDownload).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('refuses a tampered token', async () => {
      const { token } = generateStorageAccessToken(KEY, 300);
      const [payload, signature] = token.split('.');
      const tampered = `${payload}.${signature.slice(0, -1)}${signature.endsWith('a') ? 'b' : 'a'}`;

      const response = await call(SEGMENTS, tampered);

      expect(response.status).toBe(401);
      expect(mockDownload).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('refuses a malformed token', async () => {
      const response = await call(SEGMENTS, 'not-a-token');

      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe('INVALID_TOKEN');
    });

    it('refuses an empty token', async () => {
      const response = await call(SEGMENTS, '');

      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe('TOKEN_REQUIRED');
    });
  });

  describe('org claim', () => {
    const ORG_KEY = 'orgs/org-a/reports/q3.pdf';
    const ORG_SEGMENTS = ORG_KEY.split('/');

    it('serves an org-owned key when the claim names that org', async () => {
      mockDownload.mockResolvedValue({
        key: ORG_KEY,
        body: Buffer.from('org a report'),
        size: 12,
      });
      const { token } = generateStorageAccessToken(ORG_KEY, 300, { orgId: 'org-a' });

      const response = await call(ORG_SEGMENTS, token);

      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('org a report');
      expect(mockDownload).toHaveBeenCalledWith(ORG_KEY);
    });

    it("reads an org-claimed token's object through that org's storage client", async () => {
      const { getStorageClient } = await import('@/lib/storage/client');
      const { token } = generateStorageAccessToken(ORG_KEY, 300, { orgId: 'org-a' });

      await call(ORG_SEGMENTS, token);

      expect(getStorageClient).toHaveBeenCalledTimes(1);
      expect(getStorageClient).toHaveBeenCalledWith({ orgId: 'org-a' });
    });

    it('asks for the unbound client (no org) when the token carries no claim', async () => {
      const { getStorageClient } = await import('@/lib/storage/client');
      const { token } = generateStorageAccessToken(KEY, 300);

      await call(SEGMENTS, token);

      expect(getStorageClient).toHaveBeenCalledTimes(1);
      expect(getStorageClient).toHaveBeenCalledWith({});
    });

    it.each(['orgs//org-a/x.pdf', 'Orgs/org-a/x.pdf'])(
      'refuses the malformed reserved-root key %s even for a claimless token',
      async (key) => {
        const response = await call(key.split('/'), signToken(key));

        expect(response.status).toBe(403);
        expect((await response.json()).error.code).toBe('TOKEN_ORG_MISMATCH');
        expect(mockDownload).not.toHaveBeenCalled();
      }
    );

    it('refuses a token claiming org B for a key under orgs/org-a/', async () => {
      const response = await call(ORG_SEGMENTS, signToken(ORG_KEY, 'org-b'));

      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('TOKEN_ORG_MISMATCH');
      expect(mockDownload).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('refuses a token with no claim for a key under orgs/org-a/', async () => {
      const response = await call(ORG_SEGMENTS, signToken(ORG_KEY));

      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('TOKEN_ORG_MISMATCH');
      expect(mockDownload).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('refuses a token claiming org A for a legacy key no org owns', async () => {
      const response = await call(SEGMENTS, signToken(KEY, 'org-a'));

      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('TOKEN_ORG_MISMATCH');
      expect(mockDownload).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('still serves a legacy key from a token with no claim', async () => {
      const response = await call(SEGMENTS, signToken(KEY));

      expect(response.status).toBe(200);
      expect(mockDownload).toHaveBeenCalledWith(KEY);
    });

    it('looks up the claimed org by id and serves only when it is ACTIVE', async () => {
      const { token } = generateStorageAccessToken(ORG_KEY, 300, { orgId: 'org-a' });

      const response = await call(ORG_SEGMENTS, token);

      expect(response.status).toBe(200);
      expect(mockOrgFindUnique).toHaveBeenCalledTimes(1);
      expect(mockOrgFindUnique).toHaveBeenCalledWith({
        where: { id: 'org-a' },
        select: { status: true },
      });
    });

    it('refuses with 403 ORG_UNAVAILABLE when the claimed org no longer exists', async () => {
      mockOrgFindUnique.mockResolvedValue(null);
      const { token } = generateStorageAccessToken(ORG_KEY, 300, { orgId: 'org-a' });

      const response = await call(ORG_SEGMENTS, token);

      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('ORG_UNAVAILABLE');
      expect(mockDownload).not.toHaveBeenCalled();
    });

    it('refuses with 403 ORG_UNAVAILABLE when the claimed org is SUSPENDED', async () => {
      mockOrgFindUnique.mockResolvedValue({ status: 'SUSPENDED' });
      const { token } = generateStorageAccessToken(ORG_KEY, 300, { orgId: 'org-a' });

      const response = await call(ORG_SEGMENTS, token);

      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('ORG_UNAVAILABLE');
      expect(mockDownload).not.toHaveBeenCalled();
    });

    it('does not query orgs for a claimless token on a legacy key', async () => {
      const response = await call(SEGMENTS, signToken(KEY));

      expect(response.status).toBe(200);
      expect(mockOrgFindUnique).not.toHaveBeenCalled();
    });
  });

  describe('key validation as defence in depth', () => {
    it('refuses a traversal key even when the token authentically names it', async () => {
      // `generateStorageAccessToken` signs whatever key it is handed — only
      // `getSignedUrl()` validates first. So a token minted directly for a
      // traversal key is authentic AND matches the request, clearing both
      // earlier gates. `validateStorageKey` is what stops it reading
      // /etc/passwd, and this pins that it still runs.
      const { token } = generateStorageAccessToken('../../etc/passwd', 300);

      const response = await call(['..', '..', 'etc', 'passwd'], token);

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_KEY');
      expect(mockDownload).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('refuses a null-byte key that the token authentically names', async () => {
      const { token } = generateStorageAccessToken('documents/a\0.pdf', 300);

      const response = await call(['documents', 'a\0.pdf'], token);

      expect(response.status).toBe(400);
      expect(mockDownload).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });
  });

  describe('provider conditions', () => {
    it('returns 503 when storage is not configured', async () => {
      mockStorageClient = null;
      const { token } = generateStorageAccessToken(KEY, 300);

      const response = await call(SEGMENTS, token);

      expect(response.status).toBe(503);
      expect((await response.json()).error.code).toBe('STORAGE_NOT_CONFIGURED');
    });

    it('returns 501 when the provider cannot read objects back', async () => {
      mockStorageClient = { name: 'vercel-blob', capabilities: { download: false } };
      const { token } = generateStorageAccessToken(KEY, 300);

      const response = await call(SEGMENTS, token);

      expect(response.status).toBe(501);
      expect((await response.json()).error.code).toBe('DOWNLOAD_NOT_SUPPORTED');
    });

    it('returns 501 when a provider declares download but does not implement it', async () => {
      mockStorageClient = { name: 'broken-fork-provider', capabilities: { download: true } };
      const { token } = generateStorageAccessToken(KEY, 300);

      const response = await call(SEGMENTS, token);

      expect(response.status).toBe(501);
    });

    it('returns 404 when the object does not exist', async () => {
      mockDownload.mockRejectedValue(new Error('Object not found in local storage'));
      const { token } = generateStorageAccessToken(KEY, 300);

      const response = await call(SEGMENTS, token);

      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe('NOT_FOUND');
    });

    it('returns 404 when the provider rejects with a non-Error value', async () => {
      mockDownload.mockRejectedValue('a bare string, not an Error');
      const { token } = generateStorageAccessToken(KEY, 300);

      const response = await call(SEGMENTS, token);

      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe('NOT_FOUND');
    });

    it('does not leak the provider error message to the caller', async () => {
      mockDownload.mockRejectedValue(new Error('EACCES: /srv/secrets/.storage/private/x'));
      const { token } = generateStorageAccessToken(KEY, 300);

      const response = await call(SEGMENTS, token);

      expect(await response.text()).not.toContain('/srv/secrets');
    });
  });
});
