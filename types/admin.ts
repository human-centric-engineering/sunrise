/**
 * Admin Dashboard Types (Phase 4.4)
 *
 * TypeScript types for admin dashboard features including
 * system statistics, logs viewing, and feature flag management.
 */

import type { FeatureFlag, User } from './prisma';
import type { APIResponse, PaginationMeta } from './api';

/**
 * System Statistics
 *
 * Overview statistics for the admin dashboard.
 */
export interface SystemStats {
  users: {
    /** Total number of users */
    total: number;
    /** Users with verified emails */
    verified: number;
    /** Users created in the last 24 hours */
    recentSignups: number;
    /** Breakdown by role */
    byRole: {
      USER: number;
      ADMIN: number;
    };
  };
  system: {
    /** Node.js version */
    nodeVersion: string;
    /** Application version from package.json */
    appVersion: string;
    /** Current environment (development/production) */
    environment: string;
    /** Server uptime in seconds */
    uptime: number;
    /** Database connection status */
    databaseStatus: 'connected' | 'disconnected' | 'error';
  };
}

/**
 * Log Entry
 *
 * Structure of a log entry in the admin logs viewer.
 */
export interface LogEntry {
  /** Unique identifier for the log entry */
  id: string;
  /** ISO timestamp when the log was created */
  timestamp: string;
  /** Log level (debug, info, warn, error) */
  level: 'debug' | 'info' | 'warn' | 'error';
  /** Log message */
  message: string;
  /** Additional context (requestId, userId, etc.) */
  context?: Record<string, unknown>;
  /** Additional metadata */
  meta?: Record<string, unknown>;
  /** Error details if level is error */
  error?: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
  };
}

/**
 * Logs Query Parameters
 */
export interface LogsQuery {
  /** Filter by log level */
  level?: 'debug' | 'info' | 'warn' | 'error';
  /** Search in message content */
  search?: string;
  /** Page number (1-indexed) */
  page?: number;
  /** Items per page */
  limit?: number;
}

/**
 * Feature Flag with metadata
 *
 * Extends Prisma FeatureFlag with parsed metadata.
 */
export type FeatureFlagWithMeta = FeatureFlag;

/**
 * Create Feature Flag Input
 */
export interface CreateFeatureFlagInput {
  /** Flag name in SCREAMING_SNAKE_CASE */
  name: string;
  /** Description of what the flag controls */
  description?: string;
  /** Whether the flag is enabled */
  enabled?: boolean;
  /** Additional metadata as JSON */
  metadata?: Record<string, unknown>;
}

/**
 * Update Feature Flag Input
 */
export interface UpdateFeatureFlagInput {
  /** Description of what the flag controls */
  description?: string;
  /** Whether the flag is enabled */
  enabled?: boolean;
  /** Additional metadata as JSON */
  metadata?: Record<string, unknown>;
}

/**
 * Admin User Update Input
 *
 * Fields that an admin can update on a user.
 */
export interface AdminUserUpdateInput {
  /** User's display name */
  name?: string;
  /** User's role */
  role?: 'USER' | 'ADMIN';
  /** Whether email is verified */
  emailVerified?: boolean;
}

/**
 * Admin User View
 *
 * User data as seen by an admin (includes more fields than public view).
 */
export type AdminUser = Pick<
  User,
  | 'id'
  | 'name'
  | 'email'
  | 'emailVerified'
  | 'image'
  | 'role'
  | 'bio'
  | 'createdAt'
  | 'updatedAt'
  | 'phone'
  | 'timezone'
  | 'location'
>;

/**
 * API Response Types
 */

/** System stats response */
export type SystemStatsResponse = APIResponse<SystemStats>;

/** Logs list response with pagination */
export type LogsResponse = APIResponse<LogEntry[]> & {
  meta?: PaginationMeta;
};

/** Single feature flag response */
export type FeatureFlagResponse = APIResponse<FeatureFlagWithMeta>;

/** Feature flags list response */
export type FeatureFlagsResponse = APIResponse<FeatureFlagWithMeta[]>;

/** Admin user response */
export type AdminUserResponse = APIResponse<AdminUser>;
