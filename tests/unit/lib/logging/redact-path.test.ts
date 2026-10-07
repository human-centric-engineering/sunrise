/**
 * Unit Tests: collapseDynamicSegments (#685)
 *
 * The logger redacts by key name only, so a credential in a route path reaches
 * the log verbatim unless the path is collapsed first. These pin what the
 * heuristic collapses and — as importantly — what it leaves readable.
 *
 * @see lib/logging/redact-path.ts
 */

import { describe, it, expect } from 'vitest';
import { collapseDynamicSegments, loggablePath, loggableUrl } from '@/lib/logging/redact-path';

describe('collapseDynamicSegments', () => {
  it.each([
    ['uuid', '/api/v1/x/3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
    ['cuid', '/api/v1/x/cmtd5heg2001804ky8pgo6odx'],
    ['cuid2', '/api/v1/x/tz4a98xxat96iws9zmbrgj3a'],
    ['base64url token', '/api/v1/x/Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z'],
    ['mixed-case token with no digits', '/api/v1/x/AbcdEfghIjklMnopQrstUvwx'],
    ['hex token', '/api/v1/x/deadbeefcafebabe0123456789abcdef'],
    ['standard base64 token', '/api/v1/x/q8Zr+Jd0Wm4xT2pLs9VbN3kHe='],
    ['percent-encoded token', '/api/v1/x/q8Zr%2BJd0Wm4xT2pLs9VbN3kHe%3D'],
  ])('collapses a %s segment', (_label, path) => {
    expect(collapseDynamicSegments(path)).toBe('/api/v1/x/[param]');
  });

  it('collapses every sensitive segment and keeps the rest in place', () => {
    expect(
      collapseDynamicSegments(
        '/api/v1/admin/orchestration/agents/cmtd5heg2001804ky8pgo6odx/embed-tokens/cmtd5heg2001804ky8pgo6ody'
      )
    ).toBe('/api/v1/admin/orchestration/agents/[param]/embed-tokens/[param]');
  });

  it.each([
    '/api/v1/admin/orchestration',
    '/api/v1/users/123/posts',
    '/api/v1/admin/orchestration/provider-models',
    '/api/v1/knowledge/patterns/12',
    '/',
    '',
  ])('leaves %j unchanged', (path) => {
    expect(collapseDynamicSegments(path)).toBe(path);
  });

  it('leaves a 19-character token alone (documented limit)', () => {
    expect(collapseDynamicSegments('/x/Ab3dEf6hIj9kLm2nO')).toBe('/x/Ab3dEf6hIj9kLm2nO');
  });

  it.each(['ada@example.com', 'ada%40example.com', 'ADA%40EXAMPLE.COM'])(
    'collapses an email-address segment %j',
    (email) => {
      expect(collapseDynamicSegments(`/api/v1/admin/invitations/${email}`)).toBe(
        '/api/v1/admin/invitations/[param]'
      );
    }
  );

  it('collapses a JWT segment', () => {
    expect(
      collapseDynamicSegments(
        '/x/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'
      )
    ).toBe('/x/[param]');
  });

  it.each(['/blog/how-we-scaled-to-10000-users', '/pricing-2026-launch-notes-and-faq'])(
    'keeps a readable slug with numbers %j',
    (path) => {
      expect(collapseDynamicSegments(path)).toBe(path);
    }
  );

  it('still collapses a token that contains a hyphen', () => {
    expect(collapseDynamicSegments('/x/Ab3dEf6hIj9kLm2-Op5qRs8tUv1wXy4z')).toBe('/x/[param]');
  });
});

describe('loggablePath', () => {
  it('passes undefined through and collapses a present path', () => {
    expect(loggablePath(undefined)).toBeUndefined();
    expect(loggablePath('/api/v1/x/cmtd5heg2001804ky8pgo6odx')).toBe('/api/v1/x/[param]');
  });
});

describe('loggableUrl (#953)', () => {
  it('collapses a credential-shaped path segment and keeps the origin', () => {
    expect(
      loggableUrl('https://hooks.slack.com/services/T0000/B0000/AbCdEfGhIjKlMnOpQrStUvWx')
    ).toBe('https://hooks.slack.com/services/T0000/B0000/[param]');
  });

  it('drops the query string and fragment', () => {
    expect(loggableUrl('https://files.example.com/doc.pdf?sig=abc123&expires=1#page=2')).toBe(
      'https://files.example.com/doc.pdf'
    );
  });

  it('drops userinfo', () => {
    expect(loggableUrl('https://user:hunter2@example.com/hook')).toBe('https://example.com/hook');
  });

  it('keeps a non-default port and an ordinary path', () => {
    expect(loggableUrl('http://localhost:8080/api/notify')).toBe(
      'http://localhost:8080/api/notify'
    );
  });

  it('passes null and undefined through', () => {
    expect(loggableUrl(null)).toBeNull();
    expect(loggableUrl(undefined)).toBeUndefined();
  });

  it('never echoes a value it cannot parse', () => {
    expect(loggableUrl('not a url ?api_key=abc')).toBe('[unparseable-url]');
  });
});
