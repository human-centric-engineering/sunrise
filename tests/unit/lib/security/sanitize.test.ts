/**
 * Input Sanitization Unit Tests
 *
 * Tests for XSS prevention and input sanitization utilities.
 *
 * @see lib/security/sanitize.ts
 */

import { describe, it, expect } from 'vitest';
import {
  escapeHtml,
  stripHtml,
  sanitizeUrl,
  sanitizeRedirectUrl,
  safeCallbackUrl,
  isRootRelativePath,
  normalizeRootRelativePath,
  sanitizeObject,
  sanitizeFilename,
} from '@/lib/security/sanitize';

describe('Input Sanitization', () => {
  describe('escapeHtml', () => {
    it('should escape HTML special characters', () => {
      expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
      expect(escapeHtml('"quotes"')).toBe('&quot;quotes&quot;');
      expect(escapeHtml("'apostrophe'")).toBe('&#x27;apostrophe&#x27;');
      expect(escapeHtml('a & b')).toBe('a &amp; b');
    });

    it('should escape XSS vectors', () => {
      const xssVectors = [
        '<script>alert("xss")</script>',
        '<img src=x onerror=alert(1)>',
        '<svg onload=alert(1)>',
        '"><script>alert(1)</script>',
        "javascript:alert('xss')",
        '<a href="javascript:alert(1)">click</a>',
      ];

      for (const vector of xssVectors) {
        const escaped = escapeHtml(vector);
        expect(escaped).not.toContain('<script');
        expect(escaped).not.toContain('<img');
        expect(escaped).not.toContain('<svg');
        expect(escaped).not.toContain('<a');
      }
    });

    it('should handle empty and invalid input', () => {
      expect(escapeHtml('')).toBe('');
      expect(escapeHtml(null as unknown as string)).toBe('');
      expect(escapeHtml(undefined as unknown as string)).toBe('');
    });

    it('should preserve safe text', () => {
      expect(escapeHtml('Hello, World!')).toBe('Hello, World!');
      expect(escapeHtml('user@example.com')).toBe('user@example.com');
      expect(escapeHtml('123-456-7890')).toBe('123-456-7890');
    });
  });

  describe('stripHtml', () => {
    it('should remove all HTML tags', () => {
      expect(stripHtml('<p>Hello</p>')).toBe('Hello');
      expect(stripHtml('<div><span>Nested</span></div>')).toBe('Nested');
      expect(stripHtml('<script>alert(1)</script>')).toBe('alert(1)');
    });

    it('should preserve text content between tags', () => {
      expect(stripHtml('<p>Hello <strong>World</strong>!</p>')).toBe('Hello World!');
      expect(stripHtml('<a href="http://example.com">Link Text</a>')).toBe('Link Text');
    });

    it('should handle empty and invalid input', () => {
      expect(stripHtml('')).toBe('');
      expect(stripHtml(null as unknown as string)).toBe('');
    });

    it('should handle self-closing tags', () => {
      expect(stripHtml('Hello<br/>World')).toBe('HelloWorld');
      expect(stripHtml('Image: <img src="x"/>')).toBe('Image: ');
    });

    it('should strip interleaved/nested tag markup without leaving a tag', () => {
      // Adversarial markup must not survive as a usable <...> tag.
      expect(stripHtml('<scr<script>ipt>alert(1)')).not.toContain('<script');
      const stripped = stripHtml('<<a>b<c>d>');
      expect(stripped).not.toMatch(/<[^>]*>/);
    });

    it('should be idempotent', () => {
      const once = stripHtml('<div><span>x</span></div>');
      expect(stripHtml(once)).toBe(once);
    });
  });

  describe('sanitizeUrl', () => {
    it('should allow safe URLs', () => {
      expect(sanitizeUrl('https://example.com')).toBe('https://example.com');
      expect(sanitizeUrl('http://example.com')).toBe('http://example.com');
      expect(sanitizeUrl('/relative/path')).toBe('/relative/path');
      expect(sanitizeUrl('relative/path')).toBe('relative/path');
    });

    it('should block javascript: protocol', () => {
      expect(sanitizeUrl('javascript:alert(1)')).toBe('');
      expect(sanitizeUrl('JAVASCRIPT:alert(1)')).toBe('');
      expect(sanitizeUrl('  javascript:alert(1)')).toBe('');
    });

    it('should block data: protocol', () => {
      expect(sanitizeUrl('data:text/html,<script>alert(1)</script>')).toBe('');
      expect(sanitizeUrl('DATA:text/html,test')).toBe('');
    });

    it('should block vbscript: protocol', () => {
      expect(sanitizeUrl('vbscript:msgbox("xss")')).toBe('');
    });

    it('should block file: protocol', () => {
      expect(sanitizeUrl('file:///etc/passwd')).toBe('');
    });

    it('should handle empty and invalid input', () => {
      expect(sanitizeUrl('')).toBe('');
      expect(sanitizeUrl(null as unknown as string)).toBe('');
    });

    // Regression: the scheme check used to run on `url.trim().toLowerCase()`,
    // but `trim()` removes only LEADING/TRAILING whitespace. The WHATWG URL
    // parser strips tab/newline/CR from anywhere in a URL and drops leading C0
    // controls BEFORE reading the scheme, so each vector below was returned
    // unchanged by the sanitizer and then executed by the browser as
    // `javascript:`.
    describe('control-character scheme bypass', () => {
      const TAB = String.fromCharCode(0x09);
      const NEWLINE = String.fromCharCode(0x0a);
      const CR = String.fromCharCode(0x0d);
      const C0_CONTROL = String.fromCharCode(0x01);

      it('should block a tab inside the scheme', () => {
        expect(sanitizeUrl(`java${TAB}script:alert(1)`)).toBe('');
      });

      it('should block a newline inside the scheme', () => {
        expect(sanitizeUrl(`java${NEWLINE}script:alert(1)`)).toBe('');
      });

      it('should block a carriage return inside the scheme', () => {
        expect(sanitizeUrl(`java${CR}script:alert(1)`)).toBe('');
      });

      it('should block a tab before the colon', () => {
        expect(sanitizeUrl(`javascript${TAB}:alert(1)`)).toBe('');
      });

      it('should block a leading C0 control character', () => {
        // `trim()` removes whitespace but NOT \x01-\x08 / \x0e-\x1f.
        expect(sanitizeUrl(`${C0_CONTROL}javascript:alert(1)`)).toBe('');
      });

      it('should block control-character obfuscation of every dangerous scheme', () => {
        expect(sanitizeUrl(`da${TAB}ta:text/html,<script>alert(1)</script>`)).toBe('');
        expect(sanitizeUrl(`vb${NEWLINE}script:msgbox("xss")`)).toBe('');
        expect(sanitizeUrl(`fi${TAB}le:///etc/passwd`)).toBe('');
      });

      // The switch from `trim()` to an explicit character class fixed the
      // control-char bypass but dropped the non-ASCII whitespace `trim()` had
      // been removing. None of these is browser-executable — scheme parsing
      // fails on a non-ALPHA first character, so they are treated as relative
      // URLs — but the class strips them so the guard is never narrower than
      // the `trim()` it replaced.
      it('should block unicode whitespace before the scheme', () => {
        const NBSP = String.fromCharCode(0x00a0);
        const BOM = String.fromCharCode(0xfeff);
        const LINE_SEP = String.fromCharCode(0x2028);
        const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);

        expect(sanitizeUrl(`${NBSP}javascript:alert(1)`)).toBe('');
        expect(sanitizeUrl(`${BOM}javascript:alert(1)`)).toBe('');
        expect(sanitizeUrl(`${LINE_SEP}javascript:alert(1)`)).toBe('');
        expect(sanitizeUrl(`${IDEOGRAPHIC_SPACE}javascript:alert(1)`)).toBe('');
      });

      it('should block unicode whitespace inside the scheme', () => {
        const EN_QUAD = String.fromCharCode(0x2000);
        const NARROW_NBSP = String.fromCharCode(0x202f);

        expect(sanitizeUrl(`java${EN_QUAD}script:alert(1)`)).toBe('');
        expect(sanitizeUrl(`javascript${NARROW_NBSP}:alert(1)`)).toBe('');
      });

      it('should still return a URL whose PATH contains unicode whitespace', () => {
        // The widened class must not start rewriting legitimate URLs — it only
        // ever touches the inspected copy.
        const NBSP = String.fromCharCode(0x00a0);
        const url = `https://example.com/a${NBSP}b`;
        expect(sanitizeUrl(url)).toBe(url);
      });

      it('should return safe URLs VERBATIM, not the stripped copy', () => {
        // Only the inspected copy is normalised. Rewriting the returned value
        // would corrupt legitimate URLs — a space in a path is valid, and
        // callers rely on getting back exactly what they passed in.
        expect(sanitizeUrl('https://example.com/a b')).toBe('https://example.com/a b');
        expect(sanitizeUrl('https://example.com/a?b=c#d')).toBe('https://example.com/a?b=c#d');
        expect(sanitizeUrl('mailto:someone@example.com')).toBe('mailto:someone@example.com');
      });
    });
  });

  describe('sanitizeRedirectUrl', () => {
    const baseUrl = 'https://app.example.com';

    it('should allow same-origin redirects', () => {
      expect(sanitizeRedirectUrl('/dashboard', baseUrl)).toBe('/dashboard');
      expect(sanitizeRedirectUrl('/user/profile?tab=settings', baseUrl)).toBe(
        '/user/profile?tab=settings'
      );
      expect(sanitizeRedirectUrl('https://app.example.com/page', baseUrl)).toBe('/page');
    });

    it('should block cross-origin redirects', () => {
      expect(sanitizeRedirectUrl('https://evil.com', baseUrl)).toBe('/');
      expect(sanitizeRedirectUrl('https://evil.com/steal?cookie=x', baseUrl)).toBe('/');
      expect(sanitizeRedirectUrl('//evil.com', baseUrl)).toBe('/');
    });

    it('should allow whitelisted external hosts', () => {
      const allowedHosts = ['docs.example.com', 'help.example.com'];
      expect(sanitizeRedirectUrl('https://docs.example.com/guide', baseUrl, allowedHosts)).toBe(
        'https://docs.example.com/guide'
      );
      expect(sanitizeRedirectUrl('https://evil.com', baseUrl, allowedHosts)).toBe('/');
    });

    it('should handle invalid URLs', () => {
      expect(sanitizeRedirectUrl('not-a-valid-url://test', baseUrl)).toBe('/');
      expect(sanitizeRedirectUrl('', baseUrl)).toBe('/');
      expect(sanitizeRedirectUrl(null as unknown as string, baseUrl)).toBe('/');
    });

    it('should return pathname only for same-origin full URLs', () => {
      // Full same-origin URLs should return just the path
      expect(sanitizeRedirectUrl('https://app.example.com/settings', baseUrl)).toBe('/settings');
      expect(sanitizeRedirectUrl('https://app.example.com/search?q=test#results', baseUrl)).toBe(
        '/search?q=test#results'
      );
    });
  });

  describe('safeCallbackUrl', () => {
    it('should allow relative paths', () => {
      expect(safeCallbackUrl('/dashboard')).toBe('/dashboard');
      expect(safeCallbackUrl('/settings?tab=profile')).toBe('/settings?tab=profile');
      expect(safeCallbackUrl('/admin/users')).toBe('/admin/users');
    });

    it('should block absolute external URLs', () => {
      expect(safeCallbackUrl('https://evil.com')).toBe('/');
      expect(safeCallbackUrl('https://evil.com/steal')).toBe('/');
      expect(safeCallbackUrl('http://evil.com')).toBe('/');
    });

    it('should block protocol-relative URLs', () => {
      expect(safeCallbackUrl('//evil.com')).toBe('/');
      expect(safeCallbackUrl('//evil.com/path')).toBe('/');
    });

    it('should block backslash-prefixed paths the WHATWG URL parser treats as protocol-relative', () => {
      // new URL('/\\evil.com', 'https://good.example.com').href === 'https://evil.com/'
      expect(safeCallbackUrl('/\\evil.com')).toBe('/');
      expect(safeCallbackUrl('/\\evil.com', '/dashboard')).toBe('/dashboard');
    });

    it('should block dangerous protocols', () => {
      expect(safeCallbackUrl('javascript:alert(1)')).toBe('/');
      expect(safeCallbackUrl('data:text/html,<script>alert(1)</script>')).toBe('/');
    });

    it('should use custom fallback', () => {
      expect(safeCallbackUrl('https://evil.com', '/dashboard')).toBe('/dashboard');
      expect(safeCallbackUrl(null, '/dashboard')).toBe('/dashboard');
    });

    it('should handle null and empty values', () => {
      expect(safeCallbackUrl(null)).toBe('/');
      expect(safeCallbackUrl('')).toBe('/');
      expect(safeCallbackUrl(undefined as unknown as string)).toBe('/');
    });

    // Reachable sink: login-form.tsx reads `callbackUrl` off the query string
    // and router.push()es it on success. Next resolves it with
    // `new URL(href, location.href)`, sees a different origin, and hard-navigates
    // — the victim authenticates on the genuine page and lands on the attacker's.
    it.each([
      ['%09 / tab', '/\t/evil.com'],
      ['%0A / LF', '/\n/evil.com'],
      ['%0D / CR', '/\r/evil.com'],
      ['LF then backslash', '/\n\\evil.com'],
    ])('rejects a %s control-character redirect (open redirect)', (_label, payload) => {
      expect(safeCallbackUrl(payload)).toBe('/');
      expect(safeCallbackUrl(payload, '/dashboard')).toBe('/dashboard');
    });

    it('returns the normalized value so the judged string is the navigated string', () => {
      expect(safeCallbackUrl('/dash\tboard')).toBe('/dashboard');
    });

    it('preserves a space in a legitimate query string', () => {
      expect(safeCallbackUrl('/search?q=two words')).toBe('/search?q=two words');
    });
  });

  describe('isRootRelativePath', () => {
    it('should accept root-relative paths', () => {
      expect(isRootRelativePath('/dashboard')).toBe(true);
      expect(isRootRelativePath('/app/home')).toBe(true);
    });

    it('should reject protocol-relative and backslash-prefixed paths', () => {
      expect(isRootRelativePath('//evil.com')).toBe(false);
      expect(isRootRelativePath('/\\evil.com')).toBe(false);
    });

    it('should reject paths with no leading slash', () => {
      expect(isRootRelativePath('dashboard')).toBe(false);
    });

    // The WHATWG parser removes tab/LF/CR from anywhere in the input before it
    // reads the authority, so these survive `trim()` and a naive `path[1]` test
    // and then collapse to `//evil.com`. Asserted against the real parser below
    // so the test fails if that platform behaviour is what ever changes.
    it.each([
      ['tab', '/\t/evil.com'],
      ['LF', '/\n/evil.com'],
      ['CR', '/\r/evil.com'],
      ['LF then backslash', '/\n\\evil.com'],
      ['tab then backslash', '/\t\\evil.com'],
    ])('should reject a %s smuggled after the leading slash', (_label, path) => {
      expect(new URL(path, 'https://good.example.com').origin).toBe('https://evil.com');
      expect(isRootRelativePath(path)).toBe(false);
      expect(normalizeRootRelativePath(path)).toBeNull();
    });
  });

  describe('normalizeRootRelativePath', () => {
    it('returns the normalized path, not the raw input', () => {
      // The value that was judged safe must be the value the caller navigates
      // to — returning the raw string would re-open the hole, since the parser
      // acts on the stripped form.
      expect(normalizeRootRelativePath('/dash\tboard')).toBe('/dashboard');
      expect(normalizeRootRelativePath('/dashboard')).toBe('/dashboard');
    });

    it('does NOT strip spaces — the wider C0 class would corrupt real queries', () => {
      // URL_NORMALIZE_STRIP covers U+0020 and is correct for scheme inspection,
      // where the result is only compared. This value gets navigated to.
      expect(normalizeRootRelativePath('/search?q=two words')).toBe('/search?q=two words');
    });

    it('returns null for off-origin forms', () => {
      expect(normalizeRootRelativePath('//evil.com')).toBeNull();
      expect(normalizeRootRelativePath('/\\evil.com')).toBeNull();
      expect(normalizeRootRelativePath('https://evil.com')).toBeNull();
      expect(normalizeRootRelativePath('dashboard')).toBeNull();
    });
  });

  describe('sanitizeObject', () => {
    it('should sanitize all string values in an object', () => {
      const input = {
        name: '<script>alert(1)</script>',
        bio: 'Hello <b>World</b>',
      };

      const result = sanitizeObject(input);

      expect(result.name).not.toContain('<script>');
      expect(result.bio).not.toContain('<b>');
    });

    it('should recursively sanitize nested objects', () => {
      const input = {
        user: {
          profile: {
            displayName: '<img onerror=alert(1)>',
          },
        },
      };

      const result = sanitizeObject(input);

      expect(result.user.profile.displayName).not.toContain('<img');
    });

    it('should sanitize arrays of strings', () => {
      const input = {
        tags: ['<script>xss</script>', 'safe-tag', '<img src=x>'],
      };

      const result = sanitizeObject(input);

      expect(result.tags[0]).not.toContain('<script>');
      expect(result.tags[1]).toBe('safe-tag');
      expect(result.tags[2]).not.toContain('<img');
    });

    it('should sanitize arrays of objects', () => {
      const input = {
        items: [{ name: '<script>xss</script>' }, { name: 'safe' }],
      };

      const result = sanitizeObject(input);

      expect(result.items[0].name).not.toContain('<script>');
      expect(result.items[1].name).toBe('safe');
    });

    it('should preserve non-string values', () => {
      const input = {
        count: 42,
        active: true,
        nullable: null,
        items: [1, 2, 3],
      };

      const result = sanitizeObject(input);

      expect(result.count).toBe(42);
      expect(result.active).toBe(true);
      expect(result.nullable).toBe(null);
      expect(result.items).toEqual([1, 2, 3]);
    });

    it('should use custom sanitizer when provided', () => {
      const input = {
        text: 'Hello <b>World</b>',
      };

      const result = sanitizeObject(input, stripHtml);

      expect(result.text).toBe('Hello World');
    });
  });

  describe('sanitizeFilename', () => {
    it('should remove path traversal sequences', () => {
      expect(sanitizeFilename('../../../etc/passwd')).toBe('etc_passwd');
      expect(sanitizeFilename('..\\..\\windows\\system32')).toBe('windows_system32');
    });

    it('should not leave a traversal sequence that a single pass would re-form', () => {
      // `....//` collapses to `../` under a single non-looping replace.
      expect(sanitizeFilename('....//etc')).not.toContain('..');
      expect(sanitizeFilename('....\\\\etc')).not.toContain('..');
      expect(sanitizeFilename('....//etc/passwd')).toBe('etc_passwd');
    });

    it('should remove absolute path indicators', () => {
      expect(sanitizeFilename('/etc/passwd')).toBe('etc_passwd');
      expect(sanitizeFilename('\\windows\\system32')).toBe('windows_system32');
    });

    it('should replace path separators with underscores', () => {
      expect(sanitizeFilename('folder/file.txt')).toBe('folder_file.txt');
      expect(sanitizeFilename('folder\\file.txt')).toBe('folder_file.txt');
    });

    it('should remove null bytes', () => {
      expect(sanitizeFilename('file\0.txt')).toBe('file.txt');
    });

    it('should preserve normal filenames', () => {
      expect(sanitizeFilename('document.pdf')).toBe('document.pdf');
      expect(sanitizeFilename('my-file_v2.tar.gz')).toBe('my-file_v2.tar.gz');
      expect(sanitizeFilename('image (1).png')).toBe('image (1).png');
    });

    it('should limit filename length', () => {
      const longName = 'a'.repeat(300) + '.txt';
      const result = sanitizeFilename(longName);
      expect(result.length).toBeLessThanOrEqual(255);
    });

    it('should handle empty and invalid input', () => {
      expect(sanitizeFilename('')).toBe('');
      expect(sanitizeFilename(null as unknown as string)).toBe('');
    });
  });
});
