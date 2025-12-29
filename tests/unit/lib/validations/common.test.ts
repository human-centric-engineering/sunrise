/**
 * Common Validation Schema Tests
 *
 * Tests for all reusable Zod validation schemas:
 * - paginationQuerySchema
 * - sortingQuerySchema
 * - searchQuerySchema
 * - cuidSchema
 * - uuidSchema
 * - nonEmptyStringSchema
 * - urlSchema
 * - slugSchema
 * - listQuerySchema
 */

import { describe, it, expect } from 'vitest';
import {
  paginationQuerySchema,
  sortingQuerySchema,
  searchQuerySchema,
  cuidSchema,
  uuidSchema,
  nonEmptyStringSchema,
  urlSchema,
  slugSchema,
  listQuerySchema,
} from '@/lib/validations/common';

describe('paginationQuerySchema', () => {
  describe('valid pagination', () => {
    it('should accept default values', () => {
      const result = paginationQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(1);
        expect(result.data.limit).toBe(10);
      }
    });

    it('should accept valid page and limit', () => {
      const result = paginationQuerySchema.safeParse({ page: 2, limit: 20 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(2);
        expect(result.data.limit).toBe(20);
      }
    });

    it('should coerce string numbers to integers', () => {
      const result = paginationQuerySchema.safeParse({
        page: '3',
        limit: '25',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(3);
        expect(result.data.limit).toBe(25);
      }
    });

    it('should accept limit up to 100', () => {
      const result = paginationQuerySchema.safeParse({ limit: 100 });
      expect(result.success).toBe(true);
    });

    it('should accept large page numbers', () => {
      const result = paginationQuerySchema.safeParse({ page: 9999 });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid pagination', () => {
    it('should reject zero page', () => {
      const result = paginationQuerySchema.safeParse({ page: 0 });
      expect(result.success).toBe(false);
    });

    it('should reject negative page', () => {
      const result = paginationQuerySchema.safeParse({ page: -1 });
      expect(result.success).toBe(false);
    });

    it('should reject zero limit', () => {
      const result = paginationQuerySchema.safeParse({ limit: 0 });
      expect(result.success).toBe(false);
    });

    it('should reject negative limit', () => {
      const result = paginationQuerySchema.safeParse({ limit: -1 });
      expect(result.success).toBe(false);
    });

    it('should reject limit over 100', () => {
      const result = paginationQuerySchema.safeParse({ limit: 101 });
      expect(result.success).toBe(false);
    });

    it('should reject non-integer page', () => {
      const result = paginationQuerySchema.safeParse({ page: 1.5 });
      expect(result.success).toBe(false);
    });

    it('should reject non-integer limit', () => {
      const result = paginationQuerySchema.safeParse({ limit: 10.5 });
      expect(result.success).toBe(false);
    });
  });
});

describe('sortingQuerySchema', () => {
  describe('valid sorting', () => {
    it('should accept default values', () => {
      const result = sortingQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.sortOrder).toBe('desc');
        expect(result.data.sortBy).toBeUndefined();
      }
    });

    it('should accept asc order', () => {
      const result = sortingQuerySchema.safeParse({ sortOrder: 'asc' });
      expect(result.success).toBe(true);
    });

    it('should accept desc order', () => {
      const result = sortingQuerySchema.safeParse({ sortOrder: 'desc' });
      expect(result.success).toBe(true);
    });

    it('should accept sortBy field', () => {
      const result = sortingQuerySchema.safeParse({ sortBy: 'createdAt' });
      expect(result.success).toBe(true);
    });

    it('should accept both sortBy and sortOrder', () => {
      const result = sortingQuerySchema.safeParse({
        sortBy: 'name',
        sortOrder: 'asc',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid sorting', () => {
    it('should reject invalid sortOrder', () => {
      const result = sortingQuerySchema.safeParse({ sortOrder: 'invalid' });
      expect(result.success).toBe(false);
    });

    it('should reject empty sortOrder', () => {
      const result = sortingQuerySchema.safeParse({ sortOrder: '' });
      expect(result.success).toBe(false);
    });
  });
});

describe('searchQuerySchema', () => {
  describe('valid search', () => {
    it('should accept search query', () => {
      const result = searchQuerySchema.safeParse({ q: 'search term' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.q).toBe('search term');
      }
    });

    it('should trim search query', () => {
      const result = searchQuerySchema.safeParse({ q: '  search  ' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.q).toBe('search');
      }
    });

    it('should accept empty object (optional search)', () => {
      const result = searchQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.q).toBeUndefined();
      }
    });

    it('should accept special characters in search', () => {
      const result = searchQuerySchema.safeParse({ q: 'test@example.com' });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid search', () => {
    it('should convert whitespace-only search to empty string', () => {
      const result = searchQuerySchema.safeParse({ q: '   ' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.q).toBe('');
      }
    });
  });
});

describe('cuidSchema', () => {
  describe('valid CUIDs', () => {
    it('should accept valid CUID', () => {
      const result = cuidSchema.safeParse('cmjbv4i3x00003wsloputgwul');
      expect(result.success).toBe(true);
    });

    it('should accept CUID starting with c', () => {
      const result = cuidSchema.safeParse('clx1234567890123456789012');
      expect(result.success).toBe(true);
    });

    it('should accept 25-character CUID', () => {
      const result = cuidSchema.safeParse('c1234567890123456789012345'.substring(0, 25));
      expect(result.success).toBe(true);
    });
  });

  describe('invalid CUIDs', () => {
    it('should reject empty string', () => {
      const result = cuidSchema.safeParse('');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Invalid ID format');
      }
    });

    it('should reject UUID format', () => {
      const result = cuidSchema.safeParse('550e8400-e29b-41d4-a716-446655440000');
      expect(result.success).toBe(false);
    });

    it('should reject short string', () => {
      const result = cuidSchema.safeParse('c123');
      expect(result.success).toBe(false);
    });

    it('should reject string not starting with c', () => {
      const result = cuidSchema.safeParse('amjbv4i3x00003wsloputgwul');
      expect(result.success).toBe(false);
    });
  });
});

describe('uuidSchema', () => {
  describe('valid UUIDs', () => {
    it('should accept valid UUID v4', () => {
      const result = uuidSchema.safeParse('550e8400-e29b-41d4-a716-446655440000');
      expect(result.success).toBe(true);
    });

    it('should accept lowercase UUID', () => {
      const result = uuidSchema.safeParse('f47ac10b-58cc-4372-a567-0e02b2c3d479');
      expect(result.success).toBe(true);
    });

    it('should accept uppercase UUID', () => {
      const result = uuidSchema.safeParse('F47AC10B-58CC-4372-A567-0E02B2C3D479');
      expect(result.success).toBe(true);
    });
  });

  describe('invalid UUIDs', () => {
    it('should reject empty string', () => {
      const result = uuidSchema.safeParse('');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Invalid UUID format');
      }
    });

    it('should reject CUID format', () => {
      const result = uuidSchema.safeParse('cmjbv4i3x00003wsloputgwul');
      expect(result.success).toBe(false);
    });

    it('should reject malformed UUID', () => {
      const result = uuidSchema.safeParse('550e8400-e29b-41d4-a716');
      expect(result.success).toBe(false);
    });

    it('should reject UUID without hyphens', () => {
      const result = uuidSchema.safeParse('550e8400e29b41d4a716446655440000');
      expect(result.success).toBe(false);
    });
  });
});

describe('nonEmptyStringSchema', () => {
  describe('valid non-empty strings', () => {
    it('should accept non-empty string', () => {
      const result = nonEmptyStringSchema.safeParse('hello');
      expect(result.success).toBe(true);
    });

    it('should trim whitespace', () => {
      const result = nonEmptyStringSchema.safeParse('  hello  ');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe('hello');
      }
    });

    it('should accept special characters', () => {
      const result = nonEmptyStringSchema.safeParse('hello@world!');
      expect(result.success).toBe(true);
    });
  });

  describe('invalid non-empty strings', () => {
    it('should reject empty string', () => {
      const result = nonEmptyStringSchema.safeParse('');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('required');
      }
    });

    it('should reject whitespace-only string', () => {
      const result = nonEmptyStringSchema.safeParse('   ');
      expect(result.success).toBe(false);
    });
  });
});

describe('urlSchema', () => {
  describe('valid URLs', () => {
    it('should accept http URL', () => {
      const result = urlSchema.safeParse('http://example.com');
      expect(result.success).toBe(true);
    });

    it('should accept https URL', () => {
      const result = urlSchema.safeParse('https://example.com');
      expect(result.success).toBe(true);
    });

    it('should accept URL with path', () => {
      const result = urlSchema.safeParse('https://example.com/path/to/page');
      expect(result.success).toBe(true);
    });

    it('should accept URL with query parameters', () => {
      const result = urlSchema.safeParse('https://example.com?param=value');
      expect(result.success).toBe(true);
    });

    it('should accept URL with port', () => {
      const result = urlSchema.safeParse('http://localhost:3000');
      expect(result.success).toBe(true);
    });

    it('should accept URL with subdomain', () => {
      const result = urlSchema.safeParse('https://api.example.com');
      expect(result.success).toBe(true);
    });
  });

  describe('invalid URLs', () => {
    it('should reject empty string', () => {
      const result = urlSchema.safeParse('');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Invalid URL format');
      }
    });

    it('should reject URL without protocol', () => {
      const result = urlSchema.safeParse('example.com');
      expect(result.success).toBe(false);
    });

    it('should reject malformed URL', () => {
      const result = urlSchema.safeParse('not a url');
      expect(result.success).toBe(false);
    });

    it('should reject relative path', () => {
      const result = urlSchema.safeParse('/path/to/page');
      expect(result.success).toBe(false);
    });
  });
});

