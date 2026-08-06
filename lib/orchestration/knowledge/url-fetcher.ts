/**
 * URL Document Fetcher
 *
 * Fetches a document from a URL with SSRF protection, size limits,
 * and content-type detection. Returns a buffer ready for the standard
 * upload pipeline.
 */

import { basename, extname } from 'path';
import { checkSafeProviderUrl } from '@/lib/security/safe-url';
import { logger } from '@/lib/logging';

const MAX_FETCH_BYTES = 50 * 1024 * 1024; // 50 MB
const FETCH_TIMEOUT_MS = 30_000;

/** Redirect hops permitted before giving up. Matches the browser default. */
const MAX_REDIRECTS = 5;

/** Statuses that carry a `Location` the client is expected to follow. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/csv': '.csv',
  'text/html': '.html',
  'application/xhtml+xml': '.html',
  'application/pdf': '.pdf',
  'application/epub+zip': '.epub',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};

const ALLOWED_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.csv',
  '.html',
  '.htm',
  '.pdf',
  '.docx',
  '.epub',
]);

export interface FetchedDocument {
  content: Buffer;
  fileName: string;
  mimeType: string | null;
  sourceUrl: string;
}

/**
 * Fetch a document from a URL with SSRF protection and size limits.
 * Throws on failure.
 */
/**
 * Fetch `target`, re-running the SSRF guard on **every** redirect hop.
 *
 * `checkSafeProviderUrl` validates one URL. With `redirect: 'follow'` the
 * guard therefore only ever sees the first one, and `https://attacker.example/doc`
 * → `302` → `http://169.254.169.254/latest/meta-data/` reaches cloud metadata
 * without needing any DNS trickery — the response body then being ingested as a
 * knowledge document, i.e. readable afterwards.
 *
 * `redirect: 'error'` would close it in one line, but redirects are legitimate
 * here: users paste shortened links, `http`→`https` upgrades, and CDN redirects.
 * So follow them, and re-validate each target instead. (The webhook dispatcher
 * in `hooks/registry.ts` makes the opposite call, and should — see #534.)
 *
 * The caller's `AbortSignal` is shared across hops, so the timeout bounds the
 * whole chain rather than resetting per hop.
 */
async function fetchRevalidatingRedirects(target: string, init: RequestInit): Promise<Response> {
  let current = target;

  for (let hop = 0; ; hop++) {
    const urlCheck = checkSafeProviderUrl(current);
    if (!urlCheck.ok) {
      throw new Error(
        hop === 0
          ? `URL blocked: ${urlCheck.message}`
          : `URL blocked after ${hop} redirect(s) (${current}): ${urlCheck.message}`
      );
    }

    const response = await fetch(current, { ...init, redirect: 'manual' });

    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get('location');
    // A 3xx with no Location is not actionable — hand it back and let the
    // `!response.ok` check below report it.
    if (!location) return response;

    // Under `redirect: 'follow'` undici consumed intermediate bodies itself.
    // Reading only the headers leaves the stream open, and undici holds the
    // socket out of the pool until the body is consumed or cancelled — so every
    // hop would leak a connection until GC. Release it before moving on or
    // throwing, including on the error paths below.
    await response.body?.cancel().catch(() => {
      /* already errored or consumed — nothing to release */
    });

    if (hop >= MAX_REDIRECTS) {
      throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
    }

    let next: string;
    try {
      // Location may be relative; resolve against the URL that issued it.
      next = new URL(location, current).toString();
    } catch {
      throw new Error(`Redirect to an unparseable Location: ${location}`);
    }

    logger.info('Following redirect while fetching document', {
      from: current,
      to: next,
      hop: hop + 1,
    });
    current = next;
  }
}

export async function fetchDocumentFromUrl(url: string): Promise<FetchedDocument> {
  logger.info('Fetching document from URL', { url });

  // SSRF protection — applied to the initial URL and to every redirect target.
  const response = await fetchRevalidatingRedirects(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      'User-Agent': 'Sunrise-KnowledgeBase/1.0',
      Accept:
        'text/html, application/xhtml+xml, text/plain, text/markdown, application/pdf, application/epub+zip, application/vnd.openxmlformats-officedocument.wordprocessingml.document, */*',
    },
  });

  if (!response.ok) {
    throw new Error(`Fetch failed: HTTP ${response.status} ${response.statusText}`);
  }

  // Check content-length before downloading
  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_FETCH_BYTES) {
    throw new Error(`Document too large (${contentLength} bytes, max ${MAX_FETCH_BYTES})`);
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_FETCH_BYTES) {
    throw new Error(`Document too large (${arrayBuffer.byteLength} bytes, max ${MAX_FETCH_BYTES})`);
  }

  const buffer = Buffer.from(arrayBuffer);
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? null;

  // Derive file name from URL path or content-type
  let fileName = decodeURIComponent(basename(new URL(url).pathname)) || 'document';
  let ext = extname(fileName).toLowerCase();

  // If no extension from URL, derive from content-type
  if (!ext && contentType && CONTENT_TYPE_TO_EXT[contentType]) {
    ext = CONTENT_TYPE_TO_EXT[contentType];
    fileName = `${fileName}${ext}`;
  }

  // If still no extension, default to .txt for text content
  if (!ext) {
    if (contentType?.startsWith('text/')) {
      ext = '.txt';
      fileName = `${fileName}.txt`;
    } else {
      throw new Error(
        `Cannot determine file type from URL or content-type (${contentType ?? 'unknown'}). ` +
          `Supported: ${[...ALLOWED_EXTENSIONS].join(', ')}`
      );
    }
  }

  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported file type "${ext}". Supported: ${[...ALLOWED_EXTENSIONS].join(', ')}`
    );
  }

  logger.info('Document fetched from URL', {
    url,
    fileName,
    contentType,
    sizeBytes: buffer.length,
  });

  return {
    content: buffer,
    fileName,
    mimeType: contentType,
    sourceUrl: url,
  };
}
