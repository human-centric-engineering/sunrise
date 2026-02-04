import { createAuthClient } from 'better-auth/react';
import type { UserRole } from '@/types';

const VALID_ROLES: readonly string[] = ['USER', 'ADMIN'];

/**
 * Better Auth Client
 *
 * Client-side authentication utilities for React components.
 * Provides methods for sign-up, sign-in, sign-out, and session management.
 *
 * Usage:
 * ```tsx
 * import { authClient, useSession } from '@/lib/auth/client'
 *
 * // Sign up
 * await authClient.signUp.email({
 *   email: 'user@example.com',
 *   password: 'password123',
 *   name: 'John Doe',
 * })
 *
 * // Sign in
 * await authClient.signIn.email({
 *   email: 'user@example.com',
 *   password: 'password123',
 * })
 *
 * // Sign out
 * await authClient.signOut()
 *
 * // Get session (one-time)
 * const session = await authClient.getSession()
 * ```
 *
 * For reactive session access in components, use the `useSession` hook.
 *
 * Note: This is a client-side module, so it can only access NEXT_PUBLIC_* environment variables.
 * NEXT_PUBLIC_APP_URL is validated at build time in lib/env.ts.
 *
 * @see .context/environment/reference.md for environment variable documentation
 */
export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
});

/**
 * Session user type with custom fields.
 *
 * better-auth's client types don't automatically include `additionalFields`
 * defined in the server config (like `role`). This interface defines the
 * expected shape so consumers get type safety.
 *
 * The `useSession` wrapper below validates `role` at runtime to ensure
 * the type assertion is backed by an actual check.
 */
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Typed session data returned by useSession.
 */
export interface TypedSessionData {
  user: SessionUser;
  session: {
    id: string;
    userId: string;
    token: string;
    expiresAt: Date;
    ipAddress?: string | null;
    userAgent?: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
}

interface UseSessionReturn {
  data: TypedSessionData | null;
  error: { message?: string; status: number; statusText: string } | null;
  isPending: boolean;
}

/**
 * Extract and validate the user role from a raw session user object.
 *
 * better-auth returns `role` as part of the user object at runtime (via
 * `additionalFields`), but the TypeScript client types don't include it.
 * This function reads it from the raw object with a runtime check,
 * defaulting to 'USER' if the value is missing or unexpected.
 */
function extractUserRole(rawUser: Record<string, unknown>): UserRole {
  const role = rawUser.role;
  if (typeof role === 'string' && VALID_ROLES.includes(role)) {
    return role as UserRole;
  }
  return 'USER';
}

/**
 * useSession Hook
 *
 * Thin wrapper around `authClient.useSession` that adds runtime validation
 * for custom user fields (`role`) from the server-side better-auth config.
 *
 * Why a wrapper instead of a type cast:
 * - better-auth's client types don't include `additionalFields` automatically
 * - A bare `as` cast would silently produce wrong types if the server config changes
 * - This wrapper validates `role` at runtime, defaulting to 'USER' if unexpected
 *
 * Usage:
 * ```tsx
 * 'use client'
 * import { useSession } from '@/lib/auth/client'
 *
 * export function UserProfile() {
 *   const { data: session, isPending, error } = useSession()
 *
 *   if (isPending) return <div>Loading...</div>
 *   if (error) return <div>Error loading session</div>
 *   if (!session) return <div>Not authenticated</div>
 *
 *   return <div>Welcome {session.user.name} ({session.user.role})</div>
 * }
 * ```
 */
export function useSession(): UseSessionReturn {
  const raw = authClient.useSession();

  // No session — pass through
  if (!raw.data) {
    return {
      data: null,
      error: raw.error,
      isPending: raw.isPending,
    };
  }

  // Validate the role field at runtime
  const rawUser = raw.data.user as Record<string, unknown>;
  const role = extractUserRole(rawUser);

  // Build user with validated role. The spread provides all base fields from
  // better-auth; we override `role` with the runtime-validated value.
  const rawData = raw.data;
  const user: SessionUser = Object.assign({}, rawData.user, { role });
  const data: TypedSessionData = Object.assign({}, rawData, { user });

  return {
    data,
    error: raw.error,
    isPending: raw.isPending,
  };
}
