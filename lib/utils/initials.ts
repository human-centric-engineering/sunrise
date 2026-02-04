/**
 * User display utilities
 *
 * Shared helpers for displaying user names, initials, and role badges.
 */

/**
 * Get initials from a user's name (max 2 characters).
 *
 * Handles edge cases: extra spaces, empty strings, single names.
 *
 * @param name - The user's full name
 * @returns Up to 2 uppercase initials, or "?" for empty/whitespace-only input
 */
export function getInitials(name: string): string {
  const parts = name.split(' ').filter((part) => part.length > 0);
  if (parts.length === 0) return '?';
  return parts
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

/**
 * Get badge variant for a user role.
 *
 * @param role - The user's role string (e.g. "ADMIN", "USER")
 * @returns Badge variant for shadcn/ui Badge component
 */
export function getRoleBadgeVariant(role: string | null): 'default' | 'secondary' | 'outline' {
  switch (role) {
    case 'ADMIN':
      return 'default';
    default:
      return 'outline';
  }
}
