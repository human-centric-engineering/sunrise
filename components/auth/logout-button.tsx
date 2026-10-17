'use client';

import { useState } from 'react';
import { authClient } from '@/lib/auth/client';
import { useAnalytics, EVENTS } from '@/lib/analytics';
import { Button } from '@/components/ui/button';
import { logger } from '@/lib/logging';

interface LogoutButtonProps {
  /**
   * Button variant (default, ghost, outline, etc.)
   */
  variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
  /**
   * Button size
   */
  size?: 'default' | 'sm' | 'lg' | 'icon';
  /**
   * Additional CSS classes
   */
  className?: string;
  /**
   * Redirect path after logout (default: '/')
   */
  redirectTo?: string;
}

/**
 * Logout Button Component
 *
 * Handles user sign-out and redirect, the same way as the account menu's
 * sign-out (`UserButton`): a full page load to `redirectTo`, not a client-side
 * navigation. A soft navigation keeps the Router Cache, so pages rendered for
 * the signed-in user could still be shown after they signed out (#707).
 * Shows loading state during logout process.
 *
 * Usage:
 * ```tsx
 * <LogoutButton variant="ghost" />
 * <LogoutButton variant="outline" redirectTo="/login" />
 * ```
 */
export function LogoutButton({
  variant = 'ghost',
  size = 'default',
  className,
  redirectTo = '/',
}: LogoutButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const { track, reset } = useAnalytics();

  const handleLogout = async () => {
    try {
      setIsLoading(true);

      // Track logout before signing out (while session still exists)
      await track(EVENTS.USER_LOGGED_OUT);

      await authClient.signOut({
        fetchOptions: {
          onSuccess: async () => {
            // Reset analytics identity so PostHog stops associating events with this user
            await reset();
            // Full page load, so no page rendered for the signed-in user
            // survives in the Router Cache.
            window.location.href = redirectTo;
          },
          onError: (ctx) => {
            logger.error('Logout failed', ctx.error);
            setIsLoading(false);
          },
        },
      });
    } catch (error) {
      logger.error('Logout error', error);
      setIsLoading(false);
    }
  };

  return (
    <Button
      variant={variant}
      size={size}
      className={className}
      onClick={() => void handleLogout()}
      disabled={isLoading}
    >
      {isLoading ? 'Signing out...' : 'Sign Out'}
    </Button>
  );
}
