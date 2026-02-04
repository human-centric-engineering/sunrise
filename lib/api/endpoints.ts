/**
 * Centralized API Endpoint Constants
 *
 * All API paths used by client components and server component fetches.
 * Import from here instead of hardcoding paths in components.
 *
 * @example
 * ```typescript
 * import { API } from '@/lib/api/endpoints';
 *
 * // Client component
 * const user = await apiClient.get<User>(API.USERS.ME);
 *
 * // Server component
 * const res = await serverFetch(API.ADMIN.STATS);
 * ```
 */

export const API = {
  /** Auth endpoints (better-auth) */
  AUTH: {
    /** better-auth catch-all */
    BASE: '/api/auth',
    SIGN_OUT: '/api/auth/sign-out',
  },

  /** Current user endpoints */
  USERS: {
    ME: '/api/v1/users/me',
    ME_PREFERENCES: '/api/v1/users/me/preferences',
    ME_AVATAR: '/api/v1/users/me/avatar',
    /** User by ID (admin) */
    byId: (id: string): string => `/api/v1/users/${id}`,
    /** User list (admin) */
    LIST: '/api/v1/users',
    /** Send invitation (admin) */
    INVITE: '/api/v1/users/invite',
  },

  /** Invitation endpoints (public, token-gated) */
  INVITATIONS: {
    METADATA: '/api/v1/invitations/metadata',
  },

  /** Admin endpoints */
  ADMIN: {
    STATS: '/api/v1/admin/stats',
    LOGS: '/api/v1/admin/logs',
    INVITATIONS: '/api/v1/admin/invitations',
    /** Delete invitation by email */
    invitationByEmail: (email: string): string =>
      `/api/v1/admin/invitations/${encodeURIComponent(email)}`,
    FEATURE_FLAGS: '/api/v1/admin/feature-flags',
    /** Feature flag by ID */
    featureFlag: (id: string): string => `/api/v1/admin/feature-flags/${id}`,
  },

  /** Public endpoints */
  PUBLIC: {
    HEALTH: '/api/health',
    CONTACT: '/api/v1/contact',
    CSP_REPORT: '/api/v1/csp-report',
  },
} as const;
