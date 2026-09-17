/**
 * Tests: lib/tenancy/resolver.ts — the proxy's tenant-resolver registry (§106)
 *
 * Small on purpose, and the one property that matters is the last: a
 * resolver that throws answers `null`, because the proxy runs it on every
 * request and a fork's bug must strip the header, never 500 the site.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  __resetTenantResolverForTests,
  hasTenantResolver,
  registerTenantResolver,
  resolveTenantFromRequest,
  TENANT_HEADER_NAME,
} from '@/lib/tenancy/resolver';

const request = (host: string) => new Request('https://example.test/x', { headers: { host } });

beforeEach(() => __resetTenantResolverForTests());

describe('tenant resolver registry', () => {
  it('names the header the proxy writes and the guards read', () => {
    expect(TENANT_HEADER_NAME).toBe('x-sunrise-org');
  });

  it('has no resolver by default, and answers null', () => {
    expect(hasTenantResolver()).toBe(false);
    expect(resolveTenantFromRequest(request('acme.example.test'))).toBeNull();
  });

  it('asks the registered resolver with the request', () => {
    registerTenantResolver((req) => req.headers.get('host')?.split('.')[0] ?? null);
    expect(hasTenantResolver()).toBe(true);
    expect(resolveTenantFromRequest(request('acme.example.test'))).toBe('acme');
  });

  it('treats an empty string and a non-string as no answer', () => {
    registerTenantResolver(() => '');
    expect(resolveTenantFromRequest(request('x'))).toBeNull();
    registerTenantResolver(() => 42 as unknown as string);
    expect(resolveTenantFromRequest(request('x'))).toBeNull();
  });

  it('a throwing resolver is no answer, never a throw — and the caller is told', () => {
    const boom = new Error('fork bug');
    registerTenantResolver(() => {
      throw boom;
    });
    const onError = vi.fn();
    expect(resolveTenantFromRequest(request('x'), onError)).toBeNull();
    expect(onError).toHaveBeenCalledWith(boom);
    // Without a callback it still does not throw.
    expect(resolveTenantFromRequest(request('x'))).toBeNull();
  });

  it('refuses an answer that is not org-id shaped, so the proxy never throws at Headers.set', () => {
    for (const bad of [
      'evil\r\nx-injected: 1',
      'has space',
      'ünïcode',
      'a'.repeat(201),
      'slash/id',
    ]) {
      registerTenantResolver(() => bad);
      expect(resolveTenantFromRequest(request('x')), bad).toBeNull();
    }
    for (const good of ['install', 'cmorg000000000000000other', 'acme-corp_2']) {
      registerTenantResolver(() => good);
      expect(resolveTenantFromRequest(request('x'))).toBe(good);
    }
  });

  it('registering again replaces the first', () => {
    registerTenantResolver(() => 'first');
    registerTenantResolver(() => 'second');
    expect(resolveTenantFromRequest(request('x'))).toBe('second');
  });
});
