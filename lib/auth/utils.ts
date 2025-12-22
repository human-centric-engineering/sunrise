import { auth } from './config';
import { headers } from 'next/headers';
import { logger } from '@/lib/logging';

/**
 * Session type from better-auth
 * Contains both session data and user data
 */
type AuthSession = {
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
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    image?: string | null;
    role?: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
};

/**
 * Get the current user session on the server
 *
 * Use this in Server Components, Server Actions, and API Routes
 * to get the authenticated user session.
 *
 * @returns The session object with user data, or null if not authenticated
 *
 * @example
 * ```tsx
 * // In a Server Component
 * export default async function DashboardPage() {
 *   const session = await getServerSession()
 *
 *   if (!session) {
 *     redirect('/login')
 *   }
 *
 *   return <div>Welcome {session.user.name}</div>
 * }
 * ```
 *
 * @example
 * ```ts
 * // In an API Route
 * export async function GET() {
 *   const session = await getServerSession()
 *
 *   if (!session) {
 *     return Response.json({ error: 'Unauthorized' }, { status: 401 })
 *   }
 *
 *   return Response.json({ user: session.user })
 * }
 * ```
 */
export async function getServerSession(): Promise<AuthSession | null> {
  try {
    const requestHeaders = await headers();
    const session = await auth.api.getSession({
      headers: requestHeaders,
    });

    return session;
  } catch (error) {
    logger.error('Failed to get server session', error);
    return null;
  }
}

/**
 * Get the current authenticated user on the server
 *
 * Convenience function that extracts just the user from the session.
 *
 * @returns The user object, or null if not authenticated
 *
 * @example
 * ```tsx
 * export default async function ProfilePage() {
 *   const user = await getServerUser()
 *
 *   if (!user) {
 *     redirect('/login')
 *   }
 *
 *   return <div>Email: {user.email}</div>
 * }
 * ```
 */
export async function getServerUser(): Promise<AuthSession['user'] | null> {
  const session = await getServerSession();
  return session?.user ?? null;
}

/**
 * Check if the current user has a specific role
 *
 * @param requiredRole - The role to check for ('USER' | 'ADMIN' | 'MODERATOR')
 * @returns true if the user has the required role, false otherwise
 *
 * @example
 * ```tsx
 * export default async function AdminPage() {
 *   const isAdmin = await hasRole('ADMIN')
 *
 *   if (!isAdmin) {
 *     redirect('/unauthorized')
 *   }
 *
 *   return <div>Admin Dashboard</div>
 * }
 * ```
 */
export async function hasRole(requiredRole: string): Promise<boolean> {
  const user = await getServerUser();

  if (!user) {
    return false;
  }

  return user.role === requiredRole;
}

/**
 * Require authentication for a server component or API route
 *
 * Throws an error if the user is not authenticated.
 * Use this when you want to enforce authentication.
 *
 * @returns The authenticated session
 * @throws Error if not authenticated
 *
 * @example
 * ```tsx
 * export default async function ProtectedPage() {
 *   const session = await requireAuth()
 *   // If we get here, user is authenticated
 *   return <div>Welcome {session.user.name}</div>
 * }
 * ```
 */
export async function requireAuth(): Promise<AuthSession> {
  const session = await getServerSession();

  if (!session) {
    throw new Error('Authentication required');
  }

  return session;
}

/**
 * Require a specific role for a server component or API route
 *
 * Throws an error if the user doesn't have the required role.
 *
 * @param requiredRole - The role required to access this resource
 * @returns The authenticated session with user
 * @throws Error if not authenticated or doesn't have required role
 *
 * @example
 * ```tsx
 * export default async function AdminDashboard() {
 *   const session = await requireRole('ADMIN')
 *   // If we get here, user is an admin
 *   return <div>Admin Controls</div>
 * }
 * ```
 */
export async function requireRole(requiredRole: string): Promise<AuthSession> {
  const session = await requireAuth();

  if (session.user.role !== requiredRole) {
    throw new Error(`Role ${requiredRole} required`);
  }

  return session;
}

/**
 * Type guard to check if a session exists
 *
 * Useful for TypeScript type narrowing
 *
 * @example
 * ```tsx
 * const session = await getServerSession()
 *
 * if (isAuthenticated(session)) {
 *   // TypeScript knows session is not null here
 *   console.log(session.user.email)
 * }
 * ```
 */
export function isAuthenticated(session: AuthSession | null): session is AuthSession {
  return session !== null;
}
