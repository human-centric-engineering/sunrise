import { createAuthClient } from 'better-auth/react'

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
})

/**
 * useSession Hook
 *
 * Reactive hook for accessing session data in React components.
 * No provider wrapper needed - uses nanostore for state management.
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
 *   return <div>Welcome {session.user.name}</div>
 * }
 * ```
 */
export const { useSession } = authClient
