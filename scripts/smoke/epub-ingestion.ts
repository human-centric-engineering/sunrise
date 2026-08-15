/**
 * EPUB ingestion smoke script (`lib/orchestration/knowledge/parsers/epub-parser.ts`)
 *
 * Uploads a real EPUB through the real admin route against a **running server**
 * and asserts the book's prose came back out the other side.
 *
 * **Why this exists rather than another unit test.** The EPUB path has now been
 * broken twice in ways no unit test could see. #606: the parser awaited a
 * non-promise and returned an empty document for every book, while 27 mocked
 * tests stayed green. And this repo's knowledge parsers have a track record of
 * working in dev and failing only inside a **production bundle** — jsdom's ESM
 * move did it once already. `epub` is ESM-only, so the question "does it still
 * work once Next has bundled it" is not answerable by vitest at all.
 *
 * Point it at a production build to answer that:
 *
 *   npm run build
 *   PORT=3100 npm start
 *   SMOKE_BASE_URL=http://localhost:3100 npm run smoke:epub
 *
 * It works against `npm run dev` too, but a green dev run proves strictly less.
 *
 * Flow:
 *   1. Sign up a throwaway admin, upgrade its role
 *   2. Build a spec-valid EPUB in memory (deflated, as real books are)
 *   3. POST it to /api/v1/admin/orchestration/knowledge/documents
 *   4. Assert the document is ready, chunked, and contains the known prose
 *   5. Delete the document and the user
 *
 * Safety: every row is scoped by the `smoke-test-epub` prefix and removed on
 * every path, including a sweep at startup for anything an interrupted run
 * stranded. Never touches seed data, never uses an unscoped delete.
 *
 * Run with: npm run smoke:epub
 */

import { prisma } from '@/lib/db/client';
import { buildEpub } from '@/tests/helpers/epub-fixture';

const BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://localhost:3100';
const PREFIX = 'smoke-test-epub';
const EMAIL = `${PREFIX}@example.com`;
const PASSWORD = 'SmokeTest!Passw0rd';

/** A line that appears in the fixture's first chapter and nowhere else. */
const KNOWN_PROSE = 'the clocks were striking thirteen';

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

function extractSessionCookie(setCookieHeaders: string[]): string | null {
  for (const raw of setCookieHeaders) {
    const first = raw.split(';', 1)[0] ?? '';
    if (first.includes('better-auth.session_token=')) return first.trim();
  }
  return null;
}

/** Remove anything a previous run left behind. `finally` cannot cover a SIGINT. */
async function sweep(): Promise<void> {
  await prisma.aiKnowledgeDocument.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { email: EMAIL } });
}

async function main(): Promise<void> {
  console.log(`\nsmoke:epub — target ${BASE_URL}\n`);

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    console.log('skipped — no database reachable (DATABASE_URL unset or DB down).');
    return;
  }

  const reachable = await fetch(`${BASE_URL}/api/auth/get-session`, {
    headers: { origin: BASE_URL },
  }).catch(() => null);
  if (!reachable) {
    console.error(`✗ no server at ${BASE_URL} — start one first (see the header of this file).`);
    process.exit(1);
  }

  await sweep();

  let documentId = '';

  try {
    // 1. Throwaway admin.
    //
    // Sign up, then verify + promote in the database, then sign in — rather
    // than reading the cookie off the sign-up response. `requireEmailVerification`
    // defaults to ON whenever `NODE_ENV === 'production'`, so a production
    // build returns `token: null` and sets no session cookie. Doing it this way
    // means the script behaves identically against `npm run dev` and against
    // the production server this script mainly exists to test.
    const signup = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: 'EPUB smoke' }),
    });
    if (!signup.ok) throw new Error(`sign-up failed: ${signup.status} ${await signup.text()}`);

    await prisma.user.update({
      where: { email: EMAIL },
      data: { role: 'ADMIN', emailVerified: true },
    });

    const signin = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    if (!signin.ok) throw new Error(`sign-in failed: ${signin.status} ${await signin.text()}`);

    const cookie = extractSessionCookie(signin.headers.getSetCookie());
    if (!cookie) throw new Error('sign-in returned no session cookie');
    console.log(`  ✓ signed in as ${EMAIL} (ADMIN)`);

    // 2 + 3. Upload a real EPUB through the real route.
    const epub = buildEpub();
    console.log(`  ✓ built a ${epub.length}-byte EPUB`);

    const form = new FormData();
    // `new Uint8Array(...)` rather than the Buffer directly: a Buffer's
    // `.buffer` is `ArrayBufferLike`, which may be a `SharedArrayBuffer`, and
    // `BlobPart` will not take one. This copies into a plain ArrayBuffer.
    form.append(
      'file',
      new Blob([new Uint8Array(epub)], { type: 'application/epub+zip' }),
      `${PREFIX}.epub`
    );
    form.append('name', PREFIX);

    const res = await fetch(`${BASE_URL}/api/v1/admin/orchestration/knowledge/documents`, {
      method: 'POST',
      headers: { cookie, origin: BASE_URL },
      body: form,
    });
    const body: unknown = await res.json();
    if (res.status !== 201) {
      throw new Error(`upload returned ${res.status}: ${JSON.stringify(body)}`);
    }

    const parsedBody = body as { data?: { document?: { id?: string; status?: string } } };
    documentId = parsedBody.data?.document?.id ?? '';
    check(documentId !== '', 'upload returned 201 with a document id');
    check(parsedBody.data?.document?.status === 'ready', 'document status is "ready"');

    // 4. The assertion this script exists for: the BOOK is in there.
    //
    // #606 passed every one of the checks above while storing nothing — the
    // upload was accepted, the row said ready. Only the chunk text can tell
    // the difference.
    const chunks = await prisma.aiKnowledgeChunk.findMany({
      where: { documentId },
      select: { content: true },
    });

    check(chunks.length > 0, `document has ${chunks.length} chunk(s), not zero`);
    const allText = chunks.map((c) => c.content).join('\n');
    check(allText.includes(KNOWN_PROSE), `chunk text contains the book's prose ("${KNOWN_PROSE}")`);
    check(
      allText.includes('boiled cabbage and old rag mats'),
      'the SECOND chapter is present too, so the whole spine was walked'
    );

    console.log('\nsmoke:epub PASSED\n');
  } finally {
    if (documentId) {
      await prisma.aiKnowledgeDocument.delete({ where: { id: documentId } }).catch(() => {
        console.warn(`  ! could not remove document ${documentId} — remove it by hand`);
      });
    }
    await prisma.user.deleteMany({ where: { email: EMAIL } }).catch(() => {});
    await prisma.$disconnect();
  }
}

main().catch(async (err: unknown) => {
  console.error('\n✗ smoke:epub failed:', err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
