/**
 * Authentication Validation Schema Tests
 *
 * Tests for all auth-related Zod validation schemas:
 * - passwordSchema
 * - emailSchema
 * - signUpSchema
 * - signInSchema
 * - changePasswordSchema
 * - resetPasswordRequestSchema
 * - resetPasswordSchema
 * - verifyEmailSchema
 */

import { describe, it, expect } from 'vitest';
import {
  passwordSchema,
  emailSchema,
  signUpSchema,
  signInSchema,
  changePasswordSchema,
  resetPasswordRequestSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from '@/lib/validations/auth';

describe('passwordSchema', () => {
  describe('valid passwords', () => {
    it('should accept password with all required criteria', () => {
      const result = passwordSchema.safeParse('Password123!');
      expect(result.success).toBe(true);
    });

    it('should accept password with 8 characters minimum', () => {
      const result = passwordSchema.safeParse('Pass123!');
      expect(result.success).toBe(true);
    });

    it('should accept password up to 100 characters', () => {
      const longPassword = 'Password123!' + 'a'.repeat(88); // 100 chars total
      const result = passwordSchema.safeParse(longPassword);
      expect(result.success).toBe(true);
    });

    it('should accept password with various special characters', () => {
      const passwords = [
        'Pass123!@#$',
        'Pass123%^&*()',
        'Pass123-_=+',
        'Pass123[]{};',
        'Pass123<>,.?/',
      ];

      passwords.forEach((password) => {
        const result = passwordSchema.safeParse(password);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('invalid passwords', () => {
    it('should reject password shorter than 8 characters', () => {
      const result = passwordSchema.safeParse('Pass12!');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('at least 8 characters');
      }
    });

    it('should reject password longer than 100 characters', () => {
      const longPassword = 'Password123!' + 'a'.repeat(89); // 101 chars
      const result = passwordSchema.safeParse(longPassword);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('less than 100 characters');
      }
    });

    it('should reject password without uppercase letter', () => {
      const result = passwordSchema.safeParse('password123!');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('uppercase letter');
      }
    });

    it('should reject password without lowercase letter', () => {
      const result = passwordSchema.safeParse('PASSWORD123!');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('lowercase letter');
      }
    });

    it('should reject password without number', () => {
      const result = passwordSchema.safeParse('Password!');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('number');
      }
    });

    it('should reject password without special character', () => {
      const result = passwordSchema.safeParse('Password123');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('special character');
      }
    });

    it('should reject empty string', () => {
      const result = passwordSchema.safeParse('');
      expect(result.success).toBe(false);
    });
  });
});

describe('emailSchema', () => {
  describe('valid emails', () => {
    it('should accept standard email format', () => {
      const result = emailSchema.safeParse('user@example.com');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe('user@example.com');
      }
    });

    it('should convert email to lowercase', () => {
      const result = emailSchema.safeParse('User@Example.COM');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe('user@example.com');
      }
    });

    it('should normalize email with leading/trailing whitespace', () => {
      // Transforms (trim, toLowerCase) are applied before validation
      const result = emailSchema.safeParse('  USER@EXAMPLE.COM  ');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe('user@example.com');
      }
    });

    it('should accept email with subdomain', () => {
      const result = emailSchema.safeParse('user@mail.example.com');
      expect(result.success).toBe(true);
    });

    it('should accept email with plus addressing', () => {
      const result = emailSchema.safeParse('user+tag@example.com');
      expect(result.success).toBe(true);
    });

    it('should accept email with dots in local part', () => {
      const result = emailSchema.safeParse('first.last@example.com');
      expect(result.success).toBe(true);
    });
  });

  describe('invalid emails', () => {
    it('should reject empty string', () => {
      const result = emailSchema.safeParse('');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('required');
      }
    });

    it('should reject whitespace-only input', () => {
      // After trim(), whitespace becomes empty string and fails min(1)
      const result = emailSchema.safeParse('   ');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('required');
      }
    });

    it('should reject invalid email format', () => {
      const invalidEmails = [
        'notanemail',
        '@example.com',
        'user@',
        'user @example.com',
        'user@example',
      ];

      invalidEmails.forEach((email) => {
        const result = emailSchema.safeParse(email);
        expect(result.success).toBe(false);
      });
    });

    it('should reject email longer than 255 characters', () => {
      const longEmail = 'a'.repeat(244) + '@example.com'; // 256 chars
      const result = emailSchema.safeParse(longEmail);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('less than 255 characters');
      }
    });
  });
});

