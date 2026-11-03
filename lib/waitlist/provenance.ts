/**
 * Where a waitlist join came from (§125): the reader's language and the host
 * that sent them. Both are length-capped and reduced to what attribution needs —
 * a language tag, a host — so a crafted header or referrer cannot store a URL
 * with a query string full of someone's identifiers.
 */

const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/i;

/** The first language in an `Accept-Language` header, or null. */
export function localeFromAcceptLanguage(header: string | null): string | null {
  if (!header) return null;
  const first = header.split(',')[0]?.split(';')[0]?.trim() ?? '';
  return first.length <= 35 && LANGUAGE_TAG.test(first) ? first : null;
}

/** The host of an http(s) referrer, or null. Path and query are dropped. */
export function referrerHost(referrer: string | null): string | null {
  if (!referrer) return null;
  try {
    const url = new URL(referrer);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname.slice(0, 253) || null;
  } catch {
    return null;
  }
}
