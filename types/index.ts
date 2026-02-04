/**
 * Domain-Specific Types
 *
 * Application-level types that represent business domain concepts.
 * For database model types, see @/types/prisma
 * For API types, see @/types/api
 */

import type { User } from './prisma';
import type { APIResponse } from './api';

// Re-export storage types
export type {
  StorageProvider,
  StorageProviderType,
  StorageConfig,
  UploadOptions,
  UploadResult,
  DeleteResult,
  AvatarUploadRequest,
  AvatarUploadResponse,
  AvatarDeleteResponse,
  StorageStatus,
} from './storage';

/**
 * User Role Types
 *
 * Defines the possible roles a user can have in the system.
 * Add additional roles as needed (e.g., 'MODERATOR').
 */
export type UserRole = 'USER' | 'ADMIN';

/**
 * User Email Preferences
 *
 * Defines email notification preferences stored as JSON in the User model.
 * Security alerts cannot be disabled (always true).
 *
 * @example
 * ```typescript
 * const prefs: UserEmailPreferences = {
 *   marketing: false,
 *   productUpdates: true,
 *   securityAlerts: true, // Always true, cannot be disabled
 * };
 * ```
 */
export interface UserEmailPreferences {
  /** Marketing emails (newsletters, promotions) */
  marketing: boolean;
  /** Product update notifications */
  productUpdates: boolean;
  /** Security alerts (always true, cannot be disabled) */
  securityAlerts: true;
}

/**
 * User Preferences
 *
 * Top-level preferences object stored in User.preferences JSON field.
 * Currently contains email preferences, extensible for future preference types.
 */
export interface UserPreferences {
  email: UserEmailPreferences;
}

/**
 * Default User Preferences
 *
 * @deprecated Use DEFAULT_USER_PREFERENCES from '@/lib/validations/user' instead
 */
export { DEFAULT_USER_PREFERENCES } from '@/lib/validations/user';

/**
 * Public User Type
 *
 * User data safe for public exposure (no sensitive fields).
 * Note: Prisma User model doesn't contain passwords (they're in Account),
 * so this is just an alias for clarity.
 *
 * @example
 * ```typescript
 * const user: PublicUser = await prisma.user.findUnique({
 *   where: { id: userId },
 * });
 * ```
 */
export type PublicUser = User;

/**
 * User List Item Type
 *
 * Subset of user fields for displaying in lists (e.g., admin user management).
 * Only includes essential fields to reduce payload size.
 *
 * @example
 * ```typescript
 * const users: UserListItem[] = await prisma.user.findMany({
 *   select: {
 *     id: true,
 *     name: true,
 *     email: true,
 *     role: true,
 *     createdAt: true,
 *   },
 * });
 * ```
 */
export type UserListItem = Pick<
  User,
  'id' | 'name' | 'email' | 'image' | 'role' | 'emailVerified' | 'createdAt'
>;

/**
 * User Profile Type
 *
 * User data for the current authenticated user's profile.
 * Includes all fields the user should see about themselves.
 *
 * Currently identical to PublicUser, but kept as separate type for future
 * expansion (e.g., adding fields only visible to the user themselves).
 */
export type UserProfile = PublicUser;

/**
 * Auth Session Type
 *
 * Represents an authenticated user session with user information.
 * Used in components and hooks to type the current user.
 *
 * @example
 * ```typescript
 * const session: AuthSession | null = await getSession();
 * if (session) {
 *   console.log(session.user.name);
 * }
 * ```
 */
export interface AuthSession {
  user: PublicUser;
  expiresAt: Date;
}

/**
 * API Response Types
 *
 * Type-safe wrappers for common API responses
 */

/** Single user response */
export type UserResponse = APIResponse<PublicUser>;

/** Paginated user list response (meta will contain PaginationMeta) */
export type UserListResponse = APIResponse<UserListItem[]>;

/**
 * Invitation List Item Type
 *
 * Represents a pending user invitation for display in admin tables.
 * Used in GET /api/v1/admin/invitations endpoint.
 *
 * @example
 * ```typescript
 * const invitations: InvitationListItem[] = await getAllPendingInvitations();
 * ```
 */
export type InvitationListItem = {
  /** Email address of the invited user */
  email: string;
  /** Display name of the invited user */
  name: string;
  /** Role assigned to the invitation */
  role: string;
  /** User ID of the admin who created the invitation */
  invitedBy: string;
  /** Name of the admin who created the invitation (null if user deleted) */
  invitedByName: string | null;
  /** When the invitation was created */
  invitedAt: Date;
  /** When the invitation expires */
  expiresAt: Date;
};

/** Paginated invitation list response */
export type InvitationListResponse = APIResponse<InvitationListItem[]>;
