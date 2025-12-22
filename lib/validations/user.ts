/**
 * User Validation Schemas
 *
 * Zod schemas for user-related API operations (profile updates, user management, etc.)
 * Reuses email and password validation from auth schemas for consistency
 */

import { z } from 'zod';
import { emailSchema, passwordSchema } from './auth';

/**
 * Update user profile schema (PATCH /api/v1/users/me)
 *
 * Validates user profile update requests.
 * All fields are optional - only provided fields will be updated.
 */
export const updateUserSchema = z.object({
  name: z
    .string()
    .min(1, 'Name cannot be empty')
    .max(100, 'Name must be less than 100 characters')
    .trim()
    .optional(),
  email: emailSchema.optional(),
});

/**
 * List users query parameters schema (GET /api/v1/users)
 *
 * Validates query parameters for the user list endpoint (admin only).
 * Supports pagination, search, and sorting.
 */
export const listUsersQuerySchema = z.object({
  /** Page number (1-indexed) */
  page: z.coerce
    .number()
    .int('Page must be an integer')
    .positive('Page must be positive')
    .default(1),

  /** Items per page (max 100) */
  limit: z.coerce
    .number()
    .int('Limit must be an integer')
    .positive('Limit must be positive')
    .max(100, 'Maximum limit is 100')
    .default(20),

  /** Search query (searches name and email) */
  search: z.string().trim().optional(),

  /** Field to sort by */
  sortBy: z.enum(['name', 'email', 'createdAt']).default('createdAt'),

  /** Sort order */
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
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
 */
export const userIdSchema = z.object({
  id: z
    .string()
    .min(1, 'User ID is required')
    .regex(/^c[a-z0-9]{24}$/i, 'Invalid user ID format (must be a valid CUID)'),
});

/**
 * Create user schema (POST /api/v1/users - admin only)
 *
 * Validates user creation requests by admins.
 * Creates user with password that should be changed on first login.
 */
export const createUserSchema = z.object({
  /** User's full name */
  name: z
    .string()
    .min(1, 'Name is required')
    .max(100, 'Name must be less than 100 characters')
    .trim(),

  /** User's email address (must be unique) */
  email: emailSchema,

  /**
   * Password for the user
   * If not provided, a secure random password will be generated
   */
  password: passwordSchema.optional(),

  /** User's role (defaults to USER) */
  role: z.enum(['USER', 'ADMIN', 'MODERATOR']).default('USER'),
});

/**
 * TypeScript types inferred from schemas
 * Use these for type-safe API handling
 */
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
export type UserIdParam = z.infer<typeof userIdSchema>;
