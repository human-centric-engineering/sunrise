/**
 * Tests for `lib/orchestration/http/allowlist.ts`.
 *
 * Covers:
 *   - env-var parsing (csv, whitespace tolerance, empty entries dropped)
 *   - hostname normalisation (case-insensitive)
 *   - cache invalidation when env var changes
 *   - URL parse failures return false rather than throwing
 *   - empty allowlist denies everything
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ALLOWED_HOSTS_ENV,
  isHostAllowed,
  resetAllowlistCache,
} from '@/lib/orchestration/http/allowlist';

describe('allowlist', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetAllowlistCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetAllowlistCache();
  });

  it('allows hosts listed in the env var', () => {
    process.env[ALLOWED_HOSTS_ENV] = 'api.example.com,other.example.com';
    expect(isHostAllowed('https://api.example.com/v1/foo')).toBe(true);
    expect(isHostAllowed('https://other.example.com/x')).toBe(true);
  });

  it('rejects hosts not in the env var', () => {
    process.env[ALLOWED_HOSTS_ENV] = 'api.example.com';
    expect(isHostAllowed('https://evil.com/path')).toBe(false);
  });

  it('treats hostname matching as case-insensitive', () => {
    process.env[ALLOWED_HOSTS_ENV] = 'API.EXAMPLE.COM';
    expect(isHostAllowed('https://api.example.com/x')).toBe(true);
    expect(isHostAllowed('https://Api.Example.Com/x')).toBe(true);
  });

  it('tolerates whitespace and empty entries in the csv', () => {
    process.env[ALLOWED_HOSTS_ENV] = ' api.example.com , , other.example.com ';
    expect(isHostAllowed('https://api.example.com/x')).toBe(true);
    expect(isHostAllowed('https://other.example.com/x')).toBe(true);
  });

  it('returns false for malformed URLs rather than throwing', () => {
    process.env[ALLOWED_HOSTS_ENV] = 'api.example.com';
    expect(isHostAllowed('not-a-url')).toBe(false);
    expect(isHostAllowed('')).toBe(false);
  });

  it('denies everything when the env var is unset', () => {
    delete process.env[ALLOWED_HOSTS_ENV];
    expect(isHostAllowed('https://api.example.com/x')).toBe(false);
  });

  it('denies everything when the env var is empty', () => {
    process.env[ALLOWED_HOSTS_ENV] = '';
    expect(isHostAllowed('https://api.example.com/x')).toBe(false);
  });

  it('caches across calls when env var is unchanged', () => {
    process.env[ALLOWED_HOSTS_ENV] = 'api.example.com';
    expect(isHostAllowed('https://api.example.com/x')).toBe(true);
    // Second call hits cache; behaviour identical.
    expect(isHostAllowed('https://api.example.com/y')).toBe(true);
  });

  it('refreshes when env var changes', () => {
    process.env[ALLOWED_HOSTS_ENV] = 'a.example.com';
    expect(isHostAllowed('https://a.example.com/x')).toBe(true);
    expect(isHostAllowed('https://b.example.com/x')).toBe(false);

    process.env[ALLOWED_HOSTS_ENV] = 'b.example.com';
    expect(isHostAllowed('https://a.example.com/x')).toBe(false);
    expect(isHostAllowed('https://b.example.com/x')).toBe(true);
  });

  it('resetAllowlistCache forces re-read on next call', () => {
    process.env[ALLOWED_HOSTS_ENV] = 'a.example.com';
    expect(isHostAllowed('https://a.example.com/x')).toBe(true);
    resetAllowlistCache();
    process.env[ALLOWED_HOSTS_ENV] = 'b.example.com';
    expect(isHostAllowed('https://b.example.com/x')).toBe(true);
  });
});
