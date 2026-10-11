/**
 * End-to-end: private upload → getSignedUrl() → read route → bytes.
 *
 * The route's own test mocks the storage client, and the provider's test
 * never goes through HTTP. Neither would catch a mismatch *between* them —
 * a key that survives signing but not URL round-tripping, a token minted
 * for one spelling of a key and checked against another. This wires the
 * real `LocalProvider`, real HMAC tokens and the real route handler
 * together over a real temp directory.
 *
 * @see app/api/v1/storage/[...key]/route.ts
 * @see lib/storage/providers/local.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import type { NextRequest } from 'next/server';

/**
 * Scratch roots live under the repo's gitignored `.storage/`, not `os.tmpdir()` —
 * see the note in `local-private-objects.test.ts`.
 */
const SCRATCH_PARENT = join(process.cwd(), '.storage', 'test-runs');

vi.mock('@/lib/env', () => ({
  env: {
    BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters-long',
    BETTER_AUTH_URL: 'https://app.example.com',
    NODE_ENV: 'test',
  },
}));

// The read route checks an org-claimed token's org is live; there is no DB here.
const mockOrgFindUnique = vi.fn();
vi.mock('@/lib/db/client', () => ({
  prisma: { org: { findUnique: (args: unknown) => mockOrgFindUnique(args) } },
}));

let provider: import('@/lib/storage/providers/local').LocalProvider | null = null;

vi.mock('@/lib/storage/client', () => ({
  getStorageClient: vi.fn(() => provider),
}));

const { LocalProvider } = await import('@/lib/storage/providers/local');
const { scopeStorageToOrg } = await import('@/lib/storage/org-scoped');
const { GET } = await import('@/app/api/v1/storage/[...key]/route');

let root: string;

