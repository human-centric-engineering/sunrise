'use client';

/**
 * HeaderActions Component
 *
 * Container for header action buttons (ThemeToggle and UserButton).
 * Used in the AppHeader component for consistent positioning.
 */

import { ThemeToggle } from '@/components/theme-toggle';
import { UserButton } from '@/components/auth/user-button';

export function HeaderActions() {
  return (
    <div className="flex items-center gap-2">
      <ThemeToggle />
      <UserButton />
    </div>
  );
}
