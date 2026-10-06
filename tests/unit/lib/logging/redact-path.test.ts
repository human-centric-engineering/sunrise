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
import { collapseDynamicSegments } from '@/lib/logging/redact-path';

describe('collapseDynamicSegments', () => {
  it.each([
    ['uuid', '/api/v1/x/3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
    ['cuid', '/api/v1/x/cmtd5heg2001804ky8pgo6odx'],
    ['cuid2', '/api/v1/x/tz4a98xxat96iws9zmbrgj3a'],
    ['base64url token', '/api/v1/x/Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z'],
    ['mixed-case token with no digits', '/api/v1/x/AbcdEfghIjklMnopQrstUvwx'],
    ['hex token', '/api/v1/x/deadbeefcafebabe0123456789abcdef'],
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

  it('does not recognise an email address (documented limit — pin the pattern)', () => {
    expect(collapseDynamicSegments('/x/ada%40example.com')).toBe('/x/ada%40example.com');
  });
});