describe('signUpSchema', () => {
  const validSignUpData = {
    email: 'user@example.com',
    password: 'Password123!',
    name: 'John Doe',
    confirmPassword: 'Password123!',
  };

  describe('valid sign-up data', () => {
    it('should accept valid sign-up data', () => {
      const result = signUpSchema.safeParse(validSignUpData);
      expect(result.success).toBe(true);
    });

    it('should trim name', () => {
      const result = signUpSchema.safeParse({
        ...validSignUpData,
        name: '  John Doe  ',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('John Doe');
      }
    });

    it('should accept name up to 100 characters', () => {
      const result = signUpSchema.safeParse({
        ...validSignUpData,
        name: 'a'.repeat(100),
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid sign-up data', () => {
    it('should reject when passwords do not match', () => {
      const result = signUpSchema.safeParse({
        ...validSignUpData,
        confirmPassword: 'DifferentPassword123!',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("don't match");
        expect(result.error.issues[0].path).toContain('confirmPassword');
      }
    });

    it('should reject empty name', () => {
      const result = signUpSchema.safeParse({
        ...validSignUpData,
        name: '',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('required');
      }
    });

    it('should reject name longer than 100 characters', () => {
      const result = signUpSchema.safeParse({
        ...validSignUpData,
        name: 'a'.repeat(101),
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('less than 100 characters');
      }
    });

    it('should reject invalid email', () => {
      const result = signUpSchema.safeParse({
        ...validSignUpData,
        email: 'invalid-email',
      });
      expect(result.success).toBe(false);
    });

    it('should reject weak password', () => {
      const result = signUpSchema.safeParse({
        ...validSignUpData,
        password: 'weak',
        confirmPassword: 'weak',
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('signInSchema', () => {
  describe('valid sign-in data', () => {
    it('should accept valid email and password', () => {
      const result = signInSchema.safeParse({
        email: 'user@example.com',
        password: 'any-password',
      });
      expect(result.success).toBe(true);
    });

    it('should not validate password strength on login', () => {
      const result = signInSchema.safeParse({
        email: 'user@example.com',
        password: 'weak',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid sign-in data', () => {
    it('should reject empty password', () => {
      const result = signInSchema.safeParse({
        email: 'user@example.com',
        password: '',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('required');
      }
    });

    it('should reject invalid email', () => {
      const result = signInSchema.safeParse({
        email: 'invalid-email',
        password: 'password',
      });
      expect(result.success).toBe(false);
    });

    it('should reject password longer than 100 characters', () => {
      const result = signInSchema.safeParse({
        email: 'user@example.com',
        password: 'a'.repeat(101),
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('changePasswordSchema', () => {
  const validChangePasswordData = {
    currentPassword: 'OldPassword123!',
    newPassword: 'NewPassword123!',
    confirmPassword: 'NewPassword123!',
  };

  describe('valid password change data', () => {
    it('should accept valid password change', () => {
      const result = changePasswordSchema.safeParse(validChangePasswordData);
      expect(result.success).toBe(true);
    });
  });

  describe('invalid password change data', () => {
    it('should reject when passwords do not match', () => {
      const result = changePasswordSchema.safeParse({
        ...validChangePasswordData,
        confirmPassword: 'DifferentPassword123!',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("don't match");
      }
    });

    it('should reject when new password is same as current password', () => {
      const result = changePasswordSchema.safeParse({
        currentPassword: 'Password123!',
        newPassword: 'Password123!',
        confirmPassword: 'Password123!',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('must be different');
        expect(result.error.issues[0].path).toContain('newPassword');
      }
    });

    it('should reject empty current password', () => {
      const result = changePasswordSchema.safeParse({
        ...validChangePasswordData,
        currentPassword: '',
      });
      expect(result.success).toBe(false);
    });

    it('should reject weak new password', () => {
      const result = changePasswordSchema.safeParse({
        currentPassword: 'OldPassword123!',
        newPassword: 'weak',
        confirmPassword: 'weak',
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('resetPasswordRequestSchema', () => {
  describe('valid reset request', () => {
    it('should accept valid email', () => {
      const result = resetPasswordRequestSchema.safeParse({
        email: 'user@example.com',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid reset request', () => {
    it('should reject invalid email', () => {
      const result = resetPasswordRequestSchema.safeParse({
        email: 'invalid-email',
      });
      expect(result.success).toBe(false);
    });

    it('should reject empty email', () => {
      const result = resetPasswordRequestSchema.safeParse({ email: '' });
      expect(result.success).toBe(false);
    });
  });
});

describe('resetPasswordSchema', () => {
  const validResetPasswordData = {
    token: 'valid-reset-token',
    password: 'NewPassword123!',
    confirmPassword: 'NewPassword123!',
  };

  describe('valid password reset', () => {
    it('should accept valid reset data', () => {
      const result = resetPasswordSchema.safeParse(validResetPasswordData);
      expect(result.success).toBe(true);
    });
  });

  describe('invalid password reset', () => {
    it('should reject when passwords do not match', () => {
      const result = resetPasswordSchema.safeParse({
        ...validResetPasswordData,
        confirmPassword: 'DifferentPassword123!',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("don't match");
      }
    });

    it('should reject empty token', () => {
      const result = resetPasswordSchema.safeParse({
        ...validResetPasswordData,
        token: '',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('required');
      }
    });

    it('should reject weak password', () => {
      const result = resetPasswordSchema.safeParse({
        token: 'valid-token',
        password: 'weak',
        confirmPassword: 'weak',
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('verifyEmailSchema', () => {
  describe('valid email verification', () => {
    it('should accept valid token', () => {
      const result = verifyEmailSchema.safeParse({
        token: 'valid-verification-token',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid email verification', () => {
    it('should reject empty token', () => {
      const result = verifyEmailSchema.safeParse({ token: '' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('required');
      }
    });

    it('should reject missing token', () => {
      const result = verifyEmailSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });
});
