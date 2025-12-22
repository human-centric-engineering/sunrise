'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { authClient } from '@/lib/auth/client';
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
 * Handles user sign-out and redirect.
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
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);

  const handleLogout = async () => {
    try {
      setIsLoading(true);

      await authClient.signOut({
        fetchOptions: {
          onSuccess: () => {
            // Redirect to home or login page
            router.push(redirectTo);
            router.refresh();
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