describe('slugSchema', () => {
  describe('valid slugs', () => {
    it('should accept lowercase alphanumeric slug', () => {
      const result = slugSchema.safeParse('my-blog-post');
      expect(result.success).toBe(true);
    });

    it('should accept slug with numbers', () => {
      const result = slugSchema.safeParse('post-123');
      expect(result.success).toBe(true);
    });

    it('should accept slug with multiple hyphens', () => {
      const result = slugSchema.safeParse('my-awesome-blog-post');
      expect(result.success).toBe(true);
    });

    it('should accept single word slug', () => {
      const result = slugSchema.safeParse('hello');
      expect(result.success).toBe(true);
    });

    it('should accept all numbers slug', () => {
      const result = slugSchema.safeParse('123');
      expect(result.success).toBe(true);
    });
  });

  describe('invalid slugs', () => {
    it('should reject empty string', () => {
      const result = slugSchema.safeParse('');
      expect(result.success).toBe(false);
    });

    it('should reject uppercase letters', () => {
      const result = slugSchema.safeParse('My-Blog-Post');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('lowercase');
      }
    });

    it('should reject spaces', () => {
      const result = slugSchema.safeParse('my blog post');
      expect(result.success).toBe(false);
    });

    it('should reject underscores', () => {
      const result = slugSchema.safeParse('my_blog_post');
      expect(result.success).toBe(false);
    });

    it('should reject special characters', () => {
      const result = slugSchema.safeParse('my-blog-post!');
      expect(result.success).toBe(false);
    });

    it('should reject leading hyphen', () => {
      const result = slugSchema.safeParse('-my-blog-post');
      expect(result.success).toBe(false);
    });

    it('should reject trailing hyphen', () => {
      const result = slugSchema.safeParse('my-blog-post-');
      expect(result.success).toBe(false);
    });

    it('should reject consecutive hyphens', () => {
      const result = slugSchema.safeParse('my--blog--post');
      expect(result.success).toBe(false);
    });
  });
});

describe('listQuerySchema', () => {
  describe('valid list queries', () => {
    it('should accept default values', () => {
      const result = listQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(1);
        expect(result.data.limit).toBe(10);
        expect(result.data.sortOrder).toBe('desc');
      }
    });

    it('should accept all parameters together', () => {
      const result = listQuerySchema.safeParse({
        page: 2,
        limit: 20,
        sortBy: 'name',
        sortOrder: 'asc',
        q: 'search',
      });
      expect(result.success).toBe(true);
    });

    it('should combine pagination, sorting, and search', () => {
      const result = listQuerySchema.safeParse({
        page: 3,
        limit: 50,
        sortBy: 'createdAt',
        sortOrder: 'desc',
        q: 'test query',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toMatchObject({
          page: 3,
          limit: 50,
          sortBy: 'createdAt',
          sortOrder: 'desc',
          q: 'test query',
        });
      }
    });
  });

  describe('invalid list queries', () => {
    it('should reject invalid pagination', () => {
      const result = listQuerySchema.safeParse({ page: 0 });
      expect(result.success).toBe(false);
    });

    it('should reject invalid sorting', () => {
      const result = listQuerySchema.safeParse({ sortOrder: 'invalid' });
      expect(result.success).toBe(false);
    });
  });
});
