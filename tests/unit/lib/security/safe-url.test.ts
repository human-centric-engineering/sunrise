/**
 * Tests for `checkSafeProviderUrl` — the SSRF guard used on
 * `AiProviderConfig.baseUrl`.
 */

import { describe, it, expect } from 'vitest';
import { checkSafeProviderUrl, isSafeProviderUrl } from '@/lib/security/safe-url';

describe('checkSafeProviderUrl', () => {
  describe('schemes', () => {
    it('accepts https', () => {
      expect(checkSafeProviderUrl('https://api.openai.com/v1').ok).toBe(true);
    });

    it('accepts http for non-local public hosts', () => {
      expect(checkSafeProviderUrl('http://api.example.com/').ok).toBe(true);
    });

    it.each(['file:///etc/passwd', 'gopher://evil/', 'javascript:alert(1)', 'data:,hi', 'ftp://x'])(
      'rejects %s',
      (url) => {
        const result = checkSafeProviderUrl(url);
        expect(result.ok).toBe(false);
        // file:// has no host and is often rejected as invalid_url by WHATWG parsing —
        // accept either reason
        expect(['disallowed_scheme', 'invalid_url']).toContain(result.reason);
      }
    );

    it('rejects totally malformed input', () => {
      expect(checkSafeProviderUrl('not a url').ok).toBe(false);
    });
  });

  describe('cloud metadata hosts', () => {
    it.each([
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/',
      'http://metadata.goog/',
      'http://100.100.100.200/',
    ])('blocks %s', (url) => {
      const result = checkSafeProviderUrl(url, { allowLoopback: true });
      expect(result.ok).toBe(false);
    });
  });

  describe('unspecified address', () => {
    it('blocks 0.0.0.0', () => {
      expect(checkSafeProviderUrl('http://0.0.0.0/').ok).toBe(false);
    });

    it('blocks bracketed ::', () => {
      expect(checkSafeProviderUrl('http://[::]/').ok).toBe(false);
    });
  });

  describe('loopback handling', () => {
    it.each(['http://localhost/', 'http://127.0.0.1:11434/', 'http://[::1]/'])(
      'rejects %s without allowLoopback',
      (url) => {
        const result = checkSafeProviderUrl(url);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('loopback_not_allowed');
      }
    );

    it.each([
      'http://localhost:11434/v1',
      'http://127.0.0.1:1234/v1',
      'http://[::1]:8080/',
      'http://host.docker.internal:11434/',
    ])('accepts %s with allowLoopback', (url) => {
      expect(checkSafeProviderUrl(url, { allowLoopback: true }).ok).toBe(true);
    });
  });

  describe('private IP ranges (always blocked, even with allowLoopback)', () => {
    it.each([
      'http://10.0.0.1/',
      'http://10.255.255.1/',
      'http://172.16.0.1/',
      'http://172.31.255.1/',
      'http://192.168.1.1/',
      'http://100.64.0.1/', // CGNAT
    ])('blocks %s', (url) => {
      const result = checkSafeProviderUrl(url, { allowLoopback: true });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('private_ip');
    });

    it('allows 172.15.x.x (just outside RFC1918)', () => {
      expect(checkSafeProviderUrl('http://172.15.0.1/').ok).toBe(true);
    });

    it('allows 172.32.x.x (just outside RFC1918)', () => {
      expect(checkSafeProviderUrl('http://172.32.0.1/').ok).toBe(true);
    });
  });

  describe('link-local', () => {
    it('blocks 169.254.0.0/16', () => {
      expect(checkSafeProviderUrl('http://169.254.100.100/', { allowLoopback: true }).ok).toBe(
        false
      );
    });

    it('blocks IPv6 link-local fe80::', () => {
      expect(checkSafeProviderUrl('http://[fe80::1]/', { allowLoopback: true }).ok).toBe(false);
    });
  });

  describe('IPv6 unique local', () => {
    it('blocks fc00::/7', () => {
      expect(checkSafeProviderUrl('http://[fc00::1]/', { allowLoopback: true }).ok).toBe(false);
      expect(checkSafeProviderUrl('http://[fd12:3456::1]/', { allowLoopback: true }).ok).toBe(
        false
      );
    });
  });

  describe('public hosts', () => {
    it.each([
      'https://api.openai.com/v1',
      'https://api.anthropic.com',
      'https://api.together.xyz/v1',
      'https://api.groq.com/openai/v1',
    ])('accepts %s', (url) => {
      expect(checkSafeProviderUrl(url).ok).toBe(true);
    });
  });

  describe('isSafeProviderUrl wrapper', () => {
    it('returns true for safe URLs', () => {
      expect(isSafeProviderUrl('https://api.openai.com/v1')).toBe(true);
    });

    it('returns false for unsafe URLs', () => {
      expect(isSafeProviderUrl('http://169.254.169.254/')).toBe(false);
    });
  });
});
