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
