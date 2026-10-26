/**
 * Unit Tests: declared credential path segments (t-933, #971)
 *
 * A short code in a page path that grants access is a credential the shape
 * rules cannot see: they leave anything under 20 characters alone. A route
 * declared in `lib/app/credential-paths.ts` (or core's `CREDENTIAL_PATHS`) has
 * its segment collapsed whatever its length, in every sink that goes through
 * `collapseDynamicSegments()`.
 *
 * The fork seam is mocked here with the ConQuest routes that motivated it, plus
 * malformed entries that must be skipped rather than guessed at. The real,
 * empty seam is exercised in `redact-path.test.ts`.
 *
 * @see lib/logging/redact-path.ts
 * @see lib/app/credential-paths.ts
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/app/credential-paths', () => ({
  appCredentialPaths: [
    '/possibilities/[publicRef]',
    '/m/[joinRef]',
    '/files/[share]/[[...path]]',
    // Malformed: each is skipped. `/[code]` would collapse every segment of
    // every path if it were tried at every offset.
    '/[code]',
    'no-leading-slash/[code]',
    '/rooms/[code',
  ],
}));

import {
  collapseDynamicSegments,
  credentialPathProblem,
  loggablePath,
  loggableUrl,
  scrubUrl,
  scrubUrlsInText,
} from '@/lib/logging/redact-path';
import { analyticsPath, analyticsUrl } from '@/lib/analytics/page-location';
import { getEndpointPath } from '@/lib/logging/context';

/** An 8-character Crockford code: far below the 20-character shape floor. */
const CODE = 'X7K2M9QD';

describe('collapseDynamicSegments with declared credential paths', () => {
  it('leaves a short code alone when its route is not declared (the gap this closes)', () => {
    expect(collapseDynamicSegments(`/rooms/${CODE}`)).toBe(`/rooms/${CODE}`);
  });

  it.each([
    [`/possibilities/${CODE}`, '/possibilities/[param]'],
    ['/m/ab12', '/m/[param]'],
    // A one-letter word is still a credential when the route says so.
    ['/m/join', '/m/[param]'],
  ])('collapses the declared segment of %s', (path, expected) => {
    expect(collapseDynamicSegments(path)).toBe(expected);
  });

  it('covers the paths below a declared route, keeping their route words', () => {
    expect(collapseDynamicSegments(`/possibilities/${CODE}/results`)).toBe(
      '/possibilities/[param]/results'
    );
  });

  it('matches further into a path: a basePath or a locale prefix does not hide the route', () => {
    expect(collapseDynamicSegments(`/app/m/${CODE}`)).toBe('/app/m/[param]');
    expect(collapseDynamicSegments(`/en/possibilities/${CODE}`)).toBe('/en/possibilities/[param]');
  });

  it('keeps a trailing slash in place', () => {
    expect(collapseDynamicSegments(`/m/${CODE}/`)).toBe('/m/[param]/');
  });

  it('needs the literal segment to match exactly', () => {
    expect(collapseDynamicSegments(`/mm/${CODE}`)).toBe(`/mm/${CODE}`);
    expect(collapseDynamicSegments(`/M/${CODE}`)).toBe(`/M/${CODE}`);
  });

  it('does not match a route with its credential segment missing', () => {
    expect(collapseDynamicSegments('/m')).toBe('/m');
    expect(collapseDynamicSegments('/m/')).toBe('/m/');
  });

  it('collapses every segment an optional catch-all declares, and matches with none', () => {
    expect(collapseDynamicSegments(`/files/${CODE}/docs/q3/report`)).toBe(
      '/files/[param]/[param]/[param]/[param]'
    );
    expect(collapseDynamicSegments(`/files/${CODE}`)).toBe('/files/[param]');
  });

  it('skips malformed entries rather than guessing at them', () => {
    // `/[code]` was skipped: nothing else is collapsed.
    expect(collapseDynamicSegments('/api/v1/admin/orchestration')).toBe(
      '/api/v1/admin/orchestration'
    );
    expect(collapseDynamicSegments(`/rooms/${CODE}`)).toBe(`/rooms/${CODE}`);
    expect(collapseDynamicSegments(`/no-leading-slash/${CODE}`)).toBe(`/no-leading-slash/${CODE}`);
  });

  it("collapses core's own declaration: better-auth's reset token, however short", () => {
    expect(collapseDynamicSegments('/api/auth/reset-password/abc123')).toBe(
      '/api/auth/reset-password/[param]'
    );
  });

  it('still applies the shape rules alongside the declarations', () => {
    expect(collapseDynamicSegments(`/m/${CODE}/u/cmtd5heg2001804ky8pgo6odx`)).toBe(
      '/m/[param]/u/[param]'
    );
  });
});

describe('every sink honours a declared credential path', () => {
  it('the proxy, rate-limit and auth catch-all lines (collapseDynamicSegments)', () => {
    expect(collapseDynamicSegments(`/m/${CODE}`)).toBe('/m/[param]');
  });

  it("the guards' and client error handler's path (loggablePath)", () => {
    expect(loggablePath(`/possibilities/${CODE}`)).toBe('/possibilities/[param]');
  });

  it("the request context's endpoint (getEndpointPath)", () => {
    expect(getEndpointPath(new Request(`https://app.example.com/m/${CODE}?x=1`))).toBe(
      '/m/[param]'
    );
  });

  it('Sentry event URLs, span names and stack text (scrubUrl, scrubUrlsInText)', () => {
    expect(scrubUrl(`https://app.example.com/m/${CODE}?ref=a`)).toBe(
      'https://app.example.com/m/[param]'
    );
    expect(scrubUrlsInText(`GET /possibilities/${CODE}`)).toBe('GET /possibilities/[param]');
  });

  it('outbound URLs the logger reduces (loggableUrl)', () => {
    expect(loggableUrl(`https://app.example.com/m/${CODE}`)).toBe(
      'https://app.example.com/m/[param]'
    );
  });

  it('page-view analytics sent to a third party (analyticsPath, analyticsUrl)', () => {
    expect(analyticsPath(`/possibilities/${CODE}`)).toBe('/possibilities/[param]');
    expect(analyticsUrl(`https://app.example.com/m/${CODE}?utm_source=news`)).toBe(
      'https://app.example.com/m/[param]?utm_source=news'
    );
  });
});

describe('credentialPathProblem', () => {
  it.each([
    '/m/[joinRef]',
    '/possibilities/[publicRef]/results',
    '/files/[...path]',
    '/files/[share]/[[...path]]',
    '/m/[joinRef]/',
  ])('accepts %j', (pattern) => {
    expect(credentialPathProblem(pattern)).toBeNull();
  });

  it.each([
    ['m/[joinRef]', 'must start with `/`'],
    ['/[code]', 'must start with a literal segment'],
    ['/[...all]', 'must start with a literal segment'],
    ['/m/[joinRef]?x=1', 'must be a path only: no query, fragment or whitespace'],
    ['/m//[joinRef]', 'has an empty segment (`//`)'],
    ['/m/joinRef', 'declares no credential segment (`[name]`)'],
    ['/m/[joinRef', '`[joinRef` is not `[name]`, `[...name]` or `[[...name]]`'],
    ['/m/ref-[code]', '`ref-[code]` is not `[name]`, `[...name]` or `[[...name]]`'],
    ['/files/[...path]/edit', 'catch-all `[...path]` must be the last segment'],
    ['', 'must start with `/`'],
    ['/', 'must start with a literal segment'],
  ])('rejects %j: %s', (pattern, reason) => {
    expect(credentialPathProblem(pattern)).toBe(reason);
  });
});
