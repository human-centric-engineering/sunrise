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

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/csv': '.csv',
  'application/pdf': '.pdf',
  'application/epub+zip': '.epub',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};

const ALLOWED_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.csv', '.pdf', '.docx', '.epub']);

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
export async function fetchDocumentFromUrl(url: string): Promise<FetchedDocument> {
  // SSRF protection
  const urlCheck = checkSafeProviderUrl(url);
  if (!urlCheck.ok) {
    throw new Error(`URL blocked: ${urlCheck.message}`);
  }

  logger.info('Fetching document from URL', { url });

  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      'User-Agent': 'Sunrise-KnowledgeBase/1.0',
      Accept:
        'text/plain, text/markdown, application/pdf, application/epub+zip, application/vnd.openxmlformats-officedocument.wordprocessingml.document, */*',
    },
    redirect: 'follow',
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