beforeEach(async () => {
  mockOrgFindUnique.mockResolvedValue({ status: 'ACTIVE' });
  await mkdir(SCRATCH_PARENT, { recursive: true });
  root = await mkdtemp(join(SCRATCH_PARENT, 'signed-read-'));
  provider = new LocalProvider({
    baseDir: join(root, 'public', 'uploads'),
    privateDir: join(root, '.storage', 'private'),
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Drive the route from a signed URL exactly as a browser would. */
function fetchSignedUrl(signedUrl: string): Promise<Response> {
  const url = new URL(signedUrl, 'https://app.example.com');
  // Next decodes the dynamic segments before handing them to the handler.
  const segments = url.pathname.replace('/api/v1/storage/', '').split('/').map(decodeURIComponent);

  return GET({ nextUrl: url } as unknown as NextRequest, {
    params: Promise.resolve({ key: segments }),
  });
}

describe('signed read, end to end', () => {
  it('serves the bytes of a privately uploaded object', async () => {
    const key = 'documents/user-1/contract.pdf';
    await provider!.upload(Buffer.from('confidential contents'), {
      key,
      contentType: 'application/pdf',
      public: false,
    });

    const signedUrl = await provider!.getSignedUrl(key, 300);
    const response = await fetchSignedUrl(signedUrl);

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('confidential contents');
  });

  it('round-trips a key containing characters that need URL encoding', async () => {
    // The failure this guards: sign one spelling of the key, check another.
    const key = 'documents/user 1/report v2 (final).pdf';
    await provider!.upload(Buffer.from('encoded ok'), {
      key,
      contentType: 'application/pdf',
      public: false,
    });

    const signedUrl = await provider!.getSignedUrl(key, 300);
    const response = await fetchSignedUrl(signedUrl);

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('encoded ok');
  });

  it('refuses the same URL once its token has expired', async () => {
    const key = 'documents/user-1/contract.pdf';
    await provider!.upload(Buffer.from('confidential contents'), {
      key,
      contentType: 'application/pdf',
      public: false,
    });
    const signedUrl = await provider!.getSignedUrl(key, 60);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 61_000));
    const response = await fetchSignedUrl(signedUrl);
    vi.useRealTimers();

    expect(response.status).toBe(401);
  });

  it('refuses a token from one object used against another', async () => {
    await provider!.upload(Buffer.from('mine'), {
      key: 'documents/user-1/contract.pdf',
      contentType: 'application/pdf',
      public: false,
    });
    await provider!.upload(Buffer.from('theirs'), {
      key: 'documents/user-2/contract.pdf',
      contentType: 'application/pdf',
      public: false,
    });

    const signedUrl = await provider!.getSignedUrl('documents/user-1/contract.pdf', 300);
    const token = signedUrl.split('token=')[1];
    const response = await fetchSignedUrl(
      `/api/v1/storage/documents/user-2/contract.pdf?token=${token}`
    );

    expect(response.status).toBe(403);
  });

  it('404s for a key that was never uploaded', async () => {
    const signedUrl = await provider!.getSignedUrl('documents/user-1/never-written.pdf', 300);

    const response = await fetchSignedUrl(signedUrl);

    expect(response.status).toBe(404);
  });

  it('serves a public object through the same route when asked', async () => {
    // Nothing restricts the route to private objects — the token is what
    // gates it, and a public object simply also has a static URL.
    const key = 'avatars/user-1/avatar.jpg';
    await provider!.upload(Buffer.from('image bytes'), { key, contentType: 'image/jpeg' });

    const response = await fetchSignedUrl(await provider!.getSignedUrl(key, 300));

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('image bytes');
  });

  describe('org-owned private objects', () => {
    const KEY_A = 'orgs/org-a/reports/q3.pdf';

    async function uploadPrivate(key: string, body: string): Promise<void> {
      await provider!.upload(Buffer.from(body), {
        key,
        contentType: 'application/pdf',
        public: false,
      });
    }

    it('serves an org-owned object through a URL signed by the org-scoped client', async () => {
      await uploadPrivate(KEY_A, 'org a secrets');
      const orgA = scopeStorageToOrg(provider!, 'org-a');

      const signedUrl = await orgA.getSignedUrl!(KEY_A, 300);
      const response = await fetchSignedUrl(signedUrl);

      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('org a secrets');
    });

    it('carries the org in the token the scoped client signed', async () => {
      await uploadPrivate(KEY_A, 'org a secrets');
      const orgA = scopeStorageToOrg(provider!, 'org-a');

      const signedUrl = await orgA.getSignedUrl!(KEY_A, 300);
      const { verifyStorageAccessToken } = await import('@/lib/storage/access-tokens');
      const token = decodeURIComponent(signedUrl.split('token=')[1]);

      expect(verifyStorageAccessToken(token).org).toBe('org-a');
    });

    it("cannot obtain a signed URL for another org's key from the scoped client", async () => {
      await uploadPrivate('orgs/org-b/reports/q3.pdf', 'org b secrets');
      const orgA = scopeStorageToOrg(provider!, 'org-a');

      await expect(orgA.getSignedUrl!('orgs/org-b/reports/q3.pdf', 300)).rejects.toThrow(
        /outside this org/i
      );
    });

    it("cannot mint a token for another org's key at the provider either", async () => {
      await uploadPrivate('orgs/org-b/reports/q3.pdf', 'org b secrets');

      await expect(
        provider!.getSignedUrl('orgs/org-b/reports/q3.pdf', 300, { orgId: 'org-a' })
      ).rejects.toThrow(/outside the org/i);
    });

    it('refuses an org A token replayed against org B key', async () => {
      await uploadPrivate(KEY_A, 'org a secrets');
      await uploadPrivate('orgs/org-b/reports/q3.pdf', 'org b secrets');
      const orgA = scopeStorageToOrg(provider!, 'org-a');

      const token = (await orgA.getSignedUrl!(KEY_A, 300)).split('token=')[1];
      const response = await fetchSignedUrl(
        `/api/v1/storage/orgs/org-b/reports/q3.pdf?token=${token}`
      );

      expect(response.status).toBe(403);
    });
  });
});
