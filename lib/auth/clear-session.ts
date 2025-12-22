/**
 * Clear Invalid Session Utility
 *
 * Handles edge cases where a user's session cookie exists but their account
 * or session has been deleted (e.g., admin deleted user, session expired).
 *
 * This utility redirects to a route handler that clears the cookie and
 * redirects to login, preventing infinite redirect loops.
 */

import { redirect } from 'next/navigation';

/**
 * Clear the better-auth session cookie and redirect to login
 *
 * Use this when you detect an invalid session (user deleted, session expired, etc.)
 * to prevent infinite redirect loops.
 *
 * This function redirects to /api/auth/clear-session which handles cookie deletion
 * (since cookies can only be modified in Route Handlers, not Server Components).
 *
 * @param returnUrl - Optional URL to return to after login (defaults to current path)
 *
 * @example
 * ```tsx
 * // In a Server Component
 * export default async function DashboardPage() {
 *   const session = await getServerSession()
 *
 *   if (!session) {
 *     // Clear invalid cookie and redirect
 *     clearInvalidSession('/dashboard')
 *   }
 *
 *   return <div>Welcome {session.user.name}</div>
 * }
 * ```
 */
export function clearInvalidSession(returnUrl: string = '/'): never {
  // Redirect to the clear-session endpoint which will:
  // 1. Delete the invalid session cookies
  // 2. Redirect to login with the return URL
  const clearSessionUrl = `/api/auth/clear-session?returnUrl=${encodeURIComponent(returnUrl)}`;
  redirect(clearSessionUrl);
}
