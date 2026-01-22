/**
 * Admin Validation Schemas (Phase 4.4)
 *
 * Zod schemas for admin dashboard operations including
 * logs filtering, feature flag management, and user administration.
 */

import { z } from 'zod';
import { paginationQuerySchema, cuidSchema } from './common';

/**
 * Log level enum
 */
export const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);

/**
 * Logs query parameters schema (GET /api/v1/admin/logs)
 *
 * Validates query parameters for the logs viewer endpoint.
 */
export const logsQuerySchema = z.object({
  /** Filter by log level */
  level: logLevelSchema.optional(),

  /** Search in message content */
  search: z.string().trim().max(200, 'Search query too long').optional(),

  /** Page number (1-indexed) - from common pagination schema */
  page: paginationQuerySchema.shape.page,

  /** Items per page (max 100) */
  limit: z.coerce
    .number()
    .int('Limit must be an integer')
    .positive('Limit must be positive')
    .max(100, 'Maximum limit is 100')
    .default(50),
});

/**
 * Feature flag name schema
 *
 * Validates SCREAMING_SNAKE_CASE format for flag names.
 * Examples: ENABLE_BETA_FEATURES, MAINTENANCE_MODE, NEW_DASHBOARD
 */
export const featureFlagNameSchema = z
  .string()
  .min(1, 'Name is required')
  .max(100, 'Name must be less than 100 characters')
  .regex(
    /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/,
    'Name must be in SCREAMING_SNAKE_CASE (e.g., ENABLE_FEATURE, NEW_DASHBOARD)'
  )
  .transform((val) => val.toUpperCase());

/**
 * Create feature flag schema (POST /api/v1/admin/feature-flags)
 */
export const createFeatureFlagSchema = z.object({
  /** Flag name in SCREAMING_SNAKE_CASE */
  name: featureFlagNameSchema,

  /** Description of what the flag controls */
  description: z
    .string()
    .max(500, 'Description must be less than 500 characters')
    .trim()
    .optional(),

  /** Whether the flag is enabled (defaults to false) */
  enabled: z.boolean().default(false),

  /** Additional metadata as JSON object */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Update feature flag schema (PATCH /api/v1/admin/feature-flags/[id])
 *
 * All fields are optional for partial updates.
 */
export const updateFeatureFlagSchema = z.object({
  /** Description of what the flag controls */
  description: z
    .string()
    .max(500, 'Description must be less than 500 characters')
    .trim()
    .optional(),

  /** Whether the flag is enabled */
  enabled: z.boolean().optional(),

  /** Additional metadata as JSON object */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Feature flag ID parameter schema
 */
export const featureFlagIdSchema = z.object({
  id: cuidSchema,
});

/**
 * Admin user update schema (PATCH /api/v1/users/[id] - admin only)
 *
 * Fields that an admin can update on any user.
 */
export const adminUserUpdateSchema = z.object({
  /** User's display name */
  name: z
    .string()
    .min(1, 'Name cannot be empty')
    .max(100, 'Name must be less than 100 characters')
    .trim()
    .optional(),

  /** User's role */
  role: z.enum(['USER', 'ADMIN']).optional(),

  /** Whether email is verified */
  emailVerified: z.boolean().optional(),
});

/**
 * TypeScript types inferred from schemas
 */
export type LogLevel = z.infer<typeof logLevelSchema>;
export type LogsQuery = z.infer<typeof logsQuerySchema>;
export type CreateFeatureFlagInput = z.infer<typeof createFeatureFlagSchema>;
export type UpdateFeatureFlagInput = z.infer<typeof updateFeatureFlagSchema>;
export type FeatureFlagIdParam = z.infer<typeof featureFlagIdSchema>;
export type AdminUserUpdateInput = z.infer<typeof adminUserUpdateSchema>;

/**
 * List invitations query parameters schema (GET /api/v1/admin/invitations)
 *
 * Validates query parameters for the invitations list endpoint.
 */
export const listInvitationsQuerySchema = z.object({
  /** Search query for name or email */
  search: z.string().trim().max(200, 'Search query too long').optional(),

  /** Page number (1-indexed) - from common pagination schema */
  page: paginationQuerySchema.shape.page,

  /** Items per page (max 100) */
  limit: z.coerce
    .number()
    .int('Limit must be an integer')
    .positive('Limit must be positive')
    .max(100, 'Maximum limit is 100')
    .default(20),

  /** Field to sort by */
  sortBy: z.enum(['name', 'email', 'invitedAt', 'expiresAt']).default('invitedAt'),

  /** Sort order */
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export type ListInvitationsQuery = z.infer<typeof listInvitationsQuerySchema>;
