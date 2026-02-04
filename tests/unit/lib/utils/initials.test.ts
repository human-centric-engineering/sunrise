/**
 * User Display Utilities Tests
 *
 * Tests for getInitials() and getRoleBadgeVariant() utility functions
 */

import { describe, it, expect } from 'vitest';
import { getInitials, getRoleBadgeVariant } from '@/lib/utils/initials';

describe('getInitials()', () => {
  describe('normal names', () => {
    it('should return 2 initials for full name', () => {
      const result = getInitials('John Doe');
      expect(result).toBe('JD');
    });

    it('should return uppercase initials', () => {
      const result = getInitials('john doe');
      expect(result).toBe('JD');
    });

    it('should handle mixed case names', () => {
      const result = getInitials('jOhN dOe');
      expect(result).toBe('JD');
    });

    it('should return 1 initial for single name', () => {
      const result = getInitials('John');
      expect(result).toBe('J');
    });

    it('should handle single lowercase name', () => {
      const result = getInitials('john');
      expect(result).toBe('J');
    });
  });

  describe('multiple names', () => {
    it('should return only first 2 initials for 3 names', () => {
      const result = getInitials('John Michael Doe');
      expect(result).toBe('JM');
    });

    it('should return only first 2 initials for 4+ names', () => {
      const result = getInitials('John Michael Joseph Doe');
      expect(result).toBe('JM');
    });

    it('should handle long names with many parts', () => {
      const result = getInitials('John Michael Joseph Alexander Christopher Doe');
      expect(result).toBe('JM');
    });
  });

  describe('whitespace handling', () => {
    it('should handle leading spaces', () => {
      const result = getInitials('  John Doe');
      expect(result).toBe('JD');
    });

    it('should handle trailing spaces', () => {
      const result = getInitials('John Doe  ');
      expect(result).toBe('JD');
    });

    it('should handle extra spaces between names', () => {
      const result = getInitials('John   Doe');
      expect(result).toBe('JD');
    });

    it('should handle multiple leading and trailing spaces', () => {
      const result = getInitials('   John   Doe   ');
      expect(result).toBe('JD');
    });
  });

  describe('empty and whitespace-only input', () => {
    it('should return "?" for empty string', () => {
      const result = getInitials('');
      expect(result).toBe('?');
    });

    it('should return "?" for space-only string', () => {
      const result = getInitials('   ');
      expect(result).toBe('?');
    });

    it('should return "?" for many spaces', () => {
      const result = getInitials('          ');
      expect(result).toBe('?');
    });
  });

  describe('special characters', () => {
    it('should handle names with hyphens', () => {
      const result = getInitials('Mary-Jane Watson');
      expect(result).toBe('MW');
    });

    it('should handle names with apostrophes', () => {
      const result = getInitials("O'Brien Smith");
      expect(result).toBe('OS');
    });

    it('should handle names with periods', () => {
      const result = getInitials('Dr. John Doe');
      expect(result).toBe('DJ');
    });

    it('should handle names with accented characters', () => {
      const result = getInitials('José García');
      expect(result).toBe('JG');
    });

    it('should handle names with unicode characters', () => {
      const result = getInitials('François Müller');
      expect(result).toBe('FM');
    });
  });

  describe('edge cases', () => {
    it('should handle single character name', () => {
      const result = getInitials('J');
      expect(result).toBe('J');
    });

    it('should handle two single character names', () => {
      const result = getInitials('J D');
      expect(result).toBe('JD');
    });

    it('should handle name with only first letter visible', () => {
      const result = getInitials('J.');
      expect(result).toBe('J');
    });

    it('should return consistent results for same name', () => {
      const name = 'John Doe';
      const result1 = getInitials(name);
      const result2 = getInitials(name);
      expect(result1).toBe(result2);
    });
  });

  describe('return value', () => {
    it('should always return a string', () => {
      const result = getInitials('John Doe');
      expect(typeof result).toBe('string');
    });

    it('should never return more than 2 characters (except for "?")', () => {
      const result = getInitials('John Michael Joseph Doe');
      expect(result.length).toBeLessThanOrEqual(2);
    });

    it('should always return uppercase letters', () => {
      const result = getInitials('john doe');
      expect(result).toBe(result.toUpperCase());
    });

    it('should return exactly 1 character for fallback', () => {
      const result = getInitials('');
      expect(result.length).toBe(1);
      expect(result).toBe('?');
    });
  });
});

describe('getRoleBadgeVariant()', () => {
  describe('ADMIN role', () => {
    it('should return "default" for ADMIN role', () => {
      const result = getRoleBadgeVariant('ADMIN');
      expect(result).toBe('default');
    });

    it('should be case-sensitive (lowercase admin not matched)', () => {
      const result = getRoleBadgeVariant('admin');
      expect(result).toBe('outline');
    });

    it('should be case-sensitive (mixed case Admin not matched)', () => {
      const result = getRoleBadgeVariant('Admin');
      expect(result).toBe('outline');
    });
  });

  describe('other roles', () => {
    it('should return "outline" for USER role', () => {
      const result = getRoleBadgeVariant('USER');
      expect(result).toBe('outline');
    });

    it('should return "outline" for MODERATOR role', () => {
      const result = getRoleBadgeVariant('MODERATOR');
      expect(result).toBe('outline');
    });

    it('should return "outline" for GUEST role', () => {
      const result = getRoleBadgeVariant('GUEST');
      expect(result).toBe('outline');
    });

    it('should return "outline" for SUPER_ADMIN role', () => {
      const result = getRoleBadgeVariant('SUPER_ADMIN');
      expect(result).toBe('outline');
    });

    it('should return "outline" for unknown role', () => {
      const result = getRoleBadgeVariant('UNKNOWN_ROLE');
      expect(result).toBe('outline');
    });

    it('should return "outline" for empty string', () => {
      const result = getRoleBadgeVariant('');
      expect(result).toBe('outline');
    });
  });

  describe('null handling', () => {
    it('should return "outline" for null', () => {
      const result = getRoleBadgeVariant(null);
      expect(result).toBe('outline');
    });
  });

  describe('edge cases', () => {
    it('should return "outline" for role with whitespace', () => {
      const result = getRoleBadgeVariant('  ADMIN  ');
      expect(result).toBe('outline');
    });

    it('should return "outline" for role with special characters', () => {
      const result = getRoleBadgeVariant('ADMIN!');
      expect(result).toBe('outline');
    });

    it('should return consistent results for same role', () => {
      const role = 'ADMIN';
      const result1 = getRoleBadgeVariant(role);
      const result2 = getRoleBadgeVariant(role);
      expect(result1).toBe(result2);
    });

    it('should return consistent results for null', () => {
      const result1 = getRoleBadgeVariant(null);
      const result2 = getRoleBadgeVariant(null);
      expect(result1).toBe(result2);
    });
  });

  describe('return value', () => {
    it('should always return one of the valid badge variants', () => {
      const validVariants = ['default', 'secondary', 'outline'];
      const result1 = getRoleBadgeVariant('ADMIN');
      const result2 = getRoleBadgeVariant('USER');
      const result3 = getRoleBadgeVariant(null);

      expect(validVariants).toContain(result1);
      expect(validVariants).toContain(result2);
      expect(validVariants).toContain(result3);
    });

    it('should always return a string', () => {
      const result = getRoleBadgeVariant('ADMIN');
      expect(typeof result).toBe('string');
    });
  });
});
