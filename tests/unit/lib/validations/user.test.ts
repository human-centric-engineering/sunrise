/**
 * User Validation Schema Tests
 *
 * Tests for all user-related Zod validation schemas:
 * - updateUserSchema
 * - listUsersQuerySchema
 * - userIdSchema
 * - inviteUserSchema
 * - acceptInvitationSchema
 *
 * Note: createUserSchema has been removed (password-based creation removed).
 * Use inviteUserSchema for admin-initiated user creation instead.
 */

import { describe, it, expect } from 'vitest';
import {
  updateUserSchema,
  listUsersQuerySchema,
  userIdSchema,
  inviteUserSchema,
  acceptInvitationSchema,
  emailPreferencesSchema,
  userPreferencesSchema,
  updatePreferencesSchema,
  deleteAccountSchema,
} from '@/lib/validations/user';

describe('updateUserSchema', () => {
  describe('valid update data', () => {
    it('should accept valid name update', () => {
      const result = updateUserSchema.safeParse({
        name: 'John Doe',
      });
      expect(result.success).toBe(true);
    });

    it('should accept valid email update', () => {
      const result = updateUserSchema.safeParse({
        email: 'newemail@example.com',
      });
      expect(result.success).toBe(true);
    });

    it('should accept both name and email update', () => {
      const result = updateUserSchema.safeParse({
        name: 'John Doe',
        email: 'john@example.com',
      });
      expect(result.success).toBe(true);
    });

    it('should accept empty object (all fields optional)', () => {
      const result = updateUserSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('should trim name whitespace', () => {
      const result = updateUserSchema.safeParse({
        name: '  John Doe  ',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('John Doe');
      }
    });

    it('should reject email with leading/trailing whitespace', () => {
      const result = updateUserSchema.safeParse({
        email: '  USER@EXAMPLE.COM  ',
      });
      // In Zod 4, trim() is applied after validation, so this fails email format check
      expect(result.success).toBe(false);
    });

    it('should accept name up to 100 characters', () => {
      const result = updateUserSchema.safeParse({
        name: 'a'.repeat(100),
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid update data', () => {
    it('should reject empty name when provided', () => {
      const result = updateUserSchema.safeParse({
        name: '',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('cannot be empty');
      }
    });

    it('should reject name longer than 100 characters', () => {
      const result = updateUserSchema.safeParse({
        name: 'a'.repeat(101),
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('less than 100 characters');
      }
    });

    it('should reject invalid email format', () => {
      const result = updateUserSchema.safeParse({
        email: 'invalid-email',
      });
      expect(result.success).toBe(false);
    });

    it('should accept name with only whitespace (optional field)', () => {
      const result = updateUserSchema.safeParse({
        name: '   ',
      });
      // Name is optional, so whitespace-only is trimmed to empty and that's OK
      // The field is simply omitted
      expect(result.success).toBe(true);
    });
  });

  describe('extended profile fields (Phase 3.2)', () => {
    it('should accept valid bio', () => {
      const result = updateUserSchema.safeParse({
        bio: 'Software developer with a passion for building great products.',
      });
      expect(result.success).toBe(true);
    });

    it('should accept bio up to 500 characters', () => {
      const result = updateUserSchema.safeParse({
        bio: 'a'.repeat(500),
      });
      expect(result.success).toBe(true);
    });

    it('should reject bio over 500 characters', () => {
      const result = updateUserSchema.safeParse({
        bio: 'a'.repeat(501),
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('500 characters');
      }
    });

    it('should accept null bio (to clear field)', () => {
      const result = updateUserSchema.safeParse({
        bio: null,
      });
      expect(result.success).toBe(true);
    });

    it('should accept valid phone number', () => {
      const result = updateUserSchema.safeParse({
        phone: '+1 (555) 123-4567',
      });
      expect(result.success).toBe(true);
    });

    it('should accept phone with only digits', () => {
      const result = updateUserSchema.safeParse({
        phone: '5551234567',
      });
      expect(result.success).toBe(true);
    });

    it('should reject phone with invalid characters', () => {
      const result = updateUserSchema.safeParse({
        phone: '+1-555-CALL-ME',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Invalid phone number format');
      }
    });

    it('should reject phone over 20 characters', () => {
      const result = updateUserSchema.safeParse({
        phone: '+1 (555) 123-4567-999999',
      });
      expect(result.success).toBe(false);
    });

    it('should accept null phone (to clear field)', () => {
      const result = updateUserSchema.safeParse({
        phone: null,
      });
      expect(result.success).toBe(true);
    });

    it('should accept valid timezone', () => {
      const result = updateUserSchema.safeParse({
        timezone: 'America/New_York',
      });
      expect(result.success).toBe(true);
    });

    it('should reject timezone over 50 characters', () => {
      const result = updateUserSchema.safeParse({
        timezone: 'a'.repeat(51),
      });
      expect(result.success).toBe(false);
    });

    it('should accept valid location', () => {
      const result = updateUserSchema.safeParse({
        location: 'San Francisco, CA',
      });
      expect(result.success).toBe(true);
    });

    it('should reject location over 100 characters', () => {
      const result = updateUserSchema.safeParse({
        location: 'a'.repeat(101),
      });
      expect(result.success).toBe(false);
    });

    it('should accept null location (to clear field)', () => {
      const result = updateUserSchema.safeParse({
        location: null,
      });
      expect(result.success).toBe(true);
    });

    it('should accept all extended fields together', () => {
      const result = updateUserSchema.safeParse({
        name: 'John Doe',
        bio: 'Software developer',
        phone: '+1 (555) 123-4567',
        timezone: 'America/New_York',
        location: 'New York, NY',
      });
      expect(result.success).toBe(true);
    });
  });
});

describe('listUsersQuerySchema', () => {
  describe('valid query parameters', () => {
    it('should accept default values', () => {
      const result = listUsersQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(1);
        expect(result.data.limit).toBe(20);
        expect(result.data.sortBy).toBe('createdAt');
        expect(result.data.sortOrder).toBe('desc');
      }
    });

    it('should accept valid pagination parameters', () => {
      const result = listUsersQuerySchema.safeParse({
        page: 2,
        limit: 50,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(2);
        expect(result.data.limit).toBe(50);
      }
    });

    it('should accept string numbers for pagination (coercion)', () => {
      const result = listUsersQuerySchema.safeParse({
        page: '3',
        limit: '25',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(3);
        expect(result.data.limit).toBe(25);
      }
    });

    it('should accept search query', () => {
      const result = listUsersQuerySchema.safeParse({
        search: 'john',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.search).toBe('john');
      }
    });

    it('should trim search query', () => {
      const result = listUsersQuerySchema.safeParse({
        search: '  john doe  ',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.search).toBe('john doe');
      }
    });

    it('should accept all sortBy values', () => {
      const sortFields = ['name', 'email', 'createdAt'];

      sortFields.forEach((sortBy) => {
        const result = listUsersQuerySchema.safeParse({ sortBy });
        expect(result.success).toBe(true);
      });
    });

    it('should accept both sort orders', () => {
      const orders = ['asc', 'desc'];

      orders.forEach((sortOrder) => {
        const result = listUsersQuerySchema.safeParse({ sortOrder });
        expect(result.success).toBe(true);
      });
    });

    it('should accept all parameters together', () => {
      const result = listUsersQuerySchema.safeParse({
        page: 2,
        limit: 50,
        search: 'john',
        sortBy: 'name',
        sortOrder: 'asc',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid query parameters', () => {
    it('should reject zero page number', () => {
      const result = listUsersQuerySchema.safeParse({ page: 0 });
      expect(result.success).toBe(false);
    });

    it('should reject negative page number', () => {
      const result = listUsersQuerySchema.safeParse({ page: -1 });
      expect(result.success).toBe(false);
    });

    it('should reject zero limit', () => {
      const result = listUsersQuerySchema.safeParse({ limit: 0 });
      expect(result.success).toBe(false);
    });

    it('should reject negative limit', () => {
      const result = listUsersQuerySchema.safeParse({ limit: -1 });
      expect(result.success).toBe(false);
    });

    it('should reject limit over 100', () => {
      const result = listUsersQuerySchema.safeParse({ limit: 101 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Maximum limit is 100');
      }
    });

    it('should reject non-integer page', () => {
      const result = listUsersQuerySchema.safeParse({ page: 1.5 });
      expect(result.success).toBe(false);
    });

    it('should reject non-integer limit', () => {
      const result = listUsersQuerySchema.safeParse({ limit: 10.5 });
      expect(result.success).toBe(false);
    });

    it('should reject invalid sortBy value', () => {
      const result = listUsersQuerySchema.safeParse({ sortBy: 'invalid' });
      expect(result.success).toBe(false);
    });

    it('should reject invalid sortOrder value', () => {
      const result = listUsersQuerySchema.safeParse({ sortOrder: 'invalid' });
      expect(result.success).toBe(false);
    });
  });
});

describe('userIdSchema', () => {
  describe('valid user IDs', () => {
    it('should accept valid CUID', () => {
      const result = userIdSchema.safeParse({
        id: 'cmjbv4i3x00003wsloputgwul',
      });
      expect(result.success).toBe(true);
    });

    it('should accept CUID starting with c', () => {
      const result = userIdSchema.safeParse({
        id: 'clx1234567890123456789012',
      });
      expect(result.success).toBe(true);
    });

    it('should accept 25-character CUID', () => {
      const result = userIdSchema.safeParse({
        id: 'c1234567890123456789012345'.substring(0, 25),
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid user IDs', () => {
    it('should reject empty string', () => {
      const result = userIdSchema.safeParse({ id: '' });
      expect(result.success).toBe(false);
    });

    it('should reject non-CUID format', () => {
      const result = userIdSchema.safeParse({ id: 'invalid-id' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Invalid ID format');
      }
    });

    it('should reject UUID format (not CUID)', () => {
      const result = userIdSchema.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result.success).toBe(false);
    });

    it('should reject short string', () => {
      const result = userIdSchema.safeParse({ id: 'c123' });
      expect(result.success).toBe(false);
    });

    it('should reject number instead of string', () => {
      const result = userIdSchema.safeParse({ id: 12345 });
      expect(result.success).toBe(false);
    });
  });
});

describe('inviteUserSchema', () => {
  const validInviteData = {
    name: 'Jane Smith',
    email: 'jane@example.com',
    role: 'USER' as const,
  };

  describe('valid invitation data', () => {
    it('should accept valid invitation data with all fields', () => {
      const result = inviteUserSchema.safeParse(validInviteData);
      expect(result.success).toBe(true);
    });

    it('should use default role of USER when not provided', () => {
      const { role: _role, ...dataWithoutRole } = validInviteData;
      const result = inviteUserSchema.safeParse(dataWithoutRole);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.role).toBe('USER');
      }
    });

    it('should accept ADMIN role', () => {
      const result = inviteUserSchema.safeParse({
        ...validInviteData,
        role: 'ADMIN',
      });
      expect(result.success).toBe(true);
    });

    it('should trim name', () => {
      const result = inviteUserSchema.safeParse({
        ...validInviteData,
        name: '  Jane Smith  ',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('Jane Smith');
      }
    });

    it('should reject email with leading/trailing whitespace', () => {
      const result = inviteUserSchema.safeParse({
        ...validInviteData,
        email: '  JANE@EXAMPLE.COM  ',
      });
      expect(result.success).toBe(false);
    });

    it('should accept name up to 100 characters', () => {
      const result = inviteUserSchema.safeParse({
        ...validInviteData,
        name: 'a'.repeat(100),
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid invitation data', () => {
    it('should reject missing name', () => {
      const { name: _name, ...dataWithoutName } = validInviteData;
      const result = inviteUserSchema.safeParse(dataWithoutName);
      expect(result.success).toBe(false);
    });

    it('should reject empty name', () => {
      const result = inviteUserSchema.safeParse({
        ...validInviteData,
        name: '',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('required');
      }
    });

    it('should reject name longer than 100 characters', () => {
      const result = inviteUserSchema.safeParse({
        ...validInviteData,
        name: 'a'.repeat(101),
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('less than 100 characters');
      }
    });

    it('should reject missing email', () => {
      const { email: _email, ...dataWithoutEmail } = validInviteData;
      const result = inviteUserSchema.safeParse(dataWithoutEmail);
      expect(result.success).toBe(false);
    });

    it('should reject invalid email format', () => {
      const result = inviteUserSchema.safeParse({
        ...validInviteData,
        email: 'invalid-email',
      });
      expect(result.success).toBe(false);
    });

    it('should reject invalid role', () => {
      const result = inviteUserSchema.safeParse({
        ...validInviteData,
        role: 'INVALID_ROLE',
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('acceptInvitationSchema', () => {
  const validAcceptData = {
    token: 'valid-token-string-123',
    email: 'jane@example.com',
    password: 'Password123!',
    confirmPassword: 'Password123!',
  };

  describe('valid acceptance data', () => {
    it('should accept valid acceptance data', () => {
      const result = acceptInvitationSchema.safeParse(validAcceptData);
      expect(result.success).toBe(true);
    });

    it('should accept token with various characters', () => {
      const result = acceptInvitationSchema.safeParse({
        ...validAcceptData,
        token: 'abc123-DEF456_ghi789',
      });
      expect(result.success).toBe(true);
    });

    it('should accept long token strings', () => {
      const result = acceptInvitationSchema.safeParse({
        ...validAcceptData,
        token: 'a'.repeat(100),
      });
      expect(result.success).toBe(true);
    });

    it('should reject email with leading/trailing whitespace', () => {
      const result = acceptInvitationSchema.safeParse({
        ...validAcceptData,
        email: '  JANE@EXAMPLE.COM  ',
      });
      expect(result.success).toBe(false);
    });

    it('should accept strong password meeting requirements', () => {
      const result = acceptInvitationSchema.safeParse({
        ...validAcceptData,
        password: 'StrongP@ssw0rd!',
        confirmPassword: 'StrongP@ssw0rd!',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid acceptance data', () => {
    it('should reject missing token', () => {
      const { token: _token, ...dataWithoutToken } = validAcceptData;
      const result = acceptInvitationSchema.safeParse(dataWithoutToken);
      expect(result.success).toBe(false);
    });

    it('should reject empty token', () => {
      const result = acceptInvitationSchema.safeParse({
        ...validAcceptData,
        token: '',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('required');
      }
    });

    it('should reject missing email', () => {
      const { email: _email, ...dataWithoutEmail } = validAcceptData;
      const result = acceptInvitationSchema.safeParse(dataWithoutEmail);
      expect(result.success).toBe(false);
    });

    it('should reject invalid email format', () => {
      const result = acceptInvitationSchema.safeParse({
        ...validAcceptData,
        email: 'invalid-email',
      });
      expect(result.success).toBe(false);
    });

    it('should reject missing password', () => {
      const { password: _password, ...dataWithoutPassword } = validAcceptData;
      const result = acceptInvitationSchema.safeParse(dataWithoutPassword);
      expect(result.success).toBe(false);
    });

    it('should reject weak password', () => {
      const result = acceptInvitationSchema.safeParse({
        ...validAcceptData,
        password: 'weak',
        confirmPassword: 'weak',
      });
      expect(result.success).toBe(false);
    });

    it('should reject missing confirmPassword', () => {
      const { confirmPassword: _confirmPassword, ...dataWithoutConfirm } = validAcceptData;
      const result = acceptInvitationSchema.safeParse(dataWithoutConfirm);
      expect(result.success).toBe(false);
    });

    it('should reject when passwords do not match', () => {
      const result = acceptInvitationSchema.safeParse({
        ...validAcceptData,
        password: 'Password123!',
        confirmPassword: 'DifferentPassword123!',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("don't match");
        expect(result.error.issues[0].path).toEqual(['confirmPassword']);
      }
    });

    it('should reject when confirmPassword is empty even if password is valid', () => {
      const result = acceptInvitationSchema.safeParse({
        ...validAcceptData,
        password: 'Password123!',
        confirmPassword: '',
      });
      expect(result.success).toBe(false);
    });

    it('should reject when both passwords are empty', () => {
      const result = acceptInvitationSchema.safeParse({
        ...validAcceptData,
        password: '',
        confirmPassword: '',
      });
      expect(result.success).toBe(false);
    });
  });
});

/**
 * Phase 3.2: Email and User Preferences Schemas
 */
describe('emailPreferencesSchema', () => {
  describe('valid preferences', () => {
    it('should accept valid preferences with all fields', () => {
      const result = emailPreferencesSchema.safeParse({
        marketing: true,
        productUpdates: true,
        securityAlerts: true,
      });
      expect(result.success).toBe(true);
    });

    it('should use defaults for missing fields', () => {
      const result = emailPreferencesSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.marketing).toBe(false);
        expect(result.data.productUpdates).toBe(true);
        expect(result.data.securityAlerts).toBe(true);
      }
    });

    it('should accept marketing as false', () => {
      const result = emailPreferencesSchema.safeParse({
        marketing: false,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.marketing).toBe(false);
      }
    });

    it('should accept productUpdates as false', () => {
      const result = emailPreferencesSchema.safeParse({
        productUpdates: false,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.productUpdates).toBe(false);
      }
    });
  });

  describe('invalid preferences', () => {
    it('should reject non-boolean marketing value', () => {
      const result = emailPreferencesSchema.safeParse({
        marketing: 'yes',
      });
      expect(result.success).toBe(false);
    });

    it('should reject non-boolean productUpdates value', () => {
      const result = emailPreferencesSchema.safeParse({
        productUpdates: 1,
      });
      expect(result.success).toBe(false);
    });

    it('should reject securityAlerts as false (must be true)', () => {
      const result = emailPreferencesSchema.safeParse({
        securityAlerts: false,
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('userPreferencesSchema', () => {
  describe('valid preferences', () => {
    it('should accept complete preferences object', () => {
      const result = userPreferencesSchema.safeParse({
        email: {
          marketing: false,
          productUpdates: true,
          securityAlerts: true,
        },
      });
      expect(result.success).toBe(true);
    });

    it('should use email defaults when email is empty', () => {
      const result = userPreferencesSchema.safeParse({
        email: {},
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email.marketing).toBe(false);
        expect(result.data.email.productUpdates).toBe(true);
        expect(result.data.email.securityAlerts).toBe(true);
      }
    });
  });

  describe('invalid preferences', () => {
    it('should reject missing email object', () => {
      const result = userPreferencesSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('should reject invalid email preferences', () => {
      const result = userPreferencesSchema.safeParse({
        email: {
          marketing: 'invalid',
        },
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('updatePreferencesSchema', () => {
  describe('valid partial updates', () => {
    it('should accept empty object (no changes)', () => {
      const result = updatePreferencesSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('should accept partial email updates', () => {
      const result = updatePreferencesSchema.safeParse({
        email: {
          marketing: true,
        },
      });
      expect(result.success).toBe(true);
    });

    it('should accept multiple email preference changes', () => {
      const result = updatePreferencesSchema.safeParse({
        email: {
          marketing: false,
          productUpdates: false,
        },
      });
      expect(result.success).toBe(true);
    });

    it('should accept undefined email object', () => {
      const result = updatePreferencesSchema.safeParse({
        email: undefined,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid partial updates', () => {
    it('should reject invalid email preference type', () => {
      const result = updatePreferencesSchema.safeParse({
        email: {
          marketing: 'yes',
        },
      });
      expect(result.success).toBe(false);
    });

    it('should reject non-object email value', () => {
      const result = updatePreferencesSchema.safeParse({
        email: 'invalid',
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('deleteAccountSchema', () => {
  describe('valid confirmation', () => {
    it('should accept exact DELETE confirmation', () => {
      const result = deleteAccountSchema.safeParse({
        confirmation: 'DELETE',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid confirmation', () => {
    it('should reject lowercase delete', () => {
      const result = deleteAccountSchema.safeParse({
        confirmation: 'delete',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('DELETE');
      }
    });

    it('should reject empty confirmation', () => {
      const result = deleteAccountSchema.safeParse({
        confirmation: '',
      });
      expect(result.success).toBe(false);
    });

    it('should reject missing confirmation', () => {
      const result = deleteAccountSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('should reject misspelled DELETE', () => {
      const result = deleteAccountSchema.safeParse({
        confirmation: 'DELTE',
      });
      expect(result.success).toBe(false);
    });

    it('should reject DELETE with extra spaces', () => {
      const result = deleteAccountSchema.safeParse({
        confirmation: ' DELETE ',
      });
      expect(result.success).toBe(false);
    });

    it('should reject partial DELETE', () => {
      const result = deleteAccountSchema.safeParse({
        confirmation: 'DEL',
      });
      expect(result.success).toBe(false);
    });
  });
});
