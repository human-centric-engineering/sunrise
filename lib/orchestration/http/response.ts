/**
 * Response handling for orchestration outbound HTTP.
 *
 * - Status classification (retriable transient failures vs terminal).
 * - Body reading with a hard size cap (defends against OOM from
 *   malicious or buggy upstreams).
 * - Content-type-aware JSON auto-parse (also covers JSON-shaped
 *   responses served with the wrong content-type).
 * - Optional response transformation: JMESPath for structured
 *   extraction, simple `{{path.to.field}}` template strings for
 *   one-shot interpolation.
 */

import jmespath from 'jmespath';
import { HttpError } from '@/lib/orchestration/http/errors';

/** HTTP status codes that indicate transient failures worth retrying. */
const RETRIABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

export function isRetriableStatus(status: number): boolean {
  return RETRIABLE_STATUS_CODES.has(status);
}

/** Content types whose bodies are binary and would be corrupted by UTF-8 decoding. */
const BINARY_CONTENT_TYPES = ['application/pdf', 'application/octet-stream', 'application/zip'];
const BINARY_CONTENT_TYPE_PREFIXES = ['image/', 'audio/', 'video/'];

function isBinaryContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  if (BINARY_CONTENT_TYPES.some((t) => lower.startsWith(t))) return true;
  if (BINARY_CONTENT_TYPE_PREFIXES.some((p) => lower.startsWith(p))) return true;
  return false;
}

/** Returned by `readResponseBody` for binary responses. The body field on
 * `HttpResponseBody` becomes this wrapper rather than a string so consumers
 * can detect and route binary payloads (typically: hand off to a storage
 * capability rather than letting the LLM see base64 bytes). */
export interface BinaryResponseBody {
  encoding: 'base64';
  contentType: string;
  data: string;
}

export function isBinaryResponseBody(body: unknown): body is BinaryResponseBody {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { encoding?: unknown }).encoding === 'base64'
  );
}

/**
 * Read a response body, enforcing a maximum byte size, and JSON-parse
 * when the content-type or shape suggests JSON. Falls back to text on
 * parse failure.
 */
export async function readResponseBody(response: Response, maxBytes: number): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    throw new HttpError(
      'response_too_large',
      `Response body exceeds max size: ${contentLength} bytes > ${maxBytes} bytes`,
      false
    );
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new HttpError(
      'response_too_large',
      `Response body exceeds max size: ${buffer.byteLength} bytes > ${maxBytes} bytes`,
      false
    );
  }

  const contentType = response.headers.get('content-type') ?? '';

  if (isBinaryContentType(contentType)) {
    return {
      encoding: 'base64',
      contentType: contentType.split(';')[0]?.trim() ?? contentType,
      data: Buffer.from(buffer).toString('base64'),
    } satisfies BinaryResponseBody;
  }

  const text = new TextDecoder().decode(buffer);

  if (contentType.includes('json') || text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      // Fall through to raw text.
    }
  }

  return text;
}

export interface ResponseTransform {
  type: 'jmespath' | 'template';
  expression: string;
}

/**
 * Apply a response transformation to the response body.
 *
 * Throws on bad JMESPath; template misses resolve to empty string.
 * Callers decide whether the failure is fatal or surface-with-warning.
 */
export function applyResponseTransform(body: unknown, transform: ResponseTransform): unknown {
  if (transform.type === 'jmespath') {
    return jmespath.search(body, transform.expression);
  }

  if (transform.type === 'template') {
    return transform.expression.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
      const value = getNestedValue(body, path.trim());
      if (value === undefined) return '';
      return typeof value === 'object'
        ? JSON.stringify(value)
        : String(value as string | number | boolean);
    });
  }

  return body;
}

/** Resolve a dot-separated path on an object. */
export function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
