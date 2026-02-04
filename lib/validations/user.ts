/**
 * User Validation Schemas
 *
 * Zod schemas for user-related API operations (profile updates, user management, etc.)
 * Reuses email and password validation from auth schemas for consistency
 * Reuses common validation patterns (pagination, sorting, CUID) from common schemas
 */

import { z } from 'zod';
import { emailSchema, passwordSchema } from './auth';
import { paginationQuerySchema, sortingQuerySchema, cuidSchema } from './common';

/**
 * Update user profile schema (PATCH /api/v1/users/me)
 *
 * Validates user profile update requests.
 * All fields are optional - only provided fields will be updated.
 *
 * Extended in Phase 3.2 to include bio, phone, timezone, location.
 */
export const updateUserSchema = z.object({
  name: z
    .string()
    .min(1, 'Name cannot be empty')
    .max(100, 'Name must be less than 100 characters')
    .trim()
    .optional(),
  email: emailSchema.optional(),

  // Extended profile fields (Phase 3.2)
  bio: z.string().max(500, 'Bio must be less than 500 characters').trim().optional().nullable(),
  phone: z
    .string()
    .max(20, 'Phone number must be less than 20 characters')
    .regex(/^[\d\s\-+()]*$/, 'Invalid phone number format')
    .optional()
    .nullable(),
  timezone: z.string().max(50, 'Timezone must be less than 50 characters').optional(),
  location: z
    .string()
    .max(100, 'Location must be less than 100 characters')
    .trim()
    .optional()
    .nullable(),
});

/**
 * Email preferences schema
 *
 * Validates email notification preferences.
 * Note: securityAlerts is always true and cannot be disabled.
 */
export const emailPreferencesSchema = z.object({
  marketing: z.boolean().default(false),
  productUpdates: z.boolean().default(true),
  securityAlerts: z.literal(true).default(true),
});

/**
 * User preferences schema (GET/PATCH /api/v1/users/me/preferences)
 *
 * Validates the full user preferences object.
 */
export const userPreferencesSchema = z.object({
  email: emailPreferencesSchema,
});

/**
 * Default User Preferences
 *
 * Default values for new users or when preferences are not set.
 * Canonical source — also re-exported from `@/types` for backward compatibility.
 */
export const DEFAULT_USER_PREFERENCES: z.infer<typeof userPreferencesSchema> = {
  email: {
    marketing: false,
    productUpdates: true,
    securityAlerts: true,
  },
};

/**
 * Partial preferences update schema
 *
 * For PATCH operations where only some preferences are updated.
 * Allows partial updates to be merged with existing preferences.
 */
export const updatePreferencesSchema = z.object({
  email: emailPreferencesSchema.partial().optional(),
});

/**
 * Delete account confirmation schema
 *
 * Validates account deletion requests.
 * Requires user to type "DELETE" to confirm.
 */
export const deleteAccountSchema = z.object({
  confirmation: z.literal('DELETE', {
    message: 'Please type DELETE to confirm account deletion',
  }),
});

/**
 * List users query parameters schema (GET /api/v1/users)
 *
 * Validates query parameters for the user list endpoint (admin only).
 * Supports pagination, search, and sorting.
 *
 * Reuses pagination and sorting patterns from common schemas, with domain-specific
 * customizations (limit default of 20, sortBy field options).
 */
export const listUsersQuerySchema = z.object({
  /** Page number (1-indexed) - from common pagination schema */
  page: paginationQuerySchema.shape.page,

  /** Items per page (max 100) - domain-specific default of 20 */
  limit: z.coerce
    .number()
    .int('Limit must be an integer')
    .positive('Limit must be positive')
    .max(100, 'Maximum limit is 100')
    .default(20),

  /** Search query (searches name and email) */
  search: z.string().trim().optional(),

  /** Field to sort by - domain-specific enum for user fields */
  sortBy: z.enum(['name', 'email', 'createdAt']).default('createdAt'),

  /** Sort order - from common sorting schema */
  sortOrder: sortingQuerySchema.shape.sortOrder,
});

/**
 * User ID parameter validation
 *
 * Validates user ID in route parameters.
 * Enforces CUID format (25-character string starting with 'c')
 *
 * Format: c[a-z0-9]{24} (case-insensitive)
 * Example: cmjbv4i3x00003wsloputgwul
 *
 * Note: better-auth is configured to delegate ID generation to Prisma's
 * @default(cuid()), ensuring all users have this consistent format.
 *
 * Uses common CUID validation schema for consistency across the application.
 */
export const userIdSchema = z.object({
  id: cuidSchema,
});

/**
 * Invite user schema (POST /api/v1/invitations - admin only)
 *
 * Validates user invitation requests by admins.
 * Sends invitation email with token that user can use to complete registration.
 */
export const inviteUserSchema = z.object({
  /** User's full name */
  name: z
    .string()
    .min(1, 'Name is required')
    .max(100, 'Name must be less than 100 characters')
    .trim(),

  /** User's email address (must be unique) */
  email: emailSchema,

  /** User's role (defaults to USER) */
  role: z.enum(['USER', 'ADMIN']).default('USER'),
});

/**
 * Accept invitation schema (POST /api/auth/accept-invitation)
 *
 * Validates invitation acceptance requests.
 * User provides token from email, their email, and sets their password.
 * Includes password confirmation to prevent typos.
 */
export const acceptInvitationSchema = z
  .object({
    /** Invitation token from email */
    token: z.string().min(1, 'Token is required'),

    /** User's email address (must match invitation) */
    email: emailSchema,

    /** User's chosen password */
    password: passwordSchema,

    /** Password confirmation (must match password) */
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'],
  });

/**
 * TypeScript types inferred from schemas
 * Use these for type-safe API handling
 */
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
export type UserIdParam = z.infer<typeof userIdSchema>;
export type InviteUserInput = z.infer<typeof inviteUserSchema>;
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

// Phase 3.2 additions
export type EmailPreferencesInput = z.infer<typeof emailPreferencesSchema>;
export type UserPreferencesInput = z.infer<typeof userPreferencesSchema>;
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;
export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;
