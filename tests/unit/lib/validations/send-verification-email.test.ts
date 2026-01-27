/**
 * Unit Tests for Send Verification Email Validation Schema
 *
 * Tests for sendVerificationEmailSchema from lib/validations/auth.ts
 *
 * Coverage:
 * - Valid email addresses (common formats)
 * - Invalid email formats (missing parts, malformed)
 * - Missing/empty email field
 * - Email normalization (lowercase)
 * - Type safety
 */

import { describe, it, expect } from 'vitest';
import { sendVerificationEmailSchema } from '@/lib/validations/auth';
import type { SendVerificationEmailInput } from '@/lib/validations/auth';

describe('lib/validations/auth - sendVerificationEmailSchema', () => {
  describe('valid inputs', () => {
    it('should accept standard email', () => {
      const result = sendVerificationEmailSchema.safeParse({
        email: 'user@example.com',
      });
      expect(result.success).toBe(true);
    });

    it('should accept email with subdomain', () => {
      const result = sendVerificationEmailSchema.safeParse({
        email: 'user@mail.example.com',
      });
      expect(result.success).toBe(true);
    });

    it('should accept email with plus sign', () => {
      const result = sendVerificationEmailSchema.safeParse({
        email: 'user+tag@example.com',
      });
      expect(result.success).toBe(true);
    });

    it('should accept email with dots and hyphens', () => {
      const result = sendVerificationEmailSchema.safeParse({
        email: 'user.name-test@example-domain.com',
      });
      expect(result.success).toBe(true);
    });

    it('should accept email with numbers', () => {
      const result = sendVerificationEmailSchema.safeParse({
        email: 'user123@example456.com',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('email normalization', () => {
    it('should convert email to lowercase', () => {
      const result = sendVerificationEmailSchema.safeParse({
        email: 'USER@EXAMPLE.COM',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBe('user@example.com');
      }
    });

    it('should convert mixed case to lowercase', () => {
      const result = sendVerificationEmailSchema.safeParse({
        email: 'UsEr@ExAmPlE.CoM',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBe('user@example.com');
      }
    });
  });

  describe('invalid email formats', () => {
    it('should reject email without @ symbol', () => {
      const result = sendVerificationEmailSchema.safeParse({
        email: 'userexample.com',
      });
      expect(result.success).toBe(false);
    });

    it('should reject email without domain', () => {
      const result = sendVerificationEmailSchema.safeParse({
        email: 'user@',
      });
      expect(result.success).toBe(false);
    });

    it('should reject email without local part', () => {
      const result = sendVerificationEmailSchema.safeParse({
        email: '@example.com',
      });
      expect(result.success).toBe(false);
    });

    it('should reject email with spaces', () => {
      const result = sendVerificationEmailSchema.safeParse({
        email: 'user name@example.com',
      });
      expect(result.success).toBe(false);
    });

    it('should reject plain text', () => {
      const result = sendVerificationEmailSchema.safeParse({
        email: 'not an email',
      });
      expect(result.success).toBe(false);
    });

    it('should reject email with surrounding whitespace', () => {
      const result = sendVerificationEmailSchema.safeParse({
        email: '  user@example.com  ',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('missing or empty email', () => {
    it('should reject missing email field', () => {
      const result = sendVerificationEmailSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('should reject empty string email', () => {
      const result = sendVerificationEmailSchema.safeParse({
        email: '',
      });
      expect(result.success).toBe(false);
    });

    it('should reject null email', () => {
      const result = sendVerificationEmailSchema.safeParse({
        email: null,
      });
      expect(result.success).toBe(false);
    });

    it('should reject undefined email', () => {
      const result = sendVerificationEmailSchema.safeParse({
        email: undefined,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('invalid types', () => {
    it('should reject number as email', () => {
      const result = sendVerificationEmailSchema.safeParse({
        email: 12345,
      });
      expect(result.success).toBe(false);
    });

    it('should reject boolean as email', () => {
      const result = sendVerificationEmailSchema.safeParse({
        email: true,
      });
      expect(result.success).toBe(false);
    });

    it('should reject object as email', () => {
      const result = sendVerificationEmailSchema.safeParse({
        email: { address: 'user@example.com' },
      });
      expect(result.success).toBe(false);
    });

    it('should reject array as email', () => {
      const result = sendVerificationEmailSchema.safeParse({
        email: ['user@example.com'],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('extra fields', () => {
    it('should strip extra fields from input', () => {
      const result = sendVerificationEmailSchema.safeParse({
        email: 'user@example.com',
        extraField: 'should be removed',
        anotherField: 123,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ email: 'user@example.com' });
        expect(result.data).not.toHaveProperty('extraField');
      }
    });
  });

  describe('type inference', () => {
    it('should have correct TypeScript type', () => {
      const input: SendVerificationEmailInput = {
        email: 'user@example.com',
      };
      const result = sendVerificationEmailSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        const email: string = result.data.email;
        expect(email).toBe('user@example.com');
      }
    });
  });

  describe('parse vs safeParse', () => {
    it('should throw error with parse() for invalid input', () => {
      expect(() =>
        sendVerificationEmailSchema.parse({
          email: 'invalid-email',
        })
      ).toThrow();
    });

    it('should return success object with safeParse() for valid input', () => {
      const result = sendVerificationEmailSchema.safeParse({
        email: 'valid@example.com',
      });
      expect(result.success).toBe(true);
    });

    it('should return error object with safeParse() for invalid input', () => {
      const result = sendVerificationEmailSchema.safeParse({
        email: 'invalid-email',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeDefined();
      }
    });
  });
});
